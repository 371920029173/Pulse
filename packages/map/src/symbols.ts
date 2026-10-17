/*
 * 符号轻表：`导出名 → 文件:行` + 引用数。
 *
 * 为什么不用 LSP：10 万文件下启动一次语言服务器要几十秒（C++ 还要 compile_commands.json），
 * 而模型问的往往只是"这个函数在哪、谁在用"。符号**定义**用逐行正则就能拿到九成，
 * 剩下的一成（宏、模板特化、动态导入）交给 LSP 按需补——那是 v2 的事。
 *
 * 为什么不是"一个符号一个对象"：10 万文件 × 平均 20 个符号 = 200 万个对象，
 * JSON 一存就是几百 MB，读进来 GC 直接爆。这里用**排序数组 + arena**：
 *   names:  排序后的名字（二分查找）
 *   start:  同下标，指向 arena 的起始位置
 *   count:  同下标，引用数
 *   arena:  "路径:行:种类:是否导出" 的紧凑字符串
 * 体积是对象数组的 1/5～1/10，查询仍是 O(log n)。
 *
 * 引用计数只数**导出名**（导出集本身就是个 Set，逐 token 查表），
 * 否则 10 万文件里每个局部变量都要计数，既没意义又把内存撑爆。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, mapDir } from './store.js';

export type SymbolKind = 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'method' | 'unknown';

export interface SymbolDef {
  name: string;
  path: string;
  line: number;
  kind: SymbolKind;
  exported: boolean;
}

export interface SymbolTable {
  v: 1;
  names: string[];
  start: number[];
  count: number[];
  arena: string[];
}

export const SYMBOLS_FILE = 'symbols.json';

export function symbolsPath(root: string): string {
  return join(mapDir(root), SYMBOLS_FILE);
}

/** 逐行扫；含关键字之外的行直接跳过（这一条让 10 万行扫描从"慢"变成"能接受"）。 */
const INTERESTING = /(export|function|class|interface|type\s+\w|enum|const\s+\w|let\s+\w|def\s|func\s|struct\s)/;

interface Rule {
  re: RegExp;
  kind: SymbolKind;
  exported: boolean;
}

