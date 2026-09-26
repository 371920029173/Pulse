import type {
  SheConfig,
  LLMProvider,
  LLMMessage,
  MessageImage,
  ToolDefinition,
  StreamChunk,
  ConfirmTicketInfo,
  PendingPatchInfo,
} from '@she/shared';
import { createLogger, resolveModel, resolveSubagentModel, describeModel } from '@she/shared';
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
import {
  ErrorBook, createErrorbookTools, isWorthRemembering, formatErrorEntry,
  EXPECT_FAILURE_ARG, isIntentionalFailure, withExpectFailureParam,
} from './errorbook.js';
import type { ErrorbookEngineLike, ErrorbookStoreLike, ErrorbookKind } from './errorbook.js';
import { classifyToolResult, annotateToolResult, isToolFailure, type ToolResultVerdict } from './tool-result.js';
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
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Tool calls one plan step may take before the reflection check calls the plan over budget. */
export const TOOL_CALLS_PER_PLAN_STEP = 8;

const log = createLogger('agent');

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
   * Sink for tool-originated stream events during the current turn. Set on
   * entry to each public method and cleared in a finally block.
   */
  private toolEventSink: ((chunk: StreamChunk) => void) | null = null;
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
  private readonly runTrace: RunTraceStore;
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
   * One per agent, file-backed under `.she/reflection/`, so a bias is visible across sessions
   * rather than resetting whenever the process restarts.
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
  /** `provider/model`, recorded on the `start` event so a trace says which model was answering. */
  private readonly modelLabel: string;
  /** `provider/model` of the spare, for the trace and the status line. Null when none is configured. */
  private readonly fallbackLabel: string | null = null;
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
    sandboxTools: ToolSet,
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
       * Injectable so a caller can point several agents at one directory (the server does) and so
       * a test can use a throwaway path. Defaults to `.she/runs/` under the workspace, because a
       * turn that leaves no trace is the gap this closes — making it opt-in would mean the runs
       * people most want to read are the ones that were never recorded.
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
     */
    this.runTrace = opts?.runTrace ?? new RunTraceStore(config.workspace.root);
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
    this.confidenceMirror = new ConfidenceMirror(config.workspace.root);

    for (const def of sandboxTools.definitions) {
      // `shell` is where intentional failures (a test run to watch it fail) happen, so it advertises
      // the error book's `expect_failure` switch; every tool honours it (see `recordMistake` callers).
      this.allToolDefs.push(def.name === 'shell' ? withExpectFailureParam(def) : def);
      this.executors.set(def.name, (args) => sandboxTools.execute(def.name, args));
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

    // Long-horizon affordances: durable plans, report artifacts, and asking.
    const planTools = createPlanTools(config.workspace.root, this.sessionId);
    this.planStore = planTools.store;
    for (const def of planTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => planTools.execute(def.name, args));
    }

    /*
     * Pre-flight intent analysis. Registered next to the plan tools because they are used
     * together — analyse the request, then write the plan that implements it.
     *
     * `listTools` reads `allToolDefs` lazily. At construction time the list is only half
     * built, so a snapshot taken here would under-report what this agent has and invent
     * missing prerequisites for tools that are in fact registered a few lines below.
     */
    const preflightTools = createPreflightTools(config.workspace.root, {
      sessionId: this.sessionId,
      getRequest: () => this.lastUserRequest,
      listTools: () => this.allToolDefs.map((d) => d.name),
      skillProfile: () => readSkillProfile(config.workspace.root),
      automationMode: () => config.automationMode !== false,
      activePlanGoal: () => planTools.store.active()?.goal,
      knownErrors: (query) => this.errorBook
        .lookup({ query, limit: 3 })
        .map((e) => formatErrorEntry(e)),
    });
    for (const def of preflightTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => preflightTools.execute(def.name, args));
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
        const rec = new PreflightStore(config.workspace.root, this.sessionId).latestForSession();
        return rec?.actual_goal || rec?.stated_intent || planTools.store.active()?.goal || null;
      },
      // Inferred constraints are passed as SOFT: pre-flight derived them from the request and the
      // workspace rather than from the user's words, and treating a derived preference as a hard
      // prohibition would report drift for ordinary work.
      constraints: () => {
        const rec = new PreflightStore(config.workspace.root, this.sessionId).latestForSession();
        return (rec?.inferred_constraints ?? []).map((text) => ({ text, hardness: 'soft' as const }));
      },
      actions: () => this.currentRunActions(),
      currentStep: () => planTools.store.active()?.steps.find((s) => s.status === 'active')?.title ?? null,
      budget: () => {
        const plan = planTools.store.active();
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
    const memoTools = createMemoTools(config.workspace.root);
    for (const def of memoTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => memoTools.execute(def.name, args));
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
          verdict = classifyToolResult(name, result);
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
                result = await executor(args);
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
              verdict = classifyToolResult(name, result);
              toolFailed = isToolFailure(verdict);
            } catch (err) {
              toolFailed = true;
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
              verdict = classifyToolResult(name, result);
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
            verdict = classifyToolResult(name, result);
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

        const toolMsg: LLMMessage = {
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result ?? ''),
          tool_call_id: tc.id,
        };
        this.history.push(toolMsg);
        messages.push(toolMsg);

        // Stream the output so the UI can show what the tool actually did while
        // the turn is still running. Previously results existed only in history,
        // so they appeared only after a reload — the transcript looked empty of
        // tool activity during live streaming.
        onChunk?.({ type: 'tool_result', toolCallId: tc.id, toolName: name, content: result });

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
               * Added to the REQUEST only, never to `history`.
               *
               * History is persisted and rendered, so a message pushed there appears
               * in the transcript — and with `role: 'user'` the user would see a line
               * they never wrote. The nudge is meaningful only for the remaining
               * rounds of this turn, so it belongs in the request alone.
               */
              messages.push(nudge);
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
  private messagesForRequest(): { messages: LLMMessage[] } {
    return {
      messages: [{ role: 'system', content: this.calibrationBlock ? `${this.systemPrompt}\n\n${this.calibrationBlock}` : this.systemPrompt }, ...this.history],
    };
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
    this.runFallback = null;
    this.runStartedAt = Date.now();
    // A new run starts with no tool events of its own, and no inherited pre-flight confidence: the
    // mirror's sample must attribute this turn's claim to this turn's outcome.
    this.runEvents = [];
    this.runPreflightConfidence = null;
    this.lastCritic = null;

    const recorder = this.runTrace.begin({
      prompt,
      sessionId: this.sessionId,
      model: this.modelLabel,
      agent: this.isSubagent ? 'subagent' : 'main',
      tools: this.allToolDefs.map((d) => d.name),
      mode: this.config.automationMode === false ? 'manual' : 'automation',
    });
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
      const rec = new PreflightStore(this.config.workspace.root, this.sessionId).latestForSession();
      if (rec) {
        recorder.preflight(rec);
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
     * The calibration block for this turn, computed ONCE and reused for every iteration.
     *
     * Rebuilt here rather than per request because the system message is the cache prefix: a block
     * that changed between iterations of one turn would invalidate the cache on every LLM call, and
     * the only thing it would be reflecting is the run's own progress, which the model already has
     * in front of it in the transcript.
     */
    this.calibrationBlock = this.buildCalibrationBlock();
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
        'often the tool calls in those runs actually succeeded. They are a measurement of this agent, not',
        'of the current task:',
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
      return new PreflightStore(this.config.workspace.root, this.sessionId).latestForSession() ?? null;
    } catch {
      return null;
    }
  }

  private readPreflightConfidence(): { confidence: number; clamped: boolean; topic?: string } | null {
    const rec = this.readPreflightRecord();
    // Ownership is already settled by `readPreflightRecord` (see `latestForSession`); the test
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
      usage: {
        prompt_tokens: this.tokenUsage.prompt_tokens,
        completion_tokens: this.tokenUsage.completion_tokens,
        total_tokens: this.tokenUsage.total_tokens,
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
    verdict = classifyToolResult(pending.name, result);
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
      content: result,
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

    // Continue the tool/LLM loop so multiple files can stage into Composer.
    const messages: LLMMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...this.history,
    ];
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

      // Already holding the turn lock — go straight to the loop.
      const messages: LLMMessage[] = [
        { role: 'system', content: this.systemPrompt },
        ...this.history,
      ];
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
   * The run trace store, so the server can list and replay runs.
   *
   * Exposed rather than proxied through per-method wrappers: the server's two read routes need
   * `list`, `read` and `corroborate`, and a wrapper for each would be three more things to keep in
   * step with the store. The store is read-mostly and every read is already safe on a missing
   * directory.
   */
  getRunTraceStore(): RunTraceStore {
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
    await this.lsp?.dispose();
    this.lsp = null;
  }
}
