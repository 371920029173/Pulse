/**
 * 借来的知识库只能读，不能写 —— 包括绕过工具的那两条通路。
 *
 * 工具层的只读开关只挡得住 `kb_upsert` / `kb_link`：错题本和收尾自评是**直接写引擎**的，
 * 不经过任何工具，所以只读开关对它们无效。实测里这就是真正的污染源 —— 一个只读子级
 * （`sess_8d64da11747c`，父级 `sess_150beeaa9993`）在父级的 kb.sqlite 里留下了三条记录：
 *
 *   - `plan_list · unavailable`（它照着提示词去调一个自己没有的工具）
 *   - `preflight_record · unavailable`（同上）
 *   - `目标漂移 · reflection`（拿父级会话的目标当尺子量自己的动作）
 *
 * 三条都会在父级下一次做同类工作时被检索出来，被当成父级自己的历史教训。这个文件钉住的是：
 * 只读的会话可以**报告**它发现了什么（`lastReflection` 仍然对外可见），但不许留下任何一条
 * 持久记录。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import { PreflightStore, buildRecord, analyzeRequest } from '../preflight.js';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-kbguard-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * One turn: call the named tools, one per step, then answer.
 *
 * A scripted provider rather than a mock of the agent loop, so the failure actually flows through
 * `classifyToolResult` → `recordMistake` the way it does in production.
 */
class ScriptedProvider implements LLMProvider {
  name = 'stub';
  private step = 0;
  constructor(private script: { name: string; args: Record<string, unknown> }[], private reply = '做完了') {}

  async chat(_messages: LLMMessage[], _tools?: ToolDefinition[], onChunk?: (c: StreamChunk) => void): Promise<LLMMessage> {
    onChunk?.({ type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
    const next = this.script[this.step++];
    if (!next) return { role: 'assistant', content: this.reply };
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `call_${this.step}`,
        type: 'function' as const,
        function: { name: next.name, arguments: JSON.stringify(next.args) },
      }],
    };
  }
}

/** Records every write the agent attempts, so "nothing was written" is assertable. */
function spyEngine() {
  const calls: string[] = [];
  const engine = {
    calls,
    store: {
      getAllGroups: () => [] as { id: string; name: string; parentGroupId: string | null }[],
      getMemoriesByGroup: () => [] as { id: string; title: string; content: string; metadata: Record<string, unknown> }[],
      updateMemory: (id: string) => { calls.push(`updateMemory:${id}`); },
      boostAccess: (id: string) => { calls.push(`boostAccess:${id}`); },
    },
    createGroup: (name: string) => { calls.push(`createGroup:${name}`); return { id: `g-${name}`, name }; },
    addMemoryMaintained: (_g: string, _k: string, title: string) => { calls.push(`addMemory:${title}`); return { id: 'm-1' }; },
    addTypedEdge: () => { calls.push('addTypedEdge'); },
    query: () => ({ nodes: [] }),
  };
  return engine;
}

function makeConfig() {
  return {
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
    workspace: { root: dir },
    kb: { dbPath: join(dir, 'kb.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5, pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 } },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
  } as never;
}

/** A tool that fails in a way the book records: a command that ran and exited non-zero. */
const failingShell = (): { definitions: ToolDefinition[]; execute: (n: string) => Promise<string> } => ({
  definitions: [{
    name: 'shell',
    description: 'run a command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  }],
  execute: async () => 'stdout:\nexit code: 1',
});

function makeAgent(provider: LLMProvider, engine: ReturnType<typeof spyEngine>, sessionId: string, opts: { kbReadOnly?: boolean; isSubagent?: boolean }) {
  const tools = failingShell();
  const agent = new Agent(makeConfig(), engine as never, tools as never, sessionId, opts);
  (agent as unknown as { provider: LLMProvider }).provider = provider;
  return agent;
}

const noop = () => { /* chunks unused here */ };

describe('只读会话不许写知识库', () => {
  it('【实测】工具失败不留错题本记录 —— 但同一轮在可写会话里会留', async () => {
    const writable = spyEngine();
    await makeAgent(new ScriptedProvider([{ name: 'shell', args: { command: 'x' } }]), writable, 'sess-1', {}).chat('跑一下', noop);
    assert.ok(writable.calls.some((c) => c.startsWith('addMemory:')), `可写会话应当记下这次失败，实际: ${writable.calls.join(', ')}`);

    const borrowed = spyEngine();
    await makeAgent(new ScriptedProvider([{ name: 'shell', args: { command: 'x' } }]), borrowed, 'sess-1', { kbReadOnly: true }).chat('跑一下', noop);
    assert.deepEqual(borrowed.calls, [], `只读会话不该写任何东西，实际写了: ${borrowed.calls.join(', ')}`);
  });

  it('【实测】自评查出漂移也只报告，不落库 —— 发现仍然对外可见', async () => {
    /*
     * The goal is the PARENT's, which is what the child saw before `latestForSession` existed:
     * the child's own actions (three shell calls, no word in common with the goal) trip the drift
     * check, so the reflection is derived and — before the guard — written into the parent's book.
     */
    const goal = '得到一份基于实机证据的功能评估';
    /*
     * 目标里的词必须和动作完全不重叠 —— 注意工具名本身也参与比对（`actionContext` 里含 tool），
     * 所以 `shell` 这种名字会白送一个 "she"（目标「SHE 功能评估」里就有）。这里刻意挑了不撞的写法，
     * 否则测的是字符串巧合，不是漂移检测。
     */
    new PreflightStore(dir, 'sess-child').save(buildRecord(analyzeRequest('随便做点什么', { workspaceRoot: dir, tools: ['shell'] }), {
      stated_intent: '列个清单',
      actual_goal: goal,
    }));

    const engine = spyEngine();
    const agent = makeAgent(
      new ScriptedProvider([
        { name: 'shell', args: { command: 'a' } },
        { name: 'shell', args: { command: 'b' } },
        { name: 'shell', args: { command: 'c' } },
        { name: 'shell', args: { command: 'd' } },
        { name: 'shell', args: { command: 'e' } },
      ]),
      engine,
      'sess-child',
      { kbReadOnly: true, isSubagent: true },
    );
    await agent.chat('列个清单', noop);

    // The finding is not swallowed: whoever reads the run can still see what was detected.
    assert.equal(agent.getReflection()?.drift.level, 'drift', '漂移没有被检出，这个测试就没在测东西');
    assert.deepEqual(engine.calls, [], `只读会话不该把自评写进借来的库，实际写了: ${engine.calls.join(', ')}`);
  });
});
