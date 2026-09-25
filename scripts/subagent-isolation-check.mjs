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
 *   - **子级的知识库不许是空的。** 副本只拉 tracked 文件，`.she/` 从来不在里面，所以隔离过的子级
 *     原本打开的是一个刚建的空库 —— 提示词却写着「组结构知识库是默认记忆」，于是它对父级刚描述过的
 *     项目回答「查不到记录」，而它自己分不清这到底是「项目没有这条」还是「我的记忆被重置了」。
 *     现在快照父级库给它，并在交接单里说明快照的语义（写入不回父级）。
 *   - **知识库文件只经 `kb_*` 工具访问。** 实测里模型会从会话历史里学会 `sqlite3 .she/kb.sqlite
 *     "SELECT …"` 绕过引擎：直读不计访问、不走共振排序，直写跳过分裂/压缩/去重，还和正在跑的库
 *     并发写。提示词要在模型读规则的地方把这条路封掉。
 *   - **共享父级库的子任务不许写。** 隔离只在声明了 `scope` 的写任务上生效，所以只读子任务恰恰是
 *     共享父级活动库的那个 —— 它拿到的记忆规则和父级一样，写进去的节点又没有来源标记。这段在真
 *     server 上让子级去 `kb_upsert` 一次，然后直接读父级库文件确认那条记忆不存在，同时确认读还通
 *     （只读不能变成失忆）。
 *
 *   node scripts/subagent-isolation-check.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, readdirSync } from 'node:fs';
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

const { shouldIsolate, composeHandoffPrompt, createSubagentTools, getSystemPrompt } =
  await import(pathToFileURL(join(AGENT_DIR, 'dist', 'index.js')).href);
const { addWorktree, changedFiles, isGitRepo, removeWorktree, transferLocalChanges } =
  await import(pathToFileURL(join(SERVER_DIR, 'dist', 'worktrees.js')).href);
const { KBStore, GroupKBEngine } = await import(pathToFileURL(join(ROOT, 'packages', 'kb', 'dist', 'index.js')).href);
const { loadConfig } = await import(pathToFileURL(join(ROOT, 'packages', 'shared', 'dist', 'index.js')).href);
const KB_CFG = loadConfig(ROOT).kb;

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
    // The KB rule is the same one section 7 asserts positively: a shared workspace means the
    // parent's KB, so saying "snapshot" or "empty" here would be a lie the child cannot check.
    const brief2 = String((detail2?.messages ?? []).find((m) => m.role === 'user')?.content ?? '');
    check('共享工作区的子级不说「快照副本 / 空库」（共享就是共享父级的库）',
      !/快照副本/.test(brief2) && !/你的知识库是\*\*空的\*\*/.test(brief2), brief2.slice(0, 300));
  }

  const wtRoot2 = join(dirname(ws2), '.she-worktrees');
  const strayWorktrees = existsSync(wtRoot2) ? (await import('node:fs')).readdirSync(wtRoot2) : [];
  check('没有凭空建出副本目录', strayWorktrees.length === 0, JSON.stringify(strayWorktrees));
}

await live2.stop();

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 知识库接缝：提示词只许走 kb_*，子任务的知识库是私有副本且跑完就清
 *
 * 上面几段钉的是「子级改的文件落在哪」。这一段钉的是「子级知道的东西从哪来」—— 两件事都属
 * 「隔离」，但之前只验了前一件：一个被关进副本的子级如果连父级的记忆都看不到，它改出来的东西
 * 就是在一个它认为「项目没有历史」的世界里做出的判断。
 *
 * 这一段的前半（提示词只许走 `kb_*`）是静态的，后半（副本放在哪、跑完在不在）走真 server。
 * 「子级读得到父级记忆」和「子级写下的笔记被收割」在第 9 段断言 —— 那里模型 stub 会让子级
 * 真的去调 `kb_query` / `kb_upsert`，比在这里读文件更接近用户看到的东西。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n7. 子任务知识库：私有副本、放在副本目录外、跑完就清');

{
  // The rule has to sit where the model reads it, in both languages: the Chinese KB block is what
  // the KB rules are written in, the English one is what the tool list and core rules use.
  const prompt = getSystemPrompt(ROOT);
  check('【关键】提示词禁止用 shell / fs_* 直读直写知识库文件',
    /知识库文件只许经/.test(prompt) && /不要用 `shell`/.test(prompt), null);
  check('【关键】提示词说明理由（直读不计访问计数、绕过共振排序）',
    /访问计数/.test(prompt) && /共振排序|结构共振排序/.test(prompt), null);
  check('Core Rules 里也有一条把这条路封掉', /Reach the KB only through/.test(prompt), null);
  check('工具清单里 kb_query 自己就写明「只此一条路」', /never poke the sqlite file/.test(prompt), null);
}

const KB_SEED_TITLE = '父级已知的事实';
const KB_SEED_MARKER = 'MARKER-KB-SEED';

