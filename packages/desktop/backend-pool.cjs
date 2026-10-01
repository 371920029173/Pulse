'use strict';

/*
 * One backend process per workspace, shared by the windows that are on it.
 *
 * WHY THE KEY IS THE WORKSPACE AND NOT THE WINDOW
 *
 * The obvious reading of "independent windows" is one server per window. That reading is unsafe
 * here, and the reason is where state lives. Conversations (`sessions.json`), the knowledge base and
 * the audit log all live under the *workspace* (`<ws>/.she/`), and each server holds them in memory
 * and rewrites its own snapshot of the file on every change. Two servers on one workspace therefore
 * do not partition the data, they race over it: A writes a conversation, B (holding the copy it read
 * at boot) writes its own, and A's conversation is gone from disk. That is the exact "my chats
 * disappeared" failure this whole piece of work exists to remove, reintroduced by the fix.
 *
 * So the unit of ownership is the workspace. Windows on the same workspace share one server — which
 * is also what the user asked for: the window that got there first owns the project, and a new
 * window attaches without disturbing it. Windows on different workspaces get different processes,
 * which is what actually needed fixing: switching projects in one window used to move the global
 * workspace root (and the LSP root with it) out from under every other window.
 *
 * `SHE_WORKSPACE` is what makes this work without touching the server: the config loader reads it
 * into `config.workspace.root` at boot, so a process started for workspace W *is* the W backend.
 *
 * Deliberately free of any Electron import so it can be unit-tested as plain Node. The child
 * process and the filesystem are injected, which is what lets the tests run without spawning
 * anything.
 */

/** Normalise a workspace path into a map key. Windows paths are case-insensitive. */
function workspaceKey(root) {
  if (!root) return '';
  const resolved = require('node:path').resolve(String(root));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Ask the OS for a free port instead of guessing one.
 *
 * Guessing is what broke this the first time. The pool used to scan a fixed window (5700–5739) and
 * on this machine every one of the 40 was unavailable: Windows/Hyper-V had reserved 5641–5740, so
 * `listen()` failed 40 times out of 40 and every workspace switch reported 「没有可用端口」. Those
 * ranges are machine-specific and do not show up in `netstat`, so a window that works on one box can
 * be wholly reserved on the next — and the failure surfaces only on the machine that has it.
 *
 * Binding port 0 and reading back what the OS assigned sidesteps the question: the OS never hands
 * out a port it has reserved. The probe listener is closed before returning, which leaves a brief
 * window where something else could take the port — `_start` handles that by retrying with a fresh
 * port when the child dies immediately, rather than by hoping it does not happen.
 */
function defaultAllocatePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    // `exclusive` so a port already in use is reported instead of being silently shared (Windows).
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!port) { server.close(() => reject(new Error('系统没有分配可用端口'))); return; }
      server.close(() => resolve(port));
    });
  });
}

/** Default probe: does `origin` answer /api/health yet? */
function defaultWaitHealthy(origin, timeoutMs) {
  const http = require('node:http');
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const req = http.get(`${origin}/api/health`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) resolve(false);
      else setTimeout(tick, 250);
    };
    tick();
  });
}

class BackendPool {
  /**
   * @param {object} opts
   * @param {(root: string, port: number) => any} opts.spawnChild Spawn a server for `root` on `port`.
   * @param {() => Promise<number>} [opts.allocatePort] Free port from the OS.
   * @param {(origin: string, timeoutMs: number) => Promise<boolean>} [opts.waitHealthy]
   * @param {(child: any) => boolean} [opts.isAlive] Whether a failed child is still running.
   * @param {(msg: string) => void} [opts.log]
   * @param {number} [opts.attempts] Retries when a child dies at startup before becoming healthy.
   * @param {number} [opts.healthTimeoutMs]
   */
  constructor(opts) {
    if (!opts || typeof opts.spawnChild !== 'function') {
      throw new TypeError('BackendPool requires a spawnChild(root, port) function');
    }
    this.spawnChild = opts.spawnChild;
    this.allocatePort = opts.allocatePort ?? defaultAllocatePort;
    this.isAlive = opts.isAlive ?? ((child) => Boolean(child) && child.exitCode == null);
    this.waitHealthy = opts.waitHealthy ?? defaultWaitHealthy;
    this.log = opts.log ?? (() => {});
    this.attempts = opts.attempts ?? 3;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 60_000;

    /** @type {Map<string, {root: string, origin: string, port: number, child: any, spawned: boolean}>} */
    this.byKey = new Map();
    /** In-flight `ensure` calls, so two windows asking for the same workspace spawn one server. */
    this.pending = new Map();
    /** Ports handed out, so two workspaces cannot be promised the same one before either binds. */
    this.claimed = new Set();
  }

