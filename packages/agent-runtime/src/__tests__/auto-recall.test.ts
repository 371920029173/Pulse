/**
 * 自动召回的判据。
 *
 * 用户报的缺陷：「模型要在 KB 里找到这个东西，前提是模型还记得这个东西的一点碎片记忆……
 * 上下文召回不是很聪明」，而实测 digbug 会话最近 900 条里 kb_* 调用**全是写、一次读都没有**。
 * 这里钉三件事：
 *   1. 该闭嘴的时候闭嘴（问候、太短、查不到、分数低于地板、引擎抛错）—— 一个字节都不加；
 *   2. 有命中时，块里带着组路径与 node id（模型据此能直接 kb_get 原文）；
 *   3. 真的接在请求上了：末尾带【自动召回】，而且 SHE_KB_AUTO_RECALL=0 能关掉。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import { renderAutoRecall, shouldAutoRecall } from '../auto-recall.js';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

const hit = (i: number, score = 0.9) => ({
  nodes: { id: `n${i}`, title: `节点标题${i}`, content: `正文${i}` },
  trace: { finalScore: score, groupPath: ['project/x'] },
});

function engineOf(list: Array<{ nodes: { id: string; title: string; content: string }; trace: { finalScore: number; groupPath: string[] } }>) {
  return {
    query: () => ({
      nodes: list.map((h) => h.nodes),
      traces: list.map((h) => h.trace),
    }),
  };
}

describe('auto-recall：该说才说', () => {
  it('问候与太短的话：不查、不加（"你好"那条本来就已经是最贵的一轮）', () => {
    assert.equal(shouldAutoRecall('你好'), false);
    assert.equal(shouldAutoRecall('谢谢！'), false);
    assert.equal(shouldAutoRecall('continue'), false);
    assert.equal(shouldAutoRecall('好'), false);
    assert.equal(renderAutoRecall(engineOf([hit(0)]) as never, '你好'), '');
  });

  it('有命中：块里带组路径、摘要与 node id（据此能直接 kb_get）', () => {
    const block = renderAutoRecall(engineOf([hit(0)]), '这条会话的登录流程是怎么做的？');
    assert.match(block, /【自动召回】/);
    assert.match(block, /project\/x/);
    assert.match(block, /节点标题0/);
    assert.match(block, /Node: n0/);
  });

  it('分数低于地板：当作没有（宁可不提，也不要塞一堆不相关的）', () => {
    assert.equal(renderAutoRecall(engineOf([hit(0, 0.05)]), '这条会话的登录流程是怎么做的？'), '');
  });

  it('查不到：空串', () => {
    assert.equal(renderAutoRecall(engineOf([]), '这条会话的登录流程是怎么做的？'), '');
  });

  it('引擎抛错：空串 —— 召回失败绝不许弄坏一轮对话', () => {
    const broken = { query: () => { throw new Error('kb exploded'); } };
    assert.equal(renderAutoRecall(broken as never, '这条会话的登录流程是怎么做的？'), '');
  });

  it('上限：最多 5 条、不超过字符上限', () => {
    const many = Array.from({ length: 9 }, (_, i) => hit(i));
    const block = renderAutoRecall(engineOf(many), '这条会话的登录流程是怎么做的？');
    assert.equal((block.match(/- \[/g) ?? []).length, 5, '条数没有封顶');
    assert.ok(block.length <= 1200 + 200, `块太长了：${block.length}`);
  });
});

// ── 接线：真的接在请求上了 ───────────────────────────────────────────────────
class RecordingProvider implements LLMProvider {
  name = 'stub';
  sent: LLMMessage[][] = [];
  async chat(messages: LLMMessage[], _tools?: ToolDefinition[], onChunk?: (c: StreamChunk) => void): Promise<LLMMessage> {
    this.sent.push(messages.map((m) => ({ ...m })));
    onChunk?.({ type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cache_hit_tokens: 0, cache_miss_tokens: 100, reasoning_tokens: 0 } });
    return { role: 'assistant', content: 'ok' };
  }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-autorecall-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeAgent(provider: RecordingProvider, engine: unknown): Agent {
  const config = {
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
    workspace: { root: dir },
    kb: { dbPath: join(dir, 'kb.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5, pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 } },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
  } as never;
  const a = new Agent(config, engine as never, { definitions: [], execute: async () => '' } as never, null);
  (a as unknown as { provider: LLMProvider }).provider = provider;
  return a;
}

const lastOf = (p: RecordingProvider) => String(p.sent[0]?.at(-1)?.content ?? '');

describe('auto-recall：接在请求末尾', () => {
  it('一句话进来 → 请求末尾带上【自动召回】（含 node id）', async () => {
    const provider = new RecordingProvider();
    await makeAgent(provider, engineOf([hit(0)])).chat('这条会话的登录流程是怎么做的？');
    assert.match(lastOf(provider), /【自动召回】/);
    assert.match(lastOf(provider), /Node: n0/);
  });

  it('问候语进来 → 一个字节都不加', async () => {
    const provider = new RecordingProvider();
    await makeAgent(provider, engineOf([hit(0)])).chat('你好');
    assert.doesNotMatch(lastOf(provider), /【自动召回】/);
  });

  it('SHE_KB_AUTO_RECALL=0：关得掉', async () => {
    process.env.SHE_KB_AUTO_RECALL = '0';
    try {
      const provider = new RecordingProvider();
      await makeAgent(provider, engineOf([hit(0)])).chat('这条会话的登录流程是怎么做的？');
      assert.doesNotMatch(lastOf(provider), /【自动召回】/);
    } finally {
      delete process.env.SHE_KB_AUTO_RECALL;
    }
  });
});
