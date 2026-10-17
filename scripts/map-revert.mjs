#!/usr/bin/env node
/*
 * map:revert —— 局部回退，两步走。
 *
 *   第一步（只看不动）：node scripts/map-revert.mjs --path src/a.ts --rev <rev>
 *       打印计划：每个文件 +/- 行数、是否脏、目标 rev 里是否存在；有阻断项就到此为止，
 *       并给出票据 token（只对这份计划有效、一次一票）。
 *   第二步（真正动手）：加 --confirm <token>
 *       顺序是硬性的：验票 → 重算计划哈希 → 拍快照 → git restore。
 *
 * 工作区有未提交改动的文件默认阻断：git restore 会覆盖它，那是不可恢复的。
 */
import { planRevert, createTicket, executeRevert } from '../packages/map/dist/index.js';

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function list(name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1].replace(/\\/g, '/'));
  }
  return out;
}

const rev = arg('rev');
const paths = list('path');
const confirm = arg('confirm');
const allowDirty = argv.includes('--allow-dirty');

if (!rev || paths.length === 0) {
  console.log('用法: node scripts/map-revert.mjs --path <p> [--path <p2>] --rev <rev> [--confirm <token>] [--allow-dirty]');
  process.exit(2);
}

const plan = planRevert(process.cwd(), { rev, paths, allowDirty });

console.log(`计划：回退到 ${rev}，涉及 ${plan.entries.length} 个文件（planHash ${plan.planHash}）`);
for (const e of plan.entries) {
  const plus = e.added >= 0 ? `+${e.added}` : '+?';
  const minus = e.removed >= 0 ? `-${e.removed}` : '-?';
  console.log(
    `  ${e.path}  ${plus}/${minus}  ${e.dirty ? '工作区有未提交改动' : '干净'}  ${e.existsInRev ? '' : '目标 rev 中不存在'}`,
  );
}

if (plan.blockers.length) {
  console.log(`\n阻断（${plan.blockers.length}）：`);
  for (const b of plan.blockers) console.log(`  ✗ ${b}`);
  console.log('\n不执行。要回退干净版本先提交或 stash 自己的改动。');
  process.exit(1);
}

if (!confirm) {
  const token = createTicket(process.cwd(), plan);
  console.log(`\n票据：${token}`);
  console.log(`确认执行：node scripts/map-revert.mjs --path ${paths[0]} --rev ${rev} --confirm ${token}`);
  process.exit(0);
}

const res = executeRevert(process.cwd(), plan, confirm);
console.log(`\n已回退：${res.restored.length} 个恢复，${res.deleted.length} 个删除`);
console.log(`快照：.she/map/snapshots/${res.snapshotId}（回退前的原文在这里）`);
