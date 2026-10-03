import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@she/shared';
import { highFindings, renderGuardrailRefusal, scanOutbound } from './guardrail.js';
import {
  sessionStateDir,
  listSessionIds,
  workspaceStateFile,
  isWorkspaceScope,
  WORKSPACE_SCOPE,
  CHAT_SESSION_PREFIX,
} from './session-state.js';

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

  /**
   * 这个 store 读写哪个作用域的计划。
   *
   * 聊天用 `WORKSPACE_SCOPE`（`.she/plans.json`，一个项目一份，所有会话共享），群用 `cluster:<roomId>`
   * （各自一个目录，`createGroupPlanTools` 传进来）。**作用域是必需参数**，不给就抛错：让"忘了传"
   * 落到一份共享文件上，正是要根除的形态。
   */
  private scope: string;
  /**
   * 计划记下"是哪个会话建的"，**只用于溯源，不参与读写**。
   *
   * 和 `scope` 分开是这次改动的要点：以前一个字段干两件事（既决定文件在哪，又决定谁能看见），于是
   * "工作区级文件"和"按会话过滤"必须绑在一起。现在文件按作用域分，来源只是一个可追溯的标记 ——
   * 用户看到一份计划时可以知道它是哪次对话留下的。
   */
  private sessionId: string;
  /** 本作用域的状态目录，供需要把相邻文件放一起的调用方复用。 */
  readonly directory: string;

  constructor(workspaceRoot: string, scope: string, createdBy?: string) {
    this.filePath = PlanStore.fileFor(workspaceRoot, scope);
    this.directory = dirname(this.filePath);
    mkdirSync(this.directory, { recursive: true });
    this.scope = scope;
    this.sessionId = createdBy ?? scope;
  }

  /**
   * 某个作用域的计划文件在哪 —— 只报路径，不建目录。
   *
   * 给"列出哪些会话有计划"用：那个动作要从目录名出发去够别人的目录，而路径形状（含文件名）只在这
   * 一处拼，构造器也走它 —— 两处各拼一次，就会有一处忘了校验。
   */
  static fileFor(workspaceRoot: string, scope: string): string {
    if (isWorkspaceScope(scope)) return workspaceStateFile(workspaceRoot, 'plans.json');
    return join(sessionStateDir(workspaceRoot, scope), 'plans.json');
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
    /*
     * An empty id matches nothing.
     *
     * `startsWith('')` is true for every string, so without this guard a call that named no plan
     * (and found no active one) silently resolved to whichever plan happened to be first in the
     * file — a write to someone else's plan, from a caller that believed it was addressing none.
     */
    if (!id) return undefined;
    return all.find((p) => p.id === id || p.id.startsWith(id));
  }

  private save(plans: Plan[]): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(plans, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /**
   * 整份写回（迁移用）。
   *
   * 存在是因为迁移要写的是"合并后的全集"，而 `create` / `updateStep` 都是"改一份再存"。用一个只做写
   * 的入口，迁移就没法顺手改计划的内容 —— 它只该搬运。
   */
  replaceAll(plans: Plan[]): void {
    this.save(plans);
  }

  list(): Plan[] {
    return this.load().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  get(id: string): Plan | undefined {
    return this.find(this.load(), id);
  }

  /**
   * The open plan of this conversation.
   *
   * 2026-09-27 起这里没有"退回别的会话的计划"这一步了：文件按会话分开，别人的计划根本不在这个文件里，
   * 所以也就没有"默认读得到别人的计划"这回事。长任务要跨会话续做，走的是**显式动作**（去打开那个会话），
   * 不再靠 `plan_list` 顺手把别人的计划捞出来。
   */
  active(): Plan | undefined {
    return this.list().find((p) => p.status === 'open');
  }

  /**
   * 本作用域里那个进行中的计划 —— 对聊天来说就是**本工作区的**。
   *
   * `active()` 和它是同一条规则：文件按作用域分开，作用域里没有"别人的计划"这回事。名字留着是因为
   * 交付检查读起来清楚（"我这边有没有没做完的计划"），而不是因为它是会话私有的 —— 对聊天来说它是
   * 工作区级的，另一个会话留下的未收口计划在这里**看得见**，也正因为看得见才拦得住。
   */
  mine(): Plan | undefined {
    return this.active();
  }

  /**
   * Every plan still open in this scope, newest first.
   *
   * `active()` answers "where was I?" and has to give ONE answer. This answers "is anything in
   * this scope unfinished?", where one is the wrong number: nothing stops a second plan being
   * created in the same workspace (`plan_create` pushes), and the prompt calls the leftover one
   * out. Accounting for unfinished work through `active()` alone therefore reported only the
   * newest open plan — a delivery's "what is still outstanding" list was true about one plan and
   * silent about the rest (第四轮 6a).
   */
  openPlans(): Plan[] {
    return this.list().filter((p) => p.status === 'open');
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
      sessionId: this.sessionId,
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

/**
 * 哪些**目录作用域**里有计划 —— 今天只有讨论群（`cluster:<roomId>`）。
 *
 * 聊天计划是工作区级的（`.she/plans.json`），不在 `.she/sessions/<id>/` 下面，所以这个函数不会再列出
 * 任何一个聊天 —— 那正是这次改动的目的：一个项目里的计划本来就该在普通视图里全部看得见，而不是藏在
 * "哪些别的会话有计划"的选择器后面（那个选择器就是为按会话分文件而存在的）。
 *
 * 只数自己的目录，不读别的工作区。**列目录不是读内容**：返回的是会话 id 和计数，用户点开之前一行计划
 * 正文都不会离开那个目录。解不出 id 的目录名直接跳过（见 `listSessionIds`）。
 */
export interface PlanSessionSummary {
  session_id: string;
  plans: number;
  open: number;
  /** 这些计划里最新的一次改动；无时间戳（旧文件）时为 null。 */
  updated_at: string | null;
}

export function planSessions(workspaceRoot: string): PlanSessionSummary[] {
  const out: PlanSessionSummary[] = [];
  for (const sessionId of listSessionIds(workspaceRoot)) {
    /*
     * 走 `list()` 而不是自己 `JSON.parse`：旧计划文件缺字段时要补齐的默认值、以及"坏文件当成没有计划"
     * 这件事，同样只能有一处知道 —— 第二个解析器迟早会和第一个不一致。目录已经存在（它就是列出来的
     * 那个），所以这里构造 store 不会额外建出目录来。
     */
    const store = new PlanStore(workspaceRoot, sessionId);
    const plans = store.list();
    if (!plans.length) continue;
    const stamps = plans
      .map((p) => Date.parse(p.updatedAt || p.createdAt || ''))
      .filter((n) => Number.isFinite(n));
    out.push({
      session_id: sessionId,
      plans: plans.length,
      open: plans.filter((p) => p.status === 'open').length,
      updated_at: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
    });
  }
  // 最近动过的排在前面：选择器问的是"我上次那个长任务在哪"。
  return out.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || a.session_id.localeCompare(b.session_id));
}

/**
 * 把 2026-09-27 拆出去的计划收回到工作区那一份里。
 *
 * 那次改动把计划切成会话私有，而迁移**只搬了进行中的那一份**：实测这个工作区里 12 份已收口的计划留在了
 * `.she/plans.json`，agent 再也看不见它们（`plan_list` 只读当前会话的文件），而会话目录里只有 1 份。
 * 改回工作区级之后必须把那 12 份并回来，否则这次改动只是把问题掉了个方向 —— 丢的换成会话目录里的那些。
 *
 * 合并规则：按 id 取并集；同一个 id 以 `updatedAt` 更新的那份为准（迁移之后又被改过的那份才是真的）。
 * 原文件不删：迁移不该是单向门，而且这些文件很小。可重复执行，第二次是空操作。
 *
 * 只看**聊天**会话目录（`sess_*`）：群计划用自己的作用域（`cluster:<roomId>`），不属于工作区那一份。
 *
 * 返回收回了多少份，供启动日志说明发生了什么。
 */
export function adoptSessionPlansIntoWorkspace(workspaceRoot: string): { adopted: number; updated: number } {
  const workspaceStore = new PlanStore(workspaceRoot, WORKSPACE_SCOPE);
  const byId = new Map(workspaceStore.list().map((p) => [p.id, p]));
  let adopted = 0;
  let updated = 0;
  for (const sessionId of listSessionIds(workspaceRoot)) {
    if (!sessionId.startsWith(CHAT_SESSION_PREFIX)) continue;
    for (const plan of new PlanStore(workspaceRoot, sessionId).list()) {
      const current = byId.get(plan.id);
      if (!current) {
        byId.set(plan.id, plan);
        adopted += 1;
      } else if ((plan.updatedAt || '') > (current.updatedAt || '')) {
        byId.set(plan.id, plan);
        updated += 1;
      }
    }
  }
  if (adopted || updated) workspaceStore.replaceAll([...byId.values()]);
  return { adopted, updated };
}

const STATUS_MARK: Record<StepStatus, string> = {
  pending: '[ ]',
  active: '[>]',
  done: '[x]',
  blocked: '[!]',
  dropped: '[-]',
};

/** How a delivery describes itself, in the artifact a human reads later. */
const STATUS_LABEL: Record<'done' | 'partial' | 'needs_confirmation' | 'blocked', string> = {
  done: '已完成',
  partial: '部分完成',
  needs_confirmation: '待确认',
  blocked: '受阻',
};

/**
 * A list as markdown bullets, with `empty` standing in when there is nothing.
 *
 * The placeholder is passed in rather than defaulted, because "no evidence" and "no risks" are
 * very different statements and one generic `（无）` would flatten them.
 */
function listLines(items: string[], empty: string): string[] {
  if (!items.length) return [empty];
  return items.map((i) => (i.startsWith('- ') ? i : `- ${i}`));
}

/**
 * A line that is nothing but the claim, however it is spelled.
 *
 * Anchored whole-line on purpose: "done" is an assertion, but "done: 12/12 specs pass" is
 * evidence, and a rule that rejected any line mentioning the word would teach the model to avoid
 * the word rather than to bring the output.
 */
const EVIDENCE_ASSERTION_ONLY =
  /^(done|ok|okay|yes|no|pass|passed|success|successful|fixed|works|working|tested|verified|confirmed|sure|good|finish(ed)?|complete[d]?|n\/?a|none|无|好|好了|完成|已完成|搞定了?|通过|成功了?|已修复|已改好|已验证|已确认|已测试|没问题|正常|可以)$/i;

/**
 * Something observed rather than asserted: a location, a number, or quoted output.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT COUNTS, AND WHAT DELIBERATELY DOES NOT
 *
 * A signal is a LOCATION (`file:line`, a path, a known extension), a NUMBER (a count, a line, an
 * exit code), a BACKTICKED identifier, an ARROW into a result, an exit/stream word, the text of an
 * error, or an errno. Those are things a reader can go and check.
 *
 * Topic words are NOT signals: `测试`, `日志`, `输出`, `命令`, `报错`, `tests`, `logs`, `specs`. They
 * were accepted until this was tightened, and that was the hole. Naming the topic is not bringing
 * the result — "测试通过" and "跑了测试，全绿" mention a test, so they passed the rule whose entire
 * job is to refuse "把结论又说了一遍". The check was one word away from the thing it was built to
 * catch, which is the same defect as the non-empty rule it replaced, one level up.
 *
 * Still deliberately generous in the other direction: a false rejection costs a round trip, so a
 * bare path (`src/index`), a bare errno (`ENOENT`) and an extension-less location all count. There
 * is still no bare-colon signal: `状态: 完成` is an assertion wearing a field name.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const EVIDENCE_SIGNAL =
  /(\d|`|→|->|=>|\bexit\b|\bstdout\b|\bstderr\b|\b\w*Error\b|\b\w*Exception\b|\b\w*Traceback\b|\w+[/\\][\w.-]+|\.(ts|tsx|js|mjs|cjs|json|md|sql|css|html|py|yml|yaml|toml|sh|ps1|txt|log|csv)\b|行号|退出码)/i;

/**
 * An errno, matched case-SENSITIVELY and on its own.
 *
 * `ENOENT` is real evidence — it is the kernel's own answer — but folding it into the case-insensitive
 * pattern above would make `\bE[A-Z]{3,}\b` match "everything", so `everything works` would read as
 * evidence. Same word shape, opposite meaning: the case is the whole signal.
 */
const EVIDENCE_ERRNO = /\bE[A-Z]{4,}\b/;

/**
 * Does this line name something a reader could check?
 *
 * 第四轮 7a: evidence was validated as "not empty". Non-empty is not the same as substantive —
 * `["done"]` passed every rule, so the one section that exists to make a conclusion falsifiable
 * could be filled with the conclusion itself. The bar here is low and mechanical: point at a
 * location, a number, or a piece of real output. Assertion-only lines are refused.
 */
export function looksLikeEvidence(text: string): boolean {
  const s = String(text ?? '').trim();
  if (s.length < 3) return false;
  if (EVIDENCE_ASSERTION_ONLY.test(s)) return false;
  return EVIDENCE_SIGNAL.test(s) || EVIDENCE_ERRNO.test(s);
}

export interface RenderPlanOptions {
  /**
   * Print a step's note ONLY for the ids in this set; every other step prints without one.
   *
   * `plan_update` runs once per step of progress — a dozen times on a long task — and the notes
   * are the long part of the plan. Repeating all of them on every update was pure repeat billing:
   * one measured run spent ~15 updates re-sending every note in the plan. The step LIST is short
   * and is what lets the plan be read as a whole, so it stays; the notes are what is worth paying
   * for only on the step the call actually touched.
   *
   * Nothing is lost: the notes are on disk and `plan_list` prints all of them. Undefined means
   * "no filter" — `plan_create` / `plan_list` / the UI want the whole thing.
   */
  notesOnly?: ReadonlySet<string>;
}

/**
 * Which steps a write's reply should print notes for: the ones the call actually moved.
 *
 * Derived by comparing the plan before the call against the plan after it, rather than from the
 * arguments — because the changes worth reporting are the ones the caller did NOT ask for.
 * Completing a step activates the next one, starting one sends the previously active step back to
 * `pending`, and `skip` drops every step downstream. Each of those has an id that only the
 * comparison can name, and a note printed next to an untouched step reads as a change that did
 * not happen.
 *
 * A missing snapshot returns `undefined` — "print everything" — rather than an empty set. The
 * filter exists to save tokens on a repeated echo, and a reply that silently drops a note because
 * a read failed is a worse trade than a few hundred wasted tokens.
 */
function notesToPrint(
  before: Plan | undefined,
  after: Plan,
  extra: readonly string[] = [],
): Set<string> | undefined {
  if (!before) return undefined;
  const prev = new Map(before.steps.map((s) => [s.id, s]));
  const touched = new Set<string>(extra);
  for (const s of after.steps) {
    const was = prev.get(s.id);
    if (!was) {
      touched.add(s.id); // a step appended by this call
      continue;
    }
    if (
      was.status !== s.status
      || was.note !== s.note
      || was.attempts !== s.attempts
      || was.onFailure !== s.onFailure
      || was.dependsOn.join('\u0000') !== s.dependsOn.join('\u0000')
    ) {
      touched.add(s.id);
    }
  }
  return touched;
}

/** One step's line. Shared by every caller so the note filter cannot change the format. */
function stepLine(s: PlanStep, opts?: RenderPlanOptions): string {
  /*
   * Dependencies and the failure policy are printed only when they are not the default. A
   * plan of plain steps should read exactly as it did before, and a wall of `依赖: —` on
   * every line is noise that makes the one line that matters harder to find.
   */
  const deps = s.dependsOn.length ? `  依赖: ${s.dependsOn.join('、')}` : '';
  const policy = s.onFailure !== 'stop' ? `  失败策略: ${s.onFailure}` : '';
  const tries = s.attempts > 0 ? `  已试 ${s.attempts} 次` : '';
  const showNote = s.note && (!opts?.notesOnly || opts.notesOnly.has(s.id));
  return `  ${STATUS_MARK[s.status]} ${s.id} ${s.title}${deps}${policy}${tries}${showNote ? `  — ${s.note}` : ''}`;
}

export function renderPlan(plan: Plan, opts?: RenderPlanOptions): string {
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const lines = [
    `Plan ${plan.id} — ${plan.title}  (${done}/${plan.steps.length} 完成, 状态 ${plan.status})`,
  ];
  if (plan.sessionId) lines.push(`来自会话: ${plan.sessionId}`);
  if (plan.goal) lines.push(`目标: ${plan.goal}`);
  for (const s of plan.steps) lines.push(stepLine(s, opts));

  /*
   * Where to continue, spelled out.
   *
   * This is what makes the plan usable as a checkpoint: after a restart, or in a new
   * conversation, the agent's first read of the plan answers "what now?" without it having to
   * re-derive that from five status marks. When the answer is "nowhere", it says which step is
   * in the way and what the plan said to do about it, so a stalled plan does not read as a
   * finished one.
   */
  lines.push(nextLine(plan));
  return lines.join('\n');
}

/** The "下一步:" line. Shared by the full render and the compact update reply so they cannot disagree. */
function nextLine(plan: Plan): string {
  const next = nextStepOf(plan);
  return next
    ? `下一步: ${next.step.id} ${next.step.title}（${next.why}）`
    : plan.status === 'done' ? '下一步: 无，计划已收口' : '下一步: 无（没有可开始的步骤）';
}

/** How much of a note the compact `plan_update` reply echoes: the caller just wrote it, and the full text is on disk. */
const UPDATE_NOTE_CHARS = 60;

function shortNote(note: string): string {
  const one = note.replace(/\s+/g, ' ').trim();
  return one.length > UPDATE_NOTE_CHARS ? `${one.slice(0, UPDATE_NOTE_CHARS)}…` : one;
}

/**
 * "进度 x/y": done over the steps still in scope.
 *
 * A dropped step is not work left to do, so it leaves the denominator (otherwise a plan that
 * skipped a step could never read as complete), and it is named separately so the drop stays
 * visible.
 */
export function planProgress(plan: Plan): string {
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const dropped = plan.steps.filter((s) => s.status === 'dropped').length;
  const total = plan.steps.length - dropped;
  return `进度 ${done}/${total}${dropped ? `（另有 ${dropped} 步已放弃，不计入）` : ''}`;
}

/**
 * The reply to `plan_update`: only what this call changed, the progress, and where to continue.
 *
 * The steps listed are the ones the call moved, including its side effects (the next step
 * auto-activated, a previously active step sent back to pending, cascaded drops) — found by
 * comparing the plan before and after, see `notesToPrint`. Untouched steps are not repeated:
 * `plan_get` / `plan_list` print the whole plan with every note.
 */
export function renderPlanUpdate(before: Plan | undefined, after: Plan, touched: readonly string[] = []): string {
  const prev = new Map((before?.steps ?? []).map((s) => [s.id, s] as const));
  const moved = notesToPrint(before, after, touched) ?? new Set(touched);
  const lines = [`已更新 ${after.id}「${after.title}」${after.status === 'open' ? '' : `（计划状态 ${after.status}）`}`];
  for (const s of after.steps) {
    if (!moved.has(s.id)) continue;
    const was = prev.get(s.id);
    const move = was && was.status !== s.status ? `${was.status} → ${s.status}` : s.status;
    const deps = s.dependsOn.length ? `  依赖: ${s.dependsOn.join('、')}` : '';
    const policy = s.onFailure !== 'stop' ? `  失败策略: ${s.onFailure}` : '';
    const tries = s.attempts > 0 ? `  已试 ${s.attempts} 次` : '';
    const note = s.note && s.note !== was?.note ? `  — ${shortNote(s.note)}` : '';
    lines.push(`  ${STATUS_MARK[s.status]} ${s.id} ${s.title}（${move}）${deps}${policy}${tries}${note}`);
  }
  lines.push(planProgress(after));
  lines.push(nextLine(after));
  lines.push('（只列了这次变动的步骤；完整计划和全部备注用 plan_get 查看）');
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
/**
 * `scope` 决定计划存在哪：聊天用工作区那一份（默认），讨论群传自己的 `cluster:<roomId>`。
 *
 * 默认值是工作区，因为那是**唯一**用户可见的粒度 —— 群是另一个聚合，它需要自己的作用域这件事由
 * `createGroupPlanTools` 显式说出来，而不是让每个调用点自己记得传。
 */
export function createPlanTools(
  workspaceRoot: string,
  sessionId: string,
  scope: string = WORKSPACE_SCOPE,
): KBToolSetLike & { store: PlanStore } {
  /*
   * 计划对聊天来说是**工作区级**的：一个项目一份 `.she/plans.json`，项目里每条会话都读写同一份 —— 于是
   * "昨天那个长任务"在新开一个对话之后还在，接着做就是了。会话 id 只作为**来源**写进计划
   * （`plan.sessionId`），不再决定文件在哪：用户脑子里的边界是项目，不是某一条对话。
   *
   * 会话 id 依然是**必需**参数（不是可选）：它现在是来源标记，可选就会让"忘了传"变成一条查不出出处的
   * 计划。工具层也依然没有"指定别的会话/别的工作区"这个入口 —— 能看见的就是本作用域的那一份。
   */
  const plans = new PlanStore(workspaceRoot, scope, sessionId);
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
        + 'You may also pass `depends_on` / `on_failure` to declare or correct them. Always update the plan as you make progress. '
        /*
         * States the reply's shape, because a caller that does not expect it reads a missing note
         * as a lost note. The notes really are still there — one sentence here is cheaper than
         * printing every one of them back on each of a dozen updates.
         */
        + 'The reply is compact: only the step(s) this call moved (new status, plus a short note if one was set), overall progress and the next runnable step. It does NOT repeat the whole plan — call `plan_get` for every step with its full notes.',
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
      /*
       * Read the plan BEFORE writing, so the reply can name the steps this call moved — including
       * the ones it moved as a side effect (see `notesToPrint`). `get` re-reads from disk, so this
       * is a real snapshot and not a second reference to the object about to be mutated.
       */
      const before = plans.get(targetId);
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
      /*
       * Compact reply: what moved, the progress, where to continue. The whole plan used to be
       * re-sent on every update (a dozen times on a long task), which is pure repeat billing;
       * `plan_get` prints it in full when that is actually needed.
       */
      return renderPlanUpdate(before, result.plan, [stepId, ...result.dropped]);
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
      const before = plans.get(targetId);
      const plan = plans.addSteps(targetId, steps);
      if (!plan) return `Error: plan not found (plan_id=${targetId})`;
      return renderPlan(plan, { notesOnly: notesToPrint(before, plan) });
    },
  );

  reg(
    {
      name: 'plan_list',
      description: 'List the current plan in full, plus one line naming the other open plans; pass `all: true` to print every plan.',
      parameters: {
        type: 'object',
        properties: {
          all: { type: 'boolean', description: 'Print every plan in this workspace in full (optional; default false).' },
        },
      },
    },
    async (a) => {
      const all = plans.list();
      if (!all.length) return 'No plans yet.';
      // `all: true` prints every plan in full, the old default (the notes are printed in full either way).
      if (a?.all === true || a?.all === 'true') return all.map((p) => renderPlan(p)).join('\n\n');
      /*
       * Default: only the CURRENT plan — the open one, or the most recently touched when none is open
       * — plus one line about the rest. A tool result is re-sent on every later request of the
       * session, and a workspace accumulates finished plans; printing all of them in full at the start
       * of every piece of work was paying for history nobody asked about.
       *
       * The one line still NAMES every other open plan: the prompt's rule is that a plan left open by
       * another chat must not be silently ignored, and a count alone would hide which one it is.
       */
      const current = plans.active() ?? all[0];
      const others = all.filter((p) => p.id !== current.id);
      if (!others.length) return renderPlan(current);
      const open = others.filter((p) => p.status === 'open');
      const openNames = open.map((p) => `${p.id}「${p.title}」${planProgress(p).replace(/^进度 /, '')}`).join('、');
      return `${renderPlan(current)}\n\n`
        + `（另有 ${others.length} 个计划没有展开：${open.length ? `${open.length} 个仍在进行 ${openNames}，` : ''}`
        + `${others.length - open.length} 个已收口。plan_list all=true 列出全部，plan_get plan_id=… 看其中一个。）`;
    },
  );

  reg(
    {
      name: 'plan_get',
      description:
        'Print ONE plan in full: every step, its status, dependencies and full notes, plus the next step. '
        + '`plan_update` only replies with what changed, so use this when you need the whole picture. '
        + 'plan_id is optional and defaults to the active plan. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'Plan id (optional; defaults to the active plan)' },
        },
      },
    },
    async (a) => {
      const targetId = String(a.plan_id ?? '') || plans.active()?.id || '';
      if (!targetId) return 'No plans yet.';
      const plan = plans.get(targetId);
      if (!plan) return `Error: plan not found (plan_id=${targetId})`;
      return renderPlan(plan);
    },
  );

  reg(
    {
      name: 'report_write',
      description:
        'Write a markdown artifact into the workspace (.she/reports/). '
        + 'kind="report" (default) for an analysis document or comparison. '
        + 'kind="delivery" when you are handing back finished WORK: it uses the delivery template '
        + '(conclusion / evidence / assumptions / risks / open questions), and the status you claim '
        + 'is checked against the plan, so a delivery cannot report "done" over unfinished or '
        + 'unconfirmed work.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '"report" (default) or "delivery"' },
          title: { type: 'string', description: 'Report title' },
          summary: { type: 'string', description: 'Executive summary (a few lines)' },
          sections: {
            type: 'array',
            description: 'Report sections / the detailed steps behind a delivery (its appendix)',
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
          mode: {
            type: 'string',
            description: '"brief" (default) or "full". delivery only. full also requires assumptions and risks.',
          },
          status: {
            type: 'string',
            description:
              'delivery only, required: "done" | "partial" | "needs_confirmation" | "blocked". '
              + '"done" is refused while anything is unconfirmed or while this conversation\'s plan has unfinished steps.',
          },
          conclusion: { type: 'string', description: 'delivery only, required: what is now true / what the user should take away' },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'delivery only, required: what you actually observed — command output, file:line, test result. '
              + 'Each entry must be checkable; a line that only restates the conclusion ("done", "已完成") is refused.',
          },
          assumptions: { type: 'array', items: { type: 'string' }, description: 'delivery only: what you took as given' },
          risks: { type: 'array', items: { type: 'string' }, description: 'delivery only: what could still go wrong' },
          open: {
            type: 'array',
            items: { type: 'string' },
            description: 'delivery only: what is NOT verified or NOT done, each naming what would settle it',
          },
          acknowledge_sensitive: {
            type: 'boolean',
            description:
              'Set true only when the artifact genuinely has to contain something that looks like a '
              + 'credential (e.g. you are writing key-rotation documentation). Without it, a report '
              + 'containing a credential is refused instead of written.',
          },
        },
        required: ['title'],
      },
    },
    async (a) => {
      const title = String(a.title ?? 'Report').trim();
      const summary = a.summary ? String(a.summary) : '';
      const sections = Array.isArray(a.sections) ? (a.sections as { heading: string; body: string }[]) : [];
      const kind = String(a.kind ?? 'report');
      if (kind !== 'report' && kind !== 'delivery') {
        return `Error: kind 必须是 report 或 delivery，收到 "${kind}"`;
      }
      const mode = String(a.mode ?? 'brief');
      if (kind === 'delivery' && mode !== 'brief' && mode !== 'full') {
        return `Error: mode 必须是 brief 或 full，收到 "${mode}"`;
      }
      const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);

      /* ── The delivery template ──
       *
       * The point of the five parts is that they are the ones that disagree. "Done" without
       * evidence is an assertion; a conclusion without its assumptions is a generality; and a
       * delivery that lists no open questions when there are some is the failure this exists to
       * prevent. Which is why the checks below are refusals rather than a template the model is
       * asked nicely to follow: a heading nobody fills in is worse than no heading, because the
       * document then LOOKS complete.
       */
      let delivery: {
        status: 'done' | 'partial' | 'needs_confirmation' | 'blocked';
        conclusion: string;
        evidence: string[];
        assumptions: string[];
        risks: string[];
        open: string[];
        /**
         * Unfinished steps, with the plan each came from.
         *
         * The plan title rides along because step ids repeat between plans and the artifact is
         * read later by someone who has to go and find the plan being named.
         */
        unmet: Array<{ plan: string; step: PlanStep }>;
      } | null = null;

      if (kind === 'delivery') {
        const status = String(a.status ?? '').trim();
        const statuses = ['done', 'partial', 'needs_confirmation', 'blocked'];
        if (!statuses.includes(status)) {
          return `Error: kind=delivery 必须给出 status，且必须是 ${statuses.join(' / ')} 之一`
            + `${status ? `，收到 "${status}"` : '（漏了 status）'}`;
        }
        const conclusion = String(a.conclusion ?? '').trim();
        if (!conclusion) {
          return 'Error: kind=delivery 必须给出 conclusion（结论）——只罗列过程不叫交付';
        }
        if (a.evidence === undefined) {
          return 'Error: kind=delivery 必须给出 evidence（证据），至少一条：命令输出、file:line、测试结果';
        }
        const evidence = strList(a.evidence);
        if (!evidence.length) {
          return 'Error: kind=delivery 必须给出 evidence（证据），至少一条——没有证据的结论是断言';
        }
        /*
         * Non-empty is not the same as substantive (第四轮 7a). Without this, `["done"]` satisfied
         * every rule and the one section whose whole job is to make the conclusion falsifiable
         * could be filled with the conclusion. Naming the offending line is the point: the model
         * has to know which of five entries was the assertion.
         */
        const asserted = evidence.filter((e) => !looksLikeEvidence(e));
        if (asserted.length) {
          return `Error: evidence 里有 ${asserted.length} 条只是把结论又说了一遍，读者无法核对（"${asserted[0].slice(0, 60)}"）——`
            + '证据要能被查：命令与退出码、file:line、测试结果或真实输出片段';
        }
        if (mode === 'full' && (a.assumptions === undefined || a.risks === undefined)) {
          return 'Error: mode=full 必须给出 assumptions 和 risks（空数组也行——那说明你想过，没有就是没有）';
        }
        const assumptions = strList(a.assumptions);
        const risks = strList(a.risks);
        const open = strList(a.open);

        if (status === 'done' && open.length) {
          return `Error: 状态不合法：status=done 但还有 ${open.length} 项待确认（${open[0].slice(0, 60)}）——`
            + '先确认掉，或者把 status 改成 needs_confirmation';
        }
        if (status === 'needs_confirmation' && !open.length) {
          return 'Error: 状态不合法：status=needs_confirmation 但没有待确认的项，那这次交付就是 done';
        }

        /*
         * The plan is the workspace's own record of what has been finished, so this is the one
         * place where "is it really done?" has an answer that does not come from the model.
         *
         * Computed for every status, not just `done`: a partial delivery has to carry the list
         * of what is left, or the reader has to go and look it up.
         *
         * Scoped to the WORKSPACE, which means a plan left open by another conversation in this
         * project blocks today's `done` too. That is deliberate and it is the price of one plan
         * per project: "leftover" is now a thing the next conversation can see, resume, or close
         * properly, instead of a private note that expires when its chat scrolls away. The refusal
         * names the steps, and closing them honestly (done, or dropped with a reason) is the
         * intended way past it — marking them done to unlock the word "done" is what this checks.
         *
         * EVERY open plan, not just the newest: `plan_create` does not stop a second plan existing
         * in the same workspace, and reading only the active one made this section true about one
         * plan while silent about the rest. The plan title is carried along because step ids
         * (`s1`, `s2`) repeat between plans and an id alone would not say which plan to go close.
         */
        const unfinished = plans.openPlans().flatMap((p) => p.steps
          .filter((s) => s.status !== 'done' && s.status !== 'dropped')
          .map((step) => ({ plan: p.title, step })));
        if (status === 'done' && unfinished.length) {
          return `Error: status=done 但本工作区的计划还没有做完：`
            + `${unfinished.map((u) => `${u.plan} ${u.step.id} ${u.step.title}（${u.step.status}）`).join('、')}——`
            + '要么把这些步骤做完或明确标成 dropped，要么这次交付写成 partial 并把它们放进 open';
        }

        delivery = {
          status: status as 'done' | 'partial' | 'needs_confirmation' | 'blocked',
          conclusion,
          evidence,
          assumptions,
          risks,
          open,
          unmet: unfinished,
        };
      }

      const stem = String(a.filename ?? title)
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'report';

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const dir = join(workspaceRoot, '.she', 'reports');
      const suffix = kind === 'delivery' ? `delivery-${delivery!.status}` : 'report';
      const file = join(dir, `${stem}-${suffix}-${stamp}.md`);

      const parts: string[] = [
        `# ${title}`,
        '',
        `生成时间: ${new Date().toISOString()}`,
      ];
      if (delivery) {
        parts.push(`交付状态: ${STATUS_LABEL[delivery.status]}（${delivery.status}）  ·  ${mode === 'full' ? '详版' : '简版'}`);
      }
      if (summary) parts.push('', `## 摘要`, '', summary);

      if (delivery) {
        parts.push('', '## 结论', '', delivery.conclusion);
        parts.push('', '## 证据', '', ...listLines(delivery.evidence, '（无——没有证据的结论只能是假设）'));
        /*
         * Full mode prints every heading even when the list is empty: `（无）` is a real answer
         * and its absence is ambiguous. Brief mode prints only what is there, which is the whole
         * difference between the two versions.
         */
        if (mode === 'full' || delivery.assumptions.length) {
          parts.push('', '## 假设', '', ...listLines(delivery.assumptions, '（无）'));
        }
        if (mode === 'full' || delivery.risks.length) {
          parts.push('', '## 风险', '', ...listLines(delivery.risks, '（无）'));
        }
        parts.push('', '## 待确认', '', ...listLines(delivery.open, '（无——本次交付没有未验证的部分）'));
        if (delivery.unmet.length) {
          parts.push('', '### 计划里还没做完的步骤（交付时点）', '',
            ...delivery.unmet.map((u) => `- ${u.plan} · ${u.step.id} ${u.step.title} [${u.step.status}]`));
        }
      }

      for (const s of sections) {
        parts.push(`## ${s.heading}\n\n${s.body ?? ''}\n`);
      }
      const body = parts.filter(Boolean).join('\n');

      /*
       * The outbound guardrail, applied to the artifact rather than to the answer.
       *
       * This file is the one thing here that is written to be handed to someone else: it is read by
       * people who were not in this conversation, attached to tickets, and archived. A credential in
       * it is a leak that outlives the turn — and unlike the answer, it can be fixed in place,
       * because the agent still has the context that produced it.
       *
       * So this is the blocking half of the guardrail, and it refuses rather than warns. The
       * override is explicit, and it is the same stance the stylesheet guard takes: a deliberate
       * choice is recorded, not policed. `acknowledge_sensitive` is deliberately verbose for a flag
       * and deliberately has no short alias — it should not be reachable by accident.
       *
       * `scanOutbound` is imported lazily through the module scope above; the scan is cheap and
       * deterministic, so there is no reason to make it conditional on the tool being used.
       *
       * The directory is created below, AFTER this check, and not here. A refusal has to leave the
       * workspace exactly as it found it: creating `.she/reports/` on the way to saying no means a
       * caller that retries with the secret removed (or a test that asserts nothing was written)
       * cannot tell "refused" from "wrote an empty report".
       */
      if (a.acknowledge_sensitive !== true) {
        const findings = scanOutbound(body);
        const high = highFindings(findings);
        if (high.length) return renderGuardrailRefusal(findings);
      }

      mkdirSync(dir, { recursive: true });
      writeFileSync(file, body, 'utf8');

      const rel = file.replace(resolve(workspaceRoot) + '\\', '').replace(/\\/g, '/');
      if (delivery) {
        return `Delivery written: ${rel}\n`
          + `status=${delivery.status} mode=${mode} 证据 ${delivery.evidence.length} 条，待确认 ${delivery.open.length} 项，`
          + `未完成的计划步骤 ${delivery.unmet.length} 个`;
      }
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

