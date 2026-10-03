/**
 * MCP bridge: configured MCP servers reachable through `mcp_list` / `mcp_call`.
 *
 * History: servers were first only probed (the agent saw none of their tools), then every tool was
 * registered as its own function (52 tools / ~36.6k chars on every request, and a tool table that
 * changed whenever a server failed to connect, which broke the prompt cache of resumed sessions).
 * The agent now gets two STATIC meta-tools. These tests drive a real child process speaking
 * newline-delimited JSON-RPC, so handshake, framing, routing, restart and the confirm gate are
 * exercised end to end rather than mocked.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { classifyToolResult } from '@she/agent-runtime';
import { McpBridge, McpPidRegistry, MCP_META_DEFINITIONS, MCP_OUTPUT_CAP, pidAlive } from '../mcp-bridge.js';
import type { McpServerConfig } from '../mcp.js';

const FAKE_SERVER = String.raw`
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
const mode = process.env.FAKE_MODE || '';
if (process.env.FAKE_MARKER && existsSync(process.env.FAKE_MARKER)) process.exit(1);
if (mode === 'crash') process.exit(1);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const obj = (properties) => ({ type: 'object', properties });
const tools = [
  { name: 'echo', description: 'Echo the arguments back\nSecond line is not shown in the overview', inputSchema: obj({ text: { type: 'string' } }) },
  { name: 'fail', description: 'Always reports isError', inputSchema: obj({}) },
  { name: 'weird.name/x', description: 'Name with odd characters' },
  { name: 'die', description: 'Exits the process mid-call', inputSchema: obj({}) },
  { name: 'slow', description: 'Never answers', inputSchema: obj({}) },
  { name: 'big', description: 'Returns a lot of text', inputSchema: obj({}) },
];
let initialized = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  } else if (method === 'notifications/initialized') {
    initialized = true;
  } else if (method === 'tools/list') {
    if (!initialized) return send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'not initialized' } });
    // Two pages, so nextCursor pagination is exercised.
    if (!params || !params.cursor) send({ jsonrpc: '2.0', id, result: { tools: tools.slice(0, 3), nextCursor: 'p2' } });
    else send({ jsonrpc: '2.0', id, result: { tools: tools.slice(3) } });
  } else if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments;
    if (name === 'echo') send({ jsonrpc: '2.0', id, result: { content: [
      { type: 'text', text: 'echo:' + JSON.stringify(args) },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///x.bin', mimeType: 'application/octet-stream' } },
    ] } });
    else if (name === 'weird.name/x') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'weird-ok' }] } });
    else if (name === 'fail') send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
    else if (name === 'die') process.exit(3);
    else if (name === 'slow') { /* never answer */ }
    else if (name === 'big') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'x'.repeat(50000) }] } });
    else send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + name } });
  }
});
`;

let dir: string;
let script: string;
let bridge: McpBridge | null = null;
const logs: string[] = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-mcp-bridge-'));
  script = join(dir, 'fake-mcp.mjs');
  writeFileSync(script, FAKE_SERVER, 'utf8');
});
/*
 * Removal that cannot fail the file.
 *
 * This test spawns real MCP server child processes, and the directory cannot be removed while a
 * child holds it. `bridge?.shutdown()` narrows the window but cannot close it; a leftover temp
 * directory is harmless (`pnpm check:temp` sweeps it), a red suite that passed is not.
 */
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch (err) {
    console.warn(`[mcp-bridge.test] temp dir left for check:temp: ${dir} (${(err as Error).message})`);
  }
});
afterEach(() => { bridge?.shutdown(); bridge = null; logs.length = 0; });

function server(name: string, extra: Partial<McpServerConfig> = {}, env: Record<string, string> = {}): McpServerConfig {
  // `node` from PATH rather than process.execPath: on Windows the spawn goes through a shell,
  // exactly like a real config, and the install path usually contains a space.
  return { name, command: 'node', args: [script], env, source: 'she', enabled: true, ...extra };
}

function makeBridge(configs: McpServerConfig[] | (() => McpServerConfig[]), opts: { callTimeoutMs?: number; pidDir?: string | null } = {}) {
  bridge = new McpBridge({
    workspaceRoot: () => dir,
    log: (m) => logs.push(m),
    discover: () => (typeof configs === 'function' ? configs() : configs),
    connectTimeoutMs: 15_000,
    callTimeoutMs: opts.callTimeoutMs,
    pidDir: () => (opts.pidDir === undefined ? join(dir, 'pids-default') : opts.pidDir),
  });
  return bridge;
}

const call = (b: McpBridge, server: string, tool: string, args: unknown = {}, opts = {}) =>
  b.execute('mcp_call', { server, tool, arguments: args }, opts);

describe('the tool table is static', () => {
  it('exposes exactly mcp_list and mcp_call, byte-identical across refreshes, failures and toggles', async () => {
    let enabled = true;
    const b = makeBridge(() => [server('ok', { enabled }), server('broken', {}, { FAKE_MODE: 'crash' })]);
    const before = JSON.stringify(b.definitions());
    assert.deepEqual(b.definitions().map((d) => d.name), ['mcp_list', 'mcp_call']);
    const s1 = await b.refresh();
    assert.deepEqual(s1.running, ['ok']);
    assert.deepEqual(s1.failed, ['broken']);
    assert.equal(s1.tools, 6);
    const afterFirst = JSON.stringify(b.definitions());
    enabled = false;
    await b.refresh();
    const afterToggle = JSON.stringify(b.definitions());
    assert.equal(afterFirst, before);
    assert.equal(afterToggle, before);
    assert.equal(before, JSON.stringify(MCP_META_DEFINITIONS));
    // Nothing server-specific may leak into the cached text.
    assert.ok(!/\bok\b|broken|echo/.test(before), before);
  });

  it('owns only the two meta-tools', () => {
    const b = makeBridge([]);
    assert.equal(b.owns('mcp_list'), true);
    assert.equal(b.owns('mcp_call'), true);
    assert.equal(b.owns('mcp_ok_echo'), false);
  });
});

describe('mcp_list', () => {
  it('lists servers with status and one line per tool, sorted', async () => {
    const b = makeBridge([server('zeta'), server('alpha'), server('off', { enabled: false }), server('broken', {}, { FAKE_MODE: 'crash' })]);
    await b.refresh();
    const out = await b.execute('mcp_list', {});
    assert.equal(classifyToolResult('mcp_list', out).ok, true);
    const alpha = out.indexOf('- alpha: 6 tool(s)');
    const zeta = out.indexOf('- zeta: 6 tool(s)');
    assert.ok(alpha > 0 && zeta > alpha, out);
    assert.match(out, /- broken: not running \(/);
    assert.match(out, /- off: not enabled/);
    assert.match(out, /  - echo: Echo the arguments back\n/);
    assert.ok(!out.includes('Second line'), 'overview shows one line per tool');
    assert.ok(!out.includes('input schema:'), 'overview carries no schemas');
    // Tools sorted by name within a server.
    const names = [...out.slice(alpha, zeta).matchAll(/^  - ([^:]+):/gm)].map((m) => m[1]);
    assert.deepEqual(names, ['big', 'die', 'echo', 'fail', 'slow', 'weird.name/x']);
  });

  it('with a server, returns every tool with its input schema', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const out = await b.execute('mcp_list', { server: 's' });
    assert.match(out, /^MCP server s: 6 tool\(s\)/);
    assert.match(out, /## echo\nEcho the arguments back\nSecond line/);
    assert.match(out, /input schema: \{"type":"object","properties":\{"text":\{"type":"string"\}\}\}/);
    // No inputSchema -> an empty object schema, never undefined.
    assert.match(out, /## weird\.name\/x\nName with odd characters\ninput schema: \{"type":"object","properties":\{\}\}/);
  });

  it('query filters, and an exact tool name also returns its schema', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const filtered = await b.execute('mcp_list', { query: 'ECHO' });
    assert.match(filtered, /- s: 6 tool\(s\), 1 matching/);
    assert.match(filtered, /## s \/ echo\ninput schema: /);
    assert.ok(!filtered.includes('  - fail:'));
    const none = await b.execute('mcp_list', { query: 'zzz-nothing' });
    assert.match(none, /no tool matches "zzz-nothing"/);
  });

  it('says clearly when nothing is configured or nothing is enabled', async () => {
    const empty = makeBridge([]);
    assert.match(await empty.execute('mcp_list', {}), /^No MCP servers are configured/);
    empty.shutdown();
    const off = makeBridge([server('a', { enabled: false })]);
    await off.refresh();
    assert.match(await off.execute('mcp_list', {}), /^No MCP server is enabled/);
    assert.match(await off.execute('mcp_list', { server: 'a' }), /configured but not enabled/);
  });

  it('an unknown server is reported as unavailable', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const out = await b.execute('mcp_list', { server: 'nope' });
    assert.equal(classifyToolResult('mcp_list', out).kind, 'unavailable');
  });
});

describe('mcp_call', () => {
  it('round-trips tools/call and renders non-text parts as placeholders', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const out = await call(b, 's', 'echo', { text: 'hi' });
    assert.equal(out, 'echo:{"text":"hi"}\n[image: image/png]\n[resource: file:///x.bin (application/octet-stream)]');
    assert.equal(classifyToolResult('mcp_call', out).ok, true);
    // Original tool names are used as-is (no sanitizing needed any more).
    assert.equal(await call(b, 's', 'weird.name/x'), 'weird-ok');
    // Arguments sent as a JSON string are accepted.
    assert.equal((await call(b, 's', 'echo', '{"text":"str"}')).split('\n')[0], 'echo:{"text":"str"}');
  });

  it('rejects bad input with classifiable errors', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    assert.equal(classifyToolResult('mcp_call', await b.execute('mcp_call', { server: 's' })).kind, 'invalid_args');
    assert.equal(classifyToolResult('mcp_call', await call(b, 's', 'echo', [1, 2])).kind, 'invalid_args');
    assert.equal(classifyToolResult('mcp_call', await call(b, 's', 'nope')).kind, 'not_found');
    assert.equal(classifyToolResult('mcp_call', await call(b, 'ghost', 'echo')).kind, 'unavailable');
  });

  it('maps isError to an Error: result the classifier counts as a failure', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const out = await call(b, 's', 'fail');
    assert.equal(out, 'Error: MCP server s reported an error from tool fail: boom');
    const v = classifyToolResult('mcp_call', out);
    assert.equal(v.ok, false);
    assert.notEqual(v.kind, 'unknown');
  });

  it('caps long output with a truncation note', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const out = await call(b, 's', 'big');
    assert.ok(out.length < MCP_OUTPUT_CAP + 200);
    assert.match(out, /\[output truncated: 50000 chars total/);
  });

  it('times out a call with a clear error', async () => {
    const b = makeBridge([server('s')], { callTimeoutMs: 300 });
    await b.refresh();
    const out = await call(b, 's', 'slow');
    assert.match(out, /^Error: MCP server s tool slow timed out after 300ms/);
    assert.equal(classifyToolResult('mcp_call', out).kind, 'timeout');
  });

  it('a process that dies is restarted on the next call', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const died = await call(b, 's', 'die');
    assert.match(died, /^Error: MCP server "s" is not available: it exited during the call/);
    const again = await call(b, 's', 'echo', { text: 'back' });
    assert.equal(again.split('\n')[0], 'echo:{"text":"back"}');
    assert.ok(logs.some((l) => l.includes('restarted')));
  });

  it('a dead process that cannot restart gives a clean error', async () => {
    const marker = join(dir, 'no-restart.flag');
    const b = makeBridge([server('s', {}, { FAKE_MARKER: marker })]);
    await b.refresh();
    writeFileSync(marker, '1');
    try {
      await call(b, 's', 'die');
      const out = await call(b, 's', 'echo', { text: 'x' });
      assert.match(out, /^Error: MCP server "s" is not available: stopped .* could not be restarted/);
      assert.equal(classifyToolResult('mcp_call', out).kind, 'unavailable');
      assert.equal(b.injectStatus('s').injected, 0);
      assert.ok(b.injectStatus('s').injectError);
    } finally {
      if (existsSync(marker)) rmSync(marker);
    }
  });

  it('a disabled server is not started and cannot be called', async () => {
    const b = makeBridge([server('off', { enabled: false })]);
    const s = await b.refresh();
    assert.deepEqual(s.running, []);
    assert.equal(b.injectStatus('off').injected, 0);
    assert.match(await call(b, 'off', 'echo'), /^Error: MCP server "off" is not available: not enabled/);
  });

  it('injectStatus counts the tools mcp_call can reach', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    assert.deepEqual(b.injectStatus('s'), { injected: 6 });
  });

  it('with requireConfirm, a call needs a ticket bound to server + tool + arguments', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const opts = { requireConfirm: true, workspaceRoot: dir };
    const first = await call(b, 's', 'echo', { text: 'secret' }, opts);
    const parsed = JSON.parse(first) as { needs_confirm?: { ticket_id: string; summary: string; tool: string } };
    assert.ok(parsed.needs_confirm, first);
    assert.equal(parsed.needs_confirm.tool, 'mcp_call');
    assert.match(parsed.needs_confirm.summary, /MCP s\.echo \{"text":"secret"\}/);
    assert.equal(classifyToolResult('mcp_call', first).kind, 'none', 'awaiting a human is not a failure');
    const ticket = parsed.needs_confirm.ticket_id;
    // The ticket does not authorise other arguments, nor another tool on the same server.
    const otherArgs = await b.execute('mcp_call', { server: 's', tool: 'echo', arguments: { text: 'different' }, _confirm_ticket: ticket }, opts);
    assert.ok(JSON.parse(otherArgs).needs_confirm, 'mismatched args must not run');
    const t2 = (JSON.parse(await call(b, 's', 'echo', { text: 'secret' }, opts)) as { needs_confirm: { ticket_id: string } }).needs_confirm.ticket_id;
    const otherTool = await b.execute('mcp_call', { server: 's', tool: 'fail', arguments: { text: 'secret' }, _confirm_ticket: t2 }, opts);
    assert.ok(JSON.parse(otherTool).needs_confirm, 'a ticket for echo must not run fail');
    const t3 = (JSON.parse(await call(b, 's', 'echo', { text: 'secret' }, opts)) as { needs_confirm: { ticket_id: string } }).needs_confirm.ticket_id;
    const ran = await b.execute('mcp_call', { server: 's', tool: 'echo', arguments: { text: 'secret' }, _confirm_ticket: t3 }, opts);
    assert.equal(ran.split('\n')[0], 'echo:{"text":"secret"}');
    // mcp_list never asks.
    assert.ok(!(await b.execute('mcp_list', {}, opts)).includes('needs_confirm'));
  });
});

describe('orphan safeguard', () => {
  it('records spawned server PIDs and removes the record on shutdown', async () => {
    const pidDir = join(dir, 'pids-record');
    const b = makeBridge([server('s')], { pidDir });
    await b.refresh();
    const file = join(pidDir, `${process.pid}.json`);
    assert.ok(existsSync(file), 'no pid record written');
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { owner: number; children: Array<{ server: string; pid: number; needles: string[] }> };
    assert.equal(rec.owner, process.pid);
    assert.equal(rec.children.length, 1);
    assert.equal(rec.children[0].server, 's');
    assert.ok(rec.children[0].needles.includes(script));
    b.shutdown();
    assert.ok(!existsSync(file), 'record should be removed on shutdown');
  });

  it('reaps a dead owner\'s child only when its command line still matches', async () => {
    const pidDir = join(dir, 'pids-reap');
    mkdirSync(pidDir, { recursive: true });
    const sleeper = join(dir, 'sleeper.mjs');
    writeFileSync(sleeper, 'setInterval(() => {}, 1000);\n', 'utf8');
    const start = () => spawn(process.execPath, [sleeper], { stdio: 'ignore', windowsHide: true });
    const matching = start();
    const unrelated = start();
    // An owner PID that is certainly dead: a process that already exited.
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => gone.on('exit', r));
    try {
      writeFileSync(join(pidDir, `${gone.pid}.json`), JSON.stringify({
        owner: gone.pid,
        children: [
          { server: 'a', pid: matching.pid, needles: [sleeper] },
          { server: 'b', pid: unrelated.pid, needles: ['definitely-not-in-the-command-line'] },
        ],
      }), 'utf8');
      // A live owner's file must not be touched.
      writeFileSync(join(pidDir, `${process.pid}.json`), JSON.stringify({ owner: process.pid, children: [{ server: 'c', pid: unrelated.pid, needles: [sleeper] }] }), 'utf8');
      const reapLog: string[] = [];
      const killed = new McpPidRegistry().reapStale(pidDir, (m) => reapLog.push(m));
      assert.deepEqual(killed, [matching.pid]);
      for (let i = 0; i < 50 && pidAlive(matching.pid!); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(pidAlive(matching.pid!), false, 'matching orphan should be dead');
      assert.equal(pidAlive(unrelated.pid!), true, 'a process with another command line must be left alone');
      assert.deepEqual(readdirSync(pidDir).sort(), [`${process.pid}.json`]);
      assert.ok(reapLog.some((l) => l.includes('left alone')));
    } finally {
      try { matching.kill(); } catch { /* ignore */ }
      try { unrelated.kill(); } catch { /* ignore */ }
    }
  });
});