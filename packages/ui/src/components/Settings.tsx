import { useEffect, useRef, useState } from 'react';
import { fetchJSON, putSettings } from '../lib/api';
import { SKILL_PROFILES, isSkillProfile, type SkillProfileId } from '../lib/skills';
import { LOCALES, t } from '../lib/i18n';
import type { Locale } from '../lib/i18n';
import { ShortcutEditor } from './ShortcutEditor';
import { AuthSettings } from './AuthSettings';
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
    /** 「允许工作区外命令」+ 档位。老服务端没有这个字段。 */
    outsideWorkspace?: { allow?: boolean; policy?: 'all' | 'readonly' | 'deny' };
    /**
     * 自动化模式与沙箱姿态之间的张力（服务端算好回传，见 `sandboxPostureNotice`）。
     * `null`/缺省 = 没有张力，界面上不出现任何东西。
     */
    notice?: string | null;
  };
  /**
   * 真隔离那一格。`notice` 与 `sandbox.notice` 同源同理：由服务端决定要不要说，界面只显示。
   *
   * `bypassed` ＝ 勾选 + 「所有」这一档把隔离让开了（命令直接在主机上跑）。老服务端没有这个字段，
   * 于是 `undefined` —— 不能当 `false` 用来说"隔离生效中"，这里只读 `notice`，不自己下结论。
   */
  isolation?: {
    mode?: 'off' | 'auto' | 'wsl';
    available?: boolean;
    bypassed?: boolean;
    notice?: string | null;
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
   * The panel used to be a single ~3000px form, and the shared-knowledge-base controls sat about a
   * thousand pixels down it — far enough that a user looking for them concluded the feature did
   * not exist. It now has a sidebar, so a caller that opens Settings *for* a specific purpose
   * selects the section instead of scrolling to a pixel offset.
   */
  focusSection?: string | null;
}

/**
 * 侧边栏分区。
 *
 * 分成这几块而不是别的分法，依据是"改完之后要做什么"：换模型要重启会话，改工作区要重启服务端，
 * 权限改完立即生效。同一块里的设置共享这个后果，跨块的不共享 —— 这一点直接决定哪些设置可以放在
 * 一起保存。
 */
const SECTIONS: { id: SectionId; label: string; hint: string }[] = [
  { id: 'llm', label: '模型与接入', hint: '提供商、模型、密钥、备用线路' },
  { id: 'workspace', label: '工作区与知识库', hint: '目录、技能档、共享知识库' },
  { id: 'sandbox', label: '沙箱与权限', hint: '命令审批、工作区边界' },
  { id: 'appearance', label: '外观与快捷键', hint: '主题、语言、按键' },
  { id: 'background', label: '背景', hint: '图片 / 视频背景' },
];

type SectionId = 'llm' | 'workspace' | 'sandbox' | 'appearance' | 'background';

/**
 * 老调用方传进来的锚点 → 新分区。
 *
 * `focusSection` 是上一版"滚到某个像素位置"的接口，外面还有调用方在传它。保留映射而不是删掉参数，
 * 是为了让这次改动不牵连调用方 —— 但它们指向的已经是分区，不再是滚动位置。
 */
