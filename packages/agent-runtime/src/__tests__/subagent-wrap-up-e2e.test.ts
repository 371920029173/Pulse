/**
 * 软截止提醒的**端到端复现**：评测报告里这一项停在"已修好，但从未复现第二次"。
 *
 * 复现的是 2026-09-25 那次 task_spawn 超时的**形状**，不是它的规模：
 *
 *   · 子任务很早就拿齐了事实，之后一直在"探索"（每次回合都请求一次工具调用），
 *   · 它不看表，交接单里写的期限对它没有约束力，
 *   · 于是它一直跑到硬杀，父级只剩半截进度。
 *
 * 复现必须能同时证明两件事，否则"修好了"只是自述：
 *
 *   1. **机制真的触达了模型**。原来只测了时刻表（"提醒该排在这些时刻"）和措辞（"句子对不对"），
 *      没有任何东西证明提醒会落进子任务的对话、并且是在硬杀之前。所以这里让一个真的 `Agent`
 *      跑真的回合循环，从**它实际收到的请求**里找那句提醒。
 *   2. **听话的子任务真的被救回来**。只看"提醒发出去了"不够 —— 发出去了但落得太晚，
 *      和没发是一回事（2026-09-25 那次只剩 26.4s，是靠运气够的）。
 *
 * 预算压到几百毫秒：时刻表是比例，比例对了，绝对秒数不影响结论，而用例要能在门禁里跑。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import {
  armSubagentWrapUp,
  subagentWrapUpScheduleMs,
  readChildProgress,
  formatTimeoutReport,
} from '../subagent-tools.js';
import type { LLMProvider, LLMMessage, ToolDefinition } from '@she/shared';

/** 提醒里那句独一无二的开头，用来在请求里认出它。 */
const NUDGE_MARK = '停止继续探索';

/**
 * 一个"只会探索"的子任务，可配置它听不听话。
 *
 * `obeys = false` 就是原始故障的形状：永远不交付，一路跑到硬杀。两个都测，因为修复的价值恰恰在
 * 两者的差 —— 只测"听话的那个能完成"，等于没测修复有没有用。
 */
class ExploringProvider implements LLMProvider {
  name = 'exploring';
  /** 每次模型请求的完整消息数组，用来证明提醒真的到了模型面前。 */
  requests: LLMMessage[][] = [];
  /**
   * 每次请求发出的时刻（相对 `t0` 的毫秒数）。
   *
   * 靠**请求序号**判"提醒没提前到"是错的：它隐含假设"第一次请求一定发生在第一次提醒之前"，
   * 而这个假设在门禁满负荷时不成立 —— 光是构造 Agent、跑完第一轮就会用掉几百毫秒，于是提醒
   * 合法地出现在第一次请求里，用例却判它失败（实测在 `check:offline` 里挂过）。真正要钉的是
   * **时刻**：`setTimeout` 只会晚不会早，所以任何带着提醒的请求，其发出时刻必然 ≥ 时刻表上
   * 的第一次。改成量时刻之后，判据与机器快慢无关。
   */
  at: number[] = [];
  /** 由 `runChild` 在武装提醒之前设成 `Date.now()`。 */
  t0 = 0;
  calls = 0;

  constructor(private readonly obeys: boolean) {}

  async chat(messages: LLMMessage[]): Promise<LLMMessage> {
    this.requests.push(messages.map((m) => ({ ...m })));
    this.at.push(Date.now() - this.t0);
    this.calls++;
    const nudged = messages.some(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(NUDGE_MARK),
    );
    /*
     * 每个回合都花掉一点时间。
     *
     * 回合边界是提醒唯一能落地的地方（`interject` 要等工具组闭合），所以一个零耗时的回合循环会
     * 在硬杀之前跑掉几千次，把"提醒落在哪一次之后"变成一个无法观察的噪声。留出几毫秒，让这个
     * 量级和真实回合的形状对得上。
     */
    await new Promise((r) => { setTimeout(r, 8); });

    if (nudged && this.obeys) {
      return { role: 'assistant', content: '按已拿到的信息交付：结论如下（未核实部分已标注）。' };
    }
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `c${this.calls}`,
        type: 'function',
        function: { name: 'probe', arguments: JSON.stringify({ i: this.calls }) },
      }],
    };
  }
}

const PROBE: ToolDefinition = {
  name: 'probe',
  description: '永远再探一次。',
  parameters: { type: 'object', properties: { i: { type: 'number' } }, required: [] },
};

const TOOLS = {
  definitions: [PROBE],
  execute: async () => 'probe done',
};

