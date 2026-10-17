/*
 * 符号轻表的判据。
 *
 * 要守住的：
 *  ① 导出名能查到定义处（path:line），并且**引用数扣掉定义本身**；
 *  ② 排序数组 + arena 的结构真的被用上（二分查找、区间切片），不是"假装是数组、其实还是对象"；
 *  ③ 一门没有专门规则的语言不能把建表搞崩（词法降级 = 空表，不是异常）；
 *  ④ 同名的多处定义（同名函数/同名的 type）都要列出来，不能只留最后一个。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbols, buildSymbols, lookupSymbol, symbolsInFile, writeSymbols, readSymbols } from '../index.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('TS：导出与非导出都抽到，行号正确', () => {
  const text = [
    'export const a = 1;',
    'function helper() {}',
    'export function allocContext(x: number) { return x; }',
    'export interface Plan { id: string }',
    'class Internal {}',
    'export type Alias = string;',
  ].join('\n');
  const defs = extractSymbols('src/x.ts', 'ts', text);
  const byName = new Map(defs.map((d) => [d.name, d]));
  assert.equal(byName.get('a')!.line, 1);
  assert.equal(byName.get('a')!.exported, true);
  assert.equal(byName.get('helper')!.exported, false);
  assert.equal(byName.get('allocContext')!.line, 3);
  assert.equal(byName.get('allocContext')!.kind, 'function');
  assert.equal(byName.get('Plan')!.kind, 'interface');
  assert.equal(byName.get('Internal')!.exported, false);
  assert.equal(byName.get('Alias')!.kind, 'type');
});

test('Go：大写开头自动算导出（语言规则，不是配置）', () => {
  const defs = extractSymbols('main.go', 'go', ['func Serve() {}', 'func helper() {}', 'type Config struct{}'].join('\n'));
  const by = new Map(defs.map((d) => [d.name, d.exported]));
  assert.equal(by.get('Serve'), true);
  assert.equal(by.get('helper'), false);
  assert.equal(by.get('Config'), true);
});

test('Python 与未知语言：一个是规则、一个是空表（不抛异常）', () => {
  assert.deepEqual(
    extractSymbols('a.py', 'py', 'def f():\n    pass\nclass C:\n    pass\n').map((d) => d.name),
    ['f', 'C'],
  );
  assert.deepEqual(extractSymbols('a.xyz', 'xyz', 'whatever\n'), [], '没有规则的语言返回空表');
});

test('建表 → 二分查找 → 引用数（扣掉定义自身）', () => {
  const root = mkdtempSync(join(tmpdir(), 'she-sym-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export function allocContext() {}\n');
    writeFileSync(join(root, 'src', 'b.ts'), 'import { allocContext } from "./a.js";\nallocContext();\n');

    const table = buildSymbols({ root, files: [{ path: 'src/a.ts', lang: 'ts' }, { path: 'src/b.ts', lang: 'ts' }] });
    assert.deepEqual(table.names, ['allocContext'], '名字排序');
    assert.equal(table.count[0], 2, '两处使用（import + 调用），定义自身不算');

    const hits = lookupSymbol(table, 'allocContext');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.path, 'src/a.ts');
    assert.equal(hits[0]!.line, 1);
    assert.equal(hits[0]!.refs, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同名多处定义都要列出来，并按行排序（symbolsInFile）', () => {
  const root = mkdtempSync(join(tmpdir(), 'she-sym2-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export function dup() {}\nconst x = 1;\nexport function dup2() {}\n');
    const table = buildSymbols({ root, files: [{ path: 'src/a.ts', lang: 'ts' }] });
    const inFile = symbolsInFile(table, 'src/a.ts');
    assert.deepEqual(inFile.map((s) => s.name), ['dup', 'dup2']);
    assert.deepEqual(inFile.map((s) => s.line), [1, 3], '按行号排序');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('落盘与读回：排序数组 + arena 的形状不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'she-sym3-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const b = 1;\nexport const a = 2;\n');
    const table = buildSymbols({ root, files: [{ path: 'src/a.ts', lang: 'ts' }] });
    writeSymbols(root, table);
    const back = readSymbols(root)!;
    assert.deepEqual(back.names, ['a', 'b'], '名字必须有序，二分查找才成立');
    assert.equal(back.start.length, back.names.length);
    assert.equal(back.count.length, back.names.length);
    assert.ok(back.arena.length >= back.names.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
