import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CssIssue, type UserThemeApi } from '../hooks/useUserTheme';
import { scopeCss, PREVIEW_SCOPE } from '../lib/scopeCss';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { t } from '../lib/i18n';
import styles from '../styles/ThemeStudio.module.css';

/**
 * Custom stylesheet editor.
 *
 * Two decisions shape this component:
 *
 * 1. **The preview is scoped, not applied.** The obvious implementation — apply the draft
 *    to the document — means a draft containing `html { display: none }` hides the editor,
 *    leaving no way to undo it from inside the app. Scoping the draft to a preview box
 *    makes that impossible: the sample goes blank, the editor stays, and the user sees what
 *    their rule does. See `lib/scopeCss.ts`.
 *
 * 2. **Saving is separate from previewing**, so nothing reaches the real document until it
 *    has been looked at.
 *
 * The theme state comes from the caller rather than a local `useUserTheme()` call. It used to
 * own the hook, and that was a real defect: the hook is what injects the saved stylesheet, so
 * a saved theme only took effect while this panel happened to be open — and the `?theme=off`
 * escape hatch silently did nothing on a normal load, because nothing had been applied to
 * escape from. The hook now runs at the app root.
 *
 * The escape instructions are stated in the UI rather than only in docs, because the
 * situation they exist for is one where the user cannot read the docs.
 */
