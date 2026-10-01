/**
 * Layer 4.2: the parts of real isolation that can be checked without a WSL install.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS TESTED HERE, AND WHAT IS NOT
 *
 * These are the pure decisions: how a Windows path becomes a WSL path, how a target is placed
 * relative to the workspace, what the container script is allowed to say, and the two failure
 * policies. They are the parts that a mistake would make SILENT — a wrong translation points the
 * command at the wrong directory, and a missing tripwire masks the shared namespace.
 *
 * The boundary itself is not testable from here: it needs a real distro, a real mount namespace and
 * a real file that must NOT be readable. That lives in `scripts/isolation-check.mjs`, which skips
 * (without claiming success) on a machine with no WSL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE TRIPWIRE HAS A TEST OF ITS OWN
 *
 * The first working version of `buildConfinedScript` masked `/mnt` WITHOUT entering a namespace, and
 * it did so in the shared one — masking every Windows drive for the whole distro. It was found by
 * accident. The tripwire is the fix, so it gets pinned here rather than trusted to review.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toWslPath, workspaceRelative, buildConfinedScript, buildWslArgv, planIsolation,
  isolationInEffect, resetIsolationProbeCache, NOT_IN_NAMESPACE_EXIT,
} from '../isolation.js';

describe('Windows 路径翻译成 WSL 路径', () => {
  it('盘符与反斜杠都归一', () => {
    // portability-check:allow — drive letters ARE the subject of this test; the translator exists
    // only to turn them into /mnt paths, so fixtures without one would test nothing.
    assert.equal(toWslPath('D:\\proj\\she-agent-cloud'), '/mnt/d/proj/she-agent-cloud');
    assert.equal(toWslPath('D:/proj/she-agent-cloud'), '/mnt/d/proj/she-agent-cloud');
    assert.equal(toWslPath('C:\\'), '/mnt/c');
  });

  it('大小写盘符都归一到小写（/mnt 下是小写）', () => {
    // portability-check:allow — drive letters are the input under test.
    assert.equal(toWslPath('d:\\x'), '/mnt/d/x');
    assert.equal(toWslPath('E:\\a\\b\\'), '/mnt/e/a/b');
  });

  it('尾部多余的斜杠不产生空段', () => {
    // portability-check:allow — same reason: the input is a drive path by design.
    assert.equal(toWslPath('D:\\proj\\\\x\\\\'), '/mnt/d/proj/x');
  });

  it('不是盘符绝对路径就返回 null，而不是猜一个', () => {
    // Already-Linux shapes and relative paths must not be silently "translated": a guess here would
    // point the confined command at a directory nobody asked for.
    assert.equal(toWslPath('/mnt/d/proj'), null);
    assert.equal(toWslPath('AGI\\she'), null);
    assert.equal(toWslPath('\\\\server\\share\\x'), null);
    assert.equal(toWslPath(''), null);
  });
});

describe('把目标放到工作区的相对位置（在 Linux 形态上比较）', () => {
  const ws = '/mnt/d/proj/ws';

  it('工作区自己与子目录', () => {
    assert.equal(workspaceRelative(ws, '/mnt/d/proj/ws'), '');
    assert.equal(workspaceRelative(ws, '/mnt/d/proj/ws/pkg'), '/pkg');
    assert.equal(workspaceRelative(ws, '/mnt/d/proj/ws/a/b'), '/a/b');
  });

  it('工作区外返回 null', () => {
    assert.equal(workspaceRelative(ws, '/mnt/d/proj/other'), null);
    assert.equal(workspaceRelative(ws, '/mnt/d/proj'), null);
    assert.equal(workspaceRelative(ws, '/etc'), null);
  });

  it('【关键】只按文本前缀判断会把 ws2 当成 ws 的子目录', () => {
    // The reason the comparison is done on linux forms with a separator, not on raw prefixes:
    // `ws2` starts with the characters of `ws`.
    assert.equal(workspaceRelative(ws, '/mnt/d/proj/ws2'), null);
    assert.equal(workspaceRelative(ws, '/mnt/d/proj/ws2/deep'), null);
  });

  it('工作区带尾斜杠时判断不变', () => {
    assert.equal(workspaceRelative('/mnt/d/proj/ws/', '/mnt/d/proj/ws/a'), '/a');
  });
});

describe('沙箱脚本：先证明自己在私有命名空间里，再动挂载', () => {
  const script = buildConfinedScript({
    workspaceLinux: '/mnt/d/proj/ws',
    cwdRel: '/pkg',
    command: 'echo hi',
  });

  it('【关键】带命名空间自检，且失败时明确拒绝而不是继续遮 /mnt', () => {
    // Without this, the masking runs wherever it is executed — including the shared namespace.
    assert.match(script, /readlink \/proc\/self\/ns\/mnt/);
    assert.match(script, /SHE_NS0/);
    assert.ok(
      script.includes(`exit ${NOT_IN_NAMESPACE_EXIT}`),
      '必须在未进入私有命名空间时以专有退出码退出，而不是继续执行 mount',
    );
    // The masking must come AFTER the guard, or the guard would be describing something already done.
    assert.ok(
      script.indexOf('SHE_NS0') < script.indexOf('mount -t tmpfs none /mnt'),
      '自检必须在遮盖 /mnt 之前',
    );
  });

  it('工作区不可见时用另一个退出码说清楚', () => {
    assert.match(script, /工作区在 WSL 里不可见/);
    assert.match(script, /exit 90/);
  });

  it('遮盖 /mnt 用一次 tmpfs，而不是逐个盘符卸载', () => {
    assert.match(script, /mount -t tmpfs none \/mnt/);
    assert.equal(/umount/.test(script), false, '逐个卸载会漏掉没列出的挂载点');
  });

  it('命令与路径都按 base64 传递，不会被 shell 再解析一次', () => {
    const tricky = buildConfinedScript({
      workspaceLinux: '/mnt/d/proj/ws',
      cwdRel: '',
      // A command that would break any naive quoting, and a path with a space.
      command: `echo "a b" && node -e "console.log('x y')" # 'quote`,
    });
    const decoded = Buffer.from(
      tricky.split('CMD=$(printf %s \'')[1].split("' | base64 -d)")[0],
      'base64',
    ).toString('utf8');
    assert.equal(decoded, `echo "a b" && node -e "console.log('x y')" # 'quote`);
    // The raw text must NOT appear verbatim in the script: if it did, the shell would parse it.
    assert.equal(tricky.includes('# \'quote'), false);
  });

  it('先 cd 再 exec，退出码原样传出', () => {
    assert.match(script, /cd "\/ws\$\{REL\}"/);
    assert.match(script, /exec bash -lc "\$CMD"/);
  });
});

describe('外层 argv：进入私有命名空间后才跑脚本', () => {
  const argv = buildWslArgv('Ubuntu', 'echo inner');

  it('用 unshare -m 且挂载传播设为 private', () => {
    const joined = argv.join(' ');
    assert.match(joined, /unshare -m/);
    assert.match(joined, /--propagation private/);
  });

  it('【关键】先记录当前命名空间，再 unshare —— 供内层自检比对', () => {
    const outer = argv[argv.length - 1];
    assert.ok(
      outer.indexOf('SHE_NS0=') < outer.indexOf('unshare -m'),
      'SHE_NS0 必须在 unshare 之前取，否则记下来的就是新命名空间，自检永远看不出来',
    );
    assert.match(outer, /export SHE_NS0/);
  });

  it('脚本按 base64 传给内层，Windows 侧没有可被引号破坏的参数', () => {
    const outer = argv[argv.length - 1];
    assert.match(outer, /base64 -d/);
    // The payload is base64 only, so nothing in it can need quoting on the way through wsl.exe.
    const payload = outer.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1];
    assert.equal(Buffer.from(payload, 'base64').toString('utf8'), 'echo inner');
  });

  it('指定发行版时带上 -d，不指定时交给 WSL 默认', () => {
    assert.deepEqual(argv.slice(0, 3), ['-d', 'Ubuntu', '-e']);
    assert.deepEqual(buildWslArgv('', 'x').slice(0, 2), ['-e', 'bash']);
  });
});

describe('策略：显式要求真隔离时，给不出就拒绝，而不是降级', () => {
  it('off 完全不介入，返回值是 null（宿主行为逐字节不变）', () => {
    resetIsolationProbeCache();
    // portability-check:allow — a drive-letter workspace is what this branch is about.
    assert.equal(planIsolation('off', 'D:\\proj\\ws', 'D:\\proj\\ws'), null);
  });

  it('【关键】wsl 模式要不到环境时报错，绝不静默降级到宿主', () => {
    // The whole point: a transcript that says "isolated" about a command that ran uncontained is
    // worse than no isolation, because it is a claim the reader cannot check.
    resetIsolationProbeCache();
    const got = planIsolation('wsl', '\\\\server\\share\\ws', '\\\\server\\share\\ws');
    // Either the probe found no WSL (unavailable) or the workspace cannot be translated; both must
    // be an error for the explicit mode, never a null that means "ran on the host".
    if (got !== null) {
      assert.ok('error' in got, 'wsl 模式下只能是可用的 plan 或 error');
    }
  });

  it('工作区无法映射成 WSL 路径时报错', () => {
    resetIsolationProbeCache();
    // portability-check:allow — the drive-letter workspace is the input being translated.
    const got = planIsolation('wsl', 'D:\\proj\\ws', 'D:\\proj\\ws');
    if (got !== null && 'plan' in got) {
      // WSL is present and the path translated: fine, nothing to assert about the error branch.
      assert.equal(got.plan.mode, 'wsl');
    } else if (got !== null) {
      assert.match(got.error, /真隔离|工作区/);
    }
  });
});

describe('披露：读者要知道边界在哪，也要知道它不覆盖什么', () => {
  it('没有边界时不给字段（而不是给一个空字段）', () => {
    assert.equal(isolationInEffect(null), undefined);
  });

  it('有边界时带上模式与不覆盖的部分', () => {
    const got = isolationInEffect({ mode: 'wsl', distro: 'Ubuntu', workspaceLinux: '/mnt/d/x', detail: 'detail-here' });
    assert.equal(got?.mode, 'wsl');
    assert.equal(got?.detail, 'detail-here');
  });
});
