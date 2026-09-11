import type { LLMProvider, LLMMessage, ToolDefinition, ToolCall, StreamChunk } from '@she/shared';

interface OpenAIFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface OpenAITool {
  type: 'function';
  function: OpenAIFunction;
}

interface OpenAIRequestMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export class OpenAIProvider implements LLMProvider {
  name = 'openai';

  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(apiKey: string, baseUrl: string, model: string, maxTokens: number, temperature: number) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  async chat(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<LLMMessage> {
    const openaiMessages = messages.map(m => this.toOpenAIMessage(m));
    const openaiTools = tools?.length ? tools.map(t => this.toOpenAITool(t)) : undefined;
    const stream = !!onChunk;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: openaiMessages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream,
    };
    if (openaiTools) {
      body.tools = openaiTools;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errText}`);
    }

    if (stream && onChunk) {
      return this.handleStream(response, onChunk);
    }
    return this.handleNonStream(response);
  }

  private async handleNonStream(response: Response): Promise<LLMMessage> {
    const data = await response.json() as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices[0];
    if (!choice) {
      throw new Error('OpenAI returned no choices');
    }

    const msg = choice.message;
    const result: LLMMessage = {
      role: 'assistant',
      content: msg.content ?? '',
    };

    if (msg.tool_calls?.length) {
      result.tool_calls = msg.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

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
    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') {
          onChunk({ type: 'done' });
          continue;
        }

        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          contentAccum += delta.content;
          onChunk({ type: 'text', content: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: tc.id ?? '', name: '', arguments: '' });
              onChunk({
                type: 'tool_call_start',
                toolCall: {
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function?.name ?? '', arguments: '' },
                },
              });
            }
            const accum = toolCallAccum.get(idx)!;
            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) accum.name += tc.function.name;
            if (tc.function?.arguments) {
              accum.arguments += tc.function.arguments;
              onChunk({
                type: 'tool_call_delta',
                toolCall: {
                  function: { name: accum.name, arguments: tc.function.arguments },
                },
              });
            }
          }
        }
      }
    }

    for (const [, accum] of toolCallAccum) {
      onChunk({
        type: 'tool_call_end',
        toolCall: {
          id: accum.id,
          type: 'function',
          function: { name: accum.name, arguments: accum.arguments },
        },
      });
    }

    const result: LLMMessage = {
      role: 'assistant',
      content: contentAccum,
    };

    if (toolCallAccum.size > 0) {
      result.tool_calls = Array.from(toolCallAccum.values()).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    return result;
  }

  private toOpenAIMessage(msg: LLMMessage): OpenAIRequestMessage {
    const result: OpenAIRequestMessage = {
      role: msg.role,
      content: msg.content || null,
    };
    if (msg.name) result.name = msg.name;
    if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id;
    if (msg.tool_calls?.length) {
      result.tool_calls = msg.tool_calls;
    }
    return result;
  }

  private toOpenAITool(def: ToolDefinition): OpenAITool {
    return {
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      },
    };
  }
}
