import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { SandboxShell, DESTRUCTIVE_PATTERNS, decodeConsoleOutput, workspaceEscapeReason } from '../shell.js';
import { createTools, globToRegExp } from '../tools.js';

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

describe('控制台编码', () => {
  it('GBK 字节按中文还原，合法 UTF-8 保持原样', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文
    if (process.platform === 'win32') {
      assert.equal(decodeConsoleOutput(gbk), '中文');
    }
    assert.equal(decodeConsoleOutput(Buffer.from('ok-标记', 'utf8')), 'ok-标记');
  });

  it('中文文件名不会在 dir 里变成乱码', async () => {
    if (process.platform !== 'win32') return;
    await writeFile(join(tempDir, '中文名.txt'), '你好');
    const result = await shell.exec('dir /b');
    assert.match(result.stdout, /中文名\.txt/, `实际: ${result.stdout}`);
  });
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

  it('should deny shell paths that leave the workspace', async () => {
    const outside = join(tempDir, '..', 'escape_test.txt');
    const result = await shell.exec('echo test > ../escape_test.txt');
    assert.equal(result.denied, true);
    assert.match(result.stderr, /工作区外/);
    assert.equal(existsSync(outside), false);
    assert.match(workspaceEscapeReason('cd C:\\', tempDir) ?? '', /工作区外/);
    assert.match(workspaceEscapeReason('node -e "require(\'fs\').writeFileSync(\'../x\',\'a\')"', tempDir) ?? '', /工作区外/);
  });

  it('should keep quoted arrows from becoming redirections', async () => {
    const junk = join(tempDir, '!ids.includes(u))');
    const result = await shell.exec('node -e "console.log([1].filter(u => !u).length)"');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), '0');
    assert.equal(existsSync(junk), false);
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

  /*
   * 回执必须说清「改了什么」。
   *
   * 这三条盯的是同一件事：回执不能只有字节数。改三行的回执、原样重写的回执、什么都没动的回执，
   * 如果长得一样，模型就会照着「我已经改好了」继续往下走，而审计的人只能去读整个文件。
   */
  it('直写回执带前后对比，而不是只有字节数', async () => {
    const tools = createTools(shell, tempDir, { allowAllCommands: true });
    await tools.execute('fs_write', { path: 'diff-target.txt', content: 'keep\nalpha\nkeep2' });
    const out = await tools.execute('fs_write', { path: 'diff-target.txt', content: 'keep\nbeta\nkeep2' });

    assert.ok(out.includes('Wrote'), out);
    assert.match(out, /^-alpha$/m, `应给出被删的行: ${out}`);
    assert.match(out, /^\+beta$/m, `应给出新增的行: ${out}`);
    assert.match(out, /\+1 −1/, `应报出增删计数: ${out}`);
  });

  it('原样重写时明说文件没有变化', async () => {
    const tools = createTools(shell, tempDir, { allowAllCommands: true });
    const body = 'same-a\nsame-b\nsame-c';
    await tools.execute('fs_write', { path: 'noop.txt', content: body });
    const out = await tools.execute('fs_write', { path: 'noop.txt', content: body });

    assert.match(out, /完全相同/, `原样重写不该看起来像一次改动: ${out}`);
  });

  it('新建文件不把内容回灌一遍', async () => {
    const tools = createTools(shell, tempDir, { allowAllCommands: true });
    const out = await tools.execute('fs_write', { path: 'fresh.txt', content: 'brand new body' });

    assert.match(out, /新建文件/, out);
    assert.ok(!out.includes('+brand new body'), `新建不该回灌内容: ${out}`);
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

/**
 * BOM 会让读取类工具说谎。
 *
 * PowerShell 的 `Set-Content`/`Out-File` 在 Windows 上会写 UTF-8 BOM，所以凡是 agent 用 shell
 * 生成的文件、或用户用记事本存过的文件，都可能以 U+FEFF 开头。Node 的 `utf8` 解码**不会**去掉它，
 * 于是一个看不见、但真实存在的字符进入了工具结果。实测那台机器上的工作区里，`src/main.ts`、
 * `tsconfig.json`、`README.md`、`logs/*.log` 都带着 BOM。
 *
 * 这几条钉的是它造成的两个后果，都不是「不够优雅」，而是**说错话**：
 *
 *   1. `grep` 用 `^` 锚定的模式在第 1 行匹配不上 —— 那一行确实存在，而且确实以要找的文字开头。
 *   2. `fs_read` 把那个字符当正文交给模型，模型在第 1 行上按字符数列，于是它的列号比语言服务器
 *      报的多 1（LSP 的位置建立在解析后的文档上，没有 BOM）—— 这就是「BOM 列偏移」。
 */
describe('工具读到 BOM 开头的文件', () => {
  const BOM = '\uFEFF';

  it('fs_read 把开头那个 BOM 去掉（否则列号整体偏 1）', async () => {
    const tools = createTools(shell, tempDir);
    await writeFile(join(tempDir, 'bommed.ts'), `${BOM}export const x = 1;\n`, 'utf8');

    const content = await tools.execute('fs_read', { path: 'bommed.ts' });
    assert.equal(content.charCodeAt(0) === 0xfeff, false, 'fs_read 把 BOM 当成了正文');
    assert.equal(content.split('\n')[0], 'export const x = 1;');
  });

  it('grep 能找到 BOM 文件第 1 行（^ 锚定不再失配）', async () => {
    const tools = createTools(shell, tempDir);
    await writeFile(join(tempDir, 'bommed.ts'), `${BOM}export const x = 1;\nconst y = 2;\n`, 'utf8');

    const anchored = await tools.execute('grep', { pattern: '^export', path: 'bommed.ts' });
    assert.match(anchored, /bommed\.ts:1:/, `^export 没匹配到第 1 行，实际: ${anchored}`);

    const byDir = await tools.execute('grep', { pattern: '^export', path: '.' });
    assert.match(byDir, /bommed\.ts:1:/, `按目录搜索时同样要匹配到，实际: ${byDir}`);
  });

  it('只去掉开头那一个：文件中间的 U+FEFF 是正文，不能动', async () => {
    const tools = createTools(shell, tempDir);
    // Zero-width no-break space between two words — real content, and a naive global
    // replace would silently delete it.
    await writeFile(join(tempDir, 'inner.ts'), `const a = 'x${BOM}y';\n`, 'utf8');

    const content = await tools.execute('fs_read', { path: 'inner.ts' });
    assert.ok(content.includes(`x${BOM}y`), '文件中间的 U+FEFF 被误删了');
  });

  it('原样重写一个 BOM 文件不再被报成「改动了第 1 行」', async () => {
    const tools = createTools(shell, tempDir);
    await writeFile(join(tempDir, 'bommed.ts'), `${BOM}export const x = 1;\n`, 'utf8');

    const first = await tools.execute('fs_write', {
      path: 'bommed.ts',
      content: 'export const x = 1;\n',
    });
    const parsed = JSON.parse(first);
    const receipt = await tools.execute('fs_write', {
      path: 'bommed.ts',
      content: 'export const x = 1;\n',
      _confirm_ticket: parsed.needs_confirm.ticket_id,
    });
    assert.match(receipt, /没有变化/, `把 BOM 当成了真实改动，回执: ${receipt}`);
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

/*
 * 知识库文件不许用 shell / fs_* 直捅。
 *
 * 这一组盯的是真实发生过的事：模型在 kb_query 没命中时改用
 * `sqlite3 .she/kb.sqlite "SELECT ..."`，绕过了共振排序与访问计数，还在服务端已经开着
 * 的库上多抓了一个句柄。提示词里写了规则，但规则拦不住已经决定绕路的调用——所以拒绝
 * 必须发生在工具这一层。
 */
describe('知识库文件禁止直连', () => {
  /** A fresh shell + toolset with the KB protected, as the server builds them. */
  async function withKb(root: string) {
    const dir = join(root, 'kb-workspace');
    await mkdir(join(dir, '.she'), { recursive: true });
    const kbPath = join(dir, '.she', 'kb.sqlite');
    await writeFile(kbPath, 'SQLite format 3\0not really a database');
    await writeFile(join(dir, 'notes.txt'), 'ordinary file\n');
    const kbShell = new SandboxShell(dir, { allowAllCommands: true });
    const tools = createTools(kbShell, dir, { kbDbPath: kbPath });
    return { dir, kbPath, tools };
  }

  it('fs_read 读知识库被拒，并指向 kb_query', async () => {
    const { tools } = await withKb(tempDir);
    const result = await tools.execute('fs_read', { path: '.she/kb.sqlite' });
    assert.ok(result.includes('kb_query'), result);
    assert.ok(result.includes('kb_upsert'), result);
  });

  it('fs_write 写知识库被拒（不能用直写绕过访问计数）', async () => {
    const { tools } = await withKb(tempDir);
    const result = await tools.execute('fs_write', { path: '.she/kb.sqlite', content: 'x' });
    assert.ok(result.includes('kb_upsert'), result);
  });

  it('反斜杠写法：Windows 上是同一个文件必须拒，POSIX 上它不是同一个文件', async () => {
    const { tools } = await withKb(tempDir);
    const result = await tools.execute('fs_read', { path: '.she\\kb.sqlite' });
    if (process.platform === 'win32') {
      // Windows 把 `\` 当分隔符：`.she\kb.sqlite` 就是那个库，换个拼法不是绕过的理由。
      assert.ok(result.includes('kb_query'), result);
      return;
    }
    /*
     * POSIX 上 `\` 是合法的文件名字符，所以这是另一个（而且并不存在的）文件。把它当成知识库
     * 拒掉才是错的 —— 模型读一个普通文件名不该被指向 kb_query。这里钉住的正是"不过度拒绝"。
     *
     * 这条分支是 CI 发现的：这个用例原先只按 Windows 的语义写，在 Linux 上必然红。
     */
    assert.ok(!result.includes('kb_query'), result);
    assert.match(result, /ENOENT|no such file/i);
  });

  it('shell 里 sqlite3 直查被拒，而不是让它跑起来', async () => {
    const { tools } = await withKb(tempDir);
    const result = await tools.execute('shell', {
      command: 'sqlite3 .she/kb.sqlite "SELECT * FROM memories"',
    });
    assert.ok(result.includes('DENIED'), result);
    assert.ok(result.includes('kb_query'), result);
  });

  it('WAL / SHM 边角文件一并拦住（写它们同样是在动那个库）', async () => {
    const { tools } = await withKb(tempDir);
    const wal = await tools.execute('fs_read', { path: '.she/kb.sqlite-wal' });
    assert.ok(wal.includes('kb_query'), wal);
  });

  it('普通文件不受影响（拦的是这一个文件，不是 .she 目录）', async () => {
    const { tools } = await withKb(tempDir);
    const ok = await tools.execute('fs_read', { path: 'notes.txt' });
    assert.equal(ok, 'ordinary file\n');
  });

  it('没注册知识库时行为不变（这条是上面几条的前提）', async () => {
    const plain = createTools(shell, tempDir);
    const result = await plain.execute('fs_read', { path: 'hello.txt' });
    assert.ok(result.includes('hello world'));
  });
});

describe('grep glob filter', () => {
  it('handles multi-star and brace globs instead of silently matching nothing', () => {
    assert.equal(globToRegExp('*.json*').test('runs.jsonl'), true);
    assert.equal(globToRegExp('*.json*').test('a.json'), true);
    assert.equal(globToRegExp('*.json*').test('a.js'), false);
    assert.equal(globToRegExp('*.{ts,tsx}').test('App.tsx'), true);
    assert.equal(globToRegExp('*test*').test('plan.test.ts'), true);
    assert.equal(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'), true);
    assert.equal(globToRegExp('src/**/*.ts').test('src/c.ts'), true);
    assert.equal(globToRegExp('*.ts').test('a.tsx'), false);
  });
});

