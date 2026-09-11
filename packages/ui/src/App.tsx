import { useState, useEffect, useCallback } from 'react';
import { useChat } from './hooks/useChat';
import { useKB } from './hooks/useKB';
import { Chat } from './components/Chat';
import { Sidebar } from './components/Sidebar';
import { PulseTracePanel } from './components/PulseTracePanel';
import { GroupBrowser } from './components/GroupBrowser';
import styles from './styles/App.module.css';

export function App() {
  const chat = useChat();
  const kb = useKB();
  const [showTrace, setShowTrace] = useState(true);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  useEffect(() => {
    kb.fetchTree();
  }, []);

  useEffect(() => {
    if (chat.latestKBResult) {
      setShowTrace(true);
    }
  }, [chat.latestKBResult]);

  const handleGroupClick = useCallback((id: string) => {
    setSelectedGroupId(id);
    kb.fetchGroup(id);
  }, [kb]);

  const handleCloseGroup = useCallback(() => {
    setSelectedGroupId(null);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedGroupId) setSelectedGroupId(null);
        else setShowTrace(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedGroupId]);

  return (
    <div className={styles.layout}>
      <Sidebar
        tree={kb.tree}
        onGroupClick={handleGroupClick}
      />

      <main className={styles.main}>
        <Chat
          messages={chat.messages}
          isLoading={chat.isLoading}
          onSend={chat.sendMessage}
          onClear={chat.clearHistory}
          onStop={chat.stopStreaming}
        />
      </main>

      {showTrace && (
        <aside className={styles.tracePanel}>
          <PulseTracePanel
            result={chat.latestKBResult as any}
            onClose={() => setShowTrace(false)}
          />
        </aside>
      )}

      {selectedGroupId && kb.selectedGroup && (
        <GroupBrowser
          group={kb.selectedGroup.group as any}
          memories={kb.selectedGroup.memories as any}
          onClose={handleCloseGroup}
        />
      )}
    </div>
  );
}
