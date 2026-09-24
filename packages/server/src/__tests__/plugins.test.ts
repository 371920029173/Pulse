/**
 * Plugin runtime.
 *
 * The critical property pinned here: a plugin's declared tools must appear in
 * the SYNCHRONOUS `definitions()` the agent snapshots at construction.
 *
 * This is not incidental. An earlier revision exposed only an async
 * `agentTools()`, so the caller had nothing to put in the agent's tool array and
 * the merge silently contributed zero tools. Every unit test still passed while
 * the running agent truthfully reported "I don't have that tool". The
 * `definitions()` tests below exist specifically to make that class of mistake a
 * failure rather than a silent no-op.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '../plugins.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The real bundled catalog, so a broken shipped plugin fails the build. */
const BUNDLED = resolve(HERE, '../../../../plugins');

let root: string;
let appDir: string;
let workspace: string;
let pm: PluginManager;

const logs: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'she-plugins-'));
  appDir = join(root, 'app', 'plugins');
  workspace = join(root, 'ws');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  logs.length = 0;
  pm = new PluginManager({
    appPluginsDir: appDir,
    bundledPluginsDir: BUNDLED,
    workspaceRoot: () => workspace,
    log: (m) => logs.push(m),
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Write a plugin straight into the install dir. */
function installPlugin(name: string, manifest: object, moduleSource?: string) {
  const dir = join(appDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (moduleSource) writeFileSync(join(dir, 'index.mjs'), moduleSource, 'utf8');
}

describe('catalog', () => {
  it('lists the bundled plugins', () => {
    const names = pm.catalog().map((e) => e.dir);
    // These ship with the app; removing one should be a deliberate choice.
    for (const expected of ['workspace-insight', 'env-doctor', 'tunnel']) {
      assert.ok(names.includes(expected), `目录缺少 ${expected}，实际: ${names.join(', ')}`);
    }
  });

  it('reports install state', () => {
    assert.ok(pm.catalog().every((e) => !e.installed), '尚未安装时应全部为 false');
    pm.installFromCatalog('env-doctor');
    assert.equal(pm.catalog().find((e) => e.dir === 'env-doctor')?.installed, true);
  });

  it('installing twice is refused rather than overwriting', () => {
    pm.installFromCatalog('env-doctor');
    assert.throws(() => pm.installFromCatalog('env-doctor'), /已经安装/);
  });

  it('rejects an unknown catalog name', () => {
    assert.throws(() => pm.installFromCatalog('nope-not-here'), /没有这个插件/);
  });
});

describe('installing from a path', () => {
  it('installs a valid plugin folder', () => {
    const src = join(root, 'my-plugin');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: 'my-plugin' }), 'utf8');
    assert.equal(pm.installFromPath(src).dir, 'my-plugin');
    assert.ok(existsSync(join(appDir, 'my-plugin', 'manifest.json')));
  });

  it('refuses a folder with no manifest', () => {
    const src = join(root, 'not-a-plugin');
    mkdirSync(src, { recursive: true });
    assert.throws(() => pm.installFromPath(src), /manifest\.json/);
  });

  it('refuses a malformed manifest instead of half-installing', () => {
    const src = join(root, 'broken');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), '{ not json', 'utf8');
    assert.throws(() => pm.installFromPath(src), /解析失败/);
    assert.ok(!existsSync(join(appDir, 'broken')), '失败时不应留下半个插件');
  });

  it('refuses a path that is not a directory', () => {
    const f = join(root, 'a-file.txt');
    writeFileSync(f, 'x', 'utf8');
    assert.throws(() => pm.installFromPath(f), /不是目录/);
  });

  it('tolerates a quoted path (people paste from a shell)', () => {
    const src = join(root, 'quoted');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: 'quoted' }), 'utf8');
    assert.equal(pm.installFromPath(`"${src}"`).dir, 'quoted');
  });
});

