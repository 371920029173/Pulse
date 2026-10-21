/*
 * 多语言的"接线"抽取：一张显式的语言表。
 *
 * 原则和 JS/TS 那边一致：**只建能解析到真实存在的文件的边**（certain），解析不出来就计入
 * unresolved —— 不猜。区别只是每种语言的"引用语法"和"落到哪个扩展名"不一样。
 *
 * 覆盖：C/C++（#include "x"）、Python（import/from）、Go（import "p"）、Rust（use/mod）、
 * Ruby（require_relative/require）、Java/Kotlin（import a.b.C）、C#（using A.B）、PHP（use/require）。
 */
import { posix } from 'node:path';

export interface RawRef {
  /** 原始引用串（用于证据）。 */
  spec: string;
  line: number;
  /** 候选相对路径（按顺序试，第一个存在的赢）。 */
  candidates: string[];
}

type Extractor = (path: string, text: string) => RawRef[];

/** 把 `a.b.C` 变成 `a/b/C` 的候选，并按语言补扩展名。 */
function dotted(spec: string, exts: string[], suffix: string[] = []): string {
  const base = spec.replace(/\./g, '/');
  return suffix.length ? `${base}${suffix[0]}` : exts.map((e) => base + e)[0] ?? base;
}

function dottedCandidates(spec: string, exts: string[]): string[] {
  const base = spec.replace(/\./g, '/');
  return exts.map((e) => base + e);
}

const C_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|ino)$/;

const cLike: Extractor = (path, text) => {
  const out: RawRef[] = [];
  const lines = text.split(/\r?\n/);
  const dir = posix.dirname(path);
  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? '').match(/^\s*#\s*include\s+"([^"]+)"/);
    if (!m) continue;
    const spec = m[1]!;
    out.push({ spec, line: i + 1, candidates: [posix.normalize(posix.join(dir, spec)), spec] });
  }
  return out;
};

const python: Extractor = (path, text) => {
  const out: RawRef[] = [];
  const lines = text.split(/\r?\n/);
  const dir = posix.dirname(path);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const from = line.match(/^\s*from\s+(\.*)([\w.]*)\s+import\s+/);
    const plain = line.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/);
    const spec = from ? `${from[1]}${from[2]}` : plain ? plain[1]!.split(',')[0]!.trim() : '';
    if (!spec) continue;
    if (spec.startsWith('.')) {
      /* 相对导入：点号的个数 = 上升的层级 */
      const dots = spec.match(/^\.+/)![0].length;
      const rest = spec.slice(dots).replace(/\./g, '/');
      const up = Array.from({ length: Math.max(0, dots - 1) }, () => '..');
      const base = posix.normalize(posix.join(dir, ...up, rest));
      out.push({ spec, line: i + 1, candidates: [`${base}.py`, posix.join(base, '__init__.py')] });
    } else {
      const base = spec.replace(/\./g, '/');
      out.push({ spec, line: i + 1, candidates: [`${base}.py`, posix.join(base, '__init__.py')] });
    }
  }
  return out;
};

const go: Extractor = (_path, text) => {
  const out: RawRef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? '').match(/^\s*(?:import\s+)?(?:[\w.]+\s+)?"([\w./-]+)"/);
    if (!m) continue;
    const spec = m[1]!;
    /* 只认同仓路径：取最后一段，找同名目录下的 .go 文件（存在才建边）。 */
    const seg = spec.split('/').filter(Boolean);
    if (!seg.length) continue;
    const last = seg.slice(-2).join('/');
    /* 先试同名文件（svc/handlers.go），再试同名目录（svc/handlers/）。 */
    out.push({ spec, line: i + 1, candidates: [`${spec}.go`, `${last}.go`, `${spec}/`] });
  }
  return out;
};

