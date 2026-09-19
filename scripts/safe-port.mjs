/**
 * Pick a TCP port that is free AND not in a Windows excluded range.
 *
 * Hyper-V / Windows reserves blocks of ports (see `netsh interface ipv4 show
 * excludedportrange`). Binding there returns EACCES, which looks like a
 * permission bug. Hardcoded test ports 4619/4671/4701 fall in those ranges on
 * this machine 鈥?the product launcher already avoids them; checks must too.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const IS_WINDOWS = process.platform === 'win32';

export function readExcludedTcpRanges() {
  if (!IS_WINDOWS) return [];
  try {
    const out = spawnSync(
      'netsh',
      ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
      { encoding: 'utf8', windowsHide: true },
    ).stdout || '';
    const ranges = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s*\*?$/);
      if (m) ranges.push([Number(m[1]), Number(m[2])]);
    }
    return ranges;
  } catch {
    return [];
  }
}

export function portExcluded(port, ranges = readExcludedTcpRanges()) {
  return ranges.some(([a, b]) => port >= a && port <= b);
}

export function portListening(port) {
  try {
    if (IS_WINDOWS) {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      return new RegExp(`:${port}\\s+.*LISTENING`, 'i').test(out);
    }
    const out = spawnSync('lsof', ['-i', `TCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** PID bound to a TCP listen port, or null. */
export function pidListeningOn(port) {
  if (!IS_WINDOWS) return null;
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      if (!line.includes(`:${port}`)) continue;
      const m = line.trim().match(/:(\d+)\s+.*LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === port) return Number(m[2]);
      const parts = line.trim().split(/\s+/);
      const last = Number(parts[parts.length - 1]);
      if (Number.isInteger(last) && last > 0) return last;
    }
  } catch { /* ignore */ }
  return null;
}

function canBind(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => {
      s.close(() => resolve(true));
    });
    try {
      s.listen(port, '127.0.0.1');
    } catch {
      resolve(false);
    }
  });
}

/**
 * @param {number} preferred
 * @param {number[]} extras
 * @returns {Promise<number>}
 */
export async function pickSafePort(preferred = 5577, extras = []) {
  const ranges = readExcludedTcpRanges();
  const candidates = [
    preferred,
    ...extras,
    5577, 5677, 5777, 5877, 6677, 6777, 7777, 8777, 9977,
    18080, 18081, 18082, 19090, 19191,
  ].filter((p, i, arr) => Number.isInteger(p) && p > 1024 && p < 65535 && arr.indexOf(p) === i);

  for (const p of candidates) {
    if (portExcluded(p, ranges)) continue;
    if (portListening(p)) continue;
    if (await canBind(p)) return p;
  }
  throw new Error('No free non-excluded TCP port found. Set an explicit test port env var outside Windows excluded ranges.');
}

export function resolvePreferredPort(envValue, fallback = 5577) {
  const preferred = Number(envValue || fallback);
  const ranges = readExcludedTcpRanges();
  const candidates = [
    preferred,
    5577, 5677, 5777, 5877, 6677, 6777, 7777, 8777, 9977,
  ].filter((p, i, arr) => Number.isInteger(p) && p > 0 && p < 65535 && arr.indexOf(p) === i);

  for (const p of candidates) {
    if (portExcluded(p, ranges)) continue;
    // Prefer free ports; allow preferred even if listening (caller may reuse).
    if (p === preferred) return p;
    if (!portListening(p)) return p;
  }
  for (const p of candidates) {
    if (!portExcluded(p, ranges)) return p;
  }
  throw new Error('No non-excluded TCP port available');
}
