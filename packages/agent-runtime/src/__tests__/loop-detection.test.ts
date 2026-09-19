/**
 * Stuck-loop detection.
 *
 * The failure this guards against is not an infinite loop (that hits the round
 * limit) but a STUCK one: the model calls the same tool with the same arguments and
 * gets the same result, believing the call has not happened yet. With the round
 * limit at 1000 that is thousands of requests, and the user sees a spinner rather
 * than an error.
 *
 * A stub provider drives it deterministically — no API calls.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

/** A tool set with one deterministic tool, so results are reproducible. */
function makeTools(root: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    tools: {
      definitions: [
        {
          name: 'read_fixed',
          description: 'Always returns the same content.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'varies',
          description: 'Returns something new each time.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ] as ToolDefinition[],
      execute: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === 'read_fixed') return 'the same boring content';
        if (name === 'varies') return `content ${calls.length}`;
        return `Error: unknown tool ${name}`;
      },
    },
  };
}

/**
 * A provider that keeps asking for the same tool call.
 *
 * `stopAfter` lets a test hand control back to the model after N identical calls,
 * so "does it recover when the result changes" can be asserted too.
 */
class LoopingProvider implements LLMProvider {
  name = 'loop-stub';
  private round = 0;
  toolCallsSeen = 0;

  constructor(
    private toolName: string,
    private args: Record<string, unknown>,
    private stopAfter = Number.POSITIVE_INFINITY,
  ) {}

