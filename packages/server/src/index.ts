import { createServer } from 'node:http';
import os from 'node:os';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, unlinkSync, appendFileSync, rmSync, copyFileSync, cpSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname, resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { realpathSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { createLogger, loadConfig, resolveEnvFile, mergeMissingEnvFile, updateEnvFile, THINKING_LEVELS, getConfigRecovery, getConfigFileInUse, lastGoodConfigPath, lastGoodConfigMetaPath, sandboxPostureNotice, isInsideDir as sharedIsInsideDir, realPathInWorkspace } from '@she/shared';
import { type ControlAuth, presentsControlToken, resolveControlAuth } from './control-token.js';
import { isScratchWorkspace } from './scratch-workspace.js';
import type { SheConfig, StreamChunk, EdgeKind, SkillProfile, ThinkingLevel } from '@she/shared';
import { KBStore, GroupKBEngine, mergeKnowledgeBases, activationReport } from '@she/kb';
import type { KBMemoryPatch } from '@she/kb';
import { resolveWorkspaceKbPath, writeKbLink, clearKbLink, copyKbFile, readKbLink } from './kb-link.js';
import { SandboxShell, createTools, ConfirmTicketStore, describeIsolation, isolationNotice } from '@she/sandbox';
import { Agent, TurnInProgressError, isSafeSessionId, readSkillProfile, writeSkillProfile, guardrailPolicy, summariseFindings, composeHandoffPrompt, shouldIsolate, readChildProgress, formatTimeoutReport, resolveSubagentTimeoutMs, resolveSubagentLlm, armSubagentWrapUp, selectHarvestNotes, allocateContext, pricingConfigured, pricingNote } from '@she/agent-runtime';
import type { SubagentRunner, SubagentResult, SubagentKbHarvest, UsageLike } from '@she/agent-runtime';
import {
  PlanStore,
  MemoStore,
  nextStepOf,
  planSessions,
  encodeSessionId,
  sessionStateDir,
  sessionStateRelDir,
  listSessionIds,
  WORKSPACE_SCOPE,
  adoptSessionPlansIntoWorkspace,
  adoptSessionMemosIntoWorkspace,
} from '@she/agent-runtime';
import { RunTraceStore, ConfidenceMirror, REFLECTION_DIR } from '@she/agent-runtime';
import type { RunSummary } from '@she/agent-runtime';
import { retireKnownFalsePositives } from '@she/agent-runtime';
import { WebClient } from '@she/agent-runtime';
import { classifyLlmFailure, failureLabel } from '@she/agent-runtime';
import type { StepStatus } from '@she/agent-runtime';
import { metrics } from './metrics.js';
import { PRODUCT_VERSION } from './version.js';
import {
  loadTheme, saveTheme, clearTheme, setThemeEnabled, revertTheme,
  validateCss, themeBytes, themePaths, THEME_MAX_BYTES,
} from './theme.js';
import { ScheduleStore, Scheduler, SessionBusyError, TaskNotRetryableError, describeNextRun, failureAlert, nextWindowStart, withinWindow } from './schedule.js';
import type { ScheduledTask, WorkingWindow } from './schedule.js';
import { Router, HttpError, sendJSON, sendError, sendSSEEvent, startSSE, endSSE, parseBody, readRawBody, corsHeaders } from './router.js';
import { SessionStore, chooseStartupSession } from './sessions.js';
import type { ChatSession, ImportedConversation } from './sessions.js';
import { ClusterStore, runClusterWave, stopClusterRun, initClusterIdentitySkills, ROLE_PRESETS, generateRoleSkill } from './cluster.js';
import { CLUSTER_PLAN_SCOPE_PREFIX } from './cluster-auto.js';
import type { ClusterRole } from './cluster.js';
import { listMcpServers, probeMcpServer, writeMcpServer, removeMcpServer, setMcpServerEnabled } from './mcp.js';
import { PluginManager, KNOWN_PERMISSIONS, type PluginManifest } from './plugins.js';
import { McpBridge } from './mcp-bridge.js';
import { ATTACHMENT_MAX_BYTES, MAX_CHAT_IMAGES, attachmentMime, attachmentsDir, resolveAttachmentFile, saveAttachment } from './attachments.js';
import { FeishuBridge, type FeishuConfig } from './feishu.js';

import { AuditLog } from './audit.js';
import { AUDIT_KINDS } from './audit.js';
import type { AuditRecord, AuditKind } from './audit.js';
import {
  AUTH_HEADER,
  authenticate,
  currentTenant,
  isPublicRoute,
  loadTenancy,
  presentedTokens,
  runInTenant,
  TenantLedger,
} from './tenancy.js';
import type { Tenancy } from './tenancy.js';
import { listTree, readWorkspaceFile, suggestPaths } from './files.js';
import { outlinePath, suggestSymbols } from './outline.js';
import { parseContextExport } from './contextParsers.js';
import { discoverConversations, loadTranscript, materializeConversation } from './discovery.js';
import { forgetProject, knownProjectRoots, rememberProject } from './projects.js';
import { addWorktree, asciiName, changedFiles, deleteBranch, diffAgainst, isGitRepo, listWorktrees, removeWorktree, resetWorktree, transferLocalChanges } from './worktrees.js';
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
 * Is this listen address reachable only from this machine?
 *
 * Used for one decision, and the direction matters: it decides whether an unauthenticated control
 * plane is acceptable. A value we do NOT recognise counts as **not** loopback, so an address this
 * function has never seen fails closed rather than being waved through as local.
 *
 * `''` and `0.0.0.0`/`::` are the "every interface" forms — those are the opposite of local.
 */
function isLoopbackHost(host: string): boolean {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  // 整个 127/8 都是回环（`127.0.0.53` 这类本机解析器地址也在这里面）。
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Whether `candidate` sits inside `base`.
 *
 * Now an alias over `@she/shared`'s `isInsideDir` — the containment rule is one thing, and this file
 * used to hold its own copy of it. The paragraph below is kept because it records the bug that made
 * the relative-segment form necessary in the first place.
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
  return sharedIsInsideDir(base, candidate, allowEqual);
}

/**
 * The workspace jail, for the routes served out of this file.
 *
 * An alias over `@she/shared`'s `realPathInWorkspace` — it returns the REAL path (symlink unfolded),
 * which is what these routes hand to the filesystem. It used to be a local copy; the hole that
 * motivated the consolidation is documented in `workspace-path.ts` (the fifth copy, in
 * `lsp-tools.ts`, skipped the symlink re-check and disagreed with this one on the same fixture).
 *
 * Two bypasses it defeats:
 *  1. An absolute path (`C:\Windows\System32\...`): `resolve(root, raw)` returns
 *     the absolute path, silently escaping the root.
 *  2. A symlink inside the workspace pointing outside it: the textual path looks
 *     contained, so the real target must be resolved before checking.
 */
function jailToWorkspace(workspaceRoot: string, requested: string): string {
  return realPathInWorkspace(workspaceRoot, requested);
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
 * 2026-10-01：上面那条"不要每次切工作区都跑"是对的，但还不够 —— 它在**启动时**照样把安装根
 * 目录的会话搬进任何新工作区。实测：把 `SHE_WORKSPACE` 指到一个空的临时目录，启动日志写着
 * `Recovered chat sessions from <install-root>\.she\sessions.json`，于是那个全新的工作区
 * 里凭空出现了安装根目录的对话。用户看到的"会话隔离完全无效"里，这一条是能单独复现的。
 *
 * 原因：安装根目录（以及它下面的 `packages/server`）当年是**默认工作区的 cwd**，不是"公共历史"。
 * 它里面的会话属于"以安装根为工作区"这个工作区，不属于用户后来选的任何一个工作区。所以只有在
 * 目标**就是安装根自己**时才去那里翻旧账；换了工作区就没有旧账可翻，也就不该翻。
 *
 * `process.cwd()` is intentionally NOT a candidate. It made the outcome depend
 * on how the server was launched (launcher vs direct), so two different
 * workspaces could overwrite each other's history.
 */
function recoverLegacyState(targetDir: string, extraSources: string[] = []): void {
  const target = resolve(targetDir);
  const installRoot = resolve(PROJECT_ROOT);
  const isInstallRoot = pathKey(target) === pathKey(installRoot);
  const sources = [
    ...extraSources,
    ...(isInstallRoot ? [join(installRoot, 'packages', 'server'), installRoot] : []),
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

/**
 * Mount a knowledge base as the current one.
 *
 * `closeCurrent: false` is for the one caller that has already arranged for the outgoing store to
 * keep living (`mountWorkspace`, which parks it in `extraEngines` for the sessions still pinned to
 * it). Everything else closes it — correctly, because those callers are about to copy or merge the
 * file and a live handle blocks that on Windows.
 */
function remountKnowledgeBase(dbPath: string, opts: { closeCurrent?: boolean } = {}): void {
  if (opts.closeCurrent !== false) {
    try { store?.close(); } catch { /* ignore */ }
  }
  const dir = dirname(dbPath);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  store = new KBStore(dbPath);
  engine = new GroupKBEngine(store, config.kb);
  log.info(`Knowledge base mounted: ${dbPath}`);
  // Once per KB per registry version: retire error-book entries that a since-fixed
  // reflection_check wrote (errorbook-migrations.ts). Logs and returns; never throws.
  retireKnownFalsePositives(engine as never, store as never, { workspaceRoot: config.workspace.root, kbPath: dbPath, log });
}

/** Knowledge bases for sessions that work in some other directory. */
const extraEngines = new Map<string, GroupKBEngine>();

/**
 * Identity of a path, not its spelling.
 *
 * `resolve()` normalises separators and dots and nothing else, so one file reached two ways gets
 * two cache keys and — worse — two live connections inside one process. That is not hypothetical:
 * `os.tmpdir()` on Windows hands out the 8.3 short form (`C:\Users\LONGUS~1\…`) while git and
 * `realpathSync` report the long form (`C:\Users\LongUserName\…`), so the same sqlite file opened
 * from a worktree was cached under two keys. Two writers to one file in one process is lock
 * contention waiting to happen, and a handle you cannot find again is a handle you cannot close —
 * which is how a directory ends up undeletable. Comparing real paths, case-insensitively on
 * Windows because the filesystem itself is, keeps one file to one engine.
 *
 * Directories need the same treatment, for the same reason and with a sharper consequence. This
 * machine's project index held both `d:\work\_she-scratch` and `D:\Work\_she-scratch` — one
 * directory, two spellings — and keyed by spelling that is two SessionStores and two ClusterStores
 * over one `sessions.json`: two in-memory copies, each free to persist its own version and write
 * the other's conversations away.
 */
function pathKey(p: string): string {
  let out = resolve(p);
  try { out = realpathSync.native(out); } catch { /* not created yet — resolve() is the best there is */ }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** Whether two paths name the same knowledge base. */
function sameDb(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * Whether an engine still holds a usable connection.
 *
 * A closed store is not fatal to a holder that already has it (`KBStore` reopens on use), but a
 * *lookup* should prefer building a fresh engine over handing out one whose connection has been
 * released, because the store's cached statements are rebuilt either way.
 */
function engineAlive(e: GroupKBEngine | undefined): boolean {
  const store = (e as unknown as { store?: { isOpen?: boolean } } | undefined)?.store;
  return store?.isOpen === true;
}

function engineFor(dbPath: string): GroupKBEngine {
  const abs = resolve(dbPath);
  const key = pathKey(abs);
  if (key === pathKey(config.kb.dbPath)) {
    /*
     * `/api/kb/share` and `/api/kb/merge` close the current store before copying the file, so a
     * request landing in that window would otherwise be handed an engine that answers every call
     * with "The database connection is not open". Rebuild instead of returning a corpse.
     */
    if (!engineAlive(engine)) remountKnowledgeBase(config.kb.dbPath);
    return engine;
  }
  const hit = extraEngines.get(key);
  if (hit) {
    if (engineAlive(hit)) return hit;
    extraEngines.delete(key);
  }
  mkdirSync(dirname(abs), { recursive: true });
  const extra = new GroupKBEngine(new KBStore(abs), config.kb);
  extraEngines.set(key, extra);
  return extra;
}

/**
 * Release the KB engine cached for one path.
 *
 * `extraEngines` is allowed to keep every database it has ever opened, which is right for
 * correctness and wrong for the filesystem: a live sqlite handle inside a directory makes that
 * directory undeletable on Windows. An isolated child opens its own KB copy inside its worktree, so
 * without this the worktree could be reviewed but never deleted — "Invalid argument" from git, and
 * an error nobody can act on. Dropping the map entry as well is deliberate: a later request for the
 * same path must build a fresh engine rather than be handed a closed store.
 */
function closeEngineFor(dbPath: string): void {
  const key = pathKey(dbPath);
  const extra = extraEngines.get(key);
  if (!extra) return;
  try { (extra as unknown as { store: { close(): void } }).store.close(); } catch { /* ignore */ }
  extraEngines.delete(key);
}

/**
 * Let go of everything this process holds open inside `dir`, so `dir` can be deleted.
 *
 * Called before removing a worktree: the sqlite handle is what actually holds the lock, and an
 * agent still pinned to that directory would go on working in a directory that no longer exists.
 *
 * Returns false — releasing nothing — when a session in that directory is still running. Their
 * work is not the deletion's to interrupt, and that used to be enforced only for the agents while
 * the KB handle was closed regardless, which meant a delete could break the knowledge base of an
 * agent still working in it. The caller turns a false into a refusal.
 */
function disposeWorkspace(dir: string): boolean {
  const abs = resolve(dir);
  const busy = [...agents].some(([id, a]) => a.isRunning() && sameDb(rootForSession(id), abs));
  if (busy) return false;
  closeEngineFor(join(abs, '.she', 'kb.sqlite'));
  for (const [id, agent] of [...agents]) {
    if (agent.isRunning()) continue;
    if (sameDb(rootForSession(id), abs)) dropAgent(id);
  }
  return true;
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
/** The same, for the work groups living in those projects' state directories. */
const otherClusters = new Map<string, ClusterStore>();

function projectIndexFile(): string {
  return join(appDir(), 'projects.json');
}

function storeFor(dir: string): SessionStore {
  const abs = resolve(dir);
  const key = pathKey(abs);
  if (pathKey(sessions.rootDir) === key) return sessions;
  let hit = otherStores.get(key);
  if (!hit) {
    /* Keyed case-insensitively, constructed with the spelling the user gave: one store per
     * directory, but the path shown in the UI keeps its original capitals. */
    hit = new SessionStore(abs);
    otherStores.set(key, hit);
  }
  return hit;
}

/**
 * The work-group store for a project's state directory.
 *
 * Groups are per state directory just like sessions, so the session rail has to reach into the
 * other projects' stores to keep listing them (see `/api/conversations`).
 */
function clusterFor(dir: string): ClusterStore {
  const abs = resolve(dir);
  const key = pathKey(abs);
  if (pathKey(stateDir) === key) return cluster;
  let hit = otherClusters.get(key);
  if (!hit) {
    hit = new ClusterStore(abs);
    otherClusters.set(key, hit);
  }
  return hit;
}

/** Every cluster store the session rail can see: the mounted one first, then each known project's. */
function clusterStoresForRail(): ClusterStore[] {
  const stores = new Set<ClusterStore>([cluster]);
  for (const root of projectRoots()) stores.add(clusterFor(root));
  return [...stores];
}

/**
 * Where a room actually lives: the store holding it, and the project it belongs to.
 *
 * Rooms are filed per state directory, so opening a chat that belongs to another project mounts
 * that project's directory and the room you were looking at is suddenly in a store nobody is
 * asking. Every room route used to look the id up in the mounted `cluster` alone, which is why a
 * room the rail lists (the rail lists all projects) answered 404 the moment it was clicked — and a
 * button that always fails is worse than no button. A room records its own `workspace`, which is
 * also what decides whose skills and whose knowledge base it should use.
 */
function roomHome(roomId: string): { store: ClusterStore; root: string } | null {
  for (const store of clusterStoresForRail()) {
    const room = store.get(roomId);
    if (room) {
      return { store, root: room.workspace ? resolve(room.workspace) : resolve(config.workspace.root) };
    }
  }
  return null;
}

/**
 * Point the process at another project's state directory.
 *
 * Sessions and work groups are both filed per state directory, so a switch swaps both stores — and
 * the rail reads the other projects' copies through `otherStores` / `otherClusters`. That makes the
 * swap a place where one file can quietly end up with two live stores, which is the bug this whole
 * area exists to prevent:
 *
 *   - the store we are LEAVING holds the newest state for its file (it is the one the user has been
 *     writing through), so it is parked in the cache rather than dropped;
 *   - the store we are MOVING TO must be taken from the cache if it is there, and removed from it
 *     either way, because the mounted slot is now its single owner.
 *
 * Skipping the second half is not theoretical. The rail is polled continuously, so a project the
 * user has not opened yet already has a cached store reading `rooms: []` from disk; if the switch
 * leaves that instance in place and builds a second one for the mounted slot, the group the user
 * then creates is written by the mounted copy and read back from the stale one. Reproduced live on
 * 2026-09-27 (build 13472): a room existed in `_she-scratch/.she/cluster/rooms.json` and the rail
 * listed no groups at all, with `GET /api/cluster/rooms/<id>` answering 404.
 */
function mountStateDir(nextState: string): void {
  otherStores.set(pathKey(sessions.rootDir), sessions);
  otherClusters.set(pathKey(stateDir), cluster);
  stateDir = nextState;
  sessions = otherStores.get(pathKey(stateDir)) ?? new SessionStore(stateDir);
  cluster = otherClusters.get(pathKey(stateDir)) ?? new ClusterStore(stateDir);
  otherStores.delete(pathKey(stateDir));
  otherClusters.delete(pathKey(stateDir));
  log.info(`Switched state dir to ${stateDir} (${sessions.list().sessions.length} chats)`);
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

/**
 * Auth + tenancy for this process.
 *
 * Parsed once at module load, because it comes from the environment and the environment does not
 * change while the process runs. `loadTenancy` throws on a token that is too short or duplicated —
 * deliberately at startup, where the operator sees it, rather than on the first request.
 *
 * Declared above `findSession` rather than beside `auditLog` below it because `findSession` reads
 * it, and a `let` that is still in its temporal dead zone is a crash, not a default.
 */
let tenancy: Tenancy = { enabled: false, tenants: [], implicit: 'local', system: 'system' };
let tenancyError: string | null = null;
try {
  tenancy = loadTenancy(process.env);
} catch (err) {
  // A misconfigured token must NOT silently degrade to "no auth": that is the failure mode where
  // the operator believes the port is protected. Refuse to serve and say why.
  tenancyError = err instanceof Error ? err.message : String(err);
}

/**
 * 控制面凭据（这一台机器上"谁能改运行档位"）。
 *
 * 在 `startServer` 里赋值而不是在这里 —— 模块级就要做文件 I/O 会让**导入这个模块**的单元测试在
 * 真实的 `~/.she-app` 里生成凭据，而导入一个模块不该有这种副作用。`tenancy` 可以在模块级是因为
 * 它只读 `process.env`。
 */
let controlAuth: ControlAuth | null = null;

/**
 * 这个请求改的是不是**这台机器怎么跑**（而不是"让 Agent 干一件事"）。
 *
 * 划定得偏保守：设置、工作区、配置回退 —— 这三个都能改变边界的宽度（设置直接写 `.env` 里的沙箱
 * 档位，工作区决定边界画在哪，回退会换成另一份配置）。其余接口（聊天、会话、知识库、轨迹）不在这里，
 * 因为它们的权限问题**已经**由 tenancy 那套回答，而给它们再加一把锁只会让界面多一次认证。
 *
 * 前缀匹配是刻意的：`/api/workspaces/anything` 以后新增的路由默认也在里面。漏掉一个新接口的代价
 * （控制面又开一个口）比多保护一个的代价（多一次 401）大得多。
 */
function isControlPlanePath(pathname: string): boolean {
  // 控制面的**读**也要凭据：`GET /api/settings` 会回出 `.env` 里那一套档位，而"先读出来确认哪一档
  // 好改"是改写的前一半。所以这里不看 method。
  if (pathname === '/api/settings') return true;
  // 改 API 认证 = 改"谁能连这个 API"，与设置同属能改变边界宽度的那一类。
  if (pathname === '/api/auth/config') return true;
  if (pathname === '/api/config/rollback' || pathname === '/api/config/recovery') return true;
  if (pathname === '/api/workspaces' || pathname.startsWith('/api/workspaces/')) return true;
  return false;
}

/** Session → tenant, kept per workspace like the audit log. */
let ledger: TenantLedger | null = null;let ledgerRoot = '';
function tenantLedger(): TenantLedger {
  const root = resolve(config.workspace.root);
  if (!ledger || ledgerRoot !== root) {
    ledger = new TenantLedger(root);
    ledgerRoot = root;
  }
  return ledger;
}

/**
 * The tenant that owns work created with no request behind it.
 *
 * `currentTenant()` is undefined in a scheduled task or a startup migration; those sessions still
 * need an owner, or the first tenant to ask for them would be refused (and with several tenants
 * they must not fall into the "unowned is readable" branch).
 */
function ownerTenant(): string {
  return currentTenant() ?? tenancy.system;
}

/**
 * Create a session and record who owns it.
 *
 * Every creation goes through here rather than calling `sessions.create` / `store.create`
 * directly. Ownership that is assigned in five places is ownership that will be forgotten in the
 * sixth, and a forgotten claim is not a cosmetic bug: it is a session that either disappears from
 * its owner's list or is refused on the next request.
 */
function createSession(
  store: SessionStore,
  title: string | undefined,
  opts: { directory: string; parentId?: string; background?: boolean },
): ChatSession {
  const created = store.create(title, opts);
  if (tenancy.enabled) tenantLedger().claim(created.id, ownerTenant());
  return created;
}

/**
 * Drop sessions the current tenant may not see.
 *
 * `findSession` guards reads by id, and it is not enough on its own: the LIST routes never go
 * through it, they enumerate every store. Without this, tenant A's sidebar would show tenant B's
 * conversation titles — the ids would then be refused on open, which is a confusing state rather
 * than a leak, but the titles alone are often the sensitive part.
 */
function visibleToTenant<T extends { id: string }>(items: T[]): T[] {
  if (!tenancy.enabled) return items;
  const tenant = currentTenant();
  if (tenant === undefined) return items;
  return items.filter((s) => tenantLedger().canAccess(s.id, tenant, tenancy));
}

function findSession(id: string): { store: SessionStore; session: ChatSession } | null {
  /*
   * The one place every session read passes through, so the one place tenancy has to be enforced.
   *
   * Deliberately not a check in each route: sessions are addressed by id, and a caller holding
   * another tenant's id — from a log line, a shared link, a `parent_id` in a JSON dump — would
   * otherwise read that transcript from a dozen different endpoints. Returning "not found" rather
   * than "forbidden" is also a choice: whether a session id EXISTS is itself tenant information.
   */
  if (!tenantLedger().canAccess(id, currentTenant(), tenancy)) return null;
  const local = sessions.get(id);
  if (local) return { store: sessions, session: local };
  for (const root of projectRoots()) {
    if (sameDb(root, sessions.rootDir)) continue;
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
    if (pathKey(legacyDir) === pathKey(globalDir)) return;

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
 * MCP bridge: long-lived sessions to every enabled MCP server, reached by the agent through two
 * STATIC meta-tools (`mcp_list`, `mcp_call`) whose definitions never change, so connecting,
 * failing or toggling a server never changes the cached tool table. See mcp-bridge.ts; MCP servers
 * run outside the sandbox, so `makeAgent` routes `mcp_call` through the confirm-ticket gate unless
 * the workspace allows all commands.
 */
const mcp = new McpBridge({
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
/**
 * How often a running subtask reports what it is doing.
 *
 * Chosen against the two things it can annoy: the reader (a tick is one card update, so a shorter
 * interval is only noise) and the child (reading its transcript is cheap, but it is a share of the
 * same event loop). Long enough to be ignorable, short enough that "still working" is visible
 * before a user starts wondering whether it hung — which was the actual complaint.
 */
const SUBAGENT_HEARTBEAT_MS = 5_000;

function makeSubagentRunner(parentCfg: SheConfig, parentSessionId: string): SubagentRunner {
  /*
   * The default budget, in seconds.
   *
   * An env override exists for evals that want a short leash; a task can override it per call
   * (`timeout_ms`), which is the one that matters in real use — the right number depends on the
   * job, and the heaviest honest job does not fit in the default.
   */
  const DEFAULT_TIMEOUT_SECONDS = Number(process.env.SHE_SUBAGENT_TIMEOUT_MS) > 0
    ? Number(process.env.SHE_SUBAGENT_TIMEOUT_MS) / 1000
    : undefined;

  return {
    async run(req, _signal, hooks) {
      const budgetMs = resolveSubagentTimeoutMs(req.timeoutMs, DEFAULT_TIMEOUT_SECONDS);
      const baseDir = parentCfg.workspace.root;

      /*
       * Isolation is decided before anything is created, and a request for it that cannot be
       * granted is reported rather than silently downgraded. A child the parent believes is in a
       * private tree, while it is in fact editing the shared checkout, is the exact accident this
       * is meant to prevent — so the note travels back in the result.
       */
      let directory = baseDir;
      let worktree: { path: string; branch: string; head: string } | null = null;
      let isolationNote: string | undefined;

      const repo = isGitRepo(baseDir);
      /*
       * Two answers from one rule, so the reporting cannot drift from the decision.
       *
       * `isolate` is the real decision in this workspace; `wanted` is the same rule asked with the
       * git constraint lifted ("would this task be isolated if it could be?"). Asking the runtime
       * both ways is what lets the reply distinguish "isolation was not called for" — the common
       * read-only case, which must stay quiet — from "isolation was called for and did not happen",
       * which the parent has to know about.
       */
      const isolate = shouldIsolate(req, repo);
      const wanted = shouldIsolate(req, true);
      if (isolate) {
        try {
          const info = addWorktree(baseDir, `sub-${asciiName(req.description)}`, { unique: true });
          worktree = { path: info.path, branch: info.branch, head: info.head || 'HEAD' };
          directory = info.path;
          // Carry the parent's uncommitted work across, or the child would be editing a version
          // of the project that is older than the one the parent is describing to it.
          const moved = transferLocalChanges(baseDir, directory);
          if (!/已套用|没有未提交/.test(moved)) isolationNote = moved;
        } catch (err) {
          isolationNote = `隔离副本创建失败，已回退到主工作区：${err instanceof Error ? err.message : String(err)}`;
          worktree = null;
          directory = baseDir;
        }
      } else if (wanted) {
        isolationNote = '主工作区不是 git 仓库，无法开隔离副本，这个子任务在共享工作区里跑';
      }

      const childSession = createSession(storeFor(directory), req.description, {
        directory,
        parentId: parentSessionId,
      });
      /*
       * Register the worktree as a known project.
       *
       * Without this the child's transcript is written into `.she/` inside the worktree and is then
       * invisible: `/api/sessions` enumerates known project roots, and a directory nobody has
       * registered is not one. The child's session would exist on disk with no way to open it —
       * "it ran in isolation" and "there is no record of what it did" are not the same feature.
       */
      if (worktree) {
        try { rememberProject(projectIndexFile(), directory); } catch { /* non-fatal */ }
      }
      const shell = new SandboxShell(directory, parentCfg.sandbox);
      const at = configForRoot(directory);
      /*
       * The child's knowledge base is a PRIVATE copy, whether or not the child is isolated.
       *
       * Isolation and memory are two different questions, and the old code answered them with one
       * switch: only an isolated child got a copy, so a read-only child — the common case — ran
       * straight against the parent's live database. That is the worst half of both options: the
       * parent's memory was one call away from an unreviewed edit (so writes had to be refused), and
       * the child had nowhere to put a finding except the last paragraph it wrote.
       *
       * A copy fixes both ends. Writes are safe by construction because they land where the parent
       * cannot see them, and they are not thrown away either: `takeKbNotes` reads them back when the
       * child ends and hands the parent a list it can absorb. One rule for every child, and the file
       * lives in the app directory rather than inside the worktree — a knowledge base is not part of
       * the work product, and inside a worktree it showed up as an untracked `.she/` in the
       * changed-files list the parent reads.
       *
       * `spawnedAt` is taken BEFORE the copy is made, so "created since" means "created by this
       * child" rather than "already in the parent's memory".
       */
      const spawnedAt = Date.now();
      const privateKb = subagentKbPath(childSession.id);
      const childKbPath = privateKb ?? at.kb.dbPath;
      /*
       * 子任务默认低档思考、单次输出封顶 32k（见 `resolveSubagentLlm`）。主线配置不动。
       */
      const childLlm = { ...at.llm, ...resolveSubagentLlm(at.llm) };
      const childCfg = privateKb
        ? { ...at, llm: childLlm, kb: { ...at.kb, dbPath: privateKb } }
        : { ...at, llm: childLlm };
      /*
       * Seed the child's KB before constructing it, so its first `kb_query` already sees the
       * project's memory. See `seedIsolatedKb` for why an empty one is the wrong default.
       */
      const kbCarry = seedIsolatedKb(parentCfg.kb.dbPath, childKbPath);
      const tools = createTools(shell, directory, {
        allowAllCommands: parentCfg.sandbox.allowAllCommands,
        // Same rule as the parent's: the child's KB copy is `kb_*`-only too.
        kbDbPath: childKbPath,
        // 子代理也不能读控制面凭据 —— 它和父代理同在工作区内，越权是一样的越权。
        controlTokenPath: controlAuth?.token ? controlAuth.path : undefined,
      });
      const child = new Agent(childCfg, engineFor(childKbPath), tools, childSession.id, {
        isSubagent: true,
        /*
         * The one remaining case where a write has to be refused: the child ended up pointed at the
         * PARENT's own file (no private copy could be created — see `subagentKbPath`). A node there
         * would be permanent, unreviewed, and indistinguishable from one the parent wrote. Every
         * other child writes into its own copy, which cannot reach the parent's memory.
         */
        kbReadOnly: kbCarry === 'shared',
      });
      agents.set(childSession.id, child);

      // The brief the child actually receives: the structured handoff, then the parent's words.
      /*
       * The brief states the deadline it will actually be held to.
       *
       * A child held to a clock it was never told about finds out only by being killed, and what
       * it was holding at that moment is gone. Told the number, it can choose to conclude early —
       * which is the whole difference between "no result" and "a partial result with its evidence".
       */
      const brief = composeHandoffPrompt(req, {
        workdir: directory,
        isolated: Boolean(worktree),
        kb: kbCarry,
        deadlineSeconds: budgetMs / 1000,
      });

      const collectWorktree = (pending?: string): SubagentResult['worktree'] => {
        if (!worktree) return undefined;
        return {
          path: worktree.path,
          branch: worktree.branch,
          changed: changedFiles(worktree.path),
          note: [isolationNote, pending].filter(Boolean).join(' ') || undefined,
        };
      };

      /*
       * 回收隔离副本：记录搬进工作区，工作区外的那棵树删掉。
       *
       * 为什么不是"留着让人看"：副本的路径在 `.she-worktrees` 下、也就是工作区外面，所以子代理自己看不到、
       * 清不掉（2026-09-27 那次隔离专项检查就是原话："我自己看不到也清不掉"），而人会忘。留着的结果是每个
       * 子任务在工作区外留一棵完整的代码树加一个 `she/*` 分支，积累到没人知道哪些还有用。副本的价值是
       * "孩子干过什么"，那两样东西（transcript 和改动）都能搬进工作区，代码树本身不能。
       *
       * 顺序不是风格问题：
       *   1. 先算改动清单、先读笔记（都在树里，删了就没了）；
       *   2. 再把 child 的 `.she` 搬进 `<工作区>/.she/subagent-history/<子会话 id>/`，会话记录里的
       *      `directory` 改指归档处，否则点开那份记录会去挂一个已经不存在的目录；
       *   3. 再写改动补丁 —— 子任务提交过的东西在分支删掉后就只剩这份补丁；
       *   4. 最后才松句柄、删树。Windows 上 sqlite 句柄握着目录，删树会以 "Invalid argument" 失败，
       *      那正是 `closeEngineFor` 存在的原因。
       *
       * 任何一步失败都不影响子任务的结果：回收是收尾，不是交付。失败时把原因写进 note，让父级看得见。
       */
      const reclaimWorktree = (info: SubagentResult['worktree']): SubagentResult['worktree'] => {
        if (!worktree || !info) return info;
        const wt = worktree;
        const archive = join(parentCfg.workspace.root, '.she', 'subagent-history', childSession.id);
        let patchPath: string | undefined;
        try {
          rmSync(archive, { recursive: true, force: true });
          mkdirSync(archive, { recursive: true });
          const childState = join(wt.path, '.she');
          if (existsSync(childState)) renameSync(childState, join(archive, '.she'));
          const patch = diffAgainst(wt.path, wt.head);
          if (patch.trim()) {
            patchPath = join(archive, 'worktree.patch');
            writeFileSync(patchPath, patch, 'utf8');
          }
          try {
            new SessionStore(archive).update(childSession.id, { directory: archive });
          } catch { /* 记录在归档里；只是 directory 还指着旧路径 */ }
          try { rememberProject(projectIndexFile(), archive); } catch { /* non-fatal */ }

          /* 用户可能正开着这个副本的会话：那就把挂载点搬到归档处，而不是让他在一个刚被删掉的目录上翻页。 */
          const wasMounted = pathKey(stateDir) === pathKey(wt.path);
          if (wasMounted) mountStateDir(archive);
          if (!disposeWorkspace(wt.path)) throw new Error('副本里还有会话在运行，这次不回收');
          otherStores.delete(pathKey(wt.path));
          removeWorktree(parentCfg.workspace.root, wt.path);
          try { forgetProject(projectIndexFile(), wt.path); } catch { /* 索引清不掉不影响回收 */ }
          const branchError = deleteBranch(parentCfg.workspace.root, wt.branch);
          return {
            ...info,
            path: archive,
            note: [
              info.note,
              `副本已回收：记录在 ${archive}${patchPath ? `，改动补丁在 ${patchPath}` : '（没有改动）'}`,
              branchError ? `分支没删掉：${branchError}` : '',
            ].filter(Boolean).join(' '),
            reclaimed: { archivePath: archive, patchPath, branchDeleted: !branchError, error: branchError ?? undefined },
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log.warn(`隔离副本没回收掉（${wt.path}）: ${reason}`);
          return {
            ...info,
            note: [info.note, `副本没回收掉（${reason}），它还在 ${wt.path}`].filter(Boolean).join(' '),
            reclaimed: { archivePath: archive, patchPath, branchDeleted: false, error: reason },
          };
        }
      };

      /*
       * Isolation status, reported on every return path including the ones with no worktree.
       *
       * `handOff` and the failure branch both used to drop it: `collectWorktree` returns undefined when
       * there is no worktree, so a parent that asked for isolation and did not get it heard nothing at
       * all — the child simply ran in the shared checkout and the reply looked normal.
       */
      const isolationInfo = (): SubagentResult['isolation'] => ({
        requested: wanted,
        applied: Boolean(worktree),
        note: isolationNote,
      });

      /*
       * What the child wrote down, read back out of its copy — and then the copy is deleted.
       *
       * Runs once, on every ending (a finished child, a timeout, a failure), because a child that ran
       * out of time is exactly when its notes are the only thing it produced. The order inside is not
       * negotiable on Windows: the handle has to be released before the file can go, which means the
       * child's cached agent goes with it. Nothing is lost by forgetting that agent — it finished, and
       * `dispose()` only owns its language server.
       *
       * A child whose KB is the parent's own file has nothing private to read, and its file is not
       * this function's to delete.
       */
      let taken: SubagentKbHarvest | undefined;
      let takeRan = false;
      const takeKbNotes = (): SubagentKbHarvest | undefined => {
        if (takeRan) return taken;
        takeRan = true;
        if (sameDb(childKbPath, parentCfg.kb.dbPath)) return undefined;
        try {
          closeEngineFor(childKbPath);
          dropAgent(childSession.id);
          const store = new KBStore(childKbPath);
          try {
            taken = selectHarvestNotes(store.memoriesCreatedSince(spawnedAt));
          } finally {
            store.close();
          }
        } catch (err) {
          log.warn(`读取子任务知识库笔记失败（这些笔记只能去看它自己的会话）: ${(err as Error).message}`);
        } finally {
          try {
            rmSync(childKbPath, { force: true });
          } catch (err) {
            log.warn(`子任务知识库副本没删掉: ${childKbPath}: ${(err as Error).message}`);
          }
        }
        return taken;
      };

      /*
       * What the parent is told about the notes the child wrote, and where the full text lives.
       *
       * The digest file is written whenever there are notes, not only when the reply is too small to
       * hold them. Two reasons: a reply can be thrown away without being read (a detached parent, a
       * background child whose caller already returned), and the copy the notes came from no longer
       * exists — so a note that is not written down here is gone. Everything the child wrote is in
       * that file; the reply carries the titles and enough of each one to decide.
       */
      const notesFor = (): SubagentKbHarvest | undefined => {
        const harvest = takeKbNotes();
        if (!harvest?.notes.length) return harvest;
        const digestPath = writeHarvestDigest(parentCfg.workspace.root, parentSessionId, childSession.id, harvest);
        return digestPath ? { ...harvest, digestPath } : harvest;
      };

      /*
       * 每一条结束路径（跑完、超时、失败）都要走这里，顺序反过来就等于丢东西：
       * 改动清单必须在树还在的时候取，笔记必须在副本被删之前读，回收必须在这两样之后。
       */
      const finish = (result: SubagentResult): SubagentResult => {
        const wtInfo = collectWorktree();
        const harvest = notesFor();
        return { ...result, worktree: reclaimWorktree(wtInfo), kbHarvest: harvest };
      };

      const job = (async (): Promise<SubagentResult> => {
        let timedOut = false;
        /*
         * 软截止：硬杀之前先让子任务收尾。
         *
         * 排的是三次而不是一次：提醒只能落在回合边界上（`interject` 会排队，等当前工具组结束后再
         * 并入对话），而单个回合可能长达一分钟（实测 63.4s），所以第一次可能落地得很晚——
         * 2026-09-25 那次只剩 26.4s。落晚了若没有下一次就无从补救。
         *
         * 排序与措辞在 `armSubagentWrapUp` 里，因为那段要能被测试驱动（那里有整条链路的验证）。
         */
        const disarmWrapUp = armSubagentWrapUp(child, budgetMs);
        try {
          const out = await Promise.race([
            child.chat(brief),
            /*
             * `unref` because the timer usually outlives its purpose: a child that finishes in 10
             * seconds leaves this pending, and a caller that asked for a 30-minute budget would
             * then have a 30-minute timer holding the process open on its behalf.
             */
            new Promise<null>((r) => setTimeout(() => { timedOut = true; r(null); }, budgetMs).unref?.()),
          ]);
          disarmWrapUp();
          if (timedOut) {
            try { child.stop(); } catch { /* ignore */ }
          }
          try {
            /*
             * The title is passed back on every persist.
             *
             * `SessionStore.update` derives a title from the first user message when none is given,
             * and the child's first user message is now the handoff brief — so persisting without
             * it would rename every isolated subtask to "## 交接单 - 交付物：…". The parent named
             * this job; that name is what the session list should show.
             */
            storeFor(directory).update(childSession.id, { title: req.description, messages: child.historyForDisk() });
          } catch { /* keep the reply */ }
          /*
           * A timeout owes the parent an account of what it paid for.
           *
           * The old reply was `子任务超时（180s）` and nothing else, which left the parent with a
           * sunk cost and one option: dispatch the same task again and pay for the same 180s
           * twice. Read from the child's own transcript, the reply now says how far it got, what
           * it last said, and what it changed — and names the two ways to give a heavy task
           * enough room next time. The child is stopped either way; the difference is whether the
           * time spent leaves a trace.
           */
          const timedOutText = () => formatTimeoutReport(readChildProgress(child.getHistory()), {
            seconds: Math.round(budgetMs / 1000),
            sessionId: childSession.id,
            changed: collectWorktree()?.changed,
            worktreePath: worktree?.path,
          });
          return finish({
            description: req.description,
            ok: !timedOut,
            result: timedOut
              ? timedOutText()
              : `${out?.content ?? '(无输出)'}\n\n（子会话 ${childSession.id}）`,
            handoff: req.handoff,
            isolation: isolationInfo(),
          });
        } catch (err) {
          try { storeFor(directory).update(childSession.id, { title: req.description, messages: child.historyForDisk() }); } catch { /* ignore */ }
          return finish({
            description: req.description,
            ok: false,
            result: `子任务失败: ${err instanceof Error ? err.message : String(err)}\n\n（子会话 ${childSession.id}）`,
            handoff: req.handoff,
            isolation: isolationInfo(),
          });
        }
      })();

      const handOff = (): SubagentResult => {
        storeFor(directory).markBackground(childSession.id);
        void job;
        return {
          description: req.description,
          ok: true,
          result: `已在后台继续。打开会话「${childSession.title}」（${childSession.id}）可以看它的过程。`
            + `\n它结束时写下的知识库笔记会汇总到 ${harvestDigestRelPath(parentSessionId, childSession.id)}`
            + '（子任务的知识库副本随后会被删除，所以需要的结论用 `fs_read` 从那份摘要里取）。'
            + (worktree
              ? `\n它跑在隔离副本里（${worktree.path}）。副本会在它结束后自动回收：记录搬到 `
                + `${join('.she', 'subagent-history', childSession.id)}，改动补丁也写在那里；`
                + '所以"过程"要从那份记录里看，不是从副本目录里看。'
              : ''),
          handoff: req.handoff,
          worktree: collectWorktree('子任务仍在后台运行，改动清单要等它结束后再取。'),
          isolation: isolationInfo(),
        };
      };
      if (req.background) return handOff();

      const started = Date.now();
      /*
       * The heartbeat: a reading of the child, every few seconds, for as long as it runs.
       *
       * The parent agent cannot consume this — it is blocked right here — but the human watching
       * the spinner can, and until now the only thing anyone saw during a subtask was nothing at
       * all. It is best-effort by construction: the reading is wrapped, so a child whose history
       * is mid-write cannot take down the run it is describing.
       */
      const beat = hooks?.progress
        ? setInterval(() => {
          try {
            const p = readChildProgress(child.getHistory());
            hooks.progress?.({
              description: req.description,
              elapsedMs: Date.now() - started,
              steps: p.steps,
              activity: p.activity,
            });
          } catch { /* a progress reading must never break the run it describes */ }
        }, SUBAGENT_HEARTBEAT_MS)
        : undefined;
      beat?.unref?.();

      try {
        while (Date.now() - started < budgetMs + 2_000) {
          const finished = await Promise.race([
            job.then((r) => ({ ready: true as const, r })),
            new Promise<{ ready: false }>((r) => setTimeout(() => r({ ready: false }), 300)),
          ]);
          if (finished.ready) return finished.r;
          if (detachParents.has(parentSessionId)) return handOff();
        }
        return handOff();
      } finally {
        if (beat) clearInterval(beat);
      }
    },
  };
}

/**
 * Where a child's private knowledge base lives: one file per child session, in the app directory.
 *
 * The app directory rather than the project or the worktree. A copy is scaffolding, not work
 * product: inside a worktree it appeared as an untracked `.she/` in the changed-files list the
 * parent reads, and inside the project it would be a second knowledge base a user could mistake for
 * theirs. Outside both, there is nothing to confuse it with, and the path is derived from the child
 * session id — so the file is findable when something goes wrong and cannot collide with a sibling.
 *
 * Returns null when the directory cannot be created, which is the one case where the caller has to
 * fall back to the parent's own file with writes refused. Failing the spawn instead would turn a
 * disk problem into an unusable feature.
 */
function subagentKbPath(sessionId: string): string | null {
  try {
    const dir = join(appDir(), 'subagent-kb');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${sessionId}.sqlite`);
  } catch (err) {
    log.warn(`子任务知识库副本目录不可用（子级将共享父级库且只读）: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Write the child's notes to a markdown file inside the workspace, and return its path.
 *
 * Needed when the notes cannot all fit in the reply, and for a background child — whose reply was
 * already sent before the child finished, so the digest is the only thing it can leave behind. The
 * file goes under the workspace's `.she/` (unlike the KB copy, which goes to the app directory)
 * because that is the only place the parent's own file tools can reach: a path outside the
 * workspace is one `fs_read` refuses.
 *
 * Returns undefined when the write fails. The reply then says how many notes were dropped without
 * promising a file that is not there — a dangling pointer is worse than an admitted gap, because
 * the parent would have nothing to act on in either case and no way to tell that it was misled.
 */
/**
 * 子任务笔记摘要的落点（工作区相对路径）。
 *
 * 前缀来自 `sessionStateRelDir`，不在这里拼：写入方（`writeHarvestDigest`）和提前报给父级的那条交接
 * 消息（后台子任务结束时父级拿到的路径）都从这里取，两处各自拼一次就是经典的"两份缓存键"问题 ——
 * 其中一处改了、另一处没改，父级会拿到一个指向空气的路径，而它没法分辨"笔记没写"和"路径错了"。
 */
function harvestDigestRelPath(parentSessionId: string, childSessionId: string): string {
  return join(
    sessionStateRelDir(parentSessionId),
    'notes', `${encodeSessionId(childSessionId)}.md`,
  );
}

function writeHarvestDigest(root: string, parentSessionId: string, childSessionId: string, harvest: SubagentKbHarvest): string | undefined {
  if (!harvest.notes.length) return undefined;
  try {
    const rel = harvestDigestRelPath(parentSessionId, childSessionId);
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    const body = [
      `# 子任务笔记（子会话 ${childSessionId}）`,
      '',
      '子任务在自己的知识库副本里写下的内容。副本已经删除，这里是这些笔记唯一的一份。',
      '值得留的用 `kb_upsert` 搬进主库（组名按内容自定），其余不用管。',
      '',
      ...harvest.notes.map((n) => [`## ${n.title}（${n.kind}）`, '', n.content, ''].join('\n')),
    ];
    writeFileSync(file, body.join('\n'), 'utf8');
    return file;
  } catch (err) {
    log.warn(`子任务笔记摘要写入失败（只影响这一份备份）: ${(err as Error).message}`);
    return undefined;
  }
}

function configForRoot(root: string): SheConfig {
  const abs = resolve(root);
  if (sameDb(abs, config.workspace.root)) return config;
  const kb = resolveWorkspaceKbPath(abs);
  return {
    ...config,
    workspace: { ...config.workspace, root: abs },
    kb: { ...config.kb, dbPath: kb.dbPath },
  };
}

/**
 * Give a child the parent's memory.
 *
 * A worktree materialises tracked files, so `<worktree>/.she/` never exists: the child opened a
 * brand-new KB, and every `kb_query` answered "no record" about a project whose history the parent
 * had just described to it in the handoff. The prompt promises the group KB is the default memory,
 * so an empty one is not isolation, it is amnesia — and the child has no way to tell the difference
 * between "this project has no such note" and "my memory was reset".
 *
 * The fix is a copy rather than a shared file: the child reads the parent's knowledge, and anything
 * it writes lands in the copy, which cannot reach the parent's memory. Cheap — the file is tens of
 * kilobytes, and the copy happens once per spawn. The copy is not a dead drop: `takeKbNotes` reads
 * it back when the child ends and deletes it (see the call site in `makeSubagentRunner`).
 *
 * Returns a phrase for the handoff, because a child that is told nothing will assume it can read
 * anything it likes and blame the project when it cannot.
 */
function seedIsolatedKb(parentKbPath: string, childKbPath: string): 'snapshot' | 'shared' | 'empty' {
  const from = resolve(parentKbPath);
  const to = resolve(childKbPath);
  // Same path means no private copy was available at all (see `subagentKbPath`), so the child is
  // already looking at the parent's KB — say so rather than describing a copy that never happened.
  if (from === to) return 'shared';
  // A live sqlite can be copied while held open, but only if the copy is actually readable: a
  // half-written file would give the child a database that fails to open, and "your memory is
  // corrupt" is a worse answer than "your memory is empty". Verified by opening it, not by size.
  const usable = (p: string): boolean => {
    try {
      const probe = new KBStore(p);
      probe.getStats();
      probe.close();
      return true;
    } catch {
      return false;
    }
  };
  if (existsSync(to) && usable(to)) return 'snapshot';
  if (!existsSync(from)) return 'empty';
  try {
    copyKbFile(from, to);
    if (usable(to)) return 'snapshot';
    log.warn(`子任务知识库快照不可读，已丢弃: ${to}`);
    rmSync(to, { force: true });
    return 'empty';
  } catch (err) {
    log.warn(`子任务知识库快照失败（它将以空库运行）: ${(err as Error).message}`);
    return 'empty';
  }
}

function makeAgent(cfg: SheConfig, sessionId?: string | null): Agent {
  const local = configForRoot(sessionId ? rootForSession(sessionId) : cfg.workspace.root);
  const shell = new SandboxShell(local.workspace.root, local.sandbox);
  const base = createTools(shell, local.workspace.root, {
    allowAllCommands: local.sandbox.allowAllCommands,
    outsideWorkspace: local.sandbox.outsideWorkspace,
    // The KB is reachable only through `kb_*`; raw access is refused by the shell itself.
    kbDbPath: local.kb.dbPath,
    // 控制面凭据同样拒绝直读：读得到就等于能给自己换一套沙箱档位（见 control-token.ts）。
    controlTokenPath: controlAuth?.token ? controlAuth.path : undefined,
  });

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
  /*
   * MCP is two static tools appended last (`mcp_list`, `mcp_call`; never shadowing a built-in or
   * plugin name). They are NOT trusted: an MCP server is its own process outside the sandbox, so
   * every `mcp_call` goes through the same confirm-ticket gate as a dangerous built-in
   * (`needs_confirm` -> user approves -> re-run with the ticket, bound to server + tool +
   * arguments), unless the workspace runs with allowAllCommands. `mcp_list` is read-only.
   */
  const taken = new Set([...base.definitions, ...plugins.definitions()].map((d) => d.name));
  const merged = {
    definitions: [...base.definitions, ...plugins.definitions(), ...mcp.definitions().filter((d) => !taken.has(d.name))],
    execute: (name: string, args: Record<string, unknown>): Promise<string> => {
      if (base.definitions.some((d) => d.name === name)) return base.execute(name, args);
      if (mcp.owns(name) && !taken.has(name)) {
        return mcp.execute(name, args, {
          requireConfirm: !local.sandbox.allowAllCommands,
          workspaceRoot: local.workspace.root,
        });
      }
      return plugins.execute(name, args, local.workspace.root);
    },
    /*
     * The three job hooks are forwarded, not dropped.
     *
     * `merged` is a new object, so anything it does not name does not exist as far as the agent is
     * concerned. Forgetting these would leave every background job of a cached agent running after
     * the session is deleted — the process outlives the reference by design, which is why disposal
     * has to reach the shell that owns it.
     */
    dispose: () => base.dispose?.(),
    runningJobs: () => base.runningJobs?.() ?? [],
    setProgressSink: (sink: ((text: string) => void) | null) => base.setProgressSink?.(sink),
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
 * The run-trace store for one conversation.
 *
 * Keyed by (root, session): a trace is written under the session's own directory, so there is a
 * different store per conversation rather than one for the process. Cached because the panel polls
 * every few seconds and each construction would re-list the directory; the cache is dropped when
 * the workspace root changes, which is the only thing that invalidates it.
 *
 * Built directly rather than taken from a session's `Agent`, because the run list has to be
 * readable BEFORE any turn in this process has ever run — "show me what happened last time" is
 * asked on a fresh start, which is precisely when no agent object exists yet.
 */
const runTraces = new Map<string, RunTraceStore>();
let runTracesRoot = '';
function runTraceStore(sessionId: string): RunTraceStore {
  const root = resolve(config.workspace.root);
  if (runTracesRoot !== root) {
    runTraces.clear();
    runTracesRoot = root;
  }
  let store = runTraces.get(sessionId);
  if (!store) {
    store = new RunTraceStore(root, sessionId);
    runTraces.set(sessionId, store);
  }
  return store;
}

/**
 * Every conversation's runs, newest first — the explicit "show me other sessions too" view.
 *
 * Only ever called for `scope=workspace`, which the panel asks for when the user clicks the other
 * filter. Nothing on the default path reaches it. It exists because "what has this workspace been
 * doing" is a real question and the answer would otherwise be lost with the shared directory; what
 * changed is that it is now a read the user has to ask for, across directories that say whose runs
 * they are, rather than the shape of the only file that existed.
 *
 * Per-session caps rather than one cap over the merge: with a single global cap, one conversation
 * with a hundred runs would push every other conversation out of the view entirely.
 */
function runsAcrossSessions(root: string, limit: number): RunSummary[] {
  const merged: RunSummary[] = [];
  for (const id of listSessionIds(root)) {
    merged.push(...runTraceStore(id).list({ limit }));
  }
  // Newest first, on the timestamp each run recorded for itself. A run with no parseable start
  // (a damaged first line) sorts last rather than at the epoch, so it cannot censor the list.
  return merged
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))
    .slice(0, limit);
}

/**
 * The confidence mirror for one conversation.
 *
 * Cached the same way as the store above, and for the same reason: `GET /api/reflection` has to
 * work on a fresh process, before any session has produced an `Agent`. Each instance keeps an
 * in-memory copy of both files.
 *
 * The session id is what decides which per-conversation samples are readable; the cross-session
 * verdict comes from the workspace ledger either way, so a request with no session still gets a
 * calibration reading rather than a blank.
 */
const reflectionMirrors = new Map<string, ConfidenceMirror>();
let reflectionMirrorsRoot = '';
function reflectionMirror(sessionId: string | null): ConfidenceMirror {
  const root = resolve(config.workspace.root);
  if (reflectionMirrorsRoot !== root) {
    reflectionMirrors.clear();
    reflectionMirrorsRoot = root;
  }
  const key = sessionId ?? '';
  let mirror = reflectionMirrors.get(key);
  if (!mirror) {
    mirror = new ConfidenceMirror(root, sessionId);
    reflectionMirrors.set(key, mirror);
  }
  return mirror;
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
    const created = createSession(sessions, task.name, {
      directory: resolve(config.workspace.root),
      background: true,
    });
    sid = created.id;
    // Remember it, so the next run appends to the same conversation instead of
    // scattering output across a new session every time.
    schedule.recordRun(task.id, { sessionId: sid });
  }

  const agent = agentForSession(sid);
  // A busy conversation queues the task rather than failing it (see SessionBusyError).
  if (agent.isRunning()) throw new SessionBusyError();
  const turnStart = Date.now();
  const usageBefore = agent.getTokenUsage();
  try {
    const reply = await agent.chat(task.prompt);
    /*
     * A turn can fail WITHOUT throwing: `chat()` turns a provider error into a normal-looking
     * assistant message so the conversation stays usable. For a headless run that would be the
     * worst outcome — the schedule would report `ok` for a night of unreachable-API failures, and
     * the streak/retry/alert path (第四轮 8b) would never engage. The run is a failure unless the
     * turn itself finished, and it is thrown so the scheduler records it like any other.
     *
     * Three reasons are not errors but still mean the run did not deliver: `aborted` (the user
     * pressed stop on this job's session), `budget` and `max_iterations` (a ceiling was reached —
     * `agent.ts` calls these "not an error" because the conversation can be resumed). They are
     * recorded as failures so an unfinished job is never reported as done, but they are NOT
     * retried: restarting work the user just stopped is worse than useless, and the next run
     * would hit the same ceiling with the same prompt.
     */
    const failure = agent.lastRunFailure();
    if (failure) {
      recordTurnMetrics(agent, turnStart, usageBefore, false);
      const message = `这一轮没有完成（${failure.reason}）：${failure.text ?? '未给出原因'}`;
      const stoppedOnPurpose = failure.reason === 'aborted'
        || failure.reason === 'budget'
        || failure.reason === 'max_iterations';
      throw stoppedOnPurpose ? new TaskNotRetryableError(message) : new Error(message);
    }
    // A one-line breadcrumb so a run is identifiable in the transcript.
    const note = `[定时任务「${task.name}」] ${reply.content?.slice(0, 200) ?? ''}`;
    log.info(note);
    recordTurnMetrics(agent, turnStart, usageBefore, true);
    auditGuardrail(agent, sid, '定时任务');
  } catch (err) {
    if (err instanceof TurnInProgressError) throw new SessionBusyError();
    recordTurnMetrics(agent, turnStart, usageBefore, false);
    throw err;
  } finally {
    persistHistory(sid);
  }
}

/** Why a task's conversation cannot take a turn now; null when it can. */
function scheduledTaskBusy(task: ScheduledTask): string | null {
  const sid = task.sessionId;
  if (!sid) return null;
  const agent = agents.get(sid);
  return agent?.isRunning() ? '目标会话正在进行一轮对话' : null;
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
      // The model is a reader of this list too: a task that keeps failing has to say so, or the
      // agent will report "定时任务正常" while the evidence says otherwise.
      alert: failureAlert(t) ?? undefined,
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

/**
 * The session named by the request itself — deliberately WITHOUT the "current session" fallback.
 *
 * `sessionIdOf` answers "which conversation should this act on", and falling back to the active one
 * is right for that question. It is the wrong answer for reading another conversation's raw
 * material — a run's prompt, its tool arguments, its output — because the caller who forgot the id
 * would silently be served whichever conversation the server happened to touch last, which is
 * exactly the cross-session read this layout was built to make impossible. These routes would
 * rather refuse loudly and name the missing parameter.
 */
function explicitSessionIdOf(req: import('node:http').IncomingMessage): string {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const header = req.headers['x-session-id'];
  const raw = url.searchParams.get('session_id') || (Array.isArray(header) ? header[0] : header) || '';
  return typeof raw === 'string' ? raw.trim() : '';
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
    const created = createSession(sessions, undefined, { directory: resolve(config.workspace.root) });
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
    /*
     * An id nobody stored is a session the CALLER addressed, not the one on screen.
     *
     * This used to be `sessions.syncActive(disk)`, which wrote the transcript into the ACTIVE
     * conversation: posting to an unknown `session_id` erased the chat the user was reading.
     * Creating the session keeps the addressed id addressable, and `ensure` leaves `active_id`
     * alone so the conversation on screen is not replaced by one nobody opened.
     */
    else {
      sessions.ensure(sid, { directory: resolve(config.workspace.root) });
      sessions.update(sid, { messages: disk });
    }
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
 * The predicate lives in `scratch-workspace.ts` so it can be tested without booting a server;
 * see there for why it needs both the temp-directory and the naming signal.
 */

/**
 * Point the process at another project without killing sessions that are
 * already pinned to their own directory or still running.
 *
 * A full dispose made "open the other project's chat" abort every parallel
 * turn. Pinned sessions keep the agent that was built for their directory.
 */
function mountWorkspace(root: string, sessionId?: string): ChatSession | null {
  persistHistory();
  const next = resolve(root);
  const prev = resolve(config.workspace.root);
  if (prev !== next) {
    const prevKb = config.kb.dbPath;
    config.workspace.root = next;
    config.kb.dbPath = resolveWorkspaceKbPath(next).dbPath;
    if (!sameDb(prevKb, config.kb.dbPath)) {
      /*
       * Hand the outgoing knowledge base to the sessions still pinned to it instead of closing it.
       *
       * An agent is built with the engine for its session's directory and holds that reference for
       * the session's life, and this switch deliberately keeps pinned sessions running. Closing the
       * engine here therefore undid precisely what the switch promises: on 2026-09-27 a switch at
       * 16:34 left a 14-hour session calling a released connection — `The database connection is
       * not open` on every `kb_*` and `errorbook_*` call, while the UI (which reads the freshly
       * mounted store) looked perfectly healthy — and only a restart brought it back. Parking it in
       * the extra-engine cache lets `engineFor()` hand those sessions the same live connection.
       */
      if (engineAlive(engine)) extraEngines.set(pathKey(prevKb), engine);
      remountKnowledgeBase(config.kb.dbPath, { closeCurrent: false });
    }
    const nextState = resolveStateDir(config);
    /*
     * Compared by identity, not by spelling. Two spellings of one directory resolve to one state
     * directory, and a raw string compare would tear down and rebuild both stores for no reason —
     * dropping the in-memory copies a live agent's session is pinned to. One directory is one
     * state directory.
     */
    if (pathKey(nextState) !== pathKey(stateDir)) {
      mountStateDir(nextState);
      for (const [id, agent] of [...agents]) {
        if (agent.isRunning()) continue;
        const pinned = findSession(id)?.session.directory;
        if (pinned) continue;
        dropAgent(id);
      }
    }
    try { rememberProject(projectIndexFile(), next); } catch (err) {
      log.warn(`记录项目目录失败: ${(err as Error).message}`);
    }
    /*
     * Remember this workspace as the default for the next launch — unless it is a scratch directory,
     * which is used now and forgotten on restart (see `isScratchWorkspace`).
     */
    if (isScratchWorkspace(next)) {
      log.info(`临时工作区 ${next} 不写入 .env 默认（下次启动不会回到这里）`);
    } else {
      try { updateEnvFile(ENV_PATH, { SHE_WORKSPACE: next }); } catch { /* non-fatal */ }
    }
  }

  let chosen: ChatSession | null = null;
  if (sessionId) {
    const found = findSession(sessionId);
    if (found && sameDb(found.session.directory || found.store.rootDir, sessions.rootDir)) {
      chosen = found.store.setActive(sessionId);
    } else if (found) {
      chosen = found.session;
    }
  }
  if (!chosen) chosen = pickStartupSession();
  if (chosen) {
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
  } else {
    /*
     * 这个工作区里一条会话都没有。**这是一个正常状态，不该被自动补上。**
     *
     * 清掉 `activeAgentId`：它现在指着上一个工作区的会话（切工作区时刚 persist 过），留着会让
     * "当前会话"在这个工作区里指向一条不存在的记录。
     */
    activeAgentId = null;
  }

  /*
   * 把 2026-09-27 拆出去、按会话存的计划和备忘收回到工作区那一份里。
   *
   * 放在 mount 里而不是"启动时跑一次"：工作区可以在运行期切换，而"该并回来的东西"是随工作区走的 ——
   * 启动时只并了当初那个工作区，之后切到另一个，它自己的历史条目会一直留在没人读的路径上。迁移可重复
   * 执行（没有可并的就是空操作），所以每次 mount 都跑得起。
   *
   * 失败不阻断启动：迁移是修历史数据，不该让一个坏文件把工作区卡住 —— 但要说出来，否则"计划怎么还是
   * 少了"会变成下一次同样的排查。
   */
  try {
    const plans = adoptSessionPlansIntoWorkspace(config.workspace.root);
    const memos = adoptSessionMemosIntoWorkspace(config.workspace.root);
    if (plans.adopted || plans.updated || memos.adopted || memos.updated) {
      log.info(
        `状态迁移到工作区级：计划 新增${plans.adopted}/更新${plans.updated}，备忘 新增${memos.adopted}/更新${memos.updated}`,
      );
    }
  } catch (err) {
    log.warn(`工作区级状态迁移失败（不影响启动）: ${(err as Error).message}`);
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
   * Who the caller is, according to the server.
   *
   * Requires a token like every other route, which is what makes the answer worth anything: a 200
   * here means the token you hold is one the server accepts, and `tenant` names the data you can
   * reach. It never echoes the token back — a client that has it does not need it returned, and a
   * response is one more place it could be logged.
   */
/**
 * 重新从环境变量读一遍令牌，供改动配置的路由调用。
 *
 * `tenancy` 是模块级的（每个请求都要看它），代价是改 `SHE_AUTH_TOKEN(S)` 本来要重启才生效。
 * 配置错误**保留**而不是抛出：下一个请求会带着原因被拒（`tenancyError`）—— 热改配置时，"fail
 * closed"要长成这个样子，而不是让进程在编辑到一半时死去。
 */
function reloadTenancy(): void {
  try {
    tenancy = loadTenancy(process.env);
    tenancyError = null;
  } catch (err) {
    tenancyError = err instanceof Error ? err.message : String(err);
  }
}

  router.get('/api/auth/status', (_req, res) => {
    sendJSON(res, {
      enabled: tenancy.enabled,
      tenant: currentTenant() ?? tenancy.implicit,
      /** Where the token is expected, so a client does not have to guess (or use a query string). */
      header: AUTH_HEADER,
      /** How many tenants exist. Not their ids: that is a list of who else uses this install. */
      tenants: tenancy.tenants.length,
    });
  });

/**
 * 打开/关闭 API 认证，从设置页来。
 *
 * 为什么是一条路由而不是"自己改 .env"：这里要防的错是**操作者以为自己受保护**（或反过来，一把锁
 * 把自己关在外面）。输入用服务端启动时那套解析器校验（`loadTenancy`），所以太短、重复的令牌会当场
 * 拿到那条规则自己的话，而不是重启之后每个请求都被拒。
 *
 * 令牌一个字都不回显。`token` 写单用户那一格，`tokens` 写多租户那一格，`disable: true` 两格都删。
 */
  router.put('/api/auth/config', async (req, res) => {
    const body = await parseBody<{ token?: string; tokens?: string; disable?: boolean }>(req);
    const patch: Record<string, string | null> = {};

    if (body.disable === true) {
      patch.SHE_AUTH_TOKEN = null;
      patch.SHE_AUTH_TOKENS = null;
    } else if (typeof body.tokens === 'string' && body.tokens.trim()) {
      const multi = body.tokens.trim();
      try {
        loadTenancy({ SHE_AUTH_TOKENS: multi });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      patch.SHE_AUTH_TOKENS = multi;
      patch.SHE_AUTH_TOKEN = null;
    } else if (typeof body.token === 'string' && body.token.trim()) {
      const single = body.token.trim();
      try {
        loadTenancy({ SHE_AUTH_TOKEN: single });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      patch.SHE_AUTH_TOKEN = single;
      patch.SHE_AUTH_TOKENS = null;
    } else {
      throw new HttpError(400, 'Missing required field: token, or tokens, or disable: true');
    }

    updateEnvFile(ENV_PATH, patch);
    for (const key of ['SHE_AUTH_TOKEN', 'SHE_AUTH_TOKENS']) {
      const value = patch[key];
      if (value === null) delete process.env[key];
      else if (value !== undefined) process.env[key] = value;
    }
    reloadTenancy();
    // 审计里只记"做了什么"，不记令牌（与 tenant_adopt 那条一致）。
    auditSafe({
      kind: 'config',
      change: body.disable === true
        ? 'disable_api_auth'
        : patch.SHE_AUTH_TOKENS ? 'set_api_auth_multi' : 'set_api_auth_single',
      note: body.disable === true ? '关闭 API 认证（回到本机开放）' : `开启/更新 API 认证：${tenancy.tenants.length} 个租户`,
    });
    sendJSON(res, {
      ok: true,
      enabled: tenancy.enabled,
      tenants: tenancy.tenants.length,
      header: AUTH_HEADER,
    });
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
      queued: schedulerInstance?.waiting() ?? [],
      tasks: schedule.list().map((t) => ({
        ...t,
        nextRun: describeNextRun(t, workingWindow(), now),
        // The one-line "this needs your attention" sentence, or null. Same function the bridge and
        // the panel use, so the three surfaces cannot drift (第四轮 8b).
        alert: failureAlert(t),
      })),
      alerts: schedule.list()
        .map((t) => ({ id: t.id, name: t.name, text: failureAlert(t) }))
        .filter((a): a is { id: string; name: string; text: string } => a.text !== null),
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
    sendJSON(res, { ok: true, started: true, ...(result.reason ? { queued: true, note: result.reason } : {}) });
  });

  /**
   * In-flight turn state per session, so a window that left and came back can re-attach live.
   *
   * History is persisted per finished message, so a window that returns mid-turn and only polls
   * `/api/chat/history` sees the current round's reasoning only once that round ends: the chain of
   * thought appeared in one lump after thinking finished instead of streaming. `/api/chat/attach`
   * replays the current round's partial reasoning/text and then forwards every new chunk.
   */
  const liveTurns = new Map<string, { reasoning: string; text: string; subs: Set<(c: StreamChunk | null) => void> }>();
  function liveTap(sid: string, chunk: StreamChunk): void {
    const t = liveTurns.get(sid);
    if (!t) return;
    if (chunk.type === 'reasoning') t.reasoning += chunk.content ?? '';
    else if (chunk.type === 'text') t.text += chunk.content ?? '';
    else if (chunk.type === 'tool_call_start' || chunk.type === 'done') { t.reasoning = ''; t.text = ''; }
    for (const sub of t.subs) { try { sub(chunk); } catch { /* one bad listener must not stop the turn */ } }
  }
  function liveEnd(sid: string): void {
    const t = liveTurns.get(sid);
    if (!t) return;
    liveTurns.delete(sid);
    for (const sub of t.subs) { try { sub(null); } catch { /* ignore */ } }
  }

  router.post('/api/chat/attach', async (req, res) => {
    const body = await parseBody<{ session_id?: string }>(req).catch(() => ({ session_id: undefined }));
    const sid = sessionIdOf(req, body);
    const t = liveTurns.get(sid);
    startSSE(res);
    if (!t) {
      sendSSEEvent(res, { type: 'done', content: '' });
      endSSE(res);
      return;
    }
    if (t.reasoning) sendSSEEvent(res, { type: 'reasoning', content: t.reasoning });
    if (t.text) sendSSEEvent(res, { type: 'text', content: t.text });
    const sub = (c: StreamChunk | null) => {
      if (c) { sendSSEEvent(res, c); return; }
      t.subs.delete(sub);
      sendSSEEvent(res, { type: 'done', content: '' });
      endSSE(res);
    };
    t.subs.add(sub);
    res.on('close', () => { t.subs.delete(sub); });
  });

/**
 * How often a streaming turn writes its transcript to disk.
 *
 * It is a crash-safety copy, not the deliverable: the turn is persisted in full when it ends
 * (`finally`), and bulky tool output already lives on disk under `.she/sessions/<id>/tool-output/`.
 * Each write here rewrites the WHOLE session store — measured at 5.3 MB — so the old 2-second
 * cadence turned one long turn into hundreds of megabytes of writes, and on a workspace inside an
 * indexed folder (a Desktop directory) into continuous indexer and antivirus work: what the user
 * reported as the machine stalling while the app was open. Ten seconds bounds the loss after a hard
 * crash to a few tool rows and cuts the churn by 5x; unchanged content is skipped entirely
 * (see `saveStateFile`).
 */
const STREAM_PERSIST_MS = 10_000;

  router.post('/api/chat', async (req, res) => {
    const body = await parseBody<{
      message: string;
      stream?: boolean;
      session_id?: string;
      /** Pasted/dropped attachments, already uploaded and living under .she/attachments/. */
      images?: Array<{ path?: string; mime?: string }>;
    }>(req);
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
    /*
     * Attachments, validated at the edge.
     *
     * An entry with no path is dropped here rather than becoming a transcript line that says
     * nothing; one whose FILE cannot be read is kept and reported to the model as text (see the
     * providers). The cap is a guard on the request, not on the feature: eight screenshots in one
     * turn is already far past what a person does deliberately.
     */
    const images = Array.isArray(body.images)
      ? body.images
        .map((i) => ({ path: String(i?.path ?? '').trim(), mime: String(i?.mime ?? '').trim() }))
        .filter((i) => i.path)
        .slice(0, MAX_CHAT_IMAGES)
      : undefined;
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
      liveTurns.set(sid, { reasoning: '', text: '', subs: new Set() });
      try {
        let lastPersist = 0;
        const reply = await agent.chat(message, (chunk: StreamChunk) => {
          sendSSEEvent(res, chunk);
          liveTap(sid, chunk);
          const now = Date.now();
          if (now - lastPersist > STREAM_PERSIST_MS) {
            lastPersist = now;
            try { persistHistory(sid); } catch { /* the final persist still runs */ }
          }
        }, images);
        recordTurnMetrics(agent, turnStart, usageBefore, true);
        auditGuardrail(agent, sid, '对话');
        sendSSEEvent(res, { type: 'done', content: reply.content });
        endSSE(res);
      } catch (err) {
        recordTurnMetrics(agent, turnStart, usageBefore, false);
        // Say where it failed (模型端错误 / 网络问题 / 本地错误), not just the raw message.
        const kind = classifyLlmFailure(err);
        sendSSEEvent(res, { type: 'error', error: (err as Error).message, kind, label: failureLabel(kind) });
        endSSE(res);
      } finally {
        // Persist even when the provider failed, so the user's turn is never lost.
        persistHistory(sid);
        liveEnd(sid);
      }
      return;
    }

    {
      const turnStart = Date.now();
      const usageBefore = agent.getTokenUsage();
      try {
        const reply = await agent.chat(message, undefined, images);
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

  /* ───────────────────────── OpenAI 兼容面 ─────────────────────────
   *
   * 这个仓库自己的 `POST /api/chat` 是**为界面写的**：chunk 是本项目的形状、会话是显式参数、状态行
   * 说中文。对外要的是另一件东西 —— 一个**约定俗成的形状**：`POST /v1/chat/completions`，任何
   * OpenAI 客户端（官方 SDK、别的编辑器、一段脚本）都能接。有了它，"这个 Agent"才从"能用界面聊的
   * 东西"变成"能被程序调用的东西"。
   *
   * 三件必须说清的事（`docs/openai-api.md` 与 `scripts/openai-api-check.mjs` 是同一条规则的三处表达）：
   *
   * 1. **会话**。OpenAI 的协议是**无状态**的（每次把整段对话再发一遍），而这个 Agent 是有状态的
   *    （计划、知识库、按会话隔离的状态）。映射规则一句话：客户端给的消息**比现有历史长**就认它
   *    （客户端是权威），**更短**就把最后一条当新输入接在现有历史上。用哪个会话 id 在
   *    `X-She-Session` 头里回给客户端；客户端下次带上 `X-Session-Id` 就是显式的（也就不再有歧义）。
   * 2. **工具**。工具是这个 Agent 自己跑的 —— 客户端**不会**收到 tool_calls，收到的是一段跑完的答复。
   *    客户端发来的 `tool` / `function` 消息不丢：折成一条带标记的 user 消息。它们是别家 agent 的
   *    回显，丢掉会让上下文出现空洞，而这里是唯一能保住它们的地方。
   * 3. **额外读数**（会话 id、上下文分类账、压缩经济学）放在 `x_she` 命名空间下。标准字段照旧，
   *    客户端忽略它也不影响解析。
   */

  /** OpenAI 形状的错误体：客户端按这个形状显示错误，而不是去解析我们自己的 `{ error: string }`。 */
  const openaiError = (res: import('node:http').ServerResponse, status: number, message: string): void => {
    sendJSON(res, {
      error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code: null },
    }, status);
  };

  /**
   * 一条客户端消息 → 本 Agent 的消息。
   *
   * `system` / `user` / `assistant` 直接映射；其余角色（tool / function / developer）折成一条带标记的
   * user 消息。多段内容（OpenAI 的 vision 形状）只取文本段 —— 图片在这里拿不到字节（那需要它的
   * 上传通道，超出这一层的能力），所以不假装收到了图。
   */
  const toAgentMessage = (m: { role?: unknown; content?: unknown }): import('@she/shared').LLMMessage | null => {
    const role = String(m?.role ?? '');
    const raw = m?.content;
    const content = typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
          ? String((p as { text: string }).text)
          : '')).join('')
        : '';
    if (role === 'system' || role === 'user' || role === 'assistant') return { role, content };
    if (!content.trim()) return null;
    return { role: 'user', content: `[客户端提供了 ${role || '未知角色'} 的内容]\n${content}` };
  };

  /**
   * 这个端点后面站着哪个模型。
   *
   * 不是我们最大的特色，但客户端启动时几乎都会问一次；答不上来会被当成"服务不可用"。
   */
  router.get('/v1/models', (_req, res) => {
    sendJSON(res, {
      object: 'list',
      data: [{
        id: config.llm.model || 'she-agent',
        object: 'model',
        created: 0,
        owned_by: config.llm.provider || 'she',
      }],
    });
  });

  router.post('/v1/chat/completions', async (req, res) => {
    let body: { messages?: Array<{ role?: unknown; content?: unknown }>; stream?: unknown; user?: unknown };
    try {
      body = await parseBody(req);
    } catch (err) {
      return openaiError(res, 400, `请求体不是合法 JSON：${(err as Error).message}`);
    }
    const list = Array.isArray(body?.messages) ? body.messages : [];
    if (!list.length) return openaiError(res, 400, 'messages 必须是至少一条消息的数组');

    const mapped = list.map(toAgentMessage).filter((m): m is import('@she/shared').LLMMessage => m !== null);
    const inputAt = mapped.map((m) => m.role).lastIndexOf('user');
    if (inputAt < 0) return openaiError(res, 400, 'messages 里至少要有一条非空的 user 消息');
    const input = mapped[inputAt].content;

    /*
     * 会话：显式头 > `user` 字段 > 由"第一条消息 + 这次输入"算出的稳定指纹。
     *
     * 指纹那条是无状态客户端的默认路径：它每次把整段对话重发一遍，于是同一段对话永远落到同一个
     * 会话上（计划、知识库、会话级状态都跟着它走）。
     */
    const explicit = String(req.headers['x-session-id'] ?? '').trim();
    const userKey = typeof body.user === 'string' ? body.user.trim() : '';
    /*
     * 指纹只用**这段对话的开场消息**，不能带这次输入 —— 无状态客户端每轮都把整段对话重发一遍，
     * 输入每轮都不同，带上它就等于每轮开一条新会话（第一次写的时候正是这么错的，判据当场抓住）。
     */
    const seed = explicit || userKey || (mapped[0]?.content ?? input);
    const sid = explicit || `sess_api_${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
    if (!isSafeSessionId(sid)) {
      return openaiError(res, 400, 'X-Session-Id 不合法（不能含路径分隔符或控制字符，长度 ≤200）');
    }

    const agent = agentFor(req, { session_id: sid });
    /*
     * adopt / append：见文件头上第 1 条。
     *
     * 用**条数**而不是内容比较：客户端常常只改最后一条（重试、编辑），内容比较会得出"完全一样"
     * 却仍然要覆盖的结论；条数够用，而且客户端能预测。两个决定都回在 `X-She-History` 头里。
     */
    /*
     * 比的是**客户端看得见的那部分历史**。
     *
     * 工具行、以及带 tool_calls 的助手行是我们自己产生的，客户端从来没看见过它们。拿总条数比较的
     * 后果是：无状态客户端重发整段对话时，它那段**永远比我们的小**（我们多了工具行），于是每一轮都
     * 被判成 append —— 客户端的编辑与截断全部被无声忽略。投影到同一把尺子上才是可预测的。
     */
    const clientVisible = agent.getHistory()
      .filter((m) => m.role === 'user' || m.role === 'system' || (m.role === 'assistant' && !m.tool_calls?.length));
    const adopted = mapped.length > clientVisible.length;
    if (adopted) agent.setHistory(mapped.slice(0, inputAt));

    const started = Date.now();
    const usageBefore = agent.getTokenUsage();
    const created = Math.floor(started / 1000);
    const model = config.llm.model || 'she-agent';
    const id = `chatcmpl-${started.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const withStatus = String(req.headers['x-she-status'] ?? '') === '1';
    /** 这一轮的用量：`getTokenUsage()` 是累计值，只有调用方知道哪一段是新的。 */
    const turnUsage = () => {
      const now = agent.getTokenUsage();
      const pick = (k: 'prompt_tokens' | 'completion_tokens' | 'total_tokens') =>
        Math.max(0, (now[k] ?? 0) - (usageBefore[k] ?? 0));
      return { prompt_tokens: pick('prompt_tokens'), completion_tokens: pick('completion_tokens'), total_tokens: pick('total_tokens') };
    };

    res.setHeader('X-She-Session', sid);
    res.setHeader('X-She-History', adopted ? 'adopted' : 'appended');

    if (body.stream === true) {
      startSSE(res);
      const chunk = (delta: Record<string, unknown>, finish: string | null) => sendSSEEvent(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      try {
        let streamed = 0;
        const reply = await agent.chat(input, (c) => {
          if (c.type === 'text' && c.content) {
            streamed += c.content.length;
            chunk({ content: c.content }, null);
          } else if (withStatus && c.type === 'status' && c.content) {
            // 非标准事件，只在客户端明确要（X-She-Status: 1）时才发：标准客户端看不见它。
            sendSSEEvent(res, { id, object: 'she.status', created, model, content: c.content });
          }
        });
        /*
         * 一个分片都没有时补上整段答复。
         *
         * 上游把流式关掉（SHE_LLM_STREAM=off）或某个端点干脆不支持流式时，正文是随返回值一次性
         * 到达的 —— 那种情况下**不能**给客户端一个空流（它会显示"模型什么都没说"）。整段作为一个
         * 分片发出去仍然是合法的 SSE 形状。
         */
        if (streamed === 0 && reply.content) chunk({ content: reply.content }, null);
        recordTurnMetrics(agent, started, usageBefore, true);
        persistHistory(sid);
        chunk({}, 'stop');
        endSSE(res);
      } catch (err) {
        recordTurnMetrics(agent, started, usageBefore, false);
        persistHistory(sid);
        /*
         * 流已经开始（headers 发出去了），所以这里**不能**再回 HTTP 错误码 —— 只能把错误作为
         * 一个事件发出去，然后照常收尾。客户端看到的是"流里带了一条错误"，而不是"连接断了"。
         */
        sendSSEEvent(res, {
          id, object: 'she.error', created, model,
          error: { message: (err as Error).message, type: err instanceof TurnInProgressError ? 'conflict' : 'server_error' },
        });
        endSSE(res);
      }
      return;
    }

    try {
      const reply = await agent.chat(input);
      recordTurnMetrics(agent, started, usageBefore, true);
      persistHistory(sid);
      auditGuardrail(agent, sid, '对话');
      sendJSON(res, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply.content }, finish_reason: 'stop' }],
        usage: turnUsage(),
        x_she: {
          session_id: sid,
          history: adopted ? 'adopted' : 'appended',
          context: agent.getContextStatus(),
        },
      });
    } catch (err) {
      recordTurnMetrics(agent, started, usageBefore, false);
      persistHistory(sid);
      const busy = err instanceof TurnInProgressError;
      openaiError(res, busy ? 409 : 500, (err as Error).message);
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
    const agent = agentFor(req, undefined, { createIfMissing: false });
    /*
     * `waiting` 和 `ticket` 是两件事，一起回：
     *
     *   - `ticket` 是确认卡片拿去换批准的凭据（工单本身），
     *   - `waiting` 是**这一轮停着等谁、从什么时候起、工单过没过期**。
     *
     * 分开是因为工单过期之后这一轮**还停在那里**，而一张过期的工单看起来很像"事情结束了"。只有 `waiting`
     * 里那句 `expired` 能把这两件事分开，界面也才有东西可显示 —— 否则用户看到的是一张点不动的卡片，
     * 没有任何一处说明它还在等他。
     */
    sendJSON(res, { ticket: agent.getPendingConfirm(), waiting: agent.getWaitingOn() });
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
        // 0 = 按模型名自动识别。界面要能显示"这个数字是猜的"，所以原样回传。
        contextWindow: config.llm.contextWindow,
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
      /*
       * 联网能力现在的档位（只读披露，改它还是改 `.env`）。
       *
       * 和 `sandbox.isolation` 同一个理由：一次调用会把关键词/地址发给第三方，那么"现在到底会不会
       * 发出去"就必须能被读到，而不是只写在文档里 —— 用户不该靠猜。`describe` 是同一个渲染函数
       * （`WebClient.describe()`），所以设置接口、工具描述、启动日志三处说的是一句话。
       */
      web: {
        provider: config.web.provider,
        describe: new WebClient(config.web).describe(),
      },
      automationMode: config.automationMode !== false,
      sandbox: config.sandbox,
      server: config.server,
      /*
       * 动态上下文/成本面板要读的那几个值。
       *
       * 单价原样回传（包括 0）：界面必须能区分"用户填了 0"和"还没填"，所以这里不做任何"补一个
       * 默认价"的好心 —— 那会让用户以为面板算的钱是有依据的。
       */
      context: {
        compression: config.context.compression,
        allowHistoryReduction: config.context.allowHistoryReduction,
        autoCompact: config.context.autoCompact,
        compactAtShare: config.context.compactAtShare,
        pricing: { ...config.context.pricing },
      },
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
      /** 「允许工作区外命令」勾选框。 */
      allowOutsideWorkspace?: boolean;
      /** 工作区外策略：所有 / 只读 / 拒绝。 */
      outsideWorkspacePolicy?: 'all' | 'readonly' | 'deny';
      kbDbPath?: string;
      skillProfile?: 'dev' | 'liberal' | 'general' | 'custom';
      automationMode?: boolean;
      thinkingLevel?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      fallbackBaseUrl?: string;
      fallbackApiKey?: string;
      fallbackModel?: string;
      fallbackProvider?: 'openai' | 'anthropic';
      /** 动态上下文压缩档位。 */
      compression?: 'off' | 'light' | 'balanced' | 'aggressive' | 'auto';
      /** 是否允许压缩时删减历史。默认 false，且只有显式传布尔值才改。 */
      allowHistoryReduction?: boolean;
      /** 每 100 万 token 的单价。 */
      pricing?: { inputPerMillion?: number; outputPerMillion?: number; cachedInputPerMillion?: number };
      /** 一次的提示词上限（token）。0 = 按模型名自动识别。填错了就在这里改回来。 */
      contextWindow?: number;
      /** 接近窗口上限时自动压缩（天花板救援）。默认开着。 */
      autoCompact?: boolean;
      /** 从窗口的百分之多少开始压。0.1 ~ 1 之间。 */
      compactAtShare?: number;
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
      /*
       * The settings form sends its KB field on EVERY save, and the field is filled with the
       * RESOLVED path (`<workspace>/.she/kb.sqlite`) rather than with the user's own override.
       * Echoing that back as a binding is how a workspace switch silently welds two workspaces
       * onto one knowledge base: the request carries the new root plus the old root's KB path, the
       * new workspace is then bound to the OLD workspace's memory, and neither is isolated any
       * more — the exact thing per-workspace KBs exist to prevent. It also pins the plain default
       * as a "shared library", which then breaks if the folder is moved or cloned.
       *
       * So the echo is recognised and treated as "no override": either the value is this
       * workspace's own default path, or it is the previous workspace's KB while the root is
       * changing in this same request. A genuinely different path is still a real binding.
       */
      const localDefault = resolve(config.workspace.root, '.she', 'kb.sqlite');
      const echoOfPrevious = !sameDb(config.workspace.root, prevWorkspaceRoot)
        && sameDb(p, prevKbDbPath);
      const echoedOwnDefault = Boolean(p) && sameDb(isAbsolute(p) ? p : resolve(config.workspace.root, p), localDefault);
      if (!p || echoOfPrevious || echoedOwnDefault) {
        // Empty = local default for this workspace; drop shared link + env override.
        clearKbLink(config.workspace.root);
        delete process.env.SHE_KB_PATH;
        setEnv('SHE_KB_PATH', '');
        config.kb.dbPath = localDefault;
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

    /*
     * 工作区边界：勾选框 + 档位。
     *
     * 这两个字段也是各写各的，因为界面允许"只改档位"或"只改勾选"。缺省**不动**当前值 —— 这里
     * 不能像 `allowAllCommands` 那样从 automationMode 推，否则用户刚选的档位会在下一次保存别处
     * 设置时被一次没有携带它的请求冲掉。
     *
     * 勾选与「所有」档是同一件事的两种写法（见 config.ts 里 `outsideWorkspace` 的注释）：勾了「所有」
     * 就意味着免审，所以这里同步 `allowAllCommands` 的反向依赖 —— 选了「所有」时把它置真，选别的
     * 档位时把它置假，让那两处（审批层 / 边界层）读到的永远是同一个结论。
     */
    if (typeof body.allowOutsideWorkspace === 'boolean') {
      config.sandbox.outsideWorkspace.allow = body.allowOutsideWorkspace;
      setEnv('SHE_ALLOW_OUTSIDE_WORKSPACE', body.allowOutsideWorkspace ? 'true' : 'false');
    }
    if (body.outsideWorkspacePolicy === 'all' || body.outsideWorkspacePolicy === 'readonly' || body.outsideWorkspacePolicy === 'deny') {
      config.sandbox.outsideWorkspace.policy = body.outsideWorkspacePolicy;
      setEnv('SHE_OUTSIDE_WORKSPACE_POLICY', body.outsideWorkspacePolicy);
    }
    if (
      typeof body.allowOutsideWorkspace === 'boolean' || body.outsideWorkspacePolicy !== undefined
    ) {
      // 只有「勾选 + 所有」才是真正的全放行。其余三档都要经过 `classifyCommand`，所以
      // `allowAllCommands` 必须跟着走 —— 它现在只是这四个状态的派生值，不再是独立开关。
      const open = config.sandbox.outsideWorkspace.allow && config.sandbox.outsideWorkspace.policy === 'all';
      config.sandbox.allowAllCommands = open;
      config.sandbox.denyDestructiveByDefault = !open;
      setEnv('SHE_ALLOW_ALL_COMMANDS', open ? 'true' : 'false');
    }
    if (body.thinkingLevel && THINKING_LEVEL_SET.has(body.thinkingLevel)) {
      config.llm.thinkingLevel = body.thinkingLevel;
      setEnv('SHE_THINKING_LEVEL', body.thinkingLevel);
    }
    /*
     * 动态上下文 / 成本面板。
     *
     * 每一格都单独判断有没有传，而不是用 `?? 默认`：面板是分次保存的（先填单价，再选档位），
     * 用默认值覆盖没传的字段会把用户上一次的选择擦掉。
     *
     * `allowHistoryReduction` 只在**显式传了布尔值**时才改 —— 这是唯一一个会删用户东西的开关，
     * "没传"绝不能被理解成 true。
     */
    if (body.compression && ['off', 'light', 'balanced', 'aggressive', 'auto'].includes(body.compression)) {
      config.context.compression = body.compression;
      setEnv('SHE_CONTEXT_COMPRESSION', body.compression);
    }
    if (typeof body.allowHistoryReduction === 'boolean') {
      config.context.allowHistoryReduction = body.allowHistoryReduction;
      setEnv('SHE_ALLOW_HISTORY_REDUCTION', body.allowHistoryReduction ? 'true' : 'false');
    }
    /*
     * 上下文窗口与天花板救援。
     *
     * 窗口这一格是这套机制里**最可能填错、也最需要能改**的一项：它是按模型名猜的，而猜大了的后果是
     * "该压的时候不压"（那时靠模型端拒绝兜底）。所以它必须能从设置里改，改完必须落盘 —— 否则用户
     * 遇到的就是"我知道要填 32k，但填完重启就没了"。
     *
     * `0` 是合法值（回到自动识别），所以这里判断的是范围而不是真值：`if (body.contextWindow)` 会把 0
     * 当成"没传"，那样这一格就永远关不掉自动识别。
     */
    if (typeof body.contextWindow === 'number' && Number.isFinite(body.contextWindow)
      && (body.contextWindow === 0 || body.contextWindow >= 1024)) {
      config.llm.contextWindow = Math.trunc(body.contextWindow);
      setEnv('SHE_CONTEXT_WINDOW', String(config.llm.contextWindow));
    }
    if (typeof body.autoCompact === 'boolean') {
      config.context.autoCompact = body.autoCompact;
      setEnv('SHE_CONTEXT_AUTO_COMPACT', body.autoCompact ? 'true' : 'false');
    }
    /*
     * 阈值只收 (0.1, 1) 开区间。写坏的阈值（1.5 = 等于关掉、0.05 = 每轮都压）不生效并保留上一个
     * 好值：一个"看起来设了"的阈值如果实际等于关掉，用户会以为自动压缩开着而它永远不会触发。
     */
    if (typeof body.compactAtShare === 'number' && Number.isFinite(body.compactAtShare)
      && body.compactAtShare > 0.1 && body.compactAtShare < 1) {
      config.context.compactAtShare = body.compactAtShare;
      setEnv('SHE_CONTEXT_COMPACT_AT', String(body.compactAtShare));
    }
    if (body.pricing && typeof body.pricing === 'object') {
      for (const key of ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion'] as const) {
        const raw = (body.pricing as Record<string, unknown>)[key];
        if (raw === undefined || raw === null || raw === '') continue;
        const n = Number(raw);
        // 负数/NaN 直接不接受：`NaN` 会让面板把花费显示成 NaN，用户只会觉得这个功能坏了。
        if (!Number.isFinite(n) || n < 0) continue;
        config.context.pricing[key] = n;
        setEnv(
          { inputPerMillion: 'SHE_PRICE_INPUT_PER_MILLION', outputPerMillion: 'SHE_PRICE_OUTPUT_PER_MILLION', cachedInputPerMillion: 'SHE_PRICE_CACHED_INPUT_PER_MILLION' }[key],
          String(n),
        );
      }
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
    if (pathKey(nextStateDir) !== pathKey(stateDir)) {
        persistHistory();
        /* Both stores move together — see `mountStateDir` for why the incoming one must be taken
         * from the cache rather than duplicated. */
        mountStateDir(nextStateDir);
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
      || typeof body.allowOutsideWorkspace === 'boolean' || body.outsideWorkspacePolicy !== undefined
      || body.fallbackBaseUrl || body.fallbackApiKey || body.fallbackModel || body.fallbackProvider
      || typeof body.temperature === 'number' || typeof body.maxTokens === 'number'
      /*
       * 窗口是**构造时**解析并冻结的（`Agent` 的字段），所以改它必须重建 agent —— 只改配置对象
       * 的话，正在跑的那条会话仍然按旧窗口判断。`autoCompact` / `compactAtShare` 不在这里：它们
       * 每次调用都重读一遍配置，改了立刻生效，而重建会把 language server 拆掉（见上面那段注释）。
       */
      || typeof body.contextWindow === 'number',
    );
    if (!structuralChange) {
      for (const agent of agents.values()) agent.setThinkingLevel(config.llm.thinkingLevel || 'medium');
    } else {
      rebuildAgents();
    }
    persistHistory();

    const kbChanged = !sameDb(prevKbDbPath, config.kb.dbPath);
    if (kbChanged) {
      try {
        remountKnowledgeBase(config.kb.dbPath);
      } catch (err) {
        throw new HttpError(500, `知识库挂载失败: ${(err as Error).message}`);
      }
    }
    const restartRequired = !sameDb(prevWorkspaceRoot, config.workspace.root);

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
        // 设置页画那两个控件要用的真实值。`allowAllCommands` 还在返回，是为了兼容旧界面 ——
        // 但它现在是下面这两个字段的派生值，不再是一个可以独立改变的开关。
        outsideWorkspace: {
          allow: config.sandbox.outsideWorkspace.allow,
          policy: config.sandbox.outsideWorkspace.policy,
        },
        /*
         * 姿态与自动化模式之间的张力，如实回给界面。
         *
         * 放在这里而不是让界面自己推：界面推要重复一遍"哪种姿态会在无人值守时停住"的规则，而两处
         * 写同一个判断就是两处会不一致。`null` = 没有张力，界面上不出现任何提示 —— 一条永远出现的
         * 提醒等于没有提醒。
         */
        notice: sandboxPostureNotice(config),
      },
      /*
       * 真隔离（层 4.2）：这台机器能不能开、现在开着没有、要不要说点什么。
       *
       * 默认档位是 `auto`（第七轮从 `off` 改的）：能给边界就用、给不出就退回主机并在这里说明。
       * 改之前 `off` 的道理是"不拿某个平台的假设当所有人的默认"，代价是**这个能力在界面上原本
       * 完全看不见** —— 用户不会去翻一个不知道存在的开关；而 `wsl` 档位在某台机器上用不了时，
       * 命令会被拒绝，拒绝的理由只有日志里的人知道。所以这里把结论直接回给界面：能不能、现在什么
       * 档、以及该说的一句话（`isolationNotice` 决定要不要说，不是界面决定）。
       *
       * 探测惰性 + 进程内记忆（`resolveWslIsolation` 自己缓存）：首次读设置会起一次短命的 wsl.exe
       * （约 1 秒），之后不再付钱；启动本身不为它变慢。
       *
       * 第四个参数是**当前授权**：档位选到「所有」（勾选 + 所有）时真隔离被让开，这一档下
       * `available` 是"这台机器本可以隔离"，而实际跑的是主机 —— `bypassed` 就是这件事的字段，
       * `notice` 会把它说出来。曾经这里只传前三个参数，于是设置页会告诉用户"真隔离开着"，
       * 而命令其实在主机上跑（本机实测 `ver` 在最大授权下仍然 127）。
       */
      isolation: (() => {
        const a = describeIsolation(config.sandbox.isolation, config.workspace.root, config.sandbox.wslDistro, {
          allowAllCommands: config.sandbox.allowAllCommands,
          outsideWorkspace: config.sandbox.outsideWorkspace,
        });
        return { ...a, notice: isolationNotice(a) };
      })(),
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

  /*
   * Attachments: the upload half of pasting an image.
   *
   * Raw body rather than base64 JSON, for the same reason as the wallpaper: a screenshot is
   * already several MB, and base64 inflates it by a third and forces the browser to build the
   * whole string first. The name arrives in `x-filename` because the body is the bytes.
   *
   * What is returned is the PATH, not an id: providers read the bytes at request time, and the
   * transcript stores the path so later turns of the same conversation can still send the image.
   */
  router.post('/api/attachments', async (req, res) => {
    const { buffer, tooLarge } = await readRawBody(req, ATTACHMENT_MAX_BYTES);
    if (tooLarge) {
      throw new HttpError(413, `附件过大（上限 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB）`);
    }
    const header = req.headers['x-filename'];
    const rawName = decodeURIComponent(String(Array.isArray(header) ? header[0] : header || 'attachment'));
    const typeHeader = req.headers['x-mime'];
    const declaredMime = String(Array.isArray(typeHeader) ? typeHeader[0] : typeHeader || '');
    const saved = saveAttachment(config.workspace.root, buffer, rawName, declaredMime);
    sendJSON(res, {
      ...saved,
      /** For the composer's thumbnail; served by the route below. */
      url: `/api/attachments/file?name=${encodeURIComponent(saved.name)}`,
    });
  });

  /** Read one attachment back for preview. Confined to the attachments directory by name. */
  router.get('/api/attachments/file', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const full = resolveAttachmentFile(config.workspace.root, url.searchParams.get('name') ?? '');
    let buf: Buffer;
    try {
      buf = readFileSync(full);
    } catch {
      throw new HttpError(404, '附件不存在');
    }
    res.writeHead(200, {
      'content-type': attachmentMime(full),
      'content-length': String(buf.length),
      'cache-control': 'private, max-age=31536000, immutable',
    });
    res.end(buf);
  });

  /** Where attachments live, so Settings can show and clean the directory. */
  router.get('/api/attachments/dir', (_req, res) => {
    sendJSON(res, { dir: attachmentsDir(config.workspace.root) });
  });

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
    if (!sameDb(prev, config.kb.dbPath)) {
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
      throw new HttpError(500, `知识库发布失败: ${(err as Error).message}`);
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
    if (!existsSync(src)) throw new HttpError(404, `源知识库不存在: ${src}`);

    try { store.close(); } catch { /* ignore */ }
    let result;
    try {
      result = mergeKnowledgeBases(src, target, { label: body.label });
    } catch (err) {
      remountKnowledgeBase(config.kb.dbPath);
      throw new HttpError(500, `合库失败: ${(err as Error).message}`);
    }
    if (!sameDb(target, config.kb.dbPath)) {
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
          return (sid && sessions.get(sid)?.title) || 'Pulse';
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
  /*
   * After any config change the bridge reconnects. Agents are deliberately NOT rebuilt: the MCP
   * tool definitions are static (`mcp_list` / `mcp_call`), so the change is visible through
   * `mcp_list` at once, and a rebuild would only throw away every open session's cached prefix.
   */
  const refreshMcp = async (): Promise<void> => {
    try {
      await mcp.refresh();
    } catch (e) {
      log.warn(`MCP refresh failed: ${(e as Error).message}`);
    }
  };
  const mcpInject = (name: string) => mcp.injectStatus(name);

  router.get('/api/mcp/servers', async (_req, res) => {
    const servers = await listMcpServers(config.workspace.root, mcpInject);
    sendJSON(res, { servers });
  });

  router.post('/api/mcp/servers/:name/probe', async (req, res, params) => {
    const status = await probeMcpServer(config.workspace.root, params.name, mcpInject);
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
    await refreshMcp();
    sendJSON(res, { ok: true, servers: await listMcpServers(config.workspace.root, mcpInject) }, 201);
  });

  router.delete('/api/mcp/servers/:name', async (req, res, params) => {
    const ok = removeMcpServer(config.workspace.root, params.name);
    if (ok) await refreshMcp();
    sendJSON(res, { ok });
  });

  router.put('/api/mcp/servers/:name/enabled', async (req, res, params) => {
    const body = await parseBody<{ enabled?: boolean }>(req);
    const ok = setMcpServerEnabled(config.workspace.root, params.name, body.enabled !== false);
    if (ok) await refreshMcp();
    sendJSON(res, { ok });
  });

  // ── workspace memo (scratchpad for user + agent) ──
  /*
   * 备忘是**工作区级**的（`.she/memo.json`），2026-10-01 起。
   *
   * 2026-09-27 曾把它切成会话私有，理由是"别的会话不该读到我的东西"。那条边界划错了：用户脑子里的边界
   * 是**项目** —— 在一个项目里新开一个对话，昨天记的待办当然还在；按对话分账等于每次开新对话都从空开始
   * 记。跨工作区仍然是路径上不存在（另一个工作区有自己的 `.she/`），边界没变松，只是挪到了用户认识的那
   * 条线上。
   *
   * 因此这些接口**不再要 `session_id`**：本工作区就一份，没有"归属哪个会话"这回事。仍然每次请求现构造
   * store —— 工作区可以在运行期切换（`/api/workspaces/switch`），缓存一个启动期的 root 会把读写落到
   * 上一个工作区上。
   */
  const memoStore = () => new MemoStore(config.workspace.root);

  router.get('/api/memo', (_req, res) => {
    sendJSON(res, { entries: memoStore().list() });
  });

  router.post('/api/memo', async (req, res) => {
    const body = await parseBody<{ text?: string }>(req);
    const text = String(body.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Missing text');
    sendJSON(res, memoStore().add(text, 'user'), 201);
  });

  router.put('/api/memo/:id', async (req, res, params) => {
    const body = await parseBody<{ text?: string; done?: boolean }>(req);
    const entry = memoStore().update(params.id, body);
    if (!entry) throw new HttpError(404, 'Memo not found');
    sendJSON(res, entry);
  });

  router.delete('/api/memo/:id', (_req, res, params) => {
    if (!memoStore().remove(params.id)) throw new HttpError(404, 'Memo not found');
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
      const raw = Array.isArray(j.recent) ? j.recent : [];
      /*
       * One directory is one entry, whatever spelling it was recorded with.
       *
       * This is `pathKey`'s problem again, one layer out. The registry used to compare raw strings,
       * so this machine's list held both `D:\Work\_she-scratch` and `d:\work\_she-scratch` — and
       * the workspace panel renders one row per entry, so it showed the SAME folder twice, one
       * marked 当前 and one marked 1会话. Read as "the isolation is broken": two identical projects
       * sitting side by side. It is not a display artefact either — each row is a separate root the
       * API will happily switch to.
       *
       * Deduplicating on the way in heals registries already written that way, and keeping the
       * first spelling preserves the recency order the list exists for.
       */
      const out: string[] = [];
      const seen = new Set<string>();
      for (const r of raw) {
        const key = pathKey(r);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
      return { recent: out };
    } catch {
      return { recent: [] };
    }
  }

  function rememberWorkspace(root: string): void {
    const { recent } = readWorkspaceRegistry();
    const next = [root, ...recent.filter((r) => pathKey(r) !== pathKey(root))].slice(0, 12);
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
    //
    // Deduplicated the same way the registry is: the mounted root leads, so its spelling wins, and a
    // second entry naming the same directory under another casing cannot render as a second folder.
    const roots: string[] = [];
    const seenRoots = new Set<string>();
    for (const r of [current, ...recent]) {
      const key = pathKey(r);
      if (seenRoots.has(key) || !existsSync(r)) continue;
      seenRoots.add(key);
      roots.push(r);
    }
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
    /*
     * `activeSessionId` 可以是 null：这个工作区里还没有任何会话。界面据此显示空状态，
     * 而不是打开一条刚被凭空造出来的 `New chat`。
     */
    sendJSON(res, {
      ok: true,
      root: config.workspace.root,
      kbDbPath: config.kb.dbPath,
      kbMode: resolveWorkspaceKbPath(config.workspace.root).mode,
      restartRequired: false,
      activeSessionId: active?.id ?? null,
    });
  });

  /**
   * Session list.
   *
   * `recovery` / `migrated` are carried on the response, not just written to the
   * log, because a quarantined file and a deleted one look identical in the UI
   * otherwise: the list is simply shorter, with nothing anywhere explaining why.
   * The banner the UI shows for this is the difference between "the app lost my
   * chats" and "the app kept my chats, here is the file".
   */
  router.get('/api/sessions', (req, res) => {
    // `?all=1` returns closed sessions too, which the history view needs.
    // `?scope=all` also includes sessions that live in other known projects.
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const includeClosed = url.searchParams.get('all') === '1';
    const notices = { recovery: sessions.recoveryNotice, migrated: sessions.migratedNotice };
    if (url.searchParams.get('scope') !== 'all') {
      const own = sessions.list(includeClosed);
      sendJSON(res, { ...own, sessions: visibleToTenant(own.sessions), ...notices });
      return;
    }
    const mine = sessions.list(includeClosed);
    const mineVisible = visibleToTenant(mine.sessions);
    const seen = new Set(mineVisible.map((s) => s.id));
    const extra = [];
    for (const root of projectRoots()) {
      if (sameDb(root, sessions.rootDir)) continue;
      for (const s of visibleToTenant(storeFor(root).list(includeClosed).sessions)) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        extra.push({ ...s, directory: s.directory || root });
      }
    }
    sendJSON(res, { active_id: mine.active_id, sessions: [...mineVisible, ...extra], ...notices });
  });

  /** Closed sessions only (history view). */
  router.get('/api/sessions/history', (_req, res) => {
    sendJSON(res, {
      closed: visibleToTenant(sessions.listClosed()),
      open: visibleToTenant(sessions.list().sessions),
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
    /*
     * "Which store" and "which working directory" are two different questions.
     *
     * `directory` is the folder the session works in; it used to select the store as well. But the
     * store the rail READS is the mounted one (`stateDir`), and those are the same path only while
     * `SHE_STATE_DIR` is unset — it is an explicit storage override, so `stateDir` may name a
     * directory that is not `config.workspace.root`.
     *
     * With the override set, `POST` wrote `<workspace>/.she/sessions.json` while
     * `GET /api/conversations` read `<stateDir>/.she/sessions.json`. Reproduced live: four
     * `POST /api/sessions` all answered 201, the rows landed in the workspace file, and the rail
     * stayed on 暂无会话 while `GET /api/sessions/:id` answered 200 for each id — creates that
     * succeed and then never appear, which is what "the chat I just made is gone" looks like from
     * the outside. A reload did not help, because the list and the create disagreed on disk, not in
     * memory.
     *
     * So the default is the mounted store, and only an explicit `directory` picks another
     * project's. In the common case (`stateDir === workspace.root`) this is exactly the old
     * behaviour.
     */
    const requested = body.directory?.trim();
    const directory = resolve(requested || config.workspace.root);
    if (!existsSync(directory)) throw new HttpError(404, `路径不存在: ${directory}`);
    const owner = requested ? storeFor(directory) : sessions;
    const s = createSession(owner, body.title, { directory, parentId: body.parent_id });
    try { rememberProject(projectIndexFile(), directory); } catch { /* non-fatal */ }
    if (sameDb(owner.rootDir, stateDir)) {
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
    const room = roomHome(params.id)?.store.get(params.id) ?? null;
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
    if (!sameDb(dir, config.workspace.root)) {
      const active = mountWorkspace(dir, params.id);
      /*
       * `params.id` 已经确认存在（上面 404 过了），所以这里拿到 null 是"目标工作区里没有它" ——
       * 报 404，而不是把一条新建的 `New chat` 冒充成用户点的那个会话。
       */
      if (!active || active.id !== params.id) throw new HttpError(404, `Session not found: ${params.id}`);
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

/**
 * 搬会话时**留在原项目**的东西。
 *
 * `extract` / `adopt` 搬的是**会话记录本身**（`sessions.json` 里那一条），磁盘上别的文件一个都不动。
 * 而这些东西按设计都属于「原项目」：
 *
 *   - 计划 / 备忘：**工作区级**（一个项目一份，项目里每条会话读写同一份）。所以它们不只是"没跟着走"，
 *     而是**不该**跟着走 —— 它们记的是那个项目里的活，原项目里其他对话还在读它们。
 *   - 这条会话自己的 `.she/sessions/<id>/`：预检、轨迹、置信度样本。这个是**会话级**的，跟着走才合理，
 *     但路径是按工作区根拼的，所以搬到新项目后它就成了新项目里读不到的一堆孤儿文件。
 *   - 知识库：按目录组织，属于原项目。
 *
 * 以前这些**全部静默留下**：用户搬完会话，看到的是"计划没了、轨迹没了"，而界面上没有任何一处说过
 * 这件事。这里把它们如实报出来，让"计划留在哪"变成回执里的一行，而不是一个猜测。
 */
function strandedState(root: string, sessionId: string): Array<{ kind: string; path: string; detail: string }> {
  const items: Array<{ kind: string; path: string; detail: string }> = [];

  const plans = new PlanStore(root, WORKSPACE_SCOPE).list();
  if (plans.length) {
    const open = plans
      .filter((p) => p.status === 'open')
      .flatMap((p) => p.steps)
      .filter((s) => s.status !== 'done' && s.status !== 'dropped').length;
    items.push({
      kind: 'plan',
      path: join(root, '.she', 'plans.json'),
      detail: `${plans.length} 份计划，共 ${open} 个未完成步骤（工作区级：属于原项目，项目里每条会话都在读它）`,
    });
  }

  const memo = new MemoStore(root).list();
  if (memo.length) {
    items.push({
      kind: 'memo',
      path: join(root, '.she', 'memo.json'),
      detail: `${memo.length} 条备忘（同样是工作区级）`,
    });
  }

  const own = sessionStateDir(root, sessionId);
  if (existsSync(own)) {
    items.push({ kind: 'session_state', path: own, detail: '这条会话的预检 / 轨迹 / 置信度样本（会话级，可以一起带走）' });
  }

  return items;
}

/**
 * 把一个目录挪过去。同盘用 `rename`（原子、瞬间），跨盘（`EXDEV`）退化成"复制 + 删除"。
 *
 * 直接 `renameSync` 在跨盘时抛错，而"工作区换了盘符"是最普通的情况之一 —— 那时候报出来的会是一句
 * 看不懂的 EXDEV，而这件活本身完全做得到。
 */
function movePath(src: string, dst: string): void {
  try {
    renameSync(src, dst);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  cpSync(src, dst, { recursive: true });
  rmSync(src, { recursive: true, force: true });
}

router.post('/api/sessions/:id/move', async (req, res, params) => {
  const body = await parseBody<{
    directory?: string;
    move_changes?: boolean;
    carry_session_state?: boolean;
    carry_plan?: boolean;
  }>(req);
  const dest = resolve(String(body.directory ?? '').trim());
  if (!dest || !existsSync(dest)) throw new HttpError(404, '目标目录不存在');
  const found = findSession(params.id);
  if (!found) throw new HttpError(404, `Session not found: ${params.id}`);
  if (agents.get(params.id)?.isRunning()) {
    throw new HttpError(409, '这一轮还在进行。先停下，再把会话搬到别的项目。');
  }
  const from = resolve(found.session.directory || found.store.rootDir);
  const srcRoot = resolve(found.store.rootDir);

  /*
   * 先算出"会留下什么"，再动任何东西 —— 搬完之后再算，看到的就已经是新状态了。
   *
   * 而且这一步同时是**回执的正文**：`stayed` 会原样回给调用方，所以"计划留在哪"是一句陈述，不是一句
   * 需要用户自己推断的话。
   */
  const stayed = strandedState(srcRoot, params.id);

  const srcStateDir = sessionStateDir(srcRoot, params.id);
  const dstStateDir = sessionStateDir(dest, params.id);
  const srcPlanFile = join(srcRoot, '.she', 'plans.json');
  const dstPlanFile = join(dest, '.she', 'plans.json');

  /*
   * 冲突在**搬任何东西之前**判，两条都要：
   *
   *   - 目标已经有一条同 id 的状态目录：覆盖它等于替别人删状态；
   *   - 目标项目已经有一份自己的计划：`.she/plans.json` 是那个项目的**共享**文件，拿这边的计划盖上
   *     去会改掉那边所有对话读到的计划。这不是"搬运"，是破坏，所以直接拒绝并说清原因，而不是静默覆盖。
   */
  if (body.carry_session_state && existsSync(dstStateDir)) {
    throw new HttpError(409, `目标项目里已经有这条会话的状态目录（${dstStateDir}），拒绝覆盖。先处理它，或不带过去。`);
  }
  if (body.carry_plan && existsSync(dstPlanFile)) {
    throw new HttpError(409, `目标项目已经有一份属于它自己的计划（${dstPlanFile}），不会被这次搬运覆盖。要带过去就先在那边把计划处理掉。`);
  }

  let note = '';
  if (body.move_changes && from !== dest) note = transferLocalChanges(from, dest);
  const taken = found.store.extract(params.id);
  if (!taken) throw new HttpError(404, `Session not found: ${params.id}`);
  taken.directory = dest;

  const carried: string[] = [];
  const warnings: string[] = [];
  if (body.carry_session_state && existsSync(srcStateDir)) {
    try {
      mkdirSync(dirname(dstStateDir), { recursive: true });
      movePath(srcStateDir, dstStateDir);
      carried.push('这条会话的预检 / 轨迹 / 置信度样本');
    } catch (err) {
      warnings.push(`状态目录没搬成：${(err as Error).message}`);
    }
  }
  if (body.carry_plan && existsSync(srcPlanFile)) {
    try {
      mkdirSync(dirname(dstPlanFile), { recursive: true });
      /* 复制而不是移动：原项目里其他对话还在读这份计划，搬走等于替它们删计划。 */
      copyFileSync(srcPlanFile, dstPlanFile);
      carried.push('原项目那份计划（**复制**过去的，原项目保留它）');
    } catch (err) {
      warnings.push(`计划没搬成：${(err as Error).message}`);
    }
  }

  const saved = storeFor(dest).adopt(taken);
  dropAgent(params.id);
  try { rememberProject(projectIndexFile(), dest); } catch { /* non-fatal */ }

  /* 状态目录是**移动**，所以它不再"留下"；计划是复制，所以它照样留在原项目。 */
  const stillThere = carried.includes('这条会话的预检 / 轨迹 / 置信度样本')
    ? stayed.filter((s) => s.kind !== 'session_state')
    : stayed;

  sendJSON(res, { session: saved, note, stayed: stillThere, carried, warnings });
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
      const session = createSession(storeFor(info.path), body.name?.trim() || basename(info.path), { directory: info.path });
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
    // Release the KB handle first: deleting a directory that has a live sqlite file inside it
    // fails on Windows, and the child's KB copy always lives there. A running session keeps its
    // handle, and the delete is refused rather than pulling the KB out from under it.
    if (!disposeWorkspace(path)) {
      throw new HttpError(409, '这个工作区里还有正在运行的会话，等它跑完再删 —— 否则会把它正在用的知识库抽走');
    }
    try {
      removeWorktree(repo, path);
      try { forgetProject(projectIndexFile(), path); } catch { /* 索引清不掉不影响删除 */ }
      sendJSON(res, { ok: true });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  /*
   * 记忆的激活账：哪些节点真的在被用、哪些已经凉了。
   *
   * `accessCount` / `lastAccessedAt` 一直在维护，但从来没有一处把它们成批读回来 —— 于是
   * 「该清理谁」只能凭感觉，也看不见一个节点在变凉之前的样子。只读路由（不触碰任何节点）。
   */
  router.get('/api/kb/activation', (_req, res) => {
    sendJSON(res, activationReport(store, { hot: 10, cold: 10 }));
  });

  router.get('/api/kb/groups', (_req, res) => {
    sendJSON(res, { groups: store.getAllGroups() });
  });

  // ── long-horizon plans (written by the agent's plan_* tools) ──
  /*
   * 计划是**工作区级**的（`.she/plans.json`），2026-10-01 起：一个项目一份，项目里每条会话读到的是同一
   * 份，于是"昨天那个长任务"在新开一个对话里还在，接着做就行。会话 id 只作为来源标记写进
   * `plan.sessionId`，不再决定文件在哪 —— 用户脑子里的边界是项目，不是某一条对话。
   *
   * 2026-09-27 曾按会话分开（`.she/sessions/<id>/plans.json`），边界划在了对话之间，那不是用户认识的
   * 边界。代价是明确的：一个项目同时只有一个进行中计划，别处留下的未收口计划会拦住本会话的
   * `report_write status=done`（工具层会点名是哪几步）。
   *
   * 群计划仍然用自己的作用域（`cluster:<roomId>`）：群是另一个聚合，不是"另一条会话"。
   */
  const planStoreFor = (req: import('node:http').IncomingMessage, body?: { session_id?: string }) => {
    const id = sessionIdOf(req, body);
    const scope = id && id.startsWith(CLUSTER_PLAN_SCOPE_PREFIX) ? id : WORKSPACE_SCOPE;
    return new PlanStore(config.workspace.root, scope, id ?? scope);
  };

  
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

  /**
   * 哪些**目录作用域**里有计划 —— 今天只剩讨论群（`cluster:<roomId>`）。
   *
   * 聊天计划是工作区级的（`.she/plans.json`），本来就在 `/api/plans` 里全部看得见，所以这个接口不再是
   * "看别的会话的那扇门"：那个选择器是为"按会话分文件"而存在的，现在没有必须靠它才能看到的东西了。
   * 留着是因为群计划仍然在自己的目录里，面板要能说出"哪个群有在跟的计划"。
   *
   * 参数仍然必须显式带上：它枚举的是目录名，默认路径上不该有这种接口。
   */
  router.get('/api/plans/sessions', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('scope') !== 'workspace') {
      throw new HttpError(400, 'scope=workspace is required: 枚举目录作用域是一次显式动作');
    }
    sendJSON(res, { sessions: planSessions(config.workspace.root) });
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
    const store = planStoreFor(req, body);
    const result = store.setStepStatus(planId, stepId, status as StepStatus, body.note);
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
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 100;
    const sessionId = sessionIdOf(req);
    /*
     * Two scopes, and the default is the private one.
     *
     * `scope=workspace` is what the panel's "全部会话" filter asks for. It is an explicit read across
     * session directories — the directories say whose runs they are, and each row carries the
     * conversation it belongs to — rather than the old behaviour where every session's runs sat in
     * one file and the filter was the only thing between them.
     */
    const scope = url.searchParams.get('scope') === 'workspace' ? 'workspace' : 'session';

    if (scope === 'session' && !sessionId) {
      /*
       * No conversation at all: an empty list rather than a 400.
       *
       * This route is polled by a panel on a fresh install, where there is genuinely nothing yet and
       * "you forgot the parameter" is not the user's problem. It is NOT a fallback to a shared
       * directory — there is no directory to fall back to, which is the point of the layout.
       */
      return sendJSON(res, {
        root: join(resolve(config.workspace.root), '.she', 'sessions'),
        runs: [], total: 0, paused: 0, failed: 0, scope, session_id: null,
      });
    }

    const root = resolve(config.workspace.root);
    const all = scope === 'workspace' ? runsAcrossSessions(root, limit) : runTraceStore(sessionId).list({ limit });
    /*
     * Counts of the whole scope travel with the list, not just of the filtered page.
     *
     * The panel says "这 20 条里 3 条失败" and needs to know whether that is all of them. Computing
     * it here from `all` for the current filter, plus an unfiltered total, keeps the panel from
     * having to make a second request to find out what it is not showing.
     */
    sendJSON(res, {
      root: scope === 'workspace' ? join(root, '.she', 'sessions') : runTraceStore(sessionId).directory(),
      runs: all,
      total: all.length,
      paused: all.filter((r) => r.state === 'paused').length,
      failed: all.filter((r) => r.state === 'failed').length,
      scope,
      session_id: sessionId || null,
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
    const sessionId = explicitSessionIdOf(req);
    const evidence = url.searchParams.get('evidence') ?? '';
    if (!evidence.trim()) throw new HttpError(400, 'evidence is required');
    /*
     * The evidence is checked against the runs of the conversation it is claimed to come from, and
     * the session is required rather than guessed. Without it the check would have nothing to read —
     * and answering "not backed" because we did not know where to look would be a wrong answer
     * dressed as a refusal.
     */
    if (!sessionId) throw new HttpError(400, 'session_id is required');
    sendJSON(res, runTraceStore(sessionId).corroborate(evidence));
  });
  /**
   * One run, in full.
   *
   * The session comes from the request, and the run id is still resolved by listing that session's
   * own directory — so neither an id nor a session id from a URL can name a file outside it. A
   * workspace-scoped list tells the panel which conversation each row belongs to, and the panel
   * sends that back; "search every session for this id" is deliberately not implemented, because a
   * read that begins by guessing which directory to look in is the shape this whole layout removed.
   */
  router.get('/api/runs/:id', (req, res, params) => {
    const sessionId = explicitSessionIdOf(req);
    if (!sessionId) throw new HttpError(400, 'session_id is required');
    const result = runTraceStore(sessionId).read(params.id);
    if (!result) throw new HttpError(404, `Run not found: ${params.id}`);
    sendJSON(res, result);
  });

  /**
   * Self-review state: drift, calibration, the critic's reading, and what was written to the book.

   *
   * Three sources on purpose, and the split is the point rather than an implementation detail:
   *
   *   - a live agent's in-memory reports, which are this session's actual last turn;
   *   - the workspace ledger ON DISK (`.she/reflection/confidence.json`), which is what makes the
   *     VERDICT useful before any turn has run in this process. Calibration is a habit across
   *     sessions, so reading it only from a live agent would report "nothing yet" on every restart —
   *     the exact moment the history matters most. That file holds numbers and nothing else, which is
   *     why it can be shared at all;
   *   - this conversation's own samples, under `.she/sessions/<id>/confidence.json`, which carry the
   *     topic text and are therefore only ever read for the session that asks.
   */
  router.get('/api/reflection', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('session_id') ?? sessions.getActive()?.id ?? null;
    const agent = sessionId ? agents.get(sessionId) : undefined;
    const windowRaw = Number(url.searchParams.get('window'));
    const mirror = reflectionMirror(sessionId);
    const report = mirror.report(
      Number.isFinite(windowRaw) && windowRaw > 0 ? { window: windowRaw } : {},
    );
    sendJSON(res, {
      /** The shared half: numbers only, newest last. The verdict above comes from this file. */
      root: join(resolve(config.workspace.root), REFLECTION_DIR),
      confidence: report,
      /** This conversation's samples — the only ones that carry topics. Empty without a session. */
      samples: mirror.samples().slice(-50),
      samples_root: sessionId ? sessionStateDir(resolve(config.workspace.root), sessionId) : null,
      ledger: mirror.indexSamples().slice(-50),
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
   * being reported, and because a workspace whose ledger got polluted by an experiment or a broken
   * caller should be recoverable without deleting files by hand.
   *
   * It clears the ledger AND the asking conversation's own samples: the verdict comes from the
   * ledger, so clearing only the per-session file would leave the agent still being told about the
   * habit it just asked to forget. Other conversations' sample files are theirs and are left alone.
   *
   * The asking conversation comes from the body/query/header like every other route. Reading it from
   * the query alone used to make a `{ session_id }` in the body silently reset the ACTIVE session
   * instead — the wrong conversation's samples, and an audit line naming the wrong session.
   */
  router.post('/api/reflection/confidence/reset', async (req, res) => {
    const body = await parseBody<{ session_id?: string }>(req).catch(() => ({ session_id: undefined }));
    const sessionId = sessionIdOf(req, body) || null;
    reflectionMirror(sessionId).clear();
    // Recorded in the audit trail: forgetting a measurement changes what the agent will be told
    // about itself from now on, and that is a change to its behaviour rather than a display setting.
    auditSafe({ kind: 'config', session_id: sessionId ?? undefined, change: 'reset_confidence_mirror', note: '重置置信度镜像历史' });
    sendJSON(res, { ok: true, session_id: sessionId });
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
      sendJSON(res, { question: null, waiting: null });
      return;
    }
    try {
      const q = JSON.parse(readFileSync(p, 'utf8')) as { question?: string; askedAt?: string; [k: string]: unknown };
      /*
       * 提问这边**没有**挂起的一轮：`ask_user` 让模型结束本轮并等一条新消息，所以这里没有"暂停的
       * 运行"可报。但"在等谁"这句话照样成立，而且和确认那边用同一套词（`waitingOn` / `since`），
       * 界面因此不必为两种等待写两套判断。`askedAt` 是 `ask_user` 落盘时就写好的，不是这里补记的。
       */
      sendJSON(res, {
        ...q,
        waiting: {
          waitingOn: 'user',
          since: q.askedAt ?? null,
          note: '这一轮已经交回给你，等你的回答（任何一条消息都会接手这个问题）。',
        },
      });
    } catch {
      sendJSON(res, { question: null, waiting: null });
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
    const body = await parseBody<{ query: string; budget?: number; includeRetired?: boolean }>(req);
    if (!body.query) throw new HttpError(400, 'Missing required field: query');
    const result = engine.query(body.query, { budget: body.budget, includeRetired: body.includeRetired === true });
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

  /*
   * KB governance: read one memory with its retirement marker and edit history, edit it in place
   * (the replaced version is kept in its history), retire it out of retrieval, restore it.
   * The same engine calls the agent's kb_edit / kb_retire tools make.
   */
  router.get('/api/kb/memories/:id', (_req, res, params) => {
    const memory = store.getMemory(params.id);
    if (!memory) throw new HttpError(404, `Memory not found: ${params.id}`);
    sendJSON(res, {
      memory,
      retired: engine.getRetirement(memory) ?? null,
      version: engine.getVersion(memory),
      history: engine.getHistory(memory),
    });
  });

  router.put('/api/kb/memories/:id', async (req, res, params) => {
    const body = await parseBody<{ title?: string; content?: string; kind?: string; reason?: string }>(req);
    if (!store.getMemory(params.id)) throw new HttpError(404, `Memory not found: ${params.id}`);
    const patch: KBMemoryPatch = {};
    if (body.title !== undefined) {
      if (!String(body.title).trim()) throw new HttpError(400, 'title must not be empty');
      patch.title = String(body.title);
    }
    if (body.content !== undefined) {
      if (!String(body.content).trim()) throw new HttpError(400, 'content must not be empty (retire the memory instead)');
      patch.content = String(body.content);
    }
    if (body.kind !== undefined) {
      const validKinds = ['text', 'code', 'fact', 'tool_outcome', 'preference'] as const;
      if (!validKinds.includes(body.kind as any)) throw new HttpError(400, `Invalid kind: ${body.kind}`);
      patch.kind = body.kind as any;
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to change: pass title, content or kind');
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
    const r = engine.reviseMemory(params.id, patch, reason);
    sendJSON(res, { ok: true, changed: r.changed, version: r.version, memory: r.after });
  });

  router.post('/api/kb/memories/:id/retire', async (req, res, params) => {
    const body = await parseBody<{ reason?: string; replacedBy?: string }>(req);
    if (!store.getMemory(params.id)) throw new HttpError(404, `Memory not found: ${params.id}`);
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new HttpError(400, 'Missing required field: reason');
    const replacedBy = typeof body.replacedBy === 'string' && body.replacedBy.trim() ? body.replacedBy.trim() : undefined;
    if (replacedBy && (replacedBy === params.id || !store.getMemory(replacedBy))) {
      throw new HttpError(400, `Invalid replacedBy: ${replacedBy}`);
    }
    const memory = engine.retireMemory(params.id, { reason, replacedBy });
    sendJSON(res, { ok: true, memory, retired: engine.getRetirement(memory) ?? null });
  });

  router.post('/api/kb/memories/:id/restore', (_req, res, params) => {
    if (!store.getMemory(params.id)) throw new HttpError(404, `Memory not found: ${params.id}`);
    const memory = engine.restoreMemory(params.id);
    sendJSON(res, { ok: true, memory });
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

  /**
   * 成本面板的数据：这一段会话花了多少、按你的定价该往哪一侧省、以及那句免责声明。
   *
   * 这里**只算和解释，不改任何东西**。把"建议"和"生效"分开是有意的：面板要能回答"如果我改成这个
   * 档位会怎样"，而一个预览动作不该顺手把配置改了 —— 那会让用户在不知情的情况下丢掉历史（如果是
   * aggressive+允许删历史的话）。
   *
   * 没有任何会话时也返回一份（`createIfMissing: false`）：面板在空工作区也要能填单价。
   */
  router.get('/api/context/plan', (req, res) => {
    const agent = agentFor(req, undefined, { createIfMissing: false });
    const usage = agent.getTokenUsage();
    const allocation = allocateContext({
      requested: config.context.compression,
      pricing: config.context.pricing,
      usage: usage as unknown as UsageLike,
      allowHistoryReduction: config.context.allowHistoryReduction,
      currentThinkingLevel: (config.llm.thinkingLevel || 'medium') as ThinkingLevel,
    });
    sendJSON(res, {
      pricing: { ...config.context.pricing },
      pricingConfigured: pricingConfigured(config.context.pricing),
      pricingNote: pricingNote(config.context.pricing),
      compression: config.context.compression,
      allowHistoryReduction: config.context.allowHistoryReduction,
      autoCompact: config.context.autoCompact,
      compactAtShare: config.context.compactAtShare,
      /*
       * 天花板的状态和"怎么省钱"放在同一个回包里是有意的：面板要能回答"现在离上限还有多远、
       * 压过没有、压的是哪一份摘要、这个窗口是谁说的"。没有它，压缩就是一件只能从状态行里偶然
       * 看见的事。
       */
      context: agent.getContextStatus(),
      usage,
      allocation,
    });
  });

  /**
   * 把面板的建议应用下去（用户按了按钮才算）。
   *
   * `historyReduction` 不在这里设置 —— 它由设置页那个显式开关决定。让一个"应用建议"的按钮顺手
   * 打开"允许删历史"是这里最不该有的行为。
   */
  router.post('/api/context/apply', async (req, res) => {
    const body = await parseBody<{ thinkingLevel?: ThinkingLevel }>(req).catch(() => ({} as { thinkingLevel?: ThinkingLevel }));
    const agent = agentFor(req, undefined, { createIfMissing: false });
    const allocation = allocateContext({
      requested: config.context.compression,
      pricing: config.context.pricing,
      usage: agent.getTokenUsage() as unknown as UsageLike,
      allowHistoryReduction: config.context.allowHistoryReduction,
      currentThinkingLevel: (config.llm.thinkingLevel || 'medium') as ThinkingLevel,
    });
    const wanted = body.thinkingLevel ?? allocation.recommendedThinkingLevel;
    let applied: ThinkingLevel | null = null;
    if (wanted && THINKING_LEVEL_SET.has(wanted)) {
      config.llm.thinkingLevel = wanted;
      // 事件里的 `setEnv` 是 PUT /api/settings 里的局部闭包（它攒到 envPatch 再一起写），这里
      // 直接落盘，和 `mountWorkspace` 记工作区的做法一致。
      try { updateEnvFile(ENV_PATH, { SHE_THINKING_LEVEL: wanted }); } catch { /* non-fatal */ }
      for (const a of agents.values()) a.setThinkingLevel(wanted);
      applied = wanted;
    }
    sendJSON(res, { ok: true, applied, allocation });
  });

  /**
   * 手动压一次。到阈值会自动压，这个入口是给"我想现在压"和"我想离线验证这条路径"用的。
   *
   * 它不假装成功：压不动（历史太短、没有合法切点）时回 ok:false 并说明原因 —— 一个回 200 但什么
   * 都没做的端点，会让用户以为上下文已经变小了。回包里带上压之后的完整状态，面板不必再查一次。
   */
  router.post('/api/context/compact', async (req, res) => {
    const agent = agentFor(req);
    const result = await agent.forceCompact('manual');
    sendJSON(res, { ...result, status: agent.getContextStatus() });
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
    // Across every known project, for the same reason as the rail: a room filed in another
    // project's state directory is still a room the user can see and open.
    const stores = clusterStoresForRail();
    const recoveries = stores
      .map((c) => c.recoveryNotice)
      .filter((n): n is { backup: string; reason: string } => n !== null);
    sendJSON(res, { rooms: stores.flatMap((c) => c.list()), recoveries });
  });

  /**
   * Work groups surfaced in the session rail.
   *
   * Rooms were previously only reachable from the cluster panel, so a group the
   * user created looked like it had vanished. Expose them as pseudo-sessions of
   * kind 'cluster' so the sidebar can list them alongside chats.
   *
   * 默认只列**本工作区**的会话。这是这条路线之前最要命的错误：它遍历 `projectRoots()` ——
   * 所有被记住过的项目 —— 把它们的历史合并成一条列表。于是一个新工作区打开就能看到别的项目
   * 的对话，而"这个工作区里只有这个工作区的 chat"这条最基本的承诺从来没有成立过。
   *
   * 合并的初衷是好的：会话栈要能显示群，而群是按项目存的。但那个问题应该用"群跟着工作区走"
   * 来解决，不是把每个项目的历史都摊在用户面前。跨项目现在要显式要：`?scope=all`。
   */
  router.get('/api/conversations', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const crossProject = url.searchParams.get('scope') === 'all';
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
    /*
     * 本工作区就是**已挂载的那个 state 目录**（`sessions.rootDir`），不是 `config.workspace.root`：
     * 两者在 `SHE_STATE_DIR` 被显式指定时会分开，而 chats 跟着 state 目录走。用挂载中的 store 是
     * 唯一一处能同时保证"列出来的"和"点得开的"是同一批的做法。
     */
    const roots = crossProject ? projectRoots() : [sessions.rootDir];
    for (const root of roots) {
      for (const s of visibleToTenant(storeFor(root).list().sessions)) {
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
    /*
     * 群跟着工作区走，跟 chats 同一条规则。
     *
     * 2026-09-27 这里改成遍历所有项目，原因是：打开一个属于别的项目的会话会把那个项目挂载进来，
     * 于是只读挂载中的 `cluster` 会让会话栈"掉"群（实测三个变两个）。那个现象是真的，但根因是
     * **上一段**（会话栈本来就不该列别的项目的会话）。现在会话栈只剩本工作区，那个挂载切换也就
     * 不会再发生，于是这里可以回到"只列本工作区的群" —— 也就是和上面同一个 `roots`。
     *
     * `clusterStoresForRail()` 仍然保留：`roomHome()` 需要按 id 在**所有**项目里找一个群（用户
     * 可能从别处带过来一个房间 id），那是"按 id 查"而不是"列出别人的东西"，两件事不一样。
     * `seenGroups` 防止一个群被列两次（同一个 state 目录的两种写法）。
     */
    const seenGroups = new Set<string>();
    const groupStores = crossProject ? clusterStoresForRail() : [cluster];
    const groups = groupStores.flatMap((c) =>
      c.list().flatMap((r) => {
        if (seenGroups.has(r.id)) return [];
        seenGroups.add(r.id);
        return [{
          id: r.id,
          kind: 'cluster' as const,
          title: r.title,
          created_at: r.created_at,
          updated_at: r.updated_at,
          memberCount: r.members?.length ?? 0,
          status: r.status,
        }];
      }),
    );
    /*
     * 按**活跃**排序，最新用过的在最上面。
     *
     * 这本来就是这条接口的行为（`updated_at` 倒序），但它是唯一一处这么做的地方 ——
     * `SessionStore.list()` 返回的是创建顺序（`create` 用 `unshift`），所以 `/api/sessions`
     * 和会话栈会对同一批数据给出两种顺序。用户看到"排序不对"就是这两个顺序在对不上。
     *
     * 平手时用 `created_at` 再比一次，然后才是 id：两个从没说过话的会话 `updated_at` 完全相同
     * （都是创建那一刻），只按它排的话顺序取决于数组当时的样子，刷新一次就可能换位。
     */
    const all = [...chats, ...groups].sort((a, b) =>
      (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
      || (b.created_at ?? '').localeCompare(a.created_at ?? '')
      || a.id.localeCompare(b.id),
    );
    /*
     * `active_id` is filtered too. It is an id, not a title, but it is the id of a conversation the
     * caller may not open — handing it over would make the client's next request fail with a 404 it
     * could have been spared, and it announces that some other session exists.
     */
    const activeId = sessions.list().active_id;
    const activeVisible = activeId !== null
      && (!tenancy.enabled || visibleToTenant([{ id: activeId }]).length > 0);
    /*
     * Quarantined state is reported here too, because this is the list the user actually looks at.
     *
     * A quarantined file makes the rail shorter and nothing on screen says why, which is exactly
     * what a deleted conversation looks like. Each notice carries the backup path, so "where did my
     * chat go" has an answer that does not require reading a log file.
     */
    const recoveries: Array<{ kind: 'sessions' | 'cluster'; root: string; backup: string; reason: string }> = [];
    for (const root of roots) {
      const notice = storeFor(root).recoveryNotice;
      if (notice) recoveries.push({ kind: 'sessions', root, ...notice });
    }
    for (const c of groupStores) {
      const notice = c.recoveryNotice;
      if (notice) recoveries.push({ kind: 'cluster', root: c.rootDir, ...notice });
    }
    sendJSON(res, { items: all, active_id: activeVisible ? activeId : null, recoveries });
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
    const home = roomHome(params.id);
    const room = home?.store.setRoles(params.id, body.roles, configForRoot(home.root).workspace.root);
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
    const home = roomHome(params.id);
    const room = home?.store.upsertRole(params.id, role, configForRoot(home.root).workspace.root);
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, { room, role }, 201);
  });

  router.delete('/api/cluster/rooms/:id/roles/:key', (req, res, params) => {
    const home = roomHome(params.id);
    const room = home?.store.removeRole(params.id, params.key, configForRoot(home.root).workspace.root);
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
    const room = roomHome(params.id)?.store.rename(params.id, String(body.title ?? ''));
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, room);
  });

  router.delete('/api/cluster/rooms/:id', (req, res, params) => {
    roomHome(params.id)?.store.remove(params.id);
    sendJSON(res, { ok: true });
  });

  router.get('/api/cluster/rooms/:id', (_req, res, params) => {
    const room = roomHome(params.id)?.store.get(params.id) ?? null;
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, room);
  });

  router.post('/api/cluster/rooms/:id/message', async (req, res, params) => {
    const body = await parseBody<{ content?: string }>(req);
    const content = String(body.content || '').trim();
    if (!content) throw new HttpError(400, 'Missing content');
    const msg = roomHome(params.id)?.store.append(params.id, { role: 'user', name: '用户', content });
    if (!msg) throw new HttpError(404, 'Room not found');
    sendJSON(res, msg, 201);
  });

  router.post('/api/cluster/rooms/:id/reload-skills', (_req, res, params) => {
    const home = roomHome(params.id);
    const room = home?.store.reloadSkills(params.id, configForRoot(home.root).workspace.root);
    if (!room) throw new HttpError(404, 'Room not found');
    sendJSON(res, room);
  });

  router.post('/api/cluster/init-skills', async (_req, res) => {
    const files = await initClusterIdentitySkills(config, config.workspace.root);
    sendJSON(res, { ok: true, files });
  });

  router.post('/api/cluster/rooms/:id/export-kb', async (req, res, params) => {
    const home = roomHome(params.id);
    const room = home?.store.get(params.id);
    if (!home || !room) throw new HttpError(404, 'Room not found');
    const body = await parseBody<{ title?: string }>(req);
    const day = new Date().toISOString().slice(0, 10);
    const rootName = 'imports';
    /*
     * The minutes belong in the knowledge base of the project the room belongs to, not in whichever
     * project happens to be mounted: filing another project's discussion into this project's KB
     * would attach a memory about the wrong codebase, and it would be unreachable from the chat
     * that had the discussion.
     */
    const roomEngine = engineFor(resolveWorkspaceKbPath(home.root).dbPath);
    const roomStore = (roomEngine as unknown as { store: KBStore }).store;
    let root = roomStore.getAllGroups().find((g) => g.name === rootName && !g.parentGroupId);
    if (!root) root = roomEngine.createGroup(rootName);
    let srcGroup = roomStore.getAllGroups().find((g) => g.name === 'cluster' && g.parentGroupId === root!.id);
    if (!srcGroup) srcGroup = roomEngine.createGroup('cluster', root.id);
    let dayGroup = roomStore.getAllGroups().find((g) => g.name === day && g.parentGroupId === srcGroup!.id);
    if (!dayGroup) dayGroup = roomEngine.createGroup(day, srcGroup.id);

    const title = (body.title || room.title || '讨论纪要').slice(0, 80);
    const transcript = room.messages
      .map((m) => `## ${m.name}${m.parallel_group ? ` · 并行 ${m.parallel_group}` : ''}\n\n${m.content}`)
      .join('\n\n');
    const mem = roomEngine.addMemory(
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

  /*
   * Stop the room's running wave.
   *
   * The UI's stop button aborts its own stream, which only detaches the view: with
   * auto-continuation a room keeps running rounds server-side until someone tells it to stop, so
   * without this route the wave could not actually be stopped from the panel at all.
   *
   * `stopped: false` is a normal answer (the round happened to finish first), not an error — but an
   * unknown room still 404s, so "no such room" and "nothing running" stay distinguishable.
   */
  router.post('/api/cluster/rooms/:id/stop', (_req, res, params) => {
    if (!roomHome(params.id)) throw new HttpError(404, 'Room not found');
    sendJSON(res, { stopped: stopClusterRun(params.id) });
  });

  router.post('/api/cluster/rooms/:id/run', async (req, res, params) => {
    const body = await parseBody<{ goal?: string; stream?: boolean }>(req);
    const goal = String(body.goal || '').trim();
    if (!goal) throw new HttpError(400, 'Missing goal');

    /*
     * Run the room where it lives. A room filed in another project's state directory uses that
     * project's workspace — its skills, its knowledge base, its files — not the workspace this
     * request happened to arrive on.
     */
    const home = roomHome(params.id);
    if (!home) throw new HttpError(404, 'Room not found');
    const roomConfig = configForRoot(home.root);
    const roomStore = home.store;

    const wantStream =
      body.stream === true ||
      ((req.headers.accept || '').includes('text/event-stream') && body.stream !== false);

    if (wantStream) {
      startSSE(res);
      try {
        const room = await runClusterWave({
          config: roomConfig,
          store: roomStore,
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
      config: roomConfig,
      store: roomStore,
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
 *
 * 没有会话时返回 `null` —— **不再顺手建一个**。
 *
 * 之前这里以 `createSession(...)` 收尾，于是"一个空工作区启动"会凭空多出一条没人要的
 * `New chat`。用户看到的是：打开应用时列表是空的，点一下 `+`，出现**两个** `New chat` ——
 * 一个是他点的，一个是启动时替他点的。实测复现（2026-10-01，空工作区启动后
 * `GET /api/sessions` 返回 1 条 title='New chat'）。那条会话连一句话都没有，却占着 `active_id`，
 * 还让 `chooseStartupSession` 的注释里描述的"重启后历史看起来丢了"更难判断。
 *
 * "没有会话"是一个正常状态：界面就该显示空状态，用户点 `+` 才产生第一条。补上一条假的，
 * 是把"还没有"伪装成"已经有了"。
 */
function pickStartupSession(): ChatSession | null {
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
  return stored ?? null;
}

export async function startServer(overrideConfig?: SheConfig): Promise<ReturnType<typeof createServer>> {  // Resolve config against the install root so the server finds the same
  // .env / config.yaml no matter which directory it was launched from.
  config = overrideConfig ?? loadConfig(PROJECT_ROOT);
  {
    const resolved = resolveWorkspaceKbPath(config.workspace.root);
    config.kb.dbPath = resolved.dbPath;
  }
  const { port, host } = config.server;

  /*
   * 控制面凭据：没有显式给就生成一份并落在安装私有目录（`<appDir>/control-token`）。
   *
   * 放在这里而不是模块级：`appDir()` 读环境变量，而模块级就要做文件 I/O 会让导入这个模块的单元
   * 测试在真实的 `~/.she-app` 里生成凭据。放在 `listen` 之前则是因为凭据解决不了就不该开始服务 ——
   * 一个"以为控制面被保护着、其实没校验"的进程比拒绝启动危险得多（同 `tenancy.ts` 里那条）。
   */
  controlAuth = resolveControlAuth(appDir());

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
  //
  // 没有会话就什么都不开。空工作区启动时不再造一条 `New chat`（见 `pickStartupSession`）——
  // 那样会让用户点一次 `+` 得到两条，而且那条假会话会被持久化，下次启动又挑中它。
  const active = pickStartupSession();
  activeAgentId = active?.id ?? null;

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

  /*
   * Connect the MCP servers at boot, so the first `mcp_list` already sees them.
   *
   * The agent's MCP tools themselves are static (`mcp_list` / `mcp_call`), so the tool table no
   * longer depends on this having finished; what depends on it is whether the servers are
   * running when the model first asks. Bounded by the bridge's own connect budget (15s for all
   * servers, started in parallel), so one hung server cannot hold boot open indefinitely; a
   * server that misses it is retried on its first `mcp_list` / `mcp_call`.
   */
  try {
    const mcpSummary = await mcp.refresh();
    if (mcpSummary.running.length || mcpSummary.failed.length) {
      log.info(`MCP: ${mcpSummary.running.length} server(s) running with ${mcpSummary.tools} tool(s) behind mcp_call`
        + (mcpSummary.failed.length ? `; failed to start: ${mcpSummary.failed.join(', ')}` : ''));
    }
  } catch (e) {
    log.warn(`MCP tool registration failed (server still starts): ${(e as Error).message}`);
  }

  if (active) {
    const initialAgent = makeAgent(config, active.id);
    if (active.messages?.length) initialAgent.setHistory(active.messages);
    agents.set(active.id, initialAgent);
    log.info(`Opened session ${active.id} (${active.messages?.length ?? 0} messages)`);
  } else {
    /*
     * 空工作区。不打 "Opened session" —— 那句日志现在会是一句谎话，而且它是排查"会话去哪了"
     * 时第一眼看的东西。`/api/conversations` 会如实回一个空列表，界面显示空状态。
     */
    log.info('这个工作区还没有会话（等用户新建）');
  }

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
      busy: scheduledTaskBusy,
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
  /*
   * 控制面凭据这件事必须说出来。
   *
   * 一个运维（或评测方）要知道两件事才能判断端口安不安全：这次**有没有**校验，以及凭据在哪。
   * 含糊其辞的日志会让人用"PUT 一下试试"来推断 —— 而那恰好是要被拒绝的动作。
   */
  if (!controlAuth?.token) {
    log.warn('控制面凭据：**未校验**（SHE_CONTROL_AUTH 被显式关掉）—— 任何能连到本端口的调用方'
      + '都能改设置 / 工作区 / 回退配置，包括给自己换一套沙箱档位。');
  } else if (controlAuth.source === 'generated') {
    log.info(`控制面凭据：已生成一份并写入 ${controlAuth.path}（桌面端会自动读取并带上；`
      + '沙箱里的 Agent 读不到这个文件，也调不动控制面）。');
  } else {
    log.info(`控制面凭据：已启用（来自 ${controlAuth.source === 'env' ? 'SHE_CONTROL_TOKEN' : '已有文件'}），`
      + `受保护的是设置 / 工作区 / 配置回退这类接口。`);
  }
  // One-time tidying: the old version stored the wallpaper per workspace and left it there.
  cleanLegacyWorkspaceBackground();

  /*
   * Say out loud whether the port is protected, and hand over any sessions that predate the token.
   *
   * The log line matters as much as the adoption does. An operator who configured a token needs to
   * see it acknowledged at boot — the alternative is guessing from whether a request 401s — and an
   * operator who did NOT configure one should not have to read a config file to discover that the
   * API on their loopback is open to anything running as their user.
   */
  if (tenancyError) {
    log.error(`鉴权配置有误，所有请求都会被拒绝：${tenancyError}`);
  } else if (!tenancy.enabled) {
    /*
     * 鉴权关着的时候，这句话必须**说准它到底听了哪里**。
     *
     * 原来这里写的是"只接受本机来源"，而 `guardRequest` 检查的只是 `Host`/`Origin` 头 —— 那挡的是
     * 浏览器里的一个网页（DNS rebinding / 跨站），不挡"谁能连上来"。第四轮评测的 2b 就是这条：
     * 无凭据 `PUT /api/settings` 改掉了 `.env` 里的沙箱档位。本机同用户的进程 forge 这两个头毫无
     * 难度（`tenancy.ts` 开头也写着这句），所以"只接受本机来源"在 loopback 上是一句正确的免责，
     * 一旦 `SHE_HOST` 指到别的地址、或前面挂了反代，它就是**一句错的**。
     *
     * 局面不变，措辞和事实一致：说清监听地址，并说明未鉴权意味着什么。
     */
    const onLoopback = isLoopbackHost(config.server.host);
    log.info(
      `鉴权：未开启 —— 监听 ${config.server.host}:${config.server.port}，`
      + (onLoopback
        ? '仅本机可达；本机以你的身份运行的任何进程都能调用控制面（含改 .env）'
        : '【已暴露到本机之外】控制面没有凭据，任何能连到这个端口的人都能改沙箱档位与工作区')
      + '。需要鉴权就设置 SHE_AUTH_TOKEN（或 SHE_AUTH_TOKENS）。',
    );
    /*
     * 未鉴权 + 监听在 loopback 之外 = 这一格**没有**被任何一次权衡选中过。
     *
     * 这一条**不拒绝启动**，理由是不越权：`check:host` 里有一组用例是故意用 `SHE_HOST=0.0.0.0`
     * 且不带 token 启动的（容器 / 局域网部署），那是仓库里有意支持的方式，`SHE_ALLOWED_HOSTS` 的
     * 注释也是照着它写的。把启动拦掉等于替用户否掉他显式配置过的部署形态 —— 而这件事该由他定。
     *
     * 所以这里只把事实说清楚（上面那行日志），并把这一格**记下来**供门禁与面板读取；
     * 见 `scripts/host-guard-check.mjs` 里对这一格的断言。
     */
  } else {
    log.info(`鉴权：已开启，${tenancy.tenants.length} 个租户（token 从 ${AUTH_HEADER} 或 Authorization: Bearer 读取）`);
    const adoptTo = process.env.SHE_TENANT_ADOPT_TO?.trim();
    if (adoptTo && tenancy.tenants.some((t) => t.id === adoptTo)) {
      const ids: string[] = [];
      for (const s of sessions.list(true).sessions) ids.push(s.id);
      for (const root of projectRoots()) {
        if (sameDb(root, sessions.rootDir)) continue;
        for (const s of storeFor(root).list(true).sessions) ids.push(s.id);
      }
      const n = tenantLedger().adopt(ids, adoptTo);
      if (n) {
        auditSafe({ kind: 'config', change: 'tenant_adopt', note: `把 ${n} 个无主会话划给租户 ${adoptTo}` });
        log.info(`租户：已把 ${n} 个此前无归属的会话划给 ${adoptTo}`);
      }
    }
  }

  const router = new Router();
  registerRoutes(router);

  const server = createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';
    const start = Date.now();

    // A misconfigured token list must not silently become "no auth at all".
    if (tenancyError) {
      sendError(res, `鉴权配置有误：${tenancyError}`, 500);
      return;
    }

    // Refuse anything that did not originate from the local app before it
    // reaches a route (see guardRequest for what this blocks).
    const refused = guardRequest(req, port);
    if (refused) {
      log.warn(`Refused request: ${method} ${url} (${refused})`);
      sendError(res, 'Forbidden', 403);
      return;
    }

    /*
     * Then who is asking.
     *
     * Only `/api/health` is exempt: it is what the desktop shell and the offline checks poll to
     * ask "is it up", and its payload names no workspace content. Everything else — including the
     * config-recovery view, which names files inside the workspace — needs the token.
     */
    const pathname = url.split('?')[0];
    const auth = isPublicRoute(method, pathname)
      ? ({ ok: true as const, tenant: tenancy.implicit })
      : authenticate(req.headers, tenancy);
    if (!auth.ok) {
      /*
       * Recorded, not just logged. A single refusal is noise; a run of them from one source is
       * the only signal that the port is reachable by something that should not reach it, and a
       * log line that rotates away cannot answer "when did this start". The presented token is
       * never written — only whether one was presented at all.
       */
      auditSafe({
        kind: 'auth',
        path: `${method} ${pathname}`,
        presented: presentedTokens(req.headers).length > 0,
        note: auth.reason,
      });
      log.warn(`Refused (auth): ${method} ${url} (${auth.reason})`);
      /*
       * The body says WHICH gate refused and where the token comes from.
       *
       * It used to be the bare word `Unauthorized`, and that is not a neutral choice: the UI then had
       * nothing to work with and substituted its own sentence, which named the *control* credential
       * for a tenant refusal (or the reverse — see `authHint` in the UI). A 401 whose body does not say
       * what to fix pushes every client to guess, and each client guesses differently.
       *
       * Same shape as the control-plane body below, so a reader can tell the two apart at a glance.
       */
      sendError(
        res,
        'Unauthorized：本地服务开了访问令牌（SHE_AUTH_TOKEN / SHE_AUTH_TOKENS），这次请求没带上。'
        + '桌面端开窗时会自动带上；命令行可用 x-she-token 头或 Authorization: Bearer；'
        + '浏览器标签页读的是 localStorage 的 she.authToken。',
        401,
      );
      return;
    }

    /*
     * 最后一个问题：这个请求改的是不是**这台机器怎么跑**。
     *
     * 和上面那层分开，而不是把控制面塞进 tenancy 的 token 列表里，原因见 `control-token.ts` 开头：
     * 租户 token 回答"你是谁"（开了就全站都要），控制面凭据回答"你能不能改运行档位"（只管设置 /
     * 工作区 / 配置回退）。一个在单用户桌面上用界面的人不该被迫配租户 token，而一个 Agent 不该能
     * 给自己换沙箱档位 —— 这两件事得分开答。
     *
     * tenancy 开着的时候不再重复要求：那一层已经要过凭据了，再要一次只是让界面多走一遍同样的门。
     */
    if (
      controlAuth?.token
      && !tenancy.enabled
      && isControlPlanePath(pathname)
      && !presentsControlToken(req.headers, controlAuth.token)
    ) {
      auditSafe({
        kind: 'auth',
        path: `${method} ${pathname}`,
        presented: presentedTokens(req.headers).length > 0,
        note: '控制面凭据缺失',
      });
      log.warn(`Refused (control plane): ${method} ${url}`);
      sendError(
        res,
        'Unauthorized：控制面需要凭据（改运行档位 / 工作区 / 配置的接口）。'
        + `凭据在 ${controlAuth.path}，桌面端会自动带上；命令行可用 x-she-token 头或 Authorization: Bearer。`,
        401,
      );
      return;
    }

    try {
      const handled = await runInTenant(auth.tenant, () => router.handle(req, res));      if (!handled) {
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

    /*
     * 自动化模式与沙箱姿态的张力，也写进启动日志。
     *
     * 只放在接口里不够：这个张力的后果是"无人值守的那一轮会停在确认上等人"，而那时用户多半不在
     * 界面前面 —— 他下次看日志时得能读到这句话，而不是去翻界面上的一个提示。
     */
    const postureNotice = sandboxPostureNotice(config);
    if (postureNotice) log.info(postureNotice);

    /*
     * 真隔离的可用性也写进启动日志。
     *
     * 与上面同一条理由，但动机不同：那条是"默认姿态会停住"，这条是"这台机器上没有这个能力"或
     * "有这个能力但关着"。探测是惰性的（`resolveWslIsolation` 进程内缓存），这里没读设置接口的
     * 部署也能在日志里看到，第一次会付约 1 秒的 wsl.exe 探测；`off` 且不可用时 `isolationNotice`
     * 返回 null，启动日志不为一句没信息量的话变长。
     */
    const isoNotice = isolationNotice(describeIsolation(
      config.sandbox.isolation, config.workspace.root, config.sandbox.wslDistro,
      // 同一份授权，理由同 `/api/settings`：最大授权下真隔离被让开，日志不该还说"隔离开着"。
      { allowAllCommands: config.sandbox.allowAllCommands, outsideWorkspace: config.sandbox.outsideWorkspace },
    ));
    if (isoNotice) log.info(isoNotice);

    /*
     * 联网档位也写进启动日志。与上面两条同样的理由：这是"出网"这件事唯一的开关，而它默认是开的
     * （`auto`）—— 部署的人应当在日志里看到自己的机器会把查询发出去、发给谁。不探测、不发请求，
     * 只是把配置渲染成人话（`off` 时说的是"已关闭"）。
     */
    log.info(`联网：${new WebClient(config.web).describe()}`);
  });

  process.on('SIGINT', () => { mcp.shutdown(); disposeAllAgents(); tenantLedger().flush(); server.close(() => process.exit(0)); });
  process.on('SIGTERM', () => { mcp.shutdown(); disposeAllAgents(); tenantLedger().flush(); server.close(() => process.exit(0)); });
  /*
   * Any other orderly exit (crash handler, `process.exit` elsewhere) stops the MCP servers too: on
   * Windows a child does not die with its parent. A HARD kill runs none of this; the bridge's PID
   * registry (`.she/mcp-pids/`) lets the next start reap what such a kill leaves behind.
   */
  process.on('exit', () => { mcp.shutdown(); });

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



