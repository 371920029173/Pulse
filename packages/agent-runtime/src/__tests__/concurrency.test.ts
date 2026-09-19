/**
 * One turn at a time per conversation.
 *
 * Two concurrent turns on one agent interleave writes into a single `history`: each
 * pushes its own user message, each builds its request from that same array, and tool
 * results end up paired with the wrong assistant message. The transcript becomes
 * incoherent in a way that is hard to spot and impossible to repair afterwards.
 *
 * `aborter` was also a single field, so the second turn overwrote the first's
 * controller and "stop" silently only stopped the newer one.
 *
 * The guard is only useful if it is not also a trap: a throwing tool must not leave
 * the agent permanently busy, or the conversation is unusable until restart. That is
 * asserted here too.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, TurnInProgressError } from '../agent.js';
import { PendingPatchStore } from '@she/sandbox';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-concur-'));
  mkdirSync(join(dir, '.she'), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Tools with one slow tool and one that throws. */
function makeTools() {
  const calls: string[] = [];
  return {
    calls,
    tools: {
      definitions: [
        { name: 'slow', description: 'Takes a while.', parameters: { type: 'object', properties: {}, required: [] } },
        { name: 'boom', description: 'Always throws.', parameters: { type: 'object', properties: {}, required: [] } },
      ] as ToolDefinition[],
      execute: async (name: string) => {
        calls.push(name);
        if (name === 'slow') { await new Promise((r) => setTimeout(r, 120)); return 'done slowly'; }
        throw new Error('tool exploded');
      },
    },
  };
}

/**
 * A provider that blocks until released, so a test can hold a turn open and observe
 * what a second call does.
 */
class BlockingProvider implements LLMProvider {
  name = 'blocking';
  private gate: (() => void) | null = null;
  calls = 0;

  /** Release any waiting turn. */
  release(): void {
    const g = this.gate;
    this.gate = null;
    g?.();
  }

  async chat(messages: LLMMessage[], _tools?: ToolDefinition[], onChunk?: (c: StreamChunk) => void): Promise<LLMMessage> {
    this.calls++;
    onChunk?.({ type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });

    // First call blocks; later ones return immediately so a test can finish.
    if (this.calls === 1) {
      await new Promise<void>((resolve) => { this.gate = resolve; });
    }
    const last = messages.filter((m) => m.role === 'user').at(-1);
    return { role: 'assistant', content: `reply to: ${String(last?.content ?? '')}` };
  }
}

/** A provider that asks for a tool, so the loop runs more than one iteration. */
class ToolProvider implements LLMProvider {
  name = 'tool-stub';
  private round = 0;

  constructor(private toolName: string) {}

  async chat(messages: LLMMessage[]): Promise<LLMMessage> {
    const results = messages.filter((m) => m.role === 'tool');
    if (results.length >= 1) return { role: 'assistant', content: 'finished' };
    this.round++;
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `c${this.round}`,
        type: 'function',
        function: { name: this.toolName, arguments: '{}' },
      }],
    };
  }
}

/** A provider that always echoes back the last user message. */
class EchoProvider implements LLMProvider {
  name = 'echo';
  calls = 0;
  async chat(messages: LLMMessage[]): Promise<LLMMessage> {
    this.calls++;
    const last = messages.filter((m) => m.role === 'user').at(-1);
    return { role: 'assistant', content: `reply to: ${String(last?.content ?? '')}` };
  }
}

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

