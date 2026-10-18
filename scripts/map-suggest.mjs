#!/usr/bin/env node
/*
 * map-suggest —— 批量初筛：**只输出候选，不写盘**。
 *
 * 客户模型的原话："08_TESTS 246 条可按测试名/首注释自动起，06_SCRIPTS 同理，模型只审
 * what/when 里写错意图的条目 —— 比逐条手写快一个数量级，且不牺牲准确性。"
 *
 * 做法（全部来自文件内容本身，不猜语义）：
 *   测试文件   → 取 `describe('…')` / `it('…')` 的前 3 条，压成"测什么"；
 *   脚本文件   → 取首行块注释/首行注释的第一句；
 *   TS/JS 源文件 → 取第一个 export 的名字 + 首个块注释首句；
 *   其它       → 只给路径末段（让模型自己补）。
 *
 * 输出是 map-note --json 能吃的格式，审完后：
 *   node scripts/map-suggest.mjs --out .she/tmp/notes.json
 *   node scripts/map-note.mjs --json .she/tmp/notes.json --dry   # 先看
 *   node scripts/map-note.mjs --json .she/tmp/notes.json         # 再写
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readIndex, readShard } from '../packages/map/dist/index.js';

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
}
const root = process.cwd();
const outFile = arg('out');
const limit = Number(arg('limit', 0)) || Infinity;
const only = arg('path'); // 只处理某个子树

const index = readIndex(root);
if (!index) {
  console.log('还没有地图：先跑 node scripts/map-build.mjs');
  process.exit(2);
}

/** 按行扫描取第一个块注释 / 首行注释的第一句。 */
/** md 文件取第一个一级标题——比"文件里第一句人话"准得多。 */
function firstHeading(text) {
  const m = text.match(/^#\s+(.{2,60})$/m);
  return m ? m[1].trim() : '';
}

function firstDocLine(text) {
  const lines = text.split(/\r?\n/).slice(0, 40);
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('/*')) {
      inBlock = true;
      const rest = line.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim();
      if (rest) return rest.split('。')[0];
      continue;
    }
    if (inBlock) {
      if (line.startsWith('*/')) {
        inBlock = false;
        continue;
      }
      const body = line.replace(/^\*+/, '').trim();
      if (body) return body.split('。')[0];
      continue;
    }
    if (line.startsWith('//')) {
      const body = line.replace(/^\/\/+/, '').trim();
      if (body) return body.split('。')[0];
    }
  }
  return '';
}

function testNames(text) {
  const names = [...text.matchAll(/\b(?:describe|it|test)\(\s*['"`]([^'"`]{2,60})['"`]/g)].map((m) => m[1]);
  return names.slice(0, 3);
}

function exportName(text) {
  const m = text.match(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
  return m ? m[1] : '';
}

const rows = [];
for (const s of index.shards) {
  let shard = null;
  try {
    shard = readShard(root, s.key);
  } catch {
    continue;
  }
  if (!shard) continue;
  for (const node of shard.nodes) {
    if (node.kind !== 'file') continue;
    if (node.label) continue; // 已标注的不覆盖
    if (only && !node.path.startsWith(only)) continue;
    if (rows.length >= limit) break;
    let text = '';
    try {
      text = readFileSync(node.path, 'utf8');
      if (text.length > 200_000) text = text.slice(0, 200_000);
    } catch {
      /* 读不到就只给路径 */
    }
    const isTest = /(^|\/)(__tests__|tests?)\//.test(node.path) || /\.(test|spec)\.[a-z]+$/.test(node.path);
    const base = node.path.split('/').pop() ?? node.path;
    let label = '';
    let what = '';
    if (isTest) {
      const names = testNames(text);
      label = `测试：${base.replace(/\.(test|spec)\.[a-z]+$/, '')}`.slice(0, 16);
      what = names.length ? `覆盖：${names.join('；')}` : firstDocLine(text) || '（未读到 describe/it）';
    } else if (base.endsWith('.mjs') || base.endsWith('.js')) {
      const doc = firstDocLine(text);
      label = (doc || base.replace(/\.m?js$/, '')).slice(0, 16);
      what = doc ? doc : `脚本 ${base}`;
    } else if (base.endsWith('.md')) {
      const h = firstHeading(text);
      if (!h) continue; // 没有标题就不产出（噪声）
      label = h.slice(0, 16);
      what = h;
    } else {
      const doc = firstDocLine(text);
      const ex = exportName(text);
      if (!doc && !ex) continue; // 没有导出也没有注释：没有信号，交给人工
      label = (doc || ex).slice(0, 16);
      what = [ex ? `导出 ${ex}` : '', doc].filter(Boolean).join('；');
    }
    /*
     * 没有信号就不产出候选：把文件名抄进 label 只会制造 600 条噪音，
     * 让模型"审"它们比直接手写还慢。
     */
    rows.push({ path: node.path, label, what, when: '' });
  }
}

const json = JSON.stringify(rows, null, 2);
if (outFile) {
  writeFileSync(outFile, json);
  console.log(`候选 ${rows.length} 条 → ${outFile}`);
  console.log(`下一步：node scripts/map-note.mjs --json ${outFile} --dry   （先看会给什么标签，再决定写不写）`);
} else {
  console.log(json);
}
