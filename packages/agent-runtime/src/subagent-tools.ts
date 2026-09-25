import type { ToolDefinition } from '@she/shared';

/**
 * Subagent delegation.
 *
 * The parent agent can hand a self-contained subtask to a child that runs with
 * its OWN context and reports back a summary. The point is context hygiene:
 * exploring 30 files to answer one question would otherwise fill the parent's
 * transcript with material it never needs again.
 *
 * This module owns the TOOL only. Constructing a child agent is the caller's
 * business (`SubagentRunner`), which keeps agent-runtime free of any dependency
 * on how agents are built or where their tools come from.
 */

export interface SubagentRequest {
  /** Short label, shown in progress output. */
  description: string;
  /** Self-contained instructions. The child cannot see the parent's history. */
  prompt: string;
  /**
   * Return as soon as the child has a session, and let it keep running.
   * The parent is not blocked, and the child transcript stays on that session.
   */
  background?: boolean;
  /**
   * Whether to run the child in its own git worktree.
   *
   *   - `'worktree'`: always, when the workspace is a git repository.
   *   - `'none'`: never — the child shares the parent's checkout.
   *   - `'auto'` (default): only when the task DECLARES a writable `scope`.
   *
   * The `auto` rule is deliberately narrow. A child that only reads is the common case, and
   * isolating it would be actively worse: a worktree starts from `HEAD`, so a child asked to
   * review "my current changes" would be looking at the last commit instead of the dirty tree.
   * A child that declares it will write, on the other hand, races the parent and any sibling on
   * exactly the files it names — that is the case where a private tree pays for itself.
   */
  isolation?: 'auto' | 'worktree' | 'none';
  /** Structured job description; see `SubagentHandoff`. */
  handoff?: SubagentHandoff;
}

/**
 * What the child owes the parent, stated as fields rather than prose.
 *
 * A prompt alone makes the parent's request and the child's report both free text, so the parent
 * has to re-read a summary to work out whether the child stayed in scope, and a child that
 * wandered has no way to know it did. These four fields are the ones the parent always knows and
 * the child always needs, and putting them in the request means they can be repeated back
 * verbatim in the result instead of being inferred.
 */
export interface SubagentHandoff {
  /** The artifact the child must produce: a report, a fix, a file. One sentence. */
  deliverable?: string;
  /** Paths the child may modify. Anything outside is out of scope and must not be touched. */
  scope?: string[];
  /** Hard rules: "read-only", "no new dependencies", "do not touch package.json". */
  constraints?: string[];
  /** Facts already established, so the child does not spend its budget re-deriving them. */
  context?: string[];
}

/**
 * Where a child actually ran, and what it left behind.
 *
 * Returned for an isolated child so the parent can see the work exists and where it lives. The
 * changed paths are the point: the parent's transcript never contains the child's editing, so
 * without this list a successful isolated subtask looks identical to one that did nothing.
 */
export interface SubagentWorktree {
  path: string;
  branch: string;
  /** Repo-relative paths the child touched, from `git status --porcelain`. */
  changed: string[];
  /** Why isolation did not happen, when it was asked for and not granted. */
  note?: string;
}

export interface SubagentResult {
  description: string;
  ok: boolean;
  /** The child's final message, or an error description. */
  result: string;
  /** Echoed back so the parent can check scope without re-reading the prompt it wrote. */
  handoff?: SubagentHandoff;
  worktree?: SubagentWorktree;
  /**
   * Whether the isolation this task asked for was actually granted.
   *
   * Separate from `worktree` because the interesting case is the one with NO worktree: a parent that
   * declared a writable scope believes the child is editing a private copy, and if the worktree
   * could not be created — no git repository, git missing, the branch taken — it is editing the
   * shared checkout instead. Staying silent there is the worst outcome available, so the answer is
   * a required field rather than a note attached to the success story.
   */
  isolation?: {
    requested: boolean;
    applied: boolean;
    /** Why it was not applied. Absent when it was, or when nothing was asked for. */
    note?: string;
  };
}

/**
 * Whether this task should get a private tree.
 *
 * Exported because it is a decision with a rule, and a rule that only exists inside a closure is
 * a rule nobody can test.
 */
export function shouldIsolate(
  req: Pick<SubagentRequest, 'isolation' | 'handoff'>,
  isGitRepo: boolean,
): boolean {
  if (!isGitRepo) return false;
  if (req.isolation === 'none') return false;
  if (req.isolation === 'worktree') return true;
  return (req.handoff?.scope?.length ?? 0) > 0;
}

