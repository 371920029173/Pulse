/**
 * Structural invariants in the UI that behaviour tests miss.
 *
 *   node scripts/ui-structure-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE CHECKED STATICALLY
 *
 * Both invariants below pin bugs that shipped and were found only by driving a real browser:
 *
 *   1. **The saved stylesheet applied only while the editor was open.** `useUserTheme` is
 *      what injects the stylesheet, and it was called from inside the editor panel — so
 *      restarting the app silently lost the theme, and `?theme=off` did nothing on a normal
 *      load because nothing had been applied to escape from.
 *
 *   2. **Overlay panels were mounted in one render branch only.** `App` returns early for the
 *      Home page, so anything declared after that `if` cannot appear there. The landing
 *      page's Settings and skill buttons were dead; later the schedule panel and this
 *      stylesheet editor could be opened from only one of the two screens.
 *
 * Neither is something a component test naturally reaches: (1) is about *where* a hook is
 * called, and (2) needs the whole app plus a specific screen. Stated structurally they are
 * cheap, and precise — they fail on the mistake and on nothing else.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const UI = join(ROOT, 'packages', 'ui', 'src');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const read = (rel) => {
  const p = join(UI, rel);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
};

/**
 * Remove comments before analysing.
 *
 * Not cosmetic: both files *talk about* the mistakes they avoid — ThemeStudio's header
 * explains that it does not call `useUserTheme()` itself. Analysing the prose would flag the
 * explanation as the mistake.
 */
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const appRaw = read('App.tsx');
const studioRaw = read('components/ThemeStudio.tsx');
const hook = code(read('hooks/useUserTheme.ts'));
const app = code(appRaw);
const studio = code(studioRaw);

// ── 1. A root-level concern is mounted at the root ──
{
  check(
    'App 挂载 useUserTheme（否则保存的样式重启后就没了）',
    /useUserTheme\(\)/.test(app),
    'App.tsx 里没有调用 useUserTheme()',
  );
  check(
    'ThemeStudio 不自己挂载 useUserTheme',
    !/useUserTheme\(\)/.test(studio),
    'ThemeStudio.tsx 又在调用 useUserTheme() —— 样式会只在打开编辑器时生效',
  );
  check(
    'ThemeStudio 通过 props 拿到主题状态',
    /userTheme:\s*UserThemeApi/.test(studio),
    'ThemeStudio 的 props 里没有 userTheme',
  );
}

