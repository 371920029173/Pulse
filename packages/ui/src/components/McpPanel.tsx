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
  /** Tools the agent can reach through `mcp_call` right now (live bridge session). */
  injected?: number;
  injectError?: string;
  /**
   * 被收敛掉的原始允许根（缺省 = 没动过）。
   *
   * 文件系统型 MCP 的允许根从工作区派生，工作区外的目录会被替换掉 —— 实测里那个服务器原本
   * 指向桌面，于是它成了 SHE 边界的一条完整旁路（能读桌面、读不到代码树）。收敛必须说出来：
   * 悄悄改掉用户的配置比不收敛更糟。
   */
  confinedRoots?: string[];
  /**
   * 产物目录因 `cwd` 被钉到工作区而变化时，这是它**现在**写在哪（缺省 = 没这个说法）。
   *
   * MCP 子进程的 cwd 曾经继承 SHE 的 cwd，于是 playwright 通道按 `join(cwd, '.playwright-mcp')`
   * 算出来的产物目录取决于"你怎么启动 SHE" —— 实测那一份落在用户主目录里，340 项。
   */
  confinedOutputDir?: string;
  /** 旧版本留在工作区之外的历史产物（只报不删，删不删是用户的决定）。 */
  legacyOutputDir?: { path: string; entries: number };
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
        <span className={styles.headTitle}>{t('MCP 服务')}</span>
        <span className={styles.headMeta}>
          {loading ? '检测中…' : `${reachableCount}/${servers.length} 可用`}
        </span>
        <button type="button" className={styles.iconBtn} onClick={() => void load()} title={t('重新检测')}>↻</button>
        <button type="button" className={styles.iconBtn} onClick={() => setAdding((v) => !v)} title={t('添加服务')}>+</button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {adding ? (
        <div className={styles.addBox}>
          <input
            className={styles.input}
            placeholder={t('名称，例如 tavily')}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className={styles.input}
            placeholder={t('命令，例如 npx')}
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
          <input
            className={styles.input}
            placeholder={t('参数，空格分隔，例如 -y mcp-remote https://…')}
            value={draft.args}
            onChange={(e) => setDraft({ ...draft, args: e.target.value })}
          />
          <button type="button" className={styles.primaryBtn} onClick={() => void add()}>{t('保存')}</button>
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
                  <span className={styles.tools} title={t('智能体通过 mcp_call 现在能调用的工具数')}>{t('mcp_call 可调用 {n}', { n: s.injected ?? 0 })}</span>
                ) : null}
                {s.latencyMs !== undefined ? <span className={styles.latency}>{s.latencyMs}ms</span> : null}
              </div>

              <div className={styles.cmd} title={`${s.command} ${s.args.join(' ')}`}>
                {s.command} {s.args.join(' ')}
              </div>

              {s.reachable === false && s.error ? (
                <div className={styles.errline}>{s.error}</div>
              ) : null}

              {s.confinedRoots?.length ? (
                <div className={styles.errline}>
                  {t('允许根已收敛到当前工作区，原本指向：{roots}', { roots: s.confinedRoots.join('、') })}
                </div>
              ) : null}

              {s.confinedOutputDir ? (
                <div className={styles.hintline}>
                  {t('产物目录已随工作区固定：{dir}', { dir: s.confinedOutputDir })}
                </div>
              ) : null}

              {s.legacyOutputDir ? (
                <div className={styles.errline}>
                  {t('工作区外还留着 {n} 项历史产物（本通道的新产物已改在工作区内，这些要删你自己删）：{dir}', {
                    n: s.legacyOutputDir.entries,
                    dir: s.legacyOutputDir.path,
                  })}
                </div>
              ) : null}

              {s.enabled !== false && s.reachable && s.toolCount !== null && s.toolCount !== (s.injected ?? 0) ? (
                <div className={styles.errline}>
                  {t('⚠ 探测到 {probe} 个工具，但 mcp_call 现在只能调用 {injected} 个', { probe: s.toolCount, injected: s.injected ?? 0 })}
                  {s.injectError ? ` \u2014 ${s.injectError}` : ''}
                </div>
              ) : null}

              {s.source === 'cursor' ? (
                <div className={styles.hintline}>{t('来自 Cursor 的全局配置，默认不启动。启用会把它复制进本工作区的 .she/mcp.json。')}</div>
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
                      {s.enabled === false ? t('启用') : t('停用')}
                    </button>
                    <button type="button" className={styles.smallBtnDanger} onClick={() => void remove(s.name)}>
                      删除
                    </button>
                  </>
                ) : (
                  // A Cursor-sourced server is always off here; enabling copies it into `.she/mcp.json`,
                  // after which it is listed as a Pulse server with the normal toggle.
                  <button
                    type="button"
                    className={styles.smallBtn}
                    title={t('复制到本工作区的 .she/mcp.json 并启动')}
                    onClick={() => void toggle(s.name, true)}
                  >
                    {t('启用')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!loading && servers.length === 0 ? (
          <div className={styles.empty}>{t('没有发现 MCP 服务。点 + 添加，或在 Cursor 配置后回来重新检测。')}</div>
        ) : null}
      </div>
    </div>
  );
}
