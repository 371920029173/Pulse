/**
 * Log rotation actually bounds the files.
 *
 *   node scripts/log-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Three places append to logs for the lifetime of an install: the launcher's captured server
 * output, the desktop shell's spawned-process output, and the server's own crash handler. None
 * of them rotated, and `launcher-server.log` had grown to 7 MB on the machine this was found
 * on — growth that surfaces much later as "why is my disk filling up" rather than as an error.
 *
 * A cap is easy to write in a way that silently does nothing: compare sizes, read the wrong
 * byte range, or open the file in a mode that ignores the rewrite. So this checks the
 * behaviour, not the code: create an oversized file, run the rotator, assert the file shrank
 * and that the RECENT content survived while the old content is gone.
 *
 * It also pins the naming separation, because that was the other half of the bug: server
 * stderr and real crash dumps shared one filename, so `crash.log` held 60 routine warnings and
 * zero crash reports.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const dir = mkdtempSync(join(tmpdir(), 'she-log-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/*
 * Exercise the real rotator from `she.mjs`, rather than a copy of it.
 *
 * `capLog` is not exported, so the function text is extracted and re-evaluated with the `fs`
 * bindings it closes over. Re-implementing it here would test the copy and let the two drift —
 * which is exactly how a cap ends up doing nothing in the shipped launcher while its test
 * stays green.
 */
function loadCapLog() {
  const src = readFileSync(join(ROOT, 'scripts', 'she.mjs'), 'utf8');
  const start = src.indexOf('function capLog(');
  if (start === -1) throw new Error('she.mjs 里找不到 capLog');

  // Walk to the matching closing brace.
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(start, i + 1);

  const factory = new Function(
    'existsSync', 'statSync', 'openSync', 'readSync', 'closeSync', 'writeFileSync', 'Buffer',
    `${body}; return capLog;`,
  );
  return factory(existsSync, statSync, openSync, readSync, closeSync, writeFileSync, Buffer);
}

/* ─── 1. The rotator bounds an oversized file ─── */
{
  const capLog = loadCapLog();
  const file = join(dir, 'big.log');
  const line = 'x'.repeat(99) + '\n'; // 100 bytes

  // 1 MB of content, capped at 64 KB.
  writeFileSync(file, 'OLD-MARKER\n' + line.repeat(10_000) + 'NEWEST-LINE\n', 'utf8');
  const before = statSync(file).size;
  capLog(file, 64 * 1024);
  const after = statSync(file).size;

  check('超限文件被截断', after < before, `${before} → ${after} 字节`);
  check('截断到上限以内', after <= 64 * 1024 + 200, `${after} 字节`);
  check('保留了最新的内容（排障要看的是这个）', readFileSync(file, 'utf8').includes('NEWEST-LINE'), '');
  check('丢掉了最老的内容', !readFileSync(file, 'utf8').includes('OLD-MARKER'), '');
  check('文件头标明了已截断', readFileSync(file, 'utf8').startsWith('…'), '');
}

/* ─── 2. A file under the cap is left alone ─── */
{
  const capLog = loadCapLog();
  const file = join(dir, 'small.log');
  writeFileSync(file, 'keep me\n', 'utf8');
  capLog(file, 64 * 1024);
  check('未超限的文件原样不动', readFileSync(file, 'utf8') === 'keep me\n', '');
}

/* ─── 3. Missing file and repeated calls do not throw ─── */
{
  const capLog = loadCapLog();
  let threw = null;
  try {
    capLog(join(dir, 'does-not-exist.log'), 1024);
    const f = join(dir, 'twice.log');
    writeFileSync(f, 'a\n'.repeat(5000), 'utf8');
    capLog(f, 1024);
    capLog(f, 1024); // second call must not corrupt what the first produced
  } catch (e) { threw = e.message; }
  check('文件不存在或重复调用都不抛异常', threw === null, threw ?? '');
}

/* ─── 4. Truncation does not split a multi-byte character ─── */
{
  const capLog = loadCapLog();
  const file = join(dir, 'cjk.log');
  // Each line is 3-byte CJK + newline, so a byte-boundary cut lands mid-character by design.
  writeFileSync(file, '中文日志行\n'.repeat(4000), 'utf8');
  capLog(file, 4096);
  const text = readFileSync(file, 'utf8');
  check('截断点不会切碎多字节字符（否则首行是乱码）',
    !text.includes('\uFFFD'), text.slice(0, 40));
  check('截断后仍是完整的行', text.endsWith('\n'), JSON.stringify(text.slice(-10)));
}

/* ─── 5. The names are separated: stderr must not go to crash.log ─── */
{
  const launcher = readFileSync(join(ROOT, 'scripts', 'she.mjs'), 'utf8');
  // Look at what ERR_FILE is actually assigned to.
  const m = /const ERR_FILE = join\(STATE_DIR, '([^']+)'\)/.exec(launcher);
  check('启动器的错误日志不再叫 crash.log', m && m[1] !== 'crash.log', `ERR_FILE = ${m ? m[1] : '未找到'}`);
  check('启动器仍保留 stdout 日志', /const LOG_FILE = join\(STATE_DIR, '([^']+)'\)/.test(launcher), '');

  // crash.log must be written ONLY by the crash handler, never by a log redirect.
  const writers = [];
  for (const rel of ['scripts/she.mjs', 'packages/desktop/main.cjs']) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    if (/openSync\([^)]*crash\.log/.test(text) || /appendFileSync\([^)]*crash\.log/.test(text)) writers.push(rel);
  }
  check('crash.log 不再被启动器当作输出文件', writers.length === 0, writers.join(', '));

  const server = readFileSync(join(ROOT, 'packages', 'server', 'src', 'index.ts'), 'utf8');
  check('服务端仍然会写 crash.log（真正的崩溃取证）', /'crash\.log'/.test(server), '');
  check('服务端的 crash.log 有上限（崩溃循环不会写满磁盘）',
    /MAX = 512 \* 1024/.test(server), '找不到大小上限');
}

/* ─── 6. Rotation is wired up in all three writers ─── */
{
  const launcher = readFileSync(join(ROOT, 'scripts', 'she.mjs'), 'utf8');
  check('启动器在打开日志前先截断', /capLog\(LOG_FILE\)[\s\S]{0,80}capLog\(ERR_FILE\)/.test(launcher), '');

  const desktop = readFileSync(join(ROOT, 'packages', 'desktop', 'main.cjs'), 'utf8');
  check('桌面端在打开子进程日志前先截断', /capLog\(outFile\)[\s\S]{0,60}capLog\(errFile\)/.test(desktop), '');
  check('桌面端 desktop.log 也有上限', /capLog\(file\)/.test(desktop), '');
}

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${!r.ok && r.detail ? ` — ${r.detail}` : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
