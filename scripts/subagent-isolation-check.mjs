/**
 * 子任务隔离与结构化交接 —— 离线，本地起一个真 server，模型是本地 stub。
 *
 * 子智能体现在是「同一个工作区里的另一个 Agent」：它和父级、和它的兄弟读写的是同一批文件。
 * 交接也只是一段自由文本 —— 父级要重读一遍摘要才知道子级有没有越界，子级也不知道自己越界了。
 *
 * 这里补的是两件事：
 *
 *   1. **隔离副本。** 声明了会改哪些文件的子任务，在它自己的 git worktree 里干活。副本从 HEAD
 *      拉出之后会把父级未提交的改动搬过去，否则子级看到的版本比父级正在描述的还旧。
 *      「自动」这条规则刻意收得很窄：只读的子任务**留在这个 checkout 里** —— 给只读任务开副本
 *      反而更糟，因为副本基于 HEAD，一个被要求「看看我现在的改动」的子级会读到上一次提交。
 *   2. **结构化交接。** `deliverable` / `scope` / `constraints` / `context` 直接交给子级，
 *      并在返回里原样回显，父级不必重读自己写过的话就能核对范围。会改文件却没写交付物 →
 *      在派发前就拒掉：那是唯一一种产出「没人能核对的工作」的委派形状。
 *
 * 这个检查还钉住三条容易做错的：
 *
 *   - **隔离失败不许静默降级。** 拿不到副本时要在结果里说出来 —— 父级以为子级在私有树里、
 *     实际它在共享 checkout 里编辑，正是这个功能要防的那起事故。这一条在真 server 上两种工作区
 *     各验一遍：是 git 仓库时副本建起来、回执里**不该**出现警告；不是仓库时任务照跑、回执里
 *     必须出现警告和原因。两边的用词是同一个变量决定的，只验其中一边等于什么都没验。
 *   - **中文任务名也必须能开出副本。** 路径清洗只留 ASCII 时，一个纯中文的任务名会被清成空串，
 *     于是「在中文里请求隔离」会安静地退化成共享工作区。
 *   - **父级工作区必须干净。** 这是「隔离」两个字的全部含义。
 *   - **只读任务不发警告。** 只读子任务是大多数，它们没有要求过隔离；每条回执都挂一条「未隔离」
 *     会让这条警告在真正需要它的那一次失效。
 *
 *   node scripts/subagent-isolation-check.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const AGENT_DIR = join(ROOT, 'packages', 'agent-runtime');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');

if (!existsSync(SERVER_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
  }
};

const { shouldIsolate, composeHandoffPrompt, createSubagentTools } =
  await import(pathToFileURL(join(AGENT_DIR, 'dist', 'index.js')).href);
const { addWorktree, changedFiles, isGitRepo, removeWorktree, transferLocalChanges } =
  await import(pathToFileURL(join(SERVER_DIR, 'dist', 'worktrees.js')).href);

const dirs = [];
const tempDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `she-sub-${tag}-`));
  dirs.push(d);
  return d;
};
const cleanup = () => { for (const d of dirs) removeTempDir(d); };
process.on('exit', cleanup);

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

/**
 * Compare two Windows paths for real, not textually.
 *
 * A temp directory can be reached as `C:\Users\Administrator\AppData\Local\Temp\…` or as
 * `C:\Users\ADMINI~1\AppData\Local\Temp\…`, and which one a given piece of code produces depends on
 * where the string came from — `git rev-parse`, an environment variable, a syscall. Comparing the
 * raw strings makes those two spellings look like different directories, which is the same class of
 * bug the server's own `canonical()` exists to avoid; the check has to use the same rule or it
 * asserts the spelling rather than the behaviour.
 */
const canon = (p) => {
  try { return realpathSync.native(p).toLowerCase(); } catch { try { return realpathSync(p).toLowerCase(); } catch { return resolve(p).toLowerCase(); } }
};