  async chat(messages: LLMMessage[], _tools?: ToolDefinition[], onChunk?: (c: StreamChunk) => void): Promise<LLMMessage> {
    onChunk?.({ type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });

    // Any tool result already in the transcript?
    const results = messages.filter((m) => m.role === 'tool');
    if (results.length >= this.stopAfter) {
      return { role: 'assistant', content: '完成。' };
    }
    this.round++;
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `call_${this.round}`,
        type: 'function',
        function: { name: this.toolName, arguments: JSON.stringify(this.args) },
      }],
    };
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-loop-'));
  mkdirSync(join(dir, '.she'), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeAgent(provider: LLMProvider, tools: ReturnType<typeof makeTools>['tools']) {
  const cfg = {
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
    workspace: { root: dir },
    kb: {
      dbPath: join(dir, '.she', 'kb.sqlite'),
      maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5,
      pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
    },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
    schedule: { enabled: false, tickSeconds: 30, workingWindow: null },
  };
  const agent = new Agent(cfg as never, { } as never, tools as never, null);
  (agent as unknown as { provider: LLMProvider }).provider = provider;
  return agent;
}

describe('卡住的工具循环', () => {
  it('同样的调用+同样的结果连续 3 次后先提示，再犯才停', async () => {
    const { tools, calls } = makeTools(dir);
    // Infinite repetition: without detection this would run to the round limit.
    const provider = new LoopingProvider('read_fixed', { path: 'x' });
    const agent = makeAgent(provider, tools);

    const chunks: StreamChunk[] = [];
    const reply = await agent.chat('读一下那个文件', (c) => chunks.push(c));

    assert.match(String(reply.content), /重复调用/, '应当报告卡住，而不是跑到底');
    // 3 calls to detect, then one more after the nudge, then stop. Not thousands.
    assert.equal(calls.length, 4, `实际调用了 ${calls.length} 次`);

    // The nudge must reach the model, or it is just a log line.
    const nudged = chunks.some((c) => c.type === 'status' && /换个思路/.test(String(c.content)));
    assert.ok(nudged, '应当先提示模型换思路，而不是直接放弃');
  });

  it('提示之后换了思路就能继续（这才是重点）', async () => {
    /*
     * The valuable behaviour: a stuck loop is usually a WRONG APPROACH, not an
     * impossible task. Being told that should let the model recover — otherwise the
     * nudge is decoration.
     */
    const { tools, calls } = makeTools(dir);
    let round = 0;
    const provider: LLMProvider = {
      name: 'recovers-stub',
      async chat(messages: LLMMessage[]) {
        const results = messages.filter((m) => m.role === 'tool');
        const sawNudge = messages.some((m) => /\[系统提示\]/.test(String(m.content)));
        round++;

        // Before the nudge: the same call. After it: a different one that works.
        const useDifferent = sawNudge;
        if (results.length >= 5) return { role: 'assistant', content: '完成。' };
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: `c${round}`,
            type: 'function',
            function: {
              name: useDifferent ? 'varies' : 'read_fixed',
              arguments: JSON.stringify(useDifferent ? {} : {}),
            },
          }],
        };
      },
    };
    const agent = makeAgent(provider, tools);
    const reply = await agent.chat('想办法读到它');

    assert.doesNotMatch(String(reply.content), /已停止/, '换思路后不该停');
    assert.match(String(reply.content), /完成/);
    // At least one call used the different tool, proving the approach changed.
    assert.ok(calls.some((c) => c.name === 'varies'), '没有真的换工具');
  });

  it('停止时告诉用户原因和下一步，而不是静默中断', async () => {
    const { tools } = makeTools(dir);
    const agent = makeAgent(new LoopingProvider('read_fixed', {}), tools);
    const reply = await agent.chat('试试');
    // An agent that silently stops looks broken; the message has to explain.
    assert.match(String(reply.content), /没变|同一个错|依赖/);
  });

  it('结果在变化就不算卡住（重试直到成功不应被误杀）', async () => {
    const { tools, calls } = makeTools(dir);
    // 5 identical calls, then it gives up looping. Results differ each time, so
    // detection must not fire.
    const provider = new LoopingProvider('varies', {}, 5);
    const agent = makeAgent(provider, tools);
    const reply = await agent.chat('试到成功');

    assert.doesNotMatch(String(reply.content), /重复调用/, '结果不同却被判为卡住');
    assert.equal(calls.length, 5);
    assert.match(String(reply.content), /完成/);
  });

  it('参数不同就不算重复', async () => {
    const { tools, calls } = makeTools(dir);
    // Same tool, but the argument changes each round via a counter.
    let n = 0;
    const provider: LLMProvider = {
      name: 'args-stub',
      async chat(messages: LLMMessage[]) {
        const results = messages.filter((m) => m.role === 'tool');
        if (results.length >= 4) return { role: 'assistant', content: '完成。' };
        n++;
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: `c${n}`,
            type: 'function',
            function: { name: 'read_fixed', arguments: JSON.stringify({ path: `file-${n}` }) },
          }],
        };
      },
    };
    const agent = makeAgent(provider, tools);
    const reply = await agent.chat('读几个文件');
    assert.doesNotMatch(String(reply.content), /重复调用/, '参数不同却被判为卡住');
    assert.equal(calls.length, 4);
  });

  it('失败结果连续相同也算卡住（同一个错误反复出现）', async () => {
    const { tools, calls } = makeTools(dir);
    const provider = new LoopingProvider('nope_not_a_tool', {}, Number.POSITIVE_INFINITY);
    const agent = makeAgent(provider, tools);
    const reply = await agent.chat('调一个不存在的工具');
    assert.match(String(reply.content), /重复调用/);
    assert.equal(calls.length, 0, '未知工具不会进 executor');
  });

  it('只给一次改过机会，不会无限提示', async () => {
    // Two nudges would mean the loop can outlast any bound; the chance has to be
    // single-use.
    const { tools, calls } = makeTools(dir);
    const agent = makeAgent(new LoopingProvider('read_fixed', {}), tools);
    await agent.chat('试试');
    // 3 to detect + 1 after the nudge, and no second nudge.
    assert.equal(calls.length, 4, `实际 ${calls.length} 次，说明提示了不止一次`);
  });

  it('提示文本不进入历史（否则用户会看到自己没说过的话）', async () => {
    /*
     * The nudge is a `user` message so the model attends to it — but history is
     * persisted AND rendered, so pushing it there would show the user a line they
     * never wrote. It belongs in the request only.
     */
    const { tools } = makeTools(dir);
    const agent = makeAgent(new LoopingProvider('read_fixed', {}), tools);
    await agent.chat('试试');

    const historyText = agent.getHistory().map((m) => String(m.content ?? '')).join('\n');
    assert.doesNotMatch(historyText, /\[系统提示\]/, '提示文本泄漏到了历史里');
    // The explanation to the user SHOULD be in history, though — it is the reply.
    assert.match(historyText, /已停止/);
  });

  it('阈值可通过环境变量调整', async () => {
    const { tools, calls } = makeTools(dir);
    process.env.SHE_REPEAT_LIMIT = '2';
    try {
      const agent = makeAgent(new LoopingProvider('read_fixed', {}), tools);
      await agent.chat('试试');
      // 2 to detect (the limit) + 1 after the nudge.
      assert.equal(calls.length, 3, '阈值设为 2 时应当更早提示并更早停止');
    } finally {
      delete process.env.SHE_REPEAT_LIMIT;
    }
  });
});
