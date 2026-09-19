import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJSON } from '../lib/api';

export interface BackgroundMeta {
  url: string | null;
  kind: 'image' | 'video' | null;
  filename: string | null;
  updatedAt: string | null;
}

const MAX_BYTES = 1024 * 1024 * 1024;

/**
 * App background: an image or video the user drops in, stored server-side so it
 * survives restarts and is shared by every window of the same workspace.
 */
export function useBackground() {
  const [meta, setMeta] = useState<BackgroundMeta>({ url: null, kind: null, filename: null, updatedAt: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(() => localStorage.getItem('she.bg.enabled') !== '0');
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await fetchJSON<BackgroundMeta>('/api/background');
      setMeta(m);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    localStorage.setItem('she.bg.enabled', enabled ? '1' : '0');
  }, [enabled]);

  // Apply the background to the document; panels turn translucent via CSS.
  useEffect(() => {
    const root = document.documentElement;
    const active = enabled && Boolean(meta.url);
    root.dataset.bg = active ? (meta.kind || 'image') : 'none';
    if (active && meta.url) {
      root.style.setProperty('--app-bg-image', `url("${meta.url}")`);
    } else {
      root.style.removeProperty('--app-bg-image');
    }
    return () => {
      root.style.removeProperty('--app-bg-image');
    };
  }, [enabled, meta.url, meta.kind]);

  const setFromFile = useCallback(async (file: File) => {
    if (!/^(image|video)\//.test(file.type)) {
      setError('只支持图片或视频文件');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`文件过大（上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Raw binary upload: no base64 inflation, so large videos are practical.
      const res = await fetch('/api/background', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setMeta(await res.json() as BackgroundMeta);
      setEnabled(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async () => {
    /*
     * Ask first.
     *
     * This deletes the user's file from disk with no undo — the same class of
     * hazard as the session delete button. A stray click (observed during
     * automated UI testing, and just as likely by hand, since the button sits
     * beside "显示中") silently destroyed a chosen wallpaper.
     */
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && !window.confirm('移除背景会删除已选的文件，且无法撤销。确定吗？')) {
      return;
    }
    setBusy(true);
    try {
      await fetchJSON('/api/background', { method: 'DELETE' });
      setMeta({ url: null, kind: null, filename: null, updatedAt: null });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  return { meta, busy, error, enabled, setEnabled, setFromFile, clear, refresh, videoRef };
}
