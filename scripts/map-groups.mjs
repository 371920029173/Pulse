#!/usr/bin/env node
/*
 * map:groups —— 看一个路径属于哪些组、挂着哪些知识（含祖先冒泡）。
 *
 * 用法：node scripts/map-groups.mjs [路径]
 * 这是排查工具，不是给模型用的接口（模型的接口在 P5 的 map_lookup 里）。
 */
import { readIndex, deriveGroups, kbLinksFor } from '../packages/map/dist/index.js';

const path = (process.argv[2] ?? 'packages/ui/src/components/Chat.tsx').replace(/\\/g, '/');
const root = process.cwd();
const index = readIndex(root);

console.log(`路径 ${path}`);
console.log(`分支 ${index?.branch ?? '(未建图)'}｜形态 ${index?.views?.primary ?? '?'}`);

const groups = deriveGroups(path, index?.views);
console.log(`组（${groups.length}）:`);
for (const g of groups) console.log(`  ${g}`);

const links = kbLinksFor(root, index?.branch ?? 'main', path);
if (!links.length) {
  console.log('相关组结构知识：（暂无绑定；P5 起由 map_lookup 在干活时写入）');
} else {
  console.log(`相关组结构知识（${links.length}）:`);
  for (const l of links) {
    const mark = l.confidence === 'certain' ? '★' : '○';
    const from = l.fromAncestor ? `（来自上层 ${l.via}）` : '';
    console.log(`  ${mark} ${l.kbGroup} · ${l.title}${from}`);
  }
}
