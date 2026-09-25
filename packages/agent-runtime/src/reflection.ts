/**
 * Reflection: three checks that are about the AGENT rather than about the task.
 *
 *   - **Drift** (语义漂移检测) — the goal was stated once, at the start. Every action since has been
 *     chosen by a step that was already one step away from it, and a task can walk a long way from
 *     its own goal without any single step looking wrong. `detectDrift` compares the goal, the
 *     constraints and the actions, and says when the thread has been lost.
 *   - **Confidence mirror** (置信度镜像) — a stated confidence is a claim, and the tool trace is the
 *     measurement. `ConfidenceMirror` keeps the two side by side until a bias is visible, because a
 *     model that says "0.9" every time and is right 0.6 of the time is not slightly wrong: its
 *     numbers stop carrying information, and everything downstream that trusts them is wrong too.
 *   - **Reflections into the error book** (事后反思写入错题本) — `deriveReflections` turns the two
 *     reports above, plus what actually failed, into the same kind of note the error book already
 *     holds for tool failures. What is written is a LESSON, not a log line: the book is read before
 *     similar work starts, so an entry that only says what happened costs attention and returns
 *     nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DRIFT CHECK IS LEXICAL, AND WHICH WAY IT IS ALLOWED TO BE WRONG
 *
 * A deterministic layer cannot understand whether `git push` serves "fix the login bug" — that is
 * judgement, and it belongs to the model. What it CAN do is notice that the last five actions
 * contain no word from the goal, which is a fact about the text and a real signal: on-task work
 * almost always names the thing it is working on.
 *
 * So the thresholds are set to fire late and to over-report drift rather than under-report it. A
 * false alarm costs one glance at the goal, which the check then makes the agent take — that is the
 * cheap direction to be wrong in. A missed drift costs the whole task, because nothing else in the
 * system is watching for it.
 *
 * The exception is constraints. A stated rule like "do not touch the migration files" is not a
 * judgement call, and touching one IS a violation — so that signal is major, and it fires on
 * evidence (the excluded object appears in an action) rather than on a score.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Constraint } from './preflight.js';

// ─── Word extraction ────────────────────────────────────────────────────────

/**
 * Words that carry no subject matter.
 *
 * Deliberately generous on the Chinese side: the CJK bigrams below are generated mechanically, so
 * any run of two characters becomes a "term" — including the structural glue in "不要修改 X 里的
 * Y". Those have to be filtered here, or a constraint's excluded OBJECT would come out as "里的".
 */
const GENERIC = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'code', 'file', 'files', 'test', 'tests',
  'true', 'false', 'null', 'run', 'use', 'using', 'add', 'make', 'new', 'old', 'not', 'but',
  '一个', '这个', '那个', '我们', '你们', '他们', '以及', '并且', '如果', '所以', '但是', '然后',
  '可以', '需要', '应该', '必须', '可能', '已经', '还是', '或者', '因为', '这样', '那样', '就是',
  '里的', '里面', '那个', '相关', '任何', '部分', '东西', '事情', '时候', '现在', '一下',
  '改动', '修改', '变更', '触碰', '删除', '使用', '执行', '运行', '调用', '其它', '其他', '别的',
  '这些', '那些', '不能', '不要', '不得', '禁止', '严禁', '避免', '不准',
]);

/**
 * The subject matter of a piece of text: ASCII words and CJK bigrams.
 *
 * Bigrams rather than whole CJK runs because a goal is short — "修复登录超时" is four characters and
 * one word to a human, and comparing it as a single token would only match a verbatim copy. As two
 * bigrams ("修复", "复登", "登录", "录超", "超时") the same phrase overlaps with any sentence that
 * mentions "登录" or "超时", which is the behaviour a drift check needs. The junk bigrams dilute but
 * never fabricate: a term only counts when it is literally present in the other text.
 */
