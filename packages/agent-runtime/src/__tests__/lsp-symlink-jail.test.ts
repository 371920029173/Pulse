import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KNOWN_SERVERS, resolveServer } from '../lsp-client.js';
import { LspManager, executeLspTool } from '../lsp-tools.js';

/*
 * R7 复核：工作区里的软链接 / 联接点 / `..` 不能把 LSP 工具带到工作区外。
 *
 * `lsp-jail.test.ts` 钉的是文件软链接（Windows 没有开发者模式时会跳过）。这里补上：
 *   - 目录联接点（`junction`，Windows 不要管理员，所以这一格在 Windows 上不会跳过）；
 *   - 四个 LSP 工具全部走一遍，而且用一个记录调用的替身语言服务器 —— 断言的不只是"报了错"，
 *     而是区外的内容**从未送进语言服务器**；
 *   - 区内的合法链接仍然放行，不存在的路径给的是"读不到"而不是越界；
 *   - 输出一侧：语言服务器把 definition/references 指到区外时，结果里不回显区外的目录。
 */

const MARKER = 'SECRET_MARKER_R7';
const TOOLS = ['lsp_diagnostics', 'lsp_definition', 'lsp_references', 'lsp_hover'] as const;

const roots: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
after(async () => {
  for (const root of roots) {
    for (let attempt = 0; attempt < 12; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => { setTimeout(r, 250); }); }
    }
  }
});

/** 建链接；系统不让建时返回 false，由调用方跳过（跳过是诚实的，没建成夹具却绿不是）。 */
function tryLink(target: string, path: string, type: 'file' | 'dir' | 'junction'): boolean {
  try { symlinkSync(target, path, type); return true; } catch { return false; }
}

interface Fixture { root: string; outside: string; secret: string }

function fixture(): Fixture {
  const base = tempDir('she-lsp-r7-');
  const root = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(join(root, 'sub'));
  const secret = join(outside, 'secret.ts');
  writeFileSync(secret, '/** ' + MARKER + ' */\nexport const ' + MARKER + ': number = "leak";\nexport function secretFn(): string { return "' + MARKER + '"; }\n', 'utf8');
  writeFileSync(join(root, 'real.ts'), 'export const realValue: number = 1;\n', 'utf8');
  writeFileSync(join(root, 'sub', 'inner.ts'), 'export const innerValue: number = 2;\n', 'utf8');
  return { root, outside, secret };
}

/**
 * 一个会记录"送进来什么"的替身语言服务器。`locations` 是 definition/references 要返回的位置。
 */
function fakeManager(locations: unknown = null) {
  const opened: Array<{ abs: string; text: string }> = [];
  const record = async (abs: string, _lang: string, text: string) => { opened.push({ abs, text }); };
  const server = {
    diagnosticsFor: async (abs: string, lang: string, text: string) => { await record(abs, lang, text); return []; },
    definition: async (abs: string, lang: string, text: string) => { await record(abs, lang, text); return locations; },
    references: async (abs: string, lang: string, text: string) => { await record(abs, lang, text); return locations; },
    hover: async (abs: string, lang: string, text: string) => { await record(abs, lang, text); return { contents: 'hover' }; },
  };
  const manager = {
    canServe: () => true,
    supported: new Set(['typescript']),
    serverForFile: async () => server,
  } as unknown as LspManager;
  return { manager, opened };
}

async function expectRefused(root: string, p: string, viaLink: boolean) {
  const { manager, opened } = fakeManager();
  for (const tool of TOOLS) {
    const r = await executeLspTool(tool, { path: p, line: 2, column: 14 }, root, manager);
    assert.ok(r, tool);
    assert.equal(r.ok, false, tool + ' ' + p + ' 不该被放行：' + r.output);
    assert.match(r.output, /路径超出工作区/, r.output);
    if (viaLink) assert.match(r.output, /软链接指向工作区外/, r.output);
    assert.doesNotMatch(r.output, new RegExp(MARKER), r.output);
  }
  assert.deepEqual(opened, [], '区外的文件不该送进语言服务器：' + JSON.stringify(opened.map((o) => o.abs)));
}

