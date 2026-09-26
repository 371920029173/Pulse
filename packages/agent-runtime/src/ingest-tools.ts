import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@she/shared';
import { resolveInsideWorkspace } from '@she/sandbox';
import { resolveLogicalGroup } from '@she/kb';

/**
 * Knowledge ingestion into the group-structure KB.
 *
 * Two stages:
 *  1. `kb_ingest_scan` — deterministic: parse a file/dir into labeled raw ideas
 *     and stage them under a per-batch intake group. No LLM needed.
 *  2. `kb_ingest_place` — the agent (LLM) decides, per item, which EXISTING
 *     group it belongs to (or creates one), i.e. "补充到组结构知识树的对应位置".
 *
 * The split matters: parsing is cheap and repeatable, placement needs judgement
 * and therefore goes through the model. Nothing here writes to the KB directly
 * except through the engine, so edge/group invariants are preserved.
 */

export interface IngestItem {
  id: string;
  title: string;
  text: string;
  /** Where it came from, for traceability. */
  origin: string;
  status: 'pending' | 'placed';
  placedGroup?: string;
}

export interface IngestBatch {
  id: string;
  createdAt: string;
  sourcePath: string;
  /** Staging group that holds un-placed items. */
  intakeGroup: string;
  items: IngestItem[];
}

const SUPPORTED_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.log', '.yaml', '.yml']);

interface EngineLike {
  createGroup(name: string, parentId?: string): { id: string; name: string };
  addMemory(groupId: string, kind: 'text' | 'code' | 'fact' | 'tool_outcome' | 'preference', title: string, content: string): { id: string };
  /** Write that keeps the group within its split limit; used when the engine provides it. */
  addMemoryMaintained?(groupId: string, kind: 'text' | 'code' | 'fact' | 'tool_outcome' | 'preference', title: string, content: string): { id: string };
  addWeakEdge(a: string, b: string): unknown;
  query(q: string, opts?: { budget?: number }): { nodes: { id: string; title: string }[] };
}

interface StoreLike {
  getAllGroups(): { id: string; name: string; parentGroupId: string | null; memoryIds: string[] }[];
  getGroup(id: string): { id: string; name: string; parentGroupId: string | null; memoryIds: string[] } | undefined;
  getMemoriesByGroup(id: string): { id: string; title: string; content: string }[];
}

// ─── text chunking ──────────────────────────────────────────────────────────

/** Split markdown/text on headings, else by paragraph groups. */
function chunkMarkdown(text: string, fileTitle: string): { title: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { title: string; body: string }[] = [];
  let curTitle = fileTitle;
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) out.push({ title: curTitle, body });
    buf = [];
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      curTitle = h[2].trim().slice(0, 120) || fileTitle;
      continue;
    }
    buf.push(line);
  }
  flush();

  // A single huge blob is useless as an "idea" — split it further.
  const MAX = 4000;
  const result: { title: string; body: string }[] = [];
  for (const c of out) {
    if (c.body.length <= MAX) {
      result.push(c);
      continue;
    }
    const paras = c.body.split(/\n{2,}/);
    let acc: string[] = [];
    let part = 1;
    const push = () => {
      const body = acc.join('\n\n').trim();
      if (body) result.push({ title: `${c.title} (${part})`, body });
      acc = [];
      part++;
    };
    for (const p of paras) {
      acc.push(p);
      if (acc.join('\n\n').length > MAX) push();
    }
    push();
  }
  return result;
}

/** Turn JSON / JSONL into titled records. */
function chunkJson(text: string, fileTitle: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];

  const pushValue = (v: unknown, hint: string) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => pushValue(item, `${hint}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const title = String(o.title ?? o.name ?? o.role ?? o.type ?? hint).slice(0, 120);
      const content = String(o.content ?? o.text ?? o.message ?? '');
      if (content.trim()) {
        out.push({ title, body: content.trim() });
      } else {
        const body = JSON.stringify(v, null, 2);
        if (body.length < 20000) out.push({ title, body });
      }
      return;
    }
    const s = String(v ?? '').trim();
    if (s) out.push({ title: hint, body: s });
  };

  // JSONL first
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const looksJsonl = lines.length > 1 && lines.every((l) => l.trim().startsWith('{') || l.trim().startsWith('['));
  if (looksJsonl) {
    lines.forEach((line, i) => {
      try {
        pushValue(JSON.parse(line), `${fileTitle}#${i + 1}`);
      } catch {
        out.push({ title: `${fileTitle}#${i + 1}`, body: line.trim() });
      }
    });
    return out;
  }

  try {
    pushValue(JSON.parse(text), fileTitle);
  } catch {
    // Not valid JSON — fall back to plain text handling.
    return chunkMarkdown(text, fileTitle);
  }
  return out;
}

