/**
 * Who is allowed to talk to this server, and which tenant their data belongs to.
 *
 * `guardRequest` already answers "did this request come from the machine this app is installed
 * on" — it checks Host and Origin so a web page in a browser cannot reach the local API. That is a
 * good answer, and it is not an answer to "which human is this", because:
 *
 *   - any process running as the same user can open a socket to 127.0.0.1 and forge `Host` and
 *     `Origin` headers with no effort at all;
 *   - the moment the server is reachable through a reverse proxy — the documented
 *     `SHE_ALLOWED_HOSTS` path — every browser on that network is on the same footing as the
 *     desktop shell, because a real browser sends a genuine, matching `Origin`.
 *
 * So this module adds a second, independent question, answered by a shared secret rather than by a
 * header a client can invent. It is **off unless a token is configured**, because a single-user
 * install that suddenly demands a token is a worse product, not a safer one. Turned on, it is
 * fail-closed:
 *
 *   - the token is read only from a request header, never from the query string. A query string is
 *     copied into `access.log`, shell history, proxy logs and browser history by things that are
 *     not this program, and a credential that leaks through someone else's log file is not a
 *     credential any more;
 *   - comparison is constant-time over hashes, so a caller cannot learn the token one byte at a
 *     time from response latency;
 *   - a token that is too short to be a secret is refused at startup rather than accepted
 *     quietly, since accepting it would look like protection without being any;
 *   - `/api/health` stays reachable without one — it is how the desktop shell and the offline
 *     checks ask "is it up", and it answers with no workspace data. Every other route, including
 *     the config-recovery view, requires the token.
 *
 * ## Tenancy
 *
 * A token maps to a tenant id, and a session belongs to the tenant that created it. That mapping
 * is the part that matters when two people share one installed copy: authentication alone would
 * still let tenant A open tenant B's transcript, because `findSession` looks sessions up by id
 * across every known project root. Possession of a session id is not authorisation to read it.
 *
 *   - `SHE_AUTH_TOKENS="acme:tok-a,beta:tok-b"` → two tenants, isolated from each other.
 *   - `SHE_AUTH_TOKEN=tok`                     → one tenant (`default`): authentication without
 *     isolation. Any session is visible, which is what a single operator wants.
 *   - neither                                  → auth off, everything is `local`.
 *
 * Sessions created before auth was turned on have no owner. With one tenant they stay readable
 * (nothing to isolate from). With several, they are refused rather than handed to whoever asks
 * first, and `SHE_TENANT_ADOPT_TO=<id>` claims them all to one tenant in a single, recorded step
 * so the operator has a migration path that is not "delete the history".
 *
 * Work done with **no** request behind it — a scheduled task, a startup migration — carries no
 * tenant and is treated as the system. It is not a way in: the scope is set by this server from
 * the authenticated request, never by anything a caller sends.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the token may be carried. Both are equivalent; neither is a query parameter. */
export const AUTH_HEADER = 'x-she-token';

/** Shortest token accepted. Below this it is a word, not a secret. */
const MIN_TOKEN_LENGTH = 12;

/** Session-less actors (scheduled tasks) land here when no tenant is configured to own them. */
export const SYSTEM_TENANT = 'system';

export interface Tenant {
  id: string;
  /** SHA-256 of the token. The plaintext is not kept after parsing. */
  hash: Buffer;
}

export interface Tenancy {
  enabled: boolean;
  tenants: Tenant[];
  /** Tenant assumed when auth is off. */
  implicit: string;
  /** Tenant that owns work with no request behind it. */
  system: string;
}

export interface AuthOk {
  ok: true;
  tenant: string;
}

export interface AuthRefused {
  ok: false;
  /** Safe to log and to return: it never contains the presented token. */
  reason: string;
}

export type AuthResult = AuthOk | AuthRefused;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Parse `SHE_AUTH_TOKENS` / `SHE_AUTH_TOKEN`.
 *
 * Format is `id:token` pairs. A bare token (no colon) is accepted and given a positional id, so
 * the common single-token case does not need a syntax the user has to look up.
 */
