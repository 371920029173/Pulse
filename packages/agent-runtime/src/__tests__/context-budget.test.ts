/**
 * 定价必须**真的**参与决策。
 *
 * 这个文件里最重要的两条是"同样的用量、只改单价，给出的建议必须不同"：如果面板只是把定价当标签
 * 显示、策略其实写死，那它就是在骗用户 —— 用户填单价是为了换一个不同的安排，不是为了看一个被
 * 乘出来的数字。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateContext,
  estimateCost,
  parseContextBudget,
  pricingConfigured,
  pricingNote,
  COST_DISCLAIMER,
  DEFAULT_CONTEXT_BUDGET,
  type TokenPricing,
} from '../context-budget.js';

/*
 * 两套价格，用量固定为"输入 200k / 输出 1k"，只改单价。
 *
 * 数字要能真的把结论掰到两边，否则测的还是"两边一样"：
 *   CHEAP_INPUT  → 输入 200k×0.1/M = $0.020，输出 1k×100/M = $0.100  → 输出侧占 83%
 *   CHEAP_OUTPUT → 输入 200k×10/M  = $2.000，输出 1k×0.1/M  = $0.0001 → 输入侧几乎占满
 */
const CHEAP_INPUT: TokenPricing = { inputPerMillion: 0.1, outputPerMillion: 100, cachedInputPerMillion: 0 };
const CHEAP_OUTPUT: TokenPricing = { inputPerMillion: 10, outputPerMillion: 0.1, cachedInputPerMillion: 0 };

/** 输入很多、输出很少的典型一轮。 */
const INPUT_HEAVY = { prompt_tokens: 200_000, completion_tokens: 1_000 };

describe('estimateCost', () => {
  it('按输入/输出分别计价并加总', () => {
    const c = estimateCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, {
      inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0,
    });
    assert.equal(Number(c.freshInput.toFixed(6)), 3);
    assert.equal(Number(c.output.toFixed(6)), 15);
    assert.equal(Number(c.total.toFixed(6)), 18);
  });

  it('命中缓存的输入按缓存价算，不按输入价算', () => {
    const c = estimateCost(
      { prompt_tokens: 1_000_000, completion_tokens: 0, cache_hit_tokens: 1_000_000 },
      { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
    );
    assert.equal(Number(c.cachedInput.toFixed(6)), 0.3);
    assert.equal(Number(c.freshInput.toFixed(6)), 0);
  });

  it('没有缓存价时，命中的部分按输入价算（不填不等于免费）', () => {
    const c = estimateCost(
      { prompt_tokens: 1_000_000, completion_tokens: 0, cache_hit_tokens: 1_000_000 },
      { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0 },
    );
    assert.equal(Number(c.cachedInput.toFixed(6)), 3);
  });

  it('没有缓存字段时，整个 prompt 都当未命中（不猜一个命中率）', () => {
    const c = estimateCost({ prompt_tokens: 500_000, completion_tokens: 0 }, {
      inputPerMillion: 2, outputPerMillion: 2, cachedInputPerMillion: 0,
    });
    assert.equal(Number(c.freshInput.toFixed(6)), 1);
    assert.equal(Number(c.cachedInput.toFixed(6)), 0);
  });

  it('定价没填时不假装免费', () => {
    const c = estimateCost({ prompt_tokens: 999_999, completion_tokens: 999_999 }, { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 });
    assert.equal(c.total, 0);
    assert.equal(pricingConfigured({ inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 }), false);
    assert.match(pricingNote({ inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 }), /未填写单价/);
  });

  it('负数 / NaN 单价不会被悄悄当成有效值', () => {
    const c = estimateCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, {
      inputPerMillion: -5 as number, outputPerMillion: Number.NaN as number, cachedInputPerMillion: 0,
    });
    assert.equal(c.total, 0);
  });
});

