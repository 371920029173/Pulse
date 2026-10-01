import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
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

/** 这个参数看起来是不是一个"目录"（而不是包名或开关）。 */
function looksLikeDirectory(arg: string): boolean {
  if (!arg || arg.startsWith('-')) return false;
  if (arg.startsWith('~')) return true;
  return isAbsolute(arg);
}

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

  const next: string[] = [];
  for (const arg of cfg.args) {
    if (!looksLikeDirectory(arg)) { next.push(arg); continue; }
    const abs = resolve(arg.startsWith('~') ? join(home, arg.slice(1)) : arg);
    const inside = abs === ws || abs.startsWith(ws + sep);
    if (inside) {
      // 已经在工作区里：保留，但仍然去重（用户可能既写了工作区又写了子目录）。
      if (seen.has(abs)) { changed = true; continue; }
      seen.add(abs);
      next.push(arg);
      continue;
    }
    confined.push(arg);
    changed = true;
    if (!seen.has(ws)) { seen.add(ws); next.push(ws); }
  }

  // 一个根都没有（配置里只写了工作区外的目录，且全被收敛）时为 0 个根的服务器拿到空参数列表，
  // 它会把自己的 cwd 当根 —— 那又成了不可控。明确补上工作区。
  if (!next.some((a) => looksLikeDirectory(a))) next.push(ws);

  return { args: next, confinedRoots: confined, changed };
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
    const confined = confineMcpRoots({ name, command: cfg.command, args: cfg.args ?? [], source: 'she' }, workspaceRoot);
    out.push({
      name,
      command: cfg.command,
      args: confined.args,
      env: cfg.env,
      source: 'she',
      enabled: cfg.disabled !== true,
      ...(confined.changed ? { confinedRoots: confined.confinedRoots } : {}),
    });
    seen.add(name);
  }

  for (const p of cursorMcpPaths()) {
    if (!existsSync(p)) continue;
    const parsed = readJson(p) as RawMcpFile | null;
    for (const [name, cfg] of Object.entries(parsed?.mcpServers ?? {})) {
      if (!cfg?.command || seen.has(name)) continue;
      const confined = confineMcpRoots({ name, command: cfg.command, args: cfg.args ?? [], source: 'cursor' }, workspaceRoot);
      out.push({
        name,
        command: cfg.command,
        args: confined.args,
        env: cfg.env,
        source: 'cursor',
        enabled: cfg.disabled !== true,
        ...(confined.changed ? { confinedRoots: confined.confinedRoots } : {}),
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
      child = spawn(cfg.command, cfg.args, {
        env: { ...process.env, ...(cfg.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });
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

/** List every discovered server together with a live probe result. */
export async function listMcpServers(workspaceRoot: string, inject: McpInjectLookup = NO_INJECT): Promise<McpServerStatus[]> {
  const servers = discoverMcpServers(workspaceRoot);
  const results = await Promise.all(
    servers.map(async (s) => {
      const probe = await probeServer(s);
      return { ...redactMcpEnv(s), reachable: probe.reachable, toolCount: probe.toolCount, error: probe.error, latencyMs: probe.latencyMs, ...inject(s.name) };
    }),
  );
  return results;
}

/** Probe a single named server. */
export async function probeMcpServer(workspaceRoot: string, name: string, inject: McpInjectLookup = NO_INJECT): Promise<McpServerStatus | null> {
  const cfg = discoverMcpServers(workspaceRoot).find((s) => s.name === name);
  if (!cfg) return null;
  const probe = await probeServer(cfg);
  return { ...redactMcpEnv(cfg), reachable: probe.reachable, toolCount: probe.toolCount, error: probe.error, latencyMs: probe.latencyMs, ...inject(cfg.name) };
}
