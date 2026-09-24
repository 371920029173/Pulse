/**
 * Turn a copied conversation record into messages this agent can open and continue.
 *
 * The previous path rendered every source as markdown (`## 用户` / `## 助手`) and
 * then parsed that markdown with a JSON parser. Two things followed, both fatal
 * for "open this chat and keep going":
 *
 *   1. Roles never survived the round trip, so the whole transcript collapsed
 *      into one assistant message.
 *   2. Claude JSONL, Codex `response_item` logs, and Cursor's bubble order were
 *      not the formats that parser understood, so the copy on disk had no
 *      conversation to open.
 *
 * Thinking is kept on `reasoning` with `reasoningOrigin: 'imported'`. It is not
 * DeepSeek `reasoning_content` — see LLMMessage. Tool calls are kept only when
 * the matching result is in the record; a dangling call is inlined as text so
 * the next request is still a valid chat completion.
 */
import type { LLMMessage, ToolCall } from '@she/shared';

export function transcriptToMessages(
  source: string,
  text: string,
  maxMessages = Number.POSITIVE_INFINITY,
): { messages: LLMMessage[]; truncated: number } {
  const src = (source || 'raw').toLowerCase();
  const raw = text || '';
  if (!raw.trim()) return { messages: [], truncated: 0 };

  let messages: LLMMessage[] = [];
  const jsonl = tryJsonl(raw);
  if (jsonl) {
    messages = messagesFromJsonl(src, jsonl);
  } else {
    let parsed: unknown;
    let isJson = false;
    try {
      parsed = JSON.parse(raw.trim());
      isJson = true;
    } catch { /* markdown / prose */ }
    messages = isJson ? messagesFromDocument(src, parsed) : parseMarkdownTranscript(raw);
  }

  messages = repairProtocol(messages);
  return capMessages(messages, maxMessages);
}

function messagesFromJsonl(src: string, records: unknown[]): LLMMessage[] {
  const preferCodex = src === 'codex' || src === 'chatgpt';
  const preferClaude = src === 'claude' || src === 'claude-code';

  const ordered = preferCodex
    ? [parseCodexRecords, parseClaudeRecords, parseMessageList]
    : preferClaude
      ? [parseClaudeRecords, parseCodexRecords, parseMessageList]
      : [parseCodexRecords, parseClaudeRecords, parseMessageList];

  for (const parse of ordered) {
    const messages = parse(records);
    if (messages.length) return messages;
  }
  return [];
}

