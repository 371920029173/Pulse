/**
 * The built UI bundle actually contains the wiring it needs.
 *
 *   node scripts/dist-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The custom-stylesheet feature was written, unit-tested (566 tests), covered by an
 * end-to-end check, and then shipped into a build where it did nothing at all.
 *
 * The cause was absurd and entirely mechanical: a bulk edit inserted a literal `\n` instead
 * of a newline, which merged two comment lines into one — and the merged line began with
 * `//`, so the `el.textContent = promoteDocumentSelectors(...)` statement below it was
 * swallowed into the comment. The element was created, never given any CSS, and the injected
 * sheet was always empty.
 *
 * Every existing test passed, because every existing test reads SOURCE. The browser runs a
 * BUNDLE, and nothing checked the bundle. That is the gap this closes.
 *
 * It is a deliberately shallow check — a handful of greps — because the failure mode is
 * shallow: a build can be stale, or a critical line can be commented out, or a module can drop
 * out of the graph, and the result is a feature that silently does nothing. Cheap assertions
 * would have caught all three.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const UI = join(ROOT, 'packages', 'ui');
const ASSETS = join(UI, 'dist', 'assets');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

if (!existsSync(ASSETS)) {
  console.error(`找不到 ${ASSETS}\n请先 pnpm -r build`);
  process.exit(1);
}

const jsFile = readdirSync(ASSETS).filter((n) => n.endsWith('.js')).sort()[0];
if (!jsFile) {
  console.error('dist/assets 里没有 .js 产物');
  process.exit(1);
}
const bundle = readFileSync(join(ASSETS, jsFile), 'utf8');
const html = readFileSync(join(UI, 'dist', 'index.html'), 'utf8');
const cssFile = readdirSync(ASSETS).filter((n) => n.endsWith('.css')).sort()[0];
const bundleCss = cssFile ? readFileSync(join(ASSETS, cssFile), 'utf8') : '';

/*
 * Nothing may be fetched from a third party at runtime.
 *
 * The app shipped `<link href="https://fonts.googleapis.com/...">` for months. Every page load
 * made two requests to Google, one of them a font download — while the app's own stylesheet
 * validator refuses a remote `@import` with the message "这会泄露你这台机器在运行本应用". A
 * local-first app that phones a CDN on startup to render its own text is not local-first.
 *
 * The fonts are now vendored (`pnpm vendor:fonts`); this asserts nothing has crept back in.
 *
 * Comments are stripped first. Worth the four lines: `index.html` deliberately *explains* the
 * Google Fonts link it removed, so a naive substring search flags the explanation as the
 * mistake. A check that fails on comments describing the rule is a check someone deletes.
 */
