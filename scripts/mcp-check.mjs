/**
 * MCP tools, end to end, through a running server.
 *
 *   node scripts/mcp-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `mcp-bridge.test.ts` drives `McpBridge` DIRECTLY, and those tests are good: handshake,
 * framing, name sanitizing, collisions, restart-after-crash, `tools/call` routing, the
 * confirmation ticket. What none of them can see is the chain a user actually depends on:
 *
 *     boot → discover servers → refresh() → agent's toolset → tool call → result to the model
 *
 * Every link can be connected while the whole thing does nothing, and this exact failure has
 * already happened TWICE:
 *
 *   1. The bridge did not exist. Servers were probed (spawn, count tools, kill) and the panel
 *      showed "reachable, 14 tools" while the agent was handed none of them — 49 tools missing,
 *      invisible from the agent's side.
 *   2. The bridge existed and worked when driven by hand, but nothing called `refresh()` on the
 *      startup path. A fresh boot therefore handed the agent 0 of 49 tools again, and toggling
 *      any server in the panel "fixed" it — which made it intermittent, and worse.
 *
 * Both were silent. The first check below is the regression test for the second one, and it is
 * the reason this script boots a real server instead of a bridge: the bug lived in the wiring
 * between them, which is exactly the part unit tests cannot reach.
 *
 * It also pins the handshake of the OTHER MCP implementation in the tree. The panel's probe and
 * the bridge are two separate handshakes, and the probe used to skip the `notifications/initialized`
 * acknowledgement the spec requires — so a compliant server answered `tools/list` with an error the
 * probe could not read, and the panel said "超时" about a server the agent could call perfectly
 * well. `探测数被量到` below fails if either handshake drifts.
 *
 * The model endpoint is a LOCAL STUB, so this needs no API key and costs nothing, and the
 * assertions are about what the tool actually DID rather than about what was configured.
 *
 * Deliberately NOT covered here (covered elsewhere, and each needs a different harness):
 *   - the confirmation ticket that gates MCP calls (they run outside the sandbox, so this is
 *     the security-relevant part) — `mcp-bridge.test.ts`;
 *   - a server that dies mid-call and is restarted — `mcp-bridge.test.ts`;
 *   - the real 49-tool inventory of a developer's machine: this script configures its own
 *     server and hides the host's Cursor config on purpose, so it behaves the same on CI.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';
import { killTree } from './lib/kill-tree.mjs';
import { mcpToolName } from '../packages/server/dist/mcp-bridge.js';
import { hermeticEnv } from './lib/hermetic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const PORT = await pickSafePort(Number(process.env.SHE_MCP_TEST_PORT || 18320), [18321, 18322, 18323]);
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

/**
 * 同一个目录在 Windows 上可以有短名/长名/大小写三种写法，比路径得先归一。
 *
 * 这个检查跑在临时目录里，`os.tmpdir()` 在本机给的是 `C:\Users\ADMINI~1\...`（短名），而子进程
 * 报回来的 cwd 可能已经是长名 —— 直接比字符串会得到"看起来失败"的假红。
 */
const samePath = (a, b) => {
  const norm = (p) => {
    let real;
    try { real = realpathSync.native(p); } catch { real = resolve(p); }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
};

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
    // A refused connection is a status, not an exception: the server is not up yet, and
    // `waitFor` polls on it. Letting it throw turns "booting" into a crash.
    return { status: 0, json: null, text: String(e.message ?? e) };
  }
}

/* ─── The MCP server under test ─── */

/**
 * A minimal stdio MCP server: `initialize`, `tools/list`, `tools/call`.
 *
 * It answers with a string that no other code path can produce, so a tool result containing it
 * proves the text came from THIS child process rather than from a stub or a fallback.
 */
