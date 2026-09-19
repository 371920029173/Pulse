/**
 * Vendor the webfonts locally.
 *
 *   node scripts/vendor-fonts.mjs            # fetch what is missing
 *   node scripts/vendor-fonts.mjs --force    # re-fetch everything
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 *
 * `index.html` linked Inter and JetBrains Mono from fonts.googleapis.com, so every single page
 * load made two requests to Google — one of which downloaded a font file. That is worth fixing
 * for three reasons, in increasing order of importance:
 *
 *   1. **It contradicts the app's own rule.** The custom-stylesheet validator refuses a remote
 *      `@import` with the message "这会泄露你这台机器在运行本应用". The app was doing exactly
 *      that, on every start, to a third party. A rule that applies only to the user is not a
 *      rule.
 *
 *   2. **Offline.** `font-display: swap` means a failed fetch degrades rather than breaks, but
 *      the typography silently changes — and this is a local-first desktop app that should not
 *      need the network to look like itself.
 *
 *   3. **It is load-bearing, not decorative.** Measured with `CSS.getPlatformFontsForNode`: on
 *      Windows 10 the UI's text really renders in `Inter-Bold`. `Segoe UI Variable` (first in
 *      the stack) only exists on Windows 11, and `-apple-system` / `SF Pro Text` only on macOS,
 *      so on Windows 10 the stack falls through to the webfont. Removing the link without
 *      vendoring would have changed how the app looks on the machine it is developed on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT KEEPS
 *
 * Only the `latin` and `latin-ext` subsets. Google's CSS also carries cyrillic, greek and
 * vietnamese for the same families; shipping those would multiply the file count for glyphs
 * this UI does not have copy for. CJK text is unaffected either way — Inter has no CJK glyphs,
 * so those characters already come from the system font.
 *
 * The generated `@font-face` rules preserve Google's `unicode-range`, so the browser still only
 * downloads the subset a page actually needs (now from this server instead of Google's).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both families are SIL Open Font License 1.1, which permits redistribution. Attribution is
 * written into the generated stylesheet.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const UI = join(ROOT, 'packages', 'ui');
const OUT_DIR = join(UI, 'public', 'fonts');
const OUT_CSS = join(UI, 'src', 'styles', 'fonts.css');

const FORCE = process.argv.includes('--force');

/**
 * The families and weights the UI actually uses.
 *
 * Kept in one place so the list is auditable: the font stacks in `global.css` name these, and a
 * family that appears here but nowhere else is dead weight in the repository.
 */
const FAMILIES = [
  { family: 'Inter', weights: [300, 400, 500, 600, 700] },
  { family: 'JetBrains Mono', weights: [400, 500] },
];

/** Subsets worth shipping; see the header. */
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

/*
 * A modern Chrome UA, because Google serves woff2 only to browsers that advertise support and
 * falls back to much larger ttf files otherwise.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

/**
 * Pull the `@font-face` blocks out of Google's CSS, each with the subset comment above it.
 *
 * The comment is how the subset is identified — it is not in the declaration itself — so the
 * split has to keep comment and block together.
 */