export function goalTerms(text: string): string[] {
  const found: string[] = [];
  const push = (t: string) => {
    if (!GENERIC.has(t) && !found.includes(t)) found.push(t);
  };
  const raw = String(text ?? '').toLowerCase();
  for (const m of raw.matchAll(/[a-z0-9_@./\\:-]{3,}/g)) push(m[0].replace(/^[./\\:-]+|[./\\:-]+$/g, ''));
  for (const m of raw.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
  }
  return found.filter((t) => t.length >= 2);
}

function containsAny(text: string, terms: string[]): string | null {
  const hay = String(text ?? '').toLowerCase();
  for (const t of terms) if (hay.includes(t)) return t;
  return null;
}

// ─── Drift ──────────────────────────────────────────────────────────────────

export type DriftLevel = 'none' | 'watch' | 'drift';

export type DriftSignalKind =
  /** An action touched something a constraint explicitly excluded. */
  | 'constraint_violated'
  /** The last few actions contain no word from the goal — the thread may be lost. */
  | 'goal_unrelated'
  /** The plan step being worked on does not mention the goal either. */
  | 'step_off_goal'
  /** The step budget is spent. Continuing is drift by definition. */
  | 'budget_overrun';

export interface DriftSignal {
  kind: DriftSignalKind;
  /** A major signal makes the level `drift` on its own; everything else has to accumulate. */
  major: boolean;
  weight: number;
  /** What was observed, in the terms the check used. No conclusions. */
  detail: string;
}

/** One action to check. `args` and `summary` are both searched; either may be absent. */
export interface DriftAction {
  tool: string;
  summary?: string;
  args?: string;
}

export interface DriftInput {
  /** The goal as pre-flight recorded it. Not the current step — that is the thing under test. */
  goal: string;
  /** Constraints to check against. A bare string is treated as a hard rule. */
  constraints?: (string | { text: string; hardness?: 'hard' | 'soft' })[];
  /** Actions taken so far, oldest first. */
  actions?: (DriftAction | string)[];
  /** The plan step currently being worked on, if there is a plan. */
  currentStep?: string | null;
  stepsUsed?: number;
  stepBudget?: number;
}

export interface DriftReport {
  level: DriftLevel;
  score: number;
  signals: DriftSignal[];
  /** What to do about it, or null when there is nothing to do. */
  advice: string | null;
  /** True when the report is telling the caller to stop and re-plan. */
  replan: boolean;
}

/**
 * Words that make a constraint a PROHIBITION rather than a description.
 *
 * Only prohibitions are checked, and the asymmetry is on purpose: "the config is JSON" is a
 * constraint too, but violating it is a bug in the work, which the tests and the diagnostics will
 * find. "Do not touch the migrations" is a constraint where nothing else will notice, and where
 * noticing afterwards is too late.
 */
