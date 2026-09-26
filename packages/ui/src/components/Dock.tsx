import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { toast } from '../lib/toast';
import { FeishuPanel } from './FeishuPanel';
import styles from '../styles/Dock.module.css';

/**
 * Dock — install and manage plugins, plus the built-in remote control.
 *
 * Three tabs, because the three jobs are genuinely different:
 *   已安装  what is running, with its declared reach
 *   可安装  the bundled catalog, one click each — no folder or JSON editing
 *   新建    scaffold a plugin, or install one from a folder you already have
 *
 * The "declared reach" is shown prominently rather than tucked into a details
 * pane. Plugin code runs in-process, so `permissions` cannot be enforced; the
 * honest thing is to put it in front of the user before they install. See the
 * note rendered below the tabs.
 */

interface PluginTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface PluginManifest {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  enabled?: boolean;
  permissions?: string[];
  tools?: PluginTool[];
  commands?: { id: string; title: string; description?: string }[];
  panels?: { id: string; title: string; entry: string }[];
}

interface InstalledPlugin {
  dir: string;
  manifestPath: string;
  manifest: PluginManifest | null;
  error?: string;
  hasModule?: boolean;
  toolCount?: number;
  /** Declarations that cannot work, reported by the server. */
  issues?: string[];
}

interface CatalogEntry {
  dir: string;
  manifest: PluginManifest;
  installed: boolean;
}

type Tab = 'installed' | 'catalog' | 'new';

/** Human wording for the declared permission values. */
const PERM_LABEL: Record<string, string> = {
  read: '读取工作区文件',
  write: '写入工作区文件',
  shell: '执行命令',
  network: '访问网络',
  kb: '读写知识库',
};

/** Permissions worth flagging in red rather than amber. */
const DANGEROUS_PERMS = new Set(['shell', 'write', 'network']);

function PermissionChips({ list }: { list?: string[] }) {
  if (!list?.length) return <span className={styles.permNone}>未声明任何权限</span>;
  return (
    <span className={styles.permRow}>
      {list.map((p) => {
        const known = p in PERM_LABEL;
        return (
          <span
            key={p}
            className={`${styles.permChip} ${DANGEROUS_PERMS.has(p) ? styles.permChipWarn : ''} ${known ? '' : styles.permChipUnknown}`}
            title={known
              ? PERM_LABEL[p]
              : `运行时不认识这个权限，它不会生效 —— 已知权限：${Object.keys(PERM_LABEL).join(' / ')}`}
          >
            {known ? PERM_LABEL[p] : `${p}（未知）`}
          </span>
        );
      })}
    </span>
  );
}