const kbRoot = tempDir('kbroot');
const ws3 = join(kbRoot, 'ws');
mkdirSync(ws3, { recursive: true });
git(ws3, ['init']);
git(ws3, ['config', 'user.email', 'she-check@example.invalid']);
git(ws3, ['config', 'user.name', 'she-check']);
writeFileSync(join(ws3, '.gitignore'), '.she/\nappdir/\n', 'utf8');
writeFileSync(join(ws3, 'README.md'), '# 示例项目\n', 'utf8');
git(ws3, ['add', '-A']);
git(ws3, ['commit', '-m', 'init']);
check('前提：这个工作区是 git 仓库（否则不会开副本）', isGitRepo(ws3) === true, null);

const parentKb = join(ws3, '.she', 'kb.sqlite');
mkdirSync(join(ws3, '.she'), { recursive: true });
{
  // Seeded out-of-band so the check does not depend on a model choosing to write knowledge.
  const store = new KBStore(parentKb);
  const engine = new GroupKBEngine(store, { ...KB_CFG, dbPath: parentKb });
  const group = engine.createGroup('project/seed');
  engine.addMemory(group.id, 'fact', KB_SEED_TITLE, `${KB_SEED_MARKER}：父级库里的唯一线索。`);
  store.close();
}
const kbCount = (p) => {
  const s = new KBStore(p);
  const n = s.getStats().totalMemories;
  s.close();
  return n;
};
check('前提：父级库里有 1 条记忆', kbCount(parentKb) === 1, String(kbCount(parentKb)));

/**
 * The child's knowledge-base copies that are still on disk, for one workspace.
 *
 * `SHE_APP_DIR` is set per live server by the harness, so this is the app directory of the server
 * under test and not the operator's real one. The copies are expected to be gone by the time a
 * spawn returns — that is the cleanup being asserted, not a detail of the path.
 */
const leftoverKbCopies = (wsRoot) => {
  const dir = join(wsRoot, 'appdir', 'subagent-kb');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.sqlite'));
};

/** The notes digest a child's harvest is written to, when it wrote anything. */
const digestPath = (wsRoot, childId) => join(wsRoot, '.she', 'subagent-notes', `${childId}.md`);

const CHILD_NOTE_TITLE = '子级查到的产物约定';
const CHILD_NOTE_MARKER = 'MARKER-CHILD-NOTE';

/*
 * Parent delegates a writable task; the child reads the parent's memory, writes its own note, ends.
 *
 * Three claims have to be settled inside ONE run, and none of them can be observed from outside the
 * child's process: the private copy has to be READABLE (otherwise the handoff's promise — "you can
 * query what the parent knows" — is a lie about a project whose history the parent just described),
 * the note the child writes has to LAND somewhere (a child with nowhere to put a finding carries it
 * only in prose, if it remembers), and the copy has to be GONE by the time the spawn returns.
 *
 * Scripted rather than left to a model because the ORDER is part of the assertion: the read has to
 * happen against the copy it was given, and the write has to happen before it ends.
 */
