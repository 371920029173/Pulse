/*
 * 查询面的判据。
 *
 * 每条都对着"模型用起来会怎么坏"：
 *  ① 树超预算不折叠 → 十万文件一次塞爆上下文；
 *  ② 折叠把热目录折了 → 反而看不到该看的；
 *  ③ whereis 扫全图 → 10 万文件下变成秒级卡顿；
 *  ④ impact 只给一层 → 改共享工具函数时漏掉间接调用方；
 *  ⑤ 过期标签不加警告 → 模型把旧描述当新事实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMap, annotate, mapTree, mapLookup, mapWhereis, mapImpact, mapNote, gateFor, scanImports, deriveGroups,
} from '../index.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-q-'));
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'q@t']);
  run(['config', 'user.name', 'q']);
  run(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', workspaces: ['packages/*', 'upload', 'src', 'mod0'], scripts: { 'check:ui': 'x', 'check:docs': 'y', 'check:offline': 'z' } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return dir;
}

const git = (dir: string) => (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

test('map_tree：一眼看到底，带标签；超预算时折叠冷目录', () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 60; i += 1) many[`cold${i}/f${i}.ts`] = `export const v${i} = ${i};\n`;
  many['hot/core.ts'] = 'export function coreThing() {}\n';
  const dir = repo(many);
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'hot/core.ts', label: '核心入口', what: '所有调用都走这里' }, git(dir));

    const full = mapTree(dir, { budgetTokens: 100000, depth: 3 });
    assert.ok(full.text.includes('核心入口'), '标签要出现在树里');
    assert.equal(full.collapsed, 0, '预算足够时不该折叠');

    const tiny = mapTree(dir, { budgetTokens: 200, depth: 3 });
    assert.ok(tiny.tokens <= 200 * 1.4, `折叠后仍应接近预算（实际 ${tiny.tokens}）`);
    assert.ok(tiny.collapsed > 0, '必须真的折叠了东西');
    assert.ok(tiny.text.includes('已折叠'), '折叠结果要有一行汇总，不能静默丢掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map_lookup：标签 + 组 + 符号 + 注记 + 过期警告', () => {
  const dir = repo({ 'src/a.ts': 'export function alpha() {}\n' });
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'src/a.ts', label: '示例模块', what: '演示', when: '看导出时' }, git(dir));
    mapNote(dir, { path: 'src/a.ts', kind: 'pitfall', text: '改这里前先看 alpha 的调用方' });

    const res = mapLookup(dir, 'src/a.ts');
    assert.equal(res.found, true);
    assert.equal(res.stale, false);
    assert.ok(res.text.includes('示例模块'));
    assert.ok(res.text.includes('何时读'));
    assert.ok(res.text.includes('pitfall'), '注记要出现在查询结果里');
    assert.ok(res.text.includes('alpha'), '符号大纲要在');
    assert.ok(res.groups.some((g) => g.startsWith('dir:src')), '组要带出来');

    // 内容一变，标签必须被判过期并明说
    writeFileSync(join(dir, 'src/a.ts'), 'export function alpha() { return 1; }\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'change'], { cwd: dir });
    buildMap({ root: dir, branch: 'main' });
    const after = mapLookup(dir, 'src/a.ts');
    assert.equal(after.stale, true);
    assert.ok(after.text.includes('更早版本'), '过期必须明说，不许静默');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map_whereis：两级收窄，扫描量有上限', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) files[`mod${i}/x${i}.ts`] = `export const n${i} = ${i};\n`;
  files['upload/retry.ts'] = 'export function retryUpload() {}\n';
  const dir = repo(files);
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'upload/retry.ts', label: '上传重试', what: '上传失败时的退避重试' }, git(dir));

    const res = mapWhereis(dir, '上传失败重试');
    assert.ok(res.hits.length > 0, '标签命中必须能找回来');
    assert.equal(res.hits[0]!.path, 'upload/retry.ts');
    assert.ok(res.scanned <= 2000, `扫描量必须受控（实际 ${res.scanned}）`);
    assert.ok(res.shardsExpanded <= 3, `只展开前 3 个分片（实际 ${res.shardsExpanded}）`);
    assert.ok(res.ms < 500, `查询不能慢（实际 ${res.ms}ms）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map_impact：反向 import 闭包 + 闸门映射 + 相关测试', () => {
  const dir = repo({
    'packages/ui/src/core.ts': 'export const x = 1;\n',
    'packages/ui/src/uses.ts': "import { x } from './core.js';\nexport const y = x;\n",
    'packages/ui/src/__tests__/core.test.ts': "import { x } from '../core.js';\n",
    'docs/a.md': '# doc\n',
  });
  try {
    buildMap({ root: dir, branch: 'main' });
    const res = mapImpact(dir, ['packages/ui/src/core.ts']);
    assert.ok(res.reverse.includes('packages/ui/src/uses.ts'), '一层反向依赖必须找到');
    assert.ok(res.gates.some((g) => g.check === 'check:ui'), 'UI 路径要映射到 check:ui');
    assert.ok(
      res.gates.some((g) => g.check === 'check:ui' && g.exists),
      'package.json 里存在的 check 要标 exists=true',
    );
    assert.ok(
      res.gates.some((g) => !g.exists),
      '不存在的 check 必须标 exists=false —— 表过期了也要让模型看出来',
    );

    const doc = mapImpact(dir, ['docs/a.md']);
    assert.ok(doc.gates.some((g) => g.check === 'check:docs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanImports：只认相对路径，解析不到的记账但不建边', () => {
  const dir = repo({
    'a.ts': "import { b } from './b.js';\nimport fs from 'node:fs';\nimport { z } from '@she/shared';\nimport { q } from './missing.js';\n",
    'b.ts': 'export const b = 1;\n',
  });
  try {
    const res = scanImports(dir, [{ path: 'a.ts', lang: 'ts' }, { path: 'b.ts', lang: 'ts' }]);
    assert.deepEqual(res.edges.map((e) => e.edge.to), ['b.ts'], '只有仓内相对路径才建边');
    assert.equal(res.unresolved, 1, '相对但解析不到的会计数');
    assert.equal(res.edges[0]!.edge.confidence, 'certain');
    assert.ok(res.edges[0]!.edge.evidence[0]!.includes('a.ts:1'), '证据要指到具体行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gateFor：没命中规则的路径兜底到全量门禁', () => {
  const dir = repo({ 'weird/file.bin': 'x' });
  try {
    const hits = gateFor(dir, ['weird/file.bin']);
    assert.equal(hits[0]!.check, 'check:offline');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveGroups 与 package 视角一致（回归：组不能凭空）', () => {
  const dir = repo({ 'packages/ui/package.json': '{"name":"@x/ui"}', 'packages/ui/src/a.ts': 'export const a=1;\n' });
  try {
    buildMap({ root: dir, branch: 'main' });
    const res = mapLookup(dir, 'packages/ui/src/a.ts');
    assert.ok(res.groups.includes('pkg:@x/ui'), `包轴要生效（实际 ${res.groups.join(',')}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