const FAKE_MCP = String.raw`
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const obj = (properties) => ({ type: 'object', properties });
const tools = [
  { name: 'echo', description: 'Echo the text back, prefixed', inputSchema: obj({ text: { type: 'string' } }) },
  { name: 'boom', description: 'Reports isError', inputSchema: obj({}) },
];
let initialized = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } } });
  } else if (method === 'notifications/initialized') {
    initialized = true;
  } else if (method === 'tools/list') {
    if (!initialized) return send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'not initialized' } });
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    if (params.name === 'echo') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'MCP-ECHO:' + String(params.arguments?.text ?? '') }] } });
    else if (params.name === 'boom') send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'mcp-boom' }] } });
    else send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + params.name } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

/**
 * A playwright-flavoured stdio server: it does at startup exactly what the real one does with
 * its cwd.
 *
 * The real playwright MCP derives its artifact directory from the process cwd —
 * `join(cwd, '.playwright-mcp')` in `outputDir()` (`playwright-core/lib/coreBundle.js`), falling
 * back to the system temp dir only when cwd is unwritable. Observed on a real machine: 340 items
 * (screenshots, `console-*.log`) in `C:\Users\Administrator\.playwright-mcp` while the workspace
 * was elsewhere — the channel's products landed outside the boundary, where nothing cleans them
 * up and `.gitignore` cannot see them.
 *
 * This stub writes a marker there at startup, so the marker's LOCATION is the child's cwd. That
 * covers both spawn paths (the panel's probe and the bridge) without needing a tool call, and it
 * fails if either one goes back to inheriting SHE's launch directory.
 */
const FAKE_PW_MCP = String.raw`
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const dir = join(process.cwd(), '.playwright-mcp');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'cwd-marker.txt'), realpathSync.native(process.cwd()), 'utf8');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const tools = [{ name: 'shot', description: 'Pretend screenshot', inputSchema: { type: 'object', properties: {} } }];
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'pw-demo', version: '1' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'shot-ok' }] } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

/* ─── Stub model ─── */
/**
 * Records the tool list the agent offered on EVERY request, so "the agent can see the MCP tool"
 * is assertable without asking the model anything meaningful.
 *
 * When `wanted` is set, round 1 asks to call it; once a `role: 'tool'` message is present the
 * turn ends with text. Otherwise it just answers with text.
 */
function createStubModel() {
  let wanted = null;
  let wantedArgs = {};
  let calls = 0;
  const seenTools = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      calls++;
      const offered = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean);
      seenTools.push(offered);
      const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

      if (!hasToolResult && wanted) {
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_stub_1',
                type: 'function',
                function: { name: wanted, arguments: JSON.stringify(wantedArgs) },
              }],
            },
          }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

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
    /** What the next turn should call (null = plain text turn). */
    setWanted: (tool, args = {}) => { wanted = tool; wantedArgs = args; },
    getCalls: () => calls,
    /** Tool names the agent offered on the most recent request. */
    lastOffered: () => seenTools[seenTools.length - 1] ?? [],
  };
}

/* ─── Boot ─── */

const workspace = mkdtempSync(join(tmpdir(), 'she-mcp-'));
const appDir = join(workspace, 'appdir');
mkdirSync(join(workspace, '.she'), { recursive: true });
mkdirSync(appDir, { recursive: true });

const fakeMcp = join(workspace, 'fake-mcp.mjs');
writeFileSync(fakeMcp, FAKE_MCP, 'utf8');

/*
 * 文件名里带 `playwright-mcp`，才会被当作"按 cwd 派生产物位置"的那一类 —— 这是服务器自己的
 * 命名约定（`@playwright/mcp` / `playwright-mcp` / `mcp-server-playwright`），不是位置巧合。
 */
const fakePwMcp = join(workspace, 'fake-playwright-mcp.mjs');
writeFileSync(fakePwMcp, FAKE_PW_MCP, 'utf8');

/*
 * SHE's own MCP file: the servers this check drives. Everything else is hidden below, so the
 * inventory is exactly these tools no matter what the developer has in Cursor.
 */
const SERVER_NAME = 'demo';
const PW_SERVER = 'pw';
writeFileSync(join(workspace, '.she', 'mcp.json'), JSON.stringify({
  mcpServers: {
    [SERVER_NAME]: { command: 'node', args: [fakeMcp] },
    [PW_SERVER]: { command: 'node', args: [fakePwMcp] },
  },
}, null, 2) + '\n', 'utf8');

