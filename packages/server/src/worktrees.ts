import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Git worktrees for parallel work on one repository.
 *
 * Two sessions that share a checkout overwrite each other's files. A worktree
 * is another directory on another branch, so each session can be jailed to its
 * own tree. The directory lives beside the repo, not inside it, so `git status`
 * on the main checkout stays clean.
 */

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
}

function git(cwd: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, windowsHide: true });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || r.error?.message || '').trim(),
  };
}

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  }
}

function samePath(a: string, b: string): boolean {
  return canonical(a).toLowerCase() === canonical(b).toLowerCase();
}

function assertRepo(repo: string): void {
  if (!existsSync(join(repo, '.git'))) {
    throw new Error(`不是 git 仓库: ${repo}`);
  }
}

export function listWorktrees(repo: string): WorktreeInfo[] {
  assertRepo(repo);
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) throw new Error(r.stderr || 'git worktree list 失败');
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) {
      if (cur.path) out.push({ path: cur.path, head: cur.head || '', branch: cur.branch || '' });
      cur = {};
      continue;
    }
    if (line.startsWith('worktree ')) cur.path = canonical(line.slice('worktree '.length));
    else if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
  }
  if (cur.path) out.push({ path: cur.path, head: cur.head || '', branch: cur.branch || '' });
  return out;
}

/**
 * Turn a free-form label into a directory name that is safe on every filesystem.
 *
 * The character class is `\p{L}\p{N}` rather than `a-zA-Z0-9` on purpose. The old ASCII-only
 * filter replaced every CJK character with `-`, so a task named in Chinese produced an empty
 * slug, and `worktreePath` then threw '名称是空的' — which, in the subagent path, meant that
 * asking for isolation in Chinese silently fell back to the shared checkout. A Unicode letter is
 * a perfectly good directory character on Windows, macOS and Linux, and the things that actually
 * need removing are separators, whitespace and the Windows-illegal tail characters.
 */
function slug(name: string): string {
  return name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    // Windows cannot create a name ending in a dot or space, and `..` must never survive.
    .replace(/[. ]+$/g, '')
    .slice(0, 40);
}

function worktreePath(repo: string, name: string): string {
  const safe = slug(name);
  if (!safe) throw new Error('worktree 名称是空的');
  return join(dirname(repo), '.she-worktrees', basename(repo), safe);
}

/**
 * Create a worktree on a new branch `she/<name>`, starting from the repo's current HEAD.
 *
 * `unique` appends a numeric suffix when the path is taken. Two subagents given the same label —
 * "修复测试", say — are an ordinary way to use delegation, and having the second one silently drop
 * out of isolation because its sibling got there first would be a worse outcome than a `-2` in the
 * directory name. The interactive route leaves it off: a user who types a name that already exists
 * should be told, not quietly given a different branch.
 */
export function addWorktree(repo: string, name: string, opts?: { unique?: boolean }): WorktreeInfo {
  assertRepo(repo);
  let path = worktreePath(repo, name);
  if (opts?.unique) {
    for (let n = 2; existsSync(path) && n < 100; n++) path = `${worktreePath(repo, name)}-${n}`;
  }
  if (existsSync(path)) throw new Error(`目录已存在: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const branch = `she/${basename(path)}`;
  const r = git(repo, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  if (!r.ok) throw new Error(r.stderr || 'git worktree add 失败');
  const found = listWorktrees(repo).find((w) => samePath(w.path, path));
  return found ?? { path: canonical(path), head: '', branch };
}

export function removeWorktree(repo: string, path: string): void {
  assertRepo(repo);
  const r = git(repo, ['worktree', 'remove', '--force', path]);
  if (!r.ok) throw new Error(r.stderr || 'git worktree remove 失败');
}

/** Point a worktree at the main checkout's current commit. */
export function resetWorktree(repo: string, path: string): void {
  assertRepo(repo);
  const head = git(repo, ['rev-parse', 'HEAD']);
  if (!head.ok || !head.stdout) throw new Error(head.stderr || '无法读取主仓库 HEAD');
  const r = git(path, ['reset', '--hard', head.stdout]);
  if (!r.ok) throw new Error(r.stderr || 'git reset 失败');
}

/**
 * Copy uncommitted changes from one checkout onto another.
 * Returns a short note. A failed apply does not throw: the session move
 * itself should still succeed.
 */
export function transferLocalChanges(from: string, to: string): string {
  if (!existsSync(join(from, '.git')) || !existsSync(join(to, '.git'))) {
    return '两边不都是 git 仓库，未搬运未提交的改动';
  }
  const diff = git(from, ['diff']);
  if (!diff.ok) return `未能读取改动：${diff.stderr}`;
  if (!diff.stdout) return '没有未提交的改动';
  const apply = git(to, ['apply'], diff.stdout + '\n');
  if (!apply.ok) return `会话已搬走，改动未能套用：${apply.stderr}`;
  return '未提交的改动已套用到目标目录';
}

/**
 * Repo-relative paths with uncommitted work in `dir`.
 *
 * Used to report what an isolated child actually did. `git diff --name-only` alone would miss
 * files the child CREATED, which is the usual shape of a delegated change, so the untracked list
 * is included and reported as-is rather than only as a count — a count cannot be acted on.
 */
export function changedFiles(dir: string): string[] {
  if (!existsSync(join(dir, '.git'))) return [];
  const tracked = git(dir, ['diff', '--name-only']);
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']);
  const out = new Set<string>();
  for (const block of [tracked, untracked]) {
    if (!block.ok) continue;
    for (const line of block.stdout.split('\n')) {
      const p = line.trim();
      if (p) out.add(p);
    }
  }
  return [...out].sort();
}

/**
 * Whether `dir` is inside a git work tree.
 *
 * Not `existsSync(dir/.git)`: in a LINKED worktree `.git` is a file, and a repository whose root
 * is above `dir` is still a repository. `rev-parse` answers the real question, and asking git
 * rather than guessing from the filesystem is the difference between a wrong answer and no answer.
 */
export function isGitRepo(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return git(dir, ['rev-parse', '--is-inside-work-tree']).stdout === 'true';
}
