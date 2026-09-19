/**
 * Plugins, end to end, through a running server.
 *
 *   node scripts/plugins-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `plugins.test.ts` has ~48 cases and they are good ones: install, manifest audit, permission
 * enforcement, path escapes, tool-name collisions. But every one of them calls `PluginManager`
 * DIRECTLY. Nothing verified the chain a user actually depends on:
 *
 *     agent → plugin toolset → plugin module → result → back to the model
 *
 * Each link can be connected while the whole thing does nothing:
 *   - plugins load but their tools are never merged into the agent's toolset, so the model cannot
 *     see them and the feature is inert;
 *   - the tools are offered but the executor does not route them, so every call fails;
 *   - install/discover works but the agent is not rebuilt, so a newly installed plugin only appears
 *     after a restart — the "installed it and nothing happened" complaint.
 *
 * The model endpoint is a LOCAL STUB, so this needs no API key and costs nothing, and the assertions
 * are about what the tool actually DID rather than about what was configured.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const PORT = await pickSafePort(Number(process.env.SHE_PLUGINS_TEST_PORT || 18310), [18311, 18312, 18313]);
const STUB_PORT = await pickSafePort(PORT + 1, [PORT + 2, PORT + 3, PORT + 4]);

if (!existsSync(SERVER_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` is true. Fixed sleeps encode a guess about machine speed. */
async function waitFor(fn, { timeoutMs = 30_000, stepMs = 250, what = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${what}`);
    await sleep(stepMs);
  }
}

const API = `http://127.0.0.1:${PORT}`;

async function api(path, opts = {}) {
  try {
    const r = await fetch(API + path, {
      method: opts.method ?? 'GET',
      ...(opts.body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.body),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  } catch (e) {
    /*
     * A refused connection is a status, not an exception.
     *
     * `fetch` rejects when nothing is listening, which is the normal state while the server boots —
     * and `waitFor` needs to poll on it. Letting it throw turned "not up yet" into a crash.
     */
    return { status: 0, json: null, text: String(e.message ?? e) };
  }
}

/* ─── Stub model ─── */

/**
 * Round 1: ask to call one tool. Round 2 (after a `role: 'tool'` message is present): reply with text.
 *
 * `wanted` is the tool name to request, so the same stub serves both "plugin tool present" and
 * "plugin tool gone" cases.
 */
function createStubModel() {
  let wanted = null;
  let calls = 0;
  const seenTools = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      calls++;
      const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');

      // Record what the agent offered, so "the model can see plugin tools" is assertable.
      const offered = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean);

      if (!hasToolResult && wanted) {
        seenTools.push(offered);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_stub_1',
                type: 'function',
                function: { name: wanted, arguments: '{}' },
              }],
            },
          }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return {
    server,
    setWanted: (n) => { wanted = n; },
    getCalls: () => calls,
    /** Tool names the agent offered on the most recent ask. */
    lastOffered: () => seenTools[seenTools.length - 1] ?? [],
  };
}

/* ─── Boot ─── */

const workspace = mkdtempSync(join(tmpdir(), 'she-plugins-'));
const appDir = join(workspace, 'appdir');
mkdirSync(join(workspace, '.she'), { recursive: true });
mkdirSync(appDir, { recursive: true });

const stub = createStubModel();
await new Promise((r) => stub.server.listen(STUB_PORT, '127.0.0.1', r));