const TS_RULES: Rule[] = [
  { re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function', exported: true },
  { re: /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', exported: true },
  { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const', exported: true },
  { re: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', exported: true },
  { re: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: 'type', exported: true },
  { re: /^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', exported: true },
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function', exported: false },
  { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', exported: false },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'const', exported: false },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', exported: false },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type', exported: false },
];

const PY_RULES: Rule[] = [
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', exported: false },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', exported: false },
];

const GO_RULES: Rule[] = [
  { re: /^\s*func\s+([A-Za-z_]\w*)/, kind: 'function', exported: false },
  { re: /^\s*func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method', exported: false },
  { re: /^\s*type\s+([A-Za-z_]\w*)/, kind: 'type', exported: false },
];

const RS_RULES: Rule[] = [
  { re: /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', exported: true },
  { re: /^\s*(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', exported: false },
  { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'class', exported: false },
];

function rulesFor(lang: string): Rule[] | null {
  if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') return TS_RULES;
  if (lang === 'py') return PY_RULES;
  if (lang === 'go') return GO_RULES;
  if (lang === 'rs') return RS_RULES;
  return null;
}

/**
 * 抽一个文件的符号。
 *
 * Go 的导出是大写开头（语言规则），这里按首字母补一条——不这么做，Go 仓的"导出名"全是空的。
 */
export function extractSymbols(path: string, lang: string, text: string): SymbolDef[] {
  const rules = rulesFor(lang);
  if (!rules) return [];
  const out: SymbolDef[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!INTERESTING.test(line)) continue;
    for (const rule of rules) {
      const m = line.match(rule.re);
      if (!m) continue;
      const name = m[1]!;
      const key = `${name}:${i + 1}`;
      if (seen.has(key)) break;
      seen.add(key);
      const exported = rule.exported || (lang === 'go' && /^[A-Z]/.test(name));
      out.push({ name, path, line: i + 1, kind: rule.kind, exported });
      break; // 一行只认最具体的规则，避免 export function 同时被 function 规则再记一次
    }
  }
  return out;
}

/** 当前只支持到 512KB：更大的文件一定是生成物或数据，读它收益远低于成本。 */
const MAX_PARSE_BYTES = 512 * 1024;

export interface BuildSymbolsOptions {
  root: string;
  files: Array<{ path: string; lang?: string }>;
  readFile?: (abs: string) => string;
}

/** 两遍：先收集定义与导出集，再数引用（只数导出名）。 */
export function buildSymbols(opts: BuildSymbolsOptions): SymbolTable {
  const read = opts.readFile ?? ((abs: string) => readFileSync(abs, 'utf8'));
  const defs: SymbolDef[] = [];
  const exportedNames = new Set<string>();

  for (const f of opts.files) {
    const lang = f.lang ?? f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase();
    if (!rulesFor(lang)) continue;
    let text: string;
    try {
      const abs = join(opts.root, f.path);
      text = read(abs);
      if (text.length > MAX_PARSE_BYTES) continue;
    } catch {
      continue;
    }
    for (const d of extractSymbols(f.path, lang, text)) {
      defs.push(d);
      if (d.exported) exportedNames.add(d.name);
    }
  }

  /** 引用计数：逐行 token 化，只查导出集（局部变量不计数）。 */
  const counts = new Map<string, number>();
  for (const f of opts.files) {
    let text: string;
    try {
      text = read(join(opts.root, f.path));
      if (text.length > MAX_PARSE_BYTES) continue;
    } catch {
      continue;
    }
    const tokens = text.match(/[A-Za-z_$][\w$]*/g);
    if (!tokens) continue;
    for (const tok of tokens) if (exportedNames.has(tok)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }

  const byName = new Map<string, SymbolDef[]>();
  for (const d of defs) {
    const list = byName.get(d.name);
    if (list) list.push(d);
    else byName.set(d.name, [d]);
  }

  /*
   * 定义处自己被数了一次：导出名的引用数要减掉自己的定义次数，
   * 否则"没人用的导出"也会显示 1，影响面判断就被这套假数据带偏。
   */
  for (const [name, list] of byName) {
    const self = list.filter((d) => d.exported).length;
    if (self && counts.has(name)) counts.set(name, Math.max(0, counts.get(name)! - self));
  }

  const names = [...byName.keys()].sort();
  const start: number[] = [];
  const count: number[] = [];
  const arena: string[] = [];
  for (const name of names) {
    start.push(arena.length);
    count.push(counts.get(name) ?? 0);
    for (const d of byName.get(name)!) {
      arena.push(`${d.path}:${d.line}:${d.kind}:${d.exported ? 'E' : 'i'}`);
    }
  }
  return { v: 1, names, start, count, arena };
}

export function writeSymbols(root: string, table: SymbolTable): void {
  writeJsonAtomic(symbolsPath(root), table);
}

export function readSymbols(root: string): SymbolTable | null {
  try {
    return JSON.parse(readFileSync(symbolsPath(root), 'utf8')) as SymbolTable;
  } catch {
    return null;
  }
}

export interface SymbolHit extends SymbolDef {
  refs: number;
}

function endOf(table: SymbolTable, i: number): number {
  return i + 1 < table.start.length ? table.start[i + 1]! : table.arena.length;
}

function decode(entry: string): SymbolDef | null {
  const m = entry.match(/^(.*):(\d+):([a-z]+):([Ei])$/);
  if (!m) return null;
  return { path: m[1]!, line: Number(m[2]), kind: m[3] as SymbolKind, exported: m[4] === 'E', name: '' };
}

/** 二分查找：名字 → 定义处 + 引用数。 */
export function lookupSymbol(table: SymbolTable, name: string): SymbolHit[] {
  let lo = 0;
  let hi = table.names.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cur = table.names[mid]!;
    if (cur === name) {
      const out: SymbolHit[] = [];
      for (let i = table.start[mid]!; i < endOf(table, mid); i += 1) {
        const d = decode(table.arena[i]!);
        if (d) out.push({ ...d, name, refs: table.count[mid]! });
      }
      return out;
    }
    if (cur < name) lo = mid + 1;
    else hi = mid - 1;
  }
  return [];
}

/**
 * 某个文件里定义了哪些符号（按行排序），供"这个文件里哪个函数重要"用。
 *
 * 默认跳过局部 `const`：函数体里遍地都是，列进大纲等于没有大纲。
 * 私有函数/类/接口/类型仍然列出来——它们值得被看见，只是不对外导出。
 */
export function symbolsInFile(table: SymbolTable, path: string, opts: { includeLocals?: boolean } = {}): SymbolHit[] {
  const out: SymbolHit[] = [];
  for (let i = 0; i < table.names.length; i += 1) {
    for (let j = table.start[i]!; j < endOf(table, i); j += 1) {
      const d = decode(table.arena[j]!);
      if (!d || d.path !== path) continue;
      if (!opts.includeLocals && !d.exported && d.kind === 'const') continue;
      out.push({ ...d, name: table.names[i]!, refs: table.count[i]! });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
