#!/usr/bin/env node
/*
 * map-note —— 给地图写标签/注记的命令行（客户模型的第一个刺：只有工具、没有 CLI）。
 *
 * 三种用法，都先校验、再写盘：
 *   node scripts/map-note.mjs --path src/a.ts --kind why --text "为什么这么写"
 *   node scripts/map-note.mjs --label src/a.ts --label-text "会话主逻辑" --what "…" --when "读会话流时"
 *   node scripts/map-note.mjs --json notes.json          # [{path,label,what,when,kind,text}, …]
 *   node scripts/map-note.mjs --json notes.json --dry     # 只报告会写什么，不改盘
 *
 * 批量文件也支持 TSV：每行 `path<TAB>label<TAB>what<TAB>when`（以 # 开头的行忽略）。
 * 批量里单条失败不会中断整批 —— 逐条报告 ok/失败原因，最后给总数。
 */
import { readFileSync } from 'node:fs';
import { annotate, mapNote, gitIn } from '../packages/map/dist/index.js';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const root = process.cwd();
const dry = has('dry');
const jsonFile = arg('json');

/** 单条：注记（kind + text），或标签（label-text/what/when 任一）。 */
function runSingle() {
  const path = arg('path');
  if (!path) return fail('缺少 --path');
  const kind = arg('kind');
  const text = arg('text');
  const label = arg('label-text');
  const what = arg('what');
  const when = arg('when');

  if (kind || text) {
    if (!kind || !text) return fail('注记需要 --kind 与 --text 同时给');
    if (dry) {
      console.log(`[dry] 注记 [${kind}] ${path}: ${text}`);
      return 0;
    }
    const note = mapNote(root, { path, kind, text });
    console.log(`✓ 注记 [${note.kind}] ${note.path}: ${note.text}`);
  }
  if (label || what || when) {
    if (dry) {
      console.log(`[dry] 标签 ${path}: label=${label ?? '(不变)'} what=${what ?? '(不变)'} when=${when ?? '(不变)'}`);
      return 0;
    }
    const res = annotate(root, 'main', { path, label, what, when }, gitIn(root));
    console.log(`✓ 标签 ${res.node.path}: ${res.node.label ?? '(未设置)'}${res.staleBefore ? '（旧标签曾过期，已更新）' : ''}`);
  }
  if (!kind && !text && !label && !what && !when) {
    return fail('什么也没给：用 --kind/--text（注记）或 --label-text/--what/--when（标签）');
  }
  return 0;
}

function parseBatch(text) {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const parsed = JSON.parse(t);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => ({ path: r.path, label: r.label, what: r.what, when: r.when, kind: r.kind, text: r.text }));
  }
  return t
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const [path, label, what, when] = l.split('\t');
      return { path: path?.trim(), label: label?.trim(), what: what?.trim(), when: when?.trim() };
    });
}

function runBatch(file) {
  const rows = parseBatch(readFileSync(file, 'utf8'));
  let ok = 0;
  const failed = [];
  for (const r of rows) {
    if (!r.path) {
      failed.push('(缺 path)');
      continue;
    }
    try {
      if (dry) {
        console.log(`[dry] ${r.path}: ${r.label ?? ''} ${r.what ?? ''} ${r.when ?? ''}`);
        ok += 1;
        continue;
      }
      if (r.label || r.what || r.when) {
        annotate(root, 'main', { path: r.path, label: r.label, what: r.what, when: r.when }, gitIn(root));
      }
      if (r.kind && r.text) mapNote(root, { path: r.path, kind: r.kind, text: r.text });
      ok += 1;
    } catch (err) {
      failed.push(`${r.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`批量${dry ? '（dry）' : ''}：成功 ${ok} / 共 ${rows.length}`);
  if (failed.length) {
    console.log(`失败 ${failed.length}：`);
    for (const f of failed.slice(0, 10)) console.log(`  ${f}`);
    process.exitCode = 1;
  }
  return 0;
}

function fail(msg) {
  console.log(`✗ ${msg}`);
  console.log('用法: map-note --path <p> (--kind <k> --text <t> | --label-text <l> [--what] [--when])');
  console.log('      map-note --json <file> [--dry]');
  process.exitCode = 2;
  return 2;
}

if (jsonFile) runBatch(jsonFile);
else runSingle();
