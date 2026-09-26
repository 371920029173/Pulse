/**
 * 回复不能被「静默截断」。
 *
 * 真实事故（2026-09-26 21:47，会话 sess_89fd8a1b6521）：一段长回答在界面上停在
 * 「……你手里的东西恰好是」，没有任何提示；而落盘的那条助手消息是完整的（1697 字，后面还有两段）。
 * 服务端和模型都没断 —— 丢的是客户端：最后几个 text 帧和 `done` 帧在同一次 read() 里到达，
 * 旧代码的 setMessages 更新函数「懒读」可变的 acc.text / liveIdx，而 `done` 的 sealBubble 在
 * React 渲染前就把它们清空了，于是尾巴被写进了一个空气泡里。
 *
 * 这里驱动真实的 useChat + Chat，覆盖：同一次 read 里的尾帧 + done、`done.content` 对账、
 * 流在没有 done/error 时关闭、以及「达到输出上限」的提示和「继续」按钮。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { useChat } from '../hooks/useChat';
import { Chat } from '../components/Chat';

function sseStream() {
  const enc = new TextEncoder();
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => { wake?.(); wake = null; };
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
    /** 把若干事件拼成「一次 read() 读到的一块」，就像 TCP 把它们合并成一个包。 */
    burst(events: Array<Record<string, unknown> | '[DONE]'>) {
      const s = events.map((e) => `data: ${e === '[DONE]' ? e : JSON.stringify(e)}\n\n`).join('');
      queue.push(enc.encode(s));
      notify();
    },
    /** 服务器没发 done/error/[DONE] 就把连接关了。 */
    close() { closed = true; notify(); },
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

function installFetch() {
  const streams: ReturnType<typeof sseStream>[] = [];
  const bodies: unknown[] = [];
  vi.mocked(fetch).mockImplementation((async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.startsWith('/api/chat/history')) return jsonResponse({ messages: [] });
    if (url.startsWith('/api/chat/running')) return jsonResponse({ running: false });
    if (url.startsWith('/api/chat')) {
      bodies.push(init?.body ? JSON.parse(init.body) : null);
      const s = sseStream();
      streams.push(s);
      return s.response;
    }
    return jsonResponse({});
  }) as unknown as typeof fetch);
  return { streams, bodies };
}

type Api = { send: (t: string) => void };

