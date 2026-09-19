/**
 * Localization coverage.
 *
 * Reports how many user-facing Chinese strings are still hardcoded, and FAILS when
 * the count grows. A ratchet, not a gate on zero:
 *
 *   - the number is visible, so "we're at 40% localized" is a fact rather than an
 *     impression
 *   - new hardcoded strings are blocked immediately, so the target cannot recede
 *   - once the count reaches zero, the same check keeps it there
 *
 * Counting approach: find CJK text inside string literals and JSX text nodes. That
 * is deliberately approximate — a comment mentioning Chinese is not user-facing,
 * and a `title` attribute is. Being exact would need a real parser; being slightly
 * generous is safe here because the check's job is to prevent REGRESSION, and a
 * comment-only false positive is visible and cheap to fix.
 *
 *   node scripts/i18n-check.mjs
 *   node scripts/i18n-check.mjs --update     # accept the current count as baseline
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');
const BASELINE_FILE = join(HERE, 'i18n-baseline.json');
const LOCALE_FILE = join(UI_SRC, 'locales', 'en.ts');

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Source files that render to users, excluding tests and styles. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { sourceFiles(p, out); continue; }
    if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * Blank out the arguments of every `t(...)` / `tn(...)` call.
 *
 * Those strings are still Chinese in the source, but they ARE translated — the key is the
 * source text. Counting them would mean converting a component never lowers the number,
 * which makes the ratchet meaningless.
 *
 * This works on the whole file rather than line by line, because a call is routinely
 * formatted across several lines:
 *
 *     t('{rules} 条规则 · {vars} 个变量', {
 *       rules: n,
 *       vars: m,
 *     })
 *
 * A per-line regex cannot see that the trailing lines are still inside the call, and
 * reported them as untranslated. Masked characters become spaces — never newlines — so
 * line numbers in the report still match the file.
 */
function maskTCalls(text) {
  const masked = text.split('');
  const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c ?? '');

  for (let i = 0; i < text.length; i++) {
    // A `t` or `tn` identifier immediately followed by `(`.
    if (text[i] !== 't' || isIdentChar(text[i - 1])) continue;
    let j = i + 1;
    if (text[j] === 'n') j++;
    if (text[j] !== '(') continue;

    // Walk to the matching `)`, tracking nesting and strings so a paren inside a string
    // does not end the call early.
    let depth = 0;
    let inString = null;
    let k = j;
    for (; k < text.length; k++) {
      const ch = text[k];
      if (inString) {
        if (ch === '\\') k++;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (k >= text.length) continue; // unbalanced; the compiler will complain instead

    for (let p = i; p <= k; p++) {
      if (masked[p] !== '\n') masked[p] = ' ';
    }
    i = k;
  }

  return masked.join('');
}

/**
 * CJK-bearing string literals and JSX text, with translated calls excluded.
 *
 * Returns the matched text, so the report can show examples rather than only a number — a
 * number nobody can act on gets ignored.
 */
function findHardcoded(text) {
  const found = [];
  const masked = maskTCalls(text);
  const lines = masked.split(/\r?\n/);
  const rawLines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    const rawLine = rawLines[i] ?? '';
    // Skip comments: they are not rendered.
    if (/^\s*(\/\/|\*|\/\*)/.test(rawLine)) return;

    // Quoted strings (single, double, backtick).
    const quoted = line.match(/(['"`])((?:\\.|(?!\1).)*?)\1/g) ?? [];
    for (const q of quoted) {
      if (CJK.test(q)) found.push({ line: i + 1, text: q.slice(0, 70) });
    }

    // JSX text: CJK sitting between tags, not inside quotes.
    const stripped = line.replace(/(['"`])(?:\\.|(?!\1).)*?\1/g, '');
    const jsxText = stripped.match(/>[^<>{]*[\u4e00-\u9fff][^<>{]*</);
    if (jsxText) {
      found.push({ line: i + 1, text: jsxText[0].slice(0, 70) });
    }
  });
  return found;
}

/** Strings already translated, read from the English dictionary. */
function translatedCount() {
  if (!existsSync(LOCALE_FILE)) return 0;
  const text = readFileSync(LOCALE_FILE, 'utf8');
  // Count dictionary keys: lines shaped like `'源文本': 'Translation',`
  return (text.match(/^\s*'[^']+':/gm) ?? []).length;
}

const files = sourceFiles(UI_SRC).sort();
const perFile = [];
let total = 0;

for (const f of files) {
  const relPath = relative(ROOT, f).replace(/\\/g, '/');
  // The dictionary is Chinese by design (keys are the source strings), and the
  // i18n runtime quotes examples. Counting them would make coverage meaningless.
  if (relPath.endsWith('locales/en.ts') || relPath.endsWith('locales/index.ts') || relPath.endsWith('lib/i18n.ts')) {
    continue;
  }
  const text = readFileSync(f, 'utf8');
  const hits = findHardcoded(text);
  if (hits.length) {
    perFile.push({ file: relPath, count: hits.length, samples: hits.slice(0, 2) });
    total += hits.length;
  }
}

console.log('\n界面文案本地化覆盖\n');
console.log(`  已翻译条目      ${translatedCount()}`);
console.log(`  仍硬编码（中文） ${total}\n`);

if (process.argv.includes('--verbose')) {
  for (const f of perFile) {
    console.log(`  ${String(f.count).padStart(4)}  ${f.file}`);
    for (const s of f.samples) console.log(`        ${s.line}: ${s.text}`);
  }
  console.log('');
}

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_FILE, JSON.stringify({
    baseline: total,
    updatedAt: new Date().toISOString(),
    note: 'Hardcoded user-facing Chinese strings. Lower this as components are converted; never raise it.',
  }, null, 2) + '\n', 'utf8');
  console.log(`  已记录基线：${total}\n`);
  process.exit(0);
}

let baseline = null;
if (existsSync(BASELINE_FILE)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).baseline;
  } catch { /* a malformed baseline is treated as absent */ }
}

const top = [...perFile].sort((a, b) => b.count - a.count).slice(0, 8);
console.log('  待转换最多的文件：');
for (const f of top) console.log(`    ${String(f.count).padStart(4)}  ${f.file}`);
console.log('');

if (baseline === null) {
  console.log(`  没有基线文件。用 --update 记录当前值（${total}）作为上限。\n`);
  process.exit(0);
}

if (total > baseline) {
  console.log(`  FAIL  硬编码数量上升了：${baseline} → ${total}（新增 ${total - baseline}）`);
  console.log('        新加的界面文案请走 t(...)，否则又多一处要翻译。');
  console.log('        查看具体位置：node scripts/i18n-check.mjs --verbose\n');
  process.exit(1);
}

if (total < baseline) {
  console.log(`  PASS  比基线少了 ${baseline - total} 处（${baseline} → ${total}）。`);
  console.log('        用 --update 收紧基线，避免进度回退。\n');
  process.exit(0);
}

console.log(`  PASS  与基线持平（${total}）。没有新增硬编码文案。\n`);
process.exit(0);
