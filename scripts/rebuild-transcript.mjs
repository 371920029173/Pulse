/*
 * 修 rebuild-transcript：compacted/ 里的文件是**同一条对话的不同快照**（都在 35k→39k 条增长，
 * 每条第一行都是同一条 user 消息），所以把它们拼起来会把内容重复 5 遍（上次就是 183,658 条 =
 * 35k+36k+36k+37k+39k）。
 *
 * 正确做法：
 *   · 默认只取**最大/最新**的那一份（= 完整原文）；
 *   · 若给了 --all，则按快照顺序输出并**标出每份的增量区间**（只写新增的部分）；
 *   · 额外产出索引文件（偏移 + 角色 + 摘要），让 60MB 的文件能按区间跳读。
 */
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const wsArg = process.argv[2];
const sessId = process.argv[3];
const all = process.argv.includes('--all');
if (!wsArg || !sessId) {
  console.log('用法: node scripts/rebuild-transcript.mjs <工作区> <会话 id> [--all]');
  process.exit(2);
}

const sessDir = join(wsArg, '.she', 'sessions', sessId);
const compactedDir = join(sessDir, 'compacted');
if (!existsSync(compactedDir)) {
  console.log(`没有压缩原文目录：${compactedDir}`);
  process.exit(1);
}

/** 读一个 .jsonl（可能是单行巨型数组，也可能每行一条）。返回消息数组。 */
function readMessages(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  const lines = text.split(/\r?\n/);
  let parsedAny = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    parsedAny = true;
    if (Array.isArray(v)) out.push(...v);        // 单行数组
    else if (v && Array.isArray(v.messages)) out.push(...v.messages);
    else out.push(v);
  }
  if (!parsedAny) {
    /* 整个文件是一个 JSON（可能跨行） */
    try {
      const v = JSON.parse(text);
      if (Array.isArray(v)) out.push(...v);
      else if (v && Array.isArray(v.messages)) out.push(...v.messages);
    } catch { /* 放弃 */ }
  }
  return out.filter((m) => m && typeof m === 'object');
}

const files = readdirSync(compactedDir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, size: statSync(join(compactedDir, f)).size }))
  .sort((a, b) => a.size - b.size);

const outDir = join(wsArg, '.she', 'transcripts');
mkdirSync(outDir, { recursive: true });

/* 默认取最大的一份 = 最完整的快照；--all 时按大小顺序输出并标增量。 */
const chosen = all ? files : [files[files.length - 1]];

const md = [`# 会话 ${sessId} 的完整档案`, ''];
const txt = [];
const idx = ['# 索引：行号\t角色\t字符数\t预览', ''];
let total = 0;
let done = 0;   /* --all 时：已经写过多少条，用于标增量 */

for (const { f, size } of chosen) {
  const msgs = readMessages(join(compactedDir, f));
  const startAt = all ? Math.min(done, msgs.length) : 0;
  md.push(`## ${f}（${(size / 1024 / 1024).toFixed(1)} MB，共 ${msgs.length} 条${all && startAt ? `，本份新增 ${msgs.length - startAt} 条` : ''}）`, '');
  for (let i = startAt; i < msgs.length; i += 1) {
    const m = msgs[i];
    const role = m.role ?? '?';
    const content = String(m.content ?? '');
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c?.function?.name).filter(Boolean) : [];
    total += 1;
    const head = calls.length ? `${role}〔调用 ${calls.join(',')}〕` : role;
    md.push(`### [${total}] ${head}`, '', content, '');
    txt.push(`--- [${total}] ${head} ---`, content, '');
    if (i % 50 === 0) {
      idx.push(`${total}\t${head}\t${content.length}\t${content.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
  done = Math.max(done, msgs.length);
}

const mdPath = join(outDir, `${sessId}-full.md`);
const txtPath = join(outDir, `${sessId}-full.txt`);
const idxPath = join(outDir, `${sessId}-index.tsv`);
writeFileSync(mdPath, md.join('\n'), 'utf8');
writeFileSync(txtPath, txt.join('\n'), 'utf8');
writeFileSync(idxPath, idx.join('\n'), 'utf8');

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`快照 ${files.length} 份，本次用 ${chosen.length} 份（${all ? '按增量' : '取最完整的一份'}）`);
console.log(`消息 ${total} 条 → md ${mb(mdPath)}MB / txt ${mb(txtPath)}MB / 索引 ${mb(idxPath)}MB`);
console.log(mdPath);
