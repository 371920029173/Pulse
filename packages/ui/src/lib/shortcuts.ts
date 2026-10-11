import { t } from './i18n';
/**
 * Keyboard shortcut registry.
 *
 * Bindings are user-editable and persisted locally. The model is a flat list of
 * actions, each with a default chord, so the settings UI can render and rebind
 * them generically.
 *
 * `scope` decides who listens: `composer` bindings belong to the textarea,
 * `global` ones to the app, and `graph` ones to the knowledge-graph whiteboard
 * (active only while that panel is open). Two actions may share a chord across
 * scopes — Enter sends in the composer and opens a node on the whiteboard — and
 * `findConflicts` only reports clashes *within* a scope for that reason.
 */

export type ShortcutScope = 'composer' | 'global' | 'graph';

export type ShortcutActionId =
  | 'chat.send'
  | 'chat.interrupt'
  | 'chat.newline'
  | 'chat.interject'
  | 'app.palette'
  | 'app.focusChat'
  | 'app.toggleTheme'
  | 'mcp.toggle'
  | 'plugin.toggle'
  | 'plan.approveTop'
  | 'plan.rejectTop'
  | 'think.cycle'
  | 'think.up'
  | 'think.down'
  | 'graph.open'
  | 'graph.up'
  | 'graph.rename'
  | 'graph.copy'
  | 'graph.cut'
  | 'graph.paste'
  | 'graph.resetView';

export interface ShortcutAction {
  id: ShortcutActionId;
  group: string;
  label: string;
  /** Human description of what it does. */
  hint: string;
  /** Default chord, e.g. "Enter" or "Shift+Enter". */
  defaultChord: string;
  /** Contexts where the binding is active. */
  scope: ShortcutScope;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  // ── composer ──
  { id: 'chat.send', group: t('对话输入'), label: t('发送'), hint: t('把输入框内容发给智能体'), defaultChord: 'Enter', scope: 'composer' },
  { id: 'chat.interject', group: t('对话输入'), label: t('追加补充'), hint: t('不打断执行，追加信息'), defaultChord: 'Ctrl+Enter', scope: 'composer' },
  { id: 'chat.interrupt', group: t('对话输入'), label: t('打断执行'), hint: t('中止当前这一轮（含服务端）'), defaultChord: 'Shift+Backspace', scope: 'composer' },
  { id: 'chat.newline', group: t('对话输入'), label: t('换行'), hint: t('在输入框内换行而不发送'), defaultChord: 'Shift+Enter', scope: 'composer' },

  // ── thinking ──
  { id: 'think.cycle', group: t('思考强度'), label: t('循环切换'), hint: t('在四档之间循环'), defaultChord: 'Ctrl+T', scope: 'global' },
  { id: 'think.up', group: t('思考强度'), label: t('提高一档'), hint: t('升到更高强度'), defaultChord: 'Ctrl+Shift+ArrowUp', scope: 'global' },
  { id: 'think.down', group: t('思考强度'), label: t('降低一档'), hint: t('降到更低强度'), defaultChord: 'Ctrl+Shift+ArrowDown', scope: 'global' },

  // ── approvals ──
  { id: 'plan.approveTop', group: t('请求批准'), label: t('批准最上面一条'), hint: t('通过待确认的补丁 / 操作'), defaultChord: 'Ctrl+Y', scope: 'global' },
  { id: 'plan.rejectTop', group: t('请求批准'), label: t('驳回最上面一条'), hint: t('拒绝待确认的补丁 / 操作'), defaultChord: 'Ctrl+N', scope: 'global' },

  // ── toggles ──
  { id: 'mcp.toggle', group: t('开关'), label: t('启用 / 停用 MCP'), hint: t('切换 MCP 服务总开关'), defaultChord: 'Ctrl+Alt+M', scope: 'global' },
  { id: 'plugin.toggle', group: t('开关'), label: t('启用 / 停用插件'), hint: t('切换插件扩展总开关'), defaultChord: 'Ctrl+Alt+P', scope: 'global' },

  // ── app ──
  { id: 'app.palette', group: t('应用'), label: t('命令面板'), hint: t('打开命令面板'), defaultChord: 'Ctrl+K', scope: 'global' },
  { id: 'app.focusChat', group: t('应用'), label: t('专注对话'), hint: t('隐藏两侧面板放大对话区'), defaultChord: 'Ctrl+\\', scope: 'global' },
  { id: 'app.toggleTheme', group: t('应用'), label: t('切换明暗主题'), hint: t('在深色 / 浅色之间切换'), defaultChord: 'Ctrl+Shift+L', scope: 'global' },

