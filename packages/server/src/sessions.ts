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
  /**
   * Directory this conversation works in.
   *
   * Absent on older sessions: those keep following the process workspace, which
   * is what they always did. New sessions stamp the directory so a later
   * workspace switch does not drag them onto another project.
   */
  directory?: string;
  /** Set when this conversation was started by another one. */
  parent_id?: string;
  /**
   * This session runs on its own; it is not the conversation the user is watching.
   *
   * Two things set it: a child handed off to keep running after the parent stopped waiting, and
   * a session the agent created for itself (a scheduled run). The distinction that matters to
   * the rest of the code is ownership — a background session must never become the active one,
   * and the startup pick treats it as second choice.
   */
  background?: boolean;
}

/** One conversation to insert via `importMany`. */
export interface ImportedConversation {
  title: string;
  messages: LLMMessage[];
  createdAt?: string;
  updatedAt?: string;
  importedFrom?: ChatSession['imported_from'];
}

export interface SessionStoreFile {
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

/**
 * Refuse to write session state the loader would not read back intact.
 *
 * `normalizeSessionFile` is deliberately forgiving, because it also reads files
 * this build did not write. That forgiveness is silent, and on the write side
 * silence means loss: it DROPS a record whose `id` is not a non-empty string,
 * and it replaces a non-array `messages` with `[]`. Either one, written to disk,
 * looks like a perfectly healthy file — and the conversation is simply gone at
 * the next start, with no quarantine notice, because nothing ever looked
 * malformed.
 *
 * So the checks below are exactly the loader's silent repairs, turned into
 * refusals. Throwing here leaves the previous file untouched, which is the
 * recoverable outcome.
 *
 * Exported so the rule can be tested on its own, without a store or a disk.
 */
export function assertWritableSessions(data: SessionStoreFile): void {
  if (!data || typeof data !== 'object') throw new Error('会话状态不是对象，拒绝写入');
  if (!Array.isArray(data.sessions)) throw new Error('会话列表不是数组，拒绝写入');

  const ids = new Set<string>();
  for (const [i, s] of data.sessions.entries()) {
    if (!s || typeof s !== 'object') {
      throw new Error(`第 ${i} 条会话不是对象，写下去下次加载会被丢掉，拒绝写入`);
    }
    if (typeof s.id !== 'string' || !s.id) {
      throw new Error(`第 ${i} 条会话没有 id，写下去下次加载会被丢掉，拒绝写入`);
    }
    if (ids.has(s.id)) {
      // Two records with one id: one of them is unreachable, and which one wins
      // depends on load order.
      throw new Error(`会话 id 重复: ${s.id}，拒绝写入`);
    }
    ids.add(s.id);
    if (!Array.isArray(s.messages)) {
      throw new Error(`会话 ${s.id} 的 messages 不是数组，写下去整段对话会变成空，拒绝写入`);
    }
    if (typeof s.title !== 'string') {
      throw new Error(`会话 ${s.id} 的 title 不是字符串，写下去会被改名，拒绝写入`);
    }
    if (typeof s.updated_at !== 'string') {
      throw new Error(`会话 ${s.id} 的 updated_at 不是字符串，拒绝写入`);
    }
  }

  if (data.active_id !== null && !ids.has(data.active_id)) {
    throw new Error(`active_id 指向不存在的会话: ${data.active_id}，拒绝写入`);
  }
}

/**
 * The title a session carries before anything has named it.
 *
 * It is a sentinel, not a default: `update` uses it to tell "nobody has named this yet" (derive
 * one from the first message) from "this session has a name" (leave it alone).
 */
const UNTITLED = 'New chat';

function defaultTitle(messages: LLMMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && typeof m.content === 'string');
  if (firstUser && typeof firstUser.content === 'string') {
    const t = firstUser.content.trim().replace(/\s+/g, ' ');
    return t.length > 42 ? t.slice(0, 42) + '…' : t || 'New chat';
  }
  return 'New chat';
}

/**
 * Which session the user should land in on boot.
 *
 * Pure, and exported, so the RULE can be tested without starting a server. It used to be
 * inline in the server entry, which is why a real defect in it was only ever visible as an
 * intermittent end-to-end failure: `node:test` cannot reach a module-private function, so the
 * interesting part had no direct test at all.
 *
 * The rule, in order:
 *   1. The stored active session, if it has messages — the user's own last conversation.
 *   2. Otherwise the most recently updated session that has messages, so an empty "New chat"
 *      created afterwards (by a stray tab, a test, or an abandoned click) cannot make a healthy
 *      history look deleted. This is the original reason this function exists.
 *   3. Preferring a session the user owns over one the agent created for itself. A scheduled
 *      run writes its transcript into its own session, and being the most recent it would
 *      otherwise win the boot — replacing the user's chat with a job log. Background sessions
 *      are second, not excluded: opening a job log still beats opening nothing.
 *   4. Failing all of that, whatever was stored (possibly nothing, for the caller to replace).
 */
