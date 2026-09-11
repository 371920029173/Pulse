import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import type { ToolDefinition } from '@she/shared';
import type { SandboxShell } from './shell.js';

const execFileAsync = promisify(execFile);
const IS_WINDOWS = platform() === 'win32';

export interface ToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export function createTools(shell: SandboxShell, workspaceRoot: string): ToolSet {
  const root = resolve(workspaceRoot);

  const toolMap = new Map<string, { def: ToolDefinition; fn: (args: Record<string, unknown>) => Promise<string> }>();

  function reg(def: ToolDefinition, fn: (args: Record<string, unknown>) => Promise<string>) {
    toolMap.set(def.name, { def, fn });
  }

  // ── shell ─────────────────────────────────────────────────────────────────
  reg(
    {
      name: 'shell',
      description: 'Run a shell command in the sandbox workspace. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory relative to workspace root (optional)' },
        },
        required: ['command'],
      },
      isDangerous: true,
    },
    async (args) => {
      const command = args.command as string;
      const cwd = (args.cwd as string) ?? '.';
      const result = await shell.exec(command, { cwd });
      if (result.denied) {
        return `DENIED: ${result.stderr}`;
      }
      const parts: string[] = [];
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
      parts.push(`exit code: ${result.exitCode}`);
      if (result.timedOut) parts.push('(timed out)');
      return parts.join('\n');
    },
  );

  // ── fs_read ───────────────────────────────────────────────────────────────
  reg(
    {
      name: 'fs_read',
      description: 'Read a file within the workspace. Optionally specify startLine and endLine (1-indexed) to read a range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          startLine: { type: 'number', description: 'First line to read (1-indexed, inclusive)' },
          endLine: { type: 'number', description: 'Last line to read (1-indexed, inclusive)' },
        },
        required: ['path'],
      },
    },
    async (args) => {
      const filePath = shell.validatePath(args.path as string);
      const content = await readFile(filePath, 'utf-8');
      const startLine = args.startLine as number | undefined;
      const endLine = args.endLine as number | undefined;

      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n');
        const start = (startLine ?? 1) - 1;
        const end = endLine ?? lines.length;
        return lines.slice(start, end).join('\n');
      }
      return content;
    },
  );

  // ── fs_write ──────────────────────────────────────────────────────────────
  reg(
    {
      name: 'fs_write',
      description: 'Write content to a file within the workspace. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
      isDangerous: true,
    },
    async (args) => {
      const filePath = shell.validatePath(args.path as string);
      const dir = dirname(filePath);
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, args.content as string, 'utf-8');
      return `Wrote ${(args.content as string).length} bytes to ${args.path}`;
    },
  );

  // ── fs_list ───────────────────────────────────────────────────────────────
  reg(
    {
      name: 'fs_list',
      description: 'List files and directories within the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace root' },
          recursive: { type: 'boolean', description: 'Whether to list recursively (default: false)' },
        },
        required: ['path'],
      },
    },
    async (args) => {
      const dirPath = shell.validatePath(args.path as string);
      const recursive = (args.recursive as boolean) ?? false;

      async function listDir(dir: string, prefix: string): Promise<string[]> {
        const entries = await readdir(dir, { withFileTypes: true });
        const results: string[] = [];
        for (const entry of entries) {
          const entryRel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const suffix = entry.isDirectory() ? '/' : '';
          results.push(entryRel + suffix);
          if (recursive && entry.isDirectory()) {
            const sub = await listDir(join(dir, entry.name), entryRel);
            results.push(...sub);
          }
        }
        return results;
      }

      const items = await listDir(dirPath, '');
      return items.join('\n') || '(empty directory)';
    },
  );

  // ── grep ──────────────────────────────────────────────────────────────────
  reg(
    {
      name: 'grep',
      description: 'Search files for a regex pattern within the workspace.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file path relative to workspace root (default: root)' },
          glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
        },
        required: ['pattern'],
      },
    },
    async (args) => {
      const pattern = args.pattern as string;
      const searchPath = shell.validatePath((args.path as string) ?? '.');
      const globFilter = args.glob as string | undefined;

      if (IS_WINDOWS) {
        const findstrArgs = ['/S', '/N', '/R', pattern, searchPath];
        try {
          const { stdout } = await execFileAsync('findstr', findstrArgs, {
            maxBuffer: 512 * 1024,
            timeout: 15_000,
          });
          const lines = stdout.split('\n').filter(Boolean);
          if (lines.length > 200) {
            return lines.slice(0, 200).join('\n') + `\n... (${lines.length - 200} more matches)`;
          }
          return lines.join('\n') || 'No matches found';
        } catch (err: unknown) {
          const e = err as { code?: number };
          if (e.code === 1) return 'No matches found';
          throw err;
        }
      }

      const grepArgs: string[] = ['-r', '-n'];
      if (globFilter) {
        grepArgs.push(`--include=${globFilter}`);
      }
      grepArgs.push('-E', pattern, searchPath);

      try {
        const { stdout } = await execFileAsync('grep', grepArgs, {
          maxBuffer: 512 * 1024,
          timeout: 15_000,
        });
        const lines = stdout.split('\n').filter(Boolean);
        if (lines.length > 200) {
          return lines.slice(0, 200).join('\n') + `\n... (${lines.length - 200} more matches)`;
        }
        return lines.join('\n') || 'No matches found';
      } catch (err: unknown) {
        const e = err as { code?: number };
        if (e.code === 1) return 'No matches found';
        throw err;
      }
    },
  );

  // ── git_status ────────────────────────────────────────────────────────────
  reg(
    {
      name: 'git_status',
      description: 'Show the current git status of the workspace.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const result = await shell.exec('git status', { cwd: '.' });
      return result.stdout || result.stderr;
    },
  );

  // ── git_diff ──────────────────────────────────────────────────────────────
  reg(
    {
      name: 'git_diff',
      description: 'Show git diff of the workspace. Use staged flag for staged changes.',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged changes (default: false)' },
        },
      },
    },
    async (args) => {
      const staged = (args.staged as boolean) ?? false;
      const cmd = staged ? 'git diff --staged' : 'git diff';
      const result = await shell.exec(cmd, { cwd: '.' });
      return result.stdout || result.stderr || '(no changes)';
    },
  );

  // ── git_log ───────────────────────────────────────────────────────────────
  reg(
    {
      name: 'git_log',
      description: 'Show recent git log entries.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of commits to show (default: 10)' },
        },
      },
    },
    async (args) => {
      const count = (args.count as number) ?? 10;
      const cmd = `git log --oneline -n ${count}`;
      const result = await shell.exec(cmd, { cwd: '.' });
      return result.stdout || result.stderr || '(no commits)';
    },
  );

  // ── build ToolSet ─────────────────────────────────────────────────────────
  const definitions = Array.from(toolMap.values()).map(t => t.def);

  async function execute(name: string, args: Record<string, unknown>): Promise<string> {
    const entry = toolMap.get(name);
    if (!entry) {
      return `Error: unknown tool "${name}"`;
    }
    try {
      return await entry.fn(args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  }

  return { definitions, execute };
}
