import type {
  SheConfig,
  LLMProvider,
  LLMMessage,
  MessageImage,
  ToolDefinition,
  StreamChunk,
  ConfirmTicketInfo,
  PendingPatchInfo,
  ContextWindowInfo,
} from '@she/shared';
import { createLogger, resolveModel, resolveSubagentModel, describeModel, resolveContextWindow, describeContextWindow } from '@she/shared';
import type { GroupKBEngine } from '@she/kb';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { classifyLlmFailure, failureLabel } from './providers/stream-failure.js';
import { getSystemPrompt, readSkillProfile } from './system-prompt.js';
import type { ToolSet } from '@she/sandbox';
import { PendingPatchStore, CheckpointStore, resolveInsideWorkspace } from '@she/sandbox';
import { createKBTools } from './kb-tools.js';
import { createPlanTools, planAutopilot } from './plan-tools.js';
import { createPreflightTools, PreflightStore } from './preflight.js';
import type { PreflightRecord } from './preflight.js';
import {
  ErrorBook, createErrorbookTools, isWorthRemembering, formatErrorEntry,
  EXPECT_FAILURE_ARG, isIntentionalFailure, withExpectFailureParam,
} from './errorbook.js';
import type { ErrorbookEngineLike, ErrorbookStoreLike, ErrorbookKind } from './errorbook.js';
import { classifyToolResult, annotateToolResult, isToolFailure, type ToolResultVerdict } from './tool-result.js';
import {
  budgetToolResultOnArrival, fitToolResultsToBudget, spillToolOutput, TOOL_RESULT_CONTEXT_CHARS,
  type ArrivedToolResult,
} from './tool-output.js';
import { describeWaiting, type PendingWait } from './pending-wait.js';
import {
  DEFAULT_BUDGET,
  budgetStop,
  parseBudgetLimits,
  renderBudgetStop,
  type BudgetLimits,
  type BudgetStop,
  type BudgetUsage,
} from './budget.js';
import { isReadOnlyTool, queryKey, readsToPrefetch, inWaves } from './read-batch.js';
import { LspManager, makeLspTools, executeLspTool } from './lsp-tools.js';
import { makeScheduleTools, executeScheduleTool } from './schedule-tools.js';
import type { ScheduleBridge, WindowView } from './schedule-tools.js';
import { createIngestTools } from './ingest-tools.js';
import { createMemoTools } from './memo-tools.js';
import { createSkillTools } from './skill-tools.js';
import { createWebTools } from './web-tools.js';
import { createSubagentTools, type SubagentRunner } from './subagent-tools.js';
import { repairApiMessages } from './protocol.js';
import { RunTraceStore, type RunRecorder, type RunEvent } from './run-trace.js';
import {
  ConfidenceMirror,
  detectDrift,
  deriveReflections,
  createReflectionTools,
  renderCalibration,
  renderDrift,
  type DriftAction,
  type DriftReport,
} from './reflection.js';
import { reviewClaims, renderCriticReview, extractClaims, type CriticReview } from './critic.js';
import {
  guardrailPolicy,
  renderGuardrailNotice,
  scanOutbound,
  summariseFindings,
  type GuardrailFinding,
  type GuardrailPolicy,
} from './guardrail.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sessionStateDir, workspaceStateFile } from './session-state.js';
import {
  anchorsIn,
  appliedMessages,
  breakdownRequest,
  calibrateCharsPerToken,
  chooseCutIndex,
  CHARS_PER_TOKEN,
  digestSourceText,
  estimateRequest,
  fingerprint,
  isContextOverflowError,
  keepTokensFor,
  retrievalAnchors,
  summarizeExtractively,
  userLinesExcerpt,
  toolResultBudgetChars,
  windowFromOverflowError,
  DIGEST_MAX_CHARS,
  DIGEST_SOURCE_MAX_CHARS,
  MIN_DIGEST_CHARS,
  type CompactionState,
} from './compaction.js';

/** Tool calls one plan step may take before the reflection check calls the plan over budget. */
export const TOOL_CALLS_PER_PLAN_STEP = 8;

/*
 * Token 估算的换算比现在只有一处定义（`compaction.ts` 的 `CHARS_PER_TOKEN`，取值与实测出处记在
 * 那里）：压缩用它判断"该不该压"，这个文件的成本对账用它报数。两处各写一遍就会分叉，而分叉的
 * 方向恰好是"面板说还有余量、压缩那边说已经超了" —— 那种不一致最后以"会话卡死"的形式落到用户
 * 头上，而两边的代码各自看着都对。
 */

const log = createLogger('agent');

/**
 * 让模型写摘要时给它的指令。
 *
 * 逐条点名"必须保留什么"而不是笼统地说"总结一下"：这份摘要要在原文离开上下文之后替原文说话，
 * 而对话继续下去最需要的是决定、约束、文件路径、坑与没用完的下一步 —— 一份写成读后感的中文摘要
 * 恰好把这些都丢掉。
 */
const DIGEST_INSTRUCTION = `把下面这段对话记录压缩成一份摘要，供之后继续这场对话时使用。
必须保留：用户的要求、约束与偏好；已经做出的决定和它们的理由；动过或读过的重要文件路径与命令；
发现的坑与失败；还没做完的事和下一步。不要加入原文里没有的信息，不要评价，不要写成"我建议"。
用紧凑的条目写，长度不超过 800 字。`;

/**
 * A turn is already running for this conversation.
 *
 * A distinct type rather than a bare Error so the server can answer 409 (the request
 * conflicts with current state) instead of 500 (the request itself was wrong). The
 * distinction matters to a client: 409 is retryable once the turn finishes, 500 is
 * not.
 */
export class TurnInProgressError extends Error {
  constructor(message = '这一轮对话还在进行中。请等它结束，或使用「追加」把内容接在后面。') {
    super(message);
    this.name = 'TurnInProgressError';
  }
}

