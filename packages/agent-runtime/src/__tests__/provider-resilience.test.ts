/**
 * Provider resilience: transient HTTP failures, and a stream that breaks mid-response.
 *
 * Both are tested against a REAL local HTTP server rather than a stubbed `fetch`.
 * That matters here: what is being tested is behaviour around an actual socket —
 * retrying after a 429, honouring `Retry-After`, a connection destroyed part-way
 * through a chunked response. A mock would only assert that the code calls the
 * functions it calls, which is not the question.
 *
 * Zero API cost: the server is local and every response is ours.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIProvider } from '../providers/openai.js';
import type { StreamChunk } from '@she/shared';

/** What the server should do for one request. */
type Behaviour =
  | { kind: 'status'; code: number; body?: string; headers?: Record<string, string> }
  /** An SSE response. `breakAt` destroys the socket instead of writing that index. */
  | { kind: 'sse'; frames: string[]; breakAt?: number; delayMs?: number }
  /** JSON even though the request asked to stream — what some gateways do. */
  | { kind: 'json-ignoring-stream'; content: string }
  /** A 200 with an SSE content-type and no frames at all. */
  | { kind: 'empty-sse' }
  | { kind: 'ok'; content: string };

/**
 * A queue of behaviours, one per request.
 *
 * A queue rather than a callback: it makes a test read as the sequence of responses
 * it is exercising (`429, then success`), with no timing assumptions. Flaky retry
 * tests are usually a sign the harness itself is racy.
 */
const queue: Behaviour[] = [];
let fallback: Behaviour = { kind: 'ok', content: 'default' };
let requestCount = 0;
const seenBodies: string[] = [];

let server: Server;
let base = '';