function messagesFromDocument(src: string, parsed: unknown): LLMMessage[] {
  if (Array.isArray(parsed)) {
    if (parsed.some((x) => x && typeof x === 'object' && 'mapping' in (x as object))) {
      return (parsed as unknown[]).flatMap((conv) => parseChatGptConversation(conv));
    }
    if (src === 'cursor' || parsed.some((x) => isCursorBubble(x))) {
      return cursorBubblesToMessages(parsed as Record<string, unknown>[]);
    }
    return parseMessageList(parsed);
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const o = parsed as Record<string, unknown>;

  if (o.schema === 'she.imported-context.v1' && Array.isArray(o.messages)) {
    return normalizeStored(o.messages);
  }
  if (
    o.schema === 'she.cursor-record.v1'
    || Array.isArray(o.fullConversationHeadersOnly)
    || (o.bubbles && typeof o.bubbles === 'object')
  ) {
    return cursorRecordToMessages(o);
  }
  if (o.mapping && typeof o.mapping === 'object') return parseChatGptConversation(o);

  const nested = firstArray(
    (o.composer as { bubbles?: unknown } | undefined)?.bubbles,
    o.bubbles,
    (o.conversation as { messages?: unknown } | undefined)?.messages,
    o.conversation,
    o.messages,
    o.chat_messages,
    (o.conversations as { messages?: unknown }[] | undefined)?.[0]?.messages,
    (o.tabs as { bubbles?: unknown }[] | undefined)?.[0]?.bubbles,
    o.items,
    o.events,
  );
  if (!nested) return [];
  if (src === 'cursor' || nested.some((x) => isCursorBubble(x))) {
    return cursorBubblesToMessages(nested as Record<string, unknown>[]);
  }
  return parseMessageList(nested);
}

function firstArray(...candidates: unknown[]): unknown[] | null {
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return null;
}

// ─── Claude Code JSONL ──────────────────────────────────────────────────────

function parseClaudeRecords(records: unknown[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  let sawClaude = false;

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const j = rec as Record<string, unknown>;
    if (j.isMeta === true || j.isSidechain === true) continue;

    const type = String(j.type || '');
    const message = (j.message && typeof j.message === 'object' ? j.message : j) as Record<string, unknown>;
    const roleRaw = String(message.role || (type === 'user' || type === 'assistant' ? type : ''));
    const role = canonicalRole(roleRaw);
    if (role !== 'user' && role !== 'assistant') continue;
    if (j.message || type === 'user' || type === 'assistant') sawClaude = true;

    const blocks = asBlocks(message.content);

    if (role === 'user') {
      const texts: string[] = [];
      if (!blocks.length && typeof message.content === 'string') texts.push(message.content);
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            content: clip(textOf(b.content ?? b.text) || '(无输出)'),
            tool_call_id: String(b.tool_use_id || b.id || ''),
          });
        } else if (b.type === 'image' || b.type === 'image_url') {
          texts.push('[图片]');
        } else if (b.type !== 'thinking' && b.type !== 'redacted_thinking') {
          const t = typeof b.text === 'string' ? b.text : textOf(b);
          if (t.trim()) texts.push(t);
        }
      }
      const text = texts.join('\n').trim();
      if (text) out.push({ role: 'user', content: clip(text) });
      continue;
    }

    const texts: string[] = [];
    const thoughts: string[] = [];
    const calls: ToolCall[] = [];
    if (!blocks.length && typeof message.content === 'string') texts.push(message.content);
    for (const b of blocks) {
      if (b.type === 'thinking' && typeof b.thinking === 'string') thoughts.push(b.thinking);
      else if (b.type === 'redacted_thinking') thoughts.push('（思维链已折叠）');
      else if (b.type === 'tool_use') {
        calls.push({
          id: String(b.id || `toolu_${calls.length + 1}`),
          type: 'function',
          function: {
            name: String(b.name || 'tool'),
            arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
          },
        });
      } else if (b.type === 'text' || typeof b.text === 'string') {
        if (b.text?.trim()) texts.push(b.text);
      }
    }
    const msg = assistantMessage(texts.join('\n'), thoughts.join('\n\n'), calls);
    if (msg) out.push(msg);
  }

  return sawClaude ? mergeAdjacent(out) : [];
}

// ─── Codex / ChatGPT ────────────────────────────────────────────────────────

function parseCodexRecords(records: unknown[]): LLMMessage[] {
  const responsePayloads: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const legacy: Record<string, unknown>[] = [];

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const j = rec as Record<string, unknown>;
    if (j.type === 'response_item' && j.payload && typeof j.payload === 'object') {
      responsePayloads.push(j.payload as Record<string, unknown>);
    } else if (j.type === 'event_msg' && j.payload && typeof j.payload === 'object') {
      events.push(j.payload as Record<string, unknown>);
    } else if (j.type === 'session_meta' || j.type === 'turn_context' || j.type === 'token_count') {
      continue;
    } else {
      legacy.push(j);
    }
  }

  // A current Codex log writes BOTH an event_msg and a response_item for the
  // same turn. Prefer the structured items; events are only the fallback for
  // older CLIs that never wrote response_item.
  if (responsePayloads.length) return mergeAdjacent(fromCodexPayloads(responsePayloads));
  if (events.length) return mergeAdjacent(fromCodexEvents(events));
  // `role` alone is not enough: a plain `{role, content}` log is the generic
  // shape, and claiming it here would drop a `reasoning` field the generic
  // parser keeps. Codex's own legacy lines are tagged `type: "message"`.
  if (legacy.some((x) => x.type === 'message' || x.type === 'function_call' || x.type === 'function_call_output' || x.type === 'reasoning')) {
    return mergeAdjacent(fromCodexPayloads(legacy));
  }
  return [];
}