// ─── Plan autopilot ─────────────────────────────────────────────────────────

export interface AutopilotDecision {
  /** True when the turn should keep going instead of handing control back to the user. */
  proceed: boolean;
  /** The message that resumes the work, when `proceed`. */
  nudge?: string;
  /** Step statuses, so the caller can tell a round that moved the plan from one that did not. */
  signature: string;
  /** Why it stopped, for the status line. */
  reason?: string;
}

/**
 * Should a turn that just ended keep working its plan?
 *
 * The loop ends whenever the model answers without a tool call, and in practice a model does that
 * halfway through a plan to report progress ("第 3 步完成，接下来做第 4 步"). With nobody there to say
 * "继续", automation stops at every step, which is what made it turn-based rather than autonomous.
 * This decides, deterministically, when that stop is premature.
 *
 * It only ever continues THIS conversation's plan, and only one the current turn has touched: an
 * old open plan is not a standing order (see the system prompt), so it never restarts work on its
 * own. It stops, handing back to the user, when:
 *   - no step can run (everything done, or the rest waits on something unfinished);
 *   - a step is blocked with `on_failure` `ask` or `stop`, which by declaration needs a person;
 *   - the reply ends in a question, i.e. the model is asking the user something.
 */
export function planAutopilot(
  plan: Plan | undefined,
  opts: { turnStartedAt: number; reply: string },
): AutopilotDecision {
  const signature = plan ? plan.steps.map((s) => `${s.id}:${s.status}`).join(',') : '';
  if (!plan || plan.status !== 'open') return { proceed: false, signature, reason: '没有进行中的计划' };
  if (Date.parse(plan.updatedAt) < opts.turnStartedAt) {
    return { proceed: false, signature, reason: '计划不是这一轮在推进的' };
  }
  const parked = plan.steps.find((s) => s.status === 'blocked' && (s.onFailure === 'ask' || s.onFailure === 'stop'));
  if (parked) return { proceed: false, signature, reason: `步骤「${parked.title}」卡住了，需要你来定` };
  const done = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
  const runnable = plan.steps.filter(
    (s) => s.status === 'active' || (s.status === 'pending' && s.dependsOn.every((d) => done.has(d))),
  );
  if (!runnable.length) return { proceed: false, signature, reason: '没有可以继续的步骤' };
  if (/[?？]\s*$/.test(String(opts.reply ?? '').trim())) {
    return { proceed: false, signature, reason: '在等你回答问题' };
  }
  const left = plan.steps.filter((s) => s.status === 'pending' || s.status === 'active').length;
  const next = runnable.find((s) => s.status === 'active') ?? runnable[0]!;
  return {
    proceed: true,
    signature,
    nudge: `[自动续跑] 计划「${plan.title}」还有 ${left} 步没做完，下一步是「${next.title}」。`
      + '直接继续执行，不要停下来等我确认；每做完一步就 plan_update。'
      + '只有需要我提供只有我知道的信息、或要做不可逆的操作时，才停下来问我。',
  };
}

