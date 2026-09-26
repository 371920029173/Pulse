import { useState, useCallback, useRef } from 'react';
import { fetchJSON, streamSSE } from '../lib/api';
import { t } from '../lib/i18n';

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
  /**
   * Files the user attached to this turn.
   *
   * Shown as thumbnails on the user's bubble. The `path` is what actually goes to the model — the
   * bytes are read server-side at request time — so this survives a reload as long as the file is
   * still in `.she/attachments/`.
   */
  images?: Array<{ path: string; mime: string; name?: string; url?: string }>;
  /** Work-group speaker. Absent in a 1:1 chat. */
  speaker?: { name: string; hue: number };
  /**
   * A notice the user must not miss (reply cut off, connection dropped, turn failed).
   * `action: 'continue'` renders a 继续 button that appends a continuation turn.
   */
  notice?: { kind: 'length' | 'network' | 'provider' | 'local'; action?: 'continue' };
  /**
   * Identity of the live bubble a streaming round writes into. Client-only, never persisted.
   *
   * Positions in `messages` are not stable (history can be swapped in underneath a turn) and the
   * old mutable `liveIdx` was read lazily inside state updaters — see `attachStreamHandlers`.
   */
  streamRound?: string;
}

/**
 * What the 继续 button sends. A NEW user turn, appended — never an edit of the cut-off reply,
 * which would change the already-sent prefix and cost the provider's prefix cache.
 */
export const continuePrompt = (): string => t('继续（从上一条回答中断的地方接着写，不要重复已经写过的内容）');

/** Distinct prefix per handler set, so round keys from two streams never collide. */
let streamHandlerSeq = 0;

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
  /** Present on a `status` that must stay visible; see ChatMessage.notice. */
  notice?: ChatMessage['notice'];
  /** Present on `error`: where it failed (provider / network / local) and its Chinese label. */
  kind?: string;
  label?: string;
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
  /** Attachments on a user message, by path — the bytes are re-read server-side each turn. */
  images?: Array<{ path?: string; mime?: string }>;
}

/**
 * The preview URL for a stored attachment, or undefined when we cannot serve it.
 *
 * Reloaded history only carries paths, and the preview route is deliberately confined to
 * `.she/attachments/` — so a path from anywhere else gets no URL and renders as a file chip
 * instead of a broken image. Deciding that here keeps the check in one place rather than leaving
 * the component to guess from a 404.
 */
