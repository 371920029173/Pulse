import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { productVersion } from './version.js';
import { spawn, type ChildProcess } from 'node:child_process';

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Where this entry came from. */
  source: 'cursor' | 'she';
  /** Whether it was enabled from the SHE-managed file (only for source 'she'). */
  enabled?: boolean;
  /**
   * 被收敛掉的原始允许根（空/缺省 = 没动过）。
   *
   * 存在的理由见 `confineMcpRoots`：文件系统型 MCP 的允许根曾经是用户桌面，于是 SHE 的边界只
   * 盖住 `fs_*`/`shell`，MCP 是一条旁路。收敛必须**可见** —— 悄悄改掉用户的配置，比不收敛更糟。
   */
  confinedRoots?: string[];
  /**
   * 进程的工作目录（恒为工作区；缺省只在测试夹具里出现，那时按 `process.cwd()` 走）。
   *
   * 理由见 `confineMcpServer`：MCP 服务器跑在自己的进程里，曾经继承 SHE 的 cwd —— 而 SHE 的
   * cwd 取决于你怎么启动它（终端里是工作区，双击是 exe 所在目录），于是"产物写到哪"是不确定的。
   */
  cwd?: string;
  /**
   * 产物目录因为 `cwd` 被钉到工作区而改变时，这里是它**现在**会写到哪（缺省 = 没这个说法）。
   *
   * 只有按 cwd 派生产物位置的服务器（playwright 一族）会填。和允许根一样，收敛必须可见。
   */
  confinedOutputDir?: string;
  /**
   * 历史产物：旧版本把产物留在了工作区之外（有才填，只报不删）。
   *
   * 收敛管得住新的，管不住已经攒下的。这些文件在用户主目录里，删不删是用户的决定。
   */
  legacyOutputDir?: { path: string; entries: number };
}

export interface McpServerStatus extends McpServerConfig {
  /** Reachability probe result. */
  reachable: boolean | null;
  toolCount: number | null;
  error?: string;
  latencyMs?: number;
  /** Tools from this server actually registered to the agent (see mcp-bridge.ts). */
  injected: number;
  /** Why fewer tools were registered than the server offers. */
  injectError?: string;
}

/** Lookup of what the bridge registered for a server; absent means "no bridge, nothing injected". */
export type McpInjectLookup = (name: string) => { injected: number; injectError?: string };
const NO_INJECT: McpInjectLookup = () => ({ injected: 0 });

const SHE_MCP_FILE = '.she/mcp.json';

