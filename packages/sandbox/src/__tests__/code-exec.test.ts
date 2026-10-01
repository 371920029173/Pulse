/**
 * Arbitrary code execution on the command line: detected, allowed, and DISCLOSED.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS ABOUT, AND WHAT IT IS NOT
 *
 * The workspace jail (`workspaceEscapeReason`) reads the command TEXT. `cd C:\`, `> ..\file` and
 * `node C:\evil.js` are all refused, and `sandbox.test.ts` keeps them refused.
 *
 * This file is about the case the jail CANNOT answer:
 *
 *   node -e "require('fs').writeFileSync('C:/outside/x','1')"
 *
 * The path is inside a string. Reading that string means parsing JavaScript — and then Python, then
 * PowerShell, then a base64 blob (`-EncodedCommand`) that is opaque on purpose. There is no textual
 * fix, and pretending otherwise is how a boundary becomes a claim nobody can check.
 *
 * The decision this file pins down is therefore NOT "detect and block". It is:
 *
 *   the command runs, and the RESULT says the child process was not path-contained.
 *
 * Three things have to hold for that to be worth anything, and each has its own section below:
 *
 *   1. The detection matches every form that carries code, and does NOT match a string that merely
 *      mentions one (`echo "node -e x"` is not a child process).
 *   2. The flag survives to the reader — foreground, background start, and every later `shell_wait`
 *      — because a disclosure that appears once, in a result the model has already moved past, is
 *      not a disclosure.
 *   3. The gap is REAL and pinned as such. One test asserts that the jail returns null for a command
 *      that writes outside the workspace: if someone later teaches the jail to read code strings,
 *      that test fails and this whole file should be re-read rather than quietly kept.
 *
 *   node --import tsx --test src/__tests__/code-exec.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SandboxShell, detectInlineCodeExecution, codeExecutionDisclosure, workspaceEscapeReason,
} from '../shell.js';
import { createTools } from '../tools.js';

let tempDir: string;
let shell: SandboxShell;
let tools: ReturnType<typeof createTools>;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'she-codeexec-test-'));
  shell = new SandboxShell(tempDir, { allowAllCommands: true, denyDestructiveByDefault: false });
  tools = createTools(shell, tempDir, { allowAllCommands: true });
});

/** See `background.test.ts` for why the teardown reports instead of throwing. */
async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch (err) {
    console.warn(`[code-exec.test] 临时目录没删掉，留给 check:temp: ${dir} (${(err as Error).message})`);
  }
}

after(async () => {
  await shell.stopAll();
  await cleanupTempDir(tempDir);
});

