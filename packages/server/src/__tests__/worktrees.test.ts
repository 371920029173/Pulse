import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addWorktree, listWorktrees, removeWorktree } from '../worktrees.js';

let repo: string;

function git(args: string[]): void {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'git failed');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'she-wt-'));
  git(['init']);
  git(['config', 'user.email', 'she@example.com']);
  git(['config', 'user.name', 'she']);
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git(['add', 'a.txt']);
  git(['commit', '-m', 'init']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('worktrees', () => {
  it('建一个独立目录，列出来，再删掉', () => {
    const created = addWorktree(repo, 'side');
    assert.ok(created.path.includes('side'));
    const listed = listWorktrees(repo);
    assert.ok(listed.some((w) => w.path === created.path));
    assert.ok(listed.length >= 2);
    removeWorktree(repo, created.path);
    assert.equal(listWorktrees(repo).some((w) => w.path === created.path), false);
  });
});
