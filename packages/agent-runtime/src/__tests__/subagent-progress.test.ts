/**
 * 子任务超时前后的可见性：父级读得到的报告，和人看得到的进度。
 *
 * 这条线上的原始故障是这样的：一个已经缩到最小的子任务跑满 180s 被中止，父级收到的回复只有
 * 「子任务超时（180s）」六个字。父级既不知道这 180 秒换来了什么，也没有除「再派一次、再付一遍」
 * 之外的选项 —— 而它连「再派一次要给足预算」都不知道，因为没有这个参数。
 *
 * 所以这里测的是三件互相独立、缺一不可的事：
 *   1. 超时的回复必须交代它做到了哪一步（否则时间白花）；
 *   2. 预算必须是每个任务的参数（否则重武器永远跑不完）；
 *   3. 运行中的进度必须能到达**看的人**（模型读不到 —— 它卡在工具调用里，这一点绕不开）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readChildProgress,
  formatTimeoutReport,
  resolveSubagentTimeoutMs,
  composeHandoffPrompt,
  createSubagentTools,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
  MIN_SUBAGENT_TIMEOUT_SECONDS,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
} from '../subagent-tools.js';
import type { SubagentRequest, SubagentResult, SubagentProgressEvent } from '../subagent-tools.js';
import type { LLMMessage } from '@she/shared';

/** A child transcript in the shape the runner reads back. */
function childSay(...messages: LLMMessage[]): LLMMessage[] {
  return messages;
}