describe('allocateContext：定价真的参与决策', () => {
  it('同样的用量、只改单价 → 建议的那一侧不同', () => {
    const outHeavy = allocateContext({ requested: 'auto', pricing: CHEAP_INPUT, usage: INPUT_HEAVY });
    const inHeavy = allocateContext({ requested: 'auto', pricing: CHEAP_OUTPUT, usage: INPUT_HEAVY });

    assert.equal(outHeavy.heavierSide, 'output');
    assert.equal(inHeavy.heavierSide, 'input');
    assert.notEqual(outHeavy.level, inHeavy.level);

    // 输出贵 → 动推理档位；输入贵 → 不动推理（省错地方）。
    assert.equal(outHeavy.levers.find((l) => l.id === 'reasoning')?.applies, true);
    assert.equal(inHeavy.levers.find((l) => l.id === 'reasoning')?.applies, false);
    // 输入贵 → 压输入侧的杠杆打开。
    assert.equal(inHeavy.levers.find((l) => l.id === 'tool-results')?.applies, true);
  });

  it('【关键】输出占大头时输入侧不能被压狠（那会省错地方、还更贵）', () => {
    const outHeavy = allocateContext({ requested: 'auto', pricing: CHEAP_INPUT, usage: INPUT_HEAVY });
    assert.equal(outHeavy.level, 'light', '输出贵的时候输入侧应该停在 light');
    assert.equal(outHeavy.levers.find((l) => l.id === 'tool-results')?.applies, false);
  });

  it('输入极贵时给出的档位比输出极贵时更狠', () => {
    const rank = { off: 0, light: 1, balanced: 2, aggressive: 3 } as const;
    const inHeavy = allocateContext({ requested: 'auto', pricing: CHEAP_OUTPUT, usage: INPUT_HEAVY });
    const outHeavy = allocateContext({ requested: 'auto', pricing: CHEAP_INPUT, usage: INPUT_HEAVY });
    assert.ok(
      rank[inHeavy.level] >= rank[outHeavy.level],
      `输入贵(${inHeavy.level}) 应该不比 输出贵(${outHeavy.level}) 更轻`,
    );
  });

  it('还没用量时退回按价格比判断（不能说"没数据所以不动"）', () => {
    const a = allocateContext({ requested: 'auto', pricing: CHEAP_OUTPUT, usage: {} });
    assert.equal(a.level, 'aggressive');
    assert.equal(a.heavierSide, 'input');
    const b = allocateContext({ requested: 'auto', pricing: { inputPerMillion: 1, outputPerMillion: 20, cachedInputPerMillion: 0 }, usage: {} });
    assert.equal(b.level, 'light');
    assert.equal(b.heavierSide, 'output');
  });

  it('单价和用量都没有 → 不动任何东西（off）', () => {
    const a = allocateContext({ requested: 'auto', pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 }, usage: {} });
    assert.equal(a.level, 'off');
    assert.equal(a.levers.every((l) => !l.applies), true, 'off 档位不该有任何杠杆生效');
  });

  it('用户指定档位时不被自动逻辑覆盖', () => {
    for (const level of ['off', 'light', 'balanced', 'aggressive'] as const) {
      const a = allocateContext({ requested: level, pricing: CHEAP_OUTPUT, usage: INPUT_HEAVY });
      assert.equal(a.level, level);
    }
  });
});

describe('历史压缩：默认不删，且必须显式允许', () => {
  it('【关键】默认不许删历史 —— 即使用户选了最狠的档位', () => {
    const a = allocateContext({ requested: 'aggressive', pricing: CHEAP_OUTPUT, usage: INPUT_HEAVY });
    assert.equal(a.historyReduction, false);
    assert.equal(a.levers.find((l) => l.id === 'history')?.applies, false);
    assert.match(a.levers.find((l) => l.id === 'history')?.why ?? '', /默认不压缩任何历史记录/);
  });

  it('显式允许了、但档位没到 aggressive → 仍然不删', () => {
    const a = allocateContext({ requested: 'balanced', pricing: CHEAP_OUTPUT, usage: INPUT_HEAVY, allowHistoryReduction: true });
    assert.equal(a.historyReduction, false);
  });

  it('【关键】显式允许 + aggressive → 才真的删', () => {
    const a = allocateContext({ requested: 'aggressive', pricing: CHEAP_OUTPUT, usage: INPUT_HEAVY, allowHistoryReduction: true });
    assert.equal(a.historyReduction, true);
  });

  it('只有 history 这一条杠杆会删东西', () => {
    const a = allocateContext({ requested: 'aggressive', pricing: CHEAP_OUTPUT, usage: INPUT_HEAVY, allowHistoryReduction: true });
    assert.deepEqual(a.levers.filter((l) => l.destructive).map((l) => l.id), ['history']);
  });
});

