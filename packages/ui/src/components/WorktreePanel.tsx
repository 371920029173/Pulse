import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import styles from '../styles/WorktreePanel.module.css';

interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
}

/**
 * Parallel working copies.
 *
 * The API and the command-palette action already existed; what was missing was any way to SEE what
 * had been created. That is the failure mode this panel exists to fix, and it is a specific one:
 *
 *   - A worktree is a directory beside the repo on a branch called `she/<name>`. Nothing in the app
 *     listed them, so the count only grew. `git worktree list` was the only way to find out, which
 *     means the person who needed to know was the one person not told.
 *   - They are cheap to create (one palette command) and not obviously durable, so they accumulate
 *     with uncommitted work inside them. `git worktree remove` without `--force` refuses in exactly
 *     that case — so a delete that fails here is the interesting outcome, not an error to swallow.
 *
 * Hence three things the panel insists on: the directory is shown in full (that is the only handle
 * the user has outside this window), the uncommitted state is shown by asking git, and removal
 * reports what git said rather than a generic failure.
 *
 * Read-mostly: no editing, no committing, no merging. Those are decisions about a branch and belong
 * in git, where the history of the decision is kept.
 */
export function WorktreePanel({ onClose, repo, onOpenSession }: {
  onClose: () => void;
  repo?: string;
  onOpenSession?: (directory: string) => void;
}) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [root, setRoot] = useState(repo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  /** Per-worktree note from the last action: a refusal from git belongs next to the row it refused. */
  const [notes, setNotes] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const q = repo ? `?repo=${encodeURIComponent(repo)}` : '';
      const data = await fetchJSON<{ repo?: string; worktrees?: WorktreeInfo[] }>(`/api/worktrees${q}`);
      setWorktrees(data.worktrees ?? []);
      if (data.repo) setRoot(data.repo);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [repo]);

  useEffect(() => {
    void refresh();
    /*
     * Polled rather than pushed.
     *
     * There is no worktree event stream, and the thing that changes without this window doing
     * anything is not the list — it is the uncommitted state of a tree a session is working in.
     * A slow interval is right for that: the alternative is a "refresh" the user has to remember.
     */
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const create = useCallback(async () => {
    const wanted = name.trim();
    if (!wanted || creating) return;
    setCreating(true);
    try {
      await fetchJSON('/api/worktrees', { method: 'POST', body: { name: wanted, repo: root || undefined } });
      setName('');
      toast(t('已创建并行工作副本'));
      await refresh();
    } catch (e) {
      toast(t('未能创建并行副本：{msg}', { msg: (e as Error).message }));
    } finally {
      setCreating(false);
    }
  }, [creating, name, refresh, root]);

  const reset = useCallback(async (path: string) => {
    if (busy) return;
    setBusy(path);
    try {
      await fetchJSON('/api/worktrees/reset', { method: 'POST', body: { path, repo: root || undefined } });
      setNotes((n) => ({ ...n, [path]: t('已重置到主仓库当前提交（未提交的改动已丢弃）') }));
      await refresh();
    } catch (e) {
      setNotes((n) => ({ ...n, [path]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }, [busy, refresh, root]);

  const remove = useCallback(async (path: string) => {
    if (busy) return;
    /*
     * Confirmed, and the confirmation names the directory.
     *
     * Deleting a working copy can take uncommitted work with it, and the row already shows which
     * directory it is — so the dialog repeats it rather than asking a bare "are you sure", which
     * is a question nobody can answer from memory when three of these are open.
     */
    if (!window.confirm(t('删除工作副本 {dir}？里面的未提交改动会一起丢掉。', { dir: path }))) return;
    setBusy(path);
    try {
      await fetchJSON(`/api/worktrees?path=${encodeURIComponent(path)}${root ? `&repo=${encodeURIComponent(root)}` : ''}`, {
        method: 'DELETE',
      });
      await refresh();
    } catch (e) {
      // git refuses to remove a dirty worktree without --force; that refusal is the useful answer.
      setNotes((n) => ({ ...n, [path]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }, [busy, refresh, root]);

  return (
    <div className={styles.panel} data-surface="panel">
      <div className={styles.header}>
        <span className={styles.title}>{t('并行工作副本')}</span>
        <span className={styles.summary}>{t('{n} 个', { n: worktrees.length })}</span>
        <button type="button" className={styles.close} onClick={onClose} title={t('关闭')}>×</button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.create}>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder={t('副本名称，例如 feature-a')}
          aria-label={t('副本名称')}
        />
        <button type="button" className={styles.primary} onClick={() => void create()} disabled={creating || !name.trim()}>
          {creating ? t('创建中…') : t('新建副本')}
        </button>
        <button type="button" className={styles.filter} onClick={() => void refresh()}>{t('刷新')}</button>
      </div>

      {worktrees.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>⑂</div>
          <div className={styles.emptyText}>{t('还没有并行工作副本')}</div>
          <div className={styles.emptyHint}>
            {t('副本是仓库旁边的一个独立目录，在 she/<名字> 分支上。两个会话各用一个副本，就不会互相覆盖文件。')}
          </div>
        </div>
      ) : (
        <ol className={styles.list}>
          {worktrees.map((w) => {
            const isMain = root !== '' && samePath(w.path, root);
            return (
              <li key={w.path} className={styles.row}>
                <div className={styles.rowMain}>
                  <div className={styles.rowHead}>
                    <code className={styles.branch}>{w.branch || t('（游离 HEAD）')}</code>
                    {/* The main checkout is listed by git like any other and must be labelled,
                        because it is the one row here that cannot be removed. */}
                    {isMain ? <span className={styles.badgeMain}>{t('主仓库')}</span> : null}
                    {w.head ? <span className={styles.head}>{w.head.slice(0, 8)}</span> : null}
                  </div>
                  {/* Full path, not a basename: this is the only handle the user has outside the
                      app, and `.she-worktrees/<repo>/<name>` is not reconstructable from memory. */}
                  <code className={styles.path}>{w.path}</code>
                  {notes[w.path] ? <div className={styles.note}>{notes[w.path]}</div> : null}
                </div>
                <div className={styles.actions}>
                  {onOpenSession ? (
                    <button
                      type="button"
                      className={styles.filter}
                      onClick={() => onOpenSession(w.path)}
                      title={t('在副本目录里开一个会话')}
                    >
                      {t('在此开会话')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.filter}
                    onClick={() => void reset(w.path)}
                    disabled={busy === w.path}
                    title={t('把这棵树重置到主仓库当前的提交')}
                  >
                    {t('重置')}
                  </button>
                  <button
                    type="button"
                    className={styles.danger}
                    onClick={() => void remove(w.path)}
                    disabled={busy === w.path || isMain}
                    title={isMain ? t('当前工作区不能删除') : t('删除这棵工作树')}
                  >
                    {t('删除')}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {root ? <div className={styles.footer}>{t('仓库：{repo}', { repo: root })}</div> : null}
    </div>
  );
}

/**
 * Path comparison that tolerates the separators git reports.
 *
 * `git worktree list` prints forward slashes even on Windows, and the repo path arrives from the
 * server already resolved — so a plain `===` would fail to recognise the main checkout and would
 * offer a "delete" button on the one worktree that must not be deleted.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
