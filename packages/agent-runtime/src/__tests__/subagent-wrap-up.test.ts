/**
 * 子任务软截止：硬杀之前先让它用已有信息交付。
 * 原始故障是子任务在第 90 秒就拿齐了事实，却一直读文件到 180 秒被杀。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  subagentWrapUpDelayMs,
  composeWrapUpNudge,
  SUBAGENT_WRAP_UP_RATIO,
  resolveSubagentTimeoutMs,
  resolveSubagentLlm,
} from '../subagent-tools.js';

describe('subagent wrap-up nudge', () => {
  it('fires before the hard deadline and leaves room for a final step', () => {
    const budget = resolveSubagentTimeoutMs(undefined);
    const at = subagentWrapUpDelayMs(budget);
    assert.ok(at < budget);
    assert.ok(budget - at >= 45_000);
    assert.ok(SUBAGENT_WRAP_UP_RATIO > 0.5 && SUBAGENT_WRAP_UP_RATIO < 0.9);
  });

  it('scales with the minimum budget too', () => {
    const budget = resolveSubagentTimeoutMs(1);
    assert.equal(subagentWrapUpDelayMs(budget), Math.round(budget * SUBAGENT_WRAP_UP_RATIO));
  });

  it('tells the child to stop exploring and deliver now', () => {
    const text = composeWrapUpNudge(54);
    assert.ok(text.includes('54'));
    assert.match(text, /停止继续探索/);
    assert.match(text, /最终答复/);
    assert.match(text, /未核实/);
  });

  it('never shows zero or negative seconds', () => {
    assert.ok(composeWrapUpNudge(0).includes('约 1 秒'));
    assert.ok(composeWrapUpNudge(-5).includes('约 1 秒'));
  });
});

describe('subagent thinking level and output cap', () => {
  it('drops the max-level parent to low and caps output at 32k', () => {
    assert.deepEqual(resolveSubagentLlm({ thinkingLevel: 'max', maxTokens: 0 }, {}), { thinkingLevel: 'low', maxTokens: 32_768 });
    assert.deepEqual(resolveSubagentLlm({ thinkingLevel: 'high', maxTokens: 131_072 }, {}), { thinkingLevel: 'low', maxTokens: 32_768 });
  });

  it('never raises a parent that is already lower', () => {
    assert.deepEqual(resolveSubagentLlm({ thinkingLevel: 'none', maxTokens: 8000 }, {}), { thinkingLevel: 'none', maxTokens: 8000 });
  });

  it('honours explicit env overrides and ignores garbage', () => {
    assert.deepEqual(
      resolveSubagentLlm({ thinkingLevel: 'max' }, { SHE_SUBAGENT_THINKING: 'HIGH', SHE_SUBAGENT_MAX_TOKENS: '65536' }),
      { thinkingLevel: 'high', maxTokens: 65_536 },
    );
    assert.deepEqual(
      resolveSubagentLlm({ thinkingLevel: 'max' }, { SHE_SUBAGENT_THINKING: 'turbo', SHE_SUBAGENT_MAX_TOKENS: '12' }),
      { thinkingLevel: 'low', maxTokens: 32_768 },
    );
  });
});
