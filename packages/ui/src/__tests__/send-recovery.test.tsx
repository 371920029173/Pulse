/**
 * 「有的 chat 发不出消息」的四条判据。
 *
 * 用户报的原话是「重启后有的未完成/被打断的 chat 无法发送消息」。上一轮修的是「拒绝要有回声」，
 * 但**回声不是出口**：那个界面在「本地以为在跑、服务端没在跑」的时候会把每一条消息退回原处，
 * 而屏幕上连停止按钮都不渲染（停止按钮挂在 isLoading 上，而 isLoading 是假的）—— 这条会话就废了，
 * 只有整台服务重启才回来。发送碰上的 409 更直接：报一句错，用户那句话就没了。
 *
 * 四条起点各一条判据：
 *   1. 本地以为在跑、服务端说没在跑（流安静地死了）→ 这条消息必须真的发出去。
 *   2. 服务端说在跑 → 那句话不能丢，接成「追加」，并且要把那一轮显示出来。
 *   3. 流因为网络错误断开 → 死掉的控制器不许挡住自愈（盘上的记录要能重新读回来）。
 *   4. 发送撞上服务端 409 → 那句话改送「追加」，并且出现停止入口（修复前连停止按钮都没有）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useChat } from '../hooks/useChat';
import { Chat } from '../components/Chat';

/** 一个由测试逐帧驱动的 SSE 流，替代网络。`fail()` 模拟连接被掐断（不是用户按的停止）。 */
function sseStream() {
  const enc = new TextEncoder();
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let failure: Error | null = null;
  const notify = () => { wake?.(); wake = null; };
  const push = (s: string) => { queue.push(enc.encode(s)); notify(); };

  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      for (;;) {
        if (queue.length) return { done: false, value: queue.shift()! };
        if (failure) throw failure;
        if (closed) return { done: true };
        await new Promise<void>((r) => { wake = r; });
      }
    },
    cancel() { closed = true; notify(); },
  };

  return {
    frame(type: string, content = '') { push(`data: ${JSON.stringify({ type, content })}\n\n`); },
    end() { push('data: [DONE]\n\n'); closed = true; notify(); },
    fail() { failure = new TypeError('Failed to fetch'); closed = true; notify(); },
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

interface StubOpts {
  /** 服务端对 /api/chat/running 的回答。 */
  running?: () => boolean;
  /** 探测本身失败（网络抖动 / 服务端正忙）：serverTurnRunning 返回 null 的那条路。 */
  runningFails?: boolean;
  /** 盘上的记录（loadHistory / follow 回读会拿到它）。 */
  history?: unknown[];
  /** /api/chat 的回答：正常流，或 409（这一轮已经在跑）。 */
  chat?: () => 'stream' | '409';
}

function installFetch(opts: StubOpts = {}) {
  const streams: ReturnType<typeof sseStream>[] = [];
  const seen = { chat: [] as string[], interject: [] as string[], history: 0 };
  const msgOf = (init?: RequestInit) => {
    try {
      return String((JSON.parse(String(init?.body ?? '{}')) as { message?: unknown }).message ?? '');
    } catch {
      return '';
    }
  };

  vi.mocked(fetch).mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/chat/running')) {
      if (opts.runningFails) throw new Error('probe failed');
      return jsonResponse({ running: opts.running ? opts.running() : false });
    }
    if (url.startsWith('/api/chat/history')) { seen.history++; return jsonResponse({ messages: opts.history ?? [] }); }
    if (url.startsWith('/api/chat/interject')) { seen.interject.push(msgOf(init)); return jsonResponse({ ok: true }); }
    if (url.startsWith('/api/chat/attach')) { const s = sseStream(); streams.push(s); return s.response; }
    if (url.startsWith('/api/chat/stop')) return jsonResponse({ ok: true, stopped: true });
    if (url.startsWith('/api/chat')) {
      if ((opts.chat ? opts.chat() : 'stream') === '409') {
        return {
          ok: false,
          status: 409,
          headers: { get: () => 'application/json' },
          json: async () => ({ error: '这一轮还在进行中。等它结束再发，或用「追加」（/api/chat/interject）把内容接在当前这轮后面。' }),
        };
      }
      seen.chat.push(msgOf(init));
      const s = sseStream();
      streams.push(s);
      return s.response;
    }
    return jsonResponse({});
  }) as unknown as typeof fetch);

  return { streams, seen };
}

interface Api {
  send: (t: string) => void;
  loadHistory: () => Promise<void>;
  interject: (t: string) => Promise<void>;
  isLoading: () => boolean;
}

