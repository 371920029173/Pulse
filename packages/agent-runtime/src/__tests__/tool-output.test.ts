/**
 * One tool result is paid for on EVERY later request, so it has to be bounded once.
 *
 * The measurement this exists for (2026-10-03, `sess_8cd40d35a3cb`): a single `shell_wait` returned
 * 732,633 characters — 76% of that session's 964,280-character transcript — inside a run that billed
 * 9,318,458 prompt tokens over 35 requests. The cache was healthy (96% hit); the context was simply
 * enormous, and it was re-sent every turn.
 *
 * Three properties, and a fourth that is the reason the other three are not enough on their own:
 *
 *   1. **Bounded** — a result never contributes more than the budget to the context.
 *   2. **Both ends kept** — the head and the tail are byte-for-byte the tool's own output, because
 *      neither end is inferable from the other.
 *   3. **Stated** — the elision names the real sizes and the call that gets the rest.
 *   4. **NOT blanket** — a result under the budget is passed through untouched, byte for byte. A
 *      budget that trims ordinary answers is a data-loss bug wearing a budget's clothes; the check
 *      scripts pin the same distinction on the plan and KB replies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetToolResult,
  elisionRemedy,
  fitToolResultsToBudget,
  TOOL_RESULT_CONTEXT_CHARS,
} from '../tool-output.js';

/** A result shaped like the one that caused this: a long build log with a summary at the end. */
function buildLog(chars: number): string {
  const head = '> pnpm check:offline\n\n';
  const tail = '\n\n=== ALL CHECKS PASSED (52 steps, 616.7s) ===\n';
  const filler = 'x'.repeat(Math.max(0, chars - head.length - tail.length));
  return `${head}${filler}${tail}`;
}

describe('工具结果的上下文预算', () => {
  it('预算内的结果逐字节原样通过（不是见谁都裁）', () => {
    const text = 'stdout:\nPASS 12/12\nexit code: 0';
    const out = budgetToolResult(text, 'shell');
    assert.equal(out.truncated, false);
    assert.equal(out.text, text);
    assert.equal(out.elidedChars, 0);
    assert.equal(out.fullChars, text.length);
  });

  it('空结果是空结果，不会被"补"成一句说明', () => {
    assert.equal(budgetToolResult('', 'grep').text, '');
    assert.equal(budgetToolResult('', 'grep').truncated, false);
  });

  it('超预算的结果不超过预算（说明本身也算在预算里）', () => {
    const out = budgetToolResult(buildLog(400_000), 'shell');
    assert.ok(out.truncated);
    assert.ok(
      out.text.length <= TOOL_RESULT_CONTEXT_CHARS,
      `进入上下文 ${out.text.length} 字符，超过预算 ${TOOL_RESULT_CONTEXT_CHARS}`,
    );
    // The saving is the whole point; assert it rather than assuming it.
    assert.ok(out.text.length < out.fullChars / 10, `只省到 ${out.text.length}/${out.fullChars}`);
  });

  it('开头和结尾都是工具自己的原文（首尾各留一段，中间才是省略的）', () => {
    const text = buildLog(200_000);
    const out = budgetToolResult(text, 'shell');
    assert.ok(out.text.startsWith(text.slice(0, 100)), '开头不是原文');
    assert.ok(out.text.endsWith(text.slice(-100)), '结尾不是原文');
    // The ending is the news for a log, and it must survive: it is what the call was made for.
    assert.ok(out.text.includes('ALL CHECKS PASSED'), '结尾的结论没保住');
  });

  it('省略了多少、原文多大，报的是真实数字（不是估的）', () => {
    const text = buildLog(123_456);
    const out = budgetToolResult(text, 'shell');
    assert.equal(out.fullChars, text.length);
    assert.match(out.text, new RegExp(`省略了 ${out.elidedChars} 字符`));
    assert.match(out.text, new RegExp(`返回了 ${text.length} 字符`));
    /*
     * The reported arithmetic has to match what was actually kept: everything in the stored text
     * that is not one of the two ends must be the note. If a future change kept more than it says it
     * kept (or less), this is where it shows up rather than in a bill nobody attributes.
     */
    const keptEnds = out.fullChars - out.elidedChars;
    const noteChars = out.text.length - keptEnds;
    assert.ok(noteChars > 40 && noteChars < 400, `说明本身 ${noteChars} 字符，与报出的省略数对不上`);
  });

  it('去路是具体的：同一个工具每次都给同一句，不同工具给不同的句子', () => {
    // Deterministic: the same call must produce the same text, or the stuck-loop signature moves.
    assert.equal(elisionRemedy('shell'), elisionRemedy('shell'));
    assert.match(elisionRemedy('shell_wait'), /shell_wait/);
    assert.match(elisionRemedy('fs_read'), /startLine/);
    assert.match(elisionRemedy('kb_query'), /full=true/);
    assert.notEqual(elisionRemedy('fs_read'), elisionRemedy('grep'));
    // An unknown producer still gets an actionable line rather than a bare "truncated".
    assert.ok(elisionRemedy('some_mcp_tool').length > 10);
  });

  it('说明只出现一次，且带 [tool-result] 标记（和失败注释同一套词）', () => {
    const out = budgetToolResult(buildLog(90_000), 'shell');
    const marks = out.text.match(/\[tool-result\]/g) ?? [];
    assert.equal(marks.length, 1);
    assert.equal((out.text.match(/省略了/g) ?? []).length, 1);
  });

  it('是纯函数：同样的输入给同样的输出（缓存前缀靠这条活着）', () => {
    const text = buildLog(70_000);
    assert.equal(budgetToolResult(text, 'shell').text, budgetToolResult(text, 'shell').text);
    assert.equal(budgetToolResult(text, 'shell').text, budgetToolResult(text, 'shell').text);
  });

  it('更小的预算给同样的形状，而不是被说明吃掉', () => {
    const text = buildLog(50_000);
    const out = budgetToolResult(text, 'shell', 2_000);
    assert.ok(out.text.length <= 2_000, `进入上下文 ${out.text.length} 字符`);
    assert.ok(out.text.startsWith(text.slice(0, 50)), '开头没了');
    assert.ok(out.text.endsWith(text.slice(-50)), '结尾没了');
  });

  it('刚好等于预算的结果不触发（边界不左右为难）', () => {
    const text = 'y'.repeat(TOOL_RESULT_CONTEXT_CHARS);
    const out = budgetToolResult(text, 'shell');
    assert.equal(out.truncated, false);
    assert.equal(out.text, text);
  });
});