/** A real repository with one commit — `addWorktree` needs a HEAD to branch from. */
function makeRepo(tag) {
  const dir = tempDir(tag);
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'she-check@example.invalid']);
  git(dir, ['config', 'user.name', 'she-check']);
  // The app writes its own state into `<workspace>/.she`, and the server's app dir sits inside the
  // workspace in this fixture. Ignored rather than asserted around, so "the parent checkout is
  // clean" keeps meaning "no subtask touched a tracked file" instead of degenerating into a
  // filter list that has to be updated whenever the server writes something new.
  writeFileSync(join(dir, '.gitignore'), '.she/\nappdir/\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# 示例项目\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

const porcelain = (dir) => git(dir, ['status', '--porcelain']).stdout.trim();

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 什么时候开副本：规则要窄，且要明说
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n1. 自动隔离的规则');

{
  check('声明了 scope → 开副本', shouldIsolate({ isolation: 'auto', handoff: { scope: ['a.ts'] } }, true) === true, null);
  check('只读任务（没有 scope）→ 留在共享 checkout', shouldIsolate({ isolation: 'auto', handoff: {} }, true) === false, null);
  check('【关键】只读任务不开副本，才能看到父级未提交的改动（副本是从 HEAD 拉的）',
    shouldIsolate({ isolation: 'auto', handoff: { scope: [] } }, true) === false, null);
  check('显式 worktree → 即使没写 scope 也开', shouldIsolate({ isolation: 'worktree' }, true) === true, null);
  check('显式 none → 即使在 git 仓库里也不开', shouldIsolate({ isolation: 'none', handoff: { scope: ['a.ts'] } }, true) === false, null);
  check('不在 git 仓库里 → 想开也开不了，规则如实返回 false', shouldIsolate({ isolation: 'worktree' }, false) === false, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 交接单：子级看到的到底是什么
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n2. 交接单的内容');

{
  // portability-check:allow — 工作目录是夹具数据，这一项测的是「副本路径会不会写进交接单」。
  const brief = composeHandoffPrompt({
    description: '整理调用方',
    prompt: '列出所有调用方。',
    handoff: {
      deliverable: '一份调用方清单',
      scope: ['src/a.ts', 'src/b.ts'],
      constraints: ['只读外部依赖', '不要装新依赖'],
      context: ['入口在 src/index.ts'],
    },
  }, { workdir: 'D:\\ws', isolated: true }); // portability-check:allow — 夹具

  check('写明交付物', brief.includes('一份调用方清单'), brief);
  check('写明允许改哪些文件', brief.includes('src/a.ts') && brief.includes('src/b.ts'), brief);
  check('写明约束', brief.includes('不要装新依赖'), brief);
  check('写明已知情况（省掉重新验证）', brief.includes('入口在 src/index.ts'), brief);
  check('写明工作目录', brief.includes('D:\\ws'), brief); // portability-check:allow — 同一夹具
  check('【关键】说明这是副本、不要自己合并（否则子级会去 commit/push）',
    /隔离副本/.test(brief) && /不要尝试自己合并/.test(brief), brief);
  check('【关键】交接单排在任务之前（顺序会影响读的人）',
    brief.indexOf('交接单') < brief.indexOf('列出所有调用方'), brief);
  check('原始 prompt 原样保留', brief.includes('列出所有调用方。'), brief);
}

{
  const brief = composeHandoffPrompt({ description: '查一下', prompt: '看看目录。' }, { workdir: '/ws', isolated: false });
  check('没有 scope 时明说是只读任务', /不要修改、创建或删除任何文件/.test(brief), brief);
  check('没有提供交付物时退回任务简述（不留空）', brief.includes('查一下'), brief);
  check('【关键】共享 checkout 时不说「这是副本」（说了子级就不敢改文件了）',
    !/隔离副本/.test(brief), brief);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 派发层：拒掉没人能核对的委派形状，回显结构化字段
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n3. 派发与回显');

async function runTasks(tasks, runnerImpl) {
  const calls = [];
  const runner = {
    async run(req) {
      calls.push(req);
      return runnerImpl ? runnerImpl(req) : { description: req.description, ok: true, result: 'ok', handoff: req.handoff };
    },
  };
  const tools = createSubagentTools(runner);
  const out = await tools.execute('task_spawn', { tasks });
  return { out, calls };
}

{
  const { out, calls } = await runTasks([
    { description: '改文件', prompt: '把 a.ts 改好', deliverable: '改好的 a.ts', scope: ['src/a.ts'] },
  ]);
  check('结构化字段原样传到 runner', calls[0]?.handoff?.deliverable === '改好的 a.ts'
    && calls[0]?.handoff?.scope?.[0] === 'src/a.ts', JSON.stringify(calls[0]?.handoff));
  check('isolation 默认是 auto', calls[0]?.isolation === 'auto', String(calls[0]?.isolation));
  check('工具输出里回显了交付物（父级不必重读自己写的 prompt）', out.includes('一份') || out.includes('改好的 a.ts'), out);
  check('工具输出里回显了允许改动的范围', out.includes('src/a.ts'), out);
}

{
  const { out, calls } = await runTasks([
    { description: '偷偷改一堆东西', prompt: '随便改改', scope: ['src/**'] },
  ]);
  check('【关键】会改文件但没写交付物 → 拒掉', /^Error:/.test(out), out);
  check('【关键】拒掉时根本没有派发（子级没被拉起来）', calls.length === 0, JSON.stringify(calls));
  check('拒绝文案说清了缺什么、怎么补', /交付物/.test(out) && /scope 去掉/.test(out), out);
}

{
  const { out, calls } = await runTasks([
    { description: '显式副本', prompt: 'x', isolation: 'worktree' },
  ]);
  check('显式 worktree 但没写交付物 → 同样拒掉（强制副本也是会改文件的意思）',
    /^Error:/.test(out) && calls.length === 0, out);
}

{
  const { out, calls } = await runTasks([{ description: '只读', prompt: '读一下 README' }]);
  check('只读任务照常派发', calls.length === 1, out);
  check('只读任务没有 scope 也没有 isolation（由规则决定不开副本）', calls[0]?.handoff === undefined, JSON.stringify(calls[0]));
}

{
  const { out } = await runTasks(
    [{ description: '隔离的活', prompt: 'x', deliverable: '一份补丁', scope: ['src/a.ts'] }],
    (req) => ({
      description: req.description,
      ok: true,
      result: '干完了',
      handoff: req.handoff,
      worktree: { path: 'D:\\wt\\sub-1', branch: 'she/sub-1', changed: ['src/a.ts', 'src/new.ts'] },
    }),
  );
  check('结果里报出副本路径与分支', out.includes('D:\\wt\\sub-1') && out.includes('she/sub-1'), out);
  check('【关键】结果里列出子级改了哪些文件（否则成功的隔离子任务看起来像什么都没干）',
    out.includes('src/a.ts') && out.includes('src/new.ts'), out);
  check('说明改动还在副本里、要按路径取用', /隔离副本/.test(out) && /按上面的路径取用/.test(out), out);
}

{
  const { out } = await runTasks(
    [{ description: '隔离失败', prompt: 'x', deliverable: 'D', scope: ['src/a.ts'] }],
    (req) => ({
      description: req.description,
      ok: true,
      result: '干完了（但在共享 checkout 里）',
      handoff: req.handoff,
      // No worktree, only the reason it is missing — the shape the server returns when a declared
      // writable scope could not be isolated. The parent is editing files it believes are private.
      isolation: { requested: true, applied: false, note: '主工作区不是 git 仓库，无法开隔离副本，这个子任务在共享工作区里跑' },
    }),
  );
  check('【关键】隔离没能建立时，结果里说清楚（不能静默降级）', /未隔离/.test(out) && /不是 git 仓库/.test(out), out);
}

{
  const { out } = await runTasks(
    [{ description: '只读', prompt: '看看日志' }],
    (req) => ({
      description: req.description,
      ok: true,
      result: '看完了',
      handoff: req.handoff,
      // Read-only in a git repo: nothing was asked for, nothing is missing.
      isolation: { requested: false, applied: false },
    }),
  );
  check('【关键】只读任务不报「未隔离」（否则每条回执都挂一条无意义的警告）', !/未隔离/.test(out), out);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 副本的文件系统语义：改动落在副本里，主仓库干净
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n4. 副本与主仓库的边界');

{
  const repo = makeRepo('fs');
  check('isGitRepo 认得真仓库', isGitRepo(repo) === true, null);
  check('isGitRepo 不把普通目录当仓库', isGitRepo(tempDir('plain')) === false, null);

  const wt = addWorktree(repo, 'sub-写个说明', { unique: true });
  check('【关键】纯中文任务名也能开出副本（旧的 ASCII 清洗会清成空串）',
    existsSync(wt.path), wt.path);
  check('分支名带上了 she/ 前缀', wt.branch.startsWith('she/'), wt.branch);

  writeFileSync(join(wt.path, 'notes.md'), '子级的产出\n', 'utf8');
  check('【关键】副本里能看到子级写的文件', changedFiles(wt.path).includes('notes.md'), JSON.stringify(changedFiles(wt.path)));
  check('【关键】主仓库的 git status 是干净的 —— 这就是「隔离」的全部含义', porcelain(repo) === '', porcelain(repo));
  check('【关键】主仓库里没有那个文件', !existsSync(join(repo, 'notes.md')), null);

  // A sibling with the same label must get its own tree rather than silently losing isolation.
  const wt2 = addWorktree(repo, 'sub-写个说明', { unique: true });
  check('【关键】同名任务不会共用副本（第二个会退化成无隔离）', wt2.path !== wt.path && existsSync(wt2.path), wt2.path);

  let threw = null;
  try { addWorktree(repo, 'sub-写个说明'); } catch (err) { threw = err; }
  check('不带 unique 的调用仍然如实报「目录已存在」（交互式建副本要告诉用户）',
    threw !== null && /目录已存在/.test(String(threw?.message)), String(threw?.message));

  check('isGitRepo 在 worktree 里也为真（.git 是文件，不是目录）', isGitRepo(wt.path) === true, null);

  removeWorktree(repo, wt.path);
  removeWorktree(repo, wt2.path);
  check('副本可以移除', !existsSync(wt.path) && !existsSync(wt2.path), null);
}

{
  const repo = makeRepo('carry');
  writeFileSync(join(repo, 'README.md'), '# 示例项目\n\n父级还没提交的改动\n', 'utf8');
  check('先确认主仓库确实有未提交改动', porcelain(repo) !== '', porcelain(repo));

  const wt = addWorktree(repo, 'sub-carry', { unique: true });
  const note = transferLocalChanges(repo, wt.path);
  check('搬运未提交改动成功', /已套用|没有未提交/.test(note), note);
  check('【关键】子级看到的是父级当前的版本，不是上一次提交（否则它改的是旧代码）',
    existsSync(join(wt.path, 'README.md')) && readFileSync(join(wt.path, 'README.md'), 'utf8').includes('父级还没提交的改动'),
    readFileSync(join(wt.path, 'README.md'), 'utf8'));
  check('搬运不会动主仓库', porcelain(repo).includes('README.md'), porcelain(repo));
  removeWorktree(repo, wt.path);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 真 server：模型 stub 发起一个会改文件的子任务
 *
 * 这一段验的是接线：副本真的建了、子级真的被关在副本里、父级工作区真的干净、结构化交接
 * 真的到了子级手里。子级到底有没有写成功不在这里断言（那取决于危险工具的确认门），
 * 文件系统语义已经由第 4 段确定性地钉住了。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n5. 真 server：带 scope 的子任务被关进副本');

const TASK_LABEL = '整理说明文件';

/*
 * One stub model, two scenarios.
 *
 * The two scenarios further down differ only in whether the workspace is a git repository, so the
 * stub is shared and parameterised: that keeps the difference between them exactly the one variable
 * under test. A second copy of this callback would drift, and what is being compared would quietly
 * stop being "isolation available vs not".
 */
function makeStubLlm(task) {
  const state = { parentCalls: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const msgs = body.messages ?? [];
      // The child is the request that carries our handoff brief — that is the only reliable signal,
      // and using something incidental (the model name, the call order) would make this test pass or
      // fail for reasons unrelated to the brief.
      const isChild = msgs.some((m) => typeof m.content === 'string' && m.content.includes('## 交接单'));
      state.parentCalls += isChild ? 0 : 1;

      let message;
      if (state.parentCalls === 1 && !isChild) {
        message = {
          role: 'assistant',
          content: '我把它交出去做。',
          tool_calls: [{
            id: 'call_spawn_1',
            type: 'function',
            function: { name: 'task_spawn', arguments: JSON.stringify({ tasks: [task] }) },
          }],
        };
      } else {
        message = { role: 'assistant', content: isChild ? '子任务做完了。' : '已让它去做，结果见上。' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 },
      }));
    });
  });
  return { server, state };
}

async function waitForHealth(base, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Boot the stub model plus a real server on it, and hand back the handles to drive and stop both. */
async function startLive({ ws, task, llmPort, port }) {
  const { server: stub } = makeStubLlm(task);
  await new Promise((r) => stub.listen(llmPort, '127.0.0.1', r));

  const child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      SHE_WORKSPACE: ws,
      SHE_PORT: String(port),
      SHE_APP_DIR: join(ws, 'appdir'),
      SHE_STATE_DIR: ws,
      SHE_LLM_PROVIDER: 'openai',
      OPENAI_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      OPENAI_MODEL: 'stub',
      OPENAI_API_KEY: 'stub-key',
      SHE_SUBAGENT_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    try { child.kill(); } catch { /* already gone */ }
    try { stub.close(); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 400));
  };
  return {
    api: (path, init) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(90_000), ...init }),
    ok: await waitForHealth(base),
    log: () => out,
    stop,
  };
}

