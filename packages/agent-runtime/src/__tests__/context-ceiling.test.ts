/**
 * 上下文天花板：会话不该在撞上模型窗口时死掉。
 *
 * 这里钉的是**救援**，不是"省钱"（那是 `context-budget.test.ts`）。用户报的问题是：上下文一到模型
 * 上限就整条会话不可用 —— 提示词原样发出、模型端 4xx、`failTurn` 归成"模型端错误"、重试必然同样
 * 失败而历史只会更长。
 *
 * 修法有两半，每一半都有反面：阈值那半靠"我们猜的窗口"（猜大了就轮不到它），溢出那半靠模型端
 * 自己说话。每一条断言都对应一个具体的失效方式：
 *
 *   - 切点必须落在 assistant 上（切在 user 上 = 连续两条 user = 请求不合法，救援代码自己弄坏会话）
 *   - 摘要必须**冻结**（每轮重算 = 每轮改前缀 = 每轮全价，见 docs/context-and-caching.md）
 *   - 到阈值之前请求逐字节不变（`compaction.test.ts` / `prefix-stability.test.ts` 也钉着这一条）
 *   - 关掉开关后两条自动路径都不许压（"设置里明明关了"那类意外）
 *   - 压不动就说压不动，不许假装压过
 *   - 盘上的转写一条不动（压的只是发给模型的那一份）
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import {
  anchorsIn,
  breakdownRequest,
  calibrateCharsPerToken,
  chooseCutIndex,
  compactionCut,
  digestMessage,
  DIGEST_MARK,
  estimateRequest,
  fingerprint,
  isContextOverflowError,
  keepTokensFor,
  retrievalAnchors,
  toolResultBudgetChars,
  userLinesExcerpt,
  windowFromOverflowError,
  MIN_KEEP_TOKENS,
  type CompactionState,
} from '../compaction.js';
import { budgetToolResultOnArrival } from '../tool-output.js';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from '@she/shared';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

/** 模型端真正的溢出报文（DeepSeek 的措辞，实测形状）。 */
const OVERFLOW_TEXT = "This model's maximum context length is 65536 tokens. Please reduce the length of the messages.";

class StubProvider implements LLMProvider {
  name = 'stub';
  /** 每一轮**对话**请求（摘要那次不算）的完整消息，按顺序。 */
  sent: LLMMessage[][] = [];
  digestCalls = 0;
  /** 还没还清的溢出次数：还清之前每次对话请求都报"太长"。 */
  overflowLeft = 0;
  /** 报的是哪一句"太长"（有些用例要报文里带着真实上限的数字）。 */
  overflowText = OVERFLOW_TEXT;
  /** 摘要调用返回什么。默认一份够长的摘要。 */
  digestReply = `摘要：${'z'.repeat(80)}`;
  /** 报不报缓存拆分（经济学要它才知道"付了多少"）。 */
  reportCacheMiss = false;
  /** 下一轮要发的工具调用（用来驱动"取回"）。 */
  nextToolCall: { name: string; arguments: string } | null = null;
  /**
   * 桩把"提示词有多少 token"报成什么数。
   * 0 = 老行为（固定报 100）。设成别的值就模拟"这个端点用的是另一套分词器"。
   */
  reportCharsPerToken = 0;

  async chat(messages: LLMMessage[], _tools?: ToolDefinition[], onChunk?: (c: StreamChunk) => void): Promise<LLMMessage> {
    const isDigest = messages.some((m) => m.role === 'system' && m.content.includes('压缩成一份摘要'));
    if (isDigest) {
      this.digestCalls++;
      return { role: 'assistant', content: this.digestReply };
    }
    this.sent.push(messages.map((m) => ({ ...m })));
    /*
     * 提示词的字符数**必须把工具表算进去**：agent 那边算 pendingRequestChars 时是含它的，而工具表
     * 在本仓库是两万多字符 —— 少算它，比例就差了近一倍，护栏会（正确地）把样本当成量级错误丢掉。
     */
    const chars = (_tools ? JSON.stringify(_tools).length : 0)
      + messages.reduce((n, m) => n + String(m.content ?? '').length, 0);
    const promptTokens = this.reportCharsPerToken > 0
      ? Math.max(1, Math.ceil(chars / this.reportCharsPerToken))
      : 10;
    onChunk?.({
      type: 'usage',
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 1,
        total_tokens: promptTokens + 1,
        ...(this.reportCacheMiss ? { cache_hit_tokens: 0, cache_miss_tokens: promptTokens } : {}),
      },
    });
    if (this.overflowLeft > 0) {
      this.overflowLeft -= 1;
      throw new Error(this.overflowText);
    }
    if (this.nextToolCall) {
      const call = this.nextToolCall;
      this.nextToolCall = null;
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-retrieve-1', type: 'function', function: { name: call.name, arguments: call.arguments } }],
      } as LLMMessage;
    }
    return { role: 'assistant', content: 'ok' };
  }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-ceiling-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const BASE_LLM = {
  provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k',
  maxTokens: 100, temperature: 0, thinkingLevel: 'low', contextWindow: 40_000,
};

