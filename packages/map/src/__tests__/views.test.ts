/*
 * 三视角探测的判据。
 *
 * 关键不是"能探到 pnpm workspace"，而是**探不到的时候不能坏**：
 * 一个没有 manifest 的仓（比如纯 C 项目、或者别人随手解压的目录）必须退回目录轴并且
 * 地图仍然完整 —— 否则这个功能会让"地图打不开"，比没有这个功能更糟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectViews, expandGlobs, buildMap, readIndex } from '../index.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'she-views-'));
}

test('pnpm workspace：从 pnpm-workspace.yaml 探到包，primary = package', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true }, null, 2));
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'b'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'package.json'), JSON.stringify({ name: '@x/a' }));
    writeFileSync(join(dir, 'packages', 'b', 'package.json'), JSON.stringify({ name: '@x/b' }));

    const v = detectViews(dir);
    assert.equal(v.primary, 'package');
    assert.deepEqual(v.packages.map((p) => p.name).sort(), ['@x/a', '@x/b']);
    assert.ok(v.evidence.includes('pnpm-workspace.yaml'), '探测依据要留痕');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm workspaces 数组也认；排除项生效', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['apps/*', '!apps/skip'] }));
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'skip'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web' }));
    writeFileSync(join(dir, 'apps', 'skip', 'package.json'), JSON.stringify({ name: 'skip' }));
    const v = detectViews(dir);
    assert.deepEqual(v.packages.map((p) => p.name), ['web']);
    assert.deepEqual(expandGlobs(dir, ['apps/*', '!apps/skip']), ['apps/web']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('构建单元：CMake / tsconfig 被探到；没有包时 primary = target', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'CMakeLists.txt'), 'project(x)\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'CMakeLists.txt'), 'add_library(x a.c)\n');
    const v = detectViews(dir);
    assert.equal(v.primary, 'target');
    assert.ok(v.targets.some((t) => t.kind === 'cmake' && t.file === 'CMakeLists.txt'));
    assert.ok(v.targets.some((t) => t.root === 'src'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('什么都没探到 → primary = dir，地图照样建得出来', () => {
  const dir = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'v@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'v'], { cwd: dir });
    mkdirSync(join(dir, 'somestuff'), { recursive: true });
    writeFileSync(join(dir, 'somestuff', 'x.txt'), 'hi\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'i'], { cwd: dir });

    const v = detectViews(dir);
    assert.equal(v.primary, 'dir');
    assert.ok(v.evidence.some((e) => e.includes('退回目录轴')));

    const res = buildMap({ root: dir, branch: 'main' });
    assert.ok(res.files >= 1, '探不到视角也必须能建图');
    assert.equal(readIndex(dir)!.views!.primary, 'dir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