describe('恢复出来的旧会话：进请求的也必须是有界的', () => {
  /*
   * 这一组针对的是**先有记录、后有规则**的那一半：`sess_8cd40d35a3cb` 里那条 732,633 字符的
   * `shell_wait` 结果已经写进了盘上的会话记录。只在"推进 history 的那一刻"设预算，这条旧记录
   * 会在之后每一轮请求里继续全额重发 —— 也就是这一轮修的东西，对这条会话一次都没生效。
   */
  const huge = 'x'.repeat(732_633);

  const restored = () => [
    { role: 'user', content: '跑门禁' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'shell_wait' } }],
    },
    { role: 'tool', content: huge, tool_call_id: 'c1' },
  ];

  it('旧记录进请求时被压到预算内', () => {
    const out = fitToolResultsToBudget(restored());
    const toolMsg = out.find((m) => m.role === 'tool')!;
    assert.ok(toolMsg.content.length <= TOOL_RESULT_CONTEXT_CHARS,
      `进请求 ${toolMsg.content.length} 字符`);
  });

  it('旧记录的去路仍然是按工具给的（不是那句笼统的）', () => {
    const out = fitToolResultsToBudget(restored());
    const toolMsg = out.find((m) => m.role === 'tool')!;
    // The tool name has to come from the assistant message that called it, or a restored result
    // silently degrades to the generic advice.
    assert.match(toolMsg.content, /shell_wait/);
  });

  it('【关键】不改动存下来的记录（只是拼请求时的事）', () => {
    const history = restored();
    fitToolResultsToBudget(history);
    assert.equal(history[2].content.length, huge.length, '盘上的记录被就地改了');
  });

  it('【关键】对本版本写进去的记录是空操作，且原样返回同一个数组（缓存前缀靠这条活着）', () => {
    const bounded = budgetToolResult(huge, 'shell').text;
    const history = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'shell' } }] },
      { role: 'tool', content: bounded, tool_call_id: 'c1' },
      { role: 'tool', content: 'stdout:\nPASS\nexit code: 0', tool_call_id: 'c2' },
    ];
    const out = fitToolResultsToBudget(history);
    assert.equal(out, history, '空操作时应该返回原数组而不是一份拷贝');
    assert.equal(out[1].content, bounded);
  });

  it('用户消息与助手消息一律不动（只有工具结果受这条规则管）', () => {
    const history = [
      { role: 'user', content: 'x'.repeat(300_000) },
      { role: 'assistant', content: 'y'.repeat(300_000) },
    ];
    assert.equal(fitToolResultsToBudget(history), history);
  });
});
