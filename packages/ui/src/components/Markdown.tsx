import React, { useState, useMemo } from 'react';
import styles from '../styles/Markdown.module.css';
import { highlight } from '../lib/highlight';

function inlineParse(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    if (m[2] && m[3]) {
      /*
       * Only render link targets that are safe to follow.
       *
       * Assistant text is untrusted — it can contain anything the model read from a repository — and
       * React 18 warns about `javascript:` URLs but still renders them, so
       * `[click](javascript:alert(document.domain))` executed on click. Anything that is not an
       * http(s)/mailto/relative URL is shown as plain text instead of a link, which keeps the text
       * visible (the alternative — dropping it — hides what the model said) without making it
       * clickable.
       */
      const href = m[3].trim();
      const safe = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(href) && !/[\u0000-\u001f]/.test(href);
      out.push(safe ? (
        <a key={key++} className={styles.link} href={href} target="_blank" rel="noreferrer noopener">
          {m[2]}
        </a>
      ) : (
        <span key={key++}>{m[2]}</span>
      ));
    } else if (m[5] != null) {
      out.push(
        <code key={key++} className={styles.inlineCode}>
          {m[5]}
        </code>,
      );
    } else if (m[7] != null) {
      out.push(<strong key={key++}>{m[7]}</strong>);
    } else if (m[9] != null) {
      out.push(<em key={key++}>{m[9]}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  /**
   * Highlighting is memoised on the code text.
   *
   * During streaming this component re-renders on every chunk; re-tokenising
   * the whole block each time would be O(n²) over the response.
   */
  const { html, known } = useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang || 'code'}</span>
        <button
          type="button"
          className={styles.codeCopy}
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        {/* Unknown language: render plain so the fence still shows correctly. */}
        {known
          ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          : <code className="hljs">{code}</code>}
      </pre>
    </div>
  );
}

/*
 * Block-level syntax the renderer understands. Each is also a paragraph terminator: before tables,
 * ordered lists, quotes and rules were recognised, a GFM table was joined into one paragraph and
 * shown as a single line of pipes, and "1. ... 2. ..." ran together the same way.
 */
const RE_FENCE = /^\s*```/;
const RE_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RE_BULLET = /^\s*[-*+]\s+/;
const RE_ORDERED = /^\s*(\d{1,9})[.)]\s+/;
const RE_QUOTE = /^\s*>\s?/;
const RE_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let j = 0; j < t.length; j++) {
    const c = t[j];
    if (c === '\\' && t[j + 1] === '|') { cur += '|'; j++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  return i + 1 < lines.length && lines[i].includes('|') && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-');
}

function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i];
  return RE_FENCE.test(l) || RE_HEADING.test(l) || RE_RULE.test(l) || RE_BULLET.test(l)
    || RE_ORDERED.test(l) || RE_QUOTE.test(l) || isTableStart(lines, i);
}

type Align = 'left' | 'center' | 'right' | undefined;

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (RE_FENCE.test(line)) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(<CodeBlock key={k++} lang={lang} code={buf.join('\n')} />);
      continue;
    }

    const hm = RE_HEADING.exec(line);
    if (hm) {
      const level = hm[1].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(React.createElement(Tag, { key: k++, className: styles['h' + Math.min(level, 3)] }, inlineParse(hm[2])));
      i++;
      continue;
    }

    if (RE_RULE.test(line)) {
      blocks.push(<hr key={k++} className={styles.hr} />);
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const aligns: Align[] = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={k++} className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>{head.map((c, j) => <th key={j} style={{ textAlign: aligns[j] }}>{inlineParse(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => <td key={j} style={{ textAlign: aligns[j] }}>{inlineParse(r[j] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(RE_QUOTE, ''));
        i++;
      }
      blocks.push(
        <blockquote key={k++} className={styles.quote}>
          <Markdown text={buf.join('\n')} />
        </blockquote>,
      );
      continue;
    }

    if (RE_BULLET.test(line) || RE_ORDERED.test(line)) {
      const ordered = !RE_BULLET.test(line);
      const re = ordered ? RE_ORDERED : RE_BULLET;
      const first = ordered ? Number(RE_ORDERED.exec(line)![1]) : 1;
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        if (re.test(lines[i])) {
          items.push(lines[i].replace(re, ''));
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length && !startsBlock(lines, i)) {
          items[items.length - 1] += ' ' + lines[i].trim();
        } else {
          break;
        }
        i++;
      }
      const lis = items.map((it, idx) => <li key={idx}>{inlineParse(it)}</li>);
      blocks.push(ordered
        ? <ol key={k++} className={styles.ol} start={first === 1 ? undefined : first}>{lis}</ol>
        : <ul key={k++} className={styles.ul}>{lis}</ul>);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={k++} className={styles.p}>
        {inlineParse(para.join(' '))}
      </p>,
    );
  }

  return <div className={styles.md}>{blocks}</div>;
}
