/**
 * Accessibility check (structural).
 *
 * Not a full audit: no contrast measurement, no screen-reader run. These are the
 * failures that are structural, checkable by reading the source, and that this
 * codebase actually had:
 *
 *   1. A control built from a `<div>` with `onClick`. It cannot be reached with Tab,
 *      is not announced as interactive, and cannot be operated with Enter or Space.
 *      It looks identical, which is why it survives review.
 *   2. A dialog with no keyboard dismissal. Clicking outside works; a keyboard user
 *      who opens Settings has no way out.
 *   3. An icon-only button with no accessible name, which announces as "button" with
 *      no indication of what it does.
 *
 * Backdrops and panel wrappers are excluded: a backdrop click is a convenience for
 * mouse users, and requires a keyboard alternative rather than removal.
 *
 *   node scripts/a11y-check.mjs
 *   node scripts/a11y-check.mjs --list
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const COMPONENTS = join(ROOT, 'packages', 'ui', 'src', 'components');
const STYLES = join(ROOT, 'packages', 'ui', 'src', 'styles');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 8000)}`);
  }
};

const files = readdirSync(COMPONENTS).filter((f) => f.endsWith('.tsx')).sort();
const sources = new Map(files.map((f) => [f, readFileSync(join(COMPONENTS, f), 'utf8')]));

/** Every line of every component, with its file name. */
const allLines = [];
for (const [file, text] of sources) {
  text.split(/\r?\n/).forEach((line, i) => allLines.push({ file, line: i + 1, text: line }));
}

console.log('\n无障碍检查（静态）\n');

// ─── 1. No clickable divs, except backdrops / panel wrappers ───
console.log('=== 可点击元素是否为真实控件 ===');
{
  /*
   * A backdrop or a panel's stopPropagation wrapper is not a control: one dismisses
   * on an outside click (which has a keyboard path via Escape), the other exists only
   * to swallow clicks. Both are handled by rules 2 and 3.
   */
  const ALLOWED = /backdrop|overlay|sheet|modal|panel|scrim/i;

  const offenders = allLines.filter(({ text }) => {
    if (!/<div[^>]*\bonClick=/.test(text)) return false;
    return !ALLOWED.test(text);
  });

  check(
    `没有"可点击的 div"（${offenders.length} 处，遮罩与面板包裹不计）`,
    offenders.length === 0,
    offenders.map((o) => `${o.file}:${o.line}  ${o.text.trim().slice(0, 90)}`).join('\n        '),
  );
}

