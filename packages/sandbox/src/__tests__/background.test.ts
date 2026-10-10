/**
 * Background jobs: start, wait, kill, list.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE FILE FROM `sandbox.test.ts`
 *
 * Every other sandbox test is about REFUSING something: a command, a path, a
 * destructive pattern. These are about a process that keeps running after the
 * tool call that started it returned, which is a different kind of claim — the
 * state outlives the call, so what has to be asserted is the behaviour of a
 * transcript over time, not one return value.
 *
 * The four failures this file exists to make impossible, in the order they were
 * met while building it:
 *
 *   1. A job started with `background: true` never noticed its process ending,
 *      so it stayed "running" until its lifetime cap and its output never
 *      carried an exit code. (`finishProc` now lives on the spawn path.)
 *   2. A wait for a job that printed nothing and did not end exited the process
 *      instead of resolving — an unref'd timer was the only pending handle.
 *   3. A chunk boundary inside a multi-byte character turned it into U+FFFD in
 *      the model's context, a character the program never printed.
 *   4. Reading twice re-sent output the reader had already seen, which is the
 *      same text billed twice and a poll loop the detector cannot tell from a
 *      real one.
 *
 *   node --import tsx --test src/__tests__/background.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SandboxShell, splitCompleteUtf8 } from '../shell.js';
import { createTools } from '../tools.js';

let tempDir: string;
let shell: SandboxShell;
let tools: ReturnType<typeof createTools>;

/** `node -e` is the only way to get a deterministic, portable process here. */
const nodeEval = (js: string) => `node -e "${js.replace(/"/g, '\\"')}"`;

const jobIdOf = (text: string): string => {
  const m = text.match(/job_id=(job_\d+)/);
  assert.ok(m, `应返回 job_id: ${text}`);
  return m[1]!;
};

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'she-bg-test-'));
  shell = new SandboxShell(tempDir, { allowAllCommands: true, denyDestructiveByDefault: false });
  tools = createTools(shell, tempDir, { allowAllCommands: true });
});

/**
 * Remove the fixture directory — and never turn a passing file red.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SWALLOWS THE ERROR
 *
 * This hook used to end in a bare `rm(...)`. On 2026-09-29 the gate ran this file while the machine
 * was busy with an unrelated training job, a killed process took longer than the 20 retries to let
 * go of its working directory, and `rm` threw EBUSY — reported as `hookFailed`, with every
 * assertion in the file having passed. That is the worst kind of red: it is not reproducible in
 * isolation (running this file alone passes), so it trains people to re-run until green, and a gate
 * people re-run until green is not a gate.
 *
 * A leftover temp directory is harmless: `pnpm check:temp` sweeps what earlier runs leave. A check
 * that reports failure after passing is not. So this one is reported, not thrown.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch (err) {
    console.warn(`[sandbox.test] 临时目录没删掉，留给 check:temp: ${dir} (${(err as Error).message})`);
  }
}

after(async () => {
  /*
   * `stopAll` rather than `dispose`.
   *
   * On Windows a killed process keeps its working directory locked for a moment after the signal,
   * so removing the temp directory right after `dispose()` reported EBUSY and turned a fully passing
   * file into a failed one. Waiting for the processes to actually be gone is the difference between
   * "we asked" and "it is over" — but that wait is still a race, so the removal above cannot be the
   * thing that decides whether this file passed.
   */
  await shell.stopAll();
  await cleanupTempDir(tempDir);
});

describe('UTF-8 分块：半个字符不能变成替换字符', () => {
  it('不完整的尾部被扣住，完整的部分照常返回', () => {
    const whole = Buffer.from('中文', 'utf8');
    // Cut inside the second character (each CJK char is 3 bytes).
    const cut = whole.subarray(0, 4);
    const [readable, held] = splitCompleteUtf8(cut);
    assert.equal(readable.toString('utf8'), '中');
    assert.equal(held.length, 1, '第 2 个字的第 1 字节应被扣住');

    // Feeding the held byte plus the rest completes it.
    const [done] = splitCompleteUtf8(Buffer.concat([held, whole.subarray(4)]));
    assert.equal(done.toString('utf8'), '文');
  });

  it('全是续字节时整段扣住，而不是解码出乱码', () => {
    const [readable, held] = splitCompleteUtf8(Buffer.from([0xad, 0xb8]));
    assert.equal(readable.length, 0);
    assert.equal(held.length, 2);
  });

  it('完整的 UTF-8 一个字节都不扣', () => {
    const buf = Buffer.from('ok-标记', 'utf8');
    const [readable, held] = splitCompleteUtf8(buf);
    assert.equal(held.length, 0);
    assert.equal(readable.length, buf.length);
  });
});

