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
  'plan_list',
  'plan_get',
  'schedule_list',
  'schedule_window',
  'reflection_check',
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
