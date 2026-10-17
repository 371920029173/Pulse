#!/usr/bin/env node
/*
 * map:symbols —— 查一个符号定义在哪、被用了多少次；或者列出某个文件的符号大纲。
 *
 * 用法：
 *   node scripts/map-symbols.mjs allocContext
 *   node scripts/map-symbols.mjs --file packages/shared/src/context-window.ts
 */
import { readSymbols, lookupSymbol, symbolsInFile } from '../packages/map/dist/index.js';

const root = process.cwd();
const table = readSymbols(root);
if (!table) {
  console.log('还没有符号表：先跑 node scripts/map-build.mjs');
  process.exit(0);
}

const args = process.argv.slice(2);
if (args[0] === '--file') {
  const path = (args[1] ?? '').replace(/\\/g, '/');
  const syms = symbolsInFile(table, path);
  console.log(`${path}（${syms.length} 个符号）`);
  for (const s of syms) {
    const mark = s.exported ? '★' : '·';
    console.log(`  ${mark} ${String(s.line).padStart(5)}  ${s.kind.padEnd(9)} ${s.name}  (引用 ${s.refs})`);
  }
} else {
  const name = args[0];
  if (!name) {
    console.log(`符号表：${table.names.length} 个名字｜${table.arena.length} 处定义`);
    process.exit(0);
  }
  const hits = lookupSymbol(table, name);
  if (!hits.length) {
    console.log(`没有符号 ${name}（表里 ${table.names.length} 个名字）`);
  } else {
    console.log(`${name}：${hits[0].refs} 处引用，${hits.length} 处定义`);
    for (const h of hits) console.log(`  ${h.exported ? '★' : '·'} ${h.path}:${h.line}  ${h.kind}`);
  }
}
