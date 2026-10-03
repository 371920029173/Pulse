/**
 * MCP bridge: configured MCP servers, reachable by the agent through two static meta-tools.
 *
 * `mcp.ts` discovers configs and probes them. This module keeps ONE long-lived stdio session per
 * enabled server and routes calls to it.
 *
 * ## Lazy exposure (why there are exactly two tools)
 *
 * The first version registered every MCP tool as its own function (`mcp_<server>_<tool>`). Measured
 * on a real workspace that was 52 tools / ~36.6k characters (~10.5k tokens) added to EVERY request,
 * while 20 of 440 tool calls used any of them. Worse, the table was not byte-stable: a server that
 * failed to connect within the startup budget dropped its tools, a refresh rebuilt every agent, and
 * the tool table (which sits in the provider's cache prefix) changed size between restarts, so a
 * resumed session paid a full cache miss.
 *
 * So the agent now gets `mcp_list` and `mcp_call`, whose definitions are STATIC TEXT: no server
 * names, no counts, nothing that moves when servers come, go or fail. `mcp_list` reads the live
 * sessions; `mcp_call` routes `{server, tool, arguments}`. The table never changes on refresh, so
 * a refresh no longer needs to rebuild agents.
 *
 * ## Security
 *
 * An MCP server is a separate process with whatever access it has; it is NOT inside the sandbox
 * (the filesystem server can read `.she/kb.sqlite` or anything outside the workspace). So
 * `mcp_call` is never a trusted built-in: with `requireConfirm` every call goes through the same
 * confirm-ticket gate the sandbox uses for dangerous built-ins, and the ticket is bound to the exact
 * server + tool + arguments. `mcp_list` only reads what the servers advertise and needs no ticket.
 *
 * ## Orphans
 *
 * A server killed hard (`taskkill /F`, a crash) never runs its exit handlers, and on Windows child
 * processes do not die with their parent. Every spawned server is therefore recorded in
 * `.she/mcp-pids/<owner pid>.json`; the next bridge in that workspace reaps entries whose owner is
 * dead, but only when the live process's command line still matches the recorded server command
 * (a recycled PID belonging to something else is never touched).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '@she/shared';
import { ConfirmTicketStore } from '@she/sandbox';
import { discoverMcpServers, mcpSpawnSpec, type McpServerConfig } from './mcp.js';
import { productVersion } from './version.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
/** Same order of magnitude as other tool output caps; a clear note is appended when cut. */
export const MCP_OUTPUT_CAP = 20_000;
/** A tool's own description, when `mcp_list` shows one server in full. */
export const MCP_DESCRIPTION_CAP = 1000;
/** One tool's input schema in `mcp_list`. */
export const MCP_SCHEMA_CAP = 4000;
export const MCP_LIST_TOOL = 'mcp_list';
export const MCP_CALL_TOOL = 'mcp_call';

/**
 * The two meta-tools. STATIC on purpose: this text is part of the cached request prefix of every
 * session, so it must not contain anything derived from the current servers.
 */
export const MCP_META_DEFINITIONS: ToolDefinition[] = [
  {
    name: MCP_LIST_TOOL,
    description:
      'List the tools offered by the user\'s MCP (Model Context Protocol) servers. MCP tools are not in '
      + 'your tool list directly; discover them here, then run one with mcp_call. Without arguments: '
      + 'every server with its status and one line per tool. With "server": that server\'s tools with '
      + 'their full input schemas. "query" filters tools by name or description; a query equal to a '
      + 'tool name also returns that tool\'s input schema. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Only this server (name as shown by mcp_list); includes input schemas.' },
        query: { type: 'string', description: 'Case-insensitive filter on tool name and description.' },
      },
    },
  },
  {
    name: MCP_CALL_TOOL,
    description:
      'Call one tool on one of the user\'s MCP servers. Take the server name, tool name and the '
      + 'tool\'s input schema from mcp_list first. MCP servers run outside the sandbox, so a call may '
      + 'wait for the user\'s approval.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name, as listed by mcp_list.' },
        tool: { type: 'string', description: 'Tool name on that server, as listed by mcp_list.' },
        arguments: { type: 'object', description: 'Arguments for the tool, matching its input schema.' },
      },
      required: ['server', 'tool'],
    },
  },
];

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpInjectStatus {
  /** Tools from this server currently callable through `mcp_call`. */
  injected: number;
  /** Why the server offers nothing right now (start failure, crash). */
  injectError?: string;
}

