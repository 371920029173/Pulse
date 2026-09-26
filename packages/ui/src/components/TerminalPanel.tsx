import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/Terminal.module.css';

interface TermLine {
  id: string;
  kind: 'in' | 'out' | 'err' | 'sys';
  text: string;
}

interface ConfirmTicket {
  ticket_id: string;
  tool: string;
  summary: string;
}

export function TerminalPanel({ open, onToggle, height = 220 }: { open: boolean; onToggle: () => void; height?: number }) {
  const [lines, setLines] = useState<TermLine[]>([
    { id: 'boot', kind: 'sys', text: 'Pulse 终端 — 命令在工作区沙箱内执行；危险命令需确认。' },
  ]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState('.');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ ticket: ConfirmTicket; command: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const push = useCallback((kind: TermLine['kind'], text: string) => {
    setLines((prev) => [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, text }]);
  }, []);

  const run = useCallback(async (command: string, confirm_ticket_id?: string) => {
    const cmd = command.trim();
    if (!cmd || busy) return;
    setBusy(true);
    push('in', `$ ${cmd}`);
    try {
      const res = await fetchJSON<{
        needs_confirm?: boolean;
        ticket?: ConfirmTicket;
        denied?: boolean;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        timedOut?: boolean;
        durationMs?: number;
      }>('/api/terminal/exec', {
        method: 'POST',
        body: { command: cmd, cwd, confirm_ticket_id },
      });

      if (res.needs_confirm && res.ticket) {
        setPending({ ticket: res.ticket, command: cmd });
        push('sys', `需要确认：${res.ticket.summary}`);
        return;
      }

      if (res.stdout) push('out', res.stdout.replace(/\s+$/, ''));
      if (res.stderr) push('err', res.stderr.replace(/\s+$/, ''));
      push('sys', `退出码 ${res.exitCode ?? '?'}${res.timedOut ? '（超时）' : ''} · ${res.durationMs ?? 0}ms`);
    } catch (e) {
      push('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, cwd, push]);

  const onSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const cmd = input;
    setInput('');
    if (cmd.trim() === 'clear' || cmd.trim() === 'cls') {
      setLines([]);
      return;
    }
    if (cmd.trim().startsWith('cd ')) {
      const next = cmd.trim().slice(3).trim() || '.';
      setCwd(next);
      push('sys', `当前目录 → ${next}`);
      return;
    }
    void run(cmd);
  }, [input, push, run]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    const { ticket, command } = pending;
    setPending(null);
    await run(command, ticket.ticket_id);
  }, [pending, run]);

  const cancel = useCallback(() => {
    if (!pending) return;
    push('sys', '已取消确认');
    setPending(null);
  }, [pending, push]);

  if (!open) {
    return (
      <button type="button" className={styles.collapsedBar} onClick={onToggle}>
        ⌃ 终端
      </button>
    );
  }

  return (
    // Height comes from the CSS custom property first so that dragging the
    // splitter moves the panel live. `height` is React state and only commits
    // on mouseup, so using it directly made the resize lag a whole drag behind
    // the cursor — the "change layout doesn't follow the mouse" complaint.
    <div className={styles.panel} data-surface="panel" style={{ height: `var(--term-h, ${height}px)`, maxHeight: '70vh' }}>
      <div className={styles.header}>
        <span className={styles.title}>终端</span>
        <span className={styles.cwd}>{cwd}</span>
        <button type="button" className={styles.headerBtn} onClick={() => setLines([])} title="清空">
          清空
        </button>
        <button type="button" className={styles.headerBtn} onClick={onToggle} title="收起">
          ⌄
        </button>
      </div>
      <div className={styles.body} ref={scroller}>
        {lines.map((l) => (
          <pre key={l.id} className={`${styles.line} ${styles[l.kind]}`}>
            {l.text}
          </pre>
        ))}
      </div>
      {pending && (
        <div className={styles.confirmBar}>
          <span>确认危险命令：{pending.ticket.summary}</span>
          <button type="button" className={styles.confirmOk} onClick={() => void confirm()}>
            确认执行
          </button>
          <button type="button" className={styles.confirmNo} onClick={cancel}>
            取消
          </button>
        </div>
      )}
      <form className={styles.inputRow} onSubmit={onSubmit}>
        <span className={styles.prompt}>$</span>
        <input
          ref={inputRef}
          className={styles.input}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? '执行中…' : '输入命令（支持 cd / clear）'}
          autoComplete="off"
          spellCheck={false}
        />
      </form>
    </div>
  );
}
