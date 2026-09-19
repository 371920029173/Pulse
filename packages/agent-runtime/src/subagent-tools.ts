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
}

export interface SubagentResult {
  description: string;
  ok: boolean;
  /** The child's final message, or an error description. */
  result: string;
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
  /**
   * Hard cap on subtasks per call.
   *
   * Each child re-sends the entire system prompt, so a large fan-out is
   * expensive in a way that is invisible from the tool call itself.
   */
  maxPerCall?: number;
  /** Called as each subtask starts/finishes, so the UI can show progress. */
  onProgress?: (event: { phase: 'start' | 'done'; description: string; ok?: boolean }) => void;
}

export interface SubagentToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export function createSubagentTools(runner: SubagentRunner, opts?: SubagentToolOptions): SubagentToolSet {
  const maxPerCall = opts?.maxPerCall ?? 4;

  const definition: ToolDefinition = {
    name: 'task_spawn',
    description: [
      'Delegate self-contained subtasks to isolated child agents.',
      'Each child gets its OWN context (it cannot see this conversation) and returns only a summary.',
      'Use when a subtask is explorative or verbose — searching many files, gathering evidence —',
      'and you do not want the raw material in this transcript.',
      '',
      'The child cannot ask the user questions and cannot delegate further, so give it everything it needs.',
      'Prefer 1-2 focused subtasks over many; each one re-sends the full system prompt and costs accordingly.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: `Subtasks to run. At most ${maxPerCall} per call.`,
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
    const tasks: SubagentRequest[] = raw
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return {
          description: String(o.description ?? '').trim() || '(未命名子任务)',
          prompt: String(o.prompt ?? '').trim(),
        };
      })
      .filter((t) => t.prompt);

    if (tasks.length === 0) return 'Error: no usable tasks (each needs a non-empty prompt)';

    const capped = tasks.slice(0, maxPerCall);
    const note = tasks.length > capped.length
      ? `\n(注意：一次最多 ${maxPerCall} 个，已忽略其余 ${tasks.length - capped.length} 个)`
      : '';

    // Run concurrently: independent subtasks are exactly the case where waiting
    // in sequence wastes wall-clock time.
    const results = await Promise.all(
      capped.map(async (t) => {
        opts?.onProgress?.({ phase: 'start', description: t.description });
        try {
          const r = await runner.run(t);
          opts?.onProgress?.({ phase: 'done', description: t.description, ok: r.ok });
          return r;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts?.onProgress?.({ phase: 'done', description: t.description, ok: false });
          return { description: t.description, ok: false, result: `子任务异常: ${msg}` };
        }
      }),
    );

    const lines: string[] = [`完成 ${results.length} 个子任务${note}`, ''];
    for (const r of results) {
      lines.push(`### [${r.ok ? '完成' : '失败'}] ${r.description}`);
      // Cap the summary so a verbose child cannot flood the parent's context —
      // that would defeat the purpose of delegating in the first place.
      const body = r.result.trim();
      lines.push(body.length > 4000 ? body.slice(0, 4000) + '\n…（已截断）' : body);
      lines.push('');
    }
    lines.push('以上是子智能体返回的摘要。原始过程没有进入本对话；如需细节请再指派。');
    return lines.join('\n');
  };

  return { definitions: [definition], execute };
}
