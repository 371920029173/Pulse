/**
 * A reply must never stop silently.
 *
 * Covers the three ways a reply can end early, against a REAL local HTTP server (same approach as
 * provider-resilience.test.ts — the behaviour under test is around an actual socket):
 *
 *   - `finish_reason: length`          → a visible notice with a 继续 action
 *   - a break before any content       → automatic retry with a visible "正在重试（第 n 次）"
 *   - 429 / 5xx / timeout              → retried, each retry announced
 *
 * plus the classification used for the final failure message (模型端错误 / 网络问题 / 本地错误).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIProvider } from '../providers/openai.js';
import {
  classifyLlmFailure,
  failureLabel,
  retryStatusText,
  StreamInterruptedError,
  hasCompleteArguments,
  LENGTH_NOTICE_TEXT,
} from '../providers/stream-failure.js';
import type { StreamChunk } from '@she/shared';

type Behaviour =
  | { kind: 'status'; code: number; body?: string }
  | { kind: 'sse'; frames: string[]; breakAt?: number; delayMs?: number }
  /** Accept the request and say nothing for `ms` — a provider that went quiet. */
  | { kind: 'hang'; ms: number }
  | { kind: 'json'; content: string; finish?: string; toolArgs?: string };

const queue: Behaviour[] = [];
let requestCount = 0;
let server: Server;
let base = '';

function frame(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
}

