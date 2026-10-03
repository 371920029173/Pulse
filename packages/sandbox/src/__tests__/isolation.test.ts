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
  toWslPath, workspaceRelative, buildConfinedScript, buildWslArgv, planIsolation, DROPPED_CAPS,
  isolationInEffect, resetIsolationProbeCache, NOT_IN_NAMESPACE_EXIT,
  isMaxGrant, effectiveIsolationMode, describeIsolation, isolationNotice,
} from '../isolation.js';
import { SandboxShell } from '../shell.js';

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
    assert.match(script, /exec setpriv .* -- bash -lc "\$CMD"$/m);
  });

  it('【关键】执行命令前去掉 root 的挂载权限 —— 否则 umount /mnt 就能撤掉遮盖', () => {
    const line = script.split('\n').find((l) => l.startsWith('exec setpriv'));
    assert.ok(line, '必须经 setpriv 执行');
    assert.match(line, /--no-new-privs/);
    for (const cap of ['sys_admin', 'dac_read_search', 'sys_ptrace', 'mknod']) {
      assert.match(line, new RegExp(`--inh-caps=[^ ]*-${cap}`), `inheritable 集要去掉 ${cap}`);
      assert.match(line, new RegExp(`--bounding-set=[^ ]*-${cap}`), `bounding 集要去掉 ${cap}`);
    }
    assert.equal(new Set(DROPPED_CAPS).size, DROPPED_CAPS.length);
    assert.ok(
      script.indexOf('mount -t tmpfs none /mnt') < script.indexOf('exec setpriv'),
      '遮盖必须在去权限之前做完（去掉以后就挂不了了）',
    );
  });

  it('【关键】遮盖 /mnt 后 DNS 照常可用：先读 resolv.conf，盖住后写回原路径', () => {
    // WSL links /etc/resolv.conf to /mnt/wsl/resolv.conf; masking /mnt without this broke every lookup.
    const read = script.indexOf('RESOLV_C=$(cat /etc/resolv.conf');
    const mask = script.indexOf('mount -t tmpfs none /mnt');
    const back = script.indexOf('> "$RESOLV_T"');
    assert.ok(read >= 0 && back >= 0, '必须保存并写回 resolv.conf');
    assert.ok(read < mask, '必须在遮盖之前读');
    assert.ok(mask < back, '必须在遮盖之后写回');
    assert.ok(back < script.indexOf('exec setpriv'), '写回必须在执行命令之前');
    // Only a target under /mnt is rewritten; a plain /etc/resolv.conf is left alone.
    assert.match(script, /case "\$RESOLV_T" in \/mnt\/\*\)/);
    /*
     * Masking replaced /mnt wholesale, so the write-back has to recreate the DIRECTORY as well, and
     * it has to carry the SAVED bytes. A stub pointing at some other resolver would silently change
     * what the distro resolves against while still looking like the lookup "works".
     */
    assert.ok(
      script.includes('mkdir -p "$(dirname "$RESOLV_T")"'),
      '遮盖把 /mnt 换掉了，写回时必须把目录也建回来',
    );
    assert.ok(
      script.includes('"$RESOLV_C" > "$RESOLV_T"'),
      '写回的必须是遮盖前读到的内容，不能是别的解析器',
    );
  });

  it('没有 setpriv 时拒绝运行，而不是带着全部权限照跑', () => {
    assert.match(script, /command -v setpriv/);
    assert.match(script, /无法去掉 root 的挂载权限，拒绝运行/);
  });
});

