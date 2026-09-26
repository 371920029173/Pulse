/**
 * LSP tools for the agent.
 *
 * `grep` can tell you a name appears in 40 places; it cannot tell you which of
 * them is the definition, what the type is, or which call site will break if you
 * change the signature. A language server, driven by the same compiler the user's
 * editor uses, answers exactly that.
 */
import { readFileSync, statSync } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import {
  KNOWN_SERVERS, LspServer, languageOf, resolveServer, servableLanguages,
  type Diagnostic, type ResolvedServer, type ServerSpec,
} from './lsp-client.js';
import { createLogger } from '@she/shared';
import type { ToolDefinition } from '@she/shared';

const log = createLogger('lsp');

export interface ToolResult { ok: boolean; output: string; }

function textResult(output: string, ok = true): ToolResult {
  return { ok, output };
}

/**
 * Keeps one LSP server alive per language for a workspace.
 *
 * Servers are expensive to start (the TypeScript one indexes the whole project),
 * so they are reused across turns and torn down with the agent.
 */
export class LspManager {
  private readonly servers = new Map<string, LspServer | null>();
  /** Cached resolution, so we don't walk node_modules on every call. */
  private readonly resolved = new Map<string, ResolvedServer | null>();
  private languages: Set<string> | null = null;

  constructor(private readonly workspaceRoot: string) {}

  /** Languages that have a usable server here. Empty means LSP is unavailable. */
  get supported(): Set<string> {
    this.languages ??= servableLanguages(this.workspaceRoot);
    return this.languages;
  }

  /** True when this file's language has a server. */
  canServe(filePath: string): boolean {
    const lang = languageOf(filePath);
    return !!lang && this.supported.has(lang);
  }

  private specFor(language: string): ServerSpec | null {
    return KNOWN_SERVERS.find((s) => s.languages.includes(language)) ?? null;
  }

  /**
   * The server for a file, started on first use.
   *
   * Returns null when the language is unsupported or the server fails to start,
   * so callers surface a clear message instead of crashing.
   */
  async serverForFile(filePath: string): Promise<LspServer | null> {
    const language = languageOf(filePath);
    if (!language) return null;
    const spec = this.specFor(language);
    if (!spec) return null;

    const existing = this.servers.get(spec.id);
    // A server whose process died (crash, OOM, killed) would time out on every call.
    // Drop it and start a fresh one instead.
    if (existing && !existing.isAlive) {
      log.warn(`[lsp] ${spec.id} 进程已退出，重新启动`);
      this.servers.delete(spec.id);
      void existing.stop().catch(() => undefined);
    } else if (existing !== undefined) {
      return existing;
    }

    if (!this.resolved.has(spec.id)) {
      this.resolved.set(spec.id, resolveServer(spec, this.workspaceRoot));
    }
    const launch = this.resolved.get(spec.id) ?? null;
    if (!launch) {
      this.servers.set(spec.id, null);
      return null;
    }

    const server = new LspServer(spec, this.workspaceRoot, launch);
    try {
      await server.start();
      log.info(`[lsp] ${spec.id} 已启动 (${launch.via})`);
      this.servers.set(spec.id, server);
      return server;
    } catch (err) {
      log.warn(`[lsp] ${spec.id} 启动失败: ${(err as Error).message}`);
      this.servers.set(spec.id, null);
      return null;
    }
  }

  /** Where each language's server came from, for diagnostics in the UI. */
  describe(): Array<{ id: string; languages: string[]; available: boolean; via?: string }> {
    return KNOWN_SERVERS.map((spec) => {
      const r = this.resolved.get(spec.id) ?? resolveServer(spec, this.workspaceRoot);
      this.resolved.set(spec.id, r);
      return {
        id: spec.id,
        languages: spec.languages,
        available: !!r,
        via: r?.via,
      };
    });
  }

  async dispose(): Promise<void> {
    const all = [...this.servers.values()].filter((s): s is LspServer => !!s);
    this.servers.clear();
    await Promise.allSettled(all.map((s) => s.stop()));
  }
}

// ─── Argument handling ───

/** Resolve a model-supplied path against the workspace and refuse escapes. */
function resolveInWorkspace(root: string, p: string): { ok: true; abs: string } | { ok: false; error: string } {
  const abs = isAbsolute(p) ? p : join(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `路径超出工作区: ${p}` };
  }
  return { ok: true, abs };
}

