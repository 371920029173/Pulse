import { useState, useEffect, useCallback, useRef } from 'react';
import { useChat } from './hooks/useChat';
import { useKB } from './hooks/useKB';
import { useBackground } from './hooks/useBackground';
import { useClusterChat } from './hooks/useClusterChat';
import { fetchJSON } from './lib/api';
import { isSkillProfile } from './lib/skills';
import { Chat, type SkillProfileId, type ThinkingLevel } from './components/Chat';
import { Sidebar, type SessionMeta } from './components/Sidebar';
import { PulseTracePanel } from './components/PulseTracePanel';
import { GroupBrowser } from './components/GroupBrowser';
import { Settings } from './components/Settings';
import { KbImport } from './components/KbImport';
import { ImportKnowledge } from './components/ImportKnowledge';
import { StatusBar } from './components/StatusBar';
import { CheckpointTimeline } from './components/CheckpointTimeline';
import { TerminalPanel } from './components/TerminalPanel';
import { CommandPalette, type CommandItem } from './components/CommandPalette';
import { TaskCards } from './components/TaskCards';
import { ConnectionBanner } from './components/ConnectionBanner';
import { Toast } from './components/Toast';
import { toast } from './lib/toast';
import { ClusterPanel } from './components/ClusterPanel';
import { PlanPanel } from './components/PlanPanel';
import { Home } from './components/Home';
import { ImportSources } from './components/ImportSources';
import { Dock } from './components/Dock';
import { Memo } from './components/Memo';
import { SessionHistory } from './components/SessionHistory';
import { SchedulePanel } from './components/SchedulePanel';
import { AuditPanel } from './components/AuditPanel';
import { ThemeStudio } from './components/ThemeStudio';
import { useUserTheme } from './hooks/useUserTheme';
import { pickActiveSession, isSessionKnown } from './lib/sessionChoice';
import { getLocale, setLocale, t } from './lib/i18n';
import type { Locale } from './lib/i18n';
import { SkillManager } from './components/SkillManager';
import styles from './styles/App.module.css';

/**
 * Layout preferences that belong to THIS WINDOW, not to the app.
 *
 * Pane widths, focus mode and the collapsed sidebar are view decisions — the desktop shell
 * advertises 新建窗口 as a parallel view ("独立会话，可与本窗口并列"). They lived in `localStorage`, so
 * a newly opened or reloaded window silently inherited the other window's layout (it could come up in
 * focus mode with the sidebar hidden), and both windows then overwrote the same keys, so the last
 * one to change something won on every later reload.
 *
 * `sessionStorage` is per window (per tab in a browser), which is the correct scope — the same
 * storage already used for this window's conversation.
 *
 * The read falls back to the old `localStorage` key so an existing user keeps the layout they had in
 * their first window, rather than being reset to defaults by the change.
 */
const LAYOUT_PREFIX = 'she.layout.';

function readLayout(name: string, legacyDefault: string): string {
  try {
    const current = sessionStorage.getItem(LAYOUT_PREFIX + name);
    if (current !== null) return current;
    const legacy = localStorage.getItem(`she.${name}`);
    if (legacy !== null) return legacy;
  } catch { /* private mode: fall through to the default */ }
  return legacyDefault;
}

function writeLayout(name: string, value: string): void {
  try {
    sessionStorage.setItem(LAYOUT_PREFIX + name, value);
  } catch { /* not worth failing a render over */ }
}

function useIsSheDesktop(): boolean {
  return typeof window !== 'undefined' && Boolean(window.sheDesktop?.isDesktop);
}


