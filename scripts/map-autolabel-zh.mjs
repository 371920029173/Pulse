/*
 * 让中文查询也能命中：把文件里**第一段中文注释/字符串**塞进 what。
 *
 * 现状：标签是符号名（英文），所以 `planRecall` 能命中而「召回 路由」不能 —— 而用户是用中文问的。
 * 中文 bigram 匹配依赖 hay 里真的有中文；代码里的中文注释恰好是最现成的来源。
 *
 * 只取前 4KB 里最长的连续中文片段（4–16 字），追加到 what 末尾。不改已有 what 的前半段。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gitIn, loadAll, annotate } from '../packages/map/dist/index.js';
import { join } from 'node:path';

const root = process.cwd();
const refresh = process.argv.includes('--refresh');

const loaded = loadAll(root);
const index = loaded.index;
if (!index) {
  console.log('地图还没建');
  process.exit(0);
}
const branch = index.branch;
const nodes = loaded.nodes.filter((n) => n.branch === branch && n.kind === 'file');

function firstChinese(abs) {
  try {
    if (!existsSync(abs)) return '';
    const text = readFileSync(abs, 'utf8').slice(0, 4096);
    const runs = text.match(/[\u4e00-\u9fff，。、；：（）]{4,16}/g) ?? [];
    if (!runs.length) return '';
    return runs.sort((a, b) => b.length - a.length)[0].replace(/[，。、；：（）]/g, '').slice(0, 16);
  } catch {
    return '';
  }
}

const git = gitIn(root);
let touched = 0;
for (const node of nodes) {
  const hasLabel = Boolean(node.label);
  /* 默认只补缺标签的；--refresh 时也更新"自动生成"的（没有手工 when 的） */
  if (hasLabel && !refresh) continue;
  if (hasLabel && refresh && node.when) continue;

  const zh = firstChinese(join(root, node.path));
  if (!zh) continue;
  const what = node.what ? `${node.what}；${zh}` : zh;
  const label = node.label ?? [...(zh || 'file')].slice(0, 16).join('');
  try {
    annotate(root, branch, { path: node.path, label, what }, git);
    touched += 1;
  } catch { /* 单个失败不影响其它文件 */ }
}
console.log(`写了 ${touched} 个文件的 what（其中含中文）`);
