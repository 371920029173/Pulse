/**
 * Filesystem jail.
 *
 * This is the boundary that stops the agent (or a crafted request) from reading
 * and writing outside the workspace. It is the highest-consequence pure logic in
 * the server, so every escape route that has actually worked gets a case here.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { listTree, readWorkspaceFile, suggestPaths } from '../files.js';

/** Build a small tree: root/{a.txt, sub/{b.txt}}, plus an outside file. */
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), 'she-files-'));
  const root = join(base, 'ws');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'alpha', 'utf8');
  writeFileSync(join(root, 'sub', 'b.txt'), 'beta', 'utf8');
  const outside = join(base, 'outside.txt');
  writeFileSync(outside, 'SECRET', 'utf8');
  return { base, root, outside };
}

describe('workspace jail', () => {
  let t: ReturnType<typeof makeTree>;
  beforeEach(() => { t = makeTree(); });
  // Remove ONLY the fixture directory. `join(base, '..')` would be the system
  // temp dir — deleting that nukes unrelated files and fails with EBUSY.
  afterEach(() => { rmSync(t.base, { recursive: true, force: true }); });

  it('reads a normal relative path', () => {
    const r = readWorkspaceFile(t.root, 'a.txt');
    assert.equal(r.content, 'alpha');
    assert.equal(r.path, 'a.txt');
  });

  it('reads a nested path', () => {
    assert.equal(readWorkspaceFile(t.root, 'sub/b.txt').content, 'beta');
  });

  it('rejects ../ traversal', () => {
    assert.throws(() => readWorkspaceFile(t.root, '../outside.txt'), /escapes workspace/i);
    assert.throws(() => readWorkspaceFile(t.root, '../../etc/passwd'), /escapes/i);
  });

  it('rejects an absolute path outside the workspace', () => {
    // `resolve(root, '/etc/passwd')` returns '/etc/passwd', silently escaping —
    // this is the case that made import-path an arbitrary-file-read.
    assert.throws(() => readWorkspaceFile(t.root, t.outside), /escapes/i);
    assert.throws(() => readWorkspaceFile(t.root, resolve(t.outside)), /escapes/i);
  });

  it('rejects a symlink pointing outside the workspace', () => {
    const link = join(t.root, 'link.txt');
    try {
      symlinkSync(t.outside, link);
    } catch {
      return; // symlinks need privileges on Windows; skip rather than fail
    }
    assert.throws(() => readWorkspaceFile(t.root, 'link.txt'), /escapes/i,
      '软链接指向区外必须被拦截');
  });

  it('still allows a symlink that stays inside', () => {
    const link = join(t.root, 'inner-link.txt');
    try {
      symlinkSync(join(t.root, 'a.txt'), link);
    } catch {
      return;
    }
    assert.equal(readWorkspaceFile(t.root, 'inner-link.txt').content, 'alpha');
  });

  it('rejects a directory where a file is expected', () => {
    assert.throws(() => readWorkspaceFile(t.root, 'sub'), /not a file/i);
  });

  it('reports missing files without escaping the jail', () => {
    assert.throws(() => readWorkspaceFile(t.root, 'nope.txt'), /not a file/i);
  });

  it('refuses to inline binary content', () => {
    writeFileSync(join(t.root, 'x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.throws(() => readWorkspaceFile(t.root, 'x.png'), /binary/i);
  });

  it('truncates instead of loading a huge file whole', () => {
    writeFileSync(join(t.root, 'big.txt'), 'y'.repeat(5000), 'utf8');
    const r = readWorkspaceFile(t.root, 'big.txt', 1000);
    assert.equal(r.truncated, true);
    assert.equal(r.content.length, 1000);
  });
});

describe('listTree', () => {
  let t: ReturnType<typeof makeTree>;
  beforeEach(() => { t = makeTree(); });
  afterEach(() => { rmSync(t.base, { recursive: true, force: true }); });

  it('lists entries with relative paths', () => {
    const nodes = listTree(t.root, '.', 2);
    const names = nodes.map((n) => n.name).sort();
    assert.deepEqual(names, ['a.txt', 'sub']);
    const sub = nodes.find((n) => n.name === 'sub')!;
    assert.equal(sub.type, 'dir');
  });

  it('is jailed as well', () => {
    assert.throws(() => listTree(t.root, '..'), /escapes/i);
  });

  it('returns empty for a missing directory rather than throwing', () => {
    assert.deepEqual(listTree(t.root, 'no-such-dir'), []);
  });
});

describe('suggestPaths', () => {
  let t: ReturnType<typeof makeTree>;
  beforeEach(() => { t = makeTree(); });
  afterEach(() => { rmSync(t.base, { recursive: true, force: true }); });

  it('finds by substring', () => {
    const hits = suggestPaths(t.root, 'b.txt');
    assert.ok(hits.some((h) => h.path === 'sub/b.txt'), `应找到 sub/b.txt，实际: ${JSON.stringify(hits)}`);
  });

  it('respects the limit', () => {
    assert.ok(suggestPaths(t.root, '', 1).length <= 1);
  });

  it('never reports a path outside the workspace', () => {
    for (const h of suggestPaths(t.root, '', 50)) {
      assert.ok(!h.path.startsWith('..'), `越界路径: ${h.path}`);
    }
  });
});
