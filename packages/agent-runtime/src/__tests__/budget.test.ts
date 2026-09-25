/**
 * The turn budget is a switch, and a switch is only worth having if "off" is provably the old
 * behaviour.
 *
 * That is what most of this file asserts: with the defaults, `budgetStop` returns null for a turn
 * that has consumed anything at all — a hundred rounds, a million tokens, an hour of wall clock.
 * If that ever stops being true, every user who never asked for a ceiling starts having long tasks
 * cut short, and they would have no way to know why.
 *
 * The rest is the arithmetic the enforcement point relies on: one axis at a time, the `>=`
 * boundary, the order limits are reported in when several are blown at once, and a malformed value
 * that must NOT turn into a limit that silently never fires.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGET,
  budgetStop,
  parseBudgetLimits,
  renderBudgetStop,
  type BudgetLimits,
  type BudgetUsage,
} from '../budget.js';

const limits = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({ ...DEFAULT_BUDGET, enabled: true, ...over });
const usage = (over: Partial<BudgetUsage> = {}): BudgetUsage => ({
  rounds: 0, toolCalls: 0, tokens: 0, elapsedSeconds: 0, ...over,
});

describe('预算：默认关闭', () => {
  it('【关键】默认配置对任何用量都不返回停止', () => {
    /*
     * `enabled: false` short-circuits before any axis is read. Asserted against a usage that
     * exceeds every axis at once, so the test fails if a future change starts reading the limits
     * without checking the flag first.
     */
    assert.equal(budgetStop(DEFAULT_BUDGET, usage({ rounds: 1e6, toolCalls: 1e6, tokens: 1e9, elapsedSeconds: 1e6 })), null);
  });

  it('【关键】只填了上限但没开开关，仍然不生效', () => {
    /*
     * The reason `enabled` is a separate flag rather than "any limit > 0": a config file or an
     * environment variable that happens to carry a number must not arm itself. Somebody exporting
     * SHE_BUDGET_MAX_TOKENS for a shell script of their own would otherwise start having turns cut
     * short with nothing in the config to explain it.
     */
    const armed = limits({ maxTokens: 10 });
    assert.equal(budgetStop({ ...armed, enabled: false }, usage({ tokens: 9999 })), null);
  });

  it('0 表示该轴不设限', () => {
    assert.equal(budgetStop(limits({ maxTokens: 0, maxToolRounds: 0 }), usage({ tokens: 1e9, rounds: 1e6 })), null);
  });

  it('负数与 NaN 上限不会变成「提前停止」', () => {
    assert.equal(budgetStop(limits({ maxTokens: -1, maxSeconds: Number.NaN }), usage({ tokens: 5 })), null);
  });
});

describe('预算：各轴独立判定', () => {
  it('token 轴：用到上限即停，未到不停', () => {
    const l = limits({ maxTokens: 1000 });
    assert.equal(budgetStop(l, usage({ tokens: 999 })), null);
    assert.equal(budgetStop(l, usage({ tokens: 1000 }))?.kind, 'tokens');
  });

  it('秒数轴：是「已到」而不是「超过」', () => {
    /*
     * `>=` rather than `>` so a ceiling of 1 means one round of work and then stop. With `>`,
     * `maxSeconds: 1` would allow a second overrun and every test of the boundary would have to
     * reason about which side of it the implementation chose.
     */
    const l = limits({ maxSeconds: 30 });
    assert.equal(budgetStop(l, usage({ elapsedSeconds: 29.9 })), null);
    assert.equal(budgetStop(l, usage({ elapsedSeconds: 30 }))?.kind, 'seconds');
  });

  it('轮数轴：按已完成的轮数算', () => {
    const l = limits({ maxToolRounds: 1 });
    assert.equal(budgetStop(l, usage({ rounds: 0 })), null, '一轮都没跑完时不该停');
    assert.equal(budgetStop(l, usage({ rounds: 1 }))?.kind, 'rounds');
  });

  it('调用次数轴独立于轮数', () => {
    const l = limits({ maxToolCalls: 3 });
    assert.equal(budgetStop(l, usage({ rounds: 50, toolCalls: 2 })), null);
    assert.equal(budgetStop(l, usage({ toolCalls: 3 }))?.limit, 3);
  });

  it('多条同时超限时，按「最贵」的那条报（token > 秒 > 轮 > 次）', () => {
    /*
     * The order is a decision, not an accident: when both are true, "you set a spend ceiling"
     * explains more to the person who set it than "you set a round ceiling".
     */
    const l = limits({ maxTokens: 1, maxSeconds: 1, maxToolRounds: 1, maxToolCalls: 1 });
    assert.equal(budgetStop(l, usage({ rounds: 5, toolCalls: 5, tokens: 5, elapsedSeconds: 5 }))?.kind, 'tokens');
    assert.equal(budgetStop(l, usage({ rounds: 5, toolCalls: 5, tokens: 0, elapsedSeconds: 5 }))?.kind, 'seconds');
    assert.equal(budgetStop(l, usage({ rounds: 5, toolCalls: 5, tokens: 0, elapsedSeconds: 0 }))?.kind, 'rounds');
    assert.equal(budgetStop(l, usage({ rounds: 0, toolCalls: 5, tokens: 0, elapsedSeconds: 0 }))?.kind, 'tool_calls');
  });

  it('把不该判的轴传 0 就能屏蔽它（检查点各自只看自己那几轴）', () => {
    /*
     * The enforcement points pass `rounds: 0` (or `tokens: 0`) so that a check between tool calls
     * cannot fire the round ceiling a second time. That only works because 0 can never reach a
     * positive limit.
     */
    const l = limits({ maxToolRounds: 1, maxToolCalls: 2 });
    const midMessage = { rounds: 0, tokens: 0 };
    assert.equal(budgetStop(l, usage({ ...midMessage, toolCalls: 1 })), null);
    assert.equal(budgetStop(l, usage({ ...midMessage, toolCalls: 2 }))?.kind, 'tool_calls');
  });

  it('小数上限被截断，不产生「0.5 轮」这种判定', () => {
    assert.equal(budgetStop(limits({ maxToolRounds: 1.9 }), usage({ rounds: 1 }))?.limit, 1);
  });
});

