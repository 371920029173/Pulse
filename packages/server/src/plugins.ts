/**
 * Plugin runtime.
 *
 * A plugin is a directory with a `manifest.json` and an `index.mjs` that exports
 * `tools`. This module loads those tools and hands them to the agent, which is
 * what makes a plugin *do* something.
 *
 * ## The security model — read this before trusting a plugin
 *
 * **Plugin code runs in-process with the server, so it has full Node access.**
 * The `permissions` field in a manifest is *disclosure, not enforcement*: it
 * tells the user what a plugin intends to touch, and the UI shows it prominently
 * before install. It cannot stop a plugin from doing otherwise.
 *
 * That is the same posture as editor extensions, and it is stated plainly here
 * rather than faked with a sandbox that a plugin could simply walk out of. The
 * honest options are (a) disclose and let the user decide, or (b) run plugins in
 * a separate process with an IPC boundary, which is a much larger build.
 *
 * Because of this, the UI must never install a plugin silently or from a remote
 * source without showing what it declares.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { ToolDefinition } from '@she/shared';
import { jailPath } from './files.js';

export interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  /** Homepage or source URL, shown in the catalog. */
  homepage?: string;
  enabled?: boolean;
  /**
   * What the plugin declares it touches. Advisory: see the security note above.
   * Known values: 'read', 'write', 'shell', 'network', 'kb'.
   */
  permissions?: string[];
  tools?: { name: string; description: string; parameters?: Record<string, unknown> }[];
  commands?: { id: string; title: string; description?: string }[];
  panels?: { id: string; title: string; entry: string }[];
}

/** The object a plugin's `index.mjs` receives when a tool runs. */
export interface PluginContext {
  /** Workspace the agent is operating in. */
  workspaceRoot: string;
  /** Scoped logger; output goes to the server log with the plugin name. */
  log: (msg: string) => void;
  /** Read a workspace file. Jailed: escapes are rejected. */
  readFile: (relPath: string, maxBytes?: number) => string;
  /** Write a workspace file. Jailed: escapes are rejected. */
  writeFile: (relPath: string, content: string) => void;
  /** List a workspace directory. Jailed. */
  listDir: (relPath?: string) => { name: string; type: 'file' | 'dir'; size: number }[];
  /**
   * Run a shell command in the workspace.
   *
   * Declared as the `shell` permission. Note this is NOT sandboxed the way the
   * agent's own `shell` tool is — a plugin calling it is trusted code.
   */
  exec: (command: string, opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/** A tool a plugin provides, as exported from its `index.mjs`. */
export interface PluginToolExport {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: PluginContext) => Promise<string> | string;
}

export interface LoadedModule {
  tools?: PluginToolExport[];
  /** Optional: run when the plugin is enabled. */
  activate?: (ctx: PluginContext) => Promise<void> | void;
}

export interface InstalledPlugin {
  /** Directory name; the plugin's stable id. */
  dir: string;
  manifestPath: string;
  manifest: PluginManifest | null;
  /** Set when the manifest or module could not be read. */
  error?: string;
  /** True when the plugin has an index.mjs and its tools loaded. */
  hasModule?: boolean;
  toolCount?: number;
  /**
   * Declarations that cannot work.
   *
   * A manifest is a promise; without checking it, a plugin can advertise tools
   * with no implementation, permissions from an invented vocabulary, or a panel
   * whose HTML does not exist. One shipped plugin did exactly that — describing
   * a LAN remote that had been removed for security reasons — and looked
   * perfectly healthy in the UI. These strings make the gap visible.
   */
  issues?: string[];
}

/**
 * The permission vocabulary.
 *
 * Exported so the API and the UI label the same set. A plugin using anything
 * else is reported rather than silently accepted: an unrecognised permission is
 * either a typo or a feature the runtime does not honour, and either way the user
 * should not be told it is in effect.
 */
export const KNOWN_PERMISSIONS = ['read', 'write', 'shell', 'network', 'kb'] as const;

export interface CatalogEntry {
  dir: string;
  manifest: PluginManifest;
  /** Already installed in the app plugin directory. */
  installed: boolean;
}

export interface PluginManagerDeps {
  /** Where installed plugins live (`~/.she-app/plugins`). */
  appPluginsDir: string;
  /** Directory of plugins bundled with the app (the catalog source). */
  bundledPluginsDir: string;
  /** Current workspace root, for the plugin context. */
  workspaceRoot: () => string;
  log: (msg: string) => void;
}

export class PluginManager {
  private deps: PluginManagerDeps;
  /** name -> loaded module, memoised so a turn does not re-import per call. */
  private modules = new Map<string, LoadedModule | null>();
  /**
   * The loaded tool set. Rebuilt only by `refresh()`.
   *
   * Held as a field (rather than computed on demand) because the agent needs the
   * definitions synchronously; see the note on `definitions()`.
   */
  private cached: {
    definitions: ToolDefinition[];
    routes: Map<string, { plugin: string; tool: PluginToolExport; permissions: string[] }>;
  } = { definitions: [], routes: new Map() };

