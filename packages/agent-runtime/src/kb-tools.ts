import type { ToolDefinition, EdgeKind, KBQueryResult, MemoryNode } from '@she/shared';
import type { GroupKBEngine, KBMemoryPatch, KBReviseResult, KBRetirement } from '@she/kb';
import { KB_RETIRED_KEY, KB_VERSION_KEY } from '@she/kb';

export interface KBToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * How much of a node's text a `kb_query` reply carries unless `full` is asked for.
 *
 * Sized from what memories actually look like: a convention, a decided port, a command line —
 * the things a query is usually after — are well under this, so a hit still arrives complete and
 * does not cost a second call to read. What it cuts is the other shape: an ingested document or a
 * pasted log, where one node is thousands of characters. A single query activating ten of those
 * was ten documents re-sent on every lookup, which is the cost the summary is here to stop.
 */
const KB_PREVIEW_CHARS = 200;

/**
 * How many hits a `kb_query` reply lists unless `limit` asks for more, and the most it will list.
 *
 * The engine returns up to 40 hits; most lookups are answered by the first few, and every extra
 * hit stays in the conversation and is paid for again on every later turn. The full ranked result
 * still goes to the UI trace (`onQueryResult`); only the text handed to the model is capped, and
 * the reply says how many it left out.
 */
const KB_DEFAULT_LIMIT = 5;
const KB_MAX_LIMIT = 30;

const VALID_KINDS = ['text', 'code', 'fact', 'tool_outcome', 'preference'] as const;
type ValidKind = (typeof VALID_KINDS)[number];

/** Read straight from metadata so a node from any engine (or a test double) can be described. */
function retirementOf(node: MemoryNode): KBRetirement | undefined {
  const r = node.metadata?.[KB_RETIRED_KEY];
  return r && typeof r === 'object' ? r as KBRetirement : undefined;
}

function versionOf(node: MemoryNode): number {
  const v = node.metadata?.[KB_VERSION_KEY];
  return typeof v === 'number' && v >= 1 ? v : 1;
}

function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > KB_PREVIEW_CHARS ? `${one.slice(0, KB_PREVIEW_CHARS)}…` : one;
}

/** "What changed" in one line, so an update is never reported as a bare "ok". */
function describeChange(r: KBReviseResult): string {
  const parts: string[] = [];
  if (r.changed.includes('title')) parts.push(`标题「${r.before.title}」→「${r.after.title}」`);
  if (r.changed.includes('content')) parts.push(`正文 ${r.before.content.length} → ${r.after.content.length} 字`);
  if (r.changed.includes('kind')) parts.push(`类型 ${r.before.kind} → ${r.after.kind}`);
  return `改动：${parts.join('，')}；旧版本（第 ${r.version - 1} 版）已保留在节点历史里，现为第 ${r.version} 版`;
}

export interface KBToolOptions {
  /**
   * Called with the full structured result whenever `kb_query` runs, so the UI
   * can render the activation trace. Previously the UI only ever saw the tool
   * *arguments*, which is why the trace panel stayed empty.
   */
  onQueryResult?: (result: KBQueryResult) => void;
  /**
   * Reading is allowed, writing is not.
   *
   * For a delegated child whose KB is the PARENT'S live database — the read-only subagent case,
   * where no worktree is created — an unguarded `kb_upsert` writes a permanent node into the
   * parent's memory with nobody reviewing it. The child was handed the same memory rules as the
   * parent ("主动 kb_upsert 写回"), so it will do exactly that, and the node it writes is
   * indistinguishable from one the parent wrote: `kb_upsert` carries no provenance field.
   *
   * The write tools stay REGISTERED and refuse, rather than being removed. A missing tool comes
   * back as an unknown-tool error, which reads as the agent's own mistake: the error book files
   * it, and the child retries with different arguments. A refusal is a normal, informative tool
   * result, so the child learns in one step where its findings are supposed to go — its
   * deliverable, back to the parent, who decides whether the claim is worth keeping.
   */
  readOnly?: boolean;
}

