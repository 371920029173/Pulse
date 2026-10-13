/**
 * 聊天流的空闲超时：**进程意外死掉之后客户端必须能发现**。
 *
 * 用户报的原话是「chat 又无法发送消息了 …… 实际上发出去了，但前端没有反应」，
 * 而且「只在进程意外结束后出现」：服务端进程一死，那条 SSE 既不报错也不结束，
 * 客户端永远停在"还在跑"——不跟流、不回读历史，窗口就冻住了。
 * 现在服务端每隔几秒发一行心跳（router.ts 的 startHeartbeat），所以"长时间没有一个字节"
 * 就是死连接。这条判据直接打传输层：给一个永不来数据的响应，空闲超时要报错，而且说的是人话。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamSSE } from '../lib/api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('SSE 传输：静默 = 死连接', () => {
  it('空闲超时触发 onError（带一句人话），而不是永远挂着', async () => {
    // 一个永远不结束、也不发任何数据的响应体 —— 正是"进程被杀、连接没断"的样子
    const body = new ReadableStream({ start() { /* 不 push，也不 close */ } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));

    const errors: string[] = [];
    await new Promise<void>((resolve) => {
      streamSSE('/api/chat', {}, {
        onData: () => {},
        onError: (e) => { errors.push(e.message); resolve(); },
        onDone: () => resolve(),
      }, undefined, { idleTimeoutMs: 60 });
    });

    expect(errors.length, '静默的连接没有被判死').toBe(1);
    expect(errors[0], '报错不是给人看的').toContain('无响应');
  });
});
