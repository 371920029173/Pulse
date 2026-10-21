/*
 * import 边：静态依赖图。
 *
 * 只用正则抽 `from '…'` 与 `require('…')`，不解析语法树。理由：这个仓库里 import 语句的
 * 形态非常规整，而"解析不出来就跳过"是可接受的降级——反过来的选择（上一套完整解析器）
 * 会在 10 万文件上慢一个数量级，而收益主要是边界情况。
 *
 * 解析规则保守：只认相对路径，**解析到真实存在的文件才建边**，猜不到就不建。
 * 一条错的边比没有边更坏——影响面会把不相关的东西算进"会被你改坏"的名单里。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { MapEdge } from '@she/shared';
import { extractorFor } from './langs.js';

const FROM = /\bfrom\s+['"]([^'"]+)['"]/;

/**
 * 从一行 import 里抽出**导入的符号名**。
 *
 * 别名（`b as c`）算接的是 b —— 那是源文件里真实存在的名字；default 与命名空间各有名字。
 */
export function importedSymbols(line: string): string[] {
  const names: string[] = [];
  const named = line.match(/\{([^}]*)\}/);
  if (named) {
    for (const raw of named[1]!.split(',')) {
      const piece = raw.trim().replace(/^type\s+/, '');
      if (!piece) continue;
      const parts = piece.split(/\s+as\s+/);
      names.push(parts[0]!.trim());
    }
  }
  if (/\*\s+as\s+[A-Za-z_$][\w$]*/.test(line)) names.push('*');
  const def = line.match(/^\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/);
  if (def && !named) names.push(def[1]!);
  return [...new Set(names)].filter(Boolean);
}

/** 边的可读名：最多列 3 个符号。 */
export function wiringLabel(symbols: string[]): string {
  if (!symbols.length) return '接线（未指名符号）';
  const head = symbols.slice(0, 3).join('、');
  return symbols.length > 3 ? `接线 ${head} 等 ${symbols.length} 个` : `接线 ${head}`;
}
const REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/;
/** C/C++ 的 #include "x.h"：只认引号形式，系统头 <stdio.h> 不算本仓文件。 */
const INCLUDE = /^\s*#\s*include\s+"([^"]+)"/;

const CANDIDATE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js'];

/** 构建产物不是源码：地图不索引 dist/build，指向它们的 import 一律不建边。 */
const ARTIFACT = /(^|\/)(node_modules|dist|build|out|coverage|\.git|\.she|vendor|target)(\/|$)/;

/**
 * TS ESM 的源码里写的是 `./b.js`，磁盘上是 `b.ts`。
 * 不做这个映射，仓里一条边都建不出来——而"没有边"看起来像"没人依赖它"，
 * 是这套系统里最危险的静默错误。
 */
function jsToTs(spec: string): string[] {
  const m = spec.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
  if (!m) return [];
  return [`${m[1]}.ts`, `${m[1]}.tsx`];
}

/** 从一个文件里抽出所有模块说明符（带行号，作为证据）。 */
export function extractImports(text: string): Array<{ spec: string; line: number }> {
  const out: Array<{ spec: string; line: number }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.includes('import') && !line.includes('require')) continue;
    const m = line.match(FROM) ?? line.match(REQUIRE) ?? line.match(DYNAMIC);
    if (!m) continue;
    out.push({ spec: m[1]!, line: i + 1 });
  }
  return out;
}

/**
 * 把说明符解析成仓内相对路径。
 *
 * 只处理相对路径（`./x`、`../y`）：裸包名（`@she/shared`）是跨包依赖，那是包轴的事，
 * 混进文件级影响面会让"改一个文件会影响谁"变成"改这个包会影响谁"。
 */
export function resolveSpecifier(fromPath: string, spec: string, exists: (rel: string) => boolean): string | null {
  if (!spec.startsWith('.')) return null;
  const baseDir = posix.dirname(fromPath);
  const joined = posix.normalize(posix.join(baseDir === '.' ? '' : baseDir, spec));
  for (const ext of CANDIDATE_EXT) {
    const candidate = joined + ext;
    if (exists(candidate)) return candidate;
  }
  for (const alt of jsToTs(joined)) if (exists(alt)) return alt;
  return null;
}

export interface ImportScanResult {
  edges: Array<{ from: string; edge: MapEdge }>;
  /** 抽到但解析不了的说明符（用于地图可信度统计，不是错误）。 */
  unresolved: number;
}