function Harness({ sessionId, api }: { sessionId: string; api: { current: Api | null } }) {
  const chat = useChat(sessionId);
  api.current = { send: chat.sendMessage, loadHistory: chat.loadHistory, interject: chat.interject, isLoading: () => chat.isLoading };
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

function mount(sessionId: string, opts: StubOpts = {}) {
  const stub = installFetch(opts);
  const api: { current: Api | null } = { current: null };
  const view = render(<Harness sessionId={sessionId} api={api} />);
  /** 让 fetch 的往返与随之而来的 setState 都跑完。 */
  const flush = async (n = 4) => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const text = () => view.container.textContent ?? '';
  const send = async (t: string) => {
    await act(async () => { api.current!.send(t); });
    await flush();
  };
  const fail = async (index: number) => {
    await act(async () => { stub.streams[index].fail(); await new Promise((r) => setTimeout(r, 0)); });
    await flush();
  };
  const stopButton = () => view.container.querySelector('button[aria-label="停止"]');
  return { ...stub, text, send, fail, flush, stopButton, api };
}

describe('本地那一位不能吞掉消息', () => {
  it('本地以为在跑、服务端说没在跑（流安静地死了）→ 必须真的发出去', async () => {
    const v = mount('sess_stale');
    // 第一条的流一直不结束：isLoading 就此永远为真（这条流自己不发任何帧）。
    await v.send('第一条');
    expect(v.seen.chat, '第一条就没有发出去').toEqual(['第一条']);
    expect(v.api.current!.isLoading()).toBe(true);

    // 服务端没在跑（running 是内存态）—— 本地那一位是假的，消息不能被它吞掉。
    await v.send('第二条');

    expect(v.seen.chat, '本地那一位把这条消息吞了').toEqual(['第一条', '第二条']);
    expect(v.text(), '第二条没有出现在记录里').toContain('第二条');
    expect(v.text(), '不该再退回"上一轮还在进行"').not.toContain('上一轮还在进行');
  });
});

describe('服务端说在跑：那句话不丢，并且看得见', () => {
  it('接成「追加」送进去，而不是把话留在框里', async () => {
    const v = mount('sess_busy', { running: () => true });
    await v.send('第一条');
    expect(v.seen.chat).toEqual(['第一条']);

    await v.send('补充一句');

    expect(v.seen.interject, '那句话没有接进这一轮').toEqual(['补充一句']);
    expect(v.text(), '界面上没有说明它去哪了').toContain('已作为「追加」');
    expect(v.seen.chat, '它不该变成新的一轮').toEqual(['第一条']);
    expect(v.api.current!.isLoading(), '那一轮没有被显示出来').toBe(true);
    expect(v.stopButton(), '没有停止入口').toBeTruthy();
  });
});

describe('追加落到空处：改走真发送，不往不存在的轮次里塞', () => {
  it('服务端说没在跑时，那条「追加」必须真的发出去', async () => {
    const v = mount('sess_ghost');
    // 界面以为在跑（这条流一直不结束），服务端其实没在跑 ——「未完成被打断的那条会话」就是它。
    await v.send('第一条');
    expect(v.api.current!.isLoading()).toBe(true);

    await act(async () => { await v.api.current!.interject('这句话不能进空队列'); });
    await v.flush();

    expect(v.seen.interject, '它被塞进了不存在的轮次').toEqual([]);
    expect(v.seen.chat, '它没有被当成新消息发出去').toEqual(['第一条', '这句话不能进空队列']);
    expect(v.text()).toContain('这句话不能进空队列');
  });
});

describe('探测失败也不许把消息卡住', () => {
  it('问不到「在不在跑」时：这句话照发，交给 409 / 错误路径去说话', async () => {
    /*
     * 用户报的「chat 又无法发送消息了」：旧实现里探测失败会 setSendBlocked(true) 直接拒发 ——
     * 字留在框里、只弹一条提示条（而那条提示条自己还把 t(...) 写成了 JSX 文本，屏幕上一行源码）。
     * 探测失败只说明这一次探测失败，不说明服务端在忙。
     */
    const v = mount('sess_probe_fail', { runningFails: true });
    await v.send('第一条');                 // 这条流不结束 → 本地以为在跑
    expect(v.api.current!.isLoading()).toBe(true);

    await v.send('探测失败时的一句话');      // 本地说忙 → 探测 → 失败 → 必须照发

    expect(v.seen.chat, '句子被探测失败吞掉了').toEqual(['第一条', '探测失败时的一句话']);
    expect(v.text()).toContain('探测失败时的一句话');
    expect(v.text(), '出现了拒发的提示条').not.toContain('上一轮还在进行');
  });
});

describe('发送撞上 409：这句话改送，不是丢掉', () => {
  it('409 → 接成「追加」，并且出现停止入口', async () => {
    const v = mount('sess_409', { chat: () => '409', running: () => true });

    await v.send('这句话不能丢');

    expect(v.seen.interject, '409 之后这句话没有被接进去').toEqual(['这句话不能丢']);
    expect(v.text(), '界面上没有说明它去哪了').toContain('已作为「追加」');
    expect(v.stopButton(), '这一轮已经在跑，界面上却没有停止入口').toBeTruthy();
    expect(v.api.current!.isLoading()).toBe(true);
  });
});

describe('追加：立刻看得见，回读不会擦掉，落盘后不重复', () => {
  it('服务端还没落盘时，回读盘上记录也要留住本地那条', async () => {
    /*
     * 用户报的原话：「我追加信息时似乎不会展示，或者似乎根本不会发送 …… 实际上是加载不及时」。
     * 服务端是当场把 \`[用户补充]\` 推进 history 的；慢在前端：乐观画出来的那句会被 follow 每 2 秒
     * 一次的整份替换擦掉。这条判据钉的就是那一刻。
     */
    const history: unknown[] = [];
    const v = mount('sess_pending', { running: () => true, history });

    await act(async () => { await v.api.current!.interject('追加的这句'); });
    await v.flush();
    expect(v.text(), '追加没有立刻显示').toContain('追加的这句');

    // follow 的回读：盘上当然还没有它
    await act(async () => { await v.api.current!.loadHistory(); });
    await v.flush();
    expect(v.text(), '回读把刚追加的那句擦掉了').toContain('追加的这句');

    // 服务端落盘之后：本地那条让位，不能变成两条
    history.push({ role: 'user', content: '[用户补充] 追加的这句' });
    await act(async () => { await v.api.current!.loadHistory(); });
    await v.flush();
    const n = (v.text().match(/追加的这句/g) ?? []).length;
    expect(n, '本地那条与服务端那条叠成了两条').toBe(1);
  });
});
