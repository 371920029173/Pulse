import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { ChatMessage, ToolCallData } from '../hooks/useChat';
import styles from '../styles/Chat.module.css';

interface ChatProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onSend: (text: string) => void;
  onClear: () => void;
  onStop: () => void;
}

function ToolCallCard({ toolCall, denied }: { toolCall: ToolCallData; denied?: boolean }) {
  const [open, setOpen] = useState(false);

  let parsedArgs: string;
  try {
    parsedArgs = JSON.stringify(JSON.parse(toolCall.function.arguments), null, 2);
  } catch {
    parsedArgs = toolCall.function.arguments;
  }

  return (
    <div className={`${styles.toolCallCard} ${denied ? styles.toolCallCardDenied : ''}`}>
      <div className={styles.toolCallHeader} onClick={() => setOpen((v) => !v)}>
        <div className={`${styles.toolCallLabel} ${denied ? styles.toolCallLabelDenied : ''}`}>
          <span className={styles.toolCallIcon}>{denied ? '✕' : '⚡'}</span>
          <span className={styles.toolCallName}>{toolCall.function.name}</span>
        </div>
        <span className={`${styles.toolCallChevron} ${open ? styles.toolCallChevronOpen : ''}`}>
          ▾
        </span>
      </div>
      {open && (
        <div className={styles.toolCallBody}>
          <div className={styles.toolCallSection}>
            <div className={styles.toolCallSectionLabel}>Arguments</div>
            <pre className={styles.toolCallPre}>{parsedArgs}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    return (
      <>
        {msg.content && (
          <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
            <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
              {msg.content}
              {msg.isStreaming && <span className={styles.streamingDot} />}
            </div>
          </div>
        )}
        {msg.toolCalls.map((tc) => (
          <div key={tc.id} className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
            <ToolCallCard toolCall={tc} />
          </div>
        ))}
      </>
    );
  }

  const isUser = msg.role === 'user';

  return (
    <div className={`${styles.messageRow} ${isUser ? styles.messageRowUser : styles.messageRowAssistant}`}>
      <div className={`${styles.bubble} ${isUser ? styles.bubbleUser : styles.bubbleAssistant}`}>
        {msg.content || (msg.isStreaming ? '' : '(empty response)')}
        {msg.isStreaming && <span className={styles.streamingDot} />}
      </div>
    </div>
  );
}

export function Chat({ messages, isLoading, onSend, onClear, onStop }: ChatProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, isLoading, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const el = e.target;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    },
    [],
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Chat</span>
        <div className={styles.headerActions}>
          <button className={styles.headerBtn} onClick={onClear}>
            Clear
          </button>
        </div>
      </div>

      <div className={styles.messages}>
        {messages.length === 0 ? (
          <div className={styles.emptyMessages}>
            <div className={styles.emptyIcon}>⚡</div>
            <div className={styles.emptyText}>Start a conversation</div>
            <div className={styles.emptyHint}>
              Ask questions, run commands, or explore your codebase
            </div>
          </div>
        ) : (
          messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.inputArea}>
        <div className={styles.inputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder="Type a message..."
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          {isLoading ? (
            <button
              className={`${styles.sendBtn} ${styles.sendBtnStop}`}
              onClick={onStop}
              title="Stop"
            >
              ■
            </button>
          ) : (
            <button
              className={`${styles.sendBtn} ${!input.trim() ? styles.sendBtnDisabled : ''}`}
              onClick={handleSend}
              disabled={!input.trim()}
              title="Send (⌘+Enter)"
            >
              ↑
            </button>
          )}
        </div>
        <div className={styles.inputHint}>⌘ + Enter to send</div>
      </div>
    </div>
  );
}
