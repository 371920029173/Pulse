/**
 * 子任务委派：什么时候开隔离副本、交接单里到底写了什么、以及哪些委派形状会被拒掉。
 *
 * 这些断言的共同点是把「父级以为的」和「子级实际的」对齐：隔离规则是父级据以决定要不要
 * 声明 scope 的东西，交接单是子级唯一的上下文，而回显是父级事后核对范围的唯一依据。
 * 三者只要有一个和文档说的不一样，委派就会安静地偏离意图 —— 所以规则、文案、拒绝条件
 * 都当成对外契约来测，而不是当成内部实现。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIsolate, composeHandoffPrompt, createSubagentTools } from '../subagent-tools.js';
import type { SubagentRequest, SubagentResult } from '../subagent-tools.js';

describe('shouldIsolate 的规则', () => {
  it('声明了 scope 才会自动开副本', () => {
    assert.equal(shouldIsolate({ isolation: 'auto', handoff: { scope: ['a.ts'] } }, true), true);
    assert.equal(shouldIsolate({ isolation: 'auto', handoff: { scope: [] } }, true), false);
    assert.equal(shouldIsolate({ isolation: 'auto' }, true), false);
  });

  it('只读任务留在共享 checkout —— 副本基于 HEAD，会看不到未提交的改动', () => {
    // Not a style preference: a child asked to review "my current changes" inside a worktree
    // would be reading the last commit, and would then report on code that is not what the
    // parent is looking at.
    assert.equal(shouldIsolate({ isolation: 'auto', handoff: { deliverable: '一份报告', scope: [] } }, true), false);
  });

  it('显式覆盖优先于默认规则', () => {
    assert.equal(shouldIsolate({ isolation: 'worktree' }, true), true);
    assert.equal(shouldIsolate({ isolation: 'none', handoff: { scope: ['a.ts'] } }, true), false);
  });

  it('不是 git 仓库时如实返回 false —— 调用方据此说明为什么没隔离', () => {
    assert.equal(shouldIsolate({ isolation: 'worktree' }, false), false);
    assert.equal(shouldIsolate({ isolation: 'auto', handoff: { scope: ['a.ts'] } }, false), false);
  });
});

describe('交接单', () => {
  const brief = composeHandoffPrompt(
    {
      description: '整理调用方',
      prompt: '列出所有调用方。',
      handoff: {
        deliverable: '一份调用方清单',
        scope: ['src/a.ts'],
        constraints: ['不要装新依赖'],
        context: ['入口在 src/index.ts'],
      },
    },
    { workdir: '/ws/wt', isolated: true },
  );

  it('四个结构化字段都到了子级手里', () => {
    assert.match(brief, /一份调用方清单/);
    assert.match(brief, /src\/a\.ts/);
    assert.match(brief, /不要装新依赖/);
    assert.match(brief, /入口在 src\/index\.ts/);
    assert.match(brief, /\/ws\/wt/);
  });

  it('交接单排在任务之前', () => {
    assert.ok(brief.indexOf('交接单') < brief.indexOf('列出所有调用方。'));
  });

  it('副本里明说不要自己合并 —— 否则子级会去 commit / push', () => {
    assert.match(brief, /隔离副本/);
    assert.match(brief, /不要尝试自己合并/);
  });

  it('共享 checkout 时不说「这是副本」 —— 说了子级就不敢改文件了', () => {
    const shared = composeHandoffPrompt({ description: '查一下', prompt: '看看。' }, { workdir: '/ws', isolated: false });
    assert.doesNotMatch(shared, /隔离副本/);
  });

  it('没有 scope 时明说是只读任务，而不是留空', () => {
    const readOnly = composeHandoffPrompt({ description: '查一下', prompt: '看看。' }, { workdir: '/ws', isolated: false });
    assert.match(readOnly, /不要修改、创建或删除任何文件/);
  });

  it('没写交付物时退回任务简述，不留一个空字段', () => {
    const brief2 = composeHandoffPrompt({ description: '查一下', prompt: '看看。' }, { workdir: '/ws', isolated: false });
    assert.match(brief2, /交付物：查一下/);
  });

  it('共享父级库时明说只读 —— 那是子级唯一能永久改父级状态的通路', () => {
    const shared = composeHandoffPrompt(
      { description: '查一下', prompt: '看看。' },
      { workdir: '/ws', isolated: false, kb: 'shared' },
    );
    assert.match(shared, /父级的活动库/, '共享库不说清楚，子级会以为这是自己的记忆');
    assert.match(shared, /只读/);
    assert.match(shared, /交付物/, '拒了写入就必须给出替代动作');
  });

  it('私有副本与共享库的措辞不能混（两种记忆语义正好相反）', () => {
    const snap = composeHandoffPrompt(
      { description: 'x', prompt: 'y' },
      { workdir: '/wt', isolated: true, kb: 'snapshot' },
    );
    assert.match(snap, /私有副本/);
    assert.match(snap, /被父级读一遍/, '子级得知道笔记有人读，否则它不会花那一次调用');
    assert.doesNotMatch(snap, /父级的活动库/);
  });
});

/** A runner that records what it was asked for, and echoes a canned result. */
function runnerSpy(result?: Partial<SubagentResult>) {
  const calls: SubagentRequest[] = [];
  return {
    calls,
    runner: {
      async run(req: SubagentRequest): Promise<SubagentResult> {
        calls.push(req);
        return { description: req.description, ok: true, result: 'ok', handoff: req.handoff, ...result };
      },
    },
  };
}

