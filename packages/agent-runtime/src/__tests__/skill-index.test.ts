/**
 * 系统提示词瘦身（token 削减第 6 项）。
 *
 * 两件事，都是「同一份内容每个请求付两次钱」：
 *
 *   1. **逐条工具清单。** 每个工具的名字、用途和参数已经作为工具定义随请求发送，提示词里再抄一份
 *      纯属重复（而且两份会漂移：子任务曾被告知它没有的工具）。现在只留一行说明，以及定义里没有
 *      的行为约定（备忘属于整个工作区）。
 *   2. **技能全文。** 当前档位的所有技能全文每个请求都内联一遍，不管任务和它有没有关系。现在
 *      提示词里只有索引（名字 + 标题 + 一行用途，按名字稳定排序），全文用 `skill_read` 按需取。
 *
 * 还有一条硬约束：同样的输入，提示词必须逐字节相同 —— 它是缓存前缀的开头。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSystemPrompt, readSkill, summarizeSkill, SUBAGENT_DENIED_TOOLS } from '../system-prompt.js';
import { createSkillTools } from '../skill-tools.js';
import { Agent } from '../agent.js';

const DEEP = 'BODY-MARKER-ONLY-IN-FULL-TEXT';
const savedBundled = process.env.SHE_BUNDLED_SKILLS;
let base: string;
let ws: string;
let bundled: string;

function put(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

/** The bundled set, written in the given order (the order must not matter). */
const BUNDLED: Array<[string, string]> = [
  ['_common/zeta-common.md', `# 公共 · Zeta\n\n用户问「Zeta」时用。\n\n## 步骤\n1. 第一步\n2. ${DEEP}-zeta\n`],
  ['dev/alpha.md', `# 开发 · Alpha\n\nUse when building things.\n\n## Steps\n- ${DEEP}-alpha\n`],
  ['dev/beta.md', `# 打包 · Beta\n\nBUNDLED-BETA-PURPOSE\n\n- ${DEEP}-beta-bundled\n`],
  ['liberal/other-profile.md', '# 别的档\n\nOTHER-PROFILE-PURPOSE\n'],
  // Nothing but steps through tools a child does not have.
  ['_common/ingest-only.md', '# 归位\n\n1. `kb_ingest_scan` path=…\n2. `kb_ingest_place` 归位\n'],
  // Only one of its steps is parent-only.
  ['dev/mixed.md', `# 混合\n\n适用：混合场景。\n\n1. 先 \`plan_create\` 立计划\n2. ${DEEP}-mixed-kept\n`],
];

function writeBundled(root: string, order = BUNDLED): void {
  for (const [rel, text] of order) put(root, rel, text);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'she-skills-'));
  ws = join(base, 'ws');
  bundled = join(base, 'bundled');
  mkdirSync(ws, { recursive: true });
  writeBundled(bundled);
  // The workspace overrides a bundled skill of the same name.
  put(ws, '.she/skills/dev/beta.md', `# 工作区 · Beta\n\nWORKSPACE-BETA-PURPOSE\n\n- ${DEEP}-beta-workspace\n`);
  put(ws, '.she/skill-profile.json', JSON.stringify({ profile: 'dev' }));
  process.env.SHE_BUNDLED_SKILLS = bundled;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  if (savedBundled === undefined) delete process.env.SHE_BUNDLED_SKILLS;
  else process.env.SHE_BUNDLED_SKILLS = savedBundled;
});

const main = (root = ws) => getSystemPrompt(root, 'dev', true);
const sub = (root = ws) => getSystemPrompt(root, 'dev', true, { subagent: true });

/** The names in the Project Skills index, in the order the prompt lists them. */
function indexNames(prompt: string): string[] {
  const start = prompt.indexOf('\n## Project Skills');
  if (start < 0) return [];
  const end = prompt.indexOf('\n## ', start + 1);
  const section = prompt.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
}

