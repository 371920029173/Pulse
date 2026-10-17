/*
 * 孪生文件（同路径、不同分支、内容不同）必须并存，且各自的标签互不污染。
 *
 * 用户当时提的想法就是这条："一个文件在两个分支同时存在且不相同，这样可以保留更多的东西，
 * 也可以和更多的组结合。" 它成立的前提是**节点身份带分支**——否则第二次建图会把第一次的
 * 标签按 path 覆盖到另一条分支上，两条分支的描述互相踩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, annotate, readShard, shardKeyFor, kbLinksFor, linkKb, labelIsStale } from '../index.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-twin-'));
  const run = (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
  run(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'd', workspaces: ['packages/*'], scripts: {} }));
  mkdirSync(join(dir, 'packages/ui/src'), { recursive: true });
  writeFileSync(join(dir, 'packages/ui/src/a.ts'), 'export const a = 1;\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return dir;
}

const git = (dir: string) => (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

test('孪生：同路径两条分支并存，标签互不覆盖', () => {
  const dir = repo();
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'packages/ui/src/a.ts', label: '主干版' }, git(dir));

    writeFileSync(join(dir, 'packages/ui/src/a.ts'), 'export const a = 2; // 分支改动\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'branch change'], { cwd: dir });
    buildMap({ root: dir, branch: 'feat/x' });

    const shard = readShard(dir, shardKeyFor('packages/ui/src/a.ts'))!;
    const twins = shard.nodes.filter((n) => n.path === 'packages/ui/src/a.ts');
    assert.equal(twins.length, 2, `两条分支各一个节点（实际 ${twins.length}）`);
    const main = twins.find((n) => n.branch === 'main');
    const feat = twins.find((n) => n.branch === 'feat/x');
    assert.ok(main && feat, '两条分支的节点都要在');
    assert.equal(main!.label, '主干版', '主干标签必须留在主干节点上');
    assert.equal(feat!.label, undefined, '分支节点不该凭空继承主干的标签');
    assert.notEqual(main!.sha1, feat!.sha1, '内容不同 → sha 不同（两版内容都保留）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('孪生：知识绑定也按分支隔离', () => {
  const dir = repo();
  try {
    buildMap({ root: dir, branch: 'main' });
    linkKb(dir, 'main', {
      path: 'packages/ui/src/a.ts',
      kbGroup: 'architecture/ui',
      title: '主干上的知识',
      confidence: 'certain',
      evidence: ['test'],
    });
    buildMap({ root: dir, branch: 'feat/x' });

    const featLinks = kbLinksFor(dir, 'feat/x', 'packages/ui/src/a.ts', { includeAncestors: false });
    assert.equal(featLinks.length, 0, '分支上不该看到主干的知识绑定');
    const mainLinks = kbLinksFor(dir, 'main', 'packages/ui/src/a.ts', { includeAncestors: false });
    assert.equal(mainLinks.length, 1, '主干上的知识绑定必须还在');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('孪生：内容改了，只有那条分支的标签判过期', () => {
  const dir = repo();
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'packages/ui/src/a.ts', label: '主干版' }, git(dir));

    writeFileSync(join(dir, 'packages/ui/src/a.ts'), 'export const a = 3;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'change'], { cwd: dir });
    buildMap({ root: dir, branch: 'main' });

    const shard = readShard(dir, shardKeyFor('packages/ui/src/a.ts'))!;
    const node = shard.nodes.find((n) => n.branch === 'main' && n.path === 'packages/ui/src/a.ts')!;
    assert.equal(labelIsStale(node), true, '主干内容变了，主干标签要判过期');
    assert.equal(node.label, '主干版', '过期不等于删除');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
