import { useEffect, useState } from 'react';
import { subscribeToast } from '../lib/toast';
import styles from '../styles/Toast.module.css';

export function Toast() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    return subscribeToast((message) => {
      setMsg(message);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setMsg(null), 1800);
    });
  }, []);

  if (!msg) return null;
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      {msg}
    </div>
  );
}