export class Agent {
  private provider: LLMProvider;
  private fallbackProvider: LLMProvider | null = null;
  /**
   * The endpoint that answered the CURRENT turn, when it was not the primary.
   *
   * Reset in `beginRun`, written on the switch, and read once when the run closes. Kept as one
   * value rather than a counter because the question a reader asks is not "how many rounds" but
   * "was this answer produced by the model I configured" — and a run where the spare answered
   * one round out of nine still has that answer in it.
   */
  private runFallback: { from: string; to: string; reason: string } | null = null;
  private history: LLMMessage[] = [];
  // reasoning_tokens is tracked because the thinking-level slider is only
  // verifiable if its effect (a separate reasoning budget) is visible.
  // Cache counters are tracked because a prompt-cache regression is otherwise
  // invisible until the bill arrives — see docs/context-and-caching.md.
  private tokenUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
  };
  /**
   * The spend of the run currently open, reset in `beginRun`.
   *
   * `tokenUsage` above is the agent's lifetime total, which is what a cost API wants and what a
   * single conversation mostly is. It is the WRONG number for a run trace: reading a trace back,
   * one turn appeared to have cost 3.2M prompt tokens, when 3.2M was everything that session had
   * ever spent. The number was not merely imprecise, it pointed at the wrong turn — and a report
   * that points at the wrong turn cannot be acted on.
   */
  private runUsage = {
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
  };
  private allToolDefs: ToolDefinition[] = [];
  /** Code intelligence; null when no language server is installed. */
  private lsp: LspManager | null = null;
  /** What has gone wrong in this workspace before; written by the loop, read by the model. */
  private errorBook: ErrorBook;
  /**
   * Notified after every tool call with its name, duration, and whether it failed.
   *
   * A callback rather than a counter so agent-runtime stays free of any dependency
   * on where metrics are collected.
   */
  private toolObserver: ((name: string, ms: number, failed: boolean) => void) | null = null;

  /** Observe tool calls. Used by the server to expose usage metrics. */
  setToolObserver(fn: ((name: string, ms: number, failed: boolean) => void) | null): void {
    this.toolObserver = fn;
  }
  private executors: Map<string, (args: Record<string, unknown>) => Promise<string>> = new Map();
  private systemPrompt: string;
  private lastPending: {
    ticket: ConfirmTicketInfo; toolCallId: string; name: string; args: Record<string, unknown>;
    /** The model marked this call `expect_failure`; carried so the confirmed run is not recorded either. */
    expectFailure?: boolean;
  } | null = null;
  private lastPatch: PendingPatchInfo | null = null;
  private patches: PendingPatchStore;
  private checkpoints: CheckpointStore;
  /**
   * User messages supplied while a turn is already running. Drained into the
   * conversation at the next tool-loop iteration so the user can add context
   * without stopping the agent.
   */
  private pendingInterjections: string[] = [];

  /** This conversation's plan store, read by the plan autopilot at the end of each model reply. */
  private planStore?: ReturnType<typeof createPlanTools>['store'];

  /**
   * 本会话最新的一条预检记录；没有会话就是 undefined。
   *
   * 预检记录按会话存（`.she/sessions/<id>/preflight/`），所以这里既不需要也不接受"会话"参数 ——
   * 目录本身就是这个会话的。没有会话时返回 undefined（"还没分析过"），而不是去读别人的。
   */
  private preflightRecord(): PreflightRecord | undefined {
    return this.sessionId
      ? new PreflightStore(this.config.workspace.root, this.sessionId).latest()
      : undefined;
  }

  /**
   * Sink for tool-originated stream events during the current turn. Set on
   * entry to each public method and cleared in a finally block.
   */
  private toolEventSink: ((chunk: StreamChunk) => void) | null = null;
  /** Whether this request has already been told about still-running background jobs. */
  private jobsNoticeSent = false;
  /** Delegation runner; null means this agent cannot spawn children. */
  private subagentRunner: SubagentRunner | null = null;
  /** Scheduling bridge; null means this agent cannot schedule work. */
  private scheduleBridge: ScheduleBridge | null = null;
  /** Applies a working-window change. Injected by the server, which owns config. */
  private setScheduleWindow: ((w: WindowView | null) => Promise<void> | void) | null = null;
  /** True when this agent is itself a delegated child (see constructor opts). */
  private isSubagent = false;
  /**
   * True when the KB this agent holds belongs to someone else (see constructor opts).
   *
   * Kept on the instance, not only passed to the tool factory, because the tool factory is not the
   * only writer: the error book and the end-of-turn self-review write through the engine directly.
   * The measured leak was a read-only child filing three entries into the PARENT's book — two
   * "unknown tool" (its own missing tools, see `getSystemPrompt`) and one false goal drift. A
   * promise of "you may read, not write" that only the tool layer keeps is not a promise.
   */
  private kbReadOnly = false;
  /** Optional sink for TaskCards (server-owned board). */
  private onTaskEvent: ((e: { id: string; kind: string; label: string; phase: 'running' | 'done' | 'error'; detail?: string }) => void) | null = null;
  private taskIdByLabel = new Map<string, string>();
  /**
   * The user message that opened the current turn.
   *
   * Kept so `preflight_record` can analyse what was ACTUALLY said rather than what the
   * model says was said — a tool argument is the model's paraphrase, and the deterministic
   * half of the analysis exists precisely to not depend on that.
   *
   * Set by `chat()` only, not by `interject()`: an appended note is extra context, not a
   * new request, and re-analysing on every interjection would report drift that is not
   * there.
   */
  private lastUserRequest = '';
  /**
   * The run trace for the turn in flight.
   *
   * One file per user request, spanning the human gate: a run that stops for a confirmation is
   * PAUSED rather than finished, and the continuation after the user approves keeps appending to
   * the same file. Splitting it would hide the one thing a reader most wants to see — that the
   * dangerous step was approved by a person and what happened next.
   */
  private runRecorder: RunRecorder | null = null;
  /** Set while the run is stopped at a gate, cleared when the continuation resumes it. */
  private runPaused: 'confirm' | 'apply' | null = null;
  /** How this run ended, when it did not simply finish. Read by the `end` event. */
  private runFailure: { reason: string; text?: string } | null = null;
  private runStartedAt = 0;
  /** Depth of continuations holding the trace open across several `withTurn` scopes. */
  private runHold = 0;
  /**
   * Where run traces are written, or null for an agent with no conversation.
   *
   * Null is not a degraded mode: an agent built without a session id is the read-only status path
   * (`/api/chat/running` and friends), which answers from an agent's in-memory state and never runs
   * a turn. There is no turn to trace, and — since a trace is per conversation — nowhere private to
   * put one. A trace must never fall back to a shared directory, so "no session" means "no trace"
   * rather than "somewhere everyone can read it".
   */
  private readonly runTrace: RunTraceStore | null;
  /**
   * This run's tool events, kept in memory alongside the file.
   *
   * The critic needs them at the END of the turn, after the recorder has been closed, and the
   * recorder's own copy is on disk by then. Capturing the events as `tool()` returns them costs a
   * push and avoids re-reading and re-parsing a file the process just wrote — while that file is
   * still the record of authority for anyone reviewing the run later.
   */
  private runEvents: RunEvent[] = [];
  /**
   * The confidence mirror: stated confidence against measured tool success.
   *
   * One per agent. Its verdict comes from `.she/reflection/confidence.json`, a workspace-wide ledger
   * of NUMBERS only, so a bias is visible across sessions rather than resetting whenever the process
   * restarts; its per-topic detail comes from this conversation's own samples under
   * `.she/sessions/<id>/`, which are the only ones that carry the task text.
   */
  private readonly confidenceMirror: ConfidenceMirror;
  /** The newest pre-flight record for the current run, kept for its stated confidence. */
  private runPreflightConfidence: { confidence: number; clamped: boolean; topic?: string } | null = null;
  /** The last self-review's reports, for the API and the UI. */
  private lastReflection: {
    at: string;
    drift: DriftReport;
    calibration: ReturnType<ConfidenceMirror['report']>;
    written: string[];
  } | null = null;
  /** The critic's reading of the last run's answer. */
  private lastCritic: CriticReview | null = null;
  /**
   * The outbound guardrail's reading of the last answer.
   *
   * Kept as findings rather than as a string so the API can report it structurally, and so nothing
   * downstream has to re-parse a rendered message to find out what was found.
   */
  private lastGuardrail: { at: string; findings: GuardrailFinding[]; policy: GuardrailPolicy } | null = null;
  /** Every finding this process has reported, for `GET /api/guardrail`. Values are masked. */
  private guardrailHistory: GuardrailFinding[] = [];
  /**
   * The calibration block for the turn in flight.
   *
   * Held as a field rather than recomputed in `messagesForRequest()` so every iteration of one turn
   * sends the identical system message — the prefix cache depends on it.
   */
  private calibrationBlock = '';
  /**
   * Set once the calibration block has been built with something to say.
   *
   * See `beginRun`: a block that changes between turns costs half the request, because it sits at
   * the head of the cache prefix. Frozen for the lifetime of the agent, so the reading is one
   * conversation behind — the numbers behind it are accumulated across conversations and move
   * slowly, and a stable prefix is worth more than a fresher sentence.
   */
  private calibrationFrozen = false;
  /**
   * The system message last written to this session's `system-message.json` (see
   * `restoreFrozenSystemMessage`), so it is written when it changes and not on every request.
   */
  private persistedSystemMessage: string | null = null;
  /** Memo for the `request` event's prefix hash; the inputs rarely change within an agent. */
  private prefixHashMemo: { system: string; tools: ToolDefinition[]; count: number; hash: string } | null = null;
  /** Set once the fixed overhead has been logged for this agent. See `beginRun`. */
  private overheadNoticed = false;
  /** `provider/model`, recorded on the `start` event so a trace says which model was answering. */
  private readonly modelLabel: string;
  /** `provider/model` of the spare, for the trace and the status line. Null when none is configured. */
  private readonly fallbackLabel: string | null = null;
  /**
   * 一次请求的上限，以及它是从哪来的（构造时解析）。
   *
   * 和模型名同一个道理，一条会话跑到一半换窗口会让"什么时候压"跟着变、前缀随之漂移。设置页改
   * 窗口走的是重建 agent（server 的 `structuralChange`）。
   *
   * **唯一的例外是"学到的"**：模型端拒绝一次超长请求时会在报文里写出真实上限
   * （`windowFromOverflowError`），那是证据而不是猜测，所以当场就把这个数改过来（并落盘）——
   * 它只影响"什么时候压"，不参与前缀，所以改它安全。
   */
  private contextWindow: ContextWindowInfo;
  /** 已冻结的压缩记录。null = 这条会话还没压过。 */
  private compactionState: CompactionState | null = null;
  /**
   * 正在压。防重入：压缩要调一次模型，而那次调用如果也失败，会再进一次这条路 —— 递归地压同一段
   * 历史，每一次都要重发一整份提示词。
   */
  private compacting = false;
  /** 工具表字符数的备忘：它在一轮里不变，而每轮重新序列化整张表是白花的 CPU。 */
  private overheadMemo: { tools: ToolDefinition[]; chars: number } | null = null;
  /**
   * "字符 → token"的换算比。默认是先验常量（3.47，实测值），之后按**真实用量**校准
   * （`observeCharsPerToken`）：换模型或换分词器会动它，而它是"什么时候压"的唯一输入。
   *
   * 它**不参与请求字节**，所以随时可以改 —— 这与窗口那一条同理（改的只是判断，不是前缀）。
   */
  private charsPerToken = CHARS_PER_TOKEN;
  /** 最近的观测样本（我们发的字符 ÷ 模型数的 token），保留有限条。 */
  private estimateSamples: number[] = [];
  /**
   * 即将发出的这次请求有多少字符。观测要用它，而它必须在**发请求之前**取 —— 压缩会改 messages，
   * 发出去的正是改过的那一份。
   */
  private pendingRequestChars = 0;
  /** 最近一次请求的估算 token（工具结果预算按"还剩多少余量"收紧时要用它）。 */
  private lastRequestTokens = 0;
  /** 这条会话压过几次。 */
  private compactions = 0;
  /** 压缩之后真的去读过被压掉的那份原文几次（衡量"取回"这条路有没有人走）。 */
  private retrievals = 0;
  /**
   * 等着量"压缩之后第一次请求实际付掉的未命中 token"。
   *
   * 这是这次压缩真正的代价，而它只能在紧接着的那一次请求里量到 —— 摘要一改，前缀从改的那一点起全部
   * 按未命中重算，provider 会把那个数报回来（`cache_miss_tokens`）。
   */
  private awaitingMissSample = false;
  /** Aborts the in-flight turn (LLM request + tool loop). */
  private aborter: AbortController | null = null;
  /**
   * True while a turn is executing, for ANY entry point.
   *
   * Separate from `aborter`, which only `chat()` sets — so `isRunning()` used to
   * report false while a patch-application loop was running, and nothing stopped a
   * second path from running the loop concurrently.
   */
  private turnActive = false;

  constructor(
    private config: SheConfig,
    kbEngine: GroupKBEngine,
    private sandboxTools: ToolSet,
    /** Conversation this agent serves; scopes per-chat state such as plans. */
    private sessionId: string | null = null,
    opts?: {
      /**
       * Enables `schedule_*` tools when provided.
       *
       * Injected because the task store belongs to the scheduler in the server,
       * and both must see the same tasks — the agent creating its own store would
       * produce two files that overwrite each other.
       */
      scheduleBridge?: ScheduleBridge;
      /** Applies a working-window change; the server owns that config. */
      setScheduleWindow?: (w: WindowView | null) => Promise<void> | void;
      /**
       * Enables `task_spawn` when provided.
       *
       * Injected rather than imported: constructing a child agent needs the
       * server's tool wiring, and agent-runtime must not depend on that. Absent
       * means no delegation tool at all — which is exactly how a CHILD agent is
       * built, so recursion is structurally impossible rather than merely
       * guarded.
       */
      subagentRunner?: SubagentRunner;
      /** UI TaskCards sink (background long-task progress). */
      onTaskEvent?: (e: { id: string; kind: string; label: string; phase: 'running' | 'done' | 'error'; detail?: string }) => void;
      /**
       * Marks this agent as a delegated child.
       *
       * Children run unattended, so `ask_user` is removed: a question nobody
       * can answer would stall the subtask until its timeout. They also must
       * not write shared artifacts (reports, plans) that the parent owns.
       */
      isSubagent?: boolean;
      /**
       * Where run traces are written.
       *
       * Injectable so a test can use a throwaway path. The default is the agent's OWN session
       * directory — not one directory for the process — because a trace holds the prompt, every
       * command and its output. A turn that leaves no trace is the gap this closes, so making it
       * opt-in would mean the runs people most want to read are the ones that were never recorded;
       * the only thing that turns it off is having no session to write it under.
       */
      runTrace?: RunTraceStore;
      /**
       * This agent shares someone else's live KB and may only read it.
       *
       * Set for a delegated child that did NOT get an isolated worktree — it is pointed straight at
       * the parent's database, so a `kb_upsert` would be a permanent, unreviewed edit to the
       * parent's memory. Read-only children are the common case (isolation only follows a declared
       * `scope`), which is exactly why this needed to be explicit rather than assumed.
       *
       * A child with its OWN snapshot (the worktree case) is not read-only: those writes land in
       * the copy and die with it, so they cannot reach the parent either way.
       */
      kbReadOnly?: boolean;
    },
  ) {
    this.subagentRunner = opts?.subagentRunner ?? null;
    this.onTaskEvent = opts?.onTaskEvent ?? null;
    this.isSubagent = Boolean(opts?.isSubagent);
    this.kbReadOnly = opts?.kbReadOnly === true;
    /*
     * The run trace is built here rather than in the field initialiser so the workspace root is
     * already available, and so a subagent gets one too: "who did which step" is a question the
     * trace can answer about delegated work, and a child's file records `agent: "subagent"`.
     *
     * The child's trace lands in the CHILD's session directory, which is the same place its
     * transcript goes — an isolated child's whole `.she` is archived under
     * `.she/subagent-history/<child id>/` when its worktree is reclaimed, so the steps survive the
     * copy being deleted. Keying it by the parent instead would also mean a run recorded under
     * someone else's session id, which the store now refuses.
     */
    this.runTrace = opts?.runTrace ?? (this.sessionId ? new RunTraceStore(config.workspace.root, this.sessionId) : null);
    const level = config.llm.thinkingLevel || 'medium';
    /*
     * Which model this agent talks to.
     *
     * A subagent resolves through `resolveSubagentModel`, so delegating mechanical
     * work (grep, read, summarise) can use a cheaper model than the main reasoning
     * loop. Everything else resolves through the registry, which is also what makes
     * "add another vendor" a config change rather than a code change.
     */
    const resolution = this.isSubagent ? resolveSubagentModel(config) : { model: resolveModel(config) };
    if (resolution.warning) log.warn(resolution.warning);
    const chosen = resolution.model;
    /*
     * A literal name is normal when there is no registry (`SHE_MODEL=gpt-4o`), but
     * when a registry IS declared it usually means a mistyped id. We honour it —
     * changing the model under someone who asked for a specific name would be worse —
     * and say so, so the warning is in the log next to the provider's complaint.
     */
    if (!this.isSubagent && chosen.source === 'literal' && (config.llm.models?.length ?? 0) > 0) {
      log.warn(
        `模型「${chosen.model}」不在注册表里（可用: ${(config.llm.models ?? []).map((m) => m.id).join(', ')}）。`
        + '按字面模型名使用；如果这是打错了 id，请修正 SHE_MODEL。',
      );
    }
    log.info(`Model: ${describeModel(chosen)}`);
    this.modelLabel = `${chosen.provider}/${chosen.model}`;
    /*
     * 窗口在这里定下来，并且**来源一起报出来**：这个数字决定"什么时候压"，猜错了（尤其猜大）
     * 是用户唯一看不见、也最需要能怀疑的一件事。填错就能在这里改回来。
     */
    this.contextWindow = resolveContextWindow({
      configured: config.llm.contextWindow,
      envValue: process.env.SHE_CONTEXT_WINDOW,
      learned: this.learnedWindow(),
      model: chosen.model,
    });
    log.info(`上下文窗口 ${describeContextWindow(this.contextWindow)}`);
    this.restoreCompaction();
    this.restoreEstimateCalibration();

    if (chosen.provider === 'anthropic') {
      this.provider = new AnthropicProvider(
        chosen.apiKey, chosen.model,
        config.llm.maxTokens, config.llm.temperature,
      );
    } else {
      this.provider = new OpenAIProvider(
        chosen.apiKey, chosen.baseUrl, chosen.model,
        config.llm.maxTokens, config.llm.temperature, level,
      );
    }

    const fb = config.llm.fallback;
    if (fb && (fb.apiKey || fb.baseUrl) && (fb.model || fb.baseUrl)) {
      const fProvider = fb.provider || 'openai';
      const fKey = fb.apiKey || chosen.apiKey;
      const fModel = fb.model || chosen.model;
      const fBase = fb.baseUrl || chosen.baseUrl;
      if (fProvider === 'anthropic') {
        this.fallbackProvider = new AnthropicProvider(fKey, fModel, config.llm.maxTokens, config.llm.temperature);
      } else if (fKey || fBase) {
        this.fallbackProvider = new OpenAIProvider(fKey, fBase, fModel, config.llm.maxTokens, config.llm.temperature, level);
      }
      /*
       * The spare is labelled at construction, and only when the provider was actually built.
       *
       * A label derived later from `config.llm.fallback` would name a model that may not exist: the
       * branch above can decline to construct one (no key and no base URL), and `fallback.model`
       * defaults to the primary's, so reading the config would report a spare that was never
       * instantiated. The label is what a trace prints, so it has to be true.
       */
      if (this.fallbackProvider) this.fallbackLabel = `${fProvider}/${fModel}`;
    }

    this.systemPrompt = getSystemPrompt(
      config.workspace.root,
      undefined,
      config.automationMode !== false,
      // Both flags describe the same child: `subagent` trims the sections that instruct it to call
      // tools it does not have, `kbReadOnly` says which half of the KB it may use.
      { kbReadOnly: this.kbReadOnly, subagent: this.isSubagent },
    );
    this.patches = new PendingPatchStore(config.workspace.root);
    this.checkpoints = new CheckpointStore(config.workspace.root);
    /*
     * The error book.
     *
     * One instance per agent, all writing to the same KB — so a mistake recorded in one
     * conversation is readable in the next, which is the only version of this that is worth
     * building.
     *
     * It needs two halves of the KB: the engine (group maintenance, typed edges, retrieval) and
     * the store (the rows behind both). `store` is a private member of the engine, so it is
     * reached here through one structural cast and reused below — the same trick `kb-tools.ts`
     * uses, which keeps this factory decoupled from the kb package's class hierarchy.
     */
    const kbStore = (kbEngine as unknown as { store: ErrorbookStoreLike }).store;
    this.errorBook = new ErrorBook(
      kbEngine as unknown as ErrorbookEngineLike,
      kbStore,
    );
    /*
     * The mirror reads the workspace ledger (numbers only, so a verdict survives restarts) and this
     * conversation's own samples (which carry topics). Passing the session is what makes the second
     * half readable at all — and what keeps another conversation's task text unreachable from here.
     */
    this.confidenceMirror = new ConfidenceMirror(config.workspace.root, this.sessionId);
    /*
     * Built here, not at the first turn, so `getSystemPromptText()` describes what this agent will
     * actually send before it has sent anything.
     *
     * The cost guard (`evals-check`, `check:cost`) measures the fixed overhead through that method
     * on a fresh agent. Building lazily made the reading depend on whether a turn had already run:
     * the same agent reported 26,750 characters before its first turn and 27,455 after, and the
     * smaller number is the one a budget check would have compared against a real request. A cost
     * reading that under-reports by the size of a block is a check that cannot see that block
     * growing.
     */
    this.calibrationBlock = this.buildCalibrationBlock();
    this.calibrationFrozen = this.calibrationBlock !== '';
    // An existing session keeps the exact system message it has been sending. See the method.
    this.restoreFrozenSystemMessage();

    for (const def of this.sandboxTools.definitions) {
      // `shell` is where intentional failures (a test run to watch it fail) happen, so it advertises
      // the error book's `expect_failure` switch; every tool honours it (see `recordMistake` callers).
      this.allToolDefs.push(def.name === 'shell' ? withExpectFailureParam(def) : def);
      /* 读调用时的 aborter：executor 是构造时注册的，而 aborter 每轮新建 —— 这样「停止」能打断工具里的等待。 */
      this.executors.set(def.name, (args) => this.sandboxTools.execute(def.name, args, { signal: this.aborter?.signal }));
    }

    /*
     * 联网查资料。默认就有（见 config 里 `web` 的注释），`SHE_WEB_PROVIDER=off` 时**照样注册** ——
     * 两个工具会拒绝并说清楚改哪个变量能开回来。让它们凭空消失，模型会把"有人关了它"读成"这台机器
     * 不能联网"，然后放弃这件事而不是提出来。
     */
    const webTools = createWebTools(config.web);
    for (const def of webTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => webTools.execute(def.name, args));
    }

    const kbTools = createKBTools(kbEngine, {
      onQueryResult: (result) => {
        this.toolEventSink?.({ type: 'kb_result', kbResult: result });
      },
      readOnly: opts?.kbReadOnly === true,
    });
    for (const def of kbTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => kbTools.execute(def.name, args));
    }

    // Scheduling: the agent's own future work. Only when the server supplied a
    // bridge — the store lives there and both sides must see the same tasks.
    if (opts?.scheduleBridge) {
      this.scheduleBridge = opts.scheduleBridge;
      this.setScheduleWindow = opts.setScheduleWindow ?? null;
      for (const def of makeScheduleTools(opts.scheduleBridge, this.sessionId)) {
        this.allToolDefs.push(def);
        this.executors.set(def.name, async (args) => {
          const r = await executeScheduleTool(
            def.name, args, opts.scheduleBridge!, this.sessionId, this.setScheduleWindow ?? (() => {}),
          );
          return r ? r.output : `未知工具 ${def.name}`;
        });
      }
    }

    /*
     * 长任务工具：可持久化的计划、报告产物、以及反问。
     *
     * 没有会话就没有这套工具 —— 不给它兜底。计划/备忘按会话分文件（`sessionStateDir`），所以一个
     * "没有会话的 agent"根本没有可以归属的文件；给它一个共享文件就是这一层要根除的形态。什么时候会出现
     * 无会话的 agent：只读状态路由（`/api/chat/running` 这类）故意不创建会话，而那些 agent 从不跑回合，
     * 也就永远不需要这些工具。
     */
    const planTools = this.sessionId ? createPlanTools(config.workspace.root, this.sessionId) : null;
    this.planStore = planTools?.store;
    for (const def of planTools?.definitions ?? []) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => planTools!.execute(def.name, args));
    }

    /*
     * Pre-flight intent analysis. Registered next to the plan tools because they are used
     * together — analyse the request, then write the plan that implements it.
     *
     * 预检记录里有用户的请求原文，按会话存（`.she/sessions/<id>/preflight/`），所以没有会话就不注册
     * 这套工具：不存在"没有会话的预检记录"这种东西，也不给兜底目录。
     *
     * `listTools` reads `allToolDefs` lazily. At construction time the list is only half
     * built, so a snapshot taken here would under-report what this agent has and invent
     * missing prerequisites for tools that are in fact registered a few lines below.
     */
    const preflightTools = this.sessionId ? createPreflightTools(config.workspace.root, {
      sessionId: this.sessionId,
      getRequest: () => this.lastUserRequest,
      listTools: () => this.allToolDefs.map((d) => d.name),
      skillProfile: () => readSkillProfile(config.workspace.root),
      automationMode: () => config.automationMode !== false,
      activePlanGoal: () => planTools?.store.active()?.goal,
      knownErrors: (query) => this.errorBook
        .lookup({ query, limit: 3 })
        .map((e) => formatErrorEntry(e)),
    }) : null;
    for (const def of preflightTools?.definitions ?? []) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => preflightTools!.execute(def.name, args));
    }

    // The read side of the error book: what has gone wrong here before. Registered next to
    // pre-flight because that is when it is useful — before the work, not after.
    const errorbookTools = createErrorbookTools(this.errorBook);
    for (const def of errorbookTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => errorbookTools.execute(def.name, args));
    }

    /*
     * Self-review, as a tool the model can call mid-task.
     *
     * Read-only by construction: it reports drift and calibration and cannot touch the plan or the
     * goal. Left to the model's judgement when to call rather than run on a timer, because the
     * interesting moments (a phase finished, several steps without progress, about to say "done")
     * are things only the agent can recognise from the inside.
     */
    const reflectionTools = createReflectionTools({
      /*
       * This conversation's own analysis, never the workspace's newest.
       *
       * `latest()` here is how a child ended up measured against the parent's goal (and how a
       * fresh chat would be measured against the previous chat's): the record is the yardstick,
       * so a record written for a different request turns the check into a false accusation.
       */
      goal: () => {
        const rec = this.preflightRecord();
        return rec?.actual_goal || rec?.stated_intent || planTools?.store.active()?.goal || null;
      },
      // Inferred constraints are passed as SOFT: pre-flight derived them from the request and the
      // workspace rather than from the user's words, and treating a derived preference as a hard
      // prohibition would report drift for ordinary work.
      constraints: () => {
        const rec = this.preflightRecord();
        return (rec?.inferred_constraints ?? []).map((text: string) => ({ text, hardness: 'soft' as const }));
      },
      actions: () => this.currentRunActions(),
      currentStep: () => planTools?.store.active()?.steps.find((s) => s.status === 'active')?.title ?? null,
      budget: () => {
        const plan = planTools?.store.active();
        /*
         * Same unit on both sides. This used to compare tool CALLS (35) against plan STEPS (9) and
         * report an overrun on almost every real plan, since one step routinely takes several calls.
         * The budget is now calls too: a generous allowance per live step, so it only fires when
         * the work has clearly outgrown the plan it was given.
         */
        const live = plan ? plan.steps.filter((s) => s.status !== 'dropped').length : 0;
        return {
          used: this.runEvents.filter((e) => e.kind === 'tool').length,
          limit: plan && live ? live * TOOL_CALLS_PER_PLAN_STEP : undefined,
        };
      },
      calibration: () => this.confidenceMirror.report(),
      // The real tool table, so a constraint naming a tool is matched against the tool called (read lazily).
      toolNames: () => this.allToolDefs.map((d) => d.name),
    });
    for (const def of reflectionTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => reflectionTools.execute(def.name, args));
    }

    // Code intelligence. Only registered when a language server is actually
    // installed for this workspace's languages — advertising a tool that always
    // fails wastes a round-trip and teaches the model to distrust the tool list.
    this.lsp = new LspManager(config.workspace.root);
    for (const def of makeLspTools(config.workspace.root, this.lsp)) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, async (args) => {
        const r = await executeLspTool(def.name, args, config.workspace.root, this.lsp!);
        return r ? r.output : `未知工具 ${def.name}`;
      });
    }

    // Knowledge ingestion: stage files, then file each item into the tree.
    const ingestTools = createIngestTools(
      config.workspace.root,
      kbEngine as unknown as Parameters<typeof createIngestTools>[1],
      kbStore as unknown as Parameters<typeof createIngestTools>[2],
    );
    for (const def of ingestTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => ingestTools.execute(def.name, args));
    }

    // Shared scratchpad, editable by both the user and the agent.
    /*
     * 备忘是**工作区级**的（`.she/memo.json`）：一个项目一份，项目里的会话共用，所以不再需要 sessionId。
     * 跨工作区仍然读不到 —— 另一个工作区有自己的 `.she/`。
     */
    {
      const memoTools = createMemoTools(config.workspace.root);
      for (const def of memoTools.definitions) {
        this.allToolDefs.push(def);
        this.executors.set(def.name, (args) => memoTools.execute(def.name, args));
      }
    }

    /*
     * Skills are loaded on demand: the system prompt carries only an index (name + one-line purpose)
     * and `skill_read` returns a recipe's full text. Same profile and same child filter as the
     * prompt, so every name in the index is readable and a child never reads a step through a tool
     * it does not have. Not registered when the profile has no skills at all.
     */
    {
      const skillTools = createSkillTools(config.workspace.root, readSkillProfile(config.workspace.root), {
        subagent: this.isSubagent,
      });
      for (const def of skillTools.definitions) {
        this.allToolDefs.push(def);
        this.executors.set(def.name, (args) => skillTools.execute(def.name, args));
      }
    }

    // Delegation. Only registered when a runner was injected — a child agent is
    // constructed without one, so it cannot recurse.
    if (this.subagentRunner) {
      const subTools = createSubagentTools(this.subagentRunner, {
        onProgress: (e) => {
          let id = this.taskIdByLabel.get(e.description);
          if (e.phase === 'start' || !id) {
            id = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            this.taskIdByLabel.set(e.description, id);
          }
          /*
           * A tick updates the card and NOTHING else.
           *
           * The card is the right home for it: it is made to be replaced in place, so a reading
           * every few seconds costs the reader nothing. A transcript line would not be — one status
           * entry per tick would bury the conversation the subtask was spawned from, which is the
           * opposite of the visibility this is for.
           */
          if (e.phase === 'heartbeat') {
            const secs = Math.round((e.elapsedMs ?? 0) / 1000);
            const card = {
              id,
              kind: 'subagent',
              label: e.description,
              phase: 'running' as const,
              detail: `第 ${e.steps ?? 0} 步 · ${e.activity ?? '工作中'} · 已 ${secs}s`,
            };
            this.onTaskEvent?.(card);
            return;
          }
          const phase = e.phase === 'start' ? 'running' as const : (e.ok ? 'done' as const : 'error' as const);
          const card = { id, kind: 'subagent', label: e.description, phase };
          this.onTaskEvent?.(card);
          this.toolEventSink?.({
            type: 'status',
            content: e.phase === 'start'
              ? `子智能体开始：${e.description}`
              : `子智能体${e.ok ? '完成' : '失败'}：${e.description}`,
            task: card,
          });
          if (e.phase === 'done') this.taskIdByLabel.delete(e.description);
        },
      });
      for (const def of subTools.definitions) {
        this.allToolDefs.push(def);
        this.executors.set(def.name, (args) => subTools.execute(def.name, args));
      }
    }

    /*
     * Children run unattended, so they lose the tools that assume a human is
     * present or that mutate state owned by the parent:
     *   ask_user   — nobody can answer; the subtask would stall until timeout
     *   task_spawn — recursion (the runner is already absent, this is belt-and-braces)
     *   plan_*     — the parent owns the plan; a child editing it would clobber it
     *   preflight_*— the analysis describes the PARENT's request, not the subtask, so a
     *                child running it would file a record about someone else's goal
     *   memo_*     — shared scratchpad, same reasoning
     *   report_*   — long-lived artifacts belong to the parent's turn
     *   kb_ingest_*— staging files is a side effect the parent should decide on
     *   schedule_* — a child must not be able to schedule the parent's future work
     *   reflection_check — same reasoning as `preflight_*`, which it reads: the goal it compares
     *                against is the PARENT's, so a child would be told it had drifted away from a
     *                request it was never given
     */
    if (this.isSubagent) {
      const denied = /^(ask_user|task_spawn|plan_|preflight_|reflection_|memo_|report_|kb_ingest_|schedule_)/;
      this.allToolDefs = this.allToolDefs.filter((d) => {
        const blocked = denied.test(d.name);
        if (blocked) this.executors.delete(d.name);
        return !blocked;
      });
    }
  }

  /**
   * Queue a user message to be folded into the running turn at the next
   * iteration. Used for "append context without interrupting".
   *
   * The text lands in `history` immediately (so it is persisted and visible
   * even if no turn is running); `pendingInterjections` only controls when it
   * is injected into the in-flight request array.
   */
  interject(text: string): void {
    const t = String(text ?? '').trim();
    if (!t) return;
    /*
     * A running turn must not write this into history yet.
     *
     * The old code appended it immediately. If the model had just emitted tool
     * calls and the results were not stored yet, the user line landed BETWEEN
     * the call and its results. The next request is then illegal (a tool call
     * with no adjacent result), and draining the same text into the request
     * array duplicated it.
     *
     * Queue it. It is written once, at a point where the tool group is closed.
     * With no turn running there is nowhere to queue for, so it goes straight
     * into the transcript.
     */
    if (!this.turnActive) {
      this.history.push({ role: 'user', content: `[用户补充] ${t}` });
      return;
    }
    this.pendingInterjections.push(t);
  }

  /** Move queued interjections into history and the live request, once. */
  private drainInterjections(messages: LLMMessage[], onChunk?: (chunk: StreamChunk) => void): void {
    if (this.pendingInterjections.length === 0) return;
    // A tool call that does not yet have its results cannot have a user
    // message pushed after it. Wait for the for-loop to finish.
    if (this.hasOpenToolCalls()) return;
    const pending = this.pendingInterjections.splice(0, this.pendingInterjections.length);
    for (const text of pending) {
      const msg: LLMMessage = { role: 'user', content: `[用户补充] ${text}` };
      this.history.push(msg);
      messages.push(msg);
      onChunk?.({ type: 'status', content: `已追加补充信息：${text.slice(0, 80)}` });
    }
  }

  /** Keep supplements that arrived after the last model call. */
  private flushInterjections(): void {
    if (this.pendingInterjections.length === 0) return;
    if (this.hasOpenToolCalls()) return;
    const pending = this.pendingInterjections.splice(0, this.pendingInterjections.length);
    for (const text of pending) {
      this.history.push({ role: 'user', content: `[用户补充] ${text}` });
    }
  }

  /** True when an assistant tool call is still waiting for its results. */
  private hasOpenToolCalls(): boolean {
    for (let i = 0; i < this.history.length; i++) {
      const m = this.history[i];
      if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
      const need = new Set(m.tool_calls.map((t) => t.id));
      let j = i + 1;
      while (j < this.history.length && this.history[j].role === 'tool') {
        const id = this.history[j].tool_call_id;
        if (id) need.delete(id);
        j++;
      }
      if (need.size > 0) return true;
      i = j - 1;
    }
    return false;
  }

  private async runLoop(
    messages: LLMMessage[],
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<LLMMessage> {
    let iterations = 0;
    /**
     * No product quota on how long a turn may work.
     *
     * An earlier cap stopped real tasks mid-way. The loop ends when the model
     * stops, the user aborts, or the same call is stuck. SHE_MAX_TOOL_ROUNDS is
     * only for evals that want a bound.
     */
    const rawCap = Number(process.env.SHE_MAX_TOOL_ROUNDS);
    const maxIterations = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : Number.POSITIVE_INFINITY;
    let turnPromptTokens = 0;
    const signal = this.aborter?.signal;

    /*
     * ─── Turn budget (opt-in) ───
     *
     * Read per turn, not per process, so a ceiling edited in `she.config.yaml` applies to the
     * next turn instead of the next restart. With the default config `budgetStop` returns null
     * on every input, so none of the checks below can change what this loop does.
     */
    const budget = this.budgetLimits();
    const turnStartedAt = Date.now();
    /** Consumption for THIS turn: `iterations` is already per-turn, but tokens and tool calls were not. */
    let turnTokens = 0;
    let turnToolCalls = 0;
    const usageNow = (over: Partial<BudgetUsage> = {}): BudgetUsage => ({
      rounds: iterations,
      toolCalls: turnToolCalls,
      tokens: turnTokens,
      elapsedSeconds: (Date.now() - turnStartedAt) / 1000,
      ...over,
    });

    /*
     * ─── Read-only reuse (Batch I) ───
     *
     * Scoped to the turn and thrown away with it. Cleared whenever a call that can change
     * something runs, because a cached read is only the same answer while nothing has changed;
     * the residual gap is an edit made outside SHE during the turn, which no cache inside the
     * process can see.
     */
    const readCache = new Map<string, string>();

    /*
     * Repeated-call detection.
     *
     * `maxIterations` only catches a loop that never ends. The failure mode that
     * actually burns budget is a loop that is *stuck*: the model calls the same tool
     * with the same arguments and gets the same result, over and over, because it
     * believes the call has not happened yet. With a 1000-round guard that is
     * thousands of requests before anything stops it, and the user sees a spinner
     * rather than an error.
     *
     * The signature is tool + arguments + result, so a retry that finally succeeds
     * (same call, different result) is NOT flagged — only a call that produced
     * identical output again.
     */
    const callSignatures = new Map<string, { count: number; result: string }>();
    /*
     * Three by default. Two would flag a legitimate single retry (a flaky command,
     * a file that was being written); three means the model had two chances to
     * notice and changed nothing. Overridable for tests and for a workspace with
     * unusually slow or eventually-consistent tools.
     */
    const repeatLimit = Number(process.env.SHE_REPEAT_LIMIT) > 0
      ? Number(process.env.SHE_REPEAT_LIMIT)
      : 3;
    /**
     * Whether the model has already been told that it is stuck.
     *
     * One nudge, not a loop: a second identical call after being told explicitly
     * means the model cannot find its way out, and further rounds only spend money.
     */
    let recoveryAttempted = false;
    /**
     * 模型端因为"太长"拒绝过几次。
     *
     * 两次之后不再压：第三次压出来的东西和第二次几乎一样，而每压一次都要重发一整份提示词 ——
     * 那是拿钱换一个必然相同的结果。第二次保留得更少（keepScale=0.25），因为第一次没救回来的
     * 原因很可能是尾巴本身还太大。
     */
    let overflowCompactions = 0;

    /*
     * ─── Plan autopilot ───
     *
     * In automation mode a reply without tool calls no longer ends the turn while this chat's plan
     * still has runnable steps: the loop resumes it (see `planAutopilot` for when it hands back).
     * Two rounds in a row that leave every step status unchanged stop it, so a model that keeps
     * answering in prose cannot spin. SHE_PLAN_AUTOPILOT=0 turns it off; SHE_PLAN_AUTOPILOT_MAX caps
     * the resumes per turn (default 40).
     */
    const autopilotOn = this.config.automationMode !== false && process.env.SHE_PLAN_AUTOPILOT !== '0';
    const autopilotMax = Number(process.env.SHE_PLAN_AUTOPILOT_MAX) > 0 ? Number(process.env.SHE_PLAN_AUTOPILOT_MAX) : 40;
    let autopilotRounds = 0;
    let autopilotLastSig = '';
    let autopilotStalls = 0;

    while (iterations < maxIterations) {
      if (signal?.aborted) {
        this.history = repairApiMessages(this.history);
        this.flushInterjections();
        const stopped: LLMMessage = { role: 'assistant', content: '（已中断）' };
        onChunk?.({ type: 'status', content: '已中断当前执行' });
        this.history.push(stopped);
        // The turn ended because a person pressed stop, which is neither success nor failure. It
        // is recorded as a reason on the closing event instead of an `error`, so the trace does not
        // read as if the agent broke.
        this.runFailure = { reason: 'aborted' };
        this.runRecorder?.step('已中断当前执行');
        return stopped;
      }
      /*
       * Before paying for another round: has the turn already used up its budget?
       *
       * Checked here rather than after the response because this is the last moment at which
       * stopping is free. `rounds` is the number of COMPLETED rounds, so a ceiling of 1 means
       * one model call and then stop.
       */
      const roundStop = budgetStop(budget, usageNow());
      if (roundStop) return this.endTurnForBudget(roundStop, onChunk);

      iterations++;
      log.debug(`Tool loop iteration ${iterations}`);

      // Fold in anything the user appended while this turn was running.
      this.drainInterjections(messages, onChunk);

      const track = (chunk: StreamChunk) => {
        if (chunk.type === 'usage' && chunk.usage) {
          this.tokenUsage.prompt_tokens += chunk.usage.prompt_tokens || 0;
          this.tokenUsage.completion_tokens += chunk.usage.completion_tokens || 0;
          this.tokenUsage.total_tokens += chunk.usage.total_tokens || 0;
          this.tokenUsage.reasoning_tokens += chunk.usage.reasoning_tokens || 0;
          this.tokenUsage.cache_hit_tokens += chunk.usage.cache_hit_tokens || 0;
          this.tokenUsage.cache_miss_tokens += chunk.usage.cache_miss_tokens || 0;
          this.runUsage.prompt_tokens += chunk.usage.prompt_tokens || 0;
          this.runUsage.completion_tokens += chunk.usage.completion_tokens || 0;
          this.runUsage.total_tokens += chunk.usage.total_tokens || 0;
          this.runUsage.reasoning_tokens += chunk.usage.reasoning_tokens || 0;
          this.runUsage.cache_hit_tokens += chunk.usage.cache_hit_tokens || 0;
          this.runUsage.cache_miss_tokens += chunk.usage.cache_miss_tokens || 0;
          // One usage report per request, so this counter IS the number of model requests the run
          // made — the multiplier that turns "the prompt is big" into "the turn cost millions".
          this.runUsage.requests += 1;
          /*
           * One event per request, so a cache miss can be pinned to the request it happened on (the
           * `end` totals cannot say whether the misses were the first request of a resumed session
           * or spread over every round). `prefix` hashes what the cache key starts with.
           */
          this.runRecorder?.request({
            tokens: {
              prompt: chunk.usage.prompt_tokens || 0,
              cache_hit: chunk.usage.cache_hit_tokens || 0,
              cache_miss: chunk.usage.cache_miss_tokens || 0,
              completion: chunk.usage.completion_tokens || 0,
              ...(chunk.usage.reasoning_tokens ? { reasoning: chunk.usage.reasoning_tokens } : {}),
            },
            prefix: this.prefixHash(),
          });
          /*
           * 观测一次换算比：我们完全知道自己发了多少字符（`pendingRequestChars`），模型报回来的
           * `prompt_tokens` 就是真值。两者相除，就是这个模型/分词器下的"字符 → token"。
           *
           * 这是本仓库"用已有观测自校准"的那条路：换算比原本是写死的常量 + 文档里一句"换模型要人工
           * 重测"，而每次请求的 usage 里其实一直带着答案。
           */
          if (this.pendingRequestChars > 0 && (chunk.usage.prompt_tokens || 0) > 0) {
            this.observeCharsPerToken(this.pendingRequestChars, chunk.usage.prompt_tokens || 0);
          }
          /*
           * 压缩的账：付了多少、之后过了几轮。
           *
           * 两个数都来自**真实请求**：`rounds` 是压缩之后发出去的请求数（省下的量按"每次请求都省
           * 一份差值"累计），`paidTokens` 是紧接着那一次实际付掉的未命中（摘要一改前缀就重算一次）。
           * 它刻意不做任何外推：问的就是"这一次压缩，到目前为止划算吗"。
           *
           * `this.compacting` 期间不算 —— 那是生成摘要的那次调用，它属于压缩本身，不是"之后的一轮"。
           */
          if (!this.compacting && this.compactionState) {
            this.compactionState.rounds = (this.compactionState.rounds ?? 0) + 1;
            if (this.awaitingMissSample) {
              this.compactionState.paidTokens = chunk.usage.cache_miss_tokens ?? null;
              this.awaitingMissSample = false;
              this.persistCompaction();
            }
          }
          turnPromptTokens += chunk.usage.prompt_tokens || 0;
          /*
           * Per-turn total, for the budget ceiling. `total_tokens` is preferred but not trusted
           * to be present: a provider that reports only the parts would otherwise make the token
           * ceiling look permanently unreached — a limit that never fires is worse than none,
           * because the user believes it is protecting them.
           */
          turnTokens += chunk.usage.total_tokens
            || ((chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0));
        }
        /*
         * The agent's narration, recorded here because this is the one funnel every model-produced
         * chunk passes through — including the fallback path below, which bypasses `onChunk`
         * entirely by going through `track`.
         *
         * Only `status` is stored. `text` and `reasoning` are per-token: writing them would make
         * the run file larger than the transcript, and the final answer is already stored once, on
         * the closing event. A `status` line, by contrast, is the only place a decision like "the
         * primary endpoint failed, using the spare" or "this call is a repeat, stopping" is stated
         * at the moment it was made.
         */
        if (chunk.type === 'status' && chunk.content) this.runRecorder?.step(chunk.content);
        onChunk?.(chunk);
      };
      /*
       * 到天花板就先压一次再发。它在 try 之外、也在这一轮真正发请求之前：压缩自身出错（模型写不
       * 出摘要、盘写不进去）都在 `compactNow` 里就地兜住，不该把这一轮判死 —— 压不动时这次请求
       * 照发，最坏就是走到下面那个"模型端说太长了"的兜底。
       */
      await this.maybeCompact(messages, onChunk, track);

      const requestEstimate = estimateRequest(messages, this.overheadChars(), this.charsPerToken);
      this.pendingRequestChars = requestEstimate.chars;
      this.lastRequestTokens = requestEstimate.tokens;

      let response: LLMMessage;
      try {
        response = await this.provider.chat(messages, this.allToolDefs, track, signal);
      } catch (err) {
        if (signal?.aborted) {
          this.history = repairApiMessages(this.history);
          this.flushInterjections();
          const stopped: LLMMessage = { role: 'assistant', content: '（已中断）' };
          onChunk?.({ type: 'status', content: '已中断当前执行' });
          this.history.push(stopped);
          this.runFailure = { reason: 'aborted' };
          this.runRecorder?.step('已中断当前执行');
          return stopped;
        }
        /*
         * ─── 模型说"太长了"：当场压一次，再发一遍 ───
         *
         * 这一条是这个功能真正的兜底。上面那条阈值线靠的是"我们猜的窗口"，猜大了、或者一次工具调用
         * 就把历史顶过了窗口，都轮不到它出手 —— 而那时唯一能救回这条会话的事实，是**模型端自己说了
         * 太长**。所以要把它和限流/断网分开处理（`isContextOverflowError`）：对溢出重试两次是一模
         * 一样的失败，对溢出压缩再试才有意义。
         *
         * `continue` 而不是继续往下走备用接口：备用接口有自己的窗口，同一份超长提示词发给它大概率
         * 一样被拒 —— 那只会把一次失败变成两次，还让用户以为是"接口切换救不了"。
         */
        if (isContextOverflowError(err)) {
          /*
           * ── 先从这次失败里学到边界 ──
           *
           * 这是唯一一处能把"猜的窗口"换成"量的窗口"的地方：报文里通常写着真实上限。学到就当场改
           * 这个数并落盘（下次构造直接用）。它**不受 autoCompact 管** —— 学一个事实和在设置里关掉
           * 自动压缩是两件事，而且用户此刻最需要的就是这个数字对不对。
           *
           * 只收比当前更小的值：比当前窗口还大的"上限"不可能拒掉这个请求，那是误读（见
           * `windowFromOverflowError` 里的三条安全线）。
           */
          const learned = windowFromOverflowError(err);
          if (learned !== undefined && learned < this.contextWindow.tokens) {
            const was = this.contextWindow.tokens;
            this.contextWindow = {
              tokens: learned,
              source: 'learned',
              detail: `模型端拒绝时给出的上限（本次会话从错误里学到，原先按 ${was} 判断）`,
            };
            this.recordLearnedWindow(learned, err instanceof Error ? err.message : '');
            const said = `模型端给出的上限是 ${learned} tokens（原先按 ${was} 判断）；已记下，之后的判断改按 ${learned}。`;
            onChunk?.({ type: 'status', content: said });
            this.runRecorder?.step(`从拒绝报文里学到窗口：${was} → ${learned}`);
          }
          if (!this.autoCompactEnabled()) {
            /*
             * 关掉就是关掉：这条兜底也归 `autoCompact` 管，否则用户把开关关掉之后仍然会被压缩 ——
             * 而那是"设置里明明关了"的那类意外。
             *
             * 但也不能只说"失败了"：用户此刻的问题正是"一到上限就不动了"，唯一有意义的回复是**告诉
             * 他那个开关在哪、以及还能怎么修**。所以这条状态行点名设置项与环境变量，并顺带报出我们
             * 以为的窗口大小（填错了就是它）。
             */
            onChunk?.({
              type: 'status',
              content: `提示词已超过模型窗口（当前按 ${this.contextWindow.tokens} tokens 判断，${this.contextWindow.detail}），`
                + '而自动压缩被关掉了（设置页的「接近窗口时自动压缩」/ SHE_CONTEXT_AUTO_COMPACT=0）。'
                + '打开它，或把窗口填对（设置页的「上下文窗口」/ SHE_CONTEXT_WINDOW）后重试。',
            });
            this.runRecorder?.step('上下文溢出，但自动压缩被关闭：未压缩，按失败处理');
          } else if (overflowCompactions < 2) {
            overflowCompactions += 1;
            const done = await this.compactNow('overflow', {
              onChunk,
              track,
              keepScale: overflowCompactions > 1 ? 0.25 : 0.5,
            });
            if (done) {
              const fresh = this.messagesForRequest().messages;
              messages.splice(0, messages.length, ...fresh);
              continue;
            }
          }
        }
        if (this.fallbackProvider) {
          const msg = err instanceof Error ? err.message : String(err);
          /*
           * The switch is announced with both endpoints named, and recorded on the run.
           *
           * The message used to name only the failure ("主接口失败（…），改备用接口…"), which leaves
           * the two questions a user actually has unanswered: which endpoint failed, and what is
           * answering now. A fallback is silent by construction otherwise — the answer looks the
           * same, arrives the same way, and is produced by a different model with different
           * behaviour and a different bill.
           */
          this.runFallback = {
            from: this.modelLabel,
            to: this.fallbackLabel ?? '备用接口',
            reason: msg.slice(0, 200),
          };
          track({
            type: 'status',
            content: `主接口 ${this.modelLabel} 失败（${msg}），改备用接口 ${this.fallbackLabel ?? ''}…`.replace(/\s+…/, '…'),
          });
          try {
            response = await this.fallbackProvider.chat(messages, this.allToolDefs, track, signal);
          } catch (fallbackErr) {
            return this.failTurn(fallbackErr, onChunk);
          }
        } else {
          return this.failTurn(err, onChunk);
        }
      }

      response = this.usableToolCalls(response);
      this.history.push(response);
      messages.push(response);

      if (!response.tool_calls?.length) {
        if (autopilotOn && autopilotRounds < autopilotMax && this.planStore) {
          const reply = typeof response.content === 'string' ? response.content : '';
          const decision = planAutopilot(this.planStore.mine(), { turnStartedAt, reply });
          if (decision.proceed && decision.nudge) {
            autopilotStalls = decision.signature === autopilotLastSig ? autopilotStalls + 1 : 0;
            autopilotLastSig = decision.signature;
            if (autopilotStalls < 2) {
              autopilotRounds++;
              const nudge: LLMMessage = { role: 'user', content: decision.nudge };
              this.history.push(nudge);
              messages.push(nudge);
              onChunk?.({ type: 'status', content: '计划还没做完，自动继续下一步' });
              continue;
            }
            onChunk?.({ type: 'status', content: '连续两次计划没有进展，自动续跑停下' });
          }
        }
        this.flushInterjections();
        return response;
      }

      /*
       * Spend is only knowable once the provider has answered, so this check lands between the
       * response and the work it asked for: stopping here saves every tool call in the message.
       *
       * `rounds: 0` because the round axis was already tested at the top of this iteration —
       * passing the real value would let it fire twice and report the round ceiling for what is
       * actually a token overrun.
       */
      const spendStop = budgetStop(budget, usageNow({ rounds: 0 }));
      if (spendStop) {
        this.closeUnrunCalls(response.tool_calls, 0, spendStop, messages, onChunk);
        return this.endTurnForBudget(spendStop, onChunk);
      }

      /*
       * ─── Start the read-only calls early ───
       *
       * `readsToPrefetch` returns only the LEADING run of read-only calls, and only those not
       * already answered this turn, so a read that follows a write in the same message is never
       * started against the pre-write contents. The promises are awaited below, in the original
       * order, by the untouched serial path — this pass only removes the waiting, it does not
       * reorder anything.
       */
      const prefetched = new Map<number, { text: string; ms: number }>();
      const reads = readsToPrefetch(
        response.tool_calls.map((tc) => ({ name: tc.function.name, rawArgs: tc.function.arguments })),
        (key) => readCache.has(key),
      );
      if (reads.length > 1) {
        for (const wave of inWaves(reads)) {
          await Promise.all(wave.map(async (ref) => {
            const executor = this.executors.get(ref.name);
            if (!executor) return;
            const startedAt = Date.now();
            try {
              const args = JSON.parse(ref.rawArgs || '{}') as Record<string, unknown>;
              /*
               * `_`-prefixed keys are the agent's own adjustments, not what the model asked for,
               * and the confirm ticket must never reach an executor. Dropped here the same way the
               * serial path does it, so a prefetched call and a serial one receive the same
               * arguments.
               */
              for (const key of Object.keys(args)) if (key.startsWith('_')) delete args[key];
              const text = await executor(args);
              prefetched.set(ref.index, {
                text: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
                ms: Date.now() - startedAt,
              });
            } catch (err) {
              /*
               * A throw is captured as the `Error:` string the executor path would have produced,
               * rather than rethrown: the serial loop below classifies and annotates it exactly as
               * it would have, so a prefetched failure and a serial one are indistinguishable —
               * which is the property that makes this safe to add at all.
               */
              prefetched.set(ref.index, {
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                ms: Date.now() - startedAt,
              });
            }
          }));
        }
        onChunk?.({
          type: 'status',
          content: `本轮 ${reads.length} 个只读调用并行执行`,
        });
      }

      /** The stuck-loop nudge, appended once every call of this message has its result. */
      let stuckNudge: LLMMessage | null = null;
      for (let callIndex = 0; callIndex < response.tool_calls.length; callIndex++) {
        const tc = response.tool_calls[callIndex];
        const name = tc.function.name;
        const executor = this.executors.get(name);

        // Initialised rather than declared-and-assigned: the run trace below records it from a
        // `finally`, and TypeScript's definite-assignment analysis will not accept a variable
        // whose only assignments live in the guarded `try`/`catch` above. Every reachable path
        // sets it; the empty string is for a flow that cannot happen.
        let result = '';
        /*
         * The classification, carried from the executor to the two places that need it: the
         * failure counter (`toolObserver`) and the annotation the model reads. Null when the
         * tool was never found, which has no executor and so no call to classify — the
         * `unknown tool` string produced below is classified directly instead.
         */
        let verdict: ToolResultVerdict | null = null;
        /*
         * Declared out here so BOTH branches can set it.
         *
         * It used to live inside the `else`, which is exactly why a call to a tool this agent
         * does not have was never counted: there is no executor to run, so the branch that
         * owned the counter never executed.
         */
        let toolFailed = false;
        /*
         * The identity of this call if it is a pure read, so its result can be remembered for the
         * rest of the turn. Null for everything else, which is what makes "only reads are cached"
         * a property of one variable rather than of every branch below.
         */
        let reuseKey: string | null = null;
        /*
         * A ceiling reached in the middle of a message stops before the next call.
         *
         * `rounds: 0, tokens: 0` because both were tested at their own checkpoints; between two
         * tool calls only the call count and the clock can have moved.
         *
         * The remaining calls in this message are answered with an explicit "not run" result
         * rather than being dropped: an assistant message that lists tool calls and leaves some
         * of them unanswered is not a legal request, so the transcript would be unusable — and
         * the model would have no way to learn that its own budget is what stopped it.
         */
        const callStop = budgetStop(budget, usageNow({ rounds: 0, tokens: 0 }));
        if (callStop) {
          this.closeUnrunCalls(response.tool_calls, callIndex, callStop, messages, onChunk);
          return this.endTurnForBudget(callStop, onChunk);
        }
        turnToolCalls += 1;
        /*
         * A call that is not a read may change what the reads were reading, so everything cached
         * this turn is dropped before it runs. Conservative on purpose: the cost of a needless
         * re-read is one call, and the cost of a stale hit is a wrong answer that looks right.
         */
        if (!isReadOnlyTool(name)) readCache.clear();
        if (!executor) {
          result = `Error: unknown tool "${name}"`;
          verdict = classifyToolResult(name, result, { workspaceRoot: this.config.workspace.root });
          toolFailed = isToolFailure(verdict);
        } else {
          try {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            /*
             * A ticket supplied by the MODEL is always discarded.
             *
             * The only legitimate way to redeem a confirm ticket is the human path: the UI posts
             * to `/api/chat/confirm`, which calls `confirmTool(ticketId)` and takes the arguments
             * from `lastPending` — the server's own record — rather than from the model. Nothing
             * the model can send should ever satisfy the gate, so a `_confirm_ticket` in its
             * arguments is dropped here.
             *
             * This is deliberately redundant with redacting the ticket out of the model's tool
             * result. Either one alone would close the hole; keeping both means a future change
             * that re-exposes the ticket (a log, a new chunk type, a different tool) still cannot
             * let a prompt-injected agent approve its own dangerous command.
             */
            if ('_confirm_ticket' in args) {
              log.warn(`丢弃模型自带的 _confirm_ticket（工具 ${name}）：确认只能由用户发起`);
              delete args._confirm_ticket;
            }
            // The error book's switch, not the tool's argument: read from the raw arguments when
            // recording, and stripped here so a strict tool never sees a key it does not know.
            delete args[EXPECT_FAILURE_ARG];
            /*
             * Stage file writes only when a human actually has to review them.
             *
             * This used to be unconditional, so EVERY fs_write produced a
             * staged diff with Apply/Reject — even with "allow all commands" on.
             * That is why enabling 自动运行 / allowAllCommands still asked for
             * approval on every edit. In allow-all mode the write goes straight
             * through; otherwise the diff is staged for review.
             */
            if (name === 'fs_write' && !this.config.sandbox.allowAllCommands) {
              args._stage = true;
            }
            /*
             * Three sources for the result, in order of preference:
             *
             *   1. an identical read already answered this turn — free;
             *   2. a read this pass started early — the waiting is already over;
             *   3. running it here — the original path, and the only one a read that follows a
             *      write in the same message can take.
             *
             * `early` cannot be stale relative to a write in this message: `readsToPrefetch` only
             * starts the leading run of reads, so no mutation precedes any prefetched call.
             */
            /*
             * 取回率：这次调用是不是去读被压掉的那份原文。
             *
             * 只看参数里有没有 `compacted/` —— 那个路径是摘要抬头给出的，模型照着读就会命中。
             * 计数进轨迹（`step`），这样"这条路到底有没有人走"是一个事后查得到的读数，而不是猜想。
             */
            if (String(tc.function.arguments ?? '').includes('compacted/')) {
              this.retrievals += 1;
              this.runRecorder?.step(`取回被压掉的原文（第 ${this.retrievals} 次）`);
            }
            reuseKey = isReadOnlyTool(name) ? queryKey(name, tc.function.arguments) : null;
            const remembered = reuseKey ? readCache.get(reuseKey) : undefined;
            const early = prefetched.get(callIndex);

            log.info(remembered !== undefined ? `Reusing tool result: ${name}` : `Executing tool: ${name}`);
            const toolStart = Date.now();
            /*
             * Duration is taken from where the work actually started. A prefetched call began
             * before this loop reached it, so timing it from here would report the wait as the
             * tool's cost — the trace would show a 400ms read that took 12ms and the number would
             * be believed.
             */
            let toolMs: number | null = null;
            try {
              if (remembered !== undefined) {
                result = remembered;
                toolMs = 0;
              } else if (early) {
                result = early.text;
                toolMs = early.ms;
              } else {
                /*
                 * A blocked tool call can say what it is waiting for.
                 *
                 * `shell_wait` on a long job is silent for as long as the job takes, and a silent
                 * five-minute tool call is indistinguishable from a hang — for the person watching,
                 * and for whatever governs the transport. The sink is set here because this is the
                 * only scope that knows WHICH call is running; it is cleared in the same `finally`
                 * so a later, unrelated call cannot inherit it.
                 */
                this.sandboxTools.setProgressSink?.((text) => {
                  onChunk?.({ type: 'tool_progress', content: text, toolCallId: tc.id });
                });
                try {
                  result = await executor(args);
                } finally {
                  this.sandboxTools.setProgressSink?.(null);
                }
                if (typeof result !== 'string') result = JSON.stringify(result ?? '');
              }
              /*
               * Classify rather than sniff for `^Error:`.
               *
               * The prefix test missed a non-zero exit code entirely (`shell` renders it as
               * `exit code: 1`, and that counted as a healthy call) and could not tell an
               * argument mistake from a refused action from a dead endpoint — three things
               * that need three different next moves.
               *
               * The verdict is attached BEFORE the confirm-gate handling below, so the
               * metrics count the real outcome, but the annotation is added AFTER it: the
               * redacted `needs_confirm` payload is a state, not a failure, and rewriting it
               * would corrupt the JSON the gate depends on.
               */
              verdict = classifyToolResult(name, result, { workspaceRoot: this.config.workspace.root });
              toolFailed = isToolFailure(verdict);
            } catch (err) {
              toolFailed = true;
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
              verdict = classifyToolResult(name, result, { workspaceRoot: this.config.workspace.root });
            } finally {
              // In a `finally` so a throwing tool is still counted.
              const ms = toolMs ?? (Date.now() - toolStart);
              this.toolObserver?.(name, ms, toolFailed);
              /*
               * And into the run trace, from the same scope.
               *
               * Recorded HERE, before the confirm/apply handling below, so the file reads in the
               * order things happened: the call, then the pause it caused. The raw arguments are
               * used rather than the parsed `args`, because staging (`_stage`) and the dropped
               * model-supplied ticket are the agent's own adjustments — what a reader wants is
               * what the model asked for.
               */
              const toolEvent = this.runRecorder?.tool({
                name,
                args: tc.function.arguments,
                result: typeof result === 'string' ? result : JSON.stringify(result ?? ''),
                ms,
                ok: !toolFailed,
                failure: verdict?.kind,
              });
              if (toolEvent) this.runEvents.push(toolEvent);
            }
            /*
             * Remember a read that worked, so the rest of the turn does not pay for it again.
             *
             * Successes only. A failed read is exactly the case where repeating the identical
             * call is what `retryable` says may help, and serving it from a cache would make that
             * retry impossible — the one situation where reuse would cause the failure to
             * persist rather than merely waste a call.
             */
            if (reuseKey && !toolFailed) readCache.set(reuseKey, result);
            if (remembered !== undefined) {
              onChunk?.({
                type: 'status',
                content: `复用「${name}」本轮已取得的相同结果（参数一致，期间没有调用改过东西）`,
              });
            }
            /*
             * ─────────────────────────────────────────────────────────────────────────
             * A confirmation request must not hand its ticket to the model.
             *
             * The confirm gate exists so a HUMAN approves a dangerous action. It did not:
             * the raw tool result — which contains the fresh ticket id — was pushed into
             * `history`, so the model could call `shell`, read the ticket out of its own
             * tool result, and immediately call again with `_confirm_ticket` set. The store
             * only checks the tool name, an argument fingerprint that deliberately ignores
             * `_`-prefixed keys, and a TTL — nothing ties redemption to a person. So a
             * prompt-injected agent could approve its own dangerous command, and the user
             * never saw a prompt.
             *
             * The ticket goes to the UI (it has to — that is what the confirm card posts
             * back) and to `lastPending` for the agent's own confirm path. What the MODEL
             * sees is replaced with a message that says the call is waiting, and explicitly
             * tells it not to retry, so it neither learns the ticket nor loops on it.
             * ─────────────────────────────────────────────────────────────────────────
             */
            if (typeof result === 'string' && result.includes('"needs_confirm"')) {
              try {
                const parsed = JSON.parse(result) as { needs_confirm?: ConfirmTicketInfo };
                if (parsed?.needs_confirm) {
                  this.lastPending = {
                    ticket: parsed.needs_confirm,
                    toolCallId: tc.id,
                    name,
                    args,
                    expectFailure: isIntentionalFailure(tc.function.arguments),
                  };
                  // The UI needs the real ticket to render the confirm card.
                  onChunk?.({
                    type: 'needs_confirm',
                    content: `needs confirm: ${parsed.needs_confirm.ticket_id}`,
                    ticket: parsed.needs_confirm,
                  });
                  /*
                   * The run is now PAUSED, not finished.
                   *
                   * The tracing file stays open so the continuation after the human approves
                   * appends to it — which is the whole point of recording here: a reader can see
                   * that a dangerous step was approved by a person, and what happened next. Closing
                   * the run at this point would turn the most interesting part into a second file
                   * that nothing links to.
                   */
                  this.runPaused = 'confirm';
                  this.runRecorder?.awaiting('confirm', {
                    ticketId: parsed.needs_confirm.ticket_id,
                    tool: name,
                    summary: parsed.needs_confirm.summary,
                  });
                  // The model gets a redacted result. Keep the shape honest: it IS waiting.
                  result = JSON.stringify({
                    needs_confirm: true,
                    awaiting: 'user_approval',
                    tool: name,
                    note: '这个操作需要用户确认，已经向用户发起请求。不要重试，也不要试图自行批准；等用户确认后再继续。',
                  });
                }
              } catch { /* ignore */ }
            }
            if (typeof result === 'string' && result.includes('"needs_apply"')) {
              try {
                const parsed = JSON.parse(result) as { needs_apply?: PendingPatchInfo };
                if (parsed?.needs_apply) {
                  this.lastPatch = parsed.needs_apply;
                  onChunk?.({
                    type: 'needs_apply',
                    content: `needs apply: ${parsed.needs_apply.path}`,
                    patch: parsed.needs_apply,
                  });
                  // Same pause rule as a confirmation: the human is about to decide, and the
                  // continuation (apply or reject) belongs in this run's file.
                  this.runPaused = 'apply';
                  this.runRecorder?.awaiting('apply', { path: parsed.needs_apply.path });
                }
              } catch { /* ignore */ }
            }
          } catch (err: unknown) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            verdict = classifyToolResult(name, result, { workspaceRoot: this.config.workspace.root });
          }
        }

        /*
         * Tell the model what to DO, not just that something broke.
         *
         * Applied here rather than inside the executor's `try`, because by now the
         * confirm-gate redaction has finished and the `needs_confirm` / `needs_apply`
         * payloads are a state rather than a failure — annotating them would mean either
         * corrupting the JSON or counting a working gate as an error.
         *
         * Applied to `result` (not to `toolMsg.content` alone) so history, the live
         * `tool_result` chunk and the next request all show the same thing. They are the
         * same transcript, and a reload must not render a different one than streaming did.
         */
        /*
         * Write it down before the remedy is appended.
         *
         * The annotation is for the model's next request; the book wants the tool's own words,
         * because the remedy is stored as its own field and a signature that included it would
         * treat one failure as two the first time the wording changed.
         */
        const rawOutput = typeof result === 'string' ? result : JSON.stringify(result ?? '');
        if (verdict) result = annotateToolResult(result, verdict);

        /*
         * The annotation gets this turn past the failure; this is what makes it survivable past
         * the SESSION. A transcript is read linearly by a model with a token budget, so "has
         * `grep` burned me before?" is not a question it can ask the history — but it can ask
         * the book.
         */
        /*
         * Not when the model declared the failure in advance (`expect_failure: true`): a test run
         * to watch it fail is the plan working, and recording it would make every later lookup
         * accuse the agent of it. The model still gets the annotated result as usual.
         */
        if (verdict && isWorthRemembering(verdict.kind) && !isIntentionalFailure(tc.function.arguments)) {
          this.recordMistake({
            tool: name,
            kind: verdict.kind,
            call: tc.function.arguments,
            detail: rawOutput,
            remedy: verdict.remedy,
          });
        }

        /*
         * The context budget, applied at the ONE place a tool result becomes context.
         *
         * Deliberately here rather than in each tool. A tool knows what it produced; it does not
         * know what the context costs, and a third-party MCP server cannot be asked to care. The
         * agent is the only layer that knows a result is paid for on EVERY later request, so it is
         * the layer that bounds it. Measured cost of not doing this: one `shell_wait` result of
         * 732,633 characters (76% of a whole session) inside a run that billed 9.3M prompt tokens.
         *
         * Applied to the text BEFORE it is pushed, so history, the persisted transcript and every
         * later request carry the same bytes. It is a pure function of the text, which is what
         * keeps the cache prefix stable — recomputing a boundary per request would re-bill the
         * conversation (see `docs/context-and-caching.md`).
         */
        const asText = typeof result === 'string' ? result : JSON.stringify(result ?? '');
        const budgeted = this.budgetArrivedResult(asText, name, tc.id);
        if (budgeted.truncated) {
          /*
           * Logged, because a silent bound is indistinguishable from a bug: the reader of the log
           * has to be able to tell "this tool returned less" from "this result was elided".
           */
          log.info(
            `工具结果超出上下文预算：${name} 返回 ${budgeted.fullChars} 字符，`
            + `省略 ${budgeted.elidedChars}，进入上下文 ${budgeted.text.length}（上限 ${TOOL_RESULT_CONTEXT_CHARS}）`
            + (budgeted.savedTo ? `，全文存到 ${budgeted.savedTo}` : ''),
          );
        }

        const toolMsg: LLMMessage = {
          role: 'tool',
          content: budgeted.text,
          tool_call_id: tc.id,
        };
        this.history.push(toolMsg);
        messages.push(toolMsg);

        // Stream the output so the UI can show what the tool actually did while
        // the turn is still running. Previously results existed only in history,
        // so they appeared only after a reload — the transcript looked empty of
        // tool activity during live streaming.
        //
        // Streams the BUDGETED text, not the raw result: the UI renders the same transcript that
        // gets persisted, and a 700k-character payload sent to the browser would be one more copy
        // of the same waste. A reload must not render a different transcript than streaming did.
        onChunk?.({ type: 'tool_result', toolCallId: tc.id, toolName: name, content: budgeted.text });

        /*
         * Flag a genuinely stuck loop.
         *
         * The result is part of the signature so that a call which keeps failing
         * differently is not flagged, and one that finally succeeds resets nothing —
         * it simply never reaches the limit, because the result changed.
         */
        const signature = `${name}:${tc.function.arguments}:${String(result).slice(0, 500)}`;
        /*
         * A transient failure gets one more identical attempt before this counts as stuck.
         *
         * `retryable` exists to answer exactly this question — "could repeating the identical
         * call help?" — and for a timeout or a 429 the answer is yes (see `tool-result.ts`).
         * Treating those as a stuck loop spent the detector's authority on the one case where
         * repeating is correct, and the nudge told the model to change an approach that was
         * fine. The reprieve is exactly one attempt, so a service that never comes back still
         * stops rather than hammering.
         */
        const stallLimit = repeatLimit + (verdict?.retryable ? 1 : 0);
        const seen = callSignatures.get(signature);
        if (seen) {
          seen.count++;
          if (seen.count >= stallLimit) {
            const detail = `「${name}」用同样的参数连续调用 ${seen.count} 次，返回的内容完全一致。`;
            log.warn(`Detected a stuck tool loop: ${detail}`);

            /*
             * Try to recover before giving up.
             *
             * A stuck loop almost always means the APPROACH is wrong rather than the
             * task being impossible — the file was not written, the path is wrong, the
             * command needs a flag. Telling the model that, once, resolves most of
             * them; stopping immediately throws away a task that was one correction
             * from working.
             *
             * Bounded to a single attempt: if the same call comes back again after
             * being told explicitly, the model is not going to find its way out, and
             * more rounds only spend money. That is when a human should look.
             */
            if (!recoveryAttempted) {
              recoveryAttempted = true;
              onChunk?.({
                type: 'status',
                content: '检测到重复调用，已提示模型换个思路再试一次',
              });
              const nudge: LLMMessage = {
                role: 'user',
                content:
                  `[系统提示] ${detail}\n\n`
                  + (verdict?.retryable
                    /*
                     * A transient failure is the one case where the advice above would be wrong.
                     * The extra attempt `stallLimit` allowed has already been spent, so what the
                     * model needs to hear is "stop retrying", not "your approach is broken".
                     */
                    ? '这是可重试的失败（超时 / 限流 / 服务不可达），已经额外给过一次原样重试的机会，'
                      + '结果仍然一样。说明对方现在确实不可用：不要再重试，把请求改小或换一条路，'
                      + '必要时如实说明现状。\n'
                    : '这说明当前方法没有产生任何变化，再调一次也是一样的结果。\n'
                      + '请先判断原因（文件是否真的写进去了？路径对吗？是不是缺依赖或权限不足？），'
                      + '然后用**不同的方式**再试一次。如果确实无法继续，直接告诉用户你卡在哪、需要什么。\n'),
              };
              /*
               * Persisted to `history`, like the autopilot nudge, and appended after the loop.
               *
               * It used to go into the request only. Then the next turn's request (built from
               * history) no longer contained it, so the cached prefix diverged at that point and
               * everything after it was billed again. It also landed between this message's tool
               * results whenever more calls followed, which is not a legal sequence. The UI renders
               * `[系统提示]` lines as system notes, not as something the user wrote.
               */
              stuckNudge = nudge;
              // Allow this call to be retried after the nudge, but remember that we
              // have already used our one chance.
              callSignatures.delete(signature);
              callSignatures.set(signature, { count: stallLimit - 1, result });
              continue;
            }

            onChunk?.({ type: 'status', content: `重复调用未改善，已停止：${detail}` });
            // The turn is ending short for a reason worth stating in the run file: the approach
            // went nowhere. `runFailure` rather than an `error` event, because nothing threw —
            // every call may have "succeeded". The `end` event carries the reason.
            this.runFailure = { reason: 'stuck_loop', text: detail };
            this.runRecorder?.step(`重复调用未改善，已停止：${detail}`);

            /*
             * This one is not a tool failure — every call may have "succeeded". It is the
             * approach failing, which is exactly the kind of lesson worth keeping: the next
             * session that reaches for the same call should know it already went nowhere.
             */
            this.recordMistake({
              tool: name,
              kind: 'stuck_loop',
              call: tc.function.arguments,
              detail,
            });

            /*
             * Say what happened AND what to do. An agent that silently stops looks
             * broken; one that explains a stuck loop is understood, and the user can
             * point it at the actual problem (a missing dependency, a wrong path).
             */
            const stalled: LLMMessage = {
              role: 'assistant',
              content:
                `（已停止：提示过之后仍重复调用）${detail}\n\n`
                + '这通常意味着有东西没变——例如文件没写进去、命令一直报同一个错、'
                + '或需要的依赖不存在。请说明你期望的结果，或直接告诉我错误原因，我换个方向试。',
            };
            this.flushInterjections();
            this.history.push(stalled);
            return stalled;
          }
        } else {
          callSignatures.set(signature, { count: 1, result });
        }
      }
      if (stuckNudge) {
        this.history.push(stuckNudge);
        messages.push(stuckNudge);
      }
    }

    const fallback: LLMMessage = {
      role: 'assistant',
      content:
        `（已达到本轮工具调用上限 ${maxIterations} 轮，为避免失控循环而停止。）\n\n` +
        '这不是知识库次数限制——如果任务没做完，直接说「继续」即可接着做。',
    };
    this.flushInterjections();
    this.history.push(fallback);
    // Stopped by the guard, not by its own choice, and not an error: recorded as a reason so a
    // reader can tell "it finished" from "it was cut off and can be resumed".
    this.runFailure = { reason: 'max_iterations', text: `达到工具调用上限 ${maxIterations} 轮` };
    return fallback;
  }

  /**
   * The turn budget, read at the start of every turn.
   *
   * Read per turn rather than cached on the instance so an edit to `she.config.yaml` (or to the
   * settings that feed it) applies to the next turn instead of the next restart — a ceiling the
   * user raised because it was cutting work short should not need a reboot to take effect.
   *
   * `DEFAULT_BUDGET` is disabled, and a config object that predates this switch (or a test's
   * partial stub) simply has no `budget` block, so the fallback is not a special case: it is the
   * same value a fresh install gets.
   */
  private budgetLimits(): BudgetLimits {
    const raw = (this.config as { budget?: unknown } | undefined)?.budget;
    return parseBudgetLimits(raw, DEFAULT_BUDGET);
  }

  /**
   * End the turn because a ceiling was reached — not because anything failed.
   *
   * Kept separate from `failTurn`: a budget stop must not be recorded as an error, must not
   * trigger the error book, and must leave a transcript the next turn can be appended to. The
   * reason goes on the closing trace event so an interrupted-looking run is legible as "it
   * stopped where you told it to".
   */
  private endTurnForBudget(stop: BudgetStop, onChunk?: (chunk: StreamChunk) => void): LLMMessage {
    const text = renderBudgetStop(stop);
    onChunk?.({ type: 'status', content: `已按预算停止：${stop.kind} 用到 ${stop.used}（上限 ${stop.limit}）` });
    this.flushInterjections();
    const msg: LLMMessage = { role: 'assistant', content: text };
    this.history.push(msg);
    this.runFailure = { reason: 'budget', text: `${stop.kind}: ${stop.used}/${stop.limit}` };
    this.runRecorder?.step(`预算停止：${stop.kind} ${stop.used}/${stop.limit}`);
    return msg;
  }

  /**
   * Answer the tool calls that a budget stop prevented from running.
   *
   * An assistant message that lists tool calls and leaves any of them without a result is not a
   * legal request, so simply returning would leave a transcript the next turn cannot be appended
   * to — the ceiling would break the conversation instead of pausing it. Each skipped call gets an
   * explicit result naming the ceiling, which also tells the model *why* nothing happened rather
   * than leaving it to guess at a silent gap.
   */
  private closeUnrunCalls(
    calls: ReadonlyArray<{ id: string; function: { name: string } }>,
    from: number,
    stop: BudgetStop,
    messages: LLMMessage[],
    onChunk?: (chunk: StreamChunk) => void,
  ): void {
    for (let i = Math.max(0, from); i < calls.length; i++) {
      const call = calls[i];
      const note = JSON.stringify({
        not_run: true,
        reason: 'budget_exceeded',
        budget: { kind: stop.kind, limit: stop.limit, used: stop.used },
        tool: call.function.name,
        note: `预算上限（${stop.kind} ${stop.limit}）已达，这次调用没有执行。`,
      });
      const msg: LLMMessage = { role: 'tool', content: note, tool_call_id: call.id };
      this.history.push(msg);
      messages.push(msg);
      onChunk?.({ type: 'tool_result', toolCallId: call.id, toolName: call.function.name, content: note });
    }
  }

  /**
   * Write a failure into the error book without letting bookkeeping break the turn.
   *
   * The book is a durable store the user can lose access to for reasons that have nothing to do
   * with this turn (a locked database, a full disk, a KB being re-indexed). None of those should
   * turn a tool call that already returned into a crashed conversation.
   *
   * It is also not this agent's book to write when `kbReadOnly` is set: the store belongs to the
   * conversation that owns the workspace, and an entry filed by a borrowed reader is a permanent,
   * unreviewed edit to someone else's memory. That is the same rule `kb_upsert` follows, except
   * the tool layer cannot enforce it — this path goes straight to the engine. Three entries written
   * by one read-only child (two "unknown tool", one false drift) are what the rule is for: they are
   * about the CHILD's session, they read as the parent's own mistakes, and the parent cannot tell
   * where they came from. What the child genuinely learned belongs in its deliverable, which is
   * reviewable; what went wrong is still in the run trace and its own transcript.
   */
  private recordMistake(report: {
    tool: string;
    kind: ErrorbookKind;
    call?: string;
    detail: string;
    remedy?: string | null;
  }): void {
    if (this.kbReadOnly) return;
    try {
      this.errorBook.record({ ...report, sessionId: this.sessionId });
    } catch (err) {
      log.warn(`错题本写入失败（工具 ${report.tool}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The request is the system prompt plus the whole session.
   *
   * Earlier builds replaced everything past ~120k characters with an 8k digest
   * and kept only ~30k of the tail. The transcript on disk still grew, but the
   * model stopped seeing it — the session length was stuck. The full history
   * is sent. Appending leaves the prefix unchanged, which is what prompt
   * caching needs.
   */
  /**
   * Bound a tool result as it arrives — the one moment it may be cut (see `budgetToolResultOnArrival`).
   *
   * A command log that is elided has its full text written under this session's state directory, so
   * the note can name a file `fs_read` reads back. A write failure is logged and the note says the
   * output was not saved; it never fails the tool call.
   */
  private budgetArrivedResult(text: string, name: string, callId: string): ArrivedToolResult {
    /*
     * 预算按**还剩多少余量**收紧（见 `toolResultBudgetChars`）：离天花板远时就是原来的 16k 字符，
     * 近了才一刀刀收紧。用的是最近一次请求的估算 —— 它就是我们此刻站在哪儿。
     */
    const limit = toolResultBudgetChars(this.lastRequestTokens, this.contextWindow.tokens, this.charsPerToken);
    return budgetToolResultOnArrival(text, name, (full) => {
      try {
        return spillToolOutput(this.config.workspace.root, this.sessionId, callId, full);
      } catch (err) {
        log.warn(`工具输出全文没能存盘（${name}）：${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }, limit);
  }

  private messagesForRequest(): { messages: LLMMessage[] } {
    this.persistFrozenSystemMessage();
    const systemMessage = this.systemMessage();
    /*
     * `fitToolResultsToBudget` is a no-op for anything this build wrote (see `tool-output.ts`)
     * and the only thing standing between a RESTORED session and its old oversized results: a
     * 732,633-character tool result from before this rule would otherwise be re-sent on every
     * request of every later turn.
     *
     * 压缩套在这一层（"发给模型的那一份"）而不是历史本身：盘上的转写一条不动，`historyForDisk()`
     * 仍然是完整的，用户打开会话看到的也还是完整记录。**没到阈值时这里逐字节等于没压**，
     * 这正是 `prefix-stability.test.ts` 与 `compaction.test.ts` 钉住的东西。
     */
    const fitted = fitToolResultsToBudget(this.history);
    return { messages: appliedMessages(fitted, this.compactionState, systemMessage).messages };
  }

  /**
   * The system message as it is actually sent: the prompt, plus the calibration block when there is
   * one.
   *
   * One place composes it because all three request builders (the turn, the confirm continuation and
   * the patch continuation) must produce the same bytes. They used to differ — two of them sent the
   * bare prompt — which is a cache miss at every continuation boundary AND a different instruction
   * set inside what the model is told is one run.
   *
   * `getSystemPromptText()` returns the same string; the cost guard measures the overhead from it,
   * and a measurement that omitted the block would under-report by exactly the block's size.
   */
  private systemMessageContent(): string {
    return this.calibrationBlock
      ? `${this.systemPrompt}\n\n${this.calibrationBlock}`
      : this.systemPrompt;
  }

  /**
   * 请求里那条系统消息。**只此一处**拼它。
   *
   * 系统消息是缓存前缀的头，所以"谁拼它"必须是一个能数得出来的数（`check:reflection` 就数它）：
   * 两处各拼各的，迟早有一处漏掉自评块或多一个空格 —— 那种分叉不会报错，只会让每一轮都按全价
   * 重算整段历史。压缩对账也走这里，因为"压完到底小了没有"必须拿真的那份请求去算。
   */
  private systemMessage(): LLMMessage {
    return { role: 'system', content: this.systemMessageContent() };
  }

  /** Where this session's frozen system message lives, or null without a (valid) session. */
  private frozenSystemFile(): string | null {
    if (!this.sessionId) return null;
    try {
      return join(sessionStateDir(this.config.workspace.root, this.sessionId), 'system-message.json');
    } catch {
      return null;
    }
  }

  /** What the prompt was built for: a record made under other settings is not reused. */
  private frozenSystemKey(): string {
    return JSON.stringify([resolve(this.config.workspace.root), this.config.automationMode !== false, this.kbReadOnly, this.isSubagent]);
  }

  /**
   * Reuse the system message this session has already been sending, byte for byte.
   *
   * The system message is the head of the cache prefix, and an agent is rebuilt far more often than
   * a session changes: settings saves, model switches, MCP and plugin reloads, a server restart.
   * Each rebuild re-read the rules and skills and recomputed the calibration block, so a resumed
   * session could send a different first message and pay for its whole history again. The first
   * message a session sends is recorded (`persistFrozenSystemMessage`) and every later agent for the
   * same session starts from it.
   *
   * A new session has no record and gets exactly what it got before. A record made under another
   * mode (automation, read-only KB, subagent) is ignored, because there the prompt really differs.
   * The cost: an edit to project rules or skills reaches new sessions, not existing ones. An empty
   * recorded calibration block stays unfrozen, so the one "no evidence -> evidence" change in
   * `beginRun` can still happen, once.
   */
  private restoreFrozenSystemMessage(): void {
    const file = this.frozenSystemFile();
    if (!file) return;
    let rec: { v?: unknown; key?: unknown; prompt?: unknown; calibration?: unknown } | null;
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (!rec || rec.v !== 1 || rec.key !== this.frozenSystemKey()) return;
    if (typeof rec.prompt !== 'string' || !rec.prompt || typeof rec.calibration !== 'string') return;
    this.systemPrompt = rec.prompt;
    this.calibrationBlock = rec.calibration;
    this.calibrationFrozen = rec.calibration !== '';
    this.persistedSystemMessage = this.systemMessageContent();
  }

  /** Record the system message about to be sent, when it differs from the recorded one. */
  private persistFrozenSystemMessage(): void {
    const file = this.frozenSystemFile();
    if (!file) return;
    const content = this.systemMessageContent();
    if (this.persistedSystemMessage === content) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        v: 1,
        key: this.frozenSystemKey(),
        prompt: this.systemPrompt,
        calibration: this.calibrationBlock,
      }), 'utf8');
      renameSync(tmp, file);
      this.persistedSystemMessage = content;
    } catch (err) {
      log.warn(`system message not recorded for this session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** First 12 hex of sha256(system message + tool table): equal values, identical prompt head. */
  private prefixHash(): string {
    const system = this.systemMessageContent();
    const m = this.prefixHashMemo;
    if (m && m.system === system && m.tools === this.allToolDefs && m.count === this.allToolDefs.length) return m.hash;
    const hash = createHash('sha256').update(system).update('\n').update(JSON.stringify(this.allToolDefs)).digest('hex').slice(0, 12);
    this.prefixHashMemo = { system, tools: this.allToolDefs, count: this.allToolDefs.length, hash };
    return hash;
  }

  async chat(
    userMessage: string,
    onChunk?: (chunk: StreamChunk) => void,
    /**
     * Images attached to this turn.
     *
     * They ride on the user message in the transcript, by PATH: the bytes are read when a request
     * is built, never stored here, so a long conversation does not grow by megabytes per
     * screenshot and the request prefix stays identical from turn to turn (which is what the
     * provider's prompt cache keys on). The path must outlive the turn for the same reason — a
     * later turn of this conversation will re-send it.
     */
    images?: MessageImage[],
  ): Promise<LLMMessage> {
    /*
     * One turn at a time per conversation.
     *
     * Two concurrent turns on the same agent interleave writes into a single
     * `history`: each pushes its own user message, each builds its request from that
     * same array, and tool results get paired with the wrong assistant message. The
     * transcript becomes incoherent in a way that is hard to notice and impossible to
     * repair after the fact.
     *
     * `aborter` is also a single field, so the second turn would overwrite the first's
     * controller and "stop" would silently only stop the newer one.
     *
     * The UI already avoids this (the send button becomes a stop button while a turn
     * runs), but the API is reachable from two windows, from scripts, and over the
     * network. The guarantee belongs here, not in the caller.
     */
    if (this.turnActive) {
      throw new TurnInProgressError();
    }

    this.history.push({ role: 'user', content: userMessage, ...(images?.length ? { images } : {}) });
    // Recorded before the loop starts so a tool called during it sees this request.
    this.lastUserRequest = userMessage;
    this.beginRun(userMessage);

    const { messages } = this.messagesForRequest();

    this.toolEventSink = onChunk ?? null;
    try {
      const reply = await this.runExclusive(messages, onChunk);
      /*
       * The critic reads the answer against the trace, before anything else looks at it.
       *
       * Here rather than in the API layer because this is where both halves exist at once: the reply
       * and the tool events of the run that produced it. A caller that skipped it (a scheduled task,
       * a `task_spawn` child) would be delivering unchecked output, and the check has to be a
       * property of producing the answer rather than of the transport that carries it.
       */
      this.critiqueAnswer(reply.content ?? '');
      const stagedPatches = this.getPendingPatches();
      if (stagedPatches.length > 1) {
        const summary = {
          role: 'assistant' as const,
          content: `已暂存 ${stagedPatches.length} 个补丁（多文件 Composer）。请批量应用或逐个处理。`,
        };
        this.history.push(summary);
        onChunk?.({ type: 'status', content: summary.content });
        return summary;
      }
      return reply;
    } catch (err) {
      if (err instanceof TurnInProgressError) throw err;
      return this.failTurn(err, onChunk);
    } finally {
      this.toolEventSink = null;
    }
  }

  /**
   * Open the trace for a new user request.
   *
   * The previous recorder is closed as `abandoned` if it is still open. That is not a tidy-up: a
   * run left paused at a confirmation gate and never resumed has to say so, or the file ends
   * mid-step and a reader cannot tell "the user moved on" from "the process died".
   */
  private beginRun(prompt: string): void {
    if (this.runRecorder && !this.runRecorder.isClosed()) {
      this.runRecorder.end({
        ok: false,
        reason: 'abandoned',
        text: '这一轮还没收尾就开始新的一轮（上一次停在等确认/等应用补丁）。',
        durationMs: Date.now() - this.runStartedAt,
      });
    }
    this.runPaused = null;
    this.runFailure = null;
    this.jobsNoticeSent = false;
    this.runFallback = null;
    this.runStartedAt = Date.now();
    // This run's own spend, as opposed to the agent's lifetime total in `tokenUsage`. Read by
    // `finishRun`: a trace's closing event describes the run it closes.
    this.runUsage = {
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      reasoning_tokens: 0,
      cache_hit_tokens: 0,
      cache_miss_tokens: 0,
    };
    /*
     * The fixed overhead, once per agent, in the log next to the model line.
     *
     * It is the one cost every request pays whether or not the turn does any work, and it is
     * invisible from the outside: the prompt is built from the prompt file plus every registered
     * tool, and MCP servers can add sixty of them to a table nobody sees. Measured 2026-10-03 for
     * the built-in set: 41 tools ≈ 30.8k characters ≈ 8.9k prompt tokens; the number below is
     * whatever THIS workspace actually carries, so a server that injects 40k characters says so
     * instead of quietly doubling the bill.
     *
     * Logged at the first turn rather than in the constructor because the tool table is not
     * finished until every tool family has been registered.
     */
    if (!this.overheadNoticed) {
      this.overheadNoticed = true;
      const promptChars = this.getSystemPromptText().length;
      const toolChars = JSON.stringify(this.allToolDefs).length;
      log.info(
        `固定开销（每次请求都要付）：系统提示词 ${promptChars} 字符 + ${this.allToolDefs.length} 个工具 ${toolChars} 字符`
        + ` ≈ ${Math.round((promptChars + toolChars) / CHARS_PER_TOKEN)} prompt tokens`,
      );
    }
    // A new run starts with no tool events of its own, and no inherited pre-flight confidence: the
    // mirror's sample must attribute this turn's claim to this turn's outcome.
    this.runEvents = [];
    this.runPreflightConfidence = null;
    this.lastCritic = null;

    const recorder = this.runTrace?.begin({
      prompt,
      sessionId: this.sessionId,
      model: this.modelLabel,
      agent: this.isSubagent ? 'subagent' : 'main',
      tools: this.allToolDefs.map((d) => d.name),
      mode: this.config.automationMode === false ? 'manual' : 'automation',
    }) ?? null;
    this.runRecorder = recorder;

    /*
     * Link the pre-flight analysis this run was opened with.
     *
     * Read rather than passed in: `preflight_record` runs as a TOOL inside the turn, so at this
     * point the record may not exist yet — but what this link is for is the OTHER direction, the
     * analysis a previous turn wrote and this one inherited. The tool's own write is picked up by
     * the next run's link, and the record is on disk either way.
     *
     * Inherited means inherited BY THIS CONVERSATION. Linking the workspace's newest record would
     * put another session's goal on this run's trace, which is a claim the trace would then be
     * defending on the parent's behalf.
     */
    try {
      const rec = this.preflightRecord();
      if (rec) {
        recorder?.preflight(rec);
        // The claim this run is being measured against, kept so the mirror's sample is the one
        // that was actually made for this work.
        if (typeof rec.confidence === 'number') {
          this.runPreflightConfidence = {
            confidence: rec.confidence,
            clamped: rec.confidenceClamped === true,
            topic: rec.actual_goal?.slice(0, 40),
          };
        }
      }
    } catch { /* a trace must never be the reason a turn fails */ }

    /*
     * The calibration block, frozen once it says something.
     *
     * It is built at construction (see the constructor: the cost reading has to be accurate before
     * the first turn). The rebuild below exists for one case only — a long-lived agent that started
     * with an empty reading and later accumulated enough samples to have a verdict. That is ONE
     * change per session; the rule these lines exist to keep is that a turn never re-reads it.
     *
     * The block is appended to the SYSTEM message, and the system message is the head of the cache
     * prefix. Measured against the real endpoint (deepseek-flash, 2026-10-03) with a ~19.5k-char
     * history and the block at that position:
     *
     *   block unchanged between two turns → 94% of the request served from cache
     *   block recomputed between turns   → 37%
     *
     * i.e. rebuilding it costs ~57% of the request, every turn it changes — the history AND the
     * tool table both land after the break, and the tool table is 6.4k tokens for the built-in
     * tools alone (8.9k with the session-scoped tools). That is precisely the failure
     * `docs/context-and-caching.md` warns about ("每轮重新生成摘要 = 每轮改前缀"), in a different
     * place than the one it was written about.
     *
     * The reading is accumulated across conversations and moves slowly, so a session's worth of
     * staleness costs nothing next to the cache it saves.
     */
    if (!this.calibrationFrozen) {
      const block = this.buildCalibrationBlock();
      if (block) {
        this.calibrationBlock = block;
        this.calibrationFrozen = true;
      }
    }
  }

  /**
   * The calibration reading, as a prompt block, or an empty string.
   *
   * Empty unless there is enough evidence for a verdict, so an agent with three runs behind it is
   * not lectured about habits — the mirror's report says `unknown` until it has seen enough, and
   * this passes that through rather than inventing a claim.
   */
  private buildCalibrationBlock(): string {
    try {
      const text = renderCalibration(this.confidenceMirror.report());
      if (!text) return '';
      return [
        '## Self-Review — Your Calibration',
        'The numbers below are your own stated confidences in pre-flight records, measured against how',
        'often the tool calls in those runs actually succeeded. The verdict is accumulated across your',
        'conversations as numbers only, so it is a measurement of this agent, not of the current task.',
        'The list of worst topics is read from THIS conversation\'s samples, because a topic is the',
        'task text of a single conversation.',
        '',
        text,
        '',
        'Use it when you state a confidence in a pre-flight record or decide how much to verify. Do not',
        'report it to the user as a fact about the task.',
      ].join('\n');
    } catch {
      return '';
    }
  }

  /** True when this run is stopped at a gate and must not be closed yet. */
  private runIsPaused(): boolean {
    return this.runPaused !== null;
  }

  /**
   * True while a multi-step continuation is holding the trace open.
   *
   * `applyAllPatches` applies several patches, each of which runs its own `withTurn` — and
   * `withTurn` closes the run when the turn ends. Without a hold, the first patch's turn would
   * close the trace and every later patch in the same batch would be untraced, which reads as a
   * run that ended early rather than as a batch. The hold is a counter because the same reasoning
   * applies to any future nesting.
   */
  private runHeld(): boolean {
    return this.runHold > 0;
  }

  /** Close the trace unless something is still holding it open. Used by both closing paths. */
  private closeRunIfDone(): void {
    if (this.runIsPaused() || this.runHeld()) return;
    const failure = this.runFailure;
    this.finishRun(!failure, failure?.reason, failure?.text);
  }

  /**
   * This run's tool actions, in the shape the drift check takes.
   *
   * Read from the events rather than from a parallel list: the events are what the critic and the
   * trace use, so a second record would be a second thing to keep in sync, and the first time they
   * disagreed the drift check would be reporting on work that did not happen.
   */
  private currentRunActions(): DriftAction[] {
    return this.runEvents
      .filter((e) => e.kind === 'tool' && !!e.tool)
      .map((e) => ({ tool: e.tool!, args: e.args, summary: e.result?.slice(0, 200) }));
  }

  /**
   * The self-review that runs when a turn ends.
   *
   * Order matters, and it is the order of the evidence:
   *
   *   1. the mirror takes its measurement — claimed confidence (from the pre-flight record this
   *      run was opened with) against the tool success rate the recorder tallied;
   *   2. drift is computed from the goal and the actions that actually ran;
   *   3. lessons are derived from those two, and written into the error book.
   *
   * A run with no stated confidence produces NO mirror sample. Filling the gap with the ceiling or
   * with a default would make the mirror measure itself: the whole number is supposed to be the
   * model's own claim, and inventing one would leave the bias looking better than it is — the
   * direction the mirror exists to catch.
   */
  private reflectOnRun(): void {
    try {
      const tally = this.runRecorder?.toolTally() ?? { attempted: 0, succeeded: 0 };
      const claim = this.runPreflightConfidence
        ?? this.readPreflightConfidence();
      if (claim) {
        this.confidenceMirror.observe({
          claimed: claim.confidence,
          attempted: tally.attempted,
          succeeded: tally.succeeded,
          clamped: claim.clamped,
          topic: claim.topic,
          runId: this.runRecorder?.id,
        });
      }

      const calibration = this.confidenceMirror.report();
      const goal = this.readPreflightGoal();
      const preflight = this.readPreflightRecord();
      const drift = detectDrift({
        goal: goal ?? '',
        constraints: (preflight?.inferred_constraints ?? []).map((text) => ({ text, hardness: 'soft' as const })),
        actions: this.currentRunActions(),
        stepsUsed: this.runEvents.filter((e) => e.kind === 'tool').length,
        toolNames: this.allToolDefs.map((d) => d.name),
      });

      const failures = this.runEvents
        .filter((e) => e.kind === 'tool' && e.ok === false && !!e.tool)
        .map((e) => ({ tool: e.tool!, kind: String(e.failure ?? 'unknown'), detail: e.result ?? '' }));

      const notes = deriveReflections({
        goal: goal ?? '',
        drift,
        calibration,
        failures,
        runFailed: this.runFailure !== null,
        runReason: this.runFailure?.reason,
      });

      // Same ownership rule as `recordMistake`: a borrowed book is read, not written. The review
      // still runs and `lastReflection` still reports it, so the finding is visible to whoever is
      // reading the run — it just does not become a permanent entry in someone else's memory.
      const written: string[] = [];
      if (!this.kbReadOnly) {
        for (const note of notes) {
          const { entry, recurring, reopened } = this.errorBook.recordReflection({ ...note, sessionId: this.sessionId });
          written.push(reopened
            // A retirement that turned out to be wrong is worth naming: the agent chose not to hear
            // about this, and the same thing came back anyway.
            ? `${note.topic}（退役过又回来了，第 ${entry.count} 次）`
            : recurring ? `${note.topic}（第 ${entry.count} 次）` : note.topic);
        }
      }

      this.lastReflection = {
        at: new Date().toISOString(),
        drift,
        calibration,
        written,
      };
      if (written.length) {
        log.info(`自省写入错题本：${written.join('、')}`);
      }
    } catch (err) {
      // Same stance as the error book's own writes: bookkeeping must not be the reason a turn
      // fails, and a reflection that throws has already done its job badly.
      log.warn(`自省失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The newest pre-flight record for this conversation, or null. A broken file is not an error.
   *
   * Session-scoped on purpose: everything derived from this record — the goal the self-review
   * measures against, the constraints it checks, the confidence sample — is a statement about a
   * particular request. Reading the workspace's newest instead is how a child came to file the
   * parent's goal as its own drift.
   */
  private readPreflightRecord(): import('./preflight.js').PreflightRecord | null {
    try {
      return this.preflightRecord() ?? null;
    } catch {
      return null;
    }
  }

  private readPreflightConfidence(): { confidence: number; clamped: boolean; topic?: string } | null {
    const rec = this.readPreflightRecord();
    // Ownership is already settled by `readPreflightRecord` (see `preflightRecord`); the test
    // here is only whether this record carries a claim to measure.
    if (!rec || typeof rec.confidence !== 'number') return null;
    return { confidence: rec.confidence, clamped: rec.confidenceClamped === true, topic: rec.actual_goal?.slice(0, 40) };
  }

  private readPreflightGoal(): string | null {
    const rec = this.readPreflightRecord();
    return rec?.actual_goal || rec?.stated_intent || null;
  }

  /**
   * Close the trace for the turn that just finished.
   *
   * `ok` is derived from `runFailure`, which the failure paths set, rather than from whether
   * anything threw: the loop catches provider errors and turns them into a normal return with a
   * message, so an exception is not what a failed turn looks like.
   */
  private finishRun(ok: boolean, reason: string | undefined, text?: string): void {
    const recorder = this.runRecorder;
    if (!recorder || recorder.isClosed()) return;
    /*
     * Self-review BEFORE the recorder is released, because the mirror reads the run's tool tally
     * from it. Called after the early return above so it cannot run twice for one run, and outside
     * the `end` write below so a slow reflection cannot delay the `end` event a reader is waiting on.
     */
    this.reflectOnRun();
    recorder.end({
      ok,
      reason,
      text,
      durationMs: Date.now() - this.runStartedAt,
      fallback: this.runFallback ?? undefined,
      /*
       * This RUN's usage, not the agent's lifetime total.
       *
       * The closing event closes a run, so the numbers on it have to describe that run: how many
       * requests it made, and of the prompt tokens it sent, how many were served from the
       * provider's cache. A reader who cannot separate those two cannot tell a big prompt from a
       * big turn, which is exactly the confusion `usage.requests` and `cache_miss_tokens` exist to
       * end. `getTokenUsage()` still answers the lifetime question, and that is the number the
       * cost API reports.
       */
      usage: {
        requests: this.runUsage.requests,
        prompt_tokens: this.runUsage.prompt_tokens,
        completion_tokens: this.runUsage.completion_tokens,
        total_tokens: this.runUsage.total_tokens,
        cache_hit_tokens: this.runUsage.cache_hit_tokens,
        cache_miss_tokens: this.runUsage.cache_miss_tokens,
        reasoning_tokens: this.runUsage.reasoning_tokens,
      },
    });
    this.runRecorder = null;
  }

  /**
   * Run the independent critic over an answer, against this run's tool events.
   *
   * Called on the reply that ends a turn. Only a CONTRADICTION is surfaced unprompted: that is the
   * case where the trace proves the answer wrong, and letting it through is the failure this whole
   * family of checks exists to stop. `unbacked` and `unverifiable` findings are recorded and
   * exposed through the API instead — a checker that interrupts every turn with "this claim has no
   * citation" is one the agent (and the user) learns to click past, and it would cost the one time
   * it is right.
   */
  private critiqueAnswer(answer: string): void {
    try {
      const claims = extractClaims(answer);
      if (!claims.length) {
        this.lastCritic = { verdict: 'pass', findings: [], toolRuns: this.runEvents.filter((e) => e.kind === 'tool').length, checked: 0, summary: '这一轮的回答里没有可核对的完成性说法。' };
        return;
      }
      const review = reviewClaims({
        claims,
        trace: this.runEvents,
        availableTools: this.allToolDefs.map((d) => d.name),
      });
      this.lastCritic = review;
      if (review.verdict === 'fail') {
        const block = renderCriticReview(review);
        if (block) this.toolEventSink?.({ type: 'status', content: `⚠️ ${block}` });
      }
    } catch (err) {
      log.warn(`批评者复核失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The last run's self-review: drift, calibration, and what was written to the error book. */
  getReflection(): {
    at: string;
    drift: DriftReport;
    calibration: ReturnType<ConfidenceMirror['report']>;
    written: string[];
  } | null {
    return this.lastReflection;
  }

  /** The critic's reading of the last answer, or null when nothing has been reviewed yet. */
  getCriticReview(): CriticReview | null {
    return this.lastCritic;
  }

  /**
   * Check what the agent is about to hand over, and say so if it should not leave.
   *
   * Detection only — see `guardrail.ts` for why the answer is not rewritten. Three things happen
   * when something is found, and each answers a different question afterwards:
   *
   *   - the user is told now, in the turn, because "do not forward this" is only useful before they
   *     forward it;
   *   - the finding is recorded on the run trace as a step, so a run file can be searched for the
   *     fact that this turn emitted something (the values are never in it — the finding carries a
   *     masked preview and nothing else);
   *   - the history is kept in memory for `GET /api/guardrail`, which is what makes "has this
   *     workspace ever leaked a key" an answerable question rather than a hope.
   */
  private checkOutbound(answer: string, onChunk?: (chunk: StreamChunk) => void): void {
    if (!answer) return;
    const policy = guardrailPolicy();
    if (policy === 'off') {
      this.lastGuardrail = null;
      return;
    }
    try {
      const findings = scanOutbound(answer);
      this.lastGuardrail = { at: new Date().toISOString(), findings, policy };
      if (!findings.length) return;
      this.guardrailHistory.push(...findings);
      // The kinds and counts go on the trace; the previews do not. A trace is a second copy on
      // disk in the workspace, which is exactly the place a masked preview still should not be
      // if the mask ever failed — the label alone is enough to act on.
      this.runRecorder?.step(
        `出口合规护栏：找到 ${findings.length} 处（${summariseFindings(findings).map((s) => `${s.label}×${s.count}`).join('、')}）`,
      );
      onChunk?.({ type: 'status', content: renderGuardrailNotice(findings) });
      log.warn(
        `出口合规护栏：回答里有 ${findings.length} 处（${summariseFindings(findings).map((s) => `${s.label}×${s.count}`).join('、')}）`,
      );
    } catch (err) {
      // A guardrail that can break a turn is worse than one that misses: the failure mode of a
      // missed credential is a leak, and the failure mode of a throwing check is a lost answer.
      log.warn(`出口合规护栏检查失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The last outbound check, or null when none has run (or it is switched off). */
  getGuardrailReport(): { at: string; findings: GuardrailFinding[]; policy: GuardrailPolicy } | null {
    return this.lastGuardrail;
  }

  /** Everything the guardrail has reported in this process, newest last. Values are masked. */
  getGuardrailHistory(): GuardrailFinding[] {
    return [...this.guardrailHistory];
  }

  /** The confidence mirror, for a panel or an API route. */
  getConfidenceMirror(): ConfidenceMirror {
    return this.confidenceMirror;
  }

  /**
   * Run the tool loop, refusing to start if a turn is already in flight.
   *
   * Every entry point goes through here rather than calling `runLoop` directly, so a future entry
   * point cannot accidentally reintroduce concurrent turns. The flag is cleared in a `finally` so
   * a throwing tool cannot leave the agent permanently "busy" — which would make the conversation
   * unusable until restart.
   *
   * The abort controller is created HERE rather than in `chat()`, so every turn is interruptible.
   * It used to be owned by `chat()`, which meant a confirm or patch-apply turn had no controller:
   * `stop()` returned false and the user could not interrupt a call they could see running.
   * `runLoop` reads `this.aborter.signal`, so creating it before entering the loop is what makes
   * the difference.
   */
  private async runExclusive(
    messages: LLMMessage[],
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<LLMMessage> {
    return this.withTurn(async () => {
      const reply = await this.runLoop(messages, onChunk);
      /*
       * The outbound guardrail runs HERE, inside the turn, and not in `chat()` after it.
       *
       * `withTurn` closes the trace in its own `finally`, and a closed recorder refuses further
       * events — so a check placed in `chat()` would emit its warning to the user but leave nothing
       * in `.she/runs/`, which is precisely the record someone reads a week later to find out when
       * a credential first appeared in an answer. Placing it here also means every entry point gets
       * it: a confirmation, a patch application and a plain turn all produce output that leaves the
       * machine the same way.
       *
       * The answer is not modified. See `guardrail.ts`: silently rewriting it would break the
       * correspondence between what was said and what the trace recorded — the correspondence the
       * critic, the drift check and the delivery template all read.
       */
      this.checkOutbound(reply.content ?? '', onChunk);
      return reply;
    });
  }

  /**
   * Run `fn` while holding the conversation exclusively, with an abort controller installed.
   *
   * Extracted from `runExclusive` because applying a patch has to do real work — take the patch
   * from the store, validate the path, write the file — and that work must happen INSIDE the lock.
   * It used to happen before: `applyPatch` took the patch, pushed a checkpoint and wrote the file,
   * and only then entered `runExclusive`, which throws `TurnInProgressError` when a turn is already
   * running. A refused apply therefore reported a 409 to the user while the file had already been
   * written and the patch had been consumed — the edit landed, the user saw a failure, and there was
   * nothing left to retry or reject.
   */
  private async withTurn<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.turnActive) throw new TurnInProgressError();
    this.turnActive = true;
    const controller = new AbortController();
    this.aborter = controller;
    try {
      return await fn(controller.signal);
    } finally {
      if (this.aborter === controller) this.aborter = null;
      this.turnActive = false;
      /*
       * Before the trace closes: say out loud that the turn is over but the work is not.
       *
       * A background job is the one thing this agent can leave running after it answers. Without
       * this line the user reads "done", closes the window, and the computation they asked for is
       * still going with nothing on screen saying so — the same silence that made a killed command
       * look like a finished one.
       */
      this.announceRunningJobs();
      /*
       * Close the trace here rather than in each entry point.
       *
       * Every turn goes through this method, including the confirm and patch-apply continuations,
       * so a future entry point cannot leave a run file open. A turn stopped at a gate is left
       * OPEN on purpose — the continuation appends to it — and a batch of patches holds it open
       * across several of these scopes. `runPaused` and `runHold` are what distinguish those from
       * a finished turn.
       */
      this.closeRunIfDone();
    }
  }

  /**
   * Tell the user which background jobs are still running as the turn ends.
   *
   * Once per user request, not once per `withTurn`: a batch of staged patches runs several turn
   * scopes, and repeating the same sentence three times reads as three batches of work rather than
   * one. The flag is reset in `beginRun`, which is exactly "a new request started".
   */
  private announceRunningJobs(): void {
    if (this.jobsNoticeSent) return;
    const jobs = this.sandboxTools.runningJobs?.() ?? [];
    if (jobs.length === 0) return;
    this.jobsNoticeSent = true;
    this.toolEventSink?.({
      type: 'status',
      content: `这一轮已经答完，但还有 ${jobs.length} 个后台任务在跑：`
        + jobs.map((j) => `${j.id}（${Math.round(j.elapsedMs / 1000)} 秒）`).join('、')
        + '。用 shell_wait 等它结束，或 shell_jobs 看详情。',
    });
  }

  /**
   * Interrupt the running turn. Aborts the in-flight LLM request so the server
   * actually stops working (previously "stop" only detached the browser).
   */
  stop(): boolean {
    if (!this.aborter) return false;
    this.aborter.abort();
    return true;
  }

  /**
   * True while a turn is in flight.
   *
   * Must be `turnActive`, not `aborter !== null`. Only `chat()` sets `aborter`, so during a
   * confirm or patch-apply turn — which also hold the conversation exclusively — this reported
   * false. The consequences were not cosmetic:
   *
   *   - `GET /api/chat/running` said idle, so the UI showed Send instead of Stop during a patch
   *     application, and the user had no way to interrupt a call they could see running;
   *   - `POST /api/chat/stop` returned `stopped: false`;
   *   - a second message was accepted into a busy conversation and came back as an SSE error
   *     event rather than the documented 409.
   *
   * `turnActive` is the flag `runExclusive` already sets for exactly this purpose.
   */
  isRunning(): boolean {
    return this.turnActive;
  }

  /**
   * Why the last finished turn failed, or null when it completed.
   *
   * `chat()` deliberately does not throw on a provider error — it returns a normal-looking
   * message and leaves the transcript usable, so the user can just say "continue". That is right
   * for a chat and wrong for a caller that has no user watching: a headless run (a scheduled
   * task) that reads only the returned message cannot tell "the API was unreachable" from "the
   * job ran", so it recorded a failure as success and `consecutiveFailures`/retry/alert — the
   * machinery built for exactly this — could never fire for the most common failure of all.
   *
   * Cleared at the start of every turn (`beginRun`), so this always describes the turn that just
   * finished.
   */
  lastRunFailure(): { reason: string; text?: string } | null {
    return this.runFailure ? { ...this.runFailure } : null;
  }

  async confirmTool(
    ticketId: string,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<LLMMessage> {
    const pending = this.lastPending;
    if (!pending || pending.ticket.ticket_id !== ticketId) {
      throw new Error('no matching pending confirm ticket');
    }
    // Hold the turn for the confirmed action AND the continuation. The action
    // used to run with no lock and no abort controller, so a chat turn could
    // interleave into the same history, and Stop did nothing until the model
    // loop started.
    return this.withTurn(async () => {
      this.toolEventSink = onChunk ?? null;
      try {
        return await this.confirmToolBody(pending, ticketId, onChunk);
      } catch (err) {
        if (err instanceof TurnInProgressError) throw err;
        return this.failTurn(err, onChunk);
      } finally {
        this.toolEventSink = null;
      }
    });
  }

  private async confirmToolBody(
    pending: {
      ticket: ConfirmTicketInfo; toolCallId: string; name: string; args: Record<string, unknown>; expectFailure?: boolean;
    },
    ticketId: string,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<LLMMessage> {
    const executor = this.executors.get(pending.name);
    if (!executor) throw new Error(`unknown tool "${pending.name}"`);

    const args: Record<string, unknown> = { ...pending.args, _confirm_ticket: ticketId };
    // Same rule as the main loop: only stage when review is still required.
    if (pending.name === 'fs_write' && !this.config.sandbox.allowAllCommands) {
      args._stage = true;
    }
    log.info(`Confirming tool: ${pending.name} ticket=${ticketId}`);
    /*
     * The turn is RESUMING, not still paused.
     *
     * Cleared before the work below, because this is the point the wait ends: `withTurn` leaves the
     * trace open while `runPaused` is set, and if it were not cleared here the file would never be
     * closed and the run would look permanently unfinished. Set again below if this continuation
     * pauses at another gate.
     */
    this.runPaused = null;
    let result: string;
    let verdict: ToolResultVerdict;
    const confirmedStart = Date.now();
    try {
      const raw = await executor(args);
      result = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    /*
     * Classified on the confirmed path too, and for the same reason as the main loop: a
     * command that was approved and then failed is exactly when the model most needs to be
     * told why, and a non-zero exit code here was previously indistinguishable from success.
     */
    verdict = classifyToolResult(pending.name, result, { workspaceRoot: this.config.workspace.root });
    /*
     * The approved call recorded as its own tool event.
     *
     * Without this the trace would show the call only ONCE — the attempt that came back asking for a
     * ticket — and then jump to its effects. The step that actually ran, because a person said yes,
     * is the one a reader most needs to see attributed. `ok: false` when the gate was passed but the
     * command failed is deliberate: approval and success are different things.
     */
    const confirmedEvent = this.runRecorder?.tool({
      name: pending.name,
      args: JSON.stringify(pending.args),
      result,
      ms: Date.now() - confirmedStart,
      ok: verdict.ok,
      failure: verdict.ok ? undefined : verdict.kind,
    });
    if (confirmedEvent) this.runEvents.push(confirmedEvent);
    // Recorded like any other failure: a command the user approved and that then failed is
    // among the most worth remembering.
    if (isWorthRemembering(verdict.kind) && !pending.expectFailure) {
      this.recordMistake({
        tool: pending.name,
        kind: verdict.kind,
        call: JSON.stringify(pending.args),
        detail: result,
        remedy: verdict.remedy,
      });
    }
    this.lastPending = null;

    if (typeof result === 'string' && result.includes('"needs_apply"')) {
      try {
        const parsed = JSON.parse(result) as { needs_apply?: PendingPatchInfo };
        if (parsed?.needs_apply) {
          this.lastPatch = parsed.needs_apply;
          onChunk?.({
            type: 'needs_apply',
            content: `needs apply: ${parsed.needs_apply.path}`,
            patch: parsed.needs_apply,
          });
        }
      } catch { /* ignore */ }
    }

    // Same annotation as the main loop, applied after the stager has read the raw JSON.
    result = annotateToolResult(result, verdict);

    const toolMsg: LLMMessage = {
      role: 'tool',
      // Same context budget as the main loop. Confirmed commands are the ones most likely to be
      // long (a build, a full check run is exactly what a person approves), so this path needs the
      // bound at least as much as the unconfirmed one.
      content: this.budgetArrivedResult(result, pending.name, pending.toolCallId).text,
      tool_call_id: pending.toolCallId,
    };
    let replaced = false;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role === 'tool' && m.tool_call_id === pending.toolCallId) {
        this.history[i] = toolMsg;
        replaced = true;
        break;
      }
    }
    if (!replaced) this.history.push(toolMsg);

    onChunk?.({ type: 'status', content: `confirmed ${pending.name}` });

    // Continue the tool/LLM loop so multiple files can stage into Composer. Built through the same
    // helper as every other request, so the per-result context budget covers this path too — a
    // hand-built `[system, ...history]` here used to be the one request the bound did not reach.
    const { messages } = this.messagesForRequest();
    // Already inside withTurn. runExclusive would see the lock and refuse.
    const reply = await this.runLoop(messages, onChunk);
    const staged = this.getPendingPatches();
    if (staged.length) {
      const summary = {
        role: 'assistant' as const,
        content: staged.length === 1
          ? `已暂存 1 个补丁：\`${staged[0].path}\`。请在 Composer / Diff 面板应用或拒绝。`
          : `已暂存 ${staged.length} 个补丁（多文件 Composer）。请批量应用或逐个处理。`,
      };
      this.history.push(summary);
      onChunk?.({ type: 'status', content: summary.content });
      return summary;
    }
    return reply;
  }

  async applyPatch(
    patchId: string,
    onChunk?: (chunk: StreamChunk) => void,
    opts?: { continueLoop?: boolean },
  ): Promise<LLMMessage> {
    return this.withTurn(async () => {
      const patch = this.patches.take(patchId) ?? (this.lastPatch?.patch_id === patchId ? this.lastPatch : null);
      if (!patch) throw new Error('unknown or expired patch');

      // Resuming: the wait for a human's decision is over, so the trace can be closed again when
      // this turn ends. See `confirmToolBody` for the same rule.
      this.runPaused = null;

      /*
       * The patch path is re-validated HERE, at the point of the write.
       *
       * `.she/pending-patches.json` is a plain file inside the workspace, so the workspace's own
       * contents decide what a patch entry says — and the agent can write `.she/**` (the fs jail
       * permits it, because that is where staged state lives). A forged entry with
       * `path: "../../../Users/<user>/.ssh/authorized_keys"` was written outside the workspace when
       * the user clicked Apply, through the "reviewed diff" UI. The textual jail is the same one the
       * file tools use, shared rather than reimplemented so the two cannot drift.
       */
      const abs = resolveInsideWorkspace(this.config.workspace.root, patch.path);
      mkdirSync(dirname(abs), { recursive: true });
      this.checkpoints.push({
        patch_id: patch.patch_id,
        path: patch.path,
        before: patch.before,
        after: patch.after,
      });
      writeFileSync(abs, patch.after, 'utf8');
      this.lastPatch = null;
      onChunk?.({ type: 'status', content: `applied ${patch.path}` });
      // The human's decision, recorded as an event: "the agent changed this file because someone
      // approved this patch" is not visible from the tool events, which happened earlier.
      this.runRecorder?.step(`已应用补丁 \`${patch.path}\`（人工确认）`);

      const msg: LLMMessage = {
        role: 'assistant',
        content: `Applied edit to \`${patch.path}\`.`,
      };
      this.history.push(msg);

      if (opts?.continueLoop === false) {
        return msg;
      }

      // Already holding the turn lock — go straight to the loop. Same builder as the turn itself:
      // one place composes a request, so one place applies the context budget.
      const { messages } = this.messagesForRequest();
      this.toolEventSink = onChunk ?? null;
      try {
        return await this.runLoop(messages, onChunk);
      } finally {
        this.toolEventSink = null;
      }
    });
  }

  async rejectPatch(patchId: string): Promise<{ ok: true; path?: string }> {
    const patch = this.patches.take(patchId) ?? (this.lastPatch?.patch_id === patchId ? this.lastPatch : null);
    if (!patch) throw new Error('unknown or expired patch');
    this.lastPatch = null;
    this.history.push({
      role: 'assistant',
      content: `Rejected edit to \`${patch.path}\`.`,
    });
    // Recorded for the same reason an apply is: "this file was NOT changed, because a person said
    // no" is a decision, and the `apply` event would otherwise be the last thing in the trace.
    this.runRecorder?.step(`已拒绝补丁 \`${patch.path}\`（人工决定，文件未改动）`);
    return { ok: true, path: patch.path };
  }

  clearHistory(): void {    this.history = [];
    this.lastPending = null;
    this.lastPatch = null;
    this.pendingInterjections = [];
  }

  getTokenUsage() {
    return { ...this.tokenUsage };
  }

  resetTokenUsage() {
    this.tokenUsage = {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      reasoning_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0,
    };
  }

  getHistory(): LLMMessage[] {
    return [...this.history];
  }

  /**
   * Transcript safe to write to disk.
   *
   * The live history can end on a tool call whose result has not been pushed
   * yet — persisting that is how a crash made every later request 400. The
   * copy folds unfinished calls into text. The in-memory turn is left alone.
   */
  historyForDisk(): LLMMessage[] {
    return repairApiMessages(this.history);
  }

  /**
   * 天花板状态：现在离窗口还有多远、按什么阈值压、压过没有、压的是哪一份摘要。
   *
   * 面板与接口共用这一份。压缩如果只能从状态行里偶然看见，用户就没法回答"它到底压没压、压的是
   * 什么、什么时候压的" —— 而这三个问题正是"一到上限就不动了"之后最先要回答的。
   */
  getContextStatus(): {
    window: { tokens: number; source: string; detail: string };
    usedTokens: number;
    breakdown: ReturnType<typeof breakdownRequest>;
    /** 换算比与它的样本数：可见才谈得上怀疑（它决定"什么时候压"）。 */
    estimate: { charsPerToken: number; samples: number };
    threshold: number;
    autoCompact: boolean;
    compacted: boolean;
    compaction: {
      covered: number; source: string; at: string; reason: string;
      beforeTokens: number; afterTokens: number; sourcePath: string | null;
      anchors: number;
    } | null;
    /** 压缩这条路的三个读数：压过几次、真的取回过几次、以及"取回"这件事有没有发生。 */
    memory: { compactions: number; foldedMessages: number; anchors: number; retrievals: number };
    /**
     * 这次压缩到目前为止划不划算：省下的 = (前 − 后) × 之后的请求轮数；付出的 = 紧接着那次请求
     * 实际付掉的未命中 token（provider 报的，不是估的）。两个数同一把尺子（都是输入 token）。
     */
    economics: {
      rounds: number;
      savedTokens: number;
      paidTokens: number | null;
      netTokens: number;
      /** 还没量到付出的那一半时为 false（provider 不报缓存拆分，或压缩后的第一个请求还没发出）。 */
      settled: boolean;
    } | null;
    /** 这一刻一条工具结果允许带进来的字符数（离天花板越近越小）。 */
    budgetChars: number;
  } {
    const s = this.compactionState;
    /*
     * `usedTokens` 与分类账从**同一份请求**算出来（不是两处各算一遍）：两份请求不一样的话，"还
     * 剩多远"和"谁吃掉的"会互相矛盾，而面板会把矛盾原样显示给用户。
     */
    const breakdown = breakdownRequest(this.messagesForRequest().messages, this.overheadChars(), this.charsPerToken);
    return {
      window: { tokens: this.contextWindow.tokens, source: this.contextWindow.source, detail: this.contextWindow.detail },
      usedTokens: breakdown.total,
      breakdown,
      estimate: { charsPerToken: this.charsPerToken, samples: this.estimateSamples.length },
      threshold: this.compactAtShare(),
      autoCompact: this.autoCompactEnabled(),
      compacted: s !== null,
      compaction: s
        ? {
          covered: s.covered, source: s.source, at: s.at, reason: s.reason,
          beforeTokens: s.beforeTokens, afterTokens: s.afterTokens, sourcePath: s.sourcePath ?? null,
          anchors: s.anchors?.length ?? 0,
        }
        : null,
      memory: {
        compactions: this.compactions,
        foldedMessages: s?.covered ?? 0,
        anchors: s?.anchors?.length ?? 0,
        retrievals: this.retrievals,
      },
      economics: s
        ? (() => {
          const rounds = s.rounds ?? 0;
          const savedTokens = Math.max(0, s.beforeTokens - s.afterTokens) * rounds;
          const paidTokens = s.paidTokens ?? null;
          return {
            rounds,
            savedTokens,
            paidTokens,
            netTokens: savedTokens - (paidTokens ?? 0),
            settled: paidTokens !== null && rounds > 0,
          };
        })()
        : null,
      budgetChars: toolResultBudgetChars(this.lastRequestTokens, this.contextWindow.tokens, this.charsPerToken),
    };
  }

  /**
   * 手动压一次。压不动就说压不动，并说明为什么 —— 一个回 200 但什么都没做的端点，会让用户以为
   * 上下文已经变小了。
   *
   * 手动这条路**不受「接近窗口时自动压缩」开关管**：那个开关的名字与设置页文案都是关于"自动"的，
   * 而这里是用户按下的按钮。两条自动路径（阈值、模型端溢出）都由开关把关 —— 见
   * `maybeCompact()` 与 catch 里的那段。
   */
  async forceCompact(reason = 'manual'): Promise<{ ok: boolean; reason?: string; beforeTokens?: number; afterTokens?: number }> {
    const before = estimateRequest(this.messagesForRequest().messages, this.overheadChars(), this.charsPerToken).tokens;
    const done = await this.compactNow(reason, {});
    if (!done) {
      return {
        ok: false,
        beforeTokens: before,
        reason: '压不动：历史太短，或者找不到落在 assistant 消息上的切点。'
          + '切在 user 上会得到连续两条 user，请求当场不合法（摘要以 user 角色插入），所以宁可不动。',
      };
    }
    return {
      ok: true,
      beforeTokens: before,
      afterTokens: estimateRequest(this.messagesForRequest().messages, this.overheadChars(), this.charsPerToken).tokens,
    };
  }

  /**
   * 到窗口的百分之多少就压。
   *
   * 压过一次之后阈值抬到 0.95：压缩只折叠一次，之后每一轮都在摘要后面追加。阈值不抬的话，压完
   * 紧接着又会越线 —— 于是每轮压一次、每轮改一次前缀，那正是这个设计要避免的东西。抬到很高而不是
   * 抬到 1：真到了窗口边缘还是得压，否则会话又会卡死在同一个地方。
   */
  private compactAtShare(): number {
    const configured = (this.config as { context?: { compactAtShare?: number } }).context?.compactAtShare;
    const base = typeof configured === 'number' && Number.isFinite(configured) && configured > 0.1 && configured < 1
      ? configured
      : 0.8;
    return this.compactionState ? Math.max(base, 0.95) : base;
  }

  /**
   * 「接近窗口时自动压缩」。**关掉就是关掉**：阈值与模型端溢出这两条自动路径都归它管。
   *
   * 默认开着，和 `context.compression` / `allowHistoryReduction` 的"默认什么都不做"不冲突：
   * 那两个开关改的是用户的东西（删不删历史），这个改的是"发出去的那一份"，盘上一条不丢 —— 而
   * 关掉它的后果不是"什么都不做"，是会话一到窗口就死在那儿。所以关掉时也不能静默失败：溢出那条
   * 路会报出开关位置和我们以为的窗口大小，因为用户此刻的问题正是"一到上限就不动了"。
   */
  private autoCompactEnabled(): boolean {
    return (this.config as { context?: { autoCompact?: boolean } }).context?.autoCompact !== false;
  }

  /**
   * 不在 messages 里、但和它们一起决定这次请求大小的那部分：**工具表**。
   *
   * 它必须算进去：实测 32 个工具 23,474 字符 ≈ 6.8k tokens（40k 窗口的六分之一），漏掉它估算
   * 就系统性偏小，而偏小的方向正好是"该压的时候不压"。
   *
   * **系统消息不在这里。** 它已经是 `messagesForRequest()` 的第一条，再算一遍就是重复计入 ——
   * 实测那一份 20,748 字符 ≈ 6k tokens，足以让触发线整体前移（对 40k 窗口是 15%），也就是
   * "还没到该压的时候就压了"：一次白付的缓存未命中，外加一段提前离开上下文的细节。这个数字
   * 来自一次实测对账（`scripts/context-measure.mjs`），不是推理出来的。
   */
  private overheadChars(): number {
    const m = this.overheadMemo;
    if (m && m.tools === this.allToolDefs) return m.chars;
    const chars = JSON.stringify(this.allToolDefs).length;
    this.overheadMemo = { tools: this.allToolDefs, chars };
    return chars;
  }

  /** 压缩记录落在哪。没有会话就没有可落的地方（子 agent 也走这条路，但它有自己的会话目录）。 */
  private compactionFile(): string | null {
    if (!this.sessionId) return null;
    try {
      return join(sessionStateDir(this.config.workspace.root, this.sessionId), 'compaction.json');
    } catch {
      return null;
    }
  }

  /**
   * 读回这条会话已经冻结的摘要。
   *
   * 这里只做**形状校验**：边界对不对由 `compactionCut()` 在每次请求前判（历史可能在两次请求之间
   * 被改写，那时这份记录就该作废、下次重新压）。用不了的文件**挪到一边**而不是就地覆盖 —— 仓库对
   * `.she/` 下所有文件的约定都是这样（`state-file.ts`），而这里手写一份小的，是因为
   * agent-runtime 不能反向依赖 server 包。
   */
  private restoreCompaction(): void {
    const file = this.compactionFile();
    if (!file) return;
    let rec: Partial<CompactionState>;
    try {
      rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<CompactionState>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.quarantineCompaction(file, `不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!rec || rec.v !== 1 || typeof rec.digest !== 'string' || typeof rec.nextFingerprint !== 'string'
      || typeof rec.covered !== 'number' || rec.digest.length < MIN_DIGEST_CHARS) {
      this.quarantineCompaction(file, '内容形状不符合压缩记录');
      return;
    }
    this.compactionState = rec as CompactionState;
    log.info(`复用已冻结的摘要（覆盖 ${rec.covered} 条，${rec.source === 'model' ? '模型总结' : '机械折叠'}）`);
  }

  /** 把用不了的压缩记录挪到一边（不删），并说清为什么。 */
  private quarantineCompaction(file: string, why: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let backup = `${file}.unusable-${stamp}`;
    for (let n = 1; existsSync(backup); n++) backup = `${file}.unusable-${stamp}-${n}`;
    try {
      renameSync(file, backup);
      log.warn(`压缩记录用不了（${why}），已挪到 ${backup}；下次重新压一次`);
    } catch (err) {
      log.warn(`压缩记录用不了（${why}），且没能挪走：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 落盘。原子写（tmp + rename）：半个文件比没有文件更坏 —— 恢复时它会当成一份可用的摘要。
   */
  private persistCompaction(): void {
    const file = this.compactionFile();
    const state = this.compactionState;
    if (!file || !state) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (err) {
      log.warn(`压缩记录没能落盘（下次会重新压一次）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 把被折叠的那一段原文落盘，让压缩不再等于"永久丢失"。
   *
   * 摘要是有损的（模型写的那份尤其），而模型之后很可能要引用具体某一行输出或某条报错原文。落一
   * 份原文、抬头给出路径，它就能用 `fs_read` 按需取回 —— `tool-output.ts` 对超预算的工具结果早
   * 就在这么做，压缩这一层此前缺的正是同一个保证。
   *
   * 返回工作区相对路径（工具认这个），失败或不在工作区内则返回 null。
   */
  private spillCompacted(head: readonly LLMMessage[], at: string): { path: string | null; blob: string } {
    // 落盘的内容就是这一串；核对锚点用的也是它（同一个字符串，不必再读一次文件）。
    const blob = head.map((m) => JSON.stringify(m)).join('\n');
    if (!this.sessionId) return { path: null, blob };
    try {
      const dir = join(sessionStateDir(this.config.workspace.root, this.sessionId), 'compacted');
      mkdirSync(dir, { recursive: true });
      const name = `${at.replace(/[:.]/g, '-')}-${head.length}.jsonl`;
      const file = join(dir, name);
      writeFileSync(file, blob, 'utf8');
      const rel = relative(resolve(this.config.workspace.root), file).split('\\').join('/');
      if (!rel || rel.startsWith('..')) return { path: null, blob };
      return { path: rel, blob };
    } catch (err) {
      log.warn(`被折叠的原文没能落盘（摘要照常）：${err instanceof Error ? err.message : String(err)}`);
      return { path: null, blob };
    }
  }

  /** 学到的上限按"哪个端点上的哪个模型"记 —— 换模型不该继承上一个模型的边界。 */
  private windowKey(): string {
    return `${this.modelLabel}|${this.config.llm.baseUrl}`;
  }

  private contextWindowFile(): string | null {
    try {
      return workspaceStateFile(this.config.workspace.root, 'context-window.json');
    } catch {
      return null;
    }
  }

  /**
   * 上一次被模型端拒绝时，它自己在报文里给出的上限。
   *
   * 只认同一个 key（模型 + 端点）的记录：把 A 模型的上限用在 B 模型上，比不学还坏 —— 那是一个
   * 看起来有依据的错误数字。
   */
  private learnedWindow(): number | undefined {
    const file = this.contextWindowFile();
    if (!file) return undefined;
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; key?: unknown; tokens?: unknown };
      if (!rec || rec.v !== 1 || rec.key !== this.windowKey()) return undefined;
      const n = Number(rec.tokens);
      return Number.isFinite(n) && n >= 4096 ? Math.trunc(n) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 记下学到的上限（原子写）。写不进去只影响"下次还要再学一遍"，不影响这次会话。 */
  private recordLearnedWindow(tokens: number, detail: string): void {
    const file = this.contextWindowFile();
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        v: 1,
        key: this.windowKey(),
        tokens,
        at: new Date().toISOString(),
        detail: detail.slice(0, 300),
      }, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (err) {
      log.warn(`学到的窗口没能落盘（下次会再学一遍）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 校准文件的落点（工作区级：换算比是"这个端点 + 这个模型"的属性，不是某条会话的）。 */
  private estimateCalibrationFile(): string | null {
    try {
      return workspaceStateFile(this.config.workspace.root, 'estimate-calibration.json');
    } catch {
      return null;
    }
  }

  /**
   * 读回这台机器上、这个端点/模型下已经量出来的换算比。
   *
   * 只认同一个 key（模型 + 端点）：把 A 模型的分词器比例用在 B 模型上，比不校准还坏 —— 那是一个
   * 看起来有依据的错误数字。写坏了（超范围、不是数）就退回先验，下次重新量。
   */
  private restoreEstimateCalibration(): void {
    const file = this.estimateCalibrationFile();
    if (!file) return;
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; key?: unknown; charsPerToken?: unknown; samples?: unknown };
      if (!rec || rec.v !== 1 || rec.key !== this.windowKey()) return;
      const n = Number(rec.charsPerToken);
      if (!Number.isFinite(n) || n < 2.5 || n > 5) return;
      this.charsPerToken = n;
      if (Array.isArray(rec.samples)) {
        this.estimateSamples = rec.samples
          .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0)
          .slice(-20);
      }
      log.info(`换算比按实测校准：${n} 字符/token（${this.estimateSamples.length} 个样本）`);
    } catch {
      /* 坏文件当没有：先验常量仍然是对的起点 */
    }
  }

  /**
   * 观测一次：我们发了 `chars` 个字符，模型数出 `tokens` 个 token。
   *
   * 只在换算比真的动了（1% 以上）才换：每轮抖一下没有意义，而且它会在状态行里闪。落盘失败只影响
   * "下次重新学"，不影响这次会话。
   */
  private observeCharsPerToken(chars: number, tokens: number): void {
    const sample = chars / tokens;
    if (!Number.isFinite(sample) || sample <= 0) return;
    /*
     * 数量级不对的样本**不算**。真实的换算比差异来自分词器与语言，量级在 ±50% 以内；而差一个数量级
     * 的"样本"说明那个数字根本不是 prompt token（本仓库的判据脚本里就有一个固定报 100 的桩）。把它
     * 当换算比会把"什么时候压"整体带偏，而带偏的方向可能正是撞墙的那一侧。
     */
    if (sample < CHARS_PER_TOKEN / 2 || sample > CHARS_PER_TOKEN * 2) return;
    this.estimateSamples.push(Number(sample.toFixed(3)));
    if (this.estimateSamples.length > 20) this.estimateSamples = this.estimateSamples.slice(-20);
    const next = calibrateCharsPerToken(this.estimateSamples);
    if (Math.abs(next - this.charsPerToken) / this.charsPerToken < 0.01) return;
    const was = this.charsPerToken;
    this.charsPerToken = next;
    this.persistEstimateCalibration();
    const said = `换算比按 ${this.estimateSamples.length} 个真实样本校准：${was} → ${next} 字符/token（只影响"什么时候压"，不改发出去的字节）`;
    log.info(said);
    this.runRecorder?.step(said);
  }

  private persistEstimateCalibration(): void {
    const file = this.estimateCalibrationFile();
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        v: 1,
        key: this.windowKey(),
        charsPerToken: this.charsPerToken,
        samples: this.estimateSamples.slice(-20),
        at: new Date().toISOString(),
      }, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (err) {
      log.warn(`换算比没能落盘（下次重新学）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 生成摘要：**优先让模型写**，失败或太短就退回机械提取。
   *
   * 机械提取不是失败 —— 真正失败的是"压不动"（没有合法切点、或压完没变小）。所以两条路里任何一条
   * 交回一份可用摘要，这次压缩就算成立；`source` 跟着摘要一起存下来并显示给用户，机械摘要不会
   * 看起来像模型总结。
   *
   * 取样有界（DIGEST_SOURCE_MAX_CHARS）：生成摘要的这次调用自己不能溢出，否则救援代码会先撞墙。
   * `track` 是这一轮的用量漏斗：这次调用真的花了钱，就该记在账上，而它也真的是一次模型请求。
   */
  private async writeDigest(
    head: readonly LLMMessage[],
    track?: (c: StreamChunk) => void,
  ): Promise<{ text: string; source: 'model' | 'extractive' }> {
    const fallback = () => ({ text: summarizeExtractively(head, DIGEST_MAX_CHARS), source: 'extractive' as const });
    const ask: LLMMessage[] = [
      { role: 'system', content: DIGEST_INSTRUCTION },
      { role: 'user', content: digestSourceText(head, DIGEST_SOURCE_MAX_CHARS) },
    ];
    // 摘要这一次调用也观测：它**不带工具表**，所以固定开销是 0，别把工具表的字符算进去。
    this.pendingRequestChars = estimateRequest(ask, 0, this.charsPerToken).chars;
    try {
      const reply = await this.provider.chat(ask, [], track);
      const text = (reply.content ?? '').trim();
      if (text.length >= MIN_DIGEST_CHARS) return { text: text.slice(0, DIGEST_MAX_CHARS), source: 'model' };
      log.warn(`摘要太短（${text.length} 字符），改用机械提取`);
      return fallback();
    } catch (err) {
      log.warn(`模型写摘要失败（${err instanceof Error ? err.message : String(err)}），改用机械提取`);
      return fallback();
    }
  }

  /**
   * 压一次：把历史的前一段换成一份冻结的摘要。返回"这次真的压了吗"。
   *
   * 四条约束缺一不可，每条都有它的来路：
   *   1. 切点落在 assistant 上 —— 摘要以 user 角色插入，切在 user 上会让请求不合法（见
   *      `chooseCutIndex`）；
   *   2. 摘要冻结 —— 写进 state 与盘上，之后每轮原样重发，不再重算（重算 = 每轮改前缀 = 每轮全价）；
   *   3. 压完确实更小 —— 算一遍对账。没变小就如实说压不动，而不是把"压过了"报上去；
   *   4. 盘上的转写一条不动 —— 压的只是发给模型的那一份，`historyForDisk()` 不受影响。
   */
  private async compactNow(
    reason: string,
    opts: { onChunk?: (c: StreamChunk) => void; track?: (c: StreamChunk) => void; keepScale?: number } = {},
  ): Promise<boolean> {
    if (this.compacting) return false;
    const history = this.history;
    const cut = chooseCutIndex(history, keepTokensFor(this.contextWindow.tokens, opts.keepScale ?? 1));
    if (cut <= 0) {
      // 静默的拒绝最难查：轨迹里有一条，日志里什么都没有。两边都要有，理由见下一条。
      const why = `上下文压缩没有做成：找不到可用的切点（历史 ${history.length} 条，保留目标 ${keepTokensFor(this.contextWindow.tokens, opts.keepScale ?? 1)} tokens）`;
      log.warn(why);
      this.runRecorder?.step(why);
      return false;
    }
    const before = estimateRequest(this.messagesForRequest().messages, this.overheadChars(), this.charsPerToken).tokens;
    this.compacting = true;
    try {
      const head = history.slice(0, cut);
      const at = new Date().toISOString();
      /*
       * 先落原文，再写摘要：摘要抬头要带上那个路径，而路径只在**这一刻**算一次（之后逐字节不变，
       * 见 `digestMessage`）。落盘失败不影响压缩 —— 抬头会退回"原文不在摘要里"的说法，而不是给
       * 一个读不到的路径。
       */
      const spilled = this.spillCompacted(head, at);
      const sourcePath = spilled.path;
      const digest = await this.writeDigest(head, opts.track);
      /*
       * 可选：摘要之外再附一段**机械摘录**（原文要点，有界）。
       *
       * 模型写的摘要是叙事性的，具体的事实（编号、暗号、路径、数字）可能在改写里被抹平；机械摘录是
       * 逐条的原文采样，它保住那些具体的东西。代价是摘要变大（上限 1500 字符 ≈ 0.5k token），
       * 收益是"压缩之后早期的事实还在不在"。
       *
       * 现在由环境变量开关，因为这是一次 **A/B 实验**：先量它到底救不救得了东西，再决定要不要默认开。
       * 量它的判据是 scripts/context-survival-probe.mjs。
       */
      const appendix = process.env.SHE_DIGEST_APPENDIX === '1'
        ? (() => {
          const lines = userLinesExcerpt(head);
          return lines ? `\n\n用户原话摘录（逐条，各留开头；事实/编号/暗号看这里）：\n${lines}` : '';
        })()
        : '';
      if (appendix) digest.text = `${digest.text}${appendix}`;
      const state: CompactionState = {
        v: 1,
        covered: cut,
        nextFingerprint: fingerprint(history[cut]),
        digest: digest.text,
        source: digest.source,
        at,
        reason,
        sourcePath,
        paidTokens: null,
        rounds: 0,
        /*
         * 锚点算一次就进 state：它和摘要一样要冻结，否则每压一次抬头就变一次。
         *
         * 只在原文真的落了盘、并且**逐条核对过**时才留：抬头那句话是在说"这些串在原文里出现过"，
         * 那就得真的是这样（见 `anchorsIn`）。落盘失败时给个空表 —— 没有原文，锚点就是装饰。
         */
        anchors: spilled.path ? anchorsIn(spilled.blob, retrievalAnchors(head)) : [],
        beforeTokens: before,
        afterTokens: 0,
      };
      /*
       * 对账用的是**同一个**系统消息对象（`systemMessage()`）：请求那份和这一步必须逐字节相同，
       * 否则"压完到底小了没有"算的是另一个请求。
       */
      const after = estimateRequest(
        appliedMessages(history, state, this.systemMessage()).messages,
        this.overheadChars(),
        this.charsPerToken,
      ).tokens;
      if (after >= before) {
        const why = `上下文压缩没有做成：压完没有变小（${before} → ${after} tokens，窗口 ${this.contextWindow.tokens}，覆盖 ${cut} 条），不改`;
        log.warn(why);
        this.runRecorder?.step(why);
        return false;
      }
      state.afterTokens = after;
      this.compactionState = state;
      this.compactions += 1;
      this.persistCompaction();
      // 紧接着那一次请求会付掉前缀重算的钱，等 usage 回来量它。
      this.awaitingMissSample = true;
      const how = state.source === 'model' ? '模型总结' : '机械提取';
      const why = reason === 'overflow' ? '模型端拒绝了超长提示词' : reason === 'threshold' ? '接近窗口上限' : '手动';
      opts.onChunk?.({
        type: 'status',
        content: `上下文压缩（${why}）：较早的 ${cut} 条记录换成一份摘要（${how}），${before} → ${after} tokens`,
      });
      this.runRecorder?.step(`上下文压缩（${why}）：覆盖 ${cut} 条，${before} → ${after} tokens，摘要来源 ${state.source}`);
      return true;
    } finally {
      this.compacting = false;
    }
  }

  /**
   * 到阈值就先压一次，然后照常发这一轮。
   *
   * 放在**发请求之前**：这是唯一不花钱的一刻 —— 压完还发得出去，就没有那次必然失败的请求，也没有
   * 用户看到的红字。模型端那条路（`isContextOverflowError`）是兜底，管的是"我们猜的窗口偏大"或者
   * "一次工具调用就把历史顶过了窗口"。
   */
  private async maybeCompact(
    messages: LLMMessage[],
    onChunk?: (c: StreamChunk) => void,
    track?: (c: StreamChunk) => void,
  ): Promise<void> {
    if (!this.autoCompactEnabled()) return;
    const estimate = estimateRequest(messages, this.overheadChars(), this.charsPerToken);
    const limit = Math.round(this.contextWindow.tokens * this.compactAtShare());
    /*
     * 到线之前**不打日志**（每一轮都打会淹掉别的），到线才说 —— 而"离线多远"由状态接口回答。
     * 这一行是给"它到底压没压、按什么判断"用的：出问题时它就是第一个该看的数字。
     */
    if (estimate.tokens < limit) return;
    log.info(`到上下文阈值：${estimate.tokens} ≥ ${limit} tokens（窗口 ${this.contextWindow.tokens}），开始压缩`);
    const done = await this.compactNow('threshold', { onChunk, track });
    if (!done) return;
    // 压成功了才动这个数组：没压的时候它必须逐字节等于压之前 —— 见 messagesForRequest 的注释。
    const fresh = this.messagesForRequest().messages;
    messages.splice(0, messages.length, ...fresh);
  }

  setHistory(messages: LLMMessage[]): void {
    // A stored transcript can already be the broken shape. Heal it on the way
    // in, or the first request after a restart repeats the same 400.
    this.history = repairApiMessages(messages);
    this.lastPending = null;
    this.lastPatch = null;
  }

  /**
   * Drop tool calls the endpoint would reject.
   *
   * A call with no id or no name cannot be paired with a result. Sending it
   * makes the next request fail, and every request after that fails the same
   * way. The call is noted in the text instead.
   */
  private usableToolCalls(response: LLMMessage): LLMMessage {
    if (!response.tool_calls?.length) return response;
    const valid = response.tool_calls.filter((tc) => tc.id && tc.function?.name);
    if (valid.length === response.tool_calls.length) return response;
    const dropped = response.tool_calls.length - valid.length;
    const note = `（忽略了 ${dropped} 个缺少名称或 id 的工具调用）`;
    const content = `${response.content || ''}${response.content ? '\n' : ''}${note}`;
    if (!valid.length) {
      const { tool_calls: _drop, ...rest } = response;
      return { ...rest, content };
    }
    return { ...response, content, tool_calls: valid };
  }

  /**
   * End a turn that failed without leaving the transcript unsendable.
   *
   * An exception used to escape with the user message (or a tool call) as the
   * last row. The next message then sent that broken tail and failed the same
   * way, so one error retired the conversation.
   */
  private failTurn(err: unknown, onChunk?: (chunk: StreamChunk) => void): LLMMessage {
    this.history = repairApiMessages(this.history);
    this.flushInterjections();
    const detail = err instanceof Error ? err.message : String(err);
    /*
     * Name where it failed — 模型端错误 / 网络问题 / 本地错误 — because the advice differs: a
     * provider error may need a different key or model, a network one just another try, a local
     * one a bug report. The text is appended as a new assistant row (history stays append-only).
     */
    const kind = classifyLlmFailure(err);
    const label = failureLabel(kind);
    const text = `（这一轮没有完成——${label}：${detail}）\n\n可以直接再说一次，或回复「继续」。`;
    const msg: LLMMessage = { role: 'assistant', content: text };
    this.history.push(msg);
    onChunk?.({ type: 'text', content: text });
    onChunk?.({ type: 'status', content: `这一轮失败（${label}），但对话可以继续`, notice: { kind, action: 'continue' } });
    log.warn(`turn failed, transcript kept usable: ${detail}`);
    /*
     * Record the failure where the trace can see it, rather than only in the transcript.
     *
     * `finishRun` derives `ok` from this field instead of from whether anything threw, because
     * this method RETURNS a normal message — to the caller a failed turn is indistinguishable from
     * a completed one. The error event is written separately so the reason is visible at the point
     * it happened rather than only in the closing event, and the `end` that follows still carries
     * the same reason so a summary folded from a prefix of the file agrees with the whole.
     */
    this.runFailure = { reason: 'turn_failed', text: detail };
    this.runRecorder?.error(detail);
    return msg;
  }

  
  listCheckpoints(limit = 20) {
    return this.checkpoints.list(limit);
  }

  /**
   * The run trace store, so the server can list and replay runs. Null when this agent has no
   * conversation — see the field's comment; there is no trace to return rather than a shared one.
   */
  getRunTraceStore(): RunTraceStore | null {
    return this.runTrace;
  }

  undoLastCheckpoint(): { ok: true; path: string; checkpoint_id: string } {
    const cp = this.checkpoints.takeLatest();
    if (!cp) throw new Error('no checkpoint to undo');
    // Same jail as applying: a checkpoint entry is a file inside the workspace that decides where a
    // write goes, so it must be validated at the point of the write.
    const abs = resolveInsideWorkspace(this.config.workspace.root, cp.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, cp.before, 'utf8');
    this.history.push({
      role: 'assistant',
      content: `Undid apply on \`${cp.path}\` (restored pre-apply content).`,
    });
    return { ok: true, path: cp.path, checkpoint_id: cp.checkpoint_id };
  }

  undoCheckpoint(checkpointId: string): { ok: true; path: string; checkpoint_id: string } {
    const cp = this.checkpoints.take(checkpointId);
    if (!cp) throw new Error('unknown checkpoint');
    const abs = resolveInsideWorkspace(this.config.workspace.root, cp.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, cp.before, 'utf8');
    this.history.push({
      role: 'assistant',
      content: `Undid checkpoint on \`${cp.path}\`.`,
    });
    return { ok: true, path: cp.path, checkpoint_id: cp.checkpoint_id };
  }
  getPendingConfirm(): ConfirmTicketInfo | null {
    return this.lastPending?.ticket ?? null;
  }

  /**
   * 这一轮现在停着等什么 —— 在等谁、从什么时候开始等、工单是不是已经过期。
   *
   * 和 `getPendingConfirm()` 分开：那个回的是**工单**（确认卡片要拿它去换批准），这里回的是**状态**。
   * 一张过期的工单和"这一轮在等你"是两件事，而后者才是用户在界面上真正需要知道的那件。
   */
  getWaitingOn(): PendingWait | null {
    return describeWaiting(this.runPaused, this.lastPending?.ticket ?? null);
  }

  getPendingPatch(): PendingPatchInfo | null {
    if (this.lastPatch) return this.lastPatch;
    const all = this.patches.list();
    return all.length ? (all[all.length - 1] as PendingPatchInfo) : null;
  }

  getPendingPatches(): PendingPatchInfo[] {
    return this.patches.list() as PendingPatchInfo[];
  }

  async applyAllPatches(onChunk?: (chunk: StreamChunk) => void): Promise<LLMMessage> {
    const ids = this.patches.list().map((p) => p.patch_id);
    if (!ids.length) throw new Error('no pending patches');
    /*
     * Hold the trace open for the whole batch.
     *
     * Each `applyPatch` runs its own `withTurn`, and `withTurn` is what closes a run when its turn
     * ends. Without the hold, applying three patches would leave a trace that stops after the first
     * one — indistinguishable from a run that died there, which is exactly the reading this store
     * exists to make impossible.
     */
    this.runHold++;
    try {
      for (let i = 0; i < ids.length; i++) {
        const isLast = i === ids.length - 1;
        await this.applyPatch(ids[i], onChunk, { continueLoop: isLast });
      }
      // applyPatch on last already continued the loop; return last history assistant-ish
      return this.history[this.history.length - 1] ?? { role: 'assistant', content: `Applied ${ids.length} patches.` };
    } finally {
      this.runHold = Math.max(0, this.runHold - 1);
      this.closeRunIfDone();
    }
  }

  async rejectAllPatches(): Promise<{ rejected: string[] }> {
    const all = this.patches.list();
    const rejected: string[] = [];
    for (const p of all) {
      await this.rejectPatch(p.patch_id);
      rejected.push(p.path);
    }
    this.lastPatch = null;
    return { rejected };
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.allToolDefs];
  }

  /**
   * The system message exactly as it will be sent — the assembled text, not a re-derivation.
   *
   * Read by the cost guard. `evals/agent` grades a task called `greeting-cheap`, and what that task
   * is really about is "this request carried the fixed overhead and nothing else": the only durable
   * way to say that is to compare the request's prompt tokens against the overhead as it is *right
   * now*, because the overhead changes whenever anyone edits the prompt or adds a tool. A frozen
   * number goes stale silently (it did: a 13000 cap measured when the overhead was 10300 sat red
   * through five rounds of legitimate growth), while a number derived from these two strings moves
   * with them and still catches what it should — history, a resumed plan, tool output quoted back.
   *
   * A second copy of `getSystemPrompt(...)`'s arguments in another file would drift and the budget
   * would then be measuring text the model never sees, which is why this is a method here.
   */
  getSystemPromptText(): string {
    /*
     * Composed exactly as the request composes it, calibration block included: a cost reading that
     * omitted the block would under-report the overhead by exactly the block's size, which is the
     * direction that makes a regression look fine.
     */
    return this.systemMessageContent();
  }

  /**
   * Release resources the agent owns.
   *
   * Language servers are real child processes with their own memory footprint,
   * so they must not outlive the agent that started them.
   */
  /**
   * Change reasoning depth on the live provider.
   *
   * Rebuilding the agent to apply a slider move disposed the language server
   * mid-turn and aborted the work. The next model call picks this up; the
   * current HTTP request is left alone.
   */
  setThinkingLevel(level: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'): void {
    this.config.llm.thinkingLevel = level;
    const apply = (p: LLMProvider | null) => {
      const fn = (p as { setThinkingLevel?: (l: typeof level) => void } | null)?.setThinkingLevel;
      fn?.call(p, level);
    };
    apply(this.provider);
    apply(this.fallbackProvider);
  }

  async dispose(): Promise<void> {
    /*
     * Background jobs first, and synchronously.
     *
     * Disposal is called when a session is deleted, a workspace is switched, and the process is
     * shutting down. In all three the jobs' processes have to end with it — a dropped reference
     * does not stop a process, and a job whose owner is gone is one nobody can wait on, kill, or
     * even see.
     */
    this.sandboxTools.dispose?.();
    await this.lsp?.dispose();
    this.lsp = null;
  }
}
