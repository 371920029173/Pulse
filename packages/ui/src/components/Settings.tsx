import { useEffect, useRef, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { SKILL_PROFILES, isSkillProfile, type SkillProfileId } from '../lib/skills';
import { LOCALES, t } from '../lib/i18n';
import type { Locale } from '../lib/i18n';
import { ShortcutEditor } from './ShortcutEditor';
import styles from '../styles/Settings.module.css';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

interface SettingsData {
  llm: {
    provider: 'openai' | 'anthropic';
    model: string;
    baseUrl: string;
    hasKey: boolean;
    maxTokens: number;
    temperature: number;
    thinkingLevel?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    fallback?: { provider?: string; model?: string; baseUrl?: string; hasKey?: boolean };
  };
  workspace: { root: string };
  kb?: { dbPath?: string };
  skills?: { profile?: SkillProfileId };
  automationMode?: boolean;
  sandbox?: {
    allowAllCommands?: boolean;
    denyDestructiveByDefault?: boolean;
    shell?: string;
    timeout?: number;
  };
}

interface Props {
  onClose: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  /** Active UI language, and how to change it. */
  locale: Locale;
  onLocale: (l: Locale) => void;
  background?: {
    meta: { url: string | null; kind: 'image' | 'video' | null; filename: string | null };
    busy: boolean;
    error: string | null;
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    setFromFile: (file: File) => Promise<void>;
    clear: () => Promise<void>;
  };
  /** Opens the custom stylesheet editor. Optional so the panel can be rendered without it. */
  onOpenTheme?: () => void;
  /**
   * Which block to bring into view when the panel opens.
   *
   * The panel is a single ~3000px form, and the shared-knowledge-base controls sit about a thousand
   * pixels down it — far enough that a user looking for them concluded the feature did not exist.
   * Callers that open Settings *for* a specific purpose pass a section id so the panel lands on it.
   */
  focusSection?: string | null;
}

const PRESETS: { id: string; label: string; provider: 'openai' | 'anthropic'; baseUrl: string; model: string; keyHint: string }[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    keyHint: 'sk-...',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    keyHint: 'sk-or-...',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2',
    keyHint: 'ollama (any non-empty ok)',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    keyHint: 'lm-studio',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude-sonnet-4-20250514',
    keyHint: 'sk-ant-...',
  },
];

