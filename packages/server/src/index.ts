import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, loadConfig } from '@she/shared';
import type {
  SheConfig,
  LLMMessage,
  StreamChunk,
  MemoryNode,
  Group,
  Edge,
  EdgeKind,
  KBQueryResult,
  ToolCall,
  ToolDefinition,
} from '@she/shared';

import { Router, sendJSON, sendError, sendSSEEvent, startSSE, endSSE, parseBody, corsHeaders } from './router.js';

// ─── Dependency Interfaces ───
// The server dynamically loads @she/kb, @she/core, and @she/sandbox at
// startup so it can still boot when those packages haven't been built yet.
// The interfaces below describe the contract the server relies on.  They are
// intentionally broader than the current stubs — the packages will grow into
// them as development proceeds.

interface KBStore {
  getAllGroups(): Group[];
  getGroup(id: string): Group | undefined;
  getGroupChildren(parentId: string): Group[];
  getGroupMemories(groupId: string): MemoryNode[];
  createGroup(name: string, parentId?: string): Group;
  addMemory(groupId: string, kind: string, title: string, content: string): MemoryNode;
  addEdge(sourceId: string, targetId: string, kind: EdgeKind, evidence?: string): Edge;
  getAllMemories(): MemoryNode[];
  getAllEdges(): Edge[];
}

interface GroupKBEngine {
  store: KBStore;
  query(text: string, opts?: { includeTrace?: boolean }): Promise<KBQueryResult>;
  ingestDirectory(dirPath: string): Promise<{ groupsCreated: number; memoriesAdded: number }>;
  ingestFile(filePath: string): Promise<{ groupsCreated: number; memoriesAdded: number }>;
  getStats(): Promise<Record<string, unknown>>;
}

interface ChatAgent {
  chat(
    message: string,
    opts: {
      onChunk?: (chunk: StreamChunk) => void;
      onToolCall?: (toolCall: ToolCall, def: ToolDefinition | undefined) => Promise<boolean>;
    },
  ): Promise<LLMMessage>;
  clearHistory(): void;
  getTools(): ToolDefinition[];
}

interface SandboxShellLike {
  execute(command: string): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
  }>;
}

interface GroupTreeNode {
  id: string;
  name: string;
  children: GroupTreeNode[];
  memoryCount: number;
  isDormant: boolean;
}

// ─── Globals ───

const log = createLogger('server');
const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, '../../ui/dist');

let config: SheConfig;
let kbEngine: GroupKBEngine | null = null;
let agent: ChatAgent | null = null;
let sandbox: SandboxShellLike | null = null;

// Chat history is managed by the server to support the history endpoint.
// The agent itself may also keep internal history; this is the authoritative
// copy exposed via the REST API.
let chatHistory: LLMMessage[] = [];

// Pending tool confirmations: maps toolCallId -> resolver
const pendingConfirmations = new Map<string, {
  resolve: (confirmed: boolean) => void;
  toolCall: ToolCall;
  definition: ToolDefinition | undefined;
}>();

// ─── MIME Types ───

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

// ─── Dynamic Module Loader ───

async function loadDependencies(cfg: SheConfig): Promise<void> {
  const KB_PKG = '@she/kb';
  const CORE_PKG = '@she/core';
  const SANDBOX_PKG = '@she/sandbox';

  try {
    const kbMod: Record<string, unknown> = await import(KB_PKG);
    const KBStoreCtor = kbMod.KBStore as new (dbPath: string) => KBStore;
    const GroupKBEngineCtor = kbMod.GroupKBEngine as new (
      store: KBStore,
      kbConfig: SheConfig['kb'],
    ) => GroupKBEngine;
    const store = new KBStoreCtor(cfg.kb.dbPath);
    kbEngine = new GroupKBEngineCtor(store, cfg.kb);
    log.info('KB engine initialized');
  } catch (err) {
    log.warn(`KB package unavailable: ${(err as Error).message}`);
  }

  try {
    const sandboxMod: Record<string, unknown> = await import(SANDBOX_PKG);
    const SandboxShellCtor = sandboxMod.SandboxShell as new (
      sandboxConfig: SheConfig['sandbox'],
    ) => SandboxShellLike;
    sandbox = new SandboxShellCtor(cfg.sandbox);
    log.info('Sandbox initialized');
  } catch (err) {
    log.warn(`Sandbox package unavailable: ${(err as Error).message}`);
  }

  try {
    const coreMod: Record<string, unknown> = await import(CORE_PKG);
    const AgentCtor = coreMod.Agent as new (opts: {
      config: SheConfig;
      engine: unknown;
      sandbox: unknown;
    }) => ChatAgent;
    agent = new AgentCtor({ config: cfg, engine: kbEngine, sandbox });
    log.info('Agent initialized');
  } catch (err) {
    log.warn(`Core package unavailable: ${(err as Error).message}`);
  }
}

