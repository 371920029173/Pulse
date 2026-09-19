import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SHORTCUT_ACTIONS,
  loadShortcuts,
  saveShortcuts,
  resetShortcuts,
  chordFromEvent,
  findConflicts,
  type ShortcutActionId,
  type ShortcutMap,
} from '../lib/shortcuts';
import styles from '../styles/Shortcuts.module.css';

/** Tell the rest of the app the bindings changed. */
function broadcast(): void {
  window.dispatchEvent(new Event('she:shortcuts-changed'));
}

/**
 * Shortcut editor.
 *
 * Click a binding, press the new chord. Editing stops propagation so pressing
 * the chord does not also trigger the app's own handler.
 */
export function ShortcutEditor() {
  const [map, setMap] = useState<ShortcutMap>(() => loadShortcuts());
  const [capturing, setCapturing] = useState<ShortcutActionId | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setCapturing(null);
        setMsg('已取消');
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // modifiers only, keep waiting
      setMap((prev) => {
        const next = { ...prev, [capturing]: chord };
        saveShortcuts(next);
        broadcast();
        return next;
      });
      setCapturing(null);
      setMsg(`已绑定 ${chord}`);
    };
    // capture phase so we win over the app's own listeners
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  const conflicts = useMemo(() => findConflicts(map), [map]);
  const conflictSet = useMemo(() => new Set(conflicts.flat()), [conflicts]);

  const groups = useMemo(() => {
    const g = new Map<string, typeof SHORTCUT_ACTIONS>();
    for (const a of SHORTCUT_ACTIONS) {
      const list = g.get(a.group) ?? [];
      list.push(a);
      g.set(a.group, list);
    }
    return [...g.entries()];
  }, []);

  const resetAll = useCallback(() => {
    setMap(resetShortcuts());
    broadcast();
    setMsg('已恢复默认');
  }, []);

  const clearOne = useCallback((id: ShortcutActionId) => {
    setMap((prev) => {
      const next = { ...prev, [id]: '' };
      saveShortcuts(next);
      broadcast();
      return next;
    });
    setMsg('已清空该绑定');
  }, []);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <div className={styles.headTitle}>快捷键</div>
          <div className={styles.headHint}>
            点一下右侧的按键框，然后按下你想用的组合。Esc 取消，Delete 清空。
          </div>
        </div>
        <button type="button" className={styles.resetBtn} onClick={resetAll}>恢复默认</button>
      </div>

      {conflicts.length > 0 ? (
        <div className={styles.conflict}>
          有 {conflicts.length} 组快捷键冲突，冲突项已标红。
        </div>
      ) : null}

      {groups.map(([group, actions]) => (
        <div key={group} className={styles.group}>
          <div className={styles.groupLabel}>{group}</div>
          {actions.map((a) => {
            const chord = map[a.id] ?? a.defaultChord;
            const isCapturing = capturing === a.id;
            const conflicted = conflictSet.has(a.id);
            return (
              <div key={a.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <div className={styles.rowLabel}>{a.label}</div>
                  <div className={styles.rowHint}>{a.hint}</div>
                </div>
                <div className={styles.rowScope}>
                  {a.scope === 'composer' ? '输入框' : '全局'}
                </div>
                <button
                  type="button"
                  className={`${styles.chord} ${isCapturing ? styles.chordCapturing : ''} ${conflicted ? styles.chordConflict : ''} ${!chord ? styles.chordEmpty : ''}`}
                  onClick={() => { setCapturing(a.id); setMsg(''); }}
                  onKeyDown={(e) => {
                    if (isCapturing && (e.key === 'Delete' || e.key === 'Backspace')) {
                      e.preventDefault();
                      clearOne(a.id);
                      setCapturing(null);
                    }
                  }}
                  title={conflicted ? '与其他快捷键冲突' : '点击后按下新的组合键'}
                >
                  {isCapturing ? '按下按键…' : (chord || '未绑定')}
                </button>
              </div>
            );
          })}
        </div>
      ))}

      {msg ? <div className={styles.msg}>{msg}</div> : null}
    </div>
  );
}
