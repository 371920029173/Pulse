/**
 * Control styling check.
 *
 * Two rules that keep the button system coherent, both learned from bugs this
 * codebase actually had:
 *
 *   1. A control with a fill must have a hover state. Converting bordered buttons
 *      to filled ones removed the border, which in some rules was the ONLY thing
 *      that changed on hover — leaving a button that looked inert.
 *
 *   2. No rule may declare `background` twice. A conversion script inserted a fill
 *      into rules that already had a background, and because the later declaration
 *      wins it silently overrode the intended colour. Nothing about the rendering
 *      looks wrong, which is exactly why it needs a check.
 *
 * Rules that are containers or non-interactive chips are excluded by name, because
 * a segmented-control track legitimately has a fill and no hover of its own.
 *
 *   node scripts/control-style-check.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(resolve(HERE, '..'), 'packages', 'ui', 'src', 'styles');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
  }
};

/**
 * Is a class name reachable from the source?
 *
 * Three ways a class can be applied, and all three have to be recognised or the
 * report fills with noise:
 *   1. `styles.foo`                     — the common case
 *   2. `styles['foo']` / `styles["foo"]` — a lookup
 *   3. `styles['foo_' + x]`             — a computed suffix, e.g. `step_done`
 *
 * The third is why a naive search reports dozens of false positives: `step_done`
 * is never written literally, only assembled from `'step_'` and a status.
 *
 * `fromLibrary` marks classes produced by a dependency rather than by us —
 * highlight.js emits `hljs-*` at runtime, so nothing in our source names them.
 */
