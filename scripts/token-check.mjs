#!/usr/bin/env node
/*
 * Colour literals in the UI's CSS modules.
 *
 *   node scripts/token-check.mjs
 *   node scripts/token-check.mjs --list     # print the current per-file counts as a baseline
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `global.css` is the palette. Every other stylesheet is supposed to consume it, and for a long
 * while a large minority did not: a survey found 129 colour literals across 16 `.module.css` files.
 * The cost was not aesthetic alone, it was that those files stopped following the theme.
 *
 * The two failures that came out of it are worth naming, because both looked fine in the theme the
 * author was using:
 *
 *   - `CommandPalette.module.css` had no tokens at all. Its nine literals were the values of a
 *     palette that had already been deleted from `global.css`, so Ctrl+K — the panel a heavy user
 *     opens most — still drew a dark panel with light text on top of a light app.
 *   - `.codeBlock` had a hardcoded dark background while `--syntax-*` are redefined per theme. In
 *     light mode every code block was a near-black slab carrying light-tuned syntax colours; the
 *     string green measured about 2.5:1.
 *
 * Both are the same shape: a colour written down instead of referenced. Nothing in the gate could
 * see them, because `check:a11y` measures tokens and these were not tokens.
 *
 * ── The two rules ────────────────────────────────────────────────────────────
 *
 * A. A literal whose value is exactly a token's value is a token spelled out. That is the specific
 *    mistake above, and it is decidable — no judgement about intent, just string equality against
 *    the palette, with `var()` chains resolved and 3-digit hex normalised. This rule is absolute.
 *
 *    Pure white and black are excluded: text on a saturated fill is `check:a11y`'s job (it owns the
 *    `--on-*` rule, which understands which fill a rule sits on), and a scrim over an unknown
 *    backdrop is not a palette value.
 *
 * B. Everything else is ratcheted per file — the count may fall, never rise. That is the same shape
 *    as the dead-CSS and padding-height baselines in `control-style-check.mjs`, and for the same
 *    reason: the remaining literals are not all wrong (a terminal is legitimately always dark), so
 *    the job here is to stop the number growing while it is worked down, not to pretend it is zero.
 *
 * Deleting a literal without replacing it with a token lowers a count but changes nothing, so the
 * baseline is lowered by hand when a file is actually cleaned up. `--list` prints the current
 * numbers in exactly the form the baseline uses.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = join(ROOT, 'packages', 'ui', 'src', 'styles');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail.split('\n').join('\n        ')}`);
  }
};

// ─── Reading the palette ───
//
// Merged in file order so the last declaration wins, which is what the browser does — the same
// reasoning as `check:a11y`, and necessary for the same reason: `:root` does not appear once.

const globalCss = readFileSync(join(STYLES, 'global.css'), 'utf8');

const collectTokens = (selector) => {
  const out = {};
  for (const m of globalCss.matchAll(/(^|\n)([^\n{}]*)\{([\s\S]*?)\}/g)) {
    if (m[2].trim() !== selector) continue;
    for (const d of m[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
};

const resolveVar = (value, tokens) => {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(String(value).trim());
  if (!m) return value;
  const target = tokens[m[1]];
  return target === undefined ? (m[2] ?? value) : target;
};

/** `#abc` and `#AABBCC` both normalise, so equality is not defeated by spelling. */
const normHex = (hex) => {
  const h = hex.toLowerCase();
  return /^#[0-9a-f]{3}$/.test(h) ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h;
};

