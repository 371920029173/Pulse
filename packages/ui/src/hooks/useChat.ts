import { useCallback, useEffect, useRef, useState } from 'react';
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
    /**
     * Progress from a call that is still running (shared StreamChunk type).
     *
     * Local copy of the server's union so a chunk that arrives over the wire is not a type error;
     * the two are kept in step by hand, which is why the comment names the original.
     */
    | 'tool_progress'
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
export function normalizeHistory(raw: ServerHistoryMessage[]): ChatMessage[] {
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
    if (m.role === 'user' && content.startsWith(t('[自动续跑]'))) return { role: 'system', content: t('计划还没做完，自动继续下一步') };
    /*
     * 压缩摘要以 user 角色插进历史（协议要求 user/assistant 交替），但它不是用户说的话。
     * 渲染成用户气泡时，屏幕上会出现一整团几千字的"我说过的话"，看起来就是显示坏了 ——
     * 用户报的"部分 chat 显示异常"里就有它。归成系统说明（原文仍在会话文件里）。
     */
    if (m.role === 'user' && content.startsWith(t('[压缩记录]'))) {
      return { role: 'system', content: t('以上较早的记录已压缩成摘要（模型仍然看得到它）') };
    }
    // The stuck-loop nudge is persisted (so the next request keeps the same prefix); it is the agent
    // talking to itself, not the user. The prefix is a protocol marker, hence the escapes.
    if (m.role === 'user' && content.startsWith('[\u7cfb\u7edf\u63d0\u793a]')) {
      return { role: 'system', content: t('检测到重复调用，已提示模型换个思路再试一次') };
    }
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

/**
 * 聊天流允许多久没有**一个字节**？
 *
 * 以前这里是 0（不超时），因为一次工具调用几分钟不发帧是常态 —— 代价是服务端进程意外死掉后，
 * 客户端永远发现不了：窗口停在"还在跑"，不跟流、不回读历史，用户看到「消息发出去了但前端没反应」
 * （用户报的原话；而且**只在进程意外结束后**出现）。
 *
 * 现在服务端每隔几秒发一行心跳（router.ts 的 startHeartbeat），所以"长时间没有一个字节"就是
 * 死连接。120 秒 = 8 个心跳的余量，接上之后走的还是既有的自愈路径（清掉尸体 → armFollow → attach）。
 */
const CHAT_IDLE_TIMEOUT_MS = 120_000;

export function useChat(sessionId?: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  /**
   * Live progress of a tool call that has not finished yet, keyed by `tool_call_id`.
   *
   * A separate map rather than a field on the tool call: a `ToolCallData` is the provider's shape
   * and is echoed back to the API on some paths, so an extra key there would travel further than
   * the screen. Entries are dropped when the call's result arrives — the result is the answer, and
   * a stale "still waiting" line under a finished card is worse than no line at all.
   */
  const [toolProgress, setToolProgress] = useState<Map<string, string>>(new Map());
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
  const armFollowRef = useRef<(sid: string, opts?: { skipPull?: boolean }) => void>(() => {});

  /**
   * `interject` 定义在 `sendMessage` 之后，而发送路径要在「服务端说在跑」时把这条字接上去。
   * 直接在 render 期引用会撞上 TDZ（依赖数组在声明之前求值），所以照 `armFollowRef` 的做法用 ref 传。
   */
  const interjectRef = useRef<(text: string, images?: ChatMessage['images']) => void>(() => {});

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
      // Lazily opened here rather than at stream start; `sealBubble` below relies on it being set.
      if (!roundKey) roundKey = newKey();
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

          case 'tool_progress':
            /*
             * A call that is still running, saying so.
             *
             * Deliberately NOT a `system` message: a five-minute `shell_wait` reports every few
             * seconds, and appending each line would fill the transcript with a hundred rows saying
             * the same thing — the reader would scroll past the one line that matters. It updates the
             * card it belongs to instead.
             */
            if (chunk.toolCallId && chunk.content) {
              const id = chunk.toolCallId;
              const text = chunk.content;
              setToolProgress((prev) => {
                const next = new Map(prev);
                next.set(id, text);
                return next;
              });
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
              if (chunk.toolCallId) {
                const id = chunk.toolCallId;
                setToolProgress((prev) => {
                  if (!prev.has(id)) return prev;
                  const next = new Map(prev);
                  next.delete(id);
                  return next;
                });
              }
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


  /**
   * 服务端说这条会话在不在跑。
   *
   * 客户端手上那个 `isLoading` 是会骗人的：聊天流的空闲超时是显式关掉的（一次工具调用可能真的
   * 跑很久），所以连接只要死得安静一点，它就永远为真，界面从此不再发送 —— 用户看到的现象就是
   * 「这条会话发不出消息了」。只有服务端知道真相（turnActive 是内存态，重启即假），所以每次
   * 「本地说忙」的发送都问它一次。
   *
   * 返回 null = 问不到（服务端不可达）。这时候不能假设：把用户的字吞掉、又装作发过，比明说
   * 「发不出去」更糟。
   */
  const serverTurnRunning = useCallback(async (): Promise<boolean | null> => {
    const sid = sidRef.current;
    if (!sid) return null;
    try {
      const st = await fetchJSON<{ running: boolean }>(withSid('/api/chat/running', sid));
      return Boolean(st.running);
    } catch {
      return null;
    }
  }, []);

  /**
   * 把「本地以为在跑、服务端说没在跑」的那点本地状态清掉。
   *
   * 要紧的是顺手把 `abortRef` 摘干净：`loadHistory` 与 `armFollow` 都以 `abortRef === null` 为门，
   * 一条安静的尸体压在上面，自愈就永远轮不到 —— 这正是「自愈明明写了却不生效」的原因。
   * 走到这里的每个入口，前提都是服务端说没人跑（或调用方刚问过），所以摘掉它不会打断任何还在
   * 工作的东西。
   */
  /**
   * 已经画在屏幕上、但服务端转写里还没有的那几句（追加进去的话）。
   *
   * 为什么需要：追加是**乐观**画出来的，而 follow 每 2 秒回读一次历史并**整份替换** —— 服务端那份
   * 在模型读到之前当然还没有这句，于是用户的追加当场消失、或者要等下一次回读才出现（用户报的
   * 「加载不及时」）。这里把它们留着，直到服务端的历史里真的出现同一段文字。
   */
  const pendingRef = useRef<Array<{ sid: string; content: string; images?: ChatMessage['images']; at: number }>>([]);

  const rememberPending = useCallback((sid: string, content: string, images?: ChatMessage['images']) => {
    const text = content.trim();
    if (!sid || !text) return;
    pendingRef.current.push({ sid, content: text, ...(images?.length ? { images } : {}), at: Date.now() });
    if (pendingRef.current.length > 20) pendingRef.current = pendingRef.current.slice(-20);
  }, []);

  /** 服务端那份 + 还没落盘的本地那几句；服务端有了就让位（不会出现两条），超过 30 分钟不再挂。 */
  const withPending = useCallback((sid: string, msgs: ChatMessage[]): ChatMessage[] => {
    const now = Date.now();
    const keep: typeof pendingRef.current = [];
    const extra: ChatMessage[] = [];
    for (const p of pendingRef.current) {
      if (p.sid !== sid) { keep.push(p); continue; }
      const landed = msgs.some((m) => String(m.content ?? '').includes(p.content));
      if (landed || now - p.at > 30 * 60_000) continue;
      keep.push(p);
      extra.push({ role: 'user', content: p.content, ...(p.images?.length ? { images: p.images } : {}) });
    }
    pendingRef.current = keep;
    return extra.length ? [...msgs, ...extra] : msgs;
  }, []);

  const healStaleTurn = useCallback(() => {
    if (followRef.current) { clearInterval(followRef.current); followRef.current = null; }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  /**
   * Put one user message on the wire, and open its stream.
   *
   * Split out of `sendMessage` because that one may have to make a round trip first and then send
   * anyway — re-entering itself would read a stale `isLoading` out of its own closure and refuse the
   * very message it had just decided to send.
   */
  const dispatchSend = useCallback((text: string, images?: ChatMessage['images']) => {
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
        /*
         * Drop the dead controller BEFORE the error handler runs — not only when the user aborted.
         *
         * `handlers.onError` re-arms the follow watcher, and `armFollow` returns immediately while
         * `abortRef` is set. Clearing it only for `signal.aborted` meant a network death — or the
         * server's 409 for a turn that is already running — left the corpse in place, so the re-arm
         * never ran: the window showed Send, the server refused every attempt, and there was no Stop
         * button anywhere, because `isLoading` was false. The identity check keeps this from clearing
         * a NEWER stream's controller.
         */
        onError: (err: Error) => {
          if (abortRef.current === controller) abortRef.current = null;
          /*
           * 409 = 服务端说这一轮已经在跑，而这扇窗口不知道（或知道得太晚）。
           *
           * 这时把用户刚敲的字丢掉是最坏的选择 —— 他会以为消息发出去了。按这个界面的既有语义
           * 把这句话接成「追加」：服务端在下一轮迭代读到它，界面上留一行说明。别的错误一律走原来
           * 的报错路径（那条路会自己重新挂上 follow）。
           *
           * 这里直接 POST 而不是走 `interject()`：dispatchSend 已经把这条消息画在屏幕上了，
           * 再走一次会让同一句话出现两遍。
           */
          if ((err as Error & { status?: number }).status === 409) {
            rememberPending(sidRef.current ?? '', text, images);
            void fetchJSON(withSid('/api/chat/interject'), {
              method: 'POST',
              body: {
                message: text, session_id: sidRef.current,
                ...(images?.length ? { images: images.map((i) => ({ path: i.path, mime: i.mime })) } : {}),
              },
            }).catch(() => undefined);
            setMessages((prev) => [...prev, {
              role: 'system',
              content: t('这一轮还在进行：这条已作为「追加」发给当前这一轮（按停止可立刻接手）。'),
            }]);
            armFollowRef.current(sidRef.current, { skipPull: true });
          } else {
            handlers.onError(err);
          }
        },
        onDone: () => {
          handlers.onDone();
          // The turn is over: stop claiming to be the live view, so a later history load for
          // this session is no longer skipped and the transcript can be reconciled with disk.
          if (abortRef.current === controller) abortRef.current = null;
          /*
           * 流结束 ≠ 这一轮结束 —— 所以要向服务端确认一次再决定"进行中"要不要收。
           *
           * 最典型的是「追加」：那句话被服务端收下之后这一轮会**继续跑**（新一轮迭代），而窗口手上
           * 这条流可能先到终帧。此前终帧就是终局：isLoading 归 false、停止按钮变回发送，而服务端还在
           * 干活；追加成功后挂的那次 armFollow 又被 abortRef 挡掉（本地流还活着），所以没有任何东西
           * 会把"进行中"恢复回来。用户看到的就是「停止键几乎瞬间就消失了，变回了发送」。
           *
           * 确认还在跑就保持进行中，并把跟随重新挂上（它每 2 秒接着确认，直到服务端说结束）。
           */
          void (async () => {
            const stillRunning = await serverTurnRunning();
            if (stillRunning !== true) return;
            setIsLoading(true);
            if (!abortRef.current) armFollowRef.current(sidRef.current, { skipPull: true });
          })();
        },
      },
      controller.signal,
      { idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS },
    );
  }, [attachStreamHandlers]);

  /**
   * Send. While the window believes a turn is running, ask the server rather than trusting that
   * belief, and let the answer decide:
   *
   *  - nobody is running → the local state was stale. Heal it and send for real. This is the
   *    「这条会话发不出消息」 fix: `isLoading` used to be final, so a chat whose stream had died
   *    quietly could never send again — the box showed Send, the server answered 409 to every
   *    attempt, and no Stop button existed because `isLoading` was false.
   *  - someone is running → keep the text: it goes out as an append (exactly what Enter does in a
   *    window that knows), with a line saying so, and the running turn is made visible so a Stop
   *    button exists. Refusing while leaving the sentence sitting in the box is what the user
   *    reported as "can't send".
   *  - unreachable → refuse, with the echo. Guessing would either swallow the message or send it
   *    twice.
   */
  const sendMessage = useCallback((text: string, images?: ChatMessage['images']) => {
    if (!text.trim() && !images?.length) return;
    if (isLoading) {
      void (async () => {
        const running = await serverTurnRunning();
        /*
         * 问不到（null）**不再拒发**。
         *
         * 这里原来 setSendBlocked(true) 直接拒绝：字留在框里，只弹一条提示条 —— 而那条提示条自己
         * 还把 t(...) 写成了 JSX 文本，屏幕上是一行源码。用户报的「chat 又无法发送消息了」就是它。
         *
         * 探测失败只说明**这一次探测**失败，不说明服务端在忙；判断交给发送本身：
         *   · 服务端确实在跑 → POST /api/chat 回 409 → 下面 onError 把它接成「追加」；
         *   · 服务端不可达 → 走流错误路径：界面上有报错，这句话也已经画在屏幕上（不会被吞）。
         * 两条路都比"拒发"诚实。这里也**不** healStaleTurn —— 不知道对面在不在跑，就不该动本地
         * 那条可能还活着的流。
         */
        if (running === null) {
          dispatchSend(text, images);
          return;
        }
        /*
         * `sendMessage` only reaches here with `isLoading` true, and a stream that is still alive
         * keeps `isLoading` true until its terminal frame — so a controller left in `abortRef` now
         * is already a corpse. Clearing it is what lets the attach below (and `loadHistory`) run.
         */
        healStaleTurn();
        if (running === false) {
          dispatchSend(text, images);
          return;
        }
        interjectRef.current(text, images);
        setMessages((prev) => [...prev, {
          role: 'system',
          content: t('这一轮还在进行：这条已作为「追加」接在当前这轮后面（按停止可立刻接手）。'),
        }]);
        armFollowRef.current(sidRef.current, { skipPull: true });
      })();
      return;
    }
    dispatchSend(text, images);
  }, [isLoading, dispatchSend, healStaleTurn, serverTurnRunning]);

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
    if (typeof window !== 'undefined' && !window.confirm(t('清空当前对话会删除全部消息，且无法撤销。确定吗？'))) {
      return;
    }
    await fetchJSON(withSid('/api/chat/history'), { method: 'DELETE' });
    setMessages([]);
    setLatestKBResult(null);
    setToolProgress(new Map());
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
    setMessages(withPending(explicitSessionId || sidRef.current || '', normalizeHistory(data.messages ?? [])));
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

  /**
   * Append context to the turn that is currently running, without stopping it.
   * The server queues it and the agent folds it in at the next iteration.
   */
  const interject = useCallback(async (text: string, images?: ChatMessage['images']) => {
    const value = text.trim();
    if (!value && !images?.length) return;
    /*
     * 追加只对「真的在跑」的那一轮有意义。
     *
     * 服务端没在跑时 `/api/chat/interject` 照样回 ok —— 文本进了历史里的 `[用户补充]` 行，而那一行
     * 永远不会被读到（没有在跑的一轮会去读它）。用户看到自己的话躺在记录里、等不到回复，这就是
     * 「发出去没反应」。所以先问一次：没在跑就归位本地状态，当成一条新消息真的发出去。
     *
     * 问不到（null）时照旧发，让这次 POST 自己去失败 —— 那条「追加失败」比静默更诚实。
     */
    const running = await serverTurnRunning();
    if (running === false) {
      healStaleTurn();
      dispatchSend(value, images);
      return;
    }
    setMessages((prev) => [...prev, { role: 'user', content: value, ...(images?.length ? { images } : {}) }]);
    rememberPending(sidRef.current ?? '', value, images);
    try {
      await fetchJSON(withSid('/api/chat/interject'), {
        method: 'POST',
        body: {
          message: value, session_id: sidRef.current,
          ...(images?.length ? { images: images.map((i) => ({ path: i.path, mime: i.mime })) } : {}),
        },
      });
      /*
       * 成功后立刻把跟随挂上：这一轮可能正在跑而这个窗口没挂上（重启、换窗口、连接悄悄死过），
       * 那样服务端那份 [用户补充] 要等到下一次回读才出现 —— 又成了「加载不及时」。
       * skipPull：盘上这份还没有那句话，先让 attach 把正在跑的那一轮重放出来。
       */
      armFollowRef.current(sidRef.current ?? '', { skipPull: true });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: t('追加失败：{message}', { message: ((err as Error).message) }) },
      ]);
    }
  }, [serverTurnRunning, healStaleTurn, dispatchSend]);
  /* 发送路径要在「服务端说在跑」时把这条字接上去，而它定义在上面。 */
  interjectRef.current = interject;

  /**
   * Rewind the conversation to (and including) the given message index: that
   * message and everything after it are dropped, and the truncated transcript is
   * persisted so the server agrees. Used by the "撤销到此" affordance.
   */
  const rewindTo = useCallback(async (index: number) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);

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
    setMessages([]);
    setLatestKBResult(null);
    setToolProgress(new Map());
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
  /*
   * 「服务端在跑，界面却显示发送」的第二半。
   *
   * 第一半修的是"流结束了但这轮还没完"（onDone 向服务端确认）。可截图里那个场景压根没有流：
   * 这一轮是**服务端自己发起的**（看护 / 定时任务在后台会话里跑），这扇窗口从头到尾没挂过流，
   * 于是 isLoading 一直是 false —— 右下角永远是发送键，而那一轮按不动也停不了。
   *
   * 所以再补一条"只信服务端"的兜底：窗口可见时每 8 秒问一次 /api/chat/running。
   * 只在**没有本地流**的时候问（abortRef 为空）：有流的时候它自己就是权威，一次都不用问，
   * 于是正常流式期间这条轮询是零请求。
   */
  useEffect(() => {
    const tick = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (abortRef.current) return;
      const sid = sidRef.current;
      if (!sid) return;
      const running = await serverTurnRunning();
      if (running !== true) return;
      if (sidRef.current !== sid || abortRef.current) return;
      setIsLoading(true);
      armFollowRef.current(sid, { skipPull: true });
    };
    const timer = window.setInterval(() => { void tick(); }, 8_000);
    const onFocus = () => { void tick(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [serverTurnRunning]);

  const armFollow = useCallback((sid: string, opts?: { skipPull?: boolean }) => {
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
      if (sidRef.current === sid && !abortRef.current) setMessages(withPending(sid, normalizeHistory(data.messages ?? [])));
    };
    void (async () => {
      try {
        const st = await fetchJSON<{ running: boolean }>(withSid('/api/chat/running', sid));
        if (sidRef.current !== sid) return;
        if (!st.running) {
          /*
           * 自愈。重启、崩溃、换窗口之后，界面可能还留着上一次的 isLoading ——
           * 那时发送会被拒绝，用户看到的就是「这条会话发不出消息了」。
           * 服务端说没在跑（running 是内存态，重启即假），就把本地状态归位。
           *
           * 这里**不问 abortRef**：一条死掉的流正压在它上面，而它同时是 loadHistory 与下面那一段
           * 的门 —— 自愈要是也被它挡住，就等于给「自愈不生效」上了把锁。走到这里的前提是服务端说
           * 最后几帧可能还在路上，而盘上已经是完整的。
           */
          healStaleTurn();
          /*
           * 不回读盘上那份记录。用户正在读的那半截回复还没落盘（那一轮没写完），拿盘上的覆盖它
           * 就是把正文擦掉 —— stream-integrity.test.tsx 那条判据立的正是这件事。盘上那份由下一次
           * loadHistory（切会话、重开）去对；自愈只负责让这条会话重新发得出消息。
           */
          return;
        }
        if (abortRef.current) return;
        setIsLoading(true);
        /*
         * 回读盘上记录会把「还没落盘的本地行」擦掉：刚刚接成「追加」的那句话还在服务端的排队里，
         * 而盘上那份当然没有它 —— 屏幕上看起来就是被吞了。所以发送路径传 skipPull：先让 attach
         * 把正在跑的那一轮重放出来，那句话由服务端自己落盘后再出现。
         */
        if (!opts?.skipPull) await pull();
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
        const handlers = attachStreamHandlers(acc, [], { value: null });
        const finish = async () => {
          if (abortRef.current !== controller) return;
          abortRef.current = null;
          try {
            const data = await fetchJSON<{ messages: ServerHistoryMessage[] }>(withSid('/api/chat/history', sid));
            if (sidRef.current === sid && !abortRef.current) setMessages(withPending(sid, normalizeHistory(data.messages ?? [])));
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
          { idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS },
        );
      } catch { /* server unreachable; the transcript we already loaded stands */ }
    })();
  }, [attachStreamHandlers]);
  armFollowRef.current = armFollow;

  return {
    messages,
    isLoading,
    latestKBResult,
    toolProgress,
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
    interject,
    rewindTo,
  };
}