// ─── Guard Helpers ───

function requireKB(): GroupKBEngine {
  if (!kbEngine) throw new HttpError(503, 'KB engine not available');
  return kbEngine;
}

function requireAgent(): ChatAgent {
  if (!agent) throw new HttpError(503, 'Agent not available');
  return agent;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ─── Static File Server ───

function serveStaticFile(res: import('node:http').ServerResponse, filePath: string): void {
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.byteLength,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...corsHeaders(),
  });
  res.end(content);
}

function tryServeStatic(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): boolean {
  if (!existsSync(UI_DIR)) return false;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const safePath = decodeURIComponent(url.pathname).replace(/\.\./g, '');
  const filePath = join(UI_DIR, safePath);

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    serveStaticFile(res, filePath);
    return true;
  }

  const indexPath = join(UI_DIR, 'index.html');
  if (existsSync(indexPath)) {
    serveStaticFile(res, indexPath);
    return true;
  }

  return false;
}

// ─── KB Tree Builder ───

function buildGroupTree(engine: GroupKBEngine): GroupTreeNode[] {
  const allGroups = engine.store.getAllGroups();
  const roots = allGroups.filter((g) => g.parentGroupId === null);

  function buildNode(group: Group): GroupTreeNode {
    const children = engine.store.getGroupChildren(group.id);
    return {
      id: group.id,
      name: group.name,
      children: children.map(buildNode),
      memoryCount: group.stats.totalMemories,
      isDormant: group.isDormant,
    };
  }

  return roots.map(buildNode);
}

// ─── Route Registration ───

