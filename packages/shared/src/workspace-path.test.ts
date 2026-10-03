import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInsideDir, resolveWorkspacePath, jailWorkspacePath, realPathInWorkspace } from './workspace-path.js';

/*
 * 工作区围墙的唯一一份实现。
 *
 * 这些用例之所以放在 shared 而不是各调用方的包里：**四条通道（fs / shell / HTTP / LSP）判定一致
 * 这件事，不能靠四个地方各测一遍来保证**。第七轮实测的缺陷就是这个形状 —— 三份实现各自跟着软链接
 * 复查，第四份（`lsp-tools.ts`）漏了，于是同一个夹具在 `fs_read` 与 `lsp_diagnostics` 得到相反结论。
 * 现在判定只有一份，所以这些用例覆盖的就是全部四条通道的判定。
 *
 * 两条性质值得单独说：
 *   - **拒绝的理由分两种**（文本越界 / 软链接越界），因为下一步要改的东西不一样；
 *   - **`abs` 与 `real` 是两个不同的答案**，调用方要哪个是明确的（回显用 `abs`，打开文件用 `real`）。
 */

const roots: string[] = [];
function tmp(prefix: string): string {
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

/** `null` when this machine will not create a link (Windows without the privilege). */
function tryLink(target: string, at: string): boolean {
  try { symlinkSync(target, at); return true; } catch { return false; }
}

describe('isInsideDir：容器判定', () => {
  it('共享前缀不算包含（startsWith 的经典错法）', () => {
    const base = join('tmp', 'skills');
    assert.equal(isInsideDir(base, join('tmp', 'skills-backup', 'x.md')), false);
    assert.equal(isInsideDir(base, join('tmp', 'skills', 'x.md')), true);
  });

  it('容器本身默认不是合法目标，显式打开才算', () => {
    const base = join('tmp', 'skills');
    assert.equal(isInsideDir(base, base), false);
    assert.equal(isInsideDir(base, base, true), true);
  });

  it('上面的路一律不算', () => {
    assert.equal(isInsideDir(join('tmp', 'a', 'b'), join('tmp', 'a')), false);
    assert.equal(isInsideDir(join('tmp', 'a'), join('tmp')), false);
  });
});

describe('resolveWorkspacePath：文本判定', () => {
  it('区内路径原样通过，三种形状都给对', () => {
    const root = tmp('she-wsp-root-');
    const r = resolveWorkspacePath(root, 'src/a.ts');
    // `abs` 是**文本**形态：调用方要原样回显用户写的路径，所以它不该被展开或改写。
    assert.equal(r.abs, join(root, 'src', 'a.ts'));
    assert.equal(r.rel, join('src', 'a.ts'));
    // `real` 是**真实**形态，两者可以不同（Windows 上根可能带 8.3 短名，`realpath` 会给长名）。
    assert.ok(r.real.endsWith(join('src', 'a.ts')), `real 应当指向同一个文件：${r.real}`);
  });

  it('【关键】父目录还没建出来时也放行（这条曾经被误判成"软链接越界"）', () => {
    const root = tmp('she-wsp-noparent-');
    /*
     * 收成一份实现之后写这条用例才发现的坑：旧的四份都只回退**一层父目录**去展开。父目录也不存在
     * 时回退也失败，`real` 停在 `os.tmpdir()` 给的 8.3 短名上，而 `realRoot` 已经是长名 —— 同一个
     * 目录被判成"逃逸"，拒绝的是工作区**里面**的路径。
     *
     * 交付里没有这个形状的用例，所以四份实现里没有一份被测过这条路。
     */
    const r = resolveWorkspacePath(root, join('deep', 'not', 'yet', 'a.ts'));
    assert.equal(r.abs, join(root, 'deep', 'not', 'yet', 'a.ts'));
    assert.ok(r.real.endsWith(join('deep', 'not', 'yet', 'a.ts')), `real 应当保留缺的那几段：${r.real}`);
  });

  it('空路径按工作区根处理（四个调用方原来都这么写）', () => {
    const root = tmp('she-wsp-empty-');
    assert.equal(resolveWorkspacePath(root, '').abs, resolveWorkspacePath(root, '.').abs);
  });

  it('`..` 被拒，且说的是文本越界', () => {
    const root = tmp('she-wsp-dotdot-');
    for (const p of ['../x', 'a/../../x', '..']) {
      assert.throws(() => resolveWorkspacePath(root, p), /Path escapes workspace: /, `${p} 应当被拒`);
    }
  });

  it('工作区外的绝对路径被拒（`resolve` 会静默返回它）', () => {
    const root = tmp('she-wsp-abs-');
    assert.throws(() => resolveWorkspacePath(root, join(tmpdir(), 'somewhere-else.txt')),
      /Path escapes workspace: /);
  });
});

describe('resolveWorkspacePath：软链接复查（第七轮那个洞）', () => {
  it('【关键】区内链接指向区外 → 拒绝，且说的是"链接"而不是笼统的越界', () => {
    const root = tmp('she-wsp-link-in-');
    const outside = tmp('she-wsp-link-out-');
    writeFileSync(join(outside, 'types.ts'), 'export const x = 1;\n');
    if (!tryLink(join(outside, 'types.ts'), join(root, 'linked.ts'))) return; // 没有建链权限

    assert.throws(
      () => resolveWorkspacePath(root, 'linked.ts'),
      /Path escapes workspace via link: /,
      '文本上在区内、真实目标在区外，必须按软链接拒绝',
    );
  });

  it('两个出口都不放行，也不会因为用 realpath 就绕过检查', () => {
    const root = tmp('she-wsp-link-two-');
    const outside = tmp('she-wsp-link-two-out-');
    writeFileSync(join(outside, 'f.txt'), 'x\n');
    if (!tryLink(join(outside, 'f.txt'), join(root, 'l.txt'))) return;

    assert.throws(() => jailWorkspacePath(root, 'l.txt'), /via link: /);
    assert.throws(() => realPathInWorkspace(root, 'l.txt'), /via link: /);
  });

  it('指向区内的链接照常放行（这个复查不是见链接就拒）', () => {
    const root = tmp('she-wsp-link-ok-');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'f.txt'), 'x\n');
    if (!tryLink(join(root, 'sub'), join(root, 'link-to-sub'))) return;

    // 目标在区内 → 放行；`real` 指向真实目标，`abs` 保留调用方写的那条路径。
    const r = resolveWorkspacePath(root, join('link-to-sub', 'f.txt'));
    assert.ok(r.real.endsWith('f.txt'));
    assert.ok(!r.real.includes('link-to-sub'), `real 应当是展开后的路径：${r.real}`);
    assert.ok(r.abs.includes('link-to-sub'), `abs 应当保留调用方写的路径：${r.abs}`);
  });

  it('真实父目录在区外的"新建文件"路径也被拒（回退不是放宽）', () => {
    const root = tmp('she-wsp-link-new-');
    const outside = tmp('she-wsp-link-new-out-');
    if (!tryLink(outside, join(root, 'outdir'))) return;

    // `outdir/not-yet.txt` 还不存在，回退到父目录 —— 而父目录的真实位置在区外。
    assert.throws(() => resolveWorkspacePath(root, join('outdir', 'not-yet.txt')), /via link: /);
  });
});
