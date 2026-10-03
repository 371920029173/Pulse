/**
 * Which tool calls may run at the same time, and which may be answered from a result
 * already produced in this turn.
 *
 * The loop used to run every call in a message one at a time. That is a real cost when
 * the model asks for four files at once — four round trips that have nothing to do with
 * each other — but it is *correct*, and the ordering is load-bearing: a `fs_write` must
 * land before the `fs_read` that verifies it, a confirmation must pause the turn at the
 * point the human was asked, and the tool results must be appended in the order the
 * model asked for them.
 *
 * So this module does one narrow, checkable thing: mark the calls that are **pure
 * reads**, and let `agent.ts` overlap exactly those. Everything else — anything that can
 * write, pause, spawn or ask — keeps running one at a time, in order, exactly as before.
 *
 * ## Why an allowlist, and why it is this short
 *
 * Unknown means serial. Plugin tools, MCP tools and anything added later are not here,
 * so they get the old behaviour; the failure mode of guessing wrong is a corrupted turn,
 * and the failure mode of not guessing is a few extra milliseconds. The set below is
 * only tools whose callee has no side effect on the workspace or on shared state.
 *
 * Deliberately absent, though they look like reads:
 *   `lsp_*`      — the language-server pool launches lazily on first use, so two
 *                  concurrent calls can both find no server and both start one
 *   `screenshot` — writes a capture to a temp path; two at once is a collision, not a
 *                  saving
 *   `vision_describe` — spends model capacity, which is the thing a "don't hammer the
 *                  service" cap is for
 *   `git_*` is present because these three only print (`git_status`, `git_diff`,
 *                  `git_log`); `shell` is never, since it can do anything.
 */

/** Tools whose result is a function of state nothing in this turn can change behind them. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'fs_read',
  'fs_list',
  'grep',
  'git_status',
  'git_diff',
  'git_log',
  'kb_query',
  'kb_get',
  'kb_ingest_list',
  'kb_ingest_status',
  'errorbook_lookup',
  'memo_list',
  'skill_read',
  'plan_list',
  'plan_get',
  'schedule_list',
  'schedule_window',
  'reflection_check',
  /*
   * 联网的两个（`web-client.ts`）。它们会花掉的是**对外的额度**而不是工作区的状态，所以值得单独说
   * 一句为什么仍然放进来：
   *
   *   - 并行安全：两个搜索/取页互不影响，先发出的那个也不会改变后一个能拿到什么。
   *   - 同轮复用正好是想要的：模型在同一轮把同一个 query 写两遍（很常见，它忘了刚问过），复用一次
   *     结果就少发一次请求 —— 省的是配额，而不是把新数据当旧数据。缓存的寿命只有一轮，下一轮照常
   *     重查，所以"网页变了"这件事最多延迟一轮。
   *
   * 与之相对，`vision_describe` 不在表里：它花的是**同一条模型通道**的容量，而"别把服务打爆"正是
   * 那条上限存在的理由（见文件头的说明）。搜索源不是我们要保护的模型通道。
   */
  'web_search',
  'web_fetch',
]);

/** Fail-safe: a name nobody vetted runs serially. */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

/**
 * How many read-only calls may be in flight at once.
 *
 * Not a config knob: this is a latency fix, not a throughput setting, and the number
 * that matters is "more than one, fewer than all". Four overlaps the file reads a person
 * would do by hand without opening every shard of a large KB in the same instant — the
 * cap exists so that a workspace that answers slowly is not made slower by being hit
 * forty times at once.
 */
export const MAX_PARALLEL_READS = 4;

/** Split into groups of at most `cap`, preserving order. */
export function inWaves<T>(items: T[], cap: number = MAX_PARALLEL_READS): T[][] {
  const size = Math.max(1, Math.trunc(cap));
  const waves: T[][] = [];
  for (let i = 0; i < items.length; i += size) waves.push(items.slice(i, i + size));
  return waves;
}

/**
 * A stable identity for "the same query".
 *
 * Built from the parsed arguments with keys sorted, because the model re-serialises the
 * object on every round and `{"path":"a","start":1}` and `{"start":1,"path":"a"}` are the
 * same request. An unparseable `arguments` string falls back to its own text: that call
 * was never runnable anyway, and treating it as un-cacheable is the safe direction.
 */
export function queryKey(name: string, rawArgs: string): string {
  let canonical = rawArgs;
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    canonical = stableStringify(parsed);
  } catch {
    /* keep the raw text */
  }
  return `${name}\u0000${canonical}`;
}

/** JSON with object keys sorted, so key order does not change the identity of a query. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `_`-prefixed keys are the agent's own adjustments (see `_stage` in `agent.ts`) and
    // are not part of what the model asked for.
    .filter(([k]) => !k.startsWith('_'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface CallRef {
  index: number;
  name: string;
  rawArgs: string;
}

export interface ReadToPrefetch extends CallRef {
  key: string;
}

/**
 * The calls worth starting early.
 *
 * Only a **prefix**: the run stops at the first call that is not a read. A read that
 * follows a write in the same message is a read of what the write produced, and starting
 * it early would answer it against the old contents — a stale result that looks exactly
 * like a correct one, which is the worst bug this feature could have.
 *
 * Repeats within the prefix collapse to one entry: asking for the same file twice in one
 * message should cost one read, and having two promises for it would mean whichever
 * finished last won the cache.
 */
export function readsToPrefetch(
  calls: ReadonlyArray<{ name: string; rawArgs: string }>,
  isCached: (key: string) => boolean,
): ReadToPrefetch[] {
  const out: ReadToPrefetch[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < calls.length; index++) {
    const { name, rawArgs } = calls[index];
    if (!isReadOnlyTool(name)) break;
    const key = queryKey(name, rawArgs);
    if (seen.has(key) || isCached(key)) continue;
    seen.add(key);
    out.push({ index, name, rawArgs, key });
  }
  return out;
}