describe('派发前的拒绝', () => {
  it('会改文件却没写交付物 → 拒掉，而且一个子级都不拉起', async () => {
    const { calls, runner } = runnerSpy();
    const tools = createSubagentTools(runner);
    const out = await tools.execute('task_spawn', {
      tasks: [{ description: '随便改改', prompt: '改点什么', scope: ['src/**'] }],
    });
    assert.match(out, /^Error:/);
    assert.match(out, /交付物/);
    assert.equal(calls.length, 0, '拒绝必须发生在派发之前，否则副本已经开了');
  });

  it('强制副本同样要求交付物 —— 「开副本」本身就是会改文件的意思', async () => {
    const { calls, runner } = runnerSpy();
    const tools = createSubagentTools(runner);
    const out = await tools.execute('task_spawn', {
      tasks: [{ description: '隔离的活', prompt: 'x', isolation: 'worktree' }],
    });
    assert.match(out, /^Error:/);
    assert.equal(calls.length, 0);
  });
});

describe('结构化交接与回显', () => {
  it('结构化字段原样传到 runner，isolation 默认 auto', async () => {
    const { calls, runner } = runnerSpy();
    const tools = createSubagentTools(runner);
    await tools.execute('task_spawn', {
      tasks: [{ description: '改文件', prompt: '改好 a.ts', deliverable: '改好的 a.ts', scope: ['src/a.ts'] }],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].isolation, 'auto');
    assert.equal(calls[0].handoff?.deliverable, '改好的 a.ts');
    assert.deepEqual(calls[0].handoff?.scope, ['src/a.ts']);
  });

  it('只读任务不带 handoff（没有交付物、没有 scope，就不该有交接单）', async () => {
    const { calls, runner } = runnerSpy();
    const tools = createSubagentTools(runner);
    await tools.execute('task_spawn', { tasks: [{ description: '只读', prompt: '读一下' }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].handoff, undefined);
  });

  it('回执里回显范围与改动清单，父级不必重读自己写的话', async () => {
    // portability-check:allow — 这两个盘符是夹具数据，用来验证回执原样回显副本路径；
    // 断言里也要用同一个字面量，所以不能改成 path.join。
    const { runner } = runnerSpy({
      worktree: { path: 'D:\\wt\\sub-1', branch: 'she/sub-1', changed: ['src/a.ts', 'src/new.ts'] },
    });
    const tools = createSubagentTools(runner);
    const out = await tools.execute('task_spawn', {
      tasks: [{ description: '隔离的活', prompt: 'x', deliverable: '一份补丁', scope: ['src/a.ts'] }],
    });
    assert.match(out, /一份补丁/);
    assert.match(out, /src\/a\.ts/);
    assert.match(out, /D:\\wt\\sub-1/);
    assert.match(out, /she\/sub-1/);
    assert.match(out, /src\/new\.ts/);
  });

  it('副本里一个文件都没改时说出来 —— 否则和「什么都没干」分不清', async () => {
    // portability-check:allow — 夹具数据，见上一条。
    const { runner } = runnerSpy({
      worktree: { path: 'D:\\wt\\sub-2', branch: 'she/sub-2', changed: [] },
    });
    const tools = createSubagentTools(runner);
    const out = await tools.execute('task_spawn', {
      tasks: [{ description: '隔离的活', prompt: 'x', deliverable: 'D', scope: ['src/a.ts'] }],
    });
    assert.match(out, /改动的文件：无/);
  });

  it('隔离没能建立时把原因说出来 —— 静默降级到共享 checkout 是最坏的结果', async () => {
    const { runner } = runnerSpy({
      // The real shape: no worktree at all, just the reason there is none.
      isolation: { requested: true, applied: false, note: '主工作区不是 git 仓库，无法开隔离副本' },
    });
    const tools = createSubagentTools(runner);
    const out = await tools.execute('task_spawn', {
      tasks: [{ description: '隔离的活', prompt: 'x', deliverable: 'D', scope: ['src/a.ts'] }],
    });
    assert.match(out, /未隔离/);
    assert.match(out, /不是 git 仓库/);
  });

  it('没有要求过隔离的只读任务不发警告 —— 狼来了会让警告在真正需要时失效', async () => {
    const { runner } = runnerSpy({ isolation: { requested: false, applied: false } });
    const tools = createSubagentTools(runner);
    const out = await tools.execute('task_spawn', { tasks: [{ description: '只读', prompt: '看看' }] });
    assert.doesNotMatch(out, /未隔离/);
  });
});

describe('运行器的失败不会吞掉一个子任务', () => {
  it('runner 抛错时该子任务记成失败，其它子任务照常返回', async () => {
    const tools = createSubagentTools({
      async run(req) {
        if (req.description === '坏的') throw new Error('boom');
        return { description: req.description, ok: true, result: '好', handoff: req.handoff };
      },
    });
    const out = await tools.execute('task_spawn', {
      tasks: [
        { description: '坏的', prompt: 'x' },
        { description: '好的', prompt: 'y' },
      ],
    });
    assert.match(out, /\[失败\] 坏的/);
    assert.match(out, /子任务异常: boom/);
    assert.match(out, /\[完成\] 好的/);
  });
});
