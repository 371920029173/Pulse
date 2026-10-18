/*
 * 「接线」的判据：用户要的是"A 用了 B 里的 c → 边命名接线 c"。
 * 三条：① 命名导入能写出符号名；② 裸包名导入也能标；③ 能按符号反查。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, importedSymbols, wiringLabel, mapWiring, mapLookup } from '../index.js';

test('从 import 行里抽符号名：命名/别名/默认/命名空间/type', () => {
  assert.deepEqual(importedSymbols("import { a, b as c } from './x';"), ['a', 'b']);
  assert.deepEqual(importedSymbols("import type { T, U } from './x';"), ['T', 'U']);
  assert.deepEqual(importedSymbols("import def from './x';"), ['def']);
  assert.deepEqual(importedSymbols("import * as ns from './x';"), ['*']);
  assert.equal(wiringLabel(['a', 'b']), '接线 a、b');
  assert.match(wiringLabel(['a', 'b', 'c', 'd']), /等 4 个/);
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-wire-'));
  const run = (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'w@t']);
  run(['config', 'user.name', 'w']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'd', workspaces: ['packages/*'], scripts: {} }));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return dir;
}

test('建图后 A→B 的边带着「接线 c」；lookup 能看到，按符号能反查', () => {
  const dir = repo({
    'packages/ui/src/b.ts': 'export function c() {}\nexport const d = 1;\n',
    'packages/ui/src/a.ts': "import { c as rename } from './b.js';\nrename();\n",
  });
  try {
    buildMap({ root: dir, branch: 'main' });
    const hits = mapWiring(dir, { path: 'packages/ui/src/a.ts' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.from, 'packages/ui/src/a.ts');
    assert.equal(hits[0]!.to, 'packages/ui/src/b.ts');
    assert.deepEqual(hits[0]!.symbols, ['c'], '别名算接的是源文件里的名字 c');
    assert.equal(hits[0]!.label, '接线 c');

    const bySymbol = mapWiring(dir, { symbol: 'c' });
    assert.ok(bySymbol.some((h) => h.to === 'packages/ui/src/b.ts'), '按符号要能反查到这条线');

    const looked = mapLookup(dir, 'packages/ui/src/a.ts');
    assert.ok(looked.text.includes('接线'), 'lookup 里要有接线一节');
    assert.ok(looked.text.includes('接线 c'), '要写出接的是哪个符号');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('裸包名导入也标接线（指向包根）', () => {
  const dir = repo({
    'packages/shared/package.json': JSON.stringify({ name: '@she/shared' }),
    'packages/shared/src/index.ts': 'export const shared = 1;\n',
    'packages/ui/src/a.ts': "import { shared } from '@she/shared';\n",
  });
  try {
    buildMap({ root: dir, branch: 'main' });
    const hits = mapWiring(dir, { path: 'packages/ui/src/a.ts' });
    const pkgEdge = hits.find((h) => h.to === 'packages/shared');
    assert.ok(pkgEdge, '裸包名 import 也要有一条到包根的接线');
    assert.equal(pkgEdge!.label, '接线 shared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