const SPAWN_TASK = {
  description: TASK_LABEL,
  prompt: '在仓库里新建 notes/out.md，写一句「子级产出」。',
  deliverable: '一份 notes/out.md',
  scope: ['notes/out.md'],
  constraints: ['不要装新依赖'],
  context: ['仓库根就是工作目录'],
};

const LLM_PORT = await pickSafePort(Number(process.env.SHE_SUBAGENT_LLM_PORT || 18311), [18312, 18313, 19314]);

const PORT = String(await pickSafePort(Number(process.env.SHE_SUBAGENT_TEST_PORT || 18295), [18296, 18297, 19298]));
const ws = makeRepo('live');
mkdirSync(join(ws, '.she'), { recursive: true });
const worktreesRoot = join(dirname(ws), '.she-worktrees', ws.split(/[\\/]/).pop());
dirs.push(worktreesRoot);

const live = await startLive({ ws, task: SPAWN_TASK, llmPort: LLM_PORT, port: Number(PORT) });
const api = live.api;

if (!live.ok) {
  check('server 起得来', false, live.log().slice(-500));
} else {
  const chat = await api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `把「${TASK_LABEL}」交出去做`, stream: false }),
  });
  const chatBody = await chat.text();
  check('这一轮真的跑成功了（模型是本地 stub，不是超时）', chat.ok && !/max_iterations/.test(chatBody), `${chat.status} ${chatBody.slice(0, 400)}`);

  const sessions = await (await api('/api/sessions?all=1&scope=all')).json();
  const allSessions = sessions?.sessions ?? [];
  const childSession = allSessions.find((s) => s.title === TASK_LABEL);
  check('【关键】子任务在自己的会话里（过程可回看）', Boolean(childSession), JSON.stringify(allSessions.map((s) => s.title)));
  check('子会话保留父级给它的名字（结构化交接单不能顶掉标题）',
    Boolean(childSession) && childSession.title === TASK_LABEL, String(childSession?.title).slice(0, 80));

  const worktreeDirs = existsSync(worktreesRoot)
    ? (await import('node:fs')).readdirSync(worktreesRoot).filter((n) => n.startsWith('sub-'))
    : [];
  check('【关键】为它建了一个隔离副本', worktreeDirs.length === 1, JSON.stringify(worktreeDirs));
  const wtPath = worktreeDirs.length ? join(worktreesRoot, worktreeDirs[0]) : null;

  if (childSession && wtPath) {
    const detail = await (await api(`/api/sessions/${childSession.id}`)).json();
    check('【关键】子会话被关在副本里（它的工作目录就是副本）',
      canon(detail?.directory ?? '') === canon(wtPath), `${detail?.directory} vs ${wtPath}`);

    const firstUser = (detail?.messages ?? []).find((m) => m.role === 'user');
    const brief = String(firstUser?.content ?? '');
    check('【关键】子级真的收到了结构化交接单', brief.includes('## 交接单'), brief.slice(0, 300));
    check('交接单里有交付物', brief.includes('一份 notes/out.md'), brief.slice(0, 400));
    check('交接单里有允许改动的范围', brief.includes('notes/out.md'), brief.slice(0, 400));
    check('交接单里有约束', brief.includes('不要装新依赖'), brief.slice(0, 400));
    check('交接单里写明了工作目录是副本',
      brief.includes(wtPath.split(/[\\/]/).pop()) && /工作目录/.test(brief), brief.slice(0, 500));
    check('交接单里说明了改动不会自动进入主工作区', /隔离副本/.test(brief), brief.slice(0, 500));
  }

  const parentId = sessions?.active_id ?? allSessions.find((s) => s.title !== TASK_LABEL)?.id;
  const parentDetail = parentId ? await (await api(`/api/sessions/${parentId}`)).json() : null;
  const parentText = JSON.stringify(parentDetail ?? {});
  const wtLeaf = wtPath ? wtPath.split(/[\\/]/).pop() : '';
  check('拿得到父级的会话记录', Boolean(parentDetail), `${parentId} ${parentText.slice(0, 200)}`);
  check('【关键】父级拿到的回执里带着副本路径（否则它不知道去哪取结果）',
    Boolean(wtLeaf) && parentText.includes(wtLeaf), `${wtLeaf} :: ${parentText.slice(0, 500)}`);
  check('回执里列出了允许改动的范围', /允许改动/.test(parentText), parentText.slice(0, 500));
  check('【关键】副本建成了就不该出现「未隔离」警告（狼来了会让警告失效）',
    !/未隔离/.test(parentText), parentText.slice(0, 500));

  check('【关键】父级工作区始终干净 —— 子级没有任何改动落到这里', porcelain(ws) === '', porcelain(ws));
  check('主仓库里没有子级要写的那个文件', !existsSync(join(ws, 'notes', 'out.md')), null);
}

