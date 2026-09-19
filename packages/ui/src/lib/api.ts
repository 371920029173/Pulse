const BASE = '';

import { t } from './i18n';

/** Default request timeout. Long agent turns use SSE with their own signal. */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface FetchOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Override default timeout; 0 = no timeout. */
  timeoutMs?: number;
}

function friendlyNetworkError(err: unknown): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/Failed to fetch|NetworkError|fetch failed|ECONNREFUSED|Load failed/i.test(msg)) {
    return new Error(t('无法连接本地服务。请用桌面 SHE.bat 启动（API 5577），然后重试。'));
  }
  return err instanceof Error ? err : new Error(msg);
}

export async function fetchJSON<T = unknown>(
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetch(`${BASE}${url}`, {
      method: opts.method ?? 'GET',
      headers: opts.body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (opts.signal?.aborted) throw err;
      throw new Error(t('请求超时（{s}s）。服务可能卡住或未启动。', { s: timeoutMs / 1000 }));
    }
    throw friendlyNetworkError(err);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export interface SSECallbacks {
  onData: (parsed: unknown) => void;
  onError?: (err: Error) => void;
  onDone?: () => void;
}

export function streamSSE(
  url: string,
  body: unknown,
  callbacks: SSECallbacks,
  signal?: AbortSignal,
  opts?: { idleTimeoutMs?: number },
): void {
  const idleTimeoutMs = opts?.idleTimeoutMs ?? 90_000;
  const local = new AbortController();
  const onAbort = () => local.abort();
  if (signal) {
    if (signal.aborted) local.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let settled = false;
  let sawTerminal = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const bumpIdle = () => {
    clearIdle();
    if (idleTimeoutMs <= 0 || local.signal.aborted) return;
    idleTimer = setTimeout(() => {
      if (settled) return;
      local.abort();
      if (!settled) {
        settled = true;
        callbacks.onError?.(new Error(t('连接长时间无响应，已中止本轮。请检查网络或重试。')));
      }
    }, idleTimeoutMs);
  };

  fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: local.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No readable stream');

      const decoder = new TextDecoder();
      let buffer = '';
      bumpIdle();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bumpIdle();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') {
            sawTerminal = true;
            clearIdle();
            settled = true;
            callbacks.onDone?.();
            return;
          }
          try {
            const data = JSON.parse(payload) as { type?: string };
            if (data?.type === 'done' || data?.type === 'error') sawTerminal = true;
            callbacks.onData(data);
          } catch {
            // skip malformed JSON
          }
        }
      }

      clearIdle();
      if (settled) return;
      settled = true;
      if (!sawTerminal) {
        callbacks.onError?.(new Error(t('连接中断，回复可能不完整。可点停止后重试。')));
        return;
      }
      callbacks.onDone?.();
    })
    .catch((err) => {
      clearIdle();
      if (signal) signal.removeEventListener('abort', onAbort);
      if ((err as Error).name === 'AbortError') {
        // User stop or idle abort — idle path already called onError.
        if (!settled) {
          settled = true;
          // Explicit user abort: just finish quietly (stopStreaming clears UI).
        }
        return;
      }
      if (settled) return;
      settled = true;
      callbacks.onError?.(friendlyNetworkError(err));
    });
}

/** Lightweight liveness probe for the connection banner. */
export async function probeHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    await fetchJSON<{ status?: string }>('/api/health', { timeoutMs: 5000, signal });
    return true;
  } catch {
    return false;
  }
}