function makeAgent(provider: LLMProvider, dir: string): Agent {
  const cfg = {
    llm: {
      provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k',
      maxTokens: 100, temperature: 0, thinkingLevel: 'low',
    },
    workspace: { root: dir },
    kb: {
      dbPath: join(dir, 'kb.sqlite'),
      maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100,
      boostOnAccess: 1.5,
      pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
    },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: {
      shell: 'auto', timeout: 1000, maxOutputBytes: 1000,
      denyDestructiveByDefault: true, allowAllCommands: true,
    },
    schedule: { enabled: false, tickSeconds: 30, workingWindow: null },
  };
  const agent = new Agent(cfg as never, {} as never, TOOLS as never, 'sess-wrapup-child', { isSubagent: true });
  (agent as unknown as { provider: LLMProvider }).provider = provider;
  return agent;
}

/**
 * 跑一次"子任务"，软截止与硬杀按生产里那套来（`armSubagentWrapUp` 就是服务器调的那个函数），
 * 返回父级会看到的那些东西。
 */
async function runChild(obeys: boolean, budgetMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'she-wrapup-'));
  mkdirSync(join(dir, '.she'), { recursive: true });
  const provider = new ExploringProvider(obeys);
  const agent = makeAgent(provider, dir);
  /*
   * 记下 `interject` 真正被调用的时刻。
   *
   * 失败消息里最有用的一个数字就在这里：`armSubagentWrapUp` 排的是 0.7/0.8/0.88 倍预算，如果
   * 这三个时刻都出现在窗口内而请求里仍然没有提醒，问题就落在 `drainInterjections` 那一侧；如果
   * 一个都没出现（或者晚于预算），那就是计时器被负载拖后了。少了这个，两种故障长得一模一样。
   */
  const interjects: number[] = [];
  const rawInterject = agent.interject.bind(agent);
  agent.interject = (text: string) => { interjects.push(Date.now() - provider.t0); return rawInterject(text); };
  try {
    let timedOut = false;
    provider.t0 = Date.now();
    const disarm = armSubagentWrapUp(agent, budgetMs);
    const out = await Promise.race([
      agent.chat('## 交接单\n交付物：一段结论。'),
      new Promise<null>((r) => setTimeout(() => { timedOut = true; r(null); }, budgetMs)),
    ]);
    disarm();
    if (timedOut) { try { agent.stop(); } catch { /* ignore */ } }

    return {
      timedOut,
      content: out?.content ?? '',
      requests: provider.requests,
      at: provider.at,
      interjects,
      report: timedOut
        ? formatTimeoutReport(readChildProgress(agent.getHistory()), {
          seconds: budgetMs / 1000, sessionId: 'sess-wrapup-child',
        })
        : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/*
 * 预算必须比"调度抖动"大一个量级，否则这个用例测的是机器负载而不是代码。
 *
 * 修了两次才看清这一点，所以把两次量到的东西都记下来：
 *
 *   预算 500ms  → 失败。留给软截止的窗口只有 150ms，抖动轻易吃掉它。
 *   预算 2000ms → 仍然失败（`check:offline` 里 1/49 轮）。诊断打印出的时刻是决定性的：
 *                 时刻表 1400/1600/1760ms，而 `interject` 实际在 **2102ms** 才被调用 ——
 *                 三个计时器一起晚了 700ms，全部越过 2000ms 的硬截止。
 *
 * 那 700ms 不是代码问题：`node --test` 按文件并行，这个文件在满负荷的门禁里会和同包其它重活
 * 抢主线程，`setTimeout` 的回调排在同一根事件循环上，于是被推迟到有空的时刻才一起跑掉。
 * 单独跑 12 次、并行 18 次都绿，只有在门禁那种负载下才露头。
 *
 * 关键比例：**软截止窗口 = 预算的 30%（预算 × 0.7 到预算之间），而抖动大致是常数（~700ms）**。
 * 所以窗口只要显著大于抖动，用例就稳；500ms 的窗口（150ms）和 2000ms 的窗口（600ms）都比抖动小，
 * 6000ms 的窗口是 1800ms，约为抖动的 2.6 倍。
 *
 * 生产里这个比例天然安全：预算是 180s，窗口 54s，抖动是它的百分之一。
 *
 * 代价是这个文件从约 10s 变成约 27s（不听话的对照组要跑到硬截止）。可接受：门禁里红一个
 * 本来正确的用例，比多花十几秒贵得多。
 */
const BUDGET_MS = 6000;

describe('软截止端到端：提醒真的到得了模型', () => {
  it('提醒出现在子任务实际收到的请求里，而不是只被排进了某个定时器', async () => {
    const r = await runChild(true, BUDGET_MS);
    const sawIt = r.requests.some((msgs) =>
      msgs.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(NUDGE_MARK)));
    /*
     * 失败时要把"跑成什么样"说全，否则没法判断是机制坏了还是这一轮没跑够。
     *
     * 第一次在 `check:offline` 里挂掉时，消息只有"共 23 次请求"，而同一个用例单独跑是 88 次 ——
     * 光看这个数字分不清"提醒没排上"和"轮次太少、提醒还没到点"。所以把时刻表、每轮时刻、以及
     * 轮次密度一起打出来：一眼能看出是循环被拖慢了，还是计时器压根没响。
     */
    const shots = subagentWrapUpScheduleMs(BUDGET_MS);
    const span = r.at.length ? r.at[r.at.length - 1] - r.at[0] : 0;
    assert.ok(
      sawIt,
      `子任务的请求里没有出现提醒。\n`
      + `  请求数 ${r.requests.length}，第 1 轮到最后一轮跨 ${span}ms（每轮约 ${(span / Math.max(1, r.requests.length - 1)).toFixed(1)}ms）\n`
      + `  时刻表 ${shots.join('/')}ms，预算 ${BUDGET_MS}ms\n`
      + `  interject 实际被调用于 ${r.interjects.length ? `${r.interjects.join('/')}ms` : '(一次都没调用)'}\n`
      + `  最后一轮在 ${r.at.at(-1)}ms，最后一轮是否越过第一次提醒 ${(r.at.at(-1) ?? 0) >= shots[0]}\n`
      + `  最后一条用户消息: ${JSON.stringify(r.requests.at(-1)?.filter((m) => m.role === 'user').at(-1)?.content).slice(0, 200)}`,
    );
  });

  it('提醒不可能早于时刻表上的第一次（它是排出来的，不是碰出来的）', async () => {
    const shots = subagentWrapUpScheduleMs(BUDGET_MS);
    assert.ok(shots[0] > 0 && shots[0] < BUDGET_MS, shots.join(', '));
    const r = await runChild(false, BUDGET_MS);

    /*
     * 判据是**时刻**，不是请求序号。
     *
     * 原来的写法是"第一次请求里不该有提醒"（`nudgedAt > 0`）。它隐含假设第一次请求发生在
     * 第一次提醒之前，而这件事在门禁满负荷时并不成立 —— 构造 Agent、跑完首轮就能用掉几百
     * 毫秒，提醒于是合法地落在第一次请求里，用例报红而代码是对的。实测它就在 `check:offline`
     * 里挂过。
     *
     * `setTimeout` 只会晚不会早，`interject` 又把提醒排到回合边界，所以真正的不变量是：**任何
     * 带着提醒的请求，发出时刻必然不早于时刻表上的第一次**。这条与机器快慢、负载轻重都无关。
     */
    const nudgeIdx = r.requests
      .map((msgs, i) => (msgs.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(NUDGE_MARK),
      ) ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(
      nudgeIdx.length > 0,
      `提醒一次都没落到子任务的对话里（跑了 ${r.requests.length} 次请求，`
      + `时刻 ${r.at.join(', ')}，时刻表 ${shots.join('/')}）`,
    );
    const early = nudgeIdx.filter((i) => r.at[i] < shots[0]);
    assert.equal(
      early.length,
      0,
      `提醒早于时刻表上的第一次（${shots[0]}ms）：第 ${early.join(', ')} 次请求在 `
      + `${early.map((i) => r.at[i]).join(', ')}ms 就带上了它`,
    );
  });
});

describe('软截止端到端：听话的子任务真的被救回来', () => {
  it('被提醒叫住的子任务在硬杀之前交付，父级拿到的是内容不是超时', async () => {
    const r = await runChild(true, BUDGET_MS);
    assert.equal(r.timedOut, false, '被提醒后仍跑到硬杀 —— 提醒没有起作用');
    assert.match(r.content, /结论如下/, r.content);
  });

  it('同样的子任务，没人叫它就一路跑到硬杀 —— 这才是被修掉的那个形状', async () => {
    // `obeys = false`：永远不交付。这正是 2026-09-25 那次的形状，也是"修复有效"的对照组。
    const r = await runChild(false, BUDGET_MS);
    assert.equal(r.timedOut, true, '对照组必须超时，否则这个用例什么也没证明');
    // 超时时没有答复可回（`out` 是 null），父级拿到的是下面那条进度报告 —— 所以这里断报告，
    // 不断答复。生产里的 `timedOutText()` 就是 `formatTimeoutReport(...)`。
    assert.match(r.report, /中止|超时/, r.report);
  });

  it('对照组超时后，父级拿到的是进度而不是六个字', async () => {
    const r = await runChild(false, BUDGET_MS);
    // 进度报告必须带上"它做到哪一步"。原来这里是「子任务超时（180s）」，什么都没有。
    assert.match(r.report, /共 \d+ 次/, r.report);
    assert.match(r.report, /probe|还没有调用工具/, r.report);
    assert.match(r.report, /timeout_ms/, '不给出路，父级只能再赌一次同样的预算');
  });
});