describe('识别：代码写在命令行里的每一种形式', () => {
  /*
   * Each row is [command, expected interpreter, expected flag]. The expectation is the pair the
   * reader will be shown, so a wrong flag here is a wrong statement in a tool result.
   */
  const CASES: Array<[string, string, string]> = [
    ['node -e "console.log(1)"', 'node', '-e'],
    ['node --eval "console.log(1)"', 'node', '--eval'],
    ['node --eval=console.log(1)', 'node', '--eval'],
    ['node -p "1+1"', 'node', '-p'],
    ['node --print 1', 'node', '--print'],
    ['python -c "print(1)"', 'python', '-c'],
    ['python3 -c "print(1)"', 'python3', '-c'],
    ['py -c "print(1)"', 'py', '-c'],
    ['powershell -Command "Get-ChildItem"', 'powershell', '-Command'],
    // portability-check:allow — 下面这行是**被测数据**，不是调用。这个文件测的就是「能不能从命令行
    // 文本里认出有人写了代码」，所以 powershell -EncodedCommand 必须原样出现；整张表只喂给
    // detectInlineCodeExecution()，不 spawn 任何进程，也就无所谓平台分支。
    ['powershell.exe -EncodedCommand ZQBjAGgAbwA=', 'powershell', '-EncodedCommand'],
    ['pwsh -c "Get-Date"', 'pwsh', '-c'],
    ['cmd /c dir', 'cmd', '/c'],
    ['cmd /k dir', 'cmd', '/k'],
    ['sh -c "cat /etc/passwd"', 'sh', '-c'],
    ['bash -c "ls"', 'bash', '-c'],
    ['zsh -c "ls"', 'zsh', '-c'],
    ['perl -e "print 1"', 'perl', '-e'],
    ['ruby -e "puts 1"', 'ruby', '-e'],
    ['php -r "echo 1;"', 'php', '-r'],
    ['lua -e "print(1)"', 'lua', '-e'],
    ['luajit -e "print(1)"', 'luajit', '-e'],
    ['Rscript -e "print(1)"', 'rscript', '-e'],
    ['bun -e "console.log(1)"', 'bun', '-e'],
    ['deno eval "console.log(1)"', 'deno', 'eval'],
    // A full path resolves to the same interpreter as the bare name.
    // portability-check:allow — 同样是数据：带盘符的完整路径正是要认出来的形状之一（而且它一旦被
    // 当成真调用执行，写的也是 "C:/Program Files" 这种只该出现在 Windows 上的位置）。
    ['"C:/Program Files/nodejs/node.exe" -e "console.log(1)"', 'node', '-e'],
    // An environment assignment in front does not hide the command.
    ['NODE_ENV=test node -e "console.log(1)"', 'node', '-e'],
    // Case: PowerShell flags are case-insensitive on the command line.
    ['PowerShell -command "Get-Date"', 'powershell', '-command'],
  ];

  for (const [command, interpreter, flag] of CASES) {
    it(`认得出来：${command}`, () => {
      const hit = detectInlineCodeExecution(command);
      assert.ok(hit, `应识别为任意代码执行: ${command}`);
      assert.equal(hit.interpreter, interpreter);
      assert.equal(hit.flag.toLowerCase(), flag.toLowerCase());
    });
  }

  /*
   * The negative half, which is the half that keeps this usable.
   *
   * A check that fires on `echo "node -e x"` refuses nothing and teaches people to ignore the line.
   */
  const NEGATIVES = [
    'node script.js',
    'node --test',
    'node --version',
    'npm run build',
    'python script.py',
    'git log --oneline -n 10',
    'git -c core.autocrlf=false status',
    'npm test -c',
    'echo "node -e hello"',
    'grep -e "node -e" file.txt',
    'cat package.json',
    'ls -c',
  ];

  for (const command of NEGATIVES) {
    it(`不误报：${command}`, () => {
      assert.equal(detectInlineCodeExecution(command), null, `不应识别为任意代码执行: ${command}`);
    });
  }

  it('链式命令里任何一段都算（只报第一段等于漏报）', () => {
    const hit = detectInlineCodeExecution('echo ok && node -e "console.log(1)"');
    assert.ok(hit, '&& 后面的 node -e 也必须被看到');
    assert.equal(hit.interpreter, 'node');
  });

  it('引号里的同类文本不是子进程', () => {
    assert.equal(detectInlineCodeExecution('echo "sh -c whoami"'), null);
  });

  it('识别结果带上命中的那一段，供人核对', () => {
    const hit = detectInlineCodeExecution('npm run build && python -c "import os"');
    assert.ok(hit);
    assert.match(hit.segment, /python -c/);
  });
});

describe('披露：这是一条只能说明、不能靠文本拦住的边界', () => {
  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * THE GAP, PINNED
   *
   * This is the one test that documents a LIMITATION instead of a guarantee, and it is here on
   * purpose: the whole design follows from it. If the jail ever learns to see inside code strings,
   * this fails — and that failure is the signal to delete the disclosure path rather than keep
   * telling the reader about a hole that is closed.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  it('【关键】路径检查看不见代码字符串里的越界路径', () => {
    // portability-check:allow — 这条命令是断言里的**标本**，只交给 workspaceEscapeReason 和
    // detectInlineCodeExecution 做纯字符串判断，永远不执行；`C:/definitely-outside` 存在的意义
    // 恰恰是「一个明显在工作区外的路径」，写成相对路径就测不出这条限制了。
    const command = 'node -e "require(\'fs\').writeFileSync(\'C:/definitely-outside/x\',\'1\')"';
    assert.equal(
      workspaceEscapeReason(command, tempDir),
      null,
      '这条命令目前是放行的 —— 所以活干完后必须明说子进程不受约束，而不是宣称沙箱拦住了它',
    );
    assert.ok(detectInlineCodeExecution(command), '放行不等于不报告');
  });

  it('披露文案说清楚三件事：跑了 / 没被路径约束 / 真隔离是什么', () => {
    const text = codeExecutionDisclosure({ interpreter: 'node', flag: '-e', segment: 'node -e "x"' });
    assert.match(text, /任意代码执行/);
    assert.match(text, /node -e/);
    assert.match(text, /不受工作区边界约束/);
    assert.match(text, /4\.2|WSL2|Docker/);
    // It must NOT read as a refusal: the command ran.
    assert.doesNotMatch(text, /DENIED|已拒绝|被拦/);
  });
});