describe('definitions() — the agent-visible tool list', () => {
  it('is empty before refresh, then populated after', async () => {
    installPlugin('demo', { name: 'demo', enabled: true, tools: [] },
      `export const tools = [{ name: 'demo_hello', description: 'says hi', run: async () => 'hi from demo' }];`);

    // Nothing may be handed to the agent before the modules are loaded — this is
    // exactly the state the old code shipped in by accident.
    assert.deepEqual(pm.definitions(), [], '未 refresh 前不应有定义');

    await pm.refresh();
    assert.ok(pm.definitions().some((d) => d.name === 'demo_hello'),
      `refresh 后必须同步可用，实际: ${pm.definitions().map((d) => d.name).join(', ')}`);
  });

  it('is a plain array the agent can spread synchronously', async () => {
    installPlugin('demo', { name: 'demo', enabled: true, tools: [] },
      `export const tools = [{ name: 'demo_hello', description: '', run: async () => 'ok' }];`);
    await pm.refresh();
    // This mirrors makeAgent: `[...base.definitions, ...plugins.definitions()]`.
    const merged = [...[{ name: 'builtin' }], ...pm.definitions()];
    assert.ok(merged.some((d) => d.name === 'demo_hello'), '合并后应包含插件工具');
  });

  it('exposes a description and parameters the model can read', async () => {
    installPlugin('rich', { name: 'rich', enabled: true, tools: [] }, `
export const tools = [{
  name: 'rich_tool',
  description: 'does the thing',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  run: async () => 'x',
}];`);
    await pm.refresh();
    const def = pm.definitions().find((d) => d.name === 'rich_tool')!;
    assert.equal(def.description, 'does the thing');
    assert.deepEqual((def.parameters as { required: string[] }).required, ['q']);
  });

  it('skips a disabled plugin', async () => {
    installPlugin('off', { name: 'off', enabled: false, tools: [] },
      `export const tools = [{ name: 'off_tool', description: '', run: async () => 'x' }];`);
    await pm.refresh();
    assert.ok(!pm.definitions().some((d) => d.name === 'off_tool'));
  });

  it('skips a plugin with no module instead of failing the whole load', async () => {
    installPlugin('declared-only', { name: 'declared-only', enabled: true, tools: [{ name: 'ghost', description: '' }] });
    await pm.refresh();
    assert.ok(!pm.definitions().some((d) => d.name === 'ghost'), '没有 index.mjs 就不该声明工具');
  });

  it('one broken plugin does not take the others down', async () => {
    installPlugin('good', { name: 'good', enabled: true, tools: [] },
      `export const tools = [{ name: 'good_tool', description: '', run: async () => 'good' }];`);
    installPlugin('bad', { name: 'bad', enabled: true, tools: [] }, 'export const tools = [this is not valid js');
    await pm.refresh();
    assert.ok(pm.definitions().some((d) => d.name === 'good_tool'), '好的插件应照常加载');
    assert.ok(logs.some((l) => /failed to load/.test(l)), '坏的应被记录');
  });

  it('refuses a tool name that collides with another plugin', async () => {
    const src = `export const tools = [{ name: 'dup_tool', description: '', run: async () => 'x' }];`;
    installPlugin('a', { name: 'a', enabled: true, tools: [] }, src);
    installPlugin('b', { name: 'b', enabled: true, tools: [] }, src);
    await pm.refresh();
    assert.equal(pm.definitions().filter((d) => d.name === 'dup_tool').length, 1, '重名只应注册一次');
    assert.ok(logs.some((l) => /collides/.test(l)), '应记录冲突日志');
  });
});

describe('execute', () => {
  it('routes to the right plugin', async () => {
    installPlugin('demo', { name: 'demo', enabled: true, tools: [] },
      `export const tools = [{ name: 'demo_hello', description: '', run: async (a) => 'hi ' + (a.who ?? 'x') }];`);
    await pm.refresh();
    assert.equal(await pm.execute('demo_hello', { who: '世界' }), 'hi 世界');
  });

  it('a throwing tool returns an error string, not an exception', async () => {
    installPlugin('boom', { name: 'boom', enabled: true, tools: [] },
      `export const tools = [{ name: 'boom_tool', description: '', run: async () => { throw new Error('kaboom'); } }];`);
    await pm.refresh();
    assert.match(await pm.execute('boom_tool', {}), /kaboom/);
  });

  it('an unknown tool name is reported, not thrown', async () => {
    await pm.refresh();
    assert.match(await pm.execute('nope', {}), /not available/);
  });
});

