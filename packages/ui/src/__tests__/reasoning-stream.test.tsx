/**
 * 思维链必须是**边生成边显示**的，不是等生成完再一次性出现。
 *
 * 用户报的现象：第一次对话正常，之后每一次思维链都要等生成结束才显示。服务器侧的流经实测是
 * 干净的（首轮 72 个 reasoning 帧分散在 299ms 内到达，不是末尾一次爆发），所以故障只可能在
 * 客户端这一条链上：
 *
 *   SSE 帧 -> streamSSE -> attachStreamHandlers -> setMessages -> Chat 渲染
 *
 * 这条链原先**一个测试都没有经过**：已有的渲染测试都是直接给 `Chat` 喂 props，所以「实时更新
 * 被丢掉、只有最后一次性出现」这种故障能整个躲过测试。这里驱动真实的 `useChat` + 真实的
 * `Chat`，并且把三种真实起点都覆盖到 —— 空会话首轮、首轮之后、以及先 loadHistory 再发言
 * （也就是「第一次对话之后」的实际情况）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useChat } from '../hooks/useChat';
import { Chat } from '../components/Chat';
import type { ChatMessage } from '../hooks/useChat';

/** 一个由测试逐帧驱动的 SSE 流，替代网络。 */
function sseStream() {
  const enc = new TextEncoder();
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => { wake?.(); wake = null; };
  const push = (s: string) => { queue.push(enc.encode(s)); notify(); };

  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      for (;;) {
        if (queue.length) return { done: false, value: queue.shift()! };
        if (closed) return { done: true };
        await new Promise<void>((r) => { wake = r; });
      }
    },
    cancel() { closed = true; notify(); },
  };

  return {
    /** 任意一个事件对象，序列化成服务端写出的 `data:` 帧。 */
    event(obj: Record<string, unknown>) { push(`data: ${JSON.stringify(obj)}\n\n`); },
    /** 一帧 `data:`，与服务端写出的格式一致。 */
    frame(type: string, content = '') { push(`data: ${JSON.stringify({ type, content })}\n\n`); },
    end() { push('data: [DONE]\n\n'); closed = true; notify(); },
    response: {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => reader },
    },
  };
}

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
    clone() { return this; },
  };
}

/**
 * 装上 fetch 桩，并把每次 `/api/chat` 的实时流交给测试。
 *
 * `history` 是「盘上已有什么」，也就是 loadHistory 会读到的内容 —— 一轮进行中的回复还没落盘，
 * 所以它里面不会有那个正在生成的助手消息。这正是下面第三个用例要覆盖的形状。
 */
function installFetch(opts: { history?: unknown[] } = {}) {
  const streams: ReturnType<typeof sseStream>[] = [];
  vi.mocked(fetch).mockImplementation((async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('/api/chat/history')) return jsonResponse({ messages: opts.history ?? [] });
    if (url.startsWith('/api/chat/running')) return jsonResponse({ running: false });
    if (url.startsWith('/api/chat')) {
      const s = sseStream();
      streams.push(s);
      return s.response;
    }
    return jsonResponse({});
  }) as unknown as typeof fetch);
  return streams;
}

