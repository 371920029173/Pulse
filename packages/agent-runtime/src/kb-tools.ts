import type { ToolDefinition, EdgeKind } from '@she/shared';
import type { GroupKBEngine } from '@she/kb';

export interface KBToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export function createKBTools(engine: GroupKBEngine): KBToolSet {
  const toolMap = new Map<string, { def: ToolDefinition; fn: (args: Record<string, unknown>) => Promise<string> }>();

  function reg(def: ToolDefinition, fn: (args: Record<string, unknown>) => Promise<string>) {
    toolMap.set(def.name, { def, fn });
  }

  reg(
    {
      name: 'kb_query',
      description: 'Query the Group Memory KB via PulseSeed structural resonance. Returns activated memory nodes with group paths and activation traces showing how each result was reached.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The query text to search for' },
          budget: { type: 'number', description: 'Max nodes to scan (default: 100)' },
        },
        required: ['query'],
      },
    },
    async (args) => {
      const query = args.query as string;
      const budget = args.budget as number | undefined;
      const result = engine.query(query, { budget });

      if (result.nodes.length === 0) {
        return 'No results found in Group KB.';
      }

      const lines: string[] = [];
      lines.push(`Found ${result.nodes.length} nodes across ${result.groupsVisited.length} groups (${result.queryTimeMs.toFixed(1)}ms, ${result.totalNodesScanned} scanned)`);
      lines.push(`PulseSeeds emitted: ${result.pulseSeeds.length}`);
      lines.push('');

      for (let i = 0; i < result.nodes.length && i < 10; i++) {
        const node = result.nodes[i];
        const trace = result.traces[i];
        lines.push(`[${i + 1}] ${node.title} (${node.kind}) — activation: ${trace?.activationLevel.toFixed(3)}`);
        if (trace?.groupPath.length) {
          lines.push(`    Group path: ${trace.groupPath.join(' | ')}`);
        }
        if (trace?.reason) {
          lines.push(`    Reason: ${trace.reason}`);
        }
        if (trace?.pulseSeeds.length) {
          for (const ps of trace.pulseSeeds.slice(0, 3)) {
            const hops = ps.path.map(h => `${h.edgeKind}(${h.energyAfter.toFixed(2)})`).join(' → ');
            lines.push(`    PulseSeed: ${hops || 'direct'}`);
          }
        }
        const preview = node.content.slice(0, 300).replace(/\n/g, ' ');
        lines.push(`    Content: ${preview}`);
        lines.push(`    [Node: ${node.id}]`);
        lines.push('');
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

      const mem = engine.addMemory(group.id, nodeKind, title, content);
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
