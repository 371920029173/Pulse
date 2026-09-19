import type { PendingPatch } from '../hooks/useChat';
import styles from '../styles/DiffPanel.module.css';

interface Props {
  patch: PendingPatch;
  busy?: boolean;
  onApply: () => void;
  onReject: () => void;
}

export function DiffPanel({ patch, busy, onApply, onReject }: Props) {
  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <div className={styles.title}>待应用修改</div>
          <div className={styles.path}>{patch.path}</div>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.apply} onClick={onApply} disabled={busy}>
            应用
          </button>
          <button type="button" className={styles.reject} onClick={onReject} disabled={busy}>
            拒绝
          </button>
        </div>
      </div>
      <pre className={styles.diff}>{patch.unified || '（空 diff）'}</pre>
    </div>
  );
}
