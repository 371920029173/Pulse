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
// "Which packages must report" and "what did each report" live in the lib: `test-suites.mjs` needs
// the same two answers, and two copies of them would drift.
import { readJson, packagesWithTests, parseSuiteOutput } from './lib/suites.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * The unit-test total, measured rather than assumed.
 *
 * Runs the suites and sums what the runners themselves report (`# tests N` from `node:test`,
 * `Tests N passed` from vitest). This is what makes the "quoted count" assertion meaningful instead
 * of a mutual-agreement check that passes on a number nobody verified.
 *
 * A failing run yields a short/zero total, which fails the assertion — the safe direction.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RUNNER IS GIVEN A CONTROLLED ENVIRONMENT
 *
 * This check reported "实测 459, 文档写 636" on CI, where 459 was exactly the `node:test` subtotal —
 * the vitest line had not matched. Two separate causes, both about the environment rather than the
 * docs:
 *
 *   1. **Colour.** Colourised output puts escape codes between the label and the number
 *      (`Tests \x1b[1m\x1b[32m177 passed`), so `Tests\s+177` cannot match. Locally FORCE_COLOR=0, so
 *      this only ever failed on someone else's machine.
 *   2. **CI mode changes the reporter.** With `CI=true`, vitest prints a per-file list instead of the
 *      summary line, and pnpm's captured output dropped from 178KB to 111KB with two packages'
 *      counts missing entirely. So parsing the aggregate is unreliable in exactly the environment
 *      this check is most needed in.
 *
 * Rather than teach the parser every reporter variant, the child runs with colour disabled and CI
 * unset, so the output has one known shape wherever this executes. The parent's environment is not
 * modified — only the child's.
 *
 * Escapes are still stripped before matching: belt and braces, and it costs nothing.
 * ─────────────────────────────────────────────────────────────────────────────
 */
/**
 * How long the whole `pnpm -r test` run may take before it is abandoned.
 *
 * There was no timeout here, and that is how the gate hung for 65 minutes once. `spawnSync` does not
 * return when the child exits — it returns when the child's STDOUT PIPE CLOSES, and a grandchild that
 * inherited that pipe keeps it open after its parent is gone. One stuck language server or background
 * job anywhere under the test tree is therefore enough to make this call wait forever, with the
 * machine pinned and nothing printed to say why. (That is the same class of problem as the `close`
 * vs `exit` wait in the sandbox teardown.)
 *
 * A normal run of all six suites measures 45–70s on this machine, and several minutes under load, so
 * this is generous. The choice on hitting it is deliberate: report a FAILED MEASUREMENT, which the
 * assertions above already handle by skipping the doc comparison — never a hang.
 */
const SUITE_RUN_TIMEOUT_MS = 15 * 60_000;

