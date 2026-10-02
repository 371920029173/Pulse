/**
 * 命令是按哪个 shell 的语法跑的：**说在前面**（工具描述）与**错也说清**（结果里报出差异）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * 第四轮评测 3a / 3b，两条扣分说的是同一件事的两半：
 *
 *   3a  只有 cmd.exe，POSIX 静默走样 —— 模型按习惯写 POSIX，命令**跑了、退出码 0**，但意思变了。
 *   3b  工具描述没标 shell 类型 —— 模型没法为一个没被告知的 shell 写命令。
 *
 * 这两半必须一起修，缺一半都还有洞：
 *
 *   只做 3b（描述里说清）  → 说过之后仍可能写错，错了没人提 —— 静默照旧。
 *   只做 3a（错了再报）    → 每一次错都要先付一次"命令白跑"的代价。
 *
 * 所以本文件两个方向都钉住：描述里有 shell 名（3b），结果里有差异（3a）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 这个文件刻意**不**断言"被拒绝"
 *
 * 方言差异不是安全问题，是理解问题。`echo $HOME` 在 cmd.exe 里会打印字面 `$HOME`，那是 cmd 的
 * 正确行为 —— 要说的是"跑的不是你写的那条"，不是"不许这么写"。谁把它改成拒绝，谁就在逼使用者
 * 把命令藏起来（`node -e` 那次的教训），所以下面有一条断言专门盯着披露文案**不能**读成拒绝。
 *
 *   node --import tsx --test src/__tests__/shell-dialect.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SandboxShell, detectShellDialectMismatch, shellDialectDisclosure } from '../shell.js';
import { createTools } from '../tools.js';

let tempDir: string;

/**
 * `cmd.exe` 在这个文件里只是**被测数据** —— 差异表的字面文本、被断言的回执字段、跳过一个平台分支
 * 时的说明。这里不 spawn 任何 Windows 专有命令，所以那个名字集中成一个常量，既让"这是数据"一眼可见，
 * 也不必让 `check:portability` 在每一处字面量上都要求一个平台分支。
 */
// portability-check:allow — 这是被测数据的名字（标题、断言值），不是要执行的命令
const CMD = 'cmd.exe';
let shell: SandboxShell;
let tools: ReturnType<typeof createTools>;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'she-dialect-test-'));
  shell = new SandboxShell(tempDir, { allowAllCommands: true, denyDestructiveByDefault: false });
  tools = createTools(shell, tempDir, { allowAllCommands: true });
});

/** 见 `background.test.ts`：清理失败要报告，不要抛出把整个用例判红。 */
async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch (err) {
    console.warn(`[shell-dialect.test] 临时目录没删掉，留给 check:temp: ${dir} (${(err as Error).message})`);
  }
}

after(async () => {
  await shell.stopAll();
  await cleanupTempDir(tempDir);
});

