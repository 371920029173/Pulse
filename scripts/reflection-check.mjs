/**
 * 自省增强：漂移检测、置信度镜像、反思入错题本、独立批评者 —— 全部离线，不调模型。
 *
 * 这四样都是在测「agent 自己」，所以它们的错误方向很特别：错了不会有任何别的检查发现，只会让 agent
 * （和用户）从此不再相信它们。因此这里断言的重点是**它们该在什么时候闭嘴**，以及**证据从哪里来**：
 *
 *   1. **漂移检测只在有证据时开口。** 依据是「动作文本里有没有目标/约束里的词」，所以：
 *      连续多个动作与目标零重合才提醒，硬约束里的对象真的出现在动作里才是漂移，软约束只是提醒。
 *      宁可误报（代价是看一眼目标），不可漏报（代价是整个任务跑偏）。
 *   2. **镜像的样本不能被自己造出来。** 自评来自预检记录，实际成功率来自本轮工具调用的成败计数；
 *      没有自评的轮次不产生样本，没有工具调用的轮次不进实际成功率——否则「什么都没做」会被读成
 *      「说对了」，把偏差洗掉。
 *   3. **反思写的是教训，而且写进错题本之后还读得回来。** 走的是工具失败那套 upsert（子组、
 *      重复计数、共现边），所以同一主题复发是加计数而不是又一条。写进去必须能被
 *      `errorbook_lookup` 查到——查不到的记录等于没记。
 *   4. **批评者和作者用的不是同一份信息。** 作者说的是它记得的，批评者看的是轨迹里记着的：
 *      有矛盾（说某工具成功、轨迹里它最后一次失败）才判不通过；没点名工具也没引用输出的说法
 *      只报「无法核对」，不进结论，否则批评者会变成人人都跳过的噪音。
 *
 * 另外跑真的 server：`/api/reflection` 要能在**没有任何一轮跑过**的新进程里读到盘上的镜像历史
 * （习惯是跨会话的），重置要留审计记录，其余写入要被拒。
 *
 *   node scripts/reflection-check.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const AGENT_DIR = join(ROOT, 'packages', 'agent-runtime');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const REFLECT_MODULE = join(AGENT_DIR, 'dist', 'reflection.js');

if (!existsSync(SERVER_ENTRY) || !existsSync(REFLECT_MODULE)) {
  console.error(`找不到 ${SERVER_ENTRY} 或 ${REFLECT_MODULE}\n请先 pnpm -r build`);
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

const {
  ConfidenceMirror,
  detectDrift,
  deriveReflections,
  createReflectionTools,
  renderCalibration,
  renderDrift,
  goalTerms,
  prohibitionObject,
  REFLECTION_DIR,
} = await import(pathToFileURL(REFLECT_MODULE).href);
const { ErrorBook, ERRORBOOK_ROOT, formatErrorEntry } = await import(
  pathToFileURL(join(AGENT_DIR, 'dist', 'errorbook.js')).href
);
const { reviewClaims, renderCriticReview, extractClaims } = await import(
  pathToFileURL(join(AGENT_DIR, 'dist', 'critic.js')).href
);
const { loadConfig } = await import(pathToFileURL(join(ROOT, 'packages', 'shared', 'dist', 'index.js')).href);
const { KBStore, GroupKBEngine } = await import(
  pathToFileURL(join(ROOT, 'packages', 'kb', 'dist', 'index.js')).href
);

const tempDir = (p) => mkdtempSync(join(tmpdir(), p));
const confFile = (root) => join(root, REFLECTION_DIR, 'confidence.json');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 漂移检测：什么时候开口
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n1. 漂移检测只在有证据时开口');
{
  const onTask = detectDrift({
    goal: '把登录超时的问题修好并补回归测试',
    actions: [
      { tool: 'grep', args: '登录超时' },
      { tool: 'fs_read', args: 'packages/auth/session.ts' },
      { tool: 'shell', args: 'pnpm test auth' },
    ],
  });
  check('动作一直带着目标里的词 → 无漂移', onTask.level === 'none', JSON.stringify(onTask));
  check('无漂移时渲染成空串（提示词里不塞空话）', renderDrift(onTask) === '', renderDrift(onTask));

  const three = detectDrift({
    goal: '把登录超时的问题修好',
    actions: [
      { tool: 'shell', args: 'git log --oneline' },
      { tool: 'shell', args: 'du -sh node_modules' },
      { tool: 'shell', args: 'npm outdated' },
    ],
  });
  check('连续三个动作与目标零重合 → 提醒，不要求重写计划',
    three.level === 'watch' && three.replan === false, JSON.stringify(three.signals));

  const five = detectDrift({
    goal: '把登录超时的问题修好',
    actions: [
      { tool: 'shell', args: 'git log' },
      { tool: 'shell', args: 'du -sh .' },
      { tool: 'shell', args: 'npm outdated' },
      { tool: 'shell', args: 'ls -la' },
      { tool: 'shell', args: 'df -h' },
    ],
  });
  check('五个动作都无关 → 升级为漂移并要求重写计划',
    five.level === 'drift' && five.replan === true, JSON.stringify(five.signals));
  check('漂移的建议里包含「重读实际目标」',
    /实际目标/.test(renderDrift(five)), renderDrift(five));

  const two = detectDrift({
    goal: '把登录超时的问题修好',
    actions: [{ tool: 'shell', args: 'git log' }, { tool: 'shell', args: 'ls' }],
  });
  check('动作太少不猜方向', two.level === 'none', JSON.stringify(two));

  check('没有目标不报（没有基准可比）',
    detectDrift({ goal: '', actions: [{ tool: 'a' }, { tool: 'b' }, { tool: 'c' }] }).level === 'none', null);
}

console.log('\n2. 约束：硬的是漂移，软的是提醒');
{
  const hard = detectDrift({
    goal: '修好构建',
    constraints: [{ text: '不要修改 packages/migrations 下的任何文件', hardness: 'hard' }],
    actions: [{ tool: 'fs_write', args: 'packages/migrations/003_add.sql' }],
  });
  const signal = hard.signals.find((s) => s.kind === 'constraint_violated');
  check('硬约束里的对象出现在动作里 → 直接漂移',
    hard.level === 'drift' && hard.replan === true && signal?.major === true, JSON.stringify(hard.signals));
  check('点名了是哪个对象越界（不是笼统说"违反了约束"）',
    /migrations/.test(signal?.detail ?? ''), signal?.detail);
  check('越界的建议是先问用户，不是自己决定',
    /先问用户/.test(hard.advice ?? ''), hard.advice);

  const soft = detectDrift({
    goal: '修好构建',
    constraints: [{ text: '尽量别动 cluster.ts', hardness: 'soft' }],
    actions: [{ tool: 'fs_write', args: 'cluster.ts' }],
  });
  check('软约束越界只是提醒（偏好不是规则）',
    soft.level === 'watch' && soft.replan === false, JSON.stringify(soft.signals));

  const vague = detectDrift({
    goal: '修好构建',
    constraints: ['不要拖太久', '保持代码整洁'],
    actions: [{ tool: 'fs_write', args: 'a.ts' }],
  });
  check('模糊偏好不会在正常动作上误报', vague.level === 'none', JSON.stringify(vague.signals));

  const notProhibition = detectDrift({
    goal: '修好构建',
    constraints: ['配置文件必须是 JSON'],
    actions: [{ tool: 'fs_write', args: 'config.ts' }],
  });
  check('不是禁令的约束不查（描述性约束由测试和诊断去发现问题）',
    notProhibition.level === 'none', JSON.stringify(notProhibition.signals));

  /*
   * 只读「目标」，不读正文 —— 用实测里真正触发过误报的四次调用当输入。
   *
   * 约束是 `shell 为 Windows cmd：无 cat/which；避免外泄重定向`，被排除的对象提成 `cat/which`，
   * 于是「写下这条约束的 preflight」「把约束转述给子级的 task_spawn」「在备注里讨论它的 plan_update」
   * 「正文解释它、路径无辜的 fs_write」全都命中了。四条都不是在碰它，判据因此改为只读目标字段。
   */
  const constraintText = 'shell 为 Windows cmd：无 cat/which；避免外泄重定向（/dev/null 曾 DENIED）';
  const judge = (tool, args) => detectDrift({
    goal: '给两个文件里的导出符号做一份清单',
    constraints: [{ text: constraintText, hardness: 'hard' }],
    actions: [{ tool, args }],
  }).level;
  check('【实测误报】写下这条约束的 preflight_record 不算越界',
    judge('preflight_record', JSON.stringify({ actual_goal: '评估', inferred_constraints: [constraintText] })) === 'none', null);
  check('【实测误报】把约束转述给子级的 task_spawn 不算越界',
    judge('task_spawn', JSON.stringify({ tasks: [{ description: '核对', prompt: '无 cat/which', deliverable: '清单' }] })) === 'none', null);
  check('【实测误报】plan_update 的备注在讨论它，不算越界',
    judge('plan_update', JSON.stringify({ plan_id: 'p', step_id: 's9', status: 'done', note: 'cat/which 告警判定为误报' })) === 'none', null);
  check('【实测误报】正文解释它、路径无辜的 fs_write 不算越界',
    judge('fs_write', JSON.stringify({ path: 'qa/eng/notes.md', content: '该沙箱无 cat / which，请用 type / where。' })) === 'none', null);
  check('但 path 就是那个对象时照旧越界（正文豁免不能变成整体豁免）',
    judge('fs_write', JSON.stringify({ path: 'cat/which', content: '随便' })) === 'drift', null);
  check('shell 的命令行照旧查（命令本身就是动作，没有「正文」这层）',
    judge('shell', JSON.stringify({ command: 'del /f cat/which' })) === 'drift', null);
  check('嵌套交接单里的 scope 不豁免（声明要改什么仍然是行动）',
    judge('task_spawn', JSON.stringify({ tasks: [{ description: '改文件', scope: ['cat/which'], prompt: '随便' }] })) === 'drift', null);

  check('禁止句里取的是最长的那两个具体对象',
    JSON.stringify(prohibitionObject('不要修改 packages/server 里的 cluster.ts')) ===
      JSON.stringify(['packages/server', 'cluster.ts']),
    JSON.stringify(prohibitionObject('不要修改 packages/server 里的 cluster.ts')));
  check('反引号里的对象按原样取', prohibitionObject('不要碰 `session-store.ts`')[0] === 'session-store.ts', null);

  const terms = goalTerms('不要修改 packages/server 里的 cluster.ts');
  check('结构词不进目标词（否则「里的」会匹配一切）', !terms.includes('里的'), terms.join(','));
  check('中文按二元组切，短目标也能和别的句子重合',
    goalTerms('修复登录超时').includes('登录') && goalTerms('修复登录超时').includes('超时'), null);

  /*
   * 约束里的「例外」不是被禁止的对象 —— 用实测里真正触发过误报的那条约束当输入。
   *
   * 原文把 kb_upsert 称作「唯一被点名的写入…（用户明确指定的例外）」，旧实现把整句当禁止句读，
   * 于是父级那次合规的 kb_upsert 被判成「越过约束」：major、直接进错题本，还会在以后动手前被
   * 当成教训读回来。越是把例外写清楚的约束，越稳定地误报——所以例外必须排除在取值之外。
   */
  const exceptionText = '「只读」限定在文件/命令层面：子代理不得用 `shell`、`fs_*`、`git` 等工具，'
    + '不得修改工作区；唯一被点名的写入是 `kb_upsert` 写知识库（用户明确指定的例外）。';
  check('【实测误报】约束里被点名允许的对象不进禁止集',
    !prohibitionObject(exceptionText).includes('kb_upsert'), JSON.stringify(prohibitionObject(exceptionText)));
  check('【实测误报】那条约束下，合规的 kb_upsert 不算越界',
    detectDrift({
      goal: '验证子代理的知识库笔记能否被父级收割',
      constraints: [{ text: exceptionText, hardness: 'hard' }],
      actions: [{ tool: 'kb_upsert', args: '{"group":"project/x","title":"t","content":"c"}' }],
    }).level === 'none', null);
  check('例外只免它自己那一句：同句里别的禁止照旧生效（不能变成整体豁免）',
    detectDrift({
      goal: '整理导出',
      constraints: ['不要改 cluster.ts，唯一允许的是只读查询——但不要动 migrations。'],
      actions: [{ tool: 'fs_write', args: '{"path":"packages/kb/migrations/001.sql"}' }],
    }).level === 'drift', null);
  check('「不得改动 a.ts、b.ts」是一个禁止句里列了两个对象，顿号不切开它',
    prohibitionObject('不要改动 a.ts、b.ts').includes('b.ts'),
    JSON.stringify(prohibitionObject('不要改动 a.ts、b.ts')));
}

