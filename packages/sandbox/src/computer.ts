/**
 * Computer use: driving the mouse and keyboard.
 *
 * The `screenshot` tool already lets the agent SEE the desktop; these let it act. That
 * is the difference between "the agent can tell you what is on screen" and "the agent
 * can operate a system that has no API" — the legacy-software case, which is the only
 * part of the S-tier list this project was missing entirely.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS OFF BY DEFAULT, INDEPENDENTLY OF `allowAllCommands`
 *
 * `allowAllCommands` answers "may the agent run shell commands without asking?".
 * That question is about the WORKSPACE: it is scoped (in intent) to files the user
 * pointed the agent at.
 *
 * "May the agent move my mouse and type into whatever has focus?" is a different
 * question with a different blast radius. The agent cannot see the boundary of the
 * screen: a stray click sequence can reach a banking tab, an email client, a password
 * prompt. Granting shell-in-workspace implicitly is defensible; granting control of
 * the physical input devices implicitly is not.
 *
 * So it needs `SHE_ALLOW_COMPUTER_USE=true` as well. Two independent grants, both
 * explicit, matching the two different risks.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Tools are still marked `isDangerous`, so with computer use enabled but
 * `allowAllCommands` off, every action still asks for confirmation. The strongest
 * setting requires two separate opt-ins.
 *
 * Windows only. The macOS/Linux paths are reported as unavailable rather than
 * silently doing nothing — an input tool that claims success while doing nothing is
 * worse than one that says it cannot.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** True when the platform can drive input, and the user has enabled it. */
export function computerUseEnabled(): { ok: boolean; reason?: string } {
  const flag = (process.env.SHE_ALLOW_COMPUTER_USE ?? '').trim().toLowerCase();
  const granted = flag === '1' || flag === 'true' || flag === 'yes';
  if (!granted) {
    return {
      ok: false,
      reason:
        '计算机操作未启用。这是独立于「允许所有命令」的开关，因为它控制的不是工作区内的文件，'
        + '而是你的鼠标和键盘（能到达屏幕上任何窗口）。'
        + '确实需要时设 SHE_ALLOW_COMPUTER_USE=true 后重启服务。',
    };
  }
  if (process.platform !== 'win32') {
    return { ok: false, reason: '计算机操作目前仅支持 Windows。' };
  }
  return { ok: true };
}

/* ─── PowerShell generation ─── */

/**
 * P/Invoke declarations, loaded once per invocation.
 *
 * `Add-Type` compiles on every call, which costs ~200ms. Acceptable for an action
 * taken occasionally, and it avoids keeping a helper process alive just to hold the
 * binding.
 */
const WIN32 = [
  "Add-Type -Namespace She -Name Native -MemberDefinition '",
  '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, System.UIntPtr extra);',
  '[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);',
  "'",
].join('');

/** Screen size, so callers can express coordinates as fractions and stay valid. */
const SCREEN_SIZE =
  'Write-Output ("" + [She.Native]::GetSystemMetrics(0) + "x" + [She.Native]::GetSystemMetrics(1))';

const MOUSE = {
  leftDown: '0x0002',
  leftUp: '0x0004',
  rightDown: '0x0008',
  rightUp: '0x0010',
  wheel: '0x0800',
} as const;

/** Quote a string for a PowerShell single-quoted literal. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Escape SendKeys metacharacters.
 *
 * `[System.Windows.Forms.SendKeys]::SendWait` treats `+ ^ % ~ ( ) { } [ ]` as control
 * characters, so typing a sentence containing any of them would produce keystrokes the
 * user never asked for — `+` means Shift, `%` means Alt. Wrapping each in braces makes
 * it literal.
 *
 * Doing it here rather than asking the model to remember means a normal sentence types
 * as written.
 */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}

/**
 * Translate a friendly key combination into SendKeys syntax.
 *
 * `ctrl+shift+s` → `^+s`. SendKeys syntax is accepted unchanged, so a model that
 * already writes `^c` is not penalised.
 *
 * `win` is rejected rather than approximated: SendKeys has no Windows-key form, and the
 * nearest trick (`^{ESC}`) opens the Start menu — an action the user did not ask for.
 * Doing nothing with an explanation beats doing something surprising.
 */
export function toSendKeysCombo(combo: string): string {
  const raw = combo.trim();
  if (!raw) return '';

  /*
   * Already SendKeys syntax? Pass it through unchanged.
   *
   * `^c` means Ctrl+C to anyone who knows the format, and escaping it would type a
   * literal caret followed by `c` — the opposite of the request. A model that knows
   * SendKeys should not be penalised for using it.
   *
   * `+` is deliberately NOT a trigger character: it is the separator in the friendly
   * form (`ctrl+c`), so treating it as a SendKeys marker would make every combination
   * pass through unparsed. The unambiguous markers are the rest, plus a leading `+`
   * (which only SendKeys writes, as Shift).
   */
  if (/[\^%~(){}\[\]]/.test(raw) || raw.startsWith('+')) {
    // Still refuse the Windows key, which has no SendKeys form; its nearest trick opens
    // the Start menu, an action nobody asked for.
    if (/\b(win|meta|cmd|super)\b/i.test(raw)) return '';
    return raw;
  }

  const parts = raw.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);

  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') modifiers.push('^');
    else if (p === 'shift') modifiers.push('+');
    else if (p === 'alt') modifiers.push('%');
    else if (p === 'win' || p === 'meta' || p === 'cmd' || p === 'super') return '';
    else keys.push(p);
  }

  const named: Record<string, string> = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
    space: ' ', backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
    insert: '{INSERT}', ins: '{INSERT}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
    f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
  };

  const keyPart = keys.map((k) => named[k] ?? escapeSendKeys(k)).join('');
  // A combination with modifiers but no key is a mistake, not a request to press Shift.
  if (keyPart === '' && modifiers.length > 0) return '';
  return modifiers.join('') + keyPart;
}