// A workspace with a few files, so ws_overview has something real to summarise.
writeFileSync(join(workspace, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
writeFileSync(join(workspace, 'README.md'), '# demo\n\nsome words\n', 'utf8');

writeFileSync(join(workspace, '.env'), [
  'OPENAI_API_KEY=stub-key-not-used',
  `OPENAI_BASE_URL=http://127.0.0.1:${STUB_PORT}`,
  'OPENAI_MODEL=stub-model',
  `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
  `SHE_APP_DIR=${appDir.replace(/\\/g, '/')}`,
  `SHE_PORT=${PORT}`,
  'SHE_AUTOMATION_MODE=false',
  '',
].join('\n'), 'utf8');

let child = null;
async function boot() {
  child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    // Pinned in the child env as well as the .env: ambient variables beat the file.
    env: {
      ...process.env,
      SHE_ENV_FILE: join(workspace, '.env'),
      SHE_PORT: String(PORT),
      SHE_WORKSPACE: workspace,
      SHE_APP_DIR: appDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await waitFor(async () => (await api('/api/health', { timeoutMs: 1500 })).status === 200,
    { what: '服务启动', timeoutMs: 40_000, stepMs: 300 })
    .catch((e) => { console.error(`${e.message}\n${out.slice(-1200)}`); process.exit(1); });
}

async function shutdown() {
  if (child) {
    const pid = child.pid;
    child = null;
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await waitFor(async () => (await api('/api/health', { timeoutMs: 800 })).status === 0,
      { what: '服务停止', timeoutMs: 15_000, stepMs: 200 }).catch(() => undefined);
  }
}

/** Send one chat turn and collect the SSE events. */
async function chat(message, sessionId) {
  const events = [];
  const r = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, stream: true, session_id: sessionId }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) return { status: r.status, events };
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try { events.push(JSON.parse(payload)); } catch { /* not our frame */ }
      }
    }
  }
  return { status: r.status, events };
}

const toolResults = (events) => events.filter((e) => e.type === 'tool_result');
const errorEvents = (events) => events.filter((e) => e.type === 'error');

console.log('\n插件端到端检查（起真实服务 + 桩模型，不需要 API key）\n');

try {
  await boot();

  // ── 1. Catalog is discoverable ──
  {
    const r = await api('/api/plugins/catalog');
    const names = (r.json?.entries ?? []).map((e) => e.name ?? e.id);
    check('内置插件目录可读', r.status === 200, `status=${r.status}`);
    check(
      `目录里有 3 个官方插件（实际 ${names.length}）`,
      names.length >= 3,
      names.join(', '),
    );
  }

  // ── 2. A clean install has no plugin tools, and the agent has none either ──
  {
    const r = await api('/api/plugins');
    const installed = r.json?.plugins ?? [];
    check('初始没有任何已安装插件', installed.length === 0, JSON.stringify(installed.map((p) => p.name)));

    stub.setWanted('ws_overview');
    const sid = (await api('/api/sessions', { method: 'POST', body: { title: 'plugin e2e' } })).json?.id;
    const before = await chat('看看工作区', sid);
    const offeredBefore = stub.lastOffered();
    check(
      '未安装时智能体的工具表里没有插件工具',
      !offeredBefore.includes('ws_overview'),
      offeredBefore.slice(0, 40).join(', '),
    );
    void before;
  }

  // ── 3. Install through HTTP, then the tool must be BOTH offered and callable ──
  {
    const install = await api('/api/plugins/install', { method: 'POST', body: { name: 'workspace-insight' } });
    check('通过接口安装插件成功', install.status < 300, `status=${install.status} ${install.text.slice(0, 160)}`);

    /*
     * The list shape is `{ dir, manifestPath, manifest, hasModule, toolCount, issues }`.
     *
     * The identifier is `dir` — that is what the API takes back — and the plugin's own name lives
     * under `manifest.name`. Reading `p.name` here, as an earlier version of this check did, matches
     * nothing: a correctly installed plugin looked absent, which is the same false negative the check
     * exists to prevent (in the other direction).
     */
    const listed = await api('/api/plugins');
    const entry = (listed.json?.plugins ?? []).find((p) => p.dir === 'workspace-insight');
    check('列表里能看到已安装的插件', Boolean(entry),
      `已列出: ${JSON.stringify((listed.json?.plugins ?? []).map((p) => p.dir))}`);
    check('插件报告了工具数量', entry?.toolCount === 1, `toolCount=${entry?.toolCount}`);
    check(
      'manifest 审计没有报问题',
      Array.isArray(entry?.issues) && entry.issues.length === 0,
      JSON.stringify(entry?.issues),
    );

    /*
     * The chain that matters. The stub model asks for `ws_overview`; for this to produce a result,
     * the agent must have merged the plugin's tools into its own set, the executor must route the
     * call to the plugin module, and the module must actually walk the workspace.
     */
    const sid = (await api('/api/sessions', { method: 'POST', body: { title: 'plugin call' } })).json?.id;
    const turn = await chat('用 ws_overview 看看这个工作区', sid);

    const offered = stub.lastOffered();
    check(
      '【关键】安装后插件工具出现在智能体的工具表里',
      offered.includes('ws_overview'),
      `offered=${offered.length}: ${offered.slice(0, 40).join(', ')}`,
    );

    const results = toolResults(turn.events);
    const wsResult = results.find((e) => e.toolName === 'ws_overview');
    check(
      '【关键】插件工具被真正调用并返回了结果',
      Boolean(wsResult),
      `events=${turn.events.map((e) => e.type).join(',')} errors=${JSON.stringify(errorEvents(turn.events)).slice(0, 200)}`,
    );
    check(
      '插件工具的输出是真实的工作区统计（不是错误串）',
      Boolean(wsResult)
        && !/^Error:/i.test(String(wsResult.content ?? ''))
        && /a\.ts|README\.md|文件|files/i.test(String(wsResult.content ?? '')),
      String(wsResult?.content ?? '(无结果)').slice(0, 240),
    );
  }

  // ── 4. Uninstall must take effect WITHOUT a restart ──
  {
    const del = await api(`/api/plugins?dir=${encodeURIComponent('workspace-insight')}`, { method: 'DELETE' });
    check('通过接口卸载插件成功', del.status < 300, `status=${del.status} ${del.text.slice(0, 160)}`);

    const sid = (await api('/api/sessions', { method: 'POST', body: { title: 'after uninstall' } })).json?.id;
    const turn = await chat('再来一次', sid);
    const offered = stub.lastOffered();
    check(
      '【关键】卸载后智能体不再拿到该工具（说明 agent 被重建，不用重启）',
      !offered.includes('ws_overview'),
      `仍然提供: ${offered.filter((n) => n.startsWith('ws_')).join(', ') || '(无)'}`,
    );
    check(
      '卸载后调用该工具会失败而不是静默成功',
      !toolResults(turn.events).some((e) => e.toolName === 'ws_overview' && !/^Error/i.test(String(e.content))),
      JSON.stringify(toolResults(turn.events).map((e) => e.toolName)),
    );
  }

  // ── 5. A broken plugin must not take the working ones down ──
  {
    // A manifest with no module: the audit should flag it, and the server must stay healthy.
    const brokenDir = join(appDir, 'plugins', 'broken-one');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'manifest.json'), JSON.stringify({
      name: 'broken-one',
      version: '0.1.0',
      permissions: ['read'],
      tools: [{ name: 'broken_tool', description: 'x', parameters: { type: 'object', properties: {} } }],
    }, null, 2), 'utf8');

    const listed = await api('/api/plugins');
    const entry = (listed.json?.plugins ?? []).find((p) => p.dir === 'broken-one');
    check('缺模块的插件被审计出来（不是静默忽略）',
      Array.isArray(entry?.issues) && entry.issues.length > 0,
      JSON.stringify(entry?.issues ?? entry));
    check('服务仍然健康（坏插件没有拖垮其它插件）',
      (await api('/api/health')).status === 200);
  }
} catch (err) {
  check('检查过程未抛异常', false, err.stack ?? err.message);
} finally {
  await shutdown();
  await new Promise((r) => stub.server.close(() => r()));
  removeTempDir(workspace);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
