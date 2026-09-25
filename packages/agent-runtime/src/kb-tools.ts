import type { ToolDefinition, EdgeKind, KBQueryResult } from '@she/shared';
import type { GroupKBEngine } from '@she/kb';

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
        + 'Pass `full: true` when the exact wording is the point: quoting a memory, or checking a command, a number or a path character by character.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The query text to search for' },
          budget: {
            type: 'number',
            description:
              'Optional. How much of the memory graph the pulse may explore. It bounds the SCAN, not '
              + 'the reply: it cannot be used to ask for fewer results (a reply carries up to 40 of '
              + 'whatever scores above the relevance floor), and a smaller value mostly just makes the '
              + 'query cheaper. Lower it only when a query is slow.',
          },
          full: {
            type: 'boolean',
            description:
              'Return each node\'s complete text instead of a summary. Costs several times more, so use it when you need the exact wording rather than the gist.',
          },
        },
        required: ['query'],
      },
    },
    async (args) => {
      const query = args.query as string;
      const budget = args.budget as number | undefined;
      const full = args.full === true;
      const result = engine.query(query, { budget });

      // Surface the structured result so the UI trace panel can render it.
      opts?.onQueryResult?.(result);

      if (result.nodes.length === 0) {
        return 'No results found in Group KB.';
      }

      const lines: string[] = [];
      lines.push(`Found ${result.nodes.length} nodes across ${result.groupsVisited.length} groups (${result.queryTimeMs.toFixed(1)}ms, ${result.totalNodesScanned} scanned)`);
      lines.push('');

      let clipped = 0;
      for (let i = 0; i < result.nodes.length; i++) {
        const node = result.nodes[i];
        const trace = result.traces[i];
        const score = trace?.finalScore !== undefined
          ? trace.finalScore.toFixed(3)
          : trace?.activationLevel.toFixed(3);
        lines.push(`[${i + 1}] ${node.title} (${node.kind}) score=${score}`);
        if (trace?.groupPath.length) {
          lines.push(`    group: ${trace.groupPath.join(' | ')}`);
        }
        if (full || node.content.length <= KB_PREVIEW_CHARS) {
          lines.push(`    ${node.content}`);
        } else {
          lines.push(`    ${node.content.slice(0, KB_PREVIEW_CHARS)}…`);
          clipped++;
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
      if (clipped > 0) {
        lines.push('');
        lines.push(
          `（${clipped} 条正文超过 ${KB_PREVIEW_CHARS} 字，上面是摘要；要原文再查一次并带 full=true）`,
        );
      }
      return lines.join('\n');
    },
  );

  reg(
    {
      name: 'kb_upsert',
      description: 'Add a memory node to the Group KB. Creates the target group if it does not exist.',
      parameters: {
        type: 'object',
        properties: {
          groupName: { type: 'string', description: 'Name of the group to add the memory to' },
          title: { type: 'string', description: 'Title of the memory' },
          content: { type: 'string', description: 'Content of the memory' },
          kind: { type: 'string', enum: ['text', 'code', 'fact', 'tool_outcome', 'preference'], description: 'Kind of memory (default: fact)' },
        },
        required: ['groupName', 'title', 'content'],
      },
    },
    async (args) => {
      if (opts?.readOnly) return READ_ONLY_REFUSAL;
      const groupName = args.groupName as string;
      const title = args.title as string;
      const content = args.content as string;
      const kind = (args.kind as string) ?? 'fact';

      let group = engine['store'].getAllGroups().find((g: { name: string }) => g.name === groupName);
      if (!group) {
        group = engine.createGroup(groupName);
      }

      const validKinds = ['text', 'code', 'fact', 'tool_outcome', 'preference'] as const;
      const nodeKind = validKinds.includes(kind as (typeof validKinds)[number])
        ? kind as (typeof validKinds)[number]
        : 'fact' as const;

      // Maintained write: keeps the target group from growing unbounded.
      const mem = engine.addMemoryMaintained(group.id, nodeKind, title, content);
      return `Added memory "${title}" to group "${groupName}" [Node: ${mem.id}, Group: ${group.id}]`;
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
