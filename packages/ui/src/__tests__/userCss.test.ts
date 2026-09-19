/**
 * Promoting the user's document-level selectors.
 *
 * The property that matters: `:root { --var: x }` must take effect in BOTH themes. The app
 * declares its dark tokens in `:root` (specificity 0,1,0) and its light tokens in
 * `[data-theme="light"]` (0,1,1), so without promotion the user's variable wins in dark mode
 * and silently loses in light — a failure that reads as "the feature is broken" and gives no
 * clue why.
 *
 * The transform must not damage a stylesheet it does not understand, so several cases below
 * assert that the output is either correct or byte-identical to the input.
 */
import { describe, it, expect } from 'vitest';
import { promoteDocumentSelectors, promoteSelectorList } from '../lib/userCss';

describe('promoteSelectorList', () => {
  it('【关键】:root 会额外匹配 html[data-theme]（否则浅色主题下变量无效）', () => {
    expect(promoteSelectorList(':root').selector).toBe(':root, html[data-theme]');
  });

  it('html 同样提升（同一个元素，同样的问题）', () => {
    expect(promoteSelectorList('html').selector).toBe('html, html[data-theme]');
  });

  it('大小写不敏感', () => {
    expect(promoteSelectorList(':ROOT').selector).toBe(':ROOT, html[data-theme]');
  });

  it('混在列表里时只在末尾加一次伴生选择器', () => {
    const r = promoteSelectorList(':root, .x');
    expect(r.selector).toBe(':root, .x, html[data-theme]');
    expect(r.selector.match(/html\[data-theme\]/g)).toHaveLength(1);
  });

  it('普通选择器完全不动（不该被"顺手优化"）', () => {
    const r = promoteSelectorList('.toolCallCard, aside');
    expect(r.selector).toBe('.toolCallCard, aside');
    expect(r.changed).toBe(false);
  });

  it('已经写过伴生选择器时不重复添加', () => {
    expect(promoteSelectorList(':root, html[data-theme]').selector).toBe(':root, html[data-theme]');
  });

  it('body 不动（它是不同元素，本来就不和 html 的规则竞争）', () => {
    expect(promoteSelectorList('body').selector).toBe('body');
    expect(promoteSelectorList('body').changed).toBe(false);
  });

  it('保留多余空白与书写风格', () => {
    expect(promoteSelectorList(':root ,  .x').selector).toBe(':root, .x, html[data-theme]');
  });
});

describe('promoteDocumentSelectors', () => {
  it('整个规则被改写，声明内容原样保留', () => {
    const out = promoteDocumentSelectors(':root {\n  --accent: #ff7a59;\n  --radius-md: 6px;\n}');
    expect(out).toContain(':root, html[data-theme] {');
    expect(out).toContain('--accent: #ff7a59;');
    expect(out).toContain('--radius-md: 6px;');
  });

  it('@media 内部同样提升（否则媒体查询里的覆盖会失效）', () => {
    const out = promoteDocumentSelectors('@media (max-width: 900px) { :root { --a: 1; } }');
    expect(out).toContain('@media (max-width: 900px)');
    expect(out).toContain('html[data-theme]');
  });

  it('@supports 同样递归', () => {
    const out = promoteDocumentSelectors('@supports (display: grid) { html { --a: 1; } }');
    expect(out).toContain('html, html[data-theme]');
  });

  it('@keyframes 内部不能动（from/50% 不是元素选择器）', () => {
    const css = '@keyframes spin { from { opacity: 0; } 50% { opacity: 0.5; } }';
    const out = promoteDocumentSelectors(css);
    expect(out).toContain('@keyframes spin');
    expect(out).not.toContain('html[data-theme]');
    // `from`/`50%` must not have gained a companion selector.
    expect(out).not.toMatch(/from,\s*html/);
  });

  it('注释被保留，且不会被当成选择器', () => {
    const out = promoteDocumentSelectors('/* 我的主题 */\n:root { --a: 1; }');
    expect(out).toContain('/* 我的主题 */');
    expect(out).toContain(':root, html[data-theme] {');
  });

  it('普通选择器不产生任何改动', () => {
    const css = '.a { color: red; }\naside { width: 260px; }';
    expect(promoteDocumentSelectors(css)).toBe(css);
  });

  it('字符串与注释里的花括号不会打乱分块', () => {
    const out = promoteDocumentSelectors('.x::after { content: "{"; }\n:root { --a: 1; }');
    expect(out).toContain(':root, html[data-theme]');
    expect(out).toContain('content: "{";');
  });

  it('空输入返回空', () => {
    expect(promoteDocumentSelectors('')).toBe('');
    expect(promoteDocumentSelectors('   ')).toBe('');
  });

  it('对畸形输入不抛异常（用户可能正在打字）', () => {
    for (const bad of [':root {', '}', '.x { color:', '@media {', ':root { --a:']) {
      expect(() => promoteDocumentSelectors(bad), `抛异常了: ${bad}`).not.toThrow();
    }
  });

  it('未闭合的规则不会吞掉前面的规则', () => {
    const out = promoteDocumentSelectors(':root { --a: 1; }\n.broken { color: blue;');
    expect(out).toContain(':root, html[data-theme]');
  });
});

describe('提升与预览作用域可以叠加使用', () => {
  it('先作用域化再提升的结果仍然是"只作用于预览"', () => {
    // The editor scopes the draft; injection promotes it. Neither may undo the other, so the
    // composition is asserted rather than assumed.
    const scoped = ':root { --a: 1; }'.replace(':root', '#she-theme-preview');
    const out = promoteDocumentSelectors(scoped);
    expect(out).toContain('#she-theme-preview');
    expect(out).not.toContain(':root');
  });
});
