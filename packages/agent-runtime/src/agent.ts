import type {
  SheConfig,
  LLMProvider,
  LLMMessage,
  ToolDefinition,
  StreamChunk,
} from '@she/shared';
import { createLogger } from '@she/shared';
import type { GroupKBEngine } from '@she/kb';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { getSystemPrompt } from './system-prompt.js';
import type { ToolSet } from '@she/sandbox';
import { createKBTools } from './kb-tools.js';

const log = createLogger('agent');

export class Agent {
  private provider: LLMProvider;
  private history: LLMMessage[] = [];
  private allToolDefs: ToolDefinition[] = [];
  private executors: Map<string, (args: Record<string, unknown>) => Promise<string>> = new Map();
  private systemPrompt: string;

  constructor(
    private config: SheConfig,
    kbEngine: GroupKBEngine,
    sandboxTools: ToolSet,
  ) {
    if (config.llm.provider === 'anthropic') {
      this.provider = new AnthropicProvider(
        config.llm.apiKey, config.llm.model,
        config.llm.maxTokens, config.llm.temperature,
      );
    } else {
      this.provider = new OpenAIProvider(
        config.llm.apiKey, config.llm.baseUrl, config.llm.model,
        config.llm.maxTokens, config.llm.temperature,
      );
    }

    this.systemPrompt = getSystemPrompt(config.workspace.root);

    for (const def of sandboxTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => sandboxTools.execute(def.name, args));
    }

    const kbTools = createKBTools(kbEngine);
    for (const def of kbTools.definitions) {
      this.allToolDefs.push(def);
      this.executors.set(def.name, (args) => kbTools.execute(def.name, args));
    }
  }

  async chat(
    userMessage: string,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<LLMMessage> {
    this.history.push({ role: 'user', content: userMessage });

    const messages: LLMMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...this.history,
    ];

    let iterations = 0;
    const maxIterations = 15;

    while (iterations < maxIterations) {
      iterations++;
      log.debug(`Tool loop iteration ${iterations}`);

      const response = await this.provider.chat(messages, this.allToolDefs, onChunk);

      this.history.push(response);
      messages.push(response);

      if (!response.tool_calls?.length) {
        return response;
      }

      for (const tc of response.tool_calls) {
        const name = tc.function.name;
        const executor = this.executors.get(name);

        let result: string;
        if (!executor) {
          result = `Error: unknown tool "${name}"`;
        } else {
          try {
            const args = JSON.parse(tc.function.arguments);
            log.info(`Executing tool: ${name}`);
            result = await executor(args);
          } catch (err: unknown) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        const toolMsg: LLMMessage = {
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        };
        this.history.push(toolMsg);
        messages.push(toolMsg);
      }
    }

    const fallback: LLMMessage = {
      role: 'assistant',
      content: 'Tool loop reached maximum iterations. Please try a simpler request.',
    };
    this.history.push(fallback);
    return fallback;
  }

  clearHistory(): void {
    this.history = [];
  }

  getHistory(): LLMMessage[] {
    return [...this.history];
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.allToolDefs];
  }
}