describe(`识别：POSIX 写法在 ${CMD} 里不是那个意思`, () => {
  /*
   * 每行是 [命令, 期望被点名的构造]。期望值是**读者会看到的那句话的主语**，写错就等于在回执里
   * 指错了地方。
   */
  const CASES: Array<[string, string]> = [
    ['echo $(date)', '$(…)'],
    ['echo `date`', '`…`（反引号）'],
    ['echo ${HOME}', '${VAR} / $VAR'],
    ['echo $HOME', '${VAR} / $VAR'],
    ["cp 'a b.txt' out.txt", "'单引号'"],
    ['cd ~/project', '~/'],
    ['NODE_ENV=test node -v', 'VAR=value 前缀'],
    ['curl http://x 2>/dev/null', '/dev/null'],
    ['# just a note', '# 注释'],
  ];

  for (const [command, construct] of CASES) {
    it(`点得出来：${command}`, () => {
      const gaps = detectShellDialectMismatch(command);
      assert.ok(
        gaps.some((g) => g.construct === construct),
        `应点名 ${construct}，实际：${gaps.map((g) => g.construct).join(' / ') || '(空)'}`,
      );
    });
  }

  /*
   * 反面：cmd.exe 自己就认的写法不能被点名。
   *
   * 一个乱报的检查比没有检查更坏 —— 每一条真差异旁边都跟着三条假差异，读者会把整段跳过，
   * 而那正是 3a 要终结的"静默"。
   */
  const NEGATIVES = [
    'node -v',
    'echo %USERPROFILE%',
    'dir /b',
    'git commit -m "fix the thing"',
    'copy a.txt b.txt',
    'npm run build && npm test',
    'type C:\\Windows\\win.ini',
    'echo 你好',
  ];

  for (const command of NEGATIVES) {
    it(`不误报：${command}`, () => {
      assert.deepEqual(detectShellDialectMismatch(command), [], `不该有点名: ${command}`);
    });
  }

  it('每类只报一次，且最多三条（点名错误，不是清点错误）', () => {
    const gaps = detectShellDialectMismatch('echo ${A} $B $(c) `d` ~/e /dev/null # f');
    assert.ok(gaps.length <= 3, `最多三条，实际 ${gaps.length}`);
    assert.equal(new Set(gaps.map((g) => g.construct)).size, gaps.length, '同一类不该出现两次');
  });

  it('链式命令里每一段都看过（只看第一段等于漏报）', () => {
    const gaps = detectShellDialectMismatch('echo ok && echo ${HOME}');
    assert.ok(gaps.some((g) => g.construct === '${VAR} / $VAR'), '&& 后面那段也必须看到');
  });

  /*
   * 另一种语言的地盘不越权：`node -e "a${b}c"` 里那个 `${b}` 是 JS 模板字符串，
   * `powershell -Command "$(Get-Date)"` 里那个 `$(…)` 是 PowerShell 自己的替换 —— 都是**对的**写法，
   * 报出来只会教人忽略这段提示。
   */
  it('交给别的解释器的程序文本不报（那是它的语言，不是 cmd 的）', () => {
    assert.deepEqual(detectShellDialectMismatch('node -e "console.log(`${a}b`)"'), []);
    assert.deepEqual(detectShellDialectMismatch('powershell -Command "Write-Host $(Get-Date)"'), []);
    assert.deepEqual(detectShellDialectMismatch('sh -c "echo $HOME"'), []);
  });

  /*
   * 例外：`cmd /c "…"` 里面的程序**仍然是 cmd.exe 的文本**，不属于"别的语言"。
   * 这里放手不报，就等于"套一层 cmd /c"成了让提示消失的办法。
   */
  it('嵌套 cmd 的程序文本照报（它还是 cmd 的语法）', () => {
    const gaps = detectShellDialectMismatch('cmd /c "echo ${HOME}"');
    assert.ok(gaps.some((g) => g.construct === '${VAR} / $VAR'), 'cmd /c 里的 ${HOME} 也是错的');
  });
});

describe('披露文案：说清是"跑错了"而不是"被拦了"', () => {
  it('三件事都在：哪个 shell / 哪处不对 / 该写什么', () => {
    const text = shellDialectDisclosure({
      shell: CMD,
      dialect: 'cmd',
      gaps: [{
        construct: '${VAR} / $VAR',
        behavior: CMD + ' 取环境变量用 %VAR%，`$VAR` 是字面文本',
        instead: '写成 %VAR%',
      }],
    });
    assert.match(text, /shell 方言/);
    assert.match(text, /cmd\.exe/);
    assert.match(text, /\$\{VAR\}/);
    assert.match(text, /%VAR%/);
  });

  it('不能读成拒绝：命令跑了（否则读者会重跑一遍同样错的命令）', () => {
    const text = shellDialectDisclosure({
      shell: CMD,
      dialect: 'cmd',
      gaps: [{ construct: '~/', behavior: 'x', instead: 'y' }],
    });
    assert.match(text, /命令跑了/);
    assert.doesNotMatch(text, /DENIED|已拒绝|被拦|禁止/);
  });
});

describe('工具描述：先把 shell 名字说出来（3b）', () => {
  it('描述里点名了真正会解析命令的那个 shell', () => {
    const def = tools.definitions.find((d) => d.name === 'shell');
    assert.ok(def, 'shell 工具必须存在');
    assert.ok(
      def.description.includes(shell.shellName()),
      `描述里应出现 ${shell.shellName()}：${def.description.slice(0, 120)}…`,
    );
  });

  it(`${CMD} 档位下，差异逐条写在描述里（写之前就知道，而不是错了才知道）`, () => {
    if (shell.dialect() !== 'cmd') return; // POSIX 机器上这一段不适用
    const def = tools.definitions.find((d) => d.name === 'shell')!;
    for (const marker of ['%VAR%', '$(…)', '单引号', '%USERPROFILE%', 'nul', 'rem']) {
      assert.ok(def.description.includes(marker), `描述里应说明 ${marker}`);
    }
  });

  /*
   * 替身（只实现 `exec` / `validatePath` 的测试桩，见 `injection.test.ts`）不是沙箱，
   * 描述里就不该有"命令由某某解析"这句 —— 编一个方言等于在描述里写一句没人能核对的话。
   * 这一条同时是回归：工具集不能在构造阶段因为一个不认识 `shellName` 的壳而抛。
   */
  it('拿不到 shell 名时不猜（替身不导致构造失败，也不写一句编的话）', () => {
    const stub = createTools(
      {
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 0 }),
        validatePath: (p: string) => p,
        root: tempDir,
      } as unknown as SandboxShell,
      tempDir,
      { allowAllCommands: true },
    );
    const def = stub.definitions.find((d) => d.name === 'shell')!;
    assert.doesNotMatch(def.description, /命令由/, `替身上不该有方言说明：${def.description.slice(-80)}`);
  });
});

