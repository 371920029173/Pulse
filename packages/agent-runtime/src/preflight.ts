import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveInsideWorkspace } from '@she/sandbox';
import type { ToolDefinition } from '@she/shared';

/**
 * Pre-flight intent analysis.
 *
 * The gap this closes: the agent had no structured, pre-execution answer to "what was
 * actually asked for, what was left unsaid, and what must be true before I can start?".
 * Clarification happened only when the model happened to think of `ask_user` on its own,
 * so an unstated prerequisite was discovered at the END of a plan instead of the start.
 *
 * Deliberately split in two, because the two halves have different costs and different
 * failure modes:
 *
 *   - a DETERMINISTIC half (`analyzeRequest`) that costs nothing and calls no model. It
 *     reads the request for explicit `@file:` / `@folder:` / `@symbol:` references, time
 *     expressions and destructive wording, checks each against the workspace and the
 *     registered tool list, and inherits constraints from the session.
 *   - a SEMANTIC half the model fills through `preflight_record`: separate-request-from-goal
 *     is a judgement call no regex can make.
 *
 * Only the second half can be wrong in a way that matters, so the first half earns its
 * place by being EVIDENCE the model cannot talk itself out of. A `@file:` that does not
 * exist, or a request that needs a tool this agent was not given, is a fact — checked by
 * code rather than asserted by a prompt. The ceiling it computes is therefore a ceiling:
 * `preflight_record` clamps the model's confidence to it and says so.
 *
 * Records are written to `.she/preflight/`, one JSON file each. An analysis nobody can
 * read afterwards is a ritual, not an analysis; batch G's run traces and batch F's audit
 * log read the same directory.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type PrerequisiteKind = 'path' | 'symbol' | 'tool' | 'time';

export interface Prerequisite {
  kind: PrerequisiteKind;
  /** What the request needs, quoted as the user wrote it where possible. */
  what: string;
  ok: boolean;
  /**
   * Whether its absence prevents starting at all.
   *
   * Split from `ok` because the two differ in practice: a missing `@file:` blocks (the
   * user pointed at something that is not there), while a missing language server does
   * not (the agent can fall back to `grep` and `read`).
   */
  blocking: boolean;
  /** Why it is unavailable. Present only when `ok` is false. */
  detail?: string;
}

/**
 * Where a constraint came from.
 *
 * Tracked so nothing INFERRED is ever presented as something the user SAID. That
 * distinction is the whole point of item 5 in the backlog (separate confirmed facts from
 * assumptions), and it is cheap to keep at the source.
 */
export type ConstraintSource = 'stated' | 'inferred' | 'workspace' | 'session' | 'profile';

export interface Constraint {
  /** One constraint, phrased as something the agent can act on. */
  text: string;
  /**
   * `hard` — the request cannot be satisfied without it. `soft` — a preference, where
   * breaking it is a judgement call worth stating rather than a blocker.
   */
  hardness: 'hard' | 'soft';
  source: ConstraintSource;
}

export interface PreflightEvidence {
  /** The request this analysis was computed from, verbatim. */
  request: string;
  constraints: Constraint[];
  prerequisites: Prerequisite[];
  /**
   * Time expressions found.
   *
   * Evidence, not proof: "明天提醒我" needs `schedule_create`, but "明天要开会，帮我准备材料"
   * merely mentions a time. The deterministic layer cannot tell those apart, so it reports
   * what it saw and requires the tool to exist only when a scheduling verb is present too.
   */
  timeExpressions: string[];
  riskHints: string[];
  /** The highest confidence the checked facts justify, 0..1. */
  confidenceCeiling: number;
  /** Questions the deterministic layer already knows are unavoidable. */
  blockingQuestions: string[];
}

