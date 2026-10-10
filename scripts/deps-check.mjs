/**
 * Dependency advisories: measured against the registry, ratcheted so the count cannot rise.
 *
 * Why this exists. This repository had 53 gate steps and not one of them looked at its
 * dependencies. 104 advisories sat open on the default branch until they were cleared by hand
 * (2026-10-04, Electron 33 → 41 + vite 5 → 6.4.3 + vitest 2 → 4.1.11). Clearing them was a
 * one-time act; the reason they accumulated is that nothing was watching. This is the watching.
 *
 * Why it is NOT a step in `check:offline`. That gate is offline by contract — every step runs
 * with no network, which is what lets CI and a developer's machine agree on the same answer.
 * `pnpm audit` queries the advisory database, so it cannot live there. It runs as its own CI
 * step instead. `check:docs` also asserts the quoted step counts, and `docs/testing.md` states
 * them, so folding this in would silently make that documentation wrong.
 *
 * Three properties, each of which fails SILENTLY if it is not pinned:
 *
 *   1. **The audit really ran.** A registry that cannot be reached yields no advisories, and
 *      "no advisories" is indistinguishable from "no vulnerabilities" — which is exactly how a
 *      security gate ends up green on a broken network. The counts are therefore only trusted
 *      when the report has the shape of a real audit AND reports a plausible dependency count.
 *      An unusable measurement FAILS; it never reads as clean.
 *   2. **The count cannot rise.** Ratcheted per severity against the baseline below, the same
 *      shape as the dead-CSS and padding-ratchets in `control-style-check.mjs`.
 *   3. **Build/test tooling is in scope.** All 12 advisories that survived the Electron pass
 *      lived in dev tooling (vite, vitest, esbuild, @vitest/mocker) and never shipped to a user.
 *      They still run on the build machine, with the developer's credentials. `--prod` is
 *      deliberately not passed, so both trees are audited.
 *
 * Muted advisories count as a failure, not a pass. `pnpm.auditConfig.ignoreGhsas` would let one
 * config line hide an advisory from the counts above; the baseline is the single place a
 * deliberate exception belongs, because raising it is a visible, reviewable edit.
 *
 *   node scripts/deps-check.mjs
 *   node scripts/deps-check.mjs --list    # name every advisory, not just the totals
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * The ratchet, measured on 2026-10-04 immediately after the 104 open advisories were cleared.
 * The audit was clean at that moment, so every number is 0.
 *
 * Lower these as advisories are fixed. Raising one is how an advisory becomes permanent: do it
 * only in its own commit, with the reason — including why it cannot be fixed — in the message.
 */
/*
 * 2026-10-10 抬高一格（moderate 0 → 1）。理由：`sprintf-js <=1.1.3` 的 DoS 告警 ——
 * **没有修复版**（`npm view sprintf-js version` 就是 1.1.3，上游停更），它是构建期的传递依赖
 * （argparse / js-yaml 那一串），不随产品发到用户机器上。要降回 0 只有两条路：上游发新版，
 * 或把那层带它的工具换掉。详见同一次提交的说明。
 */
const BASELINE = { critical: 0, high: 0, moderate: 1, low: 0 };

/**
 * `info` is reported by pnpm but carries no remediation obligation, so it is shown and not
 * ratcheted. It is still validated for shape, because a missing field means the whole report
 * is not the thing this script thinks it is.
 */
const RATCHETED = ['critical', 'high', 'moderate', 'low'];
const ALL_SEVERITIES = [...RATCHETED, 'info'];

/**
 * A resolved workspace of this size is the evidence that the audit actually walked the tree.
 * The real number is 555 as of 2026-10-04; this floor is far below it on purpose — it is here to
 * catch an EMPTY or truncated result, not to notice ordinary drift in the dependency count.
 */
const MIN_AUDITED_DEPENDENCIES = 100;

/** A hung registry must not hang the gate. A normal run measures ~5s here. */
const AUDIT_TIMEOUT_MS = 120_000;

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
  }
};