describe('真实回执：命令跑了、退出码 0，差异被点出来（3a）', () => {
  it('【关键】POSIX 写法不是失败，是"跑的不是你写的那条"', async (t) => {
    if (shell.dialect() !== 'cmd') {
      t.skip(`本机 shell 不是 ${CMD}，这条差异不存在`);
      return;
    }
    /*
     * 这一条是 3a 的全部要害：**没有报错、退出码 0、输出看起来像回事**。断言"退出码 0"不是在
     * 断言 bug —— 那正是这类失败最难被发现的原因，写成断言是为了让它以后也不变。
     */
    const r = await shell.exec('echo $HOME');
    assert.equal(r.exitCode, 0, `${CMD} 认为它成功了`);
    assert.match(r.stdout, /\$HOME/, `${CMD} 把 $HOME 原样打印出来（这就是"静默"）`);
    assert.ok(r.shellDialect, '结果必须带上方言报告');
    assert.equal(r.shellDialect.shell, CMD);
    assert.equal(r.shellDialect.dialect, 'cmd');
    assert.ok(r.shellDialect.gaps.some((g) => g.construct === '${VAR} / $VAR'));
  });

  it('工具回执里能读到这段说明，且不说命令失败', async (t) => {
    if (shell.dialect() !== 'cmd') {
      t.skip(`本机 shell 不是 ${CMD}`);
      return;
    }
    const out = await tools.execute('shell', { command: 'echo ${HOME}' });
    assert.match(out, /shell 方言/);
    assert.match(out, /%VAR%/);
    assert.match(out, /exit code: 0/);
    assert.doesNotMatch(out, /DENIED/);
  });

  it('写对了就不吭声（这条说明只有在真有差异时才该花 token）', async () => {
    const r = await shell.exec(shell.dialect() === 'cmd' ? 'echo %USERPROFILE%' : 'echo $HOME');
    assert.equal(r.exitCode, 0);
    assert.equal(r.shellDialect, undefined, '没有差异就不该附报告');
    const out = await tools.execute('shell', { command: 'node -v' });
    assert.doesNotMatch(out, /shell 方言/, '普通命令的回执里没有这段');
  });
});

describe('后台任务：换一个回执读回来，这条说明还在', () => {
  it('【关键】启动与后续 shell_wait 都带着方言报告', async (t) => {
    if (shell.dialect() !== 'cmd') {
      t.skip(`本机 shell 不是 ${CMD}`);
      return;
    }
    /*
     * 与 `codeExecution` 同样的理由：读回任务的是一个"没有上文"的新回执，而"你写的命令和你正在等的
     * 命令不是同一条"这件事，晚一步知道就等于不知道。报告挂在进程上，所以两个视图口径一致。
     */
    const started = await shell.startJob('echo ${HOME} && node -e "setTimeout(()=>{},200)"');
    assert.ok(started.ok, '后台启动应成功');
    if (!started.ok) return;
    assert.ok(started.job.shellDialect, '启动回执里就要有');

    const view = await shell.waitJob(started.job.id, { waitMs: 20_000 });
    assert.ok(view.shellDialect, '等待回执里也要有');
    assert.equal(view.shellDialect.shell, CMD);

    const out = await tools.execute('shell', { command: 'echo ${HOME}', background: true });
    assert.match(out, /shell 方言/, '后台启动的工具回执要有披露');
  });
});

describe('判据不受影响：方言检查不改变放行与否', () => {
  it('被拒的命令不会带上方言报告（它没跑）', async () => {
    const strict = new SandboxShell(tempDir, {
      allowedCommands: ['echo'],
      denyDestructiveByDefault: false,
    });
    const r = await strict.exec('cd C:\\ && echo ${HOME}');
    assert.equal(r.denied, true);
    assert.equal(r.shellDialect, undefined, '没跑的命令没有"跑错了"这回事');
  });

  it('方言检查不看路径，越界判定一点都不松', async () => {
    const strict = new SandboxShell(tempDir);
    const r = await strict.exec('echo ${HOME} > C:\\__she_probe_no_such_dir__\\x.txt');
    assert.equal(r.denied, true, '越界写仍然被拒 —— 这条检查不是用来放松边界的');
  });
});
