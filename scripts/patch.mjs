#!/usr/bin/env node
/*
 * patch —— 给"改自己"用的安全补丁器。
 *
 * 存在的原因（都是这一轮真实踩过的坑）：
 *   · 用 `node -e "...模板串..."` 改源码，cmd 会把 `\``、`${}`、`'` 吃掉 → 改坏文件（4 次）；
 *   · 多点替换里只要有一个锚点没命中，脚本静默什么都不写，而我以为改了（2 次）；
 *   · 改完不校验，直到构建报错才发现（多次）。
 *
 * 所以这个脚本把三件事做成硬性行为：
 *   1. 锚点与替换内容**从文件读**（`--from a.txt --to b.txt`），不经过命令行转义；
 *   2. 每个锚点必须**恰好命中 1 次**，否则整批不写、退出码 1，并打印"命中 0/2 次"；
 *   3. 写回后**重新读一遍**确认新内容在里面；不一致就恢复原文件并报错。
 *
 * 用法：
 *   node scripts/patch.mjs --file src/x.ts --from a.txt --to b.txt [--apply]
 *   不给 --apply 时只做 dry-run（打印将改什么，不写盘）。
 *   多点替换：--from a1.txt --to b1.txt --from a2.txt --to b2.txt
 */
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const argv = process.argv.slice(2);
const file = (() => {
  const i = argv.indexOf('--file');
  return i >= 0 ? argv[i + 1] : undefined;
})();
const apply = argv.includes('--apply');

const pairs = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--from') continue;
  const fromFile = argv[i + 1];
  const toIdx = argv.indexOf('--to', i);
  if (!fromFile || toIdx < 0 || !argv[toIdx + 1]) {
    console.log('✗ 用法错误：每个 --from 必须配一个 --to');
    process.exit(2);
  }
  pairs.push([readFileSync(fromFile, 'utf8'), readFileSync(argv[toIdx + 1], 'utf8')]);
  i = toIdx;
}

if (!file || !pairs.length) {
  console.log('用法: node scripts/patch.mjs --file <目标> --from <锚点文件> --to <替换文件> [--from … --to …] [--apply]');
  process.exit(2);
}

const original = readFileSync(file, 'utf8');
let next = original;
const problems = [];

pairs.forEach(([from, to], idx) => {
  const hits = next.split(from).length - 1;
  if (hits !== 1) {
    problems.push(`第 ${idx + 1} 组：命中 ${hits} 次（必须恰好 1 次）`);
    return;
  }
  next = next.replace(from, to);
});

if (problems.length) {
  console.log(`✗ 整批不写（${file}）：`);
  for (const p of problems) console.log('   ' + p);
  console.log('   提示：锚点要包含足够上下文；一行里混了反引号/引号时，把它们放进 --from 文件更稳。');
  process.exit(1);
}

if (!apply) {
  console.log(`✓ dry-run 通过：${file} 将被替换 ${pairs.length} 处（加 --apply 才写盘）`);
  process.exit(0);
}

/* 写前留一份原文件，写完回读校验；不一致就恢复。 */
const backup = `${file}.patch-backup`;
copyFileSync(file, backup);
writeFileSync(file, next);
const back = readFileSync(file, 'utf8');
const okAll = pairs.every(([, to]) => back.includes(to));
if (!okAll) {
  copyFileSync(backup, file);
  unlinkSync(backup);
  console.log(`✗ 写回校验失败，已恢复原文件：${file}`);
  process.exit(1);
}
unlinkSync(backup);
console.log(`✓ 已写入并回读确认：${file}（${pairs.length} 处）`);
