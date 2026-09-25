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
 */
export function isWorthRemembering(kind: ErrorbookKind): boolean {
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
  }
}

/** Metadata marker, so a node can be recognised as an entry without guessing from the group. */
const MARKER = 'errorbook';

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
  record(report: FailureReport): { entry: ErrorEntry; recurring: boolean } {
    return this.upsert({
      groupName: toolGroupName(report.tool),
      signature: this.signatureOf(report),
      tool: toolGroupName(report.tool),
      kind: report.kind,
      call: oneLine(report.call ?? '', MAX_CALL),
      detail: oneLine(report.detail, MAX_DETAIL),
      remedy: report.remedy ?? null,
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
  recordReflection(report: ReflectionReport): { entry: ErrorEntry; recurring: boolean } {
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
  }): { entry: ErrorEntry; recurring: boolean } {
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
      this.store.updateMemory(prior.id, {
        title: `${spec.tool} · ${spec.kind} · ${count} 次`,
        content: this.renderContent(entry),
        metadata: {
          ...prior.metadata,
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
      return { entry, recurring: true };
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
    const limit = Math.max(1, opts.limit ?? 5);
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
      return this.ranked()
        .filter((r) => r.entry.group === group || r.entry.tool === wanted)
        .map((r) => r.entry)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
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
      return this.allEntries().filter((e) => ids.has(e.id)).slice(0, limit);
    }

    return this.allEntries().slice(0, limit);
  }

  /** Everything recorded, for a status line. Cheap: the book is small by design. */
  count(): number {
    return this.allEntries().length;
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
      const entries = book.lookup(tool ? { tool, limit } : { query, limit });
      if (!entries.length) {
        return tool
          ? `错题本里没有 ${tool} 的记录。`
          : '错题本里没有匹配的记录。';
      }
      const header = `错题本有 ${entries.length} 条：`;
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
