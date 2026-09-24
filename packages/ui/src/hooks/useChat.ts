import { useState, useCallback, useRef } from 'react';
import { fetchJSON, streamSSE } from '../lib/api';

export interface ToolCallData {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface PendingPatch {
  patch_id: string;
  path: string;
  before: string;
  after: string;
  unified: string;
  created_at?: string;
  expires_at?: string;
}

export interface ConfirmTicket {
  ticket_id: string;
  tool: string;
  summary: string;
  created_at?: string;
  expires_at?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** Chain-of-thought from reasoning models; display-only. */
  reasoning?: string;
  toolCalls?: ToolCallData[];
  /** For role === 'tool': which tool produced this result. */
  toolName?: string;
  /**
   * For role === 'tool': the id of the tool call it answers.
   *
   * Lets the UI pair a result with the call that produced it, so the tool card
   * can show what ran AND what came back, instead of two disconnected bubbles.
   */
  toolCallId?: string;
  isStreaming?: boolean;
  /** Set while reasoning is still streaming and content has not started. */
  isThinking?: boolean;
  /** Work-group speaker. Absent in a 1:1 chat. */
  speaker?: { name: string; hue: number };
}

export interface StreamChunk {
  type:
    | 'text'
    | 'reasoning'
    | 'tool_call_start'
    | 'tool_call_delta'
    | 'tool_call_end'
    | 'tool_result'
    | 'kb_result'
    | 'done'
    | 'error'
    | 'status'
    | 'needs_confirm'
    | 'needs_apply'
    | 'usage';
  content?: string;
  toolCall?: Partial<ToolCallData>;
  error?: string;
  ticket?: ConfirmTicket;
  patch?: PendingPatch;
  /** Present when type === 'kb_result'. */
  kbResult?: KBQueryResultData;
  /** Present when type === 'tool_result': which call this output belongs to. */
  toolCallId?: string;
  /** Present when type === 'tool_result': the tool that produced it. */
  toolName?: string;
}

export interface KBQueryResultData {
  nodes: unknown[];
  traces: unknown[];
  groupsVisited: string[];
  totalNodesScanned: number;
  queryTimeMs: number;
  pulseSeeds: unknown[];
}

interface ServerHistoryMessage {
  role: string;
  content?: string | null;
  /** Persisted chain-of-thought. The UI only displays it; the provider decides what is echoed. */
  reasoning?: string | null;
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
}

/**
 * Convert a persisted server transcript into renderable chat messages.
 * The server stores assistant messages with `tool_calls` (snake_case) and raw
 * `tool` rows; the UI renders tool activity via `toolCalls` and system notes.
 */
function normalizeHistory(raw: ServerHistoryMessage[]): ChatMessage[] {
  const nameByCallId = new Map<string, string>();
  for (const m of raw) {
    for (const tc of m.tool_calls ?? []) {
      if (tc?.id) nameByCallId.set(tc.id, tc.function?.name || 'tool');
    }
  }

  return raw.map((m): ChatMessage => {
    const content = typeof m.content === 'string' ? m.content : '';
    const reasoning = typeof m.reasoning === 'string' && m.reasoning ? m.reasoning : undefined;

    if (m.role === 'tool') {
      const name = m.tool_call_id ? nameByCallId.get(m.tool_call_id) : undefined;
      // Rendered as a collapsed card — raw tool output is reference material,
      // not conversation, and dominated the transcript when expanded.
      return { role: 'tool', content, toolName: name, toolCallId: m.tool_call_id };
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content,
        reasoning,
        toolCalls: m.tool_calls.map((tc) => ({
          id: tc.id || '',
          type: 'function' as const,
          function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' },
        })),
      };
    }

    if (m.role === 'user' || m.role === 'system') return { role: m.role, content };
    return { role: 'assistant', content, reasoning };
  });
}

