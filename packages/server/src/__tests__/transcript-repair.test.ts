/**
 * 修复协议（repairProtocol）不能“顺手”破坏别人的配对。
 *
 * 曾经的失败：一个孤儿 tool 结果被就地折成 user 文本插在 assistant 与它自己的
 * tool_result 之间；下一条（本来合法的）tool 消息再从尾部找 owner 时撞上的就是这个
 * 刚插入的 user，owner.role !== 'assistant' 于是合法结果也被折掉，接着重建阶段
 * 把 assistant 的 tool_calls 整个丢掉，只剩 `[调用 x]` 文本 —— 对话再也接不下去。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptToMessages } from '../transcript.js';

const CALL_A = { id: 'call_A', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } };

/** 只有 assistant 却找不到配对结果的 tool 消息，用来复现“折一条、连带折掉下一条”。 */
const orphanThenPaired = [
  { role: 'user' as const, content: '读一下' },
  { role: 'assistant' as const, content: '好', tool_calls: [CALL_A] },
  { role: 'tool' as const, content: '孤儿结果', tool_call_id: 'call_X' },
  { role: 'tool' as const, content: 'a.ts 的内容', tool_call_id: 'call_A' },
];

const importMessages = (messages: unknown[]) =>
  transcriptToMessages('cursor', JSON.stringify({ schema: 'she.imported-context.v1', messages })).messages;

describe('repairProtocol：孤儿 tool 结果就地折成文本，不影响别的配对', () => {
  it('孤儿在前时，后面的合法结果仍然是 tool，assistant 的 tool_calls 仍在', () => {
    const messages = importMessages(orphanThenPaired);

    const assistant = messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.tool_calls?.map((tc) => tc.id), ['call_A'], '合法调用不能被降级成 [调用 …] 文本');
    assert.equal(String(assistant.content).includes('[调用'), false);

    const paired = messages.filter((m) => m.role === 'tool');
    assert.equal(paired.length, 1, '只该保留真正有配对的那条 tool 结果');
    assert.equal(paired[0].tool_call_id, 'call_A');
    assert.equal(paired[0].content, 'a.ts 的内容');

    // 孤儿本身不能消失：折成 user 文本，且不能插在 assistant 与它的 tool_result 之间。
    const foldedAt = messages.findIndex((m) => String(m.content).includes('孤儿结果'));
    assert.ok(foldedAt > 0, '孤儿结果必须保留成文本');
    const pairedAt = messages.findIndex((m) => m.role === 'tool');
    assert.ok(foldedAt > pairedAt, '折叠出来的文本要落在工具组之后，否则会把配对切开');
  });

  it('唯一的合法配对原样保留', () => {
    const messages = importMessages([
      { role: 'user', content: '读一下' },
      { role: 'assistant', content: '好', tool_calls: [CALL_A] },
      { role: 'tool', content: 'a.ts 的内容', tool_call_id: 'call_A' },
    ]);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool']);
    assert.deepEqual(messages[1].tool_calls?.map((tc) => tc.id), ['call_A']);
    assert.equal(messages[2].content, 'a.ts 的内容');
  });
});
