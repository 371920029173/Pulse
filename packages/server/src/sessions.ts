import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger, type LLMMessage } from '@she/shared';
import { loadStateFile, saveStateFile } from './state-file.js';

const log = createLogger('sessions');

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: LLMMessage[];
  /**
   * Where a migrated conversation came from.
   *
   * Kept so the origin is answerable later: after importing a few hundred conversations from
   * another tool, "which file was this?" is the first question a user asks, and the answer cannot
   * be recovered from the transcript itself.
   */
  imported_from?: {
    source: string;
    /** Absolute path of the ORIGINAL record on disk, before any copying. */
    originPath: string;
    /** Workspace-relative copy of the record, when one was kept. */
    copiedTo?: string;
    importedAt: string;
    /** Turns dropped by the import cap, so a short transcript is not mistaken for a whole one. */
    truncated?: number;
  };
  /**
   * Closed sessions are hidden from the working list but kept in history.
   * Distinct from deletion: closing is reversible, deleting is not.
   */
  closed?: boolean;
  closed_at?: string;
}

/** One conversation to insert via `importMany`. */
export interface ImportedConversation {
  title: string;
  messages: LLMMessage[];
  createdAt?: string;
  updatedAt?: string;
  importedFrom?: ChatSession['imported_from'];
}

interface SessionStoreFile {
  schema_version: string;
  active_id: string | null;
  sessions: ChatSession[];
}

/** Current on-disk format for the session list. */
const SCHEMA = 'she-sessions/0.2';

/**
 * Validate and repair a loaded session file.
 *
 * Throws when the value cannot be a session file at all, which makes the caller
 * quarantine it instead of silently starting empty. Per-session damage is
 * repaired rather than fatal: one malformed entry should not cost the user the
 * other ninety.
 */
function normalizeSessionFile(raw: SessionStoreFile): SessionStoreFile {
  if (!raw || typeof raw !== 'object') throw new Error('不是对象');
  if (!Array.isArray(raw.sessions)) throw new Error('sessions 不是数组');

  const sessions: ChatSession[] = [];
  for (const entry of raw.sessions) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Partial<ChatSession>;
    if (typeof s.id !== 'string' || !s.id) continue;
    sessions.push({
      ...(entry as ChatSession),
      // These three are read unconditionally elsewhere, so they must exist.
      title: typeof s.title === 'string' ? s.title : 'New chat',
      messages: Array.isArray(s.messages) ? s.messages : [],
      updated_at: typeof s.updated_at === 'string' ? s.updated_at : new Date().toISOString(),
    });
  }

  const activeId = typeof raw.active_id === 'string' && sessions.some((s) => s.id === raw.active_id)
    ? raw.active_id
    : null;

  return { schema_version: SCHEMA, active_id: activeId, sessions };
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultTitle(messages: LLMMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && typeof m.content === 'string');
  if (firstUser && typeof firstUser.content === 'string') {
    const t = firstUser.content.trim().replace(/\s+/g, ' ');
    return t.length > 42 ? t.slice(0, 42) + '…' : t || 'New chat';
  }
  return 'New chat';
}

export class SessionStore {
  private path: string;
  private data: SessionStoreFile;
  /** Set when the previous file could not be used and was moved aside. */
  private recovery: { backup: string; reason: string } | null = null;
  /** Set when the previous file was upgraded in place. */
  private migratedFrom: string | null = null;

