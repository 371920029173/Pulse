import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { toast } from '../lib/toast';
import styles from '../styles/StatusBar.module.css';

interface SettingsSnapshot {
  llm: { provider: string; model: string; hasKey: boolean; baseUrl?: string };
  workspace: { root: string };
  automationMode?: boolean;
}

interface CheckpointMeta {
  checkpoint_id: string;
  patch_id: string;
  path: string;
  created_at: string;
}

export function StatusBar({ onOpenCheckpoints, theme = 'dark', onToggleTheme, focusChat = false, onToggleFocus, onOpenImport, onOpenCluster, onOpenPlans, onOpenSources, onOpenMemo }: { onOpenCheckpoints?: () => void; theme?: 'dark' | 'light'; onToggleTheme?: () => void; focusChat?: boolean; onToggleFocus?: () => void; onOpenImport?: () => void; onOpenCluster?: () => void; onOpenPlans?: () => void; onOpenSources?: () => void; onOpenMemo?: () => void }) {
  const [s, setS] = useState<SettingsSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cps, setCps] = useState<CheckpointMeta[]>([]);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [usage, setUsage] = useState<{
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
    cache_hit_tokens?: number;
    cache_miss_tokens?: number;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJSON<SettingsSnapshot>('/api/settings');
      setS(data);
      setErr(null);
      try {
        const u = await fetchJSON<{
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          reasoning_tokens?: number;
          cache_hit_tokens?: number;
          cache_miss_tokens?: number;
        }>('/api/usage');
        setUsage(u);
      } catch { /* optional */ }
    } catch (e) {
      setErr((e as Error).message);
    }
    try {
      const c = await fetchJSON<{ checkpoints: CheckpointMeta[] }>('/api/fs/checkpoints');
      setCps(c.checkpoints ?? []);
    } catch { /* optional */ }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
    const t = setInterval(() => { refresh().catch(() => undefined); }, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const undo = useCallback(async () => {
    if (undoing || cps.length === 0) return;
    setUndoing(true);
    setUndoMsg(null);
    try {
      const out = await fetchJSON<{ path: string }>('/api/fs/undo', { method: 'POST', body: {} });
      setUndoMsg(`已撤销 ${out.path}`);
      await refresh();
    } catch (e) {
      setUndoMsg((e as Error).message);
    } finally {
      setUndoing(false);
    }
  }, [cps.length, undoing, refresh]);

  const root = s?.workspace.root ?? '…';
  const short = root.length > 42 ? '…' + root.slice(-40) : root;
  const latest = cps[0];

  // Only meaningful once the provider has actually reported cache accounting; a
  // provider without prompt caching leaves both counters absent.
  const cacheAccounted = (usage?.cache_hit_tokens ?? 0) + (usage?.cache_miss_tokens ?? 0);
  const cacheHitRate = cacheAccounted > 0
    ? Math.round(((usage?.cache_hit_tokens ?? 0) / cacheAccounted) * 100)
    : null;

  return (
    <div className={styles.bar} title={err ?? root}>
      <span className={styles.item}>
        <span className={styles.label}>模型</span>
        <span className={styles.value}>{s ? `${s.llm.provider}/${s.llm.model}` : '…'}</span>
      </span>
      <span className={styles.sep}>·</span>
      <span className={styles.item}>
        <span className={styles.label}>密钥</span>
        <span className={`${styles.value} ${s?.llm.hasKey ? styles.ok : styles.warn}`}>
          {s ? (s.llm.hasKey ? '已配置' : '未配置') : '…'}
        </span>
      </span>
      <span className={styles.sep}>·</span>
      <span className={styles.item} title={root}>
        <span className={styles.label}>工作区</span>
        <span className={styles.value}>{short}</span>
      </span>
      <button type="button" className={styles.focusBtn} onClick={onToggleFocus} title="Ctrl+\\ 专注对话">
        {focusChat ? '退出专注' : '专注'}
      </button>
{usage && usage.total_tokens > 0 ? (
        <>
          <span className={styles.sep}>·</span>
          <span className={styles.item} title={`prompt ${usage.prompt_tokens} / completion ${usage.completion_tokens}`}>
            <span className={styles.label}>tokens</span>
            <span className={styles.value}>{usage.total_tokens}</span>
          </span>
          {/* Reasoning budget — the one number that proves the thinking-level
              slider is doing something. Hidden until the model actually thinks. */}
          {usage.reasoning_tokens ? (
            <>
              <span className={styles.sep}>·</span>
              <span className={styles.item} title="思维链消耗的 tokens（由思考强度决定）">
                <span className={styles.label}>思考</span>
                <span className={styles.value}>{usage.reasoning_tokens}</span>
              </span>
            </>
          ) : null}
          {/*
            Prompt-cache hit rate.

            Shown because it is the number that decides what a conversation
            actually costs, and it degrades silently: a request prefix that keeps
            changing moves every turn from mostly-cached to full price with no
            visible symptom. A rate that sits near zero in a long chat is the
            signal that something is rewriting the prefix.
          */}
          {cacheHitRate !== null ? (
            <>
              <span className={styles.sep}>·</span>
              <span
                className={styles.item}
                title={`提示缓存命中 ${usage.cache_hit_tokens ?? 0} / 未命中 ${usage.cache_miss_tokens ?? 0}；越低说明每轮重发的提示前缀在变，成本越高`}
              >
                <span className={styles.label}>缓存</span>
                <span className={styles.value}>{cacheHitRate}%</span>
              </span>
            </>
          ) : null}
        </>
      ) : null}
      {onOpenMemo && (
        <button type="button" className={styles.timeline} onClick={onOpenMemo} title="备忘录（你和智能体都能改）">备忘</button>
      )}
      {onOpenSources && (
        <button type="button" className={styles.timeline} onClick={onOpenSources} title="扫描并导入 Cursor / Claude Code / Codex 对话记录">导入对话</button>
      )}
      {onOpenImport && (
        <button type="button" className={styles.timeline} onClick={onOpenImport} title="导入 md/txt/json 到知识库">导入库</button>
      )}
      {onOpenCluster && (
        <button type="button" className={styles.timeline} onClick={onOpenCluster} title="自动化讨论群（并行）">讨论群</button>
      )}
      {onOpenPlans && (
        <button type="button" className={styles.timeline} onClick={onOpenPlans} title="长程计划与进度">计划</button>
      )}
      <button type="button" className={styles.timeline} onClick={onOpenCheckpoints} title="检查点时间线">时间线</button>
      <button
        type="button"
        className={styles.undo}
        onClick={() => void undo()}
        disabled={undoing || !latest}
        title={latest ? `撤销对 ${latest.path} 的应用` : '暂无检查点'}
      >
        {undoing ? '撤销中…' : latest ? `撤销 ${latest.path.split('/').pop()}` : '撤销'}
      </button>
      {undoMsg ? <span className={styles.hint}>{undoMsg}</span> : null}
      <button type="button" className={styles.refresh} onClick={refresh} title="刷新">刷新</button>
    </div>
  );
}