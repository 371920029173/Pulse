import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SandboxShell, DESTRUCTIVE_PATTERNS } from '../shell.js';
import { createTools } from '../tools.js';

let tempDir: string;
let shell: SandboxShell;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'she-sandbox-test-'));
  shell = new SandboxShell(tempDir);
  await mkdir(join(tempDir, 'subdir'), { recursive: true });
  await writeFile(join(tempDir, 'hello.txt'), 'hello world\nsecond line\nthird line\n');
  await writeFile(join(tempDir, 'subdir', 'nested.txt'), 'nested content');
  await writeFile(join(tempDir, 'search-me.ts'), 'const foo = 42;\nconst bar = "hello";\nfoo + bar;\n');
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('SandboxShell', () => {
  it('should exec a basic command', async () => {
    const result = await shell.exec('echo hello');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'hello');
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs >= 0);
  });

  it('should handle command failure', async () => {
    const result = await shell.exec('exit 42');
    assert.equal(result.exitCode, 42);
  });

  it('should time out long commands', async () => {
    const hang = process.platform === 'win32' ? 'ping -n 60 127.0.0.1 >nul' : 'sleep 60';
    const result = await shell.exec(hang, { timeout: 500 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
  });

  it('should reject paths outside workspace', () => {
    assert.rejects(
      () => shell.exec('echo test', { cwd: '../../etc' }),
      /Path escapes workspace/,
    );
  });

  it('should detect destructive commands', () => {
    assert.equal(shell.isDestructive('rm -rf /'), true);
    assert.equal(shell.isDestructive('git push origin main'), true);
    assert.equal(shell.isDestructive('git reset --hard HEAD'), true);
    assert.equal(shell.isDestructive('fdisk /dev/sda'), true);
    assert.equal(shell.isDestructive('mkfs.ext4 /dev/sda1'), true);
    assert.equal(shell.isDestructive('echo hello'), false);
    assert.equal(shell.isDestructive('ls -la'), false);
    assert.equal(shell.isDestructive('git status'), false);
    assert.equal(shell.isDestructive('cat file.txt'), false);
  });

  it('should capture stderr', async () => {
    const result = await shell.exec('echo err >&2');
    assert.equal(result.stderr.trim(), 'err');
  });

  it('should deny destructive commands by default', async () => {
    const result = await shell.exec('rm -rf /');
    assert.equal(result.denied, true);
    assert.equal(result.exitCode, -1);
    assert.ok(result.stderr.includes('DENIED'));
    assert.equal(result.durationMs, 0);
  });

  it('should allow destructive commands when policy is disabled', async () => {
    const permissiveShell = new SandboxShell(tempDir, { denyDestructiveByDefault: false });
    const result = await permissiveShell.exec('echo rm -rf harmless');
    assert.equal(result.denied, undefined);
    assert.equal(result.exitCode, 0);
  });

  it('should have DESTRUCTIVE_PATTERNS exported as array of RegExps', () => {
    assert.ok(Array.isArray(DESTRUCTIVE_PATTERNS));
    assert.ok(DESTRUCTIVE_PATTERNS.length > 0);
    assert.ok(DESTRUCTIVE_PATTERNS[0] instanceof RegExp);
  });
});

describe('Tool: fs_read', () => {
  it('should read a file', async () => {
    const tools = createTools(shell, tempDir);
    const content = await tools.execute('fs_read', { path: 'hello.txt' });
    assert.ok(content.includes('hello world'));
  });

  it('should read line range', async () => {
    const tools = createTools(shell, tempDir);
    const content = await tools.execute('fs_read', { path: 'hello.txt', startLine: 2, endLine: 2 });
    assert.equal(content, 'second line');
  });

  it('should reject path escape', async () => {
    const tools = createTools(shell, tempDir);
    const result = await tools.execute('fs_read', { path: '../../../etc/passwd' });
    assert.ok(result.includes('Error:'));
    assert.ok(result.includes('Path escapes workspace'));
  });
});