function attachmentPreviewUrl(path: string): string | undefined {
  const normalized = String(path ?? '').replace(/\\/g, '/');
  if (!normalized.includes('/.she/attachments/')) return undefined;
  const name = normalized.split('/').pop();
  if (!name) return undefined;
  return `/api/attachments/file?name=${encodeURIComponent(name)}`;
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

    // The plan autopilot resumes a turn with a `[自动续跑]` user message; it is the system talking, not the user.
    if (m.role === 'user' && content.startsWith('[自动续跑]')) return { role: 'system', content: '计划还没做完，自动继续下一步' };
    const images: Array<{ path: string; mime: string; name: string; url?: string }> = [];
    for (const im of m.images ?? []) {
      const imagePath = String(im?.path ?? '');
      if (!imagePath) continue;
      const name = imagePath.replace(/\\/g, '/').split('/').pop() ?? imagePath;
      images.push({ path: imagePath, mime: String(im?.mime ?? ''), name, url: attachmentPreviewUrl(imagePath) });
    }
    if (m.role === 'user' || m.role === 'system') {
      return { role: m.role, content, ...(images.length ? { images } : {}) };
    }
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
    /**
     * Key of the bubble for the round currently being filled (null = no round open).
     *
     * Every value an updater needs is captured at DISPATCH time, never read from mutable state
     * inside the updater. This is the fix for a real silent truncation (2026-09-26, a long reply
     * that stopped at 「……你手里的东西恰好是」 while the stored message was complete): the last
     * few `text` frames and the `done` frame arrived in ONE `read()`. React computed the first
     * update eagerly but queued the rest, and those read `acc.text` / `liveIdx` only when it
     * rendered — after `sealBubble` had already reset both. The tail was written into a fresh,
     * empty bubble that renders as nothing, and the visible reply simply ended mid-sentence.
     */
    let roundKey: string | null = null;
    let roundSeq = 0;
    const handlerId = ++streamHandlerSeq;
    const newKey = () => `r${handlerId}:${++roundSeq}`;
    const findKey = (list: ChatMessage[], key: string | null) => {
      if (!key) return -1;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].streamRound === key) return i;
      return -1;
    };
    /**
     * Key of the assistant message a tool call belongs to.
     *
     * `tool_call_start` is emitted while the bubble for that round is still the
     * live one, so the call is attached to it there. Without this the collected
     * tool calls were never attached to any message and stayed invisible until a
     * reload rebuilt them from history.
     */
    let callOwnerKey: string | null = null;

    /**
     * Patch the bubble for the round currently being filled, re-opening it if it went away.
     *
     * `liveIdx` is a POSITION in `messages`, and the transcript can be replaced underneath a live
     * turn: `loadHistory` binds history whenever the session changes, and the follow poll pulls it
     * every 2s. Neither can contain the turn that is still running — the turn is persisted only
     * when it ends — so after such a replacement `liveIdx` pointed at a message that was no longer
     * ours, the old code returned `prev`, and every later chunk was dropped on the floor. Nothing
     * appeared until the turn finished and the transcript was read back from disk, which is exactly
     * the complaint "the chain only shows up after generation".
     *
     * Re-opening from the accumulators is what makes the live view outrank a stale disk copy: the
     * text received so far stays on screen and the rest keeps streaming into the same place.
     */
    const patchLive = (fields: Partial<ChatMessage>) => {
      // The round opens even while paused, so `sealBubble` still lands its text.
      if (!roundKey) roundKey = newKey();
      if (pausedRef.current) return;
      const key = roundKey;
      const text = acc.text;
      const reasoning = acc.reasoning;
      setMessages((prev) => {
        const updated = [...prev];
        const idx = findKey(updated, key);
        if (idx < 0) {
          updated.push({
            role: 'assistant',
            content: text,
            reasoning,
            isStreaming: true,
            isThinking: !text,
            streamRound: key,
            ...fields,
          });
        } else {
          updated[idx] = { ...updated[idx], ...fields };
        }
        return updated;
      });
    };

    /**
     * Freeze the current bubble so the next round starts a new one.
     *
     * The round's final text is written here too (captured now, not at render time), so the
     * bubble always ends with everything that arrived — even if the last frames were not rendered
     * yet, or rendering was paused.
     */
    const sealBubble = () => {
      const key = roundKey;
      const text = acc.text;
      const reasoning = acc.reasoning;
      roundKey = null;
      acc.text = '';
      acc.reasoning = '';
      if (!key) return;
      setMessages((prev) => {
        const idx = findKey(prev, key);
        if (idx < 0) {
          if (!text && !reasoning) return prev;
          return [...prev, { role: 'assistant', content: text, reasoning, streamRound: key }];
        }
        const updated = [...prev];
        const m = updated[idx];
        updated[idx] = {
          ...m,
          content: text.length >= (m.content?.length ?? 0) ? text : m.content,
          reasoning: reasoning || m.reasoning,
          isStreaming: false,
          isThinking: false,
        };
        return updated;
      });
    };

    return {
      onData: (data: unknown) => {
        const chunk = data as StreamChunk;
        switch (chunk.type) {
          case 'text': {
            acc.text += chunk.content ?? '';
            patchLive({ content: acc.text, isThinking: false, isStreaming: true });
            break;
          }

          case 'reasoning': {
            acc.reasoning += chunk.content ?? '';
            patchLive({ reasoning: acc.reasoning, isThinking: !acc.text });
            break;
          }

          case 'tool_call_start': {
            // A tool call ends this round's prose; the next round gets a new bubble.
            // Attach the call to the round that requested it before sealing.
            /*
             * A frame with no `toolCall` used to be pushed into the list as `undefined`, and the
             * transcript then crashed on `tc.id` — a blank page for the rest of the session. The
             * server always sends one, but a malformed or half-written frame must not be able to
             * white-screen the app.
             */
            if (!chunk.toolCall) break;
            const tc = chunk.toolCall as ToolCallData;
            toolCalls.push(tc);
            // Captured now: `sealBubble` below clears `roundKey` before this updater runs.
            const liveKey = roundKey;
            const ownerKey = liveKey ?? newKey();
            callOwnerKey = ownerKey;
            setMessages((prev) => {
              const updated = [...prev];
              const liveAt = findKey(updated, liveKey);
              const target = liveAt >= 0 ? liveAt : updated.length - 1;
              const msg = updated[target];
              if (msg && msg.role === 'assistant') {
                updated[target] = { ...msg, toolCalls: [...(msg.toolCalls ?? []), tc], streamRound: msg.streamRound ?? ownerKey };
                if (msg.streamRound && msg.streamRound !== ownerKey) callOwnerKey = msg.streamRound;
              } else {
                // No prose preceded the call (tool-only round): give it a home.
                updated.push({ role: 'assistant', content: '', toolCalls: [tc], isStreaming: true, streamRound: ownerKey });
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
                const at = findKey(updated, callOwnerKey);
                const msg = updated[at];
                if (msg?.toolCalls?.length) {
                  const calls = [...msg.toolCalls];
                  calls[calls.length - 1] = partial;
                  updated[at] = { ...msg, toolCalls: calls };
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
                const at = findKey(updated, callOwnerKey);
                const msg = updated[at];
                if (msg?.toolCalls?.length) {
                  const calls = [...msg.toolCalls];
                  calls[calls.length - 1] = finalCall;
                  updated[at] = { ...msg, toolCalls: calls };
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
              const notice = chunk.notice;
              setMessages((prev) => [...prev, notice ? { role: 'system', content: chunk.content!, notice } : { role: 'system', content: chunk.content! }]);
            }
            break;

          case 'done':
            // The provider emits one `done` per LLM call inside the tool loop.
            // Only the last one ends the turn; intermediate ones just seal the
            // current bubble. Never overwrite accumulated text with the chunk's
            // content — that silently discarded everything but the final round.
            sealBubble();
            /*
             * The route's closing `done` carries the turn's final reply. Use it only to APPEND a
             * missing tail to the last reply bubble (when that bubble is a strict prefix of it):
             * whatever was lost on the way to the screen is restored, and nothing shown is ever
             * rewritten.
             */
            if (chunk.content) {
              const full = chunk.content;
              setMessages((prev) => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  const m = prev[i];
                  if (m.role === 'system') continue;
                  // Only the final round's own bubble: past a tool row or the user's message
                  // the text belongs to someone else.
                  if (m.role !== 'assistant') return prev;
                  const have = m.content ?? '';
                  if (have && full.length > have.length && full.startsWith(have)) {
                    const updated = [...prev];
                    updated[i] = { ...m, content: full, isStreaming: false, isThinking: false };
                    return updated;
                  }
                  return prev;
                }
                return prev;
              });
            }
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
            setMessages((prev) => appendStreamError(
              prev,
              chunk.label ? `${chunk.label}：${chunk.error ?? ''}` : (chunk.error ?? t('未知错误')),
            ));
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

  const sendMessage = useCallback((text: string, images?: ChatMessage['images']) => {
    if ((!text.trim() && !images?.length) || isLoading) return;

    const userMsg: ChatMessage = { role: 'user', content: text, ...(images?.length ? { images } : {}) };
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

    const handlers = attachStreamHandlers(acc, toolCalls, currentToolCallRef);
    streamSSE(
      withSid('/api/chat'),
      {
        message: text,
        stream: true,
        session_id: sidRef.current,
        // Paths only: the bytes stay on disk and are read when the request is built.
        images: images?.map((i) => ({ path: i.path, mime: i.mime })),
      },
      {
        ...handlers,
        onDone: () => {
          handlers.onDone();
          // The turn is over: stop claiming to be the live view, so a later history load for
          // this session is no longer skipped and the transcript can be reconciled with disk.
          if (abortRef.current === controller) abortRef.current = null;
        },
      },
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
    /*
     * A live turn outranks the disk copy — for the same session, this window IS the truth.
     *
     * `App` re-binds history on every `activeSessionId` change, and the first message in a fresh
     * session is exactly such a change (the server creates the session, the window adopts the id).
     * That call used to land in the middle of the turn and replace `messages` with a transcript
     * that could not possibly contain the turn still being generated. The visible result was that
     * the conversation appeared to go blank and the answer only showed up at the end, once the
     * turn had been persisted and something read it back.
     *
     * Skipping is safe because switching to a DIFFERENT conversation detaches the stream first
     * (`detachStream`), and that leaves `abortRef` null — so a real switch still loads. Only a
     * reload of the session this window is already streaming into is deferred.
     */
    const target = explicitSessionId || sidRef.current;
    if (abortRef.current && target === sidRef.current) return;

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
      /*
       * Re-checked on every tick, not just when arming.
       *
       * The guard above answers "should we start following?"; this one answers "is this window
       * still a follower?". Without it, a local stream started after the interval was armed had
       * its transcript replaced from disk every 2 seconds — and since a running turn is not on
       * disk yet, that erased the live reply and everything that had streamed into it.
       */
      if (abortRef.current) return;
      const data = await fetchJSON<{ messages: ServerHistoryMessage[] }>(
        withSid('/api/chat/history', sid),
      );
      if (sidRef.current === sid && !abortRef.current) setMessages(normalizeHistory(data.messages ?? []));
    };
    void (async () => {
      try {
        const st = await fetchJSON<{ running: boolean }>(withSid('/api/chat/running', sid));
        if (sidRef.current !== sid || !st.running || abortRef.current) return;
        setIsLoading(true);
        await pull();
        const startPolling = () => {
        if (sidRef.current !== sid || abortRef.current) return;
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
        };
        if (sidRef.current !== sid || abortRef.current) return;
        /*
         * Re-attach to the live stream instead of only polling history.
         *
         * History holds finished messages, so polling it showed the current round's chain of
         * thought only once that round ended. The attach stream replays the partial round and
         * keeps streaming; polling stays as the fallback for a server without the route.
         */
        const controller = new AbortController();
        abortRef.current = controller;
        const acc = { text: '', reasoning: '' };
        activeAccRef.current = acc;
        const handlers = attachStreamHandlers(acc, [], { value: null });
        const finish = async () => {
          if (abortRef.current !== controller) return;
          abortRef.current = null;
          try {
            const data = await fetchJSON<{ messages: ServerHistoryMessage[] }>(withSid('/api/chat/history', sid));
            if (sidRef.current === sid && !abortRef.current) setMessages(normalizeHistory(data.messages ?? []));
          } catch { /* keep what streamed */ }
          if (sidRef.current === sid) setIsLoading(false);
        };
        streamSSE(
          withSid('/api/chat/attach', sid),
          { session_id: sid },
          {
            onData: handlers.onData,
            onDone: () => { void finish(); },
            onError: () => {
              if (abortRef.current !== controller) return;
              abortRef.current = null;
              startPolling();
            },
          },
          controller.signal,
          { idleTimeoutMs: 0 },
        );
      } catch { /* server unreachable; the transcript we already loaded stands */ }
    })();
  }, [attachStreamHandlers]);
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