function Harness({ api }: { api: { current: Api | null } }) {
  const chat = useChat('sess_integrity');
  api.current = { send: chat.sendMessage };
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

function mount() {
  const { streams, bodies } = installFetch();
  const api: { current: Api | null } = { current: null };
  const view = render(<Harness api={api} />);
  const text = () => view.container.textContent ?? '';
  const send = async (t: string) => { await act(async () => { api.current!.send(t); }); };
  const burst = async (s: ReturnType<typeof sseStream>, events: Array<Record<string, unknown> | '[DONE]'>) => {
    await act(async () => { s.burst(events); await new Promise((r) => setTimeout(r, 0)); });
  };
  const close = async (s: ReturnType<typeof sseStream>) => {
    await act(async () => { s.close(); await new Promise((r) => setTimeout(r, 0)); });
  };
  return { view, streams, bodies, text, send, burst, close };
}

describe('回复不能被静默截断', () => {
  it('最后几个 text 帧和 done 在同一次 read 里到达，尾巴不能丢', async () => {
    const v = mount();
    await v.send('你觉得这个放在所有开源里能到一个什么地位');
    await v.burst(v.streams[0], [{ type: 'text', content: '前半段……你手里的东西恰好是' }]);
    expect(v.text()).toContain('恰好是');

    await v.burst(v.streams[0], [
      { type: 'text', content: '那个赛道需要的。' },
      { type: 'text', content: '\n\n尾巴标记ZZZ' },
      { type: 'done' },
      { type: 'done', content: '前半段……你手里的东西恰好是那个赛道需要的。\n\n尾巴标记ZZZ' },
      '[DONE]',
    ]);
    expect(v.text(), '尾帧和 done 同包到达时，尾巴被丢了').toContain('那个赛道需要的。');
    expect(v.text()).toContain('尾巴标记ZZZ');
  });

  it('本地没收全时，用服务端最终 done.content 把最后一条回复补齐（只追加，不改写）', async () => {
    const v = mount();
    await v.send('一');
    await v.burst(v.streams[0], [{ type: 'text', content: '开头AAA' }]);
    await v.burst(v.streams[0], [
      { type: 'done', content: '开头AAA，中间BBB，结尾CCC' },
      '[DONE]',
    ]);
    expect(v.text()).toContain('结尾CCC');
  });

  it('流在没有 done / error 的情况下关闭：界面给出提示，而不是静默', async () => {
    const v = mount();
    await v.send('一');
    await v.burst(v.streams[0], [{ type: 'text', content: '写到一半' }]);
    await v.close(v.streams[0]);
    expect(v.text()).toContain('写到一半');
    expect(v.text(), '断流没有任何提示').toMatch(/连接中断|回复可能不完整/);
  });

  it('达到单次输出长度上限：显示中文提示和「继续」，点继续会追加一轮续写', async () => {
    const v = mount();
    await v.send('写个长的');
    await v.burst(v.streams[0], [
      { type: 'text', content: '很长的回答写到这里' },
      { type: 'done' },
      { type: 'status', content: '回答达到单次输出长度上限，已停止。点「继续」可以接着往下写。', notice: { kind: 'length', action: 'continue' } },
      { type: 'done', content: '很长的回答写到这里' },
      '[DONE]',
    ]);
    expect(v.text()).toContain('很长的回答写到这里');
    expect(v.text()).toContain('回答达到单次输出长度上限');
    const btn = v.view.getByRole('button', { name: '继续' });
    await act(async () => { fireEvent.click(btn); });
    expect(v.streams.length, '点「继续」没有发出新的一轮').toBe(2);
    const body = v.bodies[1] as { message: string };
    expect(body.message).toMatch(/继续/);
    // 续写是新的一轮，原来那条回复原样留在屏幕上。
    expect(v.text()).toContain('很长的回答写到这里');
  });

  it('旧一轮的「继续」按钮在新一轮开始后不再出现（避免续写错对象）', async () => {
    const v = mount();
    await v.send('一');
    await v.burst(v.streams[0], [
      { type: 'text', content: '被截断的回答' },
      { type: 'status', content: '回答达到单次输出长度上限，已停止。', notice: { kind: 'length', action: 'continue' } },
      { type: 'done', content: '被截断的回答' },
      '[DONE]',
    ]);
    expect(v.view.queryAllByRole('button', { name: '继续' }).length).toBe(1);
    await v.send('换个话题');
    expect(v.view.queryAllByRole('button', { name: '继续' }).length).toBe(0);
  });

  it('服务端 error 帧带上「模型端错误 / 网络问题 / 本地错误」分类', async () => {
    const v = mount();
    await v.send('一');
    await v.burst(v.streams[0], [
      { type: 'error', error: 'OpenAI API error 503: overloaded', kind: 'provider', label: '模型端错误' },
      '[DONE]',
    ]);
    expect(v.text()).toContain('模型端错误：OpenAI API error 503');
  });

  it('重试状态帧会显示「网络不稳，正在重试（第 n 次）」', async () => {
    const v = mount();
    await v.send('一');
    await v.burst(v.streams[0], [
      { type: 'status', content: '网络不稳，正在重试（第 1 次）…', notice: { kind: 'network' } },
      { type: 'text', content: '重试后的回答' },
      { type: 'done' },
      { type: 'done', content: '重试后的回答' },
      '[DONE]',
    ]);
    expect(v.text()).toContain('网络不稳，正在重试（第 1 次）');
    expect(v.text()).toContain('重试后的回答');
  });
});
