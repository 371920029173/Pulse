/**
 * Minimal LSP client: JSON-RPC 2.0 over a child process's stdio.
 *
 * This exists because reading code with `grep` and `read` cannot answer the
 * questions a coding agent actually gets stuck on:
 *
 *   - "what type is this?"            -> hover
 *   - "where is this defined?"        -> definition
 *   - "what breaks if I rename this?" -> references
 *   - "is this file actually broken?" -> diagnostics
 *
 * A language server answers all four exactly, using the same compiler the user's
 * editor uses. Guessing from text search is what produces confidently wrong edits.
 *
 * Only the slice of LSP needed for those questions is implemented, plus the
 * lifecycle handshake. Everything is scoped to a workspace root, because a
 * server's project model is meaningless outside it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { createLogger } from '@she/shared';

/** A JSON-RPC request id. */
type Id = number;

const log = createLogger('lsp-client');

/**
 * Canonical key for the per-file maps.
 *
 * Windows drive letters are case-insensitive, but `Map` keys are not: a server
 * reports `file:///d%3A/...` while we hold `D:\...`, so a waiter registered under
 * one spelling is never released by a notification arriving under the other and
 * diagnostics silently never arrive. Case-folding on Windows is therefore a
 * correctness fix, not a nicety.
 */
function fileKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface LspPosition {
  line: number;      // 0-based, matching LSP
  character: number; // 0-based, UTF-16 code units
}

export interface Diagnostic {
  file: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  line: number;    // 1-based for display
  character: number;
  source?: string;
  code?: string | number;
}

/** How a language is served, and how to detect that the server is available. */
export interface ServerSpec {
  id: string;
  /** Languages this serves, matching the file extensions we map. */
  languages: string[];
  /** Executable name, for native servers found on PATH. */
  command: string;
  args: string[];
  /**
   * For JS-implemented servers: `<package>/<path-to-entry>` under a
   * `node_modules` directory. Preferred over PATH because a workspace-local
   * copy is usually the right version.
   */
  moduleEntry?: string;
  /** Files that indicate the workspace is relevant to this server. */
  projectMarkers?: string[];
}

/**
 * Known servers, in preference order.
 *
 * Only ones we can actually start are used; a missing binary is not an error,
 * it just means those languages have no code intelligence.
 */
export const KNOWN_SERVERS: ServerSpec[] = [
  {
    id: 'typescript',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    moduleEntry: 'typescript-language-server/lib/cli.mjs',
    projectMarkers: ['tsconfig.json', 'package.json', 'jsconfig.json'],
  },
  {
    id: 'pyright',
    languages: ['python'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    moduleEntry: 'pyright/langserver.index.js',
    projectMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
  },
  {
    id: 'rust-analyzer',
    languages: ['rust'],
    command: 'rust-analyzer',
    args: [],
    projectMarkers: ['Cargo.toml'],
  },
  {
    id: 'gopls',
    languages: ['go'],
    command: 'gopls',
    args: ['serve'],
    projectMarkers: ['go.mod'],
  },
  {
    id: 'clangd',
    languages: ['c', 'cpp'],
    command: 'clangd',
    args: [],
    projectMarkers: ['compile_commands.json', 'CMakeLists.txt'],
  },
];

/** Extension -> LSP language id. */
export const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
};

export function languageOf(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_LANGUAGE[filePath.slice(dot).toLowerCase()] ?? null;
}

