import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@she/shared';
import {
  workspaceStateFile,
  sessionStateDir,
  listSessionIds,
  CHAT_SESSION_PREFIX,
} from './session-state.js';

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
 * 读一份备忘文件里的条目。
 *
 * 从 `MemoStore.list` 提出来，是为了让历史迁移也能用**同一个**解析器：坏文件当空、去掉 BOM、"不是数组
 * 就当空"这三条规则各写一遍的话，第二个解析器迟早和第一个不一致。迁移只多知道"文件在哪"。
 */
function readMemoFile(filePath: string): MemoEntry[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as MemoEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 工作区级的草稿板（备忘）——用户和这个工作区里的 agent 都能改。
 *
 * 2026-09-27 曾把它切成会话私有（`.she/sessions/<id>/memo.json`），理由是"别的会话不该读到我的东西"。
 * 那条边界划错了：用户脑子里的边界是**项目**。在一个项目里新开一个对话，昨天记的待办当然还在 —— 备忘
 * 记的本来就是"这个项目里还没做的事"，按对话分账等于每次开新对话都从空开始记。
 *
 * 现在是 `.she/memo.json` 一份，工作区里所有会话共享；跨工作区仍然是路径上不存在（另一个工作区有它
 * 自己的 `.she/`）。这不影响"谁能看见"：边界从来没有变松，只是挪到了用户认识的那条线上。
 *
 * 仍然很小、仍然是文件存储：它是给"不值得写进知识库的想法和待办"用的，而且两边都要能改（UI + 工具）。
 */
export class MemoStore {
  private filePath: string;

  constructor(workspaceRoot: string) {
    // 唯一允许拼工作区级路径的方式；文件名的校验在 `workspaceStateFile` 里。
    this.filePath = workspaceStateFile(workspaceRoot, 'memo.json');
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  list(): MemoEntry[] {
    return readMemoFile(this.filePath);
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

  /** 整份写回（迁移用）——只写，不改内容，和 `PlanStore.replaceAll` 同一个理由。 */
  replaceAll(list: MemoEntry[]): void {
    this.save(list);
  }
}

/**
 * 把 2026-09-27 拆出去的备忘收回到工作区那一份里。
 *
 * 和计划同一次改动、同一个收尾问题：会话目录里如果已经记过东西，改回工作区级之后必须并回来，否则这次
 * 改动会把那些条目留在没人读的路径上。合并按 id 取并集，同一个 id 以 `updatedAt` 新的为准；原文件不删。
 * 只看聊天会话目录（群不用备忘）。可重复执行，第二次是空操作。
 */
export function adoptSessionMemosIntoWorkspace(workspaceRoot: string): { adopted: number; updated: number } {
  const workspace = new MemoStore(workspaceRoot);
  const byId = new Map(workspace.list().map((m) => [m.id, m]));
  let adopted = 0;
  let updated = 0;
  for (const sessionId of listSessionIds(workspaceRoot)) {
    if (!sessionId.startsWith(CHAT_SESSION_PREFIX)) continue;
    const file = join(sessionStateDir(workspaceRoot, sessionId), 'memo.json');
    for (const entry of readMemoFile(file)) {
      const current = byId.get(entry.id);
      if (!current) {
        byId.set(entry.id, entry);
        adopted += 1;
      } else if ((entry.updatedAt || '') > (current.updatedAt || '')) {
        byId.set(entry.id, entry);
        updated += 1;
      }
    }
  }
  if (adopted || updated) workspace.replaceAll([...byId.values()]);
  return { adopted, updated };
}

/** Tools so the agent can read and write the same scratchpad as the user. */
export function createMemoTools(workspaceRoot: string): {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
} {
  /*
   * 备忘是工作区级的，所以这里**不再需要会话 id** —— 它曾经是必填参数，用来拼会话私有的路径。
   * 工具层依然没有"指定别的工作区"这个入口：能读写的就是本工作区的那一份。
   */
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
