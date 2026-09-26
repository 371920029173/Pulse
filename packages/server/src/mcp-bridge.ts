/**
 * MCP bridge: turns configured MCP servers into tools the agent can actually call.
 *
 * `mcp.ts` discovers configs and probes them (spawn, handshake, count tools, kill). That told the
 * user a server was reachable while the agent never received a single one of its tools. This module
 * is the missing half: one long-lived stdio session per enabled server, a cached tool list the agent
 * reads synchronously, and `tools/call` routing.
 *
 * Shape follows `PluginManager` on purpose:
 *   - `definitions()` is SYNCHRONOUS and served from a cache, because the agent snapshots its tool
 *     list in its constructor;
 *   - only `refresh()` changes that cache, so the list (and therefore the prompt prefix) is stable
 *     between turns;
 *   - order is deterministic (server name, then tool name) for the same reason.
 *
 * Security: an MCP server is a separate process with whatever access it has. It is NOT inside the
 * sandbox (the filesystem server can read `.she/kb.sqlite` or anything outside the workspace), so
 * MCP tools are never treated as trusted built-ins: `execute(..., { requireConfirm: true })` puts
 * every call behind the same confirm-ticket gate the sandbox uses for dangerous built-ins.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ToolDefinition } from '@she/shared';
import { ConfirmTicketStore } from '@she/sandbox';
import { discoverMcpServers, type McpServerConfig } from './mcp.js';
import { productVersion } from './version.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
/** Same order of magnitude as other tool output caps; a clear note is appended when cut. */
export const MCP_OUTPUT_CAP = 20_000;
export const MCP_DESCRIPTION_CAP = 1000;
/** OpenAI function-name limit. */
export const MCP_TOOL_NAME_MAX = 64;

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpInjectStatus {
  /** Tools from this server actually registered to the agent. */
  injected: number;
  /** Why the server contributes fewer tools than it offers (start failure, collisions). */
  injectError?: string;
}

export class McpTimeoutError extends Error {}
export class McpRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** `mcp_<server>_<tool>`, restricted to [A-Za-z0-9_-] and 64 chars. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MCP_TOOL_NAME_MAX);
}

