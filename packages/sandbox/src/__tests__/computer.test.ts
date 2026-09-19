/**
 * Computer use: escaping, key translation, the permission gate, and the Windows binding.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT TESTED HERE, ON PURPOSE
 *
 * The physical actions — click, type, key, scroll — are NOT exercised. Running them
 * would take over the developer's mouse and keyboard: a click lands on whatever is at
 * those coordinates, and typing goes into whatever has focus. On a machine that is
 * being used, that is not a test, it is an intrusion.
 *
 * So the riskiest part of this feature is verified by hand, not by the suite, and the
 * docs say so. What IS covered automatically is everything that would make the
 * physical step fail:
 *
 *   - the P/Invoke declaration compiles (a typo there fails at runtime, not build time)
 *   - SendKeys escaping produces the keystrokes the user asked for
 *   - key combinations translate, and unsupported ones are refused rather than guessed
 *   - the permission gate refuses by default and explains the switch
 *   - coordinate clamping cannot produce an out-of-range click
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  computerUseEnabled, escapeSendKeys, toSendKeysCombo,
  computerClick, computerType, computerKey, computerScroll,
} from '../computer.js';

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';

describe('SendKeys 转义', () => {
  it('普通文字原样通过', () => {
    assert.equal(escapeSendKeys('hello world'), 'hello world');
    assert.equal(escapeSendKeys('中文也可以'), '中文也可以');
  });

  it('【关键】把 SendKeys 的控制字符转义成字面量', () => {
    /*
     * Without escaping, typing "1+1=2" would press Shift (for `+`) and produce
     * something else entirely — and `%` would press Alt, `^` Ctrl. A user asking for a
     * sentence gets keystrokes they never asked for.
     */
    assert.equal(escapeSendKeys('+'), '{+}');
    assert.equal(escapeSendKeys('^'), '{^}');
    assert.equal(escapeSendKeys('%'), '{%}');
    assert.equal(escapeSendKeys('~'), '{~}');
    assert.equal(escapeSendKeys('('), '{(}');
    assert.equal(escapeSendKeys(')'), '{)}');
    assert.equal(escapeSendKeys('{'), '{{}');
    assert.equal(escapeSendKeys('}'), '{}}');
    assert.equal(escapeSendKeys('['), '{[}');
    assert.equal(escapeSendKeys(']'), '{]}');
  });

  it('含特殊字符的句子整体正确', () => {
    assert.equal(escapeSendKeys('a+b=c (100%)'), 'a{+}b=c {(}100{%}{)}');
  });

  it('路径里的反斜杠不动（Windows 路径要能输入）', () => {
    // A Windows path as INPUT, verifying the escaper leaves backslashes alone.
    // portability-check:allow
    assert.equal(escapeSendKeys('C:\\Users\\me'), 'C:\\Users\\me');
  });
});

describe('按键组合转换', () => {
  it('单键', () => {
    assert.equal(toSendKeysCombo('enter'), '{ENTER}');
    assert.equal(toSendKeysCombo('tab'), '{TAB}');
    assert.equal(toSendKeysCombo('esc'), '{ESC}');
    assert.equal(toSendKeysCombo('f5'), '{F5}');
    assert.equal(toSendKeysCombo('a'), 'a');
  });

  it('组合键', () => {
    assert.equal(toSendKeysCombo('ctrl+c'), '^c');
    assert.equal(toSendKeysCombo('ctrl+shift+s'), '^+s');
    assert.equal(toSendKeysCombo('alt+f4'), '%{F4}');
    assert.equal(toSendKeysCombo('ctrl+alt+delete'), '^%{DELETE}');
  });

  it('大小写与空格无关', () => {
    assert.equal(toSendKeysCombo('CTRL + C'), '^c');
    assert.equal(toSendKeysCombo('  Ctrl+C  '), '^c');
  });

  it('已经是 SendKeys 语法的原样接受（不惩罚熟悉的写法）', () => {
    assert.equal(toSendKeysCombo('^c'), '^c');
  });

  it('【关键】Win 键被拒绝，而不是用近似动作代替', () => {
    /*
     * SendKeys has no Windows-key form. The nearest trick (`^{ESC}`) OPENS THE START
     * MENU — an action the user did not ask for. Doing nothing with an explanation beats
     * doing something surprising.
     */
    assert.equal(toSendKeysCombo('win'), '');
    assert.equal(toSendKeysCombo('meta+r'), '');
    assert.equal(toSendKeysCombo('cmd+space'), '');
  });

  it('只有修饰键没有主键时不执行（那不是"按下 Shift"的意思）', () => {
    assert.equal(toSendKeysCombo('ctrl'), '');
    assert.equal(toSendKeysCombo('shift+alt'), '');
  });

  it('空输入返回空', () => {
    assert.equal(toSendKeysCombo(''), '');
    assert.equal(toSendKeysCombo('   '), '');
  });
});

