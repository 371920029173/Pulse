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

/** Header the server reads the access token from; see `packages/server/src/tenancy.ts`. */
const AUTH_HEADER = 'X-SHE-Token';
/** Where a browser client keeps its token. The desktop shell injects `__sheAuthToken` instead. */
const AUTH_STORAGE_KEY = 'she.authToken';

/**
 * The access token for this client, if the server needs one.
 *
 * Three sources, in this order, because the three ways of running this app are genuinely different:
 * the desktop shell already knows the token from its own environment and hands it to the preload,
 * which is the only one that is ready before the first request; a browser tab has nowhere to get it
 * from except the person sitting there, so it reads a value they set once; and a raw injected global
 * covers a page that was wired up by hand. None of them stores the token anywhere the SERVER could
 * read — the point of the token is that it does not live in the workspace.
 */
export function authToken(): string | null {
  const desktop = (globalThis as { sheDesktop?: { authToken?: unknown } }).sheDesktop?.authToken;
  if (typeof desktop === 'string' && desktop.trim()) return desktop.trim();
  const injected = (globalThis as { __sheAuthToken?: unknown }).__sheAuthToken;
  if (typeof injected === 'string' && injected.trim()) return injected.trim();
  try {
    const stored = globalThis.localStorage?.getItem(AUTH_STORAGE_KEY);
    return stored && stored.trim() ? stored.trim() : null;
  } catch {
    // Private-mode browsers and some sandboxed renderers throw on localStorage access.
    return null;
  }
}

/** Headers for a request that may need to authenticate. */
function requestHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  const token = authToken();
  if (token) headers[AUTH_HEADER] = token;
  return headers;
}

/**
 * Turn a 401 into an instruction.
 *
 * The server's own body is just "Unauthorized", which reads as a bug rather than a setting. When
 * the API is token-gated and this client has no token, the only useful thing to say is where the
 * token comes from — otherwise the symptom is an empty session list and no reason for it.
 */
function authHint(status: number, fallback: string): Error {
  if (status === 401) {
    return new Error(t('本地服务要求访问令牌，但客户端没有提供。请设置 SHE_AUTH_TOKEN 重启服务，并在本机填入同一个令牌。'));
  }
  return new Error(fallback);
}

/**
 * `fetch` with the access token attached.
 *
 * The raw calls scattered across the theme, background and export code predate the token and would
 * each 401 on their own once the server is gated — so "auth is on" would mean "the theme panel is
 * broken", which is a worse outcome than not having the setting. One wrapper, used everywhere, is
 * the only version of this that stays correct as call sites are added.
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = authToken();
  if (token) headers.set(AUTH_HEADER, token);
  return fetch(`${BASE}${url}`, { ...init, headers });
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
      headers: requestHeaders(opts.body != null),
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw authHint(res.status, (err as { error?: string }).error ?? `HTTP ${res.status}`);
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
    headers: requestHeaders(true),
    body: JSON.stringify(body),
    signal: local.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw authHint(res.status, (err as { error?: string }).error ?? `HTTP ${res.status}`);
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
        /*
         * The body ended without `done` / `error` / `[DONE]`. That is never a finished reply, so it
         * must be said out loud — a silent end is indistinguishable from "the model stopped here".
         */
        callbacks.onError?.(new Error(t('与本地服务的连接中断（没有收到结束信号），回复可能不完整。这一轮可能仍在后台进行，稍后会自动同步。')));
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

/** A file the user pasted or dropped, after the server has stored it. */
export interface UploadedAttachment {
  /** Absolute path — what goes to the model and what `@`-references point at. */
  path: string;
  relPath: string;
  name: string;
  mime: string;
  bytes: number;
  /** Served URL, for the composer thumbnail. */
  url: string;
}

/**
 * Upload one pasted/dropped file.
 *
 * Raw body with the name in a header, matching the wallpaper upload: a pasted screenshot is
 * already megabytes, and base64 would inflate it by a third before the request even starts.
 */
export async function uploadAttachment(file: File | Blob, filename?: string): Promise<UploadedAttachment> {
  const type = (file as File).type || '';
  const name = filename || (file as File).name || 'attachment';
  const res = await apiFetch('/api/attachments', {
    method: 'POST',
    headers: {
      'Content-Type': type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(name),
      'X-Mime': type,
    },
    body: file,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return await res.json() as UploadedAttachment;
}

/** Prefix a stored attachment's URL for use in an `<img src>`. */
export function attachmentUrl(url: string): string {
  return url.startsWith('/') ? `${BASE}${url}` : url;
}
