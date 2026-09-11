import { spawn } from 'node:child_process';
import { resolve, normalize } from 'node:path';
import { platform } from 'node:os';
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
    };
  }

  isDestructive(command: string): boolean {
    return DESTRUCTIVE_PATTERNS.some(p => p.test(command));
  }

  validatePath(requestedPath: string): string {
    const resolved = resolve(this.workspaceRoot, requestedPath);
    const normalizedResolved = normalize(resolved);
    const normalizedRoot = normalize(this.workspaceRoot);
    if (!normalizedResolved.startsWith(normalizedRoot)) {
      throw new Error(`Path escapes workspace: ${requestedPath}`);
    }
    return resolved;
  }

  async exec(command: string, options?: SandboxOptions): Promise<SandboxResult> {
    if (this.config.denyDestructiveByDefault && this.isDestructive(command)) {
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
      const shellBin = this.resolveShell();
      const shellArgs = IS_WINDOWS
        ? ['/c', command]
        : ['-c', command];

      const child = spawn(shellBin, shellArgs, {
        cwd,
        env: { ...process.env, ...options?.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // On Windows, detached: false keeps the process in the parent's Job Object.
        // On Linux, detached: true creates a new process group for cleanup.
        detached: !IS_WINDOWS,
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let killed = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        if (child.pid) {
          try {
            // Kill the entire process group on Linux
            if (!IS_WINDOWS) {
              process.kill(-child.pid, 'SIGKILL');
            } else {
              child.kill('SIGKILL');
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
    return pref; // 'bash' or other
  }
}
