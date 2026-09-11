import type { LLMProvider, LLMMessage, ToolDefinition, ToolCall, StreamChunk } from '@she/shared';

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
  ): Promise<LLMMessage> {
    let system = '';
    const anthropicMessages: Array<{ role: string; content: string | AnthropicContentBlock[] }> = [];

    for (const msg of messages) {
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
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
        continue;
      }
      anthropicMessages.push({ role: msg.role, content: msg.content });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    if (onChunk) {
      return this.handleStream(response, onChunk);
    }
    return this.handleNonStream(response);
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

        let event: { type: string; delta?: { type?: string; text?: string; partial_json?: string }; content_block?: { type?: string; id?: string; name?: string } };
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
        } else if (event.type === 'message_stop') {
          onChunk({ type: 'done' });
        }
      }
    }

    const result: LLMMessage = { role: 'assistant', content: contentAccum };
    if (toolCalls.length > 0) result.tool_calls = toolCalls;
    return result;
  }
}
