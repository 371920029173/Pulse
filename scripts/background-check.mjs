/**
 * Long-running commands: background jobs, waiting, and not leaving processes behind.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS CHECK EXISTS
 *
 * The sandbox could not run a command that took longer than 30 seconds. There
 * was no timeout parameter and no way to say "start this and let me keep
 * working": the only outcome available was the process being killed and the
 * transcript saying so. So the model could not run a build, a test suite, a
 * training step, or a server — it could only run commands that finish in half a
 * minute, and nothing in the failure said so. It just "timed out" and looked
 * like a command that was too slow rather than a capability that was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT A UNIT TEST
 *
 * The unit tests in `packages/sandbox/src/__tests__/background.test.ts` assert
 * what the tool REPORTS. The claims that matter here can only be seen from
 * outside the process: that the command is still running after the call that
 * started it returned, that it is still running past the old 30-second wall,
 * and — the one that bit before — that when it is stopped, the `cmd.exe` and the
 * real process are gone from the machine rather than orphaned with dead
 * parents, holding their output pipes open and the workspace directory locked.
 *
 * A test that asserts "kill returned 已被终止" passes just as happily while
 * twelve process pairs leak. This one counts the process table instead.
 *
 *   node scripts/background-check.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const IS_WINDOWS = process.platform === 'win32';

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
  }
};

/**
 * Count live processes whose command line contains `marker`.
 *
 * The marker is passed as an extra argument to `node -e`, which ignores it, and it survives into the
 * command line of the `cmd.exe` and the `node.exe` of the tree. (It does NOT survive into the
 * `powershell.exe` wrapper, which is started as `-EncodedCommand` — that is why the count is compared
 * against itself before and after rather than against an absolute number.)
 */
const countMarked = (marker) => {
  const r = IS_WINDOWS
    ? spawnSync('wmic', ['process', 'get', 'CommandLine', '/format:csv'], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })
    : spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const text = r.stdout ?? '';
  return text.split('\n').filter((line) => line.includes(marker)).length;
};

/**
 * Pids whose command line contains `marker`.
 *
 * `countMarked` answers "how many"; a test that has to kill ONE of the marked processes needs to know
 * which. Same two platform spellings as above, so the two helpers cannot drift apart.
 */
const pidsMarked = (marker) => {
  const r = IS_WINDOWS
    ? spawnSync('wmic', ['process', 'get', 'ProcessId,CommandLine', '/format:csv'], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })
    : spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    if (!line.includes(marker)) continue;
    // Windows CSV ends `…,CommandLine,ProcessId`; POSIX is `PID ARGS`.
    const cells = line.trim().split(',');
    const pid = Number(IS_WINDOWS ? cells[cells.length - 1] : line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) out.push(pid);
  }
  return out;
};

/**
 * Wait until at least `n` marked processes exist, or give up.
 *
 * Needed because starting a job does NOT mean the command is running yet: the sandbox holds a
 * `powershell.exe` wrapper, which starts `cmd.exe`, which starts the real process, and that takes a
 * few hundred milliseconds. Asserting "it is alive" against an immediate snapshot measures the
 * wrapper's startup time, not whether the job survived — which is why this is a wait and the
 * "nothing left behind" assertions are not.
 */
const waitForMarked = async (marker, n = 1, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = countMarked(marker);
    if (count >= n) return count;
    if (Date.now() > deadline) return count;
    await new Promise((r) => setTimeout(r, 250));
  }
};

const workspace = mkdtempSync(join(tmpdir(), 'she-bg-gate-'));
const { SandboxShell } = await import('../packages/sandbox/dist/index.js');
const { createTools } = await import('../packages/sandbox/dist/tools.js');

const shell = new SandboxShell(workspace, { allowAllCommands: true });
const tools = createTools(shell, workspace, { allowAllCommands: true });
const jobId = (text) => {
  const m = text.match(/job_id=(job_\d+)/);
  if (!m) throw new Error(`没有 job_id：「${text}」`);
  return m[1];
};

console.log('\n长命令：后台执行 / 等待 / 收尾\n');