/* ─── Actions ─── */

export interface ComputerResult {
  ok: boolean;
  output: string;
}

/** Run a PowerShell snippet, returning its trimmed stdout. */
async function runPs(statements: string[]): Promise<string> {
  /*
   * Guarded here as well as in `computerUseEnabled`, deliberately.
   *
   * The caller checks first, but this function is the one that would actually spawn
   * `powershell.exe` — on a machine without it the failure would be a confusing spawn
   * error rather than a clear statement. A guard at the point of use is the one that
   * cannot be bypassed by a future caller.
   */
  if (process.platform !== 'win32') {
    throw new Error('计算机操作依赖 PowerShell，目前仅支持 Windows。');
  }
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', statements.join('; ')],
    { timeout: 20_000, windowsHide: true },
  );
  return String(stdout).trim();
}

/**
 * Clamp a coordinate to the screen.
 *
 * Exported so the arithmetic is testable without performing a click. A model that
 * computed an off-screen coordinate from a stale screenshot would otherwise have its
 * click land on whatever window happens to be at the clamped edge; clamping is
 * reported so the caller knows it happened. Non-finite input (NaN from a bad reading)
 * becomes 0 rather than producing a malformed PowerShell integer literal.
 */
export function clampToScreen(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), Math.max(0, max - 1)));
}

export async function computerClick(
  x: number,
  y: number,
  button: 'left' | 'right' = 'left',
): Promise<ComputerResult> {
  const gate = computerUseEnabled();
  if (!gate.ok) return { ok: false, output: gate.reason! };

  const size = await runPs([WIN32, SCREEN_SIZE]).catch(() => '');
  const [sw, sh] = size.split('x').map((n) => Number(n) || 0);
  const cx = clampToScreen(x, sw || 100000);
  const cy = clampToScreen(y, sh || 100000);
  const clamped = sw > 0 && (cx !== Math.floor(x) || cy !== Math.floor(y));

  const down = button === 'right' ? MOUSE.rightDown : MOUSE.leftDown;
  const up = button === 'right' ? MOUSE.rightUp : MOUSE.leftUp;

  try {
    await runPs([
      WIN32,
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})`,
      // A short settle: some applications ignore a click that arrives in the same
      // tick as the move, because they track hover state.
      'Start-Sleep -Milliseconds 60',
      `[She.Native]::mouse_event(${down}, 0, 0, 0, [System.UIntPtr]::Zero)`,
      'Start-Sleep -Milliseconds 30',
      `[She.Native]::mouse_event(${up}, 0, 0, 0, [System.UIntPtr]::Zero)`,
      'Write-Output ok',
    ]);
    return {
      ok: true,
      output: clamped
        ? `已在 (${cx}, ${cy}) 点击（${button}）。原坐标超出屏幕 ${sw}x${sh}，已收敛。`
        : `已在 (${cx}, ${cy}) 点击（${button}）。屏幕尺寸 ${sw}x${sh}。`,
    };
  } catch (err) {
    return { ok: false, output: `点击失败: ${(err as Error).message}` };
  }
}

export async function computerType(text: string): Promise<ComputerResult> {
  const gate = computerUseEnabled();
  if (!gate.ok) return { ok: false, output: gate.reason! };
  if (!text) return { ok: false, output: '要输入的内容为空。' };

  try {
    await runPs([
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(escapeSendKeys(text))})`,
      'Write-Output ok',
    ]);
    return { ok: true, output: `已输入 ${text.length} 个字符。` };
  } catch (err) {
    return { ok: false, output: `输入失败: ${(err as Error).message}` };
  }
}

export async function computerKey(combo: string): Promise<ComputerResult> {
  const gate = computerUseEnabled();
  if (!gate.ok) return { ok: false, output: gate.reason! };

  const sequence = toSendKeysCombo(combo);
  if (!sequence) return { ok: false, output: `无法识别的按键: ${combo}` };

  try {
    await runPs([
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(sequence)})`,
      'Write-Output ok',
    ]);
    return { ok: true, output: `已按下 ${combo}。` };
  } catch (err) {
    return { ok: false, output: `按键失败: ${(err as Error).message}` };
  }
}

export async function computerScroll(amount: number): Promise<ComputerResult> {
  const gate = computerUseEnabled();
  if (!gate.ok) return { ok: false, output: gate.reason! };

  /*
   * Wheel events are in multiples of 120, and the sign is the direction. Rounding
   * rather than truncating so a small value like 0.5 still scrolls one notch instead
   * of doing nothing.
   */
  const notches = Math.sign(amount || 0) * Math.max(1, Math.round(Math.abs(amount)));
  const delta = notches * 120;

  try {
    await runPs([
      WIN32,
      `[She.Native]::mouse_event(${MOUSE.wheel}, 0, 0, ${delta}, [System.UIntPtr]::Zero)`,
      'Write-Output ok',
    ]);
    return { ok: true, output: `已滚动 ${notches} 格（${delta > 0 ? '向上' : '向下'}）。` };
  } catch (err) {
    return { ok: false, output: `滚动失败: ${(err as Error).message}` };
  }
}
