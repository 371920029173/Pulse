/**
 * Every API path the UI calls is actually routed by the server.
 *
 *   node scripts/api-wiring-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * A feature shipped as two correct-looking halves and did nothing. `TaskBoard.markStaleRunning()`
 * existed on the server, and `TaskCards.tsx` posted to `/api/tasks/mark-stale` when the connection
 * dropped — but no route exposed the method, so the request 404'd and, being wrapped in
 * `.catch(() => undefined)`, failed without a trace. The UI marked its own cards failed; the server
 * kept them `running` forever; a reload showed "in progress" again for work that had already died.
 *
 * Neither half looks wrong on its own, which is why nothing caught it. TypeScript cannot: the URL is
 * a string. Tests could not: the component swallows the error, and the server method is tested
 * directly rather than through the route.
 *
 * The rule is mechanical and checkable: for each call the UI makes, does a route exist with that
 * path AND that HTTP method?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE METHOD MATTERS
 *
 * The first version of this diagnostic ignored methods and reported nothing, because
 * `/api/tasks/mark-stale` "matched" the param route `/api/tasks/:id` — a `:param` segment happily
 * swallows a literal one. That is a false negative of exactly the kind this check is meant to
 * prevent, so a route only counts when the path AND the verb both line up.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const UI = join(ROOT, 'packages', 'ui', 'src');
const SERVER = join(ROOT, 'packages', 'server', 'src');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 900)}`);
  }
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/* ─── Server routes, with the method they answer on ─── */

const routes = [];
for (const f of walk(SERVER)) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/router\.(get|post|put|delete)\(\s*'([^']+)'/g)) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], from: relative(ROOT, f).replace(/\\/g, '/') });
  }
}
console.log(`\n=== 服务端路由（${routes.length} 条）===`);

/* ─── Calls the UI makes, with the method it uses ─── */

/**
 * Extract every `fetchJSON(...)` call as `{ path, method }`.
 *
 * Scans each call's own argument list rather than a fixed-size window around the match. A window
 * gets two things wrong, both of which produce FALSE NEGATIVES (a silent check is the failure mode
 * this script exists to catch), and both were observed while writing it:
 *
 *   - too small: the URL is preceded by a multi-line generic (`fetchJSON<{ imported?: number; … }>`),
 *     so `method: 'POST'` fell outside it and the call was recorded as GET;
 *   - too large: it ran past the end of the call into the NEXT one and picked up that call's method.
 *
 * Walking to the matching closing paren is exact. `fetchJSON` defaults to GET, so a call with no
 * `method` is a GET — which is the convention the client helper documents.
 */
function extractCalls(text) {
  const found = [];
  let idx = text.indexOf('fetchJSON');
  while (idx !== -1) {
    // Walk to the opening paren of the call.
    let i = idx + 'fetchJSON'.length;
    while (i < text.length && text[i] !== '(') i++;
    if (i >= text.length) break; // e.g. the declaration itself: `export async function fetchJSON<T>(`

    // Walk to its matching close paren, tracking quotes and nesting.
    let depth = 0;
    let inString = null;
    let end = -1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) break;

    const call = text.slice(idx, end + 1);
    const urlMatch = /[(,]\s*[`'"]([^`'"]+)[`'"]/.exec(call) ?? /^\s*[`'"]([^`'"]+)[`'"]/.exec(call);
    const method = /method:\s*['"](GET|POST|PUT|DELETE)['"]/i.exec(call)?.[1]?.toUpperCase() ?? 'GET';
    if (urlMatch) found.push({ raw: urlMatch[1], method });

    idx = text.indexOf('fetchJSON', end);
  }
  return found;
}

/* ─── Calls the UI makes, with the method it uses ─── */

const calls = new Map();
for (const f of walk(UI)) {
  // Test files deliberately call paths that do not exist (the fetch-stub harness asserts on them).
  if (f.includes('__tests__')) continue;
  const text = readFileSync(f, 'utf8');

  for (const { raw, method } of extractCalls(text)) {
    if (!raw.startsWith('/api')) continue;

    /*
     * Normalise the URL into a route shape.
     *
     * `${...}` is only a path segment when it FOLLOWS a slash. `/api/tasks/${id}` is a param;
     * `/api/plans${q}` is a query string built by string concatenation, and treating it as a
     * segment produced the nonsense path `/api/plans:id`.
     */
    const path = raw
      .replace(/\/\$\{[^}]*\}/g, '/:id')
      .replace(/\$\{[^}]*\}/g, '')
      .split(/[?#]/)[0]
      .replace(/\/$/, '')
      // A concrete id in the path is a param at the route level.
      .replace(/\/sess_[A-Za-z0-9]+/g, '/:id')
      .replace(/\/room_[A-Za-z0-9]+/g, '/:id')
      .replace(/\/m_[A-Za-z0-9]+/g, '/:id');
    if (!path || path === '/api') continue;

    const key = `${method} ${path}`;
    if (!calls.has(key)) calls.set(key, new Set());
    calls.get(key).add(relative(ROOT, f).replace(/\\/g, '/'));
  }
}
console.log(`=== UI 调用（${calls.size} 个「方法 + 路径」组合）===\n`);

/** Whether a route answers this method on this path (a `:param` matches one segment). */
function routed(method, path) {
  const want = path.split('/').filter(Boolean);
  return routes.filter((r) => {
    if (r.method !== method) return false;
    const segs = r.path.split('/').filter(Boolean);
    if (segs.length !== want.length) return false;
    return segs.every((s, i) => s.startsWith(':') || s === want[i]);
  });
}

const missing = [];
for (const [key, files] of [...calls].sort()) {
  const [method, path] = key.split(' ');
  if (routed(method, path).length === 0) missing.push([key, [...files]]);
}

check(
  `UI 调用的每个接口在服务端都有对应路由（${calls.size - missing.length}/${calls.size}）`,
  missing.length === 0,
  missing.map(([k, f]) => `${k}\n          ${f.join(', ')}`).join('\n        '),
);

/* ─── Also catch a route referenced only in the UI's own client helper ─── */
//
// `lib/api.ts` wraps some calls; if it grew a helper for a path nobody routed, it belongs in the
// same report. Kept as a separate assertion so the failure names which side is wrong.
{
  const apiTs = join(UI, 'lib', 'api.ts');
  if (existsSync(apiTs)) {
    const text = readFileSync(apiTs, 'utf8');
    const stray = [];
    for (const m of text.matchAll(/['"`](\/api\/[^'"`$?]*)/g)) {
      const p = m[1].replace(/\/$/, '');
      if (!p || p === '/api') continue;
      // Any method would do here: the point is whether the path exists at all.
      const anyMethod = ['GET', 'POST', 'PUT', 'DELETE'].some((mm) => routed(mm, p).length > 0);
      if (!anyMethod) stray.push(p);
    }
    check(
      'lib/api.ts 里的接口路径都有路由',
      stray.length === 0,
      [...new Set(stray)].join(', '),
    );
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
