import type {
  SheConfig,
  LLMProvider,
  LLMMessage,
  ToolDefinition,
  StreamChunk,
  ConfirmTicketInfo,
  PendingPatchInfo,
} from '@she/shared';
import { createLogger, resolveModel, resolveSubagentModel, describeModel } from '@she/shared';
import type { GroupKBEngine } from '@she/kb';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { getSystemPrompt, readSkillProfile } from './system-prompt.js';
import type { ToolSet } from '@she/sandbox';
import { PendingPatchStore, CheckpointStore, resolveInsideWorkspace } from '@she/sandbox';
import { createKBTools } from './kb-tools.js';
import { createPlanTools } from './plan-tools.js';
import { createPreflightTools } from './preflight.js';
import { ErrorBook, createErrorbookTools, isWorthRemembering, formatErrorEntry } from './errorbook.js';
import type { ErrorbookEngineLike, ErrorbookStoreLike, ErrorbookKind } from './errorbook.js';
import { classifyToolResult, annotateToolResult, isToolFailure, type ToolResultVerdict } from './tool-result.js';
import { LspManager, makeLspTools, executeLspTool } from './lsp-tools.js';
import { makeScheduleTools, executeScheduleTool } from './schedule-tools.js';
import type { ScheduleBridge, WindowView } from './schedule-tools.js';
import { createIngestTools } from './ingest-tools.js';
import { createMemoTools } from './memo-tools.js';
import { createSubagentTools, type SubagentRunner } from './subagent-tools.js';
import { repairApiMessages } from './protocol.js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
  private lastPending: { ticket: ConfirmTicketInfo; toolCallId: string; name: string; args: Record<string, unknown> } | null = null;
  private lastPatch: PendingPatchInfo | null = null;
  private patches: PendingPatchStore;
  private checkpoints: CheckpointStore;
  /**
   * User messages supplied while a turn is already running. Drained into the
   * conversation at the next tool-loop iteration so the user can add context
   * without stopping the agent.
   */
  private pendingInterjections: string[] = [];

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
    },
  ) {
    this.subagentRunner = opts?.subagentRunner ?? null;
    this.onTaskEvent = opts?.onTaskEvent ?? null;
    this.isSubagent = Boolean(opts?.isSubagent);
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
    }

    this.systemPrompt = getSystemPrompt(config.workspace.root, undefined, config.automationMode !== false);
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

    for (const def of sandboxTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => sandboxTools.execute(def.name, args));
    }

    const kbTools = createKBTools(kbEngine, {
      onQueryResult: (result) => {
        this.toolEventSink?.({ type: 'kb_result', kbResult: result });
      },
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
     */
    if (this.isSubagent) {
      const denied = /^(ask_user|task_spawn|plan_|preflight_|memo_|report_|kb_ingest_|schedule_)/;
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

    while (iterations < maxIterations) {
      if (signal?.aborted) {
        this.history = repairApiMessages(this.history);
        this.flushInterjections();
        const stopped: LLMMessage = { role: 'assistant', content: '（已中断）' };
        onChunk?.({ type: 'status', content: '已中断当前执行' });
        this.history.push(stopped);
        return stopped;
      }
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
        }
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
          return stopped;
        }
        if (this.fallbackProvider) {
          const msg = err instanceof Error ? err.message : String(err);
          track({ type: 'status', content: `主接口失败（${msg}），改备用接口…` });
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
        this.flushInterjections();
        return response;
      }

      for (const tc of response.tool_calls) {
        const name = tc.function.name;
        const executor = this.executors.get(name);

        let result: string;
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
            log.info(`Executing tool: ${name}`);
            const toolStart = Date.now();
            try {
              result = await executor(args);
              if (typeof result !== 'string') result = JSON.stringify(result ?? '');
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
              this.toolObserver?.(name, Date.now() - toolStart, toolFailed);
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
                  };
                  // The UI needs the real ticket to render the confirm card.
                  onChunk?.({
                    type: 'needs_confirm',
                    content: `needs confirm: ${parsed.needs_confirm.ticket_id}`,
                    ticket: parsed.needs_confirm,
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
        if (verdict && isWorthRemembering(verdict.kind)) {
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
        const seen = callSignatures.get(signature);
        if (seen) {
          seen.count++;
          if (seen.count >= repeatLimit) {
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
                  + '这说明当前方法没有产生任何变化，再调一次也是一样的结果。\n'
                  + '请先判断原因（文件是否真的写进去了？路径对吗？是不是缺依赖或权限不足？），'
                  + '然后用**不同的方式**再试一次。如果确实无法继续，直接告诉用户你卡在哪、需要什么。',
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
              callSignatures.set(signature, { count: repeatLimit - 1, result });
              continue;
            }

            onChunk?.({ type: 'status', content: `重复调用未改善，已停止：${detail}` });

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
    return fallback;
  }

  /**
   * Write a failure into the error book without letting bookkeeping break the turn.
   *
   * The book is a durable store the user can lose access to for reasons that have nothing to do
   * with this turn (a locked database, a full disk, a KB being re-indexed). None of those should
   * turn a tool call that already returned into a crashed conversation.
   */
  private recordMistake(report: {
    tool: string;
    kind: ErrorbookKind;
    call?: string;
    detail: string;
    remedy?: string | null;
  }): void {
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
      messages: [{ role: 'system', content: this.systemPrompt }, ...this.history],
    };
  }

  async chat(
    userMessage: string,
    onChunk?: (chunk: StreamChunk) => void,
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

    this.history.push({ role: 'user', content: userMessage });
    // Recorded before the loop starts so a tool called during it sees this request.
    this.lastUserRequest = userMessage;

    const { messages } = this.messagesForRequest();

    this.toolEventSink = onChunk ?? null;
    try {
      const reply = await this.runExclusive(messages, onChunk);
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
    return this.withTurn(() => this.runLoop(messages, onChunk));
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
    pending: { ticket: ConfirmTicketInfo; toolCallId: string; name: string; args: Record<string, unknown> },
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
    let result: string;
    let verdict: ToolResultVerdict;
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
    // Recorded like any other failure: a command the user approved and that then failed is
    // among the most worth remembering.
    if (isWorthRemembering(verdict.kind)) {
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
    const text = `（这一轮没有完成：${detail}）\n\n可以直接再说一次，或回复「继续」。`;
    const msg: LLMMessage = { role: 'assistant', content: text };
    this.history.push(msg);
    onChunk?.({ type: 'text', content: text });
    onChunk?.({ type: 'status', content: '这一轮失败，但对话可以继续' });
    log.warn(`turn failed, transcript kept usable: ${detail}`);
    return msg;
  }

  
  listCheckpoints(limit = 20) {
    return this.checkpoints.list(limit);
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
    for (let i = 0; i < ids.length; i++) {
      const isLast = i === ids.length - 1;
      await this.applyPatch(ids[i], onChunk, { continueLoop: isLast });
    }
    // applyPatch on last already continued the loop; return last history assistant-ish
    return this.history[this.history.length - 1] ?? { role: 'assistant', content: `Applied ${ids.length} patches.` };
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
