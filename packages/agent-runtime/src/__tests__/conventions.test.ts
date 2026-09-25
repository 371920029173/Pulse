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
import { getSystemPrompt, SUBAGENT_DENIED_TOOLS } from '../system-prompt.js';

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

/**
 * 只读知识库的系统提示。
 *
 * 提示词必须和工具的实际能力一致：一边叫子级 `kb_upsert`「主动写回」，一边在执行时拒绝它，
 * 是最坏的一种组合 —— 子级会花掉一步去调一个不可能成功的工具，而失败会被错题本记成它自己的
 * 错误。所以「不要写」这件事要在它动手之前就说到，而不是等它撞上拒绝。
 */
describe('共享父级知识库时的提示词', () => {
  const READ_ONLY = /这个子任务的知识库是只读的/;
  const WRITE_INSTRUCTION = /主动 `kb_upsert` 写回/;

  it('默认（自己的库）仍然要求主动写回', () => {
    assert.match(prompt(), WRITE_INSTRUCTION, '正常的子级/主级应当照旧自动读写');
  });

  it('只读时不再叫它写，而是明说写会被拒', () => {
    const p = getSystemPrompt(root, 'general', false, { kbReadOnly: true });
    assert.match(p, READ_ONLY);
    assert.doesNotMatch(p, WRITE_INSTRUCTION, '还在叫它 kb_upsert，等于让它用不存在的权限');
    assert.match(p, /交付物/, '要给出替代动作，否则子级只会把结论丢掉');
  });

  it('只读时读的部分不能一起关掉', () => {
    const p = getSystemPrompt(root, 'general', false, { kbReadOnly: true });
    assert.match(p, /先 `kb_query`/, '查不到 = 失忆，那是另一个问题');
  });

  it('只读的说明出现在可用工具清单里 —— 两份清单不能互相打脸', () => {
    const p = getSystemPrompt(root, 'general', false, { kbReadOnly: true });
    assert.match(p, /`kb_upsert` \/ `kb_link`: \*\*disabled for this subtask\*\*/);
  });
});

/*
 * 子任务的提示词与子任务的工具集必须一致。
 *
 * 这是同一类错误里最贵的一种：主级提示词列着 `plan_list`、`preflight_record`，而子级的工具表里
 * 根本没有它们 —— 实测中一个只读子级照着提示词去调，拿到 `Error: unknown tool "plan_list"`，
 * 又按提示词「不要重试」换了一个同样不存在的工具，两次失败都被错题本记成了它的错误（见
 * `errorbook.ts` 与 `agent.ts` 里 `kbReadOnly` 的注释）。提示词里少一段是成本，多一段是陷阱。
 *
 * `SUBAGENT_DENIED_TOOLS` 是这份隔离的唯一来源，所以这个测试直接对着它断言：将来加工具时忘了
 * 同步，测试会在这里失败，而不是等到真模型在子任务里撞一次墙。
 */
describe('子任务的提示词：不许出现它没有的工具', () => {
  const sub = (over: { kbReadOnly?: boolean } = {}) =>
    getSystemPrompt(root, 'general', false, { subagent: true, ...over });

  it('一个被拒绝的工具名都不出现', () => {
    const p = sub();
    const leaked = p.match(SUBAGENT_DENIED_TOOLS);
    assert.equal(leaked, null, `子级提示词里出现了它没有的工具：${leaked?.[0]}`);
  });

  it('只读子级同样干净（两个开关叠加是最容易漏的组合）', () => {
    const p = sub({ kbReadOnly: true });
    assert.equal(p.match(SUBAGENT_DENIED_TOOLS), null);
  });

  it('主级提示词照旧列出这些工具 —— 否则上面的断言可以靠「全删了」通过', () => {
    // 逐条对照，而不是抽查一个：控制组必须覆盖被断言为「不该出现」的每一个名字，
    // 否则删掉一整段（比如计划）仍然能让测试变绿。
    for (const name of ['plan_create', 'plan_update', 'plan_list', 'preflight_record',
      'reflection_check', 'report_write', 'memo_add', 'schedule_window', 'kb_ingest_scan']) {
      assert.match(prompt(), new RegExp(`\\b${name}\\b`), `主级提示词里少了 ${name}`);
    }
  });

  it('段落级的说明也一起撤掉，而不是只删工具名', () => {
    const p = sub();
    for (const section of ['## Long-range plans', '## Pre-flight Intent Analysis',
      '## Scheduling Your Own Work', '## Self-Review']) {
      assert.equal(p.includes(section), false, `子级提示词里还留着 ${section}`);
    }
  });

  it('它真正拥有的那半边一字不能少', () => {
    const p = sub();
    for (const keep of ['先 `kb_query`', '`fs_read`', '`shell`', '`lsp_diagnostics`', '`errorbook_lookup`']) {
      assert.ok(p.includes(keep), `子级提示词里少了 ${keep}`);
    }
  });

  it('明确说清工具集比主级小，而不是留一个沉默的缺口', () => {
    // 沉默的代价是子级会开始猜：既然提示词没提，那大概是我漏看了 —— 于是去调，于是报错。
    assert.match(sub(), /工具集比主会话小/);
    assert.match(sub(), /请在交付物里说明/);
  });
});
