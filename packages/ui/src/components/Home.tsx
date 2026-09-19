import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/Home.module.css';

export interface WorkspaceEntry {
  root: string;
  name: string;
  exists: boolean;
  isGit: boolean;
  sessionCount: number;
}

interface Props {
  onEnter: (root: string) => void;
  appearance: {
    theme: 'light' | 'dark';
    setTheme: (t: 'light' | 'dark') => void;
    onOpenSettings: () => void;
    /** Opens the skill manager, so custom skills are reachable from the landing page. */
    onOpenSkills?: () => void;
    background: {
      meta: { url: string | null; kind: 'image' | 'video' | null; filename: string | null };
      enabled: boolean;
      setEnabled: (v: boolean) => void;
      setFromFile: (f: File) => Promise<void>;
      clear: () => Promise<void>;
      busy: boolean;
      error: string | null;
    };
  };
  dock?: React.ReactNode;
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

// The `window.sheDesktop` bridge is declared once in vite-env.d.ts.

/**
 * Landing page.
 *
 * A single frosted-glass panel over the user's wallpaper — not a transparent
 * scatter of tiles, and not an opaque form. Theme and background are settable
 * from here so the user never has to hunt through Settings first.
 */
export function Home({ onEnter, appearance, dock }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [canBrowse, setCanBrowse] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState('');
  const [dockOpen, setDockOpen] = useState(false);
  /** Ordered list of recently opened workspace roots, newest first. */
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  /** Show only the most recent few by default; the rest are one click away. */
  const RECENT_LIMIT = 3;
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJSON<{
        current: string;
        workspaces: WorkspaceEntry[];
        recent?: string[];
        canBrowse?: boolean;
      }>('/api/workspaces');
      setWorkspaces(data.workspaces ?? []);
      setCurrent(data.current ?? null);
      setRecentRoots(Array.isArray(data.recent) ? data.recent : []);
      setCanBrowse(Boolean(data.canBrowse) || Boolean(window.sheDesktop?.isDesktop));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const enter = useCallback(
    async (root: string) => {
      const target = (root ?? '').trim();
      if (!target || busy) return;
      setBusy(target);
      setError(null);
      try {
        const r = await fetchJSON<{ root: string }>('/api/workspaces/switch', {
          method: 'POST',
          body: { root: target },
        });
        onEnter(r.root);
      } catch (e) {
        setError((e as Error).message);
        setBusy(null);
      }
    },
    [busy, onEnter],
  );

  const browse = useCallback(async () => {
    const picked = await window.sheDesktop?.pickFolder();
    if (picked) await enter(picked);
    else setManualOpen(true);
  }, [enter]);

  const bg = appearance.background;
  const hasOther = workspaces.filter((w) => w.root !== current);

  /**
   * Workspaces ordered by how recently they were opened.
   *
   * The list is otherwise just "every workspace ever seen", which buries the one
   * you actually want. Recent-first, then limited, with the rest behind a toggle.
   */
  const orderedWorkspaces = useMemo(() => {
    if (recentRoots.length === 0) return workspaces;
    const rank = new Map(recentRoots.map((r, i) => [r, i]));
    return [...workspaces].sort((a, b) => {
      const ra = rank.has(a.root) ? rank.get(a.root)! : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.root) ? rank.get(b.root)! : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
  }, [workspaces, recentRoots]);

  const hiddenWorkspaceCount = orderedWorkspaces.length - RECENT_LIMIT;
  const shownWorkspaces =
    !showAllWorkspaces && hiddenWorkspaceCount > 0
      ? orderedWorkspaces.slice(0, RECENT_LIMIT)
      : orderedWorkspaces;

  return (
    <div className={styles.page}>
      {/* ── one frosted panel over the wallpaper ── */}
      <div className={styles.panel} data-surface="panel">
        <header className={styles.hero}>
          <div className={styles.mark} aria-hidden>
            <span className={styles.markLetter}>b</span>
          </div>
          <div className={styles.heroText}>
            <h1 className={styles.wordmark}>bot</h1>
            <p className={styles.tagline}>Structured Hierarchy Engine</p>
          </div>
        </header>

        {error ? <div className={styles.error}>{error}</div> : null}

        {/* ── appearance: theme + wallpaper, right on the landing page ── */}
        <section className={styles.appearance}>
          <div className={styles.row}>
            <span className={styles.rowLabel}>主题</span>
            <div className={styles.segmented}>
              <button
                type="button"
                className={`${styles.seg} ${appearance.theme === 'dark' ? styles.segOn : ''}`}
                onClick={() => appearance.setTheme('dark')}
              >
                深色
              </button>
              <button
                type="button"
                className={`${styles.seg} ${appearance.theme === 'light' ? styles.segOn : ''}`}
                onClick={() => appearance.setTheme('light')}
              >
                浅色
              </button>
            </div>
          </div>

          <div className={styles.row}>
            <span className={styles.rowLabel}>背景</span>
            <div className={styles.bgControls}>
              <button
                type="button"
                className={styles.smallBtn}
                disabled={bg.busy}
                onClick={() => fileRef.current?.click()}
              >
                {bg.busy ? '处理中…' : '选择图片 / 视频'}
              </button>
              {bg.meta.filename ? (
                <>
                  <button
                    type="button"
                    className={`${styles.smallBtn} ${bg.enabled ? styles.smallBtnOn : ''}`}
                    onClick={() => bg.setEnabled(!bg.enabled)}
                  >
                    {bg.enabled ? '显示中' : '已隐藏'}
                  </button>
                  <button type="button" className={styles.smallBtn} onClick={() => void bg.clear()}>
                    移除
                  </button>
                </>
              ) : (
                <span className={styles.rowHint}>支持 jpg / png / mp4，拖到这里也行</span>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void bg.setFromFile(f);
                e.currentTarget.value = '';
              }}
            />
          </div>
          {bg.error ? <div className={styles.bgErr}>{bg.error}</div> : null}
        </section>

        {/* ── workspace ── */}
        <section className={styles.picker}>
          <div className={styles.pickerHead}>
            <span className={styles.rowLabel}>工作区</span>
            <span className={styles.rowHint}>
              {loading ? '读取中…' : '会话与知识库以它为边界'}
            </span>
          </div>

          {!loading && workspaces.length === 0 ? (
            <div className={styles.empty}>还没有打开过工作区，选一个文件夹开始。</div>
          ) : null}

          <div className={styles.list}>
            {shownWorkspaces.map((w) => (
              <button
                key={w.root}
                type="button"
                className={`${styles.wsRow} ${w.root === current ? styles.wsRowCurrent : ''}`}
                disabled={!w.exists || Boolean(busy)}
                onClick={() => void enter(w.root)}
                title={w.root}
              >
                <span className={styles.wsIcon}>{w.isGit ? '⎇' : '▤'}</span>
                <span className={styles.wsBody}>
                  <span className={styles.wsName}>{w.name}</span>
                  <span className={styles.wsPath}>{shortPath(w.root)}</span>
                </span>
                {w.root === current ? (
                  <span className={styles.wsBadgeOn}>当前</span>
                ) : w.sessionCount > 0 ? (
                  <span className={styles.wsBadge}>{w.sessionCount} 会话</span>
                ) : (
                  <span className={styles.wsBadgeMuted}>进入</span>
                )}
              </button>
            ))}

            {hasOther.length === 0 && workspaces.length > 0 ? null : null}

            {/* Fold the long tail of old workspaces. */}
            {hiddenWorkspaceCount > 0 ? (
              <button
                type="button"
                className={styles.wsMore}
                onClick={() => setShowAllWorkspaces((v) => !v)}
                title={showAllWorkspaces ? '只看最近的' : `还有 ${hiddenWorkspaceCount} 个工作区`}
              >
                {showAllWorkspaces
                  ? `只看最近 ${RECENT_LIMIT} 个 ▴`
                  : `显示更早的 ${hiddenWorkspaceCount} 个 ▾`}
              </button>
            ) : null}
          </div>

          <div className={styles.pickerActions}>
            {canBrowse ? (
              <button type="button" className={styles.primaryBtn} disabled={Boolean(busy)} onClick={() => void browse()}>
                打开文件夹…
              </button>
            ) : null}
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => setManualOpen((v) => !v)}
            >
              {manualOpen ? '收起' : '输入路径'}
            </button>
          </div>

          {manualOpen ? (
            <div className={styles.manual}>
              <input
                className={styles.manualInput}
                value={manual}
                autoFocus
                onChange={(e) => setManual(e.target.value)}
                placeholder="例如 ~/projects/my-app"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void enter(manual);
                  if (e.key === 'Escape') setManualOpen(false);
                }}
              />
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={!manual.trim() || Boolean(busy)}
                onClick={() => void enter(manual)}
              >
                进入
              </button>
            </div>
          ) : null}
        </section>

        {/* ── footer ── */}
        <footer className={styles.footer}>
          <button type="button" className={styles.linkBtn} onClick={appearance.onOpenSettings}>
            更多设置
          </button>
          {/* Skills live here too: the manager used to be reachable only from a
              chip under the composer, so "where do I put my own skill?" had no
              answer from the landing page. */}
          {appearance.onOpenSkills ? (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={appearance.onOpenSkills}
              title="新建 / 编辑自定义技能（写入 .she/skills/custom/）"
            >
              技能库
            </button>
          ) : null}
          {dock ? (
            <button type="button" className={styles.linkBtn} onClick={() => setDockOpen((v) => !v)}>
              扩展坞 {dockOpen ? '▾' : '▸'}
            </button>
          ) : null}
        </footer>
      </div>

      {dockOpen && dock ? <div className={styles.dockFloat}>{dock}</div> : null}
    </div>
  );
}
