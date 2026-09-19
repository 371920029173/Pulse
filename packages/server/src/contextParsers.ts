/** Parse Cursor / Claude Code / Codex / raw chat exports into KB chunks. */
export interface ContextChunk {
  title: string;
  content: string;
  meta?: Record<string, string>;
}

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const o = p as Record<string, unknown>;
          if (typeof o.text === 'string') return o.text;
          if (typeof o.content === 'string') return o.content;
        }
        return JSON.stringify(p);
      })
      .join('\n');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return String(o.content);
    return JSON.stringify(v);
  }
  return String(v);
}

function pushMsg(chunks: ContextChunk[], role: string, content: string, idx: number, source: string) {
  const body = content.trim();
  if (!body) return;
  chunks.push({
    title: `${role}-${idx}`,
    content: body.slice(0, 20_000),
    meta: { source, role },
  });
}

/** Cursor composer / chat JSON (bubbles, messages, conversation) */
export function parseCursor(text: string): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const bubbles =
      parsed?.composer?.bubbles ||
      parsed?.bubbles ||
      parsed?.conversation?.messages ||
      parsed?.messages ||
      parsed?.tabs?.[0]?.bubbles ||
      (Array.isArray(parsed) ? parsed : null);

    if (Array.isArray(bubbles)) {
      bubbles.forEach((b: any, i: number) => {
        const role = String(b.type || b.role || b.sender || b.author || 'message')
          .replace(/^TYPE_/, '')
          .toLowerCase();
        const content = asText(b.text ?? b.content ?? b.message ?? b.rawText);
        pushMsg(chunks, role || 'message', content, i + 1, 'cursor');
      });
      if (chunks.length) return chunks;
    }
  } catch {
    /* markdown / plaintext fallthrough */
  }

  // Cursor markdown export: ### User / ### Assistant
  const mdParts = trimmed.split(/\n(?=#{1,3}\s*(User|Assistant|Human|AI|System)\b)/i);
  if (mdParts.length > 1) {
    mdParts.forEach((block, i) => {
      const lines = block.trim().split('\n');
      const head = lines[0]?.replace(/^#+\s*/, '') || `block-${i + 1}`;
      pushMsg(chunks, head.split(/\s/)[0], lines.slice(1).join('\n') || block, i + 1, 'cursor');
    });
    if (chunks.length) return chunks;
  }
  return [];
}

/** Claude Code / Claude.ai export */
export function parseClaudeCode(text: string): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const msgs =
      parsed?.chat_messages ||
      parsed?.messages ||
      parsed?.conversations?.[0]?.messages ||
      (Array.isArray(parsed) ? parsed : null);
    if (Array.isArray(msgs)) {
      msgs.forEach((m: any, i: number) => {
        const role = String(m.sender || m.role || m.author || 'message').toLowerCase();
        const content = asText(m.text ?? m.content ?? m.message);
        pushMsg(chunks, role, content, i + 1, 'claude-code');
      });
      if (chunks.length) return chunks;
    }
  } catch {
    /* fallthrough */
  }

  // Human:/Assistant: turns
  const turns = trimmed.split(/\n(?=(?:Human|Assistant|User|Claude)\s*:)/i);
  if (turns.length > 1) {
    turns.forEach((t, i) => {
      const m = /^(Human|Assistant|User|Claude)\s*:\s*([\s\S]*)$/i.exec(t.trim());
      if (m) pushMsg(chunks, m[1], m[2], i + 1, 'claude-code');
      else pushMsg(chunks, 'message', t, i + 1, 'claude-code');
    });
    if (chunks.length) return chunks;
  }
  return [];
}

/** OpenAI Codex / ChatGPT export-ish */
export function parseCodex(text: string): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    // ChatGPT export: mapping[id].message
    if (parsed?.mapping && typeof parsed.mapping === 'object') {
      const nodes = Object.values(parsed.mapping as Record<string, any>)
        .filter((n) => n?.message)
        .sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
      nodes.forEach((n: any, i: number) => {
        const role = String(n.message?.author?.role || n.message?.role || 'message');
        const parts = n.message?.content?.parts || n.message?.content;
        pushMsg(chunks, role, asText(parts), i + 1, 'codex');
      });
      if (chunks.length) return chunks;
    }
    const items = parsed?.items || parsed?.messages || parsed?.events || (Array.isArray(parsed) ? parsed : null);
    if (Array.isArray(items)) {
      items.forEach((it: any, i: number) => {
        const role = String(it.role || it.type || it.author || 'item');
        const content = asText(it.content ?? it.text ?? it.message ?? it.output_text);
        pushMsg(chunks, role, content, i + 1, 'codex');
      });
      if (chunks.length) return chunks;
    }
  } catch {
    /* fallthrough */
  }
  return [];
}

function parseGeneric(text: string, filename: string, source: string): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : parsed.messages || parsed.items || [];
      if (Array.isArray(arr) && arr.length) {
        arr.forEach((item: any, i: number) => {
          if (typeof item === 'string') pushMsg(chunks, 'item', item, i + 1, source);
          else {
            const role = String(item.role || item.author || 'item');
            pushMsg(chunks, role, asText(item.content ?? item.text ?? item.message ?? item), i + 1, source);
          }
        });
        if (chunks.length) return chunks;
      }
    } catch {
      /* fallthrough */
    }
  }
  const parts = trimmed.split(/\n(?=#{1,3}\s)/);
  const blocks = parts.length > 1 ? parts : trimmed.split(/\n{2,}/);
  blocks.forEach((block, i) => {
    const b = block.trim();
    if (!b) return;
    const titleLine = b.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || `${filename}-${i + 1}`;
    chunks.push({ title: titleLine, content: b.slice(0, 20_000), meta: { source } });
  });
  return chunks;
}

export function parseContextExport(opts: {
  source: string;
  text: string;
  filename?: string;
}): ContextChunk[] {
  const source = (opts.source || 'raw').toLowerCase();
  const text = opts.text || '';
  const filename = opts.filename || 'paste.txt';

  let chunks: ContextChunk[] = [];
  if (source === 'cursor') chunks = parseCursor(text);
  else if (source === 'claude-code' || source === 'claude') chunks = parseClaudeCode(text);
  else if (source === 'codex' || source === 'chatgpt') chunks = parseCodex(text);

  if (!chunks.length) chunks = parseGeneric(text, filename, source);
  return chunks.slice(0, 2000);
}