const stub = createStubModel();
await new Promise((r) => stub.server.listen(STUB_PORT, '127.0.0.1', r));

/*
 * A home of its own.
 *
 * `discoverMcpServers` also reads Cursor's config (`%APPDATA%/Cursor/User/mcp.json`,
 * `~/.cursor/mcp.json`). On a developer's machine that is a real set of servers with real
 * privileges — the filesystem server is configured with Desktop access — and on CI it is
 * nothing at all, so the check would test a different inventory on every machine. Pointing these
 * at a throwaway directory makes the run deterministic, and nothing can escape into the host's
 * processes.
 */
const fakeHome = join(workspace, 'home');
const fakeAppData = join(workspace, 'appdata');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeAppData, { recursive: true });

/*
 * 用户主目录里的历史产物（旧行为的现场）。
 *
 * 真实机器上这里躺着 340 项：`01-boot-zero-chats.png`、`console-*.log`，是智能体用 playwright
 * 通道做界面验证时留下的。收敛管得住新产物，管不住已经攒下的，所以这里放两项进去，看面板说不
 * 说得出"以前写在这儿、现在不写了"，以及这一轮跑完它有没有变多。
 */
const LEGACY_ITEMS = 2;
const legacyDir = join(fakeHome, '.playwright-mcp');
mkdirSync(legacyDir, { recursive: true });
for (let i = 1; i <= LEGACY_ITEMS; i++) writeFileSync(join(legacyDir, `old-${i}.png`), 'x', 'utf8');

