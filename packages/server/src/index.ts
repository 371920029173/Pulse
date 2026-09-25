import { createServer } from 'node:http';
import os from 'node:os';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, unlinkSync, appendFileSync, rmSync, copyFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { realpathSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLogger, loadConfig, resolveEnvFile, mergeMissingEnvFile, updateEnvFile, THINKING_LEVELS, getConfigRecovery, getConfigFileInUse, lastGoodConfigPath, lastGoodConfigMetaPath } from '@she/shared';
import type { SheConfig, StreamChunk, EdgeKind, SkillProfile } from '@she/shared';
import { KBStore, GroupKBEngine, mergeKnowledgeBases } from '@she/kb';
import { resolveWorkspaceKbPath, writeKbLink, clearKbLink, copyKbFile, readKbLink } from './kb-link.js';
import { SandboxShell, createTools, ConfirmTicketStore } from '@she/sandbox';
import { Agent, TurnInProgressError, readSkillProfile, writeSkillProfile, guardrailPolicy, summariseFindings } from '@she/agent-runtime';
import type { SubagentRunner } from '@she/agent-runtime';
import { PlanStore, MemoStore, nextStepOf } from '@she/agent-runtime';
import { RunTraceStore, ConfidenceMirror, REFLECTION_DIR } from '@she/agent-runtime';
import type { StepStatus } from '@she/agent-runtime';
import { metrics } from './metrics.js';
import { PRODUCT_VERSION } from './version.js';
import {
  loadTheme, saveTheme, clearTheme, setThemeEnabled, revertTheme,
  validateCss, themeBytes, themePaths, THEME_MAX_BYTES,
} from './theme.js';
import { ScheduleStore, Scheduler, describeNextRun, nextWindowStart, withinWindow } from './schedule.js';
import type { ScheduledTask, WorkingWindow } from './schedule.js';
import { Router, HttpError, sendJSON, sendError, sendSSEEvent, startSSE, endSSE, parseBody, readRawBody, corsHeaders } from './router.js';
import { SessionStore, chooseStartupSession } from './sessions.js';
import type { ChatSession, ImportedConversation } from './sessions.js';
import { ClusterStore, runClusterWave, initClusterIdentitySkills, ROLE_PRESETS, generateRoleSkill } from './cluster.js';
import type { ClusterRole } from './cluster.js';
import { listMcpServers, probeMcpServer, writeMcpServer, removeMcpServer, setMcpServerEnabled } from './mcp.js';
import { PluginManager, KNOWN_PERMISSIONS, type PluginManifest } from './plugins.js';
import { FeishuBridge, type FeishuConfig } from './feishu.js';

import { AuditLog } from './audit.js';
import { AUDIT_KINDS } from './audit.js';
import type { AuditRecord, AuditKind } from './audit.js';
import { listTree, readWorkspaceFile, suggestPaths } from './files.js';
import { outlinePath, suggestSymbols } from './outline.js';
import { parseContextExport } from './contextParsers.js';
import { discoverConversations, loadTranscript, materializeConversation } from './discovery.js';
import { knownProjectRoots, rememberProject } from './projects.js';
import { addWorktree, listWorktrees, removeWorktree, resetWorktree, transferLocalChanges } from './worktrees.js';
import { taskBoard } from './taskBoard.js';

const log = createLogger('server');

/**
 * Reject requests that did not come from the local app.
 *
 * Two attacks this stops:
 *  - **Cross-site requests**: no CORS headers, plus any request carrying a
 *    foreign `Origin` is refused outright.
 *  - **DNS rebinding**: an attacker domain that resolves to 127.0.0.1 would
 *    otherwise be treated as same-origin by the browser. Pinning the accepted
 *    `Host` values defeats it.
 *
 * Returns null when the request is acceptable, or a reason string to refuse.
 */
/**
 * Reject requests that did not come from this app, before they reach a route.
 *
 * The threat is DNS rebinding: a page the user visits resolves its own domain to
 * 127.0.0.1, then talks to this server as if it were same-origin. The defence is to
 * require that the `Host` header is a name we expect.
 *
 * That defence has to coexist with deployment, which is where the original version
 * failed: it accepted ONLY `127.0.0.1`, `localhost` and `[::1]`, so a container, a
 * LAN address, or a domain in front of a reverse proxy was refused outright.
 *
 * The rule is therefore:
 *
 *   1. Loopback names are always allowed.
 *   2. A LITERAL IP address is always allowed. Rebinding needs a hostname — an
 *      attacker cannot make their domain resolve to a value that arrives as an IP
 *      literal, because the browser sends whatever name was typed. This is what
 *      makes LAN and container access work without a configuration step.
 *   3. Any other hostname must be listed in `SHE_ALLOWED_HOSTS`.
 *   4. `SHE_ALLOWED_HOSTS=*` accepts anything, for a reverse proxy that rewrites
 *      `Host` in ways we cannot predict. Explicitly opt-in, and warned about.
 */
function isAllowedHost(host: string, port: number): boolean {
  if (!host) return false;

  const loopback = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (loopback.has(host)) return true;

  const configured = (process.env.SHE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (configured.includes('*')) return true;

  /*
   * Match with AND without the port.
   *
   * A browser sends `she.example.com:4577` while an operator naturally writes
   * `SHE_ALLOWED_HOSTS=she.example.com` — comparing the raw strings means the entry
   * silently does nothing, and the only symptom is a 403 with no explanation.
   * Accepting either spelling removes a configuration trap.
   */
  const hostWithoutPort = host.replace(/:\d+$/, '');
  if (configured.includes(host) || configured.includes(hostWithoutPort)) return true;
  // Same, for an entry that was written with a port the request omitted.
  if (configured.some((c) => c.replace(/:\d+$/, '') === hostWithoutPort)) return true;

  // Strip the port, then unwrap an IPv6 literal in brackets.
  const withoutPort = hostWithoutPort;
  const bare = withoutPort.startsWith('[') && withoutPort.endsWith(']')
    ? withoutPort.slice(1, -1)
    : withoutPort;

  // IPv4: four numeric octets.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    return bare.split('.').every((part) => Number(part) <= 255);
  }
  // IPv6: contains a colon (the port was already removed) and only hex/colons.
  if (bare.includes(':') && /^[0-9a-f:]+$/.test(bare)) return true;

  return false;
}

function guardRequest(
  req: import('node:http').IncomingMessage,
  port: number,
): string | null {
  const host = String(req.headers.host ?? '').toLowerCase();

  if (!isAllowedHost(host, port)) {
    const hint = process.env.SHE_ALLOWED_HOSTS
      ? ''
      : '（如果你是通过域名或反代访问，请把它加入 SHE_ALLOWED_HOSTS）';
    return `bad host: ${host || '(none)'}${hint}`;
  }

  // A browser only sends Origin for cross-origin / non-GET requests. When it is
  // present it must match this server; a foreign value is a cross-site attempt.
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      const u = new URL(String(origin));
      ok = isAllowedHost(u.host.toLowerCase(), port);
    } catch {
      ok = false;
    }
    if (!ok) return `bad origin: ${origin}`;
  }

  return null;
}

/**
 * Confine a user-supplied path to the workspace.
 *
/**
 * Whether `candidate` sits inside `base`.
 *
 * Uses a path RELATIVE check rather than `startsWith`, which was the bug in four skills routes:
 * `"<ws>/.she/skills-backup/x.md".startsWith("<ws>/.she/skills")` is true, so a sibling directory
 * whose name merely begins with the intended one passed the test — readable, and in one route
 * deletable. Comparing relative segments cannot be fooled by a shared prefix.
 *
 * `allowEqual` is off by default because these checks guard a CONTAINER (a skills directory, a
 * profile directory): the container itself is not a valid target.
 */
function isInsideDir(base: string, candidate: string, allowEqual = false): boolean {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const b = fold(resolve(base));
  const c = fold(resolve(candidate));
  if (c === b) return allowEqual;
  const rel = relative(b, c);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Two bypasses this must defeat:
 *  1. An absolute path (`C:\Windows\System32\...`): `resolve(root, raw)` returns
 *     the absolute path, silently escaping the root.
 *  2. A symlink inside the workspace pointing outside it: the textual path looks
 *     contained, so the real target must be resolved before checking.
 *
 * Returns the absolute path when contained; throws otherwise.
 */
function jailToWorkspace(workspaceRoot: string, requested: string): string {
  const root = resolve(workspaceRoot);
  const contained = (base: string, candidate: string): boolean => isInsideDir(base, candidate, true);

  const abs = resolve(root, requested);
  if (!contained(root, abs)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }

  // Follow symlinks so a link inside the jail cannot point outside it.
  let realRoot = root;
  try { realRoot = realpathSync.native ? realpathSync.native(root) : realpathSync(root); } catch { /* keep root */ }

  let realAbs = abs;
  try {
    realAbs = realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
  } catch {
    // Target does not exist yet: fall back to resolving its existing parent.
    const parent = dirname(abs);
    try {
      const realParent = realpathSync.native ? realpathSync.native(parent) : realpathSync(parent);
      realAbs = join(realParent, basename(abs));
    } catch { /* keep abs */ }
  }

  if (!contained(realRoot, realAbs)) {
    throw new Error(`Path escapes workspace via link: ${requested}`);
  }
  return realAbs;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = process.env.SHE_UI_DIR
  ? resolve(process.env.SHE_UI_DIR)
  : resolve(__dirname, '../../ui/dist');
/** Install root — `packages/server/src` and `packages/server/dist` are both 3 levels below it. */
const PROJECT_ROOT = resolve(__dirname, '../../..');

/**
 * The single .env this process reads AND writes. Previously reads came from
 * <PROJECT_ROOT>/.env while writes went to <cwd>/.env, so saved settings were
 * silently shadowed (or lost) on the next restart.
 */
const ENV_PATH = resolveEnvFile(PROJECT_ROOT);

/**
 * Older builds persisted settings to `<cwd>/.env`. When the server was started
 * from the package directory that produced a second file which never won on
 * boot. Pull those values into the canonical file so nothing is lost.
 */
function migrateLegacyEnvFile(): void {
  const legacyPaths = [
    resolve(process.cwd(), '.env'),
    join(PROJECT_ROOT, 'packages', 'server', '.env'),
  ];
  for (const legacy of [...new Set(legacyPaths)]) {
    if (legacy === ENV_PATH || !existsSync(legacy)) continue;
    const recovered = mergeMissingEnvFile(ENV_PATH, legacy);
    if (recovered.length) {
      log.info(`Recovered ${recovered.length} setting(s) from legacy ${legacy} (${recovered.join(', ')})`);
    }
  }
}

/**
 * Does this file already hold a session list worth keeping?
 *
 * Deliberately lenient: ANY parseable non-empty `sessions` array counts, even
 * if the conversations have no messages yet. The previous check required a
 * session WITH messages, so a store containing only fresh/empty chats was
 * judged "unusable" and replaced wholesale — that is how a 299 KB history was
 * silently overwritten by an 856-byte file from another directory.
 */
/**
 * What is actually on disk at a state-file path.
 *
 * The distinction between `absent` and `unreadable` is the whole point. An
 * earlier version collapsed both into "false" with the comment "treat as absent
 * so recovery can still happen, but the write is backed up first" — and that is
 * how a user's own session file got replaced by conversations from a different
 * directory. Recovery exists to fill a GAP left by an old build; a file that is
 * present but unreadable is not a gap, it is the user's data in trouble, and the
 * only safe move is to leave it for the store to quarantine and report.
 */
type FileState = 'absent' | 'present' | 'unreadable';

function readState(file: string): FileState {
  if (!existsSync(file)) return 'absent';
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return 'present';
  } catch {
    return 'unreadable';
  }
}

/** True only when there is real session data worth keeping in place. */
function hasAnySessions(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { sessions?: unknown[] };
    return Array.isArray(parsed.sessions) && parsed.sessions.length > 0;
  } catch {
    // Unreadable. Must NOT be treated as absent — see `readState`.
    return true;
  }
}

/**
 * Copy `src` over `target`, keeping a timestamped backup of the target.
 *
 * Recovery must never be able to destroy data it did not create, so any
 * existing target is preserved next to the new file before being replaced.
 */