/** Where Cursor keeps its MCP configuration, per platform. */
function cursorMcpPaths(): string[] {
  const home = homedir();
  const paths: string[] = [];
  if (process.env.APPDATA) paths.push(join(process.env.APPDATA, 'Cursor', 'User', 'mcp.json'));
  paths.push(join(home, '.cursor', 'mcp.json'));
  paths.push(join(home, '.config', 'Cursor', 'User', 'mcp.json'));
  return paths;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

interface RawMcpFile {
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; disabled?: boolean }>;
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * MCP 的允许根必须从工作区派生（评测报告 2c / 漏洞汇总 V3 / D3）
 *
 * 实测：`mcp_filesystem` 的允许目录是 `C:\Users\Administrator\Desktop` 与 `…\Desktop\chuli`，
 * 成功列出桌面 60+ 项；而 `D:\AGI\she-agent-cloud` 回 `not in allowed directories`。反差就是
 * 问题本身：**能读你的桌面，读不到你自己的代码树**。SHE 的边界只覆盖 `fs_*` 与 `shell`，MCP
 * 是一条完整的旁路 —— 它跑在自己的进程里，用自己的一套路径检查。
 *
 * 修法取"按工作区派生"，而不是在界面上写一句"MCP 不受沙箱约束"：后者只是把风险说清楚，前者
 * 把它去掉。代价是用户在 Cursor 里配的多根会被收成一个，所以收敛**必须回显** —— 原始根留在
 * `confinedRoots` 里，面板照实显示。悄悄改掉用户的配置比不收敛更糟。
 *
 * 只在**文件系统型**服务器上动手。别的服务器（比如某个指向另一个仓库的 git MCP）传绝对路径是
 * 配置意图本身，收敛它会毁掉功能；而文件系统型服务器的 positional 参数按契约就是"允许哪些目录"，
 * 收敛它不改变"这个服务器能做什么"，只改变"能看到哪里"。
 */
const FILESYSTEM_SERVER = /(?:@modelcontextprotocol\/server-filesystem|mcp-server-filesystem|server-filesystem)/i;

/** 这个参数看起来是不是一个"目录"（而不是包名、开关或入口脚本）。 */
function looksLikeDirectory(arg: string): boolean {
  if (!arg || arg.startsWith('-')) return false;
  // 入口脚本后缀：本机配置里就是 `…\server-filesystem\dist\index.js`，它是一个**文件**。
  if (/\.(?:js|mjs|cjs|ts|mts|cts|py|rb|jar|exe|ps1|cmd|bat)$/i.test(arg)) return false;
  if (arg.startsWith('~')) return true;
  if (!isAbsolute(arg)) return false;
  // 存在的文件不是目录；不存在时按扩展名与形状判断（上面两步已经筛掉了脚本）。
  try {
    return statSync(arg).isDirectory();
  } catch {
    return true;
  }
}

/**
 * 从哪里开始才是这个服务器的**参数**（而不是它的程序或包名）。
 *
 * `node <abs>/dist/index.js <根…>` 与 `npx -y @modelcontextprotocol/server-filesystem <根…>`
 * 是同一个形状：第一个非开关参数是入口，后面才是参数。
 *
 * 这一步不是锦上添花，是**必须的**：入口常常是一个**绝对路径**，而"绝对路径"正是允许根的形状。
 * 少了这一句，收敛逻辑会把入口本身当成一个工作区外的根、把它替换成工作区 —— 启动行于是变成
 * `node <工作区>`，服务器根本起不来。实测（2026-10-02，长尾工具探针）：filesystem 服务器
 * `process exited (code 1)`、注入 0 个工具，而面板上只留下一句被截断的 stderr 尾巴
 * （"Node.js v22.16.0"），看起来像服务器自己的毛病。回归判据见 `check:mcp` 第 6 段。
 */
function firstArgumentIndex(args: string[]): number {
  const i = args.findIndex((a) => a && !a.startsWith('-'));
  return i === -1 ? args.length : i + 1;
}

/**
 * 路径比较要在 Windows 上折叠大小写。
 *
 * `C:\Users\Me\proj` 与 `c:\users\me\proj` 是同一个目录，不折叠就会把"工作区内的根"判成区外、
 * 再"收敛"成同一件事 —— 面板于是报出一次没发生的收敛，用户看到的是一个名字变了的路径。
 */
const foldCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** `abs` 是否落在 `ws` 里（两个都已是绝对路径）。 */
const isInside = (abs: string, ws: string): boolean => {
  const [a, w] = [foldCase(abs), foldCase(ws)];
  return a === w || a.startsWith(w + sep);
};

/**
 * 把文件系统型 MCP 的允许根收敛到工作区。
 *
 * 返回新的 `args`（不改调用方传进来的数组），并把被替换掉的原始根放进 `confinedRoots`。
 * 工作区内的根原样保留 —— 用户本来就写对的情况不该被"修正"成别的东西。
 */
function confineMcpRoots(cfg: McpServerConfig, workspaceRoot: string): { args: string[]; confinedRoots: string[]; changed: boolean } {
  if (!FILESYSTEM_SERVER.test([cfg.command, ...cfg.args].join(' '))) {
    return { args: cfg.args, confinedRoots: [], changed: false };
  }

  const home = homedir();
  const ws = resolve(workspaceRoot);
  const confined: string[] = [];
  let changed = false;
  const seen = new Set<string>();
  /*
   * 入口之前的参数一律原样保留（它们是程序名、包名、开关）—— 见 `firstArgumentIndex`：
   * 把绝对路径形状的入口当成允许根，会把服务器直接弄成起不来。
   */
  const rootsFrom = firstArgumentIndex(cfg.args);

  const next: string[] = [];
  for (let i = 0; i < cfg.args.length; i++) {
    const arg = cfg.args[i];
    if (i < rootsFrom || !looksLikeDirectory(arg)) { next.push(arg); continue; }
    const abs = resolve(arg.startsWith('~') ? join(home, arg.slice(1)) : arg);
    const inside = isInside(abs, ws);
    if (inside) {
      // 已经在工作区里：保留，但仍然去重（用户可能既写了工作区又写了子目录）。
      if (seen.has(foldCase(abs))) { changed = true; continue; }
      seen.add(foldCase(abs));
      next.push(arg);
      continue;
    }
    confined.push(arg);
    changed = true;
    if (!seen.has(foldCase(ws))) { seen.add(foldCase(ws)); next.push(ws); }
  }

  // 一个根都没有（配置里只写了工作区外的目录，且全被收敛）时为 0 个根的服务器拿到空参数列表，
  // 它会把自己的 cwd 当根 —— 那又成了不可控。明确补上工作区。
  if (!next.some((a) => looksLikeDirectory(a))) next.push(ws);

  return { args: next, confinedRoots: confined, changed };
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * MCP 进程的 cwd 必须钉在工作区（评测报告 9b）
 *
 * 实测：`C:\Users\Administrator\.playwright-mcp` 里躺着 340 项 —— 截图 `01-boot-zero-chats.png`、
 * `console-*.log`，全是智能体自己用 playwright 通道做界面验证时留下的。同一个工作区，产物却落在
 * 用户主目录里：在工作区之外、没人清理，`.gitignore` 也管不到。
 *
 * 根因不是 playwright，是**我们没给它 cwd**。`spawn` 不带 cwd 就继承 SHE 的 cwd，而 SHE 的 cwd
 * 取决于你怎么启动它：从终端起来时是工作区，双击桌面版时是 exe 所在目录。playwright MCP 按
 * `join(cwd, '.playwright-mcp')` 决定产物目录（在 `playwright-core/lib/coreBundle.js` 的
 * `outputDir()` 里核过，cwd 不可写时才退到系统临时目录），于是"产物写到哪"变成"看你怎么启动"。
 *
 * 钉住 cwd 之后，同一件事有三个好处，都不需要为哪个具体服务器写特例：
 *   1. 产物目录从"看你怎么启动"变成"永远在工作区里"（顺带落进 `.gitignore`/打包排除的范围）；
 *   2. 文件系统型服务器在"一个根都不剩"时的兜底也落在工作区（见上一条）；
 *   3. 相对路径参数（`"."` 这种）按契约就是相对 cwd 解释的，现在解释基准是工作区。
 *
 * 代价：配置里写**相对命令**（`./tools/my-mcp.js`）的服务器，原来按 SHE 的 cwd 解析，现在按工作区
 * 解析。工作区既是我们给它的 cwd，也是 Cursor 自己解释相对命令的基准，所以按工作区解析是两种启动
 * 方式下都说得通的那个 —— 但必须把相对命令先钉成绝对路径，否则换 cwd 会让原本能起来的服务器起不来。
 */
const PLAYWRIGHT_ARTIFACT_DIR = '.playwright-mcp';

/** 按 cwd 派生产物位置的服务器。playwright MCP 的几个发行版名字都收进来。 */
const CWD_DERIVED_OUTPUT_SERVER = /(?:@playwright\/mcp|playwright-mcp|mcp-server-playwright|@executeautomation\/playwright)/i;

/**
 * 相对命令按**工作区**解析成绝对路径；裸名字（`node`/`npx`/`uvx`）留给 PATH。
 *
 * 换 cwd 之后，相对命令如果还留着相对形式，就会按新 cwd 去找 —— 找不到就等于把这个服务器弄坏了。
 */
function resolveMcpCommand(command: string, workspaceRoot: string): string {
  if (isAbsolute(command)) return command;
  if (!/[\\/]/.test(command)) return command;
  return resolve(workspaceRoot, command);
}

/** 一个服务器真正的启动形态 + 被收敛掉的东西（后者用于回显，不改调用方的配置）。 */
function confineMcpServer(
  raw: { name: string; command: string; args: string[]; source: 'cursor' | 'she' },
  workspaceRoot: string,
): Pick<McpServerConfig, 'command' | 'args' | 'cwd' | 'confinedRoots' | 'confinedOutputDir'> {
  const ws = resolve(workspaceRoot);
  const roots = confineMcpRoots(raw as McpServerConfig, ws);
  const isCwdDerived = CWD_DERIVED_OUTPUT_SERVER.test([raw.command, ...raw.args].join(' '));
  return {
    command: resolveMcpCommand(raw.command, ws),
    args: roots.args,
    cwd: ws,
    ...(roots.changed ? { confinedRoots: roots.confinedRoots } : {}),
    // 产物目录是 cwd 派生的：cwd 钉住了，这里报出它**现在**会写到哪。
    ...(isCwdDerived ? { confinedOutputDir: join(ws, PLAYWRIGHT_ARTIFACT_DIR) } : {}),
  };
}

/**
 * 旧版本留在工作区之外的历史产物（只有按 cwd 派生产物的服务器才有这个说法）。
 *
 * 只报不删：这些文件在用户主目录里，我们没有资格替他清理，但也不能装作没发生过 —— 面板要说得出
 * "以前写在这儿，现在写在那儿"。取 `homedir()` 下的那一份，是因为观测到的那 340 项正是 cwd 恰好
 * 是主目录时的产物。
 */
function legacyOutputDir(cfg: McpServerConfig): { path: string; entries: number } | undefined {
  if (!cfg.confinedOutputDir) return undefined;
  const dir = join(homedir(), PLAYWRIGHT_ARTIFACT_DIR);
  if (foldCase(dir) === foldCase(cfg.confinedOutputDir)) return undefined;
  try {
    const entries = readdirSync(dir).length;
    return entries > 0 ? { path: dir, entries } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `spawn` 的参数，给两个启动点（面板探测、桥）共用 —— 它们曾经各写一份，两份都不带 cwd。
 *
 * Windows 上过 shell 时，参数由 cmd.exe 重新解析，而 Node 只是把 `[command, ...args]` 用空格拼成
 * 一行（实测：`spawn('node', ['-e', '…', 'C:\\Program Files\\x y'], { shell: true })` 到了子进程手里
 * 变成三个参数）。带空格的命令与参数不加引号就会被拆开，"配置看起来没问题、一启动就找不到命令/根
 * 也认不出来"。
 *
 * 只补"含空白且不含引号"的那一类：这种参数今天 100% 是被拆坏的，加引号只会变好；已经带引号的
 * 原样保留，不去猜用户的引号意图。
 */
export function mcpSpawnSpec(cfg: McpServerConfig): {
  command: string;
  args: string[];
  options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; shell: boolean; windowsHide: boolean; cwd: string };
} {
  const win = process.platform === 'win32';
  const quote = (s: string): string => (win && /\s/.test(s) && !s.includes('"') ? `"${s}"` : s);
  return {
    command: quote(cfg.command),
    args: cfg.args.map(quote),
    options: {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: win,
      windowsHide: true,
      cwd: cfg.cwd ?? process.cwd(),
    },
  };
}

/** Discover MCP servers from Cursor configs and SHE's own override file. */
export function discoverMcpServers(workspaceRoot: string): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();

  // SHE-managed file wins (allows adding/enabling without touching Cursor).
  const sheFile = join(workspaceRoot, SHE_MCP_FILE);
  const she = existsSync(sheFile) ? (readJson(sheFile) as RawMcpFile | null) : null;
  const sheServers = she?.mcpServers ?? {};
  for (const [name, cfg] of Object.entries(sheServers)) {
    if (!cfg?.command) continue;
    out.push({
      name,
      ...confineMcpServer({ name, command: cfg.command, args: cfg.args ?? [], source: 'she' }, workspaceRoot),
      env: cfg.env,
      source: 'she',
      enabled: cfg.disabled !== true,
    });
    seen.add(name);
  }

  for (const p of cursorMcpPaths()) {
    if (!existsSync(p)) continue;
    const parsed = readJson(p) as RawMcpFile | null;
    for (const [name, cfg] of Object.entries(parsed?.mcpServers ?? {})) {
      if (!cfg?.command || seen.has(name)) continue;
      out.push({
        name,
        ...confineMcpServer({ name, command: cfg.command, args: cfg.args ?? [], source: 'cursor' }, workspaceRoot),
        env: cfg.env,
        source: 'cursor',
        enabled: cfg.disabled !== true,
      });
      seen.add(name);
    }
  }

  return out;
}

/** Add or update a server in SHE's own mcp.json. */
export function writeMcpServer(
  workspaceRoot: string,
  server: { name: string; command: string; args: string[]; env?: Record<string, string> },
): void {
  const file = join(workspaceRoot, SHE_MCP_FILE);
  const cur = (existsSync(file) ? readJson(file) : null) as RawMcpFile | null;
  const data: RawMcpFile = cur ?? { mcpServers: {} };
  data.mcpServers = data.mcpServers ?? {};
  data.mcpServers[server.name] = {
    command: server.command,
    args: server.args,
    ...(server.env ? { env: server.env } : {}),
  };
  mkdirSync(join(workspaceRoot, '.she'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

export function removeMcpServer(workspaceRoot: string, name: string): boolean {
  const file = join(workspaceRoot, SHE_MCP_FILE);
  if (!existsSync(file)) return false;
  const data = (readJson(file) as RawMcpFile | null) ?? { mcpServers: {} };
  if (!data.mcpServers?.[name]) return false;
  delete data.mcpServers[name];
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return true;
}

export function setMcpServerEnabled(workspaceRoot: string, name: string, enabled: boolean): boolean {
  const file = join(workspaceRoot, SHE_MCP_FILE);
  const data = (existsSync(file) ? readJson(file) : null) as RawMcpFile | null;
  if (!data?.mcpServers?.[name]) return false;
  data.mcpServers[name] = { ...data.mcpServers[name], disabled: !enabled };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return true;
}

// ─── live probe ─────────────────────────────────────────────────────────────

/**
 * Start a stdio MCP server, perform the initialize handshake, and ask for its
 * tool list. This is a real reachability check, not a config-file guess.
 */
function probeServer(
  cfg: McpServerConfig,
  timeoutMs = 12000,
): Promise<{ reachable: boolean; toolCount: number | null; error?: string; latencyMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let child: ChildProcess | null = null;
    let buffer = '';
    let settled = false;
    let toolCount: number | null = null;

    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      try { child?.kill(); } catch { /* ignore */ }
      resolve({ reachable, toolCount, error, latencyMs: Date.now() - started });
    };

    try {
      const spec = mcpSpawnSpec(cfg);
      child = spawn(spec.command, spec.args, spec.options);
    } catch (e) {
      finish(false, (e as Error).message);
      return;
    }

    const send = (msg: unknown) => {
      try { child?.stdin?.write(JSON.stringify(msg) + '\n'); } catch { /* ignore */ }
    };

    child.on('error', (e) => finish(false, e.message));
    child.on('exit', (code) => {
      if (!settled) finish(false, `进程退出 (code ${code})`);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { tools?: unknown[]; serverInfo?: unknown } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          /*
           * Acknowledge first, THEN ask for tools.
           *
           * Per the spec the client MUST send `notifications/initialized` before any other
           * request, and a compliant server may refuse everything until it arrives. The bridge
           * does this; the probe did not, so a strict server answered `tools/list` with an error
           * the probe could not read — and the panel reported "超时" for a server the agent could
           * call perfectly well. Two implementations of one handshake, disagreeing.
           */
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2 && msg.result) {
          toolCount = Array.isArray(msg.result.tools) ? msg.result.tools.length : 0;
          finish(true);
        }
      }
    });

    child.stderr?.on('data', () => { /* servers are chatty; ignore */ });

    // handshake
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'she', version: productVersion() },
      },
    });

    setTimeout(() => finish(false, `超时 (${timeoutMs}ms)`), timeoutMs);
  });
}