/** C/C++ 文件：走 #include 抽取，不跑 JS 的 import 解析。 */
function isCOnly(path: string): boolean {
  return /\.(c|h|cc|cpp|cxx|hpp|hh|ino)$/.test(path);
}
export function scanImports(
  root: string,
  files: Array<{ path: string; lang?: string }>,
  /** workspace 包（name → 根目录）：裸包名 import 记到包根，否则"改共享包影响谁"会是空的。 */
  packages: Array<{ name: string; root: string }> = [],
  /* 传进来的是仓内相对路径，必须拼 root —— 不拼的话每个文件都读不到，边会静默为空。 */
  readFile: (rel: string) => string = (rel) => readFileSync(join(root, rel), 'utf8'),
): ImportScanResult {
  const known = new Set(files.map((f) => f.path));
  const exists = (rel: string) => known.has(rel) || existsSync(join(root, rel));
  const edges: Array<{ from: string; edge: MapEdge }> = [];
  let unresolved = 0;

  for (const f of files) {
    const isJsFile = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f.path);
    /* 非 JS：交给语言表判断（C/C++、Python、Go、Rust、Ruby、Java/Kotlin、C#、PHP）。 */
    if (!isJsFile && !extractorFor(f.path)) continue;
    let text: string;
    try {
      text = readFile(f.path);
    } catch {
      continue;
    }
    if (text.length > 512 * 1024) continue;
    const lines = text.split(/\r?\n/);

    /*
     * 非 JS/TS：按扩展名查语言表（C/C++、Python、Go、Rust、Ruby、Java/Kotlin、C#、PHP）。
     * 解析不到真实文件就不建边（计入 unresolved）—— 这一点与 JS 那条路径同一条纪律。
     */
    const extractor = extractorFor(f.path);
    if (extractor) {
      const dir = posix.dirname(f.path);
      for (const ref of extractor.extract(f.path, text)) {
        const target = ref.candidates
          .map((c) => (c.endsWith('/') ? null : c))
          .find((c) => c && exists(c)) ?? null;
        /* Go 的 import 指向目录：退一步找同名的「目录里第一个 .go」，只认唯一一个。 */
        const dirTarget = target ?? (() => {
          const cand = ref.candidates.find((c) => c.endsWith('/'));
          if (!cand) return null;
          const d = cand.replace(/\/$/, '');
          /* 同扩展名（.go 对 .go、.cs 对 .cs），且目录里只有一个才算确定。 */
          const ext = f.path.slice(f.path.lastIndexOf('.'));
          const hits = files.filter((x) => x.path.startsWith(d + '/') && x.path.endsWith(ext));
          return hits.length === 1 ? hits[0]!.path : null;
        })();
        if (!dirTarget) {
          unresolved += 1;
          continue;
        }
        const base = dirTarget.split('/').pop() ?? dirTarget;
        edges.push({
          from: f.path,
          edge: {
            from: f.path,
            to: dirTarget,
            kind: 'import',
            confidence: 'certain',
            evidence: [f.path + ':' + ref.line + ' ' + ref.spec],
            symbols: [base],
            label: '接线 ' + base,
          },
        });
      }
      continue;
    }

    for (const { spec, line } of extractImports(text)) {
      /* 纯类型导入：行内有 import type，或该项写成 { type X }。只影响重编译，不影响运行时。 */
      const srcLine = lines[line - 1] ?? '';
      const typeOnly = /\bimport\s+type\b/.test(srcLine) || /\{[^}]*\btype\s+[A-Za-z_$]/.test(srcLine);
      const symbols = importedSymbols(srcLine);
      const target = resolveSpecifier(f.path, spec, exists);
      if (!target) {
        const pkg = packages.find((p) => spec === p.name || spec.startsWith(p.name + '/'));
        if (pkg && pkg.root !== '.' && f.path !== pkg.root) {
          edges.push({
            from: f.path,
            edge: {
              from: f.path,
              to: pkg.root,
              kind: 'import',
              confidence: 'certain',
              evidence: [`${f.path}:${line} import '${spec}'（workspace 包 ${pkg.name}）`],
              typeOnly,
              symbols,
              label: wiringLabel(symbols),
            },
          });
        } else if (spec.startsWith('.')) {
          unresolved += 1;
        }
        continue;
      }
      if (target === f.path) continue;
      if (ARTIFACT.test(target)) { unresolved += 1; continue; }
      edges.push({
        from: f.path,
        edge: {
          from: f.path,
          to: target,
          kind: 'import',
          confidence: 'certain',
          evidence: [`${f.path}:${line} import '${spec}'`],
          typeOnly,
          symbols,
          label: wiringLabel(symbols),
        },
      });
    }
  }
  return { edges, unresolved };
}