/** One running language server, tied to a workspace root. */
export class LspServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId: Id = 1;
  private pending = new Map<Id, Pending>();
  private buffer = Buffer.alloc(0);
  private readonly opened = new Set<string>();
  /**
   * Last diagnostics per file, WITH the exact source text they describe.
   *
   * Pairing the result with its content is what makes the cache safe to reuse:
   * stale diagnostics reported after an edit are worse than no diagnostics,
   * because the agent has no way to tell they are stale.
   */
  private readonly diagnosedContent = new Map<string, { text: string; diagnostics: Diagnostic[] }>();
  /** Text whose publish is still outstanding, keyed the same way. */
  private readonly pendingText = new Map<string, string>();
  private readonly diagnosticWaiters = new Map<string, (d: Diagnostic[]) => void>();
  private ready = false;
  private disposed = false;
  /**
   * Whether the server has finished loading the project.
   *
   * A cold language server answers structural queries from a partial program:
   * "go to definition" on an imported symbol returns the IMPORT line instead of
   * the declaration, stably, for ~3s (measured). Repeated calls do not help —
   * the answer only becomes correct once the project finishes loading, so the
   * first query has to wait rather than being retried.
   */
  private warmedUp = false;
  private warmupWaiters: Array<() => void> = [];
  /** Serialises lifecycle operations; LSP is order-sensitive. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly spec: ServerSpec,
    readonly root: string,
    /** Command and args resolved by `resolveServer`. */
    private readonly launch: ResolvedServer,
  ) {}

  get isReady(): boolean { return this.ready; }

  /** Start the server and complete the `initialize` handshake. */
  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn(this.launch.command, this.launch.args, {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A console window flashing on Windows for every server start is jarring.
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      // Servers log chatter to stderr constantly; it is not an error.
      log.debug(`[lsp:${this.spec.id}] ${chunk.toString().trim()}`);
    });
    this.proc.on('exit', (code) => {
      this.ready = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`语言服务器 ${this.spec.id} 已退出（code ${code}）`));
      }
      this.pending.clear();
    });
    this.proc.on('error', (err) => {
      this.ready = false;
      log.warn(`[lsp:${this.spec.id}] 启动失败: ${err.message}`);
    });

    const rootUri = pathToFileURL(this.root).href;
    await this.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: this.spec.id }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['plaintext', 'markdown'] },
          definition: {},
          references: {},
          publishDiagnostics: {},
          synchronization: { didSave: true },
        },
        workspace: { workspaceFolders: true },
      },
      initializationOptions: {
        // Keep quiet: these servers are noisy on stderr and some write to disk.
        preferences: { includeInlayParameterNameHints: 'none' },
      },
    });

    // `notify` is fire-and-forget — awaiting it would be a no-op.
    this.notify('initialized', {});
    this.ready = true;
  }

  /** Open a file so the server learns about it, and return its language id. */
  private ensureOpen(filePath: string, language: string, text: string): void {
    if (this.opened.has(fileKey(filePath))) return;
    this.opened.add(fileKey(filePath));
    /*
     * Record which text the open-time publish describes.
     *
     * Servers publish diagnostics once when a file is opened. A file first opened by a
     * structural query (definition/hover) had that publish cached against '' because nothing
     * had set `pendingText`, so a later `diagnosticsFor` with the same text missed the cache,
     * sent a no-op `didChange`, and waited for a publish that never came: typescript-language-
     * server does not re-publish unchanged diagnostics. Every call timed out after 15s, and
     * three identical timeouts tripped the stuck-loop guard and ended the whole turn.
     */
    this.pendingText.set(fileKey(filePath), text);
    this.notify('textDocument/didOpen', {
      textDocument: { uri: pathToFileURL(filePath).href, languageId: language, version: 1, text },
    });
  }

  /**
   * Wait until the server has finished loading the project.
   *
   * The signal is the first `publishDiagnostics` for the file we just opened:
   * servers only publish once they have processed it, which means the program is
   * loaded. Cost is paid once per server; afterwards this is a no-op.
   *
   * Structural queries (definition/references/hover) call this first. Diagnostic
   * queries do not need to, because they wait for diagnostics anyway.
   */
  async warmUp(filePath: string, language: string, text: string): Promise<void> {
    // ALWAYS open the file. Short-circuiting before this would leave files that
    // arrive after warm-up unknown to the server, and every query about them
    // would come back empty.
    this.ensureOpen(filePath, language, text);
    if (this.warmedUp) return;
    if (this.diagnosedContent.has(fileKey(filePath))) { this.warmedUp = true; return; }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.warmupWaiters = this.warmupWaiters.filter((w) => w !== finish);
        resolve();
      };
      // Better to answer late-and-correct than to hang forever; a very large
      // project may take a while to load.
      const timer = setTimeout(finish, 15_000);
      timer.unref?.();
      this.warmupWaiters.push(finish);
    });
    this.warmedUp = true;
  }

  /**
   * Diagnostics for one file.
   *
   * Servers publish diagnostics asynchronously rather than returning them from a
   * request, so this opens the file, waits for the matching
   * `publishDiagnostics` notification, and on timeout reports `null`.
   *
   * `null` and `[]` mean different things and must not be conflated:
   *   []   — the server checked the file and found nothing wrong
   *   null — the server never answered; we do NOT know
   *
   * A cached result is only reused when the file's text is UNCHANGED. Returning
   * the previous answer after an edit would report errors that no longer exist
   * (or hide new ones) — the one way a diagnostics check can be actively
   * harmful, because the agent would trust it.
   */
  async diagnosticsFor(filePath: string, language: string, text: string): Promise<Diagnostic[] | null> {
    this.ensureOpen(filePath, language, text);
    const key = fileKey(filePath);

    const cached = this.diagnosedContent.get(key);
    if (cached && cached.text === text) return cached.diagnostics;

    // Content changed (or first check): re-sync and wait for a fresh publish.
    this.notify('textDocument/didChange', {
      textDocument: { uri: pathToFileURL(filePath).href, version: Date.now() },
      contentChanges: [{ text }],
    });
    // Remember which text the next publish corresponds to, so a result can be
    // cached against the content it actually describes.
    this.pendingText.set(key, text);

    return new Promise<Diagnostic[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.diagnosticWaiters.delete(key);
        resolve(null);
      }, 15_000);
      timer.unref?.();
      this.diagnosticWaiters.set(key, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
    });
  }

  /**
   * Structural queries wait for warm-up first, so the FIRST answer is as correct
   * as later ones. Without this, "go to definition" on an imported symbol
   * returns the import line while the project is still loading.
   */
  async hover(filePath: string, language: string, text: string, pos: LspPosition) {
    await this.warmUp(filePath, language, text);
    return this.request('textDocument/hover', {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: pos,
    });
  }

  async definition(filePath: string, language: string, text: string, pos: LspPosition) {
    await this.warmUp(filePath, language, text);
    return this.request('textDocument/definition', {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: pos,
    });
  }

  async references(filePath: string, language: string, text: string, pos: LspPosition, includeDeclaration = true) {
    await this.warmUp(filePath, language, text);
    return this.request('textDocument/references', {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: pos,
      context: { includeDeclaration },
    });
  }

  /** Run a lifecycle operation in order, so the protocol stays well-formed. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the chain alive even if one operation rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private request<P>(method: string, params: P): Promise<unknown> {
    return this.enqueue(() => this.rawRequest(method, params));
  }

  private rawRequest<P>(method: string, params: P): Promise<unknown> {
    if (!this.proc || this.disposed) {
      return Promise.reject(new Error('语言服务器未运行'));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP 请求超时: ${method}`));
      }, 20_000);
      // Don't let a pending request hold the process open.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.send(payload);
    });
  }

  private notify<P>(method: string, params: P): void {
    if (!this.proc || this.disposed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: unknown): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    this.proc?.stdin.write(header + body, 'utf8');
  }

  /** Incremental parse of `Content-Length`-framed JSON-RPC messages. */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed framing: drop the header and resynchronise.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return; // wait for the rest

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body);
      } catch {
        log.debug(`[lsp:${this.spec.id}] 无法解析的消息`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // A response to one of our requests.
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as Id);
      if (!p) return;
      this.pending.delete(msg.id as Id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`LSP ${p.method}: ${JSON.stringify(msg.error).slice(0, 200)}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // A server-to-client notification.
    if (msg.method === 'textDocument/publishDiagnostics') {
      const params = msg.params as { uri: string; diagnostics: RawDiagnostic[] };
      const file = fileURLToPath(params.uri);
      const mapped = (params.diagnostics ?? []).map((d) => toDiagnostic(file, d));
      // Key by the canonical form so a server that reports `d:\...` still
      // satisfies a waiter registered for `D:\...`.
      const key = fileKey(file);
      this.diagnosedContent.set(key, { text: this.pendingText.get(key) ?? '', diagnostics: mapped });
      const waiter = this.diagnosticWaiters.get(key);
      if (waiter) {
        this.diagnosticWaiters.delete(key);
        waiter(mapped);
      }
      // Any diagnostics at all means the project is loaded: release any
      // structural query that is waiting on warm-up.
      const waiting = this.warmupWaiters;
      this.warmupWaiters = [];
      for (const w of waiting) w();
      return;
    }

    // Server-initiated requests must be answered or some servers stall.
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      this.respondToServerRequest(msg.id as Id, msg.method as string);
    }
  }

  private respondToServerRequest(id: Id, method: string): void {
    // Reply with the empty-but-valid shape for each known request, so the server
    // does not block waiting on us.
    const results: Record<string, unknown> = {
      'workspace/configuration': [{}],
      'workspace/workspaceFolders': this.root
        ? [{ uri: pathToFileURL(this.root).href, name: this.spec.id }]
        : null,
      'client/registerCapability': null,
      'window/workDoneProgress/create': null,
      'workspace/applyEdit': { applied: false },
    };
    const result = method in results ? results[method] : null;
    this.send({ jsonrpc: '2.0', id, result });
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.ready = false;
    if (!this.proc) return;
    try { await this.rawRequest('shutdown', null); } catch { /* server may be gone */ }
    try { this.notify('exit', null); } catch { /* ignore */ }
    const proc = this.proc;
    this.proc = null;
    setTimeout(() => { if (!proc.killed) proc.kill(); }, 1_500).unref?.();
  }
}

interface RawDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

function toDiagnostic(file: string, d: RawDiagnostic): Diagnostic {
  const severity = d.severity === 1 ? 'error'
    : d.severity === 2 ? 'warning'
    : d.severity === 3 ? 'info'
    : 'hint';
  return {
    file,
    severity,
    message: d.message,
    line: d.range.start.line + 1,
    character: d.range.start.character + 1,
    source: d.source,
    code: d.code,
  };
}

/**
 * How to launch a server: either a JS entry run by node, or an executable on PATH.
 */
export interface ResolvedServer {
  command: string;
  args: string[];
  /** Where the server came from, for the status panel. */
  via: string;
}

/**
 * Find an installed server.
 *
 * JS servers live in a `node_modules` tree (we look beside the workspace first,
 * then beside this package, so a globally-installed SHE can still drive a
 * workspace's own toolchain). Native servers are found on PATH.
 *
 * Returns null when the server is not installed — the caller degrades instead of
 * failing, because a missing language server should not break the agent.
 */
export function resolveServer(spec: ServerSpec, workspaceRoot: string): ResolvedServer | null {
  if (spec.moduleEntry) {
    for (const base of nodeModulesRoots(workspaceRoot)) {
      const entry = join(base, spec.moduleEntry);
      if (existsSync(entry)) {
        return { command: process.execPath, args: [entry, ...spec.args], via: entry };
      }
    }
  }

  const found = findOnPath(spec.command);
  if (found) {
    return { command: found, args: spec.args, via: found };
  }

  // The last resort for a JS server: its bin shim.
  for (const base of nodeModulesRoots(workspaceRoot)) {
    for (const name of [`${spec.command}.cmd`, `${spec.command}.exe`, spec.command]) {
      const bin = join(base, '.bin', name);
      if (existsSync(bin)) {
        return { command: bin, args: spec.args, via: bin };
      }
    }
  }

  return null;
}

/** Candidate `node_modules` directories, nearest first. */
function nodeModulesRoots(workspaceRoot: string): string[] {
  const roots: string[] = [];
  let dir = workspaceRoot;
  for (;;) {
    roots.push(join(dir, 'node_modules'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Beside this package and its parents, so a bundled or hoisted install works
  // even when the user's workspace has no node_modules of its own.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    roots.push(join(here, 'node_modules'));
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  return roots;
}

/** Locate an executable on PATH without shelling out. */
function findOnPath(command: string): string | null {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  const dirs = (process.env.PATH ?? '').split(delimiter);
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles;
    const pf86 = process.env['ProgramFiles(x86)'];
    const local = process.env.LOCALAPPDATA;
    if (pf) dirs.push(join(pf, 'LLVM', 'bin'));
    if (pf86) dirs.push(join(pf86, 'LLVM', 'bin'));
    if (local) dirs.push(join(local, 'Programs', 'LLVM', 'bin'));
  }
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Every server we can actually start in this workspace. */
export function availableServers(workspaceRoot: string): Array<{ spec: ServerSpec; resolved: ResolvedServer }> {
  const out: Array<{ spec: ServerSpec; resolved: ResolvedServer }> = [];
  for (const spec of KNOWN_SERVERS) {
    const resolved = resolveServer(spec, workspaceRoot);
    if (resolved) out.push({ spec, resolved });
  }
  return out;
}

/** Language ids that currently have a working server. */
export function servableLanguages(workspaceRoot: string): Set<string> {
  const langs = new Set<string>();
  for (const { spec } of availableServers(workspaceRoot)) {
    for (const l of spec.languages) langs.add(l);
  }
  return langs;
}