function makeKbHarvestLlm() {
  const state = { parentCalls: 0, childCalls: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const msgs = body.messages ?? [];
      // Same signal as everywhere else in this file: the handoff brief is what makes a request the child.
      const isChild = msgs.some((m) => typeof m.content === 'string' && m.content.includes('## 交接单'));
      state.parentCalls += isChild ? 0 : 1;
      state.childCalls += isChild ? 1 : 0;

      let message;
      if (isChild && state.childCalls === 1) {
        message = {
          role: 'assistant',
          content: '先查项目里既有的约定。',
          tool_calls: [{
            id: 'call_harvest_query',
            type: 'function',
            function: { name: 'kb_query', arguments: JSON.stringify({ query: KB_SEED_MARKER }) },
          }],
        };
      } else if (isChild && state.childCalls === 2) {
        message = {
          role: 'assistant',
          content: '有条结论值得留下来。',
          tool_calls: [{
            id: 'call_harvest_upsert',
            type: 'function',
            function: {
              name: 'kb_upsert',
              arguments: JSON.stringify({
                groupName: 'project/child-finding',
                title: CHILD_NOTE_TITLE,
                content: `${CHILD_NOTE_MARKER}：这条笔记只应该出现在子级的副本里，并随回执交回父级。`,
                kind: 'fact',
              }),
            },
          }],
        };
      } else if (isChild) {
        message = { role: 'assistant', content: '产出写在 notes/out.md 了，结论见上。' };
      } else if (state.parentCalls === 1) {
        message = {
          role: 'assistant',
          content: '我把它交出去做。',
          tool_calls: [{
            id: 'call_spawn_harvest',
            type: 'function',
            function: { name: 'task_spawn', arguments: JSON.stringify({ tasks: [SPAWN_TASK] }) },
          }],
        };
      } else {
        message = { role: 'assistant', content: '子任务回来了。' };
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

const KB_LLM_PORT = await pickSafePort(18331, [18332, 18333, 19334]);
const KB_PORT = await pickSafePort(18291, [18292, 18303, 19305]);

const kbStub = makeKbHarvestLlm();
await new Promise((r) => kbStub.server.listen(KB_LLM_PORT, '127.0.0.1', r));
const kbChildProc = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: ws3,
    SHE_PORT: String(KB_PORT),
    SHE_APP_DIR: join(ws3, 'appdir'),
    SHE_STATE_DIR: ws3,
    SHE_LLM_PROVIDER: 'openai',
    OPENAI_BASE_URL: `http://127.0.0.1:${KB_LLM_PORT}/v1`,
    OPENAI_MODEL: 'stub',
    OPENAI_API_KEY: 'stub-key',
    SHE_SUBAGENT_TIMEOUT_MS: '30000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let kbOut3 = '';
kbChildProc.stdout.on('data', (c) => { kbOut3 += c; });
kbChildProc.stderr.on('data', (c) => { kbOut3 += c; });
const kbBase3 = `http://127.0.0.1:${KB_PORT}`;
const live3 = {
  ok: await waitForHealth(kbBase3),
  api: (path, init) => fetch(`${kbBase3}${path}`, { signal: AbortSignal.timeout(90_000), ...init }),
  log: () => kbOut3,
  stop: async () => {
    try { kbChildProc.kill(); } catch { /* already gone */ }
    try { kbStub.server.close(); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 400));
  },
};

if (!live3.ok) {
  check('server 起得来（带父级知识库的工作区）', false, live3.log().slice(-500));
} else {
  const chat3 = await live3.api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `把「${TASK_LABEL}」交出去做`, stream: false }),
  });
  const body3 = await chat3.text();
  check('这一轮真的跑成功了（模型是本地 stub，不是超时）',
    chat3.ok && !/max_iterations/.test(body3), `${chat3.status} ${body3.slice(0, 400)}`);

  const sessions3 = await (await live3.api('/api/sessions?all=1&scope=all')).json();
  const child3 = (sessions3?.sessions ?? []).find((s) => s.title === TASK_LABEL);
  const wtRoot3 = join(kbRoot, '.she-worktrees', 'ws');
  const wtDirs3 = existsSync(wtRoot3) ? (await import('node:fs')).readdirSync(wtRoot3).filter((n) => n.startsWith('sub-')) : [];
  const wtPath3 = wtDirs3.length === 1 ? join(wtRoot3, wtDirs3[0]) : null;
  check('【前提】确实为它建了副本', Boolean(wtPath3), JSON.stringify(wtDirs3));

  /*
   * The snapshot is asserted through what the CHILD did, not by opening the copy.
   *
   * By this point the copy no longer exists — that IS the lifecycle under test — so reading the file
   * here would prove nothing either way. The child's transcript is where the evidence survives: it
   * queried the seeded marker and got the parent's note back, which is the only way to tell a seeded
   * copy from an empty one, and it wrote a note without being refused.
   */
  if (child3) {
    const detail3 = await (await live3.api(`/api/sessions/${child3.id}`)).json();
    const childText3 = JSON.stringify(detail3);
    check('【关键】子级 kb_query 查得到父级库里的那条记忆（副本不是空库）',
      new RegExp(KB_SEED_TITLE).test(childText3), childText3.slice(0, 900));
    check('【关键】子级往自己的副本里写是允许的（写不进去等于让它把结论忘掉）',
      /Added memory/.test(childText3), childText3.slice(0, 900));
  }

  /*
   * What the parent got back, read where the parent would read it.
   *
   * `task_spawn`'s answer is a tool RESULT, so it lives in the parent's transcript — the HTTP body
   * only carries the assistant's final message. Asserting on the body would have tested nothing.
   */
  const parentId3 = sessions3?.active_id
    ?? (sessions3?.sessions ?? []).find((s) => s.id !== child3?.id)?.id;
  const parentText3 = JSON.stringify(
    parentId3 ? await (await live3.api(`/api/sessions/${parentId3}`)).json() : {},
  );
  check('【关键】子级写下的笔记被收割进父级的回执（副本删了也看得到它留下了什么）',
    parentText3.includes(CHILD_NOTE_TITLE), parentText3.slice(0, 1200));
  check('回执说明副本已随之清理，值得留的要用 kb_upsert 搬进主库',
    /副本已随子任务清理/.test(parentText3) && /kb_upsert/.test(parentText3), parentText3.slice(0, 1200));
  check('【关键】父级库本身还是那 1 条 —— 收割是读取，不是替父级决定',
    kbCount(parentKb) === 1, `父级库现有 ${kbCount(parentKb)} 条`);

  if (child3) {
    const digest3 = digestPath(ws3, child3.id);
    check('【关键】全文另存了一份，父级能读到完整的笔记（不只是开头一段）',
      existsSync(digest3) && readFileSync(digest3, 'utf8').includes(CHILD_NOTE_MARKER), digest3);
  }
  check('【关键】子级结束后副本被删掉（不留一个没人管的库在磁盘上）',
    leftoverKbCopies(ws3).length === 0, JSON.stringify(leftoverKbCopies(ws3)));

  if (child3) {
    const detail3 = await (await live3.api(`/api/sessions/${child3.id}`)).json();
    const brief3 = String((detail3?.messages ?? []).find((m) => m.role === 'user')?.content ?? '');
    check('【关键】交接单如实说明知识库是父级库的私有副本（子级才不会把「查不到」误判成「项目没有记录」）',
      /父级库的私有副本/.test(brief3), brief3.slice(0, 600));
    check('【关键】交接单说明写下的笔记会被父级读一遍、副本随后删除（它才知道笔记是唯一的出口）',
      /被父级读一遍/.test(brief3) && /副本随后删除/.test(brief3), brief3.slice(0, 600));
  } else {
    check('【关键】找得到子会话（交接单要在这里面查）', false, JSON.stringify((sessions3?.sessions ?? []).map((s) => s.title)));
  }

  /*
   * The copy is only useful if the worktree stays disposable.
   *
   * The child's KB is opened by the server process and cached per path, so deleting the worktree
   * afterwards keeps a live sqlite handle inside the directory — on Windows `rmdir` then fails with
   * EBUSY and the copy can never be cleaned up. Asserting through the real route (rather than
   * against the helper) is the point: the handle belongs to the server, and that is the process
   * the UI's delete button runs in.
   */
  if (wtPath3) {
    const del = await live3.api(`/api/worktrees?repo=${encodeURIComponent(ws3)}&path=${encodeURIComponent(wtPath3)}`, {
      method: 'DELETE',
    });
    const delBody = await del.text();
    let locked = '';
    if (!del.ok || existsSync(wtPath3)) {
      // Identify the file that actually kept the directory: on Windows the message is only
      // "Invalid argument", which says nothing about which handle is open.
      const { readdirSync: rd, rmSync: rm } = await import('node:fs');
      const stuck = [];
      const walk = (d) => {
        for (const e of rd(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          try { rm(p); } catch { stuck.push(p.replace(wtPath3, '')); }
        }
      };
      try { walk(wtPath3); } catch { /* best effort */ }
      locked = stuck.length ? ` 锁住: ${stuck.join(', ')}` : '';
    }
    check('【关键】子任务跑完后副本能被删掉（服务端没有把库句柄一直攥着）',
      del.ok && !existsSync(wtPath3), `${del.status} ${delBody.slice(0, 300)} ${existsSync(wtPath3) ? '目录还在' : ''}${locked}`);
  }
}

