import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, loadConfig } from '@she/shared';
import type { SheConfig, StreamChunk, EdgeKind } from '@she/shared';
import { KBStore, GroupKBEngine } from '@she/kb';
import { SandboxShell, createTools } from '@she/sandbox';
import { Agent } from '@she/agent-runtime';
import { Router, sendJSON, sendError, sendSSEEvent, startSSE, endSSE, parseBody, corsHeaders } from './router.js';

const log = createLogger('server');
const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, '../../ui/dist');

let config: SheConfig;
let store: KBStore;
let engine: GroupKBEngine;
let agent: Agent;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.webp': 'image/webp',
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

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

interface GroupTreeNode {
  id: string;
  name: string;
  children: GroupTreeNode[];
  memoryCount: number;
  isDormant: boolean;
}

function buildGroupTree(): GroupTreeNode[] {
  const allGroups = store.getAllGroups();
  const roots = allGroups.filter(g => g.parentGroupId === null);

  function buildNode(groupId: string): GroupTreeNode {
    const group = store.getGroup(groupId);
    if (!group) return { id: groupId, name: '?', children: [], memoryCount: 0, isDormant: false };
    return {
      id: group.id,
      name: group.name,
      children: group.childGroupIds.map(buildNode),
      memoryCount: group.stats.totalMemories,
      isDormant: group.isDormant,
    };
  }

  return roots.map(r => buildNode(r.id));
}

function registerRoutes(router: Router): void {
  router.get('/api/health', (_req, res) => {
    sendJSON(res, { status: 'ok', version: '0.1.0', kbReady: !!store });
  });

  router.post('/api/chat', async (req, res) => {
    const body = await parseBody<{ message: string; stream?: boolean }>(req);
    if (!body.message) throw new HttpError(400, 'Missing required field: message');

    if (body.stream) {
      startSSE(res);
      try {
        const reply = await agent.chat(body.message, (chunk: StreamChunk) => {
          sendSSEEvent(res, chunk);
        });
        sendSSEEvent(res, { type: 'done', content: reply.content });
        endSSE(res);
      } catch (err) {
        sendSSEEvent(res, { type: 'error', error: (err as Error).message });
        endSSE(res);
      }
      return;
    }

    const reply = await agent.chat(body.message);
    sendJSON(res, { role: reply.role, content: reply.content, toolCalls: reply.tool_calls });
  });

  router.get('/api/chat/history', (_req, res) => {
    sendJSON(res, { messages: agent.getHistory() });
  });

  router.delete('/api/chat/history', (_req, res) => {
    agent.clearHistory();
    sendJSON(res, { ok: true });
  });

  router.get('/api/kb/groups', (_req, res) => {
    sendJSON(res, { groups: store.getAllGroups() });
  });

  router.get('/api/kb/groups/:id', (_req, res, params) => {
    const group = store.getGroup(params.id);
    if (!group) throw new HttpError(404, `Group not found: ${params.id}`);
    const children = group.childGroupIds
      .map(id => store.getGroup(id))
      .filter(Boolean);
    const memories = store.getMemoriesByGroup(params.id);
    sendJSON(res, { group, children, memories });
  });

  router.post('/api/kb/groups', async (req, res) => {
    const body = await parseBody<{ name: string; parentId?: string }>(req);
    if (!body.name) throw new HttpError(400, 'Missing required field: name');
    const group = engine.createGroup(body.name, body.parentId);
    sendJSON(res, group, 201);
  });

  router.post('/api/kb/query', async (req, res) => {
    const body = await parseBody<{ query: string; budget?: number }>(req);
    if (!body.query) throw new HttpError(400, 'Missing required field: query');
    const result = engine.query(body.query, { budget: body.budget });
    sendJSON(res, result);
  });

  router.post('/api/kb/ingest', async (req, res) => {
    const body = await parseBody<{ path: string }>(req);
    if (!body.path) throw new HttpError(400, 'Missing required field: path');

    const absPath = resolve(config.workspace.root, body.path);
    if (!existsSync(absPath)) throw new HttpError(404, `Path not found: ${body.path}`);

    const isDir = statSync(absPath).isDirectory();
    if (isDir) {
      engine.ingestDirectory(absPath);
    } else {
      engine.ingestFile(absPath);
    }
    const stats = store.getStats();
    sendJSON(res, { groupsCreated: stats.totalGroups, memoriesAdded: stats.totalMemories });
  });

  router.get('/api/kb/stats', (_req, res) => {
    const stats = store.getStats();
    const allGroups = store.getAllGroups();
    const allMems = allGroups.flatMap(g =>
      g.memoryIds.map(id => store.getMemory(id)).filter(Boolean)
    );
    const dormantCount = allMems.filter(m => m!.isDormant).length;
    sendJSON(res, {
      ...stats,
      dormancyRatio: allMems.length > 0 ? dormantCount / allMems.length : 0,
    });
  });

  router.get('/api/kb/tree', (_req, res) => {
    sendJSON(res, { tree: buildGroupTree() });
  });

  router.post('/api/kb/memories', async (req, res) => {
    const body = await parseBody<{ groupId: string; kind: string; title: string; content: string }>(req);
    if (!body.groupId || !body.title || !body.content) {
      throw new HttpError(400, 'Missing required fields');
    }
    const validKinds = ['text', 'code', 'fact', 'tool_outcome', 'preference'] as const;
    const kind = validKinds.includes(body.kind as any) ? body.kind as any : 'text';
    const mem = engine.addMemory(body.groupId, kind, body.title, body.content);
    sendJSON(res, mem, 201);
  });

  router.post('/api/kb/edges', async (req, res) => {
    const body = await parseBody<{ sourceId: string; targetId: string; kind: EdgeKind; evidence?: string; falsifiers?: string[] }>(req);
    if (!body.sourceId || !body.targetId || !body.kind) {
      throw new HttpError(400, 'Missing required fields');
    }
    const edge = engine.addTypedEdge(body.sourceId, body.targetId, body.kind, {
      evidence: body.evidence,
      falsifiers: body.falsifiers,
    });
    sendJSON(res, edge, 201);
  });
}

