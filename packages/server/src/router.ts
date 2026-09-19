import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteParams = Record<string, string>;

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: RouteParams,
) => Promise<void> | void;

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: CompiledRoute[] = [];

  get(path: string, handler: RouteHandler): this {
    return this.addRoute('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.addRoute('POST', path, handler);
  }

  put(path: string, handler: RouteHandler): this {
    return this.addRoute('PUT', path, handler);
  }

  delete(path: string, handler: RouteHandler): this {
    return this.addRoute('DELETE', path, handler);
  }

  addRoute(method: string, path: string, handler: RouteHandler): this {
    const paramNames: string[] = [];
    const segments = path.split('/').filter(Boolean);
    const regexParts = segments.map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&');
    });
    const regexStr = regexParts.length > 0
      ? '\\/' + regexParts.join('\\/')
      : '\\/';

    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    });
    return this;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return true;
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      const params: RouteParams = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
      }

      await route.handler(req, res, params);
      return true;
    }

    return false;
  }
}

// ─── Response Helpers ───

/**
 * Response headers for API replies.
 *
 * Deliberately NO `Access-Control-Allow-Origin`.
 *
 * The UI is always same-origin (served from this port, or proxied by the Vite
 * dev server server-side), so CORS buys nothing — while `*` on a localhost API
 * is actively dangerous: it lets any website the user visits read this API
 * (chat history, KB, files) and, because preflight would pass, POST to it too.
 */
export function corsHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

export function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    // charset is not optional in practice: without it several HTTP clients
    // (PowerShell, some Python/Java stacks) decode as latin1 and mangle any
    // non-ASCII text — error messages and Chinese content included.
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

export function sendError(res: ServerResponse, message: string, status = 500): void {
  sendJSON(res, { error: message, status }, status);
}

export function startSSE(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...corsHeaders(),
  });
}

export function sendSSEEvent(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function endSSE(res: ServerResponse): void {
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * An error carrying an HTTP status.
 *
 * Lives here (next to `sendError`) so that the router's own helpers — notably
 * `parseBody` — can raise client errors. Previously this class lived in the
 * server entrypoint, so `parseBody` could only throw a plain `Error`, which the
 * top-level handler classified as 500 Internal Server Error. A malformed request
 * body is the client's fault and must be a 400; reporting 500 pollutes error
 * logs and makes the UI show a scary message for a harmless typo.
 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Default ceiling for a JSON request body.
 *
 * There was none, and Node does not impose one, so `POST /api/chat` with a multi-gigabyte body
 * accumulated before any handler ran. The process dies with a V8 heap OOM, which the
 * `uncaughtException` handler cannot catch — so an unbounded body is a way to kill the server, not
 * merely a way to make one request slow. 32MB is far above any legitimate JSON payload here (the
 * large uploads use the raw-body path, which has its own cap).
 */
export const JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;

export function parseBody<T = unknown>(req: IncomingMessage, maxBytes = JSON_BODY_MAX_BYTES): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading and refuse, rather than buffering the rest and hoping.
        aborted = true;
        chunks.length = 0;
        req.destroy();
        reject(new HttpError(413, `请求体过大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) as T : {} as T);
      } catch {
        reject(new HttpError(400, '请求体不是合法的 JSON'));
      }
    });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

/**
 * Read a raw binary request body into memory, capped at `maxBytes`.
 *
 * Used for large uploads (wallpaper videos). Sending these as base64 JSON would
 * inflate them ~33% and force the browser to materialise the whole thing as a
 * string first, which falls over well before 1GB.
 */
export function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ buffer: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        chunks.length = 0;
        resolve({ buffer: Buffer.alloc(0), tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve({ buffer: Buffer.concat(chunks), tooLarge: false });
    });
    req.on('error', reject);
  });
}