/**
 * Drop a leading UTF-8 byte-order mark.
 *
 * Node's `utf8` decoder keeps U+FEFF as the first character, and a language server counts it
 * as column 0 of line 1. Everything the model sees has it removed (`fs_read` strips it, editors
 * hide it), so a `line:column` the model reads off a file was one short of the server's on line 1
 * of any BOM file: `lsp_definition` at 1:15 found nothing and 1:16 worked, and diagnostics on
 * line 1 came back one column to the right. Stripping it from the text we OPEN with makes the
 * server's coordinates the model's coordinates, in both directions (positions sent and results
 * mapped back). Files the server reads from disk itself are unaffected: tsserver's own
 * `sys.readFile` already drops the BOM.
 *
 * Only the first character: a U+FEFF anywhere else is content.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readOrError(abs: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    if (!statSync(abs).isFile()) return { ok: false, error: `不是文件: ${abs}` };
    // BOM stripped here, the one place LSP text is read, so didOpen/didChange and the
    // 1-based positions from the model agree (see `stripBom`).
    return { ok: true, text: stripBom(readFileSync(abs, 'utf8')) };
  } catch (err) {
    return { ok: false, error: `无法读取 ${abs}: ${(err as Error).message}` };
  }
}

/** 1-based line/column from the model -> 0-based LSP position. */
function toPosition(line: number, column: number) {
  return { line: Math.max(0, line - 1), character: Math.max(0, column - 1) };
}

/**
 * Syntax check when no language server is installed for this file.
 *
 * The workspace is mostly JS, Python and C. A missing `typescript-language-server`
 * used to make `lsp_diagnostics` a hard failure, so the agent could not verify
 * an edit at all. This does not provide types or references — it only catches
 * syntax errors — and it says so.
 */
function syntaxFallback(abs: string): string | null {
  const dot = abs.lastIndexOf('.');
  const ext = dot >= 0 ? abs.slice(dot).toLowerCase() : '';
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    timeout: 20_000,
  });
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const r = run(process.execPath, ['--check', abs]);
    if (r.error) return null;
    if (r.status === 0) return '语法检查通过（node --check）。没有该语言的语言服务器，所以没有类型和引用信息。';
    return `语法错误（node --check）:\n${(r.stderr || r.stdout || '').trim()}`;
  }
  if (ext === '.py') {
    const r = run('python', ['-m', 'py_compile', abs]);
    if (r.error) return null;
    if (r.status === 0) return '语法检查通过（python -m py_compile）。没有该语言的语言服务器，所以没有类型和引用信息。';
    return `语法错误（py_compile）:\n${(r.stderr || r.stdout || '').trim()}`;
  }
  if (['.c', '.h', '.cc', '.cpp', '.hpp'].includes(ext)) {
    for (const cc of ['clang', 'gcc', 'cl']) {
      const args = cc === 'cl' ? ['/Zs', '/nologo', abs] : ['-fsyntax-only', abs];
      const r = run(cc, args);
      if (r.error) continue;
      if (r.status === 0) return `语法检查通过（${cc}）。没有 clangd，所以没有跳转定义和引用。`;
      return `语法错误（${cc}）:\n${(r.stderr || r.stdout || '').trim()}`;
    }
  }
  return null;
}

function unsupportedMessage(manager: LspManager, filePath: string): string {
  const lang = languageOf(filePath) ?? '未知';
  const known = [...manager.supported].join(', ') || '无';
  return `没有可用于 ${lang} 的语言服务器（当前可用: ${known}）。`
    + '可以用 read/grep 继续，但类型与引用信息会不准确。';
}

// ─── Formatting ───

function formatDiagnostics(diags: Diagnostic[], root: string, limit = 40): string {
  if (diags.length === 0) return '没有诊断信息（该文件未报错）';
  const shown = diags.slice(0, limit);
  const lines = shown.map((d) => {
    const rel = relative(root, d.file) || d.file;
    const code = d.code != null ? ` [${d.code}]` : '';
    return `${d.severity.toUpperCase()} ${rel}:${d.line}:${d.character}${code} ${d.message}`;
  });
  const extra = diags.length > limit ? `\n… 另有 ${diags.length - limit} 条` : '';
  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.filter((d) => d.severity === 'warning').length;
  return `共 ${diags.length} 条（${errors} 错误 / ${warnings} 警告）\n${lines.join('\n')}${extra}`;
}