export interface ComposeOptions {
  /** Absolute directory the child will work in — its worktree when isolated. */
  workdir: string;
  /** True when `workdir` is a private copy the parent will not see changes in automatically. */
  isolated: boolean;
}

/**
 * Build the child's prompt: the handoff document, then the parent's own instructions.
 *
 * The block comes first on purpose. A child reads its instructions in order, and the one thing it
 * must not miss — that its changes land in a copy, not in the project — is worthless at the end of
 * a long prompt.
 */
export function composeHandoffPrompt(req: SubagentRequest, opts: ComposeOptions): string {
  const h = req.handoff ?? {};
  const lines: string[] = ['## 交接单', ''];
  lines.push(`- 交付物：${h.deliverable?.trim() || req.description}`);
  lines.push(`- 工作目录：${opts.workdir}`);
  const scope = (h.scope ?? []).map((s) => s.trim()).filter(Boolean);
  lines.push(
    scope.length
      ? `- 允许改动：${scope.join('、')}（这个范围之外的文件不要动；需要动就先说明再停手）`
      : '- 允许改动：无 —— 这是只读任务，不要修改、创建或删除任何文件',
  );
  const constraints = (h.constraints ?? []).map((s) => s.trim()).filter(Boolean);
  if (constraints.length) {
    lines.push('- 约束：');
    for (const c of constraints) lines.push(`  - ${c}`);
  }
  const context = (h.context ?? []).map((s) => s.trim()).filter(Boolean);
  if (context.length) {
    lines.push('- 已知情况（父智能体已确认，不必重新验证）：');
    for (const c of context) lines.push(`  - ${c}`);
  }
  if (opts.isolated) {
    lines.push(
      '- 你在一个隔离副本里工作：你的改动不会自动进入主工作区。'
      + '正常完成即可，父智能体会按上面列出的路径取用结果 —— 不要尝试自己合并、提交或推送。',
    );
  }
  lines.push('', '## 任务', '', req.prompt.trim());
  return lines.join('\n');
}

export interface SubagentRunner {
  /**
   * Run one subtask to completion in isolation.
   *
   * Must NOT give the child the ability to delegate further — recursion here is
   * unbounded, and each level re-sends a full system prompt, so the cost grows
   * multiplicatively. Implementations are responsible for that guard.
   */
  run(req: SubagentRequest, signal?: AbortSignal): Promise<SubagentResult>;
}

export interface SubagentToolOptions {
  /** Called as each subtask starts/finishes, so the UI can show progress. */
  onProgress?: (event: { phase: 'start' | 'done'; description: string; ok?: boolean }) => void;
}