  constructor(deps: PluginManagerDeps) {
    this.deps = deps;
  }

  private get roots(): string[] {
    const wsLocal = join(this.deps.workspaceRoot(), '.she', 'plugins');
    // Workspace-local wins, so a project can pin its own copy of a plugin.
    return existsSync(wsLocal) ? [wsLocal, this.deps.appPluginsDir] : [this.deps.appPluginsDir];
  }

  /**
   * Absolute path of an installed plugin, or null.
   *
   * The name must be a plain directory name. The old implementation only stripped `/` and `\`, which
   * left two escapes:
   *
   *   - `resolveDir('.')` returned the plugins ROOT itself (`join(root, '.')` normalises to `root`),
   *     and `uninstall`'s guard `abs.startsWith(appPluginsDir)` is true for the root — so
   *     `DELETE /api/plugins?dir=.` deleted every installed plugin and reported success.
   *   - `resolveDir('..')` returned the PARENT of the plugins directory, and `writeSource` had no
   *     containment check at all, so `PUT /api/plugins/source?dir=..` wrote `index.mjs` and
   *     `manifest.json` into `~/.she-app/`.
   *
   * Both are rejected now, and containment is verified rather than assumed.
   */
  resolveDir(name: string): string | null {
    const clean = String(name ?? '').trim();
    // A plugin directory is a plain name: no separators, no traversal, no hidden directory.
    if (!clean || clean === '.' || clean === '..' || clean.startsWith('.')) return null;
    if (/[\\/]/.test(clean) || clean.includes('\0')) return null;

    for (const root of this.roots) {
      const abs = join(root, clean);
      if (!existsSync(abs)) continue;
      // Belt and braces: the name checks above should make this impossible, but containment is
      // cheap and this is the function every destructive plugin operation routes through.
      if (!this.insideRoot(root, abs)) continue;
      return abs;
    }
    return null;
  }

  /** Whether `candidate` is strictly inside `root` (not equal to it). */
  private insideRoot(root: string, candidate: string): boolean {
    const rel = relative(resolve(root), resolve(candidate));
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
  }

