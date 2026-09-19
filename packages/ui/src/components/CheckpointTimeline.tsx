import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/CheckpointTimeline.module.css';

interface CheckpointMeta {
  checkpoint_id: string;
  patch_id: string;
  path: string;
  created_at: string;
}

export function CheckpointTimeline({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<CheckpointMeta[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    const data = await fetchJSON<{ checkpoints: CheckpointMeta[] }>('/api/fs/checkpoints');
    setList(data.checkpoints ?? []);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setMsg(String((e as Error).message || e)));
  }, [refresh]);

  const undoOne = useCallback(async (id?: string) => {
    setBusyId(id ?? 'latest');
    setMsg('');
    try {
      const out = await fetchJSON<{ path: string; checkpoint_id: string }>('/api/fs/undo', {
        method: 'POST',
        body: id ? { checkpoint_id: id } : {},
      });
      setMsg('已回滚 ' + out.path);
      await refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  return (
    <div className={styles.panel} data-surface="panel">
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h2 className={styles.title}>检查点时间线</h2>
          <span className={styles.sub}>{list.length} 个可回滚的改动</span>
        </div>
        <button type="button" className={styles.close} onClick={onClose} title="关闭">×</button>
      </header>
      <button
        type="button"
        className={`${styles.btn} ${styles.undoLatest}`}
        disabled={!!busyId || list.length === 0}
        onClick={() => void undoOne()}
      >
        {busyId === 'latest' ? '回滚中…' : '撤销最近一次应用'}
      </button>
      <div className={styles.body}>
        {list.length === 0 ? (
          <div className={styles.empty}>暂无检查点。<br />应用补丁后会出现在这里。</div>
        ) : (
          list.map((c) => (
            <div key={c.checkpoint_id} className={styles.item}>
              <div className={styles.meta}>
                <div className={styles.path}>{c.path}</div>
                <div className={styles.time}>{new Date(c.created_at).toLocaleString()}</div>
                <div className={styles.id}>{c.checkpoint_id.slice(0, 8)}</div>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={!!busyId}
                  onClick={() => void undoOne(c.checkpoint_id)}
                >
                  {busyId === c.checkpoint_id ? '回滚中…' : '回滚到此点之前'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {msg ? <div className={styles.hint}>{msg}</div> : null}
    </div>
  );
}