export function parseTenantTokens(raws: Array<string | undefined>): Array<{ id: string; token: string }> {
  const out: Array<{ id: string; token: string }> = [];
  for (const raw of raws) {
    if (!raw) continue;
    for (const piece of raw.split(',')) {
      const item = piece.trim();
      if (!item) continue;
      const sep = item.indexOf(':');
      if (sep > 0) {
        out.push({ id: item.slice(0, sep).trim(), token: item.slice(sep + 1).trim() });
      } else {
        out.push({ id: out.length === 0 ? 'default' : `tenant-${out.length + 1}`, token: item });
      }
    }
  }
  return out.filter((t) => t.id && t.token);
}

export function loadTenancy(env: NodeJS.ProcessEnv = process.env): Tenancy {
  const parsed = parseTenantTokens([env.SHE_AUTH_TOKENS, env.SHE_AUTH_TOKEN]);
  const unique = new Map<string, string>();
  for (const t of parsed) unique.set(t.id, t.token);

  if (unique.size === 0) {
    return { enabled: false, tenants: [], implicit: 'local', system: SYSTEM_TENANT };
  }

  const ids = [...unique.keys()];
  const duplicateTokens = new Set<string>();
  const seenTokens = new Set<string>();
  for (const id of ids) {
    const token = unique.get(id)!;
    if (seenTokens.has(token)) duplicateTokens.add(id);
    seenTokens.add(token);
  }
  if (duplicateTokens.size) {
    throw new Error(
      `SHE_AUTH_TOKENS: token 重复（${[...duplicateTokens].join(', ')}）。每个租户必须有自己的 token，`
      + '否则无法区分是谁在访问。',
    );
  }

  for (const id of ids) {
    const token = unique.get(id)!;
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `SHE_AUTH_TOKENS: 租户 ${id} 的 token 只有 ${token.length} 个字符，至少需要 ${MIN_TOKEN_LENGTH} 个。`
        + '过短的 token 挡不住任何人，静默接受它比不开启鉴权更危险。',
      );
    }
  }

  const system = env.SHE_TENANT_ADOPT_TO?.trim()
    || (ids.length === 1 ? ids[0] : SYSTEM_TENANT);

  return {
    enabled: true,
    tenants: ids.map((id) => ({ id, hash: sha256(unique.get(id)!) })),
    implicit: ids[0],
    system,
  };
}

