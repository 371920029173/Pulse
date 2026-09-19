/**
 * CSS scoping for the theme preview.
 *
 * The property that matters is the one the editor depends on: applying a draft must not be
 * able to affect the editor itself. These tests pin that, plus the shapes a real stylesheet
 * uses — `:root` variables, media queries, keyframes, comments, strings containing braces.
 *
 * A transform that mangles CSS silently is worse than one that drops what it cannot handle,
 * so several cases assert that the output is either correct or absent, never wrong.
 */
import { describe, it, expect } from 'vitest';
import { scopeCss, PREVIEW_SCOPE } from '../lib/scopeCss';

describe('scopeCss：文档级选择器映射到预览容器', () => {
  it(':root 变成容器本身（变量要落在预览里）', () => {
    expect(scopeCss(':root { --accent: red; }')).toContain(`${PREVIEW_SCOPE} {`);
    // `#preview :root` would match nothing: a descendant can never be the root element.
    expect(scopeCss(':root { --accent: red; }')).not.toContain(`${PREVIEW_SCOPE} :root`);
  });

  it('html / body / #root 同样映射', () => {
    for (const sel of ['html', 'body', '#root']) {
      const out = scopeCss(`${sel} { color: red; }`);
      expect(out).toContain(`${PREVIEW_SCOPE} {`);
      expect(out).not.toContain(`${PREVIEW_SCOPE} ${sel}`);
    }
  });

  it('【关键】html { display: none } 只会影响预览，不会影响编辑器', () => {
    /*
     * This is the whole reason the transform exists. If the draft were applied unscoped,
     * this rule would hide the editor and the user would have no way to undo it from
     * inside the app.
     */
    const scoped = scopeCss('html { display: none; }');
    expect(scoped).toBe(`${PREVIEW_SCOPE} { display: none; }`);
    // Nothing in the output can match the real document root.
    expect(scoped).not.toMatch(/^html/m);
    expect(scoped).not.toMatch(/(^|\n)\s*body\s*\{/m);
  });

  it('* 变成容器内的一切，而不是字面意义上的所有元素', () => {
    const scoped = scopeCss('* { box-sizing: border-box; }');
    expect(scoped).toContain(`${PREVIEW_SCOPE} *`);
    expect(scoped).not.toMatch(/^\*\s*\{/m);
  });

  it('body::before 这类伪元素挂在容器上，而不是变成容器的后代', () => {
    const scoped = scopeCss('body::before { content: "x"; }');
    expect(scoped).toContain(`${PREVIEW_SCOPE}::before`);
    expect(scoped).not.toContain(`${PREVIEW_SCOPE} body::before`);
  });
});

describe('scopeCss：普通选择器加前缀', () => {
  it('类选择器加容器前缀', () => {
    expect(scopeCss('.toolCallCard { border-radius: 2px; }'))
      .toContain(`${PREVIEW_SCOPE} .toolCallCard`);
  });

  it('选择器列表逐个加前缀', () => {
    const scoped = scopeCss('aside, header { opacity: 0.5; }');
    expect(scoped).toContain(`${PREVIEW_SCOPE} aside`);
    expect(scoped).toContain(`${PREVIEW_SCOPE} header`);
  });

  it('列表里混入文档级选择器时各自映射正确', () => {
    const scoped = scopeCss(':root, .x { color: red; }');
    expect(scoped).toContain(PREVIEW_SCOPE);
    expect(scoped).toContain(`${PREVIEW_SCOPE} .x`);
    expect(scoped).not.toContain('${PREVIEW_SCOPE} :root');
  });

  it('属性选择器与伪类照常加前缀', () => {
    expect(scopeCss('[data-surface="tool"] { color: red; }'))
      .toContain(`${PREVIEW_SCOPE} [data-surface="tool"]`);
    expect(scopeCss('.x:hover { color: red; }'))
      .toContain(`${PREVIEW_SCOPE} .x:hover`);
  });
});

describe('scopeCss：at-rule 处理', () => {
  it('@media 内部的选择器也要加前缀（否则会漏出预览范围）', () => {
    const scoped = scopeCss('@media (max-width: 900px) { html { display: none; } .x { color: red; } }');
    expect(scoped).toContain('@media (max-width: 900px)');
    expect(scoped).toContain(`${PREVIEW_SCOPE} { display: none; }`);
    expect(scoped).toContain(`${PREVIEW_SCOPE} .x`);
    // The dangerous rule must not survive unscoped inside the media query.
    expect(scoped).not.toMatch(/@media[^{]*\{\s*html\s*\{/);
  });

  it('@supports 同样递归', () => {
    const scoped = scopeCss('@supports (display: grid) { .x { display: grid; } }');
    expect(scoped).toContain('@supports (display: grid)');
    expect(scoped).toContain(`${PREVIEW_SCOPE} .x`);
  });

  it('@keyframes 原样保留（动画名是全局的，没有选择器可加前缀）', () => {
    const scoped = scopeCss('@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }');
    expect(scoped).toContain('@keyframes spin');
    expect(scoped).not.toContain(`${PREVIEW_SCOPE} @keyframes`);
    // Inner `from`/`to` must not be prefixed either — that would break the animation.
    expect(scoped).not.toContain(`${PREVIEW_SCOPE} from`);
  });

  it('嵌套的 @media 内 @keyframes 也能识别', () => {
    const scoped = scopeCss('@media print { @keyframes x { from { opacity: 0; } } }');
    expect(scoped).toContain('@keyframes x');
    expect(scoped).not.toContain(`${PREVIEW_SCOPE} from`);
  });

  it('@import 被丢弃（预览不发外部请求）', () => {
    expect(scopeCss('@import url(https://x/y.css);\n.a { color: red; }')).not.toContain('@import');
  });
});

describe('scopeCss：不会把 CSS 改坏', () => {
  it('字符串里的花括号不影响分块', () => {
    // The bug this guards: counting `{` inside a string splits the file at the wrong place
    // and silently mangles everything after it.
    const scoped = scopeCss('.x::after { content: "{"; }\n.y { color: red; }');
    expect(scoped).toContain(`${PREVIEW_SCOPE} .x::after`);
    expect(scoped).toContain(`${PREVIEW_SCOPE} .y`);
  });

  it('注释里的花括号不影响分块，且注释被保留', () => {
    const scoped = scopeCss('/* { 未闭合的注释里有个花括号 } */\n.a { color: red; }');
    expect(scoped).toContain(`${PREVIEW_SCOPE} .a`);
    expect(scoped).toContain('未闭合的注释里有个花括号');
  });

  it('转义引号不打乱字符串识别', () => {
    const scoped = scopeCss('.x::after { content: "\\""; }\n.y { color: red; }');
    expect(scoped).toContain(`${PREVIEW_SCOPE} .y`);
  });

  it('声明内容原样保留（不重排、不丢属性）', () => {
    const body = 'background: linear-gradient(180deg, #fff 0%, #000 100%);\n  border: 1px solid var(--border);';
    const scoped = scopeCss(`.x { ${body} }`);
    expect(scoped).toContain('linear-gradient(180deg, #fff 0%, #000 100%)');
    expect(scoped).toContain('var(--border)');
  });

  it('空输入返回空', () => {
    expect(scopeCss('')).toBe('');
    expect(scopeCss('   \n  ')).toBe('');
  });

  it('只有注释的输入不产生规则', () => {
    // A comment-only file has no blocks; nothing dangerous can come out of it.
    expect(scopeCss('/* 只是说明 */').trim()).toBe('');
  });

  it('对畸形输入不抛异常（编辑器里可能正在打字）', () => {
    for (const bad of ['.x {', '}', '}}}', '.x { color:', '@media {', ':root { --a:']) {
      expect(() => scopeCss(bad), `抛异常了: ${bad}`).not.toThrow();
    }
  });

  it('未闭合的规则不会吞掉前面的规则', () => {
    const scoped = scopeCss('.good { color: red; }\n.broken { color: blue;');
    expect(scoped).toContain(`${PREVIEW_SCOPE} .good`);
  });
});
