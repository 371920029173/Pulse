import { useCallback, useEffect, useRef, useState } from 'react';
import { probeHealth } from '../lib/api';

/**
 * Polls /api/health. When the local API is down, shows a non-blocking banner
 * and broadcasts she:offline so TaskCards / chat can mark in-flight work failed.
 * Also re-probes immediately on she:stream-failed (SSE abort path).
 */
export function ConnectionBanner() {
  const [online, setOnline] = useState(true);
  const [checking, setChecking] = useState(false);
  const wasOnline = useRef(true);

  const apply = useCallback((ok: boolean) => {
    setOnline(ok);
    if (wasOnline.current && !ok) {
      window.dispatchEvent(
        new CustomEvent('she:offline', { detail: { message: '本地服务不可用' } }),
      );
    }
    wasOnline.current = ok;
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      apply(await probeHealth());
    } finally {
      setChecking(false);
    }
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const ok = await probeHealth();
      if (!cancelled) apply(ok);
    };
    void tick();
    const id = window.setInterval(tick, online ? 15_000 : 4_000);
    const onFocus = () => { void tick(); };
    const onStreamFailed = () => { void tick(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('she:stream-failed', onStreamFailed);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('she:stream-failed', onStreamFailed);
    };
  }, [online, apply]);

  if (online) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '8px 16px',
        background: 'color-mix(in srgb, var(--danger, #f85149) 88%, #000)',
        color: '#fff',
        fontSize: 13,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      }}
    >
      <span>本地服务连不上（期望 5577）。桌面用 SHE.bat 启动后再点重试。</span>
      <button
        type="button"
        disabled={checking}
        onClick={() => void check()}
        style={{
          padding: '4px 10px',
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.45)',
          background: 'rgba(255,255,255,0.12)',
          color: '#fff',
          cursor: checking ? 'wait' : 'pointer',
          fontSize: 12,
        }}
      >
        {checking ? '检测中…' : '重试'}
      </button>
    </div>
  );
}
