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

export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  /** Why this step matters / how to verify it. Keeps steps from being vague. */
  detail?: string;
  note?: string;
  updatedAt: string;
}

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

/**
 * Persistent multi-step plan store.
 *
 * Long-horizon engineering work needs an explicit, durable plan that survives
 * across turns — otherwise each turn re-derives intent from a shrinking context
 * window and drifts. This keeps the plan on disk next to the workspace.
 */
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
      return Array.isArray(parsed) ? parsed : [];
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

  create(title: string, steps: string[], goal?: string): Plan {
    const plans = this.load();
    const now = new Date().toISOString();
    const plan: Plan = {
      id: `plan_${randomUUID().slice(0, 8)}`,
      title: title.trim() || '未命名计划',
      goal: goal?.trim() || undefined,
      status: 'open',
      steps: steps
        .map((s) => String(s ?? '').trim())
        .filter(Boolean)
        .map((s, i) => ({
          id: `s${i + 1}`,
          title: s,
          status: (i === 0 ? 'active' : 'pending') as StepStatus,
          updatedAt: now,
        })),
      sessionId: this.sessionId ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    plans.push(plan);
    this.save(plans);
    return plan;
  }

  updateStep(
    planId: string,
    stepId: string,
    status: StepStatus,
    note?: string,
  ): Plan | undefined {
    const plans = this.load();
    const plan = this.find(plans, planId);
    if (!plan) return undefined;
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return undefined;

    step.status = status;
    if (note !== undefined) step.note = note;
    step.updatedAt = new Date().toISOString();
    plan.updatedAt = step.updatedAt;

    // Auto-advance: mark the next pending step active when one completes.
    if (status === 'done') {
      const next = plan.steps.find((s) => s.status === 'pending');
      if (next) next.status = 'active';
    }

    /*
     * Closure is checked for ANY transition, not just `done`.
     *
     * It used to live inside the `if (status === 'done')` block above, so
     * dropping the final step left the plan 'open' forever — and because
     * `active()` returns the newest open plan, an abandoned plan would keep
     * being handed back to the agent as its current work.
     */
    if (plan.steps.every((s) => s.status === 'done' || s.status === 'dropped')) {
      plan.status = 'done';
    }
    this.save(plans);
    return plan;
  }

  addSteps(planId: string, titles: string[]): Plan | undefined {
    const plans = this.load();
    const plan = this.find(plans, planId);
    if (!plan) return undefined;
    const now = new Date().toISOString();
    const base = plan.steps.length;
    titles
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      .forEach((t, i) => {
        plan.steps.push({
          id: `s${base + i + 1}`,
          title: t,
          status: (plan.steps.length === 0 && i === 0 ? 'active' : 'pending') as StepStatus,
          updatedAt: now,
        });
      });
    plan.updatedAt = now;
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
    lines.push(`  ${STATUS_MARK[s.status]} ${s.id} ${s.title}${s.note ? `  — ${s.note}` : ''}`);
  }
  return lines.join('\n');
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
        'Create a durable multi-step plan for long or multi-stage work. Use this BEFORE starting non-trivial tasks so progress survives context loss. Steps should be concrete and verifiable.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short plan title' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Ordered, concrete steps' },
          goal: { type: 'string', description: 'Optional one-line goal' },
        },
        required: ['title', 'steps'],
      },
    },
    async (a) => {
      const title = String(a.title ?? '').trim();
      const steps = Array.isArray(a.steps) ? (a.steps as string[]) : [];
      if (!title || !steps.length) return 'Error: title and at least one step are required';
      const plan = plans.create(title, steps, a.goal ? String(a.goal) : undefined);
      return `Created plan.\n${renderPlan(plan)}`;
    },
  );

  reg(
    {
      name: 'plan_update',
      description:
        'Update one step of a plan. Status: pending | active | done | blocked | dropped. Completing a step auto-activates the next one. Always update the plan as you make progress.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'Plan id (from plan_create / plan_list)' },
          step_id: { type: 'string', description: 'Step id, e.g. s1' },
          status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked', 'dropped'] },
          note: { type: 'string', description: 'Optional short note (blocker, finding, evidence)' },
        },
        required: ['plan_id', 'step_id', 'status'],
      },
    },
    async (a) => {
      const planId = String(a.plan_id ?? '');
      const stepId = String(a.step_id ?? '');
      const status = String(a.status ?? '') as StepStatus;
      if (!['pending', 'active', 'done', 'blocked', 'dropped'].includes(status)) {
        return 'Error: invalid status';
      }
      // Allow "active plan" shorthand.
      const targetId = planId || plans.active()?.id || '';
      const plan = plans.updateStep(targetId, stepId, status, a.note ? String(a.note) : undefined);
      if (!plan) return `Error: plan or step not found (plan_id=${planId}, step_id=${stepId})`;
      return renderPlan(plan);
    },
  );

  reg(
    {
      name: 'plan_add_steps',
      description: 'Append steps to an existing plan when you discover new work.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'Plan id (optional; defaults to the active plan)' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Steps to append' },
        },
        required: ['steps'],
      },
    },
    async (a) => {
      const steps = Array.isArray(a.steps) ? (a.steps as string[]) : [];
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
