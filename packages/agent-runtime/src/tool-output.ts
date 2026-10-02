/**
 * What one tool result is allowed to cost the context — forever, not once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT ABOUT ONE BIG RESULT
 *
 * A tool result is not paid for once. It is appended to the history, and the history is re-sent on
 * every request for the rest of the session. So a result of N characters costs N × (requests left
 * in the session) — the multiplier, not the size, is what makes this the largest cost in the
 * product.
 *
 * Measured (2026-10-03, a real self-evaluation session, `sess_8cd40d35a3cb`):
 *
 *   transcript                964,280 characters over 131 messages
 *   one `shell_wait` result   732,633 characters — 76% of the whole session, from ONE call
 *   that run                  35 requests, 9,318,458 prompt tokens
 *
 * The cache was working (96% hit, 8.94M cached / 378k missed). The hit rate was never the problem:
 * the context itself was 278k tokens, so even a cache hit is a large bill, and the 4% that missed
 * was ~10x a healthy session's entire input.
 *
 * Nothing bounded it. `sandbox.maxOutputBytes` defaults to 0 (no cap), the background-job buffer
 * caps at 1MB, and the agent pushed whatever a tool returned straight into `history` with no limit
 * and no compaction.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The rule here is deliberately a CONTEXT budget rather than a tool-output cap: it applies to every
 * producer (sandbox, KB, plan, plugins, every MCP server) because the agent is the only place that
 * knows what the context costs. A tool cannot be trusted with this number — a third-party MCP server
 * certainly cannot.
 *
 * Two properties are load-bearing:
 *
 *   1. **Deterministic.** A pure function of the result text, computed ONCE when the result is
 *      stored. It must never be recomputed per request: the system message and the history are the
 *      head of the provider's cache prefix, so a boundary that moved between turns would re-bill
 *      the whole conversation (see `docs/context-and-caching.md`).
 *   2. **Honest.** The elision is stated with the real sizes, and it names the concrete call that
 *      gets the rest — the same shape `kb_query` already uses for `full=true`.
 */

/**
 * How many characters one tool result may contribute to the context.
 *
 * 16,000 characters is ~4.6k prompt tokens at the measured 3.47 chars/token. The budget is judged
 * against what a result has to carry, not against what a log can produce:
 *
 *   - a test summary, a `grep` hit list, a plan listing, a `kb_query` answer: all far under it;
 *   - a long file read: over it, and `fs_read` already takes `startLine`/`endLine`;
 *   - a 600-second build log: 45x over it, and nobody reads the middle.
 *
 * Deliberately not configurable yet: a knob nobody measures is a knob that gets turned up. If a
 * real workspace needs more, that is a decision with a measurement behind it.
 */
export const TOOL_RESULT_CONTEXT_CHARS = 16_000;

/**
 * The split when a result is over budget: three-eighths head, five-eighths tail.
 *
 * Both ends are kept because both carry distinct information and neither is inferable from the
 * other. For a log the head says what started and the tail says how it ended; for a file the head
 * holds the imports and the tail the exports; for a hit list the head shows what matched and the
 * tail shows how far it went. The middle of a long result is the part that repeats.
 *
 * The tail gets the larger share: an ending (an exit code, a summary, the error that stopped it) is
 * usually the reason the call was made.
 */
const HEAD_CHARS = 6_000;
const TAIL_CHARS = 10_000;

/**
 * How to get the part that was elided, per producer.
 *
 * Kept as a table rather than one generic sentence because a vague remedy is worse than none: the
 * reader has just been told that data it asked for is missing, and "请提供更小的范围" leaves it
 * guessing which parameter that is. Each entry names a call the reader can actually make.
 *
 * Matched by tool name, first rule wins, `null` means the generic line below is used.
 */
const REMEDIES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^shell$|^shell_wait$|^shell_jobs$/,
    '要看到被省略的部分，把命令改窄重跑一次（加过滤、只输出结尾、或把结果写进文件后用 fs_read 分段读）。'
    + '后台任务的输出是分段的：`shell_wait` 一次只收一段，剩下的还在任务缓冲里。',
  ],
  [
    /^fs_read$/,
    '用 `fs_read` 的 startLine / endLine 分段读，需要哪一段读哪一段。',
  ],
  [
    /^grep$|^fs_search$/,
    '收窄 pattern 或限定目录/文件后缀再搜一次，让命中数量落在一屏里。',
  ],
  [
    /^kb_query$/,
    '`kb_query` 默认给摘要；要逐字原文再加 `full=true`，或收窄查询条件。',
  ],
  [
    /^list_jobs$|^shell_list$/,
    '先按名字或条件过滤，再取具体的一项。',
  ],
];

const GENERIC_REMEDY = '把这次调用的范围改小（加过滤条件、限定路径、分段取）再调一次。';

/** The remedy line for a tool whose result was elided. */
export function elisionRemedy(toolName: string): string {
  for (const [re, text] of REMEDIES) if (re.test(toolName)) return text;
  return GENERIC_REMEDY;
}

