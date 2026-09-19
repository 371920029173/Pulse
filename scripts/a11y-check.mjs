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

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 600)}`);
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

if (process.argv.includes('--list')) {
  console.log('\n=== 全部组件清单 ===');
  for (const [file, text] of sources) {
    const buttons = (text.match(/<button/g) ?? []).length;
    const aria = (text.match(/aria-/g) ?? []).length;
    console.log(`  ${file.padEnd(28)} button ${String(buttons).padStart(3)}   aria-* ${String(aria).padStart(3)}`);
  }
}

console.log('\n未覆盖：颜色对比度、屏幕阅读器实际朗读、焦点顺序、缩放。');
console.log('     这些需要真实浏览器与辅助技术，静态检查给不出结论。');
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