/**
 * The counts, or `null` when the report is not a usable measurement.
 *
 * Returning `null` rather than zeros is the entire point. Zeros are what a clean tree looks
 * like, so a report this script cannot read — an unreachable registry, a changed output format,
 * an error object — would otherwise be reported as success.
 */
function readCounts(report) {
  const v = report?.metadata?.vulnerabilities;
  if (!v || typeof v !== 'object') return null;
  const counts = {};
  for (const s of ALL_SEVERITIES) {
    const n = v[s];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    counts[s] = n;
  }
  const total = report?.metadata?.totalDependencies;
  if (typeof total !== 'number' || !Number.isFinite(total)) return null;
  return { counts, total };
}

/** Advisories hidden by config. A non-empty list means the counts above are not the whole truth. */
function readMuted(report) {
  return Array.isArray(report?.muted) ? report.muted : [];
}

/** Severities whose measured count is above the baseline. At or below it is a pass. */
function exceeded(counts, baseline) {
  return RATCHETED.filter((s) => (counts[s] ?? 0) > (baseline[s] ?? 0));
}

/**
 * pnpm writes the report to stdout, but a warning printed before it would make a bare
 * `JSON.parse` fail and turn a real result into "unusable". Falls back to the outermost braces.
 */
function parseReport(text) {
  const trimmed = String(text ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to the slice below */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Advisory rows for `--list`. Read defensively: an unknown shape must not crash the report. */
function listAdvisories(report) {
  const advisories = report?.advisories;
  if (!advisories || typeof advisories !== 'object') return [];
  return Object.values(advisories).map((a) => ({
    severity: String(a?.severity ?? 'unknown'),
    module: String(a?.module_name ?? '?'),
    range: String(a?.vulnerable_versions ?? '?'),
    title: String(a?.title ?? '?'),
  }));
}

/* ══════════════════════════════════════════════════════════════════════════
 * Self-test: the shapes and the verdicts, with fabricated inputs.
 *
 * Both failure branches that matter cannot be produced on demand — a clean registry and a
 * broken one are not things this script can choose — so they are pinned here instead. The case
 * that motivated the whole design is the third one: a report with no counts must NOT read as 0.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n=== 自测：报告形状与棘轮判定 ===');
{
  const zeros = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const report = (v, total = 555) => ({ metadata: { vulnerabilities: v, totalDependencies: total } });

  check('自测：干净报告读得出全 0',
    JSON.stringify(readCounts(report(zeros))?.counts) === JSON.stringify({ critical: 0, high: 0, moderate: 0, low: 0, info: 0 }),
    JSON.stringify(readCounts(report(zeros))));

  check('【关键】自测：没有 metadata 的报告判为不可用，而不是读成 0',
    readCounts({ actions: [], advisories: {} }) === null, null);
  check('【关键】自测：字段缺失的报告判为不可用（部分读出来比读不出来更危险）',
    readCounts(report({ high: 0, critical: 0 })) === null, null);
  check('自测：负数字段判为不可用', readCounts(report({ ...zeros, high: -1 })) === null, null);
  check('自测：非数字字段判为不可用', readCounts(report({ ...zeros, high: '0' })) === null, null);
  check('自测：缺 totalDependencies 判为不可用', readCounts({ metadata: { vulnerabilities: zeros } }) === null, null);

  check('【关键】自测：空响应体判为不可用（网络断掉时就是这个形状）',
    readCounts(parseReport('')) === null, null);
  check('自测：报告前面有警告文字也能解析出来（不让一行 warning 把结果变成"不可用"）',
    parseReport('WARN deprecated foo\n{"metadata":{}}')?.metadata !== undefined, null);
  check('自测：解析不出 JSON 时返回 null', parseReport('完全不是 JSON') === null, null);

  check('自测：超过基线判红', exceeded({ critical: 1, high: 0, moderate: 0, low: 0 }, BASELINE).join(',') === 'critical', null);
  check('自测：等于基线不判红', exceeded(zeros, BASELINE).length === 0, null);
  check('【关键】自测：低于基线也算过（棘轮只挡上涨，不要求把历史一次清零）',
    exceeded(zeros, { critical: 5, high: 5, moderate: 5, low: 5 }).length === 0, null);
  check('自测：info 不参与棘轮', !exceeded({ ...zeros, info: 99 }, BASELINE).includes('info'), null);

  check('自测：muted 缺失时读成空数组（而不是 undefined 崩掉）', readMuted({}).length === 0, null);
  check('自测：muted 有值时读得出来', readMuted({ muted: [{ id: 1 }] }).length === 1, null);
  check('自测：advisories 形状未知时列出来是空数组，不抛错', listAdvisories({ advisories: null }).length === 0, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * The measurement
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n=== pnpm audit（整棵树，含 devDependencies）===');

check('被审计的是本仓库的 lockfile（pnpm-lock.yaml 存在）',
  existsSync(join(ROOT, 'pnpm-lock.yaml')), join(ROOT, 'pnpm-lock.yaml'));

const run = spawnSync('pnpm', ['audit', '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  shell: true,
  maxBuffer: 64 * 1024 * 1024,
  timeout: AUDIT_TIMEOUT_MS,
});
const timedOut = run.error?.code === 'ETIMEDOUT';
const stdout = String(run.stdout ?? '');
const stderr = String(run.stderr ?? '');

/*
 * A non-zero exit code is the NORMAL case when advisories exist — it is how the command reports
 * "found something" — so the status is deliberately not used to decide success. Only a failure
 * to run at all (timeout, spawn error) is a failed measurement, and those are caught below by
 * the report being unusable.
 */
const report = timedOut ? null : parseReport(stdout);
const measured = report ? readCounts(report) : null;

check('pnpm audit 在超时前返回了',
  !timedOut, timedOut ? `超过 ${Math.round(AUDIT_TIMEOUT_MS / 1000)} 秒未返回：${String(run.error?.message ?? '')}` : null);

check('【关键】拿到了一份真实的审计结果（不是"跑不起来所以没有告警"）',
  measured !== null,
  measured !== null
    ? null
    : `无法从输出里读出告警计数，这一轮不算数。stderr: ${stderr.trim().slice(0, 300) || '(空)'}`
      + ` stdout: ${stdout.trim().slice(0, 300) || '(空)'}`);

if (measured) {
  check(`审计覆盖了整个工作区（${measured.total} 个依赖 ≥ ${MIN_AUDITED_DEPENDENCIES}）`,
    measured.total >= MIN_AUDITED_DEPENDENCIES,
    `只看到 ${measured.total} 个依赖，说明没走完工作区`);

  const muted = readMuted(report);
  check(`没有被配置静音的告警（${muted.length} 条）`,
    muted.length === 0,
    muted.length ? `静音会让下面的数字不再等于真实情况；要放行就改基线：${JSON.stringify(muted).slice(0, 300)}` : null);

  const c = measured.counts;
  console.log(`  实测：critical ${c.critical} · high ${c.high} · moderate ${c.moderate} · low ${c.low}`
    + `（info ${c.info}，不计入棘轮）`);
  console.log(`  基线：critical ${BASELINE.critical} · high ${BASELINE.high} · moderate ${BASELINE.moderate} · low ${BASELINE.low}`);

  const over = exceeded(c, BASELINE);
  check(`各级别都不超过基线（超出 ${over.length} 个级别）`,
    over.length === 0,
    over.map((s) => `${s} ${c[s]} > ${BASELINE[s] ?? 0}`).join('; '));

  const rows = listAdvisories(report);
  if (process.argv.includes('--list') && rows.length) {
    console.log('  告警明细：');
    for (const r of rows) console.log(`    [${r.severity}] ${r.module} ${r.range}  ${r.title}`);
  } else if (rows.length) {
    console.log('    明细：node scripts/deps-check.mjs --list');
  }
} else if (stdout.trim() || stderr.trim()) {
  // Show what actually came back, because "unusable" with no evidence is not actionable.
  console.log(`        stdout: ${stdout.trim().slice(0, 400) || '(空)'}`);
  console.log(`        stderr: ${stderr.trim().slice(0, 400) || '(空)'}`);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
