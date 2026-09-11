import { useState, useCallback, useRef } from 'react';
import { fetchJSON, streamSSE } from '../lib/api';

export interface ToolCallData {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallData[];
  isStreaming?: boolean;
}

export interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done' | 'error';
  content?: string;
  toolCall?: Partial<ToolCallData>;
  error?: string;
}

export interface KBQueryResultData {
  nodes: unknown[];
  traces: unknown[];
  groupsVisited: string[];
  totalNodesScanned: number;
  queryTimeMs: number;
  pulseSeeds: unknown[];
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [latestKBResult, setLatestKBResult] = useState<KBQueryResultData | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback((text: string) => {
    if (!text.trim() || isLoading) return;

    const userMsg: ChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    const assistantMsg: ChatMessage = { role: 'assistant', content: '', isStreaming: true };
    setMessages((prev) => [...prev, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = '';
    const toolCalls: ToolCallData[] = [];
    let currentToolCall: Partial<ToolCallData> | null = null;

    streamSSE(
      '/api/chat',
      { message: text, stream: true },
      {
        onData: (data) => {
          const chunk = data as StreamChunk;
          switch (chunk.type) {
            case 'text':
              accumulated += chunk.content ?? '';
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: accumulated };
                }
                return updated;
              });
              break;

            case 'tool_call_start':
              currentToolCall = chunk.toolCall ?? null;
              break;

            case 'tool_call_delta':
              if (currentToolCall && chunk.toolCall?.function?.arguments) {
                const existing = currentToolCall.function?.arguments ?? '';
                currentToolCall = {
                  ...currentToolCall,
                  function: {
                    name: currentToolCall.function?.name ?? chunk.toolCall.function?.name ?? '',
                    arguments: existing + chunk.toolCall.function.arguments,
                  },
                };
              }
              break;

            case 'tool_call_end':
              if (currentToolCall?.id) {
                toolCalls.push(currentToolCall as ToolCallData);
                currentToolCall = null;
              }
              break;

            case 'done':
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === 'assistant') {
                  updated[updated.length - 1] = {
                    ...last,
                    content: chunk.content ?? accumulated,
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                    isStreaming: false,
                  };
                }
                return updated;
              });
              setIsLoading(false);

              for (const tc of toolCalls) {
                if (tc.function.name === 'kb_query') {
                  try {
                    const result = JSON.parse(tc.function.arguments);
                    if (result && typeof result === 'object') {
                      setLatestKBResult(result as KBQueryResultData);
                    }
                  } catch { /* skip */ }
                }
              }
              break;

            case 'error':
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === 'assistant') {
                  updated[updated.length - 1] = {
                    ...last,
                    content: `Error: ${chunk.error ?? 'Unknown error'}`,
                    isStreaming: false,
                  };
                }
                return updated;
              });
              setIsLoading(false);
              break;
          }
        },
        onError: (err) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === 'assistant') {
              updated[updated.length - 1] = {
                ...last,
                content: `Error: ${err.message}`,
                isStreaming: false,
              };
            }
            return updated;
          });
          setIsLoading(false);
        },
        onDone: () => {
          setIsLoading(false);
        },
      },
      controller.signal,
    );
  }, [isLoading]);

  const clearHistory = useCallback(async () => {
    await fetchJSON('/api/chat/history', { method: 'DELETE' });
    setMessages([]);
    setLatestKBResult(null);
  }, []);

  const loadHistory = useCallback(async () => {
    const data = await fetchJSON<{ messages: ChatMessage[] }>('/api/chat/history');
    setMessages(data.messages ?? []);
  }, []);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.isStreaming) {
        updated[updated.length - 1] = { ...last, isStreaming: false };
      }
      return updated;
    });
  }, []);

  return {
    messages,
    isLoading,
    latestKBResult,
    sendMessage,
    clearHistory,
    loadHistory,
    stopStreaming,
  };
}
