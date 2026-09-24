/**
 * Project conventions.
 *
 * An agent that ignores a repository's own convention file looks like an outsider: the
 * team wrote down how they work, and the tool walks past it. `AGENTS.md` is the one that
 * matters most in practice because that is what Cursor reads, so a project arriving from
 * Cursor keeps its conventions there.
 *
 * Three behaviours need pinning, because all three are easy to get subtly wrong:
 *
 *   1. **The standard filenames are read**, not only our own `.she/rules.md`.
 *   2. **Several are merged**, because a repository that has changed tools legitimately
 *      has more than one; honouring only the first would drop conventions the team wrote.
 *   3. **The upward search stays inside the repository.** A monorepo keeps conventions at
 *      the root while the agent is pointed at a package, but reading above the repository
 *      would pick up an unrelated project's file — so the walk stops at the repo root.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSystemPrompt } from '../system-prompt.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'she-conv-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Write a file, creating its directory. */
function put(base: string, relPath: string, content: string): void {
  const p = join(base, relPath);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

/** The prompt for a workspace, with the skills machinery out of the way. */
function prompt(workspace = root): string {
  return getSystemPrompt(workspace, 'general', false);
}

describe('约定文件：标准文件名', () => {
  it('读取 AGENTS.md（Cursor 用的就是这个名字）', () => {
    put(root, 'AGENTS.md', 'ALWAYS-USE-TABS-INDENT');
    assert.match(prompt(), /ALWAYS-USE-TABS-INDENT/, 'AGENTS.md 没有被读入');
  });

  it('读取 CLAUDE.md', () => {
    put(root, 'CLAUDE.md', 'PREFER-PNPM-OVER-NPM');
    assert.match(prompt(), /PREFER-PNPM-OVER-NPM/);
  });

  it('读取 .cursorrules', () => {
    put(root, '.cursorrules', 'NEVER-COMMIT-SECRETS');
    assert.match(prompt(), /NEVER-COMMIT-SECRETS/);
  });

  it('读取 .github/copilot-instructions.md', () => {
    put(root, '.github/copilot-instructions.md', 'COPILOT-STYLE-RULE');
    assert.match(prompt(), /COPILOT-STYLE-RULE/);
  });

  it('仍然读取自家的 .she/rules.md', () => {
    put(root, '.she/rules.md', 'NATIVE-RULE-STILL-WORKS');
    assert.match(prompt(), /NATIVE-RULE-STILL-WORKS/);
  });

  it('没有约定文件时不生成该段落（不浪费上下文）', () => {
    const p = prompt();
    assert.doesNotMatch(p, /## Project Rules/, '没有规则却出现了规则段落');
  });
});

describe('约定文件：合并而非只取一个', () => {
  it('【关键】多个文件全部合并进去', () => {
    /*
     * A repository that has moved between tools has several of these, and each may hold
     * conventions the others lack. Taking only the first would silently ignore what the
     * team wrote — the exact failure this feature exists to prevent.
     */
    put(root, 'AGENTS.md', 'RULE-FROM-AGENTS');
    put(root, 'CLAUDE.md', 'RULE-FROM-CLAUDE');
    put(root, '.cursorrules', 'RULE-FROM-CURSOR');
    const p = prompt();
    assert.match(p, /RULE-FROM-AGENTS/, 'AGENTS.md 丢了');
    assert.match(p, /RULE-FROM-CLAUDE/, 'CLAUDE.md 丢了');
    assert.match(p, /RULE-FROM-CURSOR/, '.cursorrules 丢了');
  });

  it('每个文件都标注了来源（冲突时模型才能指出是谁说的）', () => {
    put(root, 'AGENTS.md', 'A-RULE');
    put(root, 'CLAUDE.md', 'B-RULE');
    const p = prompt();
    assert.match(p, /### AGENTS\.md/, '没有标出 AGENTS.md 的来源');
    assert.match(p, /### CLAUDE\.md/, '没有标出 CLAUDE.md 的来源');
  });

  it('段落里列出了实际读取的文件名', () => {
    put(root, 'AGENTS.md', 'X');
    const p = prompt();
    assert.match(p, /AGENTS\.md/, '应当告诉模型规则来自哪个文件');
  });

  it('空文件被忽略（不产生空标题）', () => {
    put(root, 'AGENTS.md', '   \n  \n');
    assert.doesNotMatch(prompt(), /### AGENTS\.md/, '空文件不该产生一个空段落');
  });

  it('约定文件全文进入提示词', () => {
    const body = 'A'.repeat(60_000);
    put(root, 'AGENTS.md', body);
    const p = prompt();
    assert.ok(p.includes(body), '约定被截断了');
    assert.doesNotMatch(p, /已截断/);
  });

  it('多个约定文件都完整保留', () => {
    put(root, 'AGENTS.md', 'A'.repeat(40_000));
    put(root, 'CLAUDE.md', 'B'.repeat(40_000));
    put(root, '.cursorrules', 'C'.repeat(40_000));
    const p = prompt();
    assert.ok(p.includes('A'.repeat(40_000)));
    assert.ok(p.includes('B'.repeat(40_000)));
    assert.ok(p.includes('C'.repeat(40_000)));
  });
});

describe('约定文件：向上查找的边界', () => {
  it('monorepo：包目录作为工作区时，能找到仓库根目录的 AGENTS.md', () => {
    /*
     * The case this exists for: the agent is pointed at `packages/app`, conventions live
     * at the repository root. Without the upward walk the file is invisible.
     */
    put(root, '.git/HEAD', 'ref: refs/heads/main');
    put(root, 'AGENTS.md', 'REPO-WIDE-CONVENTION');
    put(root, 'packages/app/package.json', '{}');

    const p = getSystemPrompt(join(root, 'packages', 'app'), 'general', false);
    assert.match(p, /REPO-WIDE-CONVENTION/, '没找到仓库根目录的约定文件');
  });

  it('【关键】不会越过仓库根目录去读别人的文件', () => {
    /*
     * The boundary that makes the upward walk safe. A workspace inside a repository must
     * not pick up conventions belonging to a DIFFERENT repository that happens to sit
     * above it — that would apply a stranger's rules to the user's project.
     */
    put(root, 'AGENTS.md', 'OUTER-PROJECT-RULES-MUST-NOT-APPLY');
    // A separate, nested repository.
    put(root, 'inner/.git/HEAD', 'ref: refs/heads/main');
    put(root, 'inner/AGENTS.md', 'INNER-PROJECT-RULES');

    const p = getSystemPrompt(join(root, 'inner'), 'general', false);
    assert.match(p, /INNER-PROJECT-RULES/, '自己仓库的规则应当生效');
    assert.doesNotMatch(p, /OUTER-PROJECT-RULES-MUST-NOT-APPLY/, '越过了仓库根目录，读到了别的项目');
  });

  it('没有 .git 时不向上查找（只认工作区自己）', () => {
    put(root, 'AGENTS.md', 'OUTER-RULE');
    const inner = join(root, 'sub');
    mkdirSync(inner, { recursive: true });
    const p = getSystemPrompt(inner, 'general', false);
    assert.doesNotMatch(p, /OUTER-RULE/, '没有仓库标记时不该向上找');
  });

  it('就近的那份优先，不会被远处同名文件覆盖', () => {
    put(root, '.git/HEAD', 'ref');
    put(root, 'AGENTS.md', 'ROOT-VERSION');
    put(root, 'pkg/.git/HEAD', 'ref');
    put(root, 'pkg/AGENTS.md', 'NEARER-VERSION');

    const p = getSystemPrompt(join(root, 'pkg'), 'general', false);
    assert.match(p, /NEARER-VERSION/, '近处的约定应当生效');
    // The walk stops at `pkg`'s own .git, so the root copy is not even considered.
    assert.doesNotMatch(p, /ROOT-VERSION/, '不该同时带上外面仓库的约定');
  });
});
