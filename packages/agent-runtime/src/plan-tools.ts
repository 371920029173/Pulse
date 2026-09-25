import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@she/shared';

export interface KBToolSetLike {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

// ─── Plan: long-horizon task management ─────────────────────────────────────

export type StepStatus = 'pending' | 'active' | 'done' | 'blocked' | 'dropped';

/**
 * What the plan says to do when a step turns out to be impossible.
 *
 * Declared per step, at planning time, because that is when the decision is cheap: choosing
 * "skip" halfway through a failure, with the rest of the plan already in flight, is exactly the
 * judgement a model under pressure gets wrong. `stop` is the default — a plan that silently
 * continues past a failed prerequisite is worse than one that stops and says why.
 */
export type StepFailurePolicy = 'retry' | 'skip' | 'stop' | 'ask';

export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  /** Why this step matters / how to verify it. Keeps steps from being vague. */
  detail?: string;
  note?: string;
  /**
   * Ids of steps that must be `done` before this one may start or be finished.
   *
   * Always present on a step read back from the store (defaults to `[]`), so a caller never has
   * to distinguish "no dependencies" from "field missing on an old plan file".
   */
  dependsOn: string[];
  /** Always present, defaulting to `stop`. */
  onFailure: StepFailurePolicy;
  /**
   * How many times this step has been marked `blocked`.
   *
   * A count rather than a flag, because `retry` without one is an instruction to loop: the plan
   * would say "try again" forever and nothing in the transcript would show that this is the
   * fourth attempt at the same step. Rendered once it is non-zero.
   */
  attempts: number;
  updatedAt: string;
}

/** A step as it arrives from a model or a caller: a title, or a title plus declarations. */
export interface StepInput {
  title: string;
  dependsOn?: string[];
  onFailure?: StepFailurePolicy;
}

/**
 * The answer to "change this step".
 *
 * A refusal carries the reason because the caller is a model that has to act on it: "s2 waits on
 * s1, which is still pending" is a thing the model can fix, whereas `undefined` is not.
 */
export type StepUpdate =
  | { ok: true; plan: Plan; step: PlanStep; dropped: string[] }
  | { ok: false; reason: string };

export interface Plan {
  id: string;
  title: string;
  goal?: string;
  status: 'open' | 'done' | 'abandoned';
  steps: PlanStep[];
  /** Conversation this plan belongs to. Plans are per-chat, like Cursor. */
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Every valid step status, in the order the tool schema advertises them. */
export const STEP_STATUSES: StepStatus[] = ['pending', 'active', 'done', 'blocked', 'dropped'];
/** Every valid failure policy. */
export const FAILURE_POLICIES: StepFailurePolicy[] = ['retry', 'skip', 'stop', 'ask'];

/**
 * Persistent multi-step plan store.
 *
 * Long-horizon engineering work needs an explicit, durable plan that survives
 * across turns — otherwise each turn re-derives intent from a shrinking context
 * window and drifts. This keeps the plan on disk next to the workspace.
 */
/**
 * Coerce one arriving step into the stored shape.
 *
 * Accepts a bare title as well as a declaration, because the simple case (an ordered list of
 * things to do) is the common one and forcing a model to wrap every step in an object costs
 * tokens for nothing.
 */
function toStepInput(raw: unknown): StepInput | null {
  if (typeof raw === 'string') {
    const title = raw.trim();
    return title ? { title } : null;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const title = String(o.title ?? '').trim();
    if (!title) return null;
    const deps = Array.isArray(o.dependsOn)
      ? [...new Set(o.dependsOn.map((d) => String(d ?? '').trim()).filter(Boolean))]
      : undefined;
    const policy = FAILURE_POLICIES.includes(o.onFailure as StepFailurePolicy)
      ? (o.onFailure as StepFailurePolicy)
      : undefined;
    return { title, dependsOn: deps, onFailure: policy };
  }
  return null;
}

/** A step id that names no other step is a step that can never be resumed. */
function checkDepTargets(steps: { id: string }[], stepId: string, deps: string[]): string | null {
  const ids = new Set(steps.map((s) => s.id));
  if (deps.includes(stepId)) return `${stepId} 依赖它自己`;
  const unknown = deps.filter((d) => !ids.has(d));
  if (unknown.length) return `${stepId} 依赖了不存在的步骤 ${unknown.join('、')}`;
  return null;
}

/**
 * Whether the declared dependencies form a cycle.
 *
 * Only reachable through `plan_update`, since a plan being created cannot yet contain one, but
 * it has to be caught: a cycle means no step can ever become eligible, and the plan would sit
 * `open` forever, being handed back as "current work" with nothing to work on.
 */
function findCycle(steps: PlanStep[]): string | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 'done') return false;
    if (mark === 'visiting') return true;
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (walk(dep)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  for (const s of steps) {
    if (walk(s.id)) return s.id;
  }
  return null;
}

