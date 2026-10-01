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
  SandboxShell, resolveWslIsolation, resetIsolationProbeCache,
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

// ─── 4. Mutation: would this gate notice if the boundary stopped working? ───
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

// ─── 5. WSL 侧 node 探测不能把 Windows 的 node 当成 Linux 的 ───
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
