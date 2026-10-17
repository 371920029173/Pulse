/*
 * 建图 + 顺手命名的判据。
 *
 * 这里用真的 git（临时仓库），不用假数据：P1 的全部风险都在"git 到底给了什么"上 ——
 * sha 的格式、`-z` 的分隔、路径里的中文与空格、.gitignore 是否真的被遵守。喂假数据的
 * 测试这几条一条都验不到，而它们恰恰是最容易错的地方（同 KB 白板那次：stub 的形状
 * 自己编，测试全绿，真接口一接就空）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, hasMap, annotate, readIndex, readShard, sha1Of, shardKeyFor, labelIsStale } from '../index.js';

function gitInit(dir: string): void {
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'map@test']);
  run(['config', 'user.name', 'map test']);
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-map-'));
  gitInit(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'import { a } from "./a.js";\n');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  writeFileSync(join(dir, '中文文件.ts'), 'export const 中文 = 1;\n');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  writeFileSync(join(dir, 'logo.bin'), Buffer.from([1, 0, 2, 3]));
  return dir;
}

const git = (dir: string) => (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

test('建图：git ls-files 拿 path+sha，产物分片落盘', () => {
  const dir = newRepo();
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

    const res = buildMap({ root: dir, branch: 'main' });
    assert.equal(hasMap(dir), true, '建完之后 index.json 必须在');
    assert.ok(res.files >= 4, `文件数应 ≥4（实际 ${res.files}）`);

    const index = readIndex(dir);
    assert.ok(index, 'index 可读');
    assert.equal(index!.schemaVersion, 1);
    assert.equal(index!.branch, 'main');
    assert.ok(index!.shards.length >= 2, '至少 src 与根两个分片');

    const src = readShard(dir, shardKeyFor('src/a.ts'));
    assert.ok(src, 'src 分片存在');
    const a = src!.nodes.find((n) => n.kind === 'file' && n.path === 'src/a.ts');
    assert.ok(a, 'src/a.ts 是节点');
    assert.match(a!.sha1 ?? '', /^[0-9a-f]{40}$/, 'sha1 必须是 git blob sha');
    assert.equal(a!.lang, 'ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('建图：.env、二进制、中文文件名三条都按预期处理', () => {
  const dir = newRepo();
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    const res = buildMap({ root: dir, branch: 'main' });

    const all = readIndex(dir)!.shards.flatMap((s) => readShard(dir, s.key)!.nodes);
    const paths = all.filter((n) => n.kind === 'file').map((n) => n.path);
    assert.ok(!paths.includes('.env'), '凭据文件永不索引');
    assert.ok(!paths.includes('logo.bin'), '二进制不索引');
    assert.ok(paths.includes('中文文件.ts'), '中文文件名必须正常建图（findstr 那类假阴性不许在这里复现）');
    assert.equal(res.skipped.secret, 1, '被排除的凭据文件要计数，便于审计');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('顺手命名：标签绑内容，内容一变就 stale，但旧标签不删', () => {
  const dir = newRepo();
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    buildMap({ root: dir, branch: 'main' });

    const first = annotate(dir, 'main', { path: 'src/a.ts', label: '示例常量', what: '导出 a', when: '看导出约定时' }, git(dir));
    assert.equal(first.node.label, '示例常量');
    assert.equal(first.staleBefore, false);
    assert.equal(first.node.labelSha1, first.node.sha1, '标签要绑当时看到的 sha');

    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'change'], { cwd: dir });

    // 重新建图后，节点上的 sha1 变了；旧标签的 labelSha1 还是旧的 → 必须判 stale。
    buildMap({ root: dir, branch: 'main' });
    const shard = readShard(dir, shardKeyFor('src/a.ts'))!;
    const node = shard.nodes.find((n) => n.path === 'src/a.ts' && n.branch === 'main')!;
    assert.equal(node.label, '示例常量', '旧标签要留着，不能因为内容变了就丢');
    assert.equal(labelIsStale(node), true, '内容变了标签必须判过期');
    assert.equal(sha1Of(dir, 'src/a.ts', git(dir)), node.sha1, '节点 sha 应等于当前内容 sha');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('标签超过 16 字被截断，不是拒绝写入', () => {
  const dir = newRepo();
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    buildMap({ root: dir, branch: 'main' });
    const long = '一二三四五六七八九十一二三四五六七八';
    const res = annotate(dir, 'main', { path: 'README.md', label: long }, git(dir));
    assert.equal([...res.node.label!].length, 16, '标签位只放 16 字，摘要不该挤进来');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