function isClassUsed(cls, sources, fromLibrary) {
  if (fromLibrary) {
    // A vendored grammar's class names are the library's business, not ours.
    return true;
  }
  if (new RegExp(`styles\\.${cls}\\b`).test(sources)) return true;
  if (new RegExp(`styles\\[[^\\]]*${cls}`).test(sources)) return true;
  if (new RegExp(`['"\`]${cls}['"\`]`).test(sources)) return true;

  /*
   * 4. A *global* class written inside a className string — the case the quoted form
   *    above cannot see.
   *
   *    `className="she-btn she-btn--chip"` has a space after `she-btn`, not a quote, so
   *    the pattern above never matches and five variants that are live in four
   *    components were being reported dead — five units of the baseline below were
   *    fictional, and the ratchet is only as honest as that number.
   *
   *    Matching the name as a whole token can only ever mark something *used*, never
   *    unused, so the failure mode is a dead global class slipping past the count. That
   *    is the safe direction: the count still cannot go up.
   */
  const token = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|["'\`\\s])${token}(?=["'\`\\s]|$)`, 'm').test(sources)) return true;

  // Computed suffix, in either of the two ways it is written:
  //   styles['step_' + status]      -> quote, prefix, then concatenation
  //   styles[`hopBadge_${kind}`]    -> backtick template, prefix then interpolation
  // Splitting on the last underscore recovers the prefix in both cases.
  const cut = cls.lastIndexOf('_');
  if (cut > 0) {
    const prefix = cls.slice(0, cut + 1);
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Quoted prefix followed by a concatenation, or a template literal whose
    // interpolation starts right after the prefix.
    if (new RegExp(`styles\\[[^\\]]*['"\`]${escaped}['"\`]?\\s*(\\+|\\$)`).test(sources)) return true;
    if (new RegExp(`styles\\[[^\\]]*['"\`]${escaped}\\$\\{`).test(sources)) return true;
  }
  return false;
}
/**
 * Selectors that legitimately carry a fill without being interactive, so they need
 * no hover of their own:
 *   - segmented-control TRACKS (their children are the controls)
 *   - status chips that only display state
 *   - the shared button classes, whose hover lives on a separate selector
 */
/**
 * Selectors that carry a control fill but are not controls.
 *
 * The check can only see CSS, so "is this interactive" is inferred from the selector. These
 * are the shapes where that inference is wrong, with the reason:
 *
 *   - `code` / `.path`: read-only display of a path or an identifier. The fill separates it
 *     from surrounding prose; there is nothing to click.
 *   - tabs/segmented/track/badge/chip: containers or labels whose *children* are the
 *     controls, so the hover lives on the child.
 *   - `.she-btn` / `.she-bg` / overlays: defined globally, where the hover is.
 */
const NON_INTERACTIVE = [
  /\.tabs$/, /\.segmented$/, /\.track$/,
  /peerChip/, /memberChip/, /badge/i, /pill$/,
  /^\.she-btn/, /\.she-bg/, /\.overlay$/, /\.scrim/,
  / code$/, /\.path$/,
];

/*
 * Display-only tags that sit inside a run of text: a file chip in a message, a tool name,
 * a permission label, a segment of a grouped path. These are `<span>`s in a paragraph,
 * and `height` on a non-replaced inline element is ignored — the line they sit in sizes
 * them, so vertical padding is genuinely the only lever and check 6 must not demand a
 * height. They are still audited for radius and hover above, where matching the text
 * around them is exactly the point.
 *
 * Named explicitly rather than inferred: whether `height` applies depends on the element
 * the class lands on, which is not visible from the stylesheet.
 */
const INLINE_TAG = /(FileChip|toolCallChip|permChip|groupPathSegment)$/;

/*
 * What counts as a control for the geometry checks.
 *
 * Kept at module scope because more than one check needs the same notion of "control" —
 * when each section carried its own copy they drifted apart, and a rule could be
 * audited by one and invisible to the next.
 */
const BUTTONISH = /btn|Btn|button|chip|Chip|tab$|Tab$|action|Action|refresh|timeline|undo|focus|seg|icon/i;

const files = readdirSync(STYLES).filter((n) => n.endsWith('.css'));
const all = new Map(files.map((f) => [f, readFileSync(join(STYLES, f), 'utf8')]));

// ─── 1. Duplicate background declarations ───
console.log('\n=== 重复的 background 声明 ===');
{
  const offenders = [];
  for (const [file, text] of all) {
    const lines = text.split(/\r?\n/);
    let selector = '';
    let backgrounds = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const m = /^([.#][\w-]+[^{]*)\{\s*$/.exec(t);
      if (m) { selector = m[1].trim(); backgrounds = []; continue; }
      if (/^background(-color)?:/.test(t)) backgrounds.push({ line: i + 1, text: t });
      if (t.startsWith('}')) {
        if (backgrounds.length > 1) {
          offenders.push(`${file} ${selector}: 第 ${backgrounds.map((b) => b.line).join(', ')} 行各有一条`);
        }
        backgrounds = [];
      }
    }
  }
  check(
    `没有规则重复声明 background（${offenders.length} 处）`,
    offenders.length === 0,
    offenders.slice(0, 6).join('\n        '),
  );
}

// ─── 2. Filled controls have a hover state ───
console.log('\n=== 填充控件是否有 hover 反馈 ===');
{
  const offenders = [];
  for (const [file, text] of all) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*background:\s*var\(--fill-control\)/.test(lines[i])) continue;

      // Locate the owning selector.
      let selector = null;
      for (let j = i; j >= 0 && j > i - 30; j--) {
        const m = /^([.#][\w-]+[^{]*)\{\s*$/.exec(lines[j].trim());
        if (m) { selector = m[1].trim().replace(/\s+/g, ' '); break; }
      }
      if (!selector) continue;
      if (selector.includes(':hover') || selector.includes(':active') || selector.includes(':focus')) continue;
      if (NON_INTERACTIVE.some((re) => re.test(selector))) continue;

      const base = selector.split(/[\s,>]+/).pop();
      const hasHover = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:hover`).test(text);
      if (!hasHover) {
        offenders.push(`${file}:${i + 1}  ${selector}`);
      }
    }
  }
  check(
    `填充控件都有 :hover（${offenders.length} 处缺失）`,
    offenders.length === 0,
    offenders.slice(0, 8).join('\n        '),
  );
}

// ─── 3. Buttons no longer use hairline borders ───
console.log('\n=== 按钮是否还在用描边 ===');
{
  const offenders = [];
  for (const [file, text] of all) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/border:\s*1px solid var\(--border\)/.test(lines[i])) continue;

      let selector = null;
      for (let j = i; j >= 0 && j > i - 30; j--) {
        const m = /^([.#][\w-]+[^{]*)\{\s*$/.exec(lines[j].trim());
        if (m) { selector = m[1].trim().replace(/\s+/g, ' '); break; }
      }
      if (!selector) continue;
      // Containers, cards and inputs legitimately keep a border; only controls
      // should be filled instead.
      const isControl = /btn|Btn|button|chip|Chip|action|Action|tab\b|Tab\b|toggle/i.test(selector);
      const isContainer = /panel|card|box|container|wrap|bar\b|list|area|body|field|input|select|textarea/i.test(selector);
      if (isControl && !isContainer) {
        offenders.push(`${file}:${i + 1}  ${selector}`);
      }
    }
  }
  check(
    `按钮不再使用 1px 描边（${offenders.length} 处）`,
    offenders.length === 0,
    offenders.slice(0, 8).join('\n        '),
  );
}

// ─── 3b. Corner radii come from the token scale ───
//
// The symptom this was written for: three controls inside one card used 9px, 11px and
// 13px corners, and two pills in the same composer row used 999px and 9999px. None of
// that renders as broken — it renders as *unresolved*, which is what "the buttons look
// off" turned out to mean.
//
// Radii need their own check because they are the cheapest thing in CSS to drift: a
// radius has no effect on layout, so unlike a width or a height nothing downstream
// complains when one is invented. Twenty control rules had invented one.
console.log('\n=== 圆角是否来自 token 刻度 ===');
{
  // Every value that exists as a token (see --radius-* in global.css), plus the number
  // each resolves to. A rule may use either spelling; anything else is a one-off.
  const SCALE = new Set([0, 4, 6, 10, 14, 20, 999, 9999]);
  const offenders = [];
  for (const [file, text] of all) {
    const lines = text.split(/\r?\n/);
    let selector = '';
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const m = /^([.#][\w-]+[^{]*)\{\s*$/.exec(t);
      if (m) { selector = m[1].trim(); continue; }
      if (!/^border-radius:/.test(t)) continue;
      if (t.includes('var(--radius')) continue;
      // Percentages are relative to the element, so they are not part of the px scale.
      if (t.includes('%')) continue;
      const nums = [...t.matchAll(/(\d+(?:\.\d+)?)px/g)].map((x) => Number(x[1]));
      const stray = nums.filter((n) => !SCALE.has(n));
      if (stray.length && BUTTONISH.test(selector) && !NON_INTERACTIVE.some((re) => re.test(selector))) {
        offenders.push(`${file}:${i + 1}  ${selector}  →  ${t}`);
      }
    }
  }
  check(
    `圆角都在 token 刻度上（${offenders.length} 处越界）`,
    offenders.length === 0,
    offenders.slice(0, 8).join('\n        '),
  );
}

// ─── 4. Dead CSS (reported and ratcheted, not deleted automatically) ───
//
// Worth measuring because it is how a second styling system starts: a class stops
// being used, the rule stays, and a later change edits the dead rule under the
// impression it matters. Removal is deliberately left to a human — a class applied
// through `styles['prefix' + x]` cannot be proven dead by static search, and
// guessing wrong blanks part of the UI.
console.log('\n=== 已废弃的 CSS 类（棘轮）===');
{
  const tsx = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (/\.tsx?$/.test(entry.name)) tsx.push(p);
    }
  };
  walk(join(resolve(HERE, '..'), 'packages', 'ui', 'src'));
  const sources = tsx.map((f) => readFileSync(f, 'utf8')).join('\n');

  const dead = [];
  const seen = new Set();
  for (const [file, text] of all) {
    // Classes emitted by a dependency at runtime (highlight.js) are not ours to
    // audit; nothing in our source would name them.
    const fromLibrary = file.startsWith('highlight');
    const defined = [...text.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]);
    for (const cls of defined) {
      // A class can appear in several rule blocks (base + variant); count it once.
      const key = `${file}::${cls}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isClassUsed(cls, sources, fromLibrary)) continue;
      dead.push(`${file}  .${cls}`);
    }
  }

  // Tightened to the count at the time of the cleanup, so the ratchet actually
  // holds rather than leaving 47 units of slack for new dead rules to hide in.
  const BASELINE = 73;
  console.log(`  当前废弃类数量：${dead.length}（基线 ${BASELINE}）`);

  if (process.argv.includes('--update-dead')) {
    console.log('  把当前数量写为基线：更新脚本里的 BASELINE 常量。');
  }
  if (process.argv.includes('--list-dead')) {
    for (const d of dead) console.log(`    ${d}`);
  } else if (dead.length) {
    console.log('    前 8 个：');
    for (const d of dead.slice(0, 8)) console.log(`      ${d}`);
    console.log('    全部：node scripts/control-style-check.mjs --list-dead');
  }

  check(
    `废弃类没有增加（${dead.length} ≤ ${BASELINE}）`,
    dead.length <= BASELINE,
    dead.length > BASELINE
      ? `新增了 ${dead.length - BASELINE} 个未使用的类。要么用上，要么删掉。`
      : undefined,
  );
}