  constructor(baseDir: string) {
    const dir = join(baseDir, '.she');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'sessions.json');
    this.data = { schema_version: SCHEMA, active_id: null, sessions: [] };
    this.load();
  }

  /**
   * Load the session file.
   *
   * The previous implementation replaced the in-memory state with an empty list
   * on ANY parse failure and then saved it, so a truncated or hand-edited file
   * destroyed every conversation the user had. Failures now quarantine the file
   * and the data stays recoverable on disk — see `state-file.ts`.
   */
  private load(): void {
    const outcome = loadStateFile<SessionStoreFile>({
      path: this.path,
      version: SCHEMA,
      empty: () => ({ schema_version: SCHEMA, active_id: null, sessions: [] }),
      parse: (raw) => normalizeSessionFile(raw as SessionStoreFile),
      migrations: {
        // 0.1 stored the same shape; the upgrade exists so the version can be
        // bumped without stranding anyone who already has a file.
        'she-sessions/0.1': (raw) => ({ ...raw, schema_version: SCHEMA }),
        // A file with no version at all is treated as 0.1, which is what every
        // build before this one wrote.
        '*': (raw) => ({ ...raw, schema_version: SCHEMA }),
      },
    });

    this.data = outcome.data;
    if (outcome.recovered) {
      this.recovery = outcome.recovered;
      /*
       * This MUST be reported. A silent quarantine is indistinguishable from the
       * user's history having been deleted — the exact complaint that started
       * this work. Saying where the file went turns an apparent data loss into a
       * recoverable situation.
       */
      log.error(
        `会话文件无法读取，已保留为备份而不是丢弃。原因: ${outcome.recovered.reason}；`
        + `备份: ${outcome.recovered.backup}`,
      );
      // Do not write over the quarantined file's former location until the caller
      // has had a chance to see the notice; the file is safe either way.
      this.save();
    }
    if (outcome.migratedFrom) {
      this.migratedFrom = outcome.migratedFrom;
      log.info(`会话文件已从版本 ${outcome.migratedFrom} 升级到 ${SCHEMA}`);
      this.save();
    }
    if (!existsSync(this.path)) this.save();
  }

  /** The recovery notice from load, if the last file was unusable. */
  get recoveryNotice(): { backup: string; reason: string } | null {
    return this.recovery;
  }

  /** The schema version the last file was upgraded from, if any. */
  get migratedNotice(): string | null {
    return this.migratedFrom;
  }

  private save(): void {
    saveStateFile(this.path, this.data);
  }

  /**
   * List sessions.
   * `includeClosed` returns everything still on disk (i.e. not deleted), which
   * is what the history view needs.
   */
  list(includeClosed = false): {
    active_id: string | null;
    sessions: Omit<ChatSession, 'messages'>[];
  } {
    const all = this.data.sessions.filter((s) => includeClosed || !s.closed);
    return {
      active_id: this.data.active_id,
      // `imported_from` is carried through so the origin of a migrated conversation survives into
      // the list — it is the answer to "where did this come from", and dropping it here would make
      // the field write-only.
      sessions: all.map(({ id, title, created_at, updated_at, closed, closed_at, imported_from }) => ({
        id,
        title,
        created_at,
        updated_at,
        closed,
        closed_at,
        imported_from,
      })),
    };
  }

  /** Sessions that are closed (for the history view). */
  listClosed(): Omit<ChatSession, 'messages'>[] {
    return this.list(true).sessions.filter((s) => s.closed);
  }

  /**
   * Both the open list and the closed list, for the history panel.
   */
  listAll(): Omit<ChatSession, 'messages'>[] {
    return this.list(true).sessions;
  }

  /** Hide a session without losing it. */
  close(id: string): ChatSession | null {
    const s = this.get(id);
    if (!s) return null;
    s.closed = true;
    s.closed_at = nowIso();
    s.updated_at = s.closed_at;
    // Never leave a closed session as the active one.
    if (this.data.active_id === id) {
      this.data.active_id = this.data.sessions.find((x) => !x.closed)?.id ?? null;
    }
    this.save();
    return s;
  }

  /** Bring a closed session back into the working list. */
  reopen(id: string): ChatSession | null {
    const s = this.get(id);
    if (!s) return null;
    delete s.closed;
    delete s.closed_at;
    s.updated_at = nowIso();
    this.data.active_id = s.id;
    this.save();
    return s;
  }

  get(id: string): ChatSession | undefined {
    return this.data.sessions.find((s) => s.id === id);
  }

  create(title?: string): ChatSession {
    const s: ChatSession = {
      id: `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title: title?.trim() || 'New chat',
      created_at: nowIso(),
      updated_at: nowIso(),
      messages: [],
    };
    this.data.sessions.unshift(s);
    this.data.active_id = s.id;
    this.save();
    return s;
  }

  /**
   * Insert conversations migrated from another tool.
   *
   * Deliberately NOT a loop over `create()`. That method is for a user starting a chat: it makes
   * the new session ACTIVE and rewrites the whole file. Importing 500 conversations through it
   * would therefore (a) leave the active session pointing at whichever import finished last —
   * hijacking whatever the user was reading, (b) rewrite a growing JSON file 500 times, and
   * (c) stamp every imported conversation with "now", destroying the original dates that are the
   * only reason the list is usable after a migration.
   *
   * This writes once, keeps `active_id` untouched, preserves the original timestamps, and puts the
   * imported conversations at the top in date order so the list reads naturally.
   */
  importMany(items: ImportedConversation[]): ChatSession[] {
    const created: ChatSession[] = [];
    for (const item of items) {
      const messages = Array.isArray(item.messages) ? item.messages : [];
      const created_at = item.createdAt || nowIso();
      const s: ChatSession = {
        id: `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        title: item.title?.trim() || defaultTitle(messages),
        created_at,
        updated_at: item.updatedAt || created_at,
        messages,
      };
      if (item.importedFrom) s.imported_from = item.importedFrom;
      created.push(s);
    }

    /*
     * Newest first — but only when the items actually carry dates.
     *
     * With no source timestamps every item defaults to "now", computed per item, so sorting by it
     * reorders the batch according to accidental sub-millisecond differences. The caller's order is
     * the meaningful one in that case (it is the order the user selected them in), and a
     * nondeterministic order is worse than none: it makes a test flaky and makes two identical runs
     * produce different lists.
     *
     * When dates ARE present, sorting is the point — a year of history must not arrive reversed.
     */
    const anyDated = items.some((i) => Boolean(i.updatedAt || i.createdAt));
    if (anyDated) {
      created.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    }
    this.data.sessions.unshift(...created);
    this.save();
    return created;
  }

  update(
    id: string,
    patch: { title?: string; messages?: LLMMessage[] },
  ): ChatSession {
    const s = this.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    if (typeof patch.title === 'string' && patch.title.trim()) s.title = patch.title.trim();
    if (Array.isArray(patch.messages)) {
      s.messages = patch.messages;
      if (!patch.title) s.title = defaultTitle(s.messages);
    }
    s.updated_at = nowIso();
    this.save();
    return s;
  }

  remove(id: string): void {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    if (this.data.active_id === id) {
      this.data.active_id = this.data.sessions[0]?.id ?? null;
    }
    this.save();
  }

  setActive(id: string | null): ChatSession | null {
    if (id === null) {
      this.data.active_id = null;
      this.save();
      return null;
    }
    const s = this.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    this.data.active_id = id;
    this.save();
    return s;
  }

  getActive(): ChatSession | null {
    if (!this.data.active_id) return null;
    return this.get(this.data.active_id) ?? null;
  }

  /** Persist current agent history into active session (create one if needed). */
  syncActive(messages: LLMMessage[]): ChatSession {
    let s = this.getActive();
    if (!s) s = this.create();
    return this.update(s.id, { messages });
  }
}
