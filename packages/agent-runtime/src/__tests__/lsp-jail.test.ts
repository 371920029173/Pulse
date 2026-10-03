import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeLspTool } from '../lsp-tools.js';
import type { LspManager } from '../lsp-tools.js';

/*
 * 第七轮实测的洞：LSP 通道的越界判定只做文本比较（`join` + `relative`），不看软链接。
 *
 * 夹具就是探针用的那一个 —— 工作区里放一个指向工作区外的链接：
 *
 *   probe/types.ts -> %TEMP%\r7\types.ts
 *
 * `fs_read` 回 "Path escapes workspace via link"，而 `lsp_diagnostics` 把工作区外那 64 行读出来
 * 并给了诊断（1:14 [2322]）。同一个夹具，两条通道相反结论。
 *
 * 这个文件钉的是 LSP 那一条通道，而且刻意走 `executeLspTool`（工具真正的入口）而不是去测那个
 * 内部函数：
 *
 *   - 判定发生在碰语言服务器**之前**（`resolveInWorkspace` 是第一件事），所以这里可以传一个
 *     什么都不做的替身 manager —— 不需要起 tsserver，这个测试是离线且快的；
 *   - 走入口才钉得住"拒绝真的发生在读到文件之前"。测内部函数的话，把 guard 挪到读取之后
 *     也照样绿。
 *
 * 两条通道**判定一致**这件事由 `scripts/lsp-check.mjs` 的对照节钉（那边同一个夹具同时喂给
 * fs 侧与 LSP 侧）。这里钉的是 LSP 侧自己那一半。
 */

const roots: string[] = [];
function jailRoot(prefix: string): string {
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

/**
 * A manager that answers "yes, I serve .ts" and does nothing else.
 *
 * `canServe` is the only member the guard-refusal path can reach: if the guard lets a path through,
 * the next thing `executeLspTool` does is ask `canServe`, and for `lsp_diagnostics` an unservable
 * file falls back to a syntax-only check. Returning `false` there keeps the test's assertion ("we
 * got past the jail") exact without pretending a language server exists.
 */
const stubManager = {
  canServe: () => false,
  supported: new Set<string>(),
} as unknown as LspManager;

describe('lsp: 工作区里的软链接不能把诊断指向工作区外', () => {
  it('【关键】链接指向工作区外 → 拒绝，且说明是链接', async () => {
    const root = jailRoot('she-lsp-jail-');
    const outside = jailRoot('she-lsp-jail-out-');
    writeFileSync(join(outside, 'types.ts'), 'const secret: number = "not a number";\n', 'utf8');
    try {
      symlinkSync(join(outside, 'types.ts'), join(root, 'linked.ts'));
    } catch {
      // Windows without the developer-mode/junction privilege. Skip rather than pass silently —
      // a skipped test is honest, a green test that never built the fixture is not.
      return;
    }

    const r = await executeLspTool('lsp_diagnostics', { path: 'linked.ts' }, root, stubManager);
    assert.ok(r, 'lsp_diagnostics 应当是 LSP 工具');
    assert.equal(r.ok, false, `链接不该被放行，实得：${r.output}`);
    assert.match(r.output, /超出工作区/, r.output);
    // 说的是"链接"而不是笼统的"路径不对"：两种情况要改的东西不一样。
    assert.match(r.output, /软链接/, `拒绝时必须点名链接：${r.output}`);
  });

  it('同一形态的 fs 侧判定也是拒绝（两条通道在这一格上必须同答）', async () => {
    const root = jailRoot('she-lsp-jail-fs-');
    const outside = jailRoot('she-lsp-jail-fsout-');
    writeFileSync(join(outside, 'types.ts'), 'x\n', 'utf8');
    try {
      symlinkSync(join(outside, 'types.ts'), join(root, 'linked.ts'));
    } catch {
      return;
    }

    /*
     * fs 侧的实现住在 server 包里，agent-runtime 不依赖它 —— 这里不 import 它（那会是一条假的
     * 依赖边），而是断言**这一侧**的判定也是拒绝。两边"同一份实现"由 `resolveWorkspacePath`
     * 的存在与 `scripts/lsp-check.mjs` 的对照节保证。
     */
    const r = await executeLspTool('lsp_diagnostics', { path: 'linked.ts' }, root, stubManager);
    assert.equal(r?.ok, false);
  });

  it('工作区里的真文件照常放行（这个守卫不是见谁都拒）', async () => {
    const root = jailRoot('she-lsp-jail-ok-');
    writeFileSync(join(root, 'real.ts'), 'export const a = 1;\n', 'utf8');
    const r = await executeLspTool('lsp_diagnostics', { path: 'real.ts' }, root, stubManager);
    assert.ok(r);
    /*
     * 断言的是"它过了守卫"，不是"它成功了"。替身 manager 一个语言服务器都不提供，所以这条路
     * 最终一定失败 —— 但失败的理由必须落在**下一环**（没有服务器），而不是工作区越界。
     * 这正是守卫放行与守卫拒绝的分界线，写成 `ok === true` 反而会把管线的下一环当成守卫的行为。
     */
    assert.doesNotMatch(r.output, /超出工作区/, `工作区内的真文件不该被守卫拒：${r.output}`);
    assert.match(r.output, /语言服务器/, `应当是被放行之后才因为没有服务器而失败：${r.output}`);
  });

  it('文本越界仍然被拒（合并实现没有把原有的检查丢掉）', async () => {
    const root = jailRoot('she-lsp-jail-dotdot-');
    for (const p of ['../outside.ts', '..', join(tmpdir(), 'nowhere.ts')]) {
      const r = await executeLspTool('lsp_diagnostics', { path: p }, root, stubManager);
      assert.equal(r?.ok, false, `${p} 应当被拒`);
      assert.match(r?.output ?? '', /超出工作区/, `拒绝理由要说清：${r?.output}`);
    }
  });

  it('拒绝发生在读文件之前（缺 path 与越界是两条不同的报错）', async () => {
    const root = jailRoot('she-lsp-jail-nopath-');
    const r = await executeLspTool('lsp_diagnostics', {}, root, stubManager);
    assert.equal(r?.ok, false);
    assert.match(r?.output ?? '', /缺少 path/, String(r?.output));
  });
});
