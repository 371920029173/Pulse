/**
 * OpenAI 兼容面：把"这个 Agent"当成一个 OpenAI 服务来驱动。
 *
 * 这一节钉的不是"多了一个路由"，而是**这个 Agent 能不能被程序当服务用**：
 *
 *   1. 形状对：任何 OpenAI 客户端（SDK / 别的编辑器 / 一段脚本）能解析的回包与错误体；
 *   2. **它是 agent，不是回声**：客户端不会收到 tool_calls，收到的是一段已经跑完工具的答复
 *      —— 这一条必须由"工具真的执行过"来证明，而不是由回复的措辞来暗示；
 *   3. 无状态协议 ↔ 有状态 agent 的映射是可预测的：客户端重发整段对话（adopt）与只发一条新消息
 *      （append）都要说清走的是哪条，并且用同一个会话；
 *   4. 我们的额外读数（分类账）在 x_she 里，标准客户端忽略它也不影响解析。
 *
 *   node scripts/openai-api-check.mjs
 *
 * 起真 server + 本地桩模型（不发外网、不需要 key）。
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';
import { killTree } from './lib/kill-tree.mjs';
import { hermeticEnv } from './lib/hermetic.mjs';

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
  }
};

/* ── 桩模型：第一轮要一个工具，第二轮给答复（这样"工具真的跑了"是可断言的） ── */
let stubCalls = 0;
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 空体 */ }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    stubCalls++;
    const sawToolResult = messages.some((m) => m.role === 'tool');
    const reply = sawToolResult
      ? { role: 'assistant', content: '看过工作区了：这是一个带工具的答复。' }
      : {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_stub_1', type: 'function', function: { name: 'ws_overview', arguments: '{}' } }],
      };
    const payload = {
      id: 'stub', object: 'chat.completion', model: 'stub',
      choices: [{ index: 0, message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

const PORT = await pickSafePort(5630);
const workspace = mkdtempSync(join(tmpdir(), 'she-openai-'));
mkdirSync(join(workspace, '.she'), { recursive: true });
const child = spawn('node', [join(process.cwd(), 'packages', 'server', 'dist', 'index.js')], {
  cwd: join(process.cwd(), 'packages', 'server'),
  env: hermeticEnv({
    SHE_WORKSPACE: workspace,
    SHE_PORT: PORT,
    SHE_ENV_FILE: join(workspace, '.env'),
    SHE_APP_DIR: join(workspace, 'appdir'),
    SHE_STATE_DIR: workspace,
    // 桩只回 JSON，不实现 SSE；流式与否不影响要断言的东西（那是客户端与我们的约定）。
    SHE_LLM_STREAM: 'off',
    OPENAI_BASE_URL: stubBase,
    OPENAI_API_KEY: 'stub-key',
    OPENAI_MODEL: 'stub',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverOut = '';
child.stdout.on('data', (c) => { serverOut += c; });
child.stderr.on('data', (c) => { serverOut += c; });

async function waitForHealth(timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const api = (path, init = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  signal: AbortSignal.timeout(30_000),
  ...init,
  headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
});

if (!await waitForHealth()) {
  console.log(`FAIL  服务没起来\n${serverOut.slice(-2000)}`);
  killTree(child.pid);
  removeTempDir(workspace);
  process.exit(1);
}

try {
  console.log('\n1. GET /v1/models：客户端启动时问的第一个问题');
  {
    const r = await api('/v1/models');
    const b = await r.json();
    check('可用', r.ok, String(r.status));
    check('形状是 list', b.object === 'list' && Array.isArray(b.data), JSON.stringify(b).slice(0, 200));
    check('至少一个模型，且带 id', Boolean(b.data?.[0]?.id), JSON.stringify(b.data?.[0] ?? null));
  }

  console.log('\n2. 非流式：一个跑完工具的答复');
  let firstSession = '';
  {
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: '看下工作区' }] }),
    });
    const b = await r.json();
    check('可用', r.ok, `${r.status} ${JSON.stringify(b).slice(0, 200)}`);
    check('object=chat.completion', b.object === 'chat.completion', String(b.object));
    check('choices[0].message 是 assistant 消息', b.choices?.[0]?.message?.role === 'assistant',
      JSON.stringify(b.choices?.[0] ?? null).slice(0, 200));
    check('**拿到的是一段跑完工具的答复**（桩只被喂过"要工具"，答复里那句只可能来自第二次请求）',
      String(b.choices?.[0]?.message?.content).includes('带工具'),
      String(b.choices?.[0]?.message?.content));
    check('桩确实被调了两次（工具执行完又发了一次）', stubCalls === 2, `stubCalls=${stubCalls}`);
    check('usage 三个数都在，且 prompt_tokens > 0',
      typeof b.usage?.prompt_tokens === 'number' && b.usage.prompt_tokens > 0
      && typeof b.usage?.completion_tokens === 'number' && typeof b.usage?.total_tokens === 'number',
      JSON.stringify(b.usage ?? null));
    firstSession = String(r.headers.get('x-she-session') ?? '');
    check('回了一个会话 id（头 X-She-Session）', /^sess_api_[0-9a-f]{12}$/.test(firstSession), firstSession);
    check('x_she 里带着我们自己的读数（分类账 + 窗口）',
      typeof b.x_she?.context?.usedTokens === 'number' && typeof b.x_she?.context?.window?.tokens === 'number',
      JSON.stringify(b.x_she?.context?.window ?? null));
    // 历史是空的：一条消息也"比历史长"（1 > 0），所以首轮按规则就是 adopt（等价于什么都没替换）。
    check('首轮是 adopt（历史为空，1 > 0）', b.x_she?.history === 'adopted', String(b.x_she?.history));
  }

  console.log('\n3. 无状态协议 ↔ 有状态 agent：adopt 与 append 都要说清');
  {
    const say = async (messages) => {
      const r = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages }) });
      const b = await r.json();
      return { r, b, history: String(r.headers.get('x-she-history') ?? ''), session: String(r.headers.get('x-she-session') ?? '') };
    };
    const a = await say([
      { role: 'user', content: '看下工作区' },
      { role: 'assistant', content: '看过工作区了：这是一个带工具的答复。' },
      { role: 'user', content: '再看一次' },
    ]);
    check('客户端重发整段对话 → adopt（客户端是权威）', a.history === 'adopted', a.history);
    check('落在同一个会话上（无状态客户端不会每次开一条新会话）', a.session === firstSession,
      `${a.session} vs ${firstSession}`);
    /*
     * 只发一条 + 显式会话头：这是"我有状态，别替我猜"的用法，走的必须是 append。
     */
    const explicit = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Session-Id': firstSession },
      body: JSON.stringify({ messages: [{ role: 'user', content: '只发一条' }] }),
    });
    const eb = await explicit.json();
    check('显式会话头 + 一条消息 → append', String(explicit.headers.get('x-she-history')) === 'appended',
      String(explicit.headers.get('x-she-history')));
    check('用的是指定会话', String(explicit.headers.get('x-she-session')) === firstSession,
      String(explicit.headers.get('x-she-session')));
    check('答复仍来自 agent（不是空回包）', String(eb.choices?.[0]?.message?.content).length > 0,
      JSON.stringify(eb.choices?.[0] ?? null).slice(0, 160));

    /*
     * 只发一条、又不给头：那是一个**新对话**（开场消息不同）—— 不能误接到别人的历史上。
     */
    const c = await say([{ role: 'user', content: '这是另一段对话的开场' }]);
    check('不带头、开场消息不同 → 开一条新会话（不误接历史）', c.session !== firstSession,
      `${c.session} vs ${firstSession}`);
  }

  console.log('\n4. 流式：按 OpenAI 的分片形状，最后是 [DONE]');
  {
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: '流式来一段' }] }),
    });
    check('Content-Type 是 event-stream', String(r.headers.get('content-type')).includes('text/event-stream'),
      String(r.headers.get('content-type')));
    const text = await r.text();
    const events = text.split('\n\n').map((s) => s.trim()).filter(Boolean);
    check('以 data: [DONE] 收尾', events[events.length - 1] === 'data: [DONE]', events[events.length - 1]);
    const chunks = events
      .filter((e) => e.startsWith('data: ') && e !== 'data: [DONE]')
      .map((e) => JSON.parse(e.slice(6)));
    const deltas = chunks.filter((c) => c.object === 'chat.completion.chunk');
    const joined = deltas.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    check('至少一个分片，且 object=chat.completion.chunk', deltas.length > 0, `分片 ${deltas.length}`);
    check('分片拼起来就是完整答复', joined.includes('带工具'), joined.slice(0, 120));
    const last = deltas[deltas.length - 1];
    check('最后一个分片带 finish_reason=stop', last?.choices?.[0]?.finish_reason === 'stop',
      JSON.stringify(last ?? null).slice(0, 200));
    check('默认**不**夹带我们自己的事件（标准客户端不该看到非标准对象）',
      !chunks.some((c) => c.object === 'she.status'), JSON.stringify(chunks.map((c) => c.object)));
  }

  console.log('\n5. 想看我们自己的状态行时：一个头就够');
  {
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-She-Status': '1' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: '带状态行的流' }] }),
    });
    const text = await r.text();
    check('要了就发（object=she.status）', text.includes('"object":"she.status"'), text.slice(0, 200));
  }

  console.log('\n6. 错误体也是 OpenAI 形状');
  {
    const r = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) });
    const b = await r.json();
    check('空 messages → 400', r.status === 400, String(r.status));
    check('错误体有 error.message 与 error.type',
      typeof b.error?.message === 'string' && typeof b.error?.type === 'string',
      JSON.stringify(b).slice(0, 200));
    const bad = await api('/v1/chat/completions', {
      method: 'POST',
      // 必须是 ASCII：HTTP 头带不了非 ASCII（Node 会直接拒），那样测到的就不是我们的校验了。
      headers: { 'X-Session-Id': '../escape' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    check('非法会话 id → 400（不许拿它拼状态路径）', bad.status === 400,
      `${bad.status} ${(await bad.text()).slice(0, 160)}`);
  }
} finally {
  killTree(child.pid);
  await new Promise((r) => stub.close(() => r()));
  removeTempDir(workspace);
}

console.log(`\n${failures === 0 ? 'PASS  openai-api-check' : `FAIL (${failures})  openai-api-check`}`);
process.exit(failures === 0 ? 0 : 1);