function makeConfig(over: Record<string, unknown> = {}) {
  return {
    llm: { ...BASE_LLM, ...(over.llm as Record<string, unknown> ?? {}) },
    workspace: { root: dir },
    kb: { dbPath: join(dir, 'kb.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5, pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 } },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
    context: {
      compression: 'off', allowHistoryReduction: false, autoCompact: true, compactAtShare: 0.8,
      pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
      ...(over.context as Record<string, unknown> ?? {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'llm' && k !== 'context')),
  } as never;
}

function makeAgent(provider: StubProvider, sessionId: string | null = 'sess-ceiling', over: Record<string, unknown> = {}) {
  const a = new Agent(makeConfig(over), {} as never, { definitions: [], execute: async () => '' } as never, sessionId);
  (a as unknown as { provider: LLMProvider }).provider = provider;
  return a;
}

/** 把历史灌到"远超窗口"：每块 10k 字符的 user + 一条 ack，约 2.9k tokens。 */
function fillBulk(agent: Agent, blocks: number, charsPer = 10_000) {
  const bulk: LLMMessage[] = [];
  for (let i = 0; i < blocks; i++) {
    bulk.push({ role: 'user', content: `block ${i} ` + 'x'.repeat(charsPer) });
    bulk.push({ role: 'assistant', content: `ack ${i}` });
  }
  agent.setHistory([...agent.getHistory(), ...bulk]);
}

const hasDigest = (messages: LLMMessage[]) => messages.some((m) => m.content.startsWith(DIGEST_MARK));
const collect = () => {
  const chunks: StreamChunk[] = [];
  return { chunks, onChunk: (c: StreamChunk) => chunks.push(c) };
};

describe('窗口从哪来（三来源 + 保守默认）', () => {
  it('配置 > 环境 > 模型名 > 默认，且每一步都点名来源', () => {
    assert.equal(resolveContextWindow({ configured: 40_000, envValue: '32000', model: 'claude-3-5-sonnet' }).source, 'config');
    assert.equal(resolveContextWindow({ configured: 40_000, model: 'claude-3-5-sonnet' }).tokens, 40_000);
    assert.equal(resolveContextWindow({ envValue: '32000', model: 'claude-3-5-sonnet' }).source, 'env');
    assert.equal(resolveContextWindow({ envValue: '32000', model: 'claude-3-5-sonnet' }).tokens, 32_000);
    assert.equal(resolveContextWindow({ model: 'claude-3-5-sonnet-20241022' }).tokens, 200_000);
    assert.equal(resolveContextWindow({ model: 'openai/gpt-4o-2024-11-20' }).tokens, 128_000);
    // 更窄的族必须赢：gpt-3.5 排在 gpt-4 那一类前面，否则 16k 的模型会拿到 128k。
    assert.equal(resolveContextWindow({ model: 'gpt-3.5-turbo' }).tokens, 16_000);
    assert.equal(resolveContextWindow({ model: 'deepseek-chat' }).tokens, 128_000);
    // V4 系列按厂商规格（2026-10-06）：上下文 1M。窄的族必须赢过笼统的 /deepseek/。
    assert.equal(resolveContextWindow({ model: 'deepseek-flash' }).tokens, 1_000_000);
    assert.equal(resolveContextWindow({ model: 'deepseek-v4-pro' }).tokens, 1_000_000);
    assert.equal(resolveContextWindow({ model: 'deepseek-v4-flash-0731' }).tokens, 1_000_000);
    assert.equal(resolveContextWindow({ model: 'some-unknown-model' }).tokens, DEFAULT_CONTEXT_WINDOW);
  });

  it('0 是"回到自动识别"，不是"窗口是 0"', () => {
    const info = resolveContextWindow({ configured: 0, model: 'claude-3-5-sonnet' });
    assert.equal(info.source, 'model');
    assert.equal(info.tokens, 200_000);
  });

  it('第二次压缩的保留量更少（keepScale）', () => {
    assert.ok(keepTokensFor(40_000, 0.25) < keepTokensFor(40_000, 1), '第二次必须留得更少，否则压了等于没压');
    // 但不能小到没有上下文：下限是 MIN_KEEP_TOKENS 的一半。
    assert.ok(keepTokensFor(40_000, 0.01) >= MIN_KEEP_TOKENS / 2);
  });

  it('写坏的值不被当成窗口用', () => {
    assert.equal(resolveContextWindow({ envValue: '40k', model: 'unknown' }).source, 'default');
    assert.equal(resolveContextWindow({ envValue: '-5', model: 'unknown' }).source, 'default');
    assert.equal(resolveContextWindow({ envValue: '0', model: 'unknown' }).source, 'default');
  });
});

describe('估算必须含固定开销', () => {
  it('系统消息与工具表不在 messages 里，但决定这次请求会不会被拒', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'x'.repeat(3470) }];
    assert.equal(estimateRequest(messages).tokens, 1000);
    assert.equal(estimateRequest(messages, 3470).tokens, 2000);
  });
});