export interface SubagentToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export function createSubagentTools(runner: SubagentRunner, opts?: SubagentToolOptions): SubagentToolSet {
  const definition: ToolDefinition = {
    name: 'task_spawn',
    description: [
      'Delegate self-contained subtasks to isolated child agents.',
      'Each child gets its OWN context (it cannot see this conversation) and returns only a summary.',
      'Use when a subtask is explorative or verbose — searching many files, gathering evidence —',
      'and you do not want the raw material in this transcript.',
      '',
      'The child cannot ask the user questions and cannot delegate further, so give it everything it needs.',
      'Fill in `deliverable` / `scope` / `constraints` rather than writing all of it into `prompt`:',
      'they are handed to the child as a structured brief and echoed back, so you can check afterwards',
      'whether it stayed in scope without re-reading what you asked for.',
      'Declare `scope` when the child is expected to EDIT files — that is what puts it in a private',
      'git worktree, so it cannot race you or its siblings on the same paths. A read-only child runs',
      'in this checkout and sees your uncommitted work.',
      'Prefer 1-2 focused subtasks over many; each one re-sends the full system prompt and costs accordingly.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Subtasks to run. Every item in the list runs; none are dropped for length.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Short label (3-6 words).' },
              prompt: {
                type: 'string',
                description:
                  'Complete, self-contained instructions. Include the goal, what to inspect, ' +
                  'and exactly what to report back. The child has no access to this conversation.',
              },
              background: {
                type: 'boolean',
                description:
                  'True: start the child and return immediately. It keeps running as its own session ' +
                  '(listed under this conversation) instead of blocking this turn.',
              },
              deliverable: {
                type: 'string',
                description:
                  'One sentence naming what the child must produce — "a report listing every caller of X", ' +
                  '"a fix for the failing test in Y". Becomes the first line of its brief.',
              },
              scope: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Repo-relative paths the child may MODIFY. Listing any path gives it a private git ' +
                  'worktree. Omit for a read-only child.',
              },
              constraints: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Hard rules it must not break — "read-only", "no new dependencies", "do not touch package.json".',
              },
              context: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Facts you already established, so the child does not spend its budget re-deriving them.',
              },
              isolation: {
                type: 'string',
                enum: ['auto', 'worktree', 'none'],
                description:
                  "auto (default): a private worktree when `scope` is given, otherwise this checkout. " +
                  "worktree: force isolation. none: force sharing this checkout.",
              },
            },
            required: ['description', 'prompt'],
          },
        },
      },
      required: ['tasks'],
    },
  };

  const execute = async (_name: string, args: Record<string, unknown>): Promise<string> => {
    const raw = Array.isArray(args.tasks) ? args.tasks : [];
    const strList = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v.map((x) => String(x ?? '').trim()).filter(Boolean);
      return out.length ? out : undefined;
    };
    const tasks: SubagentRequest[] = raw
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const handoff: SubagentHandoff = {
          deliverable: String(o.deliverable ?? '').trim() || undefined,
          scope: strList(o.scope),
          constraints: strList(o.constraints),
          context: strList(o.context),
        };
        const isolation: SubagentRequest['isolation'] =
          o.isolation === 'worktree' || o.isolation === 'none' ? o.isolation : 'auto';
        return {
          description: String(o.description ?? '').trim() || '(未命名子任务)',
          prompt: String(o.prompt ?? '').trim(),
          background: o.background === true,
          isolation,
          handoff: Object.values(handoff).some(Boolean) ? handoff : undefined,
        };
      })
      .filter((t) => t.prompt);

    if (tasks.length === 0) return 'Error: no usable tasks (each needs a non-empty prompt)';

    /*
     * A task that edits files must say what it is producing.
     *
     * Refused here rather than sent on to the runner: the child would receive a worktree and an
     * open-ended "change whatever you like", which is the one shape of delegation that produces
     * work nobody can check. The parent gets a message telling it exactly what to add.
     */
    for (const t of tasks) {
      const writes = t.isolation === 'worktree' || (t.handoff?.scope?.length ?? 0) > 0;
      if (writes && !t.handoff?.deliverable) {
        return `Error: 子任务「${t.description}」会改动文件，但没有说明交付物（deliverable）。`
          + '补上它要产出什么（例如"修复 X 的失败测试"或"在 Y 里加 Z"），或者把 scope 去掉改成只读任务。';
      }
    }

    // Run concurrently: independent subtasks are exactly the case where waiting
    // in sequence wastes wall-clock time.
    const results = await Promise.all(
      tasks.map(async (t) => {
        opts?.onProgress?.({ phase: 'start', description: t.description });
        try {
          const r = await runner.run(t);
          opts?.onProgress?.({ phase: 'done', description: t.description, ok: r.ok });
          return r;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts?.onProgress?.({ phase: 'done', description: t.description, ok: false });
          return { description: t.description, ok: false, result: `子任务异常: ${msg}`, handoff: t.handoff };
        }
      }),
    );

    const lines: string[] = [`完成 ${results.length} 个子任务`, ''];
    for (const r of results) {
      lines.push(`### [${r.ok ? '完成' : '失败'}] ${r.description}`);
      const h = r.handoff;
      if (h?.deliverable) lines.push(`- 交付物：${h.deliverable}`);
      if (h?.scope?.length) lines.push(`- 允许改动：${h.scope.join('、')}`);
      if (h?.constraints?.length) lines.push(`- 约束：${h.constraints.join('；')}`);
      if (r.worktree) {
        lines.push(
          `- 隔离副本：${r.worktree.path}（分支 ${r.worktree.branch}）`,
        );
        lines.push(
          r.worktree.changed.length
            ? `- 改动的文件：${r.worktree.changed.join('、')}`
            : '- 改动的文件：无（副本与 HEAD 一致，也没有未提交改动）',
        );
        if (r.worktree.note) lines.push(`- 说明：${r.worktree.note}`);
      } else if (r.isolation?.note) {
        // No worktree and a note: the parent declared writable files, so the runtime was supposed to
        // put the child in a copy, and could not. Stated as its own line rather than appended to a
        // success block, because the parent has to change what it does next — its scope declaration
        // did not buy the guarantee it asked for.
        lines.push(`- ⚠ 未隔离：${r.isolation.note}`);
      }
      lines.push('');
      lines.push(r.result.trim());
      lines.push('');
    }
    lines.push(
      '以上是子智能体返回的摘要。原始过程没有进入本对话；如需细节请再指派。'
      + '若有隔离副本，它的改动还在副本里，需要时按上面的路径取用。',
    );
    return lines.join('\n');
  };

  return { definitions: [definition], execute };
}