export function Dock() {
  const [tab, setTab] = useState<Tab>('installed');
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installDir, setInstallDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Key of the row with an action in flight, so only that row shows busy. */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const [scaffoldName, setScaffoldName] = useState('');
  const [scaffoldDesc, setScaffoldDesc] = useState('');
  const [pathInput, setPathInput] = useState('');

  /** Source editor state; null when closed. */
  const [editor, setEditor] = useState<{
    dir: string;
    file: 'manifest.json' | 'index.mjs';
    manifest: string;
    module: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        fetchJSON<{ plugins: InstalledPlugin[]; dir: string }>('/api/plugins'),
        fetchJSON<{ entries: CatalogEntry[] }>('/api/plugins/catalog'),
      ]);
      setPlugins(a.plugins ?? []);
      setInstallDir(a.dir ?? '');
      setCatalog(b.entries ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** One helper so every mutation reports its own errors the same way. */
  const act = useCallback(async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusyKey(key);
    setError(null);
    try {
      await fn();
      toast(okMsg);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  const install = useCallback((name: string) => act(`install:${name}`,
    () => fetchJSON('/api/plugins/install', { method: 'POST', body: { name } }),
    `已安装 ${name}`), [act]);

  const installFromPath = useCallback(() => {
    const p = pathInput.trim();
    if (!p) { setError('先填一个插件文件夹路径'); return; }
    void act('install-path',
      () => fetchJSON('/api/plugins/install', { method: 'POST', body: { path: p } }),
      '已安装').then(() => setPathInput(''));
  }, [pathInput, act]);

  const scaffold = useCallback(() => {
    const n = scaffoldName.trim();
    if (!n) { setError('先填插件名'); return; }
    void act('scaffold',
      () => fetchJSON('/api/plugins/scaffold', { method: 'POST', body: { name: n, description: scaffoldDesc } }),
      `已创建 ${n}`).then(() => { setScaffoldName(''); setScaffoldDesc(''); setTab('installed'); });
  }, [scaffoldName, scaffoldDesc, act]);

  const toggleEnabled = useCallback((dir: string, enabled: boolean) => act(`toggle:${dir}`,
    () => fetchJSON('/api/plugins/enabled', { method: 'PUT', body: { dir, enabled } }),
    enabled ? '已启用' : '已停用'), [act]);

  const uninstall = useCallback((dir: string) => {
    // Deleting a plugin removes its folder from disk.
    // eslint-disable-next-line no-alert
    if (!window.confirm(`卸载「${dir}」？会删除它的目录，无法撤销。`)) return;
    void act(`uninstall:${dir}`, () => fetchJSON(`/api/plugins?dir=${encodeURIComponent(dir)}`, { method: 'DELETE' }), '已卸载');
  }, [act]);

  const openEditor = useCallback(async (dir: string) => {
    setBusyKey(`edit:${dir}`);
    setError(null);
    try {
      const r = await fetchJSON<{ manifest: string; module: string | null }>(
        `/api/plugins/source?dir=${encodeURIComponent(dir)}`,
      );
      setEditor({ dir, file: 'manifest.json', manifest: r.manifest, module: r.module });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }, []);

  const saveEditor = useCallback(() => {
    if (!editor) return;
    const content = editor.file === 'manifest.json' ? editor.manifest : (editor.module ?? '');
    void act('save-source', () => fetchJSON('/api/plugins/source', {
      method: 'PUT',
      body: { dir: editor.dir, file: editor.file, content },
    }), '已保存并重新加载');
  }, [editor, act]);

  const totalTools = plugins.reduce((n, p) => n + (p.manifest?.tools?.length ?? 0), 0);
  const available = catalog.filter((c) => !c.installed).length;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.headTitle}>扩展坞</span>
        <span className={styles.headMeta}>
          {loading ? '读取中…' : `${plugins.length} 已装 · ${totalTools} 工具 · ${available} 可装`}
        </span>
        <button type="button" className={styles.iconBtn} onClick={() => void load()} title="重新扫描">↻</button>
      </div>

      <div className={styles.tabs}>
        {([['installed', '已安装'], ['catalog', '可安装'], ['new', '新建']] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`${styles.tab} ${tab === id ? styles.tabOn : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'catalog' && available > 0 ? <span className={styles.tabBadge}>{available}</span> : null}
          </button>
        ))}
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.body}>
        {/* Remote control is a built-in capability, so it stays visible on every tab. */}
        <FeishuPanel />

        {tab === 'installed' ? (
          loading ? (
            <div className={styles.empty}>读取中…</div>
          ) : plugins.length === 0 ? (
            <div className={styles.empty}>
              还没有插件。
              <br />
              去 <b>可安装</b> 一键装一个，或在 <b>新建</b> 里做一个。
            </div>
          ) : (
            plugins.map((p) => {
              const m = p.manifest;
              const isOpen = openId === p.dir;
              const on = m?.enabled !== false;
              const broken = Boolean(p.error) || (m !== null && p.hasModule === false && (m.tools?.length ?? 0) > 0);
              return (
                <div key={p.dir} className={`${styles.plugin} ${on ? '' : styles.pluginOff}`}>
                  <div className={styles.pluginHead}>
                    <span className={`${styles.dot} ${broken ? styles.dotBad : on ? styles.dotOn : ''}`} />
                    <div className={styles.pluginMain}>
                      <div className={styles.pluginName}>
                        {m?.name || p.dir}
                        {m?.version ? <span className={styles.ver}>v{m.version}</span> : null}
                        {!p.hasModule && (m?.tools?.length ?? 0) > 0 ? (
                          <span className={styles.warnBadge} title="manifest 声明了工具，但没有 index.mjs，所以它们不会生效">
                            无实现
                          </span>
                        ) : null}
                      </div>
                      <div className={styles.pluginDesc}>
                        {m?.description || (p.error ? `清单读取失败：${p.error}` : '未提供说明')}
                      </div>
                      {/* Declarations that cannot work: say so instead of showing a healthy plugin. */}
                      {p.issues?.length ? (
                        <ul className={styles.issueList}>
                          {p.issues.map((it) => <li key={it}>{it}</li>)}
                        </ul>
                      ) : null}
                      <div className={styles.pluginMetaRow}>
                        <span className={styles.toolCount}>
                          {p.hasModule ? `${m?.tools?.length ?? 0} 个工具` : '无可执行工具'}
                        </span>
                        <PermissionChips list={m?.permissions} />
                      </div>
                    </div>
                    <button type="button" className={styles.small} onClick={() => setOpenId(isOpen ? null : p.dir)}>
                      {isOpen ? '收起' : '详情'}
                    </button>
                    <button
                      type="button"
                      className={styles.small}
                      disabled={busyKey === `toggle:${p.dir}`}
                      onClick={() => void toggleEnabled(p.dir, !on)}
                    >
                      {on ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className={styles.small}
                      disabled={!m || busyKey === `edit:${p.dir}`}
                      onClick={() => void openEditor(p.dir)}
                      title="查看并修改 manifest 与 index.mjs，保存后立即生效"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className={styles.smallDanger}
                      disabled={busyKey === `uninstall:${p.dir}`}
                      onClick={() => uninstall(p.dir)}
                    >
                      卸载
                    </button>
                  </div>

                  {isOpen ? (
                    <div className={styles.detail}>
                      <div className={styles.row}>
                        <b>目录</b>
                        <code>{p.manifestPath}</code>
                      </div>
                      {m?.author ? <div className={styles.row}><b>作者</b><span>{m.author}</span></div> : null}
                      <div className={styles.row}>
                        <b>权限</b>
                        <PermissionChips list={m?.permissions} />
                      </div>

                      {m?.tools?.length ? (
                        <div className={styles.section}>
                          <b>提供的工具 ({m.tools.length})</b>
                          {m.tools.map((t) => (
                            <div key={t.name} className={styles.item}>
                              <code>{t.name}</code>
                              <span>{t.description}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {m?.commands?.length ? (
                        <div className={styles.section}>
                          <b>命令 ({m.commands.length})</b>
                          {m.commands.map((cmd) => (
                            <div key={cmd.id} className={styles.item}>
                              <code>{cmd.id}</code>
                              <span>{cmd.title}{cmd.description ? ` — ${cmd.description}` : ''}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )
        ) : null}

        {tab === 'catalog' ? (
          catalog.length === 0 ? (
            <div className={styles.empty}>没有可安装的插件。目录里还没有内容。</div>
          ) : (
            catalog.map((c) => (
              <div key={c.dir} className={styles.plugin}>
                <div className={styles.pluginHead}>
                  <span className={`${styles.dot} ${c.installed ? styles.dotOn : ''}`} />
                  <div className={styles.pluginMain}>
                    <div className={styles.pluginName}>
                      {c.manifest.name || c.dir}
                      {c.manifest.version ? <span className={styles.ver}>v{c.manifest.version}</span> : null}
                    </div>
                    <div className={styles.pluginDesc}>{c.manifest.description || '未提供说明'}</div>
                    <div className={styles.pluginMetaRow}>
                      <span className={styles.toolCount}>{c.manifest.tools?.length ?? 0} 个工具</span>
                      <PermissionChips list={c.manifest.permissions} />
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.small}
                    disabled={c.installed || busyKey === `install:${c.dir}`}
                    onClick={() => void install(c.dir)}
                  >
                    {c.installed ? '已安装' : busyKey === `install:${c.dir}` ? '安装中…' : '安装'}
                  </button>
                </div>
              </div>
            ))
          )
        ) : null}

        {tab === 'new' ? (
          <>
            <div className={styles.formCard}>
              <div className={styles.formTitle}>做一个新插件</div>
              <div className={styles.formHint}>
                会生成一个能直接跑起来的骨架：manifest.json + index.mjs，
                里面有一个可调用的示例工具。建好点「编辑」就能改。
              </div>
              <label className={styles.fsField}>
                <span>插件名</span>
                <input
                  value={scaffoldName}
                  placeholder="例如 pdf-tools（字母、数字、- 或 _）"
                  onChange={(e) => setScaffoldName(e.target.value)}
                />
              </label>
              <label className={styles.fsField}>
                <span>说明（可选）</span>
                <input
                  value={scaffoldDesc}
                  placeholder="一句话说明这个插件做什么"
                  onChange={(e) => setScaffoldDesc(e.target.value)}
                />
              </label>
              <button type="button" className={styles.small} disabled={busyKey === 'scaffold'} onClick={scaffold}>
                {busyKey === 'scaffold' ? '创建中…' : '创建骨架'}
              </button>
            </div>

            <div className={styles.formCard}>
              <div className={styles.formTitle}>从文件夹安装</div>
              <div className={styles.formHint}>
                已经有一个插件目录？粘贴它的完整路径即可。目录里必须有 manifest.json。
              </div>
              <label className={styles.fsField}>
                <span>插件目录</span>
                <input
                  value={pathInput}
                  placeholder="例如 ~/my-plugins/pdf-tools"
                  onChange={(e) => setPathInput(e.target.value)}
                />
              </label>
              <button type="button" className={styles.small} disabled={busyKey === 'install-path'} onClick={installFromPath}>
                {busyKey === 'install-path' ? '安装中…' : '安装'}
              </button>
            </div>

            <div className={styles.formCard}>
              <div className={styles.formTitle}>插件装在哪</div>
              <div className={styles.formHint}>
                装在应用目录里（所有工作区共用）：
                <br />
                <code className={styles.pathCode}>{installDir || '(未知)'}</code>
                <br />
                也可以在某个工作区里放 <code>.she/plugins/</code>，它会覆盖同名的全局插件。
              </div>
            </div>

            {/*
              The security note is placed last so it is read before installing,
              not buried in docs. It is stated plainly because it is true:
              plugin code runs in-process.
            */}
            <div className={styles.disclosure}>
              <b>关于插件安全</b>
              <div>
                插件代码和 Pulse 在同一个进程里运行，所以 manifest 里的「权限」是
                <b>声明</b>，<b>不是限制</b> —— 它告诉你插件打算碰什么，但拦不住它做别的。
                装之前请看清上面列出的权限，来源不明的插件不要装。
              </div>
            </div>
          </>
        ) : null}
      </div>

      {editor ? (
        <div className={styles.editorOverlay} onClick={() => setEditor(null)}>
          <div className={styles.editorPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.editorHead}>
              <span className={styles.editorTitle}>{editor.dir}</span>
              <div className={styles.editorTabs}>
                {(['manifest.json', 'index.mjs'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`${styles.tab} ${editor.file === f ? styles.tabOn : ''}`}
                    disabled={f === 'index.mjs' && editor.module === null}
                    onClick={() => setEditor({ ...editor, file: f })}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <button type="button" className={styles.small} disabled={busyKey === 'save-source'} onClick={saveEditor}>
                {busyKey === 'save-source' ? '保存中…' : '保存并重载'}
              </button>
              <button type="button" className={styles.small} onClick={() => setEditor(null)}>关闭</button>
            </div>
            <textarea
              className={styles.editorArea}
              spellCheck={false}
              value={editor.file === 'manifest.json' ? editor.manifest : (editor.module ?? '')}
              onChange={(e) => setEditor(editor.file === 'manifest.json'
                ? { ...editor, manifest: e.target.value }
                : { ...editor, module: e.target.value })}
            />
            <div className={styles.editorFoot}>
              保存后会重新加载插件，正在进行的对话下一轮就能用上新工具。
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