  /** Adopt a server that is already running (the launcher's), so windows can land on it. */
  register(root, origin) {
    if (!root || !origin) return null;
    const port = Number(new URL(origin).port) || 0;
    const entry = { root, origin, port, child: null, spawned: false };
    this.byKey.set(workspaceKey(root), entry);
    if (port) this.claimed.add(port);
    this.log(`pool: registered existing backend for ${root} at ${origin}`);
    return entry;
  }

  /** The entry for a workspace, or null. */
  find(root) {
    return this.byKey.get(workspaceKey(root)) ?? null;
  }

  /** Every backend this pool knows about, for `she status`-style reporting and tests. */
  list() {
    return [...this.byKey.values()].map((e) => ({
      root: e.root, origin: e.origin, port: e.port, spawned: e.spawned,
    }));
  }

  /**
   * A free port that nobody in this pool has been promised.
   *
   * `claimed` is consulted because the OS only says "nothing is listening *now*" — between
   * allocation and the child binding it, another workspace could be handed the same number. Claiming
   * it for the lifetime of the pool is what keeps two workspaces off one port.
   */
  async pickPort() {
    for (let i = 0; i < this.attempts; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design: the first free port wins.
      const port = await this.allocatePort();
      if (this.claimed.has(port)) continue;
      this.claimed.add(port);
      return port;
    }
    throw new Error('连续分配到的端口都已被本进程占用');
  }

  /**
   * The backend for `root`, starting one if this is the first window to ask for it.
   *
   * Concurrent callers share one spawn: without `pending`, two windows entering the same project at
   * once would each see "no backend yet" and start two servers on the same workspace — the race this
   * class exists to prevent.
   */
  async ensure(root) {
    const key = workspaceKey(root);
    if (!key) throw new Error('workspace 为空，无法启动后端');

    const existing = this.byKey.get(key);
    if (existing) return existing;

    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    /*
     * Cleared on every path, including a failure before the child exists.
     *
     * With the delete inside a narrower `finally` the pool kept a rejected promise for the workspace
     * forever, so every later window on it inherited that same rejection instead of getting a fresh
     * attempt — a failure that only shows up after one transient port conflict.
     */
    const task = this._start(root, key).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  /**
   * @private Start a backend for `root`, retrying when the child dies before becoming healthy.
   *
   * `for` rather than recursion: the retry has to keep the same `pending` entry, because two windows
   * entering this workspace are waiting on one promise.
   */
  async _start(root, key) {
    let lastError = null;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered attempts by design.
      const port = await this.pickPort();
      const origin = `http://127.0.0.1:${port}`;
      this.log(`pool: starting backend for ${root} on ${port}`);
      const child = this.spawnChild(root, port);
      const entry = { root, origin, port, child, spawned: true };
      this.byKey.set(key, entry);

      // eslint-disable-next-line no-await-in-loop -- ordered attempts by design.
      const healthy = await this.waitHealthy(origin, this.healthTimeoutMs);
      if (healthy) return entry;

      if (this.isAlive(child)) {
        /*
         * Still running but not answering: keep the entry.
         *
         * A cold start that loads MCP servers can outlast the health budget while being perfectly
         * fine. Dropping the entry would let the next window spawn a *second* server for this
         * workspace — the split-brain this class exists to prevent. The caller gets the error; the
         * workspace stays single-owner.
         */
        throw new Error(`后端启动超时：${root}（${origin}）`);
      }

      /*
       * The child is already gone, so this port is not coming up: release it and try a new one.
       *
       * This is the case the OS-assigned port creates — the probe listener closes before the child
       * binds, so something else can take the port in between. Without the retry the pool would park
       * a dead entry on the workspace and every later window would inherit a dead backend.
       */
      this.byKey.delete(key);
      this.claimed.delete(port);
      lastError = new Error(`后端启动失败（进程已退出）：${root}（${origin}）`);
      this.log(`pool: backend for ${root} died on ${port} before healthy, retrying`);
    }
    throw lastError ?? new Error(`后端启动失败：${root}`);
  }

  /** Stop the servers this pool started. Adopted ones (the launcher's) are left alone. */
  stopAll() {
    for (const entry of this.byKey.values()) {
      if (entry.spawned && entry.child) {
        try { entry.child.kill?.(); } catch { /* already gone */ }
      }
    }
    this.byKey.clear();
    this.claimed.clear();
    this.pending.clear();
  }
}

module.exports = { BackendPool, workspaceKey, defaultAllocatePort, defaultWaitHealthy };
