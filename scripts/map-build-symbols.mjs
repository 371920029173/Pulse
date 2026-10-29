/*
 * 建符号表（一次性，纯离线）。
 *
 * 实测：`.she/map/symbols.json` 只有 72 字节（names=0 / arena=0）—— 符号表从来没建过。
 * 这解释了 whereis 为什么对符号名和中文都匹配不到：它手里只有文件名。
 *
 * 输入用 git ls-files 拿文件列表（与建图同一来源），按扩展名判语言。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildSymbols, writeSymbols } from '../packages/map/dist/index.js';

const root = process.cwd();
const raw = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const paths = raw.split(/\r?\n/).filter(Boolean);

const LANG = {
  ts: 'ts', tsx: 'ts', js: 'js', mjs: 'js', cjs: 'js',
  py: 'py', go: 'go', rs: 'rs', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp',
  java: 'java', kt: 'kt', rb: 'rb', php: 'php',
};
const files = [];
for (const p of paths) {
  const ext = (p.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase();
  const lang = ext ? LANG[ext] : undefined;
  if (lang) files.push({ path: p, lang });
}

const table = buildSymbols({ root, files });
writeSymbols(root, table);
console.log(`扫描 ${files.length} 个文件 → 符号表 names=${table.names.length} arena=${table.arena.length}`);
void join;