describe('plugin context', () => {
  it('jails file access to the workspace', async () => {
    writeFileSync(join(workspace, 'inside.txt'), 'inside', 'utf8');
    writeFileSync(join(root, 'outside.txt'), 'SECRET', 'utf8');

    installPlugin('reader', { name: 'reader', enabled: true, tools: [] }, `
export const tools = [{
  name: 'read_it', description: '',
  run: async (args, ctx) => {
    try { return 'READ: ' + ctx.readFile(args.p); }
    catch (e) { return 'REJECTED: ' + e.message; }
  },
}];`);
    await pm.refresh();
    assert.equal(await pm.execute('read_it', { p: 'inside.txt' }), 'READ: inside');
    const escaped = await pm.execute('read_it', { p: '../outside.txt' });
    assert.match(escaped, /REJECTED/, `越界读必须被拒绝，实际: ${escaped}`);
    assert.ok(!escaped.includes('SECRET'), '泄露了工作区外的内容');
  });

  it('refuses exec without the declared shell permission', async () => {
    installPlugin('noshell', { name: 'noshell', enabled: true, permissions: ['read'], tools: [] }, `
export const tools = [{
  name: 'try_exec', description: '',
  run: async (args, ctx) => {
    const r = await ctx.exec('echo should-not-run');
    return r.code === -1 ? 'REFUSED: ' + r.stderr : 'RAN: ' + r.stdout.trim();
  },
}];`);
    await pm.refresh();
    const out = await pm.execute('try_exec', {});
    assert.match(out, /REFUSED/, `未声明 shell 时应拒绝，实际: ${out}`);
    assert.ok(!out.includes('should-not-run'), '命令不该真的执行');
  });

  it('lists workspace entries', async () => {
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    writeFileSync(join(workspace, 'a.txt'), 'x', 'utf8');
    installPlugin('lister', { name: 'lister', enabled: true, tools: [] }, `
export const tools = [{
  name: 'ls_it', description: '',
  run: async (_a, ctx) => ctx.listDir('.').map((e) => e.type + ':' + e.name).sort().join(','),
}];`);
    await pm.refresh();
    const out = await pm.execute('ls_it', {});
    assert.ok(out.includes('file:a.txt') && out.includes('dir:sub'), `实际: ${out}`);
  });
});

describe('scaffold', () => {
  it('produces a plugin that loads and runs', async () => {
    assert.equal(pm.scaffold('my-scaffold', '测试用').dir, 'my-scaffold');
    await pm.refresh();
    assert.ok(pm.definitions().some((d) => d.name === 'my_scaffold_hello'),
      `模板应产出可调用工具，实际: ${pm.definitions().map((d) => d.name).join(', ')}`);
    const out = await pm.execute('my_scaffold_hello', { who: '测试' });
    assert.ok(out.includes('测试'), `实际: ${out}`);
  });

  it('refuses a duplicate name', () => {
    pm.scaffold('dup');
    assert.throws(() => pm.scaffold('dup'), /已存在/);
  });

  it('rejects a name that sanitises to nothing usable', () => {
    // "///" once became a plugin literally named "-".
    assert.throws(() => pm.scaffold('///'), /请填插件名/);
    assert.throws(() => pm.scaffold('...'), /请填插件名/);
    assert.throws(() => pm.scaffold(''), /请填插件名/);
  });
});

describe('source editing', () => {
  it('reads back what it wrote', () => {
    pm.scaffold('editable');
    assert.ok(pm.readSource('editable').module?.includes('export const tools'));
    pm.writeSource('editable', 'manifest.json', JSON.stringify({ name: 'editable', enabled: false }, null, 2));
    assert.equal(JSON.parse(pm.readSource('editable').manifest).enabled, false);
  });

  it('rejects invalid manifest JSON rather than corrupting the plugin', () => {
    pm.scaffold('guard');
    assert.throws(() => pm.writeSource('guard', 'manifest.json', '{ nope'), /不是合法 JSON/);
    assert.doesNotThrow(() => JSON.parse(pm.readSource('guard').manifest));
  });

  it('picks up an edited module on the next refresh', async () => {
    pm.scaffold('reload');
    await pm.refresh();
    assert.ok(pm.definitions().some((d) => d.name === 'reload_hello'));

    pm.writeSource('reload', 'index.mjs',
      `export const tools = [{ name: 'reload_hello', description: 'v2', run: async () => 'v2' }];`);
    await pm.refresh();
    assert.equal(await pm.execute('reload_hello', {}), 'v2', '编辑后应重新加载，而不是用缓存的旧模块');
  });
});

