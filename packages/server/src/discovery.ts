import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import type { LLMMessage } from '@she/shared';
import { transcriptToMessages } from './transcript.js';

const require = createRequire(import.meta.url);

export type ContextSource = 'cursor' | 'claude-code' | 'codex';

export interface DiscoveredConversation {
  /** Stable id used by the UI to select this item. */
  id: string;
  source: ContextSource;
  title: string;
  /** Absolute path of the underlying record. */
  path: string;
  /** Human workspace/project label. */
  project?: string;
  messageCount: number;
  updatedAt?: string;
  sizeBytes: number;
  /** True when we can read the content directly (no DB copy needed). */
  readable: boolean;
}

export interface DiscoveryResult {
  sources: {
    id: ContextSource;
    label: string;
    /** Where we looked. */
    root: string;
    found: boolean;
    conversations: DiscoveredConversation[];
    note?: string;
  }[];
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(p: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

// ─── Claude Code: ~/.claude/projects/<encoded-path>/*.jsonl ──────────────────

function discoverClaudeCode(): DiscoveryResult['sources'][number] {
  const root = join(homedir(), '.claude', 'projects');
  const found = existsSync(root);
  const conversations: DiscoveredConversation[] = [];

  if (found) {
    for (const projectDir of safeReaddir(root)) {
      const projPath = join(root, projectDir);
      try {
        if (!statSync(projPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Directory names encode the original path with dashes.
      const project = projectDir.replace(/^([A-Z])--/, '$1:/').replace(/-/g, '/');

      for (const file of safeReaddir(projPath)) {
        if (!file.toLowerCase().endsWith('.jsonl')) continue;
        const full = join(projPath, file);
        const st = safeStat(full);
        if (!st) continue;

        // Count real user/assistant turns without loading the whole file twice.
        let messageCount = 0;
        let firstUserText = '';
        try {
          const lines = readFileSync(full, 'utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const j = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
              const role = j.message?.role ?? j.type;
              if (role === 'user' || role === 'assistant') {
                messageCount++;
                if (!firstUserText && role === 'user') {
                  const c = j.message?.content;
                  firstUserText = typeof c === 'string'
                    ? c
                    : Array.isArray(c)
                      ? c.map((x: { text?: string }) => x?.text ?? '').join(' ')
                      : '';
                }
              }
            } catch { /* skip malformed line */ }
          }
        } catch { /* unreadable */ }

        conversations.push({
          id: `claude-code:${full}`,
          source: 'claude-code',
          title: (firstUserText || basename(file, '.jsonl')).slice(0, 80).replace(/\s+/g, ' ').trim(),
          project,
          path: full,
          messageCount,
          updatedAt: new Date(st.mtimeMs).toISOString(),
          sizeBytes: st.size,
          readable: true,
        });
      }
    }
  }

  conversations.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return {
    id: 'claude-code',
    label: 'Claude Code',
    root,
    found,
    conversations,
    note: found ? undefined : '未找到 ~/.claude/projects',
  };
}

// ─── Cursor ─────────────────────────────────────────────────────────────────
//
// Cursor keeps a compact conversation INDEX at
// globalStorage/conversation-search.db (tens of MB) and the heavy content in
// globalStorage/state.vscdb, which on this machine was 27 GB. We therefore:
//   - discover from the small index (fast, cheap)
//   - read content from state.vscdb opened READ-ONLY, never copied
// Copying state.vscdb is what previously filled the disk.

interface SqliteDb {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
  close: () => void;
}

function openSqlite(file: string): SqliteDb | null {
  try {
    const Database = require('better-sqlite3') as new (p: string, o?: unknown) => SqliteDb;
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function cursorGlobalStorage(): string {
  return process.env.APPDATA
    ? join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage')
    : join(homedir(), '.config', 'Cursor', 'User', 'globalStorage');
}

/**
 * Cursor conversation discovery.
 *
 * Cursor splits its data across:
 *   - conversation-search.db : a small index (titles, but only ~3% populated)
 *   - state.vscdb            : the real store
 *       cursorDiskKV  : bubbleId:<composerId>:<bubbleId>  (the messages)
 *       composerHeaders: one row per conversation, WITH workspaceId
 *
 * We use composerHeaders for the conversation list (that's what gives us the
 * "which workspace, which chat" identity) and cursorDiskKV for content.
 */
function discoverCursor(): DiscoveryResult['sources'][number] {
  const gs = cursorGlobalStorage();
  const root = gs;
  const heavy = join(gs, 'state.vscdb');
  const found = existsSync(heavy);
  const conversations: DiscoveredConversation[] = [];
  let note: string | undefined;

  if (!found) {
    return {
      id: 'cursor',
      label: 'Cursor',
      root,
      found: false,
      conversations,
      note: '未找到 Cursor 数据（state.vscdb）',
    };
  }

  const db = openSqlite(heavy);
  if (!db) {
    return {
      id: 'cursor',
      label: 'Cursor',
      root,
      found: true,
      conversations,
      note: '需要 better-sqlite3 才能读取 Cursor 数据',
    };
  }

  try {
    // Workspace id -> folder, so a conversation can name its project.
    const wsNames = new Map<string, string>();
    try {
      const wsRoot = join(gs, '..', 'workspaceStorage');
      for (const hash of safeReaddir(wsRoot)) {
        try {
          const wj = join(wsRoot, hash, 'workspace.json');
          if (!existsSync(wj)) continue;
          const j = JSON.parse(readFileSync(wj, 'utf8')) as { folder?: string };
          const folder = j.folder?.replace(/^file:\/\/\//, '').replace(/%20/g, ' ');
          if (folder) wsNames.set(hash, folder.replace(/\\/g, '/').split('/').pop() || folder);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    const rows = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived
         FROM composerHeaders
         WHERE isArchived IS NULL OR isArchived = 0
         ORDER BY lastUpdatedAt DESC
         LIMIT 500`,
      )
      .all() as {
        composerId: string;
        workspaceId: string | null;
        createdAt: number | null;
        lastUpdatedAt: number | null;
        isArchived: number | null;
      }[];

    for (const r of rows) {
      // Pull the first user message for a meaningful title.
      let title = '';
      let messageCount = 0;
      try {
        const dataRow = db
          .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
          .get(`composerData:${r.composerId}`) as { value: unknown } | undefined;
        if (dataRow) {
          const parsed = typeof dataRow.value === 'string'
            ? JSON.parse(dataRow.value) as { name?: string; text?: string }
            : null;
          title = (parsed?.name ?? parsed?.text ?? '').trim();
        }
      } catch { /* ignore */ }

      // Count bubbles with GLOB, not LIKE.
      // `LIKE 'prefix%'` cannot use the index on `key` and costs ~430ms per
      // call on a multi-GB store; with one call per conversation that alone
      // made discovery take minutes. `GLOB 'prefix*'` is index-friendly (~0ms).
      try {
        const c = db
          .prepare('SELECT COUNT(*) AS c FROM cursorDiskKV WHERE key GLOB ?')
          .get(`bubbleId:${r.composerId}:*`) as { c: number };
        messageCount = c.c ?? 0;
      } catch { /* ignore */ }

      const project = r.workspaceId ? wsNames.get(r.workspaceId) : undefined;
      const when = r.lastUpdatedAt
        ? new Date(r.lastUpdatedAt).toISOString()
        : r.createdAt
          ? new Date(r.createdAt).toISOString()
          : undefined;

      conversations.push({
        id: `cursor:${r.composerId}`,
        source: 'cursor',
        title: (title || `对话 ${r.composerId.slice(0, 8)}`).slice(0, 90),
        path: heavy,
        project,
        messageCount,
        updatedAt: when,
        sizeBytes: 0,
        readable: messageCount > 0,
      });
    }

    note = `${conversations.length} 个对话${conversations.some((c) => c.project) ? '（含工作区归属）' : ''}`;
  } catch (e) {
    note = `读取 Cursor 数据失败: ${(e as Error).message}`;
  } finally {
    db.close();
  }

  return { id: 'cursor', label: 'Cursor', root, found: true, conversations, note };
}

// ─── Codex: ~/.codex/sessions/** ────────────────────────────────────────────

function discoverCodex(): DiscoveryResult['sources'][number] {
  const root = join(homedir(), '.codex', 'sessions');
  const found = existsSync(root);
  const conversations: DiscoveredConversation[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 4) return;
    for (const entry of safeReaddir(dir)) {
      const full = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (isDir) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.(jsonl|json)$/i.test(entry)) continue;
      const st = safeStat(full);
      if (!st) continue;
      let messageCount = 0;
      try {
        messageCount = readFileSync(full, 'utf8').split('\n').filter((l) => l.trim()).length;
      } catch { /* ignore */ }
      conversations.push({
        id: `codex:${full}`,
        source: 'codex',
        title: basename(full).replace(/\.(jsonl|json)$/i, ''),
        path: full,
        messageCount,
        updatedAt: new Date(st.mtimeMs).toISOString(),
        sizeBytes: st.size,
        readable: true,
      });
    }
  }

  if (found) walk(root, 0);
  conversations.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  return {
    id: 'codex',
    label: 'Codex',
    root,
    found,
    conversations,
    note: found ? undefined : '未找到 ~/.codex/sessions（本机可能没装 Codex CLI）',
  };
}

/** Scan the machine for importable conversation records from the big three. */
export function discoverConversations(): DiscoveryResult {
  return { sources: [discoverCursor(), discoverClaudeCode(), discoverCodex()] };
}

function cellText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('utf8');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return null;
}

/**
 * Cursor's real transcript. Bubble rows are keyed by UUID, so reading them in
 * key order scrambles the conversation. The header list is the order the
 * product shows; bubbles not listed there fall in by timestamp.
 */
function readCursorRecord(conv: DiscoveredConversation): string | null {
  const composerId = conv.id.replace(/^cursor:/, '');
  const heavy = join(cursorGlobalStorage(), 'state.vscdb');
  if (!existsSync(heavy)) return null;
  const db = openSqlite(heavy);
  if (!db) return null;
  try {
    const dataRow = db
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${composerId}`) as { value: unknown } | undefined;
    let composer: Record<string, unknown> | null = null;
    if (dataRow) {
      const raw = cellText(dataRow.value);
      if (raw) {
        try { composer = JSON.parse(raw) as Record<string, unknown>; } catch { composer = null; }
      }
    }
    const headers = (composer?.fullConversationHeadersOnly
      ?? composer?.conversationHeaders
      ?? []) as { bubbleId?: string }[];
    const bubbles: Record<string, unknown> = {};
    const put = (id: string, value: unknown) => {
      const text = cellText(value);
      if (!id || !text) return;
      try { bubbles[id] = JSON.parse(text); } catch { /* skip a bad row */ }
    };

    if (Array.isArray(headers) && headers.length) {
      const stmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
      for (const h of headers) {
        const id = String(h?.bubbleId || '');
        if (!id) continue;
        const row = stmt.get(`bubbleId:${composerId}:${id}`) as { value: unknown } | undefined;
        if (row) put(id, row.value);
      }
    }
    if (!Object.keys(bubbles).length) {
      // GLOB, not LIKE: the key index can serve `prefix*`. LIKE cannot.
      const rows = db
        .prepare('SELECT key, value FROM cursorDiskKV WHERE key GLOB ? LIMIT 2000')
        .all(`bubbleId:${composerId}:*`) as { key: string; value: unknown }[];
      for (const row of rows) {
        const id = String(row.key).split(':').slice(2).join(':');
        put(id, row.value);
      }
    }
    if (!Object.keys(bubbles).length) return null;
    return JSON.stringify({
      schema: 'she.cursor-record.v1',
      fullConversationHeadersOnly: Array.isArray(headers) ? headers : [],
      bubbles,
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * The conversation as messages, read from the original record.
 *
 * File-backed sources are parsed from the file itself — not from a markdown
 * rendering of it. That rendering was lossy (roles, tool calls, and thinking
 * all fell out) and it is what the copy is supposed to replace as the thing
 * you open.
 */
export function loadTranscript(
  conv: DiscoveredConversation,
): { messages: LLMMessage[]; truncated: number } | null {
  try {
    let text: string | null = null;
    if (conv.source === 'cursor') text = readCursorRecord(conv);
    else if (conv.readable && existsSync(conv.path)) text = readFileSync(conv.path, 'utf8');
    if (!text?.trim()) return null;
    const result = transcriptToMessages(conv.source, text);
    return result.messages.length ? result : null;
  } catch {
    return null;
  }
}

/**
 * Read one discovered conversation as plain text suitable for KB ingestion.
 * Returns null when the record cannot be read.
 */
export function readConversation(conv: DiscoveredConversation): string | null {
  const loaded = loadTranscript(conv);
  if (!loaded) return null;
  const parts = loaded.messages.map((m) => {
    const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具' : m.role;
    const thinking = m.reasoning ? `\n\n<thinking>\n${m.reasoning}\n</thinking>` : '';
    return `## ${label}\n\n${m.content || ''}${thinking}`.trim();
  });
  return parts.join('\n\n') || null;
}


/** Safe filename fragment for imported context files. */
function safeName(s: string): string {
  return (s || 'conversation')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'conversation';
}

/** Human folder names under .she/imports/ (not raw source ids). */
export function importSourceFolder(source: ContextSource | string): string {
  switch (source) {
    case 'cursor': return 'Cursor';
    case 'claude-code': return 'Claude';
    case 'codex': return 'Codex';
    default: return String(source);
  }
}


export interface MaterializedContext {
  /** Absolute path of the adapted/copied file inside the workspace. */
  absPath: string;
  /** Path relative to workspace root, using forward slashes. */
  relPath: string;
  source: ContextSource;
  title: string;
  /** true when the bytes are a straight copy of the origin file. */
  copiedOriginal: boolean;
  bytes: number;
}

/**
 * Materialize an external conversation into the workspace as a real file.
 *
 * This is the import path the product wants: adapt + copy (or extract) the
 * original record onto disk, then let the agent read that file — NOT paste the
 * whole transcript into the chat as one giant user message.
 *
 * Layout:  <workspace>/.she/imports/<Cursor|Claude|Codex>/<日期>-<标题>.(jsonl|json)
 */
export function materializeConversation(
  conv: DiscoveredConversation,
  workspaceRoot: string,
  preloaded?: { messages: LLMMessage[] } | null,
): MaterializedContext | null {
  const stamp = (conv.updatedAt ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '');
  const dir = join(workspaceRoot, '.she', 'imports', importSourceFolder(conv.source));
  mkdirSync(dir, { recursive: true });

  const base = `${stamp}-${safeName(conv.title)}`;

  // File-backed sources: copy the original bytes, then drop a tiny adapter sidecar.
  if ((conv.source === 'claude-code' || conv.source === 'codex') && existsSync(conv.path) && conv.readable) {
    const ext = conv.path.toLowerCase().endsWith('.jsonl') ? '.jsonl' : pathExt(conv.path);
    let dest = join(dir, base + ext);
    let n = 0;
    while (existsSync(dest)) {
      n += 1;
      dest = join(dir, `${base}-${n}${ext}`);
    }
    copyFileSync(conv.path, dest);
    const meta = {
      schema: 'she.import.meta.v1',
      source: conv.source,
      title: conv.title,
      project: conv.project ?? null,
      originPath: conv.path,
      importedAt: new Date().toISOString(),
      adapter: conv.source === 'claude-code' ? 'claude-code-jsonl' : 'codex-export',
      note: 'Original file copied. Read this file directly; do not expect the chat transcript to contain a paste of it.',
    };
    writeFileSync(dest + '.meta.json', JSON.stringify(meta, null, 2) + '\n', 'utf8');
    const st = safeStat(dest);
    return {
      absPath: dest,
      relPath: relToWorkspace(workspaceRoot, dest),
      source: conv.source,
      title: conv.title,
      copiedOriginal: true,
      bytes: st?.size ?? 0,
    };
  }

  // Cursor (and anything else DB-backed): extract turns into a SHE-native JSON
  // — we cannot ship state.vscdb (multi-GB) as the "original file".
  // The messages are the structured transcript, not a markdown rendering of it.
  const messages = preloaded?.messages?.length
    ? preloaded.messages
    : (loadTranscript(conv)?.messages ?? []);
  if (!messages.length) return null;

  const payload = {
    schema: 'she.imported-context.v1',
    source: conv.source,
    title: conv.title,
    project: conv.project ?? null,
    originPath: conv.path,
    originId: conv.id,
    importedAt: new Date().toISOString(),
    messageCount: messages.length || conv.messageCount,
    messages,
    note: conv.source === 'cursor'
      ? 'Extracted from Cursor state.vscdb (original DB is not copied). Use this file as the conversation record.'
      : 'Adapted export for Pulse. Prefer reading this file over any chat paste.',
  };

  let dest = join(dir, base + '.json');
  let n = 0;
  while (existsSync(dest)) {
    n += 1;
    dest = join(dir, `${base}-${n}.json`);
  }
  writeFileSync(dest, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  const st = safeStat(dest);
  return {
    absPath: dest,
    relPath: relToWorkspace(workspaceRoot, dest),
    source: conv.source,
    title: conv.title,
    copiedOriginal: false,
    bytes: st?.size ?? 0,
  };
}

function pathExt(p: string): string {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i) : '.txt';
}

function relToWorkspace(workspaceRoot: string, abs: string): string {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const full = abs.replace(/\\/g, '/');
  if (full.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    return full.slice(root.length + 1);
  }
  return full;
}
