import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReflectionTools, detectDrift } from '../reflection.js';

const goal = 'verify the server restarted: pid 15884 replaced by 17856';

test('actions matching the current plan step are not drift', () => {
  const r = detectDrift({
    goal,
    currentStep: 'probe netstat port 5577 and lsp_definition on src/types.ts',
    actions: [
      { tool: 'shell', args: '{"command":"netstat -ano | findstr 5577"}' },
      { tool: 'lsp_definition', args: '{"path":"src/types.ts","line":1,"col":15}' },
      { tool: 'shell', args: '{"command":"netstat -ano"}' },
      { tool: 'lsp_definition', args: '{"path":"src/types.ts","line":1,"col":14}' },
      { tool: 'shell', args: '{"command":"netstat -a"}' },
    ],
  });
  assert.equal(r.signals.find((s) => s.kind === 'goal_unrelated'), undefined);
});

test('bookkeeping calls do not count as unrelated work', () => {
  const r = detectDrift({
    goal,
    actions: [
      { tool: 'shell', args: '{"command":"ps -p 17856"}' },
      { tool: 'plan_update', args: '{"id":"p1"}' },
      { tool: 'reflection_check', args: '{}' },
      { tool: 'errorbook_lookup', args: '{}' },
      { tool: 'memo_list', args: '{}' },
    ],
  });
  assert.equal(r.signals.find((s) => s.kind === 'goal_unrelated'), undefined);
});

test('work unrelated to both goal and step is still reported', () => {
  const r = detectDrift({
    goal,
    currentStep: 'probe netstat port 5577',
    actions: [
      { tool: 'fs_read', args: '{"path":"docs/marketing.md"}' },
      { tool: 'fs_read', args: '{"path":"docs/pricing.md"}' },
      { tool: 'web_fetch', args: '{"url":"https://example.com/blog"}' },
      { tool: 'fs_read', args: '{"path":"docs/brand.md"}' },
      { tool: 'fs_read', args: '{"path":"docs/logo.md"}' },
    ],
  });
  const s = r.signals.find((x) => x.kind === 'goal_unrelated');
  assert.ok(s);
  assert.equal(s!.major, true);
});

// Live run 2026-09-26 19:41: the model passed its own short labels and the check said drift 1.00.
const liveGoal = "复测上一轮仍未闭环的两项——reflection_check 假阳性与 lsp_diagnostics 超时（上轮在 qa/hard/geometry.ts 复现）——在新构建（PID 19300）下是否修复";
const liveStep = "s2 校验自检模块的判定品质";
const liveLabels = ["复查", "收尾", "读文件", "写文件", "清理草稿", "跑回归"];

test('labels with no tool are not judged as unrelated work', () => {
  const r = detectDrift({ goal: liveGoal, actions: liveLabels });
  assert.equal(r.signals.find((s) => s.kind === 'goal_unrelated'), undefined);
});

test('calling a bookkeeping tool the goal is about counts as on-topic', () => {
  const r = detectDrift({
    goal: liveGoal,
    currentStep: liveStep,
    actions: [
      { tool: 'reflection_check', args: '{}' },
      { tool: 'reflection_check', args: '{}' },
      { tool: 'lsp_diagnostics', args: '{"path":"qa/hard/geo-copy.ts"}' },
    ],
  });
  assert.equal(r.level, 'none');
});

test('a paraphrased step is not reported when the real calls are on the goal', () => {
  const r = detectDrift({
    goal: liveGoal,
    currentStep: liveStep,
    actions: [
      { tool: 'fs_read', args: '{"path":"src/a.ts"}' },
      { tool: 'lsp_diagnostics', args: '{"path":"qa/hard/geometry.ts"}' },
      { tool: 'shell', args: '{"command":"ps -p 19300"}' },
    ],
  });
  assert.equal(r.signals.find((s) => s.kind === 'step_off_goal'), undefined);
});

test('reflection_check judges the recorded calls, not the labels passed in', async () => {
  const tools = createReflectionTools({
    goal: () => liveGoal,
    constraints: () => [],
    actions: () => [
      { tool: 'shell', args: '{"command":"ps -p 19300"}' },
      { tool: 'lsp_diagnostics', args: '{"path":"qa/hard/geometry.ts"}' },
      { tool: 'reflection_check', args: '{}' },
      { tool: 'lsp_diagnostics', args: '{"path":"qa/hard/geo-copy.ts"}' },
      { tool: 'fs_read', args: '{"path":"qa/hard/geometry.ts"}' },
    ],
    currentStep: () => liveStep,
    budget: () => ({ used: 5, limit: 32 }),
    calibration: () => ({ samples: 0 }) as never,
  });
  const text = await tools.execute('reflection_check', { actions: [...liveLabels, ...liveLabels], current_step: liveStep });
  assert.doesNotMatch(text, /1\.00/);
  assert.doesNotMatch(text, /最近 \d 个动作/);
});

const kbRule = '不得直读 .she/kb.sqlite，只用 kb_* 工具';

test('a whitelist in a constraint is not read as the forbidden object', () => {
  for (const rule of [kbRule, '不得直读 .she/kb.sqlite 只用 kb_* 工具', 'never read .she/kb.sqlite; only use kb_* tools']) {
    const r = detectDrift({
      goal: 'record the QA findings in the knowledge base',
      constraints: [rule],
      actions: [
        { tool: 'kb_upsert', args: '{"title":"qa","content":"x"}' },
        { tool: 'kb_query', args: '{"query":"geometry"}' },
      ],
    });
    assert.equal(r.signals.find((x) => x.kind === 'constraint_violated'), undefined, rule);
  }
});

test('the prohibited half of a whitelisted constraint is still enforced', () => {
  const r = detectDrift({
    goal: 'record the QA findings in the knowledge base',
    constraints: [kbRule],
    actions: [{ tool: 'shell', args: '{"command":"sqlite3 .she/kb.sqlite .tables"}' }],
  });
  assert.ok(r.signals.find((x) => x.kind === 'constraint_violated'));
});