await live3.stop();
try { git(ws3, ['worktree', 'prune']); } catch { /* best effort */ }

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 真 server：知识库禁止直连的规则真的接上了
 *
 * 第 7 段钉的是提示词里写了规则，这一段钉的是规则真的在服务端生效。两者必须分开验：一条只写在
 * 提示词里的规则，模型一旦决定绕路就什么也拦不住 —— 真实运行里就出现过
 * `sqlite3 .she/kb.sqlite "SELECT ..."`，绕过了共振排序和访问计数，还在服务端已经打开的库上多
 * 抓了一个句柄。这里让 stub 模型直接发出这两种调用，看服务端回来的到底是什么。
 *
 * 走真 server 而不是直接调 createTools，是因为要验的正是「服务端有没有把库路径传下去」这一
 * 根接线：传丢了，工具层就什么都不拦，而单元测试会照样全绿。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n8. 真 server：知识库禁止直连');

const RAW_LLM_PORT = await pickSafePort(18341, [18342, 18343, 19344]);
const RAW_PORT = await pickSafePort(18281, [18282, 18283, 19304]);

const rawRoot = tempDir('rawroot');
const ws4 = join(rawRoot, 'ws');
mkdirSync(join(ws4, '.she'), { recursive: true });
// A real (empty) database: the server opens it on boot, so bytes chosen to look like one
// would fail startup with "file is not a database" and test nothing.
{ const s = new KBStore(join(ws4, '.she', 'kb.sqlite')); s.close(); }
writeFileSync(join(ws4, 'notes.txt'), 'ordinary file\n', 'utf8');

/** Emits exactly the two calls the rule exists to stop, then stops calling tools. */
function makeRawAccessLlm() {
  const state = { calls: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.calls++;
      const message = state.calls === 1
        ? {
            role: 'assistant',
            content: '我直接看一下库。',
            tool_calls: [
              { id: 'call_raw_1', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: '.she/kb.sqlite' }) } },
              { id: 'call_raw_2', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'sqlite3 .she/kb.sqlite "SELECT * FROM memories"' }) } },
            ],
          }
        : { role: 'assistant', content: '好，那我不直连了。' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 },
      }));
    });
  });
  return { server, state };
}

const rawStub = makeRawAccessLlm();
await new Promise((r) => rawStub.server.listen(RAW_LLM_PORT, '127.0.0.1', r));
const rawChild = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: ws4,
    SHE_PORT: String(RAW_PORT),
    SHE_APP_DIR: join(ws4, 'appdir'),
    SHE_STATE_DIR: ws4,
    SHE_LLM_PROVIDER: 'openai',
    OPENAI_BASE_URL: `http://127.0.0.1:${RAW_LLM_PORT}/v1`,
    OPENAI_MODEL: 'stub',
    OPENAI_API_KEY: 'stub-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let rawOut = '';