describe('后台任务：启动 / 等待 / 增量读取', () => {
  it('【关键】wait_ms 0 是查询状态，不是"没有"', async () => {
    const started = await tools.execute('shell', {
      command: nodeEval('setTimeout(()=>console.log("late"),2500)'),
      background: true,
    });
    const id = jobIdOf(started);

    const status = await tools.execute('shell_wait', { id, wait_ms: 0 });
    assert.match(status, /还在运行/, status);
    assert.ok(!/exit code/.test(status), `运行中的任务不能有退出码: ${status}`);

    await tools.execute('shell_kill', { id });
  });

  it('【关键】阻塞等待到结束，拿到退出码与输出', async () => {
    const started = await tools.execute('shell', {
      command: nodeEval('setTimeout(()=>console.log("LATE-DONE"),1200)'),
      background: true,
    });
    const id = jobIdOf(started);
    const done = await tools.execute('shell_wait', { id, wait_ms: 15000 });
    assert.match(done, /已结束/, done);
    assert.match(done, /LATE-DONE/, done);
    assert.match(done, /exit code: 0/, done);
  });

  it('【关键】读过的输出不再重发（第二次 wait 没有正文，且有退出码）', async () => {
    const started = await tools.execute('shell', {
      command: nodeEval('setTimeout(()=>console.log("ONCE-ONLY"),800)'),
      background: true,
    });
    const id = jobIdOf(started);
    const first = await tools.execute('shell_wait', { id, wait_ms: 15000 });
    assert.match(first, /ONCE-ONLY/, first);

    const second = await tools.execute('shell_wait', { id, wait_ms: 0 });
    assert.ok(!second.includes('ONCE-ONLY'), `同一条输出不该出现两次: ${second}`);
    assert.match(second, /exit code: 0/, second);
  });

  it('两次相邻的等待，第二次只给新输出', async () => {
    const started = await tools.execute('shell', {
      command: nodeEval('let n=0;setInterval(()=>console.log("tick",++n),400)'),
      background: true,
    });
    const id = jobIdOf(started);
    /*
     * 第一次的等待给足时间，因为这里问的不是"多快能读到"，而是"两次读有没有重叠"。
     *
     * 以前是 1500ms + 断言手里必须有 `tick 1`：那等于要求子进程在 1.5 秒内完成 node 冷启动并打印
     * 第一次。满负载的门禁里这条会假红（实测：整个文件里就它一条红，`duration_ms 3299`，单独跑
     * 两次全绿）。前置条件只需要证明"第一次读不是空的"，所以断言放宽到"拿到过至少一个 tick"，
     * 而**不变量一个字没动**：两次读里的 tick 不许重复。
     */
    const first = await tools.execute('shell_wait', { id, wait_ms: 3000 });
    const second = await tools.execute('shell_wait', { id, wait_ms: 1500 });
    assert.match(first, /tick \d+/, `第一次读必须是空的才让下面那条变成空跑: ${first}`);
    const firstTicks = new Set((first.match(/tick \d+/g) ?? []));
    const secondTicks = (second.match(/tick \d+/g) ?? []);
    for (const t of secondTicks) {
      assert.ok(!firstTicks.has(t), `${t} 在两次读取里都出现了`);
    }
    await tools.execute('shell_kill', { id });
  });

  it('pattern 命中就返回，不必等任务结束', async () => {
    const started = await tools.execute('shell', {
      command: nodeEval('let n=0;setInterval(()=>console.log("ready-step",++n),300)'),
      background: true,
    });
    const id = jobIdOf(started);
    const t0 = Date.now();
    const hit = await tools.execute('shell_wait', { id, pattern: 'ready-step 2', wait_ms: 15000 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `pattern 应立即命中，实际 ${elapsed}ms`);
    assert.match(hit, /pattern 匹配到了/, hit);
    await tools.execute('shell_kill', { id });
  });

  it('pattern 也能命中已经滚过去的那一行（不是只看未读字节）', async () => {
    const started = await tools.execute('shell', {
      command: nodeEval('console.log("SERVER-LISTENING");setInterval(()=>{},1000)'),
      background: true,
    });
    const id = jobIdOf(started);
    // Read it once so the line is definitely behind us.
    await tools.execute('shell_wait', { id, wait_ms: 1000 });
    const hit = await tools.execute('shell_wait', { id, pattern: 'SERVER-LISTENING', wait_ms: 8000 });
    assert.match(hit, /pattern 匹配到了/, hit);
    await tools.execute('shell_kill', { id });
  });
});

describe('后台任务：结束 / 终止 / 上限', () => {
  it('kill 会停掉进程与它的子进程，并给出原因', async () => {
    const started = await tools.execute('shell', {
      command: nodeEval('setInterval(()=>{},1000)'),
      background: true,
    });
    const id = jobIdOf(started);
    const killed = await tools.execute('shell_kill', { id });
    assert.match(killed, /已被终止/, killed);
    assert.match(killed, /shell_kill/, killed);
    /*
     * A killed job must NOT carry an `exit code:` line. It would make the result look like a shell
     * result to the classifier, which reads it as `nonzero_exit` — "the command ran and failed, do
     * not retry" — for a stop that was a decision, not a failure.
     */
    assert.ok(!/exit code/.test(killed), `被终止的任务不该报退出码: ${killed}`);

    // And it is really gone: another wait reports the same terminal state.
    const after = await tools.execute('shell_wait', { id, wait_ms: 0 });
    assert.match(after, /已被终止/, after);
  });

  it('【关键】子进程一起收掉（留下的是孤儿，不是后台任务）', async () => {
    /*
     * The child prints nothing and outlives its parent unless the whole tree is killed. Asserting
     * this from inside the sandbox is not possible — the process table is the only witness — so what
     * is asserted here is that kill reports a terminal state; the process-tree count lives in
     * `scripts/background-check.mjs`, which is the check that can see it.
     */
    const started = await tools.execute('shell', {
      command: nodeEval(
        'const{spawn}=require("child_process");'
        + 'spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});'
        + 'setInterval(()=>{},1000)',
      ),
      background: true,
    });
    const id = jobIdOf(started);
    const killed = await tools.execute('shell_kill', { id });
    assert.match(killed, /已被终止/, killed);
  });

  it('未知的 id 给出可操作的错误，而不是空结果', async () => {
    const out = await tools.execute('shell_wait', { id: 'job_99999', wait_ms: 0 });
    assert.match(out, /^Error:/, out);
    assert.match(out, /shell_jobs/, out);
  });

  it('缺 id / 非法 pattern 都被指出，而不是当成功', async () => {
    const noId = await tools.execute('shell_wait', {});
    assert.match(noId, /^Error: id 必填/, noId);
    const badRe = await tools.execute('shell_wait', { id: 'job_1', pattern: '([' });
    assert.match(badRe, /^Error: pattern 不合法/, badRe);
  });

  it('【关键】后台不能绕过策略：前后台走同一个确认/拒绝结论', async () => {
    const strict = new SandboxShell(tempDir, { denyDestructiveByDefault: true });
    const strictTools = createTools(strict, tempDir);
    try {
      /*
       * Both go through the confirmation gate — the background path is not a way around it.
       * Asserted as parity rather than as a literal `DENIED`, because which of the two shapes comes
       * back (a fresh ticket, or a policy refusal after the ticket is redeemed) is the sandbox's
       * decision, and the thing that must be true is that it does not differ by path.
       */
      const bgTicket = await strictTools.execute('shell', { command: 'rm -rf /', background: true });
      const fgTicket = await strictTools.execute('shell', { command: 'rm -rf /' });
      assert.match(bgTicket, /needs_confirm/, bgTicket);
      assert.match(fgTicket, /needs_confirm/, fgTicket);

      // Redeem the ticket for each path: the destructive policy still refuses both.
      const bgId = JSON.parse(bgTicket).needs_confirm.ticket_id;
      const fgId = JSON.parse(fgTicket).needs_confirm.ticket_id;
      const bg = await strictTools.execute('shell', { command: 'rm -rf /', background: true, _confirm_ticket: bgId });
      const fg = await strictTools.execute('shell', { command: 'rm -rf /', _confirm_ticket: fgId });
      assert.match(bg, /^DENIED:/, bg);
      assert.equal(bg, fg, '前后台的拒绝结论必须一致');
      // The denial says it once. `DENIED: DENIED:` is what a doubled prefix looks like.
      assert.ok(!/DENIED:.*DENIED:/i.test(bg), bg);
    } finally {
      await strict.stopAll();
    }
  });

  it('白名单在后台上同样生效', async () => {
    const listed = new SandboxShell(tempDir, { allowAllCommands: true, allowedCommands: ['echo'] });
    const listedTools = createTools(listed, tempDir, { allowAllCommands: true });
    try {
      const bg = await listedTools.execute('shell', { command: 'node -v', background: true });
      assert.match(bg, /^DENIED:/, bg);
      assert.match(bg, /白名单/, bg);
    } finally {
      await listed.stopAll();
    }
  });

  it('shell_jobs 列出运行中与已结束，且不读取、不吃掉输出', async () => {
    const started = await tools.execute('shell', {
      command: nodeEval('setTimeout(()=>console.log("KEEP-ME"),600)'),
      background: true,
    });
    const id = jobIdOf(started);
    const before = await tools.execute('shell_jobs', {});
    assert.match(before, new RegExp(id), before);

    // Listing must not consume: the log is still there for the wait that follows.
    const done = await tools.execute('shell_wait', { id, wait_ms: 15000 });
    assert.match(done, /KEEP-ME/, `shell_jobs 不该吃掉输出: ${done}`);
  });

  it('没有任务时给出哨兵，而不是空字符串', async () => {
    const fresh = new SandboxShell(tempDir, { allowAllCommands: true });
    const freshTools = createTools(fresh, tempDir, { allowAllCommands: true });
    try {
      const out = await freshTools.execute('shell_jobs', {});
      assert.equal(out, 'No background jobs found.');
    } finally {
      await fresh.stopAll();
    }
  });

  it('【关键】dispose / stopAll 都停掉在跑的进程', async () => {
    const own = new SandboxShell(tempDir, { allowAllCommands: true });
    const ownTools = createTools(own, tempDir, { allowAllCommands: true });
    await ownTools.execute('shell', { command: nodeEval('setInterval(()=>{},1000)'), background: true });
    assert.equal(own.runningJobs().length, 1);

    /*
     * `dispose()` is the fire-and-forget form used from signal handlers: it must stop the jobs
     * being tracked, so nothing is left that nobody can wait on or kill by name.
     */
    own.dispose();
    assert.equal(own.runningJobs().length, 0, 'dispose 之后不该还有在跑的任务');
    assert.equal(ownTools.runningJobs?.().length, 0);

    // And the awaiting form really waits, which is what a caller about to delete files needs.
    const second = new SandboxShell(tempDir, { allowAllCommands: true });
    const secondTools = createTools(second, tempDir, { allowAllCommands: true });
    await secondTools.execute('shell', { command: nodeEval('setInterval(()=>{},1000)'), background: true });
    await second.stopAll();
    assert.equal(second.runningJobs().length, 0);
  });
});

describe('前台超时：留在后台，而不是被杀掉', () => {
  it('【关键】超过 timeout_ms 的命令继续跑，且第一次等待就能拿到它的输出', async () => {
    const out = await tools.execute('shell', {
      command: nodeEval('setTimeout(()=>console.log("SURVIVED"),2500)'),
      timeout_ms: 1000,
    });
    assert.match(out, /job_id=/, out);
    assert.match(out, /还在跑/, out);
    /*
     * The foreground result must NOT claim an exit code. `exit code: 124` is the shell's own
     * timeout convention and reads as "it ran and failed" — which sends the model to re-run a
     * command that is still working.
     */
    assert.ok(!/exit code/.test(out), `转过后台时不能报退出码: ${out}`);

    const id = jobIdOf(out);
    const done = await tools.execute('shell_wait', { id, wait_ms: 15000 });
    assert.match(done, /SURVIVED/, done);
    assert.match(done, /exit code: 0/, done);
  });

  it('后台转到上限时降级为前台超时结论（宁可杀掉，也不给一个用不了的 id）', async () => {
    const own = new SandboxShell(tempDir, { allowAllCommands: true });
    const ownTools = createTools(own, tempDir, { allowAllCommands: true });
    try {
      // Fill the job table with long-lived processes.
      for (let i = 0; i < 8; i++) {
        await ownTools.execute('shell', { command: nodeEval('setInterval(()=>{},1000)'), background: true });
      }
      const ninth = await ownTools.execute('shell', { command: nodeEval('setInterval(()=>{},1000)'), background: true });
      assert.match(ninth, /^Error: 后台任务已达上限/, ninth);
      assert.match(ninth, /shell_jobs/, ninth);
    } finally {
      await own.stopAll();
    }
  });

  it('超时转后台时不会把同一段输出印两遍', async () => {
    const own = new SandboxShell(tempDir, { allowAllCommands: true });
    const ownTools = createTools(own, tempDir, { allowAllCommands: true });
    try {
      /*
       * 软截止必须留出**进程链自己启动**的时间，否则这条会假红。
       *
       * Windows 上一条 `node -e` 不是直接起 node：`spawnCommand` 起的是
       * `powershell.exe -EncodedCommand` → `cmd.exe /d /c` → `node`，三层。实测这一串到"第一行
       * 输出可读"的端到端延迟：空载 565–690ms（8 次），而 `pnpm -r test` 满负载下 565–2131ms
       * （10 次，中位 920ms）。原来的 1500ms 正落在满载区间的中间，于是全量门禁里这条报
       * `not ok 3`，`first` 里一行输出都没有，而它当时的原话是「已运行 1.5 秒」—— 那不是在说
       * "输出被印了两遍"，是**子进程还没轮到 CPU**。前置条件不成立，不变量根本没被检验。
       *
       * 给到 6000ms（实测最坏值的约 3 倍），LATE-LINE 推到 8000ms 让它仍然晚于截止。
       * **不变量一个字没动**：已经给出去的那段输出，不许在后台那次读里再出现一次。
       */
      const first = await ownTools.execute('shell', {
        command: nodeEval('console.log("EARLY-LINE");setTimeout(()=>console.log("LATE-LINE"),8000)'),
        timeout_ms: 6000,
      });
      assert.match(first, /EARLY-LINE/,
        `前置条件：命令必须在截止前印出第一行（没印出说明进程链启动比截止还慢，不是重复输出）: ${first}`);
      const id = jobIdOf(first);
      const rest = await ownTools.execute('shell_wait', { id, wait_ms: 15000 });
      assert.ok(!rest.includes('EARLY-LINE'), `转后台前已印过的行不该重复: ${rest}`);
      assert.match(rest, /LATE-LINE/, rest);
    } finally {
      await own.stopAll();
    }
  });
});


describe('停止这一轮：等待要结束，任务不因此被杀', () => {
  it('【关键】abort 打断 shell_wait：很快返回、说清任务仍在跑、任务确实还在', async () => {
    /*
     * 用户报「都 400 秒了…先停下说一下情况」，而那一轮还在 shell_wait 里。
     * 根因：停止只打断了模型请求（provider 拿到 signal），工具里的等待没有 signal ——
     * 一轮要等 shell_wait 返回（最长 10 分钟）才结束。
     *
     * 语义要点：**停的是等待，不是任务**。所以这条判据同时要求三件事：很快返回、明说任务仍在跑、
     * 任务真的还能被继续等（不能被顺手杀掉 —— 那会丢掉一整轮的算力）。
     */
    const started = await tools.execute('shell', {
      command: nodeEval('setTimeout(()=>console.log("LONG-DONE"),60000)'),
      background: true,
    });
    const id = jobIdOf(started);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 400);
    const t0 = Date.now();
    const interrupted = await tools.execute('shell_wait', { id, wait_ms: 60000 }, { signal: ac.signal });
    const took = Date.now() - t0;
    clearTimeout(timer);

    /*
     * 预算是 20 秒，不是"很快"，因为这条判据要区分的是两件事：
     *   - 功能对：abort 之后立即返回（正常几百毫秒）；
     *   - 功能坏：一直等，直到这个任务自己跑完（它设了 60 秒）。
     * 满负载的机器上（内存 99% 那种）光是拉起 node 就可能花几秒，5 秒会把"机器慢"判成"功能坏"
     * —— 上一轮门禁就是这样假红在这里的。20 秒离 60 秒仍然很远，区分度不减。
     */
    assert.ok(took < 20_000, `abort 之后应当很快返回，实测 ${took}ms`);
    assert.match(interrupted, /等待是被用户停止的/, interrupted);
    assert.match(interrupted, /还在运行/, interrupted);
    assert.ok(!interrupted.includes('LONG-DONE'), '任务没结束，不该出现它的收尾输出');

    // 任务没有被杀：还能继续等它
    const still = await tools.execute('shell_wait', { id, wait_ms: 0 });
    assert.match(still, /还在运行/, still);

    await tools.execute('shell_kill', { id });
  });
});