describe('切点约束', () => {
  it('切点落在 assistant 上，绝不落在 user 上', () => {
    const history: LLMMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b'.repeat(20_000) },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ];
    const cut = chooseCutIndex(history, MIN_KEEP_TOKENS);
    assert.ok(cut > 0, '应该有切点');
    assert.equal(history[cut].role, 'assistant', '摘要以 user 插入，切在 user 上会得到连续两条 user');
  });

  it('历史太短时压不动，返回 -1（调用方要说压不动，不许假装压过）', () => {
    assert.equal(chooseCutIndex([{ role: 'user', content: 'hi' }], MIN_KEEP_TOKENS), -1);
    assert.equal(
      chooseCutIndex([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'again' },
      ], MIN_KEEP_TOKENS),
      -1,
    );
  });

  it('压缩点优先认记录下来的 covered，不靠指纹扫描', () => {
    const history: LLMMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: 'c' },
    ];
    const state = {
      v: 1, covered: 3, nextFingerprint: fingerprint(history[3]),
      digest: 'x'.repeat(60), source: 'model', at: 't', reason: 'threshold', beforeTokens: 1, afterTokens: 1,
    } as CompactionState;
    // 两条 assistant 的开头一模一样，指纹相同 —— 从头扫会挑中 1，那样本该被折叠的一段又进了请求。
    assert.equal(compactionCut(state, history), 3);
  });

  it('下标漂移（丢了几行）时取离记录位置最近的匹配，而不是最前面那个', () => {
    const full: LLMMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: 'c' },
    ];
    const state = {
      v: 1, covered: 3, nextFingerprint: fingerprint(full[3]),
      digest: 'x'.repeat(60), source: 'model', at: 't', reason: 'threshold', beforeTokens: 1, afterTokens: 1,
    } as CompactionState;
    const drifted = full.slice(1);
    assert.equal(compactionCut(state, drifted), 2, '最近的那个匹配才是原来那条边界');
  });
});

describe('溢出分类：既能兜住，也不误伤', () => {
  it('认得出各家说"太长"的说法', () => {
    for (const text of [
      OVERFLOW_TEXT,
      'Error 400: context_length_exceeded',
      'The prompt is too long for this model',
      'Input is too large: 200000 tokens in your prompt',
      '请求的上下文长度超出模型上限',
    ]) {
      assert.equal(isContextOverflowError(new Error(text)), true, text);
    }
  });

  it('限流/超时/鉴权不算溢出（把它们拉进压缩是白付一次全价）', () => {
    for (const text of [
      'Rate limit exceeded, please try again',
      '429 Too Many Requests',
      'request timed out after 60000ms',
      'ECONNRESET',
      'Invalid API key',
    ]) {
      assert.equal(isContextOverflowError(new Error(text)), false, text);
    }
  });
});

describe('到阈值就压，而且压完是稳定的前缀', () => {
  it('压一次：请求里出现摘要、最早的轮次离开请求、盘上转写一条不少', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    fillBulk(a, 12);
    const before = a.getHistory().length;

    await a.chat('hello');

    const last = p.sent[p.sent.length - 1];
    assert.ok(hasDigest(last), '请求里应该有一份压缩摘要');
    assert.ok(!last.some((m) => m.content.startsWith('block 0 ')), '被折叠的早先轮次不该还在请求里');
    assert.ok(last.some((m) => m.content === 'hello'), '这一轮的用户消息当然要在');
    assert.ok(p.digestCalls >= 1, '摘要优先让模型写');

    const history = a.getHistory();
    assert.ok(history.length > before, '盘上的转写只增不减');
    assert.ok(history.some((m) => m.content.startsWith('block 0 ')), '最早的一轮仍在历史里');
    assert.ok(existsSync(join(dir, '.she', 'sessions', 'sess-ceiling', 'compaction.json')), '压缩记录要落盘');
  });

  it('摘要冻结：下一轮逐字节复用同一份，不重算', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    fillBulk(a, 12);
    await a.chat('one');
    const first = p.sent[p.sent.length - 1];
    const digestIndex = first.findIndex((m) => m.content.startsWith(DIGEST_MARK));
    const digestBytes = first[digestIndex].content;
    const digestCallsAfterFirstTurn = p.digestCalls;

    await a.chat('two');
    const next = p.sent[p.sent.length - 1];
    assert.equal(next[digestIndex].content, digestBytes, '摘要必须逐字节冻结，否则每轮都在改前缀');
    assert.equal(next[digestIndex].role, 'user');
    assert.equal(p.digestCalls, digestCallsAfterFirstTurn, '第二段不该再生成一次摘要');
    // 压缩点固定：摘要后面的第一条仍是同一条边界，尾巴只追加。
    assert.deepEqual(
      next.slice(digestIndex + 1, digestIndex + 1 + (first.length - digestIndex - 1)).map((m) => m.content),
      first.slice(digestIndex + 1).map((m) => m.content),
    );
  });

  it('没到阈值时请求逐字节不变（压缩不许提前动手）', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    a.setHistory([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    await a.chat('one');
    await a.chat('two');
    const prev = p.sent[p.sent.length - 2];
    const next = p.sent[p.sent.length - 1];
    for (let i = 0; i < prev.length; i++) {
      assert.equal(next[i]?.content, prev[i]?.content, `第 ${i} 条被改写了`);
      assert.equal(next[i]?.role, prev[i]?.role);
    }
    assert.ok(!next.some((m) => m.content.startsWith(DIGEST_MARK)));
  });

  it('摘要太短就退回机械提取，并如实标注来源', async () => {
    const p = new StubProvider();
    p.digestReply = '太短';
    const a = makeAgent(p);
    fillBulk(a, 12);
    await a.chat('hello');
    assert.equal(a.getContextStatus().compaction?.source, 'extractive');
    assert.ok(hasDigest(p.sent[p.sent.length - 1]));
  });

  it('新建的 agent（重启）复用同一条会话的摘要', async () => {
    const p1 = new StubProvider();
    const a1 = makeAgent(p1);
    fillBulk(a1, 12);
    await a1.chat('one');
    const digest = p1.sent[p1.sent.length - 1].find((m) => m.content.startsWith(DIGEST_MARK));
    assert.ok(digest);

    const p2 = new StubProvider();
    const a2 = makeAgent(p2);
    a2.setHistory(a1.getHistory());
    assert.equal(a2.getContextStatus().compacted, true, '记录要能从盘上读回来');
    await a2.chat('two');
    const reused = p2.sent[p2.sent.length - 1].find((m) => m.content.startsWith(DIGEST_MARK));
    assert.equal(reused?.content, digest.content, '重启后前缀必须和重启前逐字节一致');
  });
});