export function createKBTools(engine: GroupKBEngine, opts?: KBToolOptions): KBToolSet {
  const toolMap = new Map<string, { def: ToolDefinition; fn: (args: Record<string, unknown>) => Promise<string> }>();

  /**
   * What a read-only child is told when it tries to persist something.
   *
   * Deliberately a normal successful result, not an error: an error would be recorded against the
   * child as its own mistake and invite a retry. This states the one thing it is supposed to do
   * with a durable finding instead — hand it to the parent in the deliverable.
   */
  const READ_ONLY_REFUSAL =
    '这个子任务的知识库是父会话的活动库，只读：本工具已停用，没有写入任何内容。'
    + '把结论写进你的交付物（报告 / 清单 / 摘要）交回父级，由父级决定是否入库 —— '
    + '子任务自己写进去的记忆无法复核，而且和父级写的节点无法区分。';

  function reg(def: ToolDefinition, fn: (args: Record<string, unknown>) => Promise<string>) {
    toolMap.set(def.name, { def, fn });
  }

  reg(
    {
      name: 'kb_query',
      description: 'Query the Group Memory KB via PulseSeed structural resonance. Returns activated memory nodes with group paths and activation traces showing how each result was reached. '
        + `Node text is summarised to the first ${KB_PREVIEW_CHARS} characters by default — enough for a convention, a port or a command, and short of the whole of an ingested document. `
        + 'Pass `full: true` when the exact wording is the point: quoting a memory, or checking a command, a number or a path character by character. '
        + `Lists the top ${KB_DEFAULT_LIMIT} hits by default (\`limit\` up to ${KB_MAX_LIMIT} for more); the reply says how many were left out. `
        + 'To read one node in full, use `kb_get` with its id (the [Node: …] line).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The query text to search for' },
          budget: {
            type: 'number',
            description:
              'Optional. How much of the memory graph the pulse may explore. It bounds the SCAN, not '
              + 'the reply: it cannot be used to ask for fewer results (use `limit` for how many hits are '
              + 'listed), and a smaller value mostly just makes the query cheaper. Lower it only when a '
              + 'query is slow.',
          },
          limit: {
            type: 'number',
            description: `Optional. How many hits to list (default ${KB_DEFAULT_LIMIT}, max ${KB_MAX_LIMIT}). Raise it when the first hits are not enough.`,
          },
          full: {
            type: 'boolean',
            description:
              'Return each node\'s complete text instead of a summary. Costs several times more, so use it when you need the exact wording rather than the gist.',
          },
          includeRetired: {
            type: 'boolean',
            description:
              'Also return retired memories (retired with kb_retire as wrong or obsolete), marked [已退役] with the reason and replacement. Off by default.',
          },
        },
        required: ['query'],
      },
    },
    async (args) => {
      const query = args.query as string;
      const budget = args.budget as number | undefined;
      const full = args.full === true;
      const includeRetired = args.includeRetired === true;
      const result = engine.query(query, includeRetired ? { budget, includeRetired } : { budget });

      // Surface the structured result so the UI trace panel can render it.
      opts?.onQueryResult?.(result);

      if (result.nodes.length === 0) {
        return 'No results found in Group KB.';
      }

      const rawLimit = Number(args.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(Math.floor(rawLimit), KB_MAX_LIMIT)
        : KB_DEFAULT_LIMIT;
      const shown = Math.min(limit, result.nodes.length);
      const omitted = result.nodes.length - shown;

      const lines: string[] = [];
      lines.push(`Found ${result.nodes.length} nodes across ${result.groupsVisited.length} groups (${result.queryTimeMs.toFixed(1)}ms, ${result.totalNodesScanned} scanned)${omitted > 0 ? `，列出前 ${shown} 条` : ''}`);
      lines.push('');

      let clipped = 0;
      for (let i = 0; i < shown; i++) {
        const node = result.nodes[i];
        const trace = result.traces[i];
        const score = trace?.finalScore !== undefined
          ? trace.finalScore.toFixed(3)
          : trace?.activationLevel.toFixed(3);
        const retired = retirementOf(node);
        const version = versionOf(node);
        lines.push(`[${i + 1}] ${node.title} (${node.kind}) score=${score}${version > 1 ? ` v${version}` : ''}${retired ? ' [已退役]' : ''}`);
        if (trace?.groupPath.length) {
          lines.push(`    group: ${trace.groupPath.join(' | ')}`);
        }
        if (full || node.content.length <= KB_PREVIEW_CHARS) {
          lines.push(`    ${node.content}`);
        } else {
          // One line, whitespace collapsed: a snippet is for recognising the node, not for quoting.
          lines.push(`    ${preview(node.content)}`);
          clipped++;
        }
        if (retired) {
          lines.push(`    退役原因：${retired.reason}${retired.replacedBy ? `；替代节点：${retired.replacedBy}` : ''}`);
        }
        lines.push(`    [Node: ${node.id}]`);
      }

      /*
       * One line telling the caller what it did not get, and how to get it.
       *
       * Only when something was actually cut. A per-node marker would be a second copy of the
       * same sentence on every long node, and a reply that silently shortens a memory is worse
       * than a long one: the agent would quote the summary as if it were the text.
       */
      if (omitted > 0 || clipped > 0) lines.push('');
      if (omitted > 0) {
        lines.push(`另有 ${omitted} 条未列出，调大 limit 可看（最多 ${KB_MAX_LIMIT}）`);
      }
      if (clipped > 0) {
        lines.push(
          `（${clipped} 条正文超过 ${KB_PREVIEW_CHARS} 字，上面是摘要；要原文用 kb_get(id) 或 full=true）`,
        );
      }
      return lines.join('\n');
    },
  );

  /*
   * Read one node by id. Read-only, so it is NOT guarded by `readOnly`: a read-only child needs
   * it exactly as much as the parent does.
   */
  reg(
    {
      name: 'kb_get',
      description: 'Read one memory node in full by id (the [Node: …] from kb_query): title, kind, version, group, retirement and the complete text. '
        + 'Read-only. Use it after kb_query when a snippet is not enough, instead of re-running the query with full=true.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node id, from the [Node: …] line of a kb_query result' },
        },
        required: ['id'],
      },
    },
    async (args) => {
      const id = String(args.id ?? args.nodeId ?? '').trim().replace(/^\[?Node:\s*/i, '').replace(/\]$/, '').trim();
      if (!id) return 'Error: 必须给 id（kb_query 结果里的 [Node: …]）';
      const mem: MemoryNode | undefined = engine['store'].getMemory(id);
      if (!mem) return `Error: Memory not found: ${id}`;
      const retired = retirementOf(mem);
      const version = versionOf(mem);
      const groups = typeof engine.findGroupForMemory === 'function'
        ? engine.findGroupForMemory(id).map((g) => g.name).filter(Boolean)
        : [];
      const lines = [`${mem.title} (${mem.kind})${version > 1 ? ` v${version}` : ''}${retired ? ' [已退役]' : ''}`];
      if (groups.length) lines.push(`group: ${groups.join(' | ')}`);
      if (retired) {
        lines.push(`退役原因：${retired.reason}${retired.replacedBy ? `；替代节点：${retired.replacedBy}` : ''}`);
      }
      lines.push(`[Node: ${mem.id}]`);
      lines.push('');
      lines.push(mem.content);
      return lines.join('\n');
    },
  );

  reg(
    {
      name: 'kb_upsert',
      description: 'Add a memory node to the Group KB. Creates the target group if it does not exist. '
        + 'Never overwrites silently: if an active node with the same title already exists in that group (or its subgroups), '
        + 'identical content writes nothing, and different content is NOT written unless you choose: '
        + 'onExisting="update" edits that node in place (the previous version is kept in its history), '
        + 'onExisting="add" keeps both as separate nodes. The result always says which happened (added / updated / unchanged / not written). '
        + 'To correct a node by id use kb_edit; to take a wrong or obsolete one out of retrieval use kb_retire.',
      parameters: {
        type: 'object',
        properties: {
          groupName: { type: 'string', description: 'Name of the group to add the memory to' },
          title: { type: 'string', description: 'Title of the memory' },
          content: { type: 'string', description: 'Content of the memory' },
          kind: { type: 'string', enum: ['text', 'code', 'fact', 'tool_outcome', 'preference'], description: 'Kind of memory (default: fact)' },
          onExisting: {
            type: 'string',
            enum: ['refuse', 'update', 'add'],
            description: 'What to do when an active node with the same title already has DIFFERENT content: '
              + '"refuse" (default) writes nothing and shows the existing node; "update" edits it in place, keeping the old version in history; '
              + '"add" stores a second node alongside it.',
          },
        },
        required: ['groupName', 'title', 'content'],
      },
    },
    async (args) => {
      if (opts?.readOnly) return READ_ONLY_REFUSAL;
      let groupName = args.groupName as string;
      const title = args.title as string;
      const content = args.content as string;
      const kind = (args.kind as string) ?? 'fact';
      const onExisting = args.onExisting === 'update' || args.onExisting === 'add' ? args.onExisting : 'refuse';

      const nodeKind: ValidKind = VALID_KINDS.includes(kind as ValidKind) ? kind as ValidKind : 'fact';

      let group = engine['store'].getAllGroups().find((g: { name: string }) => g.name === groupName);

      // `<group>/part-N` is a structural bucket made by an automatic split, not a topic: write to the
      // logical group instead (writing into a part is what made parts overflow and nest).
      let redirected = '';
      if (group) {
        const logical = engine.resolveLogicalGroup(group.id);
        if (logical && logical.id !== group.id) {
          redirected = ` (redirected from split part "${groupName}" to its logical group "${logical.name}")`;
          groupName = logical.name;
          group = logical;
        }
      }

      /*
       * Same title, same group: decide explicitly instead of piling up.
       *
       * The live audit (#7) wrote a correction under the same title and got a second node next to
       * the wrong one — both kept matching queries, and nothing told the agent a node was already
       * there. Now the call reports what exists and the caller picks: update it in place (the old
       * version is kept), add a second node on purpose, or retire the old one.
       */
      let sameTitle: MemoryNode[] = [];
      if (group) {
        sameTitle = engine.findByTitle(group.id, title);
        const target = sameTitle[sameTitle.length - 1];
        const kindDiffers = args.kind !== undefined && target !== undefined && target.kind !== nodeKind;
        if (target && onExisting !== 'add') {
          if (target.content === content && !kindDiffers) {
            return `未写入（内容相同）：组 "${groupName}" 里已有同题节点「${target.title}」，内容一致 [Node: ${target.id}, Group: ${group.id}]`;
          }
          if (onExisting === 'update') {
            const patch: KBMemoryPatch = { content };
            if (args.kind !== undefined) patch.kind = nodeKind;
            const r = engine.reviseMemory(target.id, patch, 'kb_upsert onExisting=update');
            return `Updated memory "${r.after.title}" in group "${groupName}" [Node: ${target.id}, Group: ${group.id}] —— ${describeChange(r)}${redirected}`;
          }
          return [
            `未写入（已有同题节点）：组 "${groupName}" 里已有「${target.title}」[Node: ${target.id}]，内容与这次不同`
              + (sameTitle.length > 1 ? `（同题有效节点共 ${sameTitle.length} 条）` : '') + '。',
            `现有内容：${preview(target.content)}`,
            '请明确选一种处理：',
            '- 旧内容需要更正 / 补充 → 重新调用并带 onExisting="update"（原地更新，旧版本保留在历史里），或用 kb_edit 改这个节点；',
            '- 两条确实是不同的记忆 → 换一个更具体的 title，或带 onExisting="add" 让两条并存；',
            '- 旧结论是错的、不该再被检索到 → kb_retire 退役它（可带 replacedBy 指向新节点）。',
          ].join('\n');
        }
      } else {
        group = engine.createGroup(groupName);
      }

      // Maintained write: keeps the target group from growing unbounded.
      const mem = engine.addMemoryMaintained(group.id, nodeKind, title, content);
      const alongside = sameTitle.length > 0
        ? `（同组已有同题有效节点 ${sameTitle.map((m) => m.id).join(', ')}，按 onExisting="add" 并存）`
        : '';
      return `Added memory "${title}" to group "${groupName}" [Node: ${mem.id}, Group: ${group.id}]${alongside}${redirected}`;
    },
  );

  reg(
    {
      name: 'kb_link',
      description: 'Create a typed edge between two memory nodes. Edge kinds: co_occurrence, temporal, causal_candidate (requires evidence + falsifiers), weak. NEVER auto-promote edge types.',
      parameters: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Source node ID' },
          targetId: { type: 'string', description: 'Target node ID' },
          kind: { type: 'string', enum: ['co_occurrence', 'temporal', 'causal_candidate', 'weak'], description: 'Edge kind' },
          evidence: { type: 'string', description: 'Required for causal_candidate: why this causal link is hypothesized' },
          falsifiers: { type: 'array', items: { type: 'string' }, description: 'Required for causal_candidate: conditions that would disprove it' },
        },
        required: ['sourceId', 'targetId', 'kind'],
      },
    },
    async (args) => {
      if (opts?.readOnly) return READ_ONLY_REFUSAL;
      const sourceId = args.sourceId as string;
      const targetId = args.targetId as string;
      const kind = args.kind as EdgeKind;
      const evidence = args.evidence as string | undefined;
      const falsifiers = args.falsifiers as string[] | undefined;

      const edge = engine.addTypedEdge(sourceId, targetId, kind, { evidence, falsifiers });
      return `Created ${kind} edge [${edge.id}]: ${sourceId} → ${targetId}`;
    },
  );

  reg(
    {
      name: 'kb_edit',
      description: 'Edit an existing memory node in place, by id (the [Node: …] from kb_query). '
        + 'Keeps the id, groups and edges, and keeps the replaced version in the node\'s history, so nothing is lost. '
        + 'Use it to correct or extend a memory instead of adding a second node that contradicts the first.',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Id of the node to edit' },
          title: { type: 'string', description: 'New title (omit to keep)' },
          content: { type: 'string', description: 'New full content (omit to keep). Replaces the text; include what should stay.' },
          kind: { type: 'string', enum: ['text', 'code', 'fact', 'tool_outcome', 'preference'], description: 'New kind (omit to keep)' },
          reason: { type: 'string', description: 'Why it changed — stored with the previous version' },
        },
        required: ['nodeId'],
      },
    },
    async (args) => {
      if (opts?.readOnly) return READ_ONLY_REFUSAL;
      const nodeId = String(args.nodeId ?? '').trim();
      if (!nodeId) return 'Error: 必须给 nodeId（kb_query 结果里的 [Node: …]）';
      const patch: KBMemoryPatch = {};
      if (args.title !== undefined) {
        if (typeof args.title !== 'string' || !args.title.trim()) return 'Error: title 不能为空';
        patch.title = args.title;
      }
      if (args.content !== undefined) {
        if (typeof args.content !== 'string' || !args.content.trim()) {
          return 'Error: content 不能为空 —— 要让这条记忆不再生效，用 kb_retire';
        }
        patch.content = args.content;
      }
      if (args.kind !== undefined) {
        if (!VALID_KINDS.includes(args.kind as ValidKind)) return `Error: kind 只能是 ${VALID_KINDS.join(' / ')}`;
        patch.kind = args.kind as ValidKind;
      }
      if (Object.keys(patch).length === 0) return 'Error: 至少给 title / content / kind 之一';
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined;

      const r = engine.reviseMemory(nodeId, patch, reason);
      if (r.changed.length === 0) {
        return `没有变化：节点「${r.before.title}」[Node: ${nodeId}] 已经是这个内容，未写入。`;
      }
      const stillRetired = engine.isRetired(r.after)
        ? '\n注意：该节点仍处于退役状态，默认检索看不到它；要恢复用 kb_retire restore=true。'
        : '';
      return `Updated memory "${r.after.title}" [Node: ${nodeId}] —— ${describeChange(r)}${stillRetired}`;
    },
  );

  reg(
    {
      name: 'kb_retire',
      description: 'Retire a memory node that is wrong or obsolete. It stops appearing in kb_query (unless includeRetired=true) '
        + 'but is not deleted: text, history and edges are kept. Requires a reason; pass replacedBy with the id of the node that '
        + 'supersedes it, if any. restore=true brings a retired node back.',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Id of the node to retire (or restore)' },
          reason: { type: 'string', description: 'Why it no longer holds. Required when retiring.' },
          replacedBy: { type: 'string', description: 'Optional: id of the node that supersedes this one' },
          restore: { type: 'boolean', description: 'Undo a retirement instead' },
        },
        required: ['nodeId'],
      },
    },
    async (args) => {
      if (opts?.readOnly) return READ_ONLY_REFUSAL;
      const nodeId = String(args.nodeId ?? '').trim();
      if (!nodeId) return 'Error: 必须给 nodeId（kb_query 结果里的 [Node: …]）';
      const mem: MemoryNode | undefined = engine['store'].getMemory(nodeId);
      if (!mem) return `Error: Memory not found: ${nodeId}`;
      const current = engine.getRetirement(mem);

      if (args.restore === true) {
        if (!current) return `没有变化：节点「${mem.title}」[Node: ${nodeId}] 本来就是有效状态。`;
        engine.restoreMemory(nodeId);
        return `已恢复节点「${mem.title}」[Node: ${nodeId}]：重新参与检索（此前退役原因：${current.reason}）。`;
      }

      if (current) {
        return `没有变化：节点「${mem.title}」[Node: ${nodeId}] 已经是退役状态（原因：${current.reason}`
          + `${current.replacedBy ? `；替代节点：${current.replacedBy}` : ''}）。要改原因，先 restore=true 再重新退役。`;
      }
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!reason) return 'Error: 退役必须写 reason（它为什么不再成立）';
      const replacedBy = typeof args.replacedBy === 'string' && args.replacedBy.trim() ? args.replacedBy.trim() : undefined;

      engine.retireMemory(nodeId, { reason, replacedBy });
      return `已退役节点「${mem.title}」[Node: ${nodeId}]（原因：${reason}${replacedBy ? `；替代节点：${replacedBy}` : ''}）。`
        + '默认检索不再返回它；原文、历史和边都保留，kb_query 带 includeRetired=true 仍可见；'
        + `恢复：kb_retire nodeId=${nodeId} restore=true。`;
    },
  );

  const definitions = Array.from(toolMap.values()).map(t => t.def);

  async function execute(name: string, args: Record<string, unknown>): Promise<string> {
    const entry = toolMap.get(name);
    if (!entry) return `Error: unknown KB tool "${name}"`;
    try {
      return await entry.fn(args);
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { definitions, execute };
}
