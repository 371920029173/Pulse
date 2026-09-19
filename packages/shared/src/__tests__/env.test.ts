/**
 * Configuration persistence.
 *
 * This is the project's original defect: settings written by the UI were not
 * the same file the server read on boot, so changes silently vanished on
 * restart. These tests pin the file format round-trip and, critically, that
 * updates do not destroy the rest of the file.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnvFile, updateEnvFile, resolveEnvFile } from '../env.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-env-'));
  file = join(dir, '.env');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('parseEnvFile', () => {
  it('parses key=value pairs', () => {
    const out = parseEnvFile('A=1\nB=hello\n');
    assert.equal(out.A, '1');
    assert.equal(out.B, 'hello');
  });

  it('ignores comments and blank lines', () => {
    const out = parseEnvFile('# comment\n\nA=1\n   \n# another\n');
    assert.deepEqual(Object.keys(out), ['A']);
  });

  it('lets a later duplicate override an earlier one', () => {
    /*
     * Last-wins, matching dotenv convention — appending an override at the
     * bottom of the file is the expected way to change a value, and doing the
     * opposite silently picks the stale line. Precedence against the OS
     * environment is separate and handled by `loadEnvFile`, which never
     * overwrites an existing `process.env` entry.
     */
    const out = parseEnvFile('A=first\nA=second\n');
    assert.equal(out.A, 'second');
  });

  it('strips surrounding quotes but keeps inner spaces', () => {
    const out = parseEnvFile('A="quoted value"\nB=\'single\'\nC=bare value\n');
    assert.equal(out.A, 'quoted value');
    assert.equal(out.B, 'single');
    assert.equal(out.C, 'bare value');
  });

  it('tolerates a UTF-8 BOM', () => {
    // PowerShell's Set-Content writes a BOM; an earlier parser produced a
    // mangled first key like "\uFEFFOPENAI_API_KEY".
    const out = parseEnvFile('\uFEFFA=1\n');
    assert.deepEqual(Object.keys(out), ['A']);
  });

  it('handles values containing = and Chinese text', () => {
    const out = parseEnvFile('URL=https://x.test/?a=1&b=2\nNAME=中文值\n');
    assert.equal(out.URL, 'https://x.test/?a=1&b=2');
    assert.equal(out.NAME, '中文值');
  });

  it('reads CRLF files', () => {
    const out = parseEnvFile('A=1\r\nB=2\r\n');
    assert.deepEqual(out, { A: '1', B: '2' });
  });

  it('ignores malformed lines', () => {
    const out = parseEnvFile('NOEQUALS\n=value\nA=1\n');
    assert.deepEqual(out, { A: '1' });
  });
});

describe('updateEnvFile', () => {
  it('creates the file when missing', () => {
    updateEnvFile(file, { SHE_PORT: '4577' });
    assert.equal(parseEnvFile(readFileSync(file, 'utf8')).SHE_PORT, '4577');
  });

  it('replaces an existing value in place', () => {
    writeFileSync(file, 'A=1\nB=2\n', 'utf8');
    updateEnvFile(file, { B: '99' });
    assert.equal(parseEnvFile(readFileSync(file, 'utf8')).B, '99');
  });

  it('preserves unrelated keys and comments', () => {
    writeFileSync(file, '# my notes\nA=1\nB=2\n', 'utf8');
    updateEnvFile(file, { C: '3' });
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('# my notes'), '注释不能被删掉');
    const parsed = parseEnvFile(text);
    assert.deepEqual(parsed, { A: '1', B: '2', C: '3' });
  });

  it('deletes a key when the value is null', () => {
    writeFileSync(file, 'A=1\nB=2\n', 'utf8');
    updateEnvFile(file, { A: null });
    assert.equal(parseEnvFile(readFileSync(file, 'utf8')).A, undefined);
    assert.equal(parseEnvFile(readFileSync(file, 'utf8')).B, '2');
  });

  it('an update never loses a previously saved key (the restart bug)', () => {
    // Write, re-read, write again — the shape that regressed before.
    updateEnvFile(file, { SHE_LLM_MODEL: 'm1' });
    updateEnvFile(file, { SHE_THEME: 'dark' });
    const parsed = parseEnvFile(readFileSync(file, 'utf8'));
    assert.equal(parsed.SHE_LLM_MODEL, 'm1', '第二次写入不能丢掉第一次的键');
    assert.equal(parsed.SHE_THEME, 'dark');
  });

  it('keeps the file parseable across repeated updates', () => {
    for (let i = 0; i < 10; i++) updateEnvFile(file, { [`K${i}`]: String(i) });
    const parsed = parseEnvFile(readFileSync(file, 'utf8'));
    for (let i = 0; i < 10; i++) assert.equal(parsed[`K${i}`], String(i));
  });

  it('does not accumulate blank lines', () => {
    writeFileSync(file, 'A=1\n', 'utf8');
    for (let i = 0; i < 5; i++) updateEnvFile(file, { [`X${i}`]: 'v' });
    const text = readFileSync(file, 'utf8');
    assert.ok(!/\n{3,}/.test(text), `出现了连续空行:\n${text}`);
  });

  it('preserves Windows line endings in a CRLF file', () => {
    writeFileSync(file, 'A=1\r\nB=2\r\n', 'utf8');
    updateEnvFile(file, { B: '9' });
    assert.ok(readFileSync(file, 'utf8').includes('\r\n'), '不应把 CRLF 改成 LF');
  });

  it('handles a value that is an empty string', () => {
    writeFileSync(file, 'A=1\n', 'utf8');
    updateEnvFile(file, { A: '' });
    assert.equal(parseEnvFile(readFileSync(file, 'utf8')).A, '');
  });
});

describe('resolveEnvFile', () => {
  /*
   * `SHE_ENV_FILE` overrides everything, by design — that is how the packaged launcher points
   * the server at a specific config. These tests are about the FALLBACK, so the ambient
   * value has to be out of the way.
   *
   * Not hypothetical: a developer who ran the checks (or the launcher) with `SHE_ENV_FILE`
   * exported had these two tests fail on a temp path they had never seen, with no hint that
   * the environment was the cause. A test must not be defeatable by ambient state.
   */
  const savedEnvFile = process.env.SHE_ENV_FILE;
  beforeEach(() => { delete process.env.SHE_ENV_FILE; });
  afterEach(() => {
    if (savedEnvFile === undefined) delete process.env.SHE_ENV_FILE;
    else process.env.SHE_ENV_FILE = savedEnvFile;
  });

  it('prefers the project root', () => {
    writeFileSync(file, 'A=1\n', 'utf8');
    assert.equal(resolveEnvFile(dir), file);
  });

  it('returns the root path when nothing exists yet', () => {
    // Callers write here; returning a cwd path instead was how the UI and the
    // server ended up reading different files.
    assert.equal(resolveEnvFile(dir), join(dir, '.env'));
    assert.equal(existsSync(join(dir, '.env')), false, 'resolve 不应有副作用');
  });

  it('SHE_ENV_FILE 存在时优先于工作区（这条是上面两条的前提）', () => {
    process.env.SHE_ENV_FILE = join(dir, 'explicit.env');
    assert.equal(resolveEnvFile(dir), join(dir, 'explicit.env'));
  });
});