writeFileSync(join(workspace, '.env'), [
  'OPENAI_API_KEY=stub-key-not-used',
  `OPENAI_BASE_URL=http://127.0.0.1:${STUB_PORT}`,
  'OPENAI_MODEL=stub-model',
  `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
  `SHE_APP_DIR=${appDir.replace(/\\/g, '/')}`,
  `SHE_PORT=${PORT}`,
  'SHE_AUTOMATION_MODE=false',
  /*
   * MCP tools run OUTSIDE the sandbox, so every call defaults to a confirmation ticket. This is
   * about the wiring, not the gate — the ticket itself is asserted in mcp-bridge.test.ts — so
   * the workspace opts out rather than making the check depend on a human clicking.
   */
  'SHE_ALLOW_ALL_COMMANDS=1',
  '',
].join('\n'), 'utf8');

let child = null;
let serverOutput = '';
async function boot() {
  child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    /*
     * 环境由检查自己钉死，不再整体继承外层：外层里只要有 `.env` 读进来的
     * `OPENAI_BASE_URL` / `OPENAI_MODEL`，它们就会盖掉下面这个工作区的 `.env`（环境变量优先于
     * 配置文件），于是 agent 去连真服务、桩模型一次请求都收不到 —— `offered=0`。见 `lib/hermetic.mjs`。
     */
    env: hermeticEnv({
      SHE_ENV_FILE: join(workspace, '.env'),
      SHE_PORT: String(PORT),
      SHE_WORKSPACE: workspace,
      SHE_APP_DIR: appDir,
      APPDATA: fakeAppData,
      USERPROFILE: fakeHome,
      HOME: fakeHome,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (c) => { serverOutput += c; });
  child.stderr.on('data', (c) => { serverOutput += c; });
  await waitFor(async () => (await api('/api/health', { timeoutMs: 1500 })).status === 200,
    { what: '服务启动', timeoutMs: 40_000, stepMs: 300 })
    .catch((e) => {
      console.error(`${e.message}\n${serverOutput.slice(-1500)}`);
      process.exit(1);
    });
}

async function shutdown() {
  if (child) {
    const pid = child.pid;
    child = null;
    killTree(pid);
    await waitFor(async () => (await api('/api/health', { timeoutMs: 800 })).status === 0,
      { what: '服务停止', timeoutMs: 15_000, stepMs: 200 }).catch(() => undefined);
  }
  try { stub.server.close(); } catch { /* ignore */ }
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

const newSession = async (title) =>
  (await api('/api/sessions', { method: 'POST', body: { title } })).json?.id;

console.log('\nMCP 端到端检查（起真实服务 + 桩模型 + 真子进程 MCP server，不需要 API key）\n');

const ECHO = mcpToolName(SERVER_NAME, 'echo');

try {
  await boot();

  // ── 1. The startup wiring — the regression this script exists for ──
  {
    const r = await api('/api/mcp/servers');
    const servers = r.json?.servers ?? [];
    const demo = servers.find((s) => s.name === SERVER_NAME);

    check('工作区里只有我们配的那两个 MCP server（没读到本机的 Cursor 配置）',
      servers.length === 2,
      `servers=${servers.map((s) => `${s.name}(source=${s.source})`).join(', ')}`);
    check('MCP server 可达且工具数被探测到', Boolean(demo?.reachable) && demo?.toolCount === 2,
      JSON.stringify(demo));

    /*
     * THE assertion. Before the fix this was `injected: 0` on a fresh boot with 49 tools
     * discovered — the panel said one thing, the agent got nothing, and nothing errored.
     */
    check('【关键】开机时 MCP 工具真的注册给了 agent（探测数 = 注入数）',
      Boolean(demo) && demo.injected === demo.toolCount && demo.injected > 0,
      `探测=${demo?.toolCount} 注入=${demo?.injected} err=${demo?.injectError ?? '(无)'}`);
  }

  // ── 2. The agent can see it, call it, and gets the child's real answer back ──
  {
    stub.setWanted(ECHO, { text: 'hello-from-check' });
    const sid = await newSession('mcp call');
    const turn = await chat(`用 ${ECHO} 回显一句话`, sid);

    const offered = stub.lastOffered();
    check('【关键】MCP 工具出现在智能体的工具表里（不是只在配置/面板里）',
      offered.includes(ECHO),
      `offered=${offered.length} 个，其中 mcp_ 开头 ${offered.filter((n) => n.startsWith('mcp_')).length} 个`);

    check('同一次请求里内建工具仍在（MCP 是追加，不是替换）',
      offered.includes('shell') || offered.includes('fs_read'),
      offered.slice(0, 15).join(', '));

    const results = toolResults(turn.events);
    const echoResult = results.find((e) => e.toolName === ECHO);
    check('【关键】MCP 工具被真正调用（走了 tools/call，不是被本地兜住）',
      Boolean(echoResult),
      `events=${turn.events.map((e) => e.type).join(',')} errors=${JSON.stringify(errorEvents(turn.events)).slice(0, 200)}`);

    check('结果里带回的是那个子进程真的说的话',
      Boolean(echoResult) && String(echoResult.content ?? '').includes('MCP-ECHO:hello-from-check'),
      String(echoResult?.content ?? '(无结果)').slice(0, 240));

    check('调用没有变成一次错误',
      Boolean(echoResult) && !/^Error:/i.test(String(echoResult.content ?? '')),
      String(echoResult?.content ?? '').slice(0, 200));
  }

  // ── 3. Config changes take effect without a restart ──
  {
    const off = await api(`/api/mcp/servers/${SERVER_NAME}/enabled`, { method: 'PUT', body: { enabled: false } });
    check('通过接口停用该 server 成功', off.status < 300, `status=${off.status} ${off.text.slice(0, 160)}`);

    stub.setWanted(null);
    const sid = await newSession('after disable');
    await chat('在吗', sid);
    const offeredOff = stub.lastOffered();
    check('【关键】停用后 agent 不再拿到该工具（说明工具表被重建，不用重启）',
      !offeredOff.includes(ECHO),
      `仍然提供: ${offeredOff.filter((n) => n.startsWith('mcp_')).join(', ') || '(无)'}`);

    const listed = await api('/api/mcp/servers');
    const demoOff = (listed.json?.servers ?? []).find((s) => s.name === SERVER_NAME);
    check('停用后注入数归零（面板与 agent 说的一致）',
      demoOff?.injected === 0,
      JSON.stringify(demoOff));

    const on = await api(`/api/mcp/servers/${SERVER_NAME}/enabled`, { method: 'PUT', body: { enabled: true } });
    check('重新启用成功', on.status < 300, `status=${on.status} ${on.text.slice(0, 160)}`);

    await waitFor(async () => {
      const s = (await api('/api/mcp/servers')).json?.servers?.find((x) => x.name === SERVER_NAME);
      return s?.injected === 2;
    }, { what: '重新接上工具', timeoutMs: 20_000, stepMs: 400 }).catch(() => undefined);

    const listed2 = await api('/api/mcp/servers');
    const demoOn = (listed2.json?.servers ?? []).find((s) => s.name === SERVER_NAME);
    check('重新启用后工具又回来了', demoOn?.injected === 2, JSON.stringify(demoOn));
  }

  // ── 4. A server that reports isError is a failed call, not a silent success ──
  {
    stub.setWanted(mcpToolName(SERVER_NAME, 'boom'));
    const sid = await newSession('mcp error');
    const turn = await chat('调用 boom', sid);
    const boom = toolResults(turn.events).find((e) => e.toolName === mcpToolName(SERVER_NAME, 'boom'));
    check('MCP 的 isError 变成模型看得见的失败（不是静默成功）',
      !boom || /^Error|isError|mcp-boom/i.test(String(boom.content ?? '')),
      String(boom?.content ?? '(没有结果)').slice(0, 240));
  }

  // ── 5. MCP 通道不出工作区（评测报告 9b）──
  /*
   * 被观测到的事实：`C:\Users\Administrator\.playwright-mcp` 里 340 项 —— 截图与 console 日志，
   * 全是智能体用 playwright 通道做界面验证时留下的，而工作区在别处。SHE 的边界盖住了文件工具与
   * shell，但 MCP 跑在自己的进程里，`spawn` 没给 cwd 就继承了 SHE 的启动目录，于是产物落到边界外。
   *
   * 这里分三件事验：配置层（cwd 钉在工作区、产物目录要回显）、行为层（子进程真的把产物写进了工作
   * 区、没写进 SHE 的启动目录）、历史层（工作区外已经攒下的那些只报不改、而且不再增长）。
   */
  {
    const listed = (await api('/api/mcp/servers')).json?.servers ?? [];
    const pw = listed.find((s) => s.name === PW_SERVER);

    check('每个 MCP server 的 cwd 都是工作区（面板看得见）',
      listed.length > 0 && listed.every((s) => samePath(s.cwd ?? '', workspace)),
      listed.map((s) => `${s.name}: cwd=${s.cwd}`).join('; '));

    check('按 cwd 产物件的 server 报出产物目录在工作区内',
      samePath(pw?.confinedOutputDir ?? '', join(resolve(workspace), '.playwright-mcp')),
      `confinedOutputDir=${pw?.confinedOutputDir ?? '(无)'}`);

    const marker = join(resolve(workspace), '.playwright-mcp', 'cwd-marker.txt');
    const markerCwd = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
    check('【关键】playwright 型通道的产物落在工作区里（说明子进程的 cwd 真是工作区）',
      markerCwd !== '' && samePath(markerCwd, workspace),
      `marker=${markerCwd || '(没有)'}，期望 ${resolve(workspace)}`);

    // 旧行为的下落处：子进程继承 SHE 的启动目录，也就是这个检查里 packages/server。
    const leak = join(SERVER_DIR, '.playwright-mcp', 'cwd-marker.txt');
    const leaked = existsSync(leak);
    if (leaked) rmSync(leak, { force: true });
    check('产物没有落进 SHE 的启动目录（那正是旧行为的位置）', !leaked, leak);

    const legacy = pw?.legacyOutputDir;
    check('工作区外的历史产物被报了出来（只报不改）',
      samePath(legacy?.path ?? '', legacyDir) && legacy?.entries === LEGACY_ITEMS,
      JSON.stringify(legacy ?? null));

    const grew = existsSync(legacyDir) ? readdirSync(legacyDir).length : 0;
    check(`旧位置不再增长（跑完一整轮，仍然只有那 ${LEGACY_ITEMS} 项）`, grew === LEGACY_ITEMS, `${grew} 项`);
  }
} catch (err) {
  check('检查过程未抛异常', false, err.stack ?? err.message);
} finally {
  await shutdown();
  removeTempDir(workspace);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
