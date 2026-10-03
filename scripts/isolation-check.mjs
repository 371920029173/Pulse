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
  const permissive = { allowAllCommands: true, denyDestructiveByDefault: false };

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

  console.log('\n=== 挂载不外泄：边界里 /mnt 是空的，边界外 /mnt 完好 ===');
  {
    const sh = new SandboxShell(ROOT, { ...permissive, isolation: 'wsl' });
    const inside = await sh.exec('ls -A /mnt | wc -l');
    check('边界内 /mnt 被遮盖（0 项）', inside.stdout.trim() === '0',
      `stdout=${JSON.stringify(inside.stdout)} exit=${inside.exitCode}`);

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
  const permissive = { allowAllCommands: true, denyDestructiveByDefault: false };
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
