import type { LLMProvider, LLMMessage, ToolDefinition, ToolCall, StreamChunk } from '@she/shared';
import { createLogger } from '@she/shared';
import { repairApiMessages } from '../protocol.js';
import {
  StreamInterruptedError,
  isTimeoutError,
  retryStatusChunk,
  lengthNoticeChunk,
  interruptedNoticeChunk,
  hasCompleteArguments,
} from './stream-failure.js';
import { resolveImages, skippedNotice } from './images.js';

const log = createLogger('openai');

/**
 * Statuses worth trying again.
 *
 * 429: the provider is rate-limiting us; the same request will succeed shortly.
 * 5xx: transient on their side. 529 is Cloudflare's "origin overloaded", which some
 * OpenAI-compatible gateways return and which is not in the standard set.
 */
function isTransient(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

/**
 * Delay before the next attempt.
 *
 * Exponential with jitter. The jitter matters more than the base: without it, every
 * client that hit the same rate limit retries in lockstep and re-creates the spike.
 * `Retry-After` wins when the provider sent one, since it knows its own state.
 */
function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) {
    // Cap it: a provider asking for ten minutes would look like a hang, and the turn
    // deadline should govern instead.
    return Math.min(retryAfterSeconds * 1000, 30_000);
  }
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return base + Math.floor(Math.random() * 250);
}

/** Seconds from a `Retry-After` header, which may be a delay or an HTTP date. */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - Date.now()) / 1000);
}

/** Sleep that can be interrupted by the caller's abort signal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface OpenAIFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
interface OpenAITool {
  type: 'function';
  function: OpenAIFunction;
}

/**
 * A content part, for turns that carry an image.
 *
 * Text-only turns keep `content` as a plain string rather than a one-part array. That is not
 * cosmetic: the request prefix is what the prompt cache keys on, and rewriting every text message
 * into `[{type:'text',…}]` would re-key the whole history of every existing conversation.
 */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIRequestMessage {
  role: string;
  content: string | null | OpenAIContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /**
   * DeepSeek thinking-mode protocol. Present only on an assistant message that
   * still has tool_calls, and only for endpoints that require it.
   */
  reasoning_content?: string;
}

export class OpenAIProvider implements LLMProvider {
  name = 'openai';

  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private thinkingLevel: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  constructor(
    apiKey: string,
    baseUrl: string,
    model: string,
    maxTokens: number,
    temperature: number,
    thinkingLevel: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium',
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.thinkingLevel = thinkingLevel;
  }

  /** Next request uses this depth. Does not interrupt a request already in flight. */
  setThinkingLevel(level: OpenAIProvider['thinkingLevel']): void {
    this.thinkingLevel = level;
  }

  private tempForThinking(): number {
    // Fallback for endpoints with no reasoning_effort support: map depth onto
// temperature. Ordered by the measured tiers so the scale stays meaningful.
    const map = {
      none: Math.min(this.temperature, 0.1),
      minimal: Math.min(this.temperature, 0.2),
      low: Math.min(this.temperature, 0.3),
      medium: this.temperature,
      high: Math.max(this.temperature, 0.6),
      xhigh: Math.max(this.temperature, 0.7),
      max: Math.max(this.temperature, 0.8),
    } as const;
    return map[this.thinkingLevel] ?? this.temperature;
  }

  /**
   * Models that reject `temperature` outright.
   *
   * OpenAI's o-series and GPT-5 return 400 if it is present, unlike most
   * OpenAI-compatible endpoints (DeepSeek validates the range instead).
   */
  private rejectsTemperature(): boolean {
    return /^(o[134]\b|gpt-5)/.test(this.model.toLowerCase());
  }

  /**
   * Does this endpoint understand `reasoning_effort`?
   *
   * The previous check was `/o1|o3|o4|gpt-5|reason/`, which missed every
   * DeepSeek reasoning model — including the one this project is configured
   * with. DeepSeek validates `reasoning_effort` against a strict enum
   * (`none|minimal|low|medium|high|xhigh|max`), so it was a real, working lever
   * that simply never got sent.
   *
   * Override with SHE_REASONING_EFFORT=on|off when detection guesses wrong; a
   * 400 from the retry path also disables it automatically.
   */
  private supportsReasoningEffort(): boolean {
    const override = process.env.SHE_REASONING_EFFORT;
    if (override === 'on') return true;
    if (override === 'off') return false;
    const m = this.model.toLowerCase();
    if (/^(o[134]\b|gpt-5)/.test(m)) return true;
    return /reason|thinking|deepseek|qwq|qwen|glm|kimi|r1/.test(m);
  }

