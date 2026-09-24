import type { LLMMessage } from '@she/shared';

/**
 * Make a transcript acceptable to a chat-completions endpoint.
 *
 * Two shapes are rejected with HTTP 400, and either one ends the turn:
 *
 * - An assistant message with no text and no tool calls
 *   ("content or tool_calls must be set"). A reasoning-only turn, or a turn
 *   saved before any text arrived, looks exactly like that.
 * - A tool call with no result, or a result with no call. The live history
 *   can be persisted in the middle of a tool round; the next request then
 *   sends the call alone.
 *
 * The transcript shown to the user is not changed. This returns a copy for
 * the request.
 */
export function repairApiMessages(messages: LLMMessage[]): LLMMessage[] {
  const folded: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') {
      folded.push({ ...m });
      continue;
    }
    let owner: LLMMessage | undefined;
    for (let i = folded.length - 1; i >= 0; i--) {
      if (folded[i].role !== 'tool') {
        owner = folded[i];
        break;
      }
    }
    const ids = new Set(
      owner?.role === 'assistant' ? (owner.tool_calls ?? []).map((t) => t.id) : [],
    );
    if (owner?.role === 'assistant' && m.tool_call_id && ids.has(m.tool_call_id)) {
      folded.push({ ...m, content: m.content || '' });
    } else {
      const note = `[工具结果]\n${m.content || ''}`;
      const last = folded[folded.length - 1];
      if (last && last.role === 'user' && !last.tool_calls) {
        last.content = `${last.content}\n\n${note}`;
      } else {
        folded.push({ role: 'user', content: note });
      }
    }
  }

  const out: LLMMessage[] = [];
  for (let i = 0; i < folded.length; i++) {
    const m = folded[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) {
      out.push(fillAssistant(m));
      continue;
    }
    const tools: LLMMessage[] = [];
    let j = i + 1;
    while (j < folded.length && folded[j].role === 'tool') {
      tools.push(folded[j]);
      j++;
    }
    const got = new Set(tools.map((t) => t.tool_call_id));
    const kept = m.tool_calls.filter((tc) => tc.id && tc.function?.name && got.has(tc.id));
    const missing = m.tool_calls.filter((tc) => !kept.includes(tc));
    let content = m.content || '';
    if (missing.length) {
      const note = missing
        .map((tc) => `[调用 ${tc.function?.name || '工具'}]\n${tc.function?.arguments || ''}`)
        .join('\n\n');
      content = content.trim() ? `${content}\n\n${note}` : note;
    }
    if (kept.length) {
      out.push({ ...m, content, tool_calls: kept });
      for (const t of tools) {
        if (t.tool_call_id && kept.some((k) => k.id === t.tool_call_id)) out.push(t);
      }
    } else {
      const { tool_calls: _drop, ...rest } = m;
      out.push(fillAssistant({ ...rest, content }));
    }
    i = j - 1;
  }
  return out;
}

function fillAssistant(m: LLMMessage): LLMMessage {
  if (m.role !== 'assistant') return m;
  if (m.tool_calls?.length) return m;
  if (m.content?.trim()) return m;
  return { ...m, content: m.reasoning?.trim() || '…' };
}
