/*
 * 地图自动打标：让 whereis（"我想改 X 在哪"）真的能用。
 *
 * 现状（map_verify 实测）：551 个文件、**0 个标签**，所以意图检索完全不可用，只能按路径匹配 ——
 * 这就是"地图很少用"的真原因：不是它不好用，是最有用的那个入口一直空转。
 *
 * 做法：标签不靠人写，从**导出符号**机械生成：
 *   label  = 前两个导出符号名（≤16 字符，与 store 的限制一致）
 *   what   = 目录 + 语言 + 符号数的短描述
 * 机械标签不如人写的好，但它在"零"和"能用"之间 —— 而零是现在。
 *
 * 只给**没有标签**的文件写，不覆盖任何手工标注。
 */
import { gitIn, loadAll, annotate } from '../packages/map/dist/index.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const DRY = process.argv.includes('--dry');

const loaded = loadAll(root);
const index = loaded.index;
if (!index) {
  console.log('地图还没建：先跑一次任何 map_* 工具或 node scripts/map-query.mjs tree');
  process.exit(0);
}
const branch = index.branch;
const nodes = loaded.nodes.filter((n) => n.branch === branch);
const unlabeled = nodes.filter((n) => !n.label);

/* 符号名字来自索引里已有的符号表；没有符号的文件用目录名兜底。 */
const symbolsByPath = new Map();
for (const s of loaded.symbols ?? []) {
  const list = symbolsByPath.get(s.path) ?? [];
  list.push(s.name);
  symbolsByPath.set(s.path, list);
}

function labelFor(node) {
  const syms = (symbolsByPath.get(node.path) ?? []).filter((n) => n && /^[A-Za-z_$][\w$]*$/.test(n));
  if (syms.length) return [...syms.slice(0, 2).join('/')].slice(0, 16).join('');
  const base = String(node.path).split('/').pop() ?? node.path;
  const stripped = base.replace(/\.[a-z0-9]+$/i, '').replace(/^\.+/, '');
  return [...(stripped || 'root')].slice(0, 16).join('');
}

function whatFor(node) {
  const dir = String(node.path).split('/').slice(0, -1).join('/') || '.';
  const syms = (symbolsByPath.get(node.path) ?? []).length;
  const ext = (String(node.path).match(/\.([a-z0-9]+)$/i) ?? [])[1] ?? 'file';
  return `${dir} 下的 ${ext} 文件${syms ? `，导出/定义 ${syms} 个符号` : ''}`;
}

const git = gitIn(root);
let written = 0;
let failed = 0;
for (const node of unlabeled.slice(0, 700)) {
  const label = labelFor(node);
  const what = whatFor(node);
  if (DRY) {
    if (written < 8) console.log(`${node.path}  →  ${label} ｜ ${what}`);
    written += 1;
    continue;
  }
  try {
    annotate(root, branch, { path: node.path, label, what }, git);
    written += 1;
  } catch (err) {
    failed += 1;
    if (failed <= 3) console.log(`✗ ${node.path}: ${String(err).slice(0, 80)}`);
  }
}

console.log(`\n${DRY ? '（干跑）' : ''}待标 ${unlabeled.length} 个，已写 ${written}，失败 ${failed}`);