/** Byte-order independent comparison: `localeCompare` would make the order depend on the host. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function capText(text: string, cap = MCP_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[output truncated: ${text.length} chars total, first ${cap} shown]`;
}

function describeTool(server: string, description: string | undefined): string {
  const full = `[MCP ${server}] ${String(description ?? '').trim()}`.trim();
  return full.length > MCP_DESCRIPTION_CAP ? `${full.slice(0, MCP_DESCRIPTION_CAP - 1)}\u2026` : full;
}

function schemaOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { type: 'object', properties: {} };
  const s = { ...(input as Record<string, unknown>) };
  if (!s.type) s.type = 'object';
  if (s.type === 'object' && (!s.properties || typeof s.properties !== 'object')) s.properties = {};
  return s;
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
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      return;
    } catch { /* fall through */ }
  }
  try { child.kill(); } catch { /* ignore */ }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
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

  constructor(readonly cfg: McpServerConfig, private log: (m: string) => void) {}

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
    const child = spawn(this.cfg.command, this.cfg.args, {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    this.child = child;
    this.exitInfo = null;
    // Events from a previous child (after a restart) must not touch the new one.
    child.on('error', (e) => { if (this.child === child) this.markDead(`spawn failed: ${e.message}`); });
    child.on('exit', (code, signal) => {
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
    return out;
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
    const tail = this.stderrTail.trim().split(/\r?\n/).slice(-3).join(' | ');
    this.exitInfo = tail ? `${reason}; stderr: ${tail.slice(0, 400)}` : reason;
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
  /** Names already taken by other tool sources (plugins); a colliding MCP tool is skipped. */
  reservedNames?: () => Iterable<string>;
  /** Injected for tests; defaults to `discoverMcpServers`. */
  discover?: (workspaceRoot: string) => McpServerConfig[];
  /** Budget for starting all servers (in parallel). Default 15s. */
  connectTimeoutMs?: number;
  /** Per `tools/call` timeout. Default 60s. */
  callTimeoutMs?: number;
}

interface Route { server: string; tool: string }

const fingerprint = (c: McpServerConfig): string => JSON.stringify([c.command, c.args, c.env ?? {}]);

export class McpBridge {
  private sessions = new Map<string, McpSession>();
  private restarting = new Map<string, Promise<McpSession | string>>();
  private inject = new Map<string, McpInjectStatus>();
  private cached: { definitions: ToolDefinition[]; routes: Map<string, Route> } = { definitions: [], routes: new Map() };
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private deps: McpBridgeDeps) {}

  private get connectTimeoutMs(): number { return this.deps.connectTimeoutMs ?? 15_000; }
  private get callTimeoutMs(): number { return this.deps.callTimeoutMs ?? 60_000; }

  /** Cached, synchronous, deterministic. Changes only on `refresh()`. */
  definitions(): ToolDefinition[] {
    return this.cached.definitions;
  }

  owns(name: string): boolean {
    return this.cached.routes.has(name);
  }

  injectStatus(server: string): McpInjectStatus {
    return this.inject.get(server) ?? { injected: 0 };
  }

  /**
   * Reconnect according to the current config and rebuild the tool list.
   *
   * Unchanged, still-running sessions are kept; removed, disabled or edited ones are stopped; new
   * ones are started in parallel, each bounded by `connectTimeoutMs`, so this never blocks longer
   * than that. Calls are serialised so two routes firing together cannot interleave.
   */
  refresh(): Promise<ToolDefinition[]> {
    const run = this.chain.then(() => this.doRefresh(), () => this.doRefresh());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doRefresh(): Promise<ToolDefinition[]> {
    if (this.stopped) return this.cached.definitions;
    let configs: McpServerConfig[] = [];
    try {
      configs = (this.deps.discover ?? discoverMcpServers)(this.deps.workspaceRoot());
    } catch (e) {
      this.deps.log(`MCP: config discovery failed: ${(e as Error).message}`);
    }
    const wanted = new Map(configs.filter((c) => c.enabled !== false).map((c) => [c.name, c] as const));
    const inject = new Map<string, McpInjectStatus>();

    for (const [name, s] of [...this.sessions]) {
      const want = wanted.get(name);
      if (!want || !s.alive || fingerprint(want) !== fingerprint(s.cfg)) {
        s.close();
        this.sessions.delete(name);
      }
    }

    const starting = [...wanted.values()]
      .filter((cfg) => !this.sessions.has(cfg.name))
      .map(async (cfg) => {
        const s = new McpSession(cfg, this.deps.log);
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
        inject.set(r.cfg.name, { injected: 0, injectError: r.error });
        this.deps.log(`MCP ${r.cfg.name}: failed to start, no tools registered: ${r.error}`);
      } else {
        this.sessions.set(r.cfg.name, r.s);
      }
    }

    const reserved = new Set(this.deps.reservedNames?.() ?? []);
    const definitions: ToolDefinition[] = [];
    const routes = new Map<string, Route>();
    for (const server of [...this.sessions.keys()].sort(cmp)) {
      const s = this.sessions.get(server)!;
      const skipped: string[] = [];
      let injected = 0;
      for (const t of [...s.tools].sort((a, b) => cmp(a.name, b.name))) {
        const name = mcpToolName(server, t.name);
        if (reserved.has(name) || routes.has(name)) {
          skipped.push(t.name);
          this.deps.log(`MCP ${server}: tool "${t.name}" maps to "${name}", which is already taken; skipped`);
          continue;
        }
        definitions.push({ name, description: describeTool(server, t.description), parameters: schemaOf(t.inputSchema) });
        routes.set(name, { server, tool: t.name });
        injected++;
      }
      inject.set(server, {
        injected,
        ...(skipped.length ? { injectError: `${skipped.length} tool(s) skipped (name collision): ${skipped.join(', ')}` } : {}),
      });
    }

    this.inject = inject;
    this.cached = { definitions, routes };
    return definitions;
  }

  /** Restart a dead server once; concurrent callers share the attempt. */
  private restart(server: string, cfg: McpServerConfig): Promise<McpSession | string> {
    const inflight = this.restarting.get(server);
    if (inflight) return inflight;
    const attempt = (async () => {
      this.sessions.get(server)?.close();
      const s = new McpSession(cfg, this.deps.log);
      try {
        await s.start(this.connectTimeoutMs);
        if (this.stopped) { s.close(); return 'bridge is shut down'; }
        this.sessions.set(server, s);
        this.deps.log(`MCP ${server}: restarted`);
        return s;
      } catch (e) {
        this.sessions.delete(server);
        return (e as Error).message;
      }
    })();
    this.restarting.set(server, attempt);
    void attempt.finally(() => this.restarting.delete(server));
    return attempt;
  }

  /**
   * Run one MCP tool.
   *
   * `requireConfirm` puts the call behind the sandbox's confirm-ticket gate: the first call returns
   * `{ needs_confirm }` (the agent pauses and the UI asks the user), and the approved re-run carries
   * `_confirm_ticket`, valid only for these exact arguments.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    opts: { requireConfirm?: boolean; workspaceRoot?: string } = {},
  ): Promise<string> {
    const route = this.cached.routes.get(name);
    if (!route) return `Error: MCP tool "${name}" is not available`;
    const { server, tool } = route;

    if (opts.requireConfirm) {
      const tickets = new ConfirmTicketStore(opts.workspaceRoot ?? this.deps.workspaceRoot());
      const ticketId = typeof args._confirm_ticket === 'string' ? args._confirm_ticket : undefined;
      const err = tickets.consume(name, ticketId, args);
      if (err) {
        const shown = JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith('_'))));
        const clipped = shown.length > 300 ? shown.slice(0, 300) + '\u2026' : shown;
        const summary = `MCP ${server}.${tool} ${clipped}`;
        const ticket = tickets.issue(name, summary, { args });
        return JSON.stringify({
          needs_confirm: ticket,
          error: err,
          hint: 'MCP tools run outside the sandbox; re-run with args._confirm_ticket after user approval',
        });
      }
    }
    const { _confirm_ticket: _ticket, ...callArgs } = args;

    let s = this.sessions.get(server);
    if (!s || !s.alive) {
      const cfg = s?.cfg ?? (this.deps.discover ?? discoverMcpServers)(this.deps.workspaceRoot()).find((c) => c.name === server);
      if (!cfg) return `Error: MCP tool "${name}" is not available: server ${server} is no longer configured`;
      const why = s?.lastExit ?? 'not running';
      const restarted = await this.restart(server, cfg);
      if (typeof restarted === 'string') {
        return `Error: MCP tool "${name}" is not available: server ${server} stopped (${why}) and could not be restarted (${restarted})`;
      }
      s = restarted;
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
        return `Error: MCP tool "${name}" is not available: server ${server} exited during the call (${s.lastExit}); it will be restarted on the next call`;
      }
      return mcpToolError(server, tool, (e as Error).message);
    }
  }

  /** Stop every server process. Synchronous so it can run from signal / exit handlers. */
  shutdown(): void {
    this.stopped = true;
    for (const s of this.sessions.values()) s.close('shut down');
    this.sessions.clear();
    this.cached = { definitions: [], routes: new Map() };
  }
}