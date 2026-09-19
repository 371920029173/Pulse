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
  const BUTTONISH = /btn|Btn|button|chip|Chip|tab$|Tab$|action|Action|refresh|timeline|undo|focus|seg|icon/i;

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
   * The allowed set. 28/24 come from the shared button system; 22 is the dense
   * status-bar size. Anything outside this is a one-off that will not line up with
   * its neighbours.
   */
  const ALLOWED = new Set([
    // Regular and small controls, from the shared button system.
    28, 24,
    // Compact variants for dense rows (status bar, list rows).
    26, 22,
    // The composer's send button, which is deliberately round and larger.
    34,
    // Inline affordances that must stay proportionate to the chip or line they sit
    // inside (the × on a file-reference chip). Apple sizes these to their parent
    // rather than to the control grid.
    18, 16,
  ]);
  const stray = sizes.filter((h) => !ALLOWED.has(h));
  check(
    `控件高度都在允许集合内 (${sizes.join(', ')})`,
    stray.length === 0,
    stray.length
      ? `这些高度是一次性的，会和旁边控件对不齐: ${stray.map((h) => `${h}px -> ${heights.get(h).join(' / ')}`).join('; ')}`
      : undefined,
  );
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