  // ── 知识图谱白板（用户要的"像 Windows 一样"：Ctrl+C/X/V + F2 改名 + Enter 打开）──
  { id: 'graph.open', group: t('知识图谱'), label: t('打开 / 进入'), hint: t('进入选中的组，或打开选中的记忆'), defaultChord: 'Enter', scope: 'graph' },
  { id: 'graph.up', group: t('知识图谱'), label: t('上一级'), hint: t('回到父组（Backspace，和资源管理器一致）'), defaultChord: 'Backspace', scope: 'graph' },
  { id: 'graph.rename', group: t('知识图谱'), label: t('改名'), hint: t('给选中的组改名'), defaultChord: 'F2', scope: 'graph' },
  { id: 'graph.copy', group: t('知识图谱'), label: t('复制'), hint: t('复制选中的组（到待同步序列里粘贴）'), defaultChord: 'Ctrl+C', scope: 'graph' },
  { id: 'graph.cut', group: t('知识图谱'), label: t('剪切'), hint: t('剪切选中的组'), defaultChord: 'Ctrl+X', scope: 'graph' },
  { id: 'graph.paste', group: t('知识图谱'), label: t('粘贴'), hint: t('把剪贴板里的组粘贴到当前组下'), defaultChord: 'Ctrl+V', scope: 'graph' },
  { id: 'graph.resetView', group: t('知识图谱'), label: t('重置视图'), hint: t('缩放与平移回到初始位置'), defaultChord: 'Ctrl+0', scope: 'graph' },
];

const STORAGE_KEY = 'she.shortcuts';

export type ShortcutMap = Partial<Record<ShortcutActionId, string>>;

function normalize(chord: string): string {
  return chord
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const l = p.toLowerCase();
      if (l === 'ctrl' || l === 'control') return 'Ctrl';
      if (l === 'meta' || l === 'cmd' || l === 'command') return 'Meta';
      if (l === 'alt' || l === 'option') return 'Alt';
      if (l === 'shift') return 'Shift';
      if (l === 'backspace') return 'Backspace';
      if (l === 'enter' || l === 'return') return 'Enter';
      if (l === 'escape' || l === 'esc') return 'Escape';
      if (l === 'space' || l === 'spacebar') return 'Space';
      if (l === 'arrowup') return 'ArrowUp';
      if (l === 'arrowdown') return 'ArrowDown';
      if (l === 'arrowleft') return 'ArrowLeft';
      if (l === 'arrowright') return 'ArrowRight';
      return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    })
    .sort((a, b) => {
      const order = ['Ctrl', 'Meta', 'Alt', 'Shift'];
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    })
    .join('+');
}

/** Build a chord string from a keyboard event. Returns '' when only modifiers. */
export function chordFromEvent(e: KeyboardEvent | React.KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const key = e.key;
  if (key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift') return '';

  let name = key;
  if (key === ' ') name = 'Space';
  else if (key === 'Backspace') name = 'Backspace';
  else if (key === 'Enter') name = 'Enter';
  else if (key === 'Escape') name = 'Escape';
  else if (key.startsWith('Arrow')) name = key;
  else if (key.length === 1) name = key.toUpperCase();

  parts.push(name);
  return normalize(parts.join('+'));
}

export function defaultShortcuts(): ShortcutMap {
  const map: ShortcutMap = {};
  for (const a of SHORTCUT_ACTIONS) map[a.id] = a.defaultChord;
  return map;
}

export function loadShortcuts(): ShortcutMap {
  const base = defaultShortcuts();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as ShortcutMap;
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === 'string' && v.trim()) base[k as ShortcutActionId] = normalize(v);
    }
  } catch { /* ignore */ }
  return base;
}

export function saveShortcuts(map: ShortcutMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function resetShortcuts(): ShortcutMap {
  const base = defaultShortcuts();
  saveShortcuts(base);
  return base;
}

/** Does this event match the chord? */
export function matchesChord(e: KeyboardEvent | React.KeyboardEvent, chord: string): boolean {
  if (!chord) return false;
  return chordFromEvent(e) === normalize(chord);
}

/** Find an action bound to the given chord, optionally limited to a scope. */
export function actionForChord(
  map: ShortcutMap,
  chord: string,
  scope: ShortcutScope,
): ShortcutAction | null {
  const target = normalize(chord);
  for (const a of SHORTCUT_ACTIONS) {
    if (a.scope !== scope) continue;
    const bound = map[a.id] ?? a.defaultChord;
    if (normalize(bound) === target) return a;
  }
  return null;
}

/** Detect collisions across the whole map. */
export function findConflicts(map: ShortcutMap): ShortcutActionId[][] {
  const byChord = new Map<string, ShortcutActionId[]>();
  for (const a of SHORTCUT_ACTIONS) {
    const chord = normalize(map[a.id] ?? a.defaultChord);
    if (!chord) continue;
    // Only same-scope collisions matter.
    const key = `${a.scope}::${chord}`;
    const list = byChord.get(key) ?? [];
    list.push(a.id);
    byChord.set(key, list);
  }
  return [...byChord.values()].filter((l) => l.length > 1);
}
