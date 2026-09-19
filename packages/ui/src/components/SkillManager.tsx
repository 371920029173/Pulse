import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { toast } from '../lib/toast';
import { SKILL_PROFILES, type SkillProfileId } from '../lib/skills';
import styles from '../styles/SkillManager.module.css';

interface SkillFile {
  name: string;
  path: string;
  profile: string;
  size: number;
  updatedAt?: string;
}

type Profile = SkillProfileId;

/**
 * Labels for the group headers in the installed list.
 *
 * Profile labels come from the shared list (single source); `_common` is not a
 * selectable profile, so it is only mapped here.
 */
const PROFILE_LABEL: Record<string, string> = {
  ...Object.fromEntries(SKILL_PROFILES.map((p) => [p.id, p.label])),
  _common: '公共',
};

/**
 * Custom-skill manager.
 *
 * Writes to `.she/skills/<profile>/<name>.md`. The active profile's files are
 * injected into the system prompt, plus everything in `_common` and `custom`.
 */
export function SkillManager({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<SkillFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillFile | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftProfile, setDraftProfile] = useState<Profile>('custom');
  const [draftBody, setDraftBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'list' | 'edit'>('list');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchJSON<{ files: SkillFile[] }>('/api/skills/files');
      setFiles(d.files ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openNew = useCallback(() => {
    setSelected(null);
    setDraftName('');
    setDraftProfile('custom');
    setDraftBody('');
    setMode('edit');
  }, []);

  const openExisting = useCallback(async (f: SkillFile) => {
    try {
      const d = await fetchJSON<{ content: string }>(`/api/skills/files?path=${encodeURIComponent(f.path)}`);
      setSelected(f);
      setDraftName(f.name.replace(/\.md$/i, ''));
      setDraftProfile((f.profile as Profile) ?? 'custom');
      setDraftBody(d.content ?? '');
      setMode('edit');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const save = useCallback(async () => {
    const name = draftName.trim();
    if (!name) {
      setError('请填技能名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await fetchJSON('/api/skills/save', {
        method: 'POST',
        body: { name, profile: draftProfile, content: draftBody },
      });
      toast('已保存技能');
      await load();
      setMode('list');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [draftName, draftProfile, draftBody, load]);

  const remove = useCallback(async (f: SkillFile) => {
    // Deleting a skill file is permanent; it is the user's own content.
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && !window.confirm(`删除技能「${f.name}」？此操作无法撤销。`)) return;
    setBusy(true);
    try {
      await fetchJSON(`/api/skills/files?path=${encodeURIComponent(f.path)}`, { method: 'DELETE' });
      toast('已删除');
      await load();
      if (selected?.path === f.path) setMode('list');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [load, selected]);

  const grouped = useMemo(() => {
    const g = new Map<string, SkillFile[]>();
    for (const f of files) {
      const list = g.get(f.profile) ?? [];
      list.push(f);
      g.set(f.profile, list);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  return (
    <div className={styles.panel} data-surface="panel">
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h2 className={styles.title}>技能管理</h2>
          <span className={styles.sub}>
            {mode === 'list'
              ? `${files.length} 个技能文件 · 放在 .she/skills/<档位>/`
              : selected ? `编辑 ${selected.name}` : '新建技能'}
          </span>
        </div>
        <button type="button" className={styles.close} onClick={onClose} title="关闭">×</button>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}

      {mode === 'list' ? (
        <>
          <div className={styles.toolbar}>
            <button type="button" className={styles.primary} onClick={openNew}>+ 新建技能</button>
            <span className={styles.hint}>
              当前档位的技能 + <code>_common</code> + <code>custom</code> 会注入系统提示
            </span>
          </div>
          <div className={styles.body}>
            {loading ? (
              <div className={styles.empty}>读取中…</div>
            ) : files.length === 0 ? (
              <div className={styles.empty}>还没有技能文件。点「新建技能」开始。</div>
            ) : (
              grouped.map(([profile, list]) => (
                <section key={profile} className={styles.group}>
                  <div className={styles.groupLabel}>{PROFILE_LABEL[profile] ?? profile}</div>
                  {list.map((f) => (
                    <div key={f.path} className={styles.row}>
                      <span className={styles.rowName}>{f.name.replace(/\.md$/i, '')}</span>
                      <span className={styles.rowMeta}>{f.size} 字</span>
                      <button type="button" className={styles.small} onClick={() => void openExisting(f)}>编辑</button>
                      <button
                        type="button"
                        className={styles.smallDanger}
                        disabled={busy}
                        onClick={() => void remove(f)}
                      >删除</button>
                    </div>
                  ))}
                </section>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className={styles.editBar}>
            <input
              className={styles.input}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="技能名称，例如 code-review"
              spellCheck={false}
            />
            <select
              className={styles.select}
              value={draftProfile}
              onChange={(e) => setDraftProfile(e.target.value as Profile)}
            >
              {/* Shared list, so adding a profile cannot leave this dropdown behind. */}
              {SKILL_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          <textarea
            className={styles.editor}
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            placeholder={'用 Markdown 写这个技能：什么时候用、怎么做、有哪些禁忌。\n\n例如：\n# 代码评审\n\n## 何时使用\n用户在提交前要求评审时。\n\n## 步骤\n1. 先跑测试…'}
            spellCheck={false}
          />
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button type="button" className={styles.small} onClick={() => setMode('list')}>返回列表</button>
          </div>
        </>
      )}
    </div>
  );
}
