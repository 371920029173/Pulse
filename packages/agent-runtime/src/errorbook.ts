/**
 * The error book: what went wrong, so it is not rediscovered from scratch.
 *
 * A tool failure already reaches the model once, as an annotated result (`tool-result.ts`).
 * That is enough to get through the current turn and no more: the classification is computed
 * and thrown away, so the next session — or the next task, in a fresh context — pays for the
 * same discovery again. The transcript that records it is a linear log read top-to-bottom by
 * a model with a token budget; it is not a place you can ask "has `grep` burned me before?".
 *
 * So failures are written into the knowledge base, which is already a durable, retrievable
 * store with group structure. Two entries of the same mistake are one node with a count, not
 * two nodes: recurrence is the signal that the entry is worth reading, and a duplicate per
 * occurrence would bury it under its own repeats.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS BUILT FROM EXISTING KB PRIMITIVES
 *
 * Deliberately no new node kinds, no new store, no new file format. `tool_outcome` is already
 * a kind, `createGroup`/`addMemoryMaintained` already write, `addTypedEdge` already links, and
 * `query` already retrieves. A second persistence layer would mean a second thing to back up,
 * migrate, and keep out of sync with the KB — and the KB's retrieval is the only reason a note
 * written today is readable in six months.
 *
 * WHERE IT DOES NOT WRITE
 *
 * Everything lands under `errors/<tool>`, never in a fact group. A failure is an observation
 * about this machine at this moment, not a fact about the world, and mixing the two is how a
 * knowledge base starts answering questions with "this once timed out". For the same reason
 * entries are kind `tool_outcome` rather than `fact`, and nothing here writes `preference`:
 * a preference is a standing instruction from the user, and an error book that looked like one
 * would apply a past accident as a rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { ToolFailureKind } from './tool-result.js';
import type { ToolDefinition } from '@she/shared';

/**
 * What kinds of trouble the book records.
 *
 * Tool failures come from `tool-result.ts`, so the two agree on the vocabulary instead of
 * keeping parallel lists. `stuck_loop` is the one thing that is not a tool failure: it is the
 * agent giving up after repeating itself, which is a mistake about APPROACH, and it is exactly
 * the kind of thing worth reading before starting similar work.
 */
export type ErrorbookKind = ToolFailureKind | 'stuck_loop' | 'reflection';

/** A lesson from self-review, as `reflection.ts` produces them. */
export interface ReflectionReport {
  /** What the lesson is about. Doubles as the group's tool column and the de-duplication key. */
  topic: string;
  /** What to do differently. Shown as the entry's detail, because that is what a reader needs. */
  lesson: string;
  /** The observation that justifies it. Kept as the entry's "call". */
  evidence: string;
  sessionId?: string | null;
}

/** One recorded mistake. */
export interface ErrorEntry {
  id: string;
  tool: string;
  kind: ErrorbookKind;
  /** Occurrences of this exact mistake, so a repeat is visible as one. */
  count: number;
  /** ISO timestamp of the most recent occurrence. */
  lastSeenAt: string;
  /** The failing call, truncated. */
  call: string;
  /** The failure text, truncated to its first line. */
  detail: string;
  /** What to do instead, when the classifier knows. */
  remedy: string | null;
  /** Group the entry lives in, for a prompt that wants to say where it came from. */
  group: string;
}

/** A failure to write down. */
export interface FailureReport {
  tool: string;
  kind: ErrorbookKind;
  /** The call: arguments or the command line. */
  call?: string;
  /** The failure text, as the tool produced it. */
  detail: string;
  /** The classifier's advice, if any. */
  remedy?: string | null;
  /** Conversation it happened in; only used to link entries that co-occurred. */
  sessionId?: string | null;
}

/**
 * The slice of `GroupKBEngine` this needs — the write and retrieve half.
 *
 * A narrow structural type rather than the engine itself, so the book can be tested against a
 * fake without a database, and so `agent-runtime` keeps depending on shapes rather than on the
 * kb package's class hierarchy — the same reason `ingest-tools.ts` declares its own.
 */
export interface ErrorbookEngineLike {
  createGroup(name: string, parentId?: string): { id: string; name: string };
  addMemoryMaintained(
    groupId: string,
    kind: 'text' | 'code' | 'fact' | 'tool_outcome' | 'preference',
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): { id: string };
  addTypedEdge(
    sourceId: string,
    targetId: string,
    kind: 'co_occurrence' | 'temporal' | 'hierarchical' | 'weak' | 'cross_group',
    options?: { weight?: number },
  ): unknown;
  query(q: string, opts?: { budget?: number }): {
    nodes: { id: string; title: string; content: string; kind: string }[];
    traces?: { groupPath?: string[] }[];
  };
}