/** Dispatch by extension. */
export function chunkFileContent(filePath: string, text: string): { title: string; body: string }[] {
  const ext = extname(filePath).toLowerCase();
  const stem = basename(filePath, ext);
  if (ext === '.json' || ext === '.jsonl') return chunkJson(text, stem);
  return chunkMarkdown(text, stem);
}

// ─── staging ────────────────────────────────────────────────────────────────

function stagingPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.she', 'ingest-staging.json');
}

function loadBatches(workspaceRoot: string): IngestBatch[] {
  try {
    const p = stagingPath(workspaceRoot);
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as IngestBatch[];
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function saveBatches(workspaceRoot: string, batches: IngestBatch[]): void {
  const dir = join(workspaceRoot, '.she');
  mkdirSync(dir, { recursive: true });
  writeFileSync(stagingPath(workspaceRoot), JSON.stringify(batches, null, 2), 'utf8');
}

function listFiles(target: string): string[] {
  if (!existsSync(target)) return [];
  const st = statSync(target);
  if (st.isFile()) return [target];

  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules' || e === 'dist') continue;
      const full = join(dir, e);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else if (SUPPORTED_EXT.has(extname(full).toLowerCase())) out.push(full);
    }
  };
  walk(target);
  return out;
}

// ─── tools ──────────────────────────────────────────────────────────────────

export interface IngestToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * Build the ingestion tools.
 *
 * `engine`/`store` are injected so this stays decoupled from the KB package
 * (same shape as the other tool factories).
 */
