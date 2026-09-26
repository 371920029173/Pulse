import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJSON, streamSSE } from '../lib/api';
import { t } from '../lib/i18n';
import type { ChatMessage } from './useChat';

interface ClusterMessage {
  id: string;
  role: string;
  name: string;
  content: string;
  created_at: string;
  parallel_group?: string;
  reasoning?: string;
}

interface ClusterMember {
  id: string;
  name: string;
  title: string;
  hue: number;
  phase: 'lead' | 'work' | 'review';
}

interface ClusterRoom {
  id: string;
  title: string;
  status: string;
  members: ClusterMember[];
  messages: ClusterMessage[];
  last_error?: string;
}

export interface ClusterChatState {
  room: ClusterRoom | null;
  messages: ChatMessage[];
  isLoading: boolean;
  status: string;
  /** Members currently producing output, for the header strip. */
  activeMembers: string[];
  /** Members that have finished this wave. */
  doneMembers: string[];
}

const SYSTEM_ROLES = new Set(['user', 'system']);

function hueOf(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 33 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * Drive a work group like a normal conversation.
 *
 * The difference from a 1:1 chat is only that several agents are present: the
 * user's message goes into the room, then a wave runs (lead → work in parallel
 * → review → lead summary) and every speaker streams into the same transcript.
 * Everything else — composer, history, display — is the ordinary chat surface.
 */