export interface PreflightRecord {
  id: string;
  /**
   * Conversation this analysis belongs to.
   *
   * Stamped by `PreflightStore.save`, not by `buildRecord`: the session is a property of
   * where the record is written, and having both stamp it produced a record that silently
   * lost it (the store's constructor argument was never read).
   */
  sessionId?: string;
  createdAt: string;
  /** What the user literally asked for. */
  stated_intent: string;
  inferred_constraints: string[];
  prerequisites: Prerequisite[];
  /** What they are trying to achieve — which is not always the same sentence. */
  actual_goal: string;
  clarification_needed: string[];
  /**
   * Mistakes already recorded for work like this, one line each.
   *
   * Stored on the record rather than only shown to the model, because the record is the thing
   * that can be read afterwards: an analysis that consulted the error book and did not write
   * down what it found cannot be told apart from one that never looked.
   */
  known_errors: string[];
  confidence: number;
  /** Whether the model asked for a confidence higher than the checked facts allow. */
  confidenceClamped: boolean;
  /** The deterministic findings, kept so the record can be audited rather than trusted. */
  evidence: PreflightEvidence;
}

/** What the caller knows that the request text does not say. */
export interface PreflightContext {
  workspaceRoot: string;
  /** Names of the tools this agent actually has, post-filtering. */
  tools: string[];
  skillProfile?: string;
  automationMode?: boolean;
  /** Goal of the open plan, when this conversation is continuing one. */
  activePlanGoal?: string;
  /**
   * Injectable so the analysis is testable without touching disk.
   *
   * Receives a path already proven to be inside the workspace.
   */
  pathExists?: (absolutePath: string) => boolean;
}

// ─── Deterministic analysis ─────────────────────────────────────────────────

/**
 * Explicit references only.
 *
 * Bare `packages/x/y.ts` in prose is NOT treated as a prerequisite. That form is just as
 * likely to name a file the user wants CREATED, and flagging it as missing would produce
 * a blocking question on a perfectly ordinary request — which is how a check teaches
 * people to ignore it. `@file:` / `@folder:` are the markers the UI inserts when the user
 * POINTS at something that exists, so those are the ones worth checking.
 *
 * The colon is matched in both widths because the UI inserts a half-width one while a
 * Chinese-language typist will often produce `：` — and a reference that is silently not
 * checked is worse than one that is checked and found wanting.
 */
const AT_FILE = /@(file|folder)\s*[:：]\s*([^\s,，。；;、）)】"'`]+)/g;
const AT_SYMBOL = /@symbol\s*[:：]\s*([^\s,，。；;、）)】"'`]+)/g;

/**
 * Time expressions, grouped by the shape they take rather than by meaning.
 *
 * Matched as whole tokens to keep the false-positive rate bearable: a bare number is not
 * a time, and `1.2.3` in a version string is not a date.
 *
 * Every entry is GLOBAL. `findTimes` uses `matchAll`, which stops after one match on a
 * non-global pattern — so a missing `g` here would silently report only the first time
 * expression in a message that mentions several.
 */
const TIME_PATTERNS: RegExp[] = [
  /今天|今日|今晚|明天|明日|后天|大后天|昨天|前天/g,
  /每天|每日|每周|每星期|每月|每年|每小时|每分钟|每隔/g,
  /每\s*\d+\s*(?:秒|分钟|小时|天|周|月)/g,
  /\d+\s*(?:秒|分钟|小时|天|周|月)\s*(?:后|之后|以后)/g,
  /半小时后|一小时后|一会(?:儿)?后|稍后|待会(?:儿)?|回头|过阵子/g,
  /下周|下星期|下个?月|下周[一二三四五六日天]/g,
  /(?:早上|上午|中午|下午|傍晚|晚上)\s*\d{1,2}\s*(?:点|[:：])?\s*\d{0,2}/g,
  /\d{1,2}\s*[:：]\s*\d{2}/g,
  /\d{1,2}\s*点\s*(?:半|\d{1,2}\s*分?)?/g,
];

/** A time expression only implies scheduling when the agent is the one acting. */
const SCHEDULE_VERBS = /提醒|记得|定时|到点|自动|定期|每天|每周|每隔|巡逻|轮询/;

/**
 * Wording that tends to accompany irreversible work.
 *
 * A heuristic that raises attention, NOT a decision: the sandbox owns the actual refusal
 * (denylist + confirmation tickets), and duplicating that judgement here would give two
 * places to disagree. What this buys is that the pre-flight record mentions the risk while
 * the plan is still being written.
 */
const RISK_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /删除|删掉|移除|清空/, label: '删除/清空' },
  { re: /覆盖|重写|替换掉/, label: '覆盖' },
  { re: /重置|回滚|还原/, label: '重置/回滚' },
  { re: /强推|force\s*-?push/i, label: '强推' },
  { re: /格式化|卸载|迁移/, label: '不可逆或大范围操作' },
  { re: /\brm\s+-rf\b|\bdrop\s+table\b|\btruncate\b/i, label: '破坏性命令' },
];

