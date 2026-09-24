/** Parse Cursor / Claude Code / Codex / raw chat exports into KB chunks. */
import type { LLMMessage } from '@she/shared';
import { transcriptToMessages } from './transcript.js';

export interface ContextChunk {
  title: string;
  content: string;
  meta?: Record<string, string>;
}

/**
 * Turn parsed chunks back into a conversation.
 *
 * The parsers already carry the speaker in `meta.role` — they were written for knowledge ingestion,
 * so the role was metadata rather than structure. Migration needs the structure, so this reads it
 * back.
 *
 * Two decisions worth stating:
 *
 *   1. **An unrecognised role becomes `assistant`, not a drop.** Sources use their own vocabulary
 *      (`human`, `ai`, `model`, `message`, `item`, …) and the parsers pass it through verbatim. A
 *      role this function has never seen is still a turn the user wrote or received; discarding it
 *      would quietly lose part of the conversation, which is the one thing a migration must not do.
 *
 *   2. **Consecutive same-role turns are merged.** Some exports split one reply across several
 *      entries (a tool call and its text, a message and its attachment). Adjacent duplicates read
 *      as two turns and make the transcript misleading about who said what.
 *
 * `maxMessages` keeps the FIRST turns and reports the drop, rather than silently returning a
 * truncated transcript that looks complete.
 */
export function chunksToMessages(
  chunks: ContextChunk[],
  maxMessages = Number.POSITIVE_INFINITY,
): { messages: LLMMessage[]; truncated: number } {
  const messages: LLMMessage[] = [];

  for (const chunk of chunks) {
    const raw = String(chunk.meta?.role ?? '').trim().toLowerCase();
    const role: LLMMessage['role'] = raw === 'user' || raw === 'human' ? 'user' : 'assistant';
    const content = String(chunk.content ?? '').trim();
    if (!content) continue;

    const prev = messages[messages.length - 1];
    if (prev && prev.role === role && typeof prev.content === 'string') {
      prev.content = `${prev.content}\n\n${content}`;
      continue;
    }
    messages.push({ role, content });
  }

  const truncated = Math.max(0, messages.length - maxMessages);
  return { messages: truncated ? messages.slice(0, maxMessages) : messages, truncated };
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
    content: body,
    meta: { source, role },
  });
}

function messagesToChunks(messages: LLMMessage[], source: string): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  messages.forEach((m, i) => {
    const visible = (m.content || '').trim();
    const reasoning = (m.reasoning || '').trim();
    const body = [visible, reasoning ? `思维链:\n${reasoning}` : ''].filter(Boolean).join('\n\n');
    if (!body) return;
    chunks.push({
      title: `${m.role}-${i + 1}`,
      content: body,
      meta: {
        source,
        role: m.role,
        ...(reasoning ? { reasoning } : {}),
        ...(m.reasoningOrigin ? { reasoningOrigin: m.reasoningOrigin } : {}),
      },
    });
  });
  return chunks;
}

/** Cursor composer / chat JSON (bubbles, messages, conversation) */
export function parseCursor(text: string): ContextChunk[] {
  return messagesToChunks(transcriptToMessages('cursor', text).messages, 'cursor');
}

/** Claude Code / Claude.ai export */
export function parseClaudeCode(text: string): ContextChunk[] {
  return messagesToChunks(transcriptToMessages('claude-code', text).messages, 'claude-code');
}

/** OpenAI Codex / ChatGPT export-ish */
export function parseCodex(text: string): ContextChunk[] {
  return messagesToChunks(transcriptToMessages('codex', text).messages, 'codex');
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
    chunks.push({ title: titleLine, content: b, meta: { source } });
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

  // One parser for every source. The old per-source JSON parsers could not read
  // JSONL, and the markdown they were handed had already thrown the speaker away.
  let chunks = messagesToChunks(transcriptToMessages(source, text).messages, source);
  if (!chunks.length) chunks = parseGeneric(text, filename, source);
  return chunks;
}