export function App() {
  const isDesktop = useIsSheDesktop();
  useEffect(() => {
    const cls = 'she-desktop';
    if (isDesktop) document.documentElement.classList.add(cls);
    else document.documentElement.classList.remove(cls);
    return () => document.documentElement.classList.remove(cls);
  }, [isDesktop]);

  /**
   * Home screen gate. Shown on first load so the user picks a workspace;
   * "直接进入" skips it for subsequent visits in the same session.
   */
  const [entered, setEntered] = useState<boolean>(() => sessionStorage.getItem('she.entered') === '1');
  // Session identity must exist before useChat so every request is bound to
  // this window's own conversation.
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  /**
   * This window's own conversation.
   *
   * Restored from `sessionStorage`, which is per-window (per-tab in a browser). The server
   * keeps ONE global active session, so without a per-window record a reloaded or newly
   * opened window inherits whatever conversation another window happens to be on.
   *
   * Validated against the session list after the first fetch — a stored id can be stale
   * (the conversation was deleted in another window), and using it would show an empty
   * transcript with no explanation.
   */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try { return sessionStorage.getItem('she.session') || null; } catch { return null; }
  });
  const chat = useChat(activeSessionId);
  const kb = useKB();
  const bg = useBackground();
  const [showTrace, setShowTrace] = useState(true);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Which Settings block to scroll to when it opens (e.g. the shared knowledge base). */
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(true);
  const [filePreview, setFilePreview] = useState<{ path: string; content: string } | null>(null);
  const [draftInsert, setDraftInsert] = useState<string | null>(null);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [showCluster, setShowCluster] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showMemo, setShowMemo] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showTheme, setShowTheme] = useState(false);

  /*
   * The user stylesheet lives here, at the root, not inside the editor panel.
   *
   * This hook is what injects the saved stylesheet into the document, so mounting it in the
   * panel meant a saved theme applied only while the panel was open — restart the app and the
   * theme was gone until you reopened the editor. It also made `?theme=off` a no-op on a
   * normal load, since there was nothing applied to escape from.
   */
  const userTheme = useUserTheme();
  /*
   * Locale lives in App so a change re-renders the whole tree immediately.
   * 	() reads a module-level value, so without a state change React would not
   * know anything had changed and the UI would keep the old language until a
   * reload.
   */
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  const handleLocale = useCallback((l: Locale) => {
    setLocale(l);
    setLocaleState(l);
  }, []);
  const [clusterFocusId, setClusterFocusId] = useState<string | null>(null);
  /** Work group currently open in the chat surface (null = normal chat). */
  const [clusterRoomId, setClusterRoomId] = useState<string | null>(null);
  const clusterChat = useClusterChat(clusterRoomId);
  const inGroupMode = Boolean(clusterRoomId);
  const [sidebarForce, setSidebarForce] = useState(false);
  /** True collapse (distinct from the narrow-screen "force" mode). */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readLayout('sidebarCollapsed', '0') === '1',
  );
  const [skillProfile, setSkillProfile] = useState<SkillProfileId>(() => {
    const v = localStorage.getItem('she.skillProfile');
    return isSkillProfile(v) ? v : 'dev';
  });
  /*
   * The server is the source of truth for the ACTIVE skill profile.
   *
   * The client kept its own copy in localStorage and never asked, so the two drifted: with
   * `SHE_SKILL_PROFILE=general` on the server, the settings panel (which reads the server) showed
   * 通用 while the composer highlighted 开发 — the button was showing a profile the agent was not
   * using. A control that reports the wrong state is worse than no control.
   *
   * Read once on boot, after which the user's clicks drive both sides through `handleSkillProfile`.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await fetchJSON<{ skills?: { profile?: string } }>('/api/settings');
        if (cancelled || !isSkillProfile(d.skills?.profile)) return;
        setSkillProfile(d.skills.profile);
        try { localStorage.setItem('she.skillProfile', d.skills.profile); } catch { /* ignore */ }
      } catch { /* keep the local value when the server cannot be reached */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => {
    const v = localStorage.getItem('she.thinkingLevel');
    const all: ThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    return all.includes(v as ThinkingLevel) ? (v as ThinkingLevel) : 'medium';
  });

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = Number(readLayout('sidebarW', '240'));
    return Number.isFinite(v) ? Math.min(900, Math.max(120, v)) : 240;
  });
  const [traceWidth, setTraceWidth] = useState(() => {
    const v = Number(readLayout('traceW', '320'));
    return Number.isFinite(v) ? Math.min(900, Math.max(120, v)) : 320;
  });
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const v = Number(readLayout('termH', '220'));
    return Number.isFinite(v) ? Math.min(720, Math.max(100, v)) : 220;
  });
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('she.theme') === 'light' ? 'light' : 'dark',
  );
  const [focusChat, setFocusChat] = useState(() => readLayout('focusChat', '0') === '1');
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<null | { kind: 'sidebar' | 'trace' | 'terminal'; startX: number; startY: number; startW: number; startH: number }>(null);
  /** Live values during a drag; committed to state on mouseup. */
  const pendingRef = useRef<{ sidebar?: number; trace?: number; term?: number }>({});
  const rafRef = useRef<number | null>(null);
  /** True only while a splitter is held, so CSS can drop width transitions. */
  const [dragging, setDragging] = useState(false);
  /**
   * Mirrors layout state for the drag handler, which intentionally has no deps
   * (it must not re-bind listeners on every width change).
   */
  const dragCfgRef = useRef({
    sidebarW: 240, traceW: 320, showTrace: true, sidebarCollapsed: false, focusChat: false,
  });
  useEffect(() => {
    dragCfgRef.current = { sidebarW: sidebarWidth, traceW: traceWidth, showTrace, sidebarCollapsed, focusChat };
  }, [sidebarWidth, traceWidth, showTrace, sidebarCollapsed, focusChat]);

  /**
   * Largest a side panel may become without squeezing the chat column out.
   *
   * The panels no longer shrink, so the drag itself has to enforce the limit
   * that `clampPanelsForViewport` applies on window resize — otherwise a wide
   * sidebar plus an open trace panel would overflow the row and clip the chat.
   */
  const maxPanelWidth = useCallback((kind: 'sidebar' | 'trace'): number => {
    const c = dragCfgRef.current;
    const vw = window.innerWidth;
    const other = kind === 'sidebar'
      ? (c.showTrace && !c.focusChat ? c.traceW : 0)
      : (!c.sidebarCollapsed && !c.focusChat ? c.sidebarW : 0);
    // 400px let both panels squeeze the transcript to ~408px, which made
    // reasoning blocks and code unreadable. Keep enough for a real reading
    // column; on a narrow window this scales down rather than overflowing.
    const reservedCenter = Math.min(560, Math.max(320, Math.round(vw * 0.42)));
    const handles = 24; // two 8px splitters + borders
    return Math.max(160, vw - other - reservedCenter - handles);
  }, []);

  /**
   * Refresh the session rail.
   *
   * The LIST always updates. The selected conversation updates only when this window has not
   * chosen one yet.
   *
   * `active_id` is a single value on the server, and this used to be adopted unconditionally —
   * on every turn start and end. That made the conversation a window is reading something
   * another actor could change underneath it: a second window selecting its own chat, or a
   * scheduled task running headlessly and activating the session it works in, would drag this
   * window onto a different conversation mid-sentence. Requests all carry `session_id`, so the
   * server's idea of "active" is only a starting hint, not an instruction to follow.
   */
  const clusterRoomRef = useRef<string | null>(null);
  const refreshSessions = useCallback(async () => {
    // Combined list: normal chats + work groups, so groups are reachable from
    // the session rail instead of only from the cluster panel.
    const data = await fetchJSON<{ active_id: string | null; items?: SessionMeta[]; sessions?: SessionMeta[] }>(
      '/api/conversations',
    );
    setSessions(data.items ?? data.sessions ?? []);
    setActiveSessionId((cur) => pickActiveSession(cur, clusterRoomRef.current !== null, data.active_id));
  }, []);

  // Mirrored into a ref so `refreshSessions` can stay dependency-free (it is called from many
  // effects, and rebuilding it on every cluster change would restart the polling loops).
  useEffect(() => { clusterRoomRef.current = clusterRoomId; }, [clusterRoomId]);

  /**
   * Remember this window's conversation, and drop it if it no longer exists.
   *
   * Staleness matters: a conversation deleted in another window would otherwise be restored
   * forever, showing an empty chat with no reason why.
   */
  useEffect(() => {
    try {
      if (activeSessionId) sessionStorage.setItem('she.session', activeSessionId);
      else sessionStorage.removeItem('she.session');
    } catch { /* private mode, quota: not worth failing over */ }
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId || sessions.length === 0) return;
    if (!isSessionKnown(activeSessionId, sessions.map((s) => s.id))) setActiveSessionId(null);
  }, [sessions, activeSessionId]);

  const { loadHistory } = chat;

  useEffect(() => {
    // Restore persisted state on boot: KB tree, session list, and the
    // conversation itself (previously the chat pane always came up empty).
    kb.fetchTree();
    refreshSessions().catch(() => undefined);
    loadHistory().catch(() => undefined);
  }, [kb.fetchTree, refreshSessions, loadHistory]);

  /**
   * Keep the session rail in sync with the conversation.
   *
   * The server creates a session on the first message if none exists. Without
   * refetching on BOTH edges of `isLoading`, sending into an empty app left the
   * rail showing "暂无会话" even though a conversation was running.
   */
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    const justStarted = !wasLoadingRef.current && chat.isLoading;
    const justFinished = wasLoadingRef.current && !chat.isLoading;
    wasLoadingRef.current = chat.isLoading;

    if (justStarted || justFinished) {
      refreshSessions().catch(() => undefined);
    }
  }, [chat.isLoading, refreshSessions]);

  /**
   * Adopt the server's active session when we do not have one locally.
   * This is what makes a fresh app show the auto-created conversation selected.
   */
  useEffect(() => {
    if (activeSessionId || clusterRoomId) return;
    let cancelled = false;
    const adopt = async () => {
      try {
        const d = await fetchJSON<{ active_id: string | null }>('/api/sessions');
        // Same rule as the list refresh, deliberately: this only runs while the window has no
        // selection, but stated the same way it cannot drift into a second, subtly different
        // policy — and the invariant is checkable in one place.
        if (!cancelled) {
          setActiveSessionId((cur) => pickActiveSession(cur, clusterRoomRef.current !== null, d.active_id));
        }
      } catch { /* ignore */ }
    };
    void adopt();
    const t = window.setInterval(adopt, 4000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [activeSessionId, clusterRoomId]);

  // Re-bind history whenever this window switches session.
  useEffect(() => {
    if (!activeSessionId) return;
    loadHistory().catch(() => undefined);
  }, [activeSessionId, loadHistory]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('she.theme', theme);
  }, [theme]);

  useEffect(() => {
    writeLayout('focusChat', focusChat ? '1' : '0');
  }, [focusChat]);

  useEffect(() => {
    writeLayout('sidebarW', String(sidebarWidth));
    writeLayout('traceW', String(traceWidth));
  }, [sidebarWidth, traceWidth]);

  useEffect(() => {
    writeLayout('termH', String(terminalHeight));
  }, [terminalHeight]);

  useEffect(() => {
    writeLayout('sidebarCollapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem('she.skillProfile', skillProfile);
  }, [skillProfile]);

  useEffect(() => {
    localStorage.setItem('she.thinkingLevel', thinkingLevel);
  }, [thinkingLevel]);

  /**
   * Publish "is a turn running" to the desktop shell.
   *
   * The main process reads this synchronously (executeJavaScript) when the
   * window is closed, so it can ask before hiding mid-task instead of silently
   * appearing to cancel the work.
   */
  useEffect(() => {
    window.__sheBusy = chat.isLoading;
  }, [chat.isLoading]);

  useEffect(() => {
    // Shares maxPanelWidth with the drag handler so a resize cannot snap a
    // panel back to a width the user just dragged to.
    const clampPanelsForViewport = () => {
      setSidebarWidth((sw) => Math.min(sw, maxPanelWidth('sidebar')));
      setTraceWidth((tw) => Math.min(tw, maxPanelWidth('trace')));
    };
    clampPanelsForViewport();
    window.addEventListener('resize', clampPanelsForViewport);
    return () => window.removeEventListener('resize', clampPanelsForViewport);
  }, [maxPanelWidth]);

  /**
   * Panel resizing.
   *
   * During a drag we mutate the CSS custom properties straight on the layout
   * element (and commit to React state on release). Going through setState on
   * every mousemove re-rendered the whole transcript — hundreds of messages —
   * which made the drag visibly lag behind the cursor.
   */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const el = layoutRef.current;
      if (el) {
        if (d.kind === 'sidebar') {
          pendingRef.current.sidebar = Math.min(
            maxPanelWidth('sidebar'),
            Math.max(140, d.startW + (e.clientX - d.startX)),
          );
          el.style.setProperty('--sidebar-w', `${pendingRef.current.sidebar}px`);
        } else if (d.kind === 'trace') {
          pendingRef.current.trace = Math.min(
            maxPanelWidth('trace'),
            Math.max(140, d.startW - (e.clientX - d.startX)),
          );
          el.style.setProperty('--trace-w', `${pendingRef.current.trace}px`);
        } else {
          pendingRef.current.term = Math.min(720, Math.max(100, d.startH - (e.clientY - d.startY)));
          // Terminal height is read by TerminalPanel; nudge it via the same var.
          el.style.setProperty('--term-h', `${pendingRef.current.term}px`);
        }
      }
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => { rafRef.current = null; });
      }
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Commit once, so state and DOM agree.
      const p = pendingRef.current;
      if (p.sidebar != null) setSidebarWidth(p.sidebar);
      if (p.trace != null) setTraceWidth(p.trace);
      if (p.term != null) setTerminalHeight(p.term);
      pendingRef.current = {};
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /*
   * Do not force the trace panel open on new data.
   *
   * This used to run `setShowTrace(true)` on every KB result, so closing the panel was futile: the
   * next `kb_query` (which the agent performs on its own) slid it back open. A panel the user
   * explicitly closed must stay closed — being overruled is worse than not having the toggle.
   *
   * What replaces it: the reopen handle is badged instead, so the arrival of trace data is visible
   * without taking over the screen. `traceHasNew` is cleared when the panel is opened.
   */
  const [traceHasNew, setTraceHasNew] = useState(false);
  useEffect(() => {
    if (chat.latestKBResult) setTraceHasNew(true);
  }, [chat.latestKBResult]);

  useEffect(() => {
    if (showTrace) setTraceHasNew(false);
  }, [showTrace]);

  const handleGroupClick = useCallback((id: string) => {
    setSelectedGroupId(id);
    kb.fetchGroup(id);
  }, [kb]);

  const handleCloseGroup = useCallback(() => {
    setSelectedGroupId(null);
  }, []);

  const handleNewSession = useCallback(async () => {
    // Create + activate FIRST, then clear local state.
    // The previous order called clearHistory() before switching, which sent a
    // DELETE without a session id and wiped the PREVIOUS conversation.
    const created = await fetchJSON<{ id: string }>('/api/sessions', { method: 'POST', body: {} });
    setActiveSessionId(created.id);
    chat.resetLocal();
    await refreshSessions();
  }, [chat, refreshSessions]);

  /** Let the File > 新建会话 menu item create a session (defined above it). */
  useEffect(() => {
    const off = window.sheDesktop?.onNewSession?.(() => { void handleNewSession(); });
    return off;
  }, [handleNewSession]);

  const handleSelectSession = useCallback(async (id: string) => {
    // A work group opens in the SAME chat surface — the only difference is that
    // several agents are present. No separate modal.
    const meta = sessions.find((s) => s.id === id);
    if (meta?.kind === 'cluster') {
      /*
       * Leave the running turn behind instead of letting it write into the group view.
       *
       * The stream handlers close over the hook's `setMessages`, and this hook instance survives the
       * switch — so a turn for the previous session kept appending tool results and streamed text to
       * whatever was on screen.
       */
      chat.detachStream();
      setClusterRoomId(id);
      setActiveSessionId(null);
      return;
    }
    setClusterRoomId(null);
    if (id === activeSessionId) return;
    chat.detachStream();
    const s = await fetchJSON<{ id: string; directory?: string }>(`/api/sessions/${id}/activate`, {
      method: 'POST',
      body: {},
    });
    setActiveSessionId(s.id);
    await chat.loadHistory(s.id);
    await refreshSessions();
    // The session may live in another project. Refresh the tree so the files
    // on screen are the ones this conversation can actually edit.
    if (s.directory) await kb.fetchTree();
  }, [activeSessionId, chat, refreshSessions, sessions, kb]);

  const handleRenameSession = useCallback(async (id: string, title: string) => {
    await fetchJSON(`/api/sessions/${id}`, { method: 'PUT', body: { title } });
    await refreshSessions();
  }, [refreshSessions]);

  const handleEnterWorkspace = useCallback(async (root: string) => {
    sessionStorage.setItem('she.entered', '1');
    /*
     * Drop this window's saved conversation BEFORE adopting one.
     *
     * It belongs to the workspace being left, where it was meaningless anyway — sessions are
     * stored per workspace — and keeping it would make the new workspace's first load try to
     * open a session that does not exist. Unlike a plain refresh, this is the one place where
     * the server's value legitimately replaces a local choice.
     */
    try { sessionStorage.removeItem('she.session'); } catch { /* ignore */ }
    setActiveSessionId(null);
    setEntered(true);
    // Re-bind everything to the newly selected workspace.
    try {
      const data = await fetchJSON<{ active_id: string | null }>('/api/sessions');
      setActiveSessionId(data.active_id);
      await chat.resetLocal();
      // Explicit id, for the same reason as `handleSelectSession`: `sidRef` is assigned during
      // render and still holds the previous workspace's session at this point.
      await chat.loadHistory(data.active_id ?? undefined);
      await kb.fetchTree();
    } catch {
      /* non-fatal */
    }
    void root;
  }, [chat, kb]);

  const handleSkillProfile = useCallback(async (profile: SkillProfileId) => {
    setSkillProfile(profile);
    await fetchJSON('/api/skills/profile', { method: 'PUT', body: { profile } });
  }, []);

  const handleThinkingLevel = useCallback(async (level: ThinkingLevel) => {
    setThinkingLevel(level);
    try {
      await fetchJSON('/api/settings', { method: 'PUT', body: { thinkingLevel: level } });
    } catch {
      /* non-fatal: local state still applies for this session */
    }
  }, []);

  const handleExportSession = useCallback(async (id: string) => {
    /*
     * Work groups live in the same rail but are not sessions.
     *
     * Passing a room id to `/api/sessions/:id/export` returned 404 and the
     * export silently failed, so the endpoint is chosen from the row's kind —
     * the same way `handleCloseSession` already does.
     */
    const meta = sessions.find((s) => s.id === id);
    const isGroup = meta?.kind === 'cluster';
    const endpoint = isGroup ? `/api/cluster/rooms/${id}/export` : `/api/sessions/${id}/export`;

    let res: Response;
    try {
      res = await fetch(endpoint);
    } catch (e) {
      toast(`导出失败：${(e as Error).message}`);
      return;
    }
    if (!res.ok) {
      // Tell the user instead of failing mutely in the console.
      toast(`导出失败（HTTP ${res.status}）`);
      return;
    }
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const ael = document.createElement('a');
    ael.href = url;
    ael.download = `${isGroup ? 'she-group' : 'she-session'}-${id}.md`;
    ael.click();
    URL.revokeObjectURL(url);
  }, [sessions]);

  const handleCloseSession = useCallback(async (id: string) => {
    const meta = sessions.find((s) => s.id === id);
    if (meta?.kind === 'cluster') {
      await fetchJSON(`/api/cluster/rooms/${id}`, { method: 'DELETE' });
    } else {
      await fetchJSON(`/api/sessions/${id}/close`, { method: 'POST', body: {} });
    }
    // If the closed item was on screen, drop out of it.
    if (clusterRoomId === id) setClusterRoomId(null);
    if (activeSessionId === id) {
      setActiveSessionId(null);
      chat.resetLocal();
    }
    await refreshSessions();
  }, [sessions, clusterRoomId, activeSessionId, chat, refreshSessions]);

  const handleOpenHistory = useCallback(() => setShowHistory(true), []);

  const handleReopened = useCallback(async (id: string) => {
    setShowHistory(false);
    chat.detachStream();
    setClusterRoomId(null);
    setActiveSessionId(id);
    await chat.loadHistory(id);
    await refreshSessions();
  }, [chat, refreshSessions]);

  const handleDeleteSession = useCallback(async (id: string) => {
    // Work groups live in the cluster store, not the session store, so they
    // need their own endpoint — otherwise the delete silently did nothing.
    const meta = sessions.find((s) => s.id === id);
    if (meta?.kind === 'cluster') {
      await fetchJSON(`/api/cluster/rooms/${id}`, { method: 'DELETE' });
    } else {
      await fetchJSON(`/api/sessions/${id}`, { method: 'DELETE' });
    }
    // Leaving the deleted item open would strand the UI on a session that no
    // longer exists (this is what left the app "still inside a work group"
    // after every conversation was removed).
    if (clusterRoomId === id) setClusterRoomId(null);
    if (activeSessionId === id) {
      setActiveSessionId(null);
      chat.resetLocal();
    }
    await refreshSessions();
  }, [chat, refreshSessions, sessions, clusterRoomId, activeSessionId]);

  const handleRewindTo = useCallback(async (index: number) => {
    await chat.rewindTo(index);
    await refreshSessions();
  }, [chat, refreshSessions]);

  const paletteCommands: CommandItem[] = [
    { id: 'new', title: '新建会话', group: '会话', hint: 'N', run: () => { void handleNewSession(); } },
    {
      id: 'worktree',
      title: t('新建并行工作副本'),
      group: t('会话'),
      run: () => {
        const name = window.prompt(t('副本名称。会在仓库旁边建一个独立目录，和当前文件互不覆盖。'), '');
        if (!name?.trim()) return;
        void (async () => {
          try {
            const created = await fetchJSON<{ session: { id: string } }>('/api/worktrees', {
              method: 'POST',
              body: { name: name.trim() },
            });
            const opened = await fetchJSON<{ id: string; directory?: string }>(
              `/api/sessions/${created.session.id}/activate`,
              { method: 'POST', body: {} },
            );
            setClusterRoomId(null);
            setActiveSessionId(opened.id);
            await chat.loadHistory(opened.id);
            await refreshSessions();
            await kb.fetchTree();
            toast(t('已打开并行副本'));
          } catch (e) {
            toast(t('未能创建并行副本：{msg}', { msg: (e as Error).message }));
          }
        })();
      },
    },
    { id: 'skill-dev', title: '技能档位：开发', group: '技能', run: () => { void handleSkillProfile('dev'); } },
    { id: 'skill-lib', title: '技能档位：创作', group: '技能', run: () => { void handleSkillProfile('liberal'); } },
    { id: 'skill-gen', title: '技能档位：通用', group: '技能', run: () => { void handleSkillProfile('general'); } },
    { id: 'skill-custom', title: '技能档位：自定义', group: '技能', run: () => { void handleSkillProfile('custom'); } },
    { id: 'settings', title: '打开设置', group: '导航', hint: ',', run: () => setShowSettings(true) },
    { id: 'plans', title: '打开长程计划', group: '协作', run: () => setShowPlans(true) },
    { id: 'schedule', title: '打开定时任务', group: '协作', run: () => setShowSchedule(true) },
    { id: 'audit', title: t('打开审计记录'), group: '协作', run: () => setShowAudit(true) },
    { id: 'theme', title: t('自定义样式（换肤）'), group: t('外观'), run: () => setShowTheme(true) },
    { id: 'cluster', title: '打开自动化讨论群', group: '协作', run: () => setShowCluster(true) },
    { id: 'sources', title: '导入 Cursor / Claude Code / Codex 对话', group: '知识库', run: () => setShowSources(true) },
    { id: 'kb-import', title: '导入知识库', group: '知识库', hint: 'I', run: () => setShowImport(true) },
    { id: 'import', title: '导入知识到 KB', group: '知识库', run: () => setShowKnowledge(true) },
    { id: 'terminal', title: showTerminal ? '折叠终端' : '展开终端', group: '导航', hint: '`', run: () => setShowTerminal((v) => !v) },
    { id: 'trace', title: showTrace ? '隐藏组结构轨迹' : '显示组结构轨迹', group: '导航', run: () => setShowTrace((v) => !v) },
    { id: 'cp', title: '打开检查点时间线', group: '工作区', run: () => setShowCheckpoints(true) },
    { id: 'focus', title: focusChat ? '退出专注对话' : '专注对话（放大聊天区）', group: '外观', hint: '\\', run: () => setFocusChat((v) => !v) },
    { id: 'theme', title: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', group: '外观', hint: 'T', run: () => setTheme((v) => (v === 'dark' ? 'light' : 'dark')) },
    { id: 'clear', title: '清空当前对话', group: '会话', run: () => { void chat.clearHistory(); } },
  ];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette((v) => !v);
        return;
      }
      if (meta && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault();
        setFocusChat((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        /*
         * If a dialog already handled Escape, stop here.
         *
         * `useEscapeToClose` listens on `document` and calls `preventDefault()`; this handler listens
         * on `window`, and `document` fires first in the bubble path — so both ran. Pressing Escape
         * with the skill manager, history or the stylesheet editor open closed that dialog AND fell
         * through to `else setShowTrace(false)`, silently collapsing the 组结构共振轨迹 panel as
         * well. None of those three appear in the chain below, which is why the fall-through reached
         * the last branch.
         */
        if (e.defaultPrevented) return;
        if (focusChat) { setFocusChat(false); return; }
        if (showPalette) setShowPalette(false);
        else if (showCheckpoints) setShowCheckpoints(false);
        else if (showCluster) setShowCluster(false);
        else if (showPlans) setShowPlans(false);
        else if (showImport) setShowImport(false);
        else if (showKnowledge) setShowKnowledge(false);
        else if (showSettings) setShowSettings(false);
        else if (showSkills) setShowSkills(false);
        else if (showHistory) setShowHistory(false);
        else if (showTheme) setShowTheme(false);
        else if (showSchedule) setShowSchedule(false);
        else if (showAudit) setShowAudit(false);
        else if (showMemo) setShowMemo(false);
        else if (selectedGroupId) setSelectedGroupId(null);
        else setShowTrace(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedGroupId, showSettings, showImport, showKnowledge, filePreview, showCheckpoints, showPalette, showTerminal, showTrace, showCluster, showPlans, showAudit, chat, handleNewSession, focusChat, theme]);

  /**
   * The wallpaper layer.
   *
   * Must live OUTSIDE the `entered` branch: Home returns early, so a <video>
   * declared only in the chat layout never mounted on the home screen — the
   * user picked a video background and saw nothing. Image wallpapers are
   * painted by CSS on `html[data-bg="image"]`, but a video cannot come from
   * `url()`, so it needs this real element on both pages.
   */
  const backgroundLayer =
    bg.enabled && bg.meta.kind === 'video' && bg.meta.url ? (
      <video className="she-bg-video" src={bg.meta.url} autoPlay loop muted playsInline />
    ) : null;

  /**
   * Home is a SEPARATE PAGE, not an overlay.
   *
   * Rendering it as a fixed-position panel on top of the workspace made it look
   * like a stray dialog floating over a live conversation (and the wallpaper
   * was double-painted). Returning early gives it the whole window: wallpaper
   * plus one frosted panel, nothing else.
   *
   * The SHE mark in the sidebar (onGoHome) comes back here.
   */
  /*
   * Overlays rendered by BOTH branches.
   *
   * Home returns early, so anything mounted after the `if (!entered)` block is invisible on
   * the landing page. That bug has now happened twice — the landing page's 「更多设置」/
   * 「技能库」 buttons were dead, and later the schedule panel and this stylesheet editor
   * could be opened from only one of the two screens. Declaring the fragment once and
   * including it in both returns removes the whole class of mistake: a panel added here
   * cannot land in one branch only.
   */
  const overlays = (
    <>
      {showSettings && (
        <Settings
          onClose={() => { setShowSettings(false); setSettingsFocus(null); }}
          theme={theme}
          onToggleTheme={() => setTheme((v) => (v === 'dark' ? 'light' : 'dark'))}
          background={bg}
          locale={locale}
          onLocale={handleLocale}
          focusSection={settingsFocus}
          onOpenTheme={() => { setShowSettings(false); setShowTheme(true); }}
        />
      )}
      {showSkills && <SkillManager onClose={() => setShowSkills(false)} />}
      {showPlans && <PlanPanel onClose={() => setShowPlans(false)} sessionId={activeSessionId} />}
      {showSchedule && <SchedulePanel onClose={() => setShowSchedule(false)} />}
      {showAudit && <AuditPanel onClose={() => setShowAudit(false)} />}
      {showTheme && <ThemeStudio onClose={() => setShowTheme(false)} userTheme={userTheme} />}
    </>
  );

  if (!entered) {
    return (
      <>
        {backgroundLayer}
      <ConnectionBanner />
        <Home
        onEnter={(root) => { void handleEnterWorkspace(root); }}
        appearance={{
          theme,
          setTheme,
          onOpenSettings: () => setShowSettings(true),
          onOpenSkills: () => setShowSkills(true),
          background: {
            meta: {
              url: bg.meta.url,
              kind: bg.meta.kind,
              filename: bg.meta.filename,
            },
            enabled: bg.enabled,
            setEnabled: bg.setEnabled,
            setFromFile: bg.setFromFile,
            clear: bg.clear,
            busy: bg.busy,
            error: bg.error,
          },
        }}
        dock={<Dock />}
      />
        {overlays}
      </>
    );
  }

  return (
    <>
      <div
      ref={layoutRef}
      className={`${styles.layout}${isDesktop ? ' ' + styles.layoutDesktop : ''}${focusChat ? ' ' + styles.layoutFocus : ''}${sidebarForce ? ' ' + styles.layoutSidebarForce : ''}${sidebarCollapsed ? ' ' + styles.layoutSidebarCollapsed : ''}${dragging ? ' ' + styles.layoutDragging : ''}`}
      data-focus={focusChat ? '1' : '0'}
      style={{
        ["--sidebar-w" as any]: (focusChat ? 0 : sidebarWidth) + 'px',
        ["--trace-w" as any]: (focusChat ? 0 : traceWidth) + 'px',
      }}
    >
      {backgroundLayer}

      <div className={styles.layoutBody}>
        {!focusChat && sidebarCollapsed ? (
          <div className={styles.sidebarRail}>
            <button
              type="button"
              className={styles.railBtn}
              onClick={() => setSidebarCollapsed(false)}
              title="展开侧栏"
            >»</button>
            <span className={styles.railLabel}>SHE</span>
          </div>
        ) : null}

        {!focusChat && !sidebarCollapsed && (
          <>
            <aside className={styles.sidebar}>
              <Sidebar
                tree={kb.tree}
                sessions={sessions}
                activeSessionId={activeSessionId}
                onGroupClick={handleGroupClick}
                onOpenSettings={() => setShowSettings(true)}
                onNewSession={handleNewSession}
                onSelectSession={handleSelectSession}
                onDeleteSession={handleDeleteSession}
                onCloseSession={handleCloseSession}
                onOpenHistory={handleOpenHistory}
                onGoHome={() => setEntered(false)}
                onExportSession={handleExportSession}
                onRenameSession={handleRenameSession}
                onOpenFile={(path, content) => setFilePreview({ path, content })}
        onOpenKbSharing={() => { setSettingsFocus('kb-share'); setShowSettings(true); }}
                onInsertText={(text) => setDraftInsert(text)}
              />
            </aside>
            <div
              className={`${styles.resizeHandle} ${styles.resizeHandleSidebar}`}
              onDoubleClick={() => setSidebarWidth(240)}
              onMouseDown={(e) => {
                dragRef.current = { kind: 'sidebar', startX: e.clientX, startY: e.clientY, startW: sidebarWidth, startH: terminalHeight };
                setDragging(true);
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
              }}
            />
          </>
        )}

        <div className={styles.center}>
          <main className={styles.main}>
            <Chat
              messages={inGroupMode ? clusterChat.messages : chat.messages}
              isLoading={inGroupMode ? clusterChat.isLoading : chat.isLoading}
              isPaused={chat.isPaused}
              pendingConfirm={inGroupMode ? null : chat.pendingConfirm}
              pendingPatch={inGroupMode ? null : chat.pendingPatch}
              pendingPatches={inGroupMode ? [] : chat.pendingPatches}
              sessionTitle={
                inGroupMode
                  ? `${clusterChat.room?.title ?? '工作群'} · ${clusterChat.room?.members.length ?? 0} 个智能体`
                  : sessions.find((s) => s.id === activeSessionId)?.title ?? null
              }
              groupPeers={
                inGroupMode
                  ? (clusterChat.room?.members ?? []).map((m) => ({
                      id: m.id,
                      name: m.name,
                      hue: m.hue,
                      active: clusterChat.activeMembers.includes(m.id),
                      done: clusterChat.doneMembers.includes(m.id),
                    }))
                  : undefined
              }
              draftInsert={draftInsert}
              onDraftConsumed={() => setDraftInsert(null)}
              onDropPaths={(paths: string[]) => {
                const chunk = paths.map((p: string) => '@' + p.replace(/\\/g, '/')).join(' ');
                setDraftInsert(chunk);
              }}
              skillProfile={skillProfile}
              onSkillProfile={(p) => { void handleSkillProfile(p); }}
              thinkingLevel={thinkingLevel}
              onThinkingLevel={(l) => { void handleThinkingLevel(l); }}
              onSend={inGroupMode ? clusterChat.send : chat.sendMessage}
              onInterject={inGroupMode ? clusterChat.send : chat.interject}
              onStop={inGroupMode ? clusterChat.stop : chat.stopStreaming}
              onPause={chat.pauseStreaming}
              onResume={chat.resumeStreaming}
              onConfirm={chat.confirmPending}
              onDismissConfirm={chat.dismissConfirm}
              onApplyPatch={chat.applyPendingPatch}
              onRejectPatch={chat.rejectPendingPatch}
              onApplyPatchById={chat.applyPatchById}
              onRejectPatchById={chat.rejectPatchById}
              onApplyAllPatches={chat.applyAllPatches}
              onRejectAllPatches={chat.rejectAllPatches}
              onRewindTo={inGroupMode ? undefined : (i) => { void handleRewindTo(i); }}
              onOpenSkills={() => setShowSkills(true)}
            onOpenSchedule={() => setShowSchedule(true)}
              onImportContext={() => setShowSources(true)}
              onOpenPlans={() => setShowPlans(true)}
              onOpenTimeline={() => setShowCheckpoints(true)}
              focusChat={focusChat}
              onToggleFocus={() => setFocusChat((v) => !v)}
            />
          </main>

          {showTerminal && (
            <div
              className={styles.resizeHandleRow}
              title="拖拽调节终端高度；双击复位"
              onDoubleClick={() => setTerminalHeight(220)}
              onMouseDown={(e) => {
                dragRef.current = { kind: 'terminal', startX: e.clientX, startY: e.clientY, startW: sidebarWidth, startH: terminalHeight };
                setDragging(true);
                document.body.style.cursor = 'row-resize';
                document.body.style.userSelect = 'none';
              }}
            />
          )}
          <TerminalPanel open={showTerminal} height={terminalHeight} onToggle={() => setShowTerminal((v) => !v)} />
        </div>

        {!focusChat && (
          <button type="button" className={styles.sidebarFab} title="折叠 / 展开侧栏" onClick={() => setSidebarCollapsed((v) => !v)}>
            {sidebarCollapsed ? '侧栏' : '收侧栏'}
          </button>
        )}

        {!focusChat && showTrace && (
          <>
            <div
              className={`${styles.resizeHandle} ${styles.resizeHandleTrace}`}
              onDoubleClick={() => setTraceWidth(320)}
              onMouseDown={(e) => {
                dragRef.current = { kind: 'trace', startX: e.clientX, startY: e.clientY, startW: traceWidth, startH: terminalHeight };
                setDragging(true);
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
              }}
            />
            <aside className={styles.tracePanel}>
              <PulseTracePanel
                result={chat.latestKBResult as any}
                onClose={() => setShowTrace(false)}
              />
            </aside>
          </>
        )}

        {/*
          Reopen handle. Closing the trace panel previously left no way back, and the panel then
          reopened itself on the next query — both broken. This is the way back, and it carries a
          dot when new trace data arrived while it was closed, so nothing is missed silently.
        */}
        {!focusChat && !showTrace && (
          <button
            type="button"
            className={styles.traceFab}
            onClick={() => setShowTrace(true)}
            title={traceHasNew ? t('组结构轨迹有新数据') : t('打开组结构共振轨迹')}
          >
            {t('轨迹')}
            {traceHasNew ? <span className={styles.traceFabDot} aria-hidden /> : null}
          </button>
        )}
      </div>

      <StatusBar
        onOpenCheckpoints={() => setShowCheckpoints(true)}
        theme={theme}
        onToggleTheme={() => setTheme((v) => (v === 'dark' ? 'light' : 'dark'))}
        focusChat={focusChat}
        onToggleFocus={() => setFocusChat((v) => !v)}
        onOpenImport={() => setShowImport(true)}
        onOpenCluster={() => setShowCluster(true)}
        onOpenPlans={() => setShowPlans(true)}
        /*
         * `onOpenMemo` was never passed, so the 备忘 button never rendered and the whole Memo panel
         * — implemented, mounted and persisted — could not be opened from anywhere. The status bar is
         * where a user looks for it.
         */
        onOpenMemo={() => setShowMemo(true)}
      />

      {showPalette && (
        <CommandPalette
          open={showPalette}
          commands={paletteCommands}
          onClose={() => setShowPalette(false)}
        />
      )}
      <TaskCards />
      <Toast />
      {overlays}
      {showCluster && <ClusterPanel onClose={() => { setShowCluster(false); setClusterFocusId(null); }} focusRoomId={clusterFocusId} onRoomsChanged={() => { void refreshSessions(); }} />}
      {showHistory && (
        <SessionHistory
          onClose={() => setShowHistory(false)}
          onReopened={(id) => { void handleReopened(id); }}
        />
      )}
      {showMemo && (
        <div className={styles.overlay} onClick={() => setShowMemo(false)}>
          <div
            style={{
              width: 'min(560px, 92vw)',
              maxHeight: '78vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 16,
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Memo />
          </div>
        </div>
      )}
      {showSources && (
        <ImportSources
          onClose={() => setShowSources(false)}
          destination={activeSessionId ? 'sessions' : 'kb'}
          onImported={() => {
          // An import changes BOTH the conversation list and the knowledge base (or just the KB,
          // depending on the destination). Only the chat history was reloaded, so the sidebar's
          // knowledge tree stayed on its pre-import empty state — the KB looked empty while
          // holding thousands of groups, until the user re-entered the workspace or reloaded.
          void chat.loadHistory();
          void refreshSessions();
          void kb.fetchTree();
          void kb.fetchStats();
        }}
        />
      )}
      {showImport && <KbImport onClose={() => setShowImport(false)} />}
      {showKnowledge && <ImportKnowledge onClose={() => setShowKnowledge(false)} activeSessionId={activeSessionId} />}
      {showCheckpoints && <CheckpointTimeline onClose={() => setShowCheckpoints(false)} />}

      {filePreview && (
        <div className={styles.overlay} onClick={() => setFilePreview(null)}>
          <div
            style={{
              width: 'min(720px, 92vw)',
              maxHeight: '80vh',
              overflow: 'auto',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 16,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
              <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{filePreview.path}</strong>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setDraftInsert('`' + filePreview.path + '`\n```\n' + filePreview.content + '\n```');
                    setFilePreview(null);
                  }}
                >插入到对话</button>
                <button type="button" onClick={() => setFilePreview(null)}>关闭</button>
              </div>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12, margin: 0 }}>
              {filePreview.content}
            </pre>
          </div>
        </div>
      )}

      {selectedGroupId && kb.selectedGroup && (
        <GroupBrowser
          group={kb.selectedGroup.group as any}
          memories={kb.selectedGroup.memories as any}
          onClose={handleCloseGroup}
        />
      )}
    </div>
    </>
  );
}