/** Run every suite once and hand back its output. */
function runSuites() {
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.CI;

  const out = spawnSync('pnpm', ['-r', 'test'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 512 * 1024 * 1024,
    env,
    timeout: SUITE_RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  /*
   * On Windows this kills the `pnpm` shell, and a grandchild that is holding the pipe may outlive the
   * kill — so the timeout makes the gate finish, it does not guarantee the tree is gone. That is the
   * right trade here (this script is a measurement, and `check:temp` sweeps what is left), and saying
   * so is better than implying a cleanup that does not happen.
   */
  const timedOut = out.error?.code === 'ETIMEDOUT';
  const raw = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
  return {
    text: raw.replace(/\u001b\[[0-9;]*m/g, '').replace(/[ \t]+/g, ' '),
    error: timedOut
      ? `pnpm -r test 超过 ${Math.round(SUITE_RUN_TIMEOUT_MS / 60_000)} 分钟未返回，已放弃`
      : (out.error ? String(out.error.message ?? out.error) : ''),
    timedOut,
    // The child's own exit code. Null when it never started.
    status: typeof out.status === 'number' ? out.status : null,
  };
}

/**
 * How many packages SHOULD have reported. A partial count is the dangerous case: it is larger than
 * zero, so it reads as a real measurement, and the failure surfaces as "the docs quote a stale
 * number" when the docs are right and the measurement is not. Observed twice for real — a run
 * reported 514 instead of 716 (the server package missing), and a later run reported exactly
 * `shared + kb + sandbox + ui`, so the two heavy suites (`agent-runtime`, `server`) had produced no
 * summary at all.
 *
 * Counting the packages that declare a `test` script is the only fact available here that the parsed
 * output cannot fake, so it is what the count is checked against.
 * ─────────────────────────────────────────────────────────────────────────────
 */
/**
 * Decide whether one run's output is a usable measurement of "how many unit tests exist".
 *
 * Two independent conditions, and the second one was missing:
 *
 *   1. Every package that declares a `test` script reported a total (the count above).
 *   2. The run EXITED CLEAN.
 *
 * Condition 2 is not a formality. `node --test` prints a summary that counts the tests it RAN, so a
 * file that is cancelled — its promise still pending when the event loop drained, which this
 * repository has already hit once via an unref'd timer being the only handle — makes the summary
 * SHORTER than the file's real test count while still printing `# fail 0`. Measured on
 * `packages/sandbox` with one file cancelled: `# tests 256` instead of 269, `# pass 255`, `# fail 0`,
 * exit status 1.
 *
 * The suite still reports, so condition 1 alone calls that a complete measurement, and the doc
 * comparison then fails with "文档写的是 1682，实测 1669" — pointing the reader at the documentation
 * for a defect in the test run. A short total is not a census; the exit code is the one fact in the
 * output that says so, and it is why this is decided here rather than by counting suites.
 */
function judgeRun({ parsed, expected, status, timedOut }) {
  const attributed = parsed.counted.size > 0;
  const missing = attributed ? expected.filter((n) => !parsed.counted.has(n)) : [];
  const suites = parsed.nodeTestSuites + parsed.vitestSuites;
  const allReported = expected.length > 0 && suites === expected.length && missing.length === 0;
  const clean = !timedOut && status === 0;

  /*
   * Name what did not report — in BOTH non-timeout branches, not only the clean one.
   *
   * The non-zero-exit branch used to say "报出的 4/6 套不是完整普查" and stop there. That is the
   * sentence a real gate run produced (2026-10-02): it tells the reader the measurement is unusable
   * and leaves out the only part they can act on — WHICH two suites never reported. The retry that
   * follows usually hides the gap, and when it does not, this message is all anyone has. Same
   * argument as naming the silent packages when `check:suites` hits its deadline: "it came back
   * short" is not actionable, "kb and server never reported" is.
   */
  const missingNote = missing.length ? `，没报告的是：${missing.join('、')}` : '';
  const why = timedOut
    ? '整轮超时被放弃'
    : status !== 0
      ? `node --test 以退出码 ${status} 结束（有文件被取消或失败），它报出的 ${suites}/${expected.length} 套不是完整普查${missingNote}`
      : `${suites}/${expected.length} 套${missingNote}`;

  return { suites, missing, attributed, complete: allReported && clean, why };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A PARTIAL RUN IS RETRIED, AND IS NOT ALLOWED TO CONDEMN THE DOCS
 *
 * This is the second time the same shape of failure has been reported as "文档写的是 1433，实测 512".
 * 512 was not a measurement of the documentation's truthfulness; it was four suites out of six. The
 * run is therefore repeated once when it comes back short — under load a suite can fail to start and
 * say nothing, which is transient — and if it STILL comes back short the check fails on the
 * incomplete measurement, naming the missing packages, and the doc comparison is skipped rather than
 * judged with a number that is known to be wrong.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function measureUnitTests() {
  const expected = packagesWithTests();
  let measured = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text, error, timedOut, status } = runSuites();
    const parsed = parseSuiteOutput(text);
    measured = {
      ...parsed,
      ...judgeRun({ parsed, expected, status, timedOut }),
      attempts: attempt,
      error,
      status,
    };
    if (measured.complete) break;
    console.log(`        第 ${attempt} 次测量不完整（${measured.why}`
      + `${error ? `，${error}` : ''}）${attempt < 2 ? '—— 重跑一次' : ''}`);
  }

  /*
   * Report the composition. When the number is wrong, the first useful question is "which runner was
   * missed?", and a bare total cannot answer it — the failure mode that made this hard to diagnose.
   */
  console.log(`        实测单元测试 ${measured.total} 项`
    + `（node:test ${measured.nodeTestSuites} 套 + vitest ${measured.vitestSuites} 套，`
    + `应有 ${expected.length} 套${measured.complete && measured.attempts > 1 ? `，第 ${measured.attempts} 次才完整` : ''}）`);
  if (!measured.complete) {
    console.log(`        !! 计数不完整（${measured.why}）—— 是测量本身失败了，不是文档写错了`);
  }
  return { ...measured, expectedSuites: expected.length };
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

/** Cache for `isGenerated`. */
const generatedCache = new Map();

/**
 * Directories that are BUILD OUTPUT and therefore absent from a fresh checkout.
 *
 * A doc may legitimately mention one (`packages/desktop/runtime` only exists after the staging
 * step), and reporting it would fail CI for the normal state of a clean clone.
 *
 * Listed explicitly rather than asked of git. `git check-ignore` looked like the principled answer —
 * use git's own rules, no hand-maintained list — but it is unreliable here: it answers correctly for
 * a path whose directory EXISTS (as on a developer's machine, where staging has run) and differently
 * when it does not (as in CI). Verified: `git check-ignore -q packages/desktop/runtime` returned 0
 * locally and the same reference failed on CI, so the fix appeared to work and did not.
 *
 * The cost of an explicit list is that a new generated directory must be added here; the benefit is
 * that the answer is the same on every machine. Only directory PREFIXES belong here — never a real
 * source path, which would silently stop being checked.
 */
const GENERATED_PREFIXES = [
  'packages/desktop/runtime', // staged by scripts/stage-desktop-runtime.mjs
  'packages/ui/dist',         // vite output
];

function isGenerated(ref) {
  if (generatedCache.has(ref)) return generatedCache.get(ref);
  const normalised = ref.replace(/\\/g, '/').replace(/\/+$/, '');
  const hit = GENERATED_PREFIXES.some(
    (p) => normalised === p || normalised.startsWith(p + '/'),
  );
  generatedCache.set(ref, hit);
  return hit;
}

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

      /*
       * A BUILD OUTPUT path is absent on a clean checkout, which is the normal state in CI — not a
       * stale reference. See GENERATED_PREFIXES for why this is a list rather than a question asked
       * of git.
       */
      if (isGenerated(ref)) continue;

      missing.push(`${file} → ${ref}`);
    }
  }

  check(`引用的文件都存在（${missing.length} 处失效）`, missing.length === 0, missing.join('\n        '));
}