function sectionFor(focus: string | null | undefined): SectionId | null {
  if (!focus) return null;
  if (focus === 'kb-share' || focus === 'kb' || focus === 'workspace') return 'workspace';
  if (focus === 'sandbox' || focus === 'perm' || focus === 'permissions') return 'sandbox';
  if (focus === 'llm' || focus === 'model') return 'llm';
  if (focus === 'theme' || focus === 'appearance' || focus === 'shortcuts') return 'appearance';
  if (focus === 'background') return 'background';
  return null;
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

  const [section, setSection] = useState<SectionId>(() => sectionFor(focusSection) ?? 'llm');

  /**
   * 调用方指定了分区时切过去，并把它滚进视野。
   *
   * 两件事都要做：切换分区只是让它**存在**，而分区本身可能比面板高（工作区那一块就是），需要的人
   * 想找的东西仍可能在折线以下。`center` 而不是 `start`：这一块是一组输入加按钮，顶边对齐会把按钮
   * 推到面板底部之外。
   */
  useEffect(() => {
    const target = sectionFor(focusSection);
    if (!target) return;
    setSection(target);
    if (target !== 'workspace') return;
    const el = kbShareRef.current;
    if (!el) return;
    // One frame, so the section has a laid-out position to scroll to.
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
  /**
   * 工作区边界。同样用 `null` 表示"还没读到"，不是 `false`。
   *
   * 这两个值决定沙箱放行还是拦，默认成 false 会让"打开设置就保存"把用户的全放行改回逐条审批 ——
   * 上一版 `allowAllCommands` 踩过的坑，这里不能再踩一次。
   */
  const [outsideAllow, setOutsideAllow] = useState<boolean | null>(null);
  const [outsidePolicy, setOutsidePolicy] = useState<'all' | 'readonly' | 'deny'>('readonly');
  /**
   * 服务端算好的"自动化模式 vs 沙箱姿态"提示。空 = 不显示。
   *
   * 由服务端给，不是界面自己推：判据（哪种姿态会在无人值守时真的停住）只该有一份，两处写就是两处
   * 会不一致。第四轮评测 2a 的另一半就是这条 —— 姿态以前被静默改掉，现在改成"不改，但说出来"。
   */
  const [postureNotice, setPostureNotice] = useState<string | null>(null);
  /**
   * 真隔离那一格的情况（服务端算好回传的 `isolation`）。
   *
   * 界面原来只读 `sandbox.notice`，把这一个字段漏掉了，于是"隔离开着没有 / 命令在哪跑"在设置页里
   * 完全看不见 —— 用户唯一的线索是命令莫名其妙地失败（最大授权下 `ver` 返回 127 就是个例子）。
   * 判据（哪个档位让开了隔离）仍然只有服务端一份，这里只负责显示它给的那句话。
   */
  const [isolationNotice, setIsolationNotice] = useState<string | null>(null);
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
        /*
         * 老服务端不返回 `outsideWorkspace`。这时候从 `allowAllCommands` 反推一个能对得上的档位，
         * 而不是留一个空白控件 —— 界面显示的必须是沙箱此刻真正在用的那套规则。
         */
        const ow = d.sandbox?.outsideWorkspace;
        setOutsideAllow(typeof ow?.allow === 'boolean' ? ow.allow : true);
        setOutsidePolicy(
          ow?.policy === 'all' || ow?.policy === 'readonly' || ow?.policy === 'deny'
            ? ow.policy
            : (d.sandbox?.allowAllCommands ? 'all' : 'readonly'),
        );
        setPostureNotice(typeof d.sandbox?.notice === 'string' && d.sandbox.notice ? d.sandbox.notice : null);
        setIsolationNotice(
          typeof d.isolation?.notice === 'string' && d.isolation.notice ? d.isolation.notice : null,
        );
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
    setMsg(t('已套用预设：{label}', { label: p.label }));
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
      setMsg(t('请填写要发布到的共享路径（例如 ./shared/kb.sqlite，或局域网共享盘的绝对路径）'));
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
      if (outsideAllow !== null) body.allowOutsideWorkspace = outsideAllow;
      if (outsideAllow !== null) body.outsideWorkspacePolicy = outsidePolicy;
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (fallbackApiKey.trim()) body.fallbackApiKey = fallbackApiKey.trim();
      const res = await putSettings<{ ok: boolean; llm: { hasKey: boolean }; restartRequired?: boolean }>(body);
      const saved = res.llm.hasKey ? t('已保存（含 API key）') : t('已保存');
      setMsg(res.restartRequired ? t('{saved}；工作区 / 知识库路径已变更，需重启服务端后生效', { saved }) : saved);
      setApiKey('');
      const d = await fetchJSON<SettingsData>('/api/settings');
      setData(d);
      setAllowAllCommands(Boolean(d.sandbox?.allowAllCommands));
      setAutomationMode(d.automationMode !== false);
      setPostureNotice(typeof d.sandbox?.notice === 'string' && d.sandbox.notice ? d.sandbox.notice : null);
      setIsolationNotice(
        typeof d.isolation?.notice === 'string' && d.isolation.notice ? d.isolation.notice : null,
      );
      setKbDbPath(d.kb?.dbPath || '');
      setWorkspaceRoot(d.workspace.root);
    } catch (e: any) {
      setMsg(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * 当前四档落在哪一档，用来画"此刻的实际规则"。
   *
   * 「所有」这一档现在是**两件事**：不问人，而且不在隔离里跑（命令直接在主机上）。第二句必须写出来
   * —— 用户在这一档下撞到的第一个意外就是"Windows 命令跑不了"（最大授权 + auto 时 `ver` 返回 127），
   * 而界面在此之前一个字都没说。措辞与 `isolationNotice` 同源，不另写一套说法。
   */
  let effectiveRule: string;
  if (outsideAllow === false) {
    effectiveRule = t('除阅读类命令外，一律需要你点确认');
  } else if (outsidePolicy === 'all') {
    effectiveRule = t('一切命令直接放行、不再询问，且直接在主机上运行（不在真隔离里，也不是 WSL）');
  } else if (outsidePolicy === 'deny') {
    effectiveRule = t('工作区内自由执行；工作区外的写操作直接拒绝');
  } else {
    effectiveRule = t('工作区内自由执行；工作区外的写操作需要你点确认');
  }

  function renderSection() {
    if (!data) return null;
    if (section === 'llm') {
      return (
        <>
          <div className={styles.presets}>
            <span className={styles.presetsLabel}>{t('快速预设')}</span>
            <div className={styles.presetRow}>
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className={styles.presetBtn} onClick={() => applyPreset(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <label>
            <span>{t('提供商')}</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
              <option value="openai">{t('OpenAI 兼容')}</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            <span>{t('模型')}</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label>
            <span>{t('接口地址')}</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label>
            <span>{t('API 密钥')} {data.llm.hasKey ? t('（已配置）') : t('（未配置）')}</span>
            <input
              type="password"
              placeholder={data.llm.hasKey ? t('留空则不改') : 'sk-...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <p className={styles.hint}>
            {t('思考强度已移到对话框发送键旁边，可随时拖动调节。主流模型特点见 skill 档。')}
          </p>
          <label>
            <span>{t('备用接口地址（选填）')}</span>
            <input value={fallbackBaseUrl} onChange={(e) => setFallbackBaseUrl(e.target.value)} placeholder={t('主接口失败时回退')} />
          </label>
          <label>
            <span>{t('备用模型')}</span>
            <input value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} />
          </label>
          <label>
            <span>{t('备用提供商')}</span>
            <select value={fallbackProvider} onChange={(e) => setFallbackProvider(e.target.value as any)}>
              <option value="openai">{t('OpenAI 兼容')}</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            <span>{t('备用 API 密钥')} {data.llm.fallback?.hasKey ? t('（已配置）') : t('（未配置）')}</span>
            <input
              type="password"
              placeholder={data.llm.fallback?.hasKey ? t('留空则不改') : t('选填')}
              value={fallbackApiKey}
              onChange={(e) => setFallbackApiKey(e.target.value)}
              autoComplete="off"
            />
          </label>
        </>
      );
    }

    if (section === 'workspace') {
      return (
        <>
          <label>
            <span>{t('工作区 root')}</span>
            <input value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
          </label>
          <p className={styles.hint}>
            {t('改动工作区目录需要重启服务端才生效。')}
          </p>
          <label className={styles.field}>
            <span>{t('技能档位')}</span>
            <select
              value={skillProfile}
              onChange={(e) => { if (isSkillProfile(e.target.value)) setSkillProfile(e.target.value); }}
            >
              {/* Generated from the single source so this list cannot go stale
                  again — a hand-written copy here was missing 「通用」. */}
              {SKILL_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>{p.label}{p.id === 'dev' ? t('（默认）') : ''}</option>
              ))}
            </select>
          </label>
          <p className={styles.hint}>
            {t('加载 .she/skills/_common + 对应档目录。自定义 skill 放到 .she/skills/custom/*.md。侧栏状态栏也可快速切换。')}
          </p>
          <label className={styles.field}>
            <span>{t('知识库路径（本工作区或共享）')}</span>
            <input
              value={kbDbPath}
              onChange={(e) => setKbDbPath(e.target.value)}
              placeholder={t('留空则用 <工作区>/.she/kb.sqlite')}
              spellCheck={false}
            />
          </label>
          <p className={styles.hint}>
            {t('当前模式：')}<strong>{kbMode || '…'}</strong>
            {kbMode === 'shared' ? t('（多工作区可挂同一 sqlite，改完即重挂，一般不用整服重启）') : ''}
            {kbMode === 'local' ? t('（仅本工作区 .she/kb.sqlite）') : ''}
            {kbMode === 'env' ? t('（由 SHE_KB_PATH 指定，优先于 kb-link）') : ''}
            {t('。保存设置仍会写入路径；要用「贯穿」请用下面的共享操作。')}
          </p>
          <div id="settings-kb-share" ref={kbShareRef} className={styles.card}>
            <span className={styles.cardTitle}>{t('多工作区共享知识库')}</span>
            <input
              value={sharePath}
              onChange={(e) => setSharePath(e.target.value)}
              placeholder={t('共享 sqlite 路径，例如 ./shared/kb.sqlite（也可填局域网共享盘）')}
              spellCheck={false}
            />
            <div className={styles.btnRow}>
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
            <div className={styles.btnRow}>
              <button type="button" className="she-btn she-btn--sm" disabled={kbBusy} onClick={() => void mergeOtherKb()}>
                {t('合并另一库')}
              </button>
            </div>
            <p className={styles.hint}>
              {t('推荐流程：工作区 A「发布到共享路径」→ 工作区 B「挂到此共享库」→ 两边贯穿同一套知识。')}
              {t('若两套库都有内容，用「合并另一库」拼成一份再挂载。')}
            </p>
          </div>
          <p className={styles.hint}>
            {t('项目规则：编辑工作区 .she/rules.md，新建/重开 Agent 会写入系统提示。')}
          </p>
        </>
      );
    }

    if (section === 'sandbox') {
      return (
        <>
          <p className={styles.hint}>
            {t('这里决定 Agent 执行命令时会不会先来问你。改完点保存，立即生效，不用重启。')}
          </p>

          {/* API 认证：默认开放，想关就能关 —— 入口只有 .env 与文档时，这件事等于不存在。 */}
          <AuthSettings />
          {/*
            自动化模式与沙箱姿态的张力。服务端只在**真的会停住无人值守那一轮**时才给这段话，所以
            它出现就意味着"你勾了自动化，但它仍会在某些操作上停下来等确认" —— 这件事以前是被静默
            处理掉的（打开自动化顺手把边界放宽），现在是说出来让人自己决定要不要放宽。
          */}
          {postureNotice && (
            <p className={styles.warn} role="status">{postureNotice}</p>
          )}
          {/*
            真隔离那一格。与上面那条同源：由服务端决定要不要说。
            它最常见的两个理由是「这台机器能用真隔离但现在是关的」和「你选了『所有』，隔离被这一档让开
            了」—— 后者是这一节最该被看见的一句话，因为它在界面上曾经完全不可见（用户的第一手线索是
            命令莫名其妙地失败）。
          */}
          {isolationNotice && (
            <p className={styles.warn} role="status">{isolationNotice}</p>
          )}
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={automationMode === true}
              onChange={(e) => {
                const on = e.target.checked;
                setAutomationMode(on);
                // 关掉自动化时把「所有」降回「只读」，否则破坏性命令会留在静默放行状态。
                if (!on && outsidePolicy === 'all') setOutsidePolicy('readonly');
              }}
            />
            <span>
              {t('自动化模式')}
              <em className={styles.warn}>{t('（少请示：做完再汇报，不等你逐步确认）')}</em>
            </span>
          </label>

          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={outsideAllow === true}
              onChange={(e) => setOutsideAllow(e.target.checked)}
            />
            <span>
              {t('允许工作区外命令')}
              <em className={styles.warn}>
                {t('（不勾选：除了阅读类命令，工作区内外所有操作都要你确认）')}
              </em>
            </span>
          </label>

          {/*
            档位只在勾选后才有意义 —— 不勾选时规则是"除阅读类外一律确认"，没有"外面怎么处理"这回事。
            置灰而不是隐藏，是为了让"勾上之后还有更细的选择"这件事在没勾的时候也看得见。
          */}
          <div className={`${styles.policyList} ${outsideAllow === true ? '' : styles.policyDisabled}`}>
            {([
              {
                id: 'readonly' as const,
                title: t('只读（推荐）'),
                desc: t('工作区内随便跑；要动工作区外的文件时先问你一声。读文件不受限制。'),
              },
              {
                id: 'all' as const,
                title: t('所有'),
                desc: t('什么都不问，包括工作区外；命令直接在主机上运行（真隔离让开）。仅限你完全信任的本地环境。'),
              },
              {
                id: 'deny' as const,
                title: t('拒绝'),
                desc: t('工作区外一律不许，也不允许你临时批准。最严的一档。'),
              },
            ]).map((opt) => (
              <label
                key={opt.id}
                className={`${styles.policyItem} ${outsidePolicy === opt.id ? styles.policyItemActive : ''}`}
              >
                <input
                  type="radio"
                  name="outside-policy"
                  checked={outsidePolicy === opt.id}
                  disabled={outsideAllow !== true}
                  onChange={() => setOutsidePolicy(opt.id)}
                />
                <span>
                  <span className={styles.policyTitle}>{opt.title}</span>
                  <span className={styles.policyDesc}>{opt.desc}</span>
                </span>
              </label>
            ))}
          </div>

          <div className={styles.callout}>
            <strong>{t('现在的实际规则')}</strong>
            <span>{effectiveRule}</span>
            <span className={styles.calloutFoot}>
              {t('「阅读类」指 cat / type / dir / grep 这类只看不写的命令，它们在哪个目录下执行都不需要确认。')}
            </span>
          </div>
        </>
      );
    }

    if (section === 'appearance') {
      return (
        <>
          <div className={styles.row}>
            <div>
              <div className={styles.rowTitle}>{t('外观主题')}</div>
              <div className={styles.rowSub}>{t('对话区可用拖拽把手调节侧栏 / 轨迹宽度')}</div>
            </div>
            <button type="button" className={styles.toggleBtn} onClick={onToggleTheme}>
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
          <div className={styles.row}>
            <div>
              <div className={styles.rowTitle}>{t('界面语言')}</div>
              <div className={styles.rowSub}>{t('界面文案语言，立刻生效')}</div>
            </div>
            <div className={styles.btnRow}>
              {LOCALES.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`${styles.localeBtn} ${locale === l.id ? styles.localeBtnActive : ''}`}
                  onClick={() => onLocale(l.id)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.card}>
            <ShortcutEditor />
          </div>
        </>
      );
    }

    return (
      <>
        {background ? (
          <div
            className={styles.dropZone}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void background.setFromFile(f);
            }}
          >
            <div className={styles.row}>
              <div>
                <div className={styles.rowTitle}>{t('背景')}</div>
                <div className={styles.rowSub}>
                  {background.meta.filename
                    ? t('当前：{name}（{kind}）', {
                      name: background.meta.filename,
                      kind: background.meta.kind === 'video' ? t('视频') : t('图片'),
                    })
                    : t('把 jpg / png / mp4 拖到这里，各分区将变为毛玻璃')}
                </div>
              </div>
              <div className={styles.btnRow}>
                <label className={styles.filePick}>
                  {t('选择文件')}
                  <input
                    type="file"
                    accept="image/*,video/*"
                    className={styles.fileInput}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void background.setFromFile(f);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                {background.meta.filename ? (
                  <>
                    <button type="button" className={styles.toggleBtn} onClick={() => background.setEnabled(!background.enabled)}>
                      {background.enabled ? t('临时关闭') : t('启用')}
                    </button>
                    <button type="button" className={styles.toggleBtn} onClick={() => void background.clear()}>
                      {t('移除')}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            {background.busy ? <p className={styles.hint}>{t('处理中…')}</p> : null}
            {background.error ? <p className={styles.error}>{background.error}</p> : null}
          </div>
        ) : (
          <p className={styles.hint}>{t('背景功能在当前界面不可用。')}</p>
        )}
      </>
    );
  }

  return (
    <div className={styles.backdrop} data-surface="backdrop" onClick={onClose}>
      <div className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <h2>{t('设置')}</h2>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </header>
        {!data ? (
          <p className={styles.loading}>{msg || t('加载中…')}</p>
        ) : (
          <>
            <div className={styles.shell}>
              {/*
                分区导航。原来是一整条平铺表单，用户要在一千多像素之后才能找到权限开关，找到之前
                只能认为它不存在 —— 侧栏把"这里有五件事"先说出来，再让他挑。
              */}
              <nav className={styles.nav}>
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`${styles.navItem} ${section === s.id ? styles.navItemActive : ''}`}
                    onClick={() => setSection(s.id)}
                    title={t(s.hint)}
                  >
                    {t(s.label)}
                  </button>
                ))}
              </nav>
              <div className={styles.content}>
                <div className={styles.form}>{renderSection()}</div>
              </div>
            </div>
            <footer className={styles.footer}>
              <button type="button" className={styles.saveBtn} onClick={save} disabled={saving}>
                {saving ? t('保存中…') : t('保存')}
              </button>
              {msg ? <span className={styles.hint}>{msg}</span> : null}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
