// ─── Group KB Types (v2-aligned, PulseSeed retrieval) ───

export interface MemoryNode {
  id: string;
  kind: 'text' | 'code' | 'fact' | 'tool_outcome' | 'preference';
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  groupIds: string[];
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  updatedAt: number;
  isDormant: boolean;
}

/**
 * Edge kinds — strictly distinct, NEVER auto-promoted.
 * co_occurrence: observed together, no causal claim
 * temporal: ordered in time (A before B), not causal
 * causal_candidate: directional, requires evidence + falsifiers
 * hierarchical: parent→child structural edge
 * weak: pre-activation / fast reachability hint, NOT similarity proof
 * cross_group: bridge between groups
 */
export type EdgeKind = 'co_occurrence' | 'temporal' | 'causal_candidate' | 'hierarchical' | 'weak' | 'cross_group';

export interface Edge {
  id: string;
  kind: EdgeKind;
  sourceId: string;
  targetId: string;
  weight: number;
  direction: 'forward' | 'backward' | 'bidirectional';
  evidence?: string;
  falsifiers?: string[];
  createdAt: number;
}

export interface Group {
  id: string;
  name: string;
  nameIsGroupRef: boolean;
  parentGroupId: string | null;
  childGroupIds: string[];
  memoryIds: string[];
  weakEdgeIds: string[];
  crossGroupEdgeIds: string[];
  competitionSubgroupIds: string[];
  isCompetitionSubgroup: boolean;
  localIndex: Record<string, string>;
  hormoneMarker: number;
  trustConstant: number;
  isDormant: boolean;
  stats: GroupStats;
  maxChildrenBeforeSplit: number;
  createdAt: number;
  updatedAt: number;
}

export interface GroupStats {
  totalMemories: number;
  directMemories: number;
  compressedMemories: number;
  totalChildren: number;
  accessCount: number;
}

// ─── PulseSeed: the core retrieval primitive ───

/**
 * PulseSeed is the activation signal that propagates through the group structure.
 * NOT a keyword match. NOT an embedding vector. It is a structural resonance
 * signal that spreads through groups and edges based on structural affinity.
 *
 * The query decomposes into structural components (tokens bound to groups),
 * each becomes a PulseSeed. Seeds propagate through edges with energy decay.
 * Nodes/groups that structurally resonate (share group membership, edge
 * connectivity, or hierarchical relationship) activate.
 */
export interface PulseSeed {
  id: string;
  sourceNodeId: string | null;
  sourceGroupId: string;
  energy: number;
  origin: string;
  hop: number;
  path: PulseHop[];
  resonatedAt: number;
}

export interface PulseHop {
  fromId: string;
  toId: string;
  edgeId: string | null;
  edgeKind: EdgeKind | 'group_member' | 'parent_child';
  energyBefore: number;
  energyAfter: number;
}

export interface ActivationTrace {
  nodeId: string;
  groupPath: string[];
  pulseSeeds: PulseSeed[];
  activationLevel: number;
  reason: string;
}

export interface KBQueryResult {
  nodes: MemoryNode[];
  traces: ActivationTrace[];
  groupsVisited: string[];
  totalNodesScanned: number;
  queryTimeMs: number;
  pulseSeeds: PulseSeed[];
}

// ─── LLM Types ───

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isDangerous?: boolean;
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  isError?: boolean;
}

export interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done' | 'error';
  content?: string;
  toolCall?: Partial<ToolCall>;
  error?: string;
}

export interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], tools?: ToolDefinition[], onChunk?: (chunk: StreamChunk) => void): Promise<LLMMessage>;
}

// ─── Sandbox Types ───

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  denied?: boolean;
}

export interface SandboxOptions {
  cwd?: string;
  timeout?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}