function parseFaces(css) {
  const faces = [];
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
  for (const m of css.matchAll(re)) {
    const [, subset, block] = m;
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? 400);
    const url = /url\((https:\/\/[^)]+\.woff2)\)/.exec(block)?.[1];
    const unicodeRange = /unicode-range:\s*([^;]+);/.exec(block)?.[1]?.trim();
    if (family && url) faces.push({ subset, family, weight, url, unicodeRange });
  }
  return faces;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const query = FAMILIES
    .map((f) => `family=${encodeURIComponent(f.family)}:wght@${f.weights.join(';')}`)
    .join('&');
  const cssUrl = `https://fonts.googleapis.com/css2?${query}&display=swap`;

  console.log(`  取 Google 的 CSS …`);
  const css = await fetchText(cssUrl);
  const all = parseFaces(css);
  console.log(`  解析出 ${all.length} 个 @font-face（全部子集）`);

  const wanted = all.filter((f) => KEEP_SUBSETS.has(f.subset));
  console.log(`  保留 ${wanted.length} 个（${[...KEEP_SUBSETS].join(' / ')}）`);

  /*
   * Group by URL, because one file can back several weights.
   *
   * Google serves a VARIABLE font as a single file whose `@font-face` rules differ only in
   * `font-weight` — Inter arrives as one 47 KB file covering 300–700, not five. Two consequences:
   *
   *   - the file name must not contain a weight. Naming it after whichever rule happened to be
   *     visited last produced `inter-700-latin.woff2` for a file that also serves weight 300,
   *     which is both misleading and dependent on iteration order.
   *   - emitting one rule per weight for the same file is redundant. One rule with a weight
   *     RANGE is what the file actually is.
   *
   * A static family (one file per weight) still works: each URL groups to a single weight,
   * and the range collapses to that number.
   */
  const byUrl = new Map();
  for (const face of wanted) {
    const entry = byUrl.get(face.url) ?? { url: face.url, family: face.family, subset: face.subset, weights: [] };
    entry.weights.push(face.weight);
    if (face.unicodeRange) entry.unicodeRange = face.unicodeRange;
    byUrl.set(face.url, entry);
  }

  const assets = [...byUrl.values()].map((e) => ({
    ...e,
    minWeight: Math.min(...e.weights),
    maxWeight: Math.max(...e.weights),
    name: `${slug(e.family)}-${e.subset}.woff2`,
  }));

  console.log(`  需要 ${assets.length} 个字体文件`);

  let fetched = 0;
  let skipped = 0;
  for (const asset of assets) {
    const dest = join(OUT_DIR, asset.name);
    if (!FORCE && existsSync(dest) && statSync(dest).size > 0) { skipped++; continue; }
    const r = await fetch(asset.url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${asset.url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    // Verify it is really a woff2 and not an error page saved to disk under a font name.
    if (buf.length < 4 || buf.toString('latin1', 0, 4) !== 'wOF2') {
      throw new Error(`${asset.name} 不是 woff2（前 4 字节: ${JSON.stringify(buf.toString('latin1', 0, 4))}）`);
    }
    writeFileSync(dest, buf);
    fetched++;
  }
  console.log(`  下载 ${fetched} 个，复用 ${skipped} 个`);

  const header = `/*
 * Vendored webfonts — generated by scripts/vendor-fonts.mjs, do not edit by hand.
 *
 * These were loaded from fonts.googleapis.com until the app was noticed making two requests to
 * Google on every page load — which is precisely what the stylesheet validator refuses to let a
 * user do, and what a local-first app should not do at all. The files now live in
 * packages/ui/public/fonts/ and are served by this app.
 *
 * Inter — SIL Open Font License 1.1 — https://github.com/rsms/inter
 * JetBrains Mono — SIL Open Font License 1.1 — https://github.com/JetBrains/JetBrainsMono
 *
 * Only the latin and latin-ext subsets are included; other scripts fall back to system fonts,
 * which is what they did before for CJK anyway. The unicode-range declarations are preserved so
 * the browser still downloads only the subset a page needs.
 */
`;

  const rules = assets.map((a) => {
    // A single weight renders as `400`; a variable file as `300 700`.
    const weight = a.minWeight === a.maxWeight ? `${a.minWeight}` : `${a.minWeight} ${a.maxWeight}`;
    return [
      `@font-face {`,
      `  font-family: '${a.family}';`,
      `  font-style: normal;`,
      `  font-weight: ${weight};`,
      // `swap` matches what the Google stylesheet requested, so text is readable immediately
      // and swaps in when the font arrives.
      `  font-display: swap;`,
      `  src: url('/fonts/${a.name}') format('woff2');`,
      ...(a.unicodeRange ? [`  unicode-range: ${a.unicodeRange};`] : []),
      `}`,
    ].join('\n');
  }).join('\n\n');

  writeFileSync(OUT_CSS, `${header}\n${rules}\n`, 'utf8');
  console.log(`  写入 src/styles/fonts.css（${assets.length} 条规则）`);
}

await main();