// ─── 2. Every dialog can be dismissed from the keyboard ───
console.log('\n=== 弹窗是否有键盘关闭路径 ===');
{
  /*
   * A component counts as a dialog when it renders a backdrop that closes on click.
   * Each such component must either use the Escape hook or handle Escape itself.
   */
  const dialogs = [];
  for (const [file, text] of sources) {
    const hasDismissingBackdrop = /className=\{styles\.(backdrop|overlay)\}[^>]*onClick/.test(text);
    if (!hasDismissingBackdrop) continue;
    const hasEscape = /useEscapeToClose|['"]Escape['"]/.test(text);
    dialogs.push({ file, hasEscape });
  }

  const missing = dialogs.filter((d) => !d.hasEscape);
  check(
    `全部 ${dialogs.length} 个弹窗都有 Escape 处理（${missing.length} 个缺失）`,
    missing.length === 0,
    missing.map((d) => d.file).join(', '),
  );
}

// ─── 3. Icon-only buttons have an accessible name ───
console.log('\n=== 图标按钮是否有可读名称 ===');
{
  /*
   * A button whose content is only elements (an svg, a glyph span) and which has
   * neither `title` nor `aria-label` announces as just "button".
   *
   * The whole element is extracted rather than a fixed line window: JSX content
   * routinely spans more lines than a window can guess, and a short window reports
   * buttons that DO have text — noise that gets the check ignored.
   */
  const offenders = [];
  for (const [file, text] of sources) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/<button\b/.test(lines[i])) continue;

      // The opening tag may span lines; collect until it closes.
      let tag = '';
      let j = i;
      for (; j < Math.min(i + 20, lines.length); j++) {
        tag += `${lines[j]}\n`;
        if (/>/.test(lines[j])) break;
      }
      if (!/^[\s\S]*<button/.test(tag)) continue;
      const selfClosing = /\/>\s*$/.test(tag.trim()) || /\/>$/.test(lines[j].trim());
      const hasName = /\b(title|aria-label|aria-labelledby|aria-describedby)=/.test(tag);
      if (hasName) continue;
      if (selfClosing) {
        offenders.push(`${file}:${i + 1}  ${lines[i].trim().slice(0, 80)}`);
        continue;
      }

      // Collect the element body up to its matching `</button>`.
      //
      // Careful with the single-line case: `<button ...><svg /></button>` puts the
      // body on the SAME line as the opening tag, so the remainder of that line must
      // be part of the body. Skipping it made the check miss exactly the case it
      // exists to find — a bare icon button — which a negative test caught.
      let body = '';
      let depth = 0;
      let started = false;
      for (let k = i; k < Math.min(i + 80, lines.length); k++) {
        const l = lines[k];
        if (!started) {
          const openEnd = l.indexOf('>');
          if (openEnd < 0) continue;
          started = true;
          body += `${l.slice(openEnd + 1)}\n`;
        } else {
          body += `${l}\n`;
        }
        depth += (l.match(/<button\b/g) ?? []).length;
        if (/<\/button>/.test(l)) {
          if (depth <= 1) break;
          depth--;
        }
      }

      // Visible text = everything that is not a tag or a JSX expression.
      const textOnly = body
        .replace(/<\/?[^>]+>/g, '')
        .replace(/\{[\s\S]*?\}/g, '')
        .trim();
      /*
       * "No text" means no LETTERS OR DIGITS, not an empty string.
       *
       * Trailing syntax survives the strip — `<button><svg /></button>;` leaves the
       * statement's semicolon behind, so a length check saw one character and did not
       * flag the button. Requiring an alphanumeric character is what actually
       * distinguishes `<span>×</span>` (needs a label) from `<span>Save</span>`.
       */
      const meaningful = textOnly.replace(/[^\p{L}\p{N}]/gu, '');
      // An expression like `{t('保存')}` or `{label}` is also a name.
      const hasExpression = /\{[^}]*\}/.test(body);

      if (meaningful.length === 0 && !hasExpression) {
        offenders.push(`${file}:${i + 1}  ${lines[i].trim().slice(0, 80)}`);
      }
    }
  }

  check(
    `图标按钮都有 title 或 aria-label（${offenders.length} 处缺失）`,
    offenders.length === 0,
    offenders.slice(0, 12).join('\n        '),
  );
}

// ─── 4. Interactive elements are not hidden from assistive tech ───
console.log('\n=== 装饰性元素是否标记为隐藏 ===');
{
  // `aria-hidden` on something focusable is worse than no attribute: it creates a
  // focus stop that announces nothing.
  const offenders = [];
  for (const { file, line, text } of allLines) {
    if (!/aria-hidden/.test(text)) continue;
    if (/<(button|input|select|textarea|a\s)/.test(text)) {
      offenders.push(`${file}:${line}  ${text.trim().slice(0, 80)}`);
    }
  }
  check(
    `没有把可聚焦元素标为 aria-hidden（${offenders.length} 处）`,
    offenders.length === 0,
    offenders.join('\n        '),
  );
}

// ─── 5. Colour contrast: measured, not eyeballed ───
/*
 * Structure can be right and the app still unusable: a hint label at 2.7:1 is
 * decoration, not text. This section computes WCAG 2.1 contrast from the theme
 * tokens themselves, so the answer is a number rather than an opinion.
 *
 * What is checked, and why exactly this:
 *
 *   - every text token against every surface token, in both themes
 *   - 4.5:1 on the reading surfaces (bg-primary/secondary), the AA body-text bar
 *   - 3.0:1 on the tinted surfaces (bg-tertiary/hover), the AA large-text/non-text
 *     bar. A hovered row is a transient restatement of the row below it, and
 *     forcing 4.5 there would push the whole palette to one flat grey.
 *   - text drawn on a filled control (a button or badge that sets an opaque
 *     saturated background) must use the matching `--on-*` token
 *
 * What is NOT checked, and cannot be without a browser:
 *
 *   - translucent tints (`color-mix(..., transparent)`) — they composite over
 *     whatever ancestor ends up behind them, which is not knowable from the file
 *   - gradients, wallpaper/video backgrounds, and `opacity` applied to text
 *   - anything the user's own custom CSS overrides
 *
 * Those are listed so "all green" is not read as "everything readable".
 */
