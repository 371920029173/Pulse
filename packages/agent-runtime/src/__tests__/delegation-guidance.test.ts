/**
 * 「什么时候派子智能体」的判据。
 *
 * 证据（2026-10-13，两个工作区 audit.log 共 8773 次工具调用）：task_spawn **0 次**，而它只在
 * 工具表里露过一行字。这条判据钉两件事：工作规则那一节里有它（模型真读的地方），且**子任务拿不到**
 * （子任务没有 task_spawn，告诉它去派等于让它撞墙）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSystemPrompt } from '../system-prompt.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-deleg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('派子智能体的判据', () => {
  it('主会话的提示词里有「什么时候值 / 不值 / 派之前说清 / 拿回摘要之后」', () => {
    const p = getSystemPrompt(dir, 'general', false);
    assert.match(p, /## 派子智能体（task_spawn）/, '提示词里没有这一节');
    assert.match(p, /什么时候值/);
    assert.match(p, /什么时候不值/);
    assert.match(p, /派之前一次说清/);
    assert.match(p, /拿回摘要之后/);
    assert.match(p, /不能问你|不能问用户/, '没提"子任务不能问你"这条最常踩的坑');
  });

  it('子任务不被告知去派（它没有这个工具）', () => {
    const p = getSystemPrompt(dir, 'general', true, { subagent: true });
    assert.doesNotMatch(p, /## 派子智能体（task_spawn）/, '子任务也被叫去派子任务了');
  });
});