describe('同一会话的并发', () => {
  it('【关键】一轮进行中时，第二个 chat 被拒绝', async () => {
    const { tools } = makeTools();
    const provider = new BlockingProvider();
    const agent = makeAgent(provider, tools);

    const first = agent.chat('第一轮');
    // Let the first turn actually start.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(agent.isRunning(), true, '第一轮应当处于运行中');

    await assert.rejects(
      () => agent.chat('第二轮'),
      (err: Error) => {
        assert.ok(err instanceof TurnInProgressError, `应当是 TurnInProgressError，实际 ${err.name}`);
        return true;
      },
    );

    provider.release();
    await first;
  });

  it('被拒绝的请求不会污染历史', async () => {
    /*
     * The guard has to fire BEFORE the user message is pushed. Pushing first would
     * leave an unanswered user turn in the transcript — which the model would then see
     * on the next request and try to answer twice.
     */
    const { tools } = makeTools();
    const provider = new BlockingProvider();
    const agent = makeAgent(provider, tools);

    const first = agent.chat('第一轮');
    await new Promise((r) => setTimeout(r, 30));

    await assert.rejects(() => agent.chat('不该进去的第二轮'));

    const history = agent.getHistory().map((m) => String(m.content ?? ''));
    assert.ok(
      !history.some((c) => c.includes('不该进去的第二轮')),
      `被拒绝的消息进了历史: ${JSON.stringify(history)}`,
    );

    provider.release();
    await first;
  });

  it('第一轮结束后可以继续（守卫不会永久卡住）', async () => {
    const { tools } = makeTools();
    const provider = new BlockingProvider();
    const agent = makeAgent(provider, tools);

    const first = agent.chat('第一轮');
    await new Promise((r) => setTimeout(r, 30));
    provider.release();
    await first;

    assert.equal(agent.isRunning(), false, '结束后不该还标记为运行中');
    // Second turn goes through.
    const second = await agent.chat('第二轮');
    assert.match(String(second.content), /第二轮/);
  });

  it('【关键】工具抛异常后不会永久占用（否则会话就废了）', async () => {
    /*
     * Without a `finally`, a throwing tool would leave turnActive set forever and
     * every later message would be refused — the conversation would be unusable until
     * the process restarted, with no way for the user to tell why.
     */
    const { tools } = makeTools();
    const agent = makeAgent(new ToolProvider('boom'), tools);
    await agent.chat('试试会炸的工具').catch(() => undefined);

    assert.equal(agent.isRunning(), false, '抛异常后必须释放守卫');

    /*
     * The assertion is that the NEXT call is not refused, so the provider is swapped
     * for a plain one — a stateful stub that keys off tool-result count would answer
     * from its own leftover state and prove nothing about the guard.
     */
    (agent as unknown as { provider: LLMProvider }).provider = new EchoProvider();
    const next = await agent.chat('再来一次');
    assert.match(String(next.content), /再来一次/, '工具报错后应当还能继续对话');
  });

  it('isRunning 在 chat 的工具执行期间为 true', async () => {
    /*
     * Renamed: this test used to be called "isRunning 覆盖补丁应用路径", but it only ever ran
     * `chat()`. A test whose name claims coverage it does not provide is worse than no test — it
     * made the patch-apply path look verified while `isRunning()` was returning false there.
     * The patch path is covered by the next two tests.
     */
    const { tools } = makeTools();
    const agent = makeAgent(new ToolProvider('slow'), tools);
    assert.equal(agent.isRunning(), false);

    const turn = agent.chat('跑一个慢工具');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(agent.isRunning(), true, '工具执行期间应当报告为运行中');
    await turn;
    assert.equal(agent.isRunning(), false);
  });

  it('【关键】补丁应用期间 isRunning 为 true（停止键要能用）', async () => {
    const { tools } = makeTools();
    const provider = new BlockingProvider();
    const agent = makeAgent(provider, tools);

    const store = new PendingPatchStore(dir);
    const patch = store.stage('applied-while-running.txt', '', 'content');

    // `continueLoop` defaults to true, so the apply ends in an LLM call — which the blocking
    // provider holds open, giving a window to observe the flag.
    const applying = agent.applyPatch(patch.patch_id);
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(agent.isRunning(), true, '补丁应用期间应当报告为运行中');
    assert.equal(agent.stop(), true, '补丁应用期间 stop 应当可用（否则用户无法中断）');

    provider.release();
    await applying.catch(() => undefined);
    assert.equal(agent.isRunning(), false, '应用结束后应当释放');
  });

  it('【关键】一轮进行中时 applyPatch 被拒绝，且文件没有被写入', async () => {
    /*
     * The ordering bug: `applyPatch` used to take the patch from the store, push a checkpoint and
     * WRITE THE FILE before entering the exclusive section, which then threw on a busy conversation.
     * The user saw a 409 while the edit had already landed and the patch was gone — nothing left to
     * retry or reject.
     */
    const { tools } = makeTools();
    const provider = new BlockingProvider();
    const agent = makeAgent(provider, tools);

    const store = new PendingPatchStore(dir);
    const patch = store.stage('must-not-be-written.txt', '', 'LEAKED');
    const target = join(dir, 'must-not-be-written.txt');

    const turn = agent.chat('占住这一轮');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(agent.isRunning(), true);

    await assert.rejects(
      () => agent.applyPatch(patch.patch_id, undefined, { continueLoop: false }),
      (err: Error) => err instanceof TurnInProgressError,
      '忙时 applyPatch 应当抛 TurnInProgressError',
    );
    assert.equal(existsSync(target), false, '被拒绝的 apply 不应该写入文件');

    // And the patch must still be there, so it can be applied once the turn ends.
    const stillPending = new PendingPatchStore(dir).list();
    assert.ok(stillPending.some((p) => p.patch_id === patch.patch_id),
      '被拒绝的 apply 不应该消耗掉补丁');

    provider.release();
    await turn.catch(() => undefined);

    const applied = await agent.applyPatch(patch.patch_id, undefined, { continueLoop: false });
    assert.match(String(applied.content), /must-not-be-written/);
    assert.equal(existsSync(target), true, '这一轮结束后应当可以正常应用');
  });

  it('【关键】伪造的补丁路径不能写到工作区之外', async () => {
    /*
     * `.she/pending-patches.json` is a plain file INSIDE the workspace, and the agent may write
     * `.she/**` — that is where staged state lives. So the workspace's own contents decide what a
     * patch entry says, and a forged entry naming `../outside.txt` was written outside the jail when
     * the user pressed Apply.
     */
    const { tools } = makeTools();
    const agent = makeAgent(new ToolProvider('slow'), tools);

    // A forged entry, written the way a compromised store would look on disk.
    const forged = join(dir, '.she', 'pending-patches.json');
    mkdirSync(dirname(forged), { recursive: true });
    const escaped = join(dir, '..', `she-escape-${Date.now()}.txt`);
    writeFileSync(forged, JSON.stringify([{
      patch_id: 'forged-1',
      path: `../${basename(escaped)}`,
      before: '',
      after: 'PWNED-OUTSIDE-WORKSPACE',
      unified: '',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    }]), 'utf8');

    await assert.rejects(
      () => agent.applyPatch('forged-1', undefined, { continueLoop: false }),
      /escapes workspace/,
      '越界的补丁路径必须被拒绝',
    );
    assert.equal(existsSync(escaped), false, '工作区外不应出现文件');
  });

  it('stop 之后守卫释放，可以继续对话', async () => {
    const { tools } = makeTools();
    const provider = new BlockingProvider();
    const agent = makeAgent(provider, tools);

    const first = agent.chat('会被中断的一轮');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(agent.stop(), true, 'stop 应当返回 true');

    // Aborting does not resolve the stub, so release it to let the turn unwind.
    provider.release();
    await first.catch(() => undefined);

    assert.equal(agent.isRunning(), false, '中断后应当释放');
    const next = await agent.chat('中断后继续');
    assert.match(String(next.content), /中断后继续/);
  });

  it('多个请求同时打进来，只有一个能通过', async () => {
    const { tools } = makeTools();
    const provider = new BlockingProvider();
    const agent = makeAgent(provider, tools);

    /*
     * Each promise is tracked individually rather than via `Promise.allSettled`.
     *
     * `allSettled([A, B, C])` cannot resolve until A finishes, and A is deliberately
     * held open until `release()` — which would then be reached only after the await.
     * That is a deadlock in the test, not in the code, and it surfaces as "promise
     * still pending" rather than as a failed assertion.
     */
    const settled: Array<{ label: string; ok: boolean; error?: Error; value?: LLMMessage }> = [];
    const track = (label: string, p: Promise<LLMMessage>) => p.then(
      (value) => { settled.push({ label, ok: true, value }); },
      (error: Error) => { settled.push({ label, ok: false, error }); },
    );

    const promises = [
      track('A', agent.chat('A')),
      track('B', agent.chat('B')),
      track('C', agent.chat('C')),
    ];

    // Wait until the winning turn is actually inside the provider call.
    for (let i = 0; i < 100 && provider.calls === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Give the rejected ones a chance to settle.
    await new Promise((r) => setTimeout(r, 50));

    const rejected = settled.filter((s) => !s.ok);
    const accepted = settled.filter((s) => s.ok);
    assert.equal(accepted.length, 0, 'A 还被挡在 provider 里，此时不该有已完成的');
    assert.equal(rejected.length, 2, `应当只放行一个，实际拒绝 ${rejected.length} 个`);
    for (const r of rejected) {
      assert.ok(
        r.error instanceof TurnInProgressError,
        `${r.label} 的失败原因应当是 TurnInProgressError，实际 ${r.error?.name}`,
      );
    }

    provider.release();
    await Promise.all(promises);
    assert.equal(agent.isRunning(), false);
  });
});