function registerRoutes(router: Router): void {
  // ── Health ──

  router.get('/api/health', (_req, res) => {
    sendJSON(res, {
      status: 'ok',
      version: '0.1.0',
      kbReady: kbEngine !== null,
    });
  });

  // ── Chat ──

  router.post('/api/chat', async (req, res) => {
    const body = await parseBody<{ message: string; stream?: boolean }>(req);
    if (!body.message) {
      throw new HttpError(400, 'Missing required field: message');
    }

    const chatAgent = requireAgent();
    chatHistory.push({ role: 'user', content: body.message });

    if (body.stream) {
      startSSE(res);
      try {
        const reply = await chatAgent.chat(body.message, {
          onChunk(chunk: StreamChunk) {
            sendSSEEvent(res, chunk);
          },
          async onToolCall(toolCall: ToolCall, def: ToolDefinition | undefined): Promise<boolean> {
            if (!def?.isDangerous) return true;
            return new Promise<boolean>((resolveConfirm) => {
              pendingConfirmations.set(toolCall.id, {
                resolve: resolveConfirm,
                toolCall,
                definition: def,
              });
              sendSSEEvent(res, {
                type: 'tool_call_start',
                toolCall,
                needsConfirmation: true,
              });
            });
          },
        });
        chatHistory.push(reply);
        sendSSEEvent(res, { type: 'done', content: reply.content });
        endSSE(res);
      } catch (err) {
        sendSSEEvent(res, { type: 'error', error: (err as Error).message });
        endSSE(res);
      }
      return;
    }

    const reply = await chatAgent.chat(body.message, {
      async onToolCall(toolCall: ToolCall, def: ToolDefinition | undefined): Promise<boolean> {
        if (!def?.isDangerous) return true;
        return new Promise<boolean>((resolveConfirm) => {
          pendingConfirmations.set(toolCall.id, {
            resolve: resolveConfirm,
            toolCall,
            definition: def,
          });
        });
      },
    });
    chatHistory.push(reply);
    sendJSON(res, {
      role: reply.role,
      content: reply.content,
      toolCalls: reply.tool_calls ?? undefined,
    });
  });

  router.post('/api/chat/confirm', async (req, res) => {
    const body = await parseBody<{ toolCallId: string; confirmed: boolean }>(req);
    if (!body.toolCallId || typeof body.confirmed !== 'boolean') {
      throw new HttpError(400, 'Missing required fields: toolCallId, confirmed');
    }

    const pending = pendingConfirmations.get(body.toolCallId);
    if (!pending) {
      throw new HttpError(404, `No pending confirmation for tool call: ${body.toolCallId}`);
    }

    pendingConfirmations.delete(body.toolCallId);
    pending.resolve(body.confirmed);
    sendJSON(res, { ok: true, confirmed: body.confirmed });
  });

  router.get('/api/chat/history', (_req, res) => {
    sendJSON(res, { messages: chatHistory });
  });

  router.delete('/api/chat/history', (_req, res) => {
    const chatAgent = agent;
    if (chatAgent) chatAgent.clearHistory();
    chatHistory = [];
    sendJSON(res, { ok: true });
  });

  // ── KB Groups ──

  router.get('/api/kb/groups', (_req, res) => {
    const kb = requireKB();
    sendJSON(res, { groups: kb.store.getAllGroups() });
  });

  router.get('/api/kb/groups/:id', (_req, res, params) => {
    const kb = requireKB();
    const group = kb.store.getGroup(params.id);
    if (!group) throw new HttpError(404, `Group not found: ${params.id}`);
    const children = kb.store.getGroupChildren(params.id);
    const memories = kb.store.getGroupMemories(params.id);
    sendJSON(res, { group, children, memories });
  });

  router.post('/api/kb/groups', async (req, res) => {
    const body = await parseBody<{ name: string; parentId?: string }>(req);
    if (!body.name) throw new HttpError(400, 'Missing required field: name');

    const kb = requireKB();
    const group = kb.store.createGroup(body.name, body.parentId);
    sendJSON(res, group, 201);
  });

  // ── KB Query / Ingest ──

  router.post('/api/kb/query', async (req, res) => {
    const body = await parseBody<{ query: string; budget?: number }>(req);
    if (!body.query) throw new HttpError(400, 'Missing required field: query');

    const kb = requireKB();
    const result = await kb.query(body.query, { includeTrace: true });
    sendJSON(res, result);
  });

  router.post('/api/kb/ingest', async (req, res) => {
    const body = await parseBody<{ path: string }>(req);
    if (!body.path) throw new HttpError(400, 'Missing required field: path');

    const kb = requireKB();
    const absPath = resolve(config.workspace.root, body.path);
    const isDir = existsSync(absPath) && statSync(absPath).isDirectory();
    const result = isDir
      ? await kb.ingestDirectory(absPath)
      : await kb.ingestFile(absPath);
    sendJSON(res, { groupsCreated: result.groupsCreated, memoriesAdded: result.memoriesAdded });
  });

  // ── KB Stats / Tree ──

  router.get('/api/kb/stats', async (_req, res) => {
    const kb = requireKB();
    const stats = await kb.getStats();

    const allGroups = kb.store.getAllGroups();
    const allMemories = kb.store.getAllMemories();
    const allEdges = kb.store.getAllEdges();
    const dormantCount = allMemories.filter((m) => m.isDormant).length;

    const topMemories = [...allMemories]
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 10)
      .map((m) => ({ id: m.id, title: m.title, accessCount: m.accessCount }));

    sendJSON(res, {
      totalGroups: allGroups.length,
      totalMemories: allMemories.length,
      totalEdges: allEdges.length,
      dormancyRatio: allMemories.length > 0 ? dormantCount / allMemories.length : 0,
      topMemories,
      ...stats,
    });
  });

  router.get('/api/kb/tree', (_req, res) => {
    const kb = requireKB();
    const tree = buildGroupTree(kb);
    sendJSON(res, { tree });
  });

  // ── KB Memories ──

  router.post('/api/kb/memories', async (req, res) => {
    const body = await parseBody<{ groupId: string; kind: string; title: string; content: string }>(req);
    if (!body.groupId || !body.kind || !body.title || !body.content) {
      throw new HttpError(400, 'Missing required fields: groupId, kind, title, content');
    }

    const kb = requireKB();
    const memory = kb.store.addMemory(body.groupId, body.kind, body.title, body.content);
    sendJSON(res, memory, 201);
  });

  // ── KB Edges ──

  router.post('/api/kb/edges', async (req, res) => {
    const body = await parseBody<{ sourceId: string; targetId: string; kind: EdgeKind; evidence?: string }>(req);
    if (!body.sourceId || !body.targetId || !body.kind) {
      throw new HttpError(400, 'Missing required fields: sourceId, targetId, kind');
    }

    const kb = requireKB();
    const edge = kb.store.addEdge(body.sourceId, body.targetId, body.kind, body.evidence);
    sendJSON(res, edge, 201);
  });
}

