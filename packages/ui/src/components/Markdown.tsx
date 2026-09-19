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

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(<CodeBlock key={k++} lang={lang} code={buf.join('\n')} />);
      continue;
    }

    const hm = /^(#{1,3})\s+(.+)$/.exec(line);
    if (hm) {
      const level = hm[1].length;
      const Tag = (level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3') as 'h1' | 'h2' | 'h3';
      blocks.push(React.createElement(Tag, { key: k++, className: styles['h' + level] }, inlineParse(hm[2])));
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={k++} className={styles.ul}>
          {items.map((it, idx) => (
            <li key={idx}>{inlineParse(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('```') &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i])
    ) {
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