describe('关掉就是关掉：开关管住两条自动路径', () => {
  it('阈值那条不压', async () => {
    const p = new StubProvider();
    const a = makeAgent(p, 'sess-off', { context: { autoCompact: false } });
    fillBulk(a, 12);
    await a.chat('hello');
    const last = p.sent[p.sent.length - 1];
    assert.ok(!hasDigest(last));
    assert.ok(last.some((m) => m.content.startsWith('block 0 ')), '关掉之后历史完整发出');
    assert.equal(a.getContextStatus().autoCompact, false);
  });

  it('模型端说"太长"的兜底也不压，但状态行点名开关在哪', async () => {
    const p = new StubProvider();
    p.overflowLeft = 5;
    const a = makeAgent(p, 'sess-off', { context: { autoCompact: false } });
    fillBulk(a, 2);
    const { chunks, onChunk } = collect();

    const reply = await a.chat('hello', onChunk);

    assert.match(reply.content, /没有完成/, '关掉之后这一轮按失败处理');
    assert.equal(p.sent.length, 1, '不许重发（重发必然同样失败）');
    assert.ok(!p.sent.some(hasDigest), '关掉之后一次都不许压');
    const said = chunks.map((c) => c.content).join('\n');
    assert.match(said, /SHE_CONTEXT_AUTO_COMPACT/, '要告诉用户开关在哪');
    assert.match(said, /40000/, '顺带报出我们以为的窗口大小 —— 填错了就是它');
  });
});

describe('模型端拒绝时的兜底：压一次再发', () => {
  /*
   * 这三条**故意把历史停在阈值以下**（两块 ≈ 6k tokens，离 32k 的触发线很远）：要测的是"模型端
   * 自己说太长"那条兜底 —— 它存在的全部理由是"我们猜的窗口可能偏大"。如果历史早就越过阈值，请求
   * 在发出去之前就被压过了，测到的就是阈值那条路，而这三种失效方式（猜大、限流、连拒）会一起被
   * 掩盖成"反正看见摘要了"。
   */
  it('溢出一次 → 当场压 → 重发成功，会话活下来', async () => {
    const p = new StubProvider();
    p.overflowLeft = 1;
    const a = makeAgent(p);
    fillBulk(a, 2);

    const reply = await a.chat('hello');

    assert.equal(p.sent.length, 2, '第一次被拒，第二次成功');
    assert.ok(!hasDigest(p.sent[0]), '第一次发的是原样的请求（窗口猜大了，阈值那条线没拦住它）');
    assert.ok(hasDigest(p.sent[1]), '第二次发的是压缩后的请求');
    assert.equal(reply.content, 'ok');
    assert.equal(a.getContextStatus().compaction?.reason, 'overflow');
  });

  it('压不动第二次时不再压：请求次数有界，失败也是诚实的', async () => {
    const p = new StubProvider();
    p.overflowLeft = 5;
    /*
     * 这条报文里**刻意不带数字**：带了就会被"学窗口"读走（见下一组用例），窗口从 20 万变成
     * 65536，而"保留多少"是按窗口算的 —— 那样第一次压缩就切到 2000 tokens，第二次再也压不出更小
     * 的东西（正确地拒绝）。要测"两次压缩、第二次切得更深"，就得让窗口停在 20 万。
     */
    p.overflowText = 'This prompt is too long. Please reduce the length of the messages.';
    const a = makeAgent(p, 'sess-overflow', { llm: { contextWindow: 200_000 } });
    fillBulk(a, 12);

    const reply = await a.chat('hello');

    assert.equal(p.sent.length, 3, '原来一次 + 两次压缩后的重发，到此为止');
    assert.ok(hasDigest(p.sent[1]));
    assert.ok(hasDigest(p.sent[2]));
    assert.match(reply.content, /没有完成/, '压了两次还是被拒，就如实报失败，不再无限压');
    assert.equal(a.getContextStatus().compaction?.reason, 'overflow');
  });

  it('学到真实上限之后仍然有界：压不动就停，不拿钱换一样的结果', async () => {
    const p = new StubProvider();
    p.overflowLeft = 5;
    // 报文里带着 8192：窗口会被当场改成 8192，于是第一次压缩就切到最小尾巴 —— 第二次压不出更小
    // 的东西，正确地拒绝，而不是再发一次一模一样的请求。
    p.overflowText = "This model's maximum context length is 8192 tokens. Please reduce the length of the messages.";
    const a = makeAgent(p, 'sess-bounded', { llm: { contextWindow: 200_000 } });
    fillBulk(a, 12);

    const reply = await a.chat('hello');

    assert.ok(p.sent.length <= 3, `请求次数必须有界，实际 ${p.sent.length}`);
    assert.match(reply.content, /没有完成/);
    assert.equal(a.getContextStatus().window.tokens, 8192, '窗口已按证据改过来');
  });

  it('限流不会被当成溢出：不压、直接交给既有路径', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    fillBulk(a, 2);
    const original = p.chat.bind(p);
    p.chat = async (messages, tools, onChunk) => {
      if (messages.some((m) => m.role === 'system' && m.content.includes('压缩成一份摘要'))) return original(messages, tools, onChunk);
      p.sent.push(messages.map((m) => ({ ...m })));
      throw new Error('Rate limit exceeded, please try again later');
    };

    const reply = await a.chat('hello');

    assert.match(reply.content, /没有完成/);
    assert.ok(!p.sent.some(hasDigest), '限流不该触发压缩：那是一次白付的全价请求 + 丢掉细节');
    assert.equal(a.getContextStatus().compacted, false);
  });
});

