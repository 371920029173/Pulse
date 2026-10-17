/*
 * 契约图（第一对：HTTP 路由 ↔ 前端 fetch）。
 *
 * 用户提的做法，照抄成算法：
 *   ① **创建时记录潜在依赖**：服务端每注册一条路由，就记下 `{method, path, file}`；
 *   ② **两侧对账**：把使用端（fetch 调用）与提供端（路由）按规范化路径配对；
 *   ③ **确定的写出来，不确定的标潜在威胁**：
 *      - 两边都在且方法/路径相容 → certain，直接进图；
 *      - 只有使用端 → candidate + threat（**很可能 404**，也可能只是提取器没认出动态拼接）；
 *      - 只有提供端 → candidate + threat（**可能是死路由**，也可能是被外部客户端调用）。
 *
 * 关键纪律：`candidate` 永远带 falsifiers —— 说不出"什么情况下它其实没问题"，
 * 就不许把它写成"潜在威胁"，否则这份清单会迅速变成没人看的噪音。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MapEdge } from '@she/shared';

export interface RouteDef {
  method: string;
  path: string;
  file: string;
  line: number;
}

export interface FetchCall extends RouteDef {
  /** 从模板字符串抽取的原始写法（带 ${} 的），命中不到时作为证据。 */
  raw: string;
  /** 调用点是否显式写了 method（没写时不能拿 GET 硬碰别的动词）。 */
  methodExplicit: boolean;
}

const ROUTE_RE = /\brouter\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/;
const FETCH_RE = /\bfetch(?:JSON)?\s*(?:<[^>]*>)?\(\s*(`[^`]+`|'[^']+'|"[^"]+")/;
const METHOD_HINT = /method:\s*['"](\w+)['"]/;

/** 把 `/api/sessions/${id}/move` 这类模板串规范成 `/api/sessions/:id/move`。 */
export function normalizePath(raw: string): string {
  let p = raw.trim().replace(/^['"`]|['"`]$/g, '');
  p = p.replace(/\$\{[^}]*\}/g, ':param');
  /* 查询串不是路径的一部分：'/api/fs/tree?path=x' 与 '/api/fs/tree' 是同一条路由。 */
  p = p.split('?')[0]!;
  p = p.replace(/\/+$/, '');
  return p;
}

/** 路由里的 `:id` 与 fetch 里的 `:param` 都视作同一个占位符。 */
function canonical(path: string): string {
  return path.replace(/:[A-Za-z_][\w]*/g, ':x');
}

export function extractRoutes(text: string, file: string): RouteDef[] {
  const out: RouteDef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(ROUTE_RE);
    if (!m) continue;
    out.push({ method: m[1]!.toUpperCase(), path: normalizePath(m[2]!), file, line: i + 1 });
  }
  return out;
}

export function extractFetches(text: string, file: string): FetchCall[] {
  const out: FetchCall[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(FETCH_RE);
    if (!m) continue;
    const raw = m[1]!;
    const path = normalizePath(raw);
    if (!path.startsWith('/')) continue; // 相对 URL / 变量，抽取器不猜
    const explicit = lines[i]!.match(METHOD_HINT)?.[1]?.toUpperCase();
    out.push({ method: explicit ?? 'GET', path, file, line: i + 1, raw, methodExplicit: !!explicit });
  }
  return out;
}

export interface ContractScan {
  edges: Array<{ from: string; edge: MapEdge }>;
  routes: number;
  fetches: number;
  certain: number;
  threats: number;
}

export function scanHttpContracts(
  root: string,
  files: Array<{ path: string }>,
  readFile: (rel: string) => string = (rel) => readFileSync(join(root, rel), 'utf8'),
): ContractScan {
  const routes: RouteDef[] = [];
  const fetches: FetchCall[] = [];

  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f.path)) continue;
    let text: string;
    try {
      text = readFile(f.path);
    } catch {
      continue;
    }
    if (text.length > 512 * 1024) continue;
    if (text.includes('router.')) routes.push(...extractRoutes(text, f.path));
    if (text.includes('fetch')) fetches.push(...extractFetches(text, f.path));
  }

  const byMethod = new Map<string, RouteDef[]>();
  const byPathOnly = new Map<string, RouteDef[]>();
  for (const r of routes) {
    const key = `${r.method} ${canonical(r.path)}`;
    const list = byMethod.get(key);
    if (list) list.push(r);
    else byMethod.set(key, [r]);
    const pkey = canonical(r.path);
    const plist = byPathOnly.get(pkey);
    if (plist) plist.push(r);
    else byPathOnly.set(pkey, [r]);
  }

  const edges: Array<{ from: string; edge: MapEdge }> = [];
  const usedRoutes = new Set<string>();
  let certain = 0;
  let threats = 0;

  for (const c of fetches) {
    const key = `${c.method} ${canonical(c.path)}`;
    /*
     * 方法精确匹配优先；调用点没显式写方法时，允许按路径匹配任意动词
     * （多行写法很常见，硬按 GET 会对不上 PUT/DELETE 的路由）。
     */
    const match = byMethod.get(key)?.[0] ?? (c.methodExplicit ? undefined : byPathOnly.get(canonical(c.path))?.[0]);
    if (match) {
      usedRoutes.add(key);
      certain += 1;
      edges.push({
        from: c.file,
        edge: {
          from: c.file,
          to: match.file,
          kind: 'contract',
          confidence: 'certain',
          evidence: [`${c.file}:${c.line} fetch ${c.raw}`, `${match.file}:${match.line} router.${match.method.toLowerCase()}('${match.path}')`],
        },
      });
    } else {
      threats += 1;
      edges.push({
        from: c.file,
        edge: {
          from: c.file,
          to: c.file,
          kind: 'contract',
          confidence: 'candidate',
          evidence: [`${c.file}:${c.line} fetch ${c.raw} → 没有找到对应的路由注册`],
          falsifiers: [
            '服务端用动态拼接注册了这条路由，抽取器没认出来',
            '这个请求打的是外部服务，不是本仓的 server',
          ],
        },
      });
    }
  }

  /* 只有提供端：可能是死路由，也可能是给外部客户端用的。 */
  for (const r of routes) {
    const key = `${r.method} ${canonical(r.path)}`;
    if (usedRoutes.has(key)) continue;
    threats += 1;
    edges.push({
      from: r.file,
      edge: {
        from: r.file,
        to: r.file,
        kind: 'contract',
        confidence: 'candidate',
        evidence: [`${r.file}:${r.line} router.${r.method.toLowerCase()}('${r.path}') → 仓内没有调用方`],
        falsifiers: ['调用方是外部客户端（SDK / 第三方集成）', '调用方在测试或脚本里，用字符串拼接而成'],
      },
    });
  }

  return { edges, routes: routes.length, fetches: fetches.length, certain, threats };
}