export function createIngestTools(
  workspaceRoot: string,
  engine: EngineLike,
  store: StoreLike,
): IngestToolSet {
  const toolMap = new Map<string, { def: ToolDefinition; fn: (a: Record<string, unknown>) => Promise<string> }>();
  const reg = (def: ToolDefinition, fn: (a: Record<string, unknown>) => Promise<string>) =>
    toolMap.set(def.name, { def, fn });

  const ensureIntakeGroup = (): { id: string; name: string } => {
    const groups = store.getAllGroups();
    const root = groups.find((g) => g.name === 'intake' && !g.parentGroupId);
    if (root) return { id: root.id, name: root.name };
    return engine.createGroup('intake');
  };

  /**
   * Placement targets: logical groups only. A split part (`<group>/part-N`, made by an automatic
   * split) is a storage bucket, not a topic, so it is listed as its logical parent (deduped).
   */
  const logicalGroupNames = (): string[] => {
    const names = new Set<string>();
    for (const g of store.getAllGroups()) names.add(resolveLogicalGroup(g, (id) => store.getGroup(id)).name);
    return [...names];
  };

  reg(
    {
      name: 'kb_ingest_scan',
      description:
        'Stage a file or directory for knowledge ingestion. Parses md/txt/json/jsonl into individual items and records them under an "intake" group. Follow with kb_ingest_place to file each item into the right group in the knowledge tree. Use this whenever the user drops knowledge files in and wants them absorbed.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File or directory path, relative to the workspace (or an absolute path INSIDE it). Paths outside the workspace are refused.',
          },
          label: { type: 'string', description: 'Optional short label describing this batch' },
        },
        required: ['path'],
      },
    },
    async (a) => {
      const raw = String(a.path ?? '').trim();
      if (!raw) return 'Error: path is required';

      /*
       * Jailed: ingestion is a file READ, and the text ends up in the knowledge base, where
       * `kb_query` can retrieve it.
       *
       * This resolved `raw` against the workspace root and read whatever it pointed at, so a
       * prompt-injected agent could stage `~/.cursor/mcp.json` or any other file the server process
       * can read — a no-confirmation host-file read primitive. The description even advertised
       * "absolute path", which made it look intended.
       */
      let target: string;
      try {
        target = resolveInsideWorkspace(workspaceRoot, raw);
      } catch (e) {
        return `Error: ${(e as Error).message}（知识入库只允许工作区内的路径）`;
      }
      if (!existsSync(target)) return `Error: 路径不存在: ${target}`;

      const files = listFiles(target);
      if (!files.length) return `未找到可导入的文件（支持 ${[...SUPPORTED_EXT].join(' ')}）`;

      const batches = loadBatches(workspaceRoot);
      const intake = ensureIntakeGroup();
      const items: IngestItem[] = [];
      const perFile: string[] = [];

      for (const f of files) {
        let text: string;
        try {
          text = readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        const chunks = chunkFileContent(f, text);
        for (const c of chunks) {
          items.push({
            id: `it_${randomUUID().slice(0, 8)}`,
            title: c.title,
            text: c.body,
            origin: f.replace(workspaceRoot, '').replace(/\\/g, '/'),
            status: 'pending',
          });
        }
        perFile.push(`${basename(f)}: ${chunks.length}`);
      }

      if (!items.length) return '文件里没有解析出任何内容。';

      const batch: IngestBatch = {
        id: `b_${randomUUID().slice(0, 8)}`,
        createdAt: new Date().toISOString(),
        sourcePath: target,
        intakeGroup: intake.name,
        items,
      };
      batches.push(batch);
      saveBatches(workspaceRoot, batches);

      const preview = items
        .slice(0, 12)
        .map((it, i) => `  [${i + 1}] ${it.title}  (${it.text.length} 字) — ${it.origin}`)
        .join('\n');

      return [
        `已暂存 ${items.length} 条待归位知识（batch ${batch.id}）。`,
        `来源拆分：${perFile.join(' | ')}`,
        '',
        '预览（前 12 条）：',
        preview,
        items.length > 12 ? `  … 其余 ${items.length - 12} 条` : '',
        '',
        `下一步：用 kb_ingest_place 逐条归位（batch_id=${batch.id}，item_id 见 kb_ingest_list）。`,
        '归位时优先复用已有的组；确实没有合适的组再新建，避免碎片化。',
      ].filter(Boolean).join('\n');
    },
  );

  reg(
    {
      name: 'kb_ingest_list',
      description: 'List staged ingestion items that still need placement, with their batch and item ids.',
      parameters: {
        type: 'object',
        properties: {
          batch_id: { type: 'string', description: 'Optional batch id; omit for the latest batch' },
          limit: { type: 'number', description: 'Ignored. Every pending item is listed.' },
        },
      },
    },
    async (a) => {
      const batches = loadBatches(workspaceRoot);
      if (!batches.length) return '没有待归位的知识。先用 kb_ingest_scan 暂存。';
      const wanted = String(a.batch_id ?? '').trim();
      const batch = wanted ? batches.find((b) => b.id === wanted) : batches[batches.length - 1];
      if (!batch) return `未找到 batch ${wanted}`;
      const pending = batch.items.filter((i) => i.status === 'pending');

      const groupList = logicalGroupNames().join(', ');

      return [
        `batch ${batch.id}（来源 ${batch.sourcePath}）`,
        `待归位 ${pending.length} / 共 ${batch.items.length}`,
        '',
        '现有组（优先归到这些）：',
        groupList || '(还没有组)',
        '',
        '待归位条目：',
        pending.map((i) => `  ${i.id}  ${i.title}  (${i.text.length} 字)`).join('\n') || '(无)',
      ].filter(Boolean).join('\n');
    },
  );

  reg(
    {
      name: 'kb_ingest_place',
      description:
        'File one staged item into a group in the knowledge tree. Provide an EXISTING groupName when one fits; set createIfMissing=true to create a new group (use sparingly, to avoid a fragmented tree). Optionally link the new node to a related existing node.',
      parameters: {
        type: 'object',
        properties: {
          batch_id: { type: 'string', description: 'Batch id (optional; defaults to latest)' },
          item_id: { type: 'string', description: 'Item id from kb_ingest_list' },
          groupName: { type: 'string', description: 'Target group path, e.g. "project/architecture"' },
          title: { type: 'string', description: 'Optional override title' },
          kind: { type: 'string', enum: ['text', 'code', 'fact', 'tool_outcome', 'preference'] },
          createIfMissing: { type: 'boolean', description: 'Create the group when it does not exist' },
          linkToNodeId: { type: 'string', description: 'Optional existing node id to weakly link to' },
        },
        required: ['item_id', 'groupName'],
      },
    },
    async (a) => {
      const itemId = String(a.item_id ?? '').trim();
      const groupName = String(a.groupName ?? '').trim();
      if (!itemId || !groupName) return 'Error: item_id 与 groupName 必填';

      const batches = loadBatches(workspaceRoot);
      const wanted = String(a.batch_id ?? '').trim();
      const batch = wanted ? batches.find((b) => b.id === wanted) : batches[batches.length - 1];
      if (!batch) return 'Error: 没有可用的 batch';
      const item = batch.items.find((i) => i.id === itemId);
      if (!item) return `Error: 未找到条目 ${itemId}`;
      if (item.status === 'placed') return `该条目已归位到 ${item.placedGroup}`;

      // Resolve or create the group, supporting "a/b/c" nesting.
      let group = store.getAllGroups().find((g) => g.name === groupName);
      if (!group) {
        if (a.createIfMissing !== true) {
          const existing = logicalGroupNames().join(', ');
          return `Error: 组 "${groupName}" 不存在。现有组：${existing}。若确实需要新建，请传 createIfMissing=true。`;
        }
        const segments = groupName.split('/').filter(Boolean);
        let parentId: string | undefined;
        let acc = '';
        let currentId = '';
        for (const seg of segments) {
          acc = acc ? `${acc}/${seg}` : seg;
          const found = store.getAllGroups().find(
            (x) => x.name === acc && (parentId ? x.parentGroupId === parentId : true),
          );
          currentId = found ? found.id : engine.createGroup(acc, parentId).id;
          parentId = currentId;
        }
        group = store.getGroup(currentId);
      }

      // Never file into a split part: write to its logical group instead.
      let targetName = groupName;
      let redirected = '';
      if (group) {
        const logical = resolveLogicalGroup(group, (id) => store.getGroup(id));
        if (logical.id !== group.id) {
          redirected = ` (redirected from split part "${groupName}" to its logical group "${logical.name}")`;
          targetName = logical.name;
          group = logical;
        }
      }

      const title = String(a.title ?? '').trim() || item.title;
      const kindRaw = String(a.kind ?? 'text');
      const kind = (['text', 'code', 'fact', 'tool_outcome', 'preference'].includes(kindRaw)
        ? kindRaw
        : 'text') as 'text' | 'code' | 'fact' | 'tool_outcome' | 'preference';

      const body = item.origin ? `${item.text}\n\n<!-- 来源: ${item.origin} -->` : item.text;
      const mem = engine.addMemoryMaintained
        ? engine.addMemoryMaintained(group!.id, kind, title, body)
        : engine.addMemory(group!.id, kind, title, body);

      if (typeof a.linkToNodeId === 'string' && a.linkToNodeId.trim()) {
        try {
          engine.addWeakEdge(mem.id, a.linkToNodeId.trim());
        } catch { /* linking is best-effort */ }
      }

      item.status = 'placed';
      item.placedGroup = targetName;
      saveBatches(workspaceRoot, batches);

      const remaining = batch.items.filter((i) => i.status === 'pending').length;
      return `已归位「${title}」→ 组 ${targetName} [Node: ${mem.id}]${redirected}。本批剩余 ${remaining} 条。`;
    },
  );

  reg(
    {
      name: 'kb_ingest_status',
      description: 'Summarize ingestion progress: how many items are staged and how many remain unplaced.',
      parameters: { type: 'object', properties: {} },
    },
    async () => {
      const batches = loadBatches(workspaceRoot);
      if (!batches.length) return '没有导入记录。';
      return batches
        .map((b) => {
          const pending = b.items.filter((i) => i.status === 'pending').length;
          const placed = b.items.length - pending;
          return `batch ${b.id}  ${placed}/${b.items.length} 已归位  剩余 ${pending}  — ${b.sourcePath}`;
        })
        .join('\n');
    },
  );

  const definitions = Array.from(toolMap.values()).map((t) => t.def);
  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const entry = toolMap.get(name);
    if (!entry) return `Error: unknown tool "${name}"`;
    try {
      return await entry.fn(args);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return { definitions, execute };
}