describe('手动压：压不动就说压不动', () => {
  it('历史太短时 ok:false 且给出理由', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    a.setHistory([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    const r = await a.forceCompact('manual');
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /压不动/);
    assert.equal(a.getContextStatus().compacted, false);
  });

  it('手动这条路不受自动开关影响（开关的名字是关于"自动"的）', async () => {
    const p = new StubProvider();
    const a = makeAgent(p, 'sess-manual', { context: { autoCompact: false } });
    fillBulk(a, 12);
    const r = await a.forceCompact('manual');
    assert.equal(r.ok, true);
    assert.ok((r.beforeTokens ?? 0) > (r.afterTokens ?? 0), '压完必须真的更小');
    assert.equal(a.getContextStatus().compacted, true);
  });
});

describe('分类账：窗口被谁吃掉了', () => {
  it('按类别分开，且合计就等于这次请求的大小', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 's'.repeat(3470) },
      { role: 'user', content: 'u'.repeat(3470) },
      { role: 'assistant', content: 'a'.repeat(3470) },
      { role: 'tool', content: 't'.repeat(3470) },
      { role: 'user', content: DIGEST_MARK + 'd'.repeat(3470 - DIGEST_MARK.length) },
    ];
    const b = breakdownRequest(messages, 3470);
    assert.equal(b.system, 1000);
    assert.equal(b.tools, 1000);
    assert.equal(b.digest, 1000, '摘要那一格只算摘要那一条');
    assert.equal(b.toolResults, 1000);
    assert.equal(b.conversation, 2000, '对话正文 = user + assistant，不含工具结果与摘要');
    assert.equal(b.total, 6000, '合计就是这次请求的全部');
  });

  it('分类账加起来等于 reported 的 usedTokens（面板上两处不能互相矛盾）', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    fillBulk(a, 12);
    await a.chat('hello');
    const st = a.getContextStatus();
    const sum = st.breakdown.system + st.breakdown.tools + st.breakdown.digest
      + st.breakdown.toolResults + st.breakdown.conversation;
    assert.ok(Math.abs(sum - st.usedTokens) <= 4, `分类之和 ${sum} 与总量 ${st.usedTokens} 差太多`);
    assert.ok(st.breakdown.digest > 0, '压过之后摘要那一格要大于 0');
    assert.ok(st.breakdown.system > 1000, '系统提示词那一格是真的（本仓库 20k 字符量级）');
  });
});

describe('压缩不再等于丢失：原文落盘 + 抬头给路径', () => {
  it('被折叠的那一段能读回来，路径写在摘要抬头里', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    fillBulk(a, 12);
    await a.chat('hello');

    const path = a.getContextStatus().compaction?.sourcePath;
    assert.ok(path, '要给出可读路径');
    assert.ok(!path.startsWith('..'), '路径必须在工作区内');
    const abs = join(dir, path);
    assert.ok(existsSync(abs), `路径要真的存在：${abs}`);
    assert.match(readFileSync(abs, 'utf8'), /block 0 /, '最早那一轮要在原文里');
    const digest = p.sent.at(-1)?.find((m) => m.content.startsWith(DIGEST_MARK));
    assert.ok(digest?.content.includes(path), '摘要抬头要写出路径（否则模型不知道去哪读）');
  });

  it('路径跟着摘要一起冻结：第二轮逐字节不变', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    fillBulk(a, 12);
    await a.chat('one');
    const first = p.sent.at(-1)?.find((m) => m.content.startsWith(DIGEST_MARK))?.content;
    await a.chat('two');
    const next = p.sent.at(-1)?.find((m) => m.content.startsWith(DIGEST_MARK))?.content;
    assert.equal(next, first);
  });
});

