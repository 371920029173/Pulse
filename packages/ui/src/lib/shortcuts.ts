/**
 * Keyboard shortcut registry.
 *
 * Bindings are user-editable and persisted locally. The model is a flat list of
 * actions, each with a default chord, so the settings UI can render and rebind
 * them generically.
 */

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
  | 'think.down';

export interface ShortcutAction {
  id: ShortcutActionId;
  group: string;
  label: string;
  /** Human description of what it does. */
  hint: string;
  /** Default chord, e.g. "Enter" or "Shift+Enter". */
  defaultChord: string;
  /** Contexts where the binding is active. */
  scope: 'composer' | 'global';
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  // ── composer ──
  { id: 'chat.send', group: '对话输入', label: '发送', hint: '把输入框内容发给智能体', defaultChord: 'Enter', scope: 'composer' },
  { id: 'chat.interject', group: '对话输入', label: '追加补充', hint: '不打断执行，追加信息', defaultChord: 'Ctrl+Enter', scope: 'composer' },
  { id: 'chat.interrupt', group: '对话输入', label: '打断执行', hint: '中止当前这一轮（含服务端）', defaultChord: 'Shift+Backspace', scope: 'composer' },
  { id: 'chat.newline', group: '对话输入', label: '换行', hint: '在输入框内换行而不发送', defaultChord: 'Shift+Enter', scope: 'composer' },

  // ── thinking ──
  { id: 'think.cycle', group: '思考强度', label: '循环切换', hint: '在四档之间循环', defaultChord: 'Ctrl+T', scope: 'global' },
  { id: 'think.up', group: '思考强度', label: '提高一档', hint: '升到更高强度', defaultChord: 'Ctrl+Shift+ArrowUp', scope: 'global' },
  { id: 'think.down', group: '思考强度', label: '降低一档', hint: '降到更低强度', defaultChord: 'Ctrl+Shift+ArrowDown', scope: 'global' },

  // ── approvals ──
  { id: 'plan.approveTop', group: '请求批准', label: '批准最上面一条', hint: '通过待确认的补丁 / 操作', defaultChord: 'Ctrl+Y', scope: 'global' },
  { id: 'plan.rejectTop', group: '请求批准', label: '驳回最上面一条', hint: '拒绝待确认的补丁 / 操作', defaultChord: 'Ctrl+N', scope: 'global' },

  // ── toggles ──
  { id: 'mcp.toggle', group: '开关', label: '启用 / 停用 MCP', hint: '切换 MCP 服务总开关', defaultChord: 'Ctrl+Alt+M', scope: 'global' },
  { id: 'plugin.toggle', group: '开关', label: '启用 / 停用插件', hint: '切换插件扩展总开关', defaultChord: 'Ctrl+Alt+P', scope: 'global' },

  // ── app ──
  { id: 'app.palette', group: '应用', label: '命令面板', hint: '打开命令面板', defaultChord: 'Ctrl+K', scope: 'global' },
  { id: 'app.focusChat', group: '应用', label: '专注对话', hint: '隐藏两侧面板放大对话区', defaultChord: 'Ctrl+\\', scope: 'global' },
  { id: 'app.toggleTheme', group: '应用', label: '切换明暗主题', hint: '在深色 / 浅色之间切换', defaultChord: 'Ctrl+Shift+L', scope: 'global' },
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
  scope: 'composer' | 'global',
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