const stripComments = (text, kind) => kind === 'html'
  ? text.replace(/<!--[\s\S]*?-->/g, '')
  : text.replace(/\/\*[\s\S]*?\*\//g, '');

{
  const sources = [
    ['index.html', html, 'html'],
    ['bundle', bundle, 'js'],
    ['bundle css', bundleCss, 'css'],
  ];

  for (const [name, raw, kind] of sources) {
    const text = stripComments(raw, kind);
    const remote = [
      /fonts\.googleapis\.com/,
      /fonts\.gstatic\.com/,
      /https?:\/\/[^"')\s]*\.woff2?/,
      /<link[^>]+href=["']https?:\/\//i,
    ];
    const hit = remote.find((re) => re.test(text));
    check(
      `${name} 不引用外部字体/样式（本地优先，且会泄露本机在运行）`,
      !hit,
      hit ? `命中 ${hit}` : undefined,
    );
  }

  // The vendored files must actually be present and served from our own origin.
  const fontDir = join(UI, 'dist', 'fonts');
  const shipped = existsSync(fontDir) ? readdirSync(fontDir).filter((n) => n.endsWith('.woff2')) : [];
  check('产物里带着本地字体文件', shipped.length > 0, `${fontDir} 下没有 .woff2`);
  check(
    '@font-face 指向本地路径（而不是又变回远程）',
    /src: ?url\(["']?\/fonts\//.test(bundleCss),
    'CSS 里没有指向 /fonts/ 的 src',
  );
  check(
    'latin 与 latin-ext 子集都在',
    shipped.some((n) => n.includes('latin-ext')) && shipped.some((n) => /-latin\.woff2$/.test(n)),
    shipped.join(', '),
  );
}

/*
 * Wiring that has no server-side test, so a bundle-level assertion is the only thing standing
 * between "the source is right" and "the feature works".
 *
 * Each entry says what breaks if it is missing, because a bare list of strings ages into
 * cargo cult.
 */
const REQUIRED = [
  ['she-user-theme', '样式注入的元素 id —— 缺了它保存的样式永远不会生效'],
  ['html[data-theme]', '文档级选择器提升 —— 缺了它用户的 :root 变量在浅色主题下会失效'],
  ['api/theme/disable', '逃生通道 —— 缺了它样式把界面弄乱后只能手工删文件'],
  ['theme=off', '地址栏逃生通道 —— 界面看不见时唯一可行的操作'],
];

for (const [needle, why] of REQUIRED) {
  check(`产物包含 ${needle}（${why}）`, bundle.includes(needle), `未在 ${jsFile} 中找到`);
}

/*
 * ── Staleness ──
 *
 * The real failure this guards: source edited, build forgotten, and the app serves the old behaviour.
 *
 * The first version compared the bundle's mtime against the newest mtime of ANY source file. That is
 * the obvious approach and it reports false failures: something touched every file in this tree (a
 * bulk rewrite or a checkout) without changing a byte, so all of them became "newer than the bundle"
 * and the check went red while the bundle was in fact current. A check that goes red for reasons
 * unrelated to the code teaches people to ignore it.
 *
 * Two signals are used instead, and both are about CONTENT rather than filesystem noise:
 *
 *   1. **Uncommitted edits to UI source.** If a dirty file is newer than the bundle, the bundle
 *      cannot contain it.
 *   2. **The last commit that touched UI source.** Catches the other order — commit the change,
 *      forget to rebuild — which no amount of mtime comparison can see once the working tree is
 *      clean again.
 *
 * Falls back to the mtime sweep when git is unavailable, so the check still does something useful
 * outside a repository.
 */
{
  const builtAt = statSync(join(ASSETS, jsFile)).mtimeMs;
  const UI_PATH = 'packages/ui';
  const problems = [];

  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };

  const status = git(['status', '--porcelain', '--', UI_PATH]);
  const lastCommit = git(['log', '-1', '--format=%ct', '--', UI_PATH]);

  if (status === null || lastCommit === null) {
    // Not a git checkout: fall back to the mtime sweep, and say so.
    const newest = { file: '', mtime: 0 };
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(p);
        } else if (/\.(tsx?|css)$/.test(entry.name)) {
          const m = statSync(p).mtimeMs;
          if (m > newest.mtime) { newest.file = p.slice(UI.length + 1); newest.mtime = m; }
        }
      }
    };
    walk(join(UI, 'src'));
    if (builtAt < newest.mtime) {
      problems.push(`产物早于 ${newest.file}（git 不可用，退化为 mtime 比较）`);
    }
  } else {
    // 1. Uncommitted edits.
    for (const line of status.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const p = line.slice(3).trim();
      if (!p || p.includes(' -> ')) continue;
      try {
        const m = statSync(join(ROOT, p)).mtimeMs;
        if (m > builtAt) problems.push(`未提交的改动比产物新: ${p}`);
      } catch { /* deleted file: nothing to compare */ }
    }

    // 2. Committed but never rebuilt.
    const commitMs = Number(lastCommit.trim()) * 1000;
    if (Number.isFinite(commitMs) && commitMs > 0 && builtAt < commitMs) {
      problems.push(
        `产物早于最后一次改动 UI 源码的提交（产物 ${new Date(builtAt).toISOString().slice(0, 16)}，`
        + `提交 ${new Date(commitMs).toISOString().slice(0, 16)}）`,
      );
    }
  }

  check(
    '产物不比 UI 源码旧（改完忘了构建会静默沿用旧行为）',
    problems.length === 0,
    problems.slice(0, 4).join('；'),
  );
}

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${!r.ok && r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - results.filter((r) => !r.ok).length} 通过 / ${results.filter((r) => !r.ok).length} 失败`);
console.log(`  bundle: ${jsFile}（${Math.round(bundle.length / 1024)}KB）`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