export function chooseStartupSession(
  active: ChatSession | null,
  all: ChatSession[],
): ChatSession | null {
  if (active && (active.messages?.length ?? 0) > 0) return active;

  const withMessages = all
    .filter((s) => (s.messages?.length ?? 0) > 0)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

  const own = withMessages.filter((s) => !s.background);
  return own[0] ?? withMessages[0] ?? active ?? null;
}

export class SessionStore {
  private path: string;
  /** Project directory this file belongs to (`<root>/.she/sessions.json`). */
  readonly rootDir: string;
  private data: SessionStoreFile;
  /** Set when the previous file could not be used and was moved aside. */
  private recovery: { backup: string; reason: string } | null = null;
  /** Set when the previous file was upgraded in place. */
  private migratedFrom: string | null = null;
  /**
   * 本 store 发出去的最后一个时间戳（毫秒）。见 `stamp()`。
   *
   * 懒加载：第一次用到时才去已加载的数据里取最大值，所以不用去动 `load()`。
   */
  private lastStamp = 0;

  /**
   * 单调递增的"现在时刻"，用于 `created_at` / `updated_at`。
   *
   * 为什么不能直接用 `new Date().toISOString()`：它的粒度是毫秒，而"两条会话在同一毫秒里各自被碰到
   * 一次"在真实使用里是常态 —— 一次激活会先 `persistHistory()`（碰到正在看的那条）再 `setActive()`
   * （碰到被点开的那条），两次调用通常落在同一毫秒。于是两边的 `updated_at` 完全相等，"谁更近"这个
   * 问题就没有答案了。
   *
   * 后果不是理论上的：会话栈拿 `created_at` 当平手时的次序，而 store 是靠位置（`hoist`）表达的。
   * 平手时两者会给出**不同**的顺序 —— 实测 4 次跑出 3 次红：`store: 甲,丙,乙` 而 `rail: 丙,甲,乙`。
   * 界面上就是"我点了那条，它没跳到最上面"。
   *
   * 所以时间戳必须是严格递增的：撞上同一毫秒（或时钟被往回调）就往后借 1 毫秒。差额小于一毫秒，
   * 对任何展示都没有影响，但它让"最后一次被碰到"永远有唯一答案。
   */
  private stamp(): string {
    if (this.lastStamp === 0) {
      // 接着磁盘上的最大值走，免得重启后新会话排到老会话前面去（时间戳被往回调时）。
      for (const s of this.data.sessions) {
        const t = Date.parse(s.updated_at || '') || 0;
        if (t > this.lastStamp) this.lastStamp = t;
      }
    }
    const t = Date.now();
    const next = t > this.lastStamp ? t : this.lastStamp + 1;
    this.lastStamp = next;
    return new Date(next).toISOString();
  }

  constructor(baseDir: string) {
    const dir = join(baseDir, '.she');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.rootDir = baseDir;
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
    this.pinMissingDirectories();
  }