describe('推理档位建议：只会往低走', () => {
  it('输出贵时往下调一档', () => {
    const a = allocateContext({ requested: 'balanced', pricing: CHEAP_INPUT, usage: INPUT_HEAVY, currentThinkingLevel: 'medium' });
    assert.equal(a.recommendedThinkingLevel, 'low');
  });

  it('aggressive 时往下调两档', () => {
    const a = allocateContext({ requested: 'aggressive', pricing: CHEAP_INPUT, usage: INPUT_HEAVY, currentThinkingLevel: 'high' });
    assert.equal(a.recommendedThinkingLevel, 'low');
  });

  it('【关键】绝不会为了"更聪明"往上抬（那会加钱）', () => {
    /*
     * 断言的是**方向**，不是"null"：从 max 往下降到 xhigh 是正确的建议（省钱），
     * 第一版这里写成了 `assert.equal(..., null)`，等于把"正确的下调"也判成失败。
     */
    const rank = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 } as const;
    for (const level of ['off', 'light', 'balanced', 'aggressive'] as const) {
      const a = allocateContext({ requested: level, pricing: CHEAP_INPUT, usage: INPUT_HEAVY, currentThinkingLevel: 'medium' });
      if (a.recommendedThinkingLevel) {
        assert.ok(
          rank[a.recommendedThinkingLevel] < rank.medium,
          `${level} 建议了 ${a.recommendedThinkingLevel}，没有比当前更低`,
        );
      }
    }
  });

  it('当前是 max 时建议下调（不是不给建议）', () => {
    const a = allocateContext({ requested: 'balanced', pricing: CHEAP_INPUT, usage: INPUT_HEAVY, currentThinkingLevel: 'max' });
    assert.equal(a.recommendedThinkingLevel, 'xhigh');
  });

  it('已经是最低档 → 没有建议（不返回一个等于当前值的"建议"）', () => {
    const a = allocateContext({ requested: 'aggressive', pricing: CHEAP_INPUT, usage: INPUT_HEAVY, currentThinkingLevel: 'none' });
    assert.equal(a.recommendedThinkingLevel, null);
  });
});

describe('免责声明与解析', () => {
  it('【关键】免责声明逐字包含用户要求的那句', () => {
    const a = allocateContext({ requested: 'auto', pricing: CHEAP_OUTPUT, usage: INPUT_HEAVY });
    assert.ok(a.disclaimer.includes('该功能尽量为您减少开支，但不保证不会使您的开支增加'), a.disclaimer);
    assert.equal(a.disclaimer, COST_DISCLAIMER);
  });

  it('parseContextBudget：默认不删历史、默认 off', () => {
    const d = parseContextBudget(null);
    assert.equal(d.compression, 'off');
    assert.equal(d.allowHistoryReduction, false);
    assert.equal(DEFAULT_CONTEXT_BUDGET.allowHistoryReduction, false);
  });

  it('parseContextBudget：认 auto 和四档，拒绝乱写', () => {
    assert.equal(parseContextBudget({ compression: 'auto' }).compression, 'auto');
    assert.equal(parseContextBudget({ compression: 'aggressive' }).compression, 'aggressive');
    assert.equal(parseContextBudget({ compression: 'turbo' }).compression, 'off');
  });

  it('parseContextBudget：字符串形式的开关也认', () => {
    assert.equal(parseContextBudget({ allowHistoryReduction: 'true' }).allowHistoryReduction, true);
    assert.equal(parseContextBudget({ allowHistoryReduction: '0' }).allowHistoryReduction, false);
  });

  it('parseContextBudget：单价保留 0 与合法值，拒绝负数/NaN', () => {
    const p = parseContextBudget({ pricing: { inputPerMillion: 0, outputPerMillion: 15, cachedInputPerMillion: 'bad' } }).pricing;
    assert.equal(p.inputPerMillion, 0);
    assert.equal(p.outputPerMillion, 15);
    assert.equal(p.cachedInputPerMillion, 0);
    assert.equal(parseContextBudget({ pricing: { inputPerMillion: -1 } }).pricing.inputPerMillion, 0);
  });
});