console.log('\n=== 颜色对比度（按 token 实测，不是肉眼判断）===');
{
  const globalCss = readFileSync(join(STYLES, 'global.css'), 'utf8');

  const toRgb = (value) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(value).trim());
    if (!m) return null;
    return [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16));
  };
  const relativeLuminance = ([r, g, b]) => {
    const channel = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  /*
   * Merge every block with an exactly-matching selector, in file order, so the last
   * declaration wins — the same thing the browser does. Reading only the first
   * `:root` block gave a wrong answer here, because a later block re-declares the
   * background tokens.
   */
  const collectTokens = (selector) => {
    const out = {};
    const rule = /(^|\n)([^\n{}]*)\{([\s\S]*?)\}/g;
    let m;
    while ((m = rule.exec(globalCss))) {
      if (m[2].trim() !== selector) continue;
      for (const d of m[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    }
    return out;
  };

  const themes = { 深色: collectTokens(':root'), 浅色: collectTokens('[data-theme="light"]') };
  const TEXT_TOKENS = ['--text-primary', '--text-secondary', '--text-tertiary', '--text-link', '--accent', '--success', '--warning', '--danger', '--info'];
  const READING_SURFACES = ['--bg-primary', '--bg-secondary'];
  const TINTED_SURFACES = ['--bg-tertiary', '--bg-hover'];

  const problems = [];
  for (const [themeName, tokens] of Object.entries(themes)) {
    for (const textToken of TEXT_TOKENS) {
      const fg = toRgb(tokens[textToken]);
      if (!fg) {
        problems.push(`${themeName}: ${textToken} 不是可解析的 #rrggbb（实际 "${tokens[textToken]}"）`);
        continue;
      }
      for (const [surfaces, threshold] of [[READING_SURFACES, 4.5], [TINTED_SURFACES, 3.0]]) {
        for (const surfaceToken of surfaces) {
          const bg = toRgb(tokens[surfaceToken]);
          if (!bg) {
            problems.push(`${themeName}: ${surfaceToken} 不是可解析的 #rrggbb（实际 "${tokens[surfaceToken]}"）`);
            continue;
          }
          const ratio = contrast(fg, bg);
          if (ratio + 1e-9 < threshold) {
            problems.push(`${themeName}: ${textToken} 在 ${surfaceToken} 上只有 ${ratio.toFixed(2)}:1（要求 ${threshold}）`);
          }
        }
      }
    }
  }

  check(
    `文字 token × 表面 token 全部达标（${Object.keys(themes).length} 个主题 × ${TEXT_TOKENS.length} 个文字 × ${READING_SURFACES.length + TINTED_SURFACES.length} 个表面）`,
    problems.length === 0,
    problems.join('\n        '),
  );

  /*
   * Text on a filled control.
   *
   * The dark theme's accent is a light blue, so the literal `color: #fff` that
   * looked fine in the light theme measured 2.6:1 there — every primary button.
   * The fix is a token that flips with the theme, and this rule is what stops the
   * literal from creeping back.
   *
   * Decorative fills (a status dot, a progress bar, a slider thumb) legitimately
   * carry no text; they are listed by `file selector` with the reason. A stale
   * entry fails too — an allowlist nobody prunes becomes a place to hide things.
   */
  const DECORATIVE_FILLS = new Set([
    'App.module.css .resizeHandleActive::after',
    'App.module.css .resizeHandleRow:active::after',
    'App.module.css .traceFabDot',
    'Chat.module.css .streamingDot',
    'Chat.module.css .thinkTickActive',
    'Chat.module.css .thinkRange::-webkit-slider-thumb',
    'Chat.module.css .thinkRange::-moz-range-thumb',
    'Dock.module.css .dotOn',
    'Dock.module.css .dotBad',
    'McpPanel.module.css .dotOk',
    'McpPanel.module.css .dotBad',
    'PulseTracePanel.module.css .headerDot',
    'SessionHistory.module.css .dot',
    'Sidebar.module.css .sessionDotActive',
  ]);
  const SATURATED = ['--accent', '--success', '--warning', '--danger', '--info'];
  const FILLED = /^var\((--[\w-]+)\)$/;

  const fillProblems = [];
  const usedAllowlist = new Set();
  const cssFiles = readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort();

  for (const file of cssFiles) {
    const text = readFileSync(join(STYLES, file), 'utf8');
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2];
      const bgDecl = /(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+);/.exec(body);
      if (!bgDecl) continue;
      const fill = FILLED.exec(bgDecl[1].trim());
      if (!fill || !SATURATED.includes(fill[1])) continue;

      const selector = rule[1].split('\n').pop().trim();
      const key = `${file} ${selector}`;
      if (DECORATIVE_FILLS.has(key)) { usedAllowlist.add(key); continue; }

      const colorDecl = /(?:^|[;\s])color\s*:\s*([^;]+);/.exec(body);
      if (!colorDecl) {
        fillProblems.push(`${file} ${selector}: background ${fill[1]} 没有写明文字色（会继承外层，且两个主题下必然有一个不达标）`);
        continue;
      }
      const value = colorDecl[1].trim();
      const expected = `var(--on-${fill[1].slice(2)})`;
      if (value !== expected) {
        fillProblems.push(`${file} ${selector}: ${fill[1]} 上的文字是 "${value}"，应为 "${expected}"`);
      }
    }
  }
  for (const entry of DECORATIVE_FILLS) {
    if (!usedAllowlist.has(entry)) fillProblems.push(`允许清单里的 "${entry}" 已不存在或不再是纯色填充 —— 请删掉这一条`);
  }

  check(
    `填充控件上的文字用 --on-* token（${usedAllowlist.size} 处纯装饰已豁免）`,
    fillProblems.length === 0,
    fillProblems.slice(0, 80).join('\n        '),
  );

  // The `--on-*` tokens must themselves be readable on their fill.
  const onProblems = [];
  for (const [themeName, tokens] of Object.entries(themes)) {
    for (const token of SATURATED) {
      const onToken = `--on-${token.slice(2)}`;
      const fg = toRgb(tokens[onToken]);
      const bg = toRgb(tokens[token]);
      if (!fg || !bg) {
        onProblems.push(`${themeName}: ${onToken} 或 ${token} 缺失/不是 #rrggbb`);
        continue;
      }
      const ratio = contrast(fg, bg);
      if (ratio + 1e-9 < 4.5) {
        onProblems.push(`${themeName}: ${onToken} 在 ${token} 上只有 ${ratio.toFixed(2)}:1（要求 4.5）`);
      }
    }
  }
  check(`--on-* 在自己的填充色上达标（${Object.keys(themes).length} 个主题 × ${SATURATED.length} 个填充）`, onProblems.length === 0, onProblems.join('\n        '));
}

