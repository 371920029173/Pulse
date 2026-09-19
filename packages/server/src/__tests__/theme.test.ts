/**
 * User stylesheet: validation and persistence.
 *
 * The validator is the fault tolerance, so these tests are mostly about what it REFUSES
 * and why. Two properties matter more than the rest:
 *
 *   1. **It must not lock the user out.** A stylesheet that hides the app has to be
 *      reported as an error, with the line — otherwise the user is left with an invisible
 *      interface and no idea which of their 50 rules did it.
 *   2. **It must not be a tyrant.** Warnings do not block, and `force` overrides errors,
 *      because the user may be doing something deliberate. A validator that refuses to save
 *      a stylesheet it merely dislikes is worse than no validator.
 *
 * A third property is easy to forget and expensive to get wrong: anything with a line
 * number must report the line in the ORIGINAL file. Stripping comments before analysis
 * makes that non-obvious, so it is asserted.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateCss, loadTheme, saveTheme, setThemeEnabled, clearTheme, revertTheme,
  themePaths, THEME_MAX_BYTES,
} from '../theme.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-theme-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Lines of issues with a given severity. */
const errors = (css: string) => validateCss(css).issues.filter((i) => i.severity === 'error');
const warnings = (css: string) => validateCss(css).issues.filter((i) => i.severity === 'warning');

describe('校验：正常样式表应当通过', () => {
  it('空的样式表通过（等于没改）', () => {
    const v = validateCss('');
    assert.equal(v.ok, true);
    assert.deepEqual(v.issues, []);
  });

  it('设置 CSS 变量通过（这是主要的扩展方式）', () => {
    const css = [
      ':root {',
      '  --accent: #ff6b6b;',
      '  --bg-primary: #1a1a1a;',
      '  --radius-md: 4px;',
      '}',
    ].join('\n');
    const v = validateCss(css);
    assert.equal(v.ok, true, JSON.stringify(v.issues));
    assert.equal(v.stats.variables, 3, '应当数出 3 个变量');
  });

  it('普通选择器覆盖通过', () => {
    const css = '.toolCallCard { border-radius: 2px; }\naside { width: 260px; }';
    assert.equal(validateCss(css).ok, true);
  });

  it('媒体查询通过（嵌套的花括号要能处理）', () => {
    const css = '@media (max-width: 900px) {\n  aside { display: none; }\n  main { padding: 4px; }\n}';
    const v = validateCss(css);
    assert.equal(v.ok, true, JSON.stringify(v.issues));
    // `display: none` on a child selector is legitimate hiding.
    assert.equal(errors(css).length, 0, '子元素隐藏不该被当成"弄坏界面"');
  });

  it('深层嵌套通过', () => {
    const css = '@supports (display: grid) {\n  @media print {\n    .x { color: red; }\n  }\n}';
    assert.equal(validateCss(css).ok, true);
  });

  it('统计规则数', () => {
    const v = validateCss('a { color: red; }\nb { color: blue; }\nc { color: green; }');
    assert.equal(v.stats.rules, 3);
  });
});

