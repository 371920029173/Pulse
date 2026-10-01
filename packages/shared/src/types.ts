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
  /** Structural (PulseSeed) activation energy. */
  activationLevel: number;
  reason: string;
  /** Traditional lexical relevance (BM25), raw score. */
  lexicalScore?: number;
  /** Fused score actually used for ordering (structural + lexical + signals). */
  finalScore?: number;
  /** Multiplicative boost from structural signals (trust / hormone / use / recency / dormancy). */
  signalBoost?: number;
  /** Human-readable list of the signals that moved this node up or down. */
  signalNotes?: string[];
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

/**
 * An image attached to a turn.
 *
 * Stored as a PATH, never as bytes. Two reasons, both measured elsewhere in this repo:
 * the transcript is replayed on every request, so inlining base64 here would grow the session
 * file without bound; and a re-encoded blob would change the request prefix on every replay,
 * defeating the provider's prompt cache. The bytes are read once, at the moment the request is
 * built, and never enter the transcript.
 */
export interface MessageImage {
  /** Path to the image bytes. Absolute, or resolvable against the caller's workspace. */
  path: string;
  /** MIME type the endpoint is told, e.g. `image/png`. */
  mime: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /**
   * Images the user attached to this turn (pasted, dropped, or referenced).
   *
   * Only user messages carry these: a model that could *see* images would still not be able to
   * attach any, and tool results stay text. A provider that supports vision renders them as
   * content parts; one that does not sends the text alone and says so in the text, rather than
   * dropping them in silence.
   */
  images?: MessageImage[];
  /**
   * Chain-of-thought.
   *
   * Shown in the transcript either way. What gets sent to the endpoint depends
   * on where it came from:
   *
   * - `imported` (Cursor / Claude Code / Codex): display only. It must not be
   *   written into `reasoning_content`. That field is DeepSeek-class protocol;
   *   a foreign chain is rejected, or worse, treated as this model's own thought.
   * - `native` (or omitted — a chain this agent just received): echoed back
   *   only on an assistant message that still has `tool_calls`. Thinking-mode
   *   DeepSeek returns 400 if that field is missing mid tool-loop, and does not
   *   want it on a finished turn.
   */
  reasoning?: string;
  reasoningOrigin?: 'native' | 'imported';
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

export interface ConfirmTicketInfo {
  ticket_id: string;
  tool: string;
  summary: string;
  created_at?: string;
  expires_at?: string;
}

export interface PendingPatchInfo {
  patch_id: string;
  path: string;
  before: string;
  after: string;
  unified: string;
  created_at?: string;
  expires_at?: string;
}

export interface StreamChunk {
  type:
    | 'text'
    /** Chain-of-thought delta from a reasoning model. Display-only. */
    | 'reasoning'
      | 'tool_call_start'
      | 'tool_call_delta'
      | 'tool_call_end'
      /**
       * Output of a finished tool call.
       *
       * Without this the transcript showed tool calls but never their results
       * while streaming — results only appeared after a reload, because
       * normalizeHistory rebuilds them from stored history.
       */
      | 'tool_result'
    /**
     * Progress from a tool call that is STILL running.
     *
     * `tool_result` cannot carry this: it arrives when the call is over, and the case that needs a
     * line on screen is exactly the one where the call is not over — a `shell_wait` blocking on a
     * three-minute job. Carried per `toolCallId` so the UI can show it under the call it belongs to
     * instead of appending another transcript row.
     */
      | 'tool_progress'
    /** Structured result of a KB query, so the UI can render the trace panel. */
    | 'kb_result'
    | 'done'
    | 'error'
    | 'status'
    | 'needs_confirm'
    | 'needs_apply'
    | 'usage';
  content?: string;
  /** Background / subagent card update (UI TaskCards). */
  task?: { id: string; kind: string; label: string; phase: 'running' | 'done' | 'error'; detail?: string };
  toolCall?: Partial<ToolCall>;
  error?: string;
  /** Present when type === 'needs_confirm' */
  ticket?: ConfirmTicketInfo;
  /** Present when type === 'needs_apply' */
  patch?: PendingPatchInfo;
    /** Present when type === 'kb_result' — the full KBQueryResult. */
    kbResult?: unknown;
    /** Present when type === 'tool_result' — the tool call this output belongs to. */
    toolCallId?: string;
    /** Present when type === 'tool_result' — name of the tool that ran. */
    toolName?: string;
  /**
   * Present on a `status` chunk that the user must not miss: the reply stopped early or the turn
   * failed. `kind` says WHERE it went wrong (模型端 / 网络 / 本地, or the output-length ceiling),
   * and `action: 'continue'` tells the UI to offer a 继续 button that appends a continuation turn.
   *
   * Carried on `status` rather than a new chunk type so an older UI still shows the text.
   */
  notice?: { kind: 'length' | 'network' | 'provider' | 'local'; action?: 'continue' };
  /** Present when type === 'usage' */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Reasoning-token breakdown for models that report it. */
    reasoning_tokens?: number;
    /**
     * Prompt-cache accounting (DeepSeek and others report it).
     *
     * Without these the cache is invisible, so a regression that silently
     * destroys it — e.g. trimming history from the FRONT every turn, which
     * changes the prefix and drops the hit rate to 0% — shows up only on the
     * bill. See docs/context-and-caching.md for the measurements.
     */
    cache_hit_tokens?: number;
    cache_miss_tokens?: number;
  };
}

export interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], tools?: ToolDefinition[], onChunk?: (chunk: StreamChunk) => void, signal?: AbortSignal): Promise<LLMMessage>;
}

// ─── Sandbox Types ───

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  denied?: boolean;
  /**
   * Set when the command handed a program to an interpreter on the command line.
   *
   * The workspace jail reads the command TEXT: it resolves paths it can see and refuses the ones that
   * leave the workspace. Code passed as an argument — `node -e "…writeFileSync('C:/x')"` — is a
   * string, and no textual scan can say what paths it will touch. The command is therefore allowed
   * (refusing every `node -e` would break ordinary work) and the FACT is carried in the result, so
   * the model and the transcript can state that this child process was not path-contained rather
   * than implying it was. See `detectInlineCodeExecution` in the sandbox.
   */
  codeExecution?: CodeExecutionOnCommandLine;
  /**
   * Set when the command did not finish and is now running as a background job.
   *
   * `timedOut` is true in that case too (the wait really did end without an exit code), but the
   * command was NOT killed — the process is alive and `jobId` refers to it. The two fields answer
   * different questions ("did we give up waiting" / "is the work still happening"), and a caller
   * that conflates them either reports a killed command that is still writing files, or starts a
   * duplicate of something that is still running.
   */
  jobId?: string;
}

/** An interpreter invoked with its program inline, where the path jail cannot see the paths. */
export interface CodeExecutionOnCommandLine {
  /** The interpreter as the policy resolved it, e.g. `node`, `python3`, `powershell`. */
  interpreter: string;
  /** The flag that made it inline code, e.g. `-e`, `-c`, `-Command`. */
  flag: string;
  /** The command segment that matched, for the reader and for the audit trail. */
  segment: string;
}

export interface SandboxOptions {
  cwd?: string;
  timeout?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  /** When true, bypass denyDestructiveByDefault (after confirm ticket). */
  allowDestructive?: boolean;
  /**
   * Keep the process alive past `timeout` and hand back a job instead of killing it.
   *
   * Off by default: `exec()` is used by callers that want a bounded answer (the terminal endpoint,
   * tests, ingest probes), and a command that quietly outlives its timeout would be a process leak
   * they never agreed to. The agent's `shell` tool turns it on, because "give up waiting" and
   * "throw away the work" are not the same decision.
   */
  backgroundOnTimeout?: boolean;
}

/** A background command's state. `running` until the process exits or is killed. */
export type SandboxJobStatus = 'running' | 'done' | 'killed';

/**
 * What a reader learns about a background job.
 *
 * `stdout` / `stderr` are the output produced SINCE the previous read of this job, not the whole
 * log: a build that prints the same progress bar for three minutes would otherwise be re-sent on
 * every wait, and the reader (a model with a context budget) pays for it every time.
 */
export interface SandboxJobView {
  id: string;
  command: string;
  status: SandboxJobStatus;
  /** null while running. */
  exitCode: number | null;
  /** Milliseconds since the job started (frozen at the exit time once finished). */
  elapsedMs: number;
  stdout: string;
  stderr: string;
  /** Bytes dropped from the front of the unread output because the buffer cap was reached. */
  droppedBytes: number;
  /** Bytes of output written that no reader has taken yet. */
  pendingBytes: number;
  /** How it ended, when `status` is `killed`. */
  killedBy?: SandboxJobKillReason;
  /** Set by a wait that ended because `pattern` matched, rather than because the job ended. */
  matched?: boolean;
  /** The same disclosure as on `SandboxResult`: this job's program was inline, so the jail did not see it. */
  codeExecution?: CodeExecutionOnCommandLine;
  found: boolean;
}

/**
 * Why a job was killed.
 *
 * Recorded rather than collapsed into "killed", because the remedies differ: `lifetime` means the
 * job ran longer than this sandbox allows and the work has to be split, `capacity` means too many
 * jobs are open, and `user` is a decision someone made.
 */
export type SandboxJobKillReason = 'timeout' | 'lifetime' | 'capacity' | 'user' | 'shutdown';