// ─── 6. Keyboard: focus order and a visible focus ring ───
console.log('\n=== 键盘可达性（焦点顺序与焦点环）===');
{
  /*
   * A positive tabindex reorders the whole document's tab sequence by a number that
   * is impossible to keep consistent as the tree changes; a control that needs to be
   * reached earlier belongs earlier in the DOM. It is the single most reliable way to
   * break tab order, and it takes one character to reintroduce.
   */
  const positiveTabIndex = [];
  for (const [file, text] of sources) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (/tabIndex=\{?["']?[1-9]/.test(line)) positiveTabIndex.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  check(`没有正数 tabIndex（${positiveTabIndex.length} 处）`, positiveTabIndex.length === 0, positiveTabIndex.join('\n        '));

  /*
   * The focus ring is one global sheet: `:focus { outline: none }` then a
   * `:focus-visible` rule that draws it. Both selectors have the same specificity,
   * so if the reset ever ends up AFTER the ring — a rule moved, a block appended —
   * the reset wins and the entire app silently loses keyboard focus indication.
   * Order is the whole mechanism, so order is what gets asserted.
   */
  const globalCss = readFileSync(join(STYLES, 'global.css'), 'utf8');
  const resetAt = globalCss.search(/:focus\s*\{[^}]*outline\s*:\s*(none|0)/);
  const ringAt = globalCss.search(/:focus-visible\s*\{[^}]*outline\s*:/);
  check('存在全局 :focus-visible 焦点环', ringAt >= 0);
  check(
    '焦点环写在 :focus{outline:none} 之后（同特异性，顺序决定谁生效）',
    resetAt >= 0 && ringAt > resetAt,
    resetAt < 0 ? '找不到 :focus { outline: none } 重置' : `重置在 ${resetAt}，焦点环在 ${ringAt}`,
  );

  if (process.argv.includes('--list')) {
    const withRing = [...sources].filter(([, t]) => /:focus-visible/.test(t)).length;
    console.log(`        额外：${withRing}/${sources.size} 个组件的 CSS 模块里另有 :focus-visible 覆盖`);
  }
}

if (process.argv.includes('--list')) {
  console.log('\n=== 全部组件清单 ===');
  for (const [file, text] of sources) {
    const buttons = (text.match(/<button/g) ?? []).length;
    const aria = (text.match(/aria-/g) ?? []).length;
    console.log(`  ${file.padEnd(28)} button ${String(buttons).padStart(3)}   aria-* ${String(aria).padStart(3)}`);
  }
}

console.log('\n未覆盖：屏幕阅读器实际朗读、焦点陷阱是否生效、缩放与 200% 下的重排、');
console.log('       半透明色块上的文字（合成结果取决于未知的祖先表面）、图片/视频背景上的文字。');
console.log('       这些需要真实浏览器与辅助技术，静态检查给不出结论。');
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