describe('从拒绝里学窗口：猜一次错，之后不必再猜', () => {
  it('认得出报文里点名的上限，且不认 max_tokens 那种数字', () => {
    assert.equal(windowFromOverflowError(new Error("This model's maximum context length is 65536 tokens. However, you requested 130000 tokens")), 65536);
    assert.equal(windowFromOverflowError(new Error('context length is 128,000 tokens')), 128000);
    assert.equal(windowFromOverflowError(new Error('The context window is 32768')), 32768);
    assert.equal(windowFromOverflowError(new Error('请求超出上下文上限 65536')), 65536);
    assert.equal(windowFromOverflowError(new Error('max_tokens: 4096 is invalid')), undefined, '不许把 max_tokens 当成窗口');
    assert.equal(windowFromOverflowError(new Error('request id 12345678 failed')), undefined);
    assert.equal(windowFromOverflowError(new Error('too many tokens')), undefined, '没点名上下文就不猜');
    assert.equal(windowFromOverflowError(new Error('maximum context length is 1 tokens')), undefined, '荒唐的值不要');
  });

  it('学到的值比设置小 → 按证据走；比设置大 → 按设置走', () => {
    const learned = resolveContextWindow({ configured: 40_000, learned: 8192, model: 'stub' });
    assert.equal(learned.tokens, 8192);
    assert.equal(learned.source, 'learned');
    const keep = resolveContextWindow({ configured: 40_000, learned: 200_000, model: 'stub' });
    assert.equal(keep.tokens, 40_000);
    assert.equal(keep.source, 'config');
  });

  it('真被拒一次之后：窗口当场改过来、落盘、下一次构造直接用', async () => {
    const p = new StubProvider();
    p.overflowLeft = 1;
    // 桩报的是 8k 上限，而配置说 40k —— 差的正是"猜错"这件事。
    p.overflowText = "This model's maximum context length is 8192 tokens. Please reduce the length of the messages.";
    const a = makeAgent(p);
    fillBulk(a, 2);

    const reply = await a.chat('hello');

    assert.equal(a.getContextStatus().window.tokens, 8192, '当场就改按证据算');
    assert.equal(a.getContextStatus().window.source, 'learned');
    assert.equal(reply.content, 'ok', '这一轮照常救回来');
    const file = join(dir, '.she', 'context-window.json');
    assert.ok(existsSync(file), '要落盘，否则下次还要再学一遍');

    // 新 agent（同工作区 / 同模型 / 同端点）一上来就按学到的数算。
    const a2 = makeAgent(new StubProvider());
    assert.equal(a2.getContextStatus().window.tokens, 8192);
    assert.equal(a2.getContextStatus().window.source, 'learned');
  });

  it('换个模型不继承上一个模型的边界', async () => {
    const p = new StubProvider();
    p.overflowLeft = 1;
    p.overflowText = 'maximum context length is 8192 tokens';
    const a = makeAgent(p, 'sess-learn', { llm: { contextWindow: 40_000, model: 'stub' } });
    fillBulk(a, 2);
    await a.chat('hello');
    assert.equal(a.getContextStatus().window.tokens, 8192);

    const other = makeAgent(new StubProvider(), 'sess-learn', { llm: { contextWindow: 40_000, model: 'another-model' } });
    assert.equal(other.getContextStatus().window.tokens, 40_000, '另一个模型看到的是它自己的值');
    assert.equal(other.getContextStatus().window.source, 'config');
  });
});

describe('换算比自校准：用真实用量把 3.47 换成量出来的值', () => {
  it('样本不足用先验，够了取中位数，越界夹紧', () => {
    assert.equal(calibrateCharsPerToken([]), 3.47);
    assert.equal(calibrateCharsPerToken([4.2, 4.2]), 3.47, '两个样本不够，仍然用先验');
    assert.equal(calibrateCharsPerToken([4.2, 4.2, 4.2]), 4.2);
    assert.equal(calibrateCharsPerToken([4.0, 4.4, 4.2]), 4.2, '取中位数而不是均值');
    assert.equal(calibrateCharsPerToken([9, 9, 9]), 5, '荒唐的值夹紧到上界');
    assert.equal(calibrateCharsPerToken([0.5, 0.5, 0.5]), 2.5, '夹紧到下界');
    assert.equal(calibrateCharsPerToken([4.0, Number.NaN, 4.0, -1, 4.0]), 4.0, '坏样本被丢掉，剩下的够用');
  });

  it('端点报的是另一套分词器时，agent 会自己量出来并落盘', async () => {
    const p = new StubProvider();
    p.reportCharsPerToken = 4.2;
    const a = makeAgent(p, 'sess-cal');
    for (const q of ['one', 'two', 'three']) await a.chat(q);

    const st = a.getContextStatus();
    assert.ok(st.estimate.samples >= 3, `样本数 ${st.estimate.samples}`);
    assert.ok(Math.abs(st.estimate.charsPerToken - 4.2) < 0.3,
      `换算比应该接近 4.2，实际 ${st.estimate.charsPerToken}`);
    assert.ok(existsSync(join(dir, '.she', 'estimate-calibration.json')), '要落盘');

    // 新 agent（同工作区 / 同模型 / 同端点）一上来就用量出来的值。
    const a2 = makeAgent(new StubProvider(), 'sess-cal');
    assert.ok(Math.abs(a2.getContextStatus().estimate.charsPerToken - 4.2) < 0.3);
  });

  it('数量级不对的用量样本不算（桩固定报 100 就是这种）', async () => {
    const p = new StubProvider();
    const a = makeAgent(p, 'sess-bad-report');
    for (const q of ['one', 'two', 'three', 'four']) await a.chat(q);
    assert.equal(a.getContextStatus().estimate.charsPerToken, 3.47, '先验不该被一个荒唐的数字带跑');
  });
});