// ─── 2. Quoted counts match reality ───
console.log('\n=== 文档里引用的数字与实际一致 ===');
{
  const pkg = readJson(join(ROOT, 'package.json'));

  /*
   * Count the gate's steps by RESOLVING delegation.
   *
   * `check:all` is now `pnpm check:offline && pnpm eval:verify` — two entries — while the real gate
   * is the 26 commands inside `check:offline`. Counting the literal entries made the expected number
   * "2", so any doc that stated the true figure was reported as stale, and a doc that stated "2"
   * would have been accepted. A number nobody can state correctly is worse than no number.
   *
   * One level of expansion is enough here, and a cycle is guarded against: the aggregates are
   * maintained by hand and a self-reference would be a bug worth failing on rather than hiding.
   */
  const stepCount = (name, seen = new Set()) => {
    if (seen.has(name)) throw new Error(`脚本互相引用成环: ${[...seen, name].join(' → ')}`);
    const value = String(pkg.scripts?.[name] ?? '');
    if (!value) return 0;
    seen.add(name);
    let total = 0;
    for (const part of value.split(' && ').map((s) => s.trim()).filter(Boolean)) {
      const ref = /^pnpm ([\w:-]+)$/.exec(part);
      if (ref && pkg.scripts?.[ref[1]]) total += stepCount(ref[1], new Set(seen));
      else total += 1;
    }
    return total;
  };
  /*
   * Accept either aggregate's resolved size.
   *
   * Both numbers are legitimately correct: `check:all` is the full gate (28 commands), `check:offline`
   * is the subset CI runs (26). Forcing a single figure would make one of the two true statements
   * unwritable, and a check that forbids correct documentation is a check people work around.
   */
  const gateSteps = stepCount('check:all');
  const offlineSteps = stepCount('check:offline');
  const allowedSteps = new Set([gateSteps, offlineSteps]);
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
  const wrong = [...gateMentions.entries()].filter(([, n]) => !allowedSteps.has(n));
  const EXPECTED = [...allowedSteps].sort((a, b) => a - b).join(' 或 ');
  check(
    `没有过时的步数表述（若写了就必须是 ${EXPECTED}）`,
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
  const measured = measureUnitTests();
  const realTotal = measured.total;
  const testCounts = new Set();
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/(\d+)\s*(?:项|个测试|tests)/g)) {
      // Ignore small numbers: they are per-suite or per-check counts, not the unit-test total.
      if (Number(m[1]) >= 100) testCounts.add(`${file}:${m[1]}`);
    }
  }
  const quoted = [...new Set([...testCounts].map((s) => Number(s.split(':')[1])))];
  /*
   * Asserted BEFORE the comparison, because a partial measurement would otherwise be
   * reported as the documentation being stale. That happened twice: a run counted 514 instead of 716
   * — one package short — and a later one counted 512 of 1458 with two suites silent. Both times the
   * message pointed at the docs.
   */
  check(
    `测试总数是从全部套件测出来的（${measured.suites}/${measured.expectedSuites} 套）`,
    measured.complete,
    `${realTotal} 这个数字不可信：${measured.why}。`
    + '这是测量失败，不是文档写错。重跑一次再判断',
  );
  /*
   * The doc comparison runs ONLY on a complete measurement. With a known-incomplete total, every
   * answer it could give is wrong: it fails the docs for the measurement's fault, or — if the numbers
   * happen to agree — it certifies a count nobody actually verified.
   */
  if (!measured.complete) {
    console.log('        测量不完整，跳过「文档里的测试总数」比对（不拿一个已知不可信的数字去判文档的对错）');
  } else {
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
  }

  /*
   * Pin the usability rule itself, because it is the guard that decides whether the number below is
   * allowed to judge the docs — and its second half (the exit code) cannot be exercised by whatever
   * this machine happens to do during this run. Fabricated inputs, asserted directly.
   */
  {
    const two = ['a', 'b'];
    const fake = ({ counted, nodeTestSuites = 0, vitestSuites = 0, total = 10 }) =>
      ({ total, nodeTestSuites, vitestSuites, counted: new Set(counted) });
    const usable = (o) => judgeRun({ parsed: fake(o), expected: two, status: o.status, timedOut: o.timedOut ?? false }).complete;

    check('自测：两套都报数且干净退出 → 可用', usable({ counted: ['a', 'b'], nodeTestSuites: 2, status: 0 }));
    check('【关键】自测：两套都报数但退出码非 0 → 不可用（短总计不是普查，别去怪文档）',
      !usable({ counted: ['a', 'b'], nodeTestSuites: 2, status: 1 }));
    check('自测：少一套报数 → 不可用', !usable({ counted: ['a'], nodeTestSuites: 1, status: 0 }));
    check('自测：整轮超时 → 不可用（哪怕它报了两个套件）',
      !usable({ counted: ['a', 'b'], nodeTestSuites: 2, status: null, timedOut: true }));

    /*
     * And pin the wording, because "unusable" is only half the message. Both non-timeout branches
     * must name the suites that went silent — the non-zero-exit one did not, and that is the branch
     * a real run took.
     */
    const whyFor = (o) => judgeRun({
      parsed: fake(o), expected: two, status: o.status, timedOut: o.timedOut ?? false,
    }).why;
    check('【关键】自测：退出码非 0 时也要点名没报数的套件',
      whyFor({ counted: ['a'], nodeTestSuites: 1, status: 1 }).includes('b'));
    check('自测：干净退出但少一套时同样点名',
      whyFor({ counted: ['a'], nodeTestSuites: 1, status: 0 }).includes('b'));
  }

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

  const pkgScripts = readJson(join(ROOT, 'package.json')).scripts ?? {};
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