  /**
   * UI level -> API enum.
   *
   * Now an identity mapping: `none` is exposed in the UI directly, so there is
   * no reason to fold it into another value. Previously `minimal` and `low`
   * both sent `'low'`, making two of the four ticks behave identically.
   *
   * Measured on the configured model (median reasoning length on a hard task):
   * none = 0, minimal/low ≈ 5.5k, medium ≈ 11k, high/xhigh/max ≈ 14–17k. All
   * seven are accepted by the endpoint, but they collapse into about four
   * distinguishable tiers — see THINK_LEVELS in the UI for what each promises.
   */
  private effortForLevel(): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
    return this.thinkingLevel;
  }

  /**
   * Does this endpoint speak DeepSeek's `reasoning_content` protocol?
   *
   * Thinking-mode DeepSeek (and the compatible family: QwQ, Qwen, GLM, Kimi,
   * R1) returns 400 on the next tool round unless the assistant message that
   * issued the tool_calls carries `reasoning_content` back. A finished turn
   * must NOT carry it: prior-round chain-of-thought is not part of the context,
   * and some builds reject it there.
   *
   * o-series / GPT-5 use a different channel. Echoing this field at them is not
   * their protocol. Override with SHE_REASONING_ECHO=on|off when detection is
   * wrong; a 400 that names the field as unknown also turns it off.
   */
  private echoesReasoningContent(): boolean {
    const override = process.env.SHE_REASONING_ECHO;
    if (override === 'on') return true;
    if (override === 'off') return false;
    const m = this.model.toLowerCase();
    if (/^(o[134]\b|gpt-5)/.test(m)) return false;
    return /deepseek|qwq|qwen|glm|kimi|reasoner|\br1\b|thinking/.test(m);
  }

  /**
   * Apply the thinking level to the request.
   *
   * Thinking depth is expressed through `reasoning_effort` — NOT temperature.
   * The old code raised temperature to >=0.7 for `high`, which made output
   * *less* stable while the UI promised "最慢但最稳", and left reasoning models
   * with no real depth control. Temperature is now left to the user's setting.
   *
   * Returns true when `reasoning_effort` was added, so the caller can retry
   * without it if the endpoint rejects the field.
   */
  private applyThinking(body: Record<string, unknown>, messages: OpenAIRequestMessage[]): boolean {
    let usedEffort = false;

    if (this.supportsReasoningEffort()) {
      body.reasoning_effort = this.effortForLevel();
      usedEffort = true;
      if (this.rejectsTemperature()) delete body.temperature;
    }

    // For endpoints with no effort knob, a textual hint is the only lever left.
    if (!usedEffort) {
      body.temperature = this.tempForThinking();
      if (this.thinkingLevel !== 'medium' && this.thinkingLevel !== 'low') {
        const hint =
          this.thinkingLevel === 'none'
            ? '[thinking=none] Answer directly. Do not produce step-by-step reasoning.'
            : this.thinkingLevel === 'minimal'
              ? '[thinking=minimal] Be brief; keep reasoning very short.'
              : '[thinking=deep] Prefer careful multi-step reasoning before tools/answers.';
        const sys = messages.find((x) => x.role === 'system');
        if (sys && typeof sys.content === 'string') sys.content = hint + '\n\n' + sys.content;
        else messages.unshift({ role: 'system', content: hint });
      }
    }

    return usedEffort;
  }

  async chat(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    onChunk?: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<LLMMessage> {
    const openaiMessages = repairApiMessages(messages).map(m => this.toOpenAIMessage(m));
    const openaiTools = tools?.length ? tools.map(t => this.toOpenAITool(t)) : undefined;
    /*
     * Streaming is also governed by config, not only by whether the caller wants
     * incremental output. See `streamingDisabled`.
     */
    const stream = !!onChunk && !this.streamingDisabled();
    if (onChunk && !stream) {
      onChunk({ type: 'status', content: '已按设置关闭流式（SHE_LLM_STREAM=off），回复会在结束时一次性返回。' });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: openaiMessages,
      // 0 means "no cap we invented". Still send a high ceiling: several
      // endpoints otherwise default max_tokens to 4096, and thinking tokens
      // are counted against it, so the chain is cut off with no answer.
      max_tokens: this.maxTokens > 0 ? this.maxTokens : 131072,
      temperature: this.temperature,
      stream,
    };
    if (openaiTools) {
      body.tools = openaiTools;
    }

    this.applyThinking(body, openaiMessages);
    if (stream) (body as any).stream_options = { include_usage: true };

    /*
     * A stream that breaks BEFORE anything was shown is retried with backoff, visibly.
     *
     * Only that case: nothing reached the user and nothing was stored, so asking again is the
     * same request with the same prefix — no second answer on screen, no history rewrite. A
     * break AFTER content keeps what arrived and offers 继续 instead (see `handleStream`).
     */
    const maxAttempts = this.maxAttempts();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestOnce(body, stream, onChunk, signal);
      } catch (err) {
        const retryable = err instanceof StreamInterruptedError && err.retryable && !signal?.aborted;
        if (!retryable || attempt >= maxAttempts) throw err;
        log.warn(`stream broke before any content (attempt ${attempt}/${maxAttempts}): ${(err as Error).message}`);
        onChunk?.(retryStatusChunk(attempt, { timeout: isTimeoutError(err) || /超时|timeout/i.test((err as Error).message) }));
        await sleep(backoffMs(attempt, null), signal);
      }
    }
  }

  /** Total attempts including the first; `SHE_LLM_ATTEMPTS`, default 3. */
  private maxAttempts(): number {
    const raw = Number(process.env.SHE_LLM_ATTEMPTS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
  }

  /** One request (with its own HTTP-level retries) and the reading of its response. */
  private async requestOnce(
    body: Record<string, unknown>,
    stream: boolean,
    onChunk: ((chunk: StreamChunk) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<LLMMessage> {
    let response = await this.post(body, signal, onChunk);

    // A 400 that names a thinking-protocol field is often "this endpoint doesn't
    // speak that dialect" or "you forgot to echo reasoning_content". Both are
    // recoverable once. A 400 about anything else is the caller's problem.
    if (response.status === 400) {
      const detail = await response.clone().text().catch(() => '');
      let retry = false;
      if ('reasoning_effort' in body && /reasoning_effort/i.test(detail)) {
        process.env.SHE_REASONING_EFFORT = 'off';
        delete body.reasoning_effort;
        retry = true;
      }
      if (/max_tokens/i.test(detail)) {
        const mentioned = [...detail.matchAll(/\d{3,}/g)]
          .map((m) => Number(m[0]))
          .filter((n) => Number.isFinite(n) && n >= 256 && n < Number(body.max_tokens));
        if (mentioned.length) {
          body.max_tokens = Math.max(...mentioned);
          retry = true;
        }
      }
      if (/reasoning_content/i.test(detail)) {
        const mustEcho = /must be passed|must be provided|required|missing/i.test(detail);
        const rejected = /unknown|unexpected|unrecognized|not support|unsupported|extra/i.test(detail);
        const messages = body.messages as OpenAIRequestMessage[];
        if (mustEcho && !rejected) {
          let patched = false;
          for (const m of messages) {
            if (m.role === 'assistant' && m.tool_calls?.length && m.reasoning_content == null) {
              m.reasoning_content = '';
              patched = true;
            }
          }
          if (patched) retry = true;
        } else if (rejected && !mustEcho) {
          for (const m of messages) delete m.reasoning_content;
          process.env.SHE_REASONING_ECHO = 'off';
          retry = true;
        }
      }
      if (/content or tool_calls must be set/i.test(detail)) {
        const wire = body.messages as OpenAIRequestMessage[];
        let patched = false;
        for (const m of wire) {
          if (m.role !== 'assistant') continue;
          const calls = (m.tool_calls ?? []).filter((tc) => tc?.id && tc.function?.name);
          const hasText = typeof m.content === 'string' && m.content.trim().length > 0;
          if (calls.length !== (m.tool_calls?.length ?? 0)) {
            if (calls.length) m.tool_calls = calls;
            else delete m.tool_calls;
            patched = true;
          }
          if (!hasText && !(m.tool_calls?.length)) {
            m.content = '…';
            patched = true;
          }
        }
        if (patched) retry = true;
      }
      if (retry) response = await this.post(body, signal, onChunk);
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errText}`);
    }
    if (stream && onChunk) {
      /*
       * Some OpenAI-compatible gateways ignore `stream: true` and answer with a single
       * JSON object.
       *
       * Feeding that to the SSE reader produced an EMPTY assistant message, silently —
       * the worst outcome, because the turn looked successful with no content. It is
       * now handled: parse it as a normal response, and tell the caller the endpoint
       * ignored the request so the behaviour is visible rather than mysterious.
       */
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('application/json')) {
        onChunk({ type: 'status', content: '该端点忽略了流式请求，已按普通响应处理。' });
        return this.handleNonStream(response, onChunk);
      }
      return this.handleStream(response, onChunk, signal);
    }
    return this.handleNonStream(response, onChunk);
  }

  /**
   * Whether to ask for a streamed response at all.
   *
   * `SHE_LLM_STREAM=off` disables it. Behind a proxy that buffers or drops streaming
   * responses, streaming produces a worse experience than not streaming — the reply
   * arrives all at once at the end instead of incrementally, or the connection breaks
   * part-way. Without a switch, the only workaround was to change endpoints.
   *
   * Read per request rather than cached, so it can be flipped without a restart.
   */
  private streamingDisabled(): boolean {
    const raw = (process.env.SHE_LLM_STREAM ?? '').trim().toLowerCase();
    return raw === 'off' || raw === 'false' || raw === '0' || raw === 'no';
  }

  /**
   * POST the request body, retrying failures that are worth retrying.
   *
   * A 429 or a 5xx is the provider telling us it is busy, not that the request was
   * wrong. Throwing immediately turned a momentary rate limit into a failed turn —
   * and, when a fallback endpoint is configured, into a needless switch to a
   * different model mid-task, which changes the answers for a reason the user cannot
   * see.
   *
   * What is NOT retried: 4xx other than 429. A bad request stays bad; retrying only
   * delays the error and multiplies the bill.
   */
  private async post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<Response> {
    /*
     * Total attempts, including the first. Deliberately not "retries": "how many
     * retries" invites 0, which reads as "disable retrying" but would mean "never
     * send the request at all". 1 means no retry.
     *
     * Every retry is announced through `onChunk` ("网络不稳，正在重试（第 n 次）…"), so a wait of
     * several seconds reads as recovery rather than as a hang.
     */
    const maxAttempts = this.maxAttempts();

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchOnce(body, signal);
      } catch (err) {
        // An abort is deliberate; a network error — including our own request timeout, whose
        // message also says "aborted" — is worth another try.
        const timeout = isTimeoutError(err);
        if (signal?.aborted || (!timeout && /abort/i.test(String((err as Error).message)))) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (timeout) lastError = new Error(`模型请求超时（${lastError.message}）`);
        log.warn(`LLM request failed (attempt ${attempt}/${maxAttempts}): ${lastError.message}`);
        if (attempt < maxAttempts) {
          onChunk?.(retryStatusChunk(attempt, { timeout }));
          await sleep(backoffMs(attempt, null), signal);
          continue;
        }
        throw lastError;
      }

      if (response.ok || !isTransient(response.status)) return response;

      /*
       * A retryable status. On the LAST attempt the body is left untouched: reading it
       * here to log it means the caller cannot read it again, and `response.text()`
       * throws "Body has already been read" — replacing the provider's actual error
       * with a confusing one about the body.
       */
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));

      if (attempt === maxAttempts) {
        // Hand back the untouched response so the caller reports the provider's own
        // status and message.
        return response;
      }

      const detail = await response.text().catch(() => '');
      log.warn(
        `LLM returned ${response.status} (attempt ${attempt}/${maxAttempts})`
        + `${retryAfter !== null ? `, retry-after ${retryAfter}s` : ''}: ${detail.slice(0, 200)}`,
      );
      onChunk?.(retryStatusChunk(attempt, { status: response.status }));
      await sleep(backoffMs(attempt, retryAfter), signal);
    }

    throw lastError ?? new Error('Unreachable: retry loop exited without a result');
  }

  /** One HTTP attempt, with a request timeout. */
  private fetchOnce(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    /*
     * A timeout in addition to the caller's signal.
     *
     * Without one, a provider that accepts the connection and then goes quiet hangs
     * the turn indefinitely: no error, no output, no way for the user to tell the
     * difference between "thinking hard" and "gone".
     */
    const rawTimeout = Number(process.env.SHE_LLM_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 300_000;
    const timer = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;

    return fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  }

  private async handleNonStream(response: Response, onChunk?: (chunk: StreamChunk) => void): Promise<LLMMessage> {
    const data = await response.json() as {
      choices: Array<{
        finish_reason?: string | null;
        message: {
          role: string;
          content: string | null;
          /** DeepSeek / QwQ style chain-of-thought. */
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
        /** Prompt-cache accounting; DeepSeek reports these. */
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
    };

    if (data.usage && onChunk) {
      onChunk({
        type: 'usage',
        usage: {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
          reasoning_tokens: data.usage.completion_tokens_details?.reasoning_tokens,
          cache_hit_tokens: data.usage.prompt_cache_hit_tokens,
          cache_miss_tokens: data.usage.prompt_cache_miss_tokens,
        },
      });
    }
    const choice = data.choices[0];
    if (!choice) {
      throw new Error('OpenAI returned no choices');
    }

    const msg = choice.message;
    const reasoning = msg.reasoning_content ?? msg.reasoning ?? '';
    const result: LLMMessage = {
      role: 'assistant',
      content: msg.content ?? '',
    };
    if (reasoning) {
      result.reasoning = reasoning;
      result.reasoningOrigin = 'native';
      onChunk?.({ type: 'reasoning', content: reasoning });
    }

    let calls = msg.tool_calls ?? [];
    let dropped = 0;
    if (choice.finish_reason === 'length') {
      // Cut off by max_tokens: a call whose arguments are not complete JSON must not run.
      const complete = calls.filter((tc) => hasCompleteArguments(tc.function?.arguments ?? ''));
      dropped = calls.length - complete.length;
      calls = complete;
    }
    if (calls.length) {
      result.tool_calls = calls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }
    if (choice.finish_reason === 'length') {
      log.warn(`reply stopped at max_tokens (finish_reason=length, ${result.content?.length ?? 0} chars)`);
      onChunk?.(lengthNoticeChunk(dropped));
    }

    return result;
  }

  private async handleStream(
    response: Response,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<LLMMessage> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');
    /** The last `finish_reason` seen: `length` means max_tokens cut the reply off. */
    let finishReason: string | null = null;

    const decoder = new TextDecoder();
    let buffer = '';
    let contentAccum = '';
    let reasoningAccum = '';
    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

    /*
     * Read the stream, keeping whatever arrived if the connection breaks.
     *
     * A dropped connection used to propagate out of here and take the accumulated
     * content with it: the user had watched text stream in, and it vanished — while
     * those tokens had already been billed. Returning the partial text keeps what was
     * already shown on screen and lets the turn be continued.
     *
     * The one thing that must NOT be salvaged is an incomplete tool call. Its
     * arguments are JSON assembled across deltas, so a truncated one is malformed —
     * executing it would run a tool with wrong arguments, which is worse than not
     * running it at all.
     */
    let broke = false;
    let breakReason = '';
    /*
     * Whether the stream reached its end marker.
     *
     * A dropped connection does not always surface as an exception: destroying the
     * socket can make the body stream simply END, which looks identical to a normal
     * completion. Checking `reader.read()` alone therefore misses truncations.
     *
     * OpenAI-compatible streams always terminate with either a `finish_reason` on the
     * last delta or the `[DONE]` sentinel. Absence of both, at the end of the stream,
     * is the reliable signal that it was cut short.
     */
    let sawEndMarker = false;
    /** Whether any SSE frame arrived at all, which distinguishes the two failure kinds. */
    let sawAnyFrame = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') {
            sawEndMarker = true;
            onChunk({ type: 'done' });
            continue;
          }

          let parsed: {
            choices?: Array<{
              finish_reason?: string | null;
              delta?: {
                content?: string;
                /** DeepSeek / QwQ style chain-of-thought delta. */
                reasoning_content?: string;
                reasoning?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          sawAnyFrame = true;
          if (parsed.choices?.[0]?.finish_reason) {
            sawEndMarker = true;
            finishReason = parsed.choices[0].finish_reason ?? null;
          }

          if ((parsed as any).usage && onChunk) {
            const u = (parsed as any).usage;
            onChunk({
              type: 'usage',
              usage: {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
                total_tokens: u.total_tokens,
                reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
                cache_hit_tokens: u.prompt_cache_hit_tokens,
                cache_miss_tokens: u.prompt_cache_miss_tokens,
              },
            });
          }
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // Reasoning deltas MUST be handled before content and never mixed into it —
          // otherwise the chain-of-thought leaks into the visible answer.
          const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
          if (reasoningDelta) {
            reasoningAccum += reasoningDelta;
            onChunk({ type: 'reasoning', content: reasoningDelta });
          }

          if (delta.content) {
            contentAccum += delta.content;
            onChunk({ type: 'text', content: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { id: tc.id ?? '', name: '', arguments: '' });
                onChunk({
                  type: 'tool_call_start',
                  toolCall: {
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function?.name ?? '', arguments: '' },
                  },
                });
              }
              const accum = toolCallAccum.get(idx)!;
              if (tc.id) accum.id = tc.id;
              if (tc.function?.name) accum.name += tc.function.name;
              if (tc.function?.arguments) {
                accum.arguments += tc.function.arguments;
                onChunk({
                  type: 'tool_call_delta',
                  toolCall: {
                    function: { name: accum.name, arguments: tc.function.arguments },
                  },
                });
              }
            }
          }
        }
      }
    } catch (err) {
      /*
       * The connection failed mid-response. What we already have is worth keeping.
       *
       * The reader is released first so a half-open stream does not hold the socket.
       */
      broke = true;
      breakReason = err instanceof Error ? err.message : String(err);
      try { await reader.cancel(); } catch { /* already closed */ }

      /*
       * An aborted turn is a deliberate stop, not a failure to report — the agent
       * already handles it, and salvaging here would defeat the abort.
       *
       * Our own request timeout also surfaces as an abort ("aborted due to timeout"). That one
       * is NOT the user's stop: it is a provider that went quiet, and it is salvaged/retried
       * like any other broken connection.
       */
      const timeout = isTimeoutError(err);
      if (signal?.aborted || (!timeout && /abort/i.test(breakReason))) throw err;
      if (timeout) breakReason = `模型响应超时（${breakReason}）`;
    }

    /*
     * A stream that ended WITHOUT an end marker was cut short, even though nothing
     * threw. Treating it as a normal completion is how a truncated answer gets
     * presented as if it were finished.
     */
    if (!broke && !sawEndMarker) {
      broke = true;
      breakReason = sawAnyFrame
        ? '连接在收到结束标记前关闭'
        : '响应里没有任何流式数据';
      log.warn(
        `Stream ended without a finish marker after ${contentAccum.length} chars`
        + ` (${sawAnyFrame ? 'frames seen' : 'no frames at all'})`,
      );
    }

    if (broke && !contentAccum && !reasoningAccum) {
      /*
       * Nothing to salvage: the stream died before the first token. Returning an empty
       * answer would look like the model chose to say nothing, so this is reported as
       * a failure — for both the thrown and the cleanly-ended cases.
       *
       * The two cases need different advice, so the message distinguishes them: no
       * frames at all usually means the endpoint does not support streaming, while
       * frames-then-stop means the connection dropped.
       */
      const hint = sawAnyFrame
        ? ''
        : '（响应里没有任何流式数据，该端点可能不支持流式；可设 SHE_LLM_STREAM=off 关闭流式后再试）';
      /*
       * Retryable only when nothing at all was put on screen: a tool-call card that already
       * rendered would be duplicated by a second attempt. A stream that ended cleanly with no
       * frames is an endpoint that does not stream — asking again gets the same nothing.
       */
      const cleanEmpty = !sawAnyFrame && breakReason === '响应里没有任何流式数据';
      throw new StreamInterruptedError(
        `流式响应中断（尚未收到内容）: ${breakReason}${hint}`,
        !cleanEmpty && toolCallAccum.size === 0,
      );
    }

    /*
     * `finish_reason: length` — the reply hit max_tokens. It ended "normally" on the wire, which
     * is exactly why it used to look finished. Say so, and drop any tool call whose arguments
     * were cut mid-JSON (running it would act on wrong arguments).
     */
    let lengthDropped = 0;
    if (!broke && finishReason === 'length') {
      for (const [idx, accum] of [...toolCallAccum]) {
        if (!hasCompleteArguments(accum.arguments)) { toolCallAccum.delete(idx); lengthDropped++; }
      }
      log.warn(`reply stopped at max_tokens (finish_reason=length, ${contentAccum.length} chars)`);
      onChunk(lengthNoticeChunk(lengthDropped));
    }

    if (broke) {
      /*
       * Incomplete tool calls are dropped, not executed.
       *
       * Their arguments are JSON assembled from deltas, so a truncated call is
       * malformed. Running it would act on wrong arguments — writing the wrong file,
       * running the wrong command — which is worse than not running it.
       */
      const dropped = toolCallAccum.size;
      if (dropped > 0) toolCallAccum.clear();

      onChunk(interruptedNoticeChunk(breakReason, dropped));
    }

    for (const [, accum] of toolCallAccum) {
      onChunk({
        type: 'tool_call_end',
        toolCall: {
          id: accum.id,
          type: 'function',
          function: { name: accum.name, arguments: accum.arguments },
        },
      });
    }

    const result: LLMMessage = {
      role: 'assistant',
      content: contentAccum,
    };
    if (reasoningAccum) {
      result.reasoning = reasoningAccum;
      result.reasoningOrigin = 'native';
    }

    if (toolCallAccum.size > 0) {
      result.tool_calls = Array.from(toolCallAccum.values()).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    return result;
  }

  private toOpenAIMessage(msg: LLMMessage): OpenAIRequestMessage {
    let text = typeof msg.content === 'string' ? msg.content : '';    /*
     * An assistant turn with neither text nor tool calls is rejected:
     * "Invalid assistant message: content or tool_calls must be set".
     *
     * That is a reasoning-only turn (native or imported), or a turn that was
     * persisted before any text arrived. The chain cannot go in
     * `reasoning_content` unless this same message also has tool_calls —
     * that field is the model's own protocol. Put the chain in the body so
     * the turn stays a real message. A turn with nothing at all still needs
     * one character, or the next request 400s.
     */
    if (msg.role === 'assistant' && !text.trim() && !msg.tool_calls?.length) {
      text = msg.reasoning?.trim() || '…';
    }

    const result: OpenAIRequestMessage = {
      role: msg.role,
      // Tool results must be a string. `null` is how assistant turns say
      // "the content is the tool call", and it is not valid on role=tool.
      content: msg.role === 'tool' ? text : (text.length ? text : null),
    };
    if (msg.name) result.name = msg.name;
    if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id;
    if (msg.tool_calls?.length) {
      result.tool_calls = msg.tool_calls;
    }

    /*
     * Attached images turn the message into content parts.
     *
     * Only user turns can carry them (see `MessageImage`), and only when there is at least one
     * readable file: when every attachment failed to resolve, the message stays a plain string
     * with a note in it, so a text-only request is never reshaped into a parts array it did not
     * need — that reshaping is what would invalidate an otherwise cacheable prefix.
     */
    if (msg.role === 'user' && msg.images?.length) {
      const { ok, skipped } = resolveImages(msg.images);
      if (ok.length) {
        const parts: OpenAIContentPart[] = [];
        const body = text.trim() ? text : '';
        if (body) parts.push({ type: 'text', text: body });
        for (const image of ok) parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
        result.content = parts;
        return result;
      }
      const notice = skippedNotice(skipped);
      if (notice) {
        const combined = text.trim() ? `${text}\n\n${notice}` : notice;
        result.content = combined;
        text = combined;
      }
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length && this.echoesReasoningContent()) {
      // Foreign chains stay on the transcript for the UI. An empty string is
      // enough to satisfy "must be passed back" without pretending the thought
      // was this model's.
      result.reasoning_content = msg.reasoningOrigin === 'imported' ? '' : (msg.reasoning ?? '');
    }
    return result;
  }

  private toOpenAITool(def: ToolDefinition): OpenAITool {
    return {
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      },
    };
  }
}