await live.stop();
// git worktrees live outside the temp workspace; prune them so they do not accumulate.
try { git(ws, ['worktree', 'prune']); } catch { /* best effort */ }

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 真 server：开不出副本时，父级必须知道
 *
 * 和上面唯一的区别是工作区**不是 git 仓库**。规则允许任务照常跑 —— 一个不是仓库的目录里本来
 * 就没有副本可开，为此拒绝执行反而是坏的（用户会以为功能整个坏了）。但不能一声不吭：父级声明了
 * 它要改哪些文件，就必须知道这些改动落在共享工作区里，而不是它以为的私有副本里。
 * 这里断言那句话真的送到了，并且带着原因 —— 只说「未隔离」不让父级知道该怎么补救。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n6. 真 server：没有 git 仓库时的如实回报');

const NOGIT_LLM_PORT = await pickSafePort(18321, [18322, 18323, 19324]);
const NOGIT_PORT = await pickSafePort(18297, [18299, 18300, 19301]);
/*
 * The workspace sits inside a temp root of its own.
 *
 * Worktrees are created next to the workspace (`<parent>/.she-worktrees/<name>`), so a workspace
 * placed directly in the shared temp directory shares that slot with every other scenario in this
 * file and with whatever else is on the machine — and the "no worktrees were created" assertion
 * below then fails on someone else's leftovers rather than on this scenario's behaviour. A private
 * parent makes the directory mean one thing.
 */
