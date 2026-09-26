/**
 * 子任务软截止：硬杀之前先让它用已有信息交付。
 * 原始故障是子任务在第 90 秒就拿齐了事实，却一直读文件到 180 秒被杀。
 *
 * 用 `node:test`（本包的 runner），不用 vitest —— `pnpm -r build` 会编译本文件，
 * 而 agent-runtime 的 devDependencies 里没有 vitest，导入它会让整包 tsc 失败。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  subagentWrapUpDelayMs,
  composeWrapUpNudge,
  SUBAGENT_WRAP_UP_RATIO,
  resolveSubagentTimeoutMs,
} from '../subagent-tools.js';

describe('subagent wrap-up nudge', () => {
  it('fires before the hard deadline and leaves room for a final step', () => {
    const budget = resolveSubagentTimeoutMs(undefined);
    const at = subagentWrapUpDelayMs(budget);
    assert.ok(at < budget, `软截止 ${at} 必须早于硬截止 ${budget}`);
    assert.ok(
      budget - at >= 45_000,
      `硬杀前要留出至少 45s 走一两步，实际只剩 ${budget - at}ms`,
    );
    assert.ok(SUBAGENT_WRAP_UP_RATIO > 0.5, `比例 ${SUBAGENT_WRAP_UP_RATIO} 应大于 0.5`);
    assert.ok(SUBAGENT_WRAP_UP_RATIO < 0.9, `比例 ${SUBAGENT_WRAP_UP_RATIO} 应小于 0.9`);
  });

  it('scales with the minimum budget too', () => {
    const budget = resolveSubagentTimeoutMs(1);
    assert.equal(subagentWrapUpDelayMs(budget), Math.round(budget * SUBAGENT_WRAP_UP_RATIO));
  });

  it('tells the child to stop exploring and deliver now', () => {
    const text = composeWrapUpNudge(54);
    assert.ok(text.includes('54'), text);
    assert.match(text, /停止继续探索/);
    assert.match(text, /最终答复/);
    assert.match(text, /未核实/);
  });

  it('never shows zero or negative seconds', () => {
    assert.ok(composeWrapUpNudge(0).includes('约 1 秒'), composeWrapUpNudge(0));
    assert.ok(composeWrapUpNudge(-5).includes('约 1 秒'), composeWrapUpNudge(-5));
  });
});