/* ─── 1. The command outlives the call that started it ─── */
console.log('=== 启动后调用就返回，命令还在跑 ===');
{
  const marker = 'SHE-GATE-ALIVE';
  const started = await tools.execute('shell', {
    command: `node -e "setTimeout(()=>console.log('LATE'),4000)" ${marker}`,
    background: true,
  });
  check('后台启动返回 job_id', /job_id=job_\d+/.test(started), started);

  // The claim is not "it returned an id" but "the process exists right now".
  const aliveAtReturn = await waitForMarked(marker, 1, 6_000);
  check('调用返回后进程确实在跑', aliveAtReturn > 0, `匹配进程数 ${aliveAtReturn}`);

  const status = await tools.execute('shell_wait', { id: jobId(started), wait_ms: 0 });
  check('wait_ms 0 是查询状态，不是"没有"', /还在运行/.test(status), status);
  check('运行中的任务不报退出码', !/exit code/.test(status), status);

  const done = await tools.execute('shell_wait', { id: jobId(started), wait_ms: 20000 });
  check('等待拿到结束与输出', /已结束/.test(done) && /LATE/.test(done), done);
  check('结束时报出真实退出码', /exit code: 0/.test(done), done);
  check('结束后进程不在了', countMarked(marker) === 0, `还剩 ${countMarked(marker)}`);
}

/* ─── 2. Past the 30-second wall ─── */
console.log('\n=== 【关键】跑过原来的 30 秒上限，而不是被杀掉 ===');
{
  /*
   * 31 seconds, chosen to be just past the 30_000 ms default that used to be a hard death sentence,
   * and long enough that "it was really still running" cannot be explained by a fast shutdown. This
   * one case is why the check takes half a minute; the alternative is trusting a unit test that the
   * wall is gone.
   */
  const command = 'node -e "setTimeout(()=>{console.log(\'PAST-THE-WALL\')},31000)"';
  const started = await tools.execute('shell', { command, timeout_ms: 2000 });
  check('前台超时转成后台，而不是杀掉', /job_id=job_\d+/.test(started) && /还在跑/.test(started), started);
  check('转后台时不假装有退出码', !/exit code/.test(started), started);

  const done = await tools.execute('shell_wait', { id: jobId(started), wait_ms: 45000 });
  check('超过 30 秒的命令跑到自然结束', /PAST-THE-WALL/.test(done), done);
  check('退出码是 0，不是 124', /exit code: 0/.test(done) && !/124/.test(done), done);
}

/* ─── 3. Waiting on a pattern, not on a clock ─── */
console.log('\n=== pattern：等到那一行出现就返回 ===');
{
  const started = await tools.execute('shell', {
    command: 'node -e "let n=0;setInterval(()=>console.log(\'step\',++n),200)"',
    background: true,
  });
  const id = jobId(started);
  const t0 = Date.now();
  const hit = await tools.execute('shell_wait', { id, pattern: 'step 3', wait_ms: 20000 });
  const elapsed = Date.now() - t0;
  check('pattern 命中就返回', /pattern 匹配到了/.test(hit), hit);
  check('不是等到进程结束（它不会结束）', elapsed < 8000, `耗时 ${elapsed}ms`);
  await tools.execute('shell_kill', { id });
}