rawChild.stdout.on('data', (c) => { rawOut += c; });
rawChild.stderr.on('data', (c) => { rawOut += c; });
const rawBase = `http://127.0.0.1:${RAW_PORT}`;
const rawApi = (path, init) => fetch(`${rawBase}${path}`, { signal: AbortSignal.timeout(90_000), ...init });
const started = await waitForHealth(rawBase);

if (!started) {
  check('server 起得来（带知识库的工作区）', false, rawOut.slice(-500));
} else {
  const chat4 = await rawApi('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '看看知识库里有什么', stream: false }),
  });
  const body4 = await chat4.text();
  check('这一轮真的跑成功了（模型是本地 stub，不是超时）',
    chat4.ok && !/max_iterations/.test(body4), `${chat4.status} ${body4.slice(0, 400)}`);

  const sessions4 = await (await rawApi('/api/sessions?all=1&scope=all')).json();
  const sid4 = sessions4?.active_id ?? (sessions4?.sessions ?? [])[0]?.id;
  const detail4 = sid4 ? await (await rawApi(`/api/sessions/${sid4}`)).json() : {};
  const text4 = JSON.stringify(detail4);

  check('【关键】fs_read 直读知识库被服务端拒掉（不是把二进制灌给模型）',
    /知识库文件只能通过/.test(text4), text4.slice(0, 900));
  check('【关键】拒绝文案指向 kb_query（只说「不行」等于没说）',
    /kb_query/.test(text4) && /kb_upsert/.test(text4), text4.slice(0, 900));
  check('【关键】shell 里 sqlite3 直查也是 DENIED，而不是让它跑起来',
    /DENIED/.test(text4), text4.slice(0, 900));
  check('拒绝发生在确认门之前（否则用户会被问「要不要写 kb.sqlite」）',
    !/needs_confirm/.test(text4), text4.slice(0, 900));
}

rawChild.kill();
try { rawStub.server.close(); } catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 400));

/* ══════════════════════════════════════════════════════════════════════════
 * 9. 真 server：共享 checkout 的子任务，记忆仍然是私有的
 *
 * 第 7 段钉的是隔离子任务的库（有副本、能被收割、跑完删掉），这一段钉**没有隔离副本**的那种
 * 子任务 —— 它是委派里最常见的形状：没声明 `scope` 的只读任务不开副本，于是它和父级共用同一个
 * 工作目录。
 *
 * 共用工作目录不等于共用自己的记忆。旧实现把这两件事当成一件事：只有隔离子任务拿得到副本，
 * 其余子任务直接连父级的活动库，所以它们只能被设成只读 —— 父级的记忆离一次未经复核的编辑只有
 * 一个调用的距离，而子级找到的结论无处可放。现在每个子任务都拿到自己的私有副本：写一定落得下
 * （落在父级看不见的地方），而父级的库一定不动。
 *
 * 必须走真 server。要验的是「服务端有没有把私有副本接上去」这一根接线：接丢了，子级要么写进父
 * 级库、要么被拒，而单元测试里那个 dbPath 是我自己传的，怎么传都绿。
 *
 * 断言分两半，缺一不可：父级库没被动过（安全性），以及**读还通、还能写**（没顺手把记忆变成失忆
 * 或把它变成哑巴）。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n9. 真 server：共享 checkout 的子任务写在自己的副本里');

const SHARED_LABEL = '记一条不该写的记忆';
/** No `scope` on purpose — that is what keeps this child in the shared checkout. */
const SHARED_TASK = {
  description: SHARED_LABEL,
  prompt: '把「子级自己的结论」记进知识库，然后回报你查到了父级库里哪条记忆。',
};
const CHILD_WRITE_TITLE = '子级偷偷写的记忆';
const CHILD_WRITE_MARKER = 'MARKER-CHILD-WROTE';

/**
 * Parent delegates a read-only task; the child writes a note, then reads the parent's memory.
 *
 * The child is identified the same way section 5 does it — by the handoff brief in its first user
 * message. Keying off call order instead would make the stub's behaviour depend on how many turns
 * the parent happens to take, which is not what is under test.
 *
 * The write comes FIRST on purpose: if the private copy were not wired up, the parent's own database
 * would take the node, and the count assertion below is what catches that.
 */
