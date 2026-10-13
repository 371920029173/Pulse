/**
 * SSE 心跳：静默期也要往流里写字节，客户端才能发现"服务端进程已经死了"。
 *
 * 背景（2026-10-13 实测）：聊天流是静默的（一次工具调用几分钟不发一帧），所以客户端把空闲超时
 * 关掉了；于是进程意外死掉时那条连接既不报错也不结束，窗口永远停在"还在跑"，用户看到
 * 「消息发出去了，但前端没有任何反应」。心跳是让"静默"重新变得可以判读的那一半。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startSSE } from '../router.js';

type Res = Parameters<typeof startSSE>[0];

function fakeRes() {
  const writes: string[] = [];
  const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
  res.socket = { setNoDelay() {}, destroyed: false };
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = () => res;
  res.flushHeaders = () => {};
  res.write = (s: string) => { writes.push(s); return true; };
  return { res: res as unknown as Res, emitter: res, writes };
}

test('静默期每几十毫秒写一行注释帧；连接关了就不再写', async () => {
  process.env.SHE_SSE_HEARTBEAT_MS = '20';
  try {
    const { res, emitter, writes } = fakeRes();
    startSSE(res);
    await new Promise((r) => setTimeout(r, 70));
    assert.ok(writes.includes(': ping\n\n'), '静默期没有心跳');

    const n = writes.length;
    emitter.emit('close');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(writes.length, n, '连接已经关了还在写心跳');
  } finally {
    delete process.env.SHE_SSE_HEARTBEAT_MS;
  }
});

test('SHE_SSE_HEARTBEAT_MS=0 表示不发心跳', async () => {
  process.env.SHE_SSE_HEARTBEAT_MS = '0';
  try {
    const { res, writes } = fakeRes();
    startSSE(res);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(writes, [], '关掉了还在写');
  } finally {
    delete process.env.SHE_SSE_HEARTBEAT_MS;
  }
});
