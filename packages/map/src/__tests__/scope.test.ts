/*
 * map_scope 的判据。
 *
 * 工作集最容易骗人的地方是"看起来很全但其实没锚点"：如果 whereis 一个都没命中，
 * 返回一堆随便挑的文件比返回空更坏。所以判据里明确要求：
 *   ① 有锚点时必须包含锚点；
 *   ② 反向依赖要进来（否则"改坏谁"是空的）；
 *   ③ 文件数受上限约束（不然 100k 仓里工作集 = 整仓）；
 *   ④ 闸门必须跟着走；
 *   ⑤ 没有命中时要说"没命中"，不许编。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, annotate, mapScope } from '../index.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-scope-'));
  const run = (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 's@t']);
  run(['config', 'user.name', 's']);
  run(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'd', workspaces: ['packages/*'], scripts: { 'check:ui': 'x', 'check:offline': 'y' } }));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return dir;
}

const git = (dir: string) => (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

test('工作集：锚点 + 反向依赖 + 闸门，且有上限', () => {
  const files: Record<string, string> = {
    'packages/ui/src/retry.ts': 'export function retryUpload() {}\n',
    'packages/ui/src/caller.ts': "import { retryUpload } from './retry.js';\nretryUpload();\n",
    'packages/ui/src/other.ts': 'export const other = 1;\n',
  };
  for (let i = 0; i < 30; i += 1) files[`packages/ui/src/noise${i}.ts`] = `export const n${i} = ${i};\n`;
  const dir = repo(files);
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'packages/ui/src/retry.ts', label: '上传重试', what: '失败退避重试' }, git(dir));

    const res = mapScope(dir, '上传重试', { maxFiles: 10 });
    assert.ok(res.seeds.length > 0, '必须找到锚点');
    assert.equal(res.seeds[0]!.path, 'packages/ui/src/retry.ts');
    assert.ok(res.files.includes('packages/ui/src/retry.ts'), '锚点必须在工作集里');
    assert.ok(res.files.includes('packages/ui/src/caller.ts'), '反向依赖必须进来（否则不知道谁会坏）');
    assert.ok(res.files.length <= 10, `文件数必须受上限约束（实际 ${res.files.length}）`);
    assert.ok(res.gates.some((g) => g.check === 'check:ui'), '闸门要跟着走');
    assert.ok(res.ms < 500, `不能慢（实际 ${res.ms}ms）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有命中时说实话，不编文件', () => {
  const dir = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  try {
    buildMap({ root: dir, branch: 'main' });
    const res = mapScope(dir, '这个词根本不存在于任何标签');
    assert.equal(res.seeds.length, 0);
    assert.equal(res.files.length, 0, '没锚点就不要给一堆无关文件');
    assert.ok(res.text.includes('没有命中'), '要明说没命中');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('超预算时砍"会被波及"的尾巴，锚点与闸门保留', () => {
  const files: Record<string, string> = { 'packages/ui/src/retry.ts': 'export function retryUpload() {}\n' };
  for (let i = 0; i < 80; i += 1) files[`packages/ui/src/c${i}.ts`] = "import { retryUpload } from './retry.js';\n";
  const dir = repo(files);
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'packages/ui/src/retry.ts', label: '上传重试' }, git(dir));
    const res = mapScope(dir, '上传重试', { maxFiles: 100, budgetTokens: 120 });
    assert.ok(res.tokens <= 200, `预算要生效（实际 ${res.tokens}）`);
    assert.ok(res.text.includes('packages/ui/src/retry.ts'), '锚点不能被砍');
    assert.ok(res.text.includes('要跑'), '闸门不能被砍');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