describe('lsp R7：输入路径的软链接 / 联接点 / .. 逃逸', () => {
  it('文件软链接指向区外 → 四个工具都拒，且点名链接', async (t) => {
    const f = fixture();
    if (!tryLink(f.secret, join(f.root, 'file-link.ts'), 'file')) { t.skip('系统不允许创建文件软链接'); return; }
    await expectRefused(f.root, 'file-link.ts', true);
  });

  it('目录联接点指向区外 → 四个工具都拒（已存在与不存在的文件都拒）', async (t) => {
    const f = fixture();
    // junction 在 Windows 上不要管理员；POSIX 上 type 被忽略，建的是目录软链接。
    if (!tryLink(f.outside, join(f.root, 'jdir'), 'junction')) {
      if (process.platform === 'win32') assert.fail('Windows 上 junction 不要管理员，应当能建成');
      t.skip('系统不允许创建目录链接');
      return;
    }
    await expectRefused(f.root, 'jdir/secret.ts', true);
    await expectRefused(f.root, 'jdir/not-yet.ts', true);
  });

  it('.. 与绝对路径逃逸 → 四个工具都拒', async () => {
    const f = fixture();
    tryLink(f.outside, join(f.root, 'jdir'), 'junction');
    for (const p of ['../outside/secret.ts', 'sub/../../outside/secret.ts', 'jdir/../../outside/secret.ts', f.secret]) {
      await expectRefused(f.root, p, false);
    }
  });

  it('区内指向区内的链接仍然放行（守卫不是见链接就拒）', async (t) => {
    const f = fixture();
    const linked: string[] = [];
    if (tryLink(join(f.root, 'sub'), join(f.root, 'legit-jdir'), 'junction')) linked.push('legit-jdir/inner.ts');
    if (tryLink(join(f.root, 'real.ts'), join(f.root, 'legit-link.ts'), 'file')) linked.push('legit-link.ts');
    if (process.platform === 'win32') assert.ok(linked.includes('legit-jdir/inner.ts'), 'Windows 上 junction 应当能建成');
    if (!linked.length) { t.skip('系统不允许创建链接'); return; }
    for (const p of linked) {
      const { manager, opened } = fakeManager();
      for (const tool of TOOLS) {
        const r = await executeLspTool(tool, { path: p, line: 1, column: 14 }, f.root, manager);
        assert.equal(r?.ok, true, tool + ' ' + p + '：' + r?.output);
      }
      assert.equal(opened.length, TOOLS.length, p);
      assert.match(opened[0].text, /realValue|innerValue/, '送进服务器的应当是区内文件的内容');
    }
  });

  it('不存在的区内路径：报"读不到"而不是越界，也不崩', async () => {
    const f = fixture();
    const { manager, opened } = fakeManager();
    for (const tool of TOOLS) {
      const r = await executeLspTool(tool, { path: 'nope/deep/x.ts', line: 1, column: 1 }, f.root, manager);
      assert.equal(r?.ok, false, String(r?.output));
      assert.doesNotMatch(String(r?.output), /超出工作区/, String(r?.output));
      assert.match(String(r?.output), /无法读取/, String(r?.output));
    }
    assert.deepEqual(opened, []);
  });
});