function recoverFile(target: string, src: string, label: string): boolean {
  try {
    if (existsSync(target)) {
      const backup = `${target}.bak-${Date.now()}`;
      writeFileSync(backup, readFileSync(target));
      log.warn(`Recovering ${label}: existing file backed up to ${backup}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(src));
    log.info(`Recovered ${label} from ${src}`);
    return true;
  } catch (err) {
    log.warn(`Recovery of ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * One-time recovery of state left behind by older builds.
 *
 * Older builds keyed chat state to `process.cwd()`, so the same install had
 * different histories depending on how the server was started. This pulls those
 * into the workspace once.
 *
 * IMPORTANT: this must NOT run on every workspace switch — doing so copied the
 * previous project's sessions into the new one, which is exactly why chats
 * looked like they were not isolated per workspace.
 *
 * `process.cwd()` is intentionally NOT a candidate. It made the outcome depend
 * on how the server was launched (launcher vs direct), so two different
 * workspaces could overwrite each other's history.
 */
function recoverLegacyState(targetDir: string, extraSources: string[] = []): void {
  const target = resolve(targetDir);
  const sources = [
    ...extraSources,
    join(PROJECT_ROOT, 'packages', 'server'),
    PROJECT_ROOT,
  ].map((d) => resolve(d));
  const candidates = [...new Set(sources)].filter((d) => d !== target);

  /*
   * Only ever fills a GAP — never touches a file that is already there.
   *
   * In particular, a file that exists but cannot be parsed is NOT a gap. That
   * case used to be treated as absent and then overwritten with another
   * directory's history, which is how a user's conversations got displaced by
   * unrelated ones. It is now left untouched so the store can quarantine it with
   * a backup and a message the user can act on.
   */
  const targetSessions = join(target, '.she', 'sessions.json');
  if (readState(targetSessions) === 'absent') {
    for (const dir of candidates) {
      const src = join(dir, '.she', 'sessions.json');
      if (!hasAnySessions(src)) continue;
      if (recoverFile(targetSessions, src, 'chat sessions')) break;
    }
  } else if (readState(targetSessions) === 'unreadable') {
    // Deliberately left alone. The store reports it and keeps the bytes.
    log.warn(`${targetSessions} 存在但无法解析，交由存储层隔离处理，不做跨目录覆盖`);
  }

  const targetRooms = join(target, '.she', 'cluster', 'rooms.json');
  if (readState(targetRooms) === 'absent') {
    for (const dir of candidates) {
      const src = join(dir, '.she', 'cluster', 'rooms.json');
      if (readState(src) !== 'present') continue;
      if (recoverFile(targetRooms, src, 'discussion rooms')) break;
    }
  }
}

function resolveStateDir(cfg: SheConfig): string {
  const explicit = process.env.SHE_STATE_DIR;
  if (explicit && explicit.trim()) return resolve(explicit.trim());
  return cfg.workspace.root;
}

/** Valid values for the thinking-level setting (single source of truth). */
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

/** Where `ask_user` parks its question for the UI to surface. */
function pendingQuestionPath(): string {
  return join(config.workspace.root, '.she', 'pending-question.json');
}

/**
 * Forget the current pending question.
 *
 * `ask_user` used to write this file and never remove it, so the UI kept
 * offering the same question — answering it, refreshing, or ignoring it all
 * brought it back. The question is only "pending" until the user responds, so
 * any of these clears it: the user sends a message, or explicitly dismisses.
 */
function clearPendingQuestion(): void {
  try {
    rmSync(pendingQuestionPath(), { force: true });
  } catch { /* non-fatal */ }
}

migrateLegacyEnvFile();

let config: SheConfig;
let store: KBStore;
let engine: GroupKBEngine;

function remountKnowledgeBase(dbPath: string): void {
  try { store?.close(); } catch { /* ignore */ }
  const dir = dirname(dbPath);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  store = new KBStore(dbPath);
  engine = new GroupKBEngine(store, config.kb);
  log.info(`Knowledge base mounted: ${dbPath}`);
}

/** Knowledge bases for sessions that work in some other directory. */
const extraEngines = new Map<string, GroupKBEngine>();

function engineFor(dbPath: string): GroupKBEngine {
  const key = resolve(dbPath);
  if (resolve(config.kb.dbPath) === key) return engine;
  const hit = extraEngines.get(key);
  if (hit) return hit;
  mkdirSync(dirname(key), { recursive: true });
  const extra = new GroupKBEngine(new KBStore(key), config.kb);
  extraEngines.set(key, extra);
  return extra;
}

let sessions: SessionStore;
let cluster: ClusterStore;
let schedule: ScheduleStore;
/** Created during boot; the routes reference it, so it lives at module scope. */
let schedulerInstance: Scheduler | null = null;
let stateDir: string;

/**
 * One Agent per chat session.
 *
 * Previously a single global Agent held one shared transcript, so a second
 * browser window / desktop window would interleave its turns into the same
 * history and clobber the first window's stream. Keying by session id isolates
 * each window's conversation, pending tickets, patches and token usage.
 */
const agents = new Map<string, Agent>();
/** Session id treated as "active" when a request does not name one. */
let activeAgentId: string | null = null;
/** Parent sessions whose in-flight children should stop blocking and keep running. */
const detachParents = new Set<string>();
/** Session stores for projects other than the one currently mounted. */
const otherStores = new Map<string, SessionStore>();

function projectIndexFile(): string {
  return join(appDir(), 'projects.json');
}

function storeFor(dir: string): SessionStore {
  const key = resolve(dir);
  if (resolve(sessions.rootDir) === key) return sessions;
  let hit = otherStores.get(key);
  if (!hit) {
    hit = new SessionStore(key);
    otherStores.set(key, hit);
  }
  return hit;
}

function projectRoots(): string[] {
  let extra: string[] = [];
  try {
    const p = join(stateDir, '.she', 'workspaces.json');
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { recent?: string[] };
      extra = Array.isArray(j.recent) ? j.recent : [];
    }
  } catch {
    extra = [];
  }
  return knownProjectRoots(projectIndexFile(), config.workspace.root, extra);
}

function findSession(id: string): { store: SessionStore; session: ChatSession } | null {
  const local = sessions.get(id);
  if (local) return { store: sessions, session: local };
  for (const root of projectRoots()) {
    if (resolve(root) === resolve(sessions.rootDir)) continue;
    const store = storeFor(root);
    const session = store.get(id);
    if (session) return { store, session };
  }
  return null;
}

function rootForSession(sessionId?: string | null): string {
  if (!sessionId) return config.workspace.root;
  const found = findSession(sessionId);
  return found?.session.directory ? resolve(found.session.directory) : config.workspace.root;
}

/**
 * Where installed software lives (wallpaper, plugins) — as opposed to project
 * data, which lives under the workspace.
 */
function appDir(): string {
  return process.env.SHE_APP_DIR ? resolve(process.env.SHE_APP_DIR) : join(os.homedir(), '.she-app');
}

/** Plugins shipped with the app; the catalog source for one-click install. */
function bundledPluginsDir(): string {
  return join(PROJECT_ROOT, 'plugins');
}

/**
 * Remove the workspace-local wallpaper left behind by the version that stored it per workspace.
 *
 * The wallpaper moved to the app directory — it is a user preference, and a workspace-local copy
 * vanished on every project switch — but nothing cleaned up what the old version had already
 * written. On this machine that is a **146 MB** dead video sitting inside a project directory,
 * read by nobody.
 *
 * It cannot simply be deleted on sight, though: a user may have put a file there deliberately.
 * So the rule is narrow — remove it only when an app-global copy of the SAME file exists with
 * the SAME SIZE, which makes it a duplicate rather than data. Anything else is left alone, and
 * the outcome is logged either way. Silently deleting files under someone's project is not
 * something to do on a guess.
 */
function cleanLegacyWorkspaceBackground(): void {
  try {
    const legacyDir = join(config.workspace.root, '.she', 'background');
    if (!existsSync(legacyDir)) return;

    const globalDir = join(appDir(), 'background');
    // When the app directory *is* the legacy directory (SHE_APP_DIR pointing into the
    // workspace), nothing is duplicated and this is not a migration.
    if (resolve(legacyDir) === resolve(globalDir)) return;

    for (const name of readdirSync(legacyDir)) {
      const legacyFile = join(legacyDir, name);
      const globalFile = join(globalDir, name);
      if (!existsSync(globalFile)) continue;
      if (statSync(legacyFile).size !== statSync(globalFile).size) continue;
      rmSync(legacyFile, { force: true });
      log.info(`清理遗留的工作区壁纸副本: ${legacyFile}（与 ${globalFile} 内容一致）`);
    }

    // Only drop the directory if it is empty now; a leftover file means it is the user's.
    if (existsSync(legacyDir) && readdirSync(legacyDir).length === 0) {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  } catch (err) {
    // Never let tidying the disk stop the server from starting.
    log.warn(`清理遗留壁纸失败（不影响启动）: ${(err as Error).message}`);
  }
}

/**
 * Plugin runtime, at module scope because `makeAgent` (also module scope) needs
 * to merge plugin tools into every agent's toolset. The workspace root is read
 * through a thunk so a workspace switch is picked up without rebuilding this.
 */
const plugins = new PluginManager({
  appPluginsDir: join(appDir(), 'plugins'),
  bundledPluginsDir: bundledPluginsDir(),
  workspaceRoot: () => config.workspace.root,
  log: (m) => log.info(m),
});

/**
 * Build a delegated child agent.
 *
 * Deliberately constructed WITHOUT a subagent runner: a child that can spawn
 * children is unbounded recursion, and each level re-sends a full system prompt
 * so cost grows multiplicatively. Passing `isSubagent` also strips the tools
 * that assume a human is present (see Agent's constructor).
 */
function makeSubagentRunner(parentCfg: SheConfig, parentSessionId: string): SubagentRunner {
  const TIMEOUT_MS = Number(process.env.SHE_SUBAGENT_TIMEOUT_MS) > 0
    ? Number(process.env.SHE_SUBAGENT_TIMEOUT_MS)
    : 180_000;

  return {
    async run(req) {
      const directory = parentCfg.workspace.root;
      const owner = storeFor(directory);
      const childSession = owner.create(req.description, {
        directory,
        parentId: parentSessionId,
      });
      const shell = new SandboxShell(directory, parentCfg.sandbox);
      const tools = createTools(shell, directory, {
        allowAllCommands: parentCfg.sandbox.allowAllCommands,
      });
      const child = new Agent(parentCfg, engineFor(parentCfg.kb.dbPath), tools, childSession.id, { isSubagent: true });
      agents.set(childSession.id, child);

      const job = (async () => {
        let timedOut = false;
        try {
          const out = await Promise.race([
            child.chat(req.prompt),
            new Promise<null>((r) => setTimeout(() => { timedOut = true; r(null); }, TIMEOUT_MS)),
          ]);
          if (timedOut) {
            try { child.stop(); } catch { /* ignore */ }
          }
          try { owner.update(childSession.id, { messages: child.historyForDisk() }); } catch { /* keep the reply */ }
          const text = timedOut
            ? `子任务超时（${TIMEOUT_MS / 1000}s）`
            : (out?.content ?? '(无输出)');
          return {
            description: req.description,
            ok: !timedOut,
            result: `${text}\n\n（子会话 ${childSession.id}）`,
          };
        } catch (err) {
          try { owner.update(childSession.id, { messages: child.historyForDisk() }); } catch { /* ignore */ }
          return {
            description: req.description,
            ok: false,
            result: `子任务失败: ${err instanceof Error ? err.message : String(err)}\n\n（子会话 ${childSession.id}）`,
          };
        }
      })();

      const handOff = () => {
        owner.markBackground(childSession.id);
        void job;
        return {
          description: req.description,
          ok: true,
          result: `已在后台继续。打开会话「${childSession.title}」（${childSession.id}）可以看它的过程。`,
        };
      };
      if (req.background) return handOff();

      const started = Date.now();
      while (Date.now() - started < TIMEOUT_MS + 2_000) {
        const finished = await Promise.race([
          job.then((r) => ({ ready: true as const, r })),
          new Promise<{ ready: false }>((r) => setTimeout(() => r({ ready: false }), 300)),
        ]);
        if (finished.ready) return finished.r;
        if (detachParents.has(parentSessionId)) return handOff();
      }
      return handOff();
    },
  };
}

function configForRoot(root: string): SheConfig {
  const abs = resolve(root);
  if (abs === resolve(config.workspace.root)) return config;
  const kb = resolveWorkspaceKbPath(abs);
  return {
    ...config,
    workspace: { ...config.workspace, root: abs },
    kb: { ...config.kb, dbPath: kb.dbPath },
  };
}

function makeAgent(cfg: SheConfig, sessionId?: string | null): Agent {
  const local = configForRoot(sessionId ? rootForSession(sessionId) : cfg.workspace.root);
  const shell = new SandboxShell(local.workspace.root, local.sandbox);
  const base = createTools(shell, local.workspace.root, { allowAllCommands: local.sandbox.allowAllCommands });

  /*
   * Merge plugin-provided tools into the toolset the agent sees.
   *
   * This is what makes a plugin's declared `tools` real: before the runtime
   * existed, a manifest could list tools and nothing happened — the list was
   * only ever displayed in the UI.
   *
   * `plugins.definitions()` is SYNCHRONOUS on purpose. The agent reads this
   * array in its constructor, so resolving plugin tools lazily left the list
   * empty and the model correctly reported it did not have the tool. The list is
   * loaded in advance by `plugins.refresh()`; see plugins.ts.
   *
   * Built-ins are matched first on execute, so a plugin can never intercept
   * `shell` or `fs_write` (PluginManager also refuses the name collision).
   */
  const merged = {
    definitions: [...base.definitions, ...plugins.definitions()],
    execute: (name: string, args: Record<string, unknown>): Promise<string> => {
      if (base.definitions.some((d) => d.name === name)) return base.execute(name, args);
      return plugins.execute(name, args, local.workspace.root);
    },
  };

  const agent = new Agent(local, engineFor(local.kb.dbPath), merged, sessionId ?? null, {
    subagentRunner: sessionId ? makeSubagentRunner(local, sessionId) : undefined,
      onTaskEvent: (e) => { taskBoard.upsert(e); },
    // Scheduling tools come from the server's store, so the agent and the
    // scheduler always act on the same tasks. Children cannot use them: the tool
    // filter removes `schedule_*` for subagents.
    scheduleBridge: scheduleBridge(),
    setScheduleWindow: applyWorkingWindow,
  });
  // Report tool usage centrally so /api/metrics can show which tools are used and
  // which silently fail. Attached here because every agent goes through makeAgent.
  agent.setToolObserver((name, ms, failed) => {
    metrics.recordTool(name, ms, failed);
    /*
     * Every tool call, including the ones inside a confirmed action — the observer is on the
     * agent, so it sees the same calls whatever path started them. This is the "tools" third of
     * the audit trail; `request` and `confirm` are recorded at their own entry points.
     */
    auditSafe({ kind: 'tool', session_id: sessionId ?? undefined, tool: name, ms, ok: !failed });
  });
  return agent;
}

/**
 * The audit log for the workspace the server is running against.
 *
 * Created once and re-pointed when the workspace root changes, for the same reason the KB engine
 * is: the trail belongs to the project, and a trail that followed the process instead would mix
 * two projects' history into one file.
 */
let audit: AuditLog | null = null;
let auditRoot = '';
function auditLog(): AuditLog {
  const root = resolve(config.workspace.root);
  if (!audit || auditRoot !== root) {
    audit = new AuditLog(root);
    auditRoot = root;
  }
  return audit;
}

/**
 * The run-trace store for the workspace the server is running against.
 *
 * A local mirror of `auditLog`'s caching: pointed at the workspace, re-created when the root
 * changes. Built directly rather than taken from a session's `Agent`, because the run list has to
 * be readable BEFORE any turn in this process has ever run — "show me what happened last time" is
 * asked on a fresh start, which is precisely when no agent object exists yet.
 */
let runTraces: RunTraceStore | null = null;
let runTracesRoot = '';
function runTraceStore(): RunTraceStore {
  const root = resolve(config.workspace.root);
  if (!runTraces || runTracesRoot !== root) {
    runTraces = new RunTraceStore(root);
    runTracesRoot = root;
  }
  return runTraces;
}

/**
 * The confidence mirror for this workspace.
 *
 * Cached the same way as the two stores above, and for the same reason: `GET /api/reflection` has to
 * work on a fresh process, before any session has produced an `Agent`. Each instance keeps an
 * in-memory copy of the file, so constructing a new one per request would re-read and re-parse the
 * same file on every poll.
 */
let reflectionMirrors: ConfidenceMirror | null = null;
let reflectionMirrorsRoot = '';
function reflectionMirror(): ConfidenceMirror {
  const root = resolve(config.workspace.root);
  if (!reflectionMirrors || reflectionMirrorsRoot !== root) {
    reflectionMirrors = new ConfidenceMirror(root);
    reflectionMirrorsRoot = root;
  }
  return reflectionMirrors;
}

/**
 * Write an audit record, never at the cost of the work being audited.
 *
 * Same stance as the metrics path: a full disk or a permissions problem in `.she/` must not turn
 * a working turn into a failed one. It is not silent — the warning goes to the log, and
 * `GET /api/audit` reports the file list and unparseable-line count, so a trail that stopped
 * being written is visible rather than inferred.
 */
function auditSafe(rec: Omit<AuditRecord, 'ts' | 'seq'>): void {
  try {
    auditLog().append(rec);
  } catch (err) {
    log.warn(`审计写入失败（${rec.kind}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The config file the running process read, if one was found. */
function configRecoveryFile(): string | null {
  return getConfigRecovery()?.file ?? null;
}

/** The config file in force, whether or not a fallback happened. */
function configFileInUse(): string | null {
  return getConfigFileInUse();
}

/**
 * What the UI and the probes need to know about the config in force.
 *
 * `recovery` is null in the normal case and non-null only when the file on disk could not be used
 * and the last good snapshot was loaded instead. It is deliberately part of `/api/health`: a probe
 * that reports "ok" while the operator's edits are being ignored is exactly the kind of green light
 * that costs an afternoon.
 */
function configReport(): {
  file: string | null;
  recovery: ReturnType<typeof getConfigRecovery>;
  snapshot: { path: string; exists: boolean; takenAt?: string };
  /** True when what is running is NOT what is on disk. */
  degraded: boolean;
} {
  const file = getConfigFileInUse();
  const snapshotPath = file ? lastGoodConfigPath(file) : null;
  const recovery = getConfigRecovery();
  let takenAt: string | undefined;
  if (file) {
    try {
      const meta = JSON.parse(readFileSync(lastGoodConfigMetaPath(file), 'utf8')) as { takenAt?: unknown };
      if (typeof meta.takenAt === 'string') takenAt = meta.takenAt;
    } catch { /* a missing sidecar just means the timestamp is unknown */ }
  }
  return {
    file: file ?? recovery?.file ?? null,
    recovery,
    snapshot: snapshotPath
      ? { path: snapshotPath, exists: existsSync(snapshotPath), ...(takenAt ? { takenAt } : {}) }
      : { path: '', exists: false },
    degraded: recovery !== null,
  };
}

/**
 * Put the guardrail's findings on the append-only timeline, once per turn that produced any.
 *
 * The turn's own warning is a status chunk in a stream that the user may have already scrolled past,
 * and the log line rotates. The audit file does neither, and this is the finding class where the
 * question comes later ("when did that key first appear in an answer?"), from someone who was not
 * watching. Kinds, counts and MASKED previews only — see `guardrail.ts` on why the value itself is
 * never written down.
 */
function auditGuardrail(agent: Agent, sessionId: string, origin: string): void {
  const report = agent.getGuardrailReport();
  if (!report?.findings.length) return;
  const summary = summariseFindings(report.findings);
  auditSafe({
    kind: 'guardrail',
    session_id: sessionId,
    change: origin,
    note: `回答里有 ${report.findings.length} 处敏感内容：${summary.map((s) => `${s.label}×${s.count}`).join('、')}`
      + `（已遮罩：${report.findings.slice(0, 3).map((f) => f.preview).join(' / ')}）`,
  });
}

/**
 * Record one turn's cost and outcome into the process metrics.
 *
 * Takes the usage snapshot from before the turn because an agent reports
 * CUMULATIVE tokens; only the caller knows which part is new.
 */
function recordTurnMetrics(
  agent: Agent,
  startedAt: number,
  before: ReturnType<Agent['getTokenUsage']>,
  ok: boolean,
): void {
  metrics.recordTurn(Date.now() - startedAt, ok);
  try {
    const now = agent.getTokenUsage();
    metrics.recordTokens({
      prompt_tokens: (now.prompt_tokens ?? 0) - (before.prompt_tokens ?? 0),
      completion_tokens: (now.completion_tokens ?? 0) - (before.completion_tokens ?? 0),
      total_tokens: (now.total_tokens ?? 0) - (before.total_tokens ?? 0),
      reasoning_tokens: (now.reasoning_tokens ?? 0) - (before.reasoning_tokens ?? 0),
      cache_hit_tokens: (now.cache_hit_tokens ?? 0) - (before.cache_hit_tokens ?? 0),
      cache_miss_tokens: (now.cache_miss_tokens ?? 0) - (before.cache_miss_tokens ?? 0),
    });
  } catch {
    // Metrics must never break a turn.
  }
}

/**
 * The working window in effect, from config.
 *
 * Returns null when scheduling is off or no window is configured, which callers
 * read as "no restriction".
 */
function workingWindow(): WorkingWindow | null {
  if (!config.schedule?.enabled) return null;
  return config.schedule.workingWindow ?? null;
}

/**
 * Run one scheduled task.
 *
 * Deliberately NOT routed through the HTTP handlers: those are built around a
 * request and a response, and a scheduled run has neither. This creates or reuses
 * a session, runs one turn to completion, and persists the transcript so the user
 * can read what the agent did while they were away.
 *
 * Headless runs still honour permissions — a schedule must not be a way to
 * escalate: it does not temporarily flip `allowAllCommands`.
 */
async function runScheduledTask(task: ScheduledTask): Promise<void> {
  let sid = task.sessionId;
  if (!sid || !sessions.get(sid)) {
    /*
     * `background` because this session exists to hold a job's output, not to be the
     * conversation the user opens. Without it the run stole `active_id` on every fire, and
     * because the run then left messages here, the startup pick preferred this job log over
     * the user's own chat on the next boot.
     */
    const created = sessions.create(task.name, {
      directory: resolve(config.workspace.root),
      background: true,
    });
    sid = created.id;
    // Remember it, so the next run appends to the same conversation instead of
    // scattering output across a new session every time.
    schedule.recordRun(task.id, { sessionId: sid });
  }

  const agent = agentForSession(sid);
  const turnStart = Date.now();
  const usageBefore = agent.getTokenUsage();
  try {
    const reply = await agent.chat(task.prompt);
    // A one-line breadcrumb so a run is identifiable in the transcript.
    const note = `[定时任务「${task.name}」] ${reply.content?.slice(0, 200) ?? ''}`;
    log.info(note);
    recordTurnMetrics(agent, turnStart, usageBefore, true);
    auditGuardrail(agent, sid, '定时任务');
  } catch (err) {
    recordTurnMetrics(agent, turnStart, usageBefore, false);
    throw err;
  } finally {
    persistHistory(sid);
  }
}

/** The agent for a session id, creating it if needed. Not request-scoped. */
function agentForSession(sessionId: string): Agent {
  let agent = agents.get(sessionId);
  if (!agent) {
    agent = makeAgent(config, sessionId);
    agents.set(sessionId, agent);
  }
  return agent;
}

/**
 * What the `schedule_*` tools are allowed to touch.
 *
 * Kept in the server because the task store and the working window both live
 * here; the agent gets a view, not the objects.
 */
function scheduleBridge(): import('@she/agent-runtime').ScheduleBridge {
  return {
    list: () => schedule.list().map((t) => ({
      id: t.id,
      name: t.name,
      prompt: t.prompt,
      enabled: t.enabled,
      when: describeTrigger(t),
      deferredReason: t.lastDeferredReason,
      nextRun: describeNextRun(t, workingWindow()),
      lastStatus: t.lastStatus,
      lastError: t.lastError,
      runCount: t.runCount,
    })),
    create: (input) => {
      const created = schedule.create({
        name: input.name,
        prompt: input.prompt,
        trigger: input.trigger as ScheduledTask['trigger'],
        // Carried through so the run writes into the conversation the user asked
        // from, which is what the tool promises them.
        sessionId: input.sessionId ?? undefined,
        enabled: input.enabled !== false,
        window: input.window ?? null,
        overlap: input.overlap ?? 'skip',
        softLimitMinutes: input.softLimitMinutes,
      });
      return {
        id: created.id,
        name: created.name,
        prompt: created.prompt,
        enabled: created.enabled,
        when: describeTrigger(created),
        nextRun: describeNextRun(created, workingWindow()),
        runCount: created.runCount,
      };
    },
    remove: (id) => {
      // Refuse while running: removing it would hide an executing task with no
      // way to see what it did.
      if (schedulerInstance?.running().includes(id)) return false;
      return schedule.remove(id);
    },
    window: () => config.schedule?.workingWindow ?? null,
    withinWindow: () => withinWindow(new Date(), workingWindow()),
    nextWindowStart: () => nextWindowStart(new Date(), workingWindow())?.toISOString() ?? null,
  };
}

/** One-line description of when a task fires. */
function describeTrigger(task: ScheduledTask): string {
  const t = task.trigger;
  if (t.kind === 'once') return `一次性 ${new Date(t.at).toLocaleString()}`;
  if (t.kind === 'daily') return `每天 ${t.at}`;
  return `每 ${t.everyMinutes} 分钟`;
}

/**
 * Persist a working-window change and take it into effect.
 *
 * Written to `.env` so it survives a restart, and applied to the live config so
 * the scheduler sees it immediately.
 */
async function applyWorkingWindow(w: { start: string; end: string; days?: number[] } | null): Promise<void> {
  config.schedule.workingWindow = w;
  const encoded = w
    ? `${w.days?.length ? `${w.days.join(',')}@` : ''}${w.start}-${w.end}`
    : '';
  try {
    updateEnvFile(ENV_PATH, { SHE_SCHEDULE_WINDOW: encoded });
    log.info(w
      ? `允许工作的时间段已设为 ${w.start}–${w.end}${w.days?.length ? `（周 ${w.days.join('/')}）` : ''}`
      : '已取消工作时间段限制');
  } catch (err) {
    log.warn(`写入工作时间段设置失败: ${(err as Error).message}`);
  }
}

/**
 * Rebuild every live agent so a toolset change takes effect.
 * An agent caches its tool list at construction, so installing a plugin would
 * otherwise leave every open conversation without the new tools until restart.
 * Histories are carried over, the same way the settings hot-reload does it.
 *
 * The replaced agents are DISPOSED. `Agent.dispose()` stops its language server, and this runs after
 * every plugin install / enable / disable / source edit and on every settings save — so a session
 * that had ever used an `lsp_*` tool left a language server (tsserver indexes the whole project)
 * running for the life of the process, once per rebuild. Nothing called `dispose()` anywhere in the
 * repository, so the leak was unbounded in the number of rebuilds.
 *
 * Disposal is fire-and-forget: it must not make a plugin install wait on a language server shutting
 * down, and a failure to stop one must not fail the rebuild.
 */
function rebuildAgents(): void {
  for (const [sid, old] of agents) {
    // A running turn holds this object. Replacing it does not stop the turn,
    // but disposing it kills the language server under the tools it is using.
    if (old.isRunning()) {
      old.setThinkingLevel(config.llm.thinkingLevel || 'medium');
      continue;
    }
    void old.dispose().catch((err: Error) => log.warn(`释放旧 agent 失败: ${err.message}`));
    const fresh = makeAgent(config, sid);
    fresh.setHistory(old.getHistory());
    agents.set(sid, fresh);
  }
}

/** Resolve the session id a request targets, falling back to the active one. */
function sessionIdOf(req: import('node:http').IncomingMessage, body?: { session_id?: string }): string {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const fromHeader = req.headers['x-session-id'];

  /*
   * Reject a non-string session id instead of coercing it.
   *
   * `String([1,2])` is `"1,2"`, so a malformed value used to sail through and
   * CREATE a junk session — polluting the session list with an entry no client
   * can address. Failing loudly keeps bad input from becoming bad data.
   */
  for (const candidate of [body?.session_id, url.searchParams.get('session_id'), fromHeader]) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    if (typeof candidate !== 'string') {
      throw new HttpError(400, 'session_id must be a string');
    }
  }

  const raw = body?.session_id
    || url.searchParams.get('session_id')
    || (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader)
    || activeAgentId
    || sessions.getActive()?.id
    || '';
  return String(raw).trim();
}

/** Get (or lazily create) the Agent bound to a session, restoring its history. */
function agentFor(
  req: import('node:http').IncomingMessage,
  body?: { session_id?: string },
  opts?: { createIfMissing?: boolean },
): Agent {
  let id = sessionIdOf(req, body);
  if (!id) {
    // Read-only routes must NOT create a session as a side effect: doing so is
    // what made a single "+" click appear to produce two sessions (the page's
    // own history fetch had already silently created one).
    if (opts?.createIfMissing === false) {
      return makeAgent(config);
    }
    const created = sessions.create(undefined, { directory: resolve(config.workspace.root) });
    id = created.id;
  }
  if (activeAgentId !== id) activeAgentId = id;

  let a = agents.get(id);
  if (!a) {
    a = makeAgent(config, id);
    const stored = findSession(id)?.session ?? sessions.get(id);
    if (stored?.messages?.length) a.setHistory(stored.messages);
    agents.set(id, a);
  }
  return a;
}

/** Persist a session's live transcript into its stored session record. */
function persistHistory(id?: string): void {
  const sid = id || activeAgentId || sessions.getActive()?.id;
  if (!sid) return;
  const a = agents.get(sid);
  if (!a) return;
  try {
    const disk = a.historyForDisk();
    const found = findSession(sid);
    if (found) found.store.update(sid, { messages: disk });
    else if (sessions.get(sid)) sessions.update(sid, { messages: disk });
    else sessions.syncActive(disk);
  } catch (err) {
    log.warn(`Failed to persist chat history for ${sid}: ${(err as Error).message}`);
  }
}

/**
 * Stop every cached agent and forget them.
 *
 * Used when the whole set is invalidated — a settings change that moves the state directory, a
 * workspace switch, and process shutdown. `agents.clear()` on its own leaked every agent's language
 * server, because a dropped reference does not stop a child process.
 *
 * Synchronous from the caller's point of view: disposal is fire-and-forget, so this cannot block a
 * settings save on a language server shutting down.
 */
function disposeAllAgents(): void {
  for (const agent of agents.values()) {
    void agent.dispose().catch((err: Error) => log.warn(`释放 agent 失败: ${err.message}`));
  }
  agents.clear();
  activeAgentId = null;
}

/**
 * Drop a session's cached agent (called when history is replaced/deleted). */
function dropAgent(id: string): void {
  // Dispose before dropping: the agent owns a language server, and forgetting the reference without
  // stopping it leaks a child process for the life of the app. Closing a session, deleting one, and
  // switching workspace all land here.
  const old = agents.get(id);
  if (old) void old.dispose().catch((err: Error) => log.warn(`释放 agent 失败: ${err.message}`));
  agents.delete(id);
  if (activeAgentId === id) activeAgentId = null;
}

/**
 * Point the process at another project without killing sessions that are
 * already pinned to their own directory or still running.
 *
 * A full dispose made "open the other project's chat" abort every parallel
 * turn. Pinned sessions keep the agent that was built for their directory.
 */
function mountWorkspace(root: string, sessionId?: string): ChatSession {
  persistHistory();
  const next = resolve(root);
  const prev = resolve(config.workspace.root);
  if (prev !== next) {
    const prevKb = config.kb.dbPath;
    config.workspace.root = next;
    config.kb.dbPath = resolveWorkspaceKbPath(next).dbPath;
    if (resolve(prevKb) !== resolve(config.kb.dbPath)) remountKnowledgeBase(config.kb.dbPath);
    const nextState = resolveStateDir(config);
    if (nextState !== stateDir) {
      otherStores.set(resolve(sessions.rootDir), sessions);
      stateDir = nextState;
      sessions = new SessionStore(stateDir);
      otherStores.delete(resolve(sessions.rootDir));
      cluster = new ClusterStore(stateDir);
      for (const [id, agent] of [...agents]) {
        if (agent.isRunning()) continue;
        const pinned = findSession(id)?.session.directory;
        if (pinned) continue;
        dropAgent(id);
      }
      log.info(`Switched state dir to ${stateDir} (${sessions.list().sessions.length} chats)`);
    }
    try { rememberProject(projectIndexFile(), next); } catch (err) {
      log.warn(`记录项目目录失败: ${(err as Error).message}`);
    }
    try { updateEnvFile(ENV_PATH, { SHE_WORKSPACE: next }); } catch { /* non-fatal */ }
  }

  let chosen: ChatSession | null = null;
  if (sessionId) {
    const found = findSession(sessionId);
    if (found && resolve(found.session.directory || found.store.rootDir) === resolve(sessions.rootDir)) {
      chosen = found.store.setActive(sessionId);
    } else if (found) {
      chosen = found.session;
    }
  }
  if (!chosen) chosen = pickStartupSession();
  if (!chosen.directory && sessions.get(chosen.id)) {
    const dir = resolve(sessions.rootDir);
    chosen = sessions.update(chosen.id, { directory: dir });
  }
  activeAgentId = chosen.id;
  if (!agents.get(chosen.id)) {
    const a = makeAgent(config, chosen.id);
    if (chosen.messages?.length) a.setHistory(chosen.messages);
    agents.set(chosen.id, a);
  }
  return chosen;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  // Video wallpapers. Without these a .mp4 is served as
  // application/octet-stream and the browser silently refuses to play it.
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
};

function serveStaticFile(res: import('node:http').ServerResponse, filePath: string): void {
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.byteLength,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...corsHeaders(),
  });
  res.end(content);
}

function tryServeStatic(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): boolean {
  if (!existsSync(UI_DIR)) return false;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  /*
   * A malformed percent-escape must not become a 500.
   *
   * `decodeURIComponent('/%')` throws `URIError: URI malformed`, which surfaced as
   * `500 Internal Server Error` plus a stack trace in the log — a client error reported as a server
   * bug. The request simply falls back to `index.html`, which is what any other unknown path does.
   */
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    decoded = url.pathname;
  }
  const safePath = decoded.replace(/\.\./g, '');
  const filePath = join(UI_DIR, safePath);

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    serveStaticFile(res, filePath);
    return true;
  }

  const indexPath = join(UI_DIR, 'index.html');
  if (existsSync(indexPath)) {
    serveStaticFile(res, indexPath);
    return true;
  }
  return false;
}

interface GroupTreeNode {
  id: string;
  name: string;
  children: GroupTreeNode[];
  memoryCount: number;
  isDormant: boolean;
}

function buildGroupTree(): GroupTreeNode[] {
  const allGroups = store.getAllGroups();
  const roots = allGroups.filter(g => g.parentGroupId === null);

  function buildNode(groupId: string): GroupTreeNode {
    const group = store.getGroup(groupId);
    if (!group) return { id: groupId, name: '?', children: [], memoryCount: 0, isDormant: false };
    return {
      id: group.id,
      name: group.name,
      children: group.childGroupIds.map(buildNode),
      memoryCount: group.stats.totalMemories,
      isDormant: group.isDormant,
    };
  }

  return roots.map(r => buildNode(r.id));
}


function expandMentions(message: string, workspaceRoot: string): string {
  const fileRe = /@file:([^\s]+)/g;
  const folderRe = /@folder:([^\s]+)/g;
  let out = message;
  const blocks: string[] = [];

  out = out.replace(fileRe, (_m, p1: string) => {
    const rel = String(p1).replace(/^["']|["']$/g, '');
    try {
      const { path: rp, content, truncated } = readWorkspaceFile(workspaceRoot, rel);
      blocks.push(`<attached_file path="${rp}"${truncated ? ' truncated="true"' : ''}>\n${content}\n</attached_file>`);
      return `@file:${rp}`;
    } catch (err) {
      blocks.push(`<attached_file path="${rel}" error="${(err as Error).message}" />`);
      return `@file:${rel}`;
    }
  });

  out = out.replace(folderRe, (_m, p1: string) => {
    const rel = String(p1).replace(/^["']|["']$/g, '');
    try {
      const tree = listTree(workspaceRoot, rel, 2);
      const listing = JSON.stringify(tree, null, 2);
      blocks.push(`<attached_folder path="${rel.replace(/\\/g, '/')}">\n${listing}\n</attached_folder>`);
      return `@folder:${rel.replace(/\\/g, '/')}`;
    } catch (err) {
      blocks.push(`<attached_folder path="${rel}" error="${(err as Error).message}" />`);
      return `@folder:${rel}`;
    }
  });

  if (!blocks.length) return message;
  return `${out}\n\n---\nAttached workspace context (structural @file/@folder, not RAG):\n${blocks.join('\n\n')}`;
}

function registerRoutes(router: Router): void {

  router.get('/api/health', (_req, res) => {
    sendJSON(res, { status: 'ok', version: PRODUCT_VERSION, kbReady: !!store, config: configReport() });
  });

  /** Same payload as /api/health — ops probes often hit /health and used to get the SPA shell. */
  router.get('/health', (_req, res) => {
    sendJSON(res, { status: 'ok', version: PRODUCT_VERSION, kbReady: !!store, config: configReport() });
  });

  /*
   * The config file that is in force, and whether it is the one on disk.
   *
   * `loadConfig` falls back to the last config that parsed when the current file cannot be read
   * (see `lastGoodConfigPath` in @she/shared). That fallback is only safe because it is never
   * silent, and this is where it stops being silent: the UI reads this and says which file was
   * refused and why. `recovery: null` is the normal state — it means the config on disk is the
   * config in use.
   */
  router.get('/api/config/recovery', (_req, res) => {
    sendJSON(res, configReport());
  });

  /*
   * Put the last good config back where the broken one is.
   *
   * Deliberately a separate, explicit action rather than something the fallback does on its own:
   * overwriting a file the user is editing would destroy the half-finished edit that a text editor
   * and a diff can fix in seconds. The broken file is moved aside first (never deleted), so both
   * versions exist afterwards. The running process keeps the config it loaded — a restart applies
   * the change, which the response says.
   */
  router.post('/api/config/rollback', (_req, res) => {
    const current = configFileInUse() ?? configRecoveryFile();
    if (!current) throw new HttpError(404, '这个进程没有读到配置文件，没有可回退的对象');
    const snapshot = lastGoodConfigPath(current);
    if (!existsSync(snapshot)) throw new HttpError(404, `还没有可回退的配置快照：${snapshot}（需要先成功启动过一次）`);
    const aside = `${current}.unusable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (existsSync(current)) {
      try {
        renameSync(current, aside);
      } catch (err) {
        throw new HttpError(400, `无法把当前配置移到一边：${(err as Error).message}`);
      }
    }
    try {
      copyFileSync(snapshot, current);
    } catch (err) {
      // Put it back rather than leaving the user with no config file at all.
      if (existsSync(aside)) { try { renameSync(aside, current); } catch { /* reported below */ } }
      throw new HttpError(400, `无法写入配置：${(err as Error).message}`);
    }
    auditSafe({
      kind: 'config',
      change: 'rollback_config',
      note: `把 ${snapshot} 回退到 ${current}${existsSync(aside) ? `（原文件留在 ${aside}）` : ''}`,
    });
    sendJSON(res, {
      ok: true,
      file: current,
      from: snapshot,
      kept: existsSync(aside) ? aside : null,
      note: '已回退。重启后生效（当前进程仍用启动时读到的配置）。',
    });
  });

  /**
   * Process-level metrics.
   *
   * Distinct from `/api/usage`, which reports ONE session's tokens. This answers
   * the operational questions, and in particular exposes the prompt-cache hit
   * rate — a number that is otherwise invisible until it shows up on a bill. A
   * multi-turn conversation sitting near 0% means the request prefix is changing
   * when it should not be; see docs/context-and-caching.md.
   */
  router.get('/api/metrics', (_req, res) => {
    sendJSON(res, {
      ...metrics.snapshot(),
      llm: { provider: config.llm.provider, model: config.llm.model },
      sessions: { open: agents.size },
      workspace: config.workspace.root,
    });
  });

  /*
   * Scheduled tasks.
   *
   * The window endpoints report the boundary semantics explicitly, because they
   * are the part that is easy to misread: being outside the window never means
   * "will not run", only "will not START yet".
   */
  router.get('/api/schedule', (_req, res) => {
    const now = new Date();
    const window = workingWindow();
    sendJSON(res, {
      enabled: !!config.schedule?.enabled,
      tickSeconds: config.schedule?.tickSeconds ?? 30,
      workingWindow: config.schedule?.workingWindow ?? null,
      withinWindow: withinWindow(now, window),
      nextWindowStart: nextWindowStart(now, window)?.toISOString() ?? null,
      running: schedulerInstance?.running() ?? [],
      tasks: schedule.list().map((t) => ({
        ...t,
        nextRun: describeNextRun(t, workingWindow(), now),
      })),
      recovery: schedule.recoveryNotice,
    });
  });

  router.post('/api/schedule', async (req, res) => {
    const body = await parseBody<Partial<ScheduledTask>>(req);
    try {
      const task = schedule.create({
        name: String(body.name ?? '').trim(),
        prompt: String(body.prompt ?? '').trim(),
        trigger: body.trigger as ScheduledTask['trigger'],
        sessionId: body.sessionId,
        enabled: body.enabled !== false,
        window: body.window ?? null,
        overlap: body.overlap === 'queue' ? 'queue' : 'skip',
        softLimitMinutes: body.softLimitMinutes,
      });
      sendJSON(res, { ok: true, task }, 201);
    } catch (err) {
      // Validation failures are the client's fault, so 400 — not a 500.
      throw new HttpError(400, (err as Error).message);
    }
  });

  /**
   * Set or clear the working window.
   *
   * Declared BEFORE `/api/schedule/:id` on purpose: routes are matched in
   * declaration order, so with the `:id` route first, a request to
   * `/api/schedule/window` would be read as a task whose id is "window" and would
   * fail as a 404 instead of setting anything.
   */
  router.put('/api/schedule/window', async (req, res) => {
    const body = await parseBody<{ start?: string; end?: string; days?: number[]; clear?: boolean }>(req);
    if (body.clear || (!body.start && !body.end)) {
      await applyWorkingWindow(null);
      sendJSON(res, { ok: true, workingWindow: null });
      return;
    }
    const start = String(body.start ?? '').trim();
    const end = String(body.end ?? '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      throw new HttpError(400, 'start 与 end 都需要 HH:MM 格式（例如 09:00 与 18:00）');
    }
    const days = Array.isArray(body.days)
      ? body.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : undefined;
    await applyWorkingWindow(days && days.length ? { start, end, days } : { start, end });
    sendJSON(res, { ok: true, workingWindow: config.schedule.workingWindow });
  });

  router.put('/api/schedule/:id', async (req, res, params) => {
    const body = await parseBody<Partial<ScheduledTask>>(req);
    try {
      const task = schedule.update(params.id, body);
      if (!task) throw new HttpError(404, `定时任务不存在: ${params.id}`);
      sendJSON(res, { ok: true, task });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, (err as Error).message);
    }
  });

  router.delete('/api/schedule/:id', (_req, res, params) => {
    // Refuse to drop a task that is mid-run: it would vanish from the list while
    // still executing, leaving no way to see what it did.
    if (schedulerInstance?.running().includes(params.id)) {
      throw new HttpError(409, '该任务正在执行，请先停用并等它结束后再删除');
    }
    sendJSON(res, { ok: schedule.remove(params.id) });
  });

  /** Run a task now, ignoring its trigger but NOT its window. */
  router.post('/api/schedule/:id/run', async (_req, res, params) => {
    const task = schedule.get(params.id);
    if (!task) throw new HttpError(404, `定时任务不存在: ${params.id}`);

    /*
     * Manual runs respect the window too, so "run now" cannot quietly set the
     * expectation that the window does not apply. The message distinguishes a
     * deferral from a refusal, because that is the part users misread.
     */
    const window = task.window ?? workingWindow();
    if (!withinWindow(new Date(), window)) {
      const next = nextWindowStart(new Date(), window);
      throw new HttpError(
        409,
        `当前不在允许工作的时间段内${next ? `，顺延到 ${next.toLocaleString()}` : ''}。`
        + '注意这是「暂不启动」而不是「不能执行」：到点会自动开始。'
        + '若要立刻执行，请调整工作时间设置。',
      );
    }

    /*
     * A disabled scheduler must not report success.
     *
     * `schedulerInstance?.runNow(...)` yields `undefined` when the scheduler was never constructed
     * (`config.schedule.enabled` false), the `if (result && ...)` guard was skipped, and the route
     * answered `{ok: true, started: true}` — while nothing ran and no record was made. A user or a
     * script reading `ok` had no way to tell that apart from a real run.
     */
    if (!schedulerInstance) {
      throw new HttpError(409, '定时任务功能已关闭（SHE_SCHEDULE_ENABLED=0），无法手动运行。');
    }
    // Routed through the scheduler so a manual run is recorded exactly like an
    // automatic one; calling the runner directly left `lastStatus` unset, making
    // the run invisible in the list.
    const result = await schedulerInstance.runNow(params.id);
    if (!result.started) {
      throw new HttpError(409, result.reason ?? '无法启动');
    }
    sendJSON(res, { ok: true, started: true });
  });

  router.post('/api/chat', async (req, res) => {
    const body = await parseBody<{ message: string; stream?: boolean; session_id?: string }>(req);
    /*
     * Type-check, don't just truth-check.
     *
     * `if (!body.message)` passes a number or object, and the next line calls
     * `.replace()` on it — a TypeError that surfaced as HTTP 500. A malformed
     * request is the client's fault, so it must be a 400.
     */
    if (typeof body.message !== 'string' || !body.message) {
      throw new HttpError(400, 'Missing required field: message (string)');
    }
    const message = expandMentions(body.message, config.workspace.root);
    const agent = agentFor(req, body);
    const sid = sessionIdOf(req, body);

    /*
     * The request third of the audit trail: what was asked, in which conversation.
     *
     * Recorded here rather than in the agent so it covers every route into a turn and stays a
     * property of the server. Long messages are truncated by `AuditLog`, which keeps the real
     * length alongside, so a cut record is still measurable.
     */
    auditSafe({ kind: 'request', session_id: sid, message });

    /*
     * Refuse a second turn on a conversation that is already running.
     *
     * Checked here rather than relying on the agent's own guard, because the streaming
     * branch calls `startSSE` — which writes headers — before the first `chat()` call.
     * By then a 409 is no longer possible and the conflict would arrive as an SSE
     * error event, i.e. as a mid-stream failure rather than a clear status.
     *
     * The agent's guard still exists as the backstop for direct API users and for the
     * narrow race where a turn starts between this check and the call.
     */
    if (agent.isRunning()) {
      throw new HttpError(
        409,
        '这一轮还在进行中。等它结束再发，或用「追加」（/api/chat/interject）把内容接在当前这轮后面。',
      );
    }

    // A new user turn means the previous ask_user question is settled — either
    // answered by this message or abandoned. Leaving it pending resurrected the
    // card on every reload.
    clearPendingQuestion();

    if (body.stream) {
      startSSE(res);
      const turnStart = Date.now();
      // Token usage is a per-agent cumulative counter, so the turn's cost is the
      // delta across it rather than the running total.
      const usageBefore = agent.getTokenUsage();
      try {
        let lastPersist = 0;
        const reply = await agent.chat(message, (chunk: StreamChunk) => {
          sendSSEEvent(res, chunk);
          const now = Date.now();
          if (now - lastPersist > 2000) {
            lastPersist = now;
            try { persistHistory(sid); } catch { /* the final persist still runs */ }
          }
        });
        recordTurnMetrics(agent, turnStart, usageBefore, true);
        auditGuardrail(agent, sid, '对话');
        sendSSEEvent(res, { type: 'done', content: reply.content });
        endSSE(res);
      } catch (err) {
        recordTurnMetrics(agent, turnStart, usageBefore, false);
        sendSSEEvent(res, { type: 'error', error: (err as Error).message });
        endSSE(res);
      } finally {
        // Persist even when the provider failed, so the user's turn is never lost.
        persistHistory(sid);
      }
      return;
    }

    {
      const turnStart = Date.now();
      const usageBefore = agent.getTokenUsage();
      try {
        const reply = await agent.chat(message);
        recordTurnMetrics(agent, turnStart, usageBefore, true);
        auditGuardrail(agent, sid, '对话');
        persistHistory(sid);
        sendJSON(res, { role: reply.role, content: reply.content, toolCalls: reply.tool_calls });
      } catch (err) {
        recordTurnMetrics(agent, turnStart, usageBefore, false);
        persistHistory(sid);
        throw err;
      }
    }
  });

  /**
   * Transcript for the UI.
   *
   * Returns the FULL history — nothing is trimmed server-side.
   *
   * An earlier revision capped this payload, but cutting context was the wrong
   * trade: the cost belongs in the renderer (which can mount only what is on
   * screen), not in losing data the user may scroll back to.
   */
  router.get('/api/chat/history', (req, res) => {
    const agent = agentFor(req, undefined, { createIfMissing: false });
    const messages = agent.getHistory();
    sendJSON(res, {
      session_id: sessionIdOf(req),
      messages,
      total: messages.length,
    });
  });

  router.delete('/api/chat/history', (req, res) => {
    const agent = agentFor(req);
    const sid = sessionIdOf(req);
    agent.clearHistory();
    try { if (sessions.get(sid)) sessions.update(sid, { messages: [] }); } catch { /* ignore */ }
    sendJSON(res, { ok: true });
  });

  /** Replace the live transcript (used by explicit history edits). */
  router.put('/api/chat/history', async (req, res) => {
    const body = await parseBody<{ messages?: import('@she/shared').LLMMessage[]; session_id?: string }>(req);
    const sid = sessionIdOf(req, body);
    const agent = agentFor(req, body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    agent.setHistory(messages);
    const healed = agent.getHistory();
    try { if (sessions.get(sid)) sessions.update(sid, { messages: healed }); } catch { /* ignore */ }
    sendJSON(res, { ok: true, messages: healed.length });
  });

  /**
   * Rewind a conversation: drop the message at `index` and everything after it, then persist.
   * Backs the "撤销到此" affordance in the transcript.
   *
   * There were TWO handlers registered for this path, and `Router` matches in declaration order — so
   * only the first ever ran and the second's stricter validation (integer, bounds check) and richer
   * response were unreachable. This is the merged one.
   */
  router.post('/api/chat/rewind', async (req, res) => {
    const body = await parseBody<{ index?: number; session_id?: string }>(req);
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new HttpError(400, 'index must be a non-negative integer');
    }
    const agent = agentFor(req, body);
    const sid = sessionIdOf(req, body);
    const history = agent.getHistory();
    if (index >= history.length) {
      throw new HttpError(400, `index ${index} is beyond history length ${history.length}`);
    }
    const kept = history.slice(0, index);
    agent.setHistory(kept);
    persistHistory(sid);
    // `messages` is kept alongside `removed`/`remaining` so neither shape of caller is surprised.
    sendJSON(res, { ok: true, messages: kept.length, removed: history.length - kept.length, remaining: kept.length });
  });

  /**
   * Append context to an in-flight turn without stopping it. The agent folds
   * the text in at its next tool-loop iteration.
   */
  router.post('/api/chat/interject', async (req, res) => {
    const body = await parseBody<{ message?: string; session_id?: string }>(req);
    const text = String(body.message ?? '').trim();
    if (!text) throw new HttpError(400, 'Missing required field: message');
    const agent = agentFor(req, body);
    agent.interject(text);
    persistHistory(sessionIdOf(req, body));
    sendJSON(res, { ok: true, queued: text.length });
  });

  /**
   * Interrupt the running turn server-side. Previously "stop" in the UI only
   * aborted the browser fetch, so the agent kept consuming tokens and mutating
   * the workspace in the background.
   */
  router.post('/api/chat/stop', async (req, res) => {
    const body = await parseBody<{ session_id?: string }>(req).catch(() => ({ session_id: undefined }));
    const agent = agentFor(req, body);
    const stopped = agent.stop();
    persistHistory(sessionIdOf(req, body));
    sendJSON(res, { ok: true, stopped });
  });

  router.get('/api/chat/running', (req, res) => {
    sendJSON(res, { running: agentFor(req, undefined, { createIfMissing: false }).isRunning() });
  });

  router.get('/api/chat/pending-confirm', (req, res) => {
    sendJSON(res, { ticket: agentFor(req, undefined, { createIfMissing: false }).getPendingConfirm() });
  });

  router.post('/api/chat/confirm', async (req, res) => {
    const body = await parseBody<{ ticket_id: string; stream?: boolean; session_id?: string }>(req);
    if (!body.ticket_id) throw new HttpError(400, 'Missing required field: ticket_id');
    const agent = agentFor(req, body);
    const sid = sessionIdOf(req, body);

    /*
     * The confirm third of the audit trail.
     *
     * This is the line a human approval is reconstructed from: which ticket, in which
     * conversation, and that it was approved. Recorded BEFORE the tool runs, so an approval that
     * then fails is still on the record as an approval.
     *
     * The ticket is verified FIRST, and that ordering is the point. `confirmTool` throws on a
     * mismatched id before doing anything, so writing the record first meant a forged or stale
     * `ticket_id` produced a record saying a human approved a tool that no human was ever asked
     * about. The trail's one job is that "someone approved this" is true, so a ticket that does
     * not match the one actually pending is refused outright rather than logged as an approval.
     * A clean 409 also beats the old behaviour of an error delivered mid-SSE-stream.
     */
    const pendingConfirm = agent.getPendingConfirm();
    if (!pendingConfirm || pendingConfirm.ticket_id !== body.ticket_id) {
      throw new HttpError(
        409,
        pendingConfirm
          ? '这张工单已经过期，或者不是当前在等的工单。刷新后重新确认。'
          : '现在没有等你确认的操作。',
      );
    }
    auditSafe({
      kind: 'confirm',
      session_id: sid,
      ticket_id: body.ticket_id,
      approved: true,
      tool: pendingConfirm.tool,
      note: pendingConfirm.summary,
    });

    if (body.stream !== false) {
      startSSE(res);
      try {
        const reply = await agent.confirmTool(body.ticket_id, (chunk: StreamChunk) => {
          sendSSEEvent(res, chunk);
        });
        sendSSEEvent(res, { type: 'done', content: reply.content });
        endSSE(res);
      } catch (err) {
        sendSSEEvent(res, { type: 'error', error: (err as Error).message });
        endSSE(res);
      } finally {
        persistHistory(sid);
      }
      return;
    }

    const reply = await agent.confirmTool(body.ticket_id);
    persistHistory(sid);
    sendJSON(res, { role: reply.role, content: reply.content, toolCalls: reply.tool_calls });
  });



  router.get('/api/chat/pending-patch', (req, res) => {
    sendJSON(res, { patch: agentFor(req, undefined, { createIfMissing: false }).getPendingPatch() });
  });

  router.get('/api/fs/patches', (req, res) => {
    sendJSON(res, { patches: agentFor(req, undefined, { createIfMissing: false }).getPendingPatches() });
  });

  router.post('/api/fs/apply-all', async (req, res) => {
    const body = await parseBody<{ stream?: boolean; session_id?: string }>(req);
    const agent = agentFor(req, body);
    const sid = sessionIdOf(req, body);
    if (body.stream !== false) {
      startSSE(res);
      try {
        const reply = await agent.applyAllPatches((chunk: StreamChunk) => {
          sendSSEEvent(res, chunk);
        });
        sendSSEEvent(res, { type: 'done', content: reply.content });
        endSSE(res);
      } catch (err) {
        sendSSEEvent(res, { type: 'error', error: (err as Error).message });
        endSSE(res);
      } finally {
        persistHistory(sid);
      }
      return;
    }
    const reply = await agent.applyAllPatches();
    persistHistory(sid);
    sendJSON(res, { role: reply.role, content: reply.content });
  });

  router.post('/api/fs/reject-all', async (req, res) => {
    const body = await parseBody<{ session_id?: string }>(req).catch(() => ({ session_id: undefined }));
    const agent = agentFor(req, body);
    const out = await agent.rejectAllPatches();
    persistHistory(sessionIdOf(req, body));
    sendJSON(res, out);
  });

  router.post('/api/fs/apply', async (req, res) => {
    const body = await parseBody<{ patch_id: string; stream?: boolean; session_id?: string }>(req);
    if (!body.patch_id) throw new HttpError(400, 'Missing required field: patch_id');
    const agent = agentFor(req, body);
    const sid = sessionIdOf(req, body);
    if (body.stream !== false) {
      startSSE(res);
      try {
        const reply = await agent.applyPatch(body.patch_id, (chunk: StreamChunk) => {
          sendSSEEvent(res, chunk);
        });
        sendSSEEvent(res, { type: 'done', content: reply.content });
        endSSE(res);
      } catch (err) {
        sendSSEEvent(res, { type: 'error', error: (err as Error).message });
        endSSE(res);
      } finally {
        persistHistory(sid);
      }
      return;
    }
    const reply = await agent.applyPatch(body.patch_id);
    persistHistory(sid);
    sendJSON(res, { role: reply.role, content: reply.content });
  });

  
  router.get('/api/fs/checkpoints', (req, res) => {
    sendJSON(res, { checkpoints: agentFor(req, undefined, { createIfMissing: false }).listCheckpoints(20) });
  });

  router.post('/api/fs/undo', async (req, res) => {
    const body = await parseBody<{ checkpoint_id?: string; session_id?: string }>(req);
    const agent = agentFor(req, body);
    const out = body.checkpoint_id
      ? agent.undoCheckpoint(body.checkpoint_id)
      : agent.undoLastCheckpoint();
    persistHistory(sessionIdOf(req, body));
    sendJSON(res, out);
  });

  router.post('/api/fs/reject', async (req, res) => {
    const body = await parseBody<{ patch_id: string; session_id?: string }>(req);
    if (!body.patch_id) throw new HttpError(400, 'Missing required field: patch_id');
    const agent = agentFor(req, body);
    const out = await agent.rejectPatch(body.patch_id);
    persistHistory(sessionIdOf(req, body));
    sendJSON(res, out);
  });

  router.get('/api/settings', (_req, res) => {
    sendJSON(res, {
      llm: {
        provider: config.llm.provider,
        model: config.llm.model,
        baseUrl: config.llm.baseUrl,
        hasKey: Boolean(config.llm.apiKey),
        maxTokens: config.llm.maxTokens,
        temperature: config.llm.temperature,
        thinkingLevel: config.llm.thinkingLevel || 'medium',
        fallback: {
          provider: config.llm.fallback?.provider || 'openai',
          model: config.llm.fallback?.model || '',
          baseUrl: config.llm.fallback?.baseUrl || '',
          hasKey: Boolean(config.llm.fallback?.apiKey),
        },
      },
      workspace: { root: config.workspace.root },
      kb: {
        dbPath: config.kb.dbPath,
        mode: resolveWorkspaceKbPath(config.workspace.root).mode,
        linkPath: resolveWorkspaceKbPath(config.workspace.root).link?.dbPath ?? null,
      },
      skills: { profile: readSkillProfile(config.workspace.root) },
      automationMode: config.automationMode !== false,
      sandbox: config.sandbox,
      server: config.server,
    });
  });

  
  router.get('/api/skills/profile', (_req, res) => {
    sendJSON(res, { profile: readSkillProfile(config.workspace.root) });
  });

  router.put('/api/skills/profile', async (req, res) => {
    const body = await parseBody<{ profile?: string }>(req);
    if (body.profile !== 'dev' && body.profile !== 'liberal' && body.profile !== 'general' && body.profile !== 'custom') {
      sendError(res, 'profile must be dev | liberal | general | custom', 400);
      return;
    }
    writeSkillProfile(config.workspace.root, body.profile);
    config.skills.profile = body.profile;
    // The prompt is baked when the agent is constructed. Writing the file
    // alone left the live conversation on the previous profile.
    rebuildAgents();
    sendJSON(res, { ok: true, profile: body.profile });
  });

router.put('/api/settings', async (req, res) => {
    const body = await parseBody<{
      provider?: 'openai' | 'anthropic';
      model?: string;
      baseUrl?: string;
      apiKey?: string;
      workspaceRoot?: string;
      temperature?: number;
      maxTokens?: number;
      allowAllCommands?: boolean;
      kbDbPath?: string;
      skillProfile?: 'dev' | 'liberal' | 'general' | 'custom';
      automationMode?: boolean;
      thinkingLevel?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      fallbackBaseUrl?: string;
      fallbackApiKey?: string;
      fallbackModel?: string;
      fallbackProvider?: 'openai' | 'anthropic';
    }>(req);

    const prevWorkspaceRoot = config.workspace.root;
    const prevKbDbPath = config.kb.dbPath;
    /** Env keys to persist into the canonical .env (single source of truth). */
    const envPatch: Record<string, string> = {};
    const setEnv = (key: string, value: string) => { envPatch[key] = value; };

    if (body.provider === 'openai' || body.provider === 'anthropic') {
      config.llm.provider = body.provider;
      setEnv('SHE_LLM_PROVIDER', body.provider);
    }
    const provider = config.llm.provider;
    if (body.model && body.model.trim()) {
      config.llm.model = body.model.trim();
      setEnv(provider === 'anthropic' ? 'ANTHROPIC_MODEL' : 'OPENAI_MODEL', config.llm.model);
    }
    if (body.baseUrl && body.baseUrl.trim()) {
      config.llm.baseUrl = body.baseUrl.trim();
      if (provider === 'openai') setEnv('OPENAI_BASE_URL', config.llm.baseUrl);
    }
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      config.llm.apiKey = body.apiKey.trim();
      setEnv(provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY', config.llm.apiKey);
      if (provider === 'openai') setEnv('AGI_USE_API_KEY', config.llm.apiKey);
    }
    if (body.workspaceRoot) {
      config.workspace.root = resolve(body.workspaceRoot);
      setEnv('SHE_WORKSPACE', config.workspace.root);
    }
    /*
     * Persisted, not just applied in memory.
     *
     * These two were the only settings in this handler that skipped `setEnv`, so the change
     * survived until the next restart and then reverted with no error anywhere. `check:restart`
     * asserts both directions; keeping them in `.env` is what makes that pass.
     */
    if (typeof body.temperature === 'number') {
      config.llm.temperature = body.temperature;
      setEnv('SHE_LLM_TEMPERATURE', String(body.temperature));
    }
    if (typeof body.maxTokens === 'number') {
      config.llm.maxTokens = body.maxTokens;
      setEnv('SHE_LLM_MAX_TOKENS', String(body.maxTokens));
    }
    if (typeof body.allowAllCommands === 'boolean') {
      config.sandbox.allowAllCommands = body.allowAllCommands;
      config.sandbox.denyDestructiveByDefault = !body.allowAllCommands;
      setEnv('SHE_ALLOW_ALL_COMMANDS', body.allowAllCommands ? 'true' : 'false');
    }

    if (typeof body.kbDbPath === 'string') {
      const p = body.kbDbPath.trim();
      if (!p) {
        // Empty = local default for this workspace; drop shared link + env override.
        clearKbLink(config.workspace.root);
        delete process.env.SHE_KB_PATH;
        setEnv('SHE_KB_PATH', '');
        config.kb.dbPath = resolve(config.workspace.root, '.she', 'kb.sqlite');
      } else {
        const abs = isAbsolute(p) ? resolve(p) : resolve(config.workspace.root, p);
        config.kb.dbPath = abs;
        writeKbLink(config.workspace.root, abs, 'bound via settings');
        // Do not force SHE_KB_PATH ? per-workspace kb-link is the source of truth.
        // Clear a stale global override so switching workspaces can diverge.
        if (process.env.SHE_KB_PATH) {
          delete process.env.SHE_KB_PATH;
          setEnv('SHE_KB_PATH', '');
        }
      }
    }

    if (body.skillProfile === 'dev' || body.skillProfile === 'liberal' || body.skillProfile === 'general' || body.skillProfile === 'custom') {
      writeSkillProfile(config.workspace.root, body.skillProfile as SkillProfile);
      config.skills.profile = body.skillProfile;
      setEnv('SHE_SKILL_PROFILE', body.skillProfile);
    }
    if (typeof body.automationMode === 'boolean') {
      config.automationMode = body.automationMode;
      setEnv('SHE_AUTOMATION_MODE', body.automationMode ? 'true' : 'false');
      /*
       * An explicit `allowAllCommands` in the same request always wins — both ways.
       *
       * The UI links the two toggles as a convenience (turning automation on pre-ticks
       * "allow all commands"), but they are separate switches the user can then change. Only
       * the OFF branch checked for an explicit value, so sending
       * `{ automationMode: true, allowAllCommands: false }` applied `false` and then had it
       * silently overwritten back to `true` — the user turned the dangerous switch OFF and the
       * server turned it back ON, then persisted that.
       */
      if (typeof body.allowAllCommands !== 'boolean') {
        if (body.automationMode) {
          config.sandbox.allowAllCommands = true;
          config.sandbox.denyDestructiveByDefault = false;
        } else {
          // Leaving automation mode must not silently leave "allow all commands" enabled —
          // that is how destructive commands stayed permitted.
          config.sandbox.allowAllCommands = false;
          config.sandbox.denyDestructiveByDefault = true;
        }
      }
      // Persist the *effective* value, not the incoming one.
      setEnv('SHE_ALLOW_ALL_COMMANDS', config.sandbox.allowAllCommands ? 'true' : 'false');
    }
    if (body.thinkingLevel && THINKING_LEVEL_SET.has(body.thinkingLevel)) {
      config.llm.thinkingLevel = body.thinkingLevel;
      setEnv('SHE_THINKING_LEVEL', body.thinkingLevel);
    }
    if (!config.llm.fallback) config.llm.fallback = {};
    if (typeof body.fallbackBaseUrl === 'string') {
      config.llm.fallback.baseUrl = body.fallbackBaseUrl.trim();
      setEnv('SHE_LLM_FALLBACK_BASE_URL', config.llm.fallback.baseUrl);
    }
    if (typeof body.fallbackModel === 'string') {
      config.llm.fallback.model = body.fallbackModel.trim();
      setEnv('SHE_LLM_FALLBACK_MODEL', config.llm.fallback.model);
    }
    if (body.fallbackProvider === 'openai' || body.fallbackProvider === 'anthropic') {
      config.llm.fallback.provider = body.fallbackProvider;
      setEnv('SHE_LLM_FALLBACK_PROVIDER', body.fallbackProvider);
    }
    if (typeof body.fallbackApiKey === 'string' && body.fallbackApiKey.length > 0) {
      config.llm.fallback.apiKey = body.fallbackApiKey;
      setEnv('SHE_LLM_FALLBACK_API_KEY', body.fallbackApiKey);
    }

    // Persist to the canonical .env — the same file loadConfig() reads on boot.
    updateEnvFile(ENV_PATH, envPatch);
    for (const [key, value] of Object.entries(envPatch)) process.env[key] = value;

    // If the workspace moved, relocate chat/cluster state so history follows.
    const nextStateDir = resolveStateDir(config);
    if (nextStateDir !== stateDir) {
        persistHistory();
        stateDir = nextStateDir;
        sessions = new SessionStore(stateDir);
        cluster = new ClusterStore(stateDir);
        // Disposes as well as drops: each agent owns a language server process.
        disposeAllAgents();
      }

    // A thinking-level change must not rebuild agents. The slider fires this
    // endpoint, and a rebuild disposed the language server under a live turn —
    // which is why moving the slider (or anything else that saved settings)
    // stopped the reply, and why the UI felt stuck until the slider moved.
    const structuralChange = Boolean(
      body.provider || body.model || body.baseUrl || body.apiKey || body.workspaceRoot
      || body.skillProfile || typeof body.automationMode === 'boolean'
      || typeof body.allowAllCommands === 'boolean' || typeof body.kbDbPath === 'string'
      || body.fallbackBaseUrl || body.fallbackApiKey || body.fallbackModel || body.fallbackProvider
      || typeof body.temperature === 'number' || typeof body.maxTokens === 'number',
    );
    if (!structuralChange) {
      for (const agent of agents.values()) agent.setThinkingLevel(config.llm.thinkingLevel || 'medium');
    } else {
      rebuildAgents();
    }
    persistHistory();

    const kbChanged = resolve(prevKbDbPath) !== resolve(config.kb.dbPath);
    if (kbChanged) {
      try {
        remountKnowledgeBase(config.kb.dbPath);
      } catch (err) {
        throw new HttpError(500, `???????: ${(err as Error).message}`);
      }
    }
    const restartRequired =
      resolve(prevWorkspaceRoot) !== resolve(config.workspace.root);

    sendJSON(res, {
      ok: true,
      restartRequired,
      settingsFile: ENV_PATH,
      llm: {
        provider: config.llm.provider,
        model: config.llm.model,
        baseUrl: config.llm.baseUrl,
        hasKey: Boolean(config.llm.apiKey),
      },
      workspace: { root: config.workspace.root },
      kb: { dbPath: config.kb.dbPath },
      sandbox: {
        allowAllCommands: config.sandbox.allowAllCommands,
        denyDestructiveByDefault: config.sandbox.denyDestructiveByDefault,
      },
    });
  });


  // ── sessions (persisted named chats) ──


  // ---- inline terminal (sandbox shell) ----
  router.post('/api/terminal/exec', async (req, res) => {
    const body = await parseBody<{ command?: string; cwd?: string; confirm_ticket_id?: string; timeout?: number }>(req);
    const command = String(body.command || '').trim();
    if (!command) throw new HttpError(400, 'Missing command');

    const termShell = new SandboxShell(config.workspace.root, config.sandbox);
    const tickets = new ConfirmTicketStore(config.workspace.root);
    const cwd = body.cwd || '.';

    /*
     * Ask for confirmation when EITHER control would refuse.
     *
     * Previously only the denylist triggered a ticket, so a command refused by the
     * allowlist was refused outright — after the user had already been asked and
     * confirmed, which reads as the confirmation not working.
     *
     * The ticket is the human override for both controls, and it is bound to the exact
     * command: approving `rm -rf build` must not authorise a different one.
     */
    const denyVerdict = termShell.isCommandAllowed(command);
    const wouldRefuse = termShell.isDestructive(command) || !denyVerdict.allowed;

    if (wouldRefuse) {
      const err = config.sandbox.allowAllCommands
        ? null
        : tickets.consume('terminal', body.confirm_ticket_id, { command, cwd });
      if (err) {
        const summary = termShell.isDestructive(command)
          ? `terminal: ${command.slice(0, 120)}`
          : `terminal (不在白名单): ${command.slice(0, 100)}`;
        const ticket = tickets.issue('terminal', summary, { args: { command, cwd } });
        sendJSON(res, {
          needs_confirm: true,
          ticket,
          denied: true,
          reason: denyVerdict.allowed ? undefined : denyVerdict.reason,
        });
        return;
      }
    }

    const result = await termShell.exec(command, {
      cwd,
      timeout: body.timeout,
      allowDestructive: wouldRefuse,
    });
    sendJSON(res, {
      ...result,
      cwd,
      workspace: config.workspace.root,
      command,
    });
  });

  // ---- workspace file tree ----
  router.get('/api/fs/suggest', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const q = url.searchParams.get('q') || '';
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
    try {
      sendJSON(res, { query: q, hits: suggestPaths(config.workspace.root, q, limit) });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  
  router.get('/api/fs/outline', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.searchParams.get('path') || '';
    if (!p.trim()) throw new HttpError(400, 'path required');
    try {
      const result = outlinePath(config.workspace.root, p);
      sendJSON(res, { path: p, symbols: result.symbols, engine: result.engine });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  router.get('/api/fs/symbols', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const q = url.searchParams.get('q') || '';
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 30)));
    try {
      sendJSON(res, { query: q, symbols: suggestSymbols(config.workspace.root, q, limit) });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

router.get('/api/fs/tree', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const rel = url.searchParams.get('path') || '.';
    const depth = Math.min(4, Math.max(0, Number(url.searchParams.get('depth') || 2)));
    try {
      sendJSON(res, { root: config.workspace.root, tree: listTree(config.workspace.root, rel, depth) });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  router.get('/api/fs/read', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const rel = url.searchParams.get('path') || '';
    if (!rel) throw new HttpError(400, 'Missing path');
    try {
      sendJSON(res, readWorkspaceFile(config.workspace.root, rel));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  // ── app background (image / video) ──
  //
  // DELIBERATELY app-global, not per-workspace: the wallpaper is a user
  // preference like the theme. Storing it under the workspace made it vanish
  // every time the user switched project.
  const BG_DIR = (): string => join(appDir(), 'background');
  /** Local install — effectively no artificial ceiling; 1GB guards the heap. */
  const BG_MAX_BYTES = 1024 * 1024 * 1024;

  function readBackgroundMeta(): { url: string | null; kind: 'image' | 'video' | null; filename: string | null; updatedAt: string | null } {
    const dir = BG_DIR();
    try {
      const metaPath = join(dir, 'meta.json');
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f !== 'meta.json') : [];
      const file = files[0];
      if (!file) return { url: null, kind: null, filename: null, updatedAt: null };

      // The meta file is advisory; the presence of the binary is the truth.
      let updatedAt: string | null = null;
      try {
        if (existsSync(metaPath)) {
          const m = JSON.parse(readFileSync(metaPath, 'utf8')) as { updatedAt?: string };
          updatedAt = m.updatedAt ?? null;
        }
      } catch { /* ignore */ }

      if (!updatedAt) {
        try { updatedAt = statSync(join(dir, file)).mtime.toISOString(); } catch { /* ignore */ }
      }

      const kind = /\.(mp4|webm|mov|m4v|ogv)$/i.test(file) ? 'video' : 'image';
      return {
        url: `/api/background/file?v=${encodeURIComponent(updatedAt || file)}`,
        kind,
        filename: file,
        updatedAt,
      };
    } catch {
      return { url: null, kind: null, filename: null, updatedAt: null };
    }
  }

  router.get('/api/background', (_req, res) => {
    sendJSON(res, readBackgroundMeta());
  });

  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * User stylesheet.
   *
   * The UI is token-driven, so this is the supported way to restyle it without forking.
   * See `theme.ts` for why the validation exists and what it refuses.
   *
   * The escape hatches are the important part of this block. A stylesheet can hide the
   * interface, so disabling one must not require the interface:
   *
   *   POST /api/theme/disable     works from curl or a bookmarklet
   *   GET  /            ?theme=off   works from the address bar
   *
   * Both are outside CSS's reach, which is the only property that makes them useful in the
   * situation they exist for.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  router.get('/api/theme', (_req, res) => {
    const theme = loadTheme(appDir());
    sendJSON(res, {
      enabled: theme.enabled,
      css: theme.css,
      path: theme.css ? themePaths(appDir()).css : null,
      bytes: themeBytes(appDir()),
      maxBytes: THEME_MAX_BYTES,
      updatedAt: theme.updatedAt,
      validation: validateCss(theme.css),
    });
  });

  router.put('/api/theme', async (req, res) => {
    const body = await parseBody<{ css?: string; enabled?: boolean }>(req);
    if (body.css !== undefined && typeof body.css !== 'string') {
      throw new HttpError(400, 'css 必须是字符串');
    }
    const css = body.css ?? loadTheme(appDir()).css;

    const validation = validateCss(css);
    /*
     * Errors block the save unless forced.
     *
     * Reported as a 400 with the issues included, so the editor can show them inline. The
     * `force` escape exists because validation cannot tell a deliberate choice from a
     * mistake — refusing outright would make the feature unusable for anyone whose styling
     * is unusual.
     */
    const url = new URL(req.url || '/', 'http://x');
    const force = url.searchParams.get('force') === '1';
    if (!validation.ok && !force) {
      sendJSON(res, {
        ok: false,
        saved: false,
        issues: validation.issues,
        stats: validation.stats,
        hint: '修正问题后重试，或用 ?force=1 强制保存（你确定这是你要的）。',
      }, 400);
      return;
    }

    const saved = (() => {
      /*
       * A write failure must reach the user with its reason attached.
       *
       * `saveTheme` throws a described message (which file, what went wrong, what to do). Letting
       * it fall through to the generic handler would replace all of that with
       * `{"error":"Internal Server Error"}`, and "the save failed" without a cause is not
       * something the user can act on — least of all when the cause is a read-only file sitting
       * in their config directory.
       */
      try {
        return saveTheme(appDir(), css, body.enabled !== undefined ? { enabled: body.enabled } : undefined);
      } catch (err) {
        throw new HttpError(500, (err as Error)?.message ?? '样式保存失败');
      }
    })();
    log.info(`用户样式已保存（${validation.stats.bytes} 字节，${validation.stats.rules} 条规则${force && !validation.ok ? '，强制' : ''}）`);
    sendJSON(res, {
      ok: true,
      saved: true,
      enabled: saved.enabled,
      updatedAt: saved.updatedAt,
      issues: validation.issues,
      stats: validation.stats,
      forced: force && !validation.ok,
    });
  });

  /**
   * Validate a draft without saving it.
   *
   * Reuses the server's validator rather than duplicating it in the browser: two
   * implementations would drift, and the one that refuses a save is the one that has to be
   * right. This runs on every keystroke (debounced), so it must stay cheap — it is pure
   * string analysis, no model call.
   */
  router.post('/api/theme/validate', async (req, res) => {
    const body = await parseBody<{ css?: string }>(req);
    /*
     * Same contract as the PUT above: a `css` that is present but not a string is a
     * malformed request. Coercing it to `''` would answer "no problems" to a client that
     * sent garbage, which reads as a pass.
     */
    if (body.css !== undefined && typeof body.css !== 'string') {
      throw new HttpError(400, 'css 必须是字符串');
    }
    const validation = validateCss(body.css ?? '');
    sendJSON(res, { ok: validation.ok, issues: validation.issues, stats: validation.stats });
  });

  router.delete('/api/theme', (_req, res) => {
    clearTheme(appDir());
    sendJSON(res, { ok: true, css: '', enabled: true });
  });

  /** Disable without deleting. The escape hatch that works when the UI is invisible. */
  router.post('/api/theme/disable', (_req, res) => {
    const state = setThemeEnabled(appDir(), false);
    log.warn('用户样式已停用（逃生通道）；样式文件保留，可随时重新启用。');
    sendJSON(res, { ok: true, ...state });
  });

  router.post('/api/theme/enable', (_req, res) => {
    const state = setThemeEnabled(appDir(), true);
    sendJSON(res, { ok: true, ...state });
  });

  /** Restore the version from before the last save. */
  router.post('/api/theme/revert', (_req, res) => {
    const r = revertTheme(appDir());
    if (!r.ok) throw new HttpError(400, r.reason ?? '无法恢复');
    sendJSON(res, { ok: true, css: r.css ?? '', validation: validateCss(r.css ?? '') });
  });

  router.post('/api/background', async (req, res) => {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength && contentLength > BG_MAX_BYTES) {
      throw new HttpError(413, `背景文件过大（上限 ${Math.round(BG_MAX_BYTES / 1024 / 1024)}MB）`);
    }

    const contentType = String(req.headers['content-type'] || '');

    let buf: Buffer;
    let rawName: string;

    if (contentType.startsWith('data:') || contentType.includes('application/json')) {
      // Legacy base64 JSON path.
      const body = await parseBody<{ dataUrl?: string; filename?: string }>(req);
      const dataUrl = String(body.dataUrl || '');
      const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
      if (!m) throw new HttpError(400, 'Expected a base64 data URL in dataUrl');
      buf = Buffer.from(m[2], 'base64');
      rawName = String(body.filename || 'background');
    } else {
      // Raw binary upload — no base64 overhead, so large videos are practical.
      const { buffer, tooLarge } = await readRawBody(req, BG_MAX_BYTES);
      if (tooLarge) throw new HttpError(413, `背景文件过大（上限 ${Math.round(BG_MAX_BYTES / 1024 / 1024)}MB）`);
      buf = buffer;
      const header = req.headers['x-filename'];
      rawName = decodeURIComponent(String(Array.isArray(header) ? header[0] : header || 'background'));
    }

    if (buf.length === 0) throw new HttpError(400, 'Empty file');
    if (buf.length > BG_MAX_BYTES) throw new HttpError(413, `背景文件过大（上限 ${Math.round(BG_MAX_BYTES / 1024 / 1024)}MB）`);

    const safe = rawName.replace(/\\/g, '/').split('/').pop() || 'background';
    const extMatch = safe.match(/\.(jpe?g|png|gif|webp|avif|bmp|mp4|webm|mov|m4v|ogv)$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : '.png';
    const safeName = `background${ext}`;

    const dir = BG_DIR();
    mkdirSync(dir, { recursive: true });
    // Only one background at a time.
    for (const f of readdirSync(dir)) {
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
    }
    writeFileSync(join(dir, safeName), buf);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ filename: safeName, updatedAt: new Date().toISOString() }, null, 2));

    sendJSON(res, readBackgroundMeta(), 201);
  });

  const serveBackgroundFile: Parameters<typeof router.get>[1] = (req, res) => {
    const dir = BG_DIR();
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f !== 'meta.json') : [];
    if (!files.length) throw new HttpError(404, 'No background set');
    const abs = join(dir, files[0]);
    if (!existsSync(abs)) throw new HttpError(404, 'Background file missing');

    const ext = extname(abs).toLowerCase();
    const stat = statSync(abs);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Videos are routinely hundreds of MB, so:
    //  - stream instead of readFileSync (no full copy in memory per request),
    //  - honour Range requests, which browsers REQUIRE to play/seek video,
    //  - allow caching so the file is fetched once, not on every page load.
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
      ...corsHeaders(),
    };

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        const size = stat.size;
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : size - 1;
        // Suffix form ("bytes=-500") means the last N bytes.
        if (!m[1] && m[2]) {
          start = Math.max(0, size - Number(m[2]));
          end = size - 1;
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        end = Math.min(end, size - 1);
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': end - start + 1,
        });
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = createReadStream(abs, { start, end });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(abs);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };

  // Registered for HEAD as well: clients frequently probe with HEAD before a
  // ranged GET, and a 404 there makes them give up on the file entirely.
  router.get('/api/background/file', serveBackgroundFile);
  router.addRoute('HEAD', '/api/background/file', serveBackgroundFile);

  router.delete('/api/background', (_req, res) => {
    const dir = BG_DIR();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      }
    }
    sendJSON(res, { ok: true });
  });

  // ── import discovery: find Cursor / Claude Code / Codex records on disk ──
  
  /** Current knowledge-base binding for this workspace (local / shared / env). */
  router.get('/api/kb/link', (_req, res) => {
    const resolved = resolveWorkspaceKbPath(config.workspace.root);
    sendJSON(res, {
      ok: true,
      workspaceRoot: config.workspace.root,
      dbPath: config.kb.dbPath,
      mode: resolved.mode,
      link: resolved.link,
    });
  });

  /**
   * Bind this workspace to a shared sqlite path (or clear to local default).
   * Body: { dbPath?: string | null } ? empty/null restores <workspace>/.she/kb.sqlite
   */
  router.put('/api/kb/link', async (req, res) => {
    const body = await parseBody<{ dbPath?: string | null }>(req);
    const prev = config.kb.dbPath;
    const raw = typeof body.dbPath === 'string' ? body.dbPath.trim() : '';
    if (!raw) {
      clearKbLink(config.workspace.root);
      if (process.env.SHE_KB_PATH) delete process.env.SHE_KB_PATH;
      config.kb.dbPath = resolve(config.workspace.root, '.she', 'kb.sqlite');
    } else {
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(config.workspace.root, raw);
      writeKbLink(config.workspace.root, abs, 'bound via /api/kb/link');
      if (process.env.SHE_KB_PATH) delete process.env.SHE_KB_PATH;
      config.kb.dbPath = abs;
    }
    if (resolve(prev) !== resolve(config.kb.dbPath)) {
      remountKnowledgeBase(config.kb.dbPath);
    }
    const resolved = resolveWorkspaceKbPath(config.workspace.root);
    sendJSON(res, { ok: true, dbPath: config.kb.dbPath, mode: resolved.mode, link: resolved.link });
  });

  /**
   * Publish the current workspace KB to a shared file and point this workspace at it.
   * Other workspaces can PUT /api/kb/link with the same path to join.
   */
  router.post('/api/kb/share', async (req, res) => {
    const body = await parseBody<{ sharedPath?: string }>(req);
    const shared = String(body.sharedPath ?? '').trim();
    if (!shared) throw new HttpError(400, 'Missing sharedPath');
    const abs = isAbsolute(shared) ? resolve(shared) : resolve(config.workspace.root, shared);
    const src = config.kb.dbPath;
    // Close before copy so Windows can read a consistent snapshot.
    try { store.close(); } catch { /* ignore */ }
    try {
      copyKbFile(src, abs);
    } catch (err) {
      remountKnowledgeBase(src);
      throw new HttpError(500, `???????: ${(err as Error).message}`);
    }
    writeKbLink(config.workspace.root, abs, 'shared copy of workspace KB');
    if (process.env.SHE_KB_PATH) delete process.env.SHE_KB_PATH;
    config.kb.dbPath = abs;
    remountKnowledgeBase(abs);
    sendJSON(res, { ok: true, dbPath: abs, mode: 'shared', from: src });
  });

  /**
   * Merge another KB sqlite into the current one (or into a new shared target).
   * Body: { sourcePath: string, targetPath?: string }
   * If targetPath is set, merge into that file and bind this workspace to it.
   */
  router.post('/api/kb/merge', async (req, res) => {
    const body = await parseBody<{ sourcePath?: string; targetPath?: string; label?: string }>(req);
    const sourcePath = String(body.sourcePath ?? '').trim();
    if (!sourcePath) throw new HttpError(400, 'Missing sourcePath');
    const src = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(config.workspace.root, sourcePath);
    const target = body.targetPath?.trim()
      ? (isAbsolute(body.targetPath.trim()) ? resolve(body.targetPath.trim()) : resolve(config.workspace.root, body.targetPath.trim()))
      : config.kb.dbPath;
    if (!existsSync(src)) throw new HttpError(404, `???????: ${src}`);

    try { store.close(); } catch { /* ignore */ }
    let result;
    try {
      result = mergeKnowledgeBases(src, target, { label: body.label });
    } catch (err) {
      remountKnowledgeBase(config.kb.dbPath);
      throw new HttpError(500, `????: ${(err as Error).message}`);
    }
    if (resolve(target) !== resolve(config.kb.dbPath)) {
      writeKbLink(config.workspace.root, target, 'merged shared KB');
      if (process.env.SHE_KB_PATH) delete process.env.SHE_KB_PATH;
      config.kb.dbPath = target;
    }
    remountKnowledgeBase(config.kb.dbPath);
    sendJSON(res, { ok: true, ...result, dbPath: config.kb.dbPath });
  });


  router.get('/api/import/discover', (_req, res) => {
    try {
      sendJSON(res, discoverConversations());
    } catch (err) {
      throw new HttpError(500, `发现失败: ${(err as Error).message}`);
    }
  });

  /**
   * Import external conversations INTO THE CURRENT CHAT as context.
   *
   * This is context migration, not knowledge-base ingestion: the user wants the
   * agent to continue from outside history in this conversation, so the records
   * are appended to the session transcript (where the model will actually see
   * them) rather than filed into the KB tree.
   *
   * Pass `destination: 'kb'` to file them into the knowledge tree instead.
   */
  router.post('/api/import/from-source', async (req, res) => {
    const body = await parseBody<{
      ids?: string[];
      session_id?: string;
      destination?: 'chat' | 'kb';
    }>(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) throw new HttpError(400, 'Missing ids');
    const importTask = taskBoard.upsert({
      kind: 'import',
      label: `导入 ${ids.length} 段对话`,
      phase: 'running',
      detail: body.destination === 'chat' ? '写入当前会话' : '写入知识库',
    });
    try {
    const all = discoverConversations().sources.flatMap((s) => s.conversations);
    const picked = all.filter((c) => ids.includes(c.id));
    if (!picked.length) throw new HttpError(404, 'No matching conversations');

    /*
     * Destination values.
     *
     * `'sessions'` migrates each conversation into a real conversation in the list.
     * `'chat'` is accepted as its legacy spelling so a UI bundle built before this change still
     * imports rather than erroring; it maps to the same behaviour, because the old meaning
     * (append a list of file paths to the current chat) is what this change exists to remove.
     */
    const destination = body.destination === 'kb' ? 'kb' : 'sessions';

    /*
     * ── conversation migration ──
     *
     * Each selected conversation becomes a real conversation in the list, with its turns parsed
     * out of the original record (Claude/Codex JSONL, or Cursor's composer headers — not a
     * markdown rendering, which dropped the speaker, the tool calls, and the thinking).
     *
     * What this replaced: the endpoint copied files into `.she/imports/` and appended ONE message to
     * the CURRENT session listing their paths, expecting the model to go and read them. That is
     * "attach as context". A user importing twenty conversations ended up with one chat, no way to
     * open any of the twenty, and nothing resembling their history.
     *
     * The original record is still copied first — the point is to preserve the primary source, not
     * to replace it with our parse of it — and the provenance is recorded on the session so "where
     * did this come from" stays answerable.
     */
    if (destination === 'sessions') {
      const workspaceRoot = config.workspace.root;
      const toImport: ImportedConversation[] = [];
      const skipped: string[] = [];
      const files: { relPath: string; title: string; source: string; copiedOriginal: boolean; bytes: number }[] = [];
      let truncatedConversations = 0;

      for (const conv of picked) {
        // Parse the original record. File sources are read as themselves; Cursor
        // is read in composer order from state.vscdb (that file is not copied).
        const loaded = loadTranscript(conv);

        // Keep the original on disk: a straight copy for file-backed sources, an extracted
        // SHE-native JSON for database-backed ones (state.vscdb cannot be shipped).
        const mat = materializeConversation(conv, workspaceRoot, loaded);

        if (!loaded?.messages.length) {
          // The record existed but held no parseable turns. Reported rather than created empty —
          // an empty conversation in the list looks like data loss.
          skipped.push(conv.title);
          continue;
        }
        const { messages, truncated } = loaded;
        if (truncated) truncatedConversations++;

        toImport.push({
          title: conv.title,
          messages,
          createdAt: conv.updatedAt,
          updatedAt: conv.updatedAt,
          importedFrom: {
            source: conv.source,
            originPath: conv.path,
            ...(mat ? { copiedTo: mat.relPath } : {}),
            importedAt: new Date().toISOString(),
            ...(truncated ? { truncated } : {}),
          },
        });

        if (mat) {
          files.push({
            relPath: mat.relPath,
            title: mat.title,
            source: mat.source,
            copiedOriginal: mat.copiedOriginal,
            bytes: mat.bytes,
          });
        }
      }

      if (!toImport.length) {
        throw new HttpError(400, '选中的对话没有可解析的回合（原件已保留在 .she/imports/）');
      }

      const created = sessions.importMany(toImport);
      taskBoard.upsert({ id: importTask.id, kind: 'import', label: importTask.label, phase: 'done' });
      sendJSON(res, {
        ok: true,
        destination: 'sessions',
        mode: 'conversation-migration',
        imported: created.length,
        skipped,
        files,
        truncatedConversations,
        sessions: created.map((s) => ({ id: s.id, title: s.title, messageCount: s.messages.length })),
      });
      return;
    }

    // ── knowledge-base filing ──
    const rootName = 'imports';
    let root = store.getAllGroups().find((g) => g.name === rootName && !g.parentGroupId);
    if (!root) root = engine.createGroup(rootName);

    let imported = 0;
    let memories = 0;
    const skipped: string[] = [];

    for (const conv of picked) {
      const loaded = loadTranscript(conv);
      if (!loaded?.messages.length) {
        skipped.push(conv.title);
        continue;
      }
      const srcName = conv.source;
      let srcGroup = store.getAllGroups().find((g) => g.name === srcName && g.parentGroupId === root!.id);
      if (!srcGroup) srcGroup = engine.createGroup(srcName, root.id);

      const day = (conv.updatedAt ?? new Date().toISOString()).slice(0, 10);
      let dayGroup = store.getAllGroups().find((g) => g.name === day && g.parentGroupId === srcGroup!.id);
      if (!dayGroup) dayGroup = engine.createGroup(day, srcGroup.id);

      loaded.messages.forEach((m, i) => {
        const body = [m.content, m.reasoning ? `思维链:\n${m.reasoning}` : ''].filter(Boolean).join('\n\n').trim();
        if (!body) return;
        // Title carries the speaker and the origin so a node stays traceable.
        engine.addMemoryMaintained(dayGroup.id, 'text', `${m.role}-${i + 1}  ·  ${conv.source}`, body);
        memories++;
      });
      imported++;
    }

    taskBoard.upsert({ id: importTask.id, kind: 'import', label: importTask.label, phase: 'done' });
    sendJSON(res, {
      ok: true,
      destination: 'kb',
      imported,
      memoriesAdded: memories,
      skipped,
      groupPath: 'imports/<source>/<date>',
    });
    } catch (err) {
      taskBoard.upsert({
        id: importTask.id,
        kind: 'import',
        label: importTask.label,
        phase: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  /**
   * Import a file OR a folder by path.
   *
   * Pasting a folder path means "absorb everything inside it". Each memory is
   * named with its source path so knowledge stays traceable.
   *
   * The path is jailed to the workspace: `resolve(root, raw)` alone is NOT a
   * containment check, because an absolute path (e.g. C:\Windows\...) replaces
   * the root entirely and would let any caller read arbitrary files.
   */
  router.post('/api/kb/import-path', async (req, res) => {
    const body = await parseBody<{ path?: string; label?: string }>(req);
    const raw = String(body.path ?? '').trim().replace(/^["']|["']$/g, '');
    if (!raw) throw new HttpError(400, 'Missing path');

    let abs: string;
    try {
      abs = jailToWorkspace(config.workspace.root, raw);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (!existsSync(abs)) throw new HttpError(404, `路径不存在: ${abs}`);

    const st = statSync(abs);
    const isDir = st.isDirectory();
    const label = String(body.label ?? '').trim() || basename(abs);

    const rootName = 'imports';
    let root = store.getAllGroups().find((g) => g.name === rootName && !g.parentGroupId);
    if (!root) root = engine.createGroup(rootName);

    const day = new Date().toISOString().slice(0, 10);
    let srcGroup = store.getAllGroups().find((g) => g.name === label && g.parentGroupId === root!.id);
    if (!srcGroup) srcGroup = engine.createGroup(label, root.id);
    let dayGroup = store.getAllGroups().find((g) => g.name === day && g.parentGroupId === srcGroup!.id);
    if (!dayGroup) dayGroup = engine.createGroup(day, srcGroup.id);

    const created: string[] = [];
    const origin = abs.replace(config.workspace.root, '').replace(/\\/g, '/') || abs;

    if (isDir) {
      // Reuse the engine's own directory ingestion, but keep provenance in titles.
      const before = store.getStats().totalMemories;
      engine.ingestDirectory(abs, dayGroup.id);
      const after = store.getStats().totalMemories;
      sendJSON(res, {
        ok: true,
        kind: 'directory',
        groupPath: `imports/${label}/${day}`,
        memoriesAdded: after - before,
        origin,
      }, 201);
      return;
    }

    // Single file: parse into chunks so a long document becomes several nodes.
    const { chunkFileContent } = await import('@she/agent-runtime');
    const text = readFileSync(abs, 'utf8');
    const chunks = chunkFileContent(abs, text);
    for (const c of chunks) {
      // Title carries the source so a node is traceable at a glance.
      const title = `${c.title}  ·  ${basename(abs)}`;
      engine.addMemoryMaintained(
        dayGroup.id,
        'text',
        title,
        `${c.body}\n\n<!-- 来源: ${origin} -->`,
      );
      created.push(title);
    }

    sendJSON(res, {
      ok: true,
      kind: 'file',
      groupPath: `imports/${label}/${day}`,
      memoriesAdded: created.length,
      origin,
      titles: created.slice(0, 10),
    }, 201);
  });

  // ── skill files: list / read / save / delete ──
  const SKILL_PROFILES = new Set(['dev', 'liberal', 'general', 'custom', '_common']);
  const skillsRoot = () => join(config.workspace.root, '.she', 'skills');

  router.get('/api/skills/files', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const rel = url.searchParams.get('path');

    // Single-file read
    if (rel) {
      const abs = resolve(config.workspace.root, rel);
      if (!isInsideDir(skillsRoot(), abs)) throw new HttpError(400, 'Invalid path');
      if (!existsSync(abs)) throw new HttpError(404, 'File not found');
      sendJSON(res, { content: readFileSync(abs, 'utf8') });
      return;
    }

    // Directory listing
    const out: { name: string; path: string; profile: string; size: number; updatedAt?: string }[] = [];
    for (const profile of SKILL_PROFILES) {
      const dir = join(skillsRoot(), profile);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        const abs = join(dir, f);
        try {
          const st = statSync(abs);
          out.push({
            name: f,
            path: `.she/skills/${profile}/${f}`,
            profile,
            size: st.size,
            updatedAt: st.mtime.toISOString(),
          });
        } catch { /* ignore */ }
      }
    }
    sendJSON(res, { files: out });
  });

  router.post('/api/skills/save', async (req, res) => {
    const body = await parseBody<{ name?: string; profile?: string; content?: string }>(req);
    const rawName = String(body.name ?? '').trim();
    const profile = String(body.profile ?? 'custom');
    if (!rawName) throw new HttpError(400, 'Missing name');
    if (!SKILL_PROFILES.has(profile)) throw new HttpError(400, 'Invalid profile');

    const safe = rawName.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-|-$/g, '') || 'skill';
    const file = safe.toLowerCase().endsWith('.md') ? safe : `${safe}.md`;
    const dir = join(skillsRoot(), profile);
    mkdirSync(dir, { recursive: true });
    const abs = resolve(dir, file);
    if (!isInsideDir(dir, abs)) throw new HttpError(400, 'Invalid path');

    const content = String(body.content ?? '');
    writeFileSync(abs, content.endsWith('\n') ? content : content + '\n', 'utf8');
    sendJSON(res, { ok: true, path: `.she/skills/${profile}/${file}` }, 201);
  });

  router.delete('/api/skills/files', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const rel = url.searchParams.get('path') || '';
    const abs = resolve(config.workspace.root, rel);
    if (!isInsideDir(skillsRoot(), abs)) throw new HttpError(400, 'Invalid path');
    if (!existsSync(abs)) throw new HttpError(404, 'File not found');
    unlinkSync(abs);
    sendJSON(res, { ok: true });
  });

  // ── Feishu remote control (long connection; no LAN port exposed) ──
  //
  // Replaces the earlier self-hosted LAN endpoint: that one put a bearer token
  // in a URL over plain HTTP and bound 0.0.0.0, which is not something to ship
  // in an open-source project. Feishu dials out from the desktop instead.
  //
  // Accepts both `SHE_FEISHU_*` (what .env.example and the docs use, and what
  // the settings UI writes) and bare `FEISHU_*` (an early build wrote these, so
  // existing files keep working).
  const feishuEnv = (...names: string[]): string => {
    for (const n of names) {
      const v = process.env[n];
      if (v && v.trim()) return v.trim();
    }
    return '';
  };

  const feishuCfg = (): FeishuConfig => ({
    appId: feishuEnv('SHE_FEISHU_APP_ID', 'FEISHU_APP_ID'),
    appSecret: feishuEnv('SHE_FEISHU_APP_SECRET', 'FEISHU_APP_SECRET'),
    allowedUsers: feishuEnv('SHE_FEISHU_ALLOWED_USERS', 'FEISHU_ALLOWED_USERS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxReplyChars: Number(feishuEnv('SHE_FEISHU_MAX_REPLY_CHARS', 'FEISHU_MAX_REPLY_CHARS')) || 4000,
  });

  let feishu: FeishuBridge | null = null;

  const feishuBridge = (): FeishuBridge => {
    if (!feishu) {
      feishu = new FeishuBridge(feishuCfg(), {
        // Mobile messages land in whichever conversation the desktop has open.
        ask: async (text: string) => {
          const a = agentFor({ headers: {}, url: '/' } as never);
          const before = a.getHistory().length;
          const reply = await a.chat(text);
          persistHistory();
          void before;
          return reply.content || '';
        },
        title: () => {
          const sid = activeAgentId ?? sessions.getActive()?.id ?? null;
          return (sid && sessions.get(sid)?.title) || 'SHE';
        },
      });
    }
    return feishu;
  };

  router.get('/api/feishu/status', (_req, res) => {
    sendJSON(res, {
      ...feishuBridge().status(),
      // Never return the secret; just whether one is set.
      configured: Boolean(feishuCfg().appId && feishuCfg().appSecret),
      hasSecret: Boolean(process.env.FEISHU_APP_SECRET),
    });
  });

  /** Save credentials (writes the canonical .env; secrets never leave the box). */
  router.put('/api/feishu/config', async (req, res) => {
    const body = await parseBody<{
      appId?: string;
      appSecret?: string;
      allowedUsers?: string;
    }>(req);

    const patch: Record<string, string> = {};
    if (typeof body.appId === 'string') patch.SHE_FEISHU_APP_ID = body.appId.trim();
    if (typeof body.appSecret === 'string' && body.appSecret.trim()) {
      patch.SHE_FEISHU_APP_SECRET = body.appSecret.trim();
    }
    if (typeof body.allowedUsers === 'string') patch.SHE_FEISHU_ALLOWED_USERS = body.allowedUsers.trim();
    updateEnvFile(ENV_PATH, patch);
    // Drop any legacy bare-named keys so a stale value cannot shadow the new one.
    for (const legacy of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ALLOWED_USERS', 'FEISHU_MAX_REPLY_CHARS']) {
      delete process.env[legacy];
    }
    for (const [k, v] of Object.entries(patch)) process.env[k] = v;

    // Apply immediately if it was already running.
    if (feishu) feishu.updateConfig(feishuCfg());
    sendJSON(res, { ok: true, ...feishuBridge().status() });
  });

  router.post('/api/feishu/start', async (req, res) => {
    const body = await parseBody<{ pairing?: boolean }>(req).catch(() => ({ pairing: false }));
    try {
      // `pairing` starts without an allowlist so the user can discover their
      // open_id (the agent stays unreachable in that mode).
      const st = await feishuBridge().start({ pairing: Boolean(body?.pairing) });
      sendJSON(res, st);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  router.post('/api/feishu/stop', async (_req, res) => {
    if (feishu) await feishu.stop();
    sendJSON(res, feishuBridge().status());
  });

  // ── plugin system (developer extension points) ──
  //
  // Plugins are installed software, not project data, so they live in the app
  // dir (same place as the wallpaper). A workspace may still override by
  // creating its own `.she/plugins`.
  //
  // The runtime (`plugins`, `appDir`, `bundledPluginsDir`) is at module scope
  // because `makeAgent` needs it to give plugin tools to every agent. This block
  // is only the HTTP surface. See plugins.ts for the security model — plugin
  // code runs in-process, so a declared permission is disclosure, not a fence.

  router.get('/api/plugins', (_req, res) => {
    // Make sure the global dir exists so there is somewhere obvious to install into.
    const globalDir = join(appDir(), 'plugins');
    if (!existsSync(globalDir)) mkdirSync(globalDir, { recursive: true });
    sendJSON(res, {
      plugins: plugins.scan(),
      dir: globalDir,
      catalogDir: bundledPluginsDir(),
      knownPermissions: KNOWN_PERMISSIONS,
    });
  });

  /** Bundled plugins offered for one-click install. */
  router.get('/api/plugins/catalog', (_req, res) => {
    sendJSON(res, { entries: plugins.catalog() });
  });

  router.post('/api/plugins/install', async (req, res) => {
    const body = await parseBody<{ name?: string; path?: string }>(req);
    try {
      const r = body.path
        ? plugins.installFromPath(body.path)
        : plugins.installFromCatalog(String(body.name ?? ''));
      // The tool list changed: reload it and rebuild live agents so an open
      // conversation picks the new tools up without a restart.
      await plugins.refresh();
      rebuildAgents();
      sendJSON(res, { ...r, plugins: plugins.scan() }, 201);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  /** Create a runnable skeleton so authoring starts from something that works. */
  router.post('/api/plugins/scaffold', async (req, res) => {
    const body = await parseBody<{ name?: string; description?: string }>(req);
    try {
      const r = plugins.scaffold(String(body.name ?? ''), String(body.description ?? ''));
      await plugins.refresh();
      rebuildAgents();
      sendJSON(res, { ...r, plugins: plugins.scan() }, 201);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  /** Read a plugin's source, for the built-in editor. */
  router.get('/api/plugins/source', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      sendJSON(res, plugins.readSource(url.searchParams.get('dir') || ''));
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  });

  router.put('/api/plugins/source', async (req, res) => {
    const body = await parseBody<{ dir?: string; file?: 'manifest.json' | 'index.mjs'; content?: string }>(req);
    const file = body.file === 'index.mjs' ? 'index.mjs' : 'manifest.json';
    try {
      plugins.writeSource(String(body.dir ?? ''), file, String(body.content ?? ''));
      await plugins.refresh();
      rebuildAgents();
      sendJSON(res, { ok: true, plugins: plugins.scan() });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  /** Enable / disable a plugin by writing `enabled` into its manifest. */
  router.put('/api/plugins/enabled', async (req, res) => {
    const body = await parseBody<{ dir?: string; enabled?: boolean }>(req);
    const updated = plugins.setEnabled(String(body.dir ?? ''), body.enabled !== false);
    if (!updated) throw new HttpError(404, 'Plugin not found');
    await plugins.refresh();
    rebuildAgents();
    sendJSON(res, { ok: true, plugins: plugins.scan() });
  });

  /** Uninstall: remove the plugin folder. */
  router.delete('/api/plugins', async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      plugins.uninstall(url.searchParams.get('dir') || '');
      await plugins.refresh();
      rebuildAgents();
      sendJSON(res, { ok: true });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  // ── MCP servers: discovery, live probe, enable/disable ──
  router.get('/api/mcp/servers', async (_req, res) => {
    const servers = await listMcpServers(config.workspace.root);
    sendJSON(res, { servers });
  });

  router.post('/api/mcp/servers/:name/probe', async (req, res, params) => {
    const status = await probeMcpServer(config.workspace.root, params.name);
    if (!status) throw new HttpError(404, `未找到 MCP 服务: ${params.name}`);
    sendJSON(res, status);
  });

  router.post('/api/mcp/servers', async (req, res) => {
    const body = await parseBody<{ name?: string; command?: string; args?: string[]; env?: Record<string, string> }>(req);
    const name = String(body.name ?? '').trim();
    const command = String(body.command ?? '').trim();
    if (!name || !command) throw new HttpError(400, 'name 与 command 必填');
    writeMcpServer(config.workspace.root, {
      name,
      command,
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      env: body.env,
    });
    sendJSON(res, { ok: true, servers: await listMcpServers(config.workspace.root) }, 201);
  });

  router.delete('/api/mcp/servers/:name', (req, res, params) => {
    const ok = removeMcpServer(config.workspace.root, params.name);
    sendJSON(res, { ok });
  });

  router.put('/api/mcp/servers/:name/enabled', async (req, res, params) => {
    const body = await parseBody<{ enabled?: boolean }>(req);
    const ok = setMcpServerEnabled(config.workspace.root, params.name, body.enabled !== false);
    sendJSON(res, { ok });
  });

  // ── shared memo (scratchpad for user + agent) ──
  const memoOf = () => new MemoStore(config.workspace.root);

  router.get('/api/memo', (_req, res) => {
    sendJSON(res, { entries: memoOf().list() });
  });

  router.post('/api/memo', async (req, res) => {
    const body = await parseBody<{ text?: string }>(req);
    const text = String(body.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Missing text');
    sendJSON(res, memoOf().add(text, 'user'), 201);
  });

  router.put('/api/memo/:id', async (req, res, params) => {
    const body = await parseBody<{ text?: string; done?: boolean }>(req);
    const entry = memoOf().update(params.id, body);
    if (!entry) throw new HttpError(404, 'Memo not found');
    sendJSON(res, entry);
  });

  router.delete('/api/memo/:id', (req, res, params) => {
    const ok = memoOf().remove(params.id);
    if (!ok) throw new HttpError(404, 'Memo not found');
    sendJSON(res, { ok: true });
  });

  // ── plugin dock: manifest of extension points ──
  // Declared here so third-party plugins have a stable contract to build on.
  /**
   * The extension-point contract, for plugin authors and the CLI.
   *
   * Rewritten to describe what the runtime ACTUALLY does. The previous version
   * advertised an `endpoint` field on tools, claimed tools were "loaded into the
   * tool loop" (they were not), and described panels as iframes (not
   * implemented) — a contract that could not be satisfied. Documenting an
   * invented API is worse than documenting none.
   */
  router.get('/api/plugins/manifest', (_req, res) => {
    sendJSON(res, {
      apiVersion: '2.0',
      installDir: join(appDir(), 'plugins'),
      catalogDir: bundledPluginsDir(),
      installed: plugins.scan(),
      knownPermissions: KNOWN_PERMISSIONS,
      extensionPoints: [
        {
          id: 'tools',
          title: '工具 / Tools',
          description:
            'Export `tools` from index.mjs. Each tool is picked up by the agent loop and '
            + 'callable by the model, exactly like a built-in tool.',
          contract: 'export const tools = [{ name, description, parameters, run(args, ctx) }]',
          status: 'implemented',
        },
        {
          id: 'commands',
          title: '命令 / Commands',
          description: 'Declare commands in the manifest so they appear in the command palette.',
          contract: '{ "commands": [{ "id": string, "title": string, "description"?: string }] }',
          status: 'declared',
        },
        {
          id: 'panels',
          title: '面板 / Panels',
          description: 'Declare a panel and ship its HTML next to the manifest.',
          contract: '{ "panels": [{ "id": string, "title": string, "entry": "panel.html" }] }',
          status: 'declared',
        },
      ],
      notes: [
        '插件装在应用目录的 plugins/ 下；工作区里的 .she/plugins 会覆盖同名插件。',
        '插件代码在服务进程内运行，因此 manifest 的 permissions 是「声明」而非「限制」——安装前请看清它声明了什么。',
        '不能与内置工具重名：重名会被拒绝，避免插件悄悄顶掉 shell / fs_write。',
        'ctx 提供受限的工作区读写（越界会被拒绝）、受限的 exec（需声明 shell），以及日志。',
        '约定：插件不得自动把弱边/时序边升级为因果边。',
        '约定：插件写入知识库必须通过 kb_upsert / kb_ingest_place 等已有工具，保持结构不变量。',
      ],
    });
  });

  // ── workspaces (home screen) ──
  const wsRegistry = () => join(stateDir, '.she', 'workspaces.json');

  function readWorkspaceRegistry(): { recent: string[] } {
    try {
      const p = wsRegistry();
      if (!existsSync(p)) return { recent: [] };
      const j = JSON.parse(readFileSync(p, 'utf8')) as { recent?: string[] };
      return { recent: Array.isArray(j.recent) ? j.recent : [] };
    } catch {
      return { recent: [] };
    }
  }

  function rememberWorkspace(root: string): void {
    const { recent } = readWorkspaceRegistry();
    const next = [root, ...recent.filter((r) => r !== root)].slice(0, 12);
    try {
      const p = wsRegistry();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ recent: next }, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  function describeWorkspace(root: string): { root: string; name: string; exists: boolean; isGit: boolean; sessionCount: number } {
    const exists = existsSync(root);
    const isGit = exists && existsSync(join(root, '.git'));
    let sessionCount = 0;
    try {
      const p = join(root, '.she', 'sessions.json');
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { sessions?: unknown[] };
        sessionCount = Array.isArray(j.sessions) ? j.sessions.length : 0;
      }
    } catch { /* ignore */ }
    return {
      root,
      name: basename(root) || root,
      exists,
      isGit,
      sessionCount,
    };
  }

  router.get('/api/workspaces', (_req, res) => {
    const current = config.workspace.root;
    const { recent } = readWorkspaceRegistry();

    // Only the current workspace and ones the user actually opened.
    // Previously we also listed every sibling folder of the install root, which
    // auto-generated a list the user never asked for. Picking is explicit now.
    const roots = [...new Set([current, ...recent])].filter((r) => existsSync(r));
    sendJSON(res, {
      current,
      workspaces: roots.map(describeWorkspace),
      recent,
      /** True when a native folder picker is available (Electron desktop). */
      canBrowse: process.env.SHE_NATIVE_PICKER === '1',
    });
  });

  router.post('/api/workspaces/switch', async (req, res) => {
    const body = await parseBody<{ root?: string; sessionId?: string }>(req);
    const raw = String(body.root ?? '').trim();
    if (!raw) throw new HttpError(400, 'Missing root');
    const root = resolve(raw);
    if (!existsSync(root)) throw new HttpError(404, `路径不存在: ${root}`);
    const prevWorkspace = config.workspace.root;
    const active = mountWorkspace(root, body.sessionId);
    rememberWorkspace(root);
    log.info(`Workspace switched: ${prevWorkspace} -> ${root}`);
    sendJSON(res, {
      ok: true,
      root: config.workspace.root,
      kbDbPath: config.kb.dbPath,
      kbMode: resolveWorkspaceKbPath(config.workspace.root).mode,
      restartRequired: false,
      activeSessionId: active.id,
    });
  });

  router.get('/api/sessions', (req, res) => {
    // `?all=1` returns closed sessions too, which the history view needs.
    // `?scope=all` also includes sessions that live in other known projects.
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const includeClosed = url.searchParams.get('all') === '1';
    if (url.searchParams.get('scope') !== 'all') {
      sendJSON(res, sessions.list(includeClosed));
      return;
    }
    const mine = sessions.list(includeClosed);
    const seen = new Set(mine.sessions.map((s) => s.id));
    const extra = [];
    for (const root of projectRoots()) {
      if (resolve(root) === resolve(sessions.rootDir)) continue;
      for (const s of storeFor(root).list(includeClosed).sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        extra.push({ ...s, directory: s.directory || root });
      }
    }
    sendJSON(res, { active_id: mine.active_id, sessions: [...mine.sessions, ...extra] });
  });

  /** Closed sessions only (history view). */
  router.get('/api/sessions/history', (_req, res) => {
    sendJSON(res, {
      closed: sessions.listClosed(),
      open: sessions.list().sessions,
    });
  });

  /** Close a session: hidden from the working list, still in history. */
  router.post('/api/sessions/:id/close', (req, res, params) => {
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    const s = found.store.close(params.id);
    if (!s) throw new HttpError(404, `Session not found: ${params.id}`);
    dropAgent(params.id);
    sendJSON(res, { ok: true, active_id: sessions.list().active_id });
  });

  /** Bring a closed session back. */
  router.post('/api/sessions/:id/reopen', (req, res, params) => {
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    const s = found.store.reopen(params.id);
    if (!s) throw new HttpError(404, `Session not found: ${params.id}`);
    activeAgentId = s.id;
    if (!agents.get(s.id)) {
      const a = makeAgent(config, s.id);
      if (s.messages?.length) a.setHistory(s.messages);
      agents.set(s.id, a);
    }
    sendJSON(res, s);
  });

  router.post('/api/sessions', async (req, res) => {
    const body = await parseBody<{ title?: string; directory?: string; parent_id?: string }>(req);
    persistHistory();
    const directory = resolve(body.directory?.trim() || config.workspace.root);
    if (!existsSync(directory)) throw new HttpError(404, `路径不存在: ${directory}`);
    const owner = storeFor(directory);
    const s = owner.create(body.title, { directory, parentId: body.parent_id });
    try { rememberProject(projectIndexFile(), directory); } catch { /* non-fatal */ }
    if (resolve(directory) === resolve(config.workspace.root)) {
      activeAgentId = s.id;
      agents.set(s.id, makeAgent(config, s.id));
    }
    sendJSON(res, s, 201);
  });

  router.get('/api/sessions/:id', (_req, res, params) => {
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    sendJSON(res, found.session);
  });

  router.put('/api/sessions/:id', async (req, res, params) => {
    const body = await parseBody<{ title?: string; messages?: import('@she/shared').LLMMessage[] }>(req);
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    const s = found.store.update(params.id, body);
    if (Array.isArray(body.messages)) {
      const live = agents.get(s.id);
      if (live?.isRunning()) {
        // The turn is writing this transcript. Replacing it from disk would drop the live tail.
      } else if (live) {
        live.setHistory(s.messages);
      } else {
        dropAgent(s.id);
      }
    }
    sendJSON(res, s);
  });

  router.delete('/api/sessions/:id', (_req, res, params) => {
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    if (agents.get(params.id)?.isRunning()) {
      throw new HttpError(409, '这一轮还在进行。先停下，再删除会话。');
    }
    const wasActive = found.store.list().active_id === params.id;
    found.store.remove(params.id);
    dropAgent(params.id);
    if (wasActive && found.store === sessions) {
      const next = sessions.getActive();
      if (next) {
        activeAgentId = next.id;
        const a = agentFor({ headers: {}, url: '/' } as never, { session_id: next.id });
        if (!a.isRunning()) a.setHistory(next.messages ?? []);
      }
    }
    sendJSON(res, { ok: true, active_id: sessions.list().active_id });
  });

  router.get('/api/sessions/:id/export', (_req, res, params) => {
    const s = findSession(params.id)?.session;
    if (!s) throw new HttpError(404, `Session not found: ${params.id}`);
    const lines: string[] = [`# ${s.title}`, '', `session: ${s.id}`, `updated: ${s.updated_at}`, ''];
    for (const m of s.messages || []) {
      const role = (m.role || 'unknown').toUpperCase();
      lines.push(`## ${role}`, '', String(m.content || ''), '');
    }
    const body = lines.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="she-session-${params.id}.md"`,
      ...corsHeaders(),
    });
    res.end(body);
  });

  /**
   * Export a work group's transcript.
   *
   * Groups appear in the same session rail as chats, and the rail's export
   * button passed the room id to `/api/sessions/:id/export` — which 404'd,
   * because a room id is not a session id. A button that always fails is worse
   * than no button, so the group gets a real export of its own.
   */
  router.get('/api/cluster/rooms/:id/export', (_req, res, params) => {
    const room = cluster.get(params.id);
    if (!room) throw new HttpError(404, `Room not found: ${params.id}`);
    const lines: string[] = [
      `# ${room.title || '工作群'}`,
      '',
      `room: ${room.id}`,
      room.workspace ? `workspace: ${room.workspace}` : '',
      `created: ${room.created_at}`,
      `updated: ${room.updated_at}`,
      '',
    ].filter((l) => l !== '');
    if (room.members?.length) {
      lines.push('## 成员', '');
      for (const m of room.members) {
        // `title` is the human label (领导/研发); `roleKey` is the machine key.
        const label = m.title || m.roleKey || '';
        lines.push(`- ${m.name}${label ? ` (${label})` : ''}`);
      }
      lines.push('');
    }
    for (const m of room.messages || []) {
      // Speaker name matters here: a group transcript is unreadable without it.
      const who = m.name ? `${m.name}` : (m.role || 'unknown');
      lines.push(`## ${who}`, '', String(m.content || ''), '');
    }
    const body = lines.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="she-group-${params.id}.md"`,
      ...corsHeaders(),
    });
    res.end(body);
  });

  router.post('/api/sessions/:id/activate', (_req, res, params) => {
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    const dir = resolve(found.session.directory || found.store.rootDir);
    if (dir !== resolve(config.workspace.root)) {
      const active = mountWorkspace(dir, params.id);
      sendJSON(res, active);
      return;
    }
    persistHistory();
    const s = sessions.setActive(params.id);
    if (!s) throw new HttpError(404, `Session not found: ${params.id}`);
    activeAgentId = s.id;
    const a = agentFor({ headers: {}, url: '/' } as never, { session_id: s.id });
    if (!a.isRunning()) a.setHistory(s.messages);
    sendJSON(res, s);
  });

  router.get('/api/sessions/:id/children', (_req, res, params) => {
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    const children = found.store.childrenOf(params.id).map((s) => ({
      id: s.id,
      title: s.title,
      directory: s.directory,
      background: s.background,
      updated_at: s.updated_at,
    }));
    sendJSON(res, { children });
  });

  /** Stop waiting on this session's children. They keep running. */
  router.post('/api/sessions/:id/detach', (_req, res, params) => {
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    detachParents.add(params.id);
    setTimeout(() => detachParents.delete(params.id), 2000).unref?.();
    const children = found.store.childrenOf(params.id);
    for (const child of children) found.store.markBackground(child.id);
    sendJSON(res, { ok: true, children: children.map((c) => c.id) });
  });

  router.post('/api/sessions/:id/move', async (req, res, params) => {
    const body = await parseBody<{ directory?: string; move_changes?: boolean }>(req);
    const dest = resolve(String(body.directory ?? '').trim());
    if (!dest || !existsSync(dest)) throw new HttpError(404, '目标目录不存在');
    const found = findSession(params.id);
    if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
    if (agents.get(params.id)?.isRunning()) {
      throw new HttpError(409, '这一轮还在进行。先停下，再把会话搬到别的项目。');
    }
    const from = resolve(found.session.directory || found.store.rootDir);
    let note = '';
    if (body.move_changes && from !== dest) note = transferLocalChanges(from, dest);
    const taken = found.store.extract(params.id);
    if (!taken) throw new HttpError(404, `Session not found: ${params.id}`);
    taken.directory = dest;
    const saved = storeFor(dest).adopt(taken);
    dropAgent(params.id);
    try { rememberProject(projectIndexFile(), dest); } catch { /* non-fatal */ }
    sendJSON(res, { session: saved, note });
  });

  router.get('/api/worktrees', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const repo = resolve(url.searchParams.get('repo') || config.workspace.root);
    try {
      sendJSON(res, { repo, worktrees: listWorktrees(repo) });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  router.post('/api/worktrees', async (req, res) => {
    const body = await parseBody<{ name?: string; repo?: string }>(req);
    const repo = resolve(body.repo?.trim() || config.workspace.root);
    try {
      const info = addWorktree(repo, body.name?.trim() || `w${Date.now().toString(36)}`);
      const session = storeFor(info.path).create(body.name?.trim() || basename(info.path), { directory: info.path });
      try {
        rememberProject(projectIndexFile(), repo);
        rememberProject(projectIndexFile(), info.path);
      } catch { /* non-fatal */ }
      sendJSON(res, { worktree: info, session }, 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  router.post('/api/worktrees/reset', async (req, res) => {
    const body = await parseBody<{ path?: string; repo?: string }>(req);
    const repo = resolve(body.repo?.trim() || config.workspace.root);
    const path = resolve(String(body.path ?? '').trim());
    if (!path) throw new HttpError(400, '缺少 path');
    try {
      resetWorktree(repo, path);
      sendJSON(res, { ok: true, path });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  router.delete('/api/worktrees', async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const repo = resolve(url.searchParams.get('repo') || config.workspace.root);
    const path = resolve(url.searchParams.get('path') || '');
    if (!path) throw new HttpError(400, '缺少 path');
    try {
      removeWorktree(repo, path);
      sendJSON(res, { ok: true });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  router.get('/api/kb/groups', (_req, res) => {
    sendJSON(res, { groups: store.getAllGroups() });
  });

  // ── long-horizon plans (written by the agent's plan_* tools) ──
  // Plans belong to a conversation, so the client passes session_id.
  const planStoreFor = (req: import('node:http').IncomingMessage, body?: { session_id?: string }) =>
    new PlanStore(config.workspace.root, sessionIdOf(req, body) || null);

  
  // ---- background / subagent task cards ----
  router.get('/api/tasks', (_req, res) => {
    sendJSON(res, { tasks: taskBoard.list() });
  });

  router.delete('/api/tasks/:id', (_req, res, params) => {
    const ok = taskBoard.dismiss(params.id);
    if (!ok) throw new HttpError(404, 'Task not found');
    sendJSON(res, { ok: true });
  });

    router.post('/api/tasks/clear-finished', (_req, res) => {
      sendJSON(res, { ok: true, cleared: taskBoard.clearFinished() });
    });

    /*
     * Mark every still-running task as failed.
     *
     * `TaskBoard.markStaleRunning()` existed and `TaskCards.tsx` called this endpoint, but no route
     * exposed it — so the call 404'd and, being wrapped in `.catch(() => undefined)`, failed
     * silently. The effect: the UI marked its own cards as failed when the connection dropped, the
     * SERVER kept them `running` forever, and the next `GET /api/tasks` (or a reload) showed
     * "进行中…" again for work that had already died. Half-wired features are the hardest kind to
     * notice, because both halves look correct in isolation.
     */
    router.post('/api/tasks/mark-stale', async (req, res) => {
      // The body is advisory: a missing or malformed one must still mark the tasks stale.
      let reason: string | undefined;
      try {
        const body = await parseBody<{ reason?: string }>(req);
        if (typeof body?.reason === 'string' && body.reason.trim()) reason = body.reason.trim();
      } catch { /* fall back to the default reason in the store */ }
      sendJSON(res, { ok: true, marked: taskBoard.markStaleRunning(reason) });
    });

  router.get('/api/plans', (req, res) => {
    const store = planStoreFor(req);
    /*
     * The resume point is computed here, from `nextStepOf`, rather than in the panel.
     *
     * The panel drawing its own version of "what is next" is the same class of bug as two copies
     * of a cache key: the tool output the agent reads and the line the user reads would disagree,
     * and the user would be looking at a plan the agent is not following.
     */
    sendJSON(res, {
      plans: store.list().map((p) => {
        const next = nextStepOf(p);
        return { ...p, next: next ? { stepId: next.step.id, title: next.step.title, why: next.why } : null };
      }),
    });
  });

  router.post('/api/plans/step', async (req, res) => {
    const body = await parseBody<{
      plan_id?: string;
      step_id?: string;
      status?: string;
      note?: string;
      session_id?: string;
    }>(req);
    const planId = String(body.plan_id ?? '');
    const stepId = String(body.step_id ?? '');
    const status = String(body.status ?? '');
    if (!planId || !stepId) throw new HttpError(400, 'plan_id and step_id are required');
    if (!['pending', 'active', 'done', 'blocked', 'dropped'].includes(status)) {
      throw new HttpError(400, 'invalid status');
    }
    const result = planStoreFor(req, body).setStepStatus(planId, stepId, status as StepStatus, body.note);
    if (!result.ok) {
      /*
       * A refused transition is not a 404. The plan and the step exist; the plan's own rule is
       * what says no (a prerequisite that is still pending), and the reason is the useful part —
       * the panel shows it verbatim.
       */
      throw new HttpError(/not found/i.test(result.reason) ? 404 : 409, result.reason);
    }
    sendJSON(res, result.plan);
  });

  // The agent's ask_user tool surfaces a question here.
  /*
   * The audit trail.
   *
   * Read-only by design: there is no endpoint that writes, edits or clears a record, because a
   * trail a client can modify answers a different question than the one it is kept for. `total`
   * counts what is on disk rather than what was returned, so a truncated response is visible.
   */
  router.get('/api/audit', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limitRaw = Number(url.searchParams.get('limit'));
    const kind = url.searchParams.get('kind');
    const sessionId = url.searchParams.get('session_id');
    /*
     * Validated against the union rather than a hand-written list.
     *
     * The list used to be literal, and it silently fell out of date: `guardrail` was added as an
     * audit kind, was written correctly, and could not be read back through this route — it returned
     * 400 for a kind the server itself produces. Filtering by a kind that the trail contains is not
     * an invalid request, and a hand-maintained copy of a union is a promise to keep two lists in
     * sync that nothing enforces. `AUDIT_KINDS` is the one place, so adding a kind cannot half-land.
     */
    if (kind && !(AUDIT_KINDS as readonly string[]).includes(kind)) {
      throw new HttpError(400, `invalid kind: ${kind}`);
    }
    const log = auditLog();
    const result = log.read({
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200,
      kind: (kind as AuditKind | null) ?? undefined,
      sessionId: sessionId ?? undefined,
    });
    sendJSON(res, {
      root: auditRoot,
      files: result.files,
      // Unparseable lines are reported rather than skipped quietly: a damaged trail must not look
      // like a quiet day.
      skipped_lines: result.skipped,
      records: result.records,
    });
  });

  /**
   * The run traces.
   *
   * Read-only, like the audit route above and for the same reason: a trace a client can rewrite
   * is not evidence. Three routes, splitting along what each question needs:
   *
   *   - the LIST answers "what has this workspace done" — summaries only, no events, because the
   *     panel shows dozens of them and shipping every event would be the whole directory;
   *   - one run answers "what exactly happened in this turn" — every event, in order;
   *   - corroborate answers "is this delivery's evidence real", which is the only one that reads
   *     the runs for their CONTENT rather than for display.
   */
  router.get('/api/runs', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('session_id');
    const limitRaw = Number(url.searchParams.get('limit'));
    const all = runTraceStore().list({
      sessionId: sessionId ?? undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100,
    });
    /*
     * Counts of the whole workspace travel with the list, not just of the filtered page.
     *
     * The panel says "这 20 条里 3 条失败" and needs to know whether that is all of them. Computing
     * it here from `all` for the current filter, plus an unfiltered total, keeps the panel from
     * having to make a second request to find out what it is not showing.
     */
    sendJSON(res, {
      root: runTraceStore().directory(),
      runs: all,
      total: all.length,
      paused: all.filter((r) => r.state === 'paused').length,
      failed: all.filter((r) => r.state === 'failed').length,
    });
  });

  /*
   * Registered BEFORE `/api/runs/:id`.
   *
   * The router matches in registration order, so with the parameterised route first,
   * `GET /api/runs/corroborate` would be read as a request for a run whose id is "corroborate" —
   * a 404 about a missing file, which hides the real endpoint behind a confusing error.
   */
  router.get('/api/runs/corroborate', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('session_id');
    const evidence = url.searchParams.get('evidence') ?? '';
    if (!evidence.trim()) throw new HttpError(400, 'evidence is required');
    sendJSON(res, runTraceStore().corroborate(sessionId, evidence));
  });

  router.get('/api/runs/:id', (_req, res, params) => {
    const result = runTraceStore().read(params.id);
    if (!result) throw new HttpError(404, `Run not found: ${params.id}`);
    sendJSON(res, result);
  });

  /**
   * Self-review state: drift, calibration, the critic's reading, and what was written to the book.

   *
   * Two sources on purpose:
   *
   *   - a live agent's in-memory reports, which are this session's actual last turn;
   *   - the mirror ON DISK, which is what makes the route useful before any turn has run in this
   *     process. Calibration is a habit across sessions, so reading it only from a live agent would
   *     report "nothing yet" on every restart — the exact moment the history matters most.
   */
  router.get('/api/reflection', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('session_id') ?? sessions.getActive()?.id ?? null;
    const agent = sessionId ? agents.get(sessionId) : undefined;
    const windowRaw = Number(url.searchParams.get('window'));
    const report = reflectionMirror().report(
      Number.isFinite(windowRaw) && windowRaw > 0 ? { window: windowRaw } : {},
    );
    sendJSON(res, {
      root: join(resolve(config.workspace.root), REFLECTION_DIR),
      confidence: report,
      samples: reflectionMirror().samples().slice(-50),
      last: agent?.getReflection() ?? null,
      critic: agent?.getCriticReview() ?? null,
    });
  });

  /**
   * Forget the calibration history.
   *
   * A write, and the only one in this family — the mirror is a measurement of the agent, not
   * evidence about the user's work, so a reset does not erase anything the user would want to
   * consult later. It exists because a miscalibrated history that was CORRECTED should not keep
   * being reported, and because a workspace whose confidence file got polluted by an experiment
   * needs a way back.
   */
  router.post('/api/reflection/confidence/reset', (_req, res) => {
    reflectionMirror().clear();
    // Recorded in the audit trail: forgetting a measurement changes what the agent will be told
    // about itself from now on, and that is a change to its behaviour rather than a display setting.
    auditSafe({ kind: 'config', change: 'reset_confidence_mirror', note: '重置置信度镜像历史' });
    sendJSON(res, { ok: true });
  });

  /**
   * The outbound guardrail: the policy in force, the last turn's findings, and the running history.
   *
   * Read-only, and it exists for one question: "did anything this workspace produced contain
   * something it should not have?" The per-turn warning covers the moment; this covers the
   * afterwards, which is when a leak is usually discovered. Findings carry a MASKED preview only —
   * an endpoint that returned the credential to audit the credential would be the leak it exists to
   * report.
   */
  router.get('/api/guardrail', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('session_id') ?? sessions.getActive()?.id ?? null;
    const agent = sessionId ? agents.get(sessionId) : undefined;
    const last = agent?.getGuardrailReport() ?? null;
    const history = agent?.getGuardrailHistory() ?? [];
    sendJSON(res, {
      policy: guardrailPolicy(),
      session_id: sessionId,
      last,
      history: history.map((f) => ({ kind: f.kind, severity: f.severity, label: f.label, preview: f.preview })),
      summary: summariseFindings(last?.findings ?? []),
      counts: { last: last?.findings.length ?? 0, history: history.length },
    });
  });

  router.get('/api/ask/pending', (_req, res) => {
    const p = pendingQuestionPath();
    if (!existsSync(p)) {
      sendJSON(res, { question: null });
      return;
    }
    try {
      sendJSON(res, JSON.parse(readFileSync(p, 'utf8')));
    } catch {
      sendJSON(res, { question: null });
    }
  });

  /** Dismiss the current question without answering it. */
  router.delete('/api/ask/pending', (_req, res) => {
    clearPendingQuestion();
    sendJSON(res, { ok: true });
  });

  router.get('/api/kb/groups/:id', (_req, res, params) => {
    const group = store.getGroup(params.id);
    if (!group) throw new HttpError(404, `Group not found: ${params.id}`);
    const children = group.childGroupIds
      .map(id => store.getGroup(id))
      .filter(Boolean);
    const memories = store.getMemoriesByGroup(params.id);
    sendJSON(res, { group, children, memories });
  });

  router.post('/api/kb/groups', async (req, res) => {
    const body = await parseBody<{ name: string; parentId?: string }>(req);
    if (!body.name) throw new HttpError(400, 'Missing required field: name');
    const group = engine.createGroup(body.name, body.parentId);
    sendJSON(res, group, 201);
  });

  router.post('/api/kb/query', async (req, res) => {
    const body = await parseBody<{ query: string; budget?: number }>(req);
    if (!body.query) throw new HttpError(400, 'Missing required field: query');
    const result = engine.query(body.query, { budget: body.budget });
    sendJSON(res, result);
  });

  router.post('/api/kb/ingest', async (req, res) => {
    const body = await parseBody<{ path: string }>(req);
    if (!body.path) throw new HttpError(400, 'Missing required field: path');

    /*
     * Jailed, like every other path-taking route.
     *
     * This one resolved `body.path` against the workspace root with no containment check, so
     * `{"path":"C:/Users/…/.env"}` — or any absolute path the server process can read — was read
     * and filed into the knowledge base. The ingested text is then reachable through `kb_query`, so
     * it was a general host-file read primitive, and the agent's own `kb_ingest_scan` tool fed it.
     * A sibling route (`/api/kb/import-path`) had always jailed correctly; this one was simply
     * missed.
     */
    let absPath: string;
    try {
      absPath = jailToWorkspace(config.workspace.root, String(body.path).trim().replace(/^["']|["']$/g, ''));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (!existsSync(absPath)) throw new HttpError(404, `Path not found: ${body.path}`);

    // Report what THIS call added, not the running totals — the old numbers were cumulative, so a
    // call that ingested one file claimed it had added everything in the library.
    const before = store.getStats();
    const isDir = statSync(absPath).isDirectory();
    if (isDir) {
      engine.ingestDirectory(absPath);
    } else {
      engine.ingestFile(absPath);
    }
    const after = store.getStats();
    sendJSON(res, {
      groupsCreated: Math.max(0, after.totalGroups - before.totalGroups),
      memoriesAdded: Math.max(0, after.totalMemories - before.totalMemories),
      totals: { groups: after.totalGroups, memories: after.totalMemories },
    });
  });

  router.get('/api/kb/stats', (_req, res) => {
    const stats = store.getStats();
    const allGroups = store.getAllGroups();
    const allMems = allGroups.flatMap(g =>
      g.memoryIds.map(id => store.getMemory(id)).filter(Boolean)
    );
    const dormantCount = allMems.filter(m => m!.isDormant).length;
    sendJSON(res, {
      ...stats,
      dormancyRatio: allMems.length > 0 ? dormantCount / allMems.length : 0,
    });
  });

  router.get('/api/kb/tree', (_req, res) => {
    sendJSON(res, { tree: buildGroupTree() });
  });

  router.post('/api/kb/memories', async (req, res) => {
    const body = await parseBody<{ groupId: string; kind: string; title: string; content: string }>(req);
    if (!body.groupId || !body.title || !body.content) {
      throw new HttpError(400, 'Missing required fields');
    }
    const validKinds = ['text', 'code', 'fact', 'tool_outcome', 'preference'] as const;
    const kind = validKinds.includes(body.kind as any) ? body.kind as any : 'text';
    const mem = engine.addMemory(body.groupId, kind, body.title, body.content);
    sendJSON(res, mem, 201);
  });

  router.post('/api/kb/edges', async (req, res) => {
    const body = await parseBody<{ sourceId: string; targetId: string; kind: EdgeKind; evidence?: string; falsifiers?: string[] }>(req);
    if (!body.sourceId || !body.targetId || !body.kind) {
      throw new HttpError(400, 'Missing required fields');
    }
    const edge = engine.addTypedEdge(body.sourceId, body.targetId, body.kind, {
      evidence: body.evidence,
      falsifiers: body.falsifiers,
    });
    sendJSON(res, edge, 201);
  });

  router.get('/api/usage', (req, res) => {
    sendJSON(res, agentFor(req, undefined, { createIfMissing: false }).getTokenUsage());
  });

  router.post('/api/usage/reset', (req, res) => {
    agentFor(req).resetTokenUsage();
    sendJSON(res, { ok: true });
  });

  router.post('/api/skills', async (req, res) => {
    const body = await parseBody<{ name?: string; content?: string; profile?: SkillProfile }>(req);
    const rawName = String(body.name || '').trim().replace(/\\/g, '/').split('/').pop() || '';
    const safe = rawName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'skill';
    const file = safe.toLowerCase().endsWith('.md') ? safe : safe + '.md';
    const profile = body.profile === 'dev' || body.profile === 'liberal' ? body.profile : 'custom';
    const content = String(body.content || '').trim();
    if (!content) throw new HttpError(400, 'Missing content');
    const dir = resolve(config.workspace.root, '.she', 'skills', profile);
    mkdirSync(dir, { recursive: true });
    const abs = resolve(dir, file);
    if (!isInsideDir(dir, abs)) throw new HttpError(400, 'Invalid path');
    writeFileSync(abs, content.endsWith('\n') ? content : content + '\n', 'utf8');
    sendJSON(res, { ok: true, path: `.she/skills/${profile}/${file}` }, 201);
  });

  router.post('/api/kb/import', async (req, res) => {
    const body = await parseBody<{
      text?: string;
      filename?: string;
      source?: string;
      sessionId?: string;
      title?: string;
    }>(req);

    let text = String(body.text || '');
    const source = String(body.source || 'raw').slice(0, 64);
    const filename = String(body.filename || 'paste.txt');

    if (body.sessionId) {
      const s = sessions.get(body.sessionId) || (body.sessionId === 'active' ? sessions.getActive() : null);
      if (!s) throw new HttpError(404, 'Session not found');
      text = (s.messages || [])
        .map((m: any) => `# ${m.role}\n\n${m.content || ''}`)
        .join('\n\n');
    }

    if (!text.trim()) throw new HttpError(400, 'Nothing to import');

    const day = new Date().toISOString().slice(0, 10);
    const rootName = `imports`;
    let root = store.getAllGroups().find((g) => g.name === rootName && !g.parentGroupId);
    if (!root) root = engine.createGroup(rootName);
    let srcGroup = store.getAllGroups().find((g) => g.name === source && g.parentGroupId === root!.id);
    if (!srcGroup) srcGroup = engine.createGroup(source, root.id);
    let dayGroup = store.getAllGroups().find((g) => g.name === day && g.parentGroupId === srcGroup!.id);
    if (!dayGroup) dayGroup = engine.createGroup(day, srcGroup.id);

        const chunks = parseContextExport({ source, text, filename });

    const created = [];
    for (const c of chunks) {
      const mem = engine.addMemory(dayGroup.id, 'text', c.title, c.content);
      created.push(mem.id);
    }

    sendJSON(res, {
      ok: true,
      groupId: dayGroup.id,
      groupPath: `${rootName}/${source}/${day}`,
      memoriesAdded: created.length,
      filename,
    }, 201);
  });

  router.post('/api/vision/describe', async (req, res) => {
    const body = await parseBody<{ path?: string; prompt?: string }>(req);
    const visionUrl = process.env.SHE_VISION_URL || '';
    if (!visionUrl) {
      sendJSON(res, {
        ok: false,
        status: 501,
        error: 'Vision backend not configured. Set SHE_VISION_URL or describe the image in text.',
        path: body.path || null,
      }, 501);
      return;
    }
    // Optional proxy — pass-through JSON to external describe service
    const resp = await fetch(visionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.SHE_VISION_TOKEN ? { Authorization: `Bearer ${process.env.SHE_VISION_TOKEN}` } : {}) },
      body: JSON.stringify({ path: body.path, prompt: body.prompt || 'Describe this image for a coding agent.' }),
    });
    const text = await resp.text();
    sendJSON(res, { ok: resp.ok, status: resp.status, body: text.slice(0, 50_000) }, resp.ok ? 200 : 502);
  });

  // ── cluster discussion rooms (parallel agents) ──
  router.get('/api/cluster/rooms', (_req, res) => {
    sendJSON(res, { rooms: cluster.list() });
  });

  /**
   * Work groups surfaced in the session rail.
   *
   * Rooms were previously only reachable from the cluster panel, so a group the
   * user created looked like it had vanished. Expose them as pseudo-sessions of
   * kind 'cluster' so the sidebar can list them alongside chats.
   */
  router.get('/api/conversations', (_req, res) => {
    const seen = new Set<string>();
    const chats: Array<{
      id: string;
      kind: 'chat';
      title: string;
      created_at: string;
      updated_at: string;
      directory?: string;
      parent_id?: string;
      background?: boolean;
      running?: boolean;
    }> = [];
    for (const root of projectRoots()) {
      for (const s of storeFor(root).list().sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        chats.push({
          id: s.id,
          kind: 'chat',
          title: s.title,
          created_at: s.created_at,
          updated_at: s.updated_at,
          directory: s.directory || root,
          parent_id: s.parent_id,
          background: s.background,
          running: agents.get(s.id)?.isRunning() ?? false,
        });
      }
    }
    const groups = cluster.list().map((r) => ({
      id: r.id,
      kind: 'cluster' as const,
      title: r.title,
      created_at: r.created_at,
      updated_at: r.updated_at,
      memberCount: r.members?.length ?? 0,
      status: r.status,
    }));
    const all = [...chats, ...groups].sort((a, b) =>
      (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
    );
    sendJSON(res, { items: all, active_id: sessions.list().active_id });
  });

  router.post('/api/cluster/rooms', async (req, res) => {
    const body = await parseBody<{ title?: string }>(req);
    const room = cluster.create(config.workspace.root, body.title);
    sendJSON(res, room, 201);
  });

  /** Role presets the UI can offer for one-click custom roles. */
  router.get('/api/cluster/role-presets', (_req, res) => {
    sendJSON(res, { presets: ROLE_PRESETS });
  });

  /** Replace a room's whole role configuration (counts 0..9 per role). */
  router.put('/api/cluster/rooms/:id/roles', async (req, res, params) => {
    const body = await parseBody<{ roles?: ClusterRole[] }>(req);
    if (!Array.isArray(body.roles)) throw new HttpError(400, 'roles[] is required');
    const room = cluster.setRoles(params.id, body.roles, config.workspace.root);
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, room);
  });

  /** Add or update one role (custom roles included). */
  router.post('/api/cluster/rooms/:id/roles', async (req, res, params) => {
    const body = await parseBody<Partial<ClusterRole>>(req);
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Missing role name');
    const key = String(body.key ?? '').trim()
      || name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
      || `role-${Date.now()}`;
    const role: ClusterRole = {
      key,
      name,
      title: String(body.title ?? '').trim() || name,
      count: Math.max(1, Math.floor(Number(body.count) || 1)),
      skill: String(body.skill ?? '').trim(),
      phase: (body.phase === 'lead' || body.phase === 'work' || body.phase === 'review') ? body.phase : 'work',
      hue: Number(body.hue) || Math.floor(Math.random() * 360),
      isCustom: true,
    };
      if (!role.skill) {
        /*
         * An AI-written skill is a convenience, not a prerequisite.
         *
         * This call needs the model, so it fails whenever the install is offline or
         * misconfigured — and treating that as fatal made "add a role" return an opaque
         * `500 Internal Server Error`, with no role created and no clue why. The role is
         * otherwise complete; `skill` is optional and the user can type it themselves. So the
         * failure is reported in the response instead of aborting the request, and the UI can
         * say "the skill was not generated" rather than "something went wrong".
         */
        try {
          role.skill = await generateRoleSkill(config, role);
        } catch (err) {
          role.skill = '';
          log.warn(`角色技能生成失败（角色仍会创建）: ${(err as Error).message}`);
        }
      }
    const room = cluster.upsertRole(params.id, role, config.workspace.root);
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, { room, role }, 201);
  });

  router.delete('/api/cluster/rooms/:id/roles/:key', (req, res, params) => {
    const room = cluster.removeRole(params.id, params.key, config.workspace.root);
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, room);
  });

  /** Let the model write a skill for a role from a plain-language requirement. */
  router.post('/api/cluster/generate-skill', async (req, res) => {
    const body = await parseBody<{ name?: string; title?: string; requirement?: string }>(req);
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Missing role name');
    /*
     * Here the generation IS the operation, so a failure must be an error — but an actionable
     * one. Falling through to the generic handler replaced the reason with a bare
     * `{"error":"Internal Server Error"}`, which tells the user nothing about the actual cause
     * (no API key, endpoint unreachable, rejected credentials) and reads as a bug in SHE
     * rather than as a problem with the model configuration they can fix.
     *
     * 502: the request was fine; the upstream model call is what failed.
     */
    let skill: string;
    try {
      skill = await generateRoleSkill(
        config,
        { name, title: String(body.title ?? '').trim() || name },
        body.requirement ? String(body.requirement) : undefined,
      );
    } catch (err) {
      throw new HttpError(502, `AI 生成技能失败：${(err as Error).message}。请检查模型接口与密钥，或手动填写技能内容。`);
    }
    sendJSON(res, { ok: true, skill });
  });

  router.put('/api/cluster/rooms/:id/title', async (req, res, params) => {
    const body = await parseBody<{ title?: string }>(req);
    const room = cluster.rename(params.id, String(body.title ?? ''));
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, room);
  });

  router.delete('/api/cluster/rooms/:id', (req, res, params) => {
    cluster.remove(params.id);
    sendJSON(res, { ok: true });
  });

  router.get('/api/cluster/rooms/:id', (_req, res, params) => {
    const room = cluster.get(params.id);
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, room);
  });

  router.post('/api/cluster/rooms/:id/message', async (req, res, params) => {
    const body = await parseBody<{ content?: string }>(req);
    const content = String(body.content || '').trim();
    if (!content) throw new HttpError(400, 'Missing content');
    const msg = cluster.append(params.id, { role: 'user', name: '用户', content });
    if (!msg) throw new HttpError(404, 'Room not found');
    sendJSON(res, msg, 201);
  });

  router.post('/api/cluster/rooms/:id/reload-skills', (_req, res, params) => {
    const room = cluster.reloadSkills(params.id, config.workspace.root);
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, room);
  });

  router.post('/api/cluster/init-skills', async (_req, res) => {
    const files = await initClusterIdentitySkills(config, config.workspace.root);
    sendJSON(res, { ok: true, files });
  });

  router.post('/api/cluster/rooms/:id/export-kb', async (req, res, params) => {
    const room = cluster.get(params.id);
    if (!room) throw new HttpError(404, 'Room not found');
    const body = await parseBody<{ title?: string }>(req);
    const day = new Date().toISOString().slice(0, 10);
    const rootName = 'imports';
    let root = store.getAllGroups().find((g) => g.name === rootName && !g.parentGroupId);
    if (!root) root = engine.createGroup(rootName);
    let srcGroup = store.getAllGroups().find((g) => g.name === 'cluster' && g.parentGroupId === root!.id);
    if (!srcGroup) srcGroup = engine.createGroup('cluster', root.id);
    let dayGroup = store.getAllGroups().find((g) => g.name === day && g.parentGroupId === srcGroup!.id);
    if (!dayGroup) dayGroup = engine.createGroup(day, srcGroup.id);

    const title = (body.title || room.title || '讨论纪要').slice(0, 80);
    const transcript = room.messages
      .map((m) => `## ${m.name}${m.parallel_group ? ` · 并行 ${m.parallel_group}` : ''}\n\n${m.content}`)
      .join('\n\n');
    const mem = engine.addMemory(
      dayGroup.id,
      'text',
      `${title} (${room.id})`,
      transcript,
    );
    sendJSON(res, {
      ok: true,
      memoryId: mem.id,
      groupPath: `${rootName}/cluster/${day}`,
      messages: room.messages.length,
    }, 201);
  });

  router.post('/api/cluster/rooms/:id/run', async (req, res, params) => {
    const body = await parseBody<{ goal?: string; stream?: boolean }>(req);
    const goal = String(body.goal || '').trim();
    if (!goal) throw new HttpError(400, 'Missing goal');

    const wantStream =
      body.stream === true ||
      ((req.headers.accept || '').includes('text/event-stream') && body.stream !== false);

    if (wantStream) {
      startSSE(res);
      try {
        const room = await runClusterWave({
          config,
          store: cluster,
          roomId: params.id,
          goal,
          onEvent: (ev) => sendSSEEvent(res, ev),
        });
        sendSSEEvent(res, { type: 'room', room });
        endSSE(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendSSEEvent(res, { type: 'error', error: msg });
        endSSE(res);
      }
      return;
    }

    const room = await runClusterWave({
      config,
      store: cluster,
      roomId: params.id,
      goal,
    });
    sendJSON(res, room);
  });

}

/**
 * Choose which chat session to open on boot.
 *
 * The rule itself lives in `chooseStartupSession` so it can be unit-tested; this only
 * applies it to the live store (reading the sessions and writing back the pick).
 */
function pickStartupSession() {
  const stored = sessions.getActive();
  // Hydrated so the rule can see `messages` and `background`; `list()` strips both.
  const all = sessions.list()
    .sessions
    .map((meta) => sessions.get(meta.id))
    .filter((s): s is ChatSession => Boolean(s));

  const chosen = chooseStartupSession(stored, all);
  if (chosen) {
    // Only write when the pick differs, so a plain boot does not rewrite the file.
    if (stored?.id === chosen.id) return chosen;
    const activated = sessions.setActive(chosen.id);
    if (activated) return activated;
  }
  return stored ?? sessions.create(undefined, { directory: resolve(config.workspace.root) });
}

export async function startServer(overrideConfig?: SheConfig): Promise<ReturnType<typeof createServer>> {  // Resolve config against the install root so the server finds the same
  // .env / config.yaml no matter which directory it was launched from.
  config = overrideConfig ?? loadConfig(PROJECT_ROOT);
  {
    const resolved = resolveWorkspaceKbPath(config.workspace.root);
    config.kb.dbPath = resolved.dbPath;
  }
  const { port, host } = config.server;

  remountKnowledgeBase(config.kb.dbPath);

  // Sessions / rooms live with the workspace, not with the process cwd (which
  // differs between `she server` and `--filter @she/server dev`). Recover any
  // data older builds left in cwd-scoped directories.
  stateDir = resolveStateDir(config);
  recoverLegacyState(stateDir);
  sessions = new SessionStore(stateDir);
  cluster = new ClusterStore(stateDir);
  schedule = new ScheduleStore(stateDir);

  // Pre-create the agent for the active session so its transcript is warm.
  //
  // Pick the session to open carefully: a stored `active_id` can point at an
  // empty "New chat" (e.g. created by a test or an abandoned tab), which makes
  // a perfectly healthy history look like it was lost after a restart. Prefer
  // the most recently touched session that actually has messages.
  const active = pickStartupSession();
  activeAgentId = active.id;

  /*
   * Load plugin tools BEFORE the first agent is built.
   *
   * The agent snapshots its tool list in its constructor, so a plugin installed
   * on disk is invisible to it until this runs. Doing it here also means a
   * plugin that fails to import is reported at boot rather than on first use.
   */
  try {
    const loaded = await plugins.refresh();
    if (loaded.length) log.info(`Loaded ${loaded.length} plugin tool(s): ${loaded.map((t) => t.name).join(', ')}`);
  } catch (e) {
    log.warn(`Plugin loading failed: ${(e as Error).message}`);
  }

  const initialAgent = makeAgent(config, active.id);
  if (active.messages?.length) initialAgent.setHistory(active.messages);
  agents.set(active.id, initialAgent);
  log.info(`Opened session ${active.id} (${active.messages?.length ?? 0} messages)`);

  log.info(`Settings file: ${ENV_PATH}`);
  log.info(`State dir:     ${stateDir}`);

  /*
   * Start the scheduler.
   *
   * Created after the first agent exists so a task that fires immediately has a
   * working dispatch path. `enabled` in config is the master switch; individual
   * tasks also carry their own flag.
   */
  if (config.schedule?.enabled) {
    schedulerInstance = new Scheduler({
      store: schedule,
      run: runScheduledTask,
      workingWindow,
      tickSeconds: config.schedule.tickSeconds,
    });
    schedulerInstance.start();
    const w = config.schedule.workingWindow;
    if (w) log.info(`允许工作的时间段: ${w.start}–${w.end}（窗口外只顺延，不中断）`);
    else log.info('允许工作的时间段: 不限制');
  } else {
    log.info('定时任务：已关闭');
  }

  log.info('All components initialized');
  // One-time tidying: the old version stored the wallpaper per workspace and left it there.
  cleanLegacyWorkspaceBackground();

  const router = new Router();
  registerRoutes(router);

  const server = createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';
    const start = Date.now();

    // Refuse anything that did not originate from the local app before it
    // reaches a route (see guardRequest for what this blocks).
    const refused = guardRequest(req, port);
    if (refused) {
      log.warn(`Refused request: ${method} ${url} (${refused})`);
      sendError(res, 'Forbidden', 403);
      return;
    }

    try {
      const handled = await router.handle(req, res);
      if (!handled) {
        if (method === 'GET' && !url.startsWith('/api/')) {
          if (!tryServeStatic(req, res)) {
            sendError(res, 'Not Found', 404);
          }
        } else {
          sendError(res, 'Not Found', 404);
        }
      }
        } catch (err) {
          if (!res.headersSent) {
            if (err instanceof HttpError) {
              sendError(res, err.message, err.status);
            } else if (err instanceof TurnInProgressError) {
              /*
               * 409, not 500.
               *
               * The request was valid; the conversation is simply busy. A client can
               * sensibly retry once the turn ends (or append with `/api/chat/interject`),
               * and telling it "Internal Server Error" gives it no way to know that.
               * A 500 here also reads as a bug in the server rather than as state.
               */
              sendError(res, err.message, 409);
            } else {
              log.error(`Error: ${(err as Error).message}`);
              // Counted, so `/api/metrics` can show that something is failing — the counter existed
              // but nothing ever incremented it, which made the metric claim a clean process.
              metrics.recordRequestFailure();
              sendError(res, 'Internal Server Error', 500);
            }
          }
        }

    log.info(`${method} ${url} ${res.statusCode} ${Date.now() - start}ms`);
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EACCES') {
      log.error(`Port ${port} is blocked (EACCES). On Windows this is often an excluded port range — try SHE_PORT=5577 or another free port.`);
    } else if (e.code === 'EADDRINUSE') {
      log.error(`Port ${port} is already in use (EADDRINUSE). Run SHE-stop.bat or pick another SHE_PORT.`);
    } else {
      log.error(`Listen failed: ${e.message}`);
    }
    process.exit(1);
  });
  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log('');
    console.log('  ┌──────────────────────────────────────┐');
    console.log('  │                                      │');
    console.log('  │  SHE v2 Agent Server                 │');
    console.log('  │                                      │');
    console.log(`  │  Local:   ${url.padEnd(26)}│`);
    console.log('  │                                      │');
    console.log('  │  KB:      ✓ ready                    │');
    console.log('  │  Agent:   ✓ ready                    │');
    console.log('  │  Sandbox: ✓ ready                    │');
    console.log('  │                                      │');
    console.log('  └──────────────────────────────────────┘');
    console.log('');
  });

  process.on('SIGINT', () => { disposeAllAgents(); server.close(() => process.exit(0)); });
  process.on('SIGTERM', () => { disposeAllAgents(); server.close(() => process.exit(0)); });

  // ── Crash forensics ──────────────────────────────────────────────────────
  // The server previously died with exit code -1 and an EMPTY stderr, leaving
  // nothing to debug. Always write the reason somewhere durable, and keep
  // serving on per-request failures instead of taking the whole process down.
  installCrashHandlers();

  return server;
}

let crashHandlersInstalled = false;

function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;

  const dump = (kind: string, err: unknown) => {
    // Counted so `/api/metrics` reflects reality: the counter existed but nothing ever called it, so
    // a process that had crashed still reported `crashes: 0`.
    try { metrics.recordCrash(); } catch { /* metrics must never break the crash path */ }
    const e = err as Error;
    const text = [
      `\n===== ${kind} at ${new Date().toISOString()} =====`,
      e?.stack || e?.message || String(err),
      `argv: ${process.argv.join(' ')}`,
      `cwd:  ${process.cwd()}`,
      `mem:  ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap`,
      '',
    ].join('\n');
    try {
      const dir = resolve(stateDir || '.', '.she');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'crash.log');
      /*
       * Cap it, because this is the one log that can grow without bound in the worst case: a
       * crash on every request appends on every request. Keeping the tail preserves the most
       * recent crashes, which is what a report needs.
       *
       * The cut advances to the next newline so a multi-byte character is never split — that
       * would leave a replacement glyph at the top and make the first report look corrupt.
       */
      const MAX = 512 * 1024;
      if (existsSync(file) && statSync(file).size > MAX) {
        const fd = openSync(file, 'r');
        const buf = Buffer.alloc(MAX);
        readSync(fd, buf, 0, MAX, statSync(file).size - MAX);
        closeSync(fd);
        const cut = buf.toString('utf8').indexOf('\n');
        writeFileSync(file, `…（日志过大已截断）${cut === -1 ? '' : buf.toString('utf8').slice(cut)}\n`, 'utf8');
      }
      appendFileSync(file, text, 'utf8');
    } catch { /* ignore */ }
    // stderr as well, so the launcher's captured log shows it
    process.stderr.write(text);
  };

  process.on('uncaughtException', (err) => {
    dump('uncaughtException', err);
    // A request handler throwing must not kill the server.
    log.error(`uncaughtException: ${(err as Error)?.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    dump('unhandledRejection', reason);
    log.error(`unhandledRejection: ${(reason as Error)?.message ?? String(reason)}`);
  });

  process.on('warning', (w) => {
    log.warn(`node warning: ${w.name}: ${w.message}`);
  });
}

/**
 * Auto-start only when this file is the process entry point (`pnpm --filter
 * @she/server dev`, `node dist/index.js`). When another package imports
 * `startServer` (e.g. `she server`), it must be able to call it exactly once —
 * running on import caused a duplicate listen / EADDRINUSE.
 */
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  startServer().catch(err => {
    log.error(`Fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}