const call = (name: string, args: Record<string, unknown>) => ({
  id: `c-${name}-${Math.random().toString(36).slice(2, 6)}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe('readChildProgress：从子级自己的记录里读它在干什么', () => {
  it('数的是工具调用次数，报的是最后一次调用', () => {
    const p = readChildProgress(childSay(
      { role: 'assistant', content: '先看看结构。', tool_calls: [call('fs_list', { path: 'src' })] },
      { role: 'tool', content: '...' },
      { role: 'assistant', content: '', tool_calls: [call('grep', { pattern: 'kb_query' })] },
    ));
    assert.equal(p.steps, 2);
    assert.match(p.activity, /grep/);
    assert.match(p.activity, /kb_query/, '要带上参数，只报工具名等于没报');
    assert.match(p.lastWords ?? '', /先看看结构/, '它自己说的话也要带上');
  });

  it('挑的是最能说明问题的那一个参数，不是整段 JSON', () => {
    const p = readChildProgress(childSay(
      { role: 'assistant', content: '', tool_calls: [call('shell', { command: 'pnpm test', cwd: '/ws', timeout: 30000 })] },
    ));
    assert.match(p.activity, /pnpm test/);
    assert.doesNotMatch(p.activity, /timeout/, '整段 JSON 会把一行进度变成一堵墙');
  });

  it('一个工具都还没调用时如实说明，而不是报「第 0 步」', () => {
    const p = readChildProgress(childSay({ role: 'assistant', content: '我在想。' }));
    assert.equal(p.steps, 0);
    assert.match(p.activity, /还没有调用工具/);
  });

  it('参数是半截 JSON 也不抛异常 —— 进度读取不能反噬它描述的那个运行', () => {
    const p = readChildProgress(childSay(
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'fs_read', arguments: '{"path":"src/a' } }] },
    ));
    assert.equal(p.steps, 1);
    assert.match(p.activity, /fs_read/);
  });

  it('最近的调用留一小段就够了，长跑不会把整份历史搬进报告', () => {
    const many: LLMMessage[] = [];
    for (let i = 0; i < 40; i++) {
      many.push({ role: 'assistant', content: '', tool_calls: [call('fs_read', { path: `f${i}.ts` })] });
    }
    const p = readChildProgress(childSay(...many));
    assert.equal(p.steps, 40, '总数要准 —— 报告里要写「共 N 次」');
    assert.ok(p.recent.length <= 8, `只留最后几次，实际 ${p.recent.length}`);
    assert.match(p.recent[p.recent.length - 1], /f39\.ts/, '留下的必须是最后发生的');
  });
});

describe('超时报告：父级必须知道这 180 秒换来了什么', () => {
  const progress = readChildProgress(childSay(
    { role: 'assistant', content: '先读入口。', tool_calls: [call('fs_read', { path: 'src/index.ts' })] },
    { role: 'assistant', content: '', tool_calls: [call('shell', { command: 'pnpm test' })] },
  ));

  const report = formatTimeoutReport(progress, {
    seconds: 180,
    sessionId: 'sess-child-1',
    changed: ['src/a.ts'],
    worktreePath: '/ws/.she-worktrees/sub-1',
  });

  it('给出预算和「没有结果返回」这个事实', () => {
    assert.match(report, /180s/);
    assert.match(report, /中止/);
  });

  it('交代它做到哪一步', () => {
    assert.match(report, /pnpm test/, '最后在跑什么必须说出来');
    assert.match(report, /共 2 次/);
    assert.match(report, /先读入口/, '它最后说的话是判断它理解到哪了的唯一线索');
  });

  it('改过的文件要给出来，并说明它们还在副本里', () => {
    assert.match(report, /src\/a\.ts/);
    assert.match(report, /\.she-worktrees\/sub-1/);
    assert.match(report, /没有合并回主工作区/);
  });

  it('给出两条继续下去的路：加大预算，或不再阻塞本轮', () => {
    assert.match(report, /timeout_ms/, '不给这个参数，父级只能再赌一次同样的 180s');
    assert.match(report, /background/);
    assert.match(report, /sess-child-1/, '会话 id 是「打开看」的入口');
  });

  it('一次工具都没跑完时说的是「不在工作量上」，不假装它在忙', () => {
    const idle = formatTimeoutReport(readChildProgress([]), { seconds: 180, sessionId: 's' });
    assert.match(idle, /一个工具都还没调用完/);
  });
});

describe('resolveSubagentTimeoutMs：预算由任务决定，但由运行器把关', () => {
  it('不给就用默认值', () => {
    assert.equal(resolveSubagentTimeoutMs(undefined), DEFAULT_SUBAGENT_TIMEOUT_SECONDS * 1000);
    assert.equal(resolveSubagentTimeoutMs(0), DEFAULT_SUBAGENT_TIMEOUT_SECONDS * 1000);
    assert.equal(resolveSubagentTimeoutMs('abc'), DEFAULT_SUBAGENT_TIMEOUT_SECONDS * 1000);
  });

  it('给足预算时照用 —— 这正是重武器跑得完的前提', () => {
    assert.equal(resolveSubagentTimeoutMs(600_000), 600_000);
  });

  it('两头夹住：太短没意义，太长等于把父级的一轮钉住', () => {
    assert.equal(resolveSubagentTimeoutMs(1), MIN_SUBAGENT_TIMEOUT_SECONDS * 1000);
    assert.equal(resolveSubagentTimeoutMs(86_400_000), MAX_SUBAGENT_TIMEOUT_SECONDS * 1000);
  });

  it('夹住而不是报错 —— 越界是「给多点」，不是参数写错，不值得白跑一个来回', () => {
    const out = resolveSubagentTimeoutMs(-5);
    assert.equal(typeof out, 'number');
    assert.ok(out > 0);
  });
});

describe('预算传到 runner，并且写进交接单', () => {
  function runnerSpy() {
    const calls: SubagentRequest[] = [];
    return {
      calls,
      runner: {
        async run(req: SubagentRequest): Promise<SubagentResult> {
          calls.push(req);
          return { description: req.description, ok: true, result: 'ok', handoff: req.handoff };
        },
      },
    };
  }

  it('timeout_ms 原样成为任务的预算', async () => {
    const { calls, runner } = runnerSpy();
    const tools = createSubagentTools(runner);
    await tools.execute('task_spawn', {
      tasks: [{ description: '重活', prompt: 'x', timeout_ms: 600_000 }],
    });
    assert.equal(calls[0].timeoutMs, 600_000);
  });

  /*
   * Absent stays absent.
   *
   * The default is the runtime's to decide, and filling it in here would make that decision
   * unreachable: `SHE_SUBAGENT_TIMEOUT_MS` (and any future policy) would be silently overwritten by
   * a constant compiled into the tool layer. Found by the live gate, where the configured 6s budget
   * was ignored and the subtask ran to the 180s default.
   */
  it('不给预算就留空 —— 默认值归运行器，工具层不替它决定', async () => {
    const { calls, runner } = runnerSpy();
    const tools = createSubagentTools(runner);
    await tools.execute('task_spawn', { tasks: [{ description: '轻活', prompt: 'x' }] });
    assert.equal(calls[0].timeoutMs, undefined);
  });

  it('给了越界值就夹住，而不是把 undefined 传下去', async () => {
    const { calls, runner } = runnerSpy();
    const tools = createSubagentTools(runner);
    await tools.execute('task_spawn', { tasks: [{ description: '重活', prompt: 'x', timeout_ms: 999_999_999 }] });
    assert.equal(calls[0].timeoutMs, MAX_SUBAGENT_TIMEOUT_SECONDS * 1000);
  });

  it('交接单说明预算，并要求「做不完就提前交半成品」', () => {
    const brief = composeHandoffPrompt(
      { description: '查一下', prompt: '看看。' },
      { workdir: '/ws', isolated: false, deadlineSeconds: 180 },
    );
    assert.match(brief, /180 秒/, '不告诉它预算，它就只能在被中止的那一刻才知道有时间限制');
    assert.match(brief, /会被中止/);
    assert.match(brief, /提前/, '要的是提前交，不是「抓紧点」——后者不是可执行的动作');
  });

  it('不知道预算时就不提时间，不编一个数字出来', () => {
    const brief = composeHandoffPrompt({ description: 'x', prompt: 'y' }, { workdir: '/ws', isolated: false });
    assert.doesNotMatch(brief, /时间预算/);
  });

  it('timeout_ms 写在工具表里 —— 父级得先知道有这个开关', () => {
    const tools = createSubagentTools({ async run(req) { return { description: req.description, ok: true, result: '' }; } });
    const props = (tools.definitions[0].parameters.properties as Record<string, { items?: { properties?: object } }>);
    const taskProps = props.tasks.items?.properties ?? {};
    assert.ok('timeout_ms' in (taskProps as object), '参数表里要有 timeout_ms');
    assert.match(tools.definitions[0].description, /timeout_ms/, '描述里要说清什么时候用它');
  });
});

describe('心跳：运行中的进度要能到达看的人', () => {
  it('runner 的上报被转成 heartbeat 事件，带着步数和在做什么', async () => {
    const events: SubagentProgressEvent[] = [];
    const tools = createSubagentTools({
      async run(req, _signal, hooks) {
        // Exactly what a long child looks like from the runner's side.
        hooks?.progress?.({ description: req.description, elapsedMs: 95_000, steps: 23, activity: 'shell pnpm test' });
        return { description: req.description, ok: true, result: 'ok' };
      },
    }, { onProgress: (e) => events.push(e) });

    await tools.execute('task_spawn', { tasks: [{ description: '慢活', prompt: 'x' }] });

    const beats = events.filter((e) => e.phase === 'heartbeat');
    assert.equal(beats.length, 1, `心跳必须被转出去，实际事件: ${JSON.stringify(events)}`);
    assert.equal(beats[0].steps, 23);
    assert.equal(beats[0].activity, 'shell pnpm test');
    assert.equal(beats[0].elapsedMs, 95_000);
    assert.equal(beats[0].description, '慢活', '要能对上是哪个子任务');
  });

  it('start / done 仍然照常发 —— 心跳不能把原有的两个事件挤掉', async () => {
    const events: SubagentProgressEvent[] = [];
    const tools = createSubagentTools({
      async run(req) { return { description: req.description, ok: true, result: 'ok' }; },
    }, { onProgress: (e) => events.push(e) });

    await tools.execute('task_spawn', { tasks: [{ description: '快活', prompt: 'x' }] });
    assert.deepEqual(events.map((e) => e.phase), ['start', 'done']);
  });

  it('runner 不上报心跳也照常工作 —— 它是尽力而为，不是契约', async () => {
    const tools = createSubagentTools({
      async run(req) { return { description: req.description, ok: true, result: 'ok' }; },
    });
    const out = await tools.execute('task_spawn', { tasks: [{ description: '静默', prompt: 'x' }] });
    assert.match(out, /\[完成\] 静默/);
  });
});
