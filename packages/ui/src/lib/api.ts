const BASE = '';

export interface FetchOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export async function fetchJSON<T = unknown>(
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    method: opts.method ?? 'GET',
    headers: opts.body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
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
): void {
  fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') {
            callbacks.onDone?.();
            return;
          }
          try {
            callbacks.onData(JSON.parse(payload));
          } catch {
            // skip malformed JSON
          }
        }
      }

      callbacks.onDone?.();
    })
    .catch((err) => {
      if ((err as Error).name === 'AbortError') return;
      callbacks.onError?.(err as Error);
    });
}
