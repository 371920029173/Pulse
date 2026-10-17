#!/usr/bin/env node
/*
 * map —— 给模型用的查询面（命令行版，和将来注册成工具的是同一份实现）。
 *
 *   node scripts/map-query.mjs tree [--budget 2000] [--depth 6]
 *   node scripts/map-query.mjs lookup <路径>
 *   node scripts/map-query.mjs whereis "上传失败重试"
 *   node scripts/map-query.mjs impact <路径…>
 *   node scripts/map-query.mjs note <路径> <pitfall|invariant|why|todo|deadend> <文字>
 *   node scripts/map-query.mjs diff [路径…]
 */
import { mapTree, mapLookup, mapWhereis, mapImpact, mapNote, mapDiff, mapScope, mapContracts, mapVerify } from '../packages/map/dist/index.js';

const [cmd, ...rest] = process.argv.slice(2);
const root = process.cwd();
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? Number(rest[i + 1]) : dflt;
};
const positional = rest.filter((r, i) => !r.startsWith('--') && !(i > 0 && rest[i - 1]?.startsWith('--')));

switch (cmd) {
  case 'tree': {
    const res = mapTree(root, { budgetTokens: flag('budget', 2000), depth: flag('depth', 6) });
    console.log(res.text);
    console.log(`\n(${res.files} 文件｜${res.tokens} token｜折叠 ${res.collapsed} 个目录)`);
    break;
  }
  case 'lookup': {
    const res = mapLookup(root, positional[0] ?? '');
    console.log(res.text);
    break;
  }
  case 'whereis': {
    const res = mapWhereis(root, positional.join(' '));
    console.log(`查询「${positional.join(' ')}」｜扫描 ${res.scanned} 节点｜展开 ${res.shardsExpanded} 分片｜${res.ms}ms`);
    for (const h of res.hits) console.log(`  ${h.score.toFixed(1).padStart(5)}  ${h.path}  ${h.label ?? ''}  ${h.reasons.slice(0, 2).join('；')}`);
    if (!res.hits.length) console.log('  (没有命中：标签密度还低，先跑 map:build 或补标注)');
    break;
  }
  case 'impact': {
    console.log(mapImpact(root, positional).text);
    break;
  }
  case 'scope': {
    const res = mapScope(root, positional.join(' '), { maxFiles: flag('max', 60), hops: flag('hops', 1) });
    console.log(res.text);
    console.log(`\n(${res.files.length} 个文件｜${res.tokens} token｜${res.ms}ms)`);
    break;
  }
  case 'verify': {
    const r = mapVerify(root);
    console.log(r.text);
    process.exitCode = r.score >= 60 ? 0 : 1;
    break;
  }
  case 'contracts': {
    console.log(mapContracts(root).text);
    break;
  }
  case 'note': {
    const [path, kind, ...text] = positional;
    if (!path || !kind || !text.length) {
      console.log('用法: note <路径> <pitfall|invariant|why|todo|deadend> <文字>');
      process.exit(2);
    }
    const note = mapNote(root, { path, kind, text: text.join(' ') });
    console.log(`已记 [${note.kind}] ${note.path}: ${note.text}`);
    break;
  }
  case 'diff': {
    console.log(mapDiff(root, positional));
    break;
  }
  default:
    console.log('用法: node scripts/map-query.mjs <tree|lookup|whereis|impact|note|diff> …');
    process.exit(2);
}