describe('Tool: fs_write', () => {
  it('should write a file', async () => {
    const tools = createTools(shell, tempDir);
    const first = await tools.execute('fs_write', { path: 'new-file.txt', content: 'written content' });
    const parsed = JSON.parse(first);
    assert.ok(parsed.needs_confirm);
    const result = await tools.execute('fs_write', {
      path: 'new-file.txt',
      content: 'written content',
      _confirm_ticket: parsed.needs_confirm.ticket_id,
    });
    assert.ok(result.includes('Wrote'));

    const content = await readFile(join(tempDir, 'new-file.txt'), 'utf-8');
    assert.equal(content, 'written content');
  });

  it('should create parent directories', async () => {
    const tools = createTools(shell, tempDir);
    const first = await tools.execute('fs_write', { path: 'deep/nested/dir/file.txt', content: 'deep' });
    const parsed = JSON.parse(first);
    await tools.execute('fs_write', {
      path: 'deep/nested/dir/file.txt',
      content: 'deep',
      _confirm_ticket: parsed.needs_confirm.ticket_id,
    });

    const content = await readFile(join(tempDir, 'deep/nested/dir/file.txt'), 'utf-8');
    assert.equal(content, 'deep');
  });
});

describe('Tool: fs_list', () => {
  it('should list a directory', async () => {
    const tools = createTools(shell, tempDir);
    const listing = await tools.execute('fs_list', { path: '.' });
    assert.ok(listing.includes('hello.txt'));
    assert.ok(listing.includes('subdir/'));
  });

  it('should list recursively', async () => {
    const tools = createTools(shell, tempDir);
    const listing = await tools.execute('fs_list', { path: '.', recursive: true });
    assert.ok(listing.includes('subdir/nested.txt'));
  });
});

describe('Tool: grep', () => {
  it('should find matches', async () => {
    const tools = createTools(shell, tempDir);
    const result = await tools.execute('grep', { pattern: 'foo', path: '.' });
    assert.ok(result.includes('foo'));
    assert.ok(result.includes('search-me.ts'));
  });

  it('should return no matches gracefully', async () => {
    const tools = createTools(shell, tempDir);
    const result = await tools.execute('grep', { pattern: 'xyznonexistent', path: '.' });
    assert.equal(result, 'No matches found');
  });
});

describe('Tool: unknown', () => {
  it('should return error for unknown tool', async () => {
    const tools = createTools(shell, tempDir);
    const result = await tools.execute('nonexistent_tool', {});
    assert.ok(result.includes('Error: unknown tool'));
  });
});


describe('Confirm tickets', () => {
  it('should require confirm for shell tool', async () => {
    const tools = createTools(shell, tempDir);
    const first = await tools.execute('shell', { command: 'echo hi' });
    const parsed = JSON.parse(first);
    assert.ok(parsed.needs_confirm);
    const second = await tools.execute('shell', {
      command: 'echo hi',
      _confirm_ticket: parsed.needs_confirm.ticket_id,
    });
    assert.ok(second.includes('exit code'));
  });
});

describe('ToolSet definitions', () => {
  it('should have all 8 tool definitions', () => {
    const tools = createTools(shell, tempDir);
    assert.equal(tools.definitions.length, 8);
    const names = tools.definitions.map(d => d.name);
    assert.ok(names.includes('shell'));
    assert.ok(names.includes('fs_read'));
    assert.ok(names.includes('fs_write'));
    assert.ok(names.includes('fs_list'));
    assert.ok(names.includes('grep'));
    assert.ok(names.includes('git_status'));
    assert.ok(names.includes('git_diff'));
    assert.ok(names.includes('git_log'));
  });

  it('should mark dangerous tools', () => {
    const tools = createTools(shell, tempDir);
    const shellDef = tools.definitions.find(d => d.name === 'shell')!;
    const writeDef = tools.definitions.find(d => d.name === 'fs_write')!;
    const readDef = tools.definitions.find(d => d.name === 'fs_read')!;
    assert.equal(shellDef.isDangerous, true);
    assert.equal(writeDef.isDangerous, true);
    assert.equal(readDef.isDangerous, undefined);
  });
});

