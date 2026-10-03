/**
 * `skill_read` — the on-demand half of the project skills.
 *
 * The system prompt used to inline every skill of the active profile on every request. It now
 * carries an index (name, title, one-line purpose) and this tool returns one recipe in full when
 * the task calls for it.
 *
 * The definition is static — no skill names in it — so the tool table stays byte-identical across
 * workspaces (a different table is a cache miss for everything after it); the per-workspace part
 * lives in the prompt's index.
 */
import type { ToolDefinition } from '@she/shared';
import { listSkills, readSkill, readableSkillNames, type SkillProfile } from './system-prompt.js';

export const SKILL_READ_TOOL = 'skill_read';

export function createSkillTools(
  workspaceRoot: string,
  profile: SkillProfile,
  opts?: {
    /** A delegated child: steps through tools it does not have are removed, as in its prompt. */
    subagent?: boolean;
  },
): {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
} {
  const subagent = opts?.subagent === true;
  // Nothing to read means nothing to advertise: a tool that can only answer "no skills" wastes a slot.
  if (listSkills(workspaceRoot, profile).length === 0) {
    return { definitions: [], execute: async (name) => `Error: unknown tool ${name}` };
  }

  const definition: ToolDefinition = {
    name: SKILL_READ_TOOL,
    description:
      'Load the full text of one project skill (an operator recipe) by name. The system prompt lists the '
      + 'available skills under "Project Skills", each with a one-line purpose; when the task fits one, read it '
      + 'with this before following it. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name exactly as listed in the Project Skills index (the file name without .md).',
        },
      },
      required: ['name'],
    },
  };

  return {
    definitions: [definition],
    execute: async (name, args) => {
      if (name !== SKILL_READ_TOOL) return `Error: unknown tool ${name}`;
      const wanted = typeof args.name === 'string' ? args.name.trim() : '';
      const hit = readSkill(workspaceRoot, profile, wanted, { subagent });
      if (hit) return `# 技能 ${hit.entry.name}（${hit.entry.source}）\n\n${hit.text}`;
      const names = readableSkillNames(workspaceRoot, profile, { subagent });
      const list = names.length ? names.join(', ') : '（无）';
      return wanted
        ? `Error: 没有名为「${wanted}」的技能。可用：${list}`
        : `Error: skill_read 需要 name（技能索引里列出的名字）。可用：${list}`;
    },
  };
}
