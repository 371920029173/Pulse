/**
 * MCP bridge: configured MCP servers must become tools the agent can call.
 *
 * Before the bridge, servers were only probed (spawn, count tools, kill) and the agent never saw a
 * single MCP tool while the panel said "reachable, 14 tools". These tests drive a real child
 * process speaking newline-delimited JSON-RPC, so the handshake, framing, routing and restart
 * paths are exercised end to end rather than mocked.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyToolResult } from '@she/agent-runtime';
import { McpBridge, mcpToolName, MCP_OUTPUT_CAP } from '../mcp-bridge.js';
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
  { name: 'echo', description: 'Echo the arguments back', inputSchema: obj({ text: { type: 'string' } }) },
  { name: 'fail', description: 'Always reports isError', inputSchema: obj({}) },
  { name: 'weird.name/x', description: 'Name needs sanitizing' },
  { name: 'die', description: 'Exits the process mid-call', inputSchema: obj({}) },
  { name: 'slow', description: 'Never answers', inputSchema: obj({}) },
  { name: 'big', description: 'Returns a lot of text', inputSchema: obj({}) },
];
if (mode === 'collide') tools.push({ name: 'echo.', description: 'sanitizes to echo_' }, { name: 'echo_', description: 'already echo_' });
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
after(() => { rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { bridge?.shutdown(); bridge = null; logs.length = 0; });

function server(name: string, extra: Partial<McpServerConfig> = {}, env: Record<string, string> = {}): McpServerConfig {
  // `node` from PATH rather than process.execPath: on Windows the spawn goes through a shell,
  // exactly like a real config, and the install path usually contains a space.
  return { name, command: 'node', args: [script], env, source: 'she', enabled: true, ...extra };
}

function makeBridge(configs: McpServerConfig[] | (() => McpServerConfig[]), opts: { callTimeoutMs?: number; reserved?: string[] } = {}) {
  bridge = new McpBridge({
    workspaceRoot: () => dir,
    log: (m) => logs.push(m),
    discover: () => (typeof configs === 'function' ? configs() : configs),
    connectTimeoutMs: 15_000,
    callTimeoutMs: opts.callTimeoutMs,
    reservedNames: () => opts.reserved ?? [],
  });
  return bridge;
}

describe('McpBridge definitions', () => {
  it('registers every tool with prefixed, sanitized, deterministically sorted names', async () => {
    const b = makeBridge([server('zeta'), server('alpha')]);
    const defs = await b.refresh();
    const names = defs.map((d) => d.name);
    const perServer = ['mcp_X_big', 'mcp_X_die', 'mcp_X_echo', 'mcp_X_fail', 'mcp_X_slow', 'mcp_X_weird_name_x'];
    assert.deepEqual(names, [...perServer.map((n) => n.replace('X', 'alpha')), ...perServer.map((n) => n.replace('X', 'zeta'))]);
    // Synchronous and stable: the same array until the next refresh.
    assert.equal(b.definitions(), defs);
    const echo = defs.find((d) => d.name === 'mcp_alpha_echo')!;
    assert.ok(echo.description.startsWith('[MCP alpha] Echo'), echo.description);
    assert.deepEqual(echo.parameters, { type: 'object', properties: { text: { type: 'string' } } });
    // No inputSchema -> an empty object schema, never undefined.
    assert.deepEqual(defs.find((d) => d.name === 'mcp_alpha_weird_name_x')!.parameters, { type: 'object', properties: {} });
    assert.deepEqual(b.injectStatus('alpha'), { injected: 6 });
    for (const n of names) assert.match(n, /^[A-Za-z0-9_-]{1,64}$/);
  });

  it('caps names at 64 characters', () => {
    const n = mcpToolName('server', 'a'.repeat(100));
    assert.equal(n.length, 64);
    assert.ok(n.startsWith('mcp_server_'));
  });

  it('does not register a disabled server', async () => {
    const b = makeBridge([server('off', { enabled: false }), server('on')]);
    const defs = await b.refresh();
    assert.ok(defs.every((d) => d.name.startsWith('mcp_on_')));
    assert.equal(b.injectStatus('off').injected, 0);
  });

  it('skips a tool whose sanitized name collides, and reports it', async () => {
    const b = makeBridge([server('c', {}, { FAKE_MODE: 'collide' })], { reserved: ['mcp_c_fail'] });
    const defs = await b.refresh();
    const names = defs.map((d) => d.name);
    assert.equal(names.filter((n) => n === 'mcp_c_echo_').length, 1);
    assert.ok(!names.includes('mcp_c_fail'), 'reserved name must not be taken over');
    const st = b.injectStatus('c');
    assert.equal(st.injected, 6); // 8 offered, 2 skipped
    assert.match(st.injectError ?? '', /2 tool\(s\) skipped/);
    assert.ok(logs.some((l) => l.includes('already taken')));
  });

  it('a server that fails to start contributes nothing and records the error', async () => {
    const b = makeBridge([server('broken', {}, { FAKE_MODE: 'crash' }), server('ok')]);
    const defs = await b.refresh();
    assert.ok(defs.length > 0 && defs.every((d) => d.name.startsWith('mcp_ok_')));
    const st = b.injectStatus('broken');
    assert.equal(st.injected, 0);
    assert.match(st.injectError ?? '', /exited|code 1/);
  });

  it('refresh follows the config: disabling a server removes its tools', async () => {
    let enabled = true;
    const b = makeBridge(() => [server('t', { enabled })]);
    assert.ok((await b.refresh()).length > 0);
    enabled = false;
    assert.equal((await b.refresh()).length, 0);
    assert.equal(b.owns('mcp_t_echo'), false);
  });
});

describe('McpBridge execute', () => {
  it('round-trips tools/call and renders non-text parts as placeholders', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const out = await b.execute('mcp_s_echo', { text: 'hi', _confirm_ticket: 'ignored-when-not-gated' });
    assert.equal(out, 'echo:{"text":"hi"}\n[image: image/png]\n[resource: file:///x.bin (application/octet-stream)]');
    assert.equal(classifyToolResult('mcp_s_echo', out).ok, true);
  });

  it('maps isError to an Error: result the classifier counts as a failure', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const out = await b.execute('mcp_s_fail', {});
    assert.equal(out, 'Error: MCP server s reported an error from tool fail: boom');
    const v = classifyToolResult('mcp_s_fail', out);
    assert.equal(v.ok, false);
    assert.notEqual(v.kind, 'unknown');
  });

  it('caps long output with a truncation note', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const out = await b.execute('mcp_s_big', {});
    assert.ok(out.length < MCP_OUTPUT_CAP + 200);
    assert.match(out, /\[output truncated: 50000 chars total/);
  });

  it('times out a call with a clear error', async () => {
    const b = makeBridge([server('s')], { callTimeoutMs: 300 });
    await b.refresh();
    const out = await b.execute('mcp_s_slow', {});
    assert.match(out, /^Error: MCP server s tool slow timed out after 300ms/);
    assert.equal(classifyToolResult('mcp_s_slow', out).kind, 'timeout');
  });

  it('a process that dies is restarted on the next call', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const died = await b.execute('mcp_s_die', {});
    assert.match(died, /^Error: MCP tool "mcp_s_die" is not available: server s exited during the call/);
    const again = await b.execute('mcp_s_echo', { text: 'back' });
    assert.equal(again.split('\n')[0], 'echo:{"text":"back"}');
    assert.ok(logs.some((l) => l.includes('restarted')));
  });

  it('a dead process that cannot restart gives a clean error', async () => {
    const marker = join(dir, 'no-restart.flag');
    const b = makeBridge([server('s', {}, { FAKE_MARKER: marker })]);
    await b.refresh();
    writeFileSync(marker, '1');
    try {
      await b.execute('mcp_s_die', {});
      const out = await b.execute('mcp_s_echo', { text: 'x' });
      assert.match(out, /^Error: MCP tool "mcp_s_echo" is not available: server s stopped .* could not be restarted/);
      assert.equal(classifyToolResult('mcp_s_echo', out).kind, 'unavailable');
    } finally {
      if (existsSync(marker)) rmSync(marker);
    }
  });

  it('an unknown name is refused', async () => {
    const b = makeBridge([]);
    await b.refresh();
    const out = await b.execute('mcp_nope_x', {});
    assert.equal(classifyToolResult('mcp_nope_x', out).kind, 'unavailable');
  });

  it('with requireConfirm, a call needs a user-approved ticket bound to its arguments', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    const first = await b.execute('mcp_s_echo', { text: 'secret' }, { requireConfirm: true, workspaceRoot: dir });
    const parsed = JSON.parse(first) as { needs_confirm?: { ticket_id: string; summary: string } };
    assert.ok(parsed.needs_confirm, first);
    assert.match(parsed.needs_confirm.summary, /MCP s\.echo/);
    // A ticket for other arguments does not authorise this call.
    const other = await b.execute('mcp_s_echo', { text: 'different', _confirm_ticket: parsed.needs_confirm.ticket_id }, { requireConfirm: true, workspaceRoot: dir });
    assert.ok(JSON.parse(other).needs_confirm, 'mismatched args must not run');
    const again = await b.execute('mcp_s_echo', { text: 'secret' }, { requireConfirm: true, workspaceRoot: dir });
    const ticket = (JSON.parse(again) as { needs_confirm: { ticket_id: string } }).needs_confirm.ticket_id;
    const ran = await b.execute('mcp_s_echo', { text: 'secret', _confirm_ticket: ticket }, { requireConfirm: true, workspaceRoot: dir });
    assert.equal(ran.split('\n')[0], 'echo:{"text":"secret"}');
  });

  it('shutdown clears the tool list', async () => {
    const b = makeBridge([server('s')]);
    await b.refresh();
    b.shutdown();
    assert.equal(b.definitions().length, 0);
  });
});