describe('取回锚点：压过的内容怎么找回来', () => {
  it('从原文里抽出可检索的串，确定性、有界、按出现次数排', () => {
    const head: LLMMessage[] = [
      { role: 'user', content: '看 packages/agent-runtime/src/agent.ts 和 packages/kb/src/engine.ts' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'pnpm check:offline' }) } }] } as LLMMessage,
      { role: 'tool', content: 'Error: 3 failed\npackages/agent-runtime/src/agent.ts:41 boom' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'kb_upsert', arguments: JSON.stringify({ groupName: 'architecture/context', title: 'x', content: 'y' }) } }] } as LLMMessage,
    ];
    const a1 = retrievalAnchors(head);
    const a2 = retrievalAnchors(head);
    assert.deepEqual(a1, a2, '同样的段必须给同样的列表（摘要要冻结）');
    assert.ok(a1.some((x) => x.includes('agent.ts')), `要认出文件路径：${a1.join(' | ')}`);
    assert.ok(a1.includes('pnpm'), '要认出命令的可执行名');
    assert.ok(a1.includes('Error:'), '要认出报错标记');
    assert.ok(a1.includes('architecture/context'), '要认出知识库组路径');
    assert.ok(a1.length <= 10, '有界');
    assert.equal(retrievalAnchors([]).length, 0);
  });

  it('抬头里列出来，并跟着摘要一起冻结', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    const bulk: LLMMessage[] = [];
    for (let i = 0; i < 12; i++) {
      bulk.push({ role: 'user', content: `改 ${'packages/x/file' + i}.ts 的时候出错：block ${i} ` + 'x'.repeat(9_900) });
      bulk.push({ role: 'assistant', content: `Error: boom ${i}` });
    }
    a.setHistory(bulk);
    await a.chat('hello');

    const digest = p.sent.at(-1)?.find((m) => m.content.startsWith(DIGEST_MARK))?.content ?? '';
    assert.match(digest, /这些串在原文里真的出现过/, '要给出取回锚点的入口');
    assert.match(digest, /packages\/x\/file\d+\.ts/, '要认出被折叠段里的文件路径');
    /*
     * 断言 file9 而不是 file11：保留量是"最近 ≈4000 token"（夹在 4k–8k），最多也就 8000 token
     * ≈ 2.8 个 9.9k 字符的块 —— 所以 11 号在**保留的尾巴**里、根本没被折叠，它不该出现在锚点表里。
     * 9 号则一定落在被折叠的那一段里（保留下限 4k token 也够不着它）。
     */
    assert.match(digest, /file9\.ts/, '被折叠段里较晚出现的那个文件应该在锚点里');
    await a.chat('again');
    const again = p.sent.at(-1)?.find((m) => m.content.startsWith(DIGEST_MARK))?.content ?? '';
    assert.equal(again, digest, '锚点表也属于冻结的前缀');
  });

  it('没抽出可用的锚点时不印空表', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    fillBulk(a, 12);
    await a.chat('hello');
    const digest = p.sent.at(-1)?.find((m) => m.content.startsWith(DIGEST_MARK))?.content ?? '';
    assert.ok(digest.length > 0);
    assert.doesNotMatch(digest, /这些串在原文里真的出现过/, '一个空的锚点表等于在暗示有线索');
  });
});

describe('锚点自校验：索引不许撒谎', () => {
  it('核对不过的锚点被丢掉；没有原文就一条都不留', () => {
    const blob = 'head packages/a/b.ts 有事 Error: 结尾';
    assert.deepEqual(anchorsIn(blob, ['packages/a/b.ts', 'Error:', '从来没出现过.ts']),
      ['packages/a/b.ts', 'Error:']);
    assert.deepEqual(anchorsIn('', ['packages/a/b.ts']), [], '没有原文时不留任何锚点');
  });

  it('落盘失败（没有原文路径）时抬头一个字都不印锚点', () => {
    const digest = 'x'.repeat(60);
    const noPath = digestMessage({ digest, covered: 5, source: 'model', at: 't', sourcePath: null, anchors: ['packages/a/b.ts'] });
    assert.doesNotMatch(noPath.content, /这些串在原文里真的出现过/, '没有原文时锚点只是装饰');
    const withPath = digestMessage({ digest, covered: 5, source: 'model', at: 't', sourcePath: '.she/sessions/s/compacted/x.jsonl', anchors: ['packages/a/b.ts'] });
    assert.match(withPath.content, /这些串在原文里真的出现过/);
  });
});

describe('取回率：这条路到底有没有人走', () => {
  it('去读 compacted/ 的调用被数出来，别的调用不算', async () => {
    const p = new StubProvider();
    const a = new Agent(
      makeConfig(),
      {} as never,
      { definitions: [{ name: 'fs_read', description: '读文件', parameters: { type: 'object', properties: {} } } as ToolDefinition], execute: async () => '读到了一段原文' } as never,
      'sess-retrieval',
    );
    (a as unknown as { provider: LLMProvider }).provider = p;
    fillBulk(a, 12);
    await a.chat('压一次');
    const path = a.getContextStatus().compaction?.sourcePath;
    assert.ok(path, '先得压过一次');

    p.nextToolCall = { name: 'fs_read', arguments: JSON.stringify({ path, startLine: 1, endLine: 40 }) };
    await a.chat('把那段原文读回来');
    assert.equal(a.getContextStatus().memory.retrievals, 1, '读了 compacted/ 就算一次');

    p.nextToolCall = { name: 'fs_read', arguments: JSON.stringify({ path: 'packages/agent-runtime/src/agent.ts' }) };
    await a.chat('读个普通文件');
    assert.equal(a.getContextStatus().memory.retrievals, 1, '不相关的读取不该计数');
  });
});