export class PlanStore {
  private filePath: string;
  /** When set, all reads/writes are scoped to this conversation. */
  private sessionId: string | null;

  constructor(workspaceRoot: string, sessionId?: string | null) {
    const dir = join(workspaceRoot, '.she');
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'plans.json');
    this.sessionId = sessionId ?? null;
  }

  private load(): Plan[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const raw = readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as Plan[];
      if (!Array.isArray(parsed)) return [];
      /*
       * Steps written by an earlier version have no `dependsOn` / `onFailure`. Filling the
       * defaults on READ rather than when writing means every caller sees one shape, and a plan
       * file written before this existed keeps working — including its `dependsOn`-less steps,
       * which become dependency-free exactly as they behaved before.
       */
      return parsed.map((p) => ({
        ...p,
        steps: (p.steps ?? []).map((s) => ({
          ...s,
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
          onFailure: FAILURE_POLICIES.includes(s.onFailure) ? s.onFailure : 'stop',
          attempts: Number.isFinite(s.attempts) ? Number(s.attempts) : 0,
        })),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Plans are workspace state, not chat state.
   *
   * Filtering to the current session hid every open plan from a previous
   * conversation, so a long task "forgot" itself the moment the user opened
   * another chat. Reads see the whole file. New plans are still stamped with
   * the conversation that created them.
   */
  private find(all: Plan[], id: string): Plan | undefined {
    return all.find((p) => p.id === id || p.id.startsWith(id));
  }

  private save(plans: Plan[]): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(plans, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  list(): Plan[] {
    return this.load().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  get(id: string): Plan | undefined {
    return this.find(this.load(), id);
  }

  /**
   * The open plan to keep working on.
   *
   * Prefer one this conversation created. If it has none, an open plan from
   * any conversation is still visible — that is the point of a workspace plan.
   */
  active(): Plan | undefined {
    const all = this.list();
    const mine = this.sessionId ? all.filter((p) => p.sessionId === this.sessionId) : all;
    return mine.find((p) => p.status === 'open') ?? all.find((p) => p.status === 'open');
  }

  /**
   * The step to hand to the agent when this plan is resumed.
   *
   * Kept in the store rather than derived by the caller because "where was I?" has to be the
   * same answer everywhere it is asked — the tool output, the prompt, the UI. The rule itself
   * lives in `nextStepOf` so the rendered plan cannot disagree with this.
   */
  nextStep(planId?: string): { plan: Plan; step: PlanStep; why: string } | undefined {
    const plan = planId ? this.find(this.load(), planId) : this.active();
    if (!plan) return undefined;
    const next = nextStepOf(plan);
    return next ? { plan, ...next } : undefined;
  }

  /** Steps whose dependencies are all `done` and that have not started yet. */
  private activateNext(plan: Plan): void {
    if (plan.steps.some((s) => s.status === 'active')) return;
    const done = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
    const next = plan.steps.find((s) => s.status === 'pending' && s.dependsOn.every((d) => done.has(d)));
    if (next) next.status = 'active';
  }

  create(title: string, steps: (string | StepInput)[], goal?: string): Plan {
    const plans = this.load();
    const now = new Date().toISOString();
    const inputs = steps.map(toStepInput).filter((s): s is StepInput => s !== null);
    const plan: Plan = {
      id: `plan_${randomUUID().slice(0, 8)}`,
      title: title.trim() || '未命名计划',
      goal: goal?.trim() || undefined,
      status: 'open',
      steps: inputs.map((s, i) => ({
        id: `s${i + 1}`,
        title: s.title,
        status: 'pending' as StepStatus,
        dependsOn: s.dependsOn ?? [],
        onFailure: s.onFailure ?? 'stop',
        attempts: 0,
        updatedAt: now,
      })),
      sessionId: this.sessionId ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    /*
     * Dependencies naming an unknown step are dropped rather than stored. On create the caller
     * has a full list in hand; on `plan_update` the same mistake is REFUSED, because there the
     * step exists and the reference is the only thing that is wrong.
     */
    for (const s of plan.steps) {
      s.dependsOn = s.dependsOn.filter((d) => plan.steps.some((x) => x.id === d) && d !== s.id);
    }
    this.activateNext(plan);
    plans.push(plan);
    this.save(plans);
    return plan;
  }

  /**
   * Change one step, refusing transitions the plan does not allow.
   *
   * Two refusals matter and both used to be silent successes:
   *   - starting or finishing a step whose prerequisites are not done. The old code marked it
   *     and moved on, which is how a plan reports 4/4 while a prerequisite was never done.
   *   - a `skip` that does not cascade. Dropping the step that other steps declared they need
   *     leaves those steps waiting for input that will never arrive, and the plan parks there.
   */
  setStepStatus(
    planId: string,
    stepId: string,
    status: StepStatus,
    note?: string,
    declared?: { dependsOn?: string[]; onFailure?: StepFailurePolicy },
  ): StepUpdate {
    const plans = this.load();
    const plan = this.find(plans, planId);
    if (!plan) return { ok: false, reason: `plan not found (plan_id=${planId})` };
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, reason: `step not found (plan_id=${plan.id}, step_id=${stepId})` };

    if (declared?.dependsOn) {
      const deps = [...new Set(declared.dependsOn.map((d) => String(d).trim()).filter(Boolean))];
      const bad = checkDepTargets(plan.steps, step.id, deps);
      if (bad) return { ok: false, reason: bad };
      const prev = step.dependsOn;
      step.dependsOn = deps;
      const cycle = findCycle(plan.steps);
      if (cycle) {
        /*
         * Restore, do not save. A cycle that was written and then rejected would still be on
         * disk for the next reader, and the plan would be unreachable from then on.
         */
        step.dependsOn = prev;
        return { ok: false, reason: `依赖成环，照这样写没有任何一步能开始（从 ${cycle} 开始绕回来了）` };
      }
    }
    if (declared?.onFailure) step.onFailure = declared.onFailure;

    if (status === 'active' || status === 'done') {
      const done = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
      const missing = step.dependsOn.filter((d) => !done.has(d));
      if (missing.length) {
        const state = plan.steps.find((s) => s.id === missing[0]);
        return {
          ok: false,
          reason: `${step.id} 的前置还没有完成：${missing.join('、')}`
            + `（${state?.id} 现在是 ${state?.status ?? '不存在'}）——先把前置做完，或者把它标成 dropped`,
        };
      }
    }

    const now = new Date().toISOString();
    const dropped: string[] = [];

    if (status === 'active') {
      /*
       * One step in flight at a time. The plan is what the agent reads to know what it is doing
       * right now, and two rows marked "[>]" make that question unanswerable. The step that
       * loses its turn keeps its note.
       */
      for (const other of plan.steps) {
        if (other.id !== step.id && other.status === 'active') other.status = 'pending';
      }
    }

    step.status = status;
    if (status === 'blocked') step.attempts += 1;
    if (note !== undefined) step.note = note;
    step.updatedAt = now;
    plan.updatedAt = now;

    if (status === 'done') this.activateNext(plan);

    if (status === 'dropped' || (status === 'blocked' && step.onFailure === 'skip')) {
      if (status === 'blocked') {
        step.status = 'dropped';
        step.note = [note, 'onFailure=skip：跳过这一步'].filter(Boolean).join('；');
      }
      for (const id of this.cascadeDrop(plan, step)) dropped.push(id);
      this.activateNext(plan);
    }

    /*
     * Closure is checked for ANY transition, not just `done`, and now also when a cascade
     * dropped the remaining steps. Dropping the final step used to leave the plan 'open'
     * forever — and because `active()` returns the newest open plan, an abandoned plan kept
     * being handed back to the agent as its current work.
     */
    if (plan.steps.length > 0 && plan.steps.every((s) => s.status === 'done' || s.status === 'dropped')) {
      plan.status = 'done';
    }
    this.save(plans);
    return { ok: true, plan, step, dropped };
  }

  /**
   * Drop the steps that depended — directly or transitively — on one that was skipped.
   *
   * The note names the culprit so the transcript explains itself later: a step that disappeared
   * without a stated reason is indistinguishable from one the agent forgot.
   */
  private cascadeDrop(plan: Plan, from: PlanStep): string[] {
    const dropped: string[] = [];
    const queue = [from.id];
    while (queue.length) {
      const gone = queue.shift()!;
      for (const s of plan.steps) {
        if (s.id === gone || !s.dependsOn.includes(gone)) continue;
        if (s.status === 'done' || s.status === 'dropped') continue;
        s.status = 'dropped';
        s.note = `${s.dependsOn.filter((d) => d === gone).join('、')} 被跳过，这一步失去前置输入`;
        s.updatedAt = new Date().toISOString();
        dropped.push(s.id);
        queue.push(s.id);
      }
    }
    return dropped;
  }

  addSteps(planId: string, steps: (string | StepInput)[]): Plan | undefined {
    const plans = this.load();
    const plan = this.find(plans, planId);
    if (!plan) return undefined;
    const now = new Date().toISOString();
    const base = plan.steps.length;
    const inputs = steps.map(toStepInput).filter((s): s is StepInput => s !== null);
    inputs.forEach((s, i) => {
      const id = `s${base + i + 1}`;
      plan.steps.push({
        id,
        title: s.title,
        status: 'pending' as StepStatus,
        dependsOn: (s.dependsOn ?? []).filter((d) => d !== id),
        onFailure: s.onFailure ?? 'stop',
        attempts: 0,
        updatedAt: now,
      });
    });
    /*
     * Existence is checked after the whole batch is in, not step by step: a batch may reference
     * a sibling that is pushed later in the same call, and dropping that reference would
     * silently lose the dependency the caller just declared.
     */
    for (const s of plan.steps) {
      s.dependsOn = s.dependsOn.filter((d) => plan.steps.some((x) => x.id === d) && d !== s.id);
    }
    /*
     * Finding new work reopens a finished plan.
     *
     * Otherwise the plan stayed `done`, `active()` skipped it, and the agent that had just
     * written down what is left to do would not be handed that plan again — the new steps would
     * sit in a file nobody reads.
     */
    if (plan.status === 'done' && plan.steps.some((s) => s.status === 'pending' || s.status === 'active')) {
      plan.status = 'open';
    }
    plan.updatedAt = now;
    this.activateNext(plan);
    this.save(plans);
    return plan;
  }

  setStatus(planId: string, status: Plan['status']): Plan | undefined {
    const plans = this.load();
    const plan = this.find(plans, planId);
    if (!plan) return undefined;
    plan.status = status;
    plan.updatedAt = new Date().toISOString();
    this.save(plans);
    return plan;
  }
}

const STATUS_MARK: Record<StepStatus, string> = {
  pending: '[ ]',
  active: '[>]',
  done: '[x]',
  blocked: '[!]',
  dropped: '[-]',
};

export function renderPlan(plan: Plan): string {
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const lines = [
    `Plan ${plan.id} — ${plan.title}  (${done}/${plan.steps.length} 完成, 状态 ${plan.status})`,
  ];
  if (plan.sessionId) lines.push(`来自会话: ${plan.sessionId}`);
  if (plan.goal) lines.push(`目标: ${plan.goal}`);
  for (const s of plan.steps) {
    /*
     * Dependencies and the failure policy are printed only when they are not the default. A
     * plan of plain steps should read exactly as it did before, and a wall of `依赖: —` on
     * every line is noise that makes the one line that matters harder to find.
     */
    const deps = s.dependsOn.length ? `  依赖: ${s.dependsOn.join('、')}` : '';
    const policy = s.onFailure !== 'stop' ? `  失败策略: ${s.onFailure}` : '';
    const tries = s.attempts > 0 ? `  已试 ${s.attempts} 次` : '';
    lines.push(`  ${STATUS_MARK[s.status]} ${s.id} ${s.title}${deps}${policy}${tries}${s.note ? `  — ${s.note}` : ''}`);
  }

  /*
   * Where to continue, spelled out.
   *
   * This is what makes the plan usable as a checkpoint: after a restart, or in a new
   * conversation, the agent's first read of the plan answers "what now?" without it having to
   * re-derive that from five status marks. When the answer is "nowhere", it says which step is
   * in the way and what the plan said to do about it, so a stalled plan does not read as a
   * finished one.
   */
  const next = nextStepOf(plan);
  lines.push(next
    ? `下一步: ${next.step.id} ${next.step.title}（${next.why}）`
    : plan.status === 'done' ? '下一步: 无，计划已收口' : '下一步: 无（没有可开始的步骤）');
  return lines.join('\n');
}

/**
 * The next-step rule, shared by `PlanStore.nextStep` and `renderPlan`.
 *
 * Both ask "where does this plan resume?", and the answer has to be the same in the tool output
 * and in the rendered plan; two copies of this rule would be two answers.
 */
export function nextStepOf(plan: Plan): { step: PlanStep; why: string } | undefined {
  const running = plan.steps.find((s) => s.status === 'active');
  if (running) return { step: running, why: '正在进行' };
  const done = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
  const eligible = plan.steps.find((s) => s.status === 'pending' && s.dependsOn.every((d) => done.has(d)));
  if (eligible) {
    return {
      step: eligible,
      why: eligible.dependsOn.length ? `前置（${eligible.dependsOn.join('、')}）都已完成` : '没有前置',
    };
  }
  const blocked = plan.steps.find((s) => s.status === 'blocked');
  if (blocked) {
    /*
     * The policy is spelled out here rather than left to the prompt, because it is the plan's
     * own instruction and the resume path is exactly where it must not be lost: a `retry` that
     * reads as a plain failure gets abandoned instead of retried, and a `stop` that reads as a
     * failure gets retried forever.
     */
    const tries = blocked.attempts > 0 ? `，已试过 ${blocked.attempts} 次` : '';
    const how =
      blocked.onFailure === 'retry'
        ? `换个做法再试一次${tries}`
        : blocked.onFailure === 'ask'
          ? '该用 ask_user 问用户怎么继续'
          : `需要用户决定怎么继续${tries}`;
    return { step: blocked, why: `受阻（onFailure=${blocked.onFailure}）：${how}` };
  }
  const waiting = plan.steps.find((s) => s.status === 'pending');
  if (waiting) {
    const missing = waiting.dependsOn.filter((d) => !done.has(d));
    const state = plan.steps.find((s) => s.id === missing[0]);
    return {
      step: waiting,
      why: `等前置 ${missing.join('、')}（${state?.id} 现在是 ${state?.status ?? '不存在'}）`,
    };
  }
  return undefined;
}

// ─── Tool set ───────────────────────────────────────────────────────────────

/**
 * Planning / reporting / asking tools.
 *
 * These are the long-horizon affordances that a pure tool-loop lacks:
 *   - plan_*: durable multi-step task state that survives across turns
 *   - report_write: turn findings into a shareable artifact
 *   - ask_user: explicitly request clarification instead of guessing
 */
export function createPlanTools(workspaceRoot: string, sessionId?: string | null): KBToolSetLike & { store: PlanStore } {
  const plans = new PlanStore(workspaceRoot, sessionId);
  const toolMap = new Map<string, { def: ToolDefinition; fn: (a: Record<string, unknown>) => Promise<string> }>();

  const reg = (def: ToolDefinition, fn: (a: Record<string, unknown>) => Promise<string>) =>
    toolMap.set(def.name, { def, fn });

  reg(
    {
      name: 'plan_create',
      description:
        'Create a durable multi-step plan for long or multi-stage work. Use this BEFORE starting non-trivial tasks so progress survives context loss. Steps should be concrete and verifiable. '
        + 'A step is either a plain title, or an object {title, dependsOn, onFailure}: `dependsOn` lists step ids that must be done first (e.g. ["s1"]) and `onFailure` says what to do when the step turns out to be impossible — retry | skip | stop | ask (default stop). '
        + 'Declare dependencies when order is forced: it is what lets the plan be resumed correctly after an interruption, and it stops a step from being started before its input exists.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short plan title' },
          steps: {
            type: 'array',
            description: 'Ordered, concrete steps. A string, or {title, dependsOn?, onFailure?}.',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    dependsOn: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Step ids (s1, s2, …) that must be done before this step starts',
                    },
                    onFailure: { type: 'string', enum: FAILURE_POLICIES },
                  },
                  required: ['title'],
                },
              ],
            },
          },
          goal: { type: 'string', description: 'Optional one-line goal' },
        },
        required: ['title', 'steps'],
      },
    },
    async (a) => {
      const title = String(a.title ?? '').trim();
      const steps = Array.isArray(a.steps) ? a.steps : [];
      if (!title || !steps.length) return 'Error: title and at least one step are required';
      const plan = plans.create(title, steps, a.goal ? String(a.goal) : undefined);
      return `Created plan.\n${renderPlan(plan)}`;
    },
  );

  reg(
    {
      name: 'plan_update',
      description:
        'Update one step of a plan. Status: pending | active | done | blocked | dropped. Completing a step auto-activates the next step whose dependencies are done, and only one step is in progress at a time. '
        + 'A step cannot be started or finished while a step it declares in `dependsOn` is not done — the call is refused with the ids that are in the way. '
        + 'When a step turns out to be impossible, mark it `blocked`: the plan\'s own `onFailure` then applies (skip drops every step that depended on it). '
        + 'You may also pass `depends_on` / `on_failure` to declare or correct them. Always update the plan as you make progress.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'Plan id (from plan_create / plan_list)' },
          step_id: { type: 'string', description: 'Step id, e.g. s1' },
          status: { type: 'string', enum: STEP_STATUSES, description: 'New status (optional if you are only declaring depends_on / on_failure)' },
          note: { type: 'string', description: 'Optional short note (blocker, finding, evidence)' },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of steps that must be done before this one; replaces the current list',
          },
          on_failure: { type: 'string', enum: FAILURE_POLICIES, description: 'What to do if this step cannot be done' },
        },
        required: ['plan_id', 'step_id'],
      },
    },
    async (a) => {
      const planId = String(a.plan_id ?? '');
      const stepId = String(a.step_id ?? '');
      const raw = String(a.status ?? '');
      const declares = Array.isArray(a.depends_on) || typeof a.on_failure === 'string';
      if (!raw && !declares) {
        return `Error: 必须给 status 或 depends_on / on_failure 之一（只给 plan_id 和 step_id 不知道该改什么）`;
      }
      if (raw && !STEP_STATUSES.includes(raw as StepStatus)) {
        /*
         * Names the valid values. The previous message (`invalid status`) told the model only
         * that it was wrong, which leaves it guessing at the vocabulary — and the classifier
         * cannot tell an argument mistake from a broken tool without the reason in the text.
         */
        return `Error: status 不合法（必须是 ${STEP_STATUSES.join(' / ')} 之一），收到 "${raw}"`;
      }
      // Allow "active plan" shorthand.
      const targetId = planId || plans.active()?.id || '';
      const result = plans.setStepStatus(
        targetId,
        stepId,
        (raw || 'pending') as StepStatus,
        a.note ? String(a.note) : undefined,
        {
          dependsOn: Array.isArray(a.depends_on) ? (a.depends_on as string[]) : undefined,
          onFailure: FAILURE_POLICIES.includes(a.on_failure as StepFailurePolicy)
            ? (a.on_failure as StepFailurePolicy)
            : undefined,
        },
      );
      if (!result.ok) return `Error: ${result.reason}`;
      const skipped = result.dropped.length
        ? `\n被一起跳过的步骤: ${result.dropped.join('、')}（它们声明依赖这一步）`
        : '';
      return renderPlan(result.plan) + skipped;
    },
  );

  reg(
    {
      name: 'plan_add_steps',
      description:
        'Append steps to an existing plan when you discover new work. Each step is a plain title, or {title, dependsOn, onFailure} like plan_create.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'Plan id (optional; defaults to the active plan)' },
          steps: {
            type: 'array',
            description: 'Steps to append',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    dependsOn: { type: 'array', items: { type: 'string' } },
                    onFailure: { type: 'string', enum: FAILURE_POLICIES },
                  },
                  required: ['title'],
                },
              ],
            },
          },
        },
        required: ['steps'],
      },
    },
    async (a) => {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      if (!steps.length) return 'Error: steps are required';
      const targetId = String(a.plan_id ?? '') || plans.active()?.id || '';
      const plan = plans.addSteps(targetId, steps);
      if (!plan) return `Error: plan not found (plan_id=${targetId})`;
      return renderPlan(plan);
    },
  );

  reg(
    {
      name: 'plan_list',
      description: 'List every plan in this workspace, including plans opened in other conversations. Check this at the start of long work so a task is not forgotten when the chat changes.',
      parameters: { type: 'object', properties: {} },
    },
    async () => {
      const all = plans.list();
      if (!all.length) return 'No plans yet.';
      return all.map(renderPlan).join('\n\n');
    },
  );

  reg(
    {
      name: 'report_write',
      description:
        'Write a structured markdown report artifact into the workspace (.she/reports/). Use for analysis summaries, audit findings, comparisons or any deliverable the user will read outside the chat.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Report title' },
          summary: { type: 'string', description: 'Executive summary (a few lines)' },
          sections: {
            type: 'array',
            description: 'Report sections',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                body: { type: 'string', description: 'Markdown body' },
              },
              required: ['heading', 'body'],
            },
          },
          filename: { type: 'string', description: 'Optional filename stem' },
        },
        required: ['title'],
      },
    },
    async (a) => {
      const title = String(a.title ?? 'Report').trim();
      const summary = a.summary ? String(a.summary) : '';
      const sections = Array.isArray(a.sections) ? (a.sections as { heading: string; body: string }[]) : [];
      const stem = String(a.filename ?? title)
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'report';

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const dir = join(workspaceRoot, '.she', 'reports');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${stem}-${stamp}.md`);

      const parts = [
        `# ${title}`,
        '',
        `生成时间: ${new Date().toISOString()}`,
        '',
        summary ? `## 摘要\n\n${summary}\n` : '',
      ];
      for (const s of sections) {
        parts.push(`## ${s.heading}\n\n${s.body ?? ''}\n`);
      }
      writeFileSync(file, parts.filter(Boolean).join('\n'), 'utf8');

      const rel = file.replace(resolve(workspaceRoot) + '\\', '').replace(/\\/g, '/');
      return `Report written: ${rel}\n(${sections.length} sections, ${parts.join('').length} chars)`;
    },
  );

  reg(
    {
      name: 'ask_user',
      description:
        'Ask the user a focused question when a decision is genuinely theirs (ambiguous requirements, destructive trade-offs, missing credentials). Prefer this over guessing. Ends your turn so the user can answer.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of concrete choices',
          },
          context: { type: 'string', description: 'Optional brief context for why you are asking' },
        },
        required: ['question'],
      },
    },
    async (a) => {
      const question = String(a.question ?? '').trim();
      if (!question) return 'Error: question is required';
      const options = Array.isArray(a.options) ? (a.options as string[]) : [];
      const context = a.context ? String(a.context) : '';

      // Record it so the UI can surface it prominently.
      try {
        const dir = join(workspaceRoot, '.she');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'pending-question.json'),
          JSON.stringify(
            { question, options, context, askedAt: new Date().toISOString() },
            null,
            2,
          ),
          'utf8',
        );
      } catch { /* non-fatal */ }

      const lines = [`已向用户提问，请结束本轮并等待回答。`, `问题：${question}`];
      if (options.length) lines.push(`选项：${options.map((o, i) => `${i + 1}) ${o}`).join('  ')}`);
      return lines.join('\n');
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

  return { definitions, execute, store: plans };
}
