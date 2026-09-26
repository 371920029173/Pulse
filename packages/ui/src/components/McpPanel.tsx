import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import styles from '../styles/McpPanel.module.css';

interface McpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  source: 'cursor' | 'she';
  enabled?: boolean;
  reachable: boolean | null;
  toolCount: number | null;
  error?: string;
  latencyMs?: number;
  /** Tools actually registered to the agent by the server-side MCP bridge. */
  injected?: number;
  injectError?: string;
}

/**
 * MCP control panel.
 *
 * Replaces the read-only file browser: shows which MCP servers exist, whether
 * they actually respond, and lets you add / remove / enable them.
 */
export function McpPanel() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', command: 'npx', args: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJSON<{ servers: McpServer[] }>('/api/mcp/servers');
      setServers(data.servers ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const probe = useCallback(async (name: string) => {
    setProbing(name);
    try {
      const s = await fetchJSON<McpServer>(`/api/mcp/servers/${encodeURIComponent(name)}/probe`, { method: 'POST', body: {} });
      setServers((prev) => prev.map((x) => (x.name === s.name ? { ...x, ...s } : x)));
      toast(s.reachable ? `${name} 可用（${s.toolCount} 个工具）` : `${name} 不可达`);
    } catch (e) {
      toast(`探测失败：${(e as Error).message}`);
    } finally {
      setProbing(null);
    }
  }, []);

  const toggle = useCallback(async (name: string, enabled: boolean) => {
    await fetchJSON(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, {
      method: 'PUT',
      body: { enabled },
    });
    setServers((prev) => prev.map((x) => (x.name === name ? { ...x, enabled } : x)));
    // The bridge reconnected on the server; re-read so the injected count is current.
    void load();
  }, [load]);

  const remove = useCallback(async (name: string) => {
    await fetchJSON(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    setServers((prev) => prev.filter((x) => x.name !== name));
    toast(`已移除 ${name}`);
  }, []);

  const add = useCallback(async () => {
    if (!draft.name.trim() || !draft.command.trim()) return;
    try {
      const r = await fetchJSON<{ servers: McpServer[] }>('/api/mcp/servers', {
        method: 'POST',
        body: {
          name: draft.name.trim(),
          command: draft.command.trim(),
          args: draft.args.trim() ? draft.args.trim().split(/\s+/) : [],
        },
      });
      setServers(r.servers ?? []);
      setDraft({ name: '', command: 'npx', args: '' });
      setAdding(false);
      toast('已添加 MCP 服务');
    } catch (e) {
      toast((e as Error).message);
    }
  }, [draft]);

  const reachableCount = servers.filter((s) => s.reachable).length;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.headTitle}>MCP 服务</span>
        <span className={styles.headMeta}>
          {loading ? '检测中…' : `${reachableCount}/${servers.length} 可用`}
        </span>
        <button type="button" className={styles.iconBtn} onClick={() => void load()} title="重新检测">↻</button>
        <button type="button" className={styles.iconBtn} onClick={() => setAdding((v) => !v)} title="添加服务">+</button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {adding ? (
        <div className={styles.addBox}>
          <input
            className={styles.input}
            placeholder="名称，例如 tavily"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className={styles.input}
            placeholder="命令，例如 npx"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
          <input
            className={styles.input}
            placeholder="参数，空格分隔，例如 -y mcp-remote https://…"
            value={draft.args}
            onChange={(e) => setDraft({ ...draft, args: e.target.value })}
          />
          <button type="button" className={styles.primaryBtn} onClick={() => void add()}>保存</button>
        </div>
      ) : null}

      <div className={styles.list}>
        {servers.map((s) => {
          const dotClass =
            s.reachable === null ? styles.dotUnknown : s.reachable ? styles.dotOk : styles.dotBad;
          return (
            <div key={s.name} className={styles.item}>
              <div className={styles.itemTop}>
                <span className={`${styles.dot} ${dotClass}`} />
                <span className={styles.name}>{s.name}</span>
                <span className={`${styles.source} ${s.source === 'she' ? styles.sourceShe : ''}`}>
                  {s.source === 'she' ? 'Pulse' : 'Cursor'}
                </span>
                <span className={styles.spacer} />
                {s.toolCount !== null ? <span className={styles.tools}>{s.toolCount} 工具</span> : null}
                {s.enabled !== false ? (
                  <span className={styles.tools} title={t('实际注册给智能体的工具数')}>{t('已注入 {n}', { n: s.injected ?? 0 })}</span>
                ) : null}
                {s.latencyMs !== undefined ? <span className={styles.latency}>{s.latencyMs}ms</span> : null}
              </div>

              <div className={styles.cmd} title={`${s.command} ${s.args.join(' ')}`}>
                {s.command} {s.args.join(' ')}
              </div>

              {s.reachable === false && s.error ? (
                <div className={styles.errline}>{s.error}</div>
              ) : null}

              {s.enabled !== false && s.reachable && s.toolCount !== null && s.toolCount !== (s.injected ?? 0) ? (
                <div className={styles.errline}>
                  {t('⚠ 探测到 {probe} 个工具，但只有 {injected} 个注册给了智能体', { probe: s.toolCount, injected: s.injected ?? 0 })}
                  {s.injectError ? ` \u2014 ${s.injectError}` : ''}
                </div>
              ) : null}

              <div className={styles.itemActions}>
                <button
                  type="button"
                  className={styles.smallBtn}
                  disabled={probing === s.name}
                  onClick={() => void probe(s.name)}
                >
                  {probing === s.name ? '检测中…' : '检测'}
                </button>
                {s.source === 'she' ? (
                  <>
                    <button
                      type="button"
                      className={styles.smallBtn}
                      onClick={() => void toggle(s.name, s.enabled === false)}
                    >
                      {s.enabled === false ? '启用' : '停用'}
                    </button>
                    <button type="button" className={styles.smallBtnDanger} onClick={() => void remove(s.name)}>
                      删除
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
        {!loading && servers.length === 0 ? (
          <div className={styles.empty}>没有发现 MCP 服务。点 + 添加，或在 Cursor 配置后回来重新检测。</div>
        ) : null}
      </div>
    </div>
  );
}
