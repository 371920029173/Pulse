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
/** 方法常写在下一行：向后看 3 行。 */
const METHOD_LOOKAHEAD = 3;

/*
 * 包装函数：`withSid('/api/chat')`、`api.get('/v1/models')` 把路径交给本地 helper。
 * 只要"某个调用"的第一个参数是以 /api/ 或 /v1/ 开头的字面量，就算一次 HTTP 调用。
 * 宁可多认，也不能把核心 API 报成"没有调用方"（那会被读成"死路由、可以删"）。
 */
const WRAPPED_RE = /\b([A-Za-z_$][\w$]*)\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;

/** 把 `/api/sessions/${id}/move` 这类模板串规范成 `/api/sessions/:id/move`。 */
export function normalizePath(raw: string): string {
  let p = raw.trim().replace(/^['"`]|['"`]$/g, '');
  p = p.replace(/\$\{[^}]*\}/g, ':param');
  /* 查询串不是路径的一部分：'/api/fs/tree?path=x' 与 '/api/fs/tree' 是同一条路由。 */
  /*
   * 紧贴的占位符不是路径段：'/api/audit${q}' 里的 ${q} 是查询串的一部分，
   * 规范化后会变成 '/api/audit:param'，必须在这里丢掉，否则永远对不上 '/api/audit'。
   */
  p = p.replace(/([^/]):param/g, '$1');
  p = p.split('?')[0]!;
  p = p.replace(/\/+$/, '');
  return p;
}

/** 路由里的 `:id` 与 fetch 里的 `:param` 都视作同一个占位符。 */
function canonical(path: string): string {
  return path.replace(/:[A-Za-z_][\w]*/g, ':x');
}

/**
 * 逐段比较：路由段以 ':' 开头可匹配任意一段；调用点末尾多出的 ':param' 段忽略
 * （那种段来自模板串里的 ${q}，其实是查询串，不该参与路径对齐）。
 */
export function segmentsMatch(routePath: string, callPath: string): boolean {
  const r = routePath.split('/').filter((s) => s.length > 0);
  const c = callPath.split('/').filter((s) => s.length > 0);
  while (c.length > r.length && c[c.length - 1]!.startsWith(':')) c.pop();
  if (r.length !== c.length) return false;
  for (let i = 0; i < r.length; i += 1) {
    if (r[i]!.startsWith(':')) continue;
    if (r[i] !== c[i]) return false;
  }
  return true;
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
    /*
     * 用"本行 + 后两行"做窗口：URL 与方法都可能折到下一行，
     * 逐行匹配会把这类调用整体漏掉（表现出来又是"这条路由没有调用方"）。
     */
    const m = lines.slice(i, i + METHOD_LOOKAHEAD).join(' ').match(FETCH_RE);
    if (!m) continue;
    const raw = m[1]!;
    const path = normalizePath(raw);
    if (!path.startsWith('/')) continue; // 相对 URL / 变量，抽取器不猜
    const explicit = lines.slice(i, i + METHOD_LOOKAHEAD).join(' ').match(METHOD_HINT)?.[1]?.toUpperCase();
    out.push({ method: explicit ?? 'GET', path, file, line: i + 1, raw, methodExplicit: !!explicit });
  }
  /*
   * 包装函数：行内任何 "某个调用(第一个参数是 /api/… 字面量)" 都补记成一次 HTTP 调用。
   * 与上面同一套行扫描，避免两套逻辑漂移。
   */
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.includes('/api/') && !line.includes('/v1/')) continue;
    /* 路由注册行整行跳过：router.get('/api/x', handler) 不是调用。 */
    if (/^\s*(router|app|server|express)\s*\./.test(line)) continue;
    for (const m of line.matchAll(WRAPPED_RE)) {
      const callee = m[1]!;
      if (callee === 'fetch' || callee === 'fetchJSON') continue; // 上面已处理
      if (['router', 'app', 'server', 'express', 'require', 'import'].includes(callee)) continue;
      const raw = m[2]!;
      const path = normalizePath(raw);
      if (!path.startsWith('/api/') && !path.startsWith('/v1/')) continue;
      if (out.some((c) => c.line === i + 1 && c.path === path)) continue;
      const window = lines.slice(i, i + METHOD_LOOKAHEAD).join(' ');
      const explicit = window.match(METHOD_HINT)?.[1]?.toUpperCase();
      out.push({
        method: explicit ?? 'GET',
        path,
        file,
        line: i + 1,
        raw: `${callee}(${raw})`,
        methodExplicit: !!explicit,
      });
    }
  }
  return out;
}

export interface ContractScan {
  edges: Array<{ from: string; edge: MapEdge }>;
  routes: number;
  fetches: number;
  certain: number;
  threats: number;
  /** 有 fetch 调用但 URL 无法解析（变量拼接）的数量：不是威胁，是"没检查到"。 */
  unresolved: number;
}

export function scanHttpContracts(
  root: string,
  files: Array<{ path: string }>,
  readFile: (rel: string) => string = (rel) => readFileSync(join(root, rel), 'utf8'),
): ContractScan {
  const routes: RouteDef[] = [];
  const fetches: FetchCall[] = [];
  /** fetch/fetchJSON 的调用点总数（不管 URL 能不能解析）。 */
  let callSites = 0;

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
    if (text.includes('fetch')) {
      callSites += (text.match(/\bfetch(?:JSON)?\s*(?:<[^>]*>)?\(/g) ?? []).length;
      fetches.push(...extractFetches(text, f.path));
    }
  }

  /*
   * 不做哈希索引：路由是几百量级，逐段比较在这个规模上是常数级，
   * 换来的是"参数位能被具体值填上"这条语义——那才是准确率的关键。
   */
  const findRoute = (c: FetchCall): RouteDef | undefined => {
    let fallback: RouteDef | undefined;
    for (const r of routes) {
      if (!segmentsMatch(r.path, c.path)) continue;
      if (r.method === c.method) return r;
      if (!c.methodExplicit && !fallback) fallback = r;
    }
    return fallback;
  };

  const edges: Array<{ from: string; edge: MapEdge }> = [];
  const usedRoutes = new Set<string>();
  let certain = 0;
  let threats = 0;

  for (const c of fetches) {
    /* 方法精确优先；调用点没显式写方法时按路径匹配任意动词。 */
    const match = findRoute(c);
    if (match) {
      usedRoutes.add(`${match.method} ${canonical(match.path)}`);
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

  /* 解析不出来的那些调用点：如实计入"无法对账"。 */
  const unresolved = Math.max(0, callSites - fetches.length);
  return { edges, routes: routes.length, fetches: fetches.length, certain, threats, unresolved };
}