// ── 2. Overlay panels declare once, render in both branches ──
{
  const refs = (app.match(/\{overlays\}/g) ?? []).length;
  check('浮层片段被两个分支共同引用', refs === 2, `出现 ${refs} 次（应为 2）`);

  const frag = /const overlays = \(([\s\S]*?)\n  \);/.exec(app);
  if (!frag) {
    check('浮层片段存在', false, '没找到 `const overlays = (`');
  } else {
    const inFragment = new Set([...frag[1].matchAll(/\{show(\w+) &&/g)].map((m) => m[1]));

    /*
     * The precise rule: a panel the HOME SCREEN can open must be in the shared fragment,
     * because Home returns before the chat branch is ever reached.
     *
     * Panels that only the chat surface opens (checkpoints, import, knowledge base) are
     * correctly chat-only, so demanding that every panel be shared would be wrong — it would
     * force meaningless churn. Deriving the set from Home's own props keeps the rule honest
     * and self-maintaining: adding a button to Home that opens a new panel fails this check
     * until the panel is shared.
     */
    const homeProps = /<Home([\s\S]*?)\/>/.exec(app);
    const fromHome = new Set(
      homeProps ? [...homeProps[1].matchAll(/setShow(\w+)\(true\)/g)].map((m) => m[1]) : [],
    );
    check(
      '能从首页打开的面板确实被识别到',
      fromHome.size >= 2,
      `只解析出 ${fromHome.size} 个：${[...fromHome].join(', ') || '(无)'}`,
    );
    const missing = [...fromHome].filter((n) => !inFragment.has(n));
    check(
      '首页能打开的面板都在共享片段里（Home 会提前 return）',
      missing.length === 0,
      `只挂在对话分支：${missing.join(', ')}`,
    );

    // The theme editor and the scheduler are opened from Settings, which is itself reachable
    // from both screens — so they inherit that reachability and must be shared too.
    for (const name of ['Theme', 'Schedule']) {
      check(
        `${name} 面板在共享片段里（设置里能打开它）`,
        inFragment.has(name),
        `${name} 不在 overlays 里，Home 上会打不开`,
      );
    }
  }
}

// ── 3. The injected stylesheet cannot execute anything ──
//
// A stylesheet is user-supplied text that is put into the DOM, so how it is inserted decides
// whether it is data or code. `textContent` makes it data: `</style><script>…</script>` stays a
// text node inside a <style> element, the CSS parser rejects it, and nothing runs. `innerHTML`
// would end the element and execute the script.
//
// Verified in a real browser (script never ran, the <style> element kept zero child elements),
// and asserted here because a future refactor could swap one property for the other without any
// test noticing — the CSS would still look like it works.
{
  check(
    '样式通过 textContent 注入（innerHTML 会让用户 CSS 里的 </style><script> 执行）',
    /\.textContent\s*=/.test(hook),
    'useUserTheme 里找不到 textContent 赋值',
  );
  check(
    '样式注入没有用 innerHTML / dangerouslySetInnerHTML',
    !/innerHTML/.test(hook) && !/dangerouslySetInnerHTML/.test(hook),
    '出现了 innerHTML —— 这就是 XSS',
  );
  // The element must be created by the app and reused, not re-parsed from a string.
  check(
    '注入元素由 createElement + appendChild 建立',
    /createElement\('style'\)/.test(hook) && /appendChild/.test(hook),
    '没有用 createElement/appendChild',
  );
}

// ── 4. The escape hatch stays wired and documented ──
{
  const server = readFileSync(join(ROOT, 'packages', 'server', 'src', 'index.ts'), 'utf8');
  check(
    '停用接口存在（界面看不见时唯一能用的出路）',
    /router\.post\('\/api\/theme\/disable'/.test(server),
    '找不到 POST /api/theme/disable',
  );
  check(
    '客户端会读取 ?theme=off',
    /searchParams\.get\('theme'\) !== 'off'/.test(hook),
    'useUserTheme 没有处理 ?theme=off',
  );
  check(
    '编辑器里写明了逃生通道（用户会找的地方）',
    /theme=off/.test(studioRaw),
    'ThemeStudio 里没提到 ?theme=off',
  );
  check(
    '客户端会调校验接口（边打字边提示，而不是保存才知道）',
    /api\/theme\/validate/.test(hook),
    'useUserTheme 没调用 /api/theme/validate',
  );
}

// ── 5. A window's conversation is its own decision ──
{
  /*
   * The server keeps ONE global active session, and the UI re-adopted it on every refresh
   * (which runs on both edges of every turn). So a window's conversation could be replaced
   * underneath the user: a second window picking its own chat, or a scheduled task activating
   * the session it works in, pulled them elsewhere mid-sentence.
   *
   * The rule now lives in `lib/sessionChoice.ts` with its own tests. This asserts the component
   * actually USES it — re-inlining `setActiveSessionId(data.active_id)` would restore the bug
   * while those unit tests stayed green, because they test the helper, not the call site.
   */
  check(
    'App 通过 pickActiveSession 决定会话（不是直接采纳服务端的 active_id）',
    /setActiveSessionId\(\(cur\) => pickActiveSession\(/.test(app),
    'App.tsx 里没有用 pickActiveSession 包住 setActiveSessionId',
  );
  /*
   * The refresh path specifically — not every assignment of `active_id`.
   *
   * `handleEnterWorkspace` legitimately replaces the selection with the server's value,
   * because the saved one belongs to the workspace being left. Asserting "no occurrence
   * anywhere" would fail on that correct use, so the function body is inspected instead.
   */
  const refreshBody = /const refreshSessions = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(app);
  check('找到了 refreshSessions 的函数体', Boolean(refreshBody), '正则没匹配到 —— 函数形状变了');
  if (refreshBody) {
    check(
      '会话列表刷新时走 pickActiveSession（而不是直接把 active_id 写进状态）',
      /pickActiveSession\(/.test(refreshBody[1]) && !/setActiveSessionId\(data\.active_id\)/.test(refreshBody[1]),
      'refreshSessions 又直接采纳了服务端的 active_id —— 窗口会被别的窗口拽走',
    );
  }
  check(
    '恢复的会话会被校验是否仍存在（避免一直显示空对话）',
    /isSessionKnown\(/.test(app),
    'App.tsx 没有校验 sessionStorage 里恢复的会话',
  );
  check(
    '本窗口的会话选择有独立持久化（sessionStorage 是每窗口独立的）',
    /sessionStorage\.setItem\('she\.session'/.test(app),
    '没有把本窗口的选择存起来，刷新后会继承别的窗口的会话',
  );
}

// ── 6. Raw HTML injection is always guarded ──
{
  /*
   * `dangerouslySetInnerHTML` is legitimate here — highlight.js emits escaped HTML that React
   * would otherwise show as visible tags. But one unguarded use is an XSS: the staged-write preview
   * did `highlight(...).html || clipCode(content)`, so for a file with no registered grammar
   * (`.txt`, `.log`, `.env`, a dotfile) the RAW content became HTML. `<img src=x onerror=...>` in any
   * such file executed in the app origin, which holds the API, the file tools and the stored keys —
   * and the content is model-controlled, so a prompt injection could reach it.
   *
   * The rule is therefore absolute: every injection site must render a text node when the highlighter
   * has no grammar. Stated structurally because the failing case is one character away (`||` instead
   * of a guarded ternary) and nothing else would notice.
   */
  const findings = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const text = code(readFileSync(p, 'utf8'));
      if (!text.includes('dangerouslySetInnerHTML')) continue;
      const rel = p.slice(UI.length + 1);

      /*
       * Require, within the same expression, both an injection AND a text-node alternative. The
       * guarded sites look like `<code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />`
       * inside a ternary whose other branch is `<code>{content}</code>`.
       */
      const guarded = /\?[^\n]*dangerouslySetInnerHTML|dangerouslySetInnerHTML[^\n]*\n?[^\n]*:/.test(text)
        || /known\s*[?&]|if \(!known\)/.test(text);
      if (!guarded) findings.push(rel);
    }
  };
  walk(join(UI, 'components'));

  check(
    'HTML 注入点都有"无语法时退回文本节点"的分支（否则是 XSS）',
    findings.length === 0,
    findings.join(', ') || '',
  );

  // And the specific shape that was the bug: a `||` fallback straight to raw content.
  const chat = code(readFileSync(join(UI, 'components', 'Chat.tsx'), 'utf8'));
  check(
    '写入预览不再用 `|| 原始内容` 兜底',
    !/dangerouslySetInnerHTML=\{\{\s*__html:[^}]*\|\|/.test(chat),
    '又出现了 `__html: highlight(...).html || 原始内容`',
  );
}

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${!r.ok && r.detail ? ` — ${r.detail}` : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