const rust: Extractor = (path, text) => {
  const out: RawRef[] = [];
  const lines = text.split(/\r?\n/);
  const dir = posix.dirname(path);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const mod = line.match(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/);
    if (mod) {
      const name = mod[1]!;
      out.push({ spec: `mod ${name}`, line: i + 1, candidates: [posix.join(dir, `${name}.rs`), posix.join(dir, name, 'mod.rs')] });
      continue;
    }
    const use = line.match(/^\s*use\s+(?:crate|super|self)::([\w:]+)/);
    if (!use) continue;
    const parts = use[1]!.split('::');
    const tail = parts.slice(0, 2).join('/');
    out.push({
      spec: line.trim(),
      line: i + 1,
      candidates: [`src/${tail}.rs`, `src/${tail}/mod.rs`, posix.join(dir, `${parts[0]}.rs`)],
    });
  }
  return out;
};

const ruby: Extractor = (path, text) => {
  const out: RawRef[] = [];
  const lines = text.split(/\r?\n/);
  const dir = posix.dirname(path);
  for (let i = 0; i < lines.length; i += 1) {
    const rel = (lines[i] ?? '').match(/^\s*require_relative\s+['"]([^'"]+)['"]/);
    if (rel) {
      out.push({ spec: rel[1]!, line: i + 1, candidates: [posix.normalize(posix.join(dir, `${rel[1]!}.rb`))] });
      continue;
    }
    const req = (lines[i] ?? '').match(/^\s*require\s+['"]([^'"]+)['"]/);
    if (req) out.push({ spec: req[1]!, line: i + 1, candidates: [`lib/${req[1]!}.rb`, `${req[1]!}.rb`] });
  }
  return out;
};

const javaLike: Extractor = (_path, text) => {
  const out: RawRef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? '').match(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;?/);
    if (!m) continue;
    if (/^(java|javax|kotlin)\./.test(m[1]!)) continue; /* 标准库 */
    out.push({ spec: m[1]!, line: i + 1, candidates: dottedCandidates(m[1]!, ['.java', '.kt']) });
  }
  return out;
};

const csharp: Extractor = (_path, text) => {
  const out: RawRef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? '').match(/^\s*using\s+([\w.]+)\s*;/);
    if (!m) continue;
    if (/^System(\.|$)/.test(m[1]!)) continue;
    out.push({ spec: m[1]!, line: i + 1, candidates: dottedCandidates(m[1]!, [".cs"]) });
  }
  return out;
};

const php: Extractor = (path, text) => {
  const out: RawRef[] = [];
  const lines = text.split(/\r?\n/);
  const dir = posix.dirname(path);
  for (let i = 0; i < lines.length; i += 1) {
    const use = (lines[i] ?? '').match(/^\s*use\s+([\w\\]+);/);
    if (use) out.push({ spec: use[1]!, line: i + 1, candidates: [`${use[1]!.replace(/\\/g, '/')}.php`] });
    const req = (lines[i] ?? '').match(/^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/);
    if (req) out.push({ spec: req[1]!, line: i + 1, candidates: [posix.normalize(posix.join(dir, req[1]!)), req[1]!] });
  }
  return out;
};

/** 扩展名 → 抽取器。JS/TS 走 imports.ts 里原有的解析（它要处理 .js→.ts 的映射），不在这张表里。 */
export const LANG_EXTRACTORS: Array<{ test: RegExp; extract: Extractor; label: string }> = [
  { test: C_EXT, extract: cLike, label: 'C/C++ #include' },
  { test: /\.py$/, extract: python, label: 'Python import/from' },
  { test: /\.go$/, extract: go, label: 'Go import' },
  { test: /\.rs$/, extract: rust, label: 'Rust use/mod' },
  { test: /\.rb$/, extract: ruby, label: 'Ruby require' },
  { test: /\.(java|kt|kts)$/, extract: javaLike, label: 'Java/Kotlin import' },
  { test: /\.cs$/, extract: csharp, label: 'C# using' },
  { test: /\.php$/, extract: php, label: 'PHP use/require' },
];

export function extractorFor(path: string): { extract: Extractor; label: string } | null {
  for (const entry of LANG_EXTRACTORS) if (entry.test.test(path)) return entry;
  return null;
}

/** 这个扩展名是否已经被地图当作"源码"抽取（给界面上的语言开关用）。 */
export function supportedExtensions(): string[] {
  return [
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'ino',
    'py', 'go', 'rs', 'rb', 'java', 'kt', 'kts', 'cs', 'php',
  ];
}

void dotted;