// ─── Server Startup ───

export async function startServer(overrideConfig?: SheConfig): Promise<void> {
  config = overrideConfig ?? loadConfig();
  const { port, host } = config.server;

  log.info('Loading dependencies...');
  await loadDependencies(config);

  const router = new Router();
  registerRoutes(router);

  const server = createServer(async (req, res) => {
    const start = Date.now();
    const method = req.method || 'GET';
    const url = req.url || '/';

    try {
      const handled = await router.handle(req, res);
      if (!handled) {
        if (method === 'GET' && !url.startsWith('/api/')) {
          const served = tryServeStatic(req, res);
          if (!served) {
            sendError(res, 'Not Found', 404);
          }
        } else {
          sendError(res, 'Not Found', 404);
        }
      }
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof HttpError) {
          sendError(res, err.message, err.status);
        } else {
          log.error(`Unhandled error: ${(err as Error).message}`);
          sendError(res, 'Internal Server Error', 500);
        }
      }
    }

    const duration = Date.now() - start;
    log.info(`${method} ${url} ${res.statusCode} ${duration}ms`);
  });

  server.listen(port, host, () => {
    const pad = (s: string, len: number) => s + ' '.repeat(Math.max(0, len - s.length));
    const url = `http://${host}:${port}`;
    const w = 38;
    const banner = [
      '',
      '  ┌' + '─'.repeat(w) + '┐',
      '  │' + ' '.repeat(w) + '│',
      '  │  SHE Agent Server v0.1.0' + ' '.repeat(w - 27) + '│',
      '  │' + ' '.repeat(w) + '│',
      '  │  ' + pad(`Local:   ${url}`, w - 2) + '│',
      '  │' + ' '.repeat(w) + '│',
      '  │  ' + pad(`KB:      ${kbEngine ? '✓ ready' : '✗ unavailable'}`, w - 2) + '│',
      '  │  ' + pad(`Agent:   ${agent ? '✓ ready' : '✗ unavailable'}`, w - 2) + '│',
      '  │  ' + pad(`Sandbox: ${sandbox ? '✓ ready' : '✗ unavailable'}`, w - 2) + '│',
      '  │' + ' '.repeat(w) + '│',
      '  └' + '─'.repeat(w) + '┘',
      '',
    ];
    for (const line of banner) console.log(line);
    log.info(`Server listening on ${url}`);
  });

  process.on('SIGINT', () => {
    log.info('Shutting down...');
    server.close(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    log.info('Shutting down...');
    server.close(() => process.exit(0));
  });
}

startServer().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