// ─── 5. Control heights are consistent ───
//
// The single most visible inconsistency in this UI was control height: the same
// bar contained 19px text buttons, 20px chips and 28px buttons, which reads as
// unresolved rather than deliberate. Apple's bars use two sizes at most — regular
// and small — so the check allows exactly that.
console.log('\n=== 控件高度是否统一 ===');
{
  const heights = new Map(); // height -> [selectors]

  for (const [file, text] of all) {
    const lines = text.split(/\r?\n/);
    let selector = '';
    let depth = 0;
    let ruleStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (depth === 0 && t.includes('{')) {
        ruleStart = i;
        selector = t.replace(/\{.*$/, '').trim();
      }
      depth += (t.match(/\{/g) ?? []).length;
      depth -= (t.match(/\}/g) ?? []).length;

      const m = /^height:\s*(\d+)px;/.exec(t);
      // Only real controls. A decorative segment or a plain icon is sized to its
      // context, not to the control grid, so including them would produce noise.
      const isIcon = /\.icon$|\.icon[A-Z]|Segment$|Arrow$|^\.spin/.test(selector);
      if (m && depth > 0 && BUTTONISH.test(selector) && !isIcon) {
        const h = Number(m[1]);
        if (!heights.has(h)) heights.set(h, []);
        heights.get(h).push(`${file} ${selector}`);
      }
      if (depth === 0 && t.endsWith('}')) selector = '';
      void ruleStart;
    }
  }

  const sizes = [...heights.keys()].sort((a, b) => a - b);
  console.log(`  发现的控件高度: ${sizes.map((h) => `${h}px(${heights.get(h).length})`).join(', ')}`);

  /*
   * The allowed set, which is now the token ladder in global.css (--control-h-*). Keep
   * the two in sync: the whole point of naming the sizes was that a control picks a step
   * rather than inventing one.
   *
   *   34  the composer's send button, deliberately round and larger
   *   32  page-level actions and pickable rows
   *   28  the default control
   *   26  pills and chips
   *   24  small controls and icon buttons
   *   22  compact strips (status bar, list-row actions)
   *   18  tags inside a line of text
   *   16  inline affordances sized to their parent (the × on a file-reference chip)
   */
  const ALLOWED = new Set([34, 32, 28, 26, 24, 22, 18, 16]);
  const stray = sizes.filter((h) => !ALLOWED.has(h));
  check(
    `控件高度都在允许集合内 (${sizes.join(', ')})`,
    stray.length === 0,
    stray.length
      ? `这些高度是一次性的，会和旁边控件对不齐: ${stray.map((h) => `${h}px -> ${heights.get(h).join(' / ')}`).join('; ')}`
      : undefined,
  );
}