const nogitRoot = tempDir('nogit-root');
const ws2 = join(nogitRoot, 'ws');
mkdirSync(ws2, { recursive: true });
check('前提：这个工作区确实不是 git 仓库', isGitRepo(ws2) === false, ws2);

const live2 = await startLive({ ws: ws2, task: SPAWN_TASK, llmPort: NOGIT_LLM_PORT, port: NOGIT_PORT });

if (!live2.ok) {
  check('server 起得来（非 git 工作区）', false, live2.log().slice(-500));
} else {
  const chat2 = await live2.api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `把「${TASK_LABEL}」交出去做`, stream: false }),
  });
  const body2 = await chat2.text();
  check('非 git 工作区里任务照常跑（不是直接报错）',
    chat2.ok && !/max_iterations/.test(body2), `${chat2.status} ${body2.slice(0, 400)}`);

  const sessions2 = await (await live2.api('/api/sessions?all=1&scope=all')).json();
  const all2 = sessions2?.sessions ?? [];
  const child2 = all2.find((s) => s.title === TASK_LABEL);
  check('子任务仍然跑在自己的会话里', Boolean(child2), JSON.stringify(all2.map((s) => s.title)));

  const parentId2 = sessions2?.active_id ?? all2.find((s) => s.title !== TASK_LABEL)?.id;
  const parentText2 = JSON.stringify(
    parentId2 ? await (await live2.api(`/api/sessions/${parentId2}`)).json() : {},
  );
  check('【关键】父级被告知「未隔离」，而不是以为子级在私有副本里',
    /未隔离/.test(parentText2), parentText2.slice(0, 600));
  check('【关键】并且说清了原因是没有 git 仓库（否则父级不知道该怎么补救）',
    /不是 git 仓库/.test(parentText2), parentText2.slice(0, 600));

  if (child2) {
    const detail2 = await (await live2.api(`/api/sessions/${child2.id}`)).json();
    check('【关键】子级确实在共享工作区里跑（这与上面那句警告必须一致）',
      canon(detail2?.directory ?? '') === canon(ws2), `${detail2?.directory} vs ${ws2}`);
  }

  const wtRoot2 = join(dirname(ws2), '.she-worktrees');
  const strayWorktrees = existsSync(wtRoot2) ? (await import('node:fs')).readdirSync(wtRoot2) : [];
  check('没有凭空建出副本目录', strayWorktrees.length === 0, JSON.stringify(strayWorktrees));
}

await live2.stop();
cleanup();

console.log('');
if (failures) {
  console.log(`${failures} 项失败`);
  process.exit(1);
}
console.log('子任务隔离检查通过');
void rmSync;
