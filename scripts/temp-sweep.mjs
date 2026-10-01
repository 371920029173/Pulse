/**
 * 清掉以前各次运行留在系统临时目录里的工作区，并且**先证明自己只删该删的**。
 *
 *   node scripts/temp-sweep.mjs              # 清掉一天以上没动过的 she-*
 *   node scripts/temp-sweep.mjs --hours 1
 *   node scripts/temp-sweep.mjs --dry-run
 *   node scripts/temp-sweep.mjs --no-selftest
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `removeTempDir` 的规则是「清理不算断言，绝不因为清不掉就让检查失败」—— 这条规则是对的，但它只是
 * 一半。它放弃之后没有任何人去清，于是放弃的部分悄悄堆积。2026-09-29 实测 **10429 个目录**：
 * 主力是几个单测文件每次用例都 `mkdtempSync` 一个新工作区却从不删除（`run-trace` 一个文件留下
 * 5264 个、kb 3061 个、反思 1019 个、命令注入 553 个）。那几个文件已经改成用完就删，这里补上另一半：
 * **把以前各轮已经漏下来的清掉**。想知道现在堆了多少：`--dry-run` 会报数字。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT HAS A SELF-TEST
 *
 * 一个会删目录的东西，光「跑起来没报错」不算被验证过。所以它先在系统临时目录里造一个自己的沙盒，
 * 把四个候选**都做成都够旧的**（用 `utimesSync` 把时间往回拨），这样每一条断言只考验一个维度：
 *
 *   1. 带我们前缀、够旧的目录   → 必须删掉（不然这个脚本什么都没干）
 *   2. 带我们前缀、但刚建出来的 → 必须留下（不然会删掉正在跑的那一轮）
 *   3. 不是我们前缀的目录       → 必须留下（不然它会去删别人的临时文件）
 *   4. 带我们前缀的**文件**     → 必须留下（签名说「只删目录」，就得真的只删目录）
 *
 * 第 2 条要单独验一次：把 `olderThanMs` 收到 0，刚才那个「刚建出来」的目录就该被算成够旧 ——
 * 否则说明筛选根本没按年龄走，而是碰巧留下了它。
 *
 * 自测失败会让门禁变红 —— 那时删错东西的风险比不清理大得多，所以干脆什么都不清。**真正的清理永远
 * 不让门禁变红**：删不掉一个临时目录不是失败，删错一个目录才是。
 *
 * 选择规则（因为这是破坏性操作，范围收得很死）：只在系统临时目录里、只删目录、只删 `she-` 前缀、
 * 只删一天以上没被动过的。正在跑的这一轮永远不在候选里。
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepStaleTempDirs, removeTempDir, TEMP_PREFIX } from './lib/temp.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const selfTestOff = args.includes('--no-selftest');
const hoursArg = args.indexOf('--hours');
const hours = hoursArg >= 0 ? Number(args[hoursArg + 1]) : 24;

if (!Number.isFinite(hours) || hours <= 0) {
  console.error(`--hours 需要一个正数，收到：${args[hoursArg + 1]}`);
  process.exit(2);
}

const olderThanMs = hours * 60 * 60 * 1000;

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
  }
};

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

if (dryRun) {
  // Report only, using the same selection rule; nothing is removed.
  const root = tmpdir();
  const cutoff = Date.now() - olderThanMs;
  let candidates = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
    try {
      if (statSync(join(root, entry.name)).mtimeMs <= cutoff) candidates++;
    } catch { /* vanished between readdir and stat */ }
  }
  console.log(`[dry-run] ${root} 下有 ${candidates} 个超过 ${hours} 小时的 ${TEMP_PREFIX}* 目录会被清掉`);
  process.exit(0);
}

// ─── 1. 先证明它只删该删的 ───
if (!selfTestOff) {
  console.log('\n1. 清理范围自测（它要删目录，所以先钉住它不删什么）');
  const scratch = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}temp-sweep-selftest-`));
  const STALENESS_MS = 60 * 60 * 1000;
  try {
    const stale = join(scratch, `${TEMP_PREFIX}stale`);
    const fresh = join(scratch, `${TEMP_PREFIX}fresh`);
    const foreign = join(scratch, 'someone-elses-dir');
    const file = join(scratch, `${TEMP_PREFIX}looks-like-ours`);
    for (const d of [stale, fresh, foreign]) mkdirSync(d, { recursive: true });
    writeFileSync(file, 'this is a file, not a directory\n');

    /*
     * Backdate three of them, so `stale` is the ONLY candidate the age filter can eliminate on its
     * own. Without this, "the foreign directory survived" and "the file survived" would both be
     * true merely because they were young, and the checks would pass even if the prefix test or the
     * directory-only test were missing entirely.
     */
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const p of [stale, foreign, file]) utimesSync(p, old, old);

    const swept = sweepStaleTempDirs({ root: scratch, olderThanMs: STALENESS_MS });
    check('够旧的、带我们前缀的目录被删掉（清理真的在干活）', !existsSync(stale), `还在: ${stale}`);
    check('刚建出来的目录留着（否则会删掉正在跑的那一轮）', existsSync(fresh), `被删了: ${fresh}`);
    check('不是我们前缀的目录不动（不会去删别人的临时文件）', existsSync(foreign), `被删了: ${foreign}`);
    check('带我们前缀的文件不动（签名说只删目录）', existsSync(file), `被删了: ${file}`);
    check(
      `只删了那一个（removed=${swept.removed}, kept=${swept.kept}）`,
      swept.removed === 1 && swept.kept === 1,
      JSON.stringify(swept),
    );

    /*
     * Same directory, no age filter: if it is "young" only because the filter looked at age, then
     * with the filter removed it must be swept. This is what separates "the age check works" from
     * "it happened to survive for another reason".
     */
    const noFilter = sweepStaleTempDirs({ root: scratch, olderThanMs: 0 });
    check('年龄筛选真的在看年龄（阈值收到 0，刚才那个就被清了）',
      !existsSync(fresh) && noFilter.removed === 1, JSON.stringify(noFilter));

    const missing = sweepStaleTempDirs({ root: join(scratch, 'no-such-dir') });
    check('目录不存在时安静地返回 0（不抛错）',
      missing.removed === 0 && missing.kept === 0, JSON.stringify(missing));

    const badRoot = sweepStaleTempDirs({ root: file });
    check('root 指到一个文件时也安静地返回 0（不抛错）',
      badRoot.removed === 0, JSON.stringify(badRoot));
  } finally {
    // The scratch dir carries our prefix, so even if this fails a later run cleans it up.
    removeTempDir(scratch);
    check('自测沙盒自己收拾干净了', !existsSync(scratch), scratch);
  }

  console.log('');
  if (failures) {
    console.log(`${failures} 项失败 —— 清理范围没被证明，所以什么都不清`);
    process.exit(1);
  }
}

// ─── 2. 真的清理（这一步永远不让门禁变红）───
console.log('\n2. 清理以前各轮留下的临时工作区');
const { removed, kept, bytes, root } = sweepStaleTempDirs({ olderThanMs });
console.log(
  `  ${root} 下删除 ${removed} 个（约 ${mb(bytes)} MB），`
  + `保留 ${kept} 个（${hours} 小时内动过，可能正在被别的运行使用）`
);
if (removed === 0 && kept === 0) console.log(`  （没有 ${TEMP_PREFIX}* 目录，无需清理）`);

console.log('');
console.log('临时工作区清理检查通过');