export function useClusterChat(roomId: string | null) {
  const [room, setRoom] = useState<ClusterRoom | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [activeMembers, setActiveMembers] = useState<string[]>([]);
  const [doneMembers, setDoneMembers] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  /** Map a stored room transcript onto the shared chat message shape. */
  const toChat = useCallback((room: ClusterRoom | null): ChatMessage[] => {
    if (!room) return [];
    return (room.messages ?? [])
      .filter((m) => !(m.role === 'system' && !m.content.trim()))
      .map((m) => {
        if (m.role === 'user') return { role: 'user' as const, content: m.content };
        if (m.role === 'system') return { role: 'system' as const, content: m.content };
        const member = room.members.find((x) => x.id === m.role || x.name === m.name);
        return {
          role: 'assistant' as const,
          content: m.content,
          reasoning: m.reasoning || undefined,
          speaker: { name: m.name, hue: member?.hue ?? hueOf(m.name) },
        };
      });
  }, []);

  /**
   * Load a room's transcript.
   *
   * Guarded against out-of-order responses. `load()` had no request token, so clicking two rooms
   * quickly could have a slower `load(A)` resolve AFTER `load(B)` and then `setRoom(A)` /
   * `setMessages(A)` while the rail showed B — the wrong group's members and messages on screen.
   */
  const loadSeq = useRef(0);
  const load = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    try {
      const r = await fetchJSON<ClusterRoom>(`/api/cluster/rooms/${id}`);
      if (seq !== loadSeq.current) return; // a newer load won
      setRoom(r);
      setMessages(toChat(r));
    } catch {
      if (seq !== loadSeq.current) return;
      setRoom(null);
      setMessages([]);
    }
  }, [toChat]);

  const roomRef = useRef<ClusterRoom | null>(null);
  roomRef.current = room;

  useEffect(() => {
    if (!roomId) {
      // Bump the token so an in-flight load for the previous room cannot land.
      loadSeq.current++;
      setRoom(null);
      setMessages([]);
      return;
    }
    // Leaving a room must detach its stream. The clients below close over this hook's `setMessages`,
    // and the hook instance survives the switch — so a running wave for group A kept appending A's
    // members' messages to group B's transcript, and `activeMembers` showed A's members in B's
    // header.
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setActiveMembers([]);
    void load(roomId);
  }, [roomId, load]);

  // A wave keeps running after this view leaves. Poll the room so coming back
  // shows who has spoken, instead of a transcript frozen at the moment of the switch.
  useEffect(() => {
    if (!roomId || isLoading || room?.status !== 'running') return;
    const timer = setInterval(() => { void load(roomId); }, 2000);
    return () => clearInterval(timer);
  }, [roomId, isLoading, room?.status, load]);

  /** Send a message to the group and let the agents work on it. */
  const send = useCallback(
    (text: string) => {
      const id = roomId;
      const goal = text.trim();
      if (!id || !goal || isLoading) return;

      setMessages((prev) => [...prev, { role: 'user', content: goal }]);
      setIsLoading(true);
      setStatus('群成员开始工作…');
      setActiveMembers([]);
      setDoneMembers([]);

      // One live bubble per speaking member, keyed by member id.
      const liveIndex = new Map<string, number>();
      const controller = new AbortController();
      abortRef.current = controller;

      streamSSE(
        `/api/cluster/rooms/${id}/run`,
        { goal, stream: true },
        {
          onData: (data) => {
            const chunk = data as {
              type?: string;
              content?: string;
              member?: string;
              phase?: string;
              memberState?: string;
              error?: string;
              room?: ClusterRoom;
              name?: string;
            };

            if (chunk.phase) setStatus(String(chunk.phase));
            if (chunk.type === 'error') {
              setStatus(String(chunk.error ?? '出错了'));
              setIsLoading(false);
              return;
            }
            if (chunk.type === 'done') {
              setStatus('本轮完成');
              setIsLoading(false);
              return;
            }
            if (chunk.type === 'room' && chunk.room) {
              setRoom(chunk.room);
              setMessages(toChat(chunk.room));
              // Indices into the old array are meaningless now.
              liveIndex.clear();
              return;
            }
            if (!chunk.member) return;

            // Track member state for the header strip.
            if (chunk.memberState === 'running') {
              // A member speaking again (the summary, or an automatic follow-up round) gets a new
              // bubble instead of being appended to the one from its previous turn.
              liveIndex.delete(chunk.member);
              setActiveMembers((prev) => (prev.includes(chunk.member!) ? prev : [...prev, chunk.member!]));
            } else if (chunk.memberState === 'done') {
              setActiveMembers((prev) => prev.filter((m) => m !== chunk.member));
              setDoneMembers((prev) => (prev.includes(chunk.member!) ? prev : [...prev, chunk.member!]));
            }

            if ((chunk.type === 'text' || chunk.type === 'reasoning') && chunk.content) {
              const mid = chunk.member;
              const piece = chunk.content;
              const known = roomRef.current?.members.find((m) => m.id === mid);
              const speaker = {
                name: chunk.name || known?.name || t('成员'),
                hue: known?.hue ?? hueOf(chunk.name || known?.name || mid),
              };
              setMessages((prev) => {
                const updated = [...prev];
                const idx = liveIndex.get(mid);
                if (idx === undefined) {
                  updated.push({
                    role: 'assistant',
                    content: chunk.type === 'text' ? piece : '',
                    reasoning: chunk.type === 'reasoning' ? piece : undefined,
                    speaker,
                    isStreaming: true,
                  });
                  liveIndex.set(mid, updated.length - 1);
                } else if (chunk.type === 'reasoning') {
                  updated[idx] = {
                    ...updated[idx],
                    speaker,
                    reasoning: (updated[idx].reasoning ?? '') + piece,
                  };
                } else {
                  updated[idx] = {
                    ...updated[idx],
                    speaker,
                    content: (updated[idx].content ?? '') + piece,
                  };
                }
                return updated;
              });
            }
          },
          onError: (err) => {
            setStatus(`出错：${err.message}`);
            setIsLoading(false);
          },
          onDone: () => {
            setIsLoading(false);
            setActiveMembers([]);
          },
        },
        controller.signal,
        { idleTimeoutMs: 0 },
      );
    },
    [roomId, isLoading, toChat],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Aborting the stream only detaches this view; the wave (and its automatic follow-up rounds)
    // runs on the server until it is told to stop.
    if (roomId) {
      void fetchJSON(`/api/cluster/rooms/${roomId}/stop`, { method: 'POST', body: {} })
        .then(() => load(roomId))
        .catch(() => { /* the room may already be idle */ });
    }
    setIsLoading(false);
    setStatus('已中断');
  }, [roomId, load]);

  const refresh = useCallback(() => {
    if (roomId) void load(roomId);
  }, [roomId, load]);

  return { room, messages, isLoading, status, activeMembers, doneMembers, send, stop, refresh };
}
