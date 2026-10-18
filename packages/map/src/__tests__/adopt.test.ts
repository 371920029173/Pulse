/*
 * 收编的判据（用户的设计：引用优先 + 写时复制）。
 *
 * 四条不许退让：
 *  ① 收编**不搬正文**：本地分片里只有引用，没有把外部的标签抄进来；
 *  ② 外部只读：收编前后外部工作区的地图文件一个字节都不变；
 *  ③ 改一条才落地：annotate 之后本地有实体、带 derivedFrom、引用消失；
 *  ④ 外部不可达时**明说**，不许静默当成"没有这条知识"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, annotate, adoptFrom, refsOf, readShard, shardKeyFor, mapLookup } from '../index.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-adopt-'));
  const run = (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'a@t']);
  run(['config', 'user.name', 'a']);
  run(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'd', workspaces: ['packages/*'], scripts: {} }));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return dir;
}

const git = (dir: string) => (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

test('收编只写引用：本地不抄正文，外部一个字节不变', () => {
  const src = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  const dst = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  try {
    buildMap({ root: src, branch: 'main' });
    annotate(src, 'main', { path: 'packages/ui/src/a.ts', label: '外部标签', what: '外部说明' }, git(src));
    buildMap({ root: dst, branch: 'main' });

    const before = readFileSync(join(src, '.she/map/index.json'), 'utf8');
    const res = adoptFrom(dst, 'main', src, { localPaths: new Set(['packages/ui/src/a.ts']) });
    assert.equal(res.adopted, 1, '应当收编一条');

    const shard = readShard(dst, shardKeyFor('packages/ui/src/a.ts')) as any;
    assert.equal(shard.refs.length, 1, '写了一条引用');
    const local = shard.nodes.find((n: any) => n.path === 'packages/ui/src/a.ts');
    assert.ok(!local?.label, '本地节点**不应**带上外部标签（没复制正文）');
    assert.equal(readFileSync(join(src, '.she/map/index.json'), 'utf8'), before, '外部只读');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('查询时回外部取；改了才落地并带出处', () => {
  const src = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  const dst = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  try {
    buildMap({ root: src, branch: 'main' });
    annotate(src, 'main', { path: 'packages/ui/src/a.ts', label: '外部标签', what: '外部说明' }, git(src));
    buildMap({ root: dst, branch: 'main' });
    adoptFrom(dst, 'main', src, { localPaths: new Set(['packages/ui/src/a.ts']) });

    const looked = mapLookup(dst, 'packages/ui/src/a.ts');
    assert.ok(looked.text.includes('外部收编'), '查询时应当说明这是外部收编来的');
    assert.ok(looked.text.includes('外部标签'), '要回外部取到标签');

    /* 写时复制：现在改它 */
    annotate(dst, 'main', { path: 'packages/ui/src/a.ts', label: '本地改名' }, git(dst));
    const shard = readShard(dst, shardKeyFor('packages/ui/src/a.ts')) as any;
    const node = shard.nodes.find((n: any) => n.path === 'packages/ui/src/a.ts');
    assert.equal(node.label, '本地改名');
    assert.ok(node.derivedFrom?.from === src, '要记下出处');
    assert.equal(shard.refs?.length ?? 0, 0, '落地之后引用要删掉');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('外部不可达：明说"取不到"，不静默消失', () => {
  const src = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  const dst = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  try {
    buildMap({ root: src, branch: 'main' });
    annotate(src, 'main', { path: 'packages/ui/src/a.ts', label: '外部标签' }, git(src));
    buildMap({ root: dst, branch: 'main' });
    adoptFrom(dst, 'main', src, { localPaths: new Set(['packages/ui/src/a.ts']) });

    /* 模拟外部工作区被删 */
    rmSync(join(src, '.she'), { recursive: true, force: true });
    const looked = mapLookup(dst, 'packages/ui/src/a.ts');
    assert.ok(looked.text.includes('外部') && /取不到|不可用/.test(looked.text), '要明说取不到');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('路径对不上的进 unmatched，不按文件名猜', () => {
  const src = repo({ 'old/a.ts': 'export const a = 1;\n' });
  const dst = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  try {
    buildMap({ root: src, branch: 'main' });
    annotate(src, 'main', { path: 'old/a.ts', label: '外部标签' }, git(src));
    buildMap({ root: dst, branch: 'main' });

    const noMap = adoptFrom(dst, 'main', src, { localPaths: new Set(['packages/ui/src/a.ts']) });
    assert.equal(noMap.adopted, 0);
    assert.deepEqual(noMap.unmatched, ['old/a.ts'], '对不上就列出来');

    const mapped = adoptFrom(dst, 'main', src, {
      prefix: { old: 'packages/ui/src' },
      localPaths: new Set(['packages/ui/src/a.ts']),
    });
    assert.equal(mapped.adopted, 1, '给了映射才对上');
    assert.equal(refsOf(dst, 'main', 'packages/ui/src/a.ts').length, 1);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});