/** Turn an LSP location response (`Location` or `LocationLink`) into `file:line:col` lines. */
function formatLocations(result: unknown, root: string): string {
  if (!result) return '没有结果';
  const items = Array.isArray(result) ? result : [result];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const loc = raw as {
      uri?: string; range?: { start: { line: number; character: number } };
      targetUri?: string; targetRange?: { start: { line: number; character: number } };
    };
    const uri = loc.uri ?? loc.targetUri;
    const range = loc.range ?? loc.targetRange;
    if (!uri || !range) continue;
    let file: string;
    try {
      // ORDER MATTERS: tsserver sends `file:///d%3A/...`, so the drive letter is
      // percent-encoded. Decoding first turns it into `/d:/...`, and only then
      // does stripping the leading slash yield a Windows path. Doing it the
      // other way leaves `/d:/...`, which `relative` resolves into garbage.
      const raw = decodeURIComponent(new URL(uri).pathname);
      file = raw.replace(/^\/([A-Za-z]:)/, '$1');
    } catch {
      continue;
    }
    const line = `${relative(root, file) || file}:${range.start.line + 1}:${range.start.character + 1}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.length ? out.join('\n') : '没有结果';
}

/** Flatten an LSP hover (string | MarkupContent | MarkedString[]) into plain text. */
function formatHover(result: unknown): string {
  const h = result as { contents?: unknown } | null;
  if (!h?.contents) return '这里没有类型信息';
  const flatten = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(flatten).join('\n');
    if (v && typeof v === 'object') {
      const o = v as { value?: string };
      return o.value ?? '';
    }
    return '';
  };
  const text = flatten(h.contents).trim();
  return text || '这里没有类型信息';
}

// ─── Tool surface ───

const POSITION_PARAMS = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径（相对工作区）' },
    line: { type: 'number', description: '行号，从 1 开始' },
    column: { type: 'number', description: '列号，从 1 开始' },
  },
  required: ['path', 'line', 'column'],
} as const;

/**
 * LSP tool definitions bound to a workspace.
 *
 * `lsp_diagnostics` is the highest-value one: it is the difference between
 * "this edit looks plausible" and "this edit compiles".
 */
export function makeLspTools(workspaceRoot: string, manager: LspManager): ToolDefinition[] {
  // Only advertise what can actually run. A tool that always fails wastes a
  // round-trip and teaches the model to distrust the tool list.
  const anyServer = manager.supported.size > 0;

  const tools: ToolDefinition[] = [
    {
      name: 'lsp_diagnostics',
      description:
        '用语言服务器检查一个文件的类型错误和警告（相当于编辑器里的红波浪线）。'
        + '改完代码后应当调用它确认没有引入编译错误，而不是靠猜。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径（相对工作区）' } },
        required: ['path'],
      },
    },
    {
      name: 'lsp_definition',
      description:
        '跳到某个符号的定义处。给定文件与行列位置，返回定义所在位置。'
        + '比 grep 准：它区分定义与引用，并理解跨文件、跨包的符号。',
      parameters: POSITION_PARAMS,
    },
    {
      name: 'lsp_references',
      description:
        '找出某个符号被引用的所有位置。改动接口、重命名或删除函数前用它评估影响面，'
        + '比全文搜索准确（不会把注释里的同名字符串算进来）。',
      parameters: POSITION_PARAMS,
    },
    {
      name: 'lsp_hover',
      description:
        '查看某个符号的类型签名与文档。想知道一个变量或函数的真实类型时用它，不要从用法推测。',
      parameters: POSITION_PARAMS,
    },
  ];

  if (!anyServer) return [tools[0]];
  return tools;
}

/** Execute one LSP tool call. Returns null when the name is not an LSP tool. */
export async function executeLspTool(
  name: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  manager: LspManager,
): Promise<ToolResult | null> {
  if (!name.startsWith('lsp_')) return null;

  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return textResult(`${name} 失败: 缺少 path`, false);

  const resolved = resolveInWorkspace(workspaceRoot, path);
  if (!resolved.ok) return textResult(`${name} 失败: ${resolved.error}`, false);

  if (!manager.canServe(resolved.abs)) {
    if (name === 'lsp_diagnostics') {
      const fallback = syntaxFallback(resolved.abs);
      if (fallback) return textResult(fallback, !fallback.startsWith('语法错误'));
    }
    return textResult(`${name} 失败: ${unsupportedMessage(manager, resolved.abs)}`, false);
  }

  const file = readOrError(resolved.abs);
  if (!file.ok) return textResult(`${name} 失败: ${file.error}`, false);

  const language = languageOf(resolved.abs);
  if (!language) return textResult(`${name} 失败: 无法识别语言`, false);

  const server = await manager.serverForFile(resolved.abs);
  if (!server) return textResult(`${name} 失败: 语言服务器不可用`, false);

  const pos = toPosition(
    typeof args.line === 'number' ? args.line : 1,
    typeof args.column === 'number' ? args.column : 1,
  );

  try {
    switch (name) {
      case 'lsp_diagnostics': {
        const diags = await server.diagnosticsFor(resolved.abs, language, file.text);
        // `null` means the server never answered. Saying "no problems" here would
        // give the agent a false clean bill of health after an edit, which is
        // worse than admitting the check did not happen.
        if (diags === null) {
          return textResult(
            '未能获取诊断（语言服务器未在超时前响应）。这不代表文件没有问题——'
            + '不要重复调用 lsp_diagnostics，请改用 shell 运行类型检查（如 `npx tsc --noEmit`）或项目的测试来验证改动。',
            false,
          );
        }
        return textResult(formatDiagnostics(diags, workspaceRoot));
      }
      case 'lsp_definition':
        return textResult(formatLocations(
          await server.definition(resolved.abs, language, file.text, pos), workspaceRoot));
      case 'lsp_references':
        return textResult(formatLocations(
          await server.references(resolved.abs, language, file.text, pos), workspaceRoot));
      case 'lsp_hover':
        return textResult(formatHover(
          await server.hover(resolved.abs, language, file.text, pos)));
      default:
        return textResult(`未知的 LSP 工具: ${name}`, false);
    }
  } catch (err) {
    return textResult(`${name} 失败: ${(err as Error).message}`, false);
  }
}