const PROHIBITION = /(不要|不得|不准|不许|禁止|严禁|避免|别去|别动|别改|不可以|不能|do\s+not|don'?t|never|avoid|must\s+not|should\s+not)/i;

/**
 * The object a prohibition is about: what must not be touched.
 *
 * Returns null when nothing specific can be extracted, and that is the common case for a soft
 * preference ("keep it terse"). A null object produces NO signal rather than a vague one — a check
 * that fires on "the constraint might have been broken" is one the agent learns to skip.
 *
 * A backticked or quoted span wins when present, because that is how a person marks the exact token
 * they mean; otherwise the longest concrete-looking candidates are used, capped at two so a sentence
 * full of nouns does not turn into a keyword net.
 */
export function prohibitionObject(text: string): string[] {
  const src = String(text ?? '');
  const quoted = [...src.matchAll(/[`"“']([^`"”']{2,})[`"”']/g)].map((m) => m[1].trim()).filter(Boolean);
  if (quoted.length) return quoted.slice(0, 2);

  const rest = src.replace(PROHIBITION, ' ');
  const candidates: string[] = [];
  for (const m of rest.matchAll(/[A-Za-z0-9_@./\\:-]{3,}/g)) {
    const t = m[0].replace(/^[./\\:-]+|[./\\:-]+$/g, '');
    if (t.length >= 3 && !GENERIC.has(t.toLowerCase())) candidates.push(t);
  }
  for (const m of rest.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    if (GENERIC.has(run)) continue;
    // A CJK candidate is a whole run, not a bigram: the object of "别改 cluster.ts 的导出" is the
    // phrase as written, and splitting it would match any message that happens to share a pair.
    candidates.push(run);
  }
  const unique = [...new Set(candidates)].sort((a, b) => b.length - a.length);
  return unique.slice(0, 2);
}

function normalizeActions(actions: (DriftAction | string)[]): DriftAction[] {
  return actions.map((a) => (typeof a === 'string' ? { tool: '', summary: a } : a));
}

function actionText(a: DriftAction): string {
  return [a.tool, a.summary, a.args].filter(Boolean).join(' ');
}

/**
 * Compare where the work is against the goal it started from.
 *
 * Pure and deterministic: everything it reports is a quote or a count, so the same inputs give the
 * same report and a test can pin the exact wording of a signal.
 */
export function detectDrift(input: DriftInput): DriftReport {
  const signals: DriftSignal[] = [];
  const goal = String(input.goal ?? '').trim();
  const terms = goalTerms(goal);
  const actions = normalizeActions(input.actions ?? []);
  const texts = actions.map(actionText);

  // ── constraints ──
  for (const c of input.constraints ?? []) {
    const spec = typeof c === 'string' ? { text: c, hardness: 'hard' as const } : c;
    const hardness = spec.hardness === 'soft' ? 'soft' : 'hard';
    if (!PROHIBITION.test(spec.text)) continue;
    const objects = prohibitionObject(spec.text);
    if (!objects.length) continue;
    const hit = texts.find((t) => containsAny(t, objects));
    if (!hit) continue;
    const object = containsAny(hit, objects)!;
    signals.push({
      kind: 'constraint_violated',
      major: hardness === 'hard',
      weight: hardness === 'hard' ? 0.8 : 0.4,
      detail: `约束「${spec.text.trim()}」排除的对象「${object}」出现在了动作里`,
    });
  }

  // ── goal relevance of the recent actions ──
  /*
   * Three actions is the point where "this one call looked odd" stops being the explanation: a
   * single off-topic call is normal (a `git status` to check state), three in a row with no word
   * from the goal is a direction. Five escalates to major, because by then a real on-task stretch
   * would almost certainly have named the thing it is working on.
   */
  if (terms.length && actions.length >= 3) {
    const recent = texts.slice(-3);
    const matched = recent.map((t) => containsAny(t, terms));
    if (matched.every((m) => m === null)) {
      const long = actions.length >= 5 && texts.slice(-5).every((t) => containsAny(t, terms) === null);
      signals.push({
        kind: 'goal_unrelated',
        major: long,
        weight: long ? 0.7 : 0.5,
        detail: `最近 ${long ? 5 : 3} 个动作没有提到目标里的任何词（目标词如：${terms.slice(0, 5).join('、')}）`,
      });
    }
  }

  // ── the current step ──
  const step = String(input.currentStep ?? '').trim();
  if (terms.length && step.length >= 4 && !containsAny(step, terms)) {
    signals.push({
      kind: 'step_off_goal',
      major: false,
      weight: 0.4,
      detail: `当前步骤「${step.slice(0, 80)}」没有提到目标里的任何词`,
    });
  }

  // ── budget ──
  if (input.stepBudget !== undefined && input.stepsUsed !== undefined && input.stepsUsed > input.stepBudget) {
    signals.push({
      kind: 'budget_overrun',
      major: false,
      weight: 0.5,
      detail: `已用 ${input.stepsUsed} 步，超过预算的 ${input.stepBudget} 步`,
    });
  }

  const score = Math.min(1, signals.reduce((s, x) => s + x.weight, 0));
  const major = signals.some((s) => s.major);
  const level: DriftLevel = major ? 'drift' : score >= 0.4 ? 'watch' : 'none';

  return { level, score, signals, advice: driftAdvice(level, signals), replan: major };
}

function driftAdvice(level: DriftLevel, signals: DriftSignal[]): string | null {
  if (level === 'none') return null;
  const parts: string[] = [];
  if (signals.some((s) => s.kind === 'constraint_violated')) {
    parts.push('你在触碰明确排除的对象：停下来，换成不越界的做法；如果确实必须越界，先问用户，不要自己决定。');
  }
  if (signals.some((s) => s.kind === 'goal_unrelated' || s.kind === 'step_off_goal')) {
    parts.push('把 preflight 记录的「实际目标」重读一遍，再确认当前步骤在为它服务；不是就重写计划。');
  }
  if (signals.some((s) => s.kind === 'budget_overrun')) {
    parts.push('这一轮已经超预算：收尾并交付「已完成 + 未完成」，把剩下的交给下一轮，不要硬撑。');
  }
  parts.push('如果你核对后确认这些动作确实服务于目标，说明理由即可继续——本条是提醒，不是否决。');
  return parts.join(' ');
}

const LEVEL_LABEL: Record<DriftLevel, string> = {
  none: '无漂移',
  watch: '需要留意',
  drift: '已漂移',
};

/** One block for a prompt or a receipt. Empty string when there is nothing to say. */
export function renderDrift(r: DriftReport): string {
  if (r.level === 'none') return '';
  const lines = [`漂移检查：${LEVEL_LABEL[r.level]}（得分 ${r.score.toFixed(2)}）`];
  for (const s of r.signals) lines.push(`- ${s.detail}`);
  if (r.advice) lines.push(`建议：${r.advice}`);
  return lines.join('\n');
}

// ─── Confidence mirror ──────────────────────────────────────────────────────

/**
 * One run's claim and its outcome.
 *
 * `attempted`/`succeeded` are tool CALLS, not steps: the mirror's question is whether a stated
 * confidence predicts the agent's ability to get its tools to do what it said, which is the part of
 * the work that is measurable at all.
 */
export interface ConfidenceSample {
  at: string;
  /** What the agent said it expected, 0..1. */
  claimed: number;
  attempted: number;
  succeeded: number;
  /** The pre-flight clamp had to lower the claim; independent evidence of overreach. */
  clamped: boolean;
  topic?: string;
  runId?: string;
}

export type CalibrationBucket = 'unknown' | 'calibrated' | 'overconfident' | 'underconfident';

export interface CalibrationReport {
  samples: number;
  /** Mean of the claims. */
  meanClaimed: number;
  /** Mean of `succeeded / attempted` — the measured rate. 1 when nothing was attempted. */
  actualRate: number;
  /** `meanClaimed - actualRate`. Positive means overconfident. */
  bias: number;
  bucket: CalibrationBucket;
  /** Share of samples the pre-flight clamp had to bring down, 0..1. */
  clampRate: number;
  /** Topics whose bias is worst, when there are enough samples to say. */
  worst: { topic: string; samples: number; bias: number }[];
  advice: string | null;
}

/**
 * Fewer than this and the mirror says nothing.
 *
 * Two samples is a coincidence, and a calibration warning issued on a coincidence teaches the agent
 * to discount the warning. The number is per-window, not per-topic, for the overall verdict, because
 * the mirror's useful claim is about the agent's habits rather than about one task.
 */
const MIN_SAMPLES = 3;

/**
 * How far apart the claim and the measurement have to be before it is a bias.
 *
 * 0.15 would flag ordinary noise on a three-sample window; 0.25 is roughly the gap where the
 * confidence number stops being usable as a probability at all.
 */
const BIAS_THRESHOLD = 0.25;

/** Beyond this many samples the oldest are dropped: a habit is recent, and the file stays small. */
const DEFAULT_KEEP = 200;

export interface ConfidenceStoreFile {
  schema_version: number;
  samples: ConfidenceSample[];
}

export const CONFIDENCE_SCHEMA = 1;
export const REFLECTION_DIR = join('.she', 'reflection');

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * The confidence mirror, on disk.
 *
 * File-backed rather than in-memory because the whole point is a habit observed ACROSS sessions —
 * a bias that resets on every restart is invisible, and the restart is exactly when the agent would
 * otherwise start with a clean slate and the same optimism.
 *
 * Written atomically (tmp + rename) for the same reason as `.she/preflight/*`: a truncated JSON file
 * would take the entire history with it on the next read, and this file's whole value is its history.
 */
export class ConfidenceMirror {
  private cache: ConfidenceSample[] | null = null;

  constructor(
    private workspaceRoot: string,
    private keep = DEFAULT_KEEP,
  ) {}

  private file(): string {
    return join(this.workspaceRoot, REFLECTION_DIR, 'confidence.json');
  }

  /** Read from disk, tolerating a missing or damaged file. */
  samples(): ConfidenceSample[] {
    if (this.cache) return this.cache;
    try {
      if (!existsSync(this.file())) {
        this.cache = [];
        return this.cache;
      }
      const parsed = JSON.parse(readFileSync(this.file(), 'utf8')) as Partial<ConfidenceStoreFile>;
      const list = Array.isArray(parsed?.samples) ? parsed.samples : [];
      // Re-validated rather than trusted: this file outlives the version that wrote it, and a
      // hand-edited or half-written entry must not become a NaN in every average afterwards.
      this.cache = list
        .filter((s) => typeof s?.claimed === 'number')
        .map((s) => ({
          at: String(s.at ?? ''),
          claimed: clamp01(Number(s.claimed)),
          attempted: Math.max(0, Number(s.attempted) || 0),
          succeeded: Math.max(0, Number(s.succeeded) || 0),
          clamped: s.clamped === true,
          topic: s.topic ? String(s.topic) : undefined,
          runId: s.runId ? String(s.runId) : undefined,
        }));
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  /** Append one observation, and persist. */
  observe(sample: {
    claimed: number;
    attempted: number;
    succeeded: number;
    clamped?: boolean;
    topic?: string;
    runId?: string;
    at?: string;
  }): ConfidenceSample {
    const attempted = Math.max(0, Math.floor(sample.attempted));
    const full: ConfidenceSample = {
      at: sample.at ?? new Date().toISOString(),
      claimed: clamp01(sample.claimed),
      attempted,
      // Clamped to what was attempted: a caller that miscounts successes must not be able to make
      // the measured rate exceed 1, which would read as under-confidence and invert the verdict.
      succeeded: Math.min(Math.max(0, Math.floor(sample.succeeded)), attempted),
      clamped: sample.clamped === true,
      topic: sample.topic,
      runId: sample.runId,
    };

    const list = [...this.samples(), full].slice(-this.keep);
    this.cache = list;
    this.save(list);
    return full;
  }

  private save(list: ConfidenceSample[]): void {
    const payload: ConfidenceStoreFile = { schema_version: CONFIDENCE_SCHEMA, samples: list };
    const target = this.file();
    try {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = join(dirname(target), `.confidence-${randomUUID().slice(0, 8)}.tmp`);
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, target);
    } catch {
      // The mirror is bookkeeping. A read-only workspace costs the observation, not the turn.
    }
  }

  /** Forget everything. Used by the UI's "reset calibration" and by tests. */
  clear(): void {
    this.cache = [];
    this.save([]);
  }

  /**
   * The bias, over the most recent `window` samples.
   *
   * A window rather than everything ever recorded: a habit that was corrected should stop being
   * reported, and an all-time average would keep the old bias alive forever.
   */
  report(opts: { window?: number } = {}): CalibrationReport {
    const all = this.samples();
    const list = opts.window ? all.slice(-opts.window) : all;
    if (list.length < MIN_SAMPLES) {
      return {
        samples: list.length,
        meanClaimed: 0,
        actualRate: 0,
        bias: 0,
        bucket: 'unknown',
        clampRate: list.length ? list.filter((s) => s.clamped).length / list.length : 0,
        worst: [],
        advice: null,
      };
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanClaimed = mean(list.map((s) => s.claimed));
    // A run with no tool calls still tells us something about the CLAIM only, so it is excluded
    // from the measured rate rather than counted as a perfect 1.0 — that would let "I did nothing"
    // read as "I was right", which is the failure this mirror exists to catch.
    const withTools = list.filter((s) => s.attempted > 0);
    const actualRate = withTools.length
      ? mean(withTools.map((s) => Math.min(1, s.succeeded / s.attempted)))
      : meanClaimed;
    const bias = meanClaimed - actualRate;
    const bucket: CalibrationBucket =
      bias >= BIAS_THRESHOLD ? 'overconfident' : bias <= -BIAS_THRESHOLD ? 'underconfident' : 'calibrated';
    const clampRate = list.filter((s) => s.clamped).length / list.length;

    const rate = (xs: ConfidenceSample[]) => {
      const withTools = xs.filter((s) => s.attempted > 0);
      // No measurable run in this topic: the claim is all we have, so the bias is 0 rather than
      // unknown — the topic simply cannot be reported as the worst offender.
      if (!withTools.length) return mean(xs.map((s) => s.claimed));
      return mean(withTools.map((s) => Math.min(1, s.succeeded / s.attempted)));
    };
    const byTopic = new Map<string, ConfidenceSample[]>();
    for (const s of list) {
      if (!s.topic) continue;
      byTopic.set(s.topic, [...(byTopic.get(s.topic) ?? []), s]);
    }
    const worst = [...byTopic.entries()]
      .filter(([, xs]) => xs.length >= MIN_SAMPLES)
      .map(([topic, xs]) => ({
        topic,
        samples: xs.length,
        bias: mean(xs.map((s) => s.claimed)) - rate(xs),
      }))
      // Worst first by absolute distance, so an over-confident topic and an under-confident one are
      // both surfaced — the mirror is about calibration, not about pessimism.
      .sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias))
      .slice(0, 3);

    return { samples: list.length, meanClaimed, actualRate, bias, bucket, clampRate, worst, advice: calibrationAdvice(bucket, bias, list.length, clampRate) };
  }
}

function calibrationAdvice(bucket: CalibrationBucket, bias: number, samples: number, clampRate: number): string | null {
  if (bucket === 'calibrated') return null;
  const gap = Math.abs(bias).toFixed(2);
  if (bucket === 'overconfident') {
    let text = `最近 ${samples} 次里，你报的置信度平均比实际成功率高出 ${gap}。把置信度改成从已核对的事实推出来的数字，而不是从感觉。`;
    if (clampRate >= 0.5) text += `其中 ${Math.round(clampRate * 100)}% 的预检要被压到上限才合规——这一点也要算进你的自评。`;
    return text;
  }
  return `最近 ${samples} 次里，你报的置信度平均比实际成功率低 ${gap}。你的检查比你以为的更有效，不要因为不确定就少做验证或把已完成的说成没做完。`;
}

/** One line for a status bar, or a prompt block. Empty when there is not enough evidence. */
export function renderCalibration(r: CalibrationReport): string {
  if (r.bucket === 'unknown' || !r.advice) return '';
  const head = r.bucket === 'overconfident' ? '偏乐观' : '偏保守';
  return [
    `置信度镜像：${head}（样本 ${r.samples}，自评均值 ${r.meanClaimed.toFixed(2)}，实际成功率 ${r.actualRate.toFixed(2)}）`,
    r.advice,
    ...(r.worst.length ? [`偏差最大的领域：${r.worst.map((w) => `${w.topic}(${w.bias >= 0 ? '+' : ''}${w.bias.toFixed(2)})`).join('、')}`] : []),
  ].join('\n');
}

// ─── Reflections ────────────────────────────────────────────────────────────

export interface ReflectionFailure {
  tool: string;
  kind: string;
  detail: string;
  remedy?: string | null;
}

export interface ReflectionSources {
  goal: string;
  drift: DriftReport;
  calibration: CalibrationReport;
  /** Failures this run wrote to the error book. */
  failures?: ReflectionFailure[];
  /** True when the turn did not produce an answer. */
  runFailed: boolean;
  /** Why it stopped: `max_iterations`, `aborted`, an error message. */
  runReason?: string;
}

/**
 * One lesson for the error book.
 *
 * `topic` is the group the entry is filed under and the signature it is de-duplicated on, so the
 * same lesson recurring is one entry with a count rather than five entries saying the same thing.
 */
export interface ReflectionNote {
  topic: string;
  /** What to do differently next time. The only part that changes behaviour. */
  lesson: string;
  /** The observation that justifies the lesson. Quoted, never inferred. */
  evidence: string;
  /** Lower sorts later; the cap below keeps the notable ones. */
  severity: number;
}

/**
 * At most this many notes per turn.
 *
 * The book is read before work starts and competes with the task for attention, so a turn that
 * produces six lessons would bury the two that matter. Ordered by severity, then truncated.
 */
const MAX_NOTES = 3;

/** The same tool failing this many times in one turn is a pattern, not bad luck. */
const REPEAT_THRESHOLD = 2;

/**
 * Turn a run's observations into lessons.
 *
 * Every rule below is keyed to something the deterministic layers measured. Nothing here is derived
 * from what the model said about itself — a self-assessment that has already been shown to be
 * miscalibrated is the last thing to build a lesson on.
 */
export function deriveReflections(src: ReflectionSources): ReflectionNote[] {
  const notes: ReflectionNote[] = [];

  const violated = src.drift.signals.filter((s) => s.kind === 'constraint_violated');
  if (violated.length) {
    notes.push({
      topic: '越过约束',
      lesson: '约束里明确排除的对象，开工前先列出禁改清单，动手前把路径比对一遍；确实必须越界就先问，不要自己决定。',
      evidence: violated.map((s) => s.detail).join('；'),
      severity: 10,
    });
  }

  if (src.drift.level === 'drift') {
    notes.push({
      topic: '目标漂移',
      lesson: '每做完几步就把 preflight 记录的「实际目标」重读一遍；计划步骤不再直接服务于它就重写计划，而不是继续往下做。',
      evidence: src.drift.signals.map((s) => s.detail).join('；'),
      severity: 8,
    });
  }

  if (src.calibration.bucket === 'overconfident') {
    notes.push({
      topic: '过度自信',
      lesson: '自评置信度要由已核对的证据推出（跑过什么、看到什么），不要给感觉打分；拿不出证据的步骤按 0.5 以下报。',
      evidence: `样本 ${src.calibration.samples}，自评均值 ${src.calibration.meanClaimed.toFixed(2)}，实际成功率 ${src.calibration.actualRate.toFixed(2)}，偏差 ${src.calibration.bias.toFixed(2)}`,
      severity: 6,
    });
  }

  if (src.runFailed && src.runReason === 'max_iterations') {
    notes.push({
      topic: '循环失控',
      lesson: '同一类动作连续失败两次就要换方法或换工具，不要原地重试；到上限前先把「已完成 + 未完成」交付出来。',
      evidence: '本轮因为工具调用轮数达到上限而被停止',
      severity: 7,
    });
  }

  // Repeated failure of one tool inside this turn. The error book already holds the individual
  // failures; what it cannot see from a single entry is that this turn kept hitting the same one.
  const byTool = new Map<string, ReflectionFailure[]>();
  for (const f of src.failures ?? []) {
    byTool.set(f.tool, [...(byTool.get(f.tool) ?? []), f]);
  }
  for (const [tool, list] of byTool) {
    if (list.length < REPEAT_THRESHOLD) continue;
    const kinds = [...new Set(list.map((f) => f.kind))].join('/');
    notes.push({
      topic: `重复失败:${tool}`,
      lesson: list.find((f) => f.remedy)?.remedy
        ?? `同一工具本轮失败 ${list.length} 次：先读它上一次的报错全文再重试，第二次失败就换工具或换思路。`,
      evidence: `本轮 ${tool} 失败 ${list.length} 次（${kinds}）：${list.map((f) => f.detail).join(' | ').slice(0, 300)}`,
      severity: 5,
    });
  }

  return notes.sort((a, b) => b.severity - a.severity).slice(0, MAX_NOTES);
}

/** One note as one line, for a receipt or a log. */
export function renderReflection(n: ReflectionNote): string {
  return `[${n.topic}] ${n.lesson}`;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/** What `reflection_check` needs from the agent to answer honestly. */
export interface ReflectionToolDeps {
  /** The goal, from the newest pre-flight record or the active plan. */
  goal: () => string | null;
  /** Constraints as recorded, with their source's hardness. */
  constraints: () => (string | { text: string; hardness?: 'hard' | 'soft' })[];
  /** Actions this run has taken, oldest first. */
  actions: () => DriftAction[];
  /** The plan step being worked on, if a plan is open. */
  currentStep: () => string | null;
  /** Steps used and the budget, when a plan is open. */
  budget: () => { used: number; limit?: number };
  /** Calibration, for the same report. */
  calibration: () => CalibrationReport;
}

export interface ReflectionToolSet {
  definitions: import('@she/shared').ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * The agent-facing tool.
 *
 * Read-only by construction: it reports and advises, and cannot edit the plan or the goal itself.
 * That is deliberate — a checker that can rewrite the thing it is checking will eventually be used
 * to make itself pass, and this one's value is entirely in being an independent reading.
 */
export function createReflectionTools(deps: ReflectionToolDeps): ReflectionToolSet {
  const definitions: import('@she/shared').ToolDefinition[] = [
    {
      name: 'reflection_check',
      description:
        '在长任务中途自检：把当前动作与最初的「实际目标/约束」对照，报告语义漂移、预算超支和置信度偏差。只读，不修改计划。'
        + '做完一个阶段、连续几步没进展、或准备说「完成」之前调用一次。',
      parameters: {
        type: 'object',
        properties: {
          current_step: { type: 'string', description: '当前正在做的计划步骤（一句话）。省略则用计划里的当前步骤。' },
          actions: {
            type: 'array',
            items: { type: 'string' },
            description: '要检查的动作，每项一句话（如「shell: 跑了 pnpm test」）。省略则用本轮实际执行过的工具调用。',
          },
        },
        required: [],
      },
    },
  ];

  const execute = async (_name: string, args: Record<string, unknown>): Promise<string> => {
    const goal = deps.goal();
    if (!goal) {
      return '还没有记录过目标：先调用 preflight_record 写下实际目标，再来自检。';
    }
    const passedActions = Array.isArray(args.actions) ? (args.actions as unknown[]).map(String) : null;
    const actions = passedActions?.map((s) => ({ tool: '', summary: s })) ?? deps.actions();
    const step = typeof args.current_step === 'string' && args.current_step.trim()
      ? args.current_step.trim()
      : deps.currentStep();
    const budget = deps.budget();
    const drift = detectDrift({
      goal,
      constraints: deps.constraints(),
      actions,
      currentStep: step,
      stepsUsed: budget.used,
      stepBudget: budget.limit,
    });

    const parts: string[] = [
      `目标：${goal.slice(0, 200)}`,
      `检查了 ${actions.length} 个动作${step ? `，当前步骤「${step.slice(0, 80)}」` : ''}`,
      renderDrift(drift) || '漂移检查：无漂移（动作与目标的关键词仍然一致）。',
    ];
    const cal = deps.calibration();
    const calText = renderCalibration(cal);
    if (calText) parts.push(calText);
    if (drift.level === 'none' && !calText) parts.push('结论：目前没有偏离需要处理，继续。');
    return parts.join('\n');
  };

  return { definitions, execute };
}