/** 推一帧进去并把 React 的更新跑完。 */
async function frame(s: ReturnType<typeof sseStream>, type: string, content = '') {
  await act(async () => {
    s.frame(type, content);
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 推一个完整事件对象进去（工具调用这类带结构的帧用这个）。 */
async function event(s: ReturnType<typeof sseStream>, obj: Record<string, unknown>) {
  await act(async () => {
    s.event(obj);
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * 收流。
 *
 * `[DONE]` 是传输层的结束信号，`onDone` 会把 `isLoading` 放下来 —— 下一轮才发得出去。
 * 只发一个 `done` 帧（那是「这次 LLM 调用结束」）是不够的，这里踩过一次。
 */
async function endStream(s: ReturnType<typeof sseStream>) {
  await act(async () => {
    s.end();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 一次像样的工具调用帧 —— 服务端总会带上 toolCall，缺了它 UI 会读出 undefined。 */
const TOOL_CALL = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'shell', arguments: '{"command":"echo hi"}' },
};

type Api = { send: (t: string) => void; loadHistory: () => Promise<void> };

/** 真实的 hook + 真实的 Chat，接线方式与 App 一致。 */
function Harness({ sessionId, api }: { sessionId: string; api: { current: Api | null } }) {
  const chat = useChat(sessionId);
  api.current = { send: chat.sendMessage, loadHistory: chat.loadHistory };
  return (
    <Chat
      messages={chat.messages}
      isLoading={chat.isLoading}
      pendingConfirm={null}
      pendingPatch={null}
      onSend={chat.sendMessage}
      onStop={chat.stopStreaming}
      onConfirm={vi.fn()}
      onDismissConfirm={vi.fn()}
      onApplyPatch={vi.fn()}
      onRejectPatch={vi.fn()}
    />
  );
}

function mount(sessionId: string, history?: unknown[]) {
  const streams = installFetch(history ? { history } : {});
  const api: { current: Api | null } = { current: null };
  const view = render(<Harness sessionId={sessionId} api={api} />);
  const text = () => view.container.textContent ?? '';
  const send = async (t: string) => { await act(async () => { api.current!.send(t); }); };
  const loadHistory = async () => { await act(async () => { await api.current!.loadHistory(); }); };
  return { streams, text, send, loadHistory };
}

describe('思维链边生成边显示', () => {
  it('首轮：流还没结束，思维链已经在页面上', async () => {
    const v = mount('sess_first');
    await v.send('一');
    expect(v.streams.length, '没有发出请求').toBe(1);

    await frame(v.streams[0], 'reasoning', '第一段思考标记AAA');
    expect(v.text()).toContain('第一段思考标记AAA');
    // 还没有 done、也没有正文 —— 这一段必须已经在屏幕上。
    expect(v.text()).not.toContain('第一轮回答');
  });

  it('第二轮：同一会话里第二轮的思维链同样实时', async () => {
    const v = mount('sess_second');

    await v.send('一');
    await frame(v.streams[0], 'reasoning', '第一轮的思考');
    await frame(v.streams[0], 'text', '第一轮回答');
    await frame(v.streams[0], 'done');
    await endStream(v.streams[0]);
    expect(v.text()).toContain('第一轮回答');

    await v.send('二');
    expect(v.streams.length, '第二轮没有发出请求').toBe(2);
    await frame(v.streams[1], 'reasoning', '第二轮的思考标记BBB');

    expect(v.text(), '第二轮的思维链没有实时出现').toContain('第二轮的思考标记BBB');
  });

  it('先载入历史再发言（「第一次对话之后」的真实起点）也要实时', async () => {
    const v = mount('sess_third', [
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前的回答', reasoning: '之前那一轮的思维链' },
    ]);
    await v.loadHistory();
    expect(v.text(), '历史没有被载入').toContain('之前那一轮的思维链');

    await v.send('新的问题');
    await frame(v.streams[0], 'reasoning', '新一轮的思考标记CCC');
    expect(v.text(), '有历史时新一轮的思维链没有实时出现').toContain('新一轮的思考标记CCC');
  });

  it('多轮工具循环里，每一轮的思维链都各自实时出现', async () => {
    const v = mount('sess_tools');
    await v.send('一');

    // 第 1 轮：思考 -> 调用工具（toolCall 必须带上，否则 UI 会读出 undefined）
    await frame(v.streams[0], 'reasoning', '第一轮思考DDD');
    expect(v.text()).toContain('第一轮思考DDD');
    await event(v.streams[0], { type: 'tool_call_start', toolCall: TOOL_CALL });
    await frame(v.streams[0], 'tool_result', '工具结果');
    await frame(v.streams[0], 'done');

    // 第 2 轮：新的思考必须也实时出现，而不是攒到结束
    await frame(v.streams[0], 'reasoning', '第二轮思考EEE');
    expect(v.text(), '工具循环中的第二轮思维链没有实时出现').toContain('第二轮思考EEE');
  });

  it('生成过程中载入历史，不能打断正在流式的思维链', async () => {
    /*
     * 这条路径是真实会发生的：首条消息会创建会话，App 随即在 activeSessionId 变化的副作用里
     * 调 loadHistory（还顺带 armFollow）。而 loadHistory 是**整体替换** messages 的，盘上那一份
     * 里没有正在生成的那个助手消息。如果实时写入依赖的是「messages 里第几项」这样的位置，替换之
     * 后写入就会落空 —— 表现正是「整条思维链要等生成完才出现」。
     */
    const v = mount('sess_adopt', []);
    await v.send('一');
    await frame(v.streams[0], 'reasoning', '前半段标记AAA');
    expect(v.text()).toContain('前半段标记AAA');

    await v.loadHistory();

    await frame(v.streams[0], 'reasoning', '后半段标记BBB');
    expect(v.text(), '载入历史把正在流式的思维链打断了').toContain('后半段标记BBB');
  });
});