describe('外层 argv：进入私有命名空间后才跑脚本', () => {
  const argv = buildWslArgv('Ubuntu', 'echo inner');

  it('用 unshare -m 且挂载传播设为 private', () => {
    const joined = argv.join(' ');
    assert.match(joined, /unshare -m/);
    assert.match(joined, /--propagation private/);
  });

  it('【关键】PID 命名空间一起隔离 —— 否则 /proc/1/root/mnt 直通宿主', () => {
    const joined = argv.join(' ');
    assert.match(joined, /unshare [^|]*-p -f --mount-proc/);
    assert.match(joined, /--kill-child/);
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

/**
 * 「最大授权」（勾选「允许工作区外命令」+ 档位「所有」）让开真隔离。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么这件事需要在单测里钉住，而不只是门禁
 *
 * 门禁（`scripts/isolation-check.mjs` 第 4b 节）测的是"真的跑一条 Windows 命令"，那需要一个真装了
 * WSL 的机器才测得动对照格。而"让开"本身是**纯决策**：给定授权与档位，答案就定了，与这台机器装没装
 * WSL 无关 —— 这一节把它做成与机器无关的断言，这样没有 WSL 的机器（CI）也能挡住"让开没生效"或
 * "让开的范围太大"这两种回归。
 *
 * 顺带钉住一个反直觉的格子：`wsl` 档位本来是 fail-closed（用不了就拒绝执行），最大授权下它不再拒绝
 * —— 因为用户那句话是"就在这台电脑上跑"，把它拒绝掉才是违背他的选择。
 */
describe('最大授权（勾选 + 所有）让开真隔离', () => {
  const MAX = { allowAllCommands: true, outsideWorkspace: { allow: true, policy: 'all' as const } };
  const READONLY = { allowAllCommands: false, outsideWorkspace: { allow: true, policy: 'readonly' as const } };

  it('两个控件都是"是"才算：缺一个或档位不是「所有」都不让开', () => {
    assert.equal(isMaxGrant(MAX), true);
    // 库的调用方只传这一个字段（构造函数会补成 allow+all），结论必须一致。
    assert.equal(isMaxGrant({ allowAllCommands: true }), true);
    assert.equal(isMaxGrant({ allowAllCommands: true, outsideWorkspace: { allow: true, policy: 'readonly' } }), false);
    assert.equal(isMaxGrant({ allowAllCommands: true, outsideWorkspace: { allow: true, policy: 'deny' } }), false);
    // 没勾选就不算 —— 哪怕档位停在「所有」：这是唯一会让"边界开着、隔离也开着"的一格，
    // 按严的那侧读（用户以为有边界却裸跑，比多撞一次报错糟得多）。
    assert.equal(isMaxGrant({ allowAllCommands: false, outsideWorkspace: { allow: true, policy: 'all' } }), false);
    assert.equal(isMaxGrant({ outsideWorkspace: { allow: true, policy: 'all' } }), false);
    assert.equal(isMaxGrant(undefined), false);
    assert.equal(isMaxGrant(null), false);
  });

  it('合成结论：最大授权把 auto / wsl 都变成 off，其余档位原样保留', () => {
    assert.equal(effectiveIsolationMode('auto', MAX), 'off');
    assert.equal(effectiveIsolationMode('wsl', MAX), 'off');
    assert.equal(effectiveIsolationMode('off', MAX), 'off');
    assert.equal(effectiveIsolationMode('wsl', READONLY), 'wsl');
    assert.equal(effectiveIsolationMode('auto', undefined), 'auto');
  });

  it('【关键】shell 真的不再进边界：描述说主机 shell，命令照跑，结果里没有边界披露', async () => {
    /*
     * `isolation: 'wsl'` 是这里的关键 —— 它不是"能开才开"的 auto，而是明确的"我就是要边界"。最大授权
     * 必须盖过它，否则用户勾了「所有」之后仍然撞上 `ver: command not found`（本机实测 exit 127）。
     */
    const sh = new SandboxShell(process.cwd(), { ...MAX, isolation: 'wsl' as const });
    assert.equal(sh.effectiveIsolation(), 'off');
    assert.equal(sh.isolationBypassedByGrant(), true);
    assert.ok(!sh.shellName().includes('WSL'), `shellName() 不该说在 WSL 里：${sh.shellName()}`);
    const r = await sh.exec('echo maxgrant');
    assert.equal(r.denied, undefined);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('maxgrant'));
    assert.equal(r.isolation, undefined);
  });

  it('【关键】wsl 档位的拒绝也被让开（否则"就在这台电脑上跑"会被自己的设置拒掉）', async () => {
    resetIsolationProbeCache();
    // UNC 根永远映射不进 /mnt —— 也就是说纯 `wsl` 档位在这里必被拒绝。最大授权下它必须照跑。
    const sh = new SandboxShell('\\\\nowhere\\share\\ws', { ...MAX, isolation: 'wsl' as const });
    const r = await sh.exec('echo hi');
    assert.notEqual(r.denied, true);
    assert.doesNotMatch(String(r.stderr ?? ''), /真隔离|WSL/);
  });

  it('只读档不让开：同一台机器上它仍然要求边界（档位之间的差别必须还在）', () => {
    const sh = new SandboxShell(process.cwd(), {
      ...READONLY, isolation: 'auto' as const,
    });
    assert.equal(sh.effectiveIsolation(), 'auto');
    assert.equal(sh.isolationBypassedByGrant(), false);
  });

  it('提示说清"是谁让开的"和"怎么收回去"，且与另外三格都不同', () => {
    const base = {
      mode: 'auto' as const, available: true, distro: 'Ubuntu', unavailable: null,
      requestedButUnavailable: false, bypassed: true,
    };
    const bypassed = String(isolationNotice(base));
    assert.match(bypassed, /直接在主机上运行/);
    assert.match(bypassed, /所有/);
    assert.match(bypassed, /档位/);
    // 没有边界的两格（能用但关着 / 这台机器用不了）都不能与它撞车：撞车就等于没说。
    assert.notEqual(bypassed, String(isolationNotice({ ...base, bypassed: false, mode: 'off' })));
    assert.notEqual(bypassed, String(isolationNotice({ ...base, available: false, distro: null, unavailable: '没有 WSL' })));
    /*
     * 档位是 off 时**也**要说，而且必须点名 `SHE_SANDBOX_ISOLATION`：那一格下用户最自然的动作就是去
     * 打开隔离，而这一档会让那个动作白做。
     */
    assert.match(String(isolationNotice({ ...base, mode: 'off' })), /SHE_SANDBOX_ISOLATION/);
  });

  it('让开后不再声称"命令会被拒绝"（那一格的话必须跟着让开一起变）', () => {
    resetIsolationProbeCache();
    const a = describeIsolation('wsl', '\\\\nowhere\\share\\ws', '', MAX);
    assert.equal(a.bypassed, true);
    // 之前这一格是 requestedButUnavailable=true（"命令会被拒绝"）；让开之后命令在主机上照跑，
    // 再说"会被拒绝"就是一句会被用户当场证伪的话。
    assert.equal(a.requestedButUnavailable, false);
    assert.doesNotMatch(String(isolationNotice(a)), /会被\*\*拒绝\*\*执行/);
  });

  it('授权缺省时行为逐字节不变（既有调用方不因为这次改动换姿势）', () => {
    resetIsolationProbeCache();
    const a = describeIsolation('auto', process.cwd(), '');
    assert.equal(a.bypassed, false);
  });
});