/** The same sentence that says "remind me" also names the thing to remind about. */
function isBlank(s: string): boolean {
  return s.replace(/[\s\u3000]/g, '') === '';
}

/**
 * All matches of a module-level `/g` regex, as `[full, ...groups]`.
 *
 * `lastIndex` is reset per call: these regexes are shared, and a stale index would make
 * the second call of the same request miss its first match.
 */
function matchAll(text: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    /*
     * A NON-global regex ignores `lastIndex`, so `exec` returns the same match forever and
     * the caller spins. That is not a theory: the first version of `findTimes` used
     * non-global patterns with this loop and exhausted the test runner's heap. Take the one
     * match and stop, rather than relying on every pattern remembering its `g`.
     */
    if (!re.global) break;
    // A zero-length match would also spin; these patterns cannot produce one, but a future
    // edit could, and an infinite loop inside a tool is a hang rather than a bug.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/** Time expressions, in the order they appear, de-duplicated. */
function findTimes(text: string): string[] {
  const found: string[] = [];
  for (const re of TIME_PATTERNS) {
    for (const m of matchAll(text, re)) {
      const hit = m[0].trim();
      if (hit && !found.includes(hit)) found.push(hit);
    }
  }
  return found;
}

function findRisks(text: string): string[] {
  const found: string[] = [];
  for (const { re, label } of RISK_PATTERNS) {
    if (re.test(text) && !found.includes(label)) found.push(label);
  }
  return found;
}

/**
 * Check one explicit reference against the workspace.
 *
 * Containment is delegated to `resolveInsideWorkspace` rather than reimplemented: the
 * pre-flight answer and the sandbox's refusal must not be able to disagree, and that
 * helper already handles the Windows case-folding and symlink cases.
 */
function checkPathRef(
  raw: string,
  kind: 'file' | 'folder',
  ctx: PreflightContext,
  exists: (absolutePath: string) => boolean,
): Prerequisite {
  let absolute: string;
  try {
    absolute = resolveInsideWorkspace(ctx.workspaceRoot, raw);
  } catch {
    return {
      kind: 'path',
      what: `@${kind}:${raw}`,
      ok: false,
      blocking: true,
      detail: `在工作区之外，沙箱会拒绝访问（工作区：${ctx.workspaceRoot}）`,
    };
  }

  const present = exists(absolute);
  // `@folder:` must be a directory; `@file:` may be either, because a directory is a
  // legitimate thing to hand to `fs_list`. Reporting a missing one is the point.
  if (!present) {
    return {
      kind: 'path',
      what: `@${kind}:${raw}`,
      ok: false,
      blocking: true,
      detail: '工作区里没有这个路径',
    };
  }
  return { kind: 'path', what: `@${kind}:${raw}`, ok: true, blocking: true };
}

export function analyzeRequest(request: string, ctx: PreflightContext): PreflightEvidence {
  const text = String(request ?? '');
  const exists = ctx.pathExists ?? ((p: string) => existsSync(p));
  const constraints: Constraint[] = [];
  const prerequisites: Prerequisite[] = [];
  const blockingQuestions: string[] = [];

  // ── Inherited from the workspace ──
  constraints.push({
    text: `所有文件操作都限制在工作区 ${ctx.workspaceRoot} 内，越界会被沙箱拒绝。`,
    hardness: 'hard',
    source: 'workspace',
  });

  if (ctx.skillProfile) {
    constraints.push({
      text: `当前技能档是 ${ctx.skillProfile}，交付形态按这一档的约定（见技能文件）。`,
      hardness: 'soft',
      source: 'profile',
    });
  }

  if (ctx.automationMode === false) {
    constraints.push({
      text: '手动模式：动手前先说明打算怎么做并等确认，不要直接改文件。',
      hardness: 'hard',
      source: 'session',
    });
  }

  if (ctx.activePlanGoal && !isBlank(ctx.activePlanGoal)) {
    constraints.push({
      text: `工作区里有一个未完成的计划，目标「${ctx.activePlanGoal}」——只有当前这条消息确实在继续它时才接上，否则当普通对话。`,
      hardness: 'soft',
      source: 'session',
    });
  }

  // ── Explicit path references ──
  /*
   * The marker is read from the match itself rather than inferred from the text before
   * the path: the same path can appear twice with different markers, and `indexOf` would
   * always report the first one.
   */
  for (const m of matchAll(text, AT_FILE)) {
    prerequisites.push(checkPathRef(m[2], m[1].toLowerCase() === 'folder' ? 'folder' : 'file', ctx, exists));
  }

  for (const m of matchAll(text, AT_SYMBOL)) {
    const raw = m[1];
    /*
     * A symbol is not a path, so it cannot be checked for existence from here — resolving
     * it is exactly what the language server is for. What CAN be checked is whether a
     * server is wired up at all, which is the difference between "I will look it up" and
     * "I will grep and guess", and the user deserves to hear the second one said out loud.
     */
    const hasLsp = ctx.tools.some((t) => t.startsWith('lsp_'));
    prerequisites.push({
      kind: 'symbol',
      what: `@symbol:${raw}`,
      ok: hasLsp,
      blocking: false,
      detail: hasLsp ? undefined : '没有可用的语言服务器，只能退回 grep/read 按名字找，可能认错同名符号',
    });
  }

  // ── Time expressions ──
  const times = findTimes(text);
  if (times.length) {
    const needsScheduler = SCHEDULE_VERBS.test(text);
    const hasScheduler = ctx.tools.includes('schedule_create');
    if (needsScheduler) {
      prerequisites.push({
        kind: 'time',
        what: `时间表达「${times[0]}」+ 需要稍后执行`,
        ok: hasScheduler,
        blocking: true,
        detail: hasScheduler
          ? undefined
          : '这个会话没有排程工具，只能回一句文字 —— 那个「提醒」不会自己发生',
      });
    } else {
      prerequisites.push({
        kind: 'time',
        what: `提到时间「${times.join('、')}」但没有明确要稍后执行`,
        ok: true,
        blocking: false,
      });
    }
  }

  // ── Risk wording ──
  const riskHints = findRisks(text);
  if (riskHints.length) {
    constraints.push({
      text: `请求里出现「${riskHints.join('、')}」这类字眼。若是不可逆操作，先说清会失去什么，并走确认门。`,
      hardness: 'hard',
      source: 'stated',
    });
  }

  // ── Questions the facts already force ──
  for (const p of prerequisites) {
    if (p.ok || !p.blocking) continue;
    if (p.kind === 'path') {
      blockingQuestions.push(
        `${p.what} ${p.detail} —— 是要新建它，还是路径写错了？`,
      );
    } else if (p.kind === 'time') {
      blockingQuestions.push(
        `这条要求稍后执行，但${p.detail}。要改成现在就做，还是先说明做不到？`,
      );
    }
  }

  // ── Confidence ceiling ──
  /*
   * The ceiling is about the CHECKED facts, not the model's self-assessment. One missing
   * hard prerequisite means the request as literally written cannot be started, so any
   * claim of high confidence is unfounded regardless of how the model feels about it.
   */
  const blockedCount = prerequisites.filter((p) => !p.ok && p.blocking).length;
  const confidenceCeiling = blockedCount === 0
    ? 1
    : Math.max(0.3, Number((1 - 0.25 * blockedCount).toFixed(2)));

  return {
    request: text,
    constraints,
    prerequisites,
    timeExpressions: times,
    riskHints,
    confidenceCeiling,
    blockingQuestions,
  };
}

// ─── Record assembly ────────────────────────────────────────────────────────

export interface PreflightInput {
  stated_intent: string;
  actual_goal: string;
  inferred_constraints?: string[];
  clarification_needed?: string[];
  confidence?: number;
}

export function buildRecord(
  evidence: PreflightEvidence,
  input: PreflightInput,
  knownErrors: string[] = [],
): PreflightRecord {
  const stated = String(input.stated_intent ?? '').trim();
  const goal = String(input.actual_goal ?? '').trim();
  if (!stated) throw new Error('stated_intent is required');
  if (!goal) throw new Error('actual_goal is required');

  const modelConstraints = (input.inferred_constraints ?? [])
    .map((c) => String(c ?? '').trim())
    .filter(Boolean);

  // Same question asked twice is noise; the deterministic ones come first because they
  // are the ones backed by a check.
  const questions: string[] = [...evidence.blockingQuestions];
  for (const q of input.clarification_needed ?? []) {
    const clean = String(q ?? '').trim();
    if (clean && !questions.includes(clean)) questions.push(clean);
  }

  const claimed = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
    ? Math.min(1, Math.max(0, input.confidence))
    : 1;
  const clamped = claimed > evidence.confidenceCeiling;

  return {
    id: `pf_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    stated_intent: stated,
    inferred_constraints: modelConstraints,
    prerequisites: evidence.prerequisites,
    actual_goal: goal,
    clarification_needed: questions,
    known_errors: knownErrors,
    confidence: clamped ? evidence.confidenceCeiling : claimed,
    confidenceClamped: clamped,
    evidence,
  };
}

export function renderRecord(r: PreflightRecord): string {
  const lines: string[] = [
    `Pre-flight ${r.id}  (confidence ${r.confidence}${r.confidenceClamped ? `，已从更高值下调到检查结果允许的上限 ${r.evidence.confidenceCeiling}` : ''})`,
    `字面诉求: ${r.stated_intent}`,
    `实际目标: ${r.actual_goal}`,
  ];

  if (r.inferred_constraints.length) {
    lines.push('推断出的约束:');
    for (const c of r.inferred_constraints) lines.push(`  - ${c}`);
  }

  /*
   * The checked constraints are rendered, not just computed.
   *
   * They were computed and dropped at first — including the risk finding, which is the one
   * that decides whether this task needs a confirmation door. An analysis whose evidence the
   * model never sees is a ritual: the whole reason to check by code rather than ask the model
   * to remember is that the finding then exists whether or not the model thought of it.
   *
   * `hard`/`soft` is spelled out rather than marked, because the distinction is what the
   * prompt asks the model to respect and a single symbol would be ambiguous next to the
   * ✓ / ✗ / ! markers below.
   */
  if (r.evidence.constraints.length) {
    lines.push('检查到的约束:');
    for (const c of r.evidence.constraints) {
      lines.push(`  [${c.hardness === 'hard' ? '硬' : '软'} · ${c.source}] ${c.text}`);
    }
  }

  if (r.evidence.riskHints.length) {
    lines.push(`风险字眼: ${r.evidence.riskHints.join('、')}`);
  }

  if (r.evidence.timeExpressions.length) {
    lines.push(`识别到的时间表达: ${r.evidence.timeExpressions.join('、')}`);
  }

  if (r.known_errors.length) {
    /*
     * Rendered before the prerequisites, because it can change what the plan should even be:
     * "you have hit this wall before" is a reason to choose a different approach, whereas a
     * missing prerequisite is a reason to fetch one.
     */
    lines.push('错题本里相关的记录（这是本工作区真实发生过的，不是你推断的）:');
    for (const e of r.known_errors) lines.push(`  ${e}`);
  }

  if (r.prerequisites.length) {
    lines.push('前置条件:');
    for (const p of r.prerequisites) {
      const mark = p.ok ? '✓' : (p.blocking ? '✗' : '!');
      lines.push(`  ${mark} [${p.kind}] ${p.what}${p.detail ? ` — ${p.detail}` : ''}`);
    }
  }

  if (r.clarification_needed.length) {
    lines.push('开工前要问清楚:');
    for (const q of r.clarification_needed) lines.push(`  ? ${q}`);
    lines.push('');
    /*
     * Deliberately NOT "call ask_user now". Whether a question is allowed depends on the
     * active work-mode block, which this module cannot see — the automation mode says "do
     * not stop to ask" with two exceptions, and a tool that overrode that would leave the
     * model holding two rules with no way to choose. Name the condition, not the action.
     */
    lines.push(
      '上面有 ✗（阻塞项）时：只有属于「只有用户知道的信息」或「不可逆且沙箱没放行」这两种，'
      + '才先 call `ask_user` 再动手；其余按 ! 处理，说清你找到的替代办法然后继续。不要先做一半再问。',
    );
  } else {
    lines.push('没有阻塞项，可以按计划开始。');
  }

  return lines.join('\n');
}

// ─── Persistence ────────────────────────────────────────────────────────────

/**
 * One JSON file per analysis under `.she/preflight/`.
 *
 * Not a single rolling file like the plan store: these are per-turn records meant to be
 * read back individually (by a later run, by the audit log, by a person debugging a
 * decision), and rewriting one growing array on every turn would make that harder rather
 * than easier. Writes go through a temp file and a rename, so a crash mid-write cannot
 * leave a half-record that a reader then has to defend against.
 */
export class PreflightStore {
  private dir: string;
  /**
   * Guards the filename against same-millisecond ties.
   *
   * `createdAt` has millisecond resolution, so two analyses saved inside one millisecond —
   * which the unit test does deliberately, and a retry does in practice — produced the SAME
   * stamp. Ordering then fell through to the random id, so `latest()` returned the older of
   * the two about half the time. The counter makes the filename strictly increasing within a
   * store, which is what "newest first" actually needs.
   *
   * A tie across two processes in the same millisecond is left to the id, and that is
   * deliberate rather than overlooked: two agents would have to start on the same millisecond
   * and both call preflight immediately. Millisecond ties are a within-process phenomenon.
   */
  private seq = 0;

  constructor(workspaceRoot: string, public readonly sessionId?: string | null) {
    this.dir = join(workspaceRoot, '.she', 'preflight');
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  save(record: PreflightRecord): string {
    this.ensureDir();
    /*
     * The session is stamped here rather than passed through `buildRecord`. Both places
     * had it and neither the caller nor the constructor was consistent about supplying it,
     * which is how the field ended up always empty.
     */
    record.sessionId = this.sessionId ?? undefined;
    // Every field is zero-padded, so lexicographic order over the filename IS chronological
    // order — which is what `list()` relies on.
    const stamp = record.createdAt.replace(/[:.]/g, '-');
    const file = join(this.dir, `${stamp}-${String(this.seq++).padStart(3, '0')}-${record.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
    return file;
  }

  /** Newest first. Unreadable files are skipped rather than hidden. */
  list(limit = 20): PreflightRecord[] {
    try {
      if (!existsSync(this.dir)) return [];
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit)
        .flatMap((f) => {
          try {
            const raw = readFileSync(join(this.dir, f), 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(raw) as PreflightRecord;
            return parsed && typeof parsed === 'object' ? [parsed] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  latest(): PreflightRecord | undefined {
    return this.list(1)[0];
  }
}

// ─── Tool set ───────────────────────────────────────────────────────────────

export interface PreflightToolDeps {
  sessionId?: string | null;
  /**
   * The request being analysed.
   *
   * Injected because only the agent owns the transcript: a tool argument would let the
   * model paraphrase the user's message, and the whole point of the deterministic half is
   * that it reads what was ACTUALLY said.
   */
  getRequest: () => string;
  /** Tool names this agent has, read lazily — the list is still being built at construction. */
  listTools: () => string[];
  skillProfile?: () => string | undefined;
  automationMode?: () => boolean;
  activePlanGoal?: () => string | undefined;
  /**
   * Mistakes already recorded for work like this, one line each.
   *
   * A function rather than a value so the lookup happens when the tool is called, not when the
   * agent is built — the book changes as the turn runs, and a snapshot taken at construction
   * would answer with what was known before the conversation started.
   *
   * Optional because the book is a KB feature: without a knowledge base there is nothing to
   * look in, and pre-flight must still work.
   */
  knownErrors?: (query: string) => string[];
}

export interface PreflightToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export function createPreflightTools(
  workspaceRoot: string,
  deps: PreflightToolDeps,
): PreflightToolSet {
  const store = new PreflightStore(workspaceRoot, deps.sessionId ?? null);

  const toolMap = new Map<string, { def: ToolDefinition; fn: (a: Record<string, unknown>) => Promise<string> }>();
  const reg = (def: ToolDefinition, fn: (a: Record<string, unknown>) => Promise<string>) =>
    toolMap.set(def.name, { def, fn });

  /**
   * Ask the error book what it knows about this request.
   *
   * Bounded to a few lines and a few entries: this is a warning, not a report, and a long list
   * of past failures at the top of the analysis would push the actual request down the page.
   * A lookup that throws (no knowledge base, a locked database) is treated as an empty book —
   * pre-flight is the step that must not fail.
   */
  const knownErrorsFor = (query: string): string[] => {
    if (!deps.knownErrors) return [];
    try {
      return deps.knownErrors(query).slice(0, 3);
    } catch {
      return [];
    }
  };

  reg(
    {
      name: 'preflight_record',
      description:
        'Write down what this request actually asks for before starting non-trivial work: the literal request, '
        + 'the constraints nobody stated, the actual goal, and anything you must ask about first. '
        + 'Call it once, right after `plan_list` and before `plan_create`. It checks your request against the '
        + 'workspace, so a reference to a file that does not exist, or a "remind me tomorrow" with no scheduling '
        + 'tool, comes back as a finding instead of surfacing at the end.',
      parameters: {
        type: 'object',
        properties: {
          stated_intent: {
            type: 'string',
            description: 'What the user literally asked for, in their own terms.',
          },
          actual_goal: {
            type: 'string',
            description: 'What they are actually trying to achieve — the end state, which is not always the sentence they wrote.',
          },
          inferred_constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Constraints they did not state but that follow from the request, the workspace or the profile.',
          },
          clarification_needed: {
            type: 'array',
            items: { type: 'string' },
            description: 'Questions you cannot answer yourself. Leave empty if there are none — an empty list is a real answer.',
          },
          confidence: {
            type: 'number',
            description: 'How sure you are that the target above is right, 0..1. The result is capped by the checked facts.',
          },
        },
        required: ['stated_intent', 'actual_goal'],
      },
    },
    async (a) => {
      const request = deps.getRequest();
      if (isBlank(request)) {
        return 'Error: 当前没有可分析的用户请求（这条工具是给收到用户消息的那一轮用的）。';
      }

      const evidence = analyzeRequest(request, {
        workspaceRoot,
        tools: deps.listTools(),
        skillProfile: deps.skillProfile?.(),
        automationMode: deps.automationMode?.(),
        activePlanGoal: deps.activePlanGoal?.(),
      });

      const record = buildRecord(
        evidence,
        {
          stated_intent: String(a.stated_intent ?? ''),
          actual_goal: String(a.actual_goal ?? ''),
          inferred_constraints: Array.isArray(a.inferred_constraints)
            ? (a.inferred_constraints as string[])
            : [],
          clarification_needed: Array.isArray(a.clarification_needed)
            ? (a.clarification_needed as string[])
            : [],
          confidence: typeof a.confidence === 'number' ? a.confidence : undefined,
        },
        knownErrorsFor(request),
      );

      store.save(record);
      return renderRecord(record);
    },
  );

  const definitions = Array.from(toolMap.values()).map((t) => t.def);
  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const entry = toolMap.get(name);
    if (!entry) return `Error: unknown tool "${name}"`;
    try {
      return await entry.fn(args);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return { definitions, execute };
}