  /** Every installed plugin, with manifest and module status. */
  scan(): InstalledPlugin[] {
    const seen = new Set<string>();
    const out: InstalledPlugin[] = [];

    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      const isGlobal = root === this.deps.appPluginsDir;

      for (const name of readdirSync(root)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const abs = join(root, name);
        try {
          if (!statSync(abs).isDirectory()) continue;
        } catch { continue; }

        const relDir = isGlobal ? name : `.she/plugins/${name}`;
        const manifestPath = join(abs, 'manifest.json');
        if (!existsSync(manifestPath)) {
          out.push({ dir: relDir, manifestPath: `${relDir}/manifest.json`, manifest: null, error: '缺少 manifest.json' });
          continue;
        }
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as PluginManifest;
          const modulePath = join(abs, 'index.mjs');
          const hasModule = existsSync(modulePath);
          out.push({
            dir: relDir,
            manifestPath: `${relDir}/manifest.json`,
            manifest,
            hasModule,
            toolCount: manifest.tools?.length ?? 0,
            issues: this.auditManifest(abs, manifest, hasModule),
          });
        } catch (e) {
          out.push({ dir: relDir, manifestPath: `${relDir}/manifest.json`, manifest: null, error: (e as Error).message });
        }
      }
    }
    return out;
  }

  /**
   * Check a manifest's declarations against reality.
   *
   * Returns a list of things that cannot work, so the UI can say so instead of
   * presenting a healthy-looking plugin that does nothing.
   */
  private auditManifest(absDir: string, manifest: PluginManifest, hasModule: boolean): string[] {
    const issues: string[] = [];

    if ((manifest.tools?.length ?? 0) > 0 && !hasModule) {
      issues.push(`声明了 ${manifest.tools!.length} 个工具，但没有 index.mjs —— 它们不会被加载`);
    }

    for (const p of manifest.permissions ?? []) {
      if (!(KNOWN_PERMISSIONS as readonly string[]).includes(p)) {
        issues.push(`未知权限「${p}」—— 运行时不认，请用 ${KNOWN_PERMISSIONS.join(' / ')}`);
      }
    }

    for (const panel of manifest.panels ?? []) {
      const entry = join(absDir, panel.entry);
      if (!existsSync(entry)) {
        issues.push(`面板「${panel.title || panel.id}」缺少文件 ${panel.entry}`);
      }
    }

    return issues;
  }

  /** Plugins bundled with the app and offered in the catalog. */
  catalog(): CatalogEntry[] {
    const src = this.deps.bundledPluginsDir;
    if (!existsSync(src)) return [];
    const out: CatalogEntry[] = [];
    for (const name of readdirSync(src)) {
      const dir = join(src, name);
      const manifestPath = join(dir, 'manifest.json');
      try {
        if (!statSync(dir).isDirectory() || !existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as PluginManifest;
        out.push({ dir: name, manifest, installed: existsSync(join(this.deps.appPluginsDir, name)) });
      } catch { /* skip a malformed bundled entry */ }
    }
    return out.sort((a, b) => (a.manifest.name ?? a.dir).localeCompare(b.manifest.name ?? b.dir));
  }

  /** Copy a bundled plugin into the app plugin directory. */
  installFromCatalog(name: string): { ok: true; dir: string } {
    const clean = String(name ?? '').replace(/[\\/]/g, '');
    const src = join(this.deps.bundledPluginsDir, clean);
    if (!clean || !existsSync(src)) throw new Error(`目录中没有这个插件: ${name}`);

    const dest = join(this.deps.appPluginsDir, clean);
    if (existsSync(dest)) throw new Error(`已经安装: ${clean}`);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    this.modules.delete(clean);
    this.deps.log(`plugin installed: ${clean}`);
    return { ok: true, dir: clean };
  }

  /**
   * Install from a path on disk (user picked a folder, or pasted a path).
   *
   * Validated before copying so a stray folder cannot half-install.
   */
  installFromPath(sourcePath: string): { ok: true; dir: string } {
    const src = resolve(String(sourcePath ?? '').trim().replace(/^["']|["']$/g, ''));
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      throw new Error('路径不存在或不是目录');
    }
    const manifestPath = join(src, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error('这个目录里没有 manifest.json，看起来不是插件');
    }
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as PluginManifest;
    } catch (e) {
      throw new Error(`manifest.json 解析失败: ${(e as Error).message}`);
    }
    const name = manifest.name
      ? manifest.name.replace(/[^\w.-]+/g, '-').toLowerCase()
      : (src.split(/[/\\]/).pop() ?? '').replace(/[^\w.-]+/g, '-').toLowerCase();
    if (!name) throw new Error('无法确定插件名（manifest 里没有 name，目录名也不可用）');

    const dest = join(this.deps.appPluginsDir, name);
    if (existsSync(dest)) throw new Error(`已经安装同名插件: ${name}`);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    this.modules.delete(name);
    this.deps.log(`plugin installed from path: ${name}`);
    return { ok: true, dir: name };
  }

  uninstall(name: string): { ok: true } {
    const abs = this.resolveDir(name);
    if (!abs) throw new Error(`未安装: ${name}`);
    // Only ever remove from the app plugin dir; a workspace-local copy belongs to the project and
    // deleting it would be surprising. `resolveDir` already guarantees containment inside one of the
    // roots, and this narrows it further to the app directory.
    if (!this.insideRoot(this.deps.appPluginsDir, abs)) {
      throw new Error('这是工作区内的插件，请直接删除项目里的文件夹');
    }
    rmSync(abs, { recursive: true, force: true });
    this.modules.delete(name.replace(/[\\/]/g, ''));
    this.deps.log(`plugin uninstalled: ${name}`);
    return { ok: true };
  }

  /** Flip `enabled` in the manifest. */
  setEnabled(name: string, enabled: boolean): InstalledPlugin | undefined {
    const abs = this.resolveDir(name);
    if (!abs) return undefined;
    const manifestPath = join(abs, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as PluginManifest;
    manifest.enabled = enabled;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return this.scan().find((p) => p.dir.endsWith(name.replace(/[\\/]/g, '')));
  }

  /** Create a working plugin skeleton so authoring starts from something runnable. */
  scaffold(name: string, description = ''): { ok: true; dir: string } {
    /*
     * Sanitise, then require something usable to remain.
     *
     * `replace(/[^\w.-]+/g, '-')` turns "///" into "-", which is non-empty and
     * used to sail through — creating a plugin literally named "-". Strip the
     * separators and require at least one alphanumeric character instead.
     */
    const cleaned = String(name ?? '')
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .toLowerCase();
    if (!cleaned || !/[a-z0-9]/.test(cleaned)) {
      throw new Error('请填插件名（至少含一个字母或数字，可用 - 和 _）');
    }
    const clean = cleaned;
    const dest = join(this.deps.appPluginsDir, clean);
    if (existsSync(dest)) throw new Error(`已存在: ${clean}`);
    mkdirSync(dest, { recursive: true });

    const tools = [
      {
        name: `${clean.replace(/-/g, '_')}_hello`,
        description: description || `${clean} 插件的示例工具，返回一条问候`,
        parameters: {
          type: 'object',
          properties: { who: { type: 'string', description: '要问候的对象' } },
        },
      },
    ];
    const manifest: PluginManifest = {
      name: clean,
      version: '0.1.0',
      description: description || '一个 Pulse 插件',
      author: '',
      enabled: true,
      permissions: ['read'],
      tools,
      commands: [],
      panels: [],
    };
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    const module = `/**
 * ${clean} — plugin entry.
 *
 * Export \`tools\`. Each tool's \`run(args, ctx)\` may return a string, which is
 * what the agent sees as the tool result.
 *
 * ctx gives you a jailed view of the workspace plus a scoped logger:
 *   ctx.readFile / ctx.writeFile / ctx.listDir   (confined to the workspace)
 *   ctx.exec(command)                            (declares the 'shell' permission)
 *   ctx.log(message)
 */
export const tools = ${JSON.stringify(tools, null, 2).replace(/"([a-zA-Z_]\w*)":/g, '$1:')};

// Attach the implementation (kept separate so the manifest and the code above
// can stay in sync by copy-paste without editing two shapes).
tools[0].run = async (args, ctx) => {
  const who = String(args.who ?? '世界').trim() || '世界';
  ctx.log(\`打招呼: \${who}\`);
  const files = ctx.listDir('.').slice(0, 5).map((f) => f.name);
  return \`你好，\${who}！\\n工作区前几个条目: \${files.join(', ') || '(空)'}\`;
};
`;
    writeFileSync(join(dest, 'index.mjs'), module, 'utf8');
    this.deps.log(`plugin scaffolded: ${clean}`);
    return { ok: true, dir: clean };
  }

  /** Read a plugin's source files, for the built-in editor. */
  readSource(name: string): { manifest: string; module: string | null } {
    const abs = this.resolveDir(name);
    if (!abs) throw new Error(`未安装: ${name}`);
    const manifest = readFileSync(join(abs, 'manifest.json'), 'utf8');
    const modulePath = join(abs, 'index.mjs');
    return { manifest, module: existsSync(modulePath) ? readFileSync(modulePath, 'utf8') : null };
  }

  /** Write a plugin's manifest or module back. Validates before saving. */
  writeSource(name: string, file: 'manifest.json' | 'index.mjs', content: string): { ok: true } {
    const abs = this.resolveDir(name);
    if (!abs) throw new Error(`未安装: ${name}`);
    if (file === 'manifest.json') {
      try {
        JSON.parse(content);
      } catch (e) {
        throw new Error(`manifest 不是合法 JSON: ${(e as Error).message}`);
      }
    }
    writeFileSync(join(abs, file), content, 'utf8');
    // A changed module must be re-imported; the old one is cached by the loader.
    this.modules.delete(name.replace(/[\\/]/g, ''));
    return { ok: true };
  }

  /**
   * Build the context handed to a plugin's tools.
   *
   * The workspace root is read when the tool RUNS, not when the plugin was
   * loaded. Caching the string here is what made `ws_overview` keep scanning
   * the previous project after the user switched workspaces: file tools followed
   * the new root, and this context did not.
   */
  private contextFor(name: string, permissions: string[], workspaceRoot?: string): PluginContext {
    const root = () => workspaceRoot || this.deps.workspaceRoot();
    const log = (m: string) => this.deps.log(`[plugin:${name}] ${m}`);

    return {
      get workspaceRoot() { return root(); },
      log,
      readFile: (relPath, maxBytes = 256_000) => {
        const abs = jailPath(root(), relPath);
        const buf = readFileSync(abs);
        return (buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf).toString('utf8');
      },
      writeFile: (relPath, content) => {
        const abs = jailPath(root(), relPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
      },
      listDir: (relPath = '.') => {
        const abs = jailPath(root(), relPath);
        if (!existsSync(abs)) return [];
        return readdirSync(abs, { withFileTypes: true }).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' as const : 'file' as const,
          size: (() => { try { return statSync(join(abs, e.name)).size; } catch { return 0; } })(),
        }));
      },
      exec: (command, opts) => new Promise((resolvePromise) => {
        if (!permissions.includes('shell')) {
          // Advisory refusal: the plugin *declared* it would not need this.
          resolvePromise({ code: -1, stdout: '', stderr: '插件未声明 shell 权限（请在 manifest 的 permissions 里加上 "shell"）' });
          return;
        }
        const child = spawn(command, { cwd: root(), shell: true, windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, opts?.timeoutMs ?? 30_000);
        child.stdout?.on('data', (c) => { stdout += c; });
        child.stderr?.on('data', (c) => { stderr += c; });
        child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code: code ?? -1, stdout, stderr }); });
        child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: -1, stdout, stderr: err.message }); });
      }),
    };
  }

  /** Dynamically import a plugin's module, memoised. */
  private async loadModule(name: string, abs: string): Promise<LoadedModule | null> {
    const cached = this.modules.get(name);
    if (cached !== undefined) return cached;

    const modulePath = join(abs, 'index.mjs');
    if (!existsSync(modulePath)) {
      this.modules.set(name, null);
      return null;
    }
    try {
      // Cache-bust so an edited plugin picks up on the next turn instead of
      // serving a stale module for the life of the process.
      const url = `${pathToFileURL(modulePath).href}?v=${Date.now()}`;
      const mod = (await import(url)) as LoadedModule;
      this.modules.set(name, mod);
      return mod;
    } catch (e) {
      this.deps.log(`plugin ${name} failed to load: ${(e as Error).message}`);
      this.modules.set(name, null);
      return null;
    }
  }

  /**
   * Tools contributed by every enabled plugin.
   *
   * Split deliberately into a SYNCHRONOUS `definitions()` plus an async
   * `refresh()`:
   *
   * The agent builds its tool list synchronously in its constructor, from a
   * plain `definitions` array. An earlier revision exposed only an async
   * `agentTools()`, so the caller had nothing to put in that array and the merge
   * silently contributed ZERO tools — unit tests on `agentTools()` still passed,
   * while the agent truthfully reported it did not have the tool. Forcing the
   * two halves apart makes that mistake impossible: definitions must be loaded
   * in advance, and `refresh()` is the only way to change them.
   */
  definitions(): ToolDefinition[] {
    return this.cached.definitions;
  }

  /** Route one call to its plugin. */
  async execute(name: string, args: Record<string, unknown>, workspaceRoot?: string): Promise<string> {
    const route = this.cached.routes.get(name);
    if (!route) return `Error: plugin tool "${name}" is not available`;
    try {
      // The session's own directory wins over the process workspace, so two
      // projects running at once do not share one plugin root.
      const ctx = this.contextFor(route.plugin, route.permissions, workspaceRoot);
      const out = await route.tool.run(args, ctx);
      return typeof out === 'string' ? out : JSON.stringify(out);
    } catch (e) {
      return `Error in plugin ${route.plugin}: ${(e as Error).message}`;
    }
  }

  /**
   * Load every enabled plugin's module and rebuild the tool list.
   *
   * MUST be awaited at startup and after any change (install, uninstall,
   * enable/disable, source edit) — nothing else updates `definitions()`.
   */
  async refresh(): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];
    const routes = new Map<string, { plugin: string; tool: PluginToolExport; permissions: string[] }>();

    for (const p of this.scan()) {
      if (!p.manifest || p.manifest.enabled === false) continue;
      const name = p.dir.split('/').pop() ?? p.dir;
      const abs = this.resolveDir(name);
      if (!abs) continue;
      const mod = await this.loadModule(name, abs);
      if (!mod?.tools?.length) continue;

      const permissions = p.manifest.permissions ?? [];
      for (const tool of mod.tools) {
        if (!tool?.name || typeof tool.run !== 'function') continue;
        // A plugin cannot silently shadow a built-in or another plugin's tool:
        // reject the collision rather than letting load order decide.
        if (routes.has(tool.name) || definitions.some((d) => d.name === tool.name)) {
          this.deps.log(`plugin ${name}: tool "${tool.name}" collides with an existing tool, skipped`);
          continue;
        }
        definitions.push({
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        });
        routes.set(tool.name, { plugin: name, tool, permissions });
      }
    }

    this.cached = { definitions, routes };
    return definitions;
  }
}
