/**
 * Cursor-sourced MCP servers are opt-in per workspace.
 *
 * Servers from the user's global Cursor `mcp.json` used to start in every SHE workspace (seven
 * processes per server instance, ~36.6k chars of tool definitions). Now they are listed but off;
 * enabling one copies its entry into the workspace `.she/mcp.json`, after which it behaves like any
 * workspace server. `.she/mcp.json` servers keep their old default (on unless `disabled: true`).
 *
 * `cursorMcpPaths()` reads `homedir()` / `APPDATA` at call time, so a fake home keeps whatever is
 * installed on this machine out of the assertions.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMcpServers, setMcpServerEnabled, listMcpServers } from '../mcp.js';
import { McpBridge } from '../mcp-bridge.js';

const dirs: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const r of restores.splice(0)) r();
  // The spawned servers run with the workspace as cwd; Windows keeps it locked until they exit.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `she-mcp-optin-${tag}-`));
  dirs.push(d);
  return d;
};

const FAKE = String.raw`
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'f', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong:' + (process.env.OPTIN_SECRET ? 'has-env' : 'no-env') }] } });
});
`;

function setup(): { workspace: string; script: string } {
  const home = tempDir('home');
  const appData = join(home, 'AppData', 'Roaming');
  const cursorDir = join(appData, 'Cursor', 'User');
  mkdirSync(cursorDir, { recursive: true });
  const script = join(home, 'fake-mcp.mjs');
  writeFileSync(script, FAKE, 'utf8');
  writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      cursorOne: { command: process.execPath, args: [script], env: { OPTIN_SECRET: 'sekrit-value' } },
      // Even a server Cursor has explicitly enabled stays off in SHE until the user opts in.
      cursorTwo: { command: process.execPath, args: [script], disabled: false },
    },
  }, null, 2), 'utf8');

  const workspace = tempDir('ws');
  mkdirSync(join(workspace, '.she'), { recursive: true });
  writeFileSync(join(workspace, '.she', 'mcp.json'), JSON.stringify({
    mcpServers: { local: { command: process.execPath, args: [script] } },
  }, null, 2), 'utf8');

  const before = { home: process.env.USERPROFILE, home2: process.env.HOME, app: process.env.APPDATA };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = appData;
  restores.push(() => {
    for (const [key, val] of [['USERPROFILE', before.home], ['HOME', before.home2], ['APPDATA', before.app]] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });
  return { workspace, script };
}

const byName = (ws: string) => new Map(discoverMcpServers(ws).map((s) => [s.name, s] as const));

describe('Cursor-sourced MCP servers are opt-in', () => {
  it('are discovered but disabled by default; workspace servers stay enabled', () => {
    const { workspace } = setup();
    const s = byName(workspace);
    assert.equal(s.get('cursorOne')?.source, 'cursor');
    assert.equal(s.get('cursorOne')?.enabled, false);
    assert.equal(s.get('cursorTwo')?.enabled, false);
    assert.equal(s.get('local')?.source, 'she');
    assert.equal(s.get('local')?.enabled, true);
  });

  it('the bridge starts only the workspace server', async () => {
    const { workspace } = setup();
    const bridge = new McpBridge({ workspaceRoot: () => workspace, log: () => {}, pidDir: () => null });
    try {
      const summary = await bridge.refresh();
      assert.deepEqual(summary.running, ['local']);
      const call = await bridge.execute('mcp_call', { server: 'cursorOne', tool: 'ping', arguments: {} });
      assert.match(call, /not enabled/);
    } finally {
      bridge.shutdown();
    }
  });

  it('enabling copies command/args/env into .she/mcp.json and the server becomes a workspace server', async () => {
    const { workspace, script } = setup();
    assert.equal(setMcpServerEnabled(workspace, 'cursorOne', true), true);
    const file = JSON.parse(readFileSync(join(workspace, '.she', 'mcp.json'), 'utf8'));
    assert.deepEqual(file.mcpServers.cursorOne, { command: process.execPath, args: [script], env: { OPTIN_SECRET: 'sekrit-value' } });
    assert.ok(file.mcpServers.local, 'existing workspace entries are kept');

    const s = byName(workspace).get('cursorOne');
    assert.equal(s?.source, 'she');
    assert.equal(s?.enabled, true);

    // The env reaches the server process (it needs it) ...
    const bridge = new McpBridge({ workspaceRoot: () => workspace, log: () => {}, pidDir: () => null });
    try {
      const summary = await bridge.refresh();
      assert.deepEqual(summary.running, ['cursorOne', 'local']);
      const out = await bridge.execute('mcp_call', { server: 'cursorOne', tool: 'ping', arguments: {} });
      assert.match(out, /pong:has-env/);
      // ... but its value is never echoed back by the listing.
      const listed = await bridge.execute('mcp_list', { server: 'cursorOne' });
      assert.ok(!listed.includes('sekrit-value'));
    } finally {
      bridge.shutdown();
    }

    // Disabling it afterwards toggles the workspace entry, as for any she server.
    assert.equal(setMcpServerEnabled(workspace, 'cursorOne', false), true);
    assert.equal(byName(workspace).get('cursorOne')?.enabled, false);
  });

  it('the panel listing never returns env values', async () => {
    const { workspace } = setup();
    setMcpServerEnabled(workspace, 'cursorOne', true);
    const listed = await listMcpServers(workspace);
    assert.ok(!JSON.stringify(listed).includes('sekrit-value'));
  });

  it('disabling a Cursor-only server is a successful no-op; unknown names fail', () => {
    const { workspace } = setup();
    const file = join(workspace, '.she', 'mcp.json');
    const before = readFileSync(file, 'utf8');
    assert.equal(setMcpServerEnabled(workspace, 'cursorTwo', false), true);
    assert.equal(readFileSync(file, 'utf8'), before, 'nothing written for an already-off server');
    assert.equal(setMcpServerEnabled(workspace, 'nope', true), false);
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('enabling works when the workspace has no .she/mcp.json yet', () => {
    const { workspace } = setup();
    rmSync(join(workspace, '.she', 'mcp.json'));
    assert.equal(setMcpServerEnabled(workspace, 'cursorTwo', true), true);
    assert.ok(existsSync(join(workspace, '.she', 'mcp.json')));
    assert.equal(byName(workspace).get('cursorTwo')?.enabled, true);
  });
});