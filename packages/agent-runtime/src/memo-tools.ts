import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@she/shared';

export interface MemoEntry {
  id: string;
  text: string;
  /** Who wrote it — distinguishes your notes from the agent's. */
  author: 'user' | 'agent';
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Shared scratchpad for the user and the agent(s).
 *
 * Deliberately tiny and file-backed: it is for ideas and TODOs that are not
 * worth a KB node, and it must be editable from both sides (UI + tools).
 */
export class MemoStore {
  private filePath: string;

  constructor(workspaceRoot: string) {
    const dir = join(workspaceRoot, '.she');
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'memo.json');
  }

  list(): MemoEntry[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const raw = readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as MemoEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(list: MemoEntry[]): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  add(text: string, author: MemoEntry['author'] = 'user'): MemoEntry {
    const now = new Date().toISOString();
    const entry: MemoEntry = {
      id: `m_${randomUUID().slice(0, 8)}`,
      text: String(text ?? '').trim(),
      author,
      done: false,
      createdAt: now,
      updatedAt: now,
    };
    const list = this.list();
    list.push(entry);
    this.save(list);
    return entry;
  }

  update(id: string, patch: { text?: string; done?: boolean }): MemoEntry | undefined {
    const list = this.list();
    const entry = list.find((m) => m.id === id || m.id.startsWith(id));
    if (!entry) return undefined;
    if (typeof patch.text === 'string') entry.text = patch.text.trim();
    if (typeof patch.done === 'boolean') entry.done = patch.done;
    entry.updatedAt = new Date().toISOString();
    this.save(list);
    return entry;
  }

  remove(id: string): boolean {
    const list = this.list();
    const next = list.filter((m) => m.id !== id && !m.id.startsWith(id));
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }
}

/** Tools so the agent can read and write the same scratchpad as the user. */
export function createMemoTools(workspaceRoot: string): {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
} {
  const store = new MemoStore(workspaceRoot);
  const toolMap = new Map<string, { def: ToolDefinition; fn: (a: Record<string, unknown>) => Promise<string> }>();
  const reg = (def: ToolDefinition, fn: (a: Record<string, unknown>) => Promise<string>) =>
    toolMap.set(def.name, { def, fn });

  reg(
    {
      name: 'memo_list',
      description:
        'Read the shared scratchpad (memo) that you and the user both edit. Check it when the user refers to "待办 / 备忘 / 灵感 / 之前记的" or when starting a long task.',
      parameters: {
        type: 'object',
        properties: {
          includeDone: { type: 'boolean', description: 'Include completed items (default false)' },
        },
      },
    },
    async (a) => {
      const list = store.list();
      const hidden = list.filter((m) => m.done).length;
      const shown = a.includeDone === true ? list : list.filter((m) => !m.done);
      /*
       * Never let "nothing to show" read as "nothing was ever written".
       *
       * With completed items filtered out, a scratchpad whose entries are all done answered
       * `备忘录为空。` — a false statement about the world, in the one voice the model trusts. An
       * agent told the memo is empty re-notes what it already noted, or reports that the user never
       * recorded anything. The count and the way to see them are stated instead.
       */
      if (!shown.length) {
        if (hidden) {
          return `备忘录里 ${hidden} 条都已标记完成（默认不列出）。要看就带 includeDone=true。`;
        }
        return '备忘录为空。';
      }
      const body = shown
        .map((m) => `${m.done ? '[x]' : '[ ]'} ${m.id}  (${m.author === 'user' ? '用户' : '智能体'})  ${m.text}`)
        .join('\n');
      // Cheap honesty: one line, only when something is actually being withheld.
      const hiddenDone = a.includeDone === true ? 0 : hidden;
      return hiddenDone
        ? `${body}\n（另有 ${hiddenDone} 条已完成未列出，includeDone=true 可见）`
        : body;
    },
  );

  reg(
    {
      name: 'memo_add',
      description:
        'Append an idea, TODO or note to the shared scratchpad. Use it to record things that are worth remembering but do not belong in the knowledge tree.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The note text' } },
        required: ['text'],
      },
    },
    async (a) => {
      const text = String(a.text ?? '').trim();
      if (!text) return 'Error: text is required';
      const e = store.add(text, 'agent');
      return `已记录 ${e.id}：${e.text}`;
    },
  );

  reg(
    {
      name: 'memo_update',
      description: 'Edit a memo entry or mark it done.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memo id' },
          text: { type: 'string', description: 'New text (optional)' },
          done: { type: 'boolean', description: 'Mark done / not done' },
        },
        required: ['id'],
      },
    },
    async (a) => {
      const id = String(a.id ?? '');
      const e = store.update(id, {
        text: typeof a.text === 'string' ? a.text : undefined,
        done: typeof a.done === 'boolean' ? a.done : undefined,
      });
      if (!e) return `Error: 未找到备忘录 ${id}`;
      return `${e.done ? '[x]' : '[ ]'} ${e.id}：${e.text}`;
    },
  );

  reg(
    {
      name: 'memo_remove',
      description: 'Delete a memo entry.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Memo id' } },
        required: ['id'],
      },
    },
    async (a) => {
      const ok = store.remove(String(a.id ?? ''));
      return ok ? '已删除。' : `Error: 未找到备忘录 ${a.id}`;
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