export async function startServer(overrideConfig?: SheConfig): Promise<void> {
  config = overrideConfig ?? loadConfig();
  const { port, host } = config.server;

  const dbDir = dirname(config.kb.dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  store = new KBStore(config.kb.dbPath);
  engine = new GroupKBEngine(store, config.kb);

  const shell = new SandboxShell(config.workspace.root, config.sandbox);
  const tools = createTools(shell, config.workspace.root);
  agent = new Agent(config, engine, tools);

  log.info('All components initialized');

  const router = new Router();
  registerRoutes(router);

  const server = createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';
    const start = Date.now();

    try {
      const handled = await router.handle(req, res);
      if (!handled) {
        if (method === 'GET' && !url.startsWith('/api/')) {
          if (!tryServeStatic(req, res)) {
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
          log.error(`Error: ${(err as Error).message}`);
          sendError(res, 'Internal Server Error', 500);
        }
      }
    }

    log.info(`${method} ${url} ${res.statusCode} ${Date.now() - start}ms`);
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log('');
    console.log('  ┌──────────────────────────────────────┐');
    console.log('  │                                      │');
    console.log('  │  SHE v2 Agent Server                 │');
    console.log('  │                                      │');
    console.log(`  │  Local:   ${url.padEnd(26)}│`);
    console.log('  │                                      │');
    console.log('  │  KB:      ✓ ready                    │');
    console.log('  │  Agent:   ✓ ready                    │');
    console.log('  │  Sandbox: ✓ ready                    │');
    console.log('  │                                      │');
    console.log('  └──────────────────────────────────────┘');
    console.log('');
  });

  process.on('SIGINT', () => { server.close(() => process.exit(0)); });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
}

startServer().catch(err => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