export interface BudgetedToolResult {
  /** What goes into the history. Identical to the input when it was under budget. */
  text: string;
  truncated: boolean;
  /** Characters the tool actually returned, before the budget. */
  fullChars: number;
  /** Characters dropped from the middle. */
  elidedChars: number;
}

/**
 * Fit one tool result into the context budget.
 *
 * Empty for an empty input (`''` stays `''`) so callers never have to special-case it: an empty
 * result is a meaningful answer (see `classifyToolResult`'s `empty`), and padding it with a note
 * would turn "nothing matched" into "something happened".
 *
 * The invariant is `result.text.length <= limit`: the note is part of the budget, not an extra on
 * top of it. That is why the split is fitted in a loop rather than computed once — the note's own
 * length depends on the sizes it is reporting, so the two have to be solved together. Two
 * properties make the loop safe: `head + tail` strictly decreases, so it terminates, and it stops
 * as soon as the composition fits.
 *
 * (For a `limit` too small to hold the note — under ~220 characters, which no caller uses — the
 * result is the note plus two characters. Bounded and tiny, which is the right failure direction,
 * rather than an unbounded result.)
 *
 * The `limit` parameter exists for tests and for a caller that must reason about a smaller budget;
 * production always uses the default.
 */
export function budgetToolResult(
  raw: string,
  toolName: string,
  limit = TOOL_RESULT_CONTEXT_CHARS,
): BudgetedToolResult {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const fullChars = text.length;
  if (fullChars <= limit) {
    return { text, truncated: false, fullChars, elidedChars: 0 };
  }

  const remedy = elisionRemedy(toolName);
  const noteFor = (elided: number) => [
    '',
    `[... 省略了 ${elided} 字符：这次调用返回了 ${fullChars} 字符，`
    + `而一条工具结果进入上下文的预算只有 ${limit} 字符。`
    + '上面是开头、下面是结尾，中间那段没有发给你。]',
    `[tool-result] ${remedy}`,
    '',
  ].join('\n');

  // Start from the intended split, then give the note its room. A smaller `limit` gets the same
  // SHAPE (head and tail still distinct) rather than a note longer than the result it replaced.
  let head = Math.min(HEAD_CHARS, Math.floor(limit * 0.375));
  let tail = Math.min(TAIL_CHARS, limit - head);
  let note = noteFor(fullChars - head - tail);
  while (head + tail + note.length > limit && (head > 1 || tail > 1)) {
    const over = head + tail + note.length - limit;
    const fromTail = Math.min(over, tail - 1);
    tail -= fromTail;
    const rest = over - fromTail;
    if (rest > 0) head = Math.max(1, head - rest);
    note = noteFor(fullChars - head - tail);
  }

  const elidedChars = fullChars - head - tail;
  return {
    text: `${text.slice(0, head)}${note}${text.slice(fullChars - tail)}`,
    truncated: true,
    fullChars,
    elidedChars,
  };
}

/** The shape this needs from a stored message — structural, so it does not depend on `LLMMessage`. */
export interface BudgetableMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: ReadonlyArray<{ id: string; function: { name: string } }>;
}

/**
 * The same budget, applied to the REQUEST rather than to the moment a result arrived.
 *
 * `agent.ts` already bounds a result as it is pushed into the history, which keeps what is stored,
 * what the UI renders and what is sent as one transcript. This function exists for the entries that
 * predate that rule, or that arrived through `setHistory` (a session restored from disk, an explicit
 * history edit). Without it the invariant would be "results are bounded if they were pushed by this
 * build" — and the session that produced the 9.3M-token bill would keep re-sending its
 * 732,633-character `shell_wait` result on every request after the fix.
 *
 * It is a NO-OP for anything this build wrote, because that is already inside the budget, and the
 * function returns the input unchanged (same objects) when nothing needs doing. That is what keeps
 * the request prefix byte-stable: this runs on every iteration of every turn, so a boundary that
 * drifted here would re-bill the conversation.
 *
 * Deliberately does NOT rewrite the stored history. Eliding on load would be a cheaper place to do
 * it, but it edits a user's transcript as a side effect of opening it. What this guarantees is the
 * narrower, honest thing: **what is sent is bounded**.
 *
 * The tool name comes from the assistant message that made the call, so a restored result still gets
 * the right "how to get the rest" line instead of the generic one.
 */
export function fitToolResultsToBudget<T extends BudgetableMessage>(history: readonly T[]): T[] {
  const nameOfCall = new Map<string, string>();
  let out: T[] | null = null;

  history.forEach((msg, i) => {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls) nameOfCall.set(call.id, call.function.name);
      return;
    }
    if (msg.role !== 'tool' || msg.content.length <= TOOL_RESULT_CONTEXT_CHARS) return;
    const budgeted = budgetToolResult(msg.content, nameOfCall.get(msg.tool_call_id ?? '') ?? '');
    if (!budgeted.truncated) return;
    if (!out) out = [...history];
    out[i] = { ...msg, content: budgeted.text };
  });

  return out ?? (history as T[]);
}