export function Settings({ onClose, theme, onToggleTheme, background, locale, onLocale, onOpenTheme, focusSection }: Props) {
  // Escape closes this dialog: the backdrop click is a mouse convenience, not a keyboard path.
  useEscapeToClose(onClose);

  /** The shared-knowledge-base block, so a caller can ask for it to be brought into view. */
  const kbShareRef = useRef<HTMLDivElement | null>(null);

  /**
   * Scroll a requested block into view.
   *
   * Runs after the panel has laid out. The block itself renders immediately (it is not behind a
   * loading state), but `center` rather than `start` matters here: the section is a group of inputs
   * and buttons, and aligning its top edge to the viewport would push the buttons off the bottom of
   * a panel only ~900px tall.
   */
  useEffect(() => {
    if (focusSection !== 'kb-share') return;
    const el = kbShareRef.current;
    if (!el) return;
    // One frame, so the panel's entry animation has a laid-out position to scroll to.
    const id = window.requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [focusSection]);

  const [data, setData] = useState<SettingsData | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  /**
   * `null` until the real value is loaded.
   *
   * The old default was `false`, so opening Settings and pressing Save before
   * the fetch resolved wrote `allowAllCommands: false` back to .env — silently
   * switching OFF the auto-run the user had enabled. `null` means "unknown",
   * and Save omits the field instead of guessing.
   */
  const [allowAllCommands, setAllowAllCommands] = useState<boolean | null>(null);
  const [automationMode, setAutomationMode] = useState<boolean | null>(null);
  const [kbDbPath, setKbDbPath] = useState('');
  const [kbMode, setKbMode] = useState<'env' | 'shared' | 'local' | ''>('');
  const [sharePath, setSharePath] = useState('');
  const [mergeSourcePath, setMergeSourcePath] = useState('');
  const [mergeTargetPath, setMergeTargetPath] = useState('');
  const [kbBusy, setKbBusy] = useState(false);
  const [skillProfile, setSkillProfile] = useState<SkillProfileId>('dev');
  const [thinkingLevel, setThinkingLevel] = useState<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('medium');
  const [fallbackBaseUrl, setFallbackBaseUrl] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [fallbackProvider, setFallbackProvider] = useState<'openai' | 'anthropic'>('openai');
  const [fallbackApiKey, setFallbackApiKey] = useState('');
  const [customSkillName, setCustomSkillName] = useState('');
  const [customSkillBody, setCustomSkillBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetchJSON<SettingsData>('/api/settings')
      .then((d) => {
        setData(d);
        setModel(d.llm.model);
        setBaseUrl(d.llm.baseUrl);
        setProvider(d.llm.provider);
        setWorkspaceRoot(d.workspace.root);
        setAllowAllCommands(Boolean(d.sandbox?.allowAllCommands));
        setAutomationMode(d.automationMode !== false);
        setKbDbPath(d.kb?.dbPath || '');
        // isSkillProfile instead of a hand-written comparison: the old one
        // enumerated three values and silently ignored general.
        if (isSkillProfile(d.skills?.profile)) setSkillProfile(d.skills.profile);
        if (d.llm.thinkingLevel) setThinkingLevel(d.llm.thinkingLevel);
        setFallbackBaseUrl(d.llm.fallback?.baseUrl || '');
        setFallbackModel(d.llm.fallback?.model || '');
        if (d.llm.fallback?.provider === 'openai' || d.llm.fallback?.provider === 'anthropic') setFallbackProvider(d.llm.fallback.provider as 'openai' | 'anthropic');
        void refreshKbLink();
      })
      .catch((e) => setMsg(String(e.message || e)));
  }, []);

  function applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setProvider(p.provider);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    if (id === 'ollama' || id === 'lmstudio') {
      setApiKey((k) => k || 'local');
    }
    setMsg(`已套用预设：${p.label}`);
  }


  async function refreshKbLink() {
    try {
      const link = await fetchJSON<{
        ok: boolean;
        dbPath: string;
        mode: 'env' | 'shared' | 'local';
        link: { dbPath: string; note?: string } | null;
      }>('/api/kb/link');
      setKbDbPath(link.dbPath || '');
      setKbMode(link.mode);
      if (link.mode === 'shared' && link.dbPath) setSharePath(link.dbPath);
    } catch (e: any) {
      /* non-fatal: older servers may lack the route */
      console.warn('kb/link', e?.message || e);
    }
  }

  async function bindSharedKb() {
    const path = (sharePath || kbDbPath).trim();
    if (!path) {
      setMsg(t('请填写共享知识库的 sqlite 路径'));
      return;
    }
    setKbBusy(true);
    setMsg('');
    try {
      const res = await fetchJSON<{ ok: boolean; dbPath: string; mode: string }>('/api/kb/link', {
        method: 'PUT',
        body: { dbPath: path },
      });
      setKbDbPath(res.dbPath);
      setKbMode((res.mode as any) || 'shared');
      setMsg(t('已挂载共享知识库：{path}', { path: res.dbPath }));
      await refreshKbLink();
    } catch (e: any) {
      setMsg(e.message || String(e));
    } finally {
      setKbBusy(false);
    }
  }

  async function restoreLocalKb() {
    setKbBusy(true);
    setMsg('');
    try {
      const res = await fetchJSON<{ ok: boolean; dbPath: string; mode: string }>('/api/kb/link', {
        method: 'PUT',
        body: { dbPath: null },
      });
      setKbDbPath(res.dbPath);
      setKbMode((res.mode as any) || 'local');
      setMsg(t('已恢复本工作区知识库：{path}', { path: res.dbPath }));
    } catch (e: any) {
      setMsg(e.message || String(e));
    } finally {
      setKbBusy(false);
    }
  }

  async function publishSharedKb() {
    const path = sharePath.trim();
    if (!path) {
      setMsg('请填写要发布到的共享路径（例如 ./shared/kb.sqlite，或局域网共享盘的绝对路径）');
      return;
    }
    setKbBusy(true);
    setMsg('');
    try {
      const res = await fetchJSON<{ ok: boolean; dbPath: string; from?: string }>('/api/kb/share', {
        method: 'POST',
        body: { sharedPath: path },
      });
      setKbDbPath(res.dbPath);
      setKbMode('shared');
      setMsg(t('已复制并挂载共享库：{path}{from}', { path: res.dbPath, from: res.from ? t('（来自 {src}）', { src: res.from }) : '' }));
      await refreshKbLink();
    } catch (e: any) {
      setMsg(e.message || String(e));
    } finally {
      setKbBusy(false);
    }
  }

  async function mergeOtherKb() {
    const source = mergeSourcePath.trim();
    if (!source) {
      setMsg(t('请填写要合并进来的另一份 sqlite 路径'));
      return;
    }
    setKbBusy(true);
    setMsg('');
    try {
      const body: Record<string, string> = { sourcePath: source };
      if (mergeTargetPath.trim()) body.targetPath = mergeTargetPath.trim();
      const res = await fetchJSON<{ ok: boolean; dbPath: string; memoriesAdded?: number; groupsAdded?: number }>(
        '/api/kb/merge',
        { method: 'POST', body },
      );
      setKbDbPath(res.dbPath);
      setMsg(
        t('合并完成，当前库：{path}', { path: res.dbPath }) +
          (res.memoriesAdded != null ? t('（写入 {n} 条）', { n: res.memoriesAdded }) : ''),
      );
      await refreshKbLink();
    } catch (e: any) {
      setMsg(e.message || String(e));
    } finally {
      setKbBusy(false);
    }
  }

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      const body: Record<string, unknown> = {
        provider,
        model,
        baseUrl,
        workspaceRoot,
        kbDbPath,
        skillProfile,
        thinkingLevel,
        fallbackBaseUrl,
        fallbackModel,
        fallbackProvider,
      };
      // Only send permission flags once they are known, so saving a partially
      // loaded form cannot silently turn auto-run off.
      if (allowAllCommands !== null) body.allowAllCommands = allowAllCommands;
      if (automationMode !== null) body.automationMode = automationMode;
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (fallbackApiKey.trim()) body.fallbackApiKey = fallbackApiKey.trim();
      const res = await fetchJSON<{ ok: boolean; llm: { hasKey: boolean }; restartRequired?: boolean }>('/api/settings', {
        method: 'PUT',
        body,
      });
      const saved = res.llm.hasKey ? t('已保存（含 API key）') : t('已保存');
      setMsg(res.restartRequired ? t('{saved}；工作区 / 知识库路径已变更，需重启服务端后生效', { saved }) : saved);
      setApiKey('');
      const d = await fetchJSON<SettingsData>('/api/settings');
      setData(d);
      setAllowAllCommands(Boolean(d.sandbox?.allowAllCommands));
        setAutomationMode(d.automationMode !== false);
    setKbDbPath(d.kb?.dbPath || '');
    setWorkspaceRoot(d.workspace.root);
    } catch (e: any) {
      setMsg(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.backdrop} data-surface="backdrop" onClick={onClose}>
      <div className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <h2>设置</h2>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </header>
        {!data ? (
          <p className={styles.hint}>{msg || '加载中…'}</p>
        ) : (
          <div className={styles.form}>
            <div className={styles.presets}>
              <span className={styles.presetsLabel}>快速预设</span>
              <div className={styles.presetRow}>
                {PRESETS.map((p) => (
                  <button key={p.id} type="button" className={styles.presetBtn} onClick={() => applyPreset(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <label>
              <span>提供商</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label>
              <span>模型</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
            <label>
              <span>接口地址</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
            </label>
            <label>
              <span>API 密钥 {data.llm.hasKey ? '(已配置)' : '(未配置)'}</span>
              <input
                type="password"
                placeholder={data.llm.hasKey ? '留空则不改' : 'sk-...'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              <span>工作区 root</span>
              <input value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>技能档位</span>
              <select
                value={skillProfile}
                onChange={(e) => { if (isSkillProfile(e.target.value)) setSkillProfile(e.target.value); }}
              >
                {/* Generated from the single source so this list cannot go stale
                    again — a hand-written copy here was missing 「通用」. */}
                {SKILL_PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}{p.id === 'dev' ? '（默认）' : ''}</option>
                ))}
              </select>
            </label>
            <p className={styles.hint}>
              加载 <code>.she/skills/_common</code> + 对应档目录。自定义 skill 放到 <code>.she/skills/custom/*.md</code>。侧栏状态栏也可快速切换。
            </p>
            <label className={styles.field}>
              <span>{t('知识库路径（本工作区或共享）')}</span>
              <input
                value={kbDbPath}
                onChange={(e) => setKbDbPath(e.target.value)}
                placeholder="留空则用 <工作区>/.she/kb.sqlite"
                spellCheck={false}
              />
            </label>
            <p className={styles.hint}>
              当前模式：<strong>{kbMode || '…'}</strong>
              {kbMode === 'shared' ? '（多工作区可挂同一 sqlite，改完即重挂，一般不用整服重启）' : ''}
              {kbMode === 'local' ? '（仅本工作区 .she/kb.sqlite）' : ''}
              {kbMode === 'env' ? '（由 SHE_KB_PATH 指定，优先于 kb-link）' : ''}
              。保存设置仍会写入路径；要用「贯穿」请用下面的共享操作。
            </p>
            <div id="settings-kb-share" ref={kbShareRef} className={styles.field} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('多工作区共享知识库')}</span>
              <input
                value={sharePath}
                onChange={(e) => setSharePath(e.target.value)}
                placeholder={t('共享 sqlite 路径，例如 ./shared/kb.sqlite（也可填局域网共享盘）')}
                spellCheck={false}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="she-btn she-btn--sm" disabled={kbBusy} onClick={() => void bindSharedKb()}>
                  {t('挂到此共享库')}
                </button>
                <button type="button" className="she-btn she-btn--sm" disabled={kbBusy} onClick={() => void publishSharedKb()}>
                  {t('把当前库发布到该路径')}
                </button>
                <button type="button" className="she-btn she-btn--sm" disabled={kbBusy} onClick={() => void restoreLocalKb()}>
                  {t('恢复本工作区库')}
                </button>
              </div>
              <input
                value={mergeSourcePath}
                onChange={(e) => setMergeSourcePath(e.target.value)}
                placeholder={t('要合并进来的另一份 sqlite（另一工作区的库）')}
                spellCheck={false}
              />
              <input
                value={mergeTargetPath}
                onChange={(e) => setMergeTargetPath(e.target.value)}
                placeholder={t('可选：合并结果写到新共享路径（留空则并入当前库）')}
                spellCheck={false}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="she-btn she-btn--sm" disabled={kbBusy} onClick={() => void mergeOtherKb()}>
                  {t('合并另一库')}
                </button>
              </div>
              <p className={styles.hint} style={{ margin: 0 }}>
                {t('推荐流程：工作区 A「发布到共享路径」→ 工作区 B「挂到此共享库」→ 两边贯穿同一套知识。')}
                {t('若两套库都有内容，用「合并另一库」拼成一份再挂载。')}
              </p>
            </div>
              
            <p className={styles.hint}>
              思考强度已移到对话框发送键旁边，可随时拖动调节。主流模型特点见 skill 档。
            </p>
            <label>
              <span>备用接口地址（选填）</span>
              <input value={fallbackBaseUrl} onChange={(e) => setFallbackBaseUrl(e.target.value)} placeholder="主接口失败时回退" />
            </label>
            <label>
              <span>备用模型</span>
              <input value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} />
            </label>
            <label>
              <span>备用提供商</span>
              <select value={fallbackProvider} onChange={(e) => setFallbackProvider(e.target.value as any)}>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label>
              <span>备用 API 密钥 {data.llm.fallback?.hasKey ? '(已配置)' : '(未配置)'}</span>
              <input
                type="password"
                placeholder={data.llm.fallback?.hasKey ? '留空则不改' : '选填'}
                value={fallbackApiKey}
                onChange={(e) => setFallbackApiKey(e.target.value)}
                autoComplete="off"
              />
            </label>
            <div className={styles.row} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('外观主题')}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{t('对话区可用拖拽把手调节侧栏 / 轨迹宽度')}</div>
              </div>
              <button type="button" onClick={onToggleTheme} style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>
                {theme === 'light' ? t('切换到深色') : t('切换到浅色')}
              </button>
              {onOpenTheme ? (
                <button type="button" className="she-btn she-btn--sm" onClick={onOpenTheme}>
                  {t('自定义样式…')}
                </button>
              ) : null}
            </div>

            {/*
              Language switch.

              Placed next to the theme control because they are the same kind of
              setting — a personal display preference with no effect on the agent.
              Switching re-renders the whole tree, so it takes effect immediately
              everywhere rather than needing a reload.
            */}
            <div className={styles.row} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('界面语言')}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {locale === 'zh' ? t('界面文案语言，立刻生效') : 'UI language, applied immediately'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {LOCALES.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => onLocale(l.id)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      fontWeight: locale === l.id ? 600 : 400,
                      border: locale === l.id ? '1px solid var(--accent, #0a84ff)' : '1px solid var(--border)',
                      background: locale === l.id ? 'rgba(10,132,255,0.12)' : 'transparent',
                      color: 'inherit',
                    }}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>

            {background ? (
              <div
                className={styles.row}
                style={{ marginBottom: 12, padding: 12, border: '1px dashed var(--border)', borderRadius: 10 }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) void background.setFromFile(f);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>背景</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      {background.meta.filename
                        ? `当前：${background.meta.filename}（${background.meta.kind === 'video' ? '视频' : '图片'}）`
                        : '把 jpg / png / mp4 拖到这里，各分区将变为毛玻璃'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <label style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)' }}>
                      选择文件
                      <input
                        type="file"
                        accept="image/*,video/*"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void background.setFromFile(f);
                          e.currentTarget.value = '';
                        }}
                      />
                    </label>
                    {background.meta.filename ? (
                      <>
                        <button type="button" onClick={() => background.setEnabled(!background.enabled)} style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>
                          {background.enabled ? '临时关闭' : '启用'}
                        </button>
                        <button type="button" onClick={() => void background.clear()} style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>
                          移除
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                {background.busy ? <p className={styles.hint}>处理中…</p> : null}
                {background.error ? <p className={styles.hint} style={{ color: 'var(--danger, #f85149)' }}>{background.error}</p> : null}
              </div>
            ) : null}
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={automationMode === true}
                onChange={(e) => {
                  const on = e.target.checked;
                  setAutomationMode(on);
                  // Turning automation off must also drop "allow all commands",
                  // otherwise destructive shell stays silently enabled.
                  setAllowAllCommands(on);
                }}
              />
              <span>
                自动化模式
                <em className={styles.warn}>（少请示：做完再汇报，不等你逐步确认）</em>
              </span>
            </label>
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={allowAllCommands === true}
                onChange={(e) => setAllowAllCommands(e.target.checked)}
              />
              <span>
                允许所有命令
                <em className={styles.warn}>
                  （这是真正止住「危险操作确认」和「写文件待批准」的开关 — 仅本地可信环境）
                </em>
              </span>
            </label>
            <p className={styles.hint}>
              项目规则：编辑工作区 <code>.she/rules.md</code>，新建/重开 Agent 会写入系统提示。
            </p>

            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <ShortcutEditor />
            </div>

            <div className={styles.actions}>
              <button type="button" onClick={save} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
              {msg ? <span className={styles.hint}>{msg}</span> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
