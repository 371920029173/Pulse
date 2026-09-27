import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addWorktree, asciiName, deleteBranch, diffAgainst, listWorktrees, removeWorktree } from '../worktrees.js';

let repo: string;

function git(args: string[]): { stdout: string; stderr: string; status: number | null } {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
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

describe('asciiName', () => {
  it('把普通英文标签变成目录名', () => {
    assert.equal(asciiName('Fix Login Bug'), 'fix-login-bug');
    assert.equal(asciiName('  spaced  out  '), 'spaced-out');
  });

  it('丢掉的字符用 - 连接，Windows 非法结尾被削掉', () => {
    assert.equal(asciiName('a/b\\c:d*e?f'), 'a-b-c-d-e-f');
    assert.equal(asciiName('trailing.'), 'trailing');
    assert.equal(asciiName('trailing '), 'trailing');
  });

  it('超长标签截断到 24 个字符', () => {
    assert.equal(asciiName('x'.repeat(80)).length, 24);
  });

  it('【关键】纯中文标签不会变成空名，而是生成 id', () => {
    // 这是必须钉住的性质：空名会 throw，而 throw 在子代理路径里等于"悄悄回退到共享工作区"。
    const name = asciiName('检查绘画隔离');
    assert.match(name, /^t[0-9a-f]{8}$/, `应当是非空 ASCII 生成名，实际: ${JSON.stringify(name)}`);
  });

  it('中英混排保留 ASCII 片段（比生成 id 更能认出是谁）', () => {
    // "检查这个Agent，尤其是绘画隔离" → 只剩 ASCII 片段 "agent"；非空即合法，唯一性由 unique 兜。
    assert.equal(asciiName('检查这个Agent，尤其是绘画隔离'), 'agent');
  });

  it('【关键】任何输入都不会给出空名或带非 ASCII 字符的名', () => {
    const hostile = ['', '   ', '中文', '。。。', '////', 'a', '..', '中 a 文', '💥💥', 'ｆｕｌｌｗｉｄｔｈ'];
    for (const label of hostile) {
      const name = asciiName(label);
      assert.ok(name.length >= 2, `${JSON.stringify(label)} 给出了太短的名: ${JSON.stringify(name)}`);
      assert.match(name, /^[a-z0-9._-]+$/, `${JSON.stringify(label)} 给出了非 ASCII 名: ${JSON.stringify(name)}`);
      assert.doesNotMatch(name, /[. ]$/, `${JSON.stringify(label)} 给出了 Windows 非法结尾: ${JSON.stringify(name)}`);
    }
  });

  it('用生成名建 worktree，落盘路径确实全是 ASCII', () => {
    const created = addWorktree(repo, `sub-${asciiName('跑一轮隔离验证')}`, { unique: true });
    const dir = created.path.split(/[\\/]/).pop() ?? '';
    assert.match(dir, /^sub-[a-z0-9._-]+$/, `目录名应当全是 ASCII: ${dir}`);
    assert.match(created.branch, /^she\/sub-[a-z0-9._-]+$/, `分支名应当全是 ASCII: ${created.branch}`);
    removeWorktree(repo, created.path);
  });
});

describe('diffAgainst / deleteBranch', () => {
  it('【关键】新建的文件也要进补丁（git diff 看不见它，这是实测踩到的坑）', () => {
    const created = addWorktree(repo, 'patch-check');
    writeFileSync(join(created.path, 'notes.md'), '子级产出\n');
    const patch = diffAgainst(created.path, created.head);
    assert.match(patch, /notes\.md/, `补丁里应当有新文件: ${JSON.stringify(patch.slice(0, 200))}`);
    assert.match(patch, /子级产出/, '补丁里应当有新文件的内容');
    removeWorktree(repo, created.path);
  });

  it('改过的已跟踪文件也进补丁', () => {
    const created = addWorktree(repo, 'patch-edit');
    writeFileSync(join(created.path, 'a.txt'), '改过了\n');
    const patch = diffAgainst(created.path, created.head);
    assert.match(patch, /改过了/, JSON.stringify(patch.slice(0, 200)));
    removeWorktree(repo, created.path);
  });

  it('什么都没改就不生成补丁内容', () => {
    const created = addWorktree(repo, 'patch-none');
    assert.equal(diffAgainst(created.path, created.head).trim(), '');
    removeWorktree(repo, created.path);
  });

  it('deleteBranch 删掉分支，重复删不报错', () => {
    const created = addWorktree(repo, 'branch-drop');
    removeWorktree(repo, created.path);
    assert.equal(deleteBranch(repo, created.branch), null);
    assert.equal((git(['branch', '--list', 'she/*']).stdout || '').includes(created.branch), false);
    assert.equal(deleteBranch(repo, created.branch), null, '已经没了的分支不该报错');
  });
});