describe('提示词不再重复工具定义', () => {
  it('没有「## Available Tools」段，也没有逐条的工具说明（主级和子级都是）', () => {
    for (const p of [main(), sub()]) {
      assert.doesNotMatch(p, /## Available Tools/);
      assert.doesNotMatch(p, /^- `kb_get`:/m, '还在逐条描述 kb_get');
      assert.doesNotMatch(p, /`fs_read`, `fs_write`, `fs_list`, `grep`, `shell`/, '还在罗列沙箱工具');
      assert.doesNotMatch(p, /^- `lsp_definition` \/ `lsp_references`/m, '还在罗列 LSP 工具');
      assert.match(p, /tool definitions sent with this request/, '缺了那一行说明');
    }
  });

  it('工具定义里没有的行为约定留下来了（备忘属于整个工作区）', () => {
    assert.match(main(), /\.she\/memo\.json/);
    assert.match(main(), /Every chat in this project reads and writes the same one/);
  });

  it('子级照旧被告知工具集比主会话小，且不出现它没有的工具', () => {
    const p = sub();
    assert.match(p, /工具集比主会话小/);
    assert.equal(p.match(SUBAGENT_DENIED_TOOLS), null);
  });
});

describe('技能索引', () => {
  it('列出名字、标题和一行用途，按名字稳定排序', () => {
    const p = main();
    assert.deepEqual(indexNames(p), ['alpha', 'beta', 'ingest-only', 'mixed', 'zeta-common']);
    assert.ok(p.includes('- `alpha` 开发 · Alpha — Use when building things.'), '索引行格式不对');
    assert.ok(p.includes('- `zeta-common` 公共 · Zeta — 用户问「Zeta」时用。'));
  });

  it('技能正文不进提示词', () => {
    assert.equal(main().includes(DEEP), false, '技能全文仍被内联');
    assert.equal(sub().includes(DEEP), false);
  });

  it('提示词告诉模型用 skill_read 取全文', () => {
    assert.match(main(), /load the full recipe with `skill_read`/);
  });

  it('别的档位的技能不进索引', () => {
    assert.equal(main().includes('other-profile'), false);
    assert.equal(main().includes('OTHER-PROFILE-PURPOSE'), false);
  });

  it('工作区同名技能覆盖内置的那份', () => {
    const p = main();
    assert.ok(p.includes('WORKSPACE-BETA-PURPOSE'));
    assert.equal(p.includes('BUNDLED-BETA-PURPOSE'), false);
  });

  it('标了 always-on 的技能仍然全文内联，其余照旧只进索引', () => {
    put(ws, '.she/skills/_common/core.md', `<!-- always-on -->\n# 核心\n\n${DEEP}-core\n`);
    const p = main();
    assert.ok(p.includes(`${DEEP}-core`), 'always-on 技能没有内联');
    assert.equal(indexNames(p).includes('core'), false, 'always-on 技能不该再占一条索引');
    assert.equal(p.includes(`${DEEP}-alpha`), false);
  });

  it('没有任何技能时不生成该段，也不注册 skill_read', () => {
    const empty = join(base, 'empty-bundle');
    mkdirSync(empty, { recursive: true });
    process.env.SHE_BUNDLED_SKILLS = empty;
    const bare = join(base, 'bare');
    mkdirSync(bare, { recursive: true });
    assert.doesNotMatch(main(bare), /## Project Skills/);
    assert.equal(createSkillTools(bare, 'dev').definitions.length, 0);
  });

  it('用途行：取第一行正文，过长按码点截断；front-matter 的 description 优先', () => {
    const long = summarizeSkill(`# 标题\n\n${'字'.repeat(200)}`);
    assert.equal(long.title, '标题');
    assert.equal([...long.purpose].length, 81);
    assert.ok(long.purpose.endsWith('…'));
    const fm = summarizeSkill('---\nname: x\ndescription: "从 front-matter 来"\n---\n# T\n\n正文第一行');
    assert.deepEqual(fm, { title: 'T', purpose: '从 front-matter 来' });
    assert.equal(summarizeSkill('# T\n\n## 职责\n- **理解**目标').purpose, '理解目标');
  });
});

describe('skill_read：按需取全文', () => {
  it('按名字读出全文（带不带 .md、大小写都行）', async () => {
    const t = createSkillTools(ws, 'dev');
    assert.deepEqual(t.definitions.map((d) => d.name), ['skill_read']);
    for (const name of ['alpha', 'alpha.md', 'ALPHA']) {
      const out = await t.execute('skill_read', { name });
      assert.ok(out.includes(`${DEEP}-alpha`), `${name} 没读出全文：${out}`);
      assert.ok(out.includes('# 开发 · Alpha'));
    }
  });

  it('读到的是工作区覆盖后的那份', async () => {
    const out = await createSkillTools(ws, 'dev').execute('skill_read', { name: 'beta' });
    assert.ok(out.includes(`${DEEP}-beta-workspace`));
    assert.equal(out.includes(`${DEEP}-beta-bundled`), false);
  });

  it('未知名字报错并列出可用的名字', async () => {
    const out = await createSkillTools(ws, 'dev').execute('skill_read', { name: 'nope' });
    assert.match(out, /^Error: /);
    assert.ok(out.includes('alpha, beta, ingest-only, mixed, zeta-common'), out);
  });

  it('索引里列出的每一个名字都读得到（主级与子级）', () => {
    for (const [prompt, subagent] of [[main(), false], [sub(), true]] as const) {
      const names = indexNames(prompt);
      assert.ok(names.length > 0);
      for (const n of names) assert.ok(readSkill(ws, 'dev', n, { subagent }), `${n} 在索引里却读不到`);
    }
  });

  it('子级：读到的正文里没有它没有的工具；只剩这类步骤的技能整份不列出、读不到', async () => {
    const t = createSkillTools(ws, 'dev', { subagent: true });
    const mixed = await t.execute('skill_read', { name: 'mixed' });
    assert.ok(mixed.includes(`${DEEP}-mixed-kept`));
    assert.equal(mixed.match(SUBAGENT_DENIED_TOOLS), null, `子级读到了它没有的工具：${mixed}`);
    assert.match(await t.execute('skill_read', { name: 'ingest-only' }), /^Error: /);
    assert.equal(indexNames(sub()).includes('ingest-only'), false);
    assert.ok(indexNames(main()).includes('ingest-only'), '主级应当照常列出');
  });

  it('工具定义是静态的：不含技能名，跨工作区逐字节相同', () => {
    const other = join(base, 'other');
    put(other, '.she/skills/dev/only-here.md', '# 只在这里\n\n别处没有。\n');
    const a = JSON.stringify(createSkillTools(ws, 'dev').definitions);
    const b = JSON.stringify(createSkillTools(other, 'dev').definitions);
    assert.equal(a, b);
    assert.equal(a.includes('alpha'), false);
  });
});

describe('确定性：同样的输入，逐字节相同', () => {
  it('两次构建完全相同（主级与子级）', () => {
    assert.equal(main(), main());
    assert.equal(sub(), sub());
  });

  it('与文件的创建顺序无关（遮掉工作区路径后相同）', () => {
    const first = main();
    const bundled2 = join(base, 'bundled2');
    writeBundled(bundled2, [...BUNDLED].reverse());
    const ws2 = join(base, 'ws2');
    put(ws2, '.she/skills/dev/beta.md', `# 工作区 · Beta\n\nWORKSPACE-BETA-PURPOSE\n\n- ${DEEP}-beta-workspace\n`);
    process.env.SHE_BUNDLED_SKILLS = bundled2;
    const second = main(ws2);
    assert.equal(second.split(ws2).join('<WS>'), first.split(ws).join('<WS>'));
  });
});

describe('Agent 注册 skill_read', () => {
  function makeConfig() {
    return {
      llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
      workspace: { root: ws },
      kb: { dbPath: join(ws, 'kb.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5, pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 } },
      skills: { profile: 'dev' },
      automationMode: true,
      server: { port: 0, host: '127.0.0.1' },
      sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
    } as never;
  }
  const tools = { definitions: [], execute: async () => '' } as never;
  type Exec = Map<string, (a: Record<string, unknown>) => Promise<string>>;

  for (const isSubagent of [false, true]) {
    it(`${isSubagent ? '子级' : '主级'}：工具表里有 skill_read，提示词里只有索引，读得出全文`, async () => {
      const a = new Agent(makeConfig(), {} as never, tools, null, isSubagent ? { isSubagent: true } : undefined);
      try {
        assert.ok(a.getToolDefinitions().some((d) => d.name === 'skill_read'), '没有注册 skill_read');
        const prompt = a.getSystemPromptText();
        assert.ok(indexNames(prompt).includes('alpha'));
        assert.equal(prompt.includes(DEEP), false);
        const exec = (a as unknown as { executors: Exec }).executors.get('skill_read');
        assert.ok(exec);
        assert.ok((await exec!({ name: 'alpha' })).includes(`${DEEP}-alpha`));
      } finally {
        await (a as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
      }
    });
  }
});