describe('uninstall', () => {
  it('removes an installed plugin and its tools', async () => {
    pm.installFromCatalog('env-doctor');
    await pm.refresh();
    assert.ok(pm.definitions().length > 0);

    pm.uninstall('env-doctor');
    await pm.refresh();
    assert.ok(!existsSync(join(appDir, 'env-doctor')));
    assert.equal(pm.definitions().length, 0, '卸载后工具应消失');
  });

  it('refuses to delete a workspace-local plugin', () => {
    const local = join(workspace, '.she', 'plugins', 'local-one');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'manifest.json'), JSON.stringify({ name: 'local-one' }), 'utf8');
    assert.throws(() => pm.uninstall('local-one'), /工作区内的插件/);
  });

  /*
   * Both of these shipped, and both were reachable from the HTTP API.
   *
   * `resolveDir` only stripped `/` and `\`, so `.` survived — and `join(root, '.')` normalises to
   * the plugins ROOT itself, which passed `startsWith(appPluginsDir)`. So
   * `DELETE /api/plugins?dir=.` deleted EVERY installed plugin and answered 200. `..` pointed at the
   * parent of the plugins directory, and `writeSource` had no containment check, so
   * `PUT /api/plugins/source?dir=..` wrote `index.mjs` / `manifest.json` into `~/.she-app/`.
   */
  it('【关键】dir=. 不会删掉整个插件目录', async () => {
    pm.installFromCatalog('env-doctor');
    await pm.refresh();
    assert.ok(existsSync(join(appDir, 'env-doctor')));

    assert.throws(() => pm.uninstall('.'), /未安装/, 'dir=. 必须被当作无效名称');
    assert.ok(existsSync(join(appDir, 'env-doctor')), '其它插件必须还在');
    assert.ok(existsSync(appDir), '插件根目录必须还在');
  });

  it('【关键】dir=.. 不能写到插件目录之外', async () => {
    pm.installFromCatalog('env-doctor');

    for (const hostile of ['..', '../..', '.', '', 'a/b', 'a\\b', '.hidden']) {
      assert.throws(
        () => pm.writeSource(hostile, 'index.mjs', 'PWNED'),
        /未安装/,
        `dir=${JSON.stringify(hostile)} 应当被拒绝`,
      );
    }
    // Nothing landed next to the plugins directory.
    assert.ok(!existsSync(join(root, 'app', 'index.mjs')), '上层目录不应出现插件文件');
    assert.ok(!existsSync(join(root, 'app', 'manifest.json')), '上层目录不应出现插件文件');
  });
});

describe('enable / disable', () => {
  it('persists the flag and drops the tools', async () => {
    pm.scaffold('toggle');
    await pm.refresh();
    assert.ok(pm.definitions().length > 0);

    pm.setEnabled('toggle', false);
    await pm.refresh();
    assert.equal(pm.definitions().length, 0, '停用后不应再提供工具');
  });
});

