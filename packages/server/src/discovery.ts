import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createRequire } from 'node:module';

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

/**
 * Read one discovered conversation as plain text suitable for KB ingestion.
 * Returns null when the record cannot be read.
 */
export function readConversation(conv: DiscoveredConversation): string | null {
  if (!conv.readable) return null;
  try {
    if (conv.source === 'claude-code' || conv.source === 'codex') {
      const lines = readFileSync(conv.path, 'utf8').split('\n').filter((l) => l.trim());
      const out: string[] = [];
      for (const line of lines) {
        try {
          const j = JSON.parse(line) as {
            type?: string;
            message?: { role?: string; content?: unknown };
          };
          const role = j.message?.role ?? j.type;
          if (role !== 'user' && role !== 'assistant') continue;
          const c = j.message?.content;
          const text = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.map((x: { text?: string }) => x?.text ?? '').join('\n')
              : '';
          if (text.trim()) out.push(`## ${role === 'user' ? '用户' : '助手'}\n\n${text}`);
        } catch { /* skip */ }
      }
      return out.join('\n\n') || null;
    }

    // Cursor: read messages from cursorDiskKV, keyed by composer id.
    if (conv.source === 'cursor') {
      const gs = cursorGlobalStorage();
      const heavy = join(gs, 'state.vscdb');
      if (!existsSync(heavy)) return null;

      const db = openSqlite(heavy);
      if (!db) return null;
      try {
        const composerId = conv.id.replace(/^cursor:/, '');
        // GLOB, not LIKE: index-friendly, and this is the hot path when the
        // user actually imports a conversation.
        const rows = db
          .prepare('SELECT key, value FROM cursorDiskKV WHERE key GLOB ? ORDER BY key LIMIT 2000')
          .all(`bubbleId:${composerId}:*`) as { key: string; value: unknown }[];

        const out: string[] = [];
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = typeof row.value === 'string' ? JSON.parse(row.value) : null;
          } catch {
            continue;
          }
          const b = parsed as { type?: number | string; text?: string; richText?: string; role?: string };
          if (!b) continue;

          // Cursor encodes role numerically (1 = user, 2 = assistant).
          const roleRaw = String(b.type ?? b.role ?? '');
          const role = roleRaw === '1' || roleRaw === 'user' ? '用户'
            : roleRaw === '2' || roleRaw === 'assistant' ? '助手'
              : '';

          let text = typeof b.text === 'string' ? b.text : '';
          if (!text && typeof b.richText === 'string') {
            try {
              const rt = JSON.parse(b.richText) as { content?: { content?: { text?: string }[] }[] };
              text = (rt.content ?? []).flatMap((p) => (p.content ?? []).map((x) => x.text ?? '')).join('');
            } catch { /* ignore */ }
          }
          if (!role || !text.trim()) continue;
          out.push(`## ${role}\n\n${text}`);
        }
        return out.length ? out.join('\n\n') : null;
      } catch {
        return null;
      } finally {
        db.close();
      }
    }

    // Generic JSON fallback for anything else.
    return null;
  } catch {
    return null;
  }
}

/** Pull readable turns out of Cursor's loosely-typed conversation payloads. */
function extractCursorText(parsed: unknown): string | null {
  if (!parsed) return null;

  const candidates: unknown[] = [];
  if (Array.isArray(parsed)) candidates.push(...parsed);
  else {
    const o = parsed as { conversation?: unknown[]; messages?: unknown[]; bubbles?: unknown[]; tabs?: unknown[] };
    if (Array.isArray(o.conversation)) candidates.push(...o.conversation);
    if (Array.isArray(o.messages)) candidates.push(...o.messages);
    if (Array.isArray(o.bubbles)) candidates.push(...o.bubbles);
    if (Array.isArray(o.tabs)) candidates.push(...o.tabs);
  }

  const out: string[] = [];
  for (const item of candidates) {
    const b = item as { type?: string; role?: string; text?: string; richText?: string; content?: unknown };
    const roleRaw = b.type ?? b.role ?? '';
    if (roleRaw !== 'user' && roleRaw !== 'assistant' && roleRaw !== 'human' && roleRaw !== 'ai') continue;
    const role = roleRaw === 'user' || roleRaw === 'human' ? '用户' : '助手';

    let text = typeof b.text === 'string' ? b.text : '';
    if (!text && typeof b.content === 'string') text = b.content;
    if (!text && typeof b.richText === 'string') {
      try {
        const rt = JSON.parse(b.richText) as { content?: { content?: { text?: string }[] }[] };
        text = (rt.content ?? []).flatMap((p) => (p.content ?? []).map((x) => x.text ?? '')).join('');
      } catch { /* ignore */ }
    }
    if (text.trim()) out.push(`## ${role}\n\n${text}`);
  }
  return out.join('\n\n') || null;
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
  const text = readConversation(conv);
  if (!text) return null;

  const messages = parseImportedMarkdownTurns(text);
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
      : 'Adapted export for SHE. Prefer reading this file over any chat paste.',
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

/** Split the markdown produced by readConversation into role/content turns. */
function parseImportedMarkdownTurns(text: string): { role: 'user' | 'assistant'; content: string }[] {
  const parts = text.split(/\n(?=## (?:用户|助手|User|Assistant)\b)/);
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const part of parts) {
    const m = part.match(/^##\s*(用户|助手|User|Assistant)\s*\n([\s\S]*)$/);
    if (!m) continue;
    const role = m[1] === '用户' || m[1] === 'User' ? 'user' : 'assistant';
    const content = m[2].trim();
    if (content) out.push({ role, content });
  }
  if (!out.length && text.trim()) {
    out.push({ role: 'user', content: text.trim() });
  }
  return out;
}