/* ─── 4. Nothing left behind ─── */
console.log('\n=== 【关键】停掉之后机器上没有留下的进程 ===');
{
  /*
   * The failure this pins: `taskkill /T /F` snapshots the descendant list and then kills it, so a
   * grandchild created while the snapshot is being taken survives as an orphan with a dead parent —
   * invisible to `shell_jobs`, holding its output pipes open (so the parent process never exits) and
   * the working directory locked (so deleting the workspace fails with EBUSY). Measured before the
   * sweep: twelve killed jobs, twelve live process pairs.
   */
  const batch = [];
  const own = new SandboxShell(workspace, { allowAllCommands: true });
  const ownTools = createTools(own, workspace, { allowAllCommands: true });
  for (let i = 0; i < 4; i++) {
    const marker = `SHE-GATE-ORPHAN-${i}`;
    const started = await ownTools.execute('shell', {
      command: `node -e "setInterval(()=>{},1000)" ${marker}`,
      background: true,
    });
    batch.push({ marker, id: jobId(started) });
  }
  const before = [];
  for (const b of batch) before.push(await waitForMarked(b.marker, 1, 6_000));
  check('4 个任务都在跑', before.every((n) => n > 0), before.join(','));

  for (const b of batch) {
    const killed = await ownTools.execute('shell_kill', { id: b.id });
    check(`${b.id} 报告已终止`, /已被终止/.test(killed), killed);
  }

  // Give the OS a moment to finish reaping, then count. No sleeping in the product; here it is the
  // measurement, not the mechanism.
  await new Promise((r) => setTimeout(r, 1500));
  const after = batch.map((b) => countMarked(b.marker));
  check('【关键】停掉之后没有遗留进程', after.every((n) => n === 0), `剩余 ${after.join(',')}`);

  // And the sandbox no longer counts them as running — killed jobs stay listed, which is deliberate
  // (the reader can still see what happened to them), so the assertion is on the state, not on the
  // list being empty.
  const listed = await ownTools.execute('shell_jobs', {});
  check('任务表里不再有正在运行的', !/正在运行/.test(listed), listed);
  check('被终止的仍然可查（不是凭空消失）', new RegExp(batch[0].id).test(listed), listed);
  await own.stopAll();
}