function fromCodexEvents(events: Record<string, unknown>[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  let pending = '';
  for (const e of events) {
    const t = String(e.type || '');
    if (t === 'agent_reasoning' || t === 'reasoning') {
      const text = String(e.text || e.message || '').trim();
      if (text) pending = pending ? `${pending}\n\n${text}` : text;
      continue;
    }
    if (t === 'user_message') {
      const text = String(e.message || e.text || '').trim();
      if (text) out.push({ role: 'user', content: clip(text) });
      continue;
    }
    if (t === 'agent_message' || t === 'assistant_message') {
      const text = String(e.message || e.text || '').trim();
      const msg = assistantMessage(text, pending, []);
      pending = '';
      if (msg) out.push(msg);
    }
  }
  if (pending) {
    const msg = assistantMessage('', pending, []);
    if (msg) out.push(msg);
  }
  return out;
}

function fromCodexPayloads(payloads: Record<string, unknown>[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  let pendingReasoning = '';
  let pendingCalls: ToolCall[] = [];
  let pendingText = '';

  const flushCalls = () => {
    if (!pendingCalls.length) return;
    const msg = assistantMessage(pendingText, pendingReasoning, pendingCalls);
    pendingReasoning = '';
    pendingCalls = [];
    pendingText = '';
    if (msg) out.push(msg);
  };

  for (const p of payloads) {
    const type = String(p.type || '');
    if (type === 'reasoning') {
      const text = codexReasoningText(p);
      if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n\n${text}` : text;
      continue;
    }
    if (type === 'function_call' || type === 'tool_call' || type === 'custom_tool_call') {
      pendingCalls.push({
        id: String(p.call_id || p.id || `call_${pendingCalls.length + 1}`),
        type: 'function',
        function: {
          name: String(p.name || 'tool'),
          arguments: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? p.input ?? {}),
        },
      });
      continue;
    }
    if (type === 'function_call_output' || type === 'tool_result' || type === 'custom_tool_call_output') {
      flushCalls();
      out.push({
        role: 'tool',
        content: clip(textOf(p.output ?? p.content) || '(无输出)'),
        tool_call_id: String(p.call_id || p.id || ''),
      });
      continue;
    }
    if (type === 'message' || p.role) {
      const role = canonicalRole(String(p.role || 'assistant'));
      const content = textOf(p.content ?? p.text ?? p.message);
      if (role === 'user' || role === 'system') {
        flushCalls();
        const body = role === 'system' && content.trim()
          ? `[来自原对话的系统说明]\n${content}`
          : content;
        if (body.trim()) out.push({ role: 'user', content: clip(body) });
        continue;
      }
      if (role === 'tool') {
        flushCalls();
        out.push({
          role: 'tool',
          content: clip(content || '(无输出)'),
          tool_call_id: String(p.call_id || p.tool_call_id || ''),
        });
        continue;
      }
      if (pendingCalls.length) {
        pendingText = content;
        flushCalls();
        continue;
      }
      const msg = assistantMessage(content, pendingReasoning, []);
      pendingReasoning = '';
      if (msg) out.push(msg);
    }
  }
  flushCalls();
  if (pendingReasoning) {
    const msg = assistantMessage('', pendingReasoning, []);
    if (msg) out.push(msg);
  }
  return out;
}

function codexReasoningText(p: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof p.text === 'string') parts.push(p.text);
  const take = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (typeof s === 'string') parts.push(s);
      else if (s && typeof s === 'object' && typeof (s as { text?: string }).text === 'string') {
        parts.push((s as { text: string }).text);
      }
    }
  };
  take(p.summary);
  take(p.content);
  return parts.map((s) => s.trim()).filter(Boolean).join('\n');
}

function parseChatGptConversation(conv: unknown): LLMMessage[] {
  if (!conv || typeof conv !== 'object') return [];
  const c = conv as Record<string, unknown>;
  const mapping = c.mapping;
  if (!mapping || typeof mapping !== 'object') return [];

  const byId = new Map<string, Record<string, unknown>>();
  for (const n of Object.values(mapping as Record<string, unknown>)) {
    if (n && typeof n === 'object' && typeof (n as { id?: string }).id === 'string') {
      byId.set((n as { id: string }).id, n as Record<string, unknown>);
    }
  }

  // The active branch, not create_time. Edits and regenerations share a parent;
  // sorting by time interleaves the abandoned branch into the one the user kept.
  let nodes: Record<string, unknown>[];
  const current = typeof c.current_node === 'string' ? c.current_node : '';
  if (current && byId.has(current)) {
    const chain: Record<string, unknown>[] = [];
    const guard = new Set<string>();
    let id: string | undefined = current;
    while (id && byId.has(id) && !guard.has(id)) {
      guard.add(id);
      const node: Record<string, unknown> = byId.get(id)!;
      chain.push(node);
      id = typeof node.parent === 'string' ? node.parent : undefined;
    }
    chain.reverse();
    nodes = chain;
  } else {
    nodes = [...byId.values()]
      .filter((n) => n.message)
      .sort((a, b) => {
        const ta = Number((a.message as { create_time?: number } | undefined)?.create_time || 0);
        const tb = Number((b.message as { create_time?: number } | undefined)?.create_time || 0);
        return ta - tb;
      });
  }

  const out: LLMMessage[] = [];
  for (const n of nodes) {
    const message = n.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const meta = (message.metadata && typeof message.metadata === 'object'
      ? message.metadata
      : {}) as Record<string, unknown>;
    if (meta.is_visually_hidden_from_conversation === true) continue;

    const author = message.author as { role?: string } | undefined;
    const role = canonicalRole(String(author?.role || message.role || ''));
    if (role === 'unknown') continue;

    const contentObj = message.content as { parts?: unknown } | undefined;
    const content = textOf(contentObj?.parts ?? message.content);
    const reasoning = textOf(meta.reasoning ?? message.reasoning);
    if (role === 'system') {
      if (content.trim()) out.push({ role: 'user', content: clip(`[来自原对话的系统说明]\n${content}`) });
      continue;
    }
    if (role === 'tool') {
      if (content.trim()) {
        out.push({
          role: 'tool',
          content: clip(content),
          tool_call_id: String(meta.tool_call_id || n.id || ''),
        });
      }
      continue;
    }
    if (!content.trim() && !reasoning.trim()) continue;
    const msg: LLMMessage = {
      role: role === 'user' ? 'user' : 'assistant',
      content: clip(content),
    };
    if (reasoning.trim() && msg.role === 'assistant') {
      msg.reasoning = clip(reasoning);
      msg.reasoningOrigin = 'imported';
    }
    out.push(msg);
  }
  return mergeAdjacent(out);
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

function isCursorBubble(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return b.type === 1 || b.type === 2 || typeof b.bubbleId === 'string' || b.toolFormerData != null;
}

/**
 * Cursor stores each bubble under `bubbleId:<composerId>:<bubbleId>`. The
 * bubble id is a UUID, so `ORDER BY key` is not conversation order — it
 * scrambles who said what. The order the product shows is
 * `fullConversationHeadersOnly`.
 */
export function cursorRecordToMessages(record: Record<string, unknown>): LLMMessage[] {
  const headers = (Array.isArray(record.fullConversationHeadersOnly)
    ? record.fullConversationHeadersOnly
    : Array.isArray(record.conversationHeaders)
      ? record.conversationHeaders
      : []) as { bubbleId?: string }[];

  const map = new Map<string, Record<string, unknown>>();
  // An exported array has no ids. Its order is the conversation; don't drop it
  // just because nothing can be keyed.
  let listed: Record<string, unknown>[] = [];
  const bubblesField = record.bubbles;
  if (Array.isArray(bubblesField)) {
    listed = bubblesField.filter((b) => b && typeof b === 'object') as Record<string, unknown>[];
    for (const b of listed) {
      const id = String((b as { bubbleId?: string }).bubbleId || '');
      if (id) map.set(id, b);
    }
  } else if (bubblesField && typeof bubblesField === 'object') {
    for (const [k, v] of Object.entries(bubblesField as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const b = v as Record<string, unknown>;
        map.set(String((b as { bubbleId?: string }).bubbleId || k), b);
      }
    }
  }

  if (headers.length && map.size) {
    const seen = new Set<string>();
    const ordered: Record<string, unknown>[] = [];
    for (const h of headers) {
      const id = String(h?.bubbleId || '');
      if (!id || seen.has(id)) continue;
      const b = map.get(id);
      if (b) {
        ordered.push(b);
        seen.add(id);
      }
    }
    const rest = [...map.entries()].filter(([id]) => !seen.has(id)).map(([, b]) => b);
    rest.sort((a, b) => bubbleTime(a) - bubbleTime(b));
    return cursorBubblesToMessages([...ordered, ...rest]);
  }
  if (listed.length) return cursorBubblesToMessages(listed);
  if (map.size) {
    return cursorBubblesToMessages([...map.values()].sort((a, b) => bubbleTime(a) - bubbleTime(b)));
  }
  if (Array.isArray(record.conversation)) {
    return cursorBubblesToMessages(record.conversation as Record<string, unknown>[]);
  }
  if (Array.isArray(record.messages)) return parseMessageList(record.messages);
  return [];
}

function cursorBubblesToMessages(bubbles: Record<string, unknown>[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const b of bubbles) {
    if (!b || typeof b !== 'object') continue;
    const role = cursorRole(b);
    const text = cursorVisibleText(b);
    const reasoning = cursorThinking(b);
    const tool = cursorTool(b);

    if (role === 'user') {
      if (text.trim()) out.push({ role: 'user', content: clip(text) });
      else if (!tool && !reasoning.trim()) continue;
      else out.push({ role: 'user', content: clip(text || '[图片]') });
      continue;
    }
    if (role === 'unknown' && !text.trim() && !reasoning.trim() && !tool) continue;

    const calls = tool ? [tool.call] : [];
    const msg = assistantMessage(text, reasoning, calls);
    if (!msg) continue;
    out.push(msg);
    if (tool && tool.result != null) {
      out.push({
        role: 'tool',
        content: clip(tool.result || '(无输出)'),
        tool_call_id: tool.call.id,
        name: tool.call.function.name,
      });
    }
  }
  return mergeAdjacent(out);
}

function cursorRole(b: Record<string, unknown>): 'user' | 'assistant' | 'unknown' {
  const t = b.type ?? b.role ?? b.sender;
  if (t === 1 || t === '1') return 'user';
  if (t === 2 || t === '2') return 'assistant';
  return canonicalRole(String(t ?? '')) === 'user'
    ? 'user'
    : canonicalRole(String(t ?? '')) === 'assistant'
      ? 'assistant'
      : 'unknown';
}

function cursorVisibleText(b: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
  else if (typeof b.rawText === 'string' && b.rawText.trim()) parts.push(b.rawText);
  if (!parts.length && typeof b.richText === 'string') {
    const t = lexicalText(b.richText);
    if (t.trim()) parts.push(t);
  }
  if (Array.isArray(b.codeBlocks)) {
    for (const cb of b.codeBlocks) {
      if (cb && typeof cb === 'object' && typeof (cb as { content?: string }).content === 'string') {
        const code = (cb as { content: string }).content.trim();
        if (code && !parts.includes(code)) parts.push(code);
      }
    }
  }
  return parts.join('\n\n');
}

function cursorThinking(b: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    else if (v && typeof v === 'object' && typeof (v as { text?: string }).text === 'string') {
      const t = (v as { text: string }).text.trim();
      if (t) parts.push(t);
    }
  };
  push(b.thinking);
  push(b.reasoning);
  if (Array.isArray(b.allThinkingBlocks)) for (const x of b.allThinkingBlocks) push(x);
  if (Array.isArray(b.thinkingBlocks)) for (const x of b.thinkingBlocks) push(x);
  return parts.join('\n\n');
}

function cursorTool(b: Record<string, unknown>): { call: ToolCall; result: string | null } | null {
  const tf = (b.toolFormerData ?? b.toolCall) as Record<string, unknown> | undefined;
  if (!tf || typeof tf !== 'object') return null;
  const name = tf.name || tf.toolName || tf.tool;
  if (!name) return null;
  const args = typeof tf.rawArgs === 'string'
    ? tf.rawArgs
    : typeof tf.params === 'string'
      ? tf.params
      : JSON.stringify(tf.params ?? tf.arguments ?? {});
  const id = String(tf.toolCallId || tf.toolCallID || tf.id || `cursor_${name}`);
  const result = tf.result ?? tf.output ?? tf.toolResult;
  return {
    call: {
      id,
      type: 'function',
      function: { name: String(name), arguments: args },
    },
    result: result == null ? null : (typeof result === 'string' ? result : textOf(result) || JSON.stringify(result)),
  };
}

function lexicalText(raw: string): string {
  try {
    const rt = JSON.parse(raw) as unknown;
    const walk = (node: unknown): string => {
      if (!node) return '';
      if (typeof node === 'string') return node;
      if (typeof node !== 'object') return '';
      const n = node as { text?: string; type?: string; children?: unknown; content?: unknown };
      const kids = Array.isArray(n.children) ? n.children : Array.isArray(n.content) ? n.content : null;
      if (kids && n.type !== 'text') return kids.map(walk).join('');
      if (typeof n.text === 'string') return n.text;
      return kids ? kids.map(walk).join('') : '';
    };
    const root = rt && typeof rt === 'object' && 'root' in (rt as object) ? (rt as { root: unknown }).root : rt;
    return walk(root);
  } catch {
    return '';
  }
}

function bubbleTime(b: Record<string, unknown>): number {
  const v = b.createdAt ?? b.timestamp;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

// ─── Generic message lists and markdown ─────────────────────────────────────

function parseMessageList(records: unknown[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const item of records) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ role: 'assistant', content: clip(item) });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (m.type === 'response_item' || m.type === 'event_msg' || m.type === 'session_meta') return [];
    const author = m.author as { role?: string } | string | undefined;
    const roleRaw = String(
      m.role
      || (typeof author === 'string' ? author : author?.role)
      || m.sender
      || '',
    );
    const role = canonicalRole(roleRaw);
    const content = textOf(m.text ?? m.content ?? m.message ?? m.output_text ?? m.rawText);
    const reasoning = [textOf(m.reasoning_content ?? m.reasoning ?? m.thinking), thinkingFromBlocks(m.content)]
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n\n');
    if (role === 'unknown') {
      // An unrecognised speaker is still a turn. Dropping it is how a migration
      // quietly loses the conversation.
      if (content.trim()) out.push({ role: 'assistant', content: clip(content) });
      continue;
    }
    if (role === 'tool') {
      out.push({
        role: 'tool',
        content: clip(content || '(无输出)'),
        tool_call_id: String(m.tool_call_id || m.id || ''),
      });
      continue;
    }
    if (role === 'system') {
      if (content.trim()) out.push({ role: 'user', content: clip(`[来自原对话的系统说明]\n${content}`) });
      continue;
    }
    if (role === 'user') {
      if (content.trim()) out.push({ role: 'user', content: clip(content) });
      continue;
    }
    const calls = Array.isArray(m.tool_calls) ? normalizeToolCalls(m.tool_calls) : [];
    const msg = assistantMessage(content, reasoning, calls);
    if (msg) out.push(msg);
  }
  return out.length ? mergeAdjacent(out) : [];
}

function normalizeStored(messages: unknown[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const m = item as LLMMessage;
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool' && m.role !== 'system') continue;
    const msg: LLMMessage = { ...m, content: typeof m.content === 'string' ? m.content : '' };
    if (msg.role === 'system') {
      out.push({ role: 'user', content: clip(msg.content ? `[来自原对话的系统说明]\n${msg.content}` : '') });
      continue;
    }
    if (msg.reasoning && !msg.reasoningOrigin) msg.reasoningOrigin = 'imported';
    out.push(msg);
  }
  return out;
}

function parseMarkdownTranscript(text: string): LLMMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // `\b` is an ASCII word boundary. It never matches after 用户 / 助手, so a
  // heading written in Chinese used to be invisible and the whole transcript
  // came back empty.
  const heading = /\n(?=#{1,3}\s*(?:(?:User|Assistant|Human|AI|System|Claude)\b|用户|助手))/i;
  const parts = trimmed.split(heading);
  if (parts.length > 1) {
    const out: LLMMessage[] = [];
    for (const block of parts) {
      const lines = block.trim().split('\n');
      const head = (lines[0] || '').replace(/^#+\s*/, '');
      const role = canonicalRole(head.split(/\s/)[0] || '');
      const split = stripThinking(lines.slice(1).join('\n'));
      pushSpoken(out, role, split.content, split.reasoning);
    }
    return mergeAdjacent(out);
  }

  const turns = trimmed.split(/\n(?=(?:(?:Human|Assistant|User|Claude)\b|用户|助手)\s*[:：])/i);
  if (turns.length > 1) {
    const out: LLMMessage[] = [];
    for (const t of turns) {
      const m = /^(Human|Assistant|User|Claude|用户|助手)\s*[:：]\s*([\s\S]*)$/i.exec(t.trim());
      if (!m) {
        const split = stripThinking(t);
        if (split.content.trim()) out.push({ role: 'assistant', content: clip(split.content) });
        continue;
      }
      const split = stripThinking(m[2]);
      pushSpoken(out, canonicalRole(m[1]), split.content, split.reasoning);
    }
    return mergeAdjacent(out);
  }
  return [];
}

function pushSpoken(out: LLMMessage[], role: ReturnType<typeof canonicalRole>, content: string, reasoning: string): void {
  if (role === 'unknown') {
    if (content.trim()) out.push({ role: 'assistant', content: clip(content) });
    return;
  }
  if (role === 'user' || role === 'system') {
    const body = role === 'system' && content.trim() ? `[来自原对话的系统说明]\n${content}` : content;
    if (body.trim()) out.push({ role: 'user', content: clip(body) });
    return;
  }
  const msg = assistantMessage(content, reasoning, []);
  if (msg) out.push(msg);
}

function stripThinking(text: string): { content: string; reasoning: string } {
  const thoughts: string[] = [];
  const content = text.replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_all, inner) => {
    const t = String(inner).trim();
    if (t) thoughts.push(t);
    return '';
  }).trim();
  return { content, reasoning: thoughts.join('\n\n') };
}

// ─── Shared shaping ─────────────────────────────────────────────────────────

function assistantMessage(content: string, reasoning: string, calls: ToolCall[]): LLMMessage | null {
  const text = content.trim();
  const thought = reasoning.trim();
  if (!text && !thought && !calls.length) return null;
  const msg: LLMMessage = { role: 'assistant', content: clip(text) };
  if (thought) {
    msg.reasoning = clip(thought);
    msg.reasoningOrigin = 'imported';
  }
  if (calls.length) msg.tool_calls = calls;
  return msg;
}

function mergeAdjacent(messages: LLMMessage[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    const mergeable = prev
      && prev.role === m.role
      && (m.role === 'user' || m.role === 'assistant')
      && !prev.tool_calls?.length
      && !m.tool_calls?.length;
    if (mergeable && prev) {
      if (m.content.trim()) prev.content = prev.content.trim() ? `${prev.content}\n\n${m.content}` : m.content;
      if (m.reasoning) {
        prev.reasoning = prev.reasoning ? `${prev.reasoning}\n\n${m.reasoning}` : m.reasoning;
        prev.reasoningOrigin = 'imported';
      }
      continue;
    }
    out.push({ ...m, tool_calls: m.tool_calls ? m.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function } })) : undefined });
  }
  return out;
}

/**
 * A chat completion rejects a tool result with no call, and a call with no
 * result. Either one makes the transplanted conversation impossible to continue,
 * so both are folded into ordinary text instead of being dropped.
 */
function repairProtocol(messages: LLMMessage[]): LLMMessage[] {
  const folded: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') {
      folded.push({ ...m });
      continue;
    }
    let owner: LLMMessage | undefined;
    for (let i = folded.length - 1; i >= 0; i--) {
      if (folded[i].role !== 'tool') { owner = folded[i]; break; }
    }
    const ids = new Set(owner?.role === 'assistant' ? (owner.tool_calls ?? []).map((t) => t.id) : []);
    if (owner?.role === 'assistant' && m.tool_call_id && ids.has(m.tool_call_id)) {
      folded.push({ ...m });
    } else {
      const note = `[工具结果]\n${m.content}`;
      const last = folded[folded.length - 1];
      if (last && last.role === 'user' && !last.tool_calls) last.content = `${last.content}\n\n${note}`;
      else folded.push({ role: 'user', content: note });
    }
  }

  const out: LLMMessage[] = [];
  for (let i = 0; i < folded.length; i++) {
    const m = folded[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) {
      out.push(m);
      continue;
    }
    const tools: LLMMessage[] = [];
    let j = i + 1;
    while (j < folded.length && folded[j].role === 'tool') {
      tools.push(folded[j]);
      j++;
    }
    const got = new Set(tools.map((t) => t.tool_call_id));
    const kept = m.tool_calls.filter((tc) => got.has(tc.id));
    const missing = m.tool_calls.filter((tc) => !got.has(tc.id));
    let content = m.content || '';
    if (missing.length) {
      const note = missing.map((tc) => `[调用 ${tc.function.name}]\n${tc.function.arguments}`).join('\n\n');
      content = content.trim() ? `${content}\n\n${note}` : note;
    }
    if (kept.length) {
      out.push({ ...m, content, tool_calls: kept });
      for (const t of tools) {
        if (t.tool_call_id && kept.some((k) => k.id === t.tool_call_id)) out.push(t);
      }
    } else {
      const { tool_calls: _drop, ...rest } = m;
      out.push({ ...rest, content });
    }
    i = j - 1;
  }
  return out;
}

function capMessages(messages: LLMMessage[], maxMessages: number): { messages: LLMMessage[]; truncated: number } {
  if (!Number.isFinite(maxMessages) || messages.length <= maxMessages) return { messages, truncated: 0 };
  let cut = Math.max(1, maxMessages);
  // Keep a tool group intact. Cutting between a call and its result is the
  // request the endpoint rejects.
  if (messages[cut - 1]?.role === 'assistant' && messages[cut - 1].tool_calls?.length) {
    while (cut < messages.length && messages[cut].role === 'tool') cut++;
  }
  return {
    messages: repairProtocol(messages.slice(0, cut)),
    truncated: messages.length - cut,
  };
}

function canonicalRole(raw: string): 'user' | 'assistant' | 'system' | 'tool' | 'unknown' {
  const s = raw.trim().toLowerCase().replace(/^type_/, '');
  if (s === 'user' || s === 'human' || s === '用户') return 'user';
  if (s === 'assistant' || s === 'ai' || s === 'model' || s === 'bot' || s === 'claude' || s === 'gpt' || s === '助手') {
    return 'assistant';
  }
  if (s === 'system' || s === '系统') return 'system';
  if (s === 'tool' || s === 'function') return 'tool';
  if (s === '1') return 'user';
  if (s === '2') return 'assistant';
  return 'unknown';
}

function clip(s: string): string {
  return s.trim();
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const o = part as Record<string, unknown>;
      if (o.type === 'thinking' || o.type === 'redacted_thinking') return '';
      if (typeof o.text === 'string') return o.text;
      if (typeof o.content === 'string') return o.content;
      if (Array.isArray(o.content)) return textOf(o.content);
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.parts)) return textOf(o.parts);
    if (typeof o.content === 'string') return o.content;
    if (Array.isArray(o.content)) return textOf(o.content);
  }
  return '';
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

function asBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.filter((x) => x && typeof x === 'object') as Block[];
}

function thinkingFromBlocks(content: unknown): string {
  return asBlocks(content)
    .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking!.trim())
    .filter(Boolean)
    .join('\n\n');
}

function normalizeToolCalls(raw: unknown[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const tc = item as { id?: string; function?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown };
    const name = tc.function?.name || tc.name;
    if (!name) continue;
    const args = tc.function?.arguments ?? tc.arguments ?? {};
    calls.push({
      id: String(tc.id || `call_${calls.length + 1}`),
      type: 'function',
      function: { name: String(name), arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    });
  }
  return calls;
}

function tryJsonl(text: string): unknown[] | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const parsed: unknown[] = [];
  for (const line of lines) {
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { parsed.push(JSON.parse(line)); } catch { /* a prose line that happens to contain a brace */ }
  }
  if (parsed.length >= 2 && parsed.length >= lines.length * 0.5) return parsed;
  return null;
}
