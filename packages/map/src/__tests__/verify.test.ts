/*
 * map_verify 的判据。
 *
 * 这一组测的不是"分数算得准不准"（那是个拍出来的权重），而是**每一项统计有没有说谎**：
 * 过期率、黑暗角落、悬空边、孤立注记、坏分片 —— 每一项都要能用具体文件复现出来。
 * 一个报错方向反了的治理工具，比没有治理更坏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, annotate, mapVerify, mapNote } from '../index.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-verify-'));
  const run = (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'v@t']);
  run(['config', 'user.name', 'v']);
  run(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'd', workspaces: ['packages/*'], scripts: { 'check:offline': 'x' } }));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return dir;
}

const git = (dir: string) => (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

test('没有地图时明确说没有，不编分数', () => {
  const dir = repo({ 'a.ts': 'export const a = 1;\n' });
  try {
    const r = mapVerify(dir);
    assert.equal(r.score, 0);
    assert.ok(r.text.includes('还没有地图'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('统计真实：黑暗角落 = 未标注文件数；补标注后下降', () => {
  const dir = repo({
    'packages/ui/src/a.ts': 'export const a = 1;\n',
    'packages/ui/src/b.ts': 'export const b = 1;\n',
  });
  try {
    buildMap({ root: dir, branch: 'main' });
    const before = mapVerify(dir);
    assert.ok(before.files >= 2, `至少两个源文件（实际 ${before.files}）`);
    assert.equal(before.darkFiles, before.files, '一个都没标注时，黑暗角落 = 全部文件');
    assert.equal(before.labels, 0);

    annotate(dir, 'main', { path: 'packages/ui/src/a.ts', label: '示例 A' }, git(dir));
    const after = mapVerify(dir);
    assert.equal(after.labels, 1);
    assert.equal(after.darkFiles, before.darkFiles - 1, '标注一个之后黑暗角落正好少一个');
    assert.ok(after.score >= before.score, '补标注不该让分数变低');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('统计真实：内容一变，过期率上去、分数下来，并列出最该补的文件', () => {
  const dir = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'packages/ui/src/a.ts', label: '示例 A' }, git(dir));
    const clean = mapVerify(dir);
    assert.equal(clean.staleLabels, 0);

    writeFileSync(join(dir, 'packages/ui/src/a.ts'), 'export const a = 2;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'change'], { cwd: dir });
    buildMap({ root: dir, branch: 'main' });

    const dirty = mapVerify(dir);
    assert.equal(dirty.staleLabels, 1, '内容变了必须计一条过期');
    assert.ok(dirty.staleRate > 0);
    assert.ok(dirty.score < clean.score, '过期必须让可信度下降');
    assert.ok(dirty.worst.some((w) => w.path === 'packages/ui/src/a.ts' && w.why.includes('过期')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('孤立注记与坏分片都要被数出来（不静默吞掉）', () => {
  const dir = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  try {
    buildMap({ root: dir, branch: 'main' });
    mapNote(dir, { path: 'packages/ui/src/gone.ts', kind: 'why', text: '这个文件已经不在了' });
    let r = mapVerify(dir);
    assert.equal(r.orphanNotes, 1, '指向不存在文件的注记必须计数');

    /* 手写坏一个分片：地图不能因此崩，但要如实报出来。 */
    const idx = JSON.parse(readFileSync(join(dir, '.she', 'map', 'index.json'), 'utf8'));
    const key = idx.shards[0].key;
    writeFileSync(join(dir, '.she', 'map', `shard-${key}.json`), '{ 这不是 json');
    r = mapVerify(dir);
    assert.equal(r.brokenShards, 1, '坏分片必须计数');
    assert.ok(r.text.includes('坏分片'), '要在文本里说出来');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
