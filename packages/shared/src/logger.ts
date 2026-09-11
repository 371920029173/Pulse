const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = (process.env.SHE_LOG_LEVEL as Level) || 'info';

function fmt(level: Level, mod: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  return `\x1b[2m${ts}\x1b[0m ${colorize(tag, level)} \x1b[36m${mod}\x1b[0m ${msg}`;
}

function colorize(s: string, level: Level): string {
  const colors: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
  return `${colors[level]}${s}\x1b[0m`;
}

export function setLogLevel(level: Level) { currentLevel = level; }

export function createLogger(mod: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => { if (LEVELS[currentLevel] <= LEVELS.debug) console.debug(fmt('debug', mod, msg), ...args); },
    info: (msg: string, ...args: unknown[]) => { if (LEVELS[currentLevel] <= LEVELS.info) console.info(fmt('info', mod, msg), ...args); },
    warn: (msg: string, ...args: unknown[]) => { if (LEVELS[currentLevel] <= LEVELS.warn) console.warn(fmt('warn', mod, msg), ...args); },
    error: (msg: string, ...args: unknown[]) => { if (LEVELS[currentLevel] <= LEVELS.error) console.error(fmt('error', mod, msg), ...args); },
  };
}