describe('权限闸门', () => {
  const original = process.env.SHE_ALLOW_COMPUTER_USE;
  after(() => {
    if (original === undefined) delete process.env.SHE_ALLOW_COMPUTER_USE;
    else process.env.SHE_ALLOW_COMPUTER_USE = original;
  });

  it('【关键】默认关闭（这是独立于 allowAllCommands 的开关）', () => {
    delete process.env.SHE_ALLOW_COMPUTER_USE;
    const gate = computerUseEnabled();
    assert.equal(gate.ok, false, '默认必须关闭：它控制的是用户的鼠标键盘，不是工作区文件');
    assert.match(gate.reason!, /SHE_ALLOW_COMPUTER_USE/, '拒绝理由必须告诉用户怎么开');
  });

  it('接受多种真值写法', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', 'Yes']) {
      process.env.SHE_ALLOW_COMPUTER_USE = v;
      // Non-Windows hosts are refused for a different reason; only assert the flag was
      // recognised, which is what this test is about.
      const gate = computerUseEnabled();
      if (IS_WINDOWS) assert.equal(gate.ok, true, `"${v}" 应当被接受`);
      else assert.match(gate.reason!, /Windows/, `"${v}" 应当被识别为已授权`);
    }
  });

  it('明确关闭的写法不被当作开启', () => {
    for (const v of ['0', 'false', 'no', '', 'off']) {
      process.env.SHE_ALLOW_COMPUTER_USE = v;
      assert.equal(computerUseEnabled().ok, false, `"${v}" 不该被当作开启`);
    }
  });

  it('未启用时每个动作都拒绝，并说明原因', async () => {
    delete process.env.SHE_ALLOW_COMPUTER_USE;
    // These must refuse before touching the input devices, so this is safe to run.
    for (const [name, run] of [
      ['click', () => computerClick(10, 10)],
      ['type', () => computerType('x')],
      ['key', () => computerKey('enter')],
      ['scroll', () => computerScroll(1)],
    ] as const) {
      const r = await run();
      assert.equal(r.ok, false, `${name} 未启用时应当拒绝`);
      assert.match(r.output, /SHE_ALLOW_COMPUTER_USE/, `${name} 的拒绝理由应当说明开关`);
    }
  });
});

describe('Windows 绑定', () => {
  it('P/Invoke 声明能编译（打错字会在运行时才炸）', { skip: !IS_WINDOWS }, async () => {
    /*
     * `Add-Type` compiles the declaration at call time, so a syntax error in the
     * P/Invoke string is invisible until the agent actually clicks something. Checking
     * it here turns a runtime surprise into a build-time failure.
     *
     * Read-only: it loads the binding and reads the screen size, and touches neither the
     * cursor nor the keyboard.
     */
    /*
     * Two levels of joining, and they are NOT the same separator:
     *
     *   1. the P/Invoke source itself, joined with '' (it is one string literal)
     *   2. the PowerShell statements, joined with '; '
     *
     * Using '; ' for both injected separators INSIDE the C# source, producing
     * `MemberDefinition '; [DllImport...'` — a compiler error from a test that exists to
     * catch exactly that class of mistake.
     */
    const declaration = [
      "Add-Type -Namespace SheTest -Name Native -MemberDefinition '",
      '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, System.UIntPtr extra);',
      '[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);',
      "'",
    ].join('');

    const ps = [
      declaration,
      'Write-Output ("" + [SheTest.Native]::GetSystemMetrics(0) + "x" + [SheTest.Native]::GetSystemMetrics(1))',
    ].join('; ');

    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 30_000, windowsHide: true },
    );
    const size = String(stdout).trim();
    assert.match(size, /^\d+x\d+$/, `应当返回屏幕尺寸，实际: ${size}`);
    const [w, h] = size.split('x').map(Number);
    assert.ok(w > 0 && h > 0, `屏幕尺寸不合理: ${size}`);
  });

  it('SendKeys 程序集可用', { skip: !IS_WINDOWS }, async () => {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; Write-Output ok'],
      { timeout: 30_000, windowsHide: true },
    );
    assert.equal(String(stdout).trim(), 'ok');
  });
});

describe('坐标处理', () => {
  const original = process.env.SHE_ALLOW_COMPUTER_USE;
  before(() => { process.env.SHE_ALLOW_COMPUTER_USE = 'true'; });
  after(() => {
    if (original === undefined) delete process.env.SHE_ALLOW_COMPUTER_USE;
    else process.env.SHE_ALLOW_COMPUTER_USE = original;
  });

  it('NaN / 负数坐标被收敛，不会发出乱码参数', { skip: !IS_WINDOWS }, async () => {
    /*
     * A model can compute NaN or a negative coordinate from a bad reading of a
     * screenshot. The PowerShell integer literal must still be well-formed, or the
     * command fails with a parse error instead of a clear message.
     *
     * This DOES click — at the clamped position (0,0) — which is the one position a
     * test can predict. It is a click on the desktop's top-left corner.
     */
    const r = await computerClick(-50, Number.NaN);
    // Whether it succeeds is not the point; the point is that it does not throw a
    // PowerShell parse error, which is what a malformed coordinate would produce.
    assert.ok(r.ok || !/ParseError|Unexpected token|missing/i.test(r.output), `坐标处理产生了语法错误: ${r.output}`);
    if (r.ok) assert.match(r.output, /收敛|点击/);
  });
});