describe('校验：【关键】会锁死界面的规则必须报错', () => {
  const BRICKERS: Array<[string, string]> = [
    ['html { display: none; }', 'display:none 在 html 上'],
    ['body { display: none }', 'display:none 在 body 上'],
    ['#root { display: none }', 'display:none 在 #root 上'],
    ['* { display: none }', 'display:none 在 * 上'],
    [':root { display: none }', 'display:none 在 :root 上'],
    ['html { visibility: hidden }', 'visibility:hidden'],
    ['body { opacity: 0 }', 'opacity:0'],
    ['* { pointer-events: none }', 'pointer-events:none（什么都点不到）'],
    ['html { content-visibility: hidden }', 'content-visibility:hidden'],
    ['.a, body, .b { display: none }', '选择器列表里含 body'],
  ];

  for (const [css, what] of BRICKERS) {
    it(`拒绝：${what}`, () => {
      const v = validateCss(css);
      assert.equal(v.ok, false, `没有拦下: ${css}`);
      const e = errors(css);
      assert.ok(e.length > 0);
      // The message has to name the mechanism, or the user cannot act on it.
      assert.match(e[0].message, /display|visibility|opacity|pointer-events|content-visibility/);
    });
  }

  it('报出正确的行号（用户要在 50 行里找到那一行）', () => {
    const css = [
      ':root {',                 // 1
      '  --accent: red;',        // 2
      '}',                       // 3
      '',                        // 4
      'html {',                  // 5  ← 这一行是问题
      '  display: none;',        // 6
      '}',                       // 7
    ].join('\n');
    const e = errors(css);
    assert.equal(e.length, 1);
    assert.equal(e[0].line, 5, `行号应当指向选择器所在行，实际 ${e[0].line}`);
  });

  it('【不能退回去】BOM 不会让锁死界面的样式溜过去', () => {
    /*
     * A `.css` file written by Notepad or PowerShell starts with a BOM, which attaches to the
     * first selector: the sheet begins with `\uFEFFhtml`, not `html`.
     *
     * This passes today because U+FEFF is in ECMAScript's WhiteSpace production, so `trim()`
     * removes it when the selector is extracted. That is non-obvious and load-bearing:
     * replacing that `trim()` with a manual slice would let a stylesheet that hides the whole
     * interface through, silently. The test exists to make that refactor fail loudly.
     */
    const v = validateCss('\uFEFFhtml { display: none; }');
    assert.equal(v.ok, false, 'BOM 让 root 选择器没被认出来');
    assert.match(errors('\uFEFFhtml { display: none; }')[0].message, /display/);
  });

  it('BOM 也不影响正常样式的判定', () => {
    const v = validateCss('\uFEFF:root { --accent: red; }');
    assert.equal(v.ok, true, JSON.stringify(v.issues));
    assert.equal(v.stats.variables, 1);
  });

  it('BOM 出现在文件中间不会误伤（只处理开头那一个）', () => {
    assert.equal(validateCss('.a { color: red; }\n/* \uFEFF 注释里的 */').ok, true);
  });

  it('注释不会掩盖问题，也不会自己触发问题', () => {
    // The check runs on comment-stripped text, so a note mentioning display:none is fine…
    assert.equal(validateCss('/* html { display: none } 是坏主意 */\n.x { color: red }').ok, true);
    // …but a comment cannot hide a real offending rule either.
    assert.equal(validateCss('/* 说明 */\nbody { display: none }').ok, false);
  });

  it('注释在行首时行号仍然正确', () => {
    const css = [
      '/* 一',            // 1
      '   多行',          // 2
      '   注释 */',       // 3
      'body {',           // 4  ← 问题在这一行
      '  display: none;', // 5
      '}',
    ].join('\n');
    assert.equal(errors(css)[0].line, 4, '多行注释后行号错位了');
  });
});

describe('校验：花括号不平衡', () => {
  it('少一个右花括号 → 报错并指出起始行', () => {
    const e = errors(':root {\n  --a: 1;\n');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /缺少/);
    assert.equal(e[0].line, 1);
  });

  it('多一个右花括号 → 报错', () => {
    const e = errors('.x { color: red; }\n}');
    assert.match(e[0].message, /多出/);
  });

  it('【关键】未闭合的规则会吞掉后面全部内容 —— 必须拦下', () => {
    // The failure this exists for: the user's last rule is fine, but everything after an
    // earlier unclosed brace is silently discarded, so the result has nothing to do with
    // what they wrote.
    const css = '.a {\n  color: red;\n\n.b { color: blue; }\n.c { color: green; }';
    assert.equal(validateCss(css).ok, false);
  });

  it('字符串里的花括号不算数', () => {
    assert.equal(validateCss('.x::after { content: "{"; }').ok, true);
    assert.equal(validateCss('.x::after { content: "}"; }').ok, true);
    assert.equal(validateCss('.x { background: url("a{b}.png"); }').ok, true);
  });

  it('转义引号不会打乱字符串识别', () => {
    assert.equal(validateCss('.x::after { content: "\\""; }').ok, true);
  });
});

