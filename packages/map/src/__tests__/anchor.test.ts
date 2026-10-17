/*
 * 压缩协同的判据：
 *  ① 有标签的文件，块里要带标签（压缩后不用重新打开就知道它是干什么的）；
 *  ② 没标签的写「未标注」，**不编**；
 *  ③ 预算硬上限：超了就少列，并明说还有多少个没列；
 *  ④ 只输出引用，绝不把文件内容塞回上下文（压缩的意义就是丢掉内容）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, annotate, mapAnchorBlock } from '../index.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-anchor-'));
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

test('锚点块：带标签、未标注如实说、不塞内容', () => {
  const dir = repo({
    'packages/ui/src/chat.ts': 'export const x = 1; // 这一行内容不该出现在块里\n',
    'packages/ui/src/other.ts': 'export const y = 2;\n',
  });
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'packages/ui/src/chat.ts', label: '会话主逻辑' }, git(dir));

    const block = mapAnchorBlock(dir, ['packages/ui/src/chat.ts', 'packages/ui/src/other.ts']);
    assert.ok(block.text.includes('packages/ui/src/chat.ts'), '路径要在');
    assert.ok(block.text.includes('会话主逻辑'), '标签要在（压缩后不用重开文件）');
    assert.ok(block.text.includes('未标注'), '没标签的如实说未标注');
    assert.ok(!block.text.includes('这一行内容不该出现在块里'), '绝不把文件内容塞回上下文');
    assert.equal(block.included.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('锚点块：预算硬上限，超了少列并说明', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) files[`packages/ui/src/f${i}.ts`] = `export const v${i} = ${i};\n`;
  const dir = repo(files);
  try {
    buildMap({ root: dir, branch: 'main' });
    const all = Object.keys(files);
    const block = mapAnchorBlock(dir, all, 60);
    assert.ok(block.tokens <= 90, `token 必须受控（实际 ${block.tokens}）`);
    assert.ok(block.included.length < all.length, '必须真的少列了');
    assert.ok(block.text.includes('未列出'), '要说明还有多少没列');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有地图时不硬编：返回空块', () => {
  const dir = repo({ 'a.ts': 'export const a = 1;\n' });
  try {
    const block = mapAnchorBlock(dir, ['a.ts']);
    assert.equal(block.text, '');
    assert.equal(block.included.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
