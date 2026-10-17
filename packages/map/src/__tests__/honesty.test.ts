/*
 * 独立评测抓到的两处"会撒谎"，各写一条判据钉住：
 *  ① 无关查询必须返回空（之前任何查询都返回同一批高引用文件）；
 *  ② 折叠文件数不能超过全仓文件数（之前出现 877 > 539）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, annotate, mapWhereis, mapTree, mapVerify } from '../index.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-truth-'));
  const run = (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
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

test('无关查询返回空，而不是"引用数最高的几个文件"', () => {
  const dir = repo({
    /* 高引用文件：谁都会 import，但和查询词无关 */
    'packages/ui/src/lib/hub.ts': 'export const hub = 1;\n',
    'packages/ui/src/a.ts': "import { hub } from './lib/hub.js';\nexport const a = hub;\n",
    'packages/ui/src/b.ts': "import { hub } from './lib/hub.js';\nexport const b = hub;\n",
    'packages/ui/src/c.ts': "import { hub } from './lib/hub.js';\nexport const c = hub;\n",
    'packages/ui/src/compaction.ts': 'export function compact() {}\n',
  });
  try {
    buildMap({ root: dir, branch: 'main' });
    annotate(dir, 'main', { path: 'packages/ui/src/compaction.ts', label: '上下文压缩' }, git(dir));

    const junk = mapWhereis(dir, 'zzzq xyzzy');
    assert.equal(junk.hits.length, 0, `完全无关的查询必须返回空（实际 ${junk.hits.map((h) => h.path).join(',')}）`);

    const real = mapWhereis(dir, '压缩');
    assert.ok(real.hits.length > 0, '相关查询必须能命中');
    assert.equal(real.hits[0]!.path, 'packages/ui/src/compaction.ts');
    assert.ok(real.hits.every((h) => h.reasons.length > 0), '每条命中都要说明命中了什么词');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('折叠文件数不超过全仓文件数（自相矛盾的数字就是 bug）', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) files[`cold${i}/deep/x/f${i}.ts`] = `export const v${i} = ${i};\n`;
  const dir = repo(files);
  try {
    buildMap({ root: dir, branch: 'main' });
    const tiny = mapTree(dir, { budgetTokens: 60, depth: 3 });
    const m = tiny.text.match(/已折叠 (\d+) 个文件/);
    assert.ok(m, '折叠时必须给出数字');
    const hidden = Number(m[1]);
    assert.ok(hidden <= tiny.files, `折叠数(${hidden}) 不能超过全仓文件数(${tiny.files})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0 标签时可信度封顶 30，并明说意图检索不可用', () => {
  const dir = repo({ 'packages/ui/src/a.ts': 'export const a = 1;\n' });
  try {
    buildMap({ root: dir, branch: 'main' });
    const v = mapVerify(dir);
    assert.equal(v.labels, 0);
    assert.ok(v.score <= 30, `0 标签不该报 ${v.score} 分`);
    assert.ok(v.text.includes('不可用'), '要明说意图检索不可用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
