/**
 * Cost limits for one turn — **off by default**, and off unless someone asks.
 *
 * The project's standing decision is that no product quota may cut a real task short:
 * a quota stops work halfway through, and doing it again usually costs more than the
 * overrun it was meant to prevent (`docs/s-tier-backlog.md`). That decision is about
 * the DEFAULT, not about the capability. Somebody running this unattended overnight
 * wants a ceiling they choose; somebody watching a long refactor does not.
 *
 * So this is a switch, not a policy: `budget.enabled` is false in `DEFAULTS`, and while
 * it is false `budgetStop()` returns null on every input, which is what makes "the
 * default behaviour is unchanged" a testable claim rather than a promise.
 *
 * What it is NOT: a way to make the agent finish faster, and not a failure. A turn that
 * stops on budget stopped for a stated reason and can be resumed with "继续" — the
 * message says so, because a stop that reads like a crash teaches the user to distrust
 * the tool.
 *
 * Deliberately separate from `SHE_MAX_TOOL_ROUNDS`: that one is a test harness bound
 * (evals set it so a broken loop cannot run forever) and stays independent, so enabling
 * the budget cannot silently change what an eval measures.
 *
 * Everything here is a pure function of (limits, usage). The enforcement point in
 * `agent.ts` is the only place that reads the clock or the counters, which is what keeps
 * the arithmetic testable without a live model.
 */

/** A single turn's ceilings. `0` means "no limit on this axis". */
export interface BudgetLimits {
  /**
   * Whether any of the limits below are enforced.
   *
   * A separate flag rather than "any limit > 0" so that a limit left at a non-zero
   * default cannot start enforcing itself the day someone adds one.
   */
  enabled: boolean;
  /** Model round trips (one request/response cycle each) in one turn. */
  maxToolRounds: number;
  /** Tool calls in one turn. */
  maxToolCalls: number;
  /** Prompt + completion tokens for the turn, as the provider reports them. */
  maxTokens: number;
  /** Wall clock for the turn, in seconds. */
  maxSeconds: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  enabled: false,
  maxToolRounds: 0,
  maxToolCalls: 0,
  maxTokens: 0,
  maxSeconds: 0,
};

export type BudgetKind = 'tokens' | 'seconds' | 'rounds' | 'tool_calls';

/** What the turn has consumed so far. Supplied by the caller, never tracked here. */
export interface BudgetUsage {
  rounds: number;
  toolCalls: number;
  tokens: number;
  elapsedSeconds: number;
}

export interface BudgetStop {
  kind: BudgetKind;
  limit: number;
  used: number;
}

/*
 * The order is load-bearing when several limits are blown at once — the user should be
 * told the one that explains the most.
 *
 * Cost first, then time, then work: tokens are the thing most people turn this on for,
 * and being told "you set a spend ceiling" answers the question better than "you set a
 * round ceiling" when both are true. Within an axis the comparison is `>=`, so a limit
 * of 1 means "one round, then stop" rather than "two".
 */
const CHECKS: Array<{
  kind: BudgetKind;
  limit: (l: BudgetLimits) => number;
  used: (u: BudgetUsage) => number;
}> = [
  { kind: 'tokens', limit: (l) => l.maxTokens, used: (u) => u.tokens },
  { kind: 'seconds', limit: (l) => l.maxSeconds, used: (u) => u.elapsedSeconds },
  { kind: 'rounds', limit: (l) => l.maxToolRounds, used: (u) => u.rounds },
  { kind: 'tool_calls', limit: (l) => l.maxToolCalls, used: (u) => u.toolCalls },
];

/**
 * Which limit, if any, the turn has already reached.
 *
 * Checked BEFORE doing more work, not after: a budget that is consulted once the request
 * has been paid for has already failed at the one job it has. `0` disables an axis.
 */
export function budgetStop(limits: BudgetLimits, usage: BudgetUsage): BudgetStop | null {
  if (!limits.enabled) return null;
  for (const c of CHECKS) {
    const limit = Math.trunc(c.limit(limits));
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const used = c.used(usage);
    if (used >= limit) return { kind: c.kind, limit, used };
  }
  return null;
}

const UNIT: Record<BudgetKind, string> = {
  tokens: 'token',
  seconds: '秒',
  rounds: '轮模型调用',
  tool_calls: '次工具调用',
};

const SETTING: Record<BudgetKind, string> = {
  tokens: 'budget.maxTokens / SHE_BUDGET_MAX_TOKENS',
  seconds: 'budget.maxSeconds / SHE_BUDGET_MAX_SECONDS',
  rounds: 'budget.maxToolRounds / SHE_BUDGET_MAX_TOOL_ROUNDS',
  tool_calls: 'budget.maxToolCalls / SHE_BUDGET_MAX_TOOL_CALLS',
};

/**
 * The text the user sees (and the model reads) when a turn stops on budget.
 *
 * Three things have to be in it, in this order: what stopped it, that a SWITCH did it
 * rather than a failure, and how to get out (resume, or turn it off). Naming the config
 * key matters more than it looks: the ceiling is usually set once and then forgotten, so
 * "why did it stop at 20 rounds" has to be answerable from the message itself.
 */
export function renderBudgetStop(stop: BudgetStop): string {
  return [
    `（已按预算停止：本轮上限 ${stop.limit} ${UNIT[stop.kind]}，已用到 ${stop.used}。）`,
    '',
    '这不是任务失败，也不是知识库的次数限制——是配置里打开的成本上限生效了'
    + `（${SETTING[stop.kind]}）。任务没做完，直接说「继续」就能接着做；`
    + '想取消限制，把 she.config.yaml 里的 budget.enabled 改成 false（或设 SHE_BUDGET_ENABLED=0）。',
  ].join('\n');
}

/**
 * Read a `budget` block into limits, ignoring anything shaped wrong.
 *
 * Every field is validated rather than coerced: a `budget.maxTokens: "20k"` that parsed
 * as `NaN` and then compared with `>=` would silently never fire, which is the worst
 * version of this feature — the user believes a ceiling is protecting them and it is
 * not. The caller's raw values arrive as `unknown` because they can come from YAML or
 * from `process.env`.
 */
export function parseBudgetLimits(raw: unknown, base: BudgetLimits = DEFAULT_BUDGET): BudgetLimits {
  const out: BudgetLimits = { ...base };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;

  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  else if (src.enabled === 'true' || src.enabled === '1') out.enabled = true;
  else if (src.enabled === 'false' || src.enabled === '0') out.enabled = false;

  const axes: Array<[keyof BudgetLimits, unknown]> = [
    ['maxToolRounds', src.maxToolRounds],
    ['maxToolCalls', src.maxToolCalls],
    ['maxTokens', src.maxTokens],
    ['maxSeconds', src.maxSeconds],
  ];
  for (const [key, value] of axes) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[key] = Math.trunc(n) as never;
  }
  return out;
}