console.log('\n3. 预算与步骤');
{
  const over = detectDrift({ goal: 'x', stepsUsed: 9, stepBudget: 5 });
  check('超预算算提醒', over.level === 'watch' && /收尾/.test(over.advice ?? ''), over.advice);

  const offStep = detectDrift({ goal: '修好登录超时', currentStep: '跑离线门禁并提交' });
  check('当前步骤不含目标词只算提醒（「跑测试」本身是合理步骤）',
    offStep.level === 'watch' && offStep.replan === false, JSON.stringify(offStep.signals));
}

console.log('\n4. 自省工具：只读，且说得出检查了什么');
{
  const tools = createReflectionTools({
    goal: () => '把登录超时修好',
    constraints: () => [{ text: '不要改 packages/migrations', hardness: 'soft' }],
    actions: () => [{ tool: 'shell', args: 'git log' }, { tool: 'shell', args: 'ls' }, { tool: 'shell', args: 'df -h' }],
    currentStep: () => null,
    budget: () => ({ used: 3, limit: 10 }),
    calibration: () => ({ samples: 0, meanClaimed: 0, actualRate: 0, bias: 0, bucket: 'unknown', clampRate: 0, worst: [], advice: null }),
  });
  check('注册了一个 reflection_check 工具',
    tools.definitions.length === 1 && tools.definitions[0].name === 'reflection_check',
    tools.definitions.map((d) => d.name).join(','));
  const withoutGoal = await createReflectionTools({
    goal: () => null,
    constraints: () => [],
    actions: () => [],
    currentStep: () => null,
    budget: () => ({ used: 0 }),
    calibration: () => ({ samples: 0, meanClaimed: 0, actualRate: 0, bias: 0, bucket: 'unknown', clampRate: 0, worst: [], advice: null }),
  }).execute('reflection_check', {});
  check('没有目标时明说「先去写预检」，而不是假装检查过',
    /preflight_record/.test(withoutGoal), withoutGoal.slice(0, 160));

  const text = await tools.execute('reflection_check', {});
  check('报告里写清了目标、检查了几个动作和结论',
    /目标：/.test(text) && /检查了 3 个动作/.test(text) && /漂移检查/.test(text), text.slice(0, 240));
  check('要么说「无漂移」，要么给出一条建议——不留半句话',
    /漂移检查：无漂移/.test(text) || /建议：/.test(text), text.slice(0, 240));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 置信度镜像：样本从哪来，什么时候下结论
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n5. 置信度镜像');
{
  const root = tempDir('she-reflect-conf-');
  const observe = (m, claimed, attempted, succeeded, clamped = false, topic) =>
    m.observe({ claimed, attempted, succeeded, clamped, topic });

  const m = new ConfidenceMirror(root);
  check('一开始文件不存在也能读（当成空历史）', m.samples().length === 0, null);
  observe(m, 0.9, 4, 1);
  observe(m, 0.9, 4, 1);
  check('样本不足三个不下结论', m.report().bucket === 'unknown', JSON.stringify(m.report()));
  check('结论不足时不往提示词里写',
    renderCalibration(m.report()) === '', renderCalibration(m.report()));
  observe(m, 0.9, 4, 2);
  check('三个样本之后给出偏乐观的结论', m.report().bucket === 'overconfident', JSON.stringify(m.report()));
  check('建议说清了「置信度要由已核对的事实推出」',
    /已核对的事实/.test(m.report().advice ?? ''), m.report().advice);

  check('落盘了，且是 JSON', existsSync(confFile(root)) && JSON.parse(readFileSync(confFile(root), 'utf8')).samples.length === 3, null);
  const reopened = new ConfidenceMirror(root);
  check('换一个实例还能读到（习惯要跨会话才看得见）',
    reopened.samples().length === 3 && reopened.report().bucket === 'overconfident', null);

  const noTools = new ConfidenceMirror(tempDir('she-reflect-notools-'));
  observe(noTools, 0.4, 4, 1);
  observe(noTools, 0.4, 4, 1);
  observe(noTools, 0.4, 4, 1);
  const before = noTools.report().actualRate;
  observe(noTools, 0.95, 0, 0);
  check('没有工具调用的轮次不进实际成功率', noTools.report().actualRate === before, String(noTools.report().actualRate));
  check('但它的自评仍进均值（否则少做事的轮次会被当成"说对了"）',
    noTools.report().bias > 0.25, JSON.stringify(noTools.report()));

  const miscount = noTools.observe({ claimed: 0.5, attempted: 2, succeeded: 9 });
  check('成功数被夹在尝试数以内（调用方数错也造不出 >1 的成功率）',
    miscount.succeeded === 2 && miscount.attempted === 2, JSON.stringify(miscount));

  const honest = new ConfidenceMirror(tempDir('she-reflect-ok-'));
  for (let i = 0; i < 3; i++) observe(honest, 0.75, 4, 3);
  check('对得上就是 calibrated，不硬找问题',
    honest.report().bucket === 'calibrated' && renderCalibration(honest.report()) === '', null);

  const shy = new ConfidenceMirror(tempDir('she-reflect-shy-'));
  for (let i = 0; i < 3; i++) observe(shy, 0.3, 4, 4);
  check('自评低于实际成功率也是偏差（偏保守）',
    shy.report().bucket === 'underconfident' && /偏保守/.test(renderCalibration(shy.report())), null);

  const windowed = new ConfidenceMirror(tempDir('she-reflect-window-'));
  for (let i = 0; i < 6; i++) observe(windowed, 0.2, 4, 4);
  for (let i = 0; i < 3; i++) observe(windowed, 0.95, 4, 1);
  check('窗口决定报告哪一段习惯（旧数据会盖住当前习惯）',
    windowed.report({ window: 3 }).bucket === 'overconfident' && windowed.report().bucket === 'underconfident',
    JSON.stringify([windowed.report({ window: 3 }).bucket, windowed.report().bucket]));

  const bounded = new ConfidenceMirror(tempDir('she-reflect-bound-'), 3);
  for (let i = 0; i < 5; i++) observe(bounded, 0.5, 2, 1);
  check('只保留最近 N 条', bounded.samples().length === 3, String(bounded.samples().length));

  const clamped = new ConfidenceMirror(tempDir('she-reflect-clamp-'));
  for (let i = 0; i < 4; i++) observe(clamped, 0.9, 4, 2, true);
  check('预检被压过上限的比例也算进建议', /压到上限/.test(renderCalibration(clamped.report())), renderCalibration(clamped.report()));

  const damagedRoot = tempDir('she-reflect-damaged-');
  mkdirSync(join(damagedRoot, REFLECTION_DIR), { recursive: true });
  writeFileSync(confFile(damagedRoot), '{ 这不是 JSON', 'utf8');
  const damaged = new ConfidenceMirror(damagedRoot);
  check('文件损坏时当成空历史，不抛异常',
    damaged.samples().length === 0 && damaged.report().bucket === 'unknown', null);

  const cleared = new ConfidenceMirror(tempDir('she-reflect-clear-'));
  observe(cleared, 0.9, 4, 2);
  cleared.clear();
  check('清空之后内存和文件都空', cleared.samples().length === 0, String(cleared.samples().length));

  removeTempDir(root);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 反思写进错题本，并且能读回来（真 KB）
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n6. 反思 → 错题本（真 KB）');
const kbDir = tempDir('she-reflect-kb-');
mkdirSync(join(kbDir, '.she'), { recursive: true });
{
  const cfg = loadConfig(ROOT);
  cfg.workspace.root = kbDir;
  const store = new KBStore(join(kbDir, 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(kbDir, 'kb.sqlite') });
  const book = new ErrorBook(engine, store);

  const notes = deriveReflections({
    goal: '把登录超时修好',
    drift: {
      level: 'drift',
      score: 1,
      replan: true,
      advice: 'a',
      signals: [
        { kind: 'constraint_violated', major: true, weight: 0.8, detail: '约束「不要改 x」排除的对象「x」出现在了动作里' },
        { kind: 'goal_unrelated', major: true, weight: 0.7, detail: '最近 5 个动作没有提到目标里的任何词' },
      ],
    },
    calibration: { samples: 6, meanClaimed: 0.9, actualRate: 0.5, bias: 0.4, bucket: 'overconfident', clampRate: 0.5, worst: [], advice: 'a' },
    failures: [
      { tool: 'shell', kind: 'nonzero_exit', detail: 'exit 1' },
      { tool: 'shell', kind: 'nonzero_exit', detail: 'exit 1' },
    ],
    runFailed: true,
    runReason: 'max_iterations',
  });
  check('一轮最多三条反思（多的会把自己埋掉）', notes.length === 3, notes.map((n) => n.topic).join(','));
  check('严重度排序：越过约束 > 目标漂移 > 循环失控',
    notes.map((n) => n.topic).join(',') === '越过约束,目标漂移,循环失控', notes.map((n) => n.topic).join(','));

  const clean = deriveReflections({
    goal: 'x',
    drift: { level: 'none', score: 0, replan: false, advice: null, signals: [] },
    calibration: { samples: 0, meanClaimed: 0, actualRate: 0, bias: 0, bucket: 'unknown', clampRate: 0, worst: [], advice: null },
    failures: [],
    runFailed: false,
  });
  check('清白的一轮什么都不写（错题本不是日志）', clean.length === 0, JSON.stringify(clean));

  for (const n of notes) book.recordReflection({ ...n, sessionId: 'sess-r' });
  const root = store.getAllGroups().find((g) => g.name === ERRORBOOK_ROOT && !g.parentGroupId);
  const groups = store.getAllGroups().filter((g) => g.parentGroupId === root?.id).map((g) => g.name);
  check('反思写在 errors/自省 一个组里（要按「我最近老犯什么错」成组读）',
    groups.includes('自省'), groups.join(','));
  check('工具失败和反思分得开（工具组不掺反思）',
    !groups.includes('过度自信') && !groups.includes('目标漂移'), groups.join(','));

  const rows = book.lookup({ limit: 10 });
  check('写进去的三条都读得回来', rows.length === 3, String(rows.length));
  const drift = book.lookup({ tool: '目标漂移' });
  check('按主题查得到（查不到的记录等于没记）', drift.length === 1, JSON.stringify(drift));
  check('条目里主题是主题、教训是教训、依据是依据',
    drift[0].tool === '目标漂移' && /实际目标/.test(drift[0].detail) && drift[0].kind === 'reflection',
    JSON.stringify(drift[0]));
  check('一行渲染格式统一（提示词里直接可用）',
    /^- 目标漂移 · reflection：/.test(formatErrorEntry(drift[0])), formatErrorEntry(drift[0]));

  book.recordReflection(notes[1]);
  const again = book.lookup({ tool: '目标漂移' });
  check('同一个主题再犯是加计数，不是又一条',
    again.length === 1 && again[0].count === 2, JSON.stringify(again.map((r) => [r.tool, r.count])));

  const stored = store.getMemoriesByGroup(
    store.getAllGroups().find((g) => g.name === ERRORBOOK_ROOT && !g.parentGroupId)
      ? store.getAllGroups().find((g) => g.parentGroupId === root.id && g.name === '自省').id
      : '',
  );
  check('写进 KB 的正文是「教训 / 依据」，不是「原始输出」这类工具措辞',
    stored.some((m) => /教训：/.test(m.content) && /依据：/.test(m.content) && !/原始输出/.test(m.content)),
    stored.map((m) => m.content.split('\n')[0]).join(' | '));
  check('元数据带 reflection 签名（重复计数靠它）',
    stored.every((m) => !m.metadata?.errorSignature || String(m.metadata.errorSignature).startsWith('reflection|')),
    JSON.stringify(stored.map((m) => m.metadata?.errorSignature)));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 独立批评者：说法 vs 轨迹
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n7. 独立批评者');
{
  const ev = (over) => ({ seq: 1, ts: '2026-01-01T00:00:00.000Z', kind: 'tool', ...over });
  const okShell = ev({ seq: 1, tool: 'shell', args: '{"command":"pnpm check:offline"}', result: 'exit code: 0\n全部检查脚本通过', ok: true });
  const failShell = ev({ seq: 2, tool: 'shell', args: '{"command":"pnpm check:offline"}', result: 'exit code: 1\nFAIL', ok: false, failure: 'nonzero_exit' });

  const contradiction = reviewClaims({ claims: ['shell 里 pnpm check:offline 已通过'], trace: [okShell, failShell] });
  check('说某工具成功、轨迹里它最后一次失败 → 不通过',
    contradiction.verdict === 'fail' && contradiction.findings[0].status === 'contradicted',
    JSON.stringify(contradiction.findings));
  check('矛盾条目带上失败的分类（不是只说"有矛盾"）',
    /nonzero_exit/.test(contradiction.findings[0].detail), contradiction.findings[0].detail);

  const recovered = reviewClaims({ claims: ['shell 里 check:offline 已通过'], trace: [failShell, { ...okShell, seq: 3 }] });
  check('工具后来成功了就不算矛盾（最后一次才是结论）', recovered.verdict === 'pass', JSON.stringify(recovered.findings));

  const invented = reviewClaims({ claims: ['已经用 grep 找全了调用点'], trace: [okShell], availableTools: ['shell', 'grep'] });
  check('点名了工具但轨迹里没有它的调用 → 无依据',
    invented.verdict === 'concerns' && invented.findings[0].status === 'unbacked', JSON.stringify(invented.findings));

  const backed = reviewClaims({ claims: ['已经跑过 check:offline 这个脚本'], trace: [okShell] });
  check('引用的内容在轨迹里找得到 → 有依据',
    backed.findings[0].status === 'backed', JSON.stringify(backed.findings));

  const wrongQuote = reviewClaims({ claims: ['已经按 design-notes-v3.md 的约定改完了'], trace: [okShell] });
  check('引用对不上 → 无依据（保留意见，不判失败：转述是合法的）',
    wrongQuote.verdict === 'concerns' && wrongQuote.findings[0].status === 'unbacked', JSON.stringify(wrongQuote.findings));

  const prose = reviewClaims({ claims: ['整体逻辑已经理顺了，应该没问题。'], trace: [okShell] });
  check('中文散文不算「引用的依据」（中文没有词边界，长串是常态）',
    prose.findings[0].status === 'unverifiable' && prose.verdict === 'pass', JSON.stringify(prose.findings));

  const toolName = reviewClaims({ claims: ['fs_read 已经读到了配置文件'], trace: [ev({ seq: 1, tool: 'fs_read', result: '{"content":"..."}', ok: true })], availableTools: ['fs_read'] });
  check('工具名本身不算依据（否则点名工具的说法必然失败）',
    toolName.findings[0].status === 'unverifiable' && toolName.verdict === 'pass', JSON.stringify(toolName.findings));

  check('说不出所以然的说法不进结论，但分母写清楚',
    prose.checked === 0 && /不计入结论/.test(prose.summary), prose.summary);
  check('没有问题时不写「全部通过」（写了就会被跳过）',
    renderCriticReview(backed) === '', renderCriticReview(backed));
  check('有矛盾时输出可执行条目', /不通过/.test(renderCriticReview(contradiction)), renderCriticReview(contradiction));

  const claims = extractClaims('我先看 session.ts。\n- 已跑通 pnpm check:offline。\n下一步补测试。');
  check('只挑出「声称做完了」的句子', claims.length === 1 && /已跑通/.test(claims[0]), JSON.stringify(claims));

  check('空轨迹不会「通过」得理直气壮',
    reviewClaims({ claims: ['已经修好了'], trace: [] }).findings[0].status === 'unverifiable', null);
  check('非工具事件不参与（step/end 不是调用）',
    reviewClaims({ claims: ['shell 已经跑完'], trace: [ev({ seq: 1, kind: 'end', ok: true })] }).toolRuns === 0, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 真的 server：镜像的历史要能在新进程里读到
 * ══════════════════════════════════════════════════════════════════════════ */

const PORT = String(await pickSafePort(Number(process.env.SHE_REFLECT_TEST_PORT || 18261), [18262, 18263, 18264, 19291]));
const workspace = tempDir('she-reflect-live-');

/*
 * 先写历史，再起服务。这样断言的就是「镜像跨进程可读」——而重启恰好是 agent 最想当自己没犯过错的时候。
 */
{
  const seeded = new ConfidenceMirror(workspace);
  for (let i = 0; i < 4; i++) seeded.observe({ claimed: 0.95, attempted: 4, succeeded: 1, clamped: true, topic: '迁移脚本' });
  check('起服务之前盘上就有历史', JSON.parse(readFileSync(confFile(workspace), 'utf8')).samples.length === 4, null);
}

const child = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: workspace,
    SHE_PORT: PORT,
    SHE_APP_DIR: join(workspace, 'appdir'),
    SHE_STATE_DIR: workspace,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverOut = '';
child.stdout.on('data', (c) => { serverOut += c; });
child.stderr.on('data', (c) => { serverOut += c; });

async function waitForHealth(timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const api = (path, init) => fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(8000), ...init });
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

function cleanup() {
  try { child.kill(); } catch { /* already gone */ }
  removeTempDir(workspace);
}

console.log('\n8. /api/reflection：新进程里也能读到盘上的历史');
if (!(await waitForHealth())) {
  console.log('  FAIL  服务在 30 秒内就绪');
  console.log(`        ${serverOut.slice(-800)}`);
  cleanup();
  console.log('\nFAIL (1)  reflection-check');
  process.exit(1);
}

try {
  const res = await api('/api/reflection');
  check('GET /api/reflection 返回 200', res.status === 200, `status=${res.status}`);
  const body = await res.json();
  check('没有任何一轮跑过时，读的是盘上的镜像历史',
    body.confidence?.samples === 4 && body.confidence?.bucket === 'overconfident',
    JSON.stringify(body.confidence));
  check('带上目录，界面不用猜',
    typeof body.root === 'string' && body.root.includes('.she'), body.root);
  check('带上最近样本（界面要能显示具体数字）',
    Array.isArray(body.samples) && body.samples.length === 4, JSON.stringify(body.samples?.length));
  check('样本里带领域，便于按领域看偏差',
    body.samples.every((s) => s.topic === '迁移脚本'), JSON.stringify(body.samples?.[0]));
  check('本轮还没有 agent 时 last/critic 是 null，不是伪造对象',
    body.last === null && body.critic === null, JSON.stringify({ last: body.last, critic: body.critic }));

  check('?window= 能收窄窗口',
    (await (await api('/api/reflection?window=2')).json()).confidence.samples === 2, null);

  const reset = await post('/api/reflection/confidence/reset');
  check('POST /api/reflection/confidence/reset 清空历史', reset.status === 200, `status=${reset.status}`);
  check('清空后读回来是空的',
    (await (await api('/api/reflection')).json()).confidence.samples === 0, null);

  const audit = await (await api('/api/audit?kind=config')).json();
  check('重置留了审计记录（它会改变 agent 之后拿到的自我认知）',
    audit.records.length >= 1 && audit.records[0].change === 'reset_confidence_mirror',
    JSON.stringify(audit.records.slice(0, 1)));
  check('审计接口认识 config 这个 kind（拼错会 400）',
    (await api('/api/audit?kind=configs')).status === 400, null);

  const writes = await Promise.all([
    post('/api/reflection', {}),
    api('/api/reflection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    api('/api/reflection', { method: 'DELETE' }),
    api('/api/reflection/confidence', { method: 'DELETE' }),
  ]);
  check('除了重置之外没有别的写入接口（镜像是测量，不是用户的资料）',
    writes.every((r) => r.status === 404 || r.status === 405), writes.map((r) => r.status).join(', '));
} catch (err) {
  check('自省端点可用', false, err.message);
}

cleanup();

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 接线：跑一轮才触发的地方，只能结构上断言
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n9. 接线与提示词');
{
  const agentSrc = readFileSync(join(AGENT_DIR, 'src', 'agent.ts'), 'utf8');
  const serverSrc = readFileSync(join(SERVER_DIR, 'src', 'index.ts'), 'utf8');
  const promptSrc = readFileSync(join(AGENT_DIR, 'src', 'system-prompt.ts'), 'utf8');
  const clusterSrc = readFileSync(join(SERVER_DIR, 'src', 'cluster.ts'), 'utf8');

  check('一轮结束时做自省，且在释放 recorder 之前（镜像要读它的工具计数）',
    /private finishRun[\s\S]{0,600}?this\.reflectOnRun\(\)[\s\S]{0,900}?recorder\.end\(/.test(agentSrc), null);
  check('自评来自预检记录，不是模型自己另报一个数',
    /runPreflightConfidence[\s\S]{0,400}?rec\.confidence/.test(agentSrc), null);
  check('没有自评的轮次不产生样本（不拿上限或默认值凑）',
    /if \(claim\) \{[\s\S]{0,200}?confidenceMirror\.observe\(/.test(agentSrc), null);
  check('实际成功率来自本轮的调用计数',
    /toolTally\(\)/.test(agentSrc), null);
  check('反思写入失败不会拖垮这一轮',
    /private reflectOnRun\(\)[\s\S]{0,3000}?catch \(err\)/.test(agentSrc), null);
  check('漂移检查用的是真实执行过的动作（不是模型复述）',
    /currentRunActions[\s\S]{0,400}?this\.runEvents/.test(agentSrc), null);
  check('批评者在产出答案的地方跑（定时任务和子智能体也躲不掉）',
    /runExclusive\(messages, onChunk\)[\s\S]{0,1600}?this\.critiqueAnswer\(/.test(agentSrc), null);
  check('只有「矛盾」会主动提示用户，别的只进 API（避免刷屏）',
    /review\.verdict === 'fail'[\s\S]{0,200}?toolEventSink/.test(agentSrc), null);
  check('reflection_check 对子智能体关闭（它读的是父级的目标，会让子任务以为自己在漂移）',
    /\|preflight_\|reflection_/.test(agentSrc), null);

  check('置信度镜像是逐轮算一次的（每轮都变会让提示词缓存失效）',
    /private beginRun[\s\S]{0,5000}?this\.calibrationBlock = this\.buildCalibrationBlock\(\)/.test(agentSrc), null);
  check('同一个系统消息给到每一次迭代（前缀缓存靠这个）',
    /messagesForRequest[\s\S]{0,600}?this\.calibrationBlock/.test(agentSrc), null);
  check('提示词里带上镜像读数', /renderCalibration/.test(agentSrc), null);
  check('提示词里有自省段，且说明是「关于你自己」的测量',
    /## Self-Review/.test(promptSrc) && /measurement of you, not of the work/.test(promptSrc), null);
  check('工具清单里有 reflection_check 与 errorbook_lookup',
    /reflection_check/.test(promptSrc) && /errorbook_lookup/.test(promptSrc), null);
  check('提示词里写明点名工具的说法会被轨迹核对',
    /checked against the run trace/.test(promptSrc), null);

  check('server 提供 /api/reflection', /router\.get\('\/api\/reflection'/.test(serverSrc), null);
  check('镜像跟着工作区走（换项目不会串历史）',
    /function reflectionMirror[\s\S]{0,500}?config\.workspace\.root/.test(serverSrc), null);
  check('镜像在服务里是缓存的（面板轮询不会每次重读文件）',
    /let reflectionMirrors[\s\S]{0,300}?reflectionMirrorsRoot !== root/.test(serverSrc), null);

  check('工作群里多了一个「批评者」角色，和产出者分开',
    /key: 'critic'/.test(clusterSrc) && /phase: 'review'/.test(clusterSrc), null);
  check('批评者的 skill 要求逐条给出处，不接受「应该没问题」',
    /无依据/.test(clusterSrc) && /证据/.test(clusterSrc), null);
  check('独立核对在工作波之后、审查波之前跑（顺序反了就没什么可核对的）',
    /runParallel\(membersOf\('work'\)[\s\S]{0,1500}?auditRoomClaims[\s\S]{0,1500}?runParallel\(reviewMembers/.test(clusterSrc), null);
  check('没依据的说法只是「待核对项」，不是直接判定有问题',
    /不要把这条清单当成结论/.test(clusterSrc), null);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  reflection-check`);
process.exit(failures === 0 ? 0 : 1);