function headerValue(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

/** Tokens presented on this request, from the header forms only. */
export function presentedTokens(headers: Record<string, string | string[] | undefined>): string[] {
  const out: string[] = [];
  for (const raw of headerValue(headers[AUTH_HEADER])) {
    const t = raw.trim();
    if (t) out.push(t);
  }
  const auth = headerValue(headers.authorization)[0];
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * Authenticate one request.
 *
 * Every candidate token is compared against every tenant even after a match, so the time taken
 * does not reveal which tenant matched or whether an early entry was close. The cost is a few
 * microseconds against a handful of tenants and buys the property that a failed guess is
 * indistinguishable from a successful one by timing.
 */
export function authenticate(headers: Record<string, string | string[] | undefined>, tenancy: Tenancy): AuthResult {
  if (!tenancy.enabled) return { ok: true, tenant: tenancy.implicit };

  const candidates = presentedTokens(headers);
  if (candidates.length === 0) {
    return { ok: false, reason: `missing token (send ${AUTH_HEADER} or Authorization: Bearer)` };
  }

  let matched: string | null = null;
  for (const tenant of tenancy.tenants) {
    for (const candidate of candidates) {
      const h = sha256(candidate);
      if (h.length === tenant.hash.length && timingSafeEqual(h, tenant.hash)) matched = tenant.id;
    }
  }
  if (!matched) return { ok: false, reason: 'unknown token' };
  return { ok: true, tenant: matched };
}

/**
 * Routes reachable without a token.
 *
 * `/api/health` only: it is the liveness probe for the desktop shell and for `check:offline`, and
 * it returns no workspace content. Deliberately NOT including `/api/config/recovery` even though
 * it is about the app's own state — it names files inside the workspace, which is workspace data.
 * Deliberately NOT including `/api/auth/status`, which echoes the caller's own tenant back and is
 * therefore only meaningful once authenticated.
 */
export function isPublicRoute(method: string, pathname: string): boolean {
  return method === 'GET' && pathname === '/api/health';
}

/**
 * sessionId → tenant, kept next to the workspace's other state.
 *
 * A sidecar file rather than a field on the session record: `sessions.json` is rewritten wholesale
 * by SessionStore and read by code that has no tenant concept, and threading ownership through it
 * would mean every existing writer could silently drop it. Nothing but this module reads this file.
 */
export class TenantLedger {
  private file: string;
  private map: Record<string, string> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private root: string) {
    this.file = join(root, '.she', 'tenants.json');
  }

  private load(): Record<string, string> {
    if (this.map) return this.map;
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof v === 'string') out[k] = v;
          }
          this.map = out;
          return out;
        }
      }
    } catch {
      // A damaged ledger must not take the server down. Sessions simply read as unowned, which is
      // the same state as a fresh install, and the next claim rewrites the file.
    }
    this.map = {};
    return this.map;
  }

  /**
   * Record ownership.
   *
   * Writes are coalesced, not written per call: a turn can create a session in the middle of a
   * user's work, and paying a synchronous rewrite of this file on every session creation is a cost
   * with no benefit — the mapping never needs to be durable before the turn it belongs to ends.
   */
  claim(sessionId: string, tenant: string): void {
    if (!sessionId || !tenant) return;
    const map = this.load();
    if (map[sessionId] === tenant) return;
    map[sessionId] = tenant;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 200);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  flush(): void {
    if (!this.map) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.map, null, 2), 'utf8');
    } catch {
      // Ownership that cannot be persisted still holds for this process; losing it across a
      // restart makes sessions unowned, which `canAccess` treats as "no isolation configured".
    }
  }

  /** Claim every session with no owner. One-shot, run at startup, reported in the log. */
  adopt(ids: string[], tenant: string): number {
    const map = this.load();
    let n = 0;
    for (const id of ids) {
      if (!id || map[id]) continue;
      map[id] = tenant;
      n++;
    }
    if (n) this.flush();
    return n;
  }

  ownerOf(sessionId: string): string | undefined {
    return this.load()[sessionId];
  }

  size(): number {
    return Object.keys(this.load()).length;
  }

  /**
   * May `tenant` touch `sessionId`?
   *
   * `tenant === undefined` means the call is not inside a request (startup, a scheduled task, a
   * CLI check). Those are the operator's own actors and are allowed; see the module comment for
   * why that is not a hole.
   */
  canAccess(sessionId: string, tenant: string | undefined, tenancy: Tenancy): boolean {
    if (!tenancy.enabled) return true;
    if (tenant === undefined) return true;
    const owner = this.ownerOf(sessionId);
    if (owner === undefined) {
      /*
       * No owner: created before auth was switched on, or by a path that did not claim it.
       *
       * With one tenant there is nobody to leak to, so it stays readable — turning on a token must
       * not make yesterday's conversations disappear. With several, the safe direction is refusal:
       * awarding an unowned session to whichever tenant asks first is exactly the mistake this
       * module exists to prevent.
       */
      return tenancy.tenants.length === 1;
    }
    return owner === tenant;
  }
}

/** The tenant of the request currently being served, if any. */
const scope = new AsyncLocalStorage<string>();

export function currentTenant(): string | undefined {
  return scope.getStore();
}

/**
 * Run `fn` with `tenant` attached to the async context.
 *
 * AsyncLocalStorage rather than a value threaded through forty call sites: `findSession` is the
 * single choke point every session read goes through, and it is called from route handlers, from
 * the agent's tool loop, and from timers, in ways that a parameter would have to be plumbed
 * through each of. The context follows the awaits, so a tool call three levels deep still knows
 * whose request it belongs to.
 */
export function runInTenant<T>(tenant: string, fn: () => T): T {
  return scope.run(tenant, fn);
}