/** One SSE delta frame in the shape the provider parses. */
function frame(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

before(async () => {
  server = createServer((req, res) => {
    requestCount++;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBodies.push(Buffer.concat(chunks).toString('utf8'));
      const behaviour = queue.shift() ?? fallback;

      if (behaviour.kind === 'status') {
        res.writeHead(behaviour.code, { 'Content-Type': 'application/json', ...(behaviour.headers ?? {}) });
        res.end(behaviour.body ?? JSON.stringify({ error: { message: 'error' } }));
        return;
      }

      if (behaviour.kind === 'sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        /*
         * Flush the headers NOW.
         *
         * Without this, `writeHead` only stages them — they go out with the first
         * `write()`. Destroying the socket before that makes undici report "fetch
         * failed", i.e. a CONNECTION error rather than a truncated stream, which is a
         * different code path and a different (retryable) situation. Flushing first
         * makes `breakAt` produce a genuine mid-stream truncation.
         */
        res.flushHeaders();

        const { frames, breakAt, delayMs } = behaviour;
        frames.forEach((f, i) => {
          setTimeout(() => {
            if (breakAt === i) {
              // Destroying the socket is how a stream realistically fails, versus a
              // clean end that the parser can distinguish.
              res.destroy();
              return;
            }
            if (res.writableEnded || res.destroyed) return;
            res.write(f);
            if (i === frames.length - 1) res.end();
          }, (delayMs ?? 0) * (i + 1));
        });
        return;
      }

      if (behaviour.kind === 'empty-sse') {
        // Content-type says stream, body says nothing. Ends cleanly, so only an
        // explicit "no frames arrived" check can catch it.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end();
        return;
      }

      if (behaviour.kind === 'json-ignoring-stream') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: behaviour.content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: behaviour.content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
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
  seenBodies.length = 0;
  fallback = { kind: 'ok', content: 'default' };
  delete process.env.SHE_REASONING_ECHO;
  delete process.env.SHE_REASONING_EFFORT;
});

function provider(model = 'test-model') {
  return new OpenAIProvider('test-key', base, model, 100, 0);
}

describe('瞬时故障重试', () => {
  it('429 之后重试并成功', async () => {
    queue.push(
      { kind: 'status', code: 429, body: '{"error":"slow down"}' },
      { kind: 'ok', content: 'recovered' },
    );
    const reply = await provider().chat([{ role: 'user', content: 'hi' }]);
    assert.equal(reply.content, 'recovered');
    assert.equal(requestCount, 2, `应当重试一次，实际请求 ${requestCount} 次`);
  });

  it('5xx 也重试（含 529 这种非标准但常见的过载码）', async () => {
    queue.push({ kind: 'status', code: 503 }, { kind: 'status', code: 529 }, { kind: 'ok', content: 'up again' });
    const reply = await provider().chat([{ role: 'user', content: 'hi' }]);
    assert.equal(reply.content, 'up again');
    assert.equal(requestCount, 3);
  });

  it('4xx（非 429）立即失败，不重试', async () => {
    // A bad request stays bad; retrying only delays the error and multiplies the bill.
    queue.push({ kind: 'status', code: 400, body: '{"error":"bad model"}' });
    await assert.rejects(
      () => provider().chat([{ role: 'user', content: 'hi' }]),
      /400/,
    );
    assert.equal(requestCount, 1, `不应重试，实际请求 ${requestCount} 次`);
  });

  it('401 立即失败（密钥错了重试没有意义）', async () => {
    queue.push({ kind: 'status', code: 401 });
    await assert.rejects(() => provider().chat([{ role: 'user', content: 'hi' }]), /401/);
    assert.equal(requestCount, 1);
  });

  it('重试用尽后抛出，并把 provider 的原话带出来', async () => {
    // All three attempts rate-limited.
    queue.push(
      { kind: 'status', code: 429, body: '{"error":"rate limited hard"}' },
      { kind: 'status', code: 429, body: '{"error":"rate limited hard"}' },
      { kind: 'status', code: 429, body: '{"error":"rate limited hard"}' },
    );
    await assert.rejects(
      () => provider().chat([{ role: 'user', content: 'hi' }]),
      (err: Error) => {
        assert.match(err.message, /429/);
        assert.match(err.message, /rate limited/, 'provider 的原始信息应当透出，而不是换成自造的文案');
        return true;
      },
    );
    assert.equal(requestCount, 3, '默认最多尝试 3 次');
  });

  it('尊重 Retry-After 头', async () => {
    // The provider knows its own state better than our guess does.
    queue.push(
      { kind: 'status', code: 429, headers: { 'retry-after': '1' } },
      { kind: 'ok', content: 'ok' },
    );
    const t0 = Date.now();
    await provider().chat([{ role: 'user', content: 'hi' }]);
    assert.ok(Date.now() - t0 >= 900, `等待时间不足，实际 ${Date.now() - t0}ms`);
  });

  it('Retry-After 支持 HTTP 日期格式', async () => {
    // HTTP dates have SECOND granularity, so a sub-second offset can round to the past.
    // Use over a second so truncation still leaves it in the future.
    const at = new Date(Date.now() + 1500).toUTCString();
    queue.push(
      { kind: 'status', code: 429, headers: { 'retry-after': at } },
      { kind: 'ok', content: 'ok' },
    );
    const t0 = Date.now();
    await provider().chat([{ role: 'user', content: 'hi' }]);
    const waited = Date.now() - t0;
    assert.ok(waited >= 200 && waited < 3000, `日期解析可能不对，等了 ${waited}ms`);
  });

  it('SHE_LLM_ATTEMPTS=1 时完全不重试', async () => {
    queue.push({ kind: 'status', code: 429 });
    process.env.SHE_LLM_ATTEMPTS = '1';
    try {
      await assert.rejects(() => provider().chat([{ role: 'user', content: 'hi' }]), /429/);
      assert.equal(requestCount, 1, `设了不重试却请求了 ${requestCount} 次`);
    } finally {
      delete process.env.SHE_LLM_ATTEMPTS;
    }
  });

  it('每次重试都发出完整请求体（不是空请求）', async () => {
    queue.push({ kind: 'status', code: 500 }, { kind: 'ok', content: 'fine' });
    await provider().chat([{ role: 'user', content: 'hello there' }]);
    assert.equal(seenBodies.length, 2);
    for (const raw of seenBodies) {
      const body = JSON.parse(raw);
      assert.equal(body.model, 'test-model');
      assert.equal(body.messages.at(-1).content, 'hello there');
    }
  });
});

describe('流式响应中断', () => {
  it('【关键】中途断流时保留已收到的内容，而不是全部丢弃', async () => {
    /*
     * The user watched those tokens stream in and they had already been billed.
     * Throwing them away loses both the money and the visible answer.
     */
    queue.push({
      kind: 'sse',
      frames: [frame({ content: '第一段。' }), frame({ content: '第二段' }), frame({ content: '不会到' })],
      breakAt: 2,
      delayMs: 20,
    });
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));

    assert.equal(reply.content, '第一段。第二段');
    const streamed = chunks.filter((c) => c.type === 'text').map((c) => String(c.content)).join('');
    assert.equal(streamed, '第一段。第二段', '已推送的文本应当与结果一致');
  });

  it('中断时明确告知用户，而不是静默截断', async () => {
    queue.push({
      kind: 'sse',
      frames: [frame({ content: 'ok then break' }), frame({ content: 'x' })],
      breakAt: 1,
      delayMs: 15,
    });
    const chunks: StreamChunk[] = [];
    await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    const status = chunks.filter((c) => c.type === 'status').map((c) => String(c.content)).join(' ');
    assert.match(status, /中断/, `没有告诉用户中断了，实际: ${status}`);
  });

  it('【关键】残缺的工具调用被丢弃，绝不去执行', async () => {
    /*
     * Tool arguments are JSON assembled from deltas, so a truncated one is malformed.
     * Executing it would act on wrong arguments — writing the wrong file, running the
     * wrong command — which is worse than not running it.
     */
    queue.push({
      kind: 'sse',
      frames: [
        frame({ content: '我要写文件。' }),
        frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fs_write' } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt","content":"截' } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: '断了' } }] }),
      ],
      breakAt: 3,
      delayMs: 15,
    });
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));

    assert.equal(reply.tool_calls, undefined, '残缺的工具调用不应出现在结果里');
    assert.equal(reply.content, '我要写文件。', '正文仍应保留');
    const status = chunks.filter((c) => c.type === 'status').map((c) => String(c.content)).join(' ');
    assert.match(status, /工具调用/, `应当说明丢弃了工具调用，实际: ${status}`);
  });

  it('【关键】头部已发出但一帧都没有就断开，报错并提示可能不支持流式', async () => {
    /*
     * The ambiguous case: the endpoint accepted the streaming request (headers say
     * text/event-stream) and then sent nothing. That is either a broken connection or
     * an endpoint that does not really stream, and the error should say so rather than
     * looking like a dropped connection.
     *
     * Queued three times because the retry layer treats a broken body as worth another
     * attempt; with one entry the test would measure the retry instead.
     */
    const headerOnlyBreak = { kind: 'sse' as const, frames: [frame({ content: 'x' })], breakAt: 0, delayMs: 10 };
    queue.push(headerOnlyBreak, headerOnlyBreak, headerOnlyBreak);
    await assert.rejects(
      () => provider().chat([{ role: 'user', content: 'hi' }], undefined, () => {}),
      (err: Error) => {
        assert.match(err.message, /中断/, `应当是中断类错误，实际: ${err.message}`);
        assert.match(err.message, /流式/, `应当提示流式相关的原因，实际: ${err.message}`);
        return true;
      },
    );
  });

  it('已收到内容后断流：保留内容，不重试（重试会产出第二个答案并双倍计费）', async () => {
    /*
     * The interaction between salvaging and retrying, which is a real design decision:
     *
     *  - break BEFORE any content  → retry (nothing was shown, nothing was lost)
     *  - break AFTER content       → keep it and stop
     *
     * Retrying the second case would show the user two different partial answers to the
     * same turn and bill for both, so salvage wins.
     */
    queue.push(
      { kind: 'sse', frames: [frame({ content: '已经显示给用户的这段话' }), frame({ content: 'x' })], breakAt: 1, delayMs: 10 },
      { kind: 'ok', content: '不该被用到的第二次' },
    );
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));

    assert.equal(reply.content, '已经显示给用户的这段话', '应当保留已收到的内容');
    assert.equal(requestCount, 1, `不该重试，实际请求 ${requestCount} 次`);
    // The second queue entry is still waiting, proving the retry did not happen.
    assert.equal(queue.length, 1, '第二次响应不该被取走');
    const status = chunks.filter((c) => c.type === 'status').map((c) => String(c.content)).join(' ');
    assert.match(status, /中断/, '应当告知用户中断了');
  });

  it('主动中断（abort）不被当成断流补救，仍抛错', async () => {
    // Salvaging an aborted turn would defeat the abort.
    queue.push({ kind: 'sse', frames: [frame({ content: 'a' }), frame({ content: 'b' }), frame({ content: 'c' })], delayMs: 80 });
    const ctl = new AbortController();
    const promise = provider().chat([{ role: 'user', content: 'hi' }], undefined, () => {}, ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    await assert.rejects(() => promise);
  });

  it('完整流不受影响（补救逻辑不误伤正常路径）', async () => {
    queue.push({
      kind: 'sse',
      frames: [frame({ content: '完整' }), frame({ content: '的回复' }), 'data: [DONE]\n\n'],
      delayMs: 5,
    });
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    assert.equal(reply.content, '完整的回复');
    assert.equal(chunks.filter((c) => c.type === 'status').length, 0, '正常完成不该出现中断提示');
  });

  it('推理内容在断流时同样保留', async () => {
    queue.push({
      kind: 'sse',
      frames: [frame({ reasoning_content: '思考中…' }), frame({ content: '答案' }), frame({ content: 'x' })],
      breakAt: 2,
      delayMs: 10,
    });
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, () => {});
    assert.equal(reply.reasoning, '思考中…');
    assert.equal(reply.content, '答案');
  });

  it('断流后 usage 仍然计入（花掉的钱不能漏记）', async () => {
    queue.push({
      kind: 'sse',
      frames: [
        `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
        frame({ content: 'text' }),
        frame({ content: 'x' }),
      ],
      breakAt: 2,
      delayMs: 10,
    });
    const chunks: StreamChunk[] = [];
    await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));
    const usage = chunks.filter((c) => c.type === 'usage');
    assert.equal(usage.length, 1, 'usage 应当被上报');
  });

  it('【关键】端点忽略 stream 参数时，解析 JSON 而不是报"流中断"', async () => {
    /*
     * Some OpenAI-compatible gateways ignore `stream: true` and answer with a single
     * JSON object. Feeding that to the SSE reader produced an EMPTY assistant message
     * silently — the worst outcome, because the turn looked successful with no content.
     */
    queue.push({ kind: 'json-ignoring-stream', content: '被忽略 stream 也应当有回复' });
    const chunks: StreamChunk[] = [];
    const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));

    assert.equal(reply.content, '被忽略 stream 也应当有回复', '不该返回空回复');
    const status = chunks.filter((c) => c.type === 'status').map((c) => String(c.content)).join(' ');
    assert.match(status, /忽略|普通响应/, `应当说明端点忽略了流式请求，实际: ${status}`);
  });

  it('流式回复没有任何帧时报错，并提示可能不支持流式', async () => {
    // A wrong content-type plus no frames is the ambiguous case; the error should point
    // at the likely cause instead of looking like a dropped connection.
    queue.push({ kind: 'empty-sse' });
    await assert.rejects(
      () => provider().chat([{ role: 'user', content: 'hi' }], undefined, () => {}),
      (err: Error) => {
        assert.match(err.message, /中断/);
        assert.match(err.message, /SHE_LLM_STREAM/, `应当给出可操作的设置名，实际: ${err.message}`);
        return true;
      },
    );
  });

  it('SHE_LLM_STREAM=off 时不请求流式，走普通响应', async () => {
    /*
     * The escape hatch for a proxy that buffers or drops streams. Without it the only
     * workaround was to change endpoints — and the error message telling users to set
     * this would have been promising something that did not exist.
     */
    process.env.SHE_LLM_STREAM = 'off';
    try {
      // The stub answers non-streaming requests with JSON regardless, so a successful
      // parse here proves the request went out without `stream: true`.
      queue.push({ kind: 'ok', content: '非流式回复' });
      const chunks: StreamChunk[] = [];
      const reply = await provider().chat([{ role: 'user', content: 'hi' }], undefined, (c) => chunks.push(c));

      assert.equal(reply.content, '非流式回复');
      const sent = JSON.parse(seenBodies.at(-1) ?? '{}');
      assert.equal(sent.stream, false, '请求体里不该要求流式');
      const status = chunks.filter((c) => c.type === 'status').map((c) => String(c.content)).join(' ');
      assert.match(status, /关闭流式/, `应当说明为什么没有流式输出，实际: ${status}`);
    } finally {
      delete process.env.SHE_LLM_STREAM;
    }
  });
});

describe('DeepSeek 思维链协议', () => {
  const toolCall = {
    id: 'c1',
    type: 'function' as const,
    function: { name: 'shell', arguments: '{}' },
  };

  function sentMessages(index = -1): Array<Record<string, unknown>> {
    const raw = index < 0 ? seenBodies.at(-1) : seenBodies[index];
    return JSON.parse(raw ?? '{}').messages;
  }

  it('带工具调用的原生思维链要回传，已完成的回合不回传', async () => {
    queue.push({ kind: 'ok', content: 'ok' });
    await provider('deepseek-reasoner').chat([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'calling', reasoning: 'native-think', tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
      { role: 'assistant', content: 'done', reasoning: 'finished-think' },
    ]);
    const messages = sentMessages();
    const calling = messages.find((m) => m.content === 'calling');
    const done = messages.find((m) => m.content === 'done');
    assert.equal(calling?.reasoning_content, 'native-think');
    assert.equal(done?.reasoning_content, undefined, '已完成回合的思维链不是上下文的一部分');
  });

  it('移植来的思维链不占用 reasoning_content', async () => {
    queue.push({ kind: 'ok', content: 'ok' });
    await provider('deepseek-reasoner').chat([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'imported answer',
        reasoning: 'foreign-think',
        reasoningOrigin: 'imported',
      },
      {
        role: 'assistant',
        content: 'imported call',
        reasoning: 'foreign-tool-think',
        reasoningOrigin: 'imported',
        tool_calls: [toolCall],
      },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
      { role: 'assistant', content: '', reasoning: 'only-chain', reasoningOrigin: 'imported' },
    ]);
    const messages = sentMessages();
    const answer = messages.find((m) => m.content === 'imported answer');
    const call = messages.find((m) => m.content === 'imported call');
    const only = messages.find((m) => m.content === 'only-chain');
    assert.equal(answer?.reasoning_content, undefined);
    assert.equal(call?.reasoning_content, '', '工具轮次要有这个字段，但内容不能是别的产品的思维链');
    assert.notEqual(call?.reasoning_content, 'foreign-tool-think');
    assert.equal(only?.reasoning_content, undefined, '只有思维链的回合改走正文，不走协议字段');
  });

  it('只有思维链、没有正文的助手消息不会被送成空消息', async () => {
    queue.push({ kind: 'ok', content: 'ok' });
    await provider('deepseek-reasoner').chat([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', reasoning: 'native-only', reasoningOrigin: 'native' },
      { role: 'assistant', content: '   ' },
    ]);
    const messages = sentMessages().filter((m) => m.role === 'assistant');
    assert.equal(messages[0]?.content, 'native-only');
    assert.equal(messages[1]?.content, '…');
    for (const m of messages) {
      const hasBody = typeof m.content === 'string' && String(m.content).trim().length > 0;
      const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      assert.ok(hasBody || hasCalls, '助手消息必须有正文或工具调用');
    }
  });

  it('非推理模型不发送 reasoning_content', async () => {
    queue.push({ kind: 'ok', content: 'ok' });
    await provider('test-model').chat([
      { role: 'assistant', content: 'calling', reasoning: 'native-think', tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
      { role: 'user', content: 'hi' },
    ]);
    const messages = sentMessages();
    assert.equal(messages.some((m) => 'reasoning_content' in m), false);
  });

  it('端点要求回传 reasoning_content 时补上空字段再重试', async () => {
    queue.push(
      { kind: 'status', code: 400, body: '{"error":{"message":"The reasoning_content in the thinking mode must be passed back to the API."}}' },
      { kind: 'ok', content: 'continued' },
    );
    const reply = await provider('test-model').chat([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'calling', tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
      { role: 'assistant', content: 'done', reasoning: 'finished-think' },
    ]);
    assert.equal(reply.content, 'continued');
    assert.equal(requestCount, 2);
    const first = sentMessages(0).find((m) => m.tool_calls);
    const second = sentMessages(1);
    assert.equal(first?.reasoning_content, undefined);
    assert.equal(second.find((m) => m.tool_calls)?.reasoning_content, '');
    assert.equal(second.find((m) => m.content === 'done')?.reasoning_content, undefined);
  });

  it('端点不认识 reasoning_content 时去掉再重试', async () => {
    queue.push(
      { kind: 'status', code: 400, body: '{"error":{"message":"Unknown parameter: reasoning_content"}}' },
      { kind: 'ok', content: 'ok' },
    );
    const reply = await provider('deepseek-reasoner').chat([
      { role: 'assistant', content: 'calling', reasoning: 'native-think', tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(reply.content, 'ok');
    assert.equal(sentMessages(0).find((m) => m.tool_calls)?.reasoning_content, 'native-think');
    assert.equal(sentMessages(1).some((m) => 'reasoning_content' in m), false);
    assert.equal(process.env.SHE_REASONING_ECHO, 'off');
  });
});