/**
 * The read/write half that lives on `KBStore` rather than on the engine.
 *
 * Passed separately because that is where these methods actually are: the engine owns the
 * POLICY (group maintenance, retrieval) and the store owns the rows. `createIngestTools`
 * takes the same two arguments for the same reason.
 */
export interface ErrorbookStoreLike {
  getAllGroups(): { id: string; name: string; parentGroupId: string | null }[];
  getMemoriesByGroup(groupId: string): {
    id: string;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
  }[];
  updateMemory(id: string, partial: Record<string, unknown>): unknown;
  boostAccess(memoryId: string): void;
}

/** Root group everything is filed under. */
export const ERRORBOOK_ROOT = 'errors';

/**
 * Which failures are worth writing down.
 *
 * Not "all of them". A failure is not the same as a mistake, and the book is only useful if
 * everything in it is something the agent could have done differently:
 *
 *   - `service`, `timeout`, `rate_limited` — the network. These are the same kinds the
 *     classifier marks `retryable`, and that is the same judgement: the identical call may
 *     work next time, so there is no lesson to keep. Recording them would fill the book with
 *     weather and bury the entries that matter.
 *   - `empty` — a `grep` that matched nothing SUCCEEDED. It is the answer to the question
 *     asked, not a mistake, and treating it as one would teach the agent to distrust good
 *     searches.
 *   - `precondition` — "no plan is open" is procedural and stated by the tool itself every
 *     time. It is a thing to do next, not a thing to remember.
 *   - `none` — nothing failed.
 *
 * What is left is what the agent got WRONG: bad arguments, a refused action, a tool that does
 * not exist, a path that is not there, a command that failed, and a failure nobody has
 * classified yet. Those are worth reading before doing similar work again.
 *
 * `reflection` is in the yes-list by a different route: it is not a tool failure at all, it is a
 * self-review finding written by `reflection.ts` (drift, over-confidence, a repeated loop). It
 * qualifies for the same test — it is a thing the agent could have done differently.
 *
 * Takes a plain string as well as the union, and an UNRECOGNISED kind answers `true`. The two
 * callers read their kind out of a run trace, where the value is a string that outlived the
 * version that wrote it; a kind this build has never heard of is a reason to look, not a reason
 * to silently drop the only record of it.
 */
export function isWorthRemembering(kind: ErrorbookKind | string): boolean {
  if (kind === 'stuck_loop' || kind === 'reflection') return true;
  switch (kind) {
    case 'invalid_args':
    case 'permission':
    case 'unavailable':
    case 'not_found':
    case 'nonzero_exit':
    case 'unknown':
      return true;
    case 'none':
    case 'empty':
    case 'precondition':
    case 'service':
    case 'timeout':
    case 'rate_limited':
      return false;
    default:
      return true;
  }
}

/**
 * The reserved argument that marks a tool call as EXPECTED to fail.
 *
 * `errorbook_forget` cleans up after the fact; this stops the entry being written at all. The
 * measured case is the same one — a test run on purpose to watch it fail, a deliberately bad input
 * to check a refusal — and without it every such probe landed in the book as the agent's own
 * mistake and had to be retired by hand. It is an ARGUMENT on the call rather than a mode on the
 * turn because it is a claim about one call: the next, unplanned failure in the same turn is still
 * recorded. The agent loop reads it, strips it before the tool runs, and skips the book.
 */
export const EXPECT_FAILURE_ARG = 'expect_failure';

/**
 * True when a tool call's arguments carry `expect_failure: true`.
 *
 * Takes the raw JSON string as well as a parsed object, because the loop has the raw string in
 * hand at the point it records and a call whose arguments do not parse is simply not flagged.
 * Only a real `true` (or the string "true") counts: a model that writes `expect_failure: "no"`
 * has not declared anything.
 */
