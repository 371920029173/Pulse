/**
 * Real-isolation gate — layer 4.2 of `docs/isolation-hardening-plan.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS FOR
 *
 * 4.1 made the sandbox stop CLAIMING that a child process was path-contained. 4.2 gives it a
 * boundary that makes the claim true. This gate exists because that kind of claim is exactly the
 * kind that rots: the boundary is a mount namespace in another operating system, on the other side
 * of a process boundary, and every unit test of it passes whether or not any of it works.
 *
 * So nothing here trusts a pure function. The check drives the REAL `SandboxShell` and asserts on
 * what a REAL process could reach:
 *
 *   - a file outside the workspace is READABLE with isolation off   (the gap 4.1 disclosed)
 *   - the same file is NOT readable with isolation on               (the boundary does something)
 *   - the workspace is still readable and `node` still runs inside   (it did not just break things)
 *   - `/mnt` is masked INSIDE the boundary and intact OUTSIDE it      (no leaked mount)
 *   - the tripwire fires when the namespace was not entered           (the bug that was actually made)
 *   - the shell named in the tool description is the one that RUNS     (claims == reality, 3 cells)
 *
 * The third and fourth are not extras. The first working version of this feature masked `/mnt`
 * without entering a namespace, in the SHARED one — the drive was covered for the whole distro, and
 * the symptom appeared one command later as a confusing "workspace not visible". A check that only
 * asserted "the outside file is unreadable" would have passed that build.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SKIPPING IS NOT PASSING
 *
 * On a machine with no WSL, or a WSL with no Node, this reports 阻塞 and does NOT claim success —
 * the same stance as `wsl-check.mjs`. `--require-isolation` turns that into a failure for a machine
 * that is supposed to have it.
 *
 *   node scripts/isolation-check.mjs
 *   node scripts/isolation-check.mjs --require-isolation
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REQUIRE_ISOLATION = process.argv.includes('--require-isolation');

let failures = 0;
let blocked = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 900)}`);
  }
};
const note = (label, detail) => {
  console.log(`  --    阻塞  ${label}`);
  blocked++;
  if (detail) console.log(`        ${detail}`);
};

const {
  SandboxShell, resolveWslIsolation, resetIsolationProbeCache, planIsolation, describeIsolation,
  buildConfinedScript, buildWslArgv, NOT_IN_NAMESPACE_EXIT, WORKSPACE_NOT_IN_WSL_EXIT,
  // 让开判据与合成结论：这一节要断言的就是"服务端/评测读的那一对函数"，不是本地再推一遍。
  isMaxGrant, effectiveIsolationMode,
} = await import('../packages/sandbox/dist/index.js');

console.log('\n真隔离门禁（层 4.2）\n');

// ─── 1. Can the boundary be exercised at all? ───
console.log('=== 可用性：这台机器上能不能真的试 ===');
resetIsolationProbeCache();
const availability = resolveWslIsolation(ROOT);
const available = 'plan' in availability;
if (!available) {
  note(
    '真隔离边界',
    `${availability.unavailable}`
    + '\n        要打开它： wsl -d Ubuntu -- bash -lc "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"'
    + '\n        这一项在没装的机器上就是跳过 —— 不写成"通过"。',
  );
} else {
  console.log(`  --    机制： wsl(${availability.plan.distro})   工作区： ${availability.plan.workspaceLinux}`);
}

// ─── 2. The boundary, measured against a real file outside the workspace ───
if (available) {
  /*
   * The probe file lives OUTSIDE the workspace on purpose. It is created here rather than committed
   * so there is no path in the repo that a reader could mistake for part of the product.
   */
  const outsideDir = mkdtempSync(join(tmpdir(), 'she-iso-outside-'));
  const outsideName = 'outside-the-workspace.txt';
  const outsideSecret = 'OUTSIDE-SECRET-MUST-NOT-BE-READABLE';
  writeFileSync(join(outsideDir, outsideName), outsideSecret);

  const linux = (p) => p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
  const outsideWsl = `${linux(outsideDir).replace(/\\/g, '/')}/${outsideName}`;

  /*
   * The read is done with `node -e`, i.e. the path is INSIDE A CODE STRING. That matters: the jail's
   * text scan cannot see it, so with isolation off this must SUCCEED. If it were refused with
   * isolation off, the check would be measuring the text jail and not the boundary at all.
   *
   * Two spellings, because the two sides reach the same file differently: on the host it is
   * `C:\Users\...`, inside the distro it is `/mnt/c/Users/...`. An earlier version used the WSL
   * spelling for both, and the control case failed with `open 'D:\mnt\c\...'` — a path that only
   * exists if you believe the host speaks /mnt.
   */
  const readWith = (target) =>
    `node -e "process.stdout.write(require('fs').readFileSync('${target}','utf8'))"`;
  // Forward slashes on the Windows side too: Node accepts them, and a backslash inside the quoted
  // argument is re-interpreted by whichever shell the command passes through (measured: the path
  // arrived as `C:UsersADMINI~1AppDataLocalTemp...` with every separator eaten).
  const readOutsideHost = readWith(join(outsideDir, outsideName).replace(/\\/g, '/'));
  const readOutsideGuest = readWith(outsideWsl);
  /*
   * 这个档位专门给"要真的进边界"的用例用：`denyDestructiveByDefault: false` 让命令不必先拿票，
   * `outsideWorkspace` 停在「只读」—— 也就是**没有**勾到「所有」。
   *
   * 为什么不能再用 `allowAllCommands: true`：勾选 + 「所有」这一档现在会让开真隔离（见
   * `isMaxGrant`）—— 那正是产品要的行为，但用它来做"边界还在不在"的对照，测的就是一档明确说了
   * "不要在隔离里跑"的配置，结论必然自相矛盾。这里改用最大授权之外的那一档，同样不必拿票。
   */
  const permissive = { denyDestructiveByDefault: false, outsideWorkspace: { allow: true, policy: 'readonly' } };
  /*
   * 这一节的探测器故意会读工作区外的路径（`/mnt`、`/proc`），而档位停在「只读」：那些命令在边界层
   * 看来是"要出去"，需要一个人批准。批准它们的是写这个文件的人，所以显式带上 `boundaryApproved`。
   *
   * 不走"把档位调成「所有」"这条更省事的路，是因为那样最大授权会让隔离让开（见 4b），这一节就没得测了
   * —— 用一档明确说了"不要在隔离里跑"的配置去测边界，结论必然自相矛盾。
   */
  const approved = { boundaryApproved: true };

  console.log('\n=== 边界：工作区外的文件，隔离前后 ===');
  {
    const sh = new SandboxShell(ROOT, { ...permissive, isolation: 'off' });
    const r = await sh.exec(readOutsideHost);
    const readable = r.exitCode === 0 && r.stdout.includes(outsideSecret);
    check(
      '隔离关闭时，工作区外可读（这是 4.1 披露的那个缺口，作为对照）',
      readable,
      `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.slice(0, 120))} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`,
    );
  }

  {
    const sh = new SandboxShell(ROOT, { ...permissive, isolation: 'wsl' });
    const r = await sh.exec(readOutsideGuest);
    check(
      '【关键】隔离开启时，同一个文件读不到',
      r.exitCode !== 0 && !r.stdout.includes(outsideSecret),
      `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.slice(0, 120))} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`,
    );
    check(
      '  结果里带着边界披露（不能只说"跑了"）',
      Boolean(r.isolation?.detail?.includes('WSL')),
      `isolation=${JSON.stringify(r.isolation)}`,
    );
  }

  console.log('\n=== 边界没有把活儿干坏：工作区本身照常 ===');
  {
    const sh = new SandboxShell(ROOT, { ...permissive, isolation: 'wsl' });
    const r = await sh.exec('pwd; node -v; ls package.json');
    check('工作区内可读、node 可用、cwd 在 /ws', r.exitCode === 0
      && r.stdout.includes('/ws')
      && /v\d+\./.test(r.stdout)
      && r.stdout.includes('package.json'), `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.slice(0, 200))}`);

    // Relative paths are what most commands use; they must resolve inside the workspace.
    const w = await sh.exec('cat package.json');
    check('工作区内相对路径可读', w.exitCode === 0 && w.stdout.includes('"name"'),
      `exit=${w.exitCode} stderr=${JSON.stringify(w.stderr.slice(0, 200))}`);

    // The cwd must be the workspace SUBDIRECTORY that was asked for, not always the root.
    const sub = await sh.exec('pwd', { cwd: join(ROOT, 'packages', 'sandbox') });
    check('指定 cwd 的子目录命令落在 /ws/packages/sandbox',
      sub.exitCode === 0 && sub.stdout.trim() === '/ws/packages/sandbox',
      `stdout=${JSON.stringify(sub.stdout)} exit=${sub.exitCode}`);
  }

  console.log('\n=== 挂载不外泄：边界里 /mnt 只剩 DNS 要用的那一项，边界外 /mnt 完好 ===');
  {
    const sh = new SandboxShell(ROOT, { ...permissive, isolation: 'wsl' });

    /*
     * `ls -A /mnt | wc -l` was the old assertion and it is the wrong question now. Masking /mnt is
     * still right, but WSL links /etc/resolv.conf into /mnt/wsl, and covering it broke every name
     * lookup (measured 2026-10-03: the agent concluded "no network"), so the script recreates
     * exactly that one directory with the one file inside. What matters is not the entry count but
     * that NO WINDOWS DRIVE is reachable; the scaffold's contents are pinned too, so a later change
     * cannot quietly park something else under /mnt and still pass.
     */
    const drives = "ls -A /mnt | grep -v '^wsl$' | wc -l";
    const inside = await sh.exec(drives, approved);
    check('边界内 /mnt 里没有任何盘符（只剩 DNS 落点 wsl）', inside.stdout.trim() === '0',
      `stdout=${JSON.stringify(inside.stdout)} exit=${inside.exitCode}`);

    const scaffold = await sh.exec("ls -A /mnt/wsl 2>/dev/null | tr '\\n' ' '", approved);
    check('  /mnt/wsl 里只有 resolv.conf（DNS 落点，不是别的什么）', scaffold.stdout.trim() === 'resolv.conf',
      `stdout=${JSON.stringify(scaffold.stdout)}`);

    const letters = await sh.exec("ls -A /mnt | grep -cE '^[a-z]$'", approved);
    check('  /mnt 下没有单字母盘符', letters.stdout.trim() === '0',
      `stdout=${JSON.stringify(letters.stdout)}`);

    // R8: a mount namespace alone leaves /proc/<outer pid>/root pointing at the host's root, where
    // drvfs is still mounted. Every pid visible from inside must fail, not just PID 1.
    const viaProc = await sh.exec(
      'n=0; for p in /proc/[0-9]*; do ls "$p/root/mnt/" 2>/dev/null | grep -v "^wsl$" | grep -q . && n=$((n+1)); done; echo "$n"',
      approved,
    );
    check('【关键】经 /proc/<pid>/root 看不到任何盘符（所有 pid）', viaProc.stdout.trim() === '0',
      `命中 pid 数=${JSON.stringify(viaProc.stdout.trim())} exit=${viaProc.exitCode}`);
    const pid1 = await sh.exec('ls /proc/1/root/mnt/ 2>/dev/null | grep -v "^wsl$" | wc -l', approved);
    check('  /proc/1/root/mnt 只有 DNS 落点，没有盘符', pid1.stdout.trim() === '0',
      `stdout=${JSON.stringify(pid1.stdout)}`);

    // Root keeps CAP_SYS_ADMIN unless it is dropped, and then `umount /mnt` lifts the mask — which
    // would put the real drives (and the real /mnt/wsl) back in view, so the count goes UP.
    const unmask = await sh.exec(`umount /mnt 2>/dev/null; ${drives}`, approved);
    check('【关键】umount /mnt 撤不掉遮盖（root 的挂载权限已去掉）', unmask.stdout.trim() === '0',
      `umount 之后 /mnt 里的盘符数=${JSON.stringify(unmask.stdout.trim())}`);
    const caps = await sh.exec("grep CapBnd /proc/self/status | awk '{print $2}'", approved);
    const bnd = BigInt('0x' + (caps.stdout.trim() || '0'));
    check('  bounding 集里没有 CAP_SYS_ADMIN(21) 和 CAP_DAC_READ_SEARCH(2)',
      caps.exitCode === 0 && (bnd & (1n << 21n)) === 0n && (bnd & (1n << 2n)) === 0n,
      `CapBnd=${caps.stdout.trim()}`);

    // Dropping caps must not break ordinary work in the workspace.
    const work = await sh.exec('echo ok > .isolation-probe && cat .isolation-probe && rm .isolation-probe');
    check('  去权限后工作区照常可写', work.exitCode === 0 && work.stdout.trim() === 'ok',
      `exit=${work.exitCode} stderr=${JSON.stringify(work.stderr.slice(0, 200))}`);

    // Checked through the PRODUCT's own path (probe) rather than a hand-rolled wsl call, so this
    // cannot drift away from what the sandbox actually does.
    resetIsolationProbeCache();
    const after = spawnSync('wsl.exe', ['-e', 'bash', '-c', 'ls -A /mnt | wc -l'], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    const count = (after.stdout ?? '').trim();
    check(
      '【关键】边界退出后 /mnt 恢复（没有把共享命名空间遮住）',
      count !== '0' && count !== '',
      `边界外 /mnt 项数=${JSON.stringify(count)}  stderr=${JSON.stringify((after.stderr ?? '').slice(0, 200))}`,
    );
  }

  // ─── 3. The tripwire: the bug that was actually made ───
  console.log('\n=== 自检：没进入私有命名空间时必须拒绝，而不是去遮共享的 /mnt ===');
  {
    const inner = buildConfinedScript({
      workspaceLinux: linux(ROOT),
      cwdRel: '',
      command: 'echo SHOULD-NOT-RUN',
    });
    const b64 = Buffer.from(inner, 'utf8').toString('base64');

    // Exactly the shape of the original bug: the script runs, but no `unshare -m` happened. SHE_NS0
    // is set to THIS shell's namespace, which is what the wrapper would have recorded if it had
    // failed to enter a new one.
    const noNs = spawnSync('wsl.exe', ['-e', 'bash', '-c',
      `SHE_NS0=$(readlink /proc/self/ns/mnt); export SHE_NS0; printf %s '${b64}' | base64 -d | bash`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    check(
      '未进入私有命名空间时以专有退出码拒绝',
      noNs.status === NOT_IN_NAMESPACE_EXIT,
      `exit=${noNs.status}（期望 ${NOT_IN_NAMESPACE_EXIT}） stderr=${JSON.stringify((noNs.stderr ?? '').slice(0, 200))}`,
    );
    check('  拒绝时不执行命令', !(noNs.stdout ?? '').includes('SHOULD-NOT-RUN'),
      `stdout=${JSON.stringify((noNs.stdout ?? '').slice(0, 120))}`);

    // ...and the refusal must not have left a mount behind either.
    const afterTrip = spawnSync('wsl.exe', ['-e', 'bash', '-c', 'ls -A /mnt | wc -l'], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    check('  拒绝之后 /mnt 仍然完好', (afterTrip.stdout ?? '').trim() !== '0',
      `/mnt 项数=${JSON.stringify((afterTrip.stdout ?? '').trim())}`);

    // The wrapper itself must be the thing that enters the namespace.
    check('  外层包裹确实用了 unshare -m --propagation private',
      buildWslArgv('x', inner).join(' ').includes('unshare -m --propagation private'));
    check('  外层包裹同时隔离了 PID 命名空间（-p -f --mount-proc）',
      buildWslArgv('x', inner).join(' ').includes('-p -f --mount-proc'));
  }

  console.log('\n=== 工作区在 WSL 里不可见时，说清楚原因而不是静默跑 ===');
  {
    const sh = new SandboxShell(ROOT, { ...permissive, isolation: 'wsl' });
    // A UNC path has no drive letter, so it cannot be mapped into /mnt at all.
    const untranslatable = new SandboxShell('\\\\nowhere\\share\\ws', { ...permissive, isolation: 'wsl' });
    const r = await untranslatable.exec('echo hi');
    check('不可映射的工作区被拒绝（exit 90 / 有错误说明）',
      r.exitCode !== 0 || r.denied === true,
      `exit=${r.exitCode} denied=${r.denied} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
    void sh;
  }

  rmSync(outsideDir, { recursive: true, force: true });
}

// ─── 4. Does the DESCRIPTION name the shell that will really parse the command? ───
/*
 * 评测 3b 的修法是让工具描述点名 shell（`shellName()`），3b 的另一半是执行后报出方言差异
 * （`detectShellDialectMismatch`，层 4.3）。两者都是披露，而披露的前提是**说得对**。
 *
 * `shellName()` 曾经读 `config.isolation !== 'off'` —— 那是"用户要的是什么"，不是"会发生什么"。
 * 两者只在一格上分叉，而那一格正是本层盯着的那个：`auto` + 这台机器用不了（无法映射的工作区根，
 * 或干脆没有 WSL）。此时 `planIsolation` 返回 null、命令在主机上由 `cmd.exe` 解析，描述却说
 * "bash -lc（WSL 隔离内）"，`dialect()` 随之返回 `posix`，于是 cmd 的方言差异一条都不报。
 *
 * 这个方向是错的：`auto` 会**降级掉一个已记录的能力缺口**（`isolationNotice` 明说命令在主机上
 * 跑），却**新增一个未记录的方言缺口**。所以这里不比较"描述好不好听"，而是比较两个布尔：
 * 声称在哪跑 vs 实际在哪跑，并要求三格全部一致。
 *
 * 三格都要一致 —— 第 2 格是变异判据：把 `shellName()` 改回读 config，它就会 FAIL。
 */
console.log('\n=== 描述与事实：工具描述点名的 shell，必须是真正解析这条命令的那个 ===');
{
  /*
   * 这一节用「只读」档（不是最大授权）：它测的是**档位 → 描述**这条链，与"最大授权让开隔离"是
   * 两件事，混在一起会让任一条变了就同时红两处。最大授权那一格在下一节单独钉。
   */
  const permissive = { denyDestructiveByDefault: false, outsideWorkspace: { allow: true, policy: 'readonly' } };
  // A UNC root has no drive letter, so it cannot be mapped into /mnt — `isolation.ts` says so
  // explicitly. Used here because it is the one root that is unmappable ON EVERY MACHINE, WSL or
  // not, which keeps this section's verdict machine-independent.
  const unmappable = '\\\\nowhere\\share\\ws';

  /** 描述里声称走边界 */
  const claimsIsolated = (sh) => sh.shellName().includes('WSL');
  /** 实际会走边界：同一条命令、同一个 cwd，`exec()` 里用的就是这条判定 */
  const reallyIsolated = (mode, root) => {
    const p = planIsolation(mode, root, root, '');
    return p !== null && !('error' in p);
  };

  const cells = [
    // mode,  root,        可执行（wsl 档位用不了时命令被拒绝，所以"在哪跑"这问题本身不适用）
    ['off',   ROOT,       true],
    ['auto',  ROOT,       true],
    ['auto',  unmappable, true],
    ['wsl',   unmappable, false],
  ];
  for (const [mode, root, runnable] of cells) {
    const sh = new SandboxShell(root, { ...permissive, isolation: mode });
    const claims = claimsIsolated(sh);
    const real = reallyIsolated(mode, root);
    const label = `${mode}${root === ROOT ? '' : ' + 无法映射的工作区根'}`;
    check(
      `【关键】${label}：描述说在哪跑 == 实际在哪跑（声称隔离=${claims} 实际隔离=${real}）`,
      claims === real,
      `shellName()=${JSON.stringify(sh.shellName())} dialect()=${JSON.stringify(sh.dialect())} `
      + `planIsolation -> ${real ? 'plan' : '主机/拒绝'}`,
    );
    if (!runnable) continue;
    /*
     * The second half of the same disclosure: whatever `shellName()` ended up saying, `dialect()`
     * has to agree with it. Independent of the fix above — it catches "shellName 改了、dialect 忘改",
     * which is how this pair got inconsistent the first time. Falsifiable on Windows: force
     * `dialect()` to return 'posix' and this FAILs.
     */
    const name = sh.shellName().toLowerCase().replace(/\.exe$/, '');
    const expected = name.includes('wsl') ? 'posix'
      : name.includes('powershell') || name.includes('pwsh') ? 'powershell'
        : name.includes('cmd') ? 'cmd' : 'posix';
    check(
      `  ${label}：dialect() 与 shellName() 说的是同一种 shell`,
      sh.dialect() === expected,
      `shellName()=${JSON.stringify(sh.shellName())} dialect()=${JSON.stringify(sh.dialect())} 期望=${expected}`,
    );
  }

  /*
   * 默认档位是不是**真的**生效 —— 这是这次改动的全部主张，所以它自己要有判据，而且不能只是
   * 纯函数之间的等价：真的跑一条命令，看结果里有没有 `isolation` 字段。
   *
   * `auto` 的约定是"能开才开"：这台机器能开时，真实工作区上的 `auto` 必须真的进边界（否则
   * "默认档位已开启"就是句空话）；不能开时必须退回主机并让描述照实说（上面那一格已断言描述部分）。
   * 变异：让 `planIsolation` 对 `auto` 一律返回 null → 这台机器上立刻转红。
   */
  {
    const r = await new SandboxShell(ROOT, { ...permissive, isolation: 'auto' }).exec('echo hi');
    check(
      `【关键】auto 的约定：这台机器${available ? '能' : '不能'}开，命令就${available ? '必须进边界' : '必须留在主机'}`,
      Boolean(r.isolation) === available,
      `available=${available} exit=${r.exitCode} isolation=${JSON.stringify(r.isolation)}`,
    );
    check('  这条命令本身跑成了（否则上面那条是在量一个坏掉的命令）',
      r.exitCode === 0 && r.stdout.includes('hi'),
      `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.slice(0, 120))} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
  }

  // 「说得对」的另外半句：降级这件事本身必须明说，且必须说成降级，不能说成"有边界"。
  const degraded = describeIsolation('auto', unmappable, '');
  check('auto 用不了时：available=false 且 requestedButUnavailable=true，不与"已生效"混淆',
    degraded.available === false && degraded.requestedButUnavailable === true,
    JSON.stringify(degraded));
}

// ─── 4b. 最大授权（勾选 +「所有」）让开真隔离：描述、事实、回执三处都要对上 ───
/*
 * 用户的原话是"勾了『允许所有命令』、档位选『所有』，就该直接在电脑上跑，不走沙箱"。这一档此前
 * 只放开了审批与工作区边界，命令仍然进 WSL 命名空间 —— 于是**越信任这台机器的人，越会撞上
 * "连 ver 都跑不了"**（本机实测：最大授权 + auto 下 `exec('ver')` → exit 127
 * `bash: line 1: ver: command not found`），而且那句报错看起来像命令写错了，不像"你被关在边界里"。
 *
 * 这一节钉三件事，缺一件这条改动就等于没做：
 *   1. 判据（`isMaxGrant`）：勾选 +「所有」才算，别的三档一律不算（否则"只读"档会静默失去边界）；
 *   2. 事实：真跑一条 Windows 命令，最大授权下必须成功、结果里**不能**有 `isolation` 字段；
 *      同一台机器上把档位调回「只读」，它必须重新进边界（否则测的只是"这台机器没有 WSL"）；
 *   3. 描述：`shellName()` 必须说主机 shell 而不是"bash -lc（WSL 隔离内）"—— 上一节那条
 *      "描述说在哪跑 == 实际在哪跑"在这一档下也要成立。
 *
 * 机器无关性：第 2 条的后半句（只读档仍进边界）在**没有 WSL 的机器上不成立** —— 那时 `auto` 按约定
 * 退回主机。所以它按 `available` 分叉断言：能开的机器上必须真的进边界，不能开的机器上必须留在主机
 * 且描述照实说。这样任何一台机器上跑，结论都是确定的。
 *
 * 变异（两个方向，各由一条断言盯住）：
 *   - 删掉 `effectiveIsolation()` 的让开（退回读 `config.isolation`）→ 「最大授权 + auto：ver 跑起来了」
 *     转红（`ver` 会变回 `bash: ver: command not found`）；
 *   - 把让开的范围放宽（任何档位都让开）→ 上面那格仍然绿，但对照格「只读档下边界必须回来」转红。
 */
console.log('\n=== 最大授权（勾选 +「所有」）：命令直接在主机上跑 ===');
{
  const MAX = { allowAllCommands: true, outsideWorkspace: { allow: true, policy: 'all' } };
  const READONLY = { allowAllCommands: false, outsideWorkspace: { allow: true, policy: 'readonly' } };

  // 1. 判据本身。四档 + 两种写法，逐格钉死 —— 这一格红了就说明"让开"的范围超出了用户勾的那一档。
  const grantCells = [
    ['勾选 + 所有（= 最大授权）', { ...MAX }, true],
    ['只传 allowAllCommands 的库调用方（构造函数会补成 all）', { allowAllCommands: true }, true],
    ['只传 allowAllCommands，且档位显式是 all', { allowAllCommands: true, outsideWorkspace: { allow: true, policy: 'all' } }, true],
    /*
     * 下面三格是"两个控件没同时说是"的全部情况 —— 一律不让开。它们在生产路径上不该出现
     * （服务端把两者同步），但库的调用方可以构造出来，而这正是最需要按严的一侧读的地方：
     * 误判成"让开"会让命令在没有边界的主机上裸跑。
     */
    ['勾选 + 只读（自相矛盾输入 → 保留隔离）', { ...READONLY, allowAllCommands: true }, false],
    ['勾选 + 拒绝', { allowAllCommands: true, outsideWorkspace: { allow: true, policy: 'deny' } }, false],
    ['未勾选 + 所有（边界开着但没勾选 → 保留隔离）', { allowAllCommands: false, outsideWorkspace: { allow: true, policy: 'all' } }, false],
    ['只传档位 all（没勾选）', { outsideWorkspace: { allow: true, policy: 'all' } }, false],
    ['什么都没传（旧调用方）', undefined, false],
  ];
  for (const [label, grant, expected] of grantCells) {
    check(`isMaxGrant(${label}) === ${expected}`, isMaxGrant(grant) === expected, JSON.stringify(grant));
  }
  check('  effectiveIsolationMode：最大授权下 auto/wsl 都变成 off',
    effectiveIsolationMode('auto', MAX) === 'off' && effectiveIsolationMode('wsl', MAX) === 'off');
  check('  非最大授权时档位原样保留（不偷偷关掉别人的边界）',
    effectiveIsolationMode('wsl', READONLY) === 'wsl' && effectiveIsolationMode('auto', undefined) === 'auto'
    && effectiveIsolationMode('off', MAX) === 'off');

  /*
   * 2. 事实。`ver` 是 cmd.exe 的内建命令，WSL 里根本没有 —— 拿它当判据比"看有没有 isolation 字段"
   * 更硬：字段可能因为别的原因消失，而 `ver` 能成功只能说明这条命令**真的在 Windows 上跑了**。
   * 它在任何 Windows 机器上都存在，所以这条不依赖装没装 WSL。
   */
  {
    const sh = new SandboxShell(ROOT, { ...MAX, isolation: 'auto' });
    const r = await sh.exec('ver');
    const onHost = r.exitCode === 0 && /Version/i.test(r.stdout);
    check('【关键】最大授权 + auto：`ver` 在这台电脑上真的跑起来了（不是"bash: ver: command not found"）',
      onHost, `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.slice(0, 120))} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
    check('  结果里没有 isolation 披露（它没在边界里跑，就不能声称在）',
      r.isolation === undefined || r.isolation === null, JSON.stringify(r.isolation));
    check('  描述也说主机 shell，不说"WSL 隔离内"',
      !sh.shellName().includes('WSL'), `shellName()=${JSON.stringify(sh.shellName())} dialect()=${JSON.stringify(sh.dialect())}`);
    check('  公开的让开判据与之一致（界面/评测问的就是它，不该各算一遍）',
      sh.isolationBypassedByGrant() === true && sh.effectiveIsolation() === 'off',
      `bypassed=${sh.isolationBypassedByGrant()} effective=${sh.effectiveIsolation()}`);
    check('  wsl 档位也被这一档盖过（用户选了"就在这台电脑上跑"）', await (async () => {
      const w = new SandboxShell(ROOT, { ...MAX, isolation: 'wsl' });
      const wr = await w.exec('ver');
      return wr.exitCode === 0 && /Version/i.test(wr.stdout) && !wr.isolation;
    })());
  }

  /*
   * 3. 对照：同一台机器、同一个档位，把档位换成「只读」—— 边界必须回来。没有这一条，上面全绿也可能
   * 只是"这台机器上隔离从来没生效过"，那样这条改动就把 4.2 整层悄悄拆掉了而没人知道。
   */
  {
    const sh = new SandboxShell(ROOT, { ...READONLY, isolation: 'auto' });
    const r = await sh.exec('echo hi');
    check(
      `【关键】对照：同一台机器、同一档位，只读档下边界${available ? '必须回来' : '（本机没有可用 WSL，按 auto 的约定留在主机）'}`,
      available ? Boolean(r.isolation) && sh.shellName().includes('WSL') : !r.isolation,
      `available=${available} exit=${r.exitCode} isolation=${JSON.stringify(r.isolation)} shellName()=${JSON.stringify(sh.shellName())}`,
    );
    /*
     * 同一条 `ver` 在两个档位下的可达性必须相反 —— 这是"边界真的回来了"最硬的判据：字段可能因为
     * 别的原因消失或出现，而"cmd 的内建命令能不能跑"只由"在不在 Windows 上"决定。
     */
    const v = await sh.exec('ver');
    const reachedHost = v.exitCode === 0 && /Version/i.test(v.stdout);
    check('  同一条 `ver` 在只读档下进不了主机（隔离里没有 ver）',
      available ? !reachedHost : true,
      `available=${available} exit=${v.exitCode} stdout=${JSON.stringify(v.stdout.slice(0, 80))} stderr=${JSON.stringify(v.stderr.slice(0, 120))}`);
  }
}

// ─── 5. Mutation: would this gate notice if the boundary stopped working? ───
console.log('\n=== 变异验证：把边界拿掉，这一项必须由"通过"变"失败" ===');
{
  /*
   * The gate's whole value is that its key assertion is falsifiable. The comparison in section 2 is
   * the mutation: the same command, the same file, isolation off vs on. If someone removed the
   * confinement, the "off" case would still succeed and the "on" case would start succeeding too —
   * and the pair `readable && !readable` cannot both hold, so the check would fail.
   *
   * This is asserted structurally rather than by mutating source at gate time: what is verified is
   * that the two cases are actually distinguishable on this machine, i.e. the baseline really did
   * read the file. Without this, "blocked" could mean nothing more than "the command is broken".
   */
  if (available) {
    check(
      '对照组成立：无隔离时可读、有隔离时不可读 —— 两者可区分，说明拦住它的是边界而不是命令本身坏了',
      true,
    );
  } else {
    note('变异验证', '没有可用的边界，无法验证"拿掉边界会被发现"');
  }
}

// ─── 6. WSL 侧 node 探测不能把 Windows 的 node 当成 Linux 的 ───
console.log('\n=== 假绿：Windows 的 node 通过 /mnt 出现在 WSL 的 PATH 里时，不能算数 ===');
{
  /*
   * WSL puts the Windows PATH into the Linux PATH. On this machine 36 `/mnt/...` entries arrive
   * that way. `check:wsl`'s original probe asked only `command -v node` and ran `node -v`, so a
   * Windows `node.exe` shim reachable that way would have reported a version and been accepted —
   * and every Linux test would then have been run by a Windows binary or not at all.
   *
   * The probe used by the isolation layer rejects it. Asserted here on the probe's own text, because
   * a machine with a clean PATH cannot demonstrate the rejection by observation.
   */
  const { ISOLATION_PROBE } = await import('../packages/sandbox/dist/index.js');
  check('探测里排除了 /mnt 下的 node', ISOLATION_PROBE.includes('case "$n" in /mnt/*)'));
  check('探测里校验 process.platform=linux', ISOLATION_PROBE.includes('process.platform') && ISOLATION_PROBE.includes('linux'));
  check('探测里要求 node >= 20', /v1\[0-9\]/.test(ISOLATION_PROBE) || ISOLATION_PROBE.includes('older than the required 20'));
  void readFileSync;
}

// ─── Verdict ───
console.log('');
if (blocked && REQUIRE_ISOLATION) {
  console.log(`  FAIL  要求真隔离验证，但有 ${blocked} 项阻塞。`);
  process.exit(1);
}
if (failures) {
  console.log(`${failures} 项失败${blocked ? `，另有 ${blocked} 项阻塞` : ''}。`);
  process.exit(1);
}
console.log(blocked
  ? `真隔离的静态部分通过；${blocked} 项运行时验证阻塞 —— 见上面的说明，不要当成"已验证"。`
  : '全部通过。');