function makeSharedKbLlm() {
  const state = { parentCalls: 0, childCalls: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const msgs = body.messages ?? [];
      const isChild = msgs.some((m) => typeof m.content === 'string' && m.content.includes('## 交接单'));
      state.parentCalls += isChild ? 0 : 1;
      state.childCalls += isChild ? 1 : 0;

      let message;
      if (isChild && state.childCalls === 1) {
        message = {
          role: 'assistant',
          content: '先把结论记进知识库。',
          tool_calls: [{
            id: 'call_child_upsert',
            type: 'function',
            function: {
              name: 'kb_upsert',
              arguments: JSON.stringify({
                groupName: 'project/child-only',
                title: CHILD_WRITE_TITLE,
                content: `${CHILD_WRITE_MARKER}：父级的库里不应该出现这一条。`,
                kind: 'fact',
              }),
            },
          }],
        };
      } else if (isChild && state.childCalls === 2) {
        message = {
          role: 'assistant',
          content: '再看看库里的既有知识。',
          tool_calls: [{
            id: 'call_child_query',
            type: 'function',
            function: { name: 'kb_query', arguments: JSON.stringify({ query: KB_SEED_MARKER }) },
          }],
        };
      } else if (isChild) {
        message = { role: 'assistant', content: '结论我写进交付物带回父级。' };
      } else if (state.parentCalls === 1) {
        message = {
          role: 'assistant',
          content: '我把它交出去。',
          tool_calls: [{
            id: 'call_spawn_shared',
            type: 'function',
            function: { name: 'task_spawn', arguments: JSON.stringify({ tasks: [SHARED_TASK] }) },
          }],
        };
      } else {
        message = { role: 'assistant', content: '子任务回来了。' };
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

const SHARED_LLM_PORT = await pickSafePort(18351, [18352, 18353, 19354]);
const SHARED_PORT = await pickSafePort(18271, [18272, 18273, 19306]);

const sharedRoot = tempDir('sharedkbroot');
const ws5 = join(sharedRoot, 'ws');
mkdirSync(ws5, { recursive: true });
git(ws5, ['init']);
git(ws5, ['config', 'user.email', 'she-check@example.invalid']);
git(ws5, ['config', 'user.name', 'she-check']);
writeFileSync(join(ws5, '.gitignore'), '.she/\nappdir/\n', 'utf8');
writeFileSync(join(ws5, 'README.md'), '# 共享库示例\n', 'utf8');
git(ws5, ['add', '-A']);
git(ws5, ['commit', '-m', 'init']);
// git on purpose: the workspace COULD isolate. The child stays shared because the task declares no
// scope — that is the case under test, not "git was unavailable".
check('前提：这个工作区是 git 仓库（共享是任务形态决定的，不是没得选）', isGitRepo(ws5) === true, null);

const sharedKb = join(ws5, '.she', 'kb.sqlite');
mkdirSync(join(ws5, '.she'), { recursive: true });
{
  const store = new KBStore(sharedKb);
  const engine = new GroupKBEngine(store, { ...KB_CFG, dbPath: sharedKb });
  const group = engine.createGroup('project/seed');
  engine.addMemory(group.id, 'fact', KB_SEED_TITLE, `${KB_SEED_MARKER}：父级库里的唯一线索。`);
  store.close();
}
check('前提：父级库里有 1 条记忆', kbCount(sharedKb) === 1, String(kbCount(sharedKb)));

const sharedStub = makeSharedKbLlm();
await new Promise((r) => sharedStub.server.listen(SHARED_LLM_PORT, '127.0.0.1', r));
const sharedChild = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: ws5,
    SHE_PORT: String(SHARED_PORT),
    SHE_APP_DIR: join(ws5, 'appdir'),
    SHE_STATE_DIR: ws5,
    SHE_LLM_PROVIDER: 'openai',
    OPENAI_BASE_URL: `http://127.0.0.1:${SHARED_LLM_PORT}/v1`,
    OPENAI_MODEL: 'stub',
    OPENAI_API_KEY: 'stub-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let sharedOut = '';
sharedChild.stdout.on('data', (c) => { sharedOut += c; });
sharedChild.stderr.on('data', (c) => { sharedOut += c; });
const sharedBase = `http://127.0.0.1:${SHARED_PORT}`;
const sharedApi = (path, init) => fetch(`${sharedBase}${path}`, { signal: AbortSignal.timeout(90_000), ...init });
const sharedStarted = await waitForHealth(sharedBase);

if (!sharedStarted) {
  check('server 起得来（共享知识库的工作区）', false, sharedOut.slice(-500));
} else {
  const chat5 = await sharedApi('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `把「${SHARED_LABEL}」交出去做`, stream: false }),
  });
  const body5 = await chat5.text();
  check('这一轮真的跑成功了（模型是本地 stub，不是超时）',
    chat5.ok && !/max_iterations/.test(body5), `${chat5.status} ${body5.slice(0, 400)}`);

  const sessions5 = await (await sharedApi('/api/sessions?all=1&scope=all')).json();
  const child5 = (sessions5?.sessions ?? []).find((s) => s.title === SHARED_LABEL);
  check('【前提】找得到那个子会话', Boolean(child5),
    JSON.stringify((sessions5?.sessions ?? []).map((s) => s.title)));

  // The parent's database is the thing being protected, so it is read directly rather than through
  // the transcript: a transcript assertion would only prove the tool *said* it did not write.
  const after5 = kbCount(sharedKb);
  check('【关键】父级库里还是只有那 1 条 —— 子任务的 kb_upsert 没有落到父级的库',
    after5 === 1, `父级库现有 ${after5} 条`);

  if (child5) {
    const detail5 = await (await sharedApi(`/api/sessions/${child5.id}`)).json();
    const text5 = JSON.stringify(detail5);
    const brief5 = String((detail5?.messages ?? []).find((m) => m.role === 'user')?.content ?? '');
    check('【关键】交接单说明库是父级库的私有副本（没有隔离副本的子级也有自己的记忆）',
      /父级库的私有副本/.test(brief5), brief5.slice(0, 600));
    check('【关键】写入被接受，落在它自己的副本里 —— 旧行为是直接拒掉，让它没地方放结论',
      /Added memory/.test(text5), text5.slice(0, 900));
    check('【关键】读没有被一起关掉 —— 父级库里的那条记忆仍然查得到',
      new RegExp(KB_SEED_TITLE).test(text5), text5.slice(0, 900));
    check('子任务没有为此拿到隔离副本（共享 checkout 是任务形态，不是隔离失败）',
      !/未隔离/.test(text5), text5.slice(0, 900));
    check('【关键】共享 checkout 的子任务跑完也不留副本（清理与隔离无关）',
      leftoverKbCopies(ws5).length === 0, JSON.stringify(leftoverKbCopies(ws5)));
  }
}

sharedChild.kill();
try { sharedStub.server.close(); } catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 400));