describe('前台执行：结果里带着这条事实', () => {
  it('node -e 照常运行，且结果标注了它', async () => {
    const r = await shell.exec('node -e "console.log(1)"');
    assert.equal(r.stdout.trim(), '1', '命令本身必须照常执行');
    assert.equal(r.exitCode, 0);
    assert.ok(r.codeExecution, '结果必须带上 codeExecution');
    assert.equal(r.codeExecution.interpreter, 'node');
    assert.equal(r.codeExecution.flag, '-e');
  });

  it('普通命令不标注（否则这条说明就成了背景噪音）', async () => {
    const r = await shell.exec('node -v');
    assert.equal(r.codeExecution, undefined);
  });

  it('被白名单拒绝的命令不会被标注（它没跑）', async () => {
    const strict = new SandboxShell(tempDir, {
      allowedCommands: ['echo'],
      denyDestructiveByDefault: false,
    });
    const r = await strict.exec('node -e "console.log(1)"');
    assert.equal(r.denied, true);
    assert.equal(r.codeExecution, undefined, '拒绝的命令没有「子进程不受约束」这回事');
  });

  it('工具层的回执里能读到这句披露', async () => {
    const out = await tools.execute('shell', { command: 'node -e "console.log(2)"' });
    assert.match(out, /任意代码执行/);
    assert.match(out, /node -e/);
    assert.match(out, /exit code: 0/);
  });

  it('普通命令的回执里没有这句披露', async () => {
    const out = await tools.execute('shell', { command: 'node -v' });
    assert.doesNotMatch(out, /任意代码执行/);
  });
});

describe('后台任务：这一事实在每一次读回都在', () => {
  it('【关键】后台启动、等待、读回，三次都带着标注', async () => {
    /*
     * `setTimeout` keeps the process alive briefly, so this is a real job that ends by itself — the
     * test does not have to kill anything, and nothing is left running.
     */
    const started = await shell.startJob('node -e "setTimeout(()=>console.log(\'done\'),150)"');
    assert.ok(started.ok, '后台启动应成功');
    if (!started.ok) return;
    const id = started.job.id;
    assert.ok(started.job.codeExecution, '启动回执里就要有');

    const view = await shell.waitJob(id, { waitMs: 20_000 });
    assert.equal(view.status, 'done');
    assert.ok(view.codeExecution, '等待回执里也要有');
    assert.equal(view.codeExecution.interpreter, 'node');

    // And through the tools, where the reader actually sees it.
    const started2 = await tools.execute('shell', {
      command: 'node -e "setTimeout(()=>{},200)"',
      background: true,
    });
    const id2 = /job_id=(job_\d+)/.exec(started2)?.[1];
    assert.ok(id2, `应返回 job_id: ${started2}`);
    assert.match(started2, /任意代码执行/, '后台启动回执要有披露');

    const waited = await tools.execute('shell_wait', { id: id2, wait_ms: 20_000 });
    assert.match(waited, /任意代码执行/, '等它结束时也要再说一遍');
  });
});

describe('既有的路径拦截没有被这条新检查影响', () => {
  /*
   * 这一段原来断言"`cd C:\` 一律被拒"，并注明"既有的路径拦截没被影响"。第二轮返工后，这个断言
   * 本身成了要改的东西 —— 它把两件事绑在了一起：
   *
   *   路径拦截（这条命令有没有出去）      ← 仍然成立，下面第一条继续测
   *   出去之后怎么办（拒 / 问人 / 放行）  ← 现在由四档策略决定，不再是无条件拒
   *
   * 旧行为在实测里两个方向都出过错（V17）：开「允许所有命令」时字面越界照拒（该放没放），
   * 关的时候间接越界照跑（该问没问）。所以这里按档位分开测，而不是继续测"一律拒"。
   */
  it('默认（未勾选工作区外）档：越界命令仍被拒', async () => {
    const strict = new SandboxShell(tempDir);
    const r = await strict.exec('cd C:\\');
    assert.equal(r.denied, true);
    assert.match(r.stderr, /DENIED/);
    assert.equal(r.codeExecution, undefined, '被拒的命令没有子进程');
  });

  it('「所有」档：越界命令不再被拒（用户明确选过不在乎边界）', async () => {
    const r = await shell.exec('cd C:\\');
    assert.notEqual(r.denied, true, `「所有」档下不该再拒: ${r.stderr}`);
  });

  it('只读档：越界**写**仍然进不来，越界只读可以（阅读类不看位置）', async () => {
    const ro = new SandboxShell(tempDir, {
      outsideWorkspace: { allow: true, policy: 'readonly' },
    });
    // 指向一个不存在的目录：万一守卫没拦住，这条命令自己也会失败，不会真在 C: 根上留下文件。
    const write = await ro.exec('echo x > C:\\__she_probe_no_such_dir__\\x.txt');
    assert.equal(write.denied, true, '越界写在只读档下没被拦住');

    // 读越界则放行：规则是阅读类不限制位置，`type` 在不写东西的动词表里。
    const read = await ro.exec('type C:\\Windows\\win.ini');
    assert.notEqual(read.denied, true, `越界只读被误拦: ${read.stderr}`);
  });

  it('写进工作区里的普通命令不受影响', async () => {
    await writeFile(join(tempDir, 'probe.txt'), 'x', 'utf8');
    const r = await tools.execute('fs_read', { path: 'probe.txt' });
    assert.equal(r, 'x');
  });
});
