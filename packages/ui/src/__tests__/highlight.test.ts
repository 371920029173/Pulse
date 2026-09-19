/**
 * Syntax highlighting.
 *
 * Two things matter here and both are easy to get subtly wrong:
 *
 *  1. An unknown language must be REPORTED as unknown, so the caller can render
 *     plain text. Returning empty HTML silently would make the code block vanish —
 *     and streaming code blocks hit this path constantly while the fence is still
 *     being written.
 *  2. Aliases must resolve, because fences are written every which way (`js`,
 *     `ts`, `sh`, `yml`). A missing alias degrades silently to unhighlighted code.
 *
 * The language list is also asserted against the files the app actually renders,
 * since an unregistered language is only noticed when a user sees uncolored code.
 */
import { describe, it, expect } from 'vitest';
import { highlight, registeredLanguages } from '../lib/highlight';

describe('highlight', () => {
  it('已知语言返回 HTML 且标记为已识别', () => {
    const r = highlight('const x: number = 1;', 'typescript');
    expect(r.known).toBe(true);
    expect(r.html).toContain('hljs-keyword');
  });

  it('别名解析到同一语言', () => {
    const code = 'const a = 1;';
    const viaFull = highlight(code, 'javascript');
    const viaAlias = highlight(code, 'js');
    expect(viaAlias.known).toBe(true);
    expect(viaAlias.html).toBe(viaFull.html);
  });

  it('未知语言报告为未识别（调用方据此降级为纯文本）', () => {
    const r = highlight('x', 'brainfuck');
    expect(r.known).toBe(false);
    expect(r.html).toBe('');
  });

  it('空语言名报告为未识别（流式渲染中围栏还没写完时会发生）', () => {
    expect(highlight('x', '').known).toBe(false);
    expect(highlight('x', '   ').known).toBe(false);
  });

  it('大小写与首尾空格无关', () => {
    expect(highlight('const a = 1;', '  JavaScript  ').known).toBe(true);
    expect(highlight('const a = 1;', 'TS').known).toBe(true);
  });

  it('不抛异常（highlight.js 会对畸形输入抛错）', () => {
    expect(() => highlight('<<<>>>', 'xml')).not.toThrow();
    expect(() => highlight('"unclosed', 'json')).not.toThrow();
    expect(() => highlight('', 'python')).not.toThrow();
  });

  it('转义 HTML，不把代码里的标签当标记', () => {
    const r = highlight('<script>alert(1)</script>', 'xml');
    expect(r.known).toBe(true);
    // The literal text must survive; what matters is that no live tag is emitted.
    expect(r.html).not.toContain('<script>');
  });
});

describe('已注册语言', () => {
  it('包含 agent 日常会渲染的语言', () => {
    const langs = registeredLanguages();
    for (const need of ['javascript', 'typescript', 'python', 'json', 'bash', 'xml', 'markdown', 'diff', 'yaml']) {
      expect(langs, `缺少 ${need}，对应代码块会失去配色`).toContain(need);
    }
  });

  it('每个已注册语言都能高亮而不抛错', () => {
    for (const lang of registeredLanguages()) {
      expect(() => highlight('a = 1\n', lang), `${lang} 注册了却无法高亮`).not.toThrow();
      expect(highlight('a = 1\n', lang).known, `${lang} 注册了却报未识别`).toBe(true);
    }
  });

  it('没有重复注册', () => {
    const langs = registeredLanguages();
    expect(new Set(langs).size).toBe(langs.length);
  });
});

describe('常用别名都能解析', () => {
  // These are the spellings that actually appear in model output and diffs.
  const ALIASES: Array<[string, string]> = [
    ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
    ['ts', 'typescript'], ['tsx', 'typescript'],
    ['py', 'python'],
    ['sh', 'bash'], ['shell', 'bash'], ['zsh', 'bash'], ['console', 'bash'],
    ['ps1', 'powershell'], ['pwsh', 'powershell'],
    ['html', 'xml'], ['svg', 'xml'], ['vue', 'xml'],
    ['md', 'markdown'],
    ['yml', 'yaml'],
    ['toml', 'ini'], ['cfg', 'ini'], ['conf', 'ini'],
    ['patch', 'diff'],
    ['c++', 'cpp'], ['hpp', 'cpp'], ['h', 'cpp'],
    ['cs', 'csharp'],
    ['golang', 'go'],
    ['rs', 'rust'],
    ['postgres', 'sql'], ['psql', 'sql'],
    ['docker', 'dockerfile'],
  ];

  for (const [alias, target] of ALIASES) {
    it(`${alias} -> ${target}`, () => {
      expect(highlight('a = 1\n', alias).known, `${alias} 没有解析到任何语言`).toBe(true);
      expect(highlight('a = 1\n', alias).html).toBe(highlight('a = 1\n', target).html);
    });
  }
});