/**
 * Strip secret values from a server config before it leaves the server.
 *
 * `env` routinely carries tokens (that is what it is for), and the whole object was returned by
 * `GET /api/mcp/servers`, so the panel handed every configured MCP token back to the caller. The
 * keys are kept so the user can see WHICH variables the server is configured with — the values are
 * what must not travel.
 */
function redactMcpEnv(cfg: McpServerConfig): McpServerConfig {
  if (!cfg.env) return cfg;
  return { ...cfg, env: Object.fromEntries(Object.keys(cfg.env).map((k) => [k, '***'])) };
}

/** 面板要显示的那一份：抹掉密钥 + 报出历史产物（只报不删，见 `legacyOutputDir`）。 */
function panelView(cfg: McpServerConfig): McpServerConfig {
  const redacted = redactMcpEnv(cfg);
  const legacy = legacyOutputDir(cfg);
  return legacy ? { ...redacted, legacyOutputDir: legacy } : redacted;
}

/** List every discovered server together with a live probe result. */
export async function listMcpServers(workspaceRoot: string, inject: McpInjectLookup = NO_INJECT): Promise<McpServerStatus[]> {
  const servers = discoverMcpServers(workspaceRoot);
  const results = await Promise.all(
    servers.map(async (s) => {
      const probe = await probeServer(s);
      return { ...panelView(s), reachable: probe.reachable, toolCount: probe.toolCount, error: probe.error, latencyMs: probe.latencyMs, ...inject(s.name) };
    }),
  );
  return results;
}

/** Probe a single named server. */
export async function probeMcpServer(workspaceRoot: string, name: string, inject: McpInjectLookup = NO_INJECT): Promise<McpServerStatus | null> {
  const cfg = discoverMcpServers(workspaceRoot).find((s) => s.name === name);
  if (!cfg) return null;
  const probe = await probeServer(cfg);
  return { ...panelView(cfg), reachable: probe.reachable, toolCount: probe.toolCount, error: probe.error, latencyMs: probe.latencyMs, ...inject(cfg.name) };
}