describe('manifest audit — declarations that cannot work', () => {
  it('flags tools declared with no module', () => {
    installPlugin('liar', {
      name: 'liar',
      enabled: true,
      tools: [{ name: 'ghost', description: '' }],
    });
    const found = pm.scan().find((p) => p.dir === 'liar')!;
    assert.ok(found.issues?.some((i) => /没有 index\.mjs/.test(i)), `实际: ${JSON.stringify(found.issues)}`);
  });

  it('flags a permission the runtime does not know', () => {
    // A shipped plugin used `chat.read` / `network.bind`, which nothing honours —
    // it looked healthy while promising capabilities it could not have.
    installPlugin('odd-perms', {
      name: 'odd-perms',
      enabled: true,
      permissions: ['read', 'chat.read', 'network.bind'],
      tools: [],
    }, 'export const tools = [];');
    const found = pm.scan().find((p) => p.dir === 'odd-perms')!;
    const issues = found.issues ?? [];
    assert.equal(issues.filter((i) => /未知权限/.test(i)).length, 2, `实际: ${JSON.stringify(issues)}`);
    assert.ok(!issues.some((i) => /「read」/.test(i)), '已知权限不该被报错');
  });

  it('flags a panel whose file is missing', () => {
    installPlugin('no-panel-file', {
      name: 'no-panel-file',
      enabled: true,
      tools: [],
      panels: [{ id: 'p', title: '缺文件的面板', entry: 'panel.html' }],
    }, 'export const tools = [];');
    const found = pm.scan().find((p) => p.dir === 'no-panel-file')!;
    assert.ok(found.issues?.some((i) => /缺少文件 panel\.html/.test(i)), `实际: ${JSON.stringify(found.issues)}`);
  });

  it('a panel whose file exists passes', () => {
    installPlugin('good-panel', {
      name: 'good-panel',
      enabled: true,
      tools: [],
      panels: [{ id: 'p', title: '好的面板', entry: 'panel.html' }],
    }, 'export const tools = [];');
    writeFileSync(join(appDir, 'good-panel', 'panel.html'), '<html></html>', 'utf8');
    const found = pm.scan().find((p) => p.dir === 'good-panel')!;
    assert.deepEqual(found.issues, []);
  });

  it('a healthy plugin reports no issues', async () => {
    pm.installFromCatalog('workspace-insight');
    const found = pm.scan().find((p) => p.dir === 'workspace-insight')!;
    assert.deepEqual(found.issues, [], `实际: ${JSON.stringify(found.issues)}`);
  });

  it('every bundled plugin is free of issues', () => {
    // A shipped plugin that mis-declares itself is a release defect.
    for (const entry of pm.catalog()) pm.installFromCatalog(entry.dir);
    for (const p of pm.scan()) {
      assert.deepEqual(p.issues, [], `${p.dir} 有问题: ${JSON.stringify(p.issues)}`);
    }
  });
});

describe('bundled plugins are valid', () => {
  it('every catalog entry loads and declares at least one tool', async () => {
    for (const entry of pm.catalog()) pm.installFromCatalog(entry.dir);
    await pm.refresh();
    // A shipped plugin that cannot load is a broken release, so this is asserted
    // rather than tolerated.
    const names = pm.definitions().map((d) => d.name);
    assert.ok(names.includes('ws_overview'), `workspace-insight 应提供 ws_overview，实际: ${names.join(', ')}`);
    assert.ok(names.includes('env_check'), `env-doctor 应提供 env_check，实际: ${names.join(', ')}`);
    assert.ok(names.includes('tunnel_providers'), `tunnel 应提供 tunnel_providers，实际: ${names.join(', ')}`);
  });

  it('ws_overview actually summarises a workspace', async () => {
    pm.installFromCatalog('workspace-insight');
    await pm.refresh();
    writeFileSync(join(workspace, 'app.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    const out = await pm.execute('ws_overview', {});
    assert.match(out, /源码文件/, `实际: ${out.slice(0, 200)}`);
    assert.ok(out.includes('.ts'), '应报告 .ts 统计');
    assert.ok(out.includes(workspace), `概览应写明扫的是哪个目录，实际: ${out.slice(0, 300)}`);
  });

  it('切换工作区后 ws_overview 扫新目录，而不是加载时的那个', async () => {
    pm.installFromCatalog('workspace-insight');
    await pm.refresh();
    writeFileSync(join(workspace, 'only-a.ts'), 'export const a = 1;\n', 'utf8');
    const first = await pm.execute('ws_overview', {});
    assert.match(first, /\.ts/);
    assert.doesNotMatch(first, /\.py/);

    const other = join(root, 'other-ws');
    mkdirSync(other);
    writeFileSync(join(other, 'only-b.py'), 'x = 1\n', 'utf8');
    workspace = other;

    const second = await pm.execute('ws_overview', {});
    assert.ok(second.includes(other), `应扫切换后的目录，实际: ${second.slice(0, 300)}`);
    assert.match(second, /\.py/);
    assert.doesNotMatch(second, /only-a\.ts/);
  });
});