export function useChat(sessionId?: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [latestKBResult, setLatestKBResult] = useState<KBQueryResultData | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmTicket | null>(null);
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [pendingPatches, setPendingPatches] = useState<PendingPatch[]>([]);
  /**
   * Record a stream/transport failure in the transcript, whatever the last message is.
   *
   * Extracted so both error paths share one behaviour. The rule it encodes: an error must always
   * become visible. The previous guard (`if (last.role === 'assistant')`) silently dropped the
   * error whenever the turn ended on a tool result — which is exactly where a tool-loop turn ends —
   * leaving a stopped turn with no explanation and a tool card that pulsed "执行中" forever.
   *
   * The error is appended to the last assistant bubble when there is one (it reads as a note on that
   * reply), and otherwise added as its own system message.
   */
  function appendStreamError(prev: ChatMessage[], message: string): ChatMessage[] {
    const text = `Error: ${message}`;
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i].role === 'assistant') {
        const updated = [...prev];
        const bubble = updated[i];
        updated[i] = {
          ...bubble,
          content: bubble.content ? `${bubble.content}\n\n${text}` : text,
          isStreaming: false,
          isThinking: false,
        };
        // Anything after the bubble (tool rows) stays where it is.
        return updated;
      }
    }
    return [...prev, { role: 'system', content: text } as ChatMessage];
  }

  const abortRef = useRef<AbortController | null>(null);
  const followRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const armFollowRef = useRef<(sid: string) => void>(() => {});
  /** Pausing only holds back rendering — the stream keeps running underneath. */
  const [isPaused, setIsPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = isPaused;
  /** Latest in-flight accumulators, used to flush the view on resume. */
  const activeAccRef = useRef<{ text: string; reasoning: string } | null>(null);

  /**
   * The session this window is bound to. Held in a ref so every callback reads
   * the current value without being re-created on each session switch — a
   * stale session id here is what made extra windows talk to the wrong agent.
   */
  const sidRef = useRef<string>('');
  sidRef.current = sessionId ?? '';
  /** Append `session_id` when known, so a request is never misrouted. */
  const withSid = (url: string, explicitSessionId?: string) => {
    const s = explicitSessionId || sidRef.current;
    return s ? `${url}${url.includes('?') ? '&' : '?'}session_id=${encodeURIComponent(s)}` : url;
  };

  const attachStreamHandlers = useCallback((
    acc: { text: string; reasoning: string },
    toolCalls: ToolCallData[],
    currentToolCallRef: { value: Partial<ToolCallData> | null },
  ) => {
    /**
     * Index of the assistant bubble currently being filled.
     *
     * A turn in a tool loop produces several assistant messages (think → call
     * tool → think again …). The server streams them into one SSE response, so
     * we open a FRESH bubble whenever a new round starts. Previously everything
     * was appended to a single bubble and the terminal `done` chunk overwrote it
     * with only the last round's text, which is why replies appeared to vanish.
     */
    let liveIdx = -1;
    /**
     * Index of the assistant message a tool call belongs to.
     *
     * `tool_call_start` is emitted while the bubble for that round is still the
     * live one, so the call is attached to it there. Without this the collected
     * tool calls were never attached to any message and stayed invisible until a
     * reload rebuilt them from history.
     */
    let callOwnerIdx = -1;

    const openBubble = () => {
      setMessages((prev) => {
        const updated = [...prev];
        updated.push({ role: 'assistant', content: '', isStreaming: true, isThinking: true });
        liveIdx = updated.length - 1;
        return updated;
      });
    };

    const patchLive = (patch: (m: ChatMessage) => ChatMessage) => {
      if (pausedRef.current) return;
      setMessages((prev) => {
        const updated = [...prev];
        if (liveIdx < 0 || !updated[liveIdx] || updated[liveIdx].role !== 'assistant') return prev;
        updated[liveIdx] = patch(updated[liveIdx]);
        return updated;
      });
    };

    /** Freeze the current bubble so the next round starts a new one. */
    const sealBubble = () => {
      setMessages((prev) => {
        const updated = [...prev];
        if (liveIdx >= 0 && updated[liveIdx]?.role === 'assistant') {
          updated[liveIdx] = { ...updated[liveIdx], isStreaming: false, isThinking: false };
        }
        return updated;
      });
      acc.text = '';
      acc.reasoning = '';
      liveIdx = -1;
    };

    return {
      onData: (data: unknown) => {
        const chunk = data as StreamChunk;
        switch (chunk.type) {
          case 'text': {
            if (liveIdx < 0) openBubble();
            acc.text += chunk.content ?? '';
            patchLive((m) => ({ ...m, content: acc.text, isThinking: false, isStreaming: true }));
            break;
          }

          case 'reasoning': {
            if (liveIdx < 0) openBubble();
            acc.reasoning += chunk.content ?? '';
            patchLive((m) => ({ ...m, reasoning: acc.reasoning, isThinking: !acc.text }));
            break;
          }

          case 'tool_call_start': {
            // A tool call ends this round's prose; the next round gets a new bubble.
            // Attach the call to the round that requested it before sealing.
            const tc = chunk.toolCall as ToolCallData;
            toolCalls.push(tc);
            setMessages((prev) => {
              const updated = [...prev];
              const target = liveIdx >= 0 ? liveIdx : updated.length - 1;
              const msg = updated[target];
              if (msg && msg.role === 'assistant') {
                updated[target] = { ...msg, toolCalls: [...(msg.toolCalls ?? []), tc] };
                callOwnerIdx = target;
              } else {
                // No prose preceded the call (tool-only round): give it a home.
                updated.push({ role: 'assistant', content: '', toolCalls: [tc], isStreaming: true });
                callOwnerIdx = updated.length - 1;
              }
              return updated;
            });
            currentToolCallRef.value = chunk.toolCall ?? null;
            sealBubble();
            break;
          }

          case 'tool_call_delta':
            if (currentToolCallRef.value && chunk.toolCall?.function?.arguments) {
              const existing = currentToolCallRef.value.function?.arguments ?? '';
              currentToolCallRef.value = {
                ...currentToolCallRef.value,
                function: {
                  name: currentToolCallRef.value.function?.name ?? chunk.toolCall.function?.name ?? '',
                  arguments: existing + chunk.toolCall.function.arguments,
                },
              };
              // Keep the pushed entry in sync while arguments stream in.
              const last = toolCalls[toolCalls.length - 1];
              if (last) toolCalls[toolCalls.length - 1] = currentToolCallRef.value as ToolCallData;
              // Mirror the partial arguments into the rendered card.
              const partial = currentToolCallRef.value as ToolCallData;
              setMessages((prev) => {
                const updated = [...prev];
                const msg = updated[callOwnerIdx];
                if (msg?.toolCalls?.length) {
                  const calls = [...msg.toolCalls];
                  calls[calls.length - 1] = partial;
                  updated[callOwnerIdx] = { ...msg, toolCalls: calls };
                }
                return updated;
              });
            }
            break;

          case 'tool_call_end':
            if (currentToolCallRef.value?.id) {
              toolCalls[toolCalls.length - 1] = currentToolCallRef.value as ToolCallData;
              const finalCall = currentToolCallRef.value as ToolCallData;
              setMessages((prev) => {
                const updated = [...prev];
                const msg = updated[callOwnerIdx];
                if (msg?.toolCalls?.length) {
                  const calls = [...msg.toolCalls];
                  calls[calls.length - 1] = finalCall;
                  updated[callOwnerIdx] = { ...msg, toolCalls: calls };
                }
                return updated;
              });
              currentToolCallRef.value = null;
            }
            break;

          case 'tool_result':
            /*
             * Mirrors what normalizeHistory produces for a stored `tool` row, so
             * live streaming and a reload render through the same path. Without
             * this the result only existed in server-side history and the card
             * looked empty until the page was reloaded.
             */
            if (chunk.toolCallId || chunk.content) {
              setMessages((prev) => [
                ...prev,
                {
                  role: 'tool',
                  content: chunk.content ?? '',
                  toolName: chunk.toolName,
                  toolCallId: chunk.toolCallId,
                },
              ]);
            }
            break;

          case 'kb_result': {
            const kr = (chunk as unknown as { kbResult?: KBQueryResultData }).kbResult;
            if (kr) setLatestKBResult(kr);
            break;
          }

          case 'needs_confirm':
            if (chunk.ticket) {
              setPendingConfirm(chunk.ticket);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `needs confirm: ${chunk.ticket!.tool} — ${chunk.ticket!.summary}`,
                },
              ]);
            }
            break;

          case 'needs_apply':
            if (chunk.patch) {
              setPendingPatch(chunk.patch);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `staged diff: ${chunk.patch!.path}`,
                },
              ]);
            }
            break;

          case 'usage':
            // StatusBar polls /api/usage; ignore locally
            break;

          case 'status':
            
          if ((data as any)?.task) {
            window.dispatchEvent(new CustomEvent('she:task', { detail: (data as any).task }));
          }if (chunk.content) {
              setMessages((prev) => [...prev, { role: 'system', content: chunk.content! }]);
            }
            break;

          case 'done':
            // The provider emits one `done` per LLM call inside the tool loop.
            // Only the last one ends the turn; intermediate ones just seal the
            // current bubble. Never overwrite accumulated text with the chunk's
            // content — that silently discarded everything but the final round.
            sealBubble();
            break;

          case 'error':
            /*
             * Report the failure even when the last message is not an assistant bubble.
             *
             * A tool-loop turn ends with a `role: 'tool'` message, and both this handler and the
             * transport `onError` below only wrote the error when the last message was an assistant
             * one. So a failure on the round AFTER a tool call — a 429, a dropped connection, a bad
             * key — produced no message at all: the turn simply stopped, and the pending tool card
             * stayed at `result === undefined`, rendering as an endless "执行中" animation.
             */
            setMessages((prev) => appendStreamError(prev, chunk.error ?? 'Unknown error'));
            setIsLoading(false);
            break;
        }
      },
    onError: (err: Error) => {
      setMessages((prev) => {
        const next = appendStreamError(prev, err.message);
        // Clear sticky streaming dots so the UI does not look still-alive.
        return next.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
      });
      setIsLoading(false);
      setIsPaused(false);
      window.dispatchEvent(new CustomEvent('she:stream-failed', { detail: { message: err.message } }));
      // The view dropped. The turn belongs to that conversation and keeps
      // running; coming back shows the result. Stopping here is what made
      // switching chats — or a quiet stretch of thinking — kill the work.
      if (abortRef.current?.signal.aborted) abortRef.current = null;
      armFollowRef.current(sidRef.current);
    },
    onDone: () => {
      setIsLoading(false);
    },
    };
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!text.trim() || isLoading) return;

    const userMsg: ChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    setPendingConfirm(null);
    setPendingPatch(null);
    setPendingPatches([]);

    // No assistant bubble is pre-created: the stream handler opens one per
    // round so each think/tool cycle renders as its own message.

    const controller = new AbortController();
    abortRef.current = controller;

    const acc = { text: '', reasoning: '' };
    activeAccRef.current = acc;
    const toolCalls: ToolCallData[] = [];
    const currentToolCallRef = { value: null as Partial<ToolCallData> | null };

    streamSSE(
      withSid('/api/chat'),
      { message: text, stream: true, session_id: sidRef.current },
      attachStreamHandlers(acc, toolCalls, currentToolCallRef),
      controller.signal,
      { idleTimeoutMs: 0 },
    );
  }, [isLoading, attachStreamHandlers]);

  const confirmPending = useCallback(() => {
    if (!pendingConfirm || isLoading) return;
    const ticketId = pendingConfirm.ticket_id;
    setIsLoading(true);
    setPendingConfirm(null);
    setPendingPatch(null);
    setPendingPatches([]);

    setMessages((prev) => [...prev, { role: 'system', content: `confirming ${ticketId}` }]);

    const controller = new AbortController();
    abortRef.current = controller;
    const acc = { text: '', reasoning: '' };
    activeAccRef.current = acc;
    const toolCalls: ToolCallData[] = [];
    const currentToolCallRef = { value: null as Partial<ToolCallData> | null };

    streamSSE(
      withSid('/api/chat/confirm'),
      { ticket_id: ticketId, stream: true, session_id: sidRef.current },
      attachStreamHandlers(acc, toolCalls, currentToolCallRef),
      controller.signal,
    );
  }, [pendingConfirm, isLoading, attachStreamHandlers]);

  const dismissConfirm = useCallback(() => {
    setPendingConfirm(null);
    setPendingPatch(null);
    setPendingPatches([]);
    setMessages((prev) => [...prev, { role: 'system', content: 'confirm cancelled' }]);
  }, []);


  const applyPendingPatch = useCallback(() => {
    if (!pendingPatch || isLoading) return;
    const patchId = pendingPatch.patch_id;
    setIsLoading(true);
    setPendingPatch(null);
    setPendingPatches([]);

    setMessages((prev) => [...prev, { role: 'system', content: `applying ${patchId}` }]);

    const controller = new AbortController();
    abortRef.current = controller;
    const acc = { text: '', reasoning: '' };
    activeAccRef.current = acc;
    const toolCalls: ToolCallData[] = [];
    const currentToolCallRef = { value: null as Partial<ToolCallData> | null };

    streamSSE(
      withSid('/api/fs/apply'),
      { patch_id: patchId, stream: true, session_id: sidRef.current },
      attachStreamHandlers(acc, toolCalls, currentToolCallRef),
      controller.signal,
    );
  }, [pendingPatch, isLoading, attachStreamHandlers]);

  const rejectPendingPatch = useCallback(async () => {
    if (!pendingPatch || isLoading) return;
    const patchId = pendingPatch.patch_id;
    const path = pendingPatch.path;
    setPendingPatch(null);
    setPendingPatches([]);
    try {
      await fetchJSON(withSid('/api/fs/reject'), { method: 'POST', body: { patch_id: patchId, session_id: sidRef.current } });
      setMessages((prev) => [...prev, { role: 'system', content: `rejected edit to ${path}` }]);
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: 'system', content: `reject failed: ${e.message || e}` }]);
    }
  }, [pendingPatch, isLoading]);

  const clearHistory = useCallback(async () => {
    /*
     * Clearing is irreversible from the UI, so it asks first.
     *
     * The transcript is the user's work; a stray click should not destroy it.
     * (Same hazard class as session delete / background remove.)
     */
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && !window.confirm('清空当前对话会删除全部消息，且无法撤销。确定吗？')) {
      return;
    }
    await fetchJSON(withSid('/api/chat/history'), { method: 'DELETE' });
    setMessages([]);
    setLatestKBResult(null);
    setPendingConfirm(null);
    setPendingPatch(null);
    setPendingPatches([]);
  }, []);

  /**
   * Load a transcript into the view.
   *
   * Pass an explicit session id whenever the caller already knows which
   * session it just switched to — reading `sidRef` immediately after
   * `setActiveSessionId` would race with React's render and load the wrong
   * (previous) conversation.
   */
  const loadHistory = useCallback(async (explicitSessionId?: string) => {
    const data = await fetchJSON<{ messages: ServerHistoryMessage[] }>(
      withSid('/api/chat/history', explicitSessionId),
    );
    setMessages(normalizeHistory(data.messages ?? []));
    const sid = explicitSessionId || sidRef.current;
    if (sid) armFollowRef.current(sid);
  }, []);


  const refreshPatches = useCallback(async () => {
    try {
      const data = await fetchJSON<{ patches: PendingPatch[] }>(withSid('/api/fs/patches'));
      const list = data.patches || [];
      setPendingPatches(list);
      setPendingPatch(list.length ? list[list.length - 1] : null);
    } catch {
      /* ignore */
    }
  }, []);

  const applyPatchById = useCallback((patchId: string) => {
    if (!patchId || isLoading) return;
    setIsLoading(true);
    setPendingPatches((prev) => prev.filter((p) => p.patch_id !== patchId));
    setPendingPatch(null);
    setMessages((prev) => [...prev, { role: 'system', content: `applying ${patchId}` }]);
    const controller = new AbortController();
    abortRef.current = controller;
    const acc = { text: '', reasoning: '' };
    activeAccRef.current = acc;
    const toolCalls: ToolCallData[] = [];
    const currentToolCallRef = { value: null as Partial<ToolCallData> | null };
    streamSSE(
      withSid('/api/fs/apply'),
      { patch_id: patchId, stream: true, session_id: sidRef.current },
      attachStreamHandlers(acc, toolCalls, currentToolCallRef),
      controller.signal,
    );
  }, [isLoading, attachStreamHandlers]);

  const rejectPatchById = useCallback(async (patchId: string) => {
    if (!patchId || isLoading) return;
    await fetchJSON(withSid('/api/fs/reject'), { method: 'POST', body: { patch_id: patchId, session_id: sidRef.current } });
    setMessages((prev) => [...prev, { role: 'system', content: `rejected ${patchId}` }]);
    await refreshPatches();
  }, [isLoading, refreshPatches]);

  const applyAllPatches = useCallback(() => {
    if (isLoading || pendingPatches.length === 0) return;
    setIsLoading(true);
    setPendingPatches([]);
    setPendingPatch(null);
    setMessages((prev) => [...prev, { role: 'system', content: 'applying all patches' }]);
    const controller = new AbortController();
    abortRef.current = controller;
    const acc = { text: '', reasoning: '' };
    activeAccRef.current = acc;
    const toolCalls: ToolCallData[] = [];
    const currentToolCallRef = { value: null as Partial<ToolCallData> | null };
    streamSSE(
      withSid('/api/fs/apply-all'),
      { stream: true, session_id: sidRef.current },
      attachStreamHandlers(acc, toolCalls, currentToolCallRef),
      controller.signal,
    );
  }, [isLoading, pendingPatches.length, attachStreamHandlers]);

  const rejectAllPatches = useCallback(async () => {
    if (isLoading || pendingPatches.length === 0) return;
    await fetchJSON(withSid('/api/fs/reject-all'), { method: 'POST', body: { session_id: sidRef.current } });
    setPendingPatches([]);
    setPendingPatch(null);
    setMessages((prev) => [...prev, { role: 'system', content: 'rejected all patches' }]);
  }, [isLoading, pendingPatches.length]);

  const stopStreaming = useCallback(() => {
    if (followRef.current) { clearInterval(followRef.current); followRef.current = null; }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setIsPaused(false);
    // Tell the server to abort the turn too — otherwise the agent kept running
    // (and billing tokens) after the browser disconnected.
    void fetchJSON(withSid('/api/chat/stop'), {
      method: 'POST',
      body: { session_id: sidRef.current },
    }).catch(() => undefined);
    setMessages((prev) => {
      /*
       * Clear the streaming flag on the last ASSISTANT message, not just the last message.
       *
       * A tool-loop turn ends with a `role: 'tool'` row, so `prev[prev.length - 1]` was that row —
       * which never has `isStreaming` set, so nothing was cleared. The owning assistant bubble kept
       * `isStreaming: true` for the rest of the session: the streaming dot pulsed forever, and since
       * the copy / rewind buttons are gated on `!msg.isStreaming`, they never appeared on that reply.
       * Only a reload repaired it.
       */
      const updated = [...prev];
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].role === 'assistant') {
          if (updated[i].isStreaming || updated[i].isThinking) {
            updated[i] = { ...updated[i], isStreaming: false, isThinking: false };
          }
          break;
        }
      }
      return updated;
    });
  }, []);

  /** Hold the view still; the stream keeps arriving in the background. */
  const pauseStreaming = useCallback(() => setIsPaused(true), []);

  /** Resume and catch the view up to everything received while paused. */
  const resumeStreaming = useCallback(() => {
    setIsPaused(false);
    const acc = activeAccRef.current;
    if (!acc) return;
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === 'assistant') {
        updated[updated.length - 1] = {
          ...last,
          content: acc.text,
          reasoning: acc.reasoning || last.reasoning,
          isThinking: !acc.text,
        };
      }
      return updated;
    });
  }, []);

  /**
   * Append context to the turn that is currently running, without stopping it.
   * The server queues it and the agent folds it in at the next iteration.
   */
  const interject = useCallback(async (text: string) => {
    const value = text.trim();
    if (!value) return;
    setMessages((prev) => [...prev, { role: 'user', content: value }]);
    try {
      await fetchJSON(withSid('/api/chat/interject'), {
        method: 'POST',
        body: { message: value, session_id: sidRef.current },
      });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: `追加失败：${(err as Error).message}` },
      ]);
    }
  }, []);

  /**
   * Rewind the conversation to (and including) the given message index: that
   * message and everything after it are dropped, and the truncated transcript is
   * persisted so the server agrees. Used by the "撤销到此" affordance.
   */
  const rewindTo = useCallback(async (index: number) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setIsPaused(false);

    let next: ChatMessage[] = [];
    setMessages((prev) => {
      next = prev.slice(0, Math.max(0, index));
      return next;
    });
    setPendingConfirm(null);
    setPendingPatch(null);
    setPendingPatches([]);

    try {
      await fetchJSON(withSid('/api/chat/rewind'), {
        method: 'POST',
        body: { index, session_id: sidRef.current },
      });
    } catch {
      // Fall back to persisting locally-truncated history.
      try {
        await fetchJSON(withSid('/api/chat/history'), {
          method: 'PUT',
          body: { messages: next, session_id: sidRef.current },
        });
      } catch { /* non-fatal */ }
    }
  }, []);

  /** Clear local transcript only (no server call) — for switching to a fresh session. */
  const resetLocal = useCallback(() => {
    if (followRef.current) { clearInterval(followRef.current); followRef.current = null; }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setIsPaused(false);
    setMessages([]);
    setLatestKBResult(null);
    setPendingConfirm(null);
    setPendingPatch(null);
    setPendingPatches([]);
  }, []);

  /**
   * Detach from the running turn WITHOUT stopping it server-side.
   *
   * Used when this window moves to a different conversation. The stream handlers close over
   * `setMessages`, and the hook instance survives a session switch — so without detaching, the turn
   * for session A kept appending into whatever transcript was on screen. The visible symptoms were a
   * stray `tool_result` card in B's conversation, and streamed text overwriting one of B's messages
   * (the live bubble is tracked by index).
   *
   * Deliberately not `/api/chat/stop`: the turn belongs to A and the server keeps no `close` handler,
   * so it finishes and persists into A's own history. Coming back to A shows the finished result
   * instead of having thrown the work away.
   */
  const detachStream = useCallback(() => {
    if (followRef.current) { clearInterval(followRef.current); followRef.current = null; }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setIsPaused(false);
    setPendingConfirm(null);
    setPendingPatch(null);
    setPendingPatches([]);
  }, []);

  /**
   * Keep showing a turn that is still running on the server.
   *
   * Switching chats aborts only this view. The agent keeps working. When the
   * user comes back, poll until the turn finishes and then load the result.
   * A local stream (abortRef set) is the live view — don't overwrite it.
   */
  const armFollow = useCallback((sid: string) => {
    if (followRef.current) { clearInterval(followRef.current); followRef.current = null; }
    if (!sid || abortRef.current) return;
    const pull = async () => {
      if (sidRef.current !== sid) return;
      const data = await fetchJSON<{ messages: ServerHistoryMessage[] }>(
        withSid('/api/chat/history', sid),
      );
      if (sidRef.current === sid) setMessages(normalizeHistory(data.messages ?? []));
    };
    void (async () => {
      try {
        const st = await fetchJSON<{ running: boolean }>(withSid('/api/chat/running', sid));
        if (sidRef.current !== sid || !st.running || abortRef.current) return;
        setIsLoading(true);
        await pull();
        followRef.current = setInterval(() => {
          void (async () => {
            if (sidRef.current !== sid) {
              if (followRef.current) { clearInterval(followRef.current); followRef.current = null; }
              return;
            }
            try {
              const again = await fetchJSON<{ running: boolean }>(withSid('/api/chat/running', sid));
              if (sidRef.current !== sid) return;
              if (!again.running) {
                if (followRef.current) { clearInterval(followRef.current); followRef.current = null; }
                await pull();
                setIsLoading(false);
                return;
              }
              setIsLoading(true);
              await pull();
            } catch { /* keep the interval */ }
          })();
        }, 2000);
      } catch { /* server unreachable; the transcript we already loaded stands */ }
    })();
  }, []);
  armFollowRef.current = armFollow;

  return {
    messages,
    isLoading,
    isPaused,
    latestKBResult,
    pendingConfirm,
    pendingPatch,
    sendMessage,
    confirmPending,
    dismissConfirm,
    applyPendingPatch,
    rejectPendingPatch,
    applyPatchById,
    rejectPatchById,
    applyAllPatches,
    rejectAllPatches,
    detachStream,
    pendingPatches,
    clearHistory,
    resetLocal,
    loadHistory,
    stopStreaming,
    pauseStreaming,
    resumeStreaming,
    interject,
    rewindTo,
  };
}