export function isIntentionalFailure(args: unknown): boolean {
  let obj: unknown = args;
  if (typeof args === 'string') {
    try { obj = JSON.parse(args); } catch { return false; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const v = (obj as Record<string, unknown>)[EXPECT_FAILURE_ARG];
  return v === true || v === 'true';
}

/**
 * A copy of `def` that advertises `expect_failure` in its schema.
 *
 * Only added where a deliberate failure is routine (`shell`, which runs tests); any other tool
 * still honours the argument if the model sends it, but advertising it on every tool would cost
 * tokens on every request for a rarely-used switch. The original definition is not mutated.
 */
export function withExpectFailureParam(def: ToolDefinition): ToolDefinition {
  const params = (def.parameters ?? { type: 'object', properties: {} }) as {
    type?: string; properties?: Record<string, unknown>; required?: string[];
  };
  return {
    ...def,
    parameters: {
      ...params,
      properties: {
        ...(params.properties ?? {}),
        [EXPECT_FAILURE_ARG]: {
          type: 'boolean',
          description: 'Set true ONLY when this call is meant to fail (an intentional failing test, a deliberately '
            + 'rejected input). The failure is then not recorded in the error book. Leave it out otherwise.',
        },
      },
    } as ToolDefinition['parameters'],
  };
}

/**
 * The concrete "do this instead" for a policy refusal, or null when the refusal is not one of the
 * known kinds.
 *
 * The classifier's remedy is a pure function of the KIND (it feeds the stuck-loop signature), so for
 * every `permission` it can only say "the sandbox refused; don't retry" — true, and useless as a
 * lesson six sessions later. The book is read later and out of context, so it stores the specific
 * route instead, derived from the refusal text the sandbox and guardrail actually produce
 * (`sandbox/shell.ts`, `sandbox/tools.ts`, `guardrail.ts`). Matched on the tool's own wording,
 * most specific first; the remedy is still a pure function of the failure, so a repeat of the same
 * refusal keeps the same entry.
 */
export function policyRemedy(report: { tool?: string; call?: string; detail: string }): string | null {
  const d = String(report.detail ?? '');
  if (/只能通过 kb_\*? ?工具|知识库文件/.test(d)) {
    return '知识库只能走 kb_* 工具：查用 kb_query，写用 kb_upsert / kb_link。'
      + '不要用 shell（sqlite3 等）或 fs_* 直接读写库文件（.she/kb.sqlite 及其 -wal/-shm）。';
  }
  if (/检测到敏感内容|已拒绝写入/.test(d)) {
    return '交付文件里不要写入密钥/令牌等敏感值：改用环境变量或占位符（如 ${API_KEY}），真值由用户自己填。';
  }
  if (/escapes workspace|工作区外|只允许工作区内|命令包含 \.\.\//i.test(d)) {
    return '只在工作区内操作：用相对工作区根的路径，不要用 ../、绝对路径、cd 或重定向跳到工作区外；'
      + '需要外部文件就请用户把它复制进工作区。';
  }
  if (/重定向（> 或 <）|重定向目标/.test(d)) {
    return '白名单模式下不要用 > / < 重定向：写文件用 fs_write，读文件用 fs_read。';
  }
  if (/\$\(\) 或反引号/.test(d)) {
    return '白名单模式下不要用 $() 或反引号嵌套命令：拆成几次独立的 shell 调用，前一次的输出自己读完再用。';
  }
  if (/不在白名单内/.test(d)) {
    return '这个命令不在白名单里：改用白名单内的命令，或用内置工具代替（读文件 fs_read、列目录 fs_list、'
      + '搜索 grep、写文件 fs_write、看仓库 git_status / git_diff / git_log）；确实需要就向用户说明，由用户放行。';
  }
  if (/destructive command blocked/i.test(d)) {
    return '破坏性命令（rm -rf、del /s、git reset --hard、format 等）被策略拦截：改单个文件用 fs_write，'
      + '确需删除或回滚就向用户说明要删什么、为什么，由用户确认后执行。';
  }
  return null;
}

/** Metadata marker, so a node can be recognised as an entry without guessing from the group. */
const MARKER = 'errorbook';

/**
 * Metadata marker for an entry the agent has retired, because it was never a mistake.
 *
 * A flag rather than a delete. The entry is evidence about a moment in a session, and deleting it
 * would destroy the record of what the runtime classified — which is the only thing that can be
 * used to judge whether the classifier was wrong. Retired means "do not offer this as a lesson
 * again", and every read (`ranked`, and therefore `lookup`, `count` and the prompt block) honours it.
 */
const FORGOTTEN = 'errorForgotten';

/** Kept short on purpose: an entry is a note, and a long one is never read. */
const MAX_CALL = 200;
const MAX_DETAIL = 300;

/** Collapse whitespace; the same mistake written with different spacing is the same mistake. */
function oneLine(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * Group a failure under its tool, so repeated trouble with one tool is a group rather than a
 * scatter. Falls back to `unknown` when a report carries no tool name, because an entry filed
 * nowhere would be invisible.
 */
function toolGroupName(tool: string): string {
  const name = oneLine(tool, 60).trim();
  return name || 'unknown';
}

export class ErrorBook {
  constructor(
    private engine: ErrorbookEngineLike,
    private store: ErrorbookStoreLike,
  ) {}

  /** The `errors` root, created on first write. */
  private rootId(): string {
    const existing = this.store.getAllGroups()
      .find((g) => g.name === ERRORBOOK_ROOT && g.parentGroupId === null);
    return existing?.id ?? this.engine.createGroup(ERRORBOOK_ROOT).id;
  }

  /** A direct child group of `errors`, created on first write. */
  private groupId(name: string): string {
    const root = this.rootId();
    const existing = this.store.getAllGroups()
      .find((g) => g.name === name && g.parentGroupId === root);
    return existing?.id ?? this.engine.createGroup(name, root).id;
  }

  /**
   * What makes two failures "the same mistake".
   *
   * Exact text, whitespace-collapsed, plus the call. Deliberately NOT normalised further:
   * folding digits or paths together would merge "no such file: a.ts" with "no such file:
   * b.ts", which are two different files to go and look at, and would let the book claim a
   * pattern that is not there. The cost of the stricter rule is that a genuinely flaky detail
   * (a temp path, a timestamp) makes a new entry — which is the safe direction to be wrong in.
   */
  private signatureOf(report: FailureReport): string {
    return `${report.kind}|${oneLine(report.call ?? '', MAX_CALL)}|${oneLine(report.detail, MAX_DETAIL)}`;
  }

  private renderContent(entry: Omit<ErrorEntry, 'id' | 'group'>): string {
    /*
     * Two shapes, because the same fields mean different things for the two kinds of entry and the
     * content is the prose a reader actually opens. Labelling a lesson "原始输出" would read as a
     * command's output and be skimmed past as noise.
     */
    const lines = entry.kind === 'reflection'
      ? [
        `主题：${entry.tool}`,
        `出现次数：${entry.count}`,
        `最近一次：${entry.lastSeenAt}`,
        `教训：${entry.detail}`,
        ...(entry.call ? [`依据：${entry.call}`] : []),
      ]
      : [
        `工具：${entry.tool}`,
        `失败类型：${entry.kind}`,
        `出现次数：${entry.count}`,
        `最近一次：${entry.lastSeenAt}`,
        ...(entry.call ? [`调用：${entry.call}`] : []),
        `原始输出：${entry.detail}`,
        ...(entry.remedy ? [`去路：${entry.remedy}`] : []),
      ];
    return lines.join('\n');
  }

  /**
   * Write down a failure, or count an existing one up.
   *
   * Returns the entry and whether it had been seen before — the caller can decide whether a
   * repeat is worth surfacing, without deriving it from the count.
   */
  record(report: FailureReport): { entry: ErrorEntry; recurring: boolean; reopened?: boolean } {
    return this.upsert({
      groupName: toolGroupName(report.tool),
      signature: this.signatureOf(report),
      tool: toolGroupName(report.tool),
      kind: report.kind,
      call: oneLine(report.call ?? '', MAX_CALL),
      detail: oneLine(report.detail, MAX_DETAIL),
      // A refusal gets the specific sanctioned route (see `policyRemedy`); anything else keeps the
      // classifier's advice.
      remedy: (report.kind === 'permission' || report.kind === 'unknown' ? policyRemedy(report) : null)
        ?? report.remedy ?? null,
      sessionId: report.sessionId ?? null,
    });
  }

  /**
   * The group self-review findings are filed under.
   *
   * One group rather than one per topic: a reflection is read as a SET ("what have I been getting
   * wrong lately?"), and splitting them across `errors/目标漂移` and `errors/过度自信` would make the
   * reader collect them from several places to see the pattern. The topic survives in the entry's
   * tool column and in its signature, which is what de-duplication and display need.
   */
  private static readonly REFLECTION_GROUP = '自省';

  /**
   * Write down a lesson from self-review.
   *
   * Goes through the same upsert as a tool failure, so a recurring lesson counts up instead of
   * filling the book with copies, and it is retrieved by the same reads. The mapping is:
   *
   *   - the TOPIC fills the tool column, so `formatErrorEntry` renders it without a special case
   *     and `errorbook_lookup({ tool })` can be asked about it by name;
   *   - the LESSON becomes the detail, because that is the part a reader acts on;
   *   - the EVIDENCE becomes the call, because that is the part that says whether to believe it.
   *
   * The signature is the topic alone — not the wording. A drift lesson re-derived on a later day
   * will read differently (the quoted signals differ) and would otherwise be a new entry every
   * time, which is how a book about habits turns into a log.
   */
  recordReflection(report: ReflectionReport): { entry: ErrorEntry; recurring: boolean; reopened?: boolean } {
    const topic = toolGroupName(report.topic);
    return this.upsert({
      groupName: ErrorBook.REFLECTION_GROUP,
      signature: `reflection|${topic}`,
      tool: topic,
      kind: 'reflection',
      call: oneLine(report.evidence, MAX_CALL),
      detail: oneLine(report.lesson, MAX_DETAIL),
      remedy: null,
      sessionId: report.sessionId ?? null,
    });
  }

  /**
   * The single write path: find the entry this signature already has, or create it.
   *
   * Shared rather than duplicated because the pieces that matter are the ones that are easy to get
   * subtly different in a copy — the marker, the reason a repeat is upvoted, and the co-occurrence
   * link that keeps only the newest target per session.
   */
  private upsert(spec: {
    /** Direct child of `errors` this entry belongs to. */
    groupName: string;
    signature: string;
    tool: string;
    kind: ErrorbookKind;
    call: string;
    detail: string;
    remedy: string | null;
    sessionId: string | null;
  }): { entry: ErrorEntry; recurring: boolean; reopened?: boolean } {
    const groupId = this.groupId(spec.groupName);
    const groupName = `${ERRORBOOK_ROOT}/${spec.groupName}`;
    const now = new Date().toISOString();

    const prior = this.store.getMemoriesByGroup(groupId)
      .find((m) => m.metadata?.[MARKER] === true && m.metadata?.errorSignature === spec.signature);

    if (prior) {
      const count = Number(prior.metadata?.errorCount ?? 1) + 1;
      const entry: ErrorEntry = {
        id: prior.id,
        count,
        group: groupName,
        tool: spec.tool,
        kind: spec.kind,
        call: spec.call,
        detail: spec.detail,
        remedy: spec.remedy,
        lastSeenAt: now,
      };
      /*
       * An entry the agent retired and then hit AGAIN comes back.
       *
       * "Not a mistake" was a judgement about that situation, and this is the same thing happening
       * in a new one — which is worth re-reading, and worth more than the retirement was. Silently
       * counting it up behind a hidden entry would make the book lie in the other direction: the
       * agent asked not to be told about a thing, and then the thing turned out to be real.
       */
      const carried: Record<string, unknown> = { ...prior.metadata };
      const reopened = carried[FORGOTTEN] === true;
      delete carried[FORGOTTEN];
      delete carried.errorForgottenAt;
      delete carried.errorForgottenReason;
      this.store.updateMemory(prior.id, {
        title: `${spec.tool} · ${spec.kind} · ${count} 次`,
        content: this.renderContent(entry),
        metadata: {
          ...carried,
          errorCall: entry.call,
          errorDetail: entry.detail,
          errorRemedy: entry.remedy,
          errorCount: count,
          errorSeq: ++this.seq,
          errorLastSeenAt: now,
          errorSessionId: spec.sessionId ?? prior.metadata?.errorSessionId ?? null,
        },
      });
      /*
       * A repeat is evidence that this entry MATTERS, so it is upvoted rather than merely
       * rewritten. Retrieval is driven by access, and the failures worth warning about are
       * the ones that keep happening — a note written once and never hit again should not
       * outrank the thing that has cost the user five attempts.
       */
      this.store.boostAccess(prior.id);
      this.linkCoOccurrence(prior.id, spec.sessionId);
      return { entry, recurring: true, reopened };
    }

    const entry: ErrorEntry = {
      id: '',
      count: 1,
      group: groupName,
      tool: spec.tool,
      kind: spec.kind,
      call: spec.call,
      detail: spec.detail,
      remedy: spec.remedy,
      lastSeenAt: now,
    };
    const created = this.engine.addMemoryMaintained(
      groupId,
      'tool_outcome',
      `${spec.tool} · ${spec.kind}`,
      this.renderContent(entry),
      {
        [MARKER]: true,
        errorTool: spec.tool,
        errorKind: spec.kind,
        errorCall: entry.call,
        errorDetail: entry.detail,
        errorRemedy: entry.remedy,
        errorCount: 1,
        errorSeq: ++this.seq,
        errorSignature: spec.signature,
        errorLastSeenAt: now,
        errorSessionId: spec.sessionId,
      },
    );
    entry.id = created.id;
    this.linkCoOccurrence(created.id, spec.sessionId);
    return { entry, recurring: false };
  }

  /**
   * Link this failure to the previous one from the same conversation.
   *
   * `co_occurrence` and nothing stronger: two failures in one turn were observed together,
   * which is a fact, while "A caused B" is a claim this cannot support. The chain is only ever
   * one edge per entry and keeps the most recent target per session, so a long session cannot
   * grow edges quadratically.
   */
  private linkCoOccurrence(entryId: string, sessionId: string | null): void {
    if (!sessionId) return;
    const previous = this.lastBySession.get(sessionId);
    this.lastBySession.set(sessionId, entryId);
    if (!previous || previous === entryId) return;
    try {
      this.engine.addTypedEdge(previous, entryId, 'co_occurrence');
    } catch {
      // The link is a navigational nicety; the entry itself is the payload. A failure to link
      // (a deleted node, a store hiccup) must not cost the record we just wrote.
    }
  }

  /**
   * A monotonic counter for entries written by this process.
   *
   * `lastSeenAt` has millisecond resolution, and two failures in one turn are routinely
   * written inside the same millisecond — at which point sorting by the timestamp alone is a
   * tie, and the order falls back to group creation order, which is not what "newest first"
   * means. The same tie was fixed the same way in `preflight.ts`.
   *
   * Per-process, and that is enough: this only has to order writes that share a millisecond,
   * and those are always from the same process (a restart moves the clock on).
   */
  private seq = 0;

  /** Most recent entry per session, for `linkCoOccurrence`. In-memory: it only orders one turn. */
  private lastBySession = new Map<string, string>();

  /** Every entry under `errors`, newest first. */
  private allEntries(): ErrorEntry[] {
    return this.ranked().map((r) => r.entry);
  }

  /**
   * Every entry with the counter needed to order two of them written in the same millisecond.
   *
   * Internal on purpose: `seq` is how this class breaks a tie in its own bookkeeping, and
   * exposing it in `ErrorEntry` would invite a caller to sort by it as if it meant something
   * across processes.
   */
  private ranked(): { entry: ErrorEntry; seq: number }[] {
    const root = this.store.getAllGroups()
      .find((g) => g.name === ERRORBOOK_ROOT && g.parentGroupId === null);
    if (!root) return [];
    const toolGroups = this.store.getAllGroups().filter((g) => g.parentGroupId === root.id);
    const out: { entry: ErrorEntry; seq: number }[] = [];
    for (const g of toolGroups) {
      for (const m of this.store.getMemoriesByGroup(g.id)) {
        if (m.metadata?.[MARKER] !== true) continue;
        // Retired entries are still in the store — they are only no longer offered as lessons.
        if (m.metadata?.[FORGOTTEN] === true) continue;
        out.push({
          entry: this.toEntry(m, `${ERRORBOOK_ROOT}/${g.name}`),
          seq: Number(m.metadata?.errorSeq ?? 0),
        });
      }
    }
    return out.sort((a, b) => (b.entry.lastSeenAt || '').localeCompare(a.entry.lastSeenAt || '')
      || b.seq - a.seq);
  }

  private toEntry(
    m: { id: string; title: string; content: string; metadata: Record<string, unknown> },
    group: string,
  ): ErrorEntry {
    return {
      id: m.id,
      tool: String(m.metadata?.errorTool ?? ''),
      kind: String(m.metadata?.errorKind ?? 'unknown') as ErrorbookKind,
      count: Number(m.metadata?.errorCount ?? 1),
      lastSeenAt: String(m.metadata?.errorLastSeenAt ?? ''),
      // Read back from metadata rather than parsed out of `content`: the content is prose meant
      // for a reader, and re-deriving fields from it would make the two disagree the first time
      // the wording changes.
      call: String(m.metadata?.errorCall ?? ''),
      detail: String(m.metadata?.errorDetail ?? ''),
      remedy: (m.metadata?.errorRemedy as string | null) ?? null,
      group,
    };
  }

  /**
   * Read the book back.
   *
   * `tool` is the precise question ("what has `shell` done to me?") and `query` is the fuzzy one
   * ("have I been here before?"). Both use the existing retrieval, and neither can return
   * anything from outside the `errors` subtree: `tool` names the group directly, and `query`
   * intersects the retrieval hits with this book's own entries.
   */
  lookup(opts: { tool?: string; query?: string; limit?: number } = {}): ErrorEntry[] {
    return this.lookupPage(opts).entries;
  }

  /**
   * `lookup`, plus how many entries matched before the limit.
   *
   * The tool's header used to print the length of the LIMITED list as "错题本有 N 条", so a book with
   * six entries and the default limit of five claimed to hold five. `total` is the true match count,
   * so a caller can say "显示 5 / 共 6" and the reader knows there is more to ask for.
   */
  lookupPage(opts: { tool?: string; query?: string; limit?: number } = {}): { entries: ErrorEntry[]; total: number } {
    const limit = Math.max(1, opts.limit ?? 5);
    const page = (all: ErrorEntry[]) => ({ entries: all.slice(0, limit), total: all.length });
    if (opts.tool) {
      const wanted = toolGroupName(opts.tool);
      const group = `${ERRORBOOK_ROOT}/${wanted}`;
      /*
       * Built from `ranked()` rather than read group-by-group, so the ordering rule lives in one
       * place. It is already sorted newest-first, and `sort` is stable — so ordering by count
       * here keeps the recency order inside each count, without repeating the tiebreak.
       *
       * Two ways to match, because a tool failure is filed under its tool while a reflection is
       * filed under `errors/自省` and carries its TOPIC in the tool column. Matching only the group
       * would make `errorbook_lookup({ tool: '目标漂移' })` return nothing — a store that answers
       * "no" about entries it is holding is worse than one that answers wrongly, because the agent
       * concludes the mistake was never made.
       */
      return page(this.ranked()
        .filter((r) => r.entry.group === group || r.entry.tool === wanted)
        .map((r) => r.entry)
        .sort((a, b) => b.count - a.count));
    }

    if (opts.query) {
      /*
       * Bounded retrieval, then intersected with the book's own entries.
       *
       * The intersection IS the subtree filter: `allEntries()` reads only the `errors` subtree,
       * so a node from a fact group that merely shares a word cannot survive it. An earlier
       * version filtered on the retrieval trace's group path instead, and was silently dead:
       * the engine renders that path with an arrow (`errors → shell`), not the slash this file
       * assumed, so every query returned nothing — which is indistinguishable from "no
       * mistakes recorded" and wrong in the direction that teaches the agent nothing.
       *
       * Only real matches. An earlier draft fell back to the most recent entries "so the answer
       * is not empty" — which would answer "have I been here before?" with a mistake from an
       * unrelated area, and a model that believes it has prior trouble with this task will
       * change its approach for no reason. No record is a true answer; a wrong one is not.
       */
      const res = this.engine.query(opts.query, { budget: limit * 4 });
      const ids = new Set(res.nodes.map((n) => n.id));
      // `total` here is bounded by the retrieval budget: it counts the matches retrieval returned.
      return page(this.allEntries().filter((e) => ids.has(e.id)));
    }

    return page(this.allEntries());
  }

  /** Everything recorded, for a status line. Cheap: the book is small by design. */
  count(): number {
    return this.allEntries().length;
  }

  /**
   * Find one entry by id, including retired ones.
   *
   * Separate from `lookup` because the two disagree about the one thing this needs to know:
   * `lookup` answers "what lessons apply", and a retired entry is deliberately not one.
   */
  private nodeById(id: string): { node: { id: string; title: string; content: string; metadata: Record<string, unknown> }; group: string } | undefined {
    const root = this.store.getAllGroups()
      .find((g) => g.name === ERRORBOOK_ROOT && g.parentGroupId === null);
    if (!root) return undefined;
    for (const g of this.store.getAllGroups().filter((x) => x.parentGroupId === root.id)) {
      const node = this.store.getMemoriesByGroup(g.id)
        .find((m) => m.id === id && m.metadata?.[MARKER] === true);
      if (node) return { node, group: `${ERRORBOOK_ROOT}/${g.name}` };
    }
    return undefined;
  }

  /**
   * Retire an entry that was not a mistake.
   *
   * Written for one measured case: the agent runs a test that fails ON PURPOSE, and its own
   * classifier files the failure as a mistake it made. Every read afterwards repeats the charge —
   * `errorbook_lookup` answers "you have failed at this three times" about work that went exactly
   * as designed — and there was no way to say so, because writes belong to the loop and the
   * loop's judgement is what was wrong. Retiring is the agent's answer to it, and it is the
   * narrowest one available: the entry stays on disk as evidence about the classifier, and stops
   * being offered as a lesson.
   */
  forget(id: string, reason?: string): { entry: ErrorEntry; already: boolean } | undefined {
    const hit = this.nodeById(id.trim());
    if (!hit) return undefined;
    const entry = this.toEntry(hit.node, hit.group);
    if (hit.node.metadata?.[FORGOTTEN] === true) return { entry, already: true };
    const note = oneLine(reason ?? '', MAX_DETAIL);
    this.store.updateMemory(hit.node.id, {
      // The prose a reader opens says so too: a retired entry that still read as a live mistake
      // would be re-filed as one by whoever found it next, this agent included.
      content: `${hit.node.content}\n\n已退役（${entry.tool} · ${entry.kind}）：${note || '不是我的错误'}`,
      metadata: {
        ...hit.node.metadata,
        [FORGOTTEN]: true,
        errorForgottenAt: new Date().toISOString(),
        errorForgottenReason: note || null,
      },
    });
    return { entry, already: false };
  }
}

/**
 * One entry as one line.
 *
 * Kept to the three things that change a decision — which tool, what happened, and how often —
 * because this text competes for attention with the actual task. The full entry stays in the
 * KB for whoever goes looking.
 */
export function formatErrorEntry(e: ErrorEntry): string {
  const times = e.count > 1 ? `（已出现 ${e.count} 次）` : '';
  return `- ${e.tool} · ${e.kind}${times}：${e.detail}`;
}

/**
 * Format entries for a prompt. Empty string when there is nothing, so a caller can append it
 * unconditionally.
 */
export function renderErrorbook(entries: ErrorEntry[]): string {
  return entries.map(formatErrorEntry).join('\n');
}

export interface ErrorbookToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * The read side, as a tool.
 *
 * Read-only on purpose. Writes happen where the evidence is — the agent loop classifies a
 * result and records it — so there is no `errorbook_record` for the model to call. A tool that
 * let the model write its own notes would be filled with plausible lessons that were never
 * observed, and the whole value of the book is that every entry is a thing that actually
 * happened. Self-review findings arrive by the same rule: `recordReflection` is called from the
 * agent loop with measurements it made itself, not by the model asking for an entry.
 */
export function createErrorbookTools(book: ErrorBook): ErrorbookToolSet {
  const toolMap = new Map<string, { def: ToolDefinition; fn: (a: Record<string, unknown>) => Promise<string> }>();
  const reg = (def: ToolDefinition, fn: (a: Record<string, unknown>) => Promise<string>) =>
    toolMap.set(def.name, { def, fn });

  reg(
    {
      name: 'errorbook_lookup',
      description:
        'Look up mistakes already recorded for this workspace before starting similar work: tool failures '
        + 'that were classified as the agent\'s own error (bad arguments, a refused action, a missing path, a '
        + 'failed command), loops where the same call was repeated until the agent gave up, and lessons from '
        + 'self-review (goal drift, over-confidence, a tool that failed repeatedly). '
        + 'Pass `tool` to ask about one tool precisely, or `query` to ask "have I been here before?". '
        + 'An empty result is a real answer: nothing has gone wrong here yet.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Tool name to look up, e.g. "shell" or "grep".' },
          query: { type: 'string', description: 'Free-text description of what you are about to do.' },
          limit: { type: 'number', description: 'Maximum entries to return (default 5).' },
        },
      },
    },
    async (a) => {
      const tool = typeof a.tool === 'string' ? a.tool.trim() : '';
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      if (!tool && !query) {
        return 'Error: 必须给 tool 或 query 之一（两个都不给就等于问「全部错误」，那不是一次查询）';
      }
      const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.trunc(a.limit) : 5;
      const { entries, total } = book.lookupPage(tool ? { tool, limit } : { query, limit });
      if (!entries.length) {
        return tool
          ? `错题本里没有 ${tool} 的记录。`
          : '错题本里没有匹配的记录。';
      }
      // The TRUE total, and say so when the list below is cut short by `limit`.
      const header = total > entries.length
        ? `错题本有 ${total} 条（显示 ${entries.length} / 共 ${total}，调大 limit 可看全部）：`
        : `错题本有 ${total} 条：`;
      const body = entries.map((e) => {
        const lines = [
          `- [${e.id}] ${e.tool} · ${e.kind}（${e.count} 次，最近 ${e.lastSeenAt}）`,
        ];
        if (e.call) lines.push(`    调用: ${e.call}`);
        if (e.detail) lines.push(`    输出: ${e.detail}`);
        if (e.remedy) lines.push(`    去路: ${e.remedy}`);
        return lines.join('\n');
      });
      return [header, ...body].join('\n');
    },
  );

  reg(
    {
      name: 'errorbook_forget',
      description:
        'Retire one entry from the error book when it is NOT a mistake you made. The measured case: you run '
        + 'something that fails ON PURPOSE (an intentional failing test, a deliberate bad input) and the '
        + 'runtime files the failure as your error, so every later lookup accuses you of it. Pass the `id` '
        + 'from `errorbook_lookup` and say why. The entry stays on disk but stops being offered, so it will '
        + 'not distort what you conclude about this project. If the same failure happens again later it '
        + 'reopens by itself — use this for things you know are by design, not for things you would rather '
        + 'not hear. To keep a planned failure out of the book in the first place, add `"expect_failure": true` '
        + 'to the arguments of the call you expect to fail (any tool; `shell` advertises it) — it is then not '
        + 'recorded at all.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node id of the entry, as printed by `errorbook_lookup` (the [id] prefix).' },
          reason: { type: 'string', description: 'Why it is not a mistake — one line, e.g. "an intentional failing test".' },
        },
        required: ['id'],
      },
    },
    async (a) => {
      const id = typeof a.id === 'string' ? a.id.trim() : '';
      if (!id) {
        return 'Error: 必须给 id（`errorbook_lookup` 的输出里每条记录前面的 [id]）';
      }
      const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
      const done = book.forget(id, reason);
      if (!done) {
        return `错题本里没有 id 为 ${id} 的记录。先 \`errorbook_lookup\` 拿到准确的 id —— `
          + '凭空退役一条不存在的记录，等于自己给自己一个「已经处理过」的错觉。';
      }
      const { entry, already } = done;
      if (already) {
        return `[${entry.id}] ${entry.tool} · ${entry.kind} 早就退役过了，没有重复处理。`;
      }
      return `已退役 [${entry.id}] ${entry.tool} · ${entry.kind}`
        + `${reason ? `（${reason}）` : ''}：它不会再出现在 \`errorbook_lookup\` 或提示词里。`
        + '如果同样的失败再次发生，它会自己重新计数并回来。';
    },
  );

  return {
    definitions: Array.from(toolMap.values()).map((t) => t.def),
    execute: async (name, args) => {
      const entry = toolMap.get(name);
      if (!entry) return `Error: unknown tool "${name}"`;
      try {
        return await entry.fn(args);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
