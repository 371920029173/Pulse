/**
 * Documentation matches the code.
 *
 * Twice now a doc has pointed at something that no longer exists — `README.md` and
 * `CONTRIBUTING.md` both told readers to run `scripts/one-click.ps1` long after the
 * cross-platform launcher replaced it. A reader following those instructions hits a
 * missing file, and nothing in the gate notices.
 *
 * Three things are checked, all of which have actually been wrong:
 *
 *   1. Command and file references resolve. A script named in a doc must exist.
 *   2. The counts quoted in docs match reality (test count, check count, gate steps).
 *      These go stale silently and are the fastest way to lose a reader's trust.
 *   3. No TODO/FIXME leaked into shipped docs, matching the repository's own rule.
 *
 *   node scripts/docs-check.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * The unit-test total, measured rather than assumed.
 *
 * Runs the suites and sums what the runners themselves report (`# tests N` from `node:test`,
 * `Tests N passed` from vitest). This is the only source that cannot drift from reality, and it is
 * what makes the "quoted count" assertion meaningful instead of a mutual-agreement check that passes
 * on a number nobody verified.
 *
 * A failing run yields a short/zero total, which fails the assertion — the safe direction.
 */
function measureUnitTests() {
  const out = spawnSync('pnpm', ['-r', 'test'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
  let total = 0;
  for (const m of text.matchAll(/# tests (\d+)/g)) total += Number(m[1]);
  for (const m of text.matchAll(/Tests\s+(\d+) passed/g)) total += Number(m[1]);
  return total;
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
  }
};

/** Markdown files a reader is expected to follow. */
const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'architecture.md',
  'FEATURES.md',
  'PERF.md',
  'UPGRADES.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('docs', f)),
].filter((f) => existsSync(join(ROOT, f)));

console.log(`\n文档一致性检查（${DOCS.length} 个文件）\n`);

const texts = new Map(DOCS.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));

// ─── 1. Referenced paths exist ───
console.log('=== 文档里引用的文件是否真的存在 ===');
{
  /*
   * Only paths that look like THIS project's files: a leading `scripts/`, `packages/`,
   * `docs/`, `evals/`, `plugins/`, or a bare top-level filename we ship. Deliberately not
   * matching prose like `node_modules/` or a path in an example.
   */
  const PATTERN = /(?:^|[\s(`'"[=])((?:scripts|packages|docs|evals|plugins)\/[\w./@-]+|(?:SHE|SHE-stop)\.bat|she\.sh|Dockerfile|\.dockerignore|config\.example\.yaml|\.env\.example)/gm;

  const missing = [];
  for (const [file, text] of texts) {
    /*
     * CHANGELOG is exempt.
     *
     * It is a historical record: an entry describing a removal has to name the file that was
     * removed, and one describing a rename has to name the old name. Requiring those to exist would
     * force the history to be rewritten to match the present, which defeats the point of keeping it.
     */
    if (file === 'CHANGELOG.md') continue;
    for (const m of text.matchAll(PATTERN)) {
      const ref = m[1].replace(/[.,;:)]+$/, '');
      // A glob cannot be checked literally.
      if (ref.includes('*')) continue;
      /*
       * The reference must EXIST — as a file or as a directory.
       *
       * There used to be a fallback here: `if (existsSync(dirname(target))) continue`, meant to allow
       * directory references like `packages/x/src`. It defeated the entire check — every missing file
       * under an existing directory was skipped, which is all of them. Demonstrated: a doc pointing at
       * `scripts/one-click.ps1` (deleted long ago) passed, as did `docs/does-not-exist.md`. That is
       * precisely the drift this check was written to catch.
       *
       * `existsSync` already returns true for a directory, so the fallback was never needed.
       */
      if (existsSync(join(ROOT, ref))) continue;
      missing.push(`${file} → ${ref}`);
    }
  }

  check(`引用的文件都存在（${missing.length} 处失效）`, missing.length === 0, missing.join('\n        '));
}

// ─── 2. Quoted counts match reality ───
console.log('\n=== 文档里引用的数字与实际一致 ===');
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const gateSteps = String(pkg.scripts?.['check:all'] ?? '').split(' && ').filter(Boolean).length;
  const checkScripts = readdirSync(join(ROOT, 'scripts')).filter((f) => f.includes('check') && f.endsWith('.mjs')).length;

  /*
   * Deliberately NOT requiring docs to state the gate step count.
   *
   * The number changes every time a check is added — it was updated four times while this
   * file was being written — and it tells a reader nothing that "runs everything" does
   * not. Requiring it would create busywork; allowing a WRONG one is worse, so this
   * asserts only that no stale number survives. The guidance for docs is therefore:
   * describe what runs, do not count it.
   */
  const gateMentions = new Map();
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/(\d+)\s*(?:步|steps)/g)) {
      gateMentions.set(file, Number(m[1]));
    }
  }
  const wrong = [...gateMentions.entries()].filter(([, n]) => n !== gateSteps);
  check(
    `没有过时的步数表述（若写了就必须等于 ${gateSteps}）`,
    wrong.length === 0,
    wrong.map(([f, n]) => `${f} 写的是 ${n}`).join('; '),
  );

  /*
   * The quoted test count must match the REAL count, not merely agree between documents.
   *
   * The previous version asserted only that the docs agreed with each other: `totals.size <= 1`. If
   * every document had said `999 / 999`, it passed. That is a check that cannot fail in the one case
   * it exists for — and four wrong counts were sitting in README while it reported PASS.
   *
   * There is no cheap authoritative source, so the suites are RUN and their own reported totals are
   * summed. Static counting of `it(` was considered and rejected: loops and parameterised tests make
   * it disagree with the runner, which would produce false failures and teach people to ignore the
   * check. If the run fails, totals come back short and this fails loudly, which is the safe direction.
   */
  const realTotal = measureUnitTests();
  const testCounts = new Set();
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/(\d+)\s*(?:项|个测试|tests)/g)) {
      // Ignore small numbers: they are per-suite or per-check counts, not the unit-test total.
      if (Number(m[1]) >= 100) testCounts.add(`${file}:${m[1]}`);
    }
  }
  const quoted = [...new Set([...testCounts].map((s) => Number(s.split(':')[1])))];
  check(
    `文档里的单元测试总数是真实的（实测 ${realTotal}，文档写 ${quoted.join(' / ') || '未引用'}）`,
    realTotal > 0 && quoted.every((n) => n === realTotal),
    quoted.length === 0
      ? '没有任何文档引用总数，无法校验'
      : `文档写的是 ${quoted.join(' / ')}，实测 ${realTotal}`,
  );
  check(
    '引用到的测试数量彼此一致',
    quoted.length <= 1,
    [...testCounts].join('\n        '),
  );

  console.log(`        门禁步数 ${gateSteps}，检查脚本 ${checkScripts} 个`);
}

// ─── 3. No TODO / FIXME in shipped docs ───
console.log('\n=== 文档里没有 TODO / FIXME ===');
{
  /*
   * The repository rule is zero markers: an incomplete task should be described, not
   * flagged. A doc that says "TODO: document this" tells the reader nothing.
   *
   * CHANGELOG is exempt — it is a historical record, and a past entry may legitimately
   * quote a marker that has since been removed.
   */
  const offenders = [];
  for (const [file, text] of texts) {
    if (file === 'CHANGELOG.md') continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (/\b(TODO|FIXME|XXX)\b/.test(line) && !/零 TODO|no TODO|TODO \/ FIXME/i.test(line)) {
        offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  check(`没有遗留标记（${offenders.length} 处）`, offenders.length === 0, offenders.join('\n        '));
}

// ─── 4. Every check script is documented somewhere ───
console.log('\n=== 检查脚本是否都在文档里提到 ===');
{
  const scripts = readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.mjs') && f !== 'she.mjs')
    .map((f) => f.replace(/\.mjs$/, ''));

  const pkgScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
  /** The `check:*` alias that runs a given script, if any. */
  const aliasFor = (script) => Object.entries(pkgScripts)
    .find(([, cmd]) => String(cmd).includes(`scripts/${script}.mjs`))?.[0];

  /*
   * Docs reference these by their pnpm alias (`pnpm check:data`), not by filename, so
   * looking for the filename alone reported most of them as undocumented. Both spellings
   * count.
   */
  const undocumented = scripts.filter((s) => {
    const alias = aliasFor(s);
    const needles = [s, alias].filter(Boolean).map((n) => new RegExp(String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return ![...texts.values()].some((t) => needles.some((re) => re.test(t)));
  });

  /*
   * This FAILS, where it used to only print.
   *
   * The previous version reported `27/28` and exited 0 regardless, so it contributed nothing to the
   * gate — a check whose result cannot change the outcome is a comment, not a check. A script nobody
   * documented is a script nobody can run: the reader's only route to it is `pnpm check:all`, which
   * tells them nothing about what it guards.
   */
  check(
    `每个检查脚本都在文档里出现过（${scripts.length - undocumented.length}/${scripts.length}）`,
    undocumented.length === 0,
    undocumented.length ? `未提到: ${undocumented.join(', ')}` : '',
  );
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