export interface McpRefreshSummary {
  /** Servers with a live session, sorted. */
  running: string[];
  /** Enabled servers that could not be started, sorted. */
  failed: string[];
  /** Tools callable through `mcp_call` across all running servers. */
  tools: number;
}

export class McpTimeoutError extends Error {}
export class McpRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** Byte-order comparison: `localeCompare` would make the order depend on the host. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function capText(text: string, cap = MCP_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[output truncated: ${text.length} chars total, first ${cap} shown]`;
}

/** First line of a description, whitespace collapsed, short. */
function oneLine(description: string | undefined, cap = 160): string {
  const first = String(description ?? '').trim().split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return first.length > cap ? first.slice(0, cap - 1) + '\u2026' : first;
}

function schemaOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { type: 'object', properties: {} };
  const s = { ...(input as Record<string, unknown>) };
  if (!s.type) s.type = 'object';
  if (s.type === 'object' && (!s.properties || typeof s.properties !== 'object')) s.properties = {};
  return s;
}

function schemaText(input: unknown): string {
  const text = JSON.stringify(schemaOf(input));
  return text.length > MCP_SCHEMA_CAP ? `${text.slice(0, MCP_SCHEMA_CAP)} ...(schema truncated at ${MCP_SCHEMA_CAP} chars)` : text;
}

/** Render a `tools/call` result's `content` array as the text the model reads. */
export function mcpContentToText(result: unknown): string {
  const r = (result ?? {}) as { content?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  for (const raw of Array.isArray(r.content) ? r.content : []) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const res = (p.resource ?? {}) as Record<string, unknown>;
    switch (p.type) {
      case 'text':
        parts.push(String(p.text ?? ''));
        break;
      case 'image':
        parts.push(`[image: ${String(p.mimeType ?? 'unknown')}]`);
        break;
      case 'audio':
        parts.push(`[audio: ${String(p.mimeType ?? 'unknown')}]`);
        break;
      case 'resource':
        parts.push(typeof res.text === 'string'
          ? `[resource: ${String(res.uri ?? '')}]\n${res.text}`
          : `[resource: ${String(res.uri ?? '')}${res.mimeType ? ' (' + String(res.mimeType) + ')' : ''}]`);
        break;
      case 'resource_link':
        parts.push(`[resource: ${String(p.uri ?? '')}]`);
        break;
      default:
        parts.push(`[${String(p.type ?? 'unknown')} content]`);
    }
  }
  if (!parts.length && r.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  return parts.join('\n');
}

/**
 * The one failure shape for "the MCP server said no" (a result with `isError`, or a JSON-RPC error).
 * Starts with `Error:` so the tool-result classifier counts it; see the MCP rule in tool-result.ts.
 */
export function mcpToolError(server: string, tool: string, text: string): string {
  return `Error: MCP server ${server} reported an error from tool ${tool}: ${text || '(no details)'}`;
}

/** Kill a process and its children by PID (Windows: the whole tree, since a shell sits in between). */
function killPidTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      return;
    } catch { /* fall through */ }
  }
  try { process.kill(pid); } catch { /* already gone */ }
}

/**
 * Stop a server process and everything it started.
 *
 * On Windows the spawn goes through a shell (so `npx` resolves), and `child.kill()` only kills that
 * shell: the real server (node under npx) would be orphaned on every refresh. `taskkill /T` takes
 * the tree. Closing stdin first lets a well-behaved server exit on its own.
 */
function killTree(child: ChildProcess | null): void {
  if (!child) return;
  try { child.stdin?.end(); } catch { /* ignore */ }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    killPidTree(child.pid);
    return;
  }
  try { child.kill(); } catch { /* ignore */ }
}

/** Whether a PID is running (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A running process's command line, or null when it cannot be read. */
export function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      const out = String(r.stdout ?? '').trim();
      return out || null;
    }
    if (existsSync(`/proc/${pid}/cmdline`)) {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
    }
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    return String(r.stdout ?? '').trim() || null;
  } catch {
    return null;
  }
}

interface PidEntry { server: string; pid: number; needles: string[] }

/**
 * Which server processes this bridge started, on disk, so a successor can clean up after a hard kill.
 *
 * One file per owning process (`<pid>.json`): two servers may share one workspace (a launcher
 * instance and the desktop's embedded one), and neither may reap the other's live children.
 */
export class McpPidRegistry {
  private entries = new Map<string, PidEntry[]>();

  /** Strings that must all appear in a process's command line for it to count as "ours". */
  static needlesFor(cfg: McpServerConfig): string[] {
    return [cfg.command, ...cfg.args.slice(0, 1)]
      .map((s) => String(s ?? '').replace(/"/g, '').trim())
      .filter((s) => s.length > 0);
  }

  private fileIn(dir: string): string {
    return join(dir, `${process.pid}.json`);
  }

  private save(dir: string): void {
    const list = this.entries.get(dir) ?? [];
    try {
      if (!list.length) {
        rmSync(this.fileIn(dir), { force: true });
        return;
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.fileIn(dir), JSON.stringify({ owner: process.pid, children: list }, null, 2), 'utf8');
    } catch { /* bookkeeping must never break a server start */ }
  }

  record(dir: string | null, entry: PidEntry): void {
    if (!dir) return;
    const list = (this.entries.get(dir) ?? []).filter((e) => e.pid !== entry.pid);
    list.push(entry);
    this.entries.set(dir, list);
    this.save(dir);
  }

  forget(pid: number): void {
    for (const [dir, list] of this.entries) {
      const next = list.filter((e) => e.pid !== pid);
      if (next.length !== list.length) {
        this.entries.set(dir, next);
        this.save(dir);
      }
    }
  }

  clear(): void {
    for (const dir of [...this.entries.keys()]) {
      this.entries.set(dir, []);
      this.save(dir);
    }
  }

  /**
   * Kill children left behind by DEAD owners in `dir`. Returns the PIDs killed.
   *
   * A child is only killed when it is alive AND its command line contains every recorded needle,
   * so a recycled PID now belonging to an unrelated process is left alone. A file whose owner is
   * still running is never touched.
   */
  reapStale(dir: string | null, log: (m: string) => void): number[] {
    if (!dir || !existsSync(dir)) return [];
    const killed: number[] = [];
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
    for (const f of files) {
      const owner = Number(f.slice(0, -5));
      if (owner === process.pid || pidAlive(owner)) continue;
      let children: PidEntry[] = [];
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { children?: PidEntry[] };
        children = Array.isArray(parsed.children) ? parsed.children : [];
      } catch { /* unreadable: just remove it */ }
      for (const c of children) {
        if (!pidAlive(c.pid)) continue;
        const line = processCommandLine(c.pid);
        const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
        const matches = line !== null && Array.isArray(c.needles) && c.needles.length > 0
          && c.needles.every((n) => fold(line).includes(fold(String(n))));
        if (!matches) {
          log(`MCP: stale pid ${c.pid} (${c.server}) no longer runs the recorded command; left alone`);
          continue;
        }
        killPidTree(c.pid);
        killed.push(c.pid);
        log(`MCP: reaped orphaned server process ${c.pid} (${c.server}) left by dead owner ${owner}`);
      }
      try { rmSync(join(dir, f), { force: true }); } catch { /* ignore */ }
    }
    return killed;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 起不来的服务器，stderr 里最该给人看的那两行。
 *
 * 取"最后三行"是错的，而且错得很有欺骗性：Node 崩溃的结尾是 `}` 加版本横幅
 * （`Node.js v22.16.0`），于是面板上报的启动失败**看不到原因**。实测（2026-10-02）：
 * filesystem 服务器被以 `node <工作区目录>` 启动（见 `mcp.ts` 的 `firstArgumentIndex`），
 * exit 1，而唯一留下的线索就是那句横幅 —— 看起来像服务器自己的毛病。
 *
 * 所以先找错误行（`Error:` / `ERR_*` / `Cannot find` / `EACCES` …），连它下面那一行
 * （通常是 `at …` 的定位）一起给出；找不到才退回最后三行。
 */
export function stderrReason(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const at = lines.findIndex((l) => /(?:^|\s)(?:Error|ERR_[A-Z]+|EACCES|ENOENT|Cannot find|is not recognized|SyntaxError|TypeError|MODULE_NOT_FOUND)/.test(l));
  const picked = at >= 0 ? lines.slice(at, at + 2) : lines.slice(-3);
  return picked.join(' | ').slice(0, 400);
}

/** One long-lived stdio connection to an MCP server (newline-delimited JSON-RPC). */
export class McpSession {
  tools: McpRemoteTool[] = [];
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail = '';
  private exitInfo: string | null = 'not started';

  constructor(
    readonly cfg: McpServerConfig,
    private log: (m: string) => void,
    private hooks: { spawned?: (pid: number) => void; closed?: (pid: number) => void } = {},
  ) {}

  get name(): string { return this.cfg.name; }
  get alive(): boolean { return this.child !== null && this.exitInfo === null; }
  /** Why the process is not running, or null while it is. */
  get lastExit(): string | null { return this.exitInfo; }

  /** Spawn, handshake, list tools. Rejects (and leaves the session dead) on any failure. */
  async start(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    this.buffer = '';
    this.stderrTail = '';
    const decoder = new StringDecoder('utf8');
    // cwd is pinned to the workspace: see `confineMcpServer` in mcp.ts.
    const spec = mcpSpawnSpec(this.cfg);
    const child = spawn(spec.command, spec.args, spec.options);
    this.child = child;
    this.exitInfo = null;
    if (child.pid) this.hooks.spawned?.(child.pid);
    // Events from a previous child (after a restart) must not touch the new one.
    child.on('error', (e) => { if (this.child === child) this.markDead(`spawn failed: ${e.message}`); });
    child.on('exit', (code, signal) => {
      if (child.pid) this.hooks.closed?.(child.pid);
      if (this.child === child) this.markDead(`process exited (code ${code ?? signal})`);
    });
    child.stdin?.on('error', () => { /* EPIPE after the process died; reported via exit */ });
    child.stdout?.on('data', (c: Buffer) => { if (this.child === child) this.onData(decoder.write(c)); });
    child.stderr?.on('data', (c: Buffer) => { this.stderrTail = (this.stderrTail + c.toString('utf8')).slice(-1500); });

    try {
      await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'she', version: productVersion() },
      }, Math.max(1, deadline - Date.now()));
      this.notify('notifications/initialized', {});
      this.tools = await this.listTools(deadline);
    } catch (e) {
      this.close((e as Error).message);
      throw e;
    }
  }

  private async listTools(deadline: number): Promise<McpRemoteTool[]> {
    const out: McpRemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {}, Math.max(1, deadline - Date.now()))) as {
        tools?: McpRemoteTool[]; nextCursor?: string;
      };
      for (const t of Array.isArray(res?.tools) ? res.tools : []) {
        if (t && typeof t.name === 'string' && t.name) out.push(t);
      }
      if (!res?.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
    return out.sort((a, b) => cmp(a.name, b.name));
  }

  private onData(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: { id?: number | string; method?: string; result?: unknown; error?: { code?: number; message?: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method !== undefined) {
        // A request FROM the server. Answer the two that matter so it does not wait forever.
        if (msg.id !== undefined && msg.id !== null) {
          if (msg.method === 'ping') this.write({ jsonrpc: '2.0', id: msg.id, result: {} });
          else this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not supported: ${msg.method}` } });
        }
        continue;
      }
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new McpRpcError(msg.error.message ?? 'JSON-RPC error', msg.error.code));
      else p.resolve(msg.result);
    }
  }

  private write(msg: unknown): void {
    try { this.child?.stdin?.write(JSON.stringify(msg) + '\n'); } catch { /* reported via exit */ }
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`MCP server ${this.name} is not running (${this.exitInfo})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // Tell the server to stop working on it; harmless if it ignores the notification.
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new McpTimeoutError(`MCP server ${this.name}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private markDead(reason: string): void {
    if (this.exitInfo !== null) return;
    const tail = stderrReason(this.stderrTail);
    this.exitInfo = tail ? `${reason}; stderr: ${tail}` : reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server ${this.name}: ${this.exitInfo}`));
    }
    this.pending.clear();
  }

  close(reason = 'closed'): void {
    const child = this.child;
    this.markDead(reason);
    this.child = null;
    killTree(child);
  }
}

export interface McpBridgeDeps {
  /** Workspace whose `.she/mcp.json` (plus the user's Cursor config) is read. */
  workspaceRoot: () => string;
  log: (msg: string) => void;
  /** Injected for tests; defaults to `discoverMcpServers`. */
  discover?: (workspaceRoot: string) => McpServerConfig[];
  /** Budget for starting all servers (in parallel). Default 15s. */
  connectTimeoutMs?: number;
  /** Per `tools/call` timeout. Default 60s. */
  callTimeoutMs?: number;
  /**
   * Where spawned server PIDs are recorded for orphan reaping. Default `<workspace>/.she/mcp-pids`;
   * return null to disable.
   */
  pidDir?: () => string | null;
}

const fingerprint = (c: McpServerConfig): string => JSON.stringify([c.command, c.args, c.env ?? {}, c.cwd ?? '']);

export class McpBridge {
  private sessions = new Map<string, McpSession>();
  private restarting = new Map<string, Promise<McpSession | string>>();
  private failures = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly pids = new McpPidRegistry();
  private reapedDirs = new Set<string>();

  constructor(private deps: McpBridgeDeps) {}

  private get connectTimeoutMs(): number { return this.deps.connectTimeoutMs ?? 15_000; }
  private get callTimeoutMs(): number { return this.deps.callTimeoutMs ?? 60_000; }

  private pidDir(): string | null {
    try {
      return this.deps.pidDir ? this.deps.pidDir() : join(this.deps.workspaceRoot(), '.she', 'mcp-pids');
    } catch {
      return null;
    }
  }

  private discover(): McpServerConfig[] {
    try {
      return (this.deps.discover ?? discoverMcpServers)(this.deps.workspaceRoot());
    } catch (e) {
      this.deps.log(`MCP: config discovery failed: ${(e as Error).message}`);
      return [];
    }
  }

  private newSession(cfg: McpServerConfig): McpSession {
    const dir = this.pidDir();
    const needles = McpPidRegistry.needlesFor(cfg);
    return new McpSession(cfg, this.deps.log, {
      spawned: (pid) => this.pids.record(dir, { server: cfg.name, pid, needles }),
      closed: (pid) => this.pids.forget(pid),
    });
  }

  /**
   * The agent's MCP tools: always the same two static definitions, whatever the servers are doing.
   * See the module comment; this is what keeps the tool table byte-stable across refreshes.
   */
  definitions(): ToolDefinition[] {
    return MCP_META_DEFINITIONS;
  }

  owns(name: string): boolean {
    return name === MCP_LIST_TOOL || name === MCP_CALL_TOOL;
  }

  /** What `mcp_call` can reach on one server right now (panel: "available via mcp_call"). */
  injectStatus(server: string): McpInjectStatus {
    const s = this.sessions.get(server);
    if (s?.alive) return { injected: s.tools.length };
    const why = this.failures.get(server) ?? (s ? s.lastExit ?? undefined : undefined);
    return why ? { injected: 0, injectError: why } : { injected: 0 };
  }

  /**
   * Reconnect according to the current config.
   *
   * Unchanged, still-running sessions are kept; removed, disabled or edited ones are stopped; new
   * ones are started in parallel, each bounded by `connectTimeoutMs`. Calls are serialised so two
   * routes firing together cannot interleave. The tool table does not depend on any of this.
   */
  refresh(): Promise<McpRefreshSummary> {
    const run = this.chain.then(() => this.doRefresh(), () => this.doRefresh());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private summary(): McpRefreshSummary {
    const running = [...this.sessions.entries()].filter(([, s]) => s.alive).map(([n]) => n).sort(cmp);
    return {
      running,
      failed: [...this.failures.keys()].sort(cmp),
      tools: running.reduce((n, name) => n + (this.sessions.get(name)?.tools.length ?? 0), 0),
    };
  }

  private async doRefresh(): Promise<McpRefreshSummary> {
    if (this.stopped) return this.summary();
    const dir = this.pidDir();
    if (dir && !this.reapedDirs.has(dir)) {
      this.reapedDirs.add(dir);
      try { this.pids.reapStale(dir, this.deps.log); } catch { /* never block startup on cleanup */ }
    }
    const wanted = new Map(this.discover().filter((c) => c.enabled !== false).map((c) => [c.name, c] as const));

    for (const [name, s] of [...this.sessions]) {
      const want = wanted.get(name);
      if (!want || !s.alive || fingerprint(want) !== fingerprint(s.cfg)) {
        s.close();
        this.sessions.delete(name);
      }
    }
    for (const name of [...this.failures.keys()]) if (!wanted.has(name)) this.failures.delete(name);

    const starting = [...wanted.values()]
      .filter((cfg) => !this.sessions.has(cfg.name))
      .map(async (cfg) => {
        const s = this.newSession(cfg);
        try {
          await s.start(this.connectTimeoutMs);
          return { cfg, s, error: null as string | null };
        } catch (e) {
          return { cfg, s, error: (e as Error).message };
        }
      });
    for (const r of await Promise.all(starting)) {
      if (this.stopped) { r.s.close(); continue; }
      if (r.error) {
        r.s.close();
        this.failures.set(r.cfg.name, r.error);
        this.deps.log(`MCP ${r.cfg.name}: failed to start: ${r.error}`);
      } else {
        this.failures.delete(r.cfg.name);
        this.sessions.set(r.cfg.name, r.s);
      }
    }
    return this.summary();
  }

  /** A live session for `server`, restarting it once if it is enabled but dead. Error text otherwise. */
  private async ensureSession(server: string): Promise<McpSession | string> {
    const s = this.sessions.get(server);
    if (s?.alive) return s;
    const cfg = this.discover().find((c) => c.name === server);
    if (!cfg) return 'not configured';
    if (cfg.enabled === false) return 'not enabled (the user can enable it in the MCP panel)';
    const why = s?.lastExit ?? this.failures.get(server) ?? 'not running';
    const restarted = await this.restart(server, cfg);
    return typeof restarted === 'string' ? `stopped (${why}) and could not be restarted (${restarted})` : restarted;
  }

  /** Restart a dead server once; concurrent callers share the attempt. */
  private restart(server: string, cfg: McpServerConfig): Promise<McpSession | string> {
    const inflight = this.restarting.get(server);
    if (inflight) return inflight;
    const attempt = (async () => {
      this.sessions.get(server)?.close();
      const s = this.newSession(cfg);
      try {
        await s.start(this.connectTimeoutMs);
        if (this.stopped) { s.close(); return 'bridge is shut down'; }
        this.sessions.set(server, s);
        this.failures.delete(server);
        this.deps.log(`MCP ${server}: restarted`);
        return s;
      } catch (e) {
        this.sessions.delete(server);
        this.failures.set(server, (e as Error).message);
        return (e as Error).message;
      }
    })();
    this.restarting.set(server, attempt);
    void attempt.finally(() => this.restarting.delete(server));
    return attempt;
  }

  /** Run `mcp_list` or `mcp_call`. */
  async execute(
    name: string,
    args: Record<string, unknown>,
    opts: { requireConfirm?: boolean; workspaceRoot?: string } = {},
  ): Promise<string> {
    if (name === MCP_LIST_TOOL) return this.list(args);
    if (name === MCP_CALL_TOOL) return this.call(args, opts);
    return `Error: MCP tool "${name}" is not available`;
  }

  private async list(args: Record<string, unknown>): Promise<string> {
    const server = typeof args.server === 'string' ? args.server.trim() : '';
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const matches = (t: McpRemoteTool) => !query
      || t.name.toLowerCase().includes(query)
      || String(t.description ?? '').toLowerCase().includes(query);
    const configs = this.discover().sort((a, b) => cmp(a.name, b.name));
    const howToCall = 'Call a tool with mcp_call {"server": ..., "tool": ..., "arguments": {...}}.';

    if (server) {
      const cfg = configs.find((c) => c.name === server);
      if (!cfg && !this.sessions.get(server)?.alive) {
        const known = configs.map((c) => c.name).join(', ') || '(none)';
        return `Error: MCP server "${server}" is not available: not configured. Configured servers: ${known}`;
      }
      if (cfg && cfg.enabled === false) {
        return `MCP server "${server}" is configured but not enabled, so its tools cannot be called. `
          + 'The user can enable it in the MCP panel.';
      }
      const s = await this.ensureSession(server);
      if (typeof s === 'string') return `Error: MCP server "${server}" is not available: ${s}`;
      const tools = s.tools.filter(matches);
      const out = [`MCP server ${server}: ${s.tools.length} tool(s)${query ? `, ${tools.length} matching "${query}"` : ''}. ${howToCall}`];
      for (const t of tools) {
        const desc = String(t.description ?? '').trim();
        out.push('', `## ${t.name}`,
          desc.length > MCP_DESCRIPTION_CAP ? desc.slice(0, MCP_DESCRIPTION_CAP - 1) + '\u2026' : desc || '(no description)',
          `input schema: ${schemaText(t.inputSchema)}`);
      }
      return capText(out.join('\n'));
    }

    if (!configs.length) return 'No MCP servers are configured. The user can add one in the MCP panel.';
    const enabled = configs.filter((c) => c.enabled !== false);
    const out: string[] = [enabled.length
      ? `MCP servers. ${howToCall} Call mcp_list with "server" for input schemas.`
      : 'No MCP server is enabled, so no MCP tool can be called right now. The user can enable one in the MCP panel.'];
    const exact: Array<{ server: string; tool: McpRemoteTool }> = [];
    for (const c of configs) {
      if (c.enabled === false) {
        if (!query) out.push(`- ${c.name}: not enabled${c.source === 'cursor' ? ' (found in the Cursor config)' : ''}`);
        continue;
      }
      const s = this.sessions.get(c.name);
      if (!s?.alive) {
        if (!query) out.push(`- ${c.name}: not running (${(this.failures.get(c.name) ?? s?.lastExit ?? 'not started').slice(0, 300)})`);
        continue;
      }
      const tools = s.tools.filter(matches);
      if (query && !tools.length) continue;
      out.push(`- ${c.name}: ${s.tools.length} tool(s)${query ? `, ${tools.length} matching` : ''}`);
      for (const t of tools) {
        out.push(`  - ${t.name}: ${oneLine(t.description) || '(no description)'}`);
        if (query && t.name.toLowerCase() === query) exact.push({ server: c.name, tool: t });
      }
    }
    if (query && out.length === 1) out.push(`(no tool matches "${query}")`);
    for (const e of exact) out.push('', `## ${e.server} / ${e.tool.name}`, `input schema: ${schemaText(e.tool.inputSchema)}`);
    return capText(out.join('\n'));
  }

  private async call(args: Record<string, unknown>, opts: { requireConfirm?: boolean; workspaceRoot?: string }): Promise<string> {
    const server = typeof args.server === 'string' ? args.server.trim() : '';
    const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!server || !tool) return 'Error: mcp_call: "server" and "tool" are required (see mcp_list)';
    let callArgs: unknown = args.arguments ?? {};
    // Models sometimes send the arguments as a JSON string; accept that, it is unambiguous.
    if (typeof callArgs === 'string') {
      try { callArgs = callArgs.trim() ? JSON.parse(callArgs) : {}; } catch { /* rejected below */ }
    }
    if (!callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs)) {
      return 'Error: mcp_call: "arguments" is required to be a JSON object';
    }

    const s = await this.ensureSession(server);
    if (typeof s === 'string') return `Error: MCP server "${server}" is not available: ${s}`;
    if (!s.tools.some((t) => t.name === tool)) {
      return `Error: MCP tool "${tool}" not found on server ${server}; call mcp_list with {"server": "${server}"} to see its tools`;
    }

    if (opts.requireConfirm) {
      const tickets = new ConfirmTicketStore(opts.workspaceRoot ?? this.deps.workspaceRoot());
      const ticketId = typeof args._confirm_ticket === 'string' ? args._confirm_ticket : undefined;
      // Bound to exactly this server + tool + arguments: approving one call authorises nothing else.
      const bound = { server, tool, arguments: callArgs };
      const err = tickets.consume(MCP_CALL_TOOL, ticketId, bound);
      if (err) {
        const shown = JSON.stringify(callArgs);
        const clipped = shown.length > 300 ? shown.slice(0, 300) + '\u2026' : shown;
        const ticket = tickets.issue(MCP_CALL_TOOL, `MCP ${server}.${tool} ${clipped}`, { args: bound });
        return JSON.stringify({
          needs_confirm: ticket,
          error: err,
          hint: 'MCP tools run outside the sandbox; re-run with args._confirm_ticket after user approval',
        });
      }
    }

    try {
      const result = await s.request('tools/call', { name: tool, arguments: callArgs }, this.callTimeoutMs);
      const text = capText(mcpContentToText(result));
      if ((result as { isError?: boolean } | null)?.isError === true) return mcpToolError(server, tool, text);
      return text.trim() ? text : `(MCP ${server}.${tool} returned no content)`;
    } catch (e) {
      if (e instanceof McpTimeoutError) {
        return `Error: MCP server ${server} tool ${tool} timed out after ${this.callTimeoutMs}ms (no response)`;
      }
      if (e instanceof McpRpcError) return mcpToolError(server, tool, capText(e.message));
      if (!s.alive) {
        return `Error: MCP server "${server}" is not available: it exited during the call (${s.lastExit}); it will be restarted on the next call`;
      }
      return mcpToolError(server, tool, (e as Error).message);
    }
  }

  /** Stop every server process. Synchronous so it can run from signal / exit handlers. */
  shutdown(): void {
    this.stopped = true;
    for (const s of this.sessions.values()) s.close('shut down');
    this.sessions.clear();
    this.pids.clear();
  }
}