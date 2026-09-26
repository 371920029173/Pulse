import type { LLMProvider, LLMMessage, ToolDefinition, ToolCall, StreamChunk } from '@she/shared';
import { repairApiMessages } from '../protocol.js';
import { lengthNoticeChunk, interruptedNoticeChunk } from './stream-failure.js';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';

  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(apiKey: string, model: string, maxTokens: number, temperature: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  async chat(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    onChunk?: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<LLMMessage> {
    let system = '';
    const anthropicMessages: Array<{ role: string; content: string | AnthropicContentBlock[] }> = [];

    for (const msg of repairApiMessages(messages)) {
      if (msg.role === 'system') {
        system += (system ? '\n\n' : '') + msg.content;
        continue;
      }
      if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: `[tool_result id=${msg.tool_call_id}] ${msg.content}` },
          ],
        });
        continue;
      }
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const content: AnthropicContentBlock[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(tc.function.arguments || '{}') as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              input = parsed as Record<string, unknown>;
            }
          } catch {
            input = { _raw: tc.function.arguments || '' };
          }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
        continue;
      }
      const text = msg.content?.trim() ? msg.content : '…';
      anthropicMessages.push({ role: msg.role, content: text });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens > 0 ? this.maxTokens : 131072,
      temperature: this.temperature,
      messages: anthropicMessages,
      stream: !!onChunk,
    };
    if (system) body.system = system;
    if (tools?.length) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const response = await this.fetchAnthropic(body, signal);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    if (onChunk) {
      return this.handleStream(response, onChunk);
    }
    return this.handleNonStream(response);
  }

  /** Retry a dropped connection or a busy endpoint. A 4xx other than 429 is final. */
  private async fetchAnthropic(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    };
    let last: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', init);
        const retry = response.status === 429 || response.status >= 500;
        if (!retry || attempt === 3) return response;
      } catch (err) {
        if (signal?.aborted) throw err;
        last = err instanceof Error ? err : new Error(String(err));
        if (attempt === 3) throw last;
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    throw last ?? new Error('Anthropic request failed');
  }

  private async handleNonStream(response: Response): Promise<LLMMessage> {
    const data = await response.json() as {
      content: AnthropicContentBlock[];
      stop_reason: string;
    };

    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        content += block.text;
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const result: LLMMessage = { role: 'assistant', content };
    if (toolCalls.length > 0) result.tool_calls = toolCalls;
    return result;
  }

  private async handleStream(
    response: Response,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<LLMMessage> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let buffer = '';
    let contentAccum = '';
    const toolCalls: ToolCall[] = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolArgs = '';
    let broke = false;
    /** `message_stop` arrived; without it a cleanly-ended body was still cut short. */
    let sawStop = false;
    /** `stop_reason: max_tokens` — the reply hit the output ceiling. */
    let hitMaxTokens = false;

    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);

        let event: { type: string; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }; content_block?: { type?: string; id?: string; name?: string } };
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          currentToolId = event.content_block.id ?? '';
          currentToolName = event.content_block.name ?? '';
          currentToolArgs = '';
          onChunk({
            type: 'tool_call_start',
            toolCall: { id: currentToolId, type: 'function', function: { name: currentToolName, arguments: '' } },
          });
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            contentAccum += event.delta.text;
            onChunk({ type: 'text', content: event.delta.text });
          } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            currentToolArgs += event.delta.partial_json;
            onChunk({
              type: 'tool_call_delta',
              toolCall: { function: { name: currentToolName, arguments: event.delta.partial_json } },
            });
          }
        } else if (event.type === 'content_block_stop' && currentToolId) {
          toolCalls.push({
            id: currentToolId,
            type: 'function',
            function: { name: currentToolName, arguments: currentToolArgs },
          });
          onChunk({
            type: 'tool_call_end',
            toolCall: { id: currentToolId, type: 'function', function: { name: currentToolName, arguments: currentToolArgs } },
          });
          currentToolId = '';
          currentToolName = '';
          currentToolArgs = '';
        } else if (event.type === 'message_delta' && event.delta?.stop_reason === 'max_tokens') {
          hitMaxTokens = true;
        } else if (event.type === 'message_stop') {
          sawStop = true;
          onChunk({ type: 'done' });
        }
      }
    }
    } catch (err) {
      broke = true;
      try { await reader.cancel(); } catch { /* already closed */ }
      const reason = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(reason)) throw err;
      if (!contentAccum && toolCalls.length === 0) {
        throw new Error(`流式响应中断（尚未收到内容）: ${reason}`);
      }
      onChunk({
        type: 'status',
        content: '响应中断，已保留收到的内容。回复「继续」可以接着往下写。',
      });
    }

    // An unfinished tool call has no complete arguments. Do not run it.
    if (broke) currentToolId = '';

    if (!broke && hitMaxTokens) {
      onChunk(lengthNoticeChunk(currentToolId ? 1 : 0));
      currentToolId = '';
    } else if (!broke && !sawStop && (contentAccum || toolCalls.length)) {
      // The body ended without `message_stop`: a truncation that threw nothing.
      onChunk(interruptedNoticeChunk('连接在收到结束标记前关闭'));
    }

    const result: LLMMessage = { role: 'assistant', content: contentAccum };
    if (toolCalls.length > 0) result.tool_calls = toolCalls;
    return result;
  }
}