describe('校验：远程加载与危险声明', () => {
  it('拒绝 @import 远程样式（会泄露本机在跑这个应用）', () => {
    for (const css of [
      '@import url(https://evil.example/x.css);',
      '@import "http://evil.example/x.css";',
      "@import '//evil.example/x.css';",
    ]) {
      const v = validateCss(css);
      assert.equal(v.ok, false, `没有拦下: ${css}`);
      assert.match(errors(css)[0].message, /远程|泄露/);
    }
  });

  it('本地 @import 不算错（但会提醒）', () => {
    const v = validateCss('@import url("./other.css");');
    assert.equal(v.ok, true);
  });

  it('url(http…) 给警告而不是报错（可能是用户有意的）', () => {
    const w = warnings('.x { background: url(https://example.com/a.png); }');
    assert.equal(w.length, 1);
    assert.equal(validateCss('.x { background: url(https://example.com/a.png); }').ok, true);
  });

  it('拒绝 expression() / javascript: / behavior:', () => {
    for (const css of ['.x { width: expression(alert(1)); }', '.x { color: javascript:x; }', '.x { behavior: url(x.htc); }']) {
      assert.equal(validateCss(css).ok, false, `没有拦下: ${css}`);
    }
  });
});

describe('校验：体积与警告不阻塞', () => {
  it('超过上限 → 报错（过大会让每次重绘都变慢）', () => {
    const v = validateCss('/* pad */'.repeat(THEME_MAX_BYTES));
    assert.equal(v.ok, false);
    assert.match(v.issues[0].message, /过大/);
  });

  it('警告不影响 ok（不能因为"我不喜欢"就拒绝保存）', () => {
    const css = 'html { overflow: hidden; }'; // warning, not fatal
    const v = validateCss(css);
    assert.ok(v.issues.length > 0, '应当有提示');
    assert.equal(v.ok, true, '只是警告，不该拦下保存');
  });
});

describe('持久化', () => {
  it('默认没有样式表，且是启用状态', () => {
    const t = loadTheme(dir);
    assert.equal(t.css, '');
    assert.equal(t.enabled, true);
  });

  it('保存后能读回', () => {
    saveTheme(dir, ':root { --accent: red; }');
    assert.equal(loadTheme(dir).css, ':root { --accent: red; }');
    assert.ok(loadTheme(dir).updatedAt);
  });

  it('【关键】保存会留下上一版（出错时最可能要做的事就是回退）', () => {
    saveTheme(dir, '第一版');
    saveTheme(dir, '第二版');
    assert.equal(loadTheme(dir).css, '第二版');
    assert.ok(existsSync(themePaths(dir).prev), '没有留下上一版');
    assert.equal(readFileSync(themePaths(dir).prev, 'utf8'), '第一版');
  });

  it('revert 恢复上一版，并且本身可撤销', () => {
    saveTheme(dir, '第一版');
    saveTheme(dir, '第二版');

    const r = revertTheme(dir);
    assert.equal(r.ok, true);
    assert.equal(loadTheme(dir).css, '第一版');

    // Reverting again goes back, so a mistaken revert is not a dead end.
    const back = revertTheme(dir);
    assert.equal(back.ok, true);
    assert.equal(loadTheme(dir).css, '第二版');
  });

  it('没有上一版时 revert 明确报错（而不是静默什么都不做）', () => {
    const r = revertTheme(dir);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /没有上一版/);
  });

  it('可以停用而不删除（保住内容，随时开回来）', () => {
    saveTheme(dir, ':root { --accent: red; }');
    setThemeEnabled(dir, false);
    const off = loadTheme(dir);
    assert.equal(off.enabled, false);
    assert.equal(off.css, ':root { --accent: red; }', '停用不该丢掉内容');

    setThemeEnabled(dir, true);
    assert.equal(loadTheme(dir).enabled, true);
  });

  it('清除会删掉文件并保留一份备份', () => {
    saveTheme(dir, '要被清掉的');
    clearTheme(dir);
    assert.equal(loadTheme(dir).css, '');
    assert.ok(existsSync(themePaths(dir).prev), '清除前应当留一份');
  });

  it('状态文件损坏时不会锁死（隔离并回到默认启用）', () => {
    saveTheme(dir, 'x');
    writeFileSync(themePaths(dir).state, '{"schema_version":"she-theme/1","enabled":', 'utf8');
    const t = loadTheme(dir);
    // Quarantined and defaulted rather than throwing on every request.
    assert.equal(t.enabled, true);
    assert.equal(t.css, 'x', '样式文件本身还能读');
  });

  it('样式文件读不到时不会抛错（界面照常启动）', () => {
    saveTheme(dir, 'x');
    rmSync(themePaths(dir).css, { force: true });
    assert.doesNotThrow(() => loadTheme(dir));
    assert.equal(loadTheme(dir).css, '');
  });
});
