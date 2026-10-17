/*
 * 项目地图（只读）面板。
 *
 * 只做三件事：拉 `/api/map/tree`、把树文本原样铺出来、给一个复制按钮。
 * 不做编辑 —— 地图的写入路径是 `map_*` 工具与 `pnpm map:build`，界面只负责"看得见"。
 *
 * 空板纪律（KB 白板那次踩过）：接口返回 ok:false 时必须把原因写在面板里
 * （"还没有地图，先跑 pnpm map:build"），而不是画一张空图。空图和"没有数据"
 * 在界面上长得一样，会让人以为功能坏了。
 */
import { useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';

interface MapTreeResponse {
  ok: boolean;
  text?: string;
  tokens?: number;
  collapsed?: number;
  files?: number;
  score?: number;
  stale?: number;
  dark?: number;
  threats?: number;
  error?: string;
}

export function MapPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<MapTreeResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchJSON<MapTreeResponse>('/api/map/tree');
        if (alive) setData(res);
      } catch (err) {
        if (alive) setData({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function copy() {
    if (!data?.text) return;
    try {
      await navigator.clipboard.writeText(data.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 复制失败不弹窗：文本就在眼前，用户可以自己选 */
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(860px, 94vw)',
          maxHeight: '82vh',
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <strong style={{ fontSize: 14 }}>{t('项目地图（只读）')}</strong>
          {data?.ok ? (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {t('文件')} {data.files ?? 0}｜{data.tokens ?? 0} token｜{t('可信度')} {data.score ?? 0}/100｜
              {t('过期')} {data.stale ?? 0}｜{t('未标注')} {data.dark ?? 0}｜{t('契约威胁')} {data.threats ?? 0}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {data?.ok ? (
            <button type="button" className="she-btn she-btn--chip" onClick={() => void copy()}>
              {copied ? t('已复制') : t('复制')}
            </button>
          ) : null}
          <button type="button" className="she-btn she-btn--chip" onClick={onClose}>
            {t('关闭')}
          </button>
        </div>
        <div style={{ overflow: 'auto', padding: '10px 16px' }}>
          {data === null ? (
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('读取中…')}</p>
          ) : data.ok ? (
            <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre', fontFamily: 'var(--font-mono, monospace)' }}>
              {data.text}
            </pre>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{data.error ?? t('读取失败')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