before(async () => {
  server = createServer((req, res) => {
    requestCount++;
    req.resume();
    req.on('end', () => {
      const b = queue.shift() ?? { kind: 'json', content: 'default' };
      if (b.kind === 'status') {
        res.writeHead(b.code, { 'Content-Type': 'application/json' });
        res.end(b.body ?? '{"error":"x"}');
        return;
      }
      if (b.kind === 'hang') {
        const t = setTimeout(() => { try { res.destroy(); } catch { /* gone */ } }, b.ms);
        res.on('close', () => clearTimeout(t));
        return;
      }
      if (b.kind === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const message: Record<string, unknown> = { role: 'assistant', content: b.content };
        if (b.toolArgs !== undefined) {
          message.tool_calls = [{ id: 'c1', type: 'function', function: { name: 'fs_write', arguments: b.toolArgs } }];
        }
        res.end(JSON.stringify({ choices: [{ message, finish_reason: b.finish ?? 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      const { frames, breakAt, delayMs } = b;
      frames.forEach((f, i) => {
        setTimeout(() => {
          if (breakAt === i) { res.destroy(); return; }
          if (res.writableEnded || res.destroyed) return;
          res.write(f);
          if (i === frames.length - 1) res.end();
        }, (delayMs ?? 5) * (i + 1));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  queue.length = 0;
  requestCount = 0;
  delete process.env.SHE_LLM_ATTEMPTS;
  delete process.env.SHE_LLM_TIMEOUT_MS;
  delete process.env.SHE_LLM_STREAM;
});

const provider = () => new OpenAIProvider('k', base, 'test-model', 0, 0);
const statuses = (chunks: StreamChunk[]) => chunks.filter((c) => c.type === 'status');

describe('finish_reason: length —— 达到输出上限必须告诉用户', () => {
  it('【关键】流式：给出中文提示 + 继续动作，已收到的内容原样保留', async () => {
    queue.push({
      kind: 'sse',
      frames: [frame({ content: '很长的回答写到' }), frame({ content: '这里' }, 'length'), 'data: [DONE]\n\n'],
    });
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.content, '很长的回答写到这里');
    const notice = statuses(chunks).find((c) => c.notice?.kind === 'length');
    assert.ok(notice, `没有长度上限提示，实际: ${JSON.stringify(statuses(chunks))}`);
    assert.match(String(notice!.content), /回答达到单次输出长度上限，已停止/);
    assert.equal(notice!.notice?.action, 'continue');
    assert.equal(requestCount, 1, '长度截断不该自动重试（那会重复计费并产出第二个答案）');
  });

  it('【关键】被截断的工具调用（参数不是完整 JSON）被丢弃，绝不执行', async () => {
    queue.push({
      kind: 'sse',
      frames: [
        frame({ content: '写文件：' }),
        frame({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'fs_write', arguments: '{"path":"a.txt","content":"半' } }] }, 'length'),
        'data: [DONE]\n\n',
      ],
    });
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.tool_calls, undefined);
    const notice = statuses(chunks).find((c) => c.notice?.kind === 'length');
    assert.match(String(notice?.content), /工具调用/);
  });

  it('正常 stop 不出现任何提示', async () => {
    queue.push({ kind: 'sse', frames: [frame({ content: '完整' }, 'stop'), 'data: [DONE]\n\n'] });
    const chunks: StreamChunk[] = [];
    await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(statuses(chunks).length, 0);
  });

  it('非流式同样识别 length', async () => {
    process.env.SHE_LLM_STREAM = 'off';
    queue.push({ kind: 'json', content: '截断的', finish: 'length', toolArgs: '{"path":' });
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.content, '截断的');
    assert.equal(reply.tool_calls, undefined, '参数残缺的工具调用不该保留');
    assert.ok(statuses(chunks).some((c) => c.notice?.kind === 'length'));
  });
});

describe('断流 / 超时 / 429 / 5xx —— 可以安全重试时自动重试，并且看得见', () => {
  it('【关键】还没收到任何内容就断流：自动重试并显示「网络不稳，正在重试（第 1 次）」', async () => {
    queue.push(
      { kind: 'sse', frames: [frame({ content: 'x' })], breakAt: 0 },
      { kind: 'sse', frames: [frame({ content: '重试后的完整回答' }, 'stop'), 'data: [DONE]\n\n'] },
    );
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.content, '重试后的完整回答');
    assert.equal(requestCount, 2);
    const text = statuses(chunks).map((c) => c.content).join(' ');
    assert.match(text, /网络不稳，正在重试（第 1 次）/);
  });

  it('已经显示了内容再断流：不重试，保留内容并提供「继续」', async () => {
    queue.push(
      { kind: 'sse', frames: [frame({ content: '已显示的一半' }), frame({ content: 'x' })], breakAt: 1, delayMs: 10 },
      { kind: 'json', content: '不该用到' },
    );
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.content, '已显示的一半');
    assert.equal(requestCount, 1);
    const notice = statuses(chunks).find((c) => c.notice?.action === 'continue');
    assert.ok(notice, '断流后没有提供继续');
    assert.equal(notice!.notice?.kind, 'network');
    assert.match(String(notice!.content), /网络问题/);
  });

  it('流在没有结束标记时干净关闭（且没有内容）：当作断流重试', async () => {
    queue.push(
      { kind: 'sse', frames: [`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`] },
      { kind: 'sse', frames: [frame({ content: 'ok' }, 'stop')] },
    );
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.content, 'ok');
    assert.equal(requestCount, 2);
  });

  it('429 / 503 重试时逐次显示「模型端…正在重试（第 n 次）」', async () => {
    queue.push({ kind: 'status', code: 429 }, { kind: 'status', code: 503 }, { kind: 'json', content: 'fine' });
    const chunks: StreamChunk[] = [];
    process.env.SHE_LLM_STREAM = 'off';
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.content, 'fine');
    const text = statuses(chunks).map((c) => c.content).join(' | ');
    assert.match(text, /HTTP 429.*第 1 次/);
    assert.match(text, /HTTP 503.*第 2 次/);
  });

  it('【关键】请求超时（provider 不说话）会重试，而不是被当成用户中断直接放弃', async () => {
    process.env.SHE_LLM_TIMEOUT_MS = '150';
    queue.push({ kind: 'hang', ms: 2000 }, { kind: 'sse', frames: [frame({ content: '超时后成功' }, 'stop')] });
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.content, '超时后成功');
    assert.match(statuses(chunks).map((c) => c.content).join(' '), /超时，正在重试（第 1 次）/);
  });

  it('用户主动中断仍然直接抛出，不重试', async () => {
    queue.push({ kind: 'hang', ms: 2000 }, { kind: 'json', content: '不该用到' });
    const ctl = new AbortController();
    const p = provider().chat([{ role: 'user', content: 'hi' }], undefined, () => {}, ctl.signal);
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(() => p);
    assert.equal(requestCount, 1);
  });
});

describe('失败分类（模型端错误 / 网络问题 / 本地错误）', () => {
  it('HTTP 错误状态 → 模型端错误', () => {
    assert.equal(classifyLlmFailure(new Error('OpenAI API error 503: overloaded')), 'provider');
    assert.equal(classifyLlmFailure(new Error('Anthropic API error 401: bad key')), 'provider');
  });
  it('连接类错误 → 网络问题', () => {
    assert.equal(classifyLlmFailure(new Error('fetch failed')), 'network');
    assert.equal(classifyLlmFailure(new StreamInterruptedError('流式响应中断（尚未收到内容）: terminated', true)), 'network');
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    assert.equal(classifyLlmFailure(timeout), 'network');
  });
  it('其余 → 本地错误', () => {
    assert.equal(classifyLlmFailure(new TypeError("Cannot read properties of undefined (reading 'x')")), 'local');
  });
  it('中文标签与重试文案', () => {
    assert.equal(failureLabel('provider'), '模型端错误');
    assert.equal(failureLabel('network'), '网络问题');
    assert.equal(failureLabel('local'), '本地错误');
    assert.equal(retryStatusText(2), '网络不稳，正在重试（第 2 次）…');
    assert.match(retryStatusText(1, { status: 429 }), /限流/);
    assert.match(LENGTH_NOTICE_TEXT, /回答达到单次输出长度上限，已停止/);
  });
  it('工具参数完整性判断', () => {
    assert.equal(hasCompleteArguments('{"a":1}'), true);
    assert.equal(hasCompleteArguments(''), true);
    assert.equal(hasCompleteArguments('{"a":'), false);
  });
});