  /** Older chats had no directory and followed whichever project was open. */
  private pinMissingDirectories(): void {
    let changed = false;
    for (const s of this.data.sessions) {
      if (!s.directory) {
        s.directory = this.rootDir;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** The recovery notice from load, if the last file was unusable. */
  get recoveryNotice(): { backup: string; reason: string } | null {
    return this.recovery;
  }

  /** The schema version the last file was upgraded from, if any. */
  get migratedNotice(): string | null {
    return this.migratedFrom;
  }

  /**
   * Persist.
   *
   * Validated before the file is touched: the alternative — writing state the
   * loader would then repair — is how a healthy-looking `sessions.json` ends up
   * holding fewer conversations than the user had. See `assertWritableSessions`.
   */
  private save(): void {
    saveStateFile(this.path, this.data, { validate: assertWritableSessions });
  }

  /**
   * List sessions.
   * `includeClosed` returns everything still on disk (i.e. not deleted), which
   * is what the history view needs.
   */
  /**
   * 会话列表，**最近用过的在最前面**。
   *
   * 这个顺序不是在这里排出来的，而是被维护出来的：`create` 把新会话放到最前面，`update` 和
   * `setActive`（也就是"被用到"的两条路径）把它移回最前面。
   *
   * 为什么不在读的时候按 `updated_at` 排：`importMany` 有一条刻意的规则 —— 导入的对话**没有来源
   * 时间戳时保持调用方给出来的顺序**（那是用户选择它们的顺序），因为每个条目的"现在"是逐条算的，
   * 按它排等于按亚毫秒的偶然差别重排这一批。读时排序会让那条规则失效（实测：`importMany` 的
   * 顺序测试转红），而且同一份数据在 `/api/sessions` 和会话栈上会出现两种顺序。维护顺序没有
   * 这个问题：它只改变"哪一条被碰到了"，不改变没被碰到的那一批的相对位置。
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
      sessions: all.map(({ id, title, created_at, updated_at, closed, closed_at, imported_from, directory, parent_id, background }) => ({
        id,
        title,
        created_at,
        updated_at,
        closed,
        closed_at,
        imported_from,
        directory,
        parent_id,
        background,
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

  /**
   * The session with this id, created if it is not there yet — without becoming the active one.
   *
   * Written for a measured data loss. `persistHistory` had no branch for an id it did not
   * recognise, so it fell through to `syncActive` — which writes into whichever conversation is
   * ACTIVE. A caller that addressed a session id the store did not have (a script, a stale page, a
   * typo in `session_id`) therefore OVERWROTE the transcript of the chat the user was reading with
   * its own four messages. Measured twice in one day: `POST /api/chat {"session_id":"sess_harvest_probe"}`
   * replaced a 29-message conversation, and the file went from 786KB to 290KB.
   *
   * The id a client addressed is a session, whether or not anyone created it first: give it a home
   * rather than writing over someone else's. It stays out of `active_id` for the same reason
   * `background` sessions do — a session nobody asked to open must not replace the one on screen.
   */
  ensure(id: string, opts?: { title?: string; directory?: string }): ChatSession {
    const existing = this.get(id);
    if (existing) return existing;
    const s: ChatSession = {
      id,
      title: opts?.title?.trim() || UNTITLED,
      created_at: nowIso(),
      updated_at: nowIso(),
      messages: [],
      directory: opts?.directory || this.rootDir,
    };
    this.data.sessions.unshift(s);
    this.save();
    return s;
  }

  get(id: string): ChatSession | undefined {
    return this.data.sessions.find((s) => s.id === id);
  }

  create(title?: string, opts?: { directory?: string; parentId?: string; background?: boolean }): ChatSession {
    /*
     * 一次取一个时间戳给两个字段用：分开取会让 `created_at` 和 `updated_at` 差 1 毫秒，而
     * "没被碰过"的会话两者本该相等 —— 有代码和测试依赖这个等式。
     */
    const ts = this.stamp();
    const s: ChatSession = {
      id: `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title: title?.trim() || UNTITLED,
      created_at: ts,
      updated_at: ts,
      messages: [],
      directory: opts?.directory || this.rootDir,
    };
    if (opts?.parentId) s.parent_id = opts.parentId;
    if (opts?.background) s.background = true;
    this.data.sessions.unshift(s);
    /*
     * A child must not steal whichever conversation the user is reading — and neither must a
     * session the AGENT created for itself.
     *
     * This used to be guarded only by `parentId`, so a scheduled run (which passes a name and
     * no parent) took over `active_id` every time it fired. The visible effect arrived a boot
     * later: the run leaves messages in its own session, `pickStartupSession` prefers the most
     * recently updated session that has any, and the user's conversation is replaced by a job
     * log. Passing `background: true` says the session is a side effect of other work rather
     * than something to open.
     */
    if (!opts?.parentId && !opts?.background) this.data.active_id = s.id;
    this.save();
    return s;
  }

  /** Sessions started by `parentId`, including ones already sent to the background. */
  childrenOf(parentId: string): ChatSession[] {
    return this.data.sessions.filter((s) => s.parent_id === parentId);
  }

  markBackground(id: string): ChatSession | null {
    const s = this.get(id);
    if (!s) return null;
    s.background = true;
    s.updated_at = nowIso();
    this.save();
    return s;
  }

  /**
   * Remove a session and return it, for a move onto another project.
   * The caller inserts it into the destination store.
   */
  extract(id: string): ChatSession | null {
    const s = this.get(id);
    if (!s) return null;
    const copy: ChatSession = { ...s, messages: [...s.messages] };
    this.remove(id);
    return copy;
  }

  /** Insert a session that already has an id (the other half of `extract`). */
  adopt(session: ChatSession): ChatSession {
    if (this.get(session.id)) throw new Error(`session already exists: ${session.id}`);
    this.data.sessions.unshift(session);
    this.data.active_id = session.id;
    this.save();
    return session;
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
    /*
     * 没有来源时间戳的条目共用**同一个**"现在"，而不是各算各的。
     *
     * 逐条 `nowIso()` 会让同一批里的条目相差 0–2 毫秒，于是"这批该是什么顺序"变成了对亚毫秒差
     * 别的赌博：`list()` 维护顺序时它们算平手（保持调用方顺序），而按 `updated_at` 排的地方
     * （会话栈）会按那个偶然差别重排 —— 同一批数据两种顺序。给它们同一个时间戳，两边就同解。
     */
    const batchStamp = this.stamp();
    const created: ChatSession[] = [];
    for (const item of items) {
      const messages = Array.isArray(item.messages) ? item.messages : [];
      const created_at = item.createdAt || batchStamp;
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
    this.data.sessions.unshift(...created);    this.save();
    return created;
  }

  update(
    id: string,
    patch: { title?: string; messages?: LLMMessage[]; directory?: string },
  ): ChatSession {
    const s = this.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    if (typeof patch.title === 'string' && patch.title.trim()) s.title = patch.title.trim();
    if (typeof patch.directory === 'string' && patch.directory.trim()) s.directory = patch.directory;
    if (Array.isArray(patch.messages)) {
      s.messages = patch.messages;
      /*
       * Only name an UNNAMED session. Overwriting unconditionally renamed anything a caller had
       * deliberately titled, because this branch runs on every transcript persist — not just once.
       *
       * `persistHistory` writes messages (and nothing else) on every turn tick, on session
       * activate, and when settings change. Re-deriving the title there meant:
       *
       *   - a delegated child lost the name its parent gave it and became the first line of its
       *     handoff brief ("## 交接单 - 交付物：…"), because the brief is the child's first user
       *     message and the child's own titled write happens earlier;
       *   - a rename by the user survived only until the next message in that conversation.
       *
       * Both were invisible in normal use: for an ordinary chat the derived title already equals
       * what was stored, so the corruption only showed on sessions whose title came from somewhere
       * other than their own first message.
       */
      if (!patch.title && s.title === UNTITLED) s.title = defaultTitle(s.messages);
    }
    s.updated_at = this.stamp();
    /*
     * 被碰到就移到最前面 —— "最近用过的在最上面"是这个 store 维护出来的，不是读的时候排出来的。
     *
     * 之前这里只改 `updated_at` 而不动位置：一分钟前刚说过话的会话还待在它当初被创建的地方，
     * 列表看起来是乱的（用户的原话是"chat 的排序不该按活跃排序吗"）。而会话栈是按 `updated_at`
     * 排的，同一批数据两种顺序。
     *
     * 放在 `update` 里是因为它是"这条会话被用到了"的唯一入口：`persistHistory` 每轮都在调它。
     * 逐条重排而不是读时排序，是为了不打断 `importMany` 刻意保留的导入顺序（见 `list`）。
     */
    this.hoist(s.id);
    this.save();
    return s;
  }

  /** 把一条会话移到数组最前面（已经是第一条时什么都不做）。 */
  private hoist(id: string): void {
    const i = this.data.sessions.findIndex((s) => s.id === id);
    if (i <= 0) return;
    const [s] = this.data.sessions.splice(i, 1);
    this.data.sessions.unshift(s);
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
    /*
     * 选中也算"用到过"：用户点开一条会话却不说话，它也该排到最上面去 —— Cursor 就是这样，而
     * 列表的顺序应该反映用户看到的东西的顺序，不是"只有发过消息才算数"。
     *
     * `updated_at` 必须一起抬：顺序有两处读它 —— 这个 store 自己靠 `hoist` 维护位置，会话栈
     * （`/api/conversations`）靠 `updated_at` 排序。只 hoist 不抬时间戳，会话栈就仍把这条留在
     * 原位，同一批数据两种顺序（实测 2026-10-01：激活最早那条后 `/api/sessions` 把它排到第一，
     * 会话栈排第三）。要一致就得两条路都走。
     */
    s.updated_at = this.stamp();
    this.hoist(id);
    this.save();
    return s;
  }

  getActive(): ChatSession | null {
    if (!this.data.active_id) return null;
    return this.get(this.data.active_id) ?? null;
  }
}
