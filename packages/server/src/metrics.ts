/**
 * Process-level metrics.
 *
 * `/api/usage` reports one session's token count, which answers "what did this
 * chat cost". It cannot answer the operational questions: how many turns the
 * process served, how many failed, how long they took, which tools are actually
 * used, and — the one that determines the bill — what fraction of prompt tokens
 * came from the cache.
 *
 * The cache figure is the reason this exists. Prompt caching is prefix-based, so a
 * regression that changes the request prefix (trimming history from the front, for
 * instance) silently moves every subsequent turn from ~97% cached to 0% cached.
 * The feature keeps working and the cost multiplies; without a number on screen
 * there is nothing to notice. See docs/context-and-caching.md.
 *
 * Counters live in memory and reset with the process, which is the right scope: a
 * restart is a fresh baseline, and nothing here needs to survive one.
 */

export interface ToolStat {
  calls: number;
  errors: number;
  totalMs: number;
}

export interface MetricsSnapshot {
  uptimeMs: number;
  startedAt: string;
  turns: {
    total: number;
    ok: number;
    failed: number;
    /** Average and p95 wall-clock duration of a turn, in ms. */
    avgMs: number;
    p95Ms: number;
  };
  tokens: {
    prompt: number;
    completion: number;
    total: number;
    reasoning: number;
    cacheHit: number;
    cacheMiss: number;
    /**
     * Share of prompt tokens served from the cache, 0–1.
     *
     * Below ~0.5 in a multi-turn conversation means the request prefix is
     * changing when it should not — investigate before it shows up on an invoice.
     */
    cacheHitRate: number;
  };
  tools: Array<{ name: string; calls: number; errors: number; avgMs: number }>;
  errors: {
    /** Failures caught at the request boundary. */
    requestFailures: number;
    /** Unhandled exceptions and rejections the process survived. */
    crashes: number;
  };
}

/** Keeps a bounded sample of turn durations, enough for a stable p95. */
const DURATION_WINDOW = 200;

export class Metrics {
  private readonly startedAtMs = Date.now();

  private turnsTotal = 0;
  private turnsOk = 0;
  private turnsFailed = 0;
  private readonly durations: number[] = [];

  private prompt = 0;
  private completion = 0;
  private total = 0;
  private reasoning = 0;
  private cacheHit = 0;
  private cacheMiss = 0;

  private readonly tools = new Map<string, ToolStat>();

  private requestFailures = 0;
  private crashes = 0;

  /** Record a completed turn. */
  recordTurn(ms: number, ok: boolean): void {
    this.turnsTotal++;
    if (ok) this.turnsOk++;
    else this.turnsFailed++;
    this.durations.push(ms);
    // Keep memory flat on a long-running process; the window is wide enough that
    // a p95 over it is still meaningful.
    if (this.durations.length > DURATION_WINDOW) this.durations.shift();
  }

  /**
   * Add a turn's token usage.
   *
   * Takes a delta rather than reading a running total, because each agent reports
   * its own cumulative usage and only the caller knows which slice is new.
   */
  recordTokens(u: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    cache_hit_tokens?: number;
    cache_miss_tokens?: number;
  }): void {
    this.prompt += u.prompt_tokens ?? 0;
    this.completion += u.completion_tokens ?? 0;
    this.total += u.total_tokens ?? 0;
    this.reasoning += u.reasoning_tokens ?? 0;
    this.cacheHit += u.cache_hit_tokens ?? 0;
    this.cacheMiss += u.cache_miss_tokens ?? 0;
  }

  recordTool(name: string, ms: number, errored: boolean): void {
    const stat = this.tools.get(name) ?? { calls: 0, errors: 0, totalMs: 0 };
    stat.calls++;
    stat.totalMs += ms;
    if (errored) stat.errors++;
    this.tools.set(name, stat);
  }

  /**
   * Count a request that failed with a server-side error.
   *
   * Was never called, so `errors.requestFailures` was permanently 0 — including right after a crash,
   * which made the metric worse than useless: it looked like evidence that nothing was going wrong.
   */
  recordRequestFailure(): void { this.requestFailures++; }

  /** Count a crash-handler invocation. Called from the `uncaughtException`/`unhandledRejection` path. */
  recordCrash(): void { this.crashes++; }

  snapshot(): MetricsSnapshot {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    const accounted = this.cacheHit + this.cacheMiss;
    return {
      uptimeMs: Date.now() - this.startedAtMs,
      startedAt: new Date(this.startedAtMs).toISOString(),
      turns: {
        total: this.turnsTotal,
        ok: this.turnsOk,
        failed: this.turnsFailed,
        avgMs: sorted.length ? Math.round(this.durations.reduce((a, b) => a + b, 0) / this.durations.length) : 0,
        p95Ms: Math.round(p95),
      },
      tokens: {
        prompt: this.prompt,
        completion: this.completion,
        total: this.total,
        reasoning: this.reasoning,
        cacheHit: this.cacheHit,
        cacheMiss: this.cacheMiss,
        cacheHitRate: accounted ? Number((this.cacheHit / accounted).toFixed(4)) : 0,
      },
      tools: [...this.tools.entries()]
        .map(([name, s]) => ({ name, calls: s.calls, errors: s.errors, avgMs: Math.round(s.totalMs / s.calls) }))
        .sort((a, b) => b.calls - a.calls),
      errors: {
        requestFailures: this.requestFailures,
        crashes: this.crashes,
      },
    };
  }
}

/** The process's metrics. Module-scoped: one server process, one set of counters. */
export const metrics = new Metrics();