console.log('\n10. 真 server：子任务超时要交代它做到了哪一步');

const TIMEOUT_LABEL = '会把仓库翻一遍的活';
/** A distinct marker per call, so the parent's report can be checked against a call that really happened. */
const TIMEOUT_MARKER = 'SHE_TIMEOUT_PROBE_';

/**
 * A child that never finishes.
 *
 * Drives the one path nothing else can reach. The reply to a timeout is built from a REAL child
 * transcript — its actual last tool call, its own words, its worktree's changed list — and whether
 * that reply is what the parent receives is a property of the server, not of the formatter. A unit
 * test can only prove the formatter formats.
 */
function makeTimeoutLlm() {
  const state = { parentCalls: 0, childCalls: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const msgs = body.messages ?? [];
      const isChild = msgs.some((m) => typeof m.content === 'string' && m.content.includes('## 交接单'));
      state.parentCalls += isChild ? 0 : 1;

      let message;
      if (isChild) {
        state.childCalls++;
        /*
         * A DIFFERENT call every round, deliberately.
         *
         * Repeating one call with one argument is exactly what the loop's stuck-detection exists to
         * catch, and it would end this child early with a real answer — the one outcome that must
         * not happen here, because reaching the timeout is the point.
         *
         * `kb_query` rather than `shell` because a child in a shared checkout is a read-only child,
         * and this keeps the fixture inside what such a child is allowed to do.
         */
        message = {
          role: 'assistant',
          content: `还在查第 ${state.childCalls} 处。`,
          tool_calls: [{
            id: `call_probe_${state.childCalls}`,
            type: 'function',
            function: { name: 'kb_query', arguments: JSON.stringify({ query: `${TIMEOUT_MARKER}${state.childCalls}` }) },
          }],
        };
      } else if (state.parentCalls === 1) {
        message = {
          role: 'assistant',
          content: '这活比看上去重，交给子智能体。',
          tool_calls: [{
            id: 'call_spawn_timeout',
            type: 'function',
            function: {
              name: 'task_spawn',
              arguments: JSON.stringify({
                tasks: [{ description: TIMEOUT_LABEL, prompt: '把整个仓库翻一遍，逐条给我结论。' }],
              }),
            },
          }],
        };
      } else {
        message = { role: 'assistant', content: '子任务回来了，我看下它报了什么。' };
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

const TIMEOUT_LLM_PORT = await pickSafePort(18361, [18362, 18363, 19366]);
const TIMEOUT_PORT = await pickSafePort(18291, [18292, 18293, 19307]);
/** Seconds, not the default 180: the floor of the clamp is 30, and this check runs on every gate. */
const TIMEOUT_ENV_SECONDS = 6;

const timeoutRoot = tempDir('timeoutroot');
const ws6 = join(timeoutRoot, 'ws');
mkdirSync(ws6, { recursive: true });
git(ws6, ['init']);
git(ws6, ['config', 'user.email', 'she-check@example.invalid']);
git(ws6, ['config', 'user.name', 'she-check']);
writeFileSync(join(ws6, '.gitignore'), '.she/\nappdir/\n', 'utf8');
writeFileSync(join(ws6, 'README.md'), '# 超时示例\n', 'utf8');
git(ws6, ['add', '-A']);
git(ws6, ['commit', '-m', 'init']);

const timeoutStub = makeTimeoutLlm();
await new Promise((r) => timeoutStub.server.listen(TIMEOUT_LLM_PORT, '127.0.0.1', r));
const timeoutChild = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: ws6,
    SHE_PORT: String(TIMEOUT_PORT),
    SHE_APP_DIR: join(ws6, 'appdir'),
    SHE_STATE_DIR: ws6,
    SHE_LLM_PROVIDER: 'openai',
    OPENAI_BASE_URL: `http://127.0.0.1:${TIMEOUT_LLM_PORT}/v1`,
    OPENAI_MODEL: 'stub',
    OPENAI_API_KEY: 'stub-key',
    /*
     * The default budget is set from the environment rather than passed as `timeout_ms`, because
     * the per-task parameter is clamped to a 30s floor — correct for the product, and far too slow
     * for a check that runs on every gate. Both paths land on the same code (the resolved budget),
     * so this still exercises the real timeout.
     */
    SHE_SUBAGENT_TIMEOUT_MS: String(TIMEOUT_ENV_SECONDS * 1000),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let timeoutOut = '';
timeoutChild.stdout.on('data', (c) => { timeoutOut += c; });
timeoutChild.stderr.on('data', (c) => { timeoutOut += c; });
const timeoutBase = `http://127.0.0.1:${TIMEOUT_PORT}`;
const timeoutApi = (path, init) => fetch(`${timeoutBase}${path}`, { signal: AbortSignal.timeout(90_000), ...init });
const timeoutStarted = await waitForHealth(timeoutBase);

if (!timeoutStarted) {
  check('server 起得来（超时场景）', false, timeoutOut.slice(-500));
} else {
  const startedAt = Date.now();
  /*
   * Poll the board WHILE the parent waits.
   *
   * This is the whole point of the heartbeat, and it can only be observed during the run: the claim
   * is that someone watching can see progress, not that a card eventually said something. Reading
   * it afterwards would pass even if the tick fired once at the end, or after the child died.
   */
  let live = '';
  const poll = (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const tasks = await (await timeoutApi('/api/tasks')).json();
        const card = (tasks?.tasks ?? []).find((t) => t.label === TIMEOUT_LABEL && t.detail);
        if (card?.detail) { live = card.detail; return; }
      } catch { /* board request can lose a race with startup */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();

  const chatT = await timeoutApi('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `把「${TIMEOUT_LABEL}」交出去做`, stream: false }),
  });
  await poll;
  const elapsed = Date.now() - startedAt;
  const bodyT = await chatT.text();

  check('这一轮跑完了（模型是本地 stub，不是它自己出错）',
    chatT.ok, `${chatT.status} ${bodyT.slice(0, 300)}`);
  check(
    '预算被真的执行了（这一轮只等了 ~6s，不是默认的 180s）',
    elapsed < 45_000,
    `实际等了 ${Math.round(elapsed / 1000)}s`,
  );

  const sessionsT = await (await timeoutApi('/api/sessions?all=1&scope=all')).json();
  const childT = (sessionsT?.sessions ?? []).find((s) => s.title === TIMEOUT_LABEL);
  check('【前提】超时的子任务仍然留下了一个会话（不是查无此人）',
    Boolean(childT), JSON.stringify((sessionsT?.sessions ?? []).map((s) => s.title)));

  /*
   * Read the report where the parent would read it.
   *
   * The reply to `task_spawn` is a tool RESULT, so it lives in the parent's transcript — the HTTP
   * body of `/api/chat` only carries the assistant's final message. Asserting on the body would
   * have tested nothing: the first run of this section "passed" the budget check and failed every
   * content check for exactly that reason.
   */
  let parentText = '';
  for (const s of sessionsT?.sessions ?? []) {
    if (childT && s.id === childT.id) continue;
    const d = await (await timeoutApi(`/api/sessions/${s.id}`)).json();
    parentText += JSON.stringify(d);
  }
  const where = `${parentText}\n${bodyT}`;

  /*
   * Each check below is one thing the parent had none of: what was done, what the child said, that
   * the budget is a parameter, and where the full transcript is.
   */
  check('【关键】超时的回复交代了它做到哪一步，不再是「超时」两个字',
    /预算用尽/.test(where) && /做到哪一步/.test(where), where.slice(0, 900));
  check('【关键】报告引用的是子级真实发生过的调用',
    new RegExp(`${TIMEOUT_MARKER}\\d+`).test(where), where.slice(0, 900));
  check('报告带上它自己说的话（判断它理解到哪了的唯一线索）',
    /它最后说的是/.test(where), where.slice(0, 900));
  check('给出了加大预算这条路（timeout_ms），否则父级只能再赌一次同样的预算',
    /timeout_ms/.test(where), where.slice(0, 900));
  check('给出了不再阻塞本轮这条路（background）',
    /background/.test(where), where.slice(0, 900));
  check('子会话 id 在报告里 —— 完整过程是可以打开看的',
    /子会话\s*sess_[0-9a-f]{6,}/i.test(where), where.slice(0, 900));

  check('【关键】运行中就能看到它在干什么（心跳到了 UI 的卡片上）',
    /已 \d+s/.test(live), `卡片 detail 读到的是「${live}」`);

  if (childT) {
    const detailT = await (await timeoutApi(`/api/sessions/${childT.id}`)).json();
    const briefT = String((detailT?.messages ?? []).find((m) => m.role === 'user')?.content ?? '');
    check('【关键】交接单里写了时间预算 —— 子级不是被中止那一刻才知道有时间限制',
      /时间预算/.test(briefT) && new RegExp(`${TIMEOUT_ENV_SECONDS} 秒`).test(briefT), briefT.slice(0, 700));
    check('交接单要求「做不完就提前交半成品」，而不是含糊的「抓紧点」',
      /提前/.test(briefT), briefT.slice(0, 700));
  }
}

timeoutChild.kill();
try { timeoutStub.server.close(); } catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 400));

cleanup();

console.log('');
if (failures) {
  console.log(`${failures} 项失败`);
  process.exit(1);
}
console.log('子任务隔离检查通过');
void rmSync;
