import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { productVersion } from './version.js';
import { spawn, type ChildProcess } from 'node:child_process';

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Where this entry came from. */
  source: 'cursor' | 'she';
  /** Whether it was enabled from the SHE-managed file (only for source 'she'). */
  enabled?: boolean;
}

export interface McpServerStatus extends McpServerConfig {
  /** Reachability probe result. */
  reachable: boolean | null;
  toolCount: number | null;
  error?: string;
  latencyMs?: number;
}

const SHE_MCP_FILE = '.she/mcp.json';

/** Where Cursor keeps its MCP configuration, per platform. */
function cursorMcpPaths(): string[] {
  const home = homedir();
  const paths: string[] = [];
  if (process.env.APPDATA) paths.push(join(process.env.APPDATA, 'Cursor', 'User', 'mcp.json'));
  paths.push(join(home, '.cursor', 'mcp.json'));
  paths.push(join(home, '.config', 'Cursor', 'User', 'mcp.json'));
  return paths;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

interface RawMcpFile {
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; disabled?: boolean }>;
}

/** Discover MCP servers from Cursor configs and SHE's own override file. */
export function discoverMcpServers(workspaceRoot: string): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();

  // SHE-managed file wins (allows adding/enabling without touching Cursor).
  const sheFile = join(workspaceRoot, SHE_MCP_FILE);
  const she = existsSync(sheFile) ? (readJson(sheFile) as RawMcpFile | null) : null;
  const sheServers = she?.mcpServers ?? {};
  for (const [name, cfg] of Object.entries(sheServers)) {
    if (!cfg?.command) continue;
    out.push({
      name,
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
      source: 'she',
      enabled: cfg.disabled !== true,
    });
    seen.add(name);
  }

  for (const p of cursorMcpPaths()) {
    if (!existsSync(p)) continue;
    const parsed = readJson(p) as RawMcpFile | null;
    for (const [name, cfg] of Object.entries(parsed?.mcpServers ?? {})) {
      if (!cfg?.command || seen.has(name)) continue;
      out.push({
        name,
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
        source: 'cursor',
        enabled: cfg.disabled !== true,
      });
      seen.add(name);
    }
  }

  return out;
}

/** Add or update a server in SHE's own mcp.json. */
export function writeMcpServer(
  workspaceRoot: string,
  server: { name: string; command: string; args: string[]; env?: Record<string, string> },
): void {
  const file = join(workspaceRoot, SHE_MCP_FILE);
  const cur = (existsSync(file) ? readJson(file) : null) as RawMcpFile | null;
  const data: RawMcpFile = cur ?? { mcpServers: {} };
  data.mcpServers = data.mcpServers ?? {};
  data.mcpServers[server.name] = {
    command: server.command,
    args: server.args,
    ...(server.env ? { env: server.env } : {}),
  };
  mkdirSync(join(workspaceRoot, '.she'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

export function removeMcpServer(workspaceRoot: string, name: string): boolean {
  const file = join(workspaceRoot, SHE_MCP_FILE);
  if (!existsSync(file)) return false;
  const data = (readJson(file) as RawMcpFile | null) ?? { mcpServers: {} };
  if (!data.mcpServers?.[name]) return false;
  delete data.mcpServers[name];
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return true;
}

export function setMcpServerEnabled(workspaceRoot: string, name: string, enabled: boolean): boolean {
  const file = join(workspaceRoot, SHE_MCP_FILE);
  const data = (existsSync(file) ? readJson(file) : null) as RawMcpFile | null;
  if (!data?.mcpServers?.[name]) return false;
  data.mcpServers[name] = { ...data.mcpServers[name], disabled: !enabled };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return true;
}

// ─── live probe ─────────────────────────────────────────────────────────────

/**
 * Start a stdio MCP server, perform the initialize handshake, and ask for its
 * tool list. This is a real reachability check, not a config-file guess.
 */
function probeServer(
  cfg: McpServerConfig,
  timeoutMs = 12000,
): Promise<{ reachable: boolean; toolCount: number | null; error?: string; latencyMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let child: ChildProcess | null = null;
    let buffer = '';
    let settled = false;
    let toolCount: number | null = null;

    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      try { child?.kill(); } catch { /* ignore */ }
      resolve({ reachable, toolCount, error, latencyMs: Date.now() - started });
    };

    try {
      child = spawn(cfg.command, cfg.args, {
        env: { ...process.env, ...(cfg.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch (e) {
      finish(false, (e as Error).message);
      return;
    }

    const send = (msg: unknown) => {
      try { child?.stdin?.write(JSON.stringify(msg) + '\n'); } catch { /* ignore */ }
    };

    child.on('error', (e) => finish(false, e.message));
    child.on('exit', (code) => {
      if (!settled) finish(false, `进程退出 (code ${code})`);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { tools?: unknown[]; serverInfo?: unknown } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          // initialized -> ask for tools
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2 && msg.result) {
          toolCount = Array.isArray(msg.result.tools) ? msg.result.tools.length : 0;
          finish(true);
        }
      }
    });

    child.stderr?.on('data', () => { /* servers are chatty; ignore */ });

    // handshake
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'she', version: productVersion() },
      },
    });

    setTimeout(() => finish(false, `超时 (${timeoutMs}ms)`), timeoutMs);
  });
}

/**
 * Strip secret values from a server config before it leaves the server.
 *
 * `env` routinely carries tokens (that is what it is for), and the whole object was returned by
 * `GET /api/mcp/servers`, so the panel handed every configured MCP token back to the caller. The
 * keys are kept so the user can see WHICH variables the server is configured with — the values are
 * what must not travel.
 */
function redactMcpEnv(cfg: McpServerConfig): McpServerConfig {
  if (!cfg.env) return cfg;
  return { ...cfg, env: Object.fromEntries(Object.keys(cfg.env).map((k) => [k, '***'])) };
}

/** List every discovered server together with a live probe result. */
export async function listMcpServers(workspaceRoot: string): Promise<McpServerStatus[]> {
  const servers = discoverMcpServers(workspaceRoot);
  const results = await Promise.all(
    servers.map(async (s) => {
      const probe = await probeServer(s);
      return { ...redactMcpEnv(s), reachable: probe.reachable, toolCount: probe.toolCount, error: probe.error, latencyMs: probe.latencyMs };
    }),
  );
  return results;
}

/** Probe a single named server. */
export async function probeMcpServer(workspaceRoot: string, name: string): Promise<McpServerStatus | null> {
  const cfg = discoverMcpServers(workspaceRoot).find((s) => s.name === name);
  if (!cfg) return null;
  const probe = await probeServer(cfg);
  return { ...redactMcpEnv(cfg), reachable: probe.reachable, toolCount: probe.toolCount, error: probe.error, latencyMs: probe.latencyMs };
}