describe('预算：给用户看的文案', () => {
  it('【关键】说清是哪个开关停的、怎么恢复、怎么关掉', () => {
    const stop = budgetStop(limits({ maxToolRounds: 5 }), usage({ rounds: 5 }))!;
    const text = renderBudgetStop(stop);
    assert.match(text, /上限 5 轮模型调用/, '要说清上限和单位');
    assert.match(text, /已用到 5/);
    assert.match(text, /继续说「继续」|说「继续」/, '要告诉用户能接着做');
    assert.match(text, /budget\.enabled/, '要指出是哪个开关');
    assert.match(text, /不是任务失败/, '要明确不是失败——否则会被当成崩溃');
    assert.match(text, /不是知识库的次数限制/, '要和既有那条「达到工具调用上限」的文案区分开');
  });

  it('每种轴都写上了自己的配置键', () => {
    const keys = [
      ['tokens', 'SHE_BUDGET_MAX_TOKENS'],
      ['seconds', 'SHE_BUDGET_MAX_SECONDS'],
      ['rounds', 'SHE_BUDGET_MAX_TOOL_ROUNDS'],
      ['tool_calls', 'SHE_BUDGET_MAX_TOOL_CALLS'],
    ] as const;
    for (const [kind, env] of keys) {
      const stop = { kind, limit: 1, used: 1 } as const;
      const text = renderBudgetStop(stop);
      assert.ok(text.includes(env), `${kind} 的文案里应该出现 ${env}：${text}`);
    }
  });
});

describe('预算：读取配置', () => {
  it('从对象读，缺项保留默认', () => {
    const parsed = parseBudgetLimits({ enabled: true, maxTokens: 500 });
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.maxTokens, 500);
    assert.equal(parsed.maxToolRounds, 0, '没写的轴应当保持默认（不设限）');
  });

  it('字符串形式的开关也认（YAML / env 都可能是字符串）', () => {
    assert.equal(parseBudgetLimits({ enabled: 'true' }).enabled, true);
    assert.equal(parseBudgetLimits({ enabled: '1' }).enabled, true);
    assert.equal(parseBudgetLimits({ enabled: 'false' }).enabled, false);
    assert.equal(parseBudgetLimits({ enabled: '0' }).enabled, false);
  });

  it('【关键】坏值被丢弃，而不是变成 NaN（那会让这一轴永不触发）', () => {
    const parsed = parseBudgetLimits({ enabled: true, maxTokens: '20k', maxSeconds: -5 });
    assert.equal(parsed.maxTokens, 0, "'20k' 应当退回默认（不设限），不能变成 NaN");
    assert.equal(parsed.maxSeconds, 0, '负数上限没有意义');
    assert.ok(Number.isFinite(parsed.maxTokens));
  });

  it('null / 数组 / 字符串不会让读取抛错', () => {
    for (const raw of [null, [], 'budget: none', 42, undefined]) {
      const parsed = parseBudgetLimits(raw);
      assert.equal(parsed.enabled, false);
      assert.equal(parsed.maxTokens, 0);
    }
  });

  it('小数被截断为整数', () => {
    assert.equal(parseBudgetLimits({ maxToolCalls: 2.8 }).maxToolCalls, 2);
  });
});