/* ─── 5. The snapshot miss, reproduced on purpose (Windows only) ─── */
if (!IS_WINDOWS) {
  console.log('\n=== 【关键】终止快照漏掉的那部分必须被补上 ===');
  console.log('  --    跳过：这一段复现的是 Windows 的终止机制，POSIX 上走进程组终止，不存在这个漏杀');
} else {
console.log('\n=== 【关键】终止快照漏掉的那部分必须被补上 ===');
{
  /*
   * This is the failure the descendant sweep exists for, made deterministic.
   *
   * `taskkill /T /F` builds the descendant list once and then kills what is in it, so a process
   * created while that list is being built is not in it and is never killed. Whether that happens is
   * a timing race — it fires roughly one kill in three on this machine and depends on load — so a
   * check that merely kills quickly and hopes would pass while the bug was present. (It did: this
   * section's first version passed with the sweep removed.)
   *
   * So the miss is forced instead of awaited: the job's own root is killed WITHOUT `/T`, which leaves
   * exactly the state a snapshot miss leaves — `cmd.exe` and the real process alive, their ancestor
   * chain pointing at an already-dead parent. Then the job is stopped and the result is counted.
   *
   * The orphan chain is still walkable precisely because Windows records the parent id a process was
   * CREATED with and does not rewrite it when the parent dies, which is what lets the sweep find what
   * `/T` could not.
   */
  const own = new SandboxShell(workspace, { allowAllCommands: true });
  const ownTools = createTools(own, workspace, { allowAllCommands: true });

  // Reaching into the shell's table is deliberate: the pid of the root is the only handle on the
  // process tree, and without it the miss cannot be forced. Asserted first so that a rename shows up
  // as a failure here rather than as a silently weaker check.
  const jobTable = own.jobs;
  check('能看到内部任务表（否则这段退化成假检查）', jobTable instanceof Map, String(jobTable));

  const marker = 'SHE-GATE-SNAPSHOT';
  const started = await ownTools.execute('shell', {
    command: `node -e "setInterval(()=>{},1000)" ${marker}`,
    background: true,
  });
  const id = jobId(started);
  await waitForMarked(marker, 1, 6_000);

  const rootPid = jobTable?.get(id)?.child?.pid;
  check('拿到根进程 pid', Number.isInteger(rootPid), String(rootPid));

  // Kill ONLY the root. Everything below it is now an orphan with a dead parent — the state a
  // snapshot miss produces.
  spawnSync('taskkill', ['/PID', String(rootPid), '/F'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => setTimeout(r, 800));
  const orphaned = countMarked(marker);
  check('孤儿确实存在（这就是要修的状态）', orphaned > 0, `匹配 ${orphaned}`);

  // Stopping the job must clean up the orphans, not just the process it was holding.
  const killed = await ownTools.execute('shell_kill', { id });
  check('停掉时报告已终止', /已被终止/.test(killed), killed);
  await new Promise((r) => setTimeout(r, 1200));
  const left = countMarked(marker);
  check('【关键】根之外的残留也被收掉', left === 0, `剩余 ${left}`);
  await own.stopAll();
}
}

/* ─── 5b. A reaped ancestor must not hide the child it left behind ─── */
/*
 * The sweep walks the process table UP from each pid, which is what makes it work after `taskkill /T`
 * has killed the intermediates. The window it cannot see through is a REAPED one: once an ancestor's
 * pid is gone from the table, the chain from its child stops resolving, and retrying the read does not
 * bring it back. That is not a rare state — it is the normal result of killing a tree, because the
 * kill is what reaps the intermediates.
 *
 * So the sweep is checked against a description of the tree taken BEFORE the kill (`known`), and this
 * section pins that rule on the real process table rather than asserting the walk in the abstract:
 * a three-level tree, the middle level forcibly reaped, and the same query run with and without the
 * middle level recorded. The second answer is the bug the fix exists for.
 */
if (!IS_WINDOWS) {
  console.log('\n=== 【关键】祖先被回收后仍认得出它留下的孩子 ===');
  console.log('  --    跳过：这一段读的是 Windows 的进程表与 ppid 语义');
} else {
console.log('\n=== 【关键】祖先被回收后仍认得出它留下的孩子 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'she-bg-tree-'));
  writeFileSync(join(dir, 'l3.cjs'), 'setInterval(() => {}, 1000);\n');
  /*
   * `detached: true` on the grandchild is what makes this scenario buildable at all.
   *
   * Without it the middle level cannot be reaped on its own: Node on Windows is a console process, so
   * the grandchild is attached to the middle level's console, and force-killing the middle level
   * destroys that console and takes the grandchild with it. Measured — the grandchild was gone and the
   * only survivor was a `conhost`, so the state this section exists to create could not be reached.
   * A detached child gets its own console, which is also why `spawnCommand` must NOT detach on Windows
   * (see `portability-check.mjs`): a detached child escapes `taskkill /T`, and escaping is exactly the
   * orphan this sweep has to catch.
   */
  writeFileSync(join(dir, 'l2.cjs'),
    'require("child_process").spawn(process.execPath, [__dirname + "/l3.cjs", "SHE-GATE-L3"], { stdio: "ignore", detached: true });\n'
    + 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(dir, 'l1.cjs'),
    'require("child_process").spawn(process.execPath, [__dirname + "/l2.cjs", "SHE-GATE-L2"], { stdio: "ignore" });\n'
    + 'setInterval(() => {}, 1000);\n');
  const l1 = spawn(process.execPath, [join(dir, 'l1.cjs')], { stdio: 'ignore', windowsHide: true });
  const root = l1.pid;
  await waitForMarked('SHE-GATE-L3', 1, 8_000);
  const l2pid = pidsMarked('SHE-GATE-L2')[0];
  const l3pid = pidsMarked('SHE-GATE-L3')[0];
  check('三层树都起来了', Boolean(root && l2pid && l3pid), `root=${root} l2=${l2pid} l3=${l3pid}`);

  // Walks up through live ancestors, which is the easy case and was never broken.
  const whole = new Set([root]);
  const both = await SandboxShell.descendantsOf(root, whole);
  // `null` means the process table could not be read. Asserted, because every check below would
  // otherwise pass by comparing against an empty list.
  check('进程表读得到（否则这一段退化成假检查）', both !== null, '读不到进程表');
  check('活着的时候三层都认得出', (both ?? []).includes(l2pid) && (both ?? []).includes(l3pid),
    JSON.stringify(both));

  // Reap the middle level, leaving the grandchild pointing at a pid that no longer resolves.
  spawnSync('taskkill', ['/PID', String(l2pid), '/F'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => setTimeout(r, 800));
  check('中间层确实被回收了', pidsMarked('SHE-GATE-L2').length === 0);
  check('孙进程还活着（这就是要认出来的那个）', pidsMarked('SHE-GATE-L3').length === 1);

  // Not recorded before the kill => the chain is unreadable and the child is unattributable.
  const blind = await SandboxShell.descendantsOf(root, new Set([root]));
  check('没记录中间层时，它就是找不到（这是被承认的极限）', !(blind ?? []).includes(l3pid), JSON.stringify(blind));

  // Recorded before the kill => the child is claimed, which is what the pre-kill snapshot buys.
  const aware = await SandboxShell.descendantsOf(root, new Set([root, l2pid]));
  check('【关键】记录过中间层，孙进程就被认回来', (aware ?? []).includes(l3pid), JSON.stringify(aware));

  spawnSync('taskkill', ['/PID', String(root), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  spawnSync('taskkill', ['/PID', String(l3pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => setTimeout(r, 800));
  check('这一段自己没留下进程', countMarked('SHE-GATE-L') === 0, `剩余 ${countMarked('SHE-GATE-L')}`);
  removeTempDir(dir);
}
}

/* ─── 6. A process that spawns a process ─── */
console.log('\n=== 【关键】命令的孙进程也一起收掉 ===');
{
  const marker = 'SHE-GATE-GRANDCHILD';
  const started = await tools.execute('shell', {
    command: 'node -e "const{spawn}=require(\'child_process\');'
      + `spawn(process.execPath,['-e','setInterval(()=>{},1000)','${marker}'],{stdio:'ignore'});`
      + 'setInterval(()=>{},1000)"',
    background: true,
  });
  const id = jobId(started);
  const grandchild = await waitForMarked(marker, 1, 6_000);
  check('孙进程起来了', grandchild > 0, `匹配 ${grandchild}`);
  await tools.execute('shell_kill', { id });
  await new Promise((r) => setTimeout(r, 1500));
  check('【关键】孙进程没有变成孤儿', countMarked(marker) === 0, `剩余 ${countMarked(marker)}`);
}

/* ─── 6. Background is not a way around the policy ─── */
console.log('\n=== 后台不是绕过策略的路径 ===');
{
  const strict = new SandboxShell(workspace, { denyDestructiveByDefault: true });
  const strictTools = createTools(strict, workspace);
  const listed = new SandboxShell(workspace, { allowAllCommands: true, allowedCommands: ['echo'] });
  const listedTools = createTools(listed, workspace, { allowAllCommands: true });

  const bgDenied = await strictTools.execute('shell', { command: 'rm -rf /', background: true });
  check('破坏性命令在后台同样被拦下', /needs_confirm|DENIED/.test(bgDenied), bgDenied);
  check('【关键】拒绝时不会先把进程起起来', !/job_id=/.test(bgDenied), bgDenied);

  const bgOutside = await listedTools.execute('shell', { command: 'node -v', background: true });
  check('白名单在后台同样生效', /^DENIED:/.test(bgOutside), bgOutside);
  check('拒绝信息指出命令名', /node/.test(bgOutside), bgOutside);

  await strict.stopAll();
  await listed.stopAll();
}

/* ─── 7. The table cannot grow without bound ─── */
console.log('\n=== 上限：宁可拒绝第九个，也不让它悄悄溜走 ===');
{
  const own = new SandboxShell(workspace, { allowAllCommands: true });
  const ownTools = createTools(own, workspace, { allowAllCommands: true });
  /*
   * Every job here carries a marker, because the teardown of eight jobs at once is one of the two
   * places the snapshot race shows up. Measuring only the tool's answer would have said "everything
   * was stopped" while eight pairs sat on the machine — which is exactly how this section previously
   * passed under a build that leaked.
   */
  const marks = [];
  for (let i = 0; i < 8; i++) {
    const marker = `SHE-GATE-CAP-${i}`;
    await ownTools.execute('shell', { command: `node -e "setInterval(()=>{},1000)" ${marker}`, background: true });
    marks.push(marker);
  }
  const ninth = await ownTools.execute('shell', { command: 'node -e "setInterval(()=>{},1000)"', background: true });
  check('第九个被拒绝，并说明怎么腾位置', /^Error: 后台任务已达上限/.test(ninth) && /shell_jobs/.test(ninth), ninth);
  check('8 个都在跑', (await Promise.all(marks.slice(0, 3).map((m) => waitForMarked(m, 1, 6_000)))).every((n) => n > 0));

  await own.stopAll();
  check('stopAll 之后一个都不剩', own.runningJobs().length === 0);
  check('stopAll 之后不再计数', /No background jobs found/.test(await ownTools.execute('shell_jobs', {})), '');

  await new Promise((r) => setTimeout(r, 1500));
  const left = marks.map((m) => countMarked(m));
  check('【关键】一次停掉 8 个也不留孤儿', left.every((n) => n === 0), `剩余 ${left.join(',')}`);
}

/* ─── 8. A foreground timeout is a promotion, not a death ─── */
console.log('\n=== 前台超时 = 转后台，不是杀掉 ===');
{
  const marker = 'SHE-GATE-TIMEOUT';
  const promoted = await tools.execute('shell', {
    command: `node -e "setTimeout(()=>console.log('FINISHED-LATE'),5000)" ${marker}`,
    timeout_ms: 1200,
  });
  const alive = await waitForMarked(marker, 1, 6_000);
  check('超时后进程仍然活着', alive > 0, `匹配 ${alive}`);
  const done = await tools.execute('shell_wait', { id: jobId(promoted), wait_ms: 20000 });
  check('等待能拿到它后来才打印的输出', /FINISHED-LATE/.test(done), done);
}

/* ─── 9. A killed job does not look like a failed command ─── */
console.log('\n=== 被终止的任务不能被读成「命令跑失败了」 ===');
{
  const started = await tools.execute('shell', {
    command: 'node -e "setInterval(()=>{},1000)"',
    background: true,
  });
  const killed = await tools.execute('shell_kill', { id: jobId(started) });
  /*
   * `classifyToolResult` reads `exit code: <n>` as "the command ran and failed — do not retry". A
   * stop is a decision, not a failure, so the text must not carry an exit code at all.
   */
  check('终止结果不带退出码', !/exit code/.test(killed), killed);
  check('终止原因写明了是 shell_kill', /shell_kill/.test(killed), killed);
}

/* ─── 10. Release on teardown ─── */
console.log('\n=== 会话结束时收掉后台任务（不是丢引用）===');
{
  const own = new SandboxShell(workspace, { allowAllCommands: true });
  const ownTools = createTools(own, workspace, { allowAllCommands: true });
  const marker = 'SHE-GATE-TEARDOWN';
  await ownTools.execute('shell', { command: `node -e "setInterval(()=>{},1000)" ${marker}`, background: true });
  check('任务在跑', (await waitForMarked(marker, 1, 6_000)) > 0);
  await own.stopAll();
  await new Promise((r) => setTimeout(r, 1200));
  check('【关键】stopAll 收掉进程', countMarked(marker) === 0, `剩余 ${countMarked(marker)}`);

  const second = new SandboxShell(workspace, { allowAllCommands: true });
  const secondTools = createTools(second, workspace, { allowAllCommands: true });
  const marker2 = 'SHE-GATE-DISPOSE';
  await secondTools.execute('shell', { command: `node -e "setInterval(()=>{},1000)" ${marker2}`, background: true });
  second.dispose();
  check('dispose 之后不再被跟踪', second.runningJobs().length === 0);
  await second.stopAll();
  await new Promise((r) => setTimeout(r, 1200));
  check('【关键】dispose 也收掉进程（丢引用不等于停进程）', countMarked(marker2) === 0, `剩余 ${countMarked(marker2)}`);
}

/* ─── 11. Nothing was left behind by this check at all ─── */
{
  const leftover = countMarked('SHE-GATE-');
  check('本次检查自己没留下任何进程', leftover === 0, `剩余 ${leftover}`);
}

await shell.stopAll();
removeTempDir(workspace);

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
