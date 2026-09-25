/**
 * Repeated samples → a verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Both eval harnesses grade on a pass RATE with a floor, and both say the same
 * thing when something fails: "先重跑一次确认是不是波动". That is an honest
 * admission that one sample cannot tell the two interesting cases apart:
 *
 *   - **回归** — the task fails every time. Something is broken and it will not
 *     fix itself. This is the one that must stop a release.
 *   - **波动** — the task passes sometimes. The behaviour it measures is real but
 *     not deterministic, and the task itself needs a tighter prompt or a more
 *     tolerant check. Failing a release on this trains people to ignore the gate.
 *
 * One sample cannot distinguish them: a single failure is consistent with both.
 * Repeating the run is the only way to separate them, and the numbers that
 * separate them are the ones this module computes.
 *
 * It also closes a hole that a rate hides by construction. A suite where 1 of 12
 * tasks never passes still scores 92%, which clears an 80% floor — a dead tool
 * disappears into an average. With repeated samples there is finally enough
 * evidence to say "this one failed all N times", so that case can be failed
 * outright instead of averaged away. The rule is deliberately gated on N ≥ 3:
 * with 2 samples, a task that really passes 80% of the time still fails twice
 * about 4% of runs, and a gate that fires on that is the flaky gate again.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Population-free statistics: sample standard deviation, so n=2 is not silently 0. */
export function stats(values) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0, min: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, min: Math.min(...values), max: Math.max(...values) };
}

/**
 * How a task behaved across its samples.
 *
 * `pass` / `fail` mean "every sample agreed", which is only evidence of stability
 * when there was more than one sample — the caller has to say how many it took,
 * because "1/1 passed" and "5/5 passed" are not the same claim.
 */
export function verdict(passes, runs) {
  if (runs > 0 && passes === runs) return 'pass';
  if (passes === 0) return 'fail';
  return 'flaky';
}

/**
 * Group per-sample results by task and decide what the suite is saying.
 *
 * `samples` is one entry per (task, run) — flat, because that is the order the
 * harnesses produce them in, and because it keeps a partially finished run
 * readable. Each entry needs `id` and `pass`; `ms` and `tokens` are summarised
 * when present.
 */
export function summarize(samples, opts = {}) {
  const threshold = opts.threshold ?? 0.8;
  // Below this many samples, "it failed every time" is still consistent with an
  // unlucky draw, so a task cannot be called dead yet.
  const minRunsForVerdict = opts.minRunsForVerdict ?? 3;

  const order = [];
  const groups = new Map();
  for (const s of samples) {
    if (!groups.has(s.id)) {
      order.push(s.id);
      groups.set(s.id, []);
    }
    groups.get(s.id).push(s);
  }

  const byTask = order.map((id) => {
    const rows = groups.get(id);
    const passes = rows.filter((r) => r.pass).length;
    const runs = rows.length;
    const v = verdict(passes, runs);
    return {
      id,
      runs,
      passes,
      verdict: v,
      // Only meaningful with repeats; a single sample reports 0 variance, which
      // is a statement about the sample count, not about the task.
      ms: stats(rows.map((r) => r.ms ?? 0)),
      tokens: stats(rows.map((r) => r.tokens ?? 0)),
      // Kept for the "what actually happened" line under a failing task.
      details: rows.filter((r) => !r.pass).map((r) => r.detail).filter(Boolean),
      replies: rows.filter((r) => !r.pass && r.reply).map((r) => r.reply),
      turns: rows[0]?.turns ?? 1,
      note: rows[0]?.note,
    };
  });

  const passed = samples.filter((s) => s.pass).length;
  const rate = samples.length ? passed / samples.length : 0;

  const dead = byTask.filter((t) => t.runs >= minRunsForVerdict && t.passes === 0);
  const flaky = byTask.filter((t) => t.verdict === 'flaky');

  return {
    byTask,
    totals: {
      samples: samples.length,
      tasks: byTask.length,
      passed,
      rate,
      tokens: stats(samples.map((s) => s.tokens ?? 0)),
      ms: stats(samples.map((s) => s.ms ?? 0)),
      // One run = one full pass over the suite; reported because it is the number
      // that multiplies the API bill.
      repeats: samples.length && byTask.length ? samples.length / byTask.length : 0,
    },
    dead,
    flaky,
    threshold,
    minRunsForVerdict,
    // A dead task fails the suite on its own, even though the average cleared the
    // floor. That is the whole point of taking more than one sample.
    ok: rate >= threshold && dead.length === 0,
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** The per-task table plus the verdict lines, as strings, so both harnesses read alike. */
export function formatReport(summary) {
  const { byTask, totals, dead, flaky, threshold, minRunsForVerdict } = summary;
  const lines = [];
  const repeats = Math.round(totals.repeats);

  lines.push('─'.repeat(88));
  for (const t of byTask) {
    const mark = t.verdict === 'pass' ? '✓' : t.verdict === 'flaky' ? '±' : '✗';
    const runs = repeats > 1 ? `  ${t.passes}/${t.runs}` : '';
    // Standard deviation only earns its space when there is more than one sample:
    // printing "±0" next to a single run reads like "rock solid".
    const spread = repeats > 1
      ? `   ${Math.round(t.tokens.mean)}±${Math.round(t.tokens.sd)} tokens   ${secs(t.ms.mean)}±${secs(t.ms.sd)}`
      : `   ${t.tokens.mean} tokens   ${secs(t.ms.mean)}`;
    lines.push(`  ${mark} ${t.id.padEnd(26)}${runs.padEnd(8)}${spread}`);
    for (const d of t.details.slice(0, 3)) lines.push(`      ${d}`);
  }
  lines.push('─'.repeat(88));
  lines.push(`  通过率        ${totals.passed}/${totals.samples} (${pct(totals.rate)})   门槛 ${pct(threshold)}`);
  if (repeats > 1) {
    lines.push(`  每任务重跑    ${repeats} 次   样本 ${totals.samples}   任务 ${totals.tasks}`);
    lines.push(`  用量          ${Math.round(totals.tokens.mean)}±${Math.round(totals.tokens.sd)} tokens   （单次全套均值）`);
  } else {
    lines.push(`  用量          ${totals.tokens.mean} tokens`);
  }
  lines.push(`  总耗时        ${secs(totals.ms.mean * repeats)}`);

  /*
   * The verdict, in the order that matters: a dead task first, because it is the
   * only outcome here that is certainly a regression.
   */
  if (dead.length) {
    lines.push('');
    lines.push(`  ✗ 有任务 ${minRunsForVerdict} 次以上全部失败 —— 这是回归，不是波动：`);
    for (const t of dead) lines.push(`      ${t.id}  ${t.passes}/${t.runs}`);
  }
  if (flaky.length) {
    lines.push('');
    lines.push(`  ± 波动（有时通过、有时不通过，共 ${flaky.length} 个）：`);
    for (const t of flaky) lines.push(`      ${t.id}  ${t.passes}/${t.runs}`);
    lines.push('    这类任务判定不稳：要么收紧判据，要么承认它测的是概率性行为。');
  }
  if (repeats === 1) {
    lines.push('');
    lines.push('  样本只有 1 次 —— 失败的任务说不清是回归还是波动。');
    lines.push('  要区分，用 --repeat 3（或 SHE_AGENT_REPEAT=3），API 花费约为 3 倍。');
  }
  return lines;
}
