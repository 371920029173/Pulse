/**
 * Telling the user WHY a reply stopped, and which failures are safe to retry.
 *
 * A reply that simply ends is the worst outcome: the user cannot tell "the model finished" from
 * "the output ceiling was hit" from "the connection dropped". Everything here exists so that each
 * of those produces a distinct, visible message:
 *
 *   - `finish_reason: length`     → 回答达到单次输出长度上限，已停止（带「继续」）
 *   - a network drop / timeout    → retried automatically while nothing has been shown yet,
 *                                   otherwise the partial reply is kept and 继续 is offered
 *   - a 429 / 5xx                 → retried with backoff, each attempt visible
 *   - the final failure           → named as 模型端错误 / 网络问题 / 本地错误
 *
 * Retrying never rewrites history: a retry only re-sends a request whose answer was never
 * shown or stored, and "继续" appends a new user turn. The prompt prefix stays byte-identical,
 * which is what keeps the provider's prefix cache hitting.
 */
import type { StreamChunk } from '@she/shared';

export type LlmFailureKind = 'provider' | 'network' | 'local';

/**
 * A stream that broke before producing anything the user saw.
 *
 * `retryable` is true for a genuine connection failure (reset, timeout, closed mid-way) and false
 * for a stream that ended cleanly with no frames at all — that is an endpoint that does not stream,
 * and asking again gets the same nothing.
 */
export class StreamInterruptedError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'StreamInterruptedError';
    this.retryable = retryable;
  }
}

/** The request's own timeout fired (AbortSignal.timeout), as opposed to the user pressing stop. */
export function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; cause?: { name?: string } } | null;
  if (!e) return false;
  if (e.name === 'TimeoutError' || e.cause?.name === 'TimeoutError') return true;
  return /due to timeout|timed out|ETIMEDOUT|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(String(e.message ?? ''));
}

/**
 * Where a failure came from.
 *
 * - provider: the model endpoint answered with an error status (`… API error 503: …`), or with a
 *   body we could not use.
 * - network: we never got a usable answer — refused, reset, DNS, timeout, a stream cut short.
 * - local: anything else, i.e. our own code or configuration.
 */
export function classifyLlmFailure(err: unknown): LlmFailureKind {
  if (err instanceof StreamInterruptedError) return 'network';
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err);
  if (/API error \d{3}/i.test(msg) || /returned no choices/i.test(msg)) return 'provider';
  if (isTimeoutError(err)) return 'network';
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|socket|terminated|other side closed|network|UND_ERR|流式响应中断|连接在收到结束标记前关闭/i.test(msg)) {
    return 'network';
  }
  return 'local';
}

/** The Chinese label shown to the user for each kind. */
export function failureLabel(kind: LlmFailureKind): string {
  if (kind === 'provider') return '模型端错误';
  if (kind === 'network') return '网络问题';
  return '本地错误';
}

/**
 * The status line shown before an automatic retry.
 *
 * `attempt` is the number of the retry about to happen (1 = first retry), which is what a user
 * reads "第 n 次" as.
 */
export function retryStatusText(attempt: number, cause: { status?: number; timeout?: boolean } = {}): string {
  const n = `第 ${attempt} 次`;
  if (cause.status === 429) return `模型端限流（HTTP 429），正在重试（${n}）…`;
  if (typeof cause.status === 'number') return `模型端错误（HTTP ${cause.status}），正在重试（${n}）…`;
  if (cause.timeout) return `模型响应超时，正在重试（${n}）…`;
  return `网络不稳，正在重试（${n}）…`;
}

/** Status chunk for a retry, so the wait is visible instead of looking like a hang. */
export function retryStatusChunk(attempt: number, cause: { status?: number; timeout?: boolean } = {}): StreamChunk {
  return {
    type: 'status',
    content: retryStatusText(attempt, cause),
    notice: { kind: typeof cause.status === 'number' ? 'provider' : 'network' },
  };
}

export const LENGTH_NOTICE_TEXT = '回答达到单次输出长度上限，已停止。点「继续」可以接着往下写。';

/** `finish_reason: length` (OpenAI) / `stop_reason: max_tokens` (Anthropic). */
export function lengthNoticeChunk(droppedCalls = 0): StreamChunk {
  return {
    type: 'status',
    content: droppedCalls
      ? `${LENGTH_NOTICE_TEXT}（被截断的 ${droppedCalls} 个工具调用参数不完整，已丢弃，没有执行）`
      : LENGTH_NOTICE_TEXT,
    notice: { kind: 'length', action: 'continue' },
  };
}

/** The connection broke after part of the reply was shown: keep it, say so, offer 继续. */
export function interruptedNoticeChunk(reason: string, droppedCalls = 0): StreamChunk {
  return {
    type: 'status',
    content:
      `⚠ 响应中断（网络问题：${reason}），已保留收到的内容${droppedCalls ? `，并丢弃了 ${droppedCalls} 个未完整的工具调用` : ''}。`
      + '回复「继续」可以接着往下写。',
    notice: { kind: 'network', action: 'continue' },
  };
}

/** Tool calls whose arguments are not complete JSON — a cut-off call must never run. */
export function hasCompleteArguments(args: string): boolean {
  if (!args.trim()) return true;
  try { JSON.parse(args); return true; } catch { return false; }
}