export function ThemeStudio({ onClose, userTheme }: {
  onClose: () => void;
  userTheme: UserThemeApi;
}) {
  const { theme, loading, error, save, disable, enable, reset, revert, validate } = userTheme;
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issues, setIssues] = useState<CssIssue[]>([]);
  const [showPreview, setShowPreview] = useState(true);
  const [showReference, setShowReference] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEscapeToClose(onClose);

  // Seed the editor from the server once, and only while untouched — a background refresh
  // must not overwrite what the user is typing.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || loading) return;
    setDraft(theme.css);
    setIssues(theme.issues);
    seeded.current = true;
  }, [loading, theme.css, theme.issues]);

  /*
   * Live validation.
   *
   * Without this the user types `html { display: none }`, watches the sample go blank, and
   * gets no explanation until they press Save — the preview tells them *something* is wrong
   * but not what or where. The check runs against the same server-side validator that guards
   * the save, so what it reports here is exactly what would block it.
   *
   * Debounced, and tagged with the draft it describes: a response that arrives after the user
   * has typed on would otherwise show stale advice for text that no longer exists.
   */
  const [liveCheck, setLiveCheck] = useState<{ forText: string; issues: CssIssue[] } | null>(null);
  useEffect(() => {
    if (!seeded.current) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void validate(draft).then((r) => {
        if (cancelled || !r) return;
        setLiveCheck({ forText: draft, issues: r.issues });
      });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [draft, validate]);

  /** Issues for the text currently in the editor: live results while they are fresh, else
   *  whatever the last save reported. */
  const shownIssues = liveCheck && liveCheck.forText === draft ? liveCheck.issues : issues;

  const scopedPreview = useMemo(() => {
    try {
      return scopeCss(draft);
    } catch {
      // A draft mid-typing can be malformed; the preview simply shows the last good state.
      return '';
    }
  }, [draft]);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const onSave = useCallback((force: boolean) => run('save', async () => {
    const r = await save(draft, { force });
    setIssues(r.issues);
    if (!r.ok) {
      /*
       * Distinguish "your CSS has problems" from "the file could not be written".
       *
       * Both come back as `ok: false`, but they need different actions from the user — fix the
       * stylesheet, versus clear a read-only flag on a file. Reporting the second as the first
       * leaves them editing CSS that was never the problem.
       */
      setNotice(r.error
        ? t('保存失败：{reason}', { reason: r.error })
        : t('样式未保存：有错误需要先修正（或用「强制保存」）。'));
      return;
    }
    setDirty(false);
    setNotice(r.forced ? t('已强制保存（存在未修正的问题）。') : t('已保存并生效。'));
  }), [draft, run, save]);

  const onImport = useCallback(async (file: File) => {
    const text = await file.text();
    // Strip a UTF-8 BOM: editors add one, and a stray \uFEFF at the top of a stylesheet is
    // an invalid character that can make the first rule fail to parse.
    setDraft(text.replace(/^\uFEFF/, ''));
    setDirty(true);
    setNotice(t('已载入 {name}，还没保存 —— 预览是即时生效的。', { name: file.name }));
  }, []);

  const jumpTo = useCallback((line: number) => {
    const el = editorRef.current;
    if (!el) return;
    const lines = draft.split('\n');
    const upTo = lines.slice(0, Math.max(0, line - 1)).join('\n');
    const start = upTo.length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    // Scroll the line into view: a textarea does not do this for a programmatic selection.
    const lineHeight = 18;
    el.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }, [draft]);

  const errorCount = shownIssues.filter((i) => i.severity === 'error').length;
  const warnCount = shownIssues.filter((i) => i.severity === 'warning').length;

  /**
   * The variables worth knowing about.
   *
   * Built at render rather than module level: `t()` reads the active locale from module
   * state, and module-level evaluation happens before `initLocale()` runs — so an English
   * user would get Chinese labels for the life of the process.
   */
  const variables = useMemo<Array<{ name: string; what: string }>>(() => [
    { name: '--bg-primary', what: t('主背景') },
    { name: '--bg-secondary', what: t('次级背景') },
    { name: '--text-primary', what: t('正文') },
    { name: '--text-secondary', what: t('次要文字') },
    { name: '--accent', what: t('强调色') },
    { name: '--border', what: t('边框') },
    { name: '--danger', what: t('危险动作') },
    { name: '--radius-md', what: t('圆角') },
    { name: '--font-sans', what: t('字体') },
    { name: '--text-base', what: t('正文字号') },
    { name: '--fill-control', what: t('控件填充') },
    { name: '--shadow-md', what: t('投影') },
  ], []);

  /** A starter stylesheet, shown as the editor's placeholder. */
  const placeholder = t('/* 例：把强调色换成暖色，圆角收紧一点 */\n:root {\n  --accent: #ff7a59;\n  --radius-md: 6px;\n}\n\n/* 也可以针对具体元素 */\naside { width: 260px; }');

  return (
    <div className={styles.overlay} onClick={onClose}>
      <section
        className={styles.panel}
        data-surface="panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>{t('自定义样式')}</h2>
            <p className={styles.subtitle}>
              {t('整个界面由 CSS 变量驱动 —— 改几个变量就能整体换肤。')}
            </p>
          </div>
          <div className={styles.headActions}>
            <button type="button" className="she-btn she-btn--sm" onClick={() => setShowReference((v) => !v)}>
              {showReference ? t('隐藏变量表') : t('变量表')}
            </button>
            <button type="button" className="she-btn she-btn--sm" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? t('隐藏预览') : t('显示预览')}
            </button>
            <button type="button" className={styles.close} onClick={onClose} title={t('关闭')}>×</button>
          </div>
        </header>

        {error ? <p className={styles.error}>{error}</p> : null}

        <div className={styles.statusRow}>
          <span className={theme.enabled ? styles.on : styles.off}>
            {theme.enabled ? t('已启用') : t('已停用')}
          </span>
          <span className={styles.meta}>
            {t('{rules} 条规则 · {vars} 个变量 · {kb} KB', {
              rules: theme.stats.rules,
              vars: theme.stats.variables,
              kb: (theme.bytes / 1024).toFixed(1),
            })}
          </span>
          {theme.path ? <code className={styles.path} title={theme.path}>{theme.path}</code> : null}
          {theme.updatedAt ? <span className={styles.meta}>{t('更新于')} {new Date(theme.updatedAt).toLocaleString()}</span> : null}
        </div>

        {showReference ? (
          <div className={styles.reference}>
            <p className={styles.hint}>
              {t('常用变量（写在 :root 里即可，深浅两套主题都生效）：')}
            </p>
            <div className={styles.varGrid}>
              {variables.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  className={styles.varItem}
                  onClick={() => {
                    // Inserting a starter rule is friendlier than making the user retype the
                    // variable name, which is the most common way to get it wrong.
                    const snippet = `:root {\n  ${v.name}: ;\n}\n`;
                    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${snippet}` : snippet));
                    setDirty(true);
                  }}
                  title={t('点击插入到编辑器')}
                >
                  <code>{v.name}</code>
                  <span>{v.what}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.body}>
          <div className={styles.editorCol}>
            <textarea
              ref={editorRef}
              className={styles.editor}
              value={draft}
              spellCheck={false}
              placeholder={placeholder}
              onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
              // Tab should indent, not move focus out of a code editor.
              onKeyDown={(e) => {
                if (e.key !== 'Tab') return;
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: s, selectionEnd: end } = el;
                const next = `${draft.slice(0, s)}  ${draft.slice(end)}`;
                setDraft(next);
                setDirty(true);
                requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
              }}
            />
            <div className={styles.toolbar}>
              <label className="she-btn she-btn--sm">
                {t('从文件载入')}
                <input
                  type="file"
                  accept=".css,text/css,text/plain"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onImport(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <button
                type="button"
                className="she-btn she-btn--sm she-btn--primary"
                disabled={busy !== null || !dirty}
                onClick={() => void onSave(false)}
              >
                {busy === 'save' ? t('保存中…') : t('保存并生效')}
              </button>
              {errorCount > 0 ? (
                <button
                  type="button"
                  className="she-btn she-btn--sm she-btn--danger"
                  disabled={busy !== null}
                  onClick={() => void onSave(true)}
                  title={t('明知道有错也要保存（你确定这是你要的）')}
                >
                  {t('强制保存')}
                </button>
              ) : null}
              <button
                type="button"
                className="she-btn she-btn--sm"
                disabled={busy !== null}
                onClick={() => void run('revert', async () => {
                  const r = await revert();
                  if (!r.ok) { setNotice(t('没有上一版可以恢复。')); return; }
                  setDirty(false);
                  setNotice(t('已恢复上一版。'));
                })}
              >
                {t('恢复上一版')}
              </button>
              <button
                type="button"
                className="she-btn she-btn--sm"
                disabled={busy !== null}
                onClick={() => void run('toggle', async () => {
                  if (theme.enabled) { await disable(); setNotice(t('已停用（内容保留，随时可启用）。')); }
                  else { await enable(); setNotice(t('已重新启用。')); }
                })}
              >
                {theme.enabled ? t('停用') : t('启用')}
              </button>
              <button
                type="button"
                className="she-btn she-btn--sm she-btn--danger"
                disabled={busy !== null || (!theme.css && !draft)}
                onClick={() => {
                  // Permanent, so it asks first — consistent with every other destructive
                  // action in the app.
                  if (!window.confirm(t('删除自定义样式？会保留一份备份，但界面会回到默认外观。'))) return;
                  void run('reset', async () => {
                    await reset();
                    setDraft('');
                    setDirty(false);
                    setIssues([]);
                    setNotice(t('已删除，界面回到默认外观。'));
                  });
                }}
              >
                {t('删除')}
              </button>
            </div>
          </div>

          <div className={styles.sideCol}>
            {showPreview ? (
              <div className={styles.previewBox}>
                <div className={styles.previewLabel}>
                  {t('预览（只作用于这块区域，弄不坏编辑器）')}
                </div>
                <div id={PREVIEW_SCOPE.replace('#', '')} className={styles.previewScope} data-surface="preview">
                  <style>{scopedPreview}</style>
                  <div className={styles.sample}>
                    <div className={styles.sampleCard}>
                      <div className={styles.sampleTitle}>{t('示例标题')}</div>
                      <p className={styles.sampleText}>
                        {t('这段文字用来判断字号、行高与对比度。')}
                      </p>
                      <div className={styles.sampleRow}>
                        <button type="button" className={styles.sampleBtn}>{t('主按钮')}</button>
                        <button type="button" className={styles.sampleBtnGhost}>{t('次级')}</button>
                      </div>
                      <pre className={styles.sampleCode}>{t('const x = 1; // 代码块')}</pre>
                      <div className={styles.sampleChip}>{t('标签')}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className={styles.issuesBox}>
              <div className={styles.previewLabel}>
                {errorCount || warnCount
                  ? t('检查结果：{e} 个错误 / {w} 个提示', { e: errorCount, w: warnCount })
                  : t('检查结果：没有问题')}
              </div>
              {shownIssues.length === 0 ? (
                <p className={styles.hint}>{t('保存时会自动检查；会锁死界面的写法会被拦下。')}</p>
              ) : (
                <ul className={styles.issueList}>
                  {shownIssues.map((i, idx) => (
                    <li key={`${i.line}-${idx}`} className={i.severity === 'error' ? styles.issueError : styles.issueWarn}>
                      <button type="button" className={styles.issueLine} onClick={() => jumpTo(i.line)}>
                        {t('第 {n} 行', { n: i.line })}
                      </button>
                      <span>{i.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={styles.escapeBox}>
              <div className={styles.previewLabel}>{t('样式把界面弄乱了怎么办')}</div>
              <p className={styles.hint}>
                {t('在地址栏手动加上')} <code>?theme=off</code> {t('并回车，即可停用（内容保留）。')}
                <br />
                {t('或执行')} <code>curl -X POST localhost:4577/api/theme/disable</code>
              </p>
              <p className={styles.hint}>
                {t('这两条都不依赖界面，所以界面看不见时也能用。')}
              </p>
            </div>
          </div>
        </div>

        {notice ? <p className={styles.notice}>{notice}</p> : null}
      </section>
    </div>
  );
}