// ─── 6. Controls name a height instead of deriving it from padding ───
//
// This is the hole that let the check above stay green through eleven control heights.
// It only reads `height:`, and most controls were sized by vertical padding — so the
// real geometry was invisible to it. Two chips in one composer row measured 25px and
// 26px and nothing objected, because neither declared a height at all.
//
// Rewriting every control in one pass is how a refactor breaks a layout it cannot see,
// so this is a ratchet like the dead-CSS count: the number may fall, never rise.
console.log('\n=== 靠 padding 撑高度的控件（棘轮）===');
{
  const offenders = [];
  for (const [file, text] of all) {
    const lines = text.split(/\r?\n/);
    let selector = '';
    let depth = 0;
    let hasHeight = false;
    let vpad = null;
    let startLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (depth === 0 && t.includes('{')) {
        selector = t.replace(/\{.*$/, '').trim();
        hasHeight = false;
        vpad = null;
        startLine = i + 1;
      }
      const pad = /^padding:\s*(\d+(?:\.\d+)?)px/.exec(t);
      if (pad) vpad = Number(pad[1]);
      if (/^height:/.test(t)) hasHeight = true;
      depth += (t.match(/\{/g) ?? []).length;
      depth -= (t.match(/\}/g) ?? []).length;
      if (depth === 0 && t.endsWith('}')) {
        const isVariant = /:hover|:active|:focus|:disabled|::|:not|\[/.test(selector);
        if (
          !isVariant &&
          BUTTONISH.test(selector) &&
          !NON_INTERACTIVE.some((re) => re.test(selector)) &&
          !INLINE_TAG.test(selector) &&
          vpad &&
          !hasHeight
        ) {
          offenders.push(`${file}:${startLine}  ${selector}  (padding-y ${vpad}px)`);
        }
        selector = '';
      }
    }
  }
  // Set from the count measured when the control ladder was introduced (2026-10-01).
  // Lower it as controls are converted; never raise it.
  const BASELINE = 0;
  console.log(`  当前数量：${offenders.length}（基线 ${BASELINE}）`);
  if (offenders.length) {
    console.log('    前 8 个：');
    for (const o of offenders.slice(0, 8)) console.log(`      ${o}`);
  }
  check(
    `控件自己声明高度、不靠 padding 撑（${offenders.length} ≤ ${BASELINE}）`,
    offenders.length <= BASELINE,
    offenders.length > BASELINE ? `新增了 ${offenders.length - BASELINE} 个。给它们一个 --control-h-* 档位。` : undefined,
  );
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
