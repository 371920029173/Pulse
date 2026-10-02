/**
 * Run every workspace test suite, under a wall clock that actually ends.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The gate ran `pnpm -r test` directly, and that step had no timeout. It was observed to hang for
 * real: `packages/sandbox/src/__tests__/background.test.ts` blocked for 10 minutes inside a full
 * run — CPU frozen at 1.156s, no child processes, i.e. blocked rather than slow — and the whole gate
 * sat there printing nothing. That is the worst shape a failure can take: no output, no exit code,
 * and the only way out is to notice and kill it by hand. (An earlier occurrence lasted 6 minutes.)
 *
 * So the suite step gets a deadline. The point is not to make a hang impossible — it is not fixed
 * and has not been reproduced — but to make it END, name what was still in flight, and say so.
 *
 * This is deliberately NOT a measurement. `docs-check.mjs` is where "how many tests exist" is
 * decided, with its own env hygiene and its own completeness rules; doing that here as well would
 * put two answers to the same question in the gate. This script only bounds the step and forwards
 * the exit code.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/test-suites.mjs
 */
import { spawn } from 'node:child_process';
import { killTree } from './lib/kill-tree.mjs';
import { ROOT, packagesWithTests, parseSuiteOutput } from './lib/suites.mjs';
import { hermeticEnv } from './lib/hermetic.mjs';

/**
 * How long the whole run may take before it is abandoned.
 *
 * The slowest package measures ~45s with every file running in parallel (kb, 2026-10-02), and a
 * loaded machine stretches the whole run to a few minutes. Fifteen minutes is generous on purpose:
 * the deadline exists to end a hang, not to referee a slow machine, and a false red here would train
 * people to re-run the gate — the thing this repository keeps deciding against.
 *
 * Override with SHE_SUITE_TIMEOUT_MS (used to prove the deadline path itself).
 */
const TIMEOUT_MS = Number(process.env.SHE_SUITE_TIMEOUT_MS ?? 15 * 60_000);

/**
 * The deadline in words.
 *
 * The override exists for the mutation test, which sets it to one second — and "超过 0 分钟仍未
 * 跑完" is a sentence that says nothing true. Sub-minute values print in seconds.
 */
const limitWords = TIMEOUT_MS < 60_000 ? `${TIMEOUT_MS / 1000} 秒` : `${Math.round(TIMEOUT_MS / 60_000)} 分钟`;

/** Packages that were supposed to report a total but never did, in `expected` order. */
function silentPackages(expected, text) {
  const counted = parseSuiteOutput(text).counted;
  return expected.filter((name) => !counted.has(name));
}

// ─── self-test: the "who went silent" answer, on fabricated input ───
{
  const twoReported = 'packages/a test: # tests 3\npackages/b test: # tests 5\n';
  const allReported = 'packages/a test: # tests 3\npackages/b test: # tests 5\npackages/c test: # tests 2\n';
  const cases = [
    [['a', 'b', 'c'], twoReported, ['c'], '少一套就点名那一套'],
    [['a', 'b', 'c'], allReported, [], '都报了就不点名'],
    [['a', 'b'], twoReported, [], '预期集合里的都报了，别多嘴'],
    [[], twoReported, [], '没有预期的套件时安静'],
  ];
  let bad = 0;
  for (const [expected, text, want, label] of cases) {
    const got = silentPackages(expected, text).join(',');
    if (got !== want.join(',')) { bad++; console.log(`  FAIL  自测：${label}（得到「${got}」，应为「${want.join(',')}」）`); }
  }
  console.log(bad === 0
    ? '  自测通过：超时时点名的就是没报数的那几套'
    : `  自测 ${bad} 项失败`);
  if (bad > 0) process.exit(1);
}

console.log(`\n跑全部套件（上限 ${limitWords}）：pnpm -r test\n`);

const child = spawn('pnpm', ['-r', 'test'], {
  cwd: ROOT,
  shell: true,
  /*
   * 「套件在什么环境里跑」由这一步决定，不由「谁在跑这一步」决定。
   *
   * 不给 `env` 就是整体继承外层环境，而 `loadConfig` 的优先级是环境变量 > 配置文件 —— 于是在
   * SHE 自己的沙箱里跑门禁（那个环境里有 `.env` 读进来的 `OPENAI_MODEL`）时，一遍全绿的套件
   * 会变成 `packages/shared` 的 3 条红，报的还是「期望 from-she-config，实得 deepseek-flash」。
   * 同一份代码，结论取决于命令从哪儿敲的 —— 那就不是门禁。见 `lib/hermetic.mjs`。
   */
  env: hermeticEnv(),
  stdio: ['ignore', 'pipe', 'pipe'],
});

/*
 * Stream output through untouched, and keep a copy for the diagnostic.
 *
 * The copy is capped: it exists so a killed run can name what never reported, and a suite log large
 * enough to matter here is already a signal on its own.
 */
const CAP = 32 * 1024 * 1024;
let seen = '';
const keep = (chunk) => {
  if (seen.length < CAP) seen += chunk;
  return chunk;
};
child.stdout.on('data', (d) => process.stdout.write(keep(d.toString())));
child.stderr.on('data', (d) => process.stderr.write(keep(d.toString())));

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.log(`\n!! 超过 ${limitWords} 仍未跑完 —— 判定为卡住，结束它`);
  /*
   * `child.kill()` kills one process. The suites spawn children of their own, and on Windows a
   * terminating process gets no chance to clean up — so the tree has to go, or the leftovers keep
   * the memory and the pipes.
   */
  killTree(child.pid);
}, TIMEOUT_MS);

child.on('close', (code) => {
  clearTimeout(timer);

  if (!timedOut) process.exit(code ?? 1);

  /*
   * Name what was still in flight. This is the actionable part of a timeout: "it hung" is not
   * something a reader can act on, and the package that never printed a summary is where to look.
   */
  const stripped = seen.replace(/\u001b\[[0-9;]*m/g, '');
  const expected = packagesWithTests();
  const silent = silentPackages(expected, stripped);
  const reported = expected.length - silent.length;
  console.log(`   没报数的套件（${reported}/${expected.length} 套报了）：`
    + `${silent.length ? silent.join('、') : '无 —— 都报了数，卡在收尾或 pnpm 本身'}`);
  console.log('   注意：这里只说"谁没说完"，判定测试对错的是上一步的退出码与 check:docs');
  process.exit(124);
});

child.on('error', (err) => {
  clearTimeout(timer);
  console.error(`起不来 pnpm -r test：${err.message}`);
  process.exit(1);
});
