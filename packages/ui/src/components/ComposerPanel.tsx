import { useState } from 'react';
import type { PendingPatch } from '../hooks/useChat';
import styles from '../styles/ComposerPanel.module.css';

interface Props {
  patches: PendingPatch[];
  busy?: boolean;
  onApplyOne: (patchId: string) => void;
  onRejectOne: (patchId: string) => void;
  onApplyAll: () => void;
  onRejectAll: () => void;
}

export function ComposerPanel({
  patches,
  busy,
  onApplyOne,
  onRejectOne,
  onApplyAll,
  onRejectAll,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(patches[0]?.patch_id ?? null);
  if (!patches.length) return null;
  const active = patches.find((p) => p.patch_id === openId) ?? patches[0];

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <div className={styles.title}>多文件 Composer</div>
          <div className={styles.sub}>{patches.length} 个待应用补丁</div>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.apply} onClick={onApplyAll} disabled={busy}>
            全部应用
          </button>
          <button type="button" className={styles.reject} onClick={onRejectAll} disabled={busy}>
            全部拒绝
          </button>
        </div>
      </div>
      <div className={styles.body}>
        <div className={styles.list}>
          {patches.map((p) => (
            <button
              key={p.patch_id}
              type="button"
              className={`${styles.item} ${p.patch_id === active.patch_id ? styles.itemActive : ''}`}
              onClick={() => setOpenId(p.patch_id)}
            >
              <span className={styles.itemPath}>{p.path}</span>
            </button>
          ))}
        </div>
        <div className={styles.detail}>
          <div className={styles.detailHead}>
            <span className={styles.itemPath}>{active.path}</span>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.apply}
                disabled={busy}
                onClick={() => onApplyOne(active.patch_id)}
              >
                应用
              </button>
              <button
                type="button"
                className={styles.reject}
                disabled={busy}
                onClick={() => onRejectOne(active.patch_id)}
              >
                拒绝
              </button>
            </div>
          </div>
          <pre className={styles.diff}>{active.unified || '(empty diff)'}</pre>
        </div>
      </div>
    </div>
  );
}