describe('lsp R7：语言服务器返回的位置不回显区外目录', () => {
  const at = (file: string, line: number, character: number) => ({ uri: pathToFileURL(file).href, range: { start: { line, character }, end: { line, character } } });

  it('区外位置只给文件名并标 [工作区外]，区内位置照旧是相对路径', async () => {
    const f = fixture();
    const junction = tryLink(f.outside, join(f.root, 'jdir'), 'junction');
    const legit = tryLink(join(f.root, 'sub'), join(f.root, 'legit-jdir'), 'junction');
    const locations: unknown[] = [
      at(join(f.root, 'real.ts'), 0, 13),
      at(f.secret, 2, 16),                                   // 直接 ../ 出去
      { targetUri: pathToFileURL(join(f.outside, 'gone.ts')).href, targetRange: { start: { line: 0, character: 0 } } },
    ];
    if (junction) locations.push(at(join(f.root, 'jdir', 'secret.ts'), 1, 13)); // 经区外联接点
    if (legit) locations.push(at(join(f.root, 'legit-jdir', 'inner.ts'), 0, 13)); // 经区内联接点
    const { manager } = fakeManager(locations);
    for (const tool of ['lsp_definition', 'lsp_references']) {
      const r = await executeLspTool(tool, { path: 'real.ts', line: 1, column: 14 }, f.root, manager);
      const out = String(r?.output);
      assert.equal(r?.ok, true, out);
      assert.match(out, /^real\.ts:1:14$/m, out);
      assert.match(out, /^\[工作区外\] secret\.ts:3:17$/m, out);
      assert.match(out, /^\[工作区外\] gone\.ts:1:1$/m, out);
      if (junction) assert.match(out, /^\[工作区外\] secret\.ts:2:14$/m, out);
      if (legit) assert.match(out, /^legit-jdir[\\/]inner\.ts:1:14$/m, out);
      assert.doesNotMatch(out, /outside|\.\.[\\/]|^[a-z]:/im, '不该回显区外目录：' + out);
      assert.doesNotMatch(out, /jdir[\\/]secret/, '经联接点的区外文件不该伪装成区内路径：' + out);
      assert.match(out, /位置在工作区之外/, out);
    }
  });

  it('工作区根与服务器报的路径写法不同（8.3 短名 / 长名）时不误标成区外', async () => {
    const f = fixture();
    const realRoot = realpathSync.native(f.root);
    const { manager } = fakeManager([at(join(realRoot, 'real.ts'), 0, 13), at(join(f.root, 'sub', 'inner.ts'), 0, 0)]);
    const r = await executeLspTool('lsp_definition', { path: 'real.ts', line: 1, column: 14 }, f.root, manager);
    const out = String(r?.output);
    assert.match(out, /^real\.ts:1:14$/m, out);
    assert.match(out, /^sub[\\/]inner\.ts:1:1$/m, out);
    assert.doesNotMatch(out, /工作区外/, out);
  });

  const spec = KNOWN_SERVERS.find((s) => s.id === 'typescript');
  const probeRoot = tempDir('she-lsp-r7-probe-');
  const launch = spec ? resolveServer(spec, probeRoot) : null;

  it('真实 tsserver：经联接点 / ../ import 的区外定义不回显区外路径', { skip: !launch, timeout: 90_000 }, async (t) => {
    const f = fixture();
    if (!tryLink(f.outside, join(f.root, 'jdir'), 'junction')) { t.skip('系统不允许创建目录链接'); return; }
    writeFileSync(join(f.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2020' }, include: ['**/*.ts'] }));
    writeFileSync(join(f.root, 'main.ts'), "import { " + MARKER + " } from './jdir/secret';\nimport { secretFn } from '../outside/secret';\nconst a = " + MARKER + ";\nconst b = secretFn();\nexport { a, b };\n");
    const manager = new LspManager(f.root);
    try {
      // 入口一侧：真实服务器下也先被围墙拒掉。
      const viaJunction = await executeLspTool('lsp_diagnostics', { path: 'jdir/secret.ts' }, f.root, manager);
      assert.equal(viaJunction?.ok, false, String(viaJunction?.output));
      for (const [line, column] of [[3, 11], [4, 11]]) {
        for (const tool of ['lsp_definition', 'lsp_references']) {
          const r = await executeLspTool(tool, { path: 'main.ts', line, column }, f.root, manager);
          const out = String(r?.output);
          assert.equal(r?.ok, true, out);
          assert.match(out, /\[工作区外\] secret\.ts:\d+:\d+/, out);
          assert.doesNotMatch(out, /outside|\.\.[\\/]|jdir[\\/]secret/i, out);
        }
      }
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  });
});
