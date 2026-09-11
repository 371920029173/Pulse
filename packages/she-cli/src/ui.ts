// ─── ANSI escape helpers ───

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

function wrap(code: string): (text: string) => string {
  return (text: string) => `${ESC}${code}m${text}${RESET}`;
}

export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');
export const dim = wrap('2');
export const bold = wrap('1');
export const underline = wrap('4');

export const boldRed = (t: string) => bold(red(t));
export const boldGreen = (t: string) => bold(green(t));
export const boldCyan = (t: string) => bold(cyan(t));
export const boldYellow = (t: string) => bold(yellow(t));
export const boldMagenta = (t: string) => bold(magenta(t));
export const boldBlue = (t: string) => bold(blue(t));
export const dimYellow = (t: string) => dim(yellow(t));

// ─── Icons ───

export const icons = {
  pass: green('✓'),
  fail: red('✗'),
  arrow: dim('→'),
  dot: dim('·'),
  bullet: cyan('▸'),
  gear: yellow('⚙'),
  warn: yellow('⚠'),
  bolt: yellow('⚡'),
  box: cyan('■'),
  seed: magenta('◆'),
} as const;

// ─── Spinner ───

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  update(text: string): void;
  stop(finalText?: string): void;
}

export function spinner(text: string): Spinner {
  let frame = 0;
  let currentText = text;
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    const f = cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    process.stderr.write(`\r${ESC}2K  ${f} ${currentText}`);
    frame++;
  }, 80);

  process.stderr.write(`\r${ESC}2K  ${cyan(SPINNER_FRAMES[0])} ${currentText}`);

  return {
    update(newText: string) {
      currentText = newText;
    },
    stop(finalText?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      process.stderr.write(`\r${ESC}2K`);
      if (finalText !== undefined) {
        process.stderr.write(`${finalText}\n`);
      }
    },
  };
}

// ─── Box drawing ───

const BOX_CHARS = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
};

export function box(text: string, title?: string): string {
  const lines = text.split('\n');
  const maxLen = Math.max(...lines.map(l => stripAnsi(l).length), title ? stripAnsi(title).length + 2 : 0);
  const width = maxLen + 2;

  const topLabel = title ? ` ${title} ` : '';
  const topPad = BOX_CHARS.h.repeat(width - stripAnsi(topLabel).length);
  const top = `${BOX_CHARS.tl}${topLabel}${topPad}${BOX_CHARS.tr}`;
  const bottom = `${BOX_CHARS.bl}${BOX_CHARS.h.repeat(width)}${BOX_CHARS.br}`;

  const rows = lines.map(line => {
    const visible = stripAnsi(line).length;
    const pad = ' '.repeat(Math.max(0, maxLen - visible));
    return `${BOX_CHARS.v} ${line}${pad} ${BOX_CHARS.v}`;
  });

  return [top, ...rows, bottom].join('\n');
}

// ─── Progress bar ───

export function progressBar(current: number, total: number, width: number = 30): string {
  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = green('█'.repeat(filled)) + dim('░'.repeat(empty));
  const pct = (ratio * 100).toFixed(0).padStart(3);
  return `${bar} ${pct}%`;
}

// ─── Activation level bar (for KB results) ───

export function activationBar(level: number, width: number = 20): string {
  const clamped = Math.min(Math.max(level, 0), 1);
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const colorFn = clamped >= 0.7 ? green : clamped >= 0.4 ? yellow : red;
  return colorFn('▮'.repeat(filled)) + dim('▯'.repeat(empty));
}

// ─── Badge ───

const BADGE_COLORS: Record<string, (t: string) => string> = {
  code: green,
  text: blue,
  fact: cyan,
  tool_outcome: yellow,
  preference: magenta,
};

export function badge(text: string, color?: string): string {
  const colorFn = (color && BADGE_COLORS[color]) || BADGE_COLORS[text.toLowerCase()] || dim;
  return colorFn(`[${text.toUpperCase()}]`);
}

// ─── Table ───

export function table(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, stripAnsi(row[i] ?? '').length), 0);
    return Math.max(stripAnsi(h).length, dataMax);
  });

  const sep = colWidths.map(w => '─'.repeat(w + 2)).join('┼');
  const headerLine = headers.map((h, i) => {
    const pad = ' '.repeat(colWidths[i] - stripAnsi(h).length);
    return ` ${bold(h)}${pad} `;
  }).join('│');

  const dataLines = rows.map(row =>
    row.map((cell, i) => {
      const pad = ' '.repeat(Math.max(0, colWidths[i] - stripAnsi(cell).length));
      return ` ${cell}${pad} `;
    }).join('│')
  );

  return [headerLine, sep, ...dataLines].join('\n');
}

// ─── Strip ANSI (for width calculations) ───

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
