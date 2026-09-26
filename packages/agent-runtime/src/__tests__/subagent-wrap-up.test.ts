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
  subagentWrapUpScheduleMs,
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

  /**
   * 一次机会是不够的，这条是 2026-09-25 那次超时留下的算术。
   *
   * 子会话 sess_8d64da11747c 的真实回合边界（子会话起点起算，秒）：
   *   43.6 / 56.3 / 88.9 / 90.1 / 90.2 / 153.6 / 167.1 / 180.2（硬杀）
   * 提醒在 126.0s 发出，但 90.2s 起的那次模型请求跑了 63.4s，所以提醒只能在 153.6s 落地，
   * 剩 26.4s。它恰好够（该轮中位回合 13.5s），但那不是设计给的保证——若那次回合再慢一点，
   * 单发的提醒就完全白费。所以窗口内必须排不止一次。
   */
  it('fires more than once, so one landing too late is not the only chance', () => {
    const budget = resolveSubagentTimeoutMs(undefined);
    const shots = subagentWrapUpScheduleMs(budget);
    assert.ok(shots.length >= 2, `软截止要有不止一次机会，实际 ${shots.length} 次`);
    for (let i = 1; i < shots.length; i++) {
      assert.ok(shots[i] > shots[i - 1], `第 ${i + 1} 次提醒必须晚于上一次: ${shots.join(', ')}`);
    }
    assert.equal(shots[0], subagentWrapUpDelayMs(budget), '第一次提醒仍是原来的比例');
    const last = shots[shots.length - 1];
    assert.ok(last < budget, `最后一次提醒 ${last} 必须早于硬截止 ${budget}`);
    assert.ok(
      budget - last >= 15_000,
      `最后一次也要留出一次答复的时间，实际只剩 ${budget - last}ms`,
    );
  });

  it('keeps every shot inside even the smallest budget', () => {
    const budget = resolveSubagentTimeoutMs(1);
    const shots = subagentWrapUpScheduleMs(budget);
    assert.ok(shots.length >= 2, shots.join(', '));
    assert.ok(shots.every((s) => s > 0 && s < budget), shots.join(', '));
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

  /**
   * 重复提醒必须说清"这是重复"，否则它读起来和第一次一模一样——
   * 而它出现的唯一理由就是前一次落地后子任务还在探索。
   */
  it('says it is a repeat when the first reminder did not make it deliver', () => {
    const first = composeWrapUpNudge(54, 1);
    assert.ok(!/次提醒/.test(first), first);
    const again = composeWrapUpNudge(26.4, 2);
    assert.match(again, /第 2 次提醒/);
    assert.ok(again.includes('26.4') || again.includes('26'), again);
    assert.match(again, /停止继续探索/);
    assert.match(again, /最终答复/);
  });

  it('never shows zero or negative seconds', () => {
    assert.ok(composeWrapUpNudge(0).includes('约 1 秒'), composeWrapUpNudge(0));
    assert.ok(composeWrapUpNudge(-5).includes('约 1 秒'), composeWrapUpNudge(-5));
    assert.ok(composeWrapUpNudge(0, 3).includes('约 1 秒'), composeWrapUpNudge(0, 3));
  });
});
