/**
 * Opening a copied Cursor / Claude Code / Codex transcript as a conversation.
 *
 * The failure this pins down: the import path used to render the record as
 * markdown and parse that markdown as JSON, so roles, tool calls, thinking,
 * and (for Codex) the entire transcript disappeared. A conversation you cannot
 * continue is not a migration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptToMessages } from '../transcript.js';

const roles = (text: string, source: string) =>
  transcriptToMessages(source, text).messages.map((m) => m.role);

describe('Claude Code JSONL', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'system reminder' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先想一下' },
          { type: 'text', text: '你好，我是助手' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' },
          { type: 'text', text: '继续' },
        ],
      },
    }),
  ].join('\n');

  it('保留角色、思维链和成对的工具调用', () => {
    const { messages } = transcriptToMessages('claude-code', jsonl);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
    assert.equal(messages[0].content, '你好');
    assert.equal(messages[1].content, '你好，我是助手');
    assert.equal(messages[1].reasoning, '先想一下');
    assert.equal(messages[1].reasoningOrigin, 'imported');
    assert.equal(messages[1].content.includes('先想一下'), false, '思维链不该混进正文');
    assert.equal(messages[1].tool_calls?.[0].function.name, 'Read');
    assert.equal(messages[2].tool_call_id, 'toolu_1');
    assert.equal(messages[2].content, 'file body');
    assert.equal(messages[3].content, '继续');
    assert.equal(messages.some((m) => m.content.includes('system reminder')), false);
  });
});

describe('Codex JSONL', () => {
  it('用 response_item，不把同一轮的 event_msg 再记一遍', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { id: 's1' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'SHOULD NOT APPEAR' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '解释这段代码' }] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'reasoning', content: [{ text: '看循环' }] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call_1' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.ts' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '目录里有 a.ts' }] },
      }),
    ].join('\n');

    const { messages } = transcriptToMessages('codex', jsonl);
    assert.equal(messages.some((m) => String(m.content).includes('SHOULD NOT APPEAR')), false);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(messages[0].content, '解释这段代码');
    assert.equal(messages[1].reasoning, '看循环');
    assert.equal(messages[1].reasoningOrigin, 'imported');
    assert.equal(messages[1].tool_calls?.[0].function.name, 'shell');
    assert.equal(messages[2].content, 'a.ts');
    assert.equal(messages[3].content, '目录里有 a.ts');
    assert.equal(messages[3].reasoning, undefined, '思维链属于发起调用的那一轮');
  });

  it('没有 response_item 时退回 event_msg', () => {
    const jsonl = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'think' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } }),
    ].join('\n');
    const { messages } = transcriptToMessages('codex', jsonl);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(messages[1].content, 'hello');
    assert.equal(messages[1].reasoning, 'think');
  });

  it('ChatGPT 导出沿着当前分支走，不按时间把废弃分支编进来', () => {
    const text = JSON.stringify({
      current_node: 'c',
      mapping: {
        s: {
          id: 's',
          parent: null,
          message: {
            author: { role: 'system' },
            content: { parts: ['hidden prompt'] },
            metadata: { is_visually_hidden_from_conversation: true },
            create_time: 0,
          },
        },
        a: {
          id: 'a',
          parent: 's',
          message: { author: { role: 'user' }, content: { parts: ['first'] }, create_time: 3 },
        },
        b: {
          id: 'b',
          parent: 'a',
          message: { author: { role: 'assistant' }, content: { parts: ['old branch'] }, create_time: 2 },
        },
        c: {
          id: 'c',
          parent: 'a',
          message: { author: { role: 'assistant' }, content: { parts: ['active'] }, create_time: 1 },
        },
      },
    });
    const { messages } = transcriptToMessages('chatgpt', text);
    assert.deepEqual(messages.map((m) => m.content), ['first', 'active']);
  });
});

describe('Cursor', () => {
  it('按对话头的顺序，而不是 UUID / 时间顺序', () => {
    const text = JSON.stringify({
      fullConversationHeadersOnly: [
        { bubbleId: 'bbb', type: 1 },
        { bubbleId: 'aaa', type: 2 },
      ],
      bubbles: {
        aaa: { bubbleId: 'aaa', type: 2, text: '答案', thinking: '推理', createdAt: '2020-01-01T00:00:00.000Z' },
        bbb: { bubbleId: 'bbb', type: 1, text: '问题', createdAt: '2020-01-02T00:00:00.000Z' },
      },
    });
    const { messages } = transcriptToMessages('cursor', text);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(messages[0].content, '问题');
    assert.equal(messages[1].content, '答案');
    assert.equal(messages[1].reasoning, '推理');
    assert.equal(messages[1].reasoningOrigin, 'imported');
    assert.equal(messages[1].content.includes('推理'), false);
  });

  it('工具气泡配上结果，没有结果的调用收成正文', () => {
    const text = JSON.stringify({
      bubbles: [
        { type: 1, text: '读一下' },
        {
          type: 2,
          text: '好',
          toolFormerData: { name: 'read_file', rawArgs: '{"path":"a"}', result: 'content', toolCallId: 'c1' },
        },
        {
          type: 2,
          text: '',
          toolFormerData: { name: 'shell', rawArgs: '{"cmd":"ls"}', toolCallId: 'c2' },
        },
      ],
    });
    const { messages } = transcriptToMessages('cursor', text);
    assert.equal(messages[1].tool_calls?.[0].id, 'c1');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].content, 'content');
    const dangling = messages.find((m) => m.content.includes('shell'));
    assert.ok(dangling);
    assert.equal(dangling?.tool_calls, undefined, '没有结果的调用不能留在协议里');
  });
});

describe('移植后还能当对话用', () => {
  it('markdown 往返不再把所有人收成一个助手', () => {
    const text = '## 用户\n\n问题一\n\n## 助手\n\n回答一\n\n<thinking>\n想过\n</thinking>\n\n## 用户\n\n问题二';
    const { messages } = transcriptToMessages('cursor', text);
    assert.deepEqual(roles(text, 'cursor'), ['user', 'assistant', 'user']);
    assert.equal(messages[0].content, '问题一');
    assert.equal(messages[1].content, '回答一');
    assert.equal(messages[1].reasoning, '想过');
    assert.equal(messages[2].content, '问题二');
  });

  it('不认识的角色也不会被丢掉', () => {
    const { messages } = transcriptToMessages('raw', JSON.stringify([{ role: 'message', content: '保留下来' }]));
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /保留下来/);
  });

  it('截断时不把工具调用和结果切开', () => {
    const messages = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a', tool_calls: [{ id: 'c', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', content: 'out', tool_call_id: 'c' },
      { role: 'assistant', content: 'done' },
    ];
    const text = JSON.stringify({ schema: 'she.imported-context.v1', messages });
    const { messages: kept, truncated } = transcriptToMessages('cursor', text, 2);
    assert.equal(truncated, 1);
    assert.equal(kept[1].tool_calls?.[0].id, 'c');
    assert.equal(kept[2].role, 'tool');
    assert.equal(kept.some((m) => m.content === 'done'), false);
  });

  it('空输入是空对话', () => {
    const { messages, truncated } = transcriptToMessages('claude-code', '   ');
    assert.deepEqual(messages, []);
    assert.equal(truncated, 0);
  });
});