const tokenValues = new Map();
for (const [selector, themeName] of [[':root', '深色'], ['[data-theme="light"]', '浅色']]) {
  const tokens = collectTokens(selector);
  for (const [name, raw] of Object.entries(tokens)) {
    const value = String(resolveVar(raw, tokens)).trim();
    if (!/^#[0-9a-f]{3,8}$/i.test(value)) continue;
    if (!tokenValues.has(normHex(value))) tokenValues.set(normHex(value), []);
    tokenValues.get(normHex(value)).push(`${name}(${themeName})`);
  }
}

// ─── Reading the stylesheets ───
//
// Two things are stripped before counting, and both would otherwise produce false positives:
//
//   - block comments, which in this repo explain *why* a literal was removed and therefore name it
//   - `var(--x, fallback)`, where the colour only applies if the token is missing. Those fallbacks
//     are part of a tokenised rule, so a rule that has one is not bypassing the theme.

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const stripVarFallbacks = (code) => code.replace(/var\((--[\w-]+)\s*,[^()]*(?:\([^()]*\)[^()]*)*\)/g, 'var($1)');

const MODULES = readdirSync(STYLES).filter((f) => f.endsWith('.module.css')).sort();

/*
 * Files whose literals are correct, with the reason.
 *
 * A pruned allowlist is required — a stale entry fails — because an exemption nobody revisits is
 * just a place for the problem to hide. There is exactly one file here, and it is a genuine case:
 * the terminal renders a shell's own palette on a surface that is dark in BOTH themes, so pointing
 * it at theme-flipping tokens would be the bug rather than the fix (`--success` is `#3fb950` in the
 * dark theme and `#1a7f37` in the light one, and the light green is unreadable on `#0a0e14`).
 */
const ALWAYS_DARK = new Map([
  ['Terminal.module.css', '终端在两种主题下都是深色表面，用会随主题翻转的 token 反而会变不可读'],
]);

/** Rule B baseline. Counts may fall; lower them by hand when a file is actually cleaned up. */
const BASELINE = {
  'Chat.module.css': 31,
  'SchedulePanel.module.css': 20,
  'Home.module.css': 16,
  'ComposerPanel.module.css': 15,
  'GroupBrowser.module.css': 14,
  'PulseTracePanel.module.css': 10,
  'Terminal.module.css': 6,
  'Sidebar.module.css': 6,
  'ThemeStudio.module.css': 5,
  'Settings.module.css': 4,
  'Cluster.module.css': 2,
  'ImportSources.module.css': 2,
  'App.module.css': 1,
  'CommandPalette.module.css': 1,
  'Dock.module.css': 1,
  'SkillManager.module.css': 1,
};

const counts = new Map();
const duplicated = [];
const usedExemptions = new Set();

for (const file of MODULES) {
  const lines = stripComments(readFileSync(join(STYLES, file), 'utf8')).split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = stripVarFallbacks(line);
    const hits = code.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g);
    if (!hits) return;
    counts.set(file, (counts.get(file) ?? 0) + hits.length);

    if (ALWAYS_DARK.has(file)) { usedExemptions.add(file); return; }
    // Rule A only reads hex, because a token value is hex; `rgba()` never equals one.
    for (const hit of hits.filter((h) => h.startsWith('#'))) {
      const key = normHex(hit);
      if (!tokenValues.has(key)) continue;
      if (key === '#ffffff' || key === '#000000') continue;
      duplicated.push(`${file}:${i + 1}  ${hit} 就是 ${tokenValues.get(key).join(' / ')} 的取值`);
    }
  });
}

for (const file of ALWAYS_DARK.keys()) {
  if (!usedExemptions.has(file)) {
    duplicated.push(`允许清单里的 "${file}" 已经不再包含颜色字面量 —— 请删掉这一条`);
  }
}

console.log('\n=== 颜色字面量：是否只是把 token 抄了一遍 ===');
check(
  `没有字面量等于某个 token 的取值（${MODULES.length} 个 module，对照 ${tokenValues.size} 个 token 取值）`,
  duplicated.length === 0,
  duplicated.slice(0, 40).join('\n'),
);

console.log('\n=== 颜色字面量：按文件计数（棘轮）===');
const rows = [...new Set([...counts.keys(), ...Object.keys(BASELINE)])].sort();
const over = [];
for (const file of rows) {
  const now = counts.get(file) ?? 0;
  const was = BASELINE[file] ?? 0;
  const mark = now > was ? `${RED}+${now - was}${RESET}` : now < was ? `${GREEN}-${was - now}${RESET}` : '';
  console.log(`  ${file.padEnd(30)} ${String(now).padStart(3)} ${DIM}（基线 ${was}）${RESET} ${mark}`);
  if (now > was) over.push(`${file} 从 ${was} 涨到 ${now}（多出 ${now - was} 处）`);
}
const total = [...counts.values()].reduce((a, b) => a + b, 0);
const baseTotal = Object.values(BASELINE).reduce((a, b) => a + b, 0);
console.log(`  ${'合计'.padEnd(30)} ${String(total).padStart(3)} ${DIM}（基线 ${baseTotal}）${RESET}`);

check(
  `字面量没有增加（${total} ≤ ${baseTotal}）`,
  over.length === 0,
  over.length
    ? `${over.join('\n')}\n要加颜色就加 token（packages/ui/src/styles/global.css），不要在 module 里写字面量。\n如果这是有意为之，请像 Terminal.module.css 那样写明理由并进允许清单。`
    : '',
);

if (total < baseTotal) {
  console.log(`\n  ${DIM}现在比基线少了 ${baseTotal - total} 处 —— 把上面的数字抄进 scripts/token-check.mjs 的 BASELINE，棘轮就锁紧了。${RESET}`);
}

if (process.argv.includes('--list')) {
  console.log('\n=== BASELINE（可直接粘贴）===');
  console.log('const BASELINE = {');
  for (const file of rows) if ((counts.get(file) ?? 0) > 0) console.log(`  '${file}': ${counts.get(file)},`);
  console.log('};');
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