describe('压缩经济学：省下的按轮数累计，付出的是真实未命中', () => {
  it('provider 不报缓存拆分时，如实说"还没量到"（不拿估计冒充实测）', async () => {
    const p = new StubProvider();
    // 刻意**不开** reportCacheMiss：这类端点（不报缓存拆分的）就是这条分支要覆盖的。
    const a = makeAgent(p, 'sess-econ');
    fillBulk(a, 12);

    await a.chat('一');
    await a.chat('二');
    await a.chat('三');

    const e = a.getContextStatus().economics;
    assert.ok(e, '压过之后要有账');
    assert.ok(e.rounds >= 3, `轮数 ${e.rounds}`);
    assert.equal(e.paidTokens, null, '没量到就是没量到');
    assert.equal(e.settled, false, '账没结清就不能说"划算"');
    assert.ok(e.netTokens === e.savedTokens, '没量到付出时，净额只由省下的一侧算出来');
  });

  it('provider 报了缓存拆分时，付出与净值都对得上', async () => {
    const p = new StubProvider();
    p.reportCacheMiss = true;
    const a = makeAgent(p, 'sess-econ2');
    fillBulk(a, 12);
    await a.chat('一');
    await a.chat('二');

    const e = a.getContextStatus().economics;
    const s = a.getContextStatus().compaction;
    assert.ok(e && s);
    const paid = e.paidTokens;
    assert.ok(paid !== null && paid > 0, `付掉的未命中 ${paid}`);
    assert.equal(e.savedTokens, Math.max(0, s.beforeTokens - s.afterTokens) * e.rounds);
    assert.equal(e.netTokens, e.savedTokens - paid);
    assert.equal(e.settled, true);
  });
});

describe('预算租借：离天花板越近，一条结果能带进来的越少', () => {
  it('余量充足就是原来的上限，近了按余量收紧，并有一个下限', () => {
    assert.equal(toolResultBudgetChars(0, 40_000), 16_000);
    const mid = toolResultBudgetChars(35_000, 40_000);
    assert.ok(mid < 16_000 && mid > 800, `收紧到 ${mid}`);
    assert.equal(toolResultBudgetChars(39_999, 40_000), 800, '下限是 800 字符');
    assert.ok(toolResultBudgetChars(35_000, 40_000) > toolResultBudgetChars(38_000, 40_000), '越满越紧');
    assert.equal(toolResultBudgetChars(0, 0), 16_000, '窗口未知时不收紧');
  });

  it('收紧之后命令日志仍然落盘、退出码行还在', () => {
    const log = Array.from({ length: 400 }, (_, i) => `第 ${i} 行输出`).join('\n') + '\nexit code: 3\n';
    let saved = '';
    const tight = budgetToolResultOnArrival(log, 'shell', (full) => { saved = full; return '.she/sessions/s/tool-output/x.log'; }, 2_800);
    assert.ok(tight.text.length < 6_000, `收紧后长度 ${tight.text.length}`);
    assert.match(tight.text, /exit code: 3/, '退出码行不能丢');
    assert.equal(saved, log, '全文仍然落盘');
    assert.match(tight.text, /已存到/, '注解要给出取回路径');
  });

  it('状态里给出这一刻的预算', async () => {
    const p = new StubProvider();
    const a = makeAgent(p);
    fillBulk(a, 12);
    await a.chat('一');
    const b = a.getContextStatus().budgetChars;
    assert.equal(typeof b, 'number');
    assert.ok(b >= 800 && b <= 16_000);
  });
});

describe('机械摘录：用户说过的每一句都别丢', () => {
  it('事实与长填充交错、还有重复时，每一条事实都进摘录', () => {
    const head: LLMMessage[] = [];
    for (let i = 0; i < 8; i++) {
      head.push({ role: 'user', content: `记住这一条：KEY-${i + 1} 是 ALPHA-${1111 * (i + 1)}。只回复 ok。` });
      head.push({ role: 'assistant', content: 'ok' });
      head.push({ role: 'user', content: '填充内容。'.repeat(600) });
      head.push({ role: 'assistant', content: '收到。' });
    }
    const excerpt = userLinesExcerpt(head);
    for (let i = 0; i < 8; i++) {
      assert.ok(excerpt.includes(`ALPHA-${1111 * (i + 1)}`), `第 ${i + 1} 条事实没进摘录`);
    }
    assert.ok(excerpt.length <= 2400 + 40, `摘录要有界，实际 ${excerpt.length}`);
    assert.ok(!excerpt.includes('未列入'), '没超上限就不该说"漏了"');
  });

  it('超上限时如实说漏了几条（不装作完整）', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ role: 'user' as const, content: `第 ${i} 条要求：` + 'x'.repeat(300) }));
    const excerpt = userLinesExcerpt(many);
    assert.match(excerpt, /另有 \d+ 条用户消息未列入/);
    assert.ok(excerpt.length <= 2500, `要有界，实际 ${excerpt.length}`);
  });
});

describe('盘上那份记录不会被悄悄换掉', () => {
  it('压缩记录坏了就挪到一边（不删），下次重新压', async () => {
    const p1 = new StubProvider();
    const a1 = makeAgent(p1);
    fillBulk(a1, 12);
    await a1.chat('one');
    const file = join(dir, '.she', 'sessions', 'sess-ceiling', 'compaction.json');
    assert.ok(existsSync(file));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');

    const p2 = new StubProvider();
    const a2 = makeAgent(p2);
    a2.setHistory(a1.getHistory());
    assert.equal(a2.getContextStatus().compacted, false, '坏记录不复用');
    const dir2 = join(dir, '.she', 'sessions', 'sess-ceiling');
    const backups = (await import('node:fs')).readdirSync(dir2).filter((f) => f.includes('unusable-'));
    assert.equal(backups.length, 1, '坏文件要留下来，而不是被覆盖');
    assert.equal(readFileSync(join(dir2, backups[0]), 'utf8'), '{ 这不是 JSON');
  });
});
