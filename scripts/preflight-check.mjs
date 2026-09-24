/**
 * Pre-flight intent analysis check — offline, no API calls, no server.
 *
 * This one needs neither a port nor a stub: the deterministic half makes no model call by
 * design, so it can be exercised directly. That is the point of splitting it out of the
 * model-facing half — the facts a plan is built on are asserted here, for free, on every
 * gate run.
 *
 * Three things are checked, in order of how much they matter:
 *
 *   1. The ANALYSIS is right. Every assertion is one of the facts the agent will build a
 *      plan on, so a regression here is a plan that starts from a false premise.
 *   2. The WIRING is right, through a real Agent: the tool exists, a subagent does not get
 *      it, and the prompt actually teaches the behaviour.
 *   3. The RECORDS survive. An analysis nobody can read afterwards is a ritual.
 *
 * Imports the built `dist`, not the source, so this checks what runs.
 *
 *   node scripts/preflight-check.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../packages/sandbox/dist/index.js';
import {
  Agent,
  analyzeRequest,
  buildRecord,
  renderRecord,
  PreflightStore,
  createPreflightTools,
  getSystemPrompt,
} from '../packages/agent-runtime/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'she-preflight-'));
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A context with everything present, so each case can remove exactly one thing. */
const ctx = (over = {}) => ({
  workspaceRoot: dir,
  tools: ['schedule_create', 'lsp_definition', 'ask_user', 'fs_read'],
  ...over,
});

// ─── 1. The analysis ────────────────────────────────────────────────────────
console.log('\n=== 确定性分析：显式引用 ===');
{
  const missing = analyzeRequest('改一下 @file:src/nope.ts', ctx());
  const p = missing.prerequisites.find((x) => x.kind === 'path');
  check('不存在的 @file: 是阻塞项', p && p.ok === false && p.blocking === true,
    JSON.stringify(missing.prerequisites));
  check('阻塞时产生必须问的问题', missing.blockingQuestions.length >= 1, JSON.stringify(missing.blockingQuestions));
  check('阻塞时下调置信度上限', missing.confidenceCeiling < 1, `ceiling=${missing.confidenceCeiling}`);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'real.ts'), 'export const x = 1;\n', 'utf8');
  const ok = analyzeRequest('看 @file:src/real.ts', ctx());
  check('存在的 @file: 通过且不产生问题',
    ok.prerequisites.every((x) => x.ok) && ok.blockingQuestions.length === 0,
    JSON.stringify(ok.prerequisites));
  check('没有阻塞项时上限为 1', ok.confidenceCeiling === 1, `ceiling=${ok.confidenceCeiling}`);

  const escape = analyzeRequest('读 @file:../../etc/passwd', ctx());
  const ep = escape.prerequisites.find((x) => x.kind === 'path');
  check('越界路径被拒（与沙箱同一判定）', ep && ep.ok === false && /工作区之外/.test(String(ep.detail)),
    String(ep?.detail));

  const bare = analyzeRequest('新建 packages/server/src/audit.ts', ctx());
  check('未加 @file: 的裸路径不算前置条件',
    bare.prerequisites.filter((x) => x.kind === 'path').length === 0,
    JSON.stringify(bare.prerequisites));
  check('裸路径不产生阻塞问题（否则普通请求也会被挡）', bare.blockingQuestions.length === 0);

  const two = analyzeRequest('@folder:src 里的 @file:src/a.ts', ctx({ pathExists: () => true }));
  check('同一路径出现两种标记时各自保留',
    JSON.stringify(two.prerequisites.map((x) => x.what)) === JSON.stringify(['@folder:src', '@file:src/a.ts']),
    JSON.stringify(two.prerequisites.map((x) => x.what)));
}

console.log('\n=== 确定性分析：符号与时间 ===');
{
  const noLsp = analyzeRequest('@symbol:Foo 在哪', ctx({ tools: ['grep'] }));
  const sp = noLsp.prerequisites.find((x) => x.kind === 'symbol');
  check('无语言服务器时 @symbol: 报出但不阻塞', sp && sp.ok === false && sp.blocking === false,
    JSON.stringify(sp));
  check('无语言服务器时说明会退回 grep', /语言服务器/.test(String(sp?.detail)), String(sp?.detail));

  const mention = analyzeRequest('明天要开会，帮我准备材料', ctx({ tools: [] }));
  const mp = mention.prerequisites.find((x) => x.kind === 'time');
  check('只提到时间不算排程需求', mp && mp.blocking === false, JSON.stringify(mp));

  const need = analyzeRequest('明天早上 9 点提醒我检查构建', ctx({ tools: ['grep'] }));
  const np = need.prerequisites.find((x) => x.kind === 'time');
  check('要稍后执行但没有排程工具 → 阻塞', np && np.ok === false && np.blocking === true,
    JSON.stringify(np));
  check('并给出「改成现在做还是说明做不到」的问题',
    need.blockingQuestions.some((q) => q.includes('稍后执行')), JSON.stringify(need.blockingQuestions));

  const has = analyzeRequest('每天检查一次构建', ctx());
  check('有排程工具时该项通过', has.prerequisites.find((x) => x.kind === 'time')?.ok === true);
  check('通过时不产生问题', has.blockingQuestions.length === 0);

  const version = analyzeRequest('把 v1.2.3 升到 2.0.0', ctx());
  check('版本号不被当成时间', version.timeExpressions.length === 0,
    JSON.stringify(version.timeExpressions));
}

console.log('\n=== 确定性分析：继承的约束 ===');
{
  const base = analyzeRequest('随便做点什么', ctx());
  check('总是声明工作区边界为硬约束',
    base.constraints.some((c) => c.source === 'workspace' && c.hardness === 'hard'));

  const prof = analyzeRequest('随便做点什么', ctx({ skillProfile: 'liberal', automationMode: false }));
  check('技能档进入约束（软）',
    prof.constraints.some((c) => c.source === 'profile' && c.text.includes('liberal')));
  check('手动模式是硬约束',
    prof.constraints.some((c) => c.source === 'session' && c.hardness === 'hard' && c.text.includes('手动')));

  const leftover = analyzeRequest('你好', ctx({ activePlanGoal: '把门禁跑绿' }));
  const lc = leftover.constraints.find((c) => c.text.includes('把门禁跑绿'));
  check('旧计划是软约束且不构成续做指令',
    lc && lc.hardness === 'soft' && /否则当普通对话/.test(lc.text), JSON.stringify(lc));

  const risky = analyzeRequest('把旧日志删掉', ctx());
  check('破坏性字眼被标为风险', risky.riskHints.includes('删除/清空'), JSON.stringify(risky.riskHints));
  check('风险写进约束并指向确认门',
    risky.constraints.some((c) => c.text.includes('确认门')));
}

console.log('\n=== 置信度上限 ===');
{
  const blocked = analyzeRequest('@file:a.ts @file:b.ts', ctx());
  const rec = buildRecord(blocked, { stated_intent: 's', actual_goal: 'g', confidence: 0.99 });
  check('声称的置信度被压到检查结果允许的上限', rec.confidence === blocked.confidenceCeiling,
    `${rec.confidence} vs ceiling ${blocked.confidenceCeiling}`);
  check('下调这件事被记录下来', rec.confidenceClamped === true);
  check('渲染时说明下调过', /已从更高值下调/.test(renderRecord(rec)));

  const low = buildRecord(analyzeRequest('x', ctx()), { stated_intent: 's', actual_goal: 'g', confidence: 0.4 });
  check('低于上限的置信度不被改动', low.confidence === 0.4 && low.confidenceClamped === false);

  let threw = false;
  try { buildRecord(analyzeRequest('x', ctx()), { stated_intent: '  ', actual_goal: 'g' }); } catch { threw = true; }
  check('空字面诉求被拒（不留空壳记录）', threw);
}

// ─── 2. Records survive ─────────────────────────────────────────────────────
console.log('\n=== 记录落盘 ===');
{
  const store = new PreflightStore(dir, 'sess-check');
  const rec = buildRecord(analyzeRequest('做个东西', ctx()), { stated_intent: 's', actual_goal: '目标甲' });
  const file = store.save(rec);
  check('写到 .she/preflight/ 下', existsSync(file) && file.includes(join('.she', 'preflight')),
    file);

  const back = store.latest();
  check('能读回同一份记录', back?.id === rec.id && back?.actual_goal === '目标甲',
    JSON.stringify(back && { id: back.id, goal: back.actual_goal }));
  check('会话号被写上（不是空）', back?.sessionId === 'sess-check', String(back?.sessionId));

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  check('落盘的是完整记录（含检查到的证据）',
    Array.isArray(onDisk.evidence?.prerequisites) && typeof onDisk.evidence?.confidenceCeiling === 'number');

  store.save(buildRecord(analyzeRequest('x', ctx()), { stated_intent: 's', actual_goal: '目标乙' }));
  check('保留历史而不是只留最后一条', store.list().length === 2, `实际 ${store.list().length} 条`);
  /*
   * Two saves land in the SAME millisecond here, which is the case that used to break:
   * `createdAt` ties, ordering fell through to the random id, and `latest()` returned the
   * older record roughly half the time. The filename carries a sequence for exactly this.
   */
  check('同毫秒内连续保存时，最新的仍排最前', store.latest()?.actual_goal === '目标乙',
    `latest=${store.latest()?.actual_goal}`);

  writeFileSync(join(dir, '.she', 'preflight', 'zz-broken.json'), '{ not json', 'utf8');
  check('坏文件被跳过，不连累好记录', store.list().length === 2, `实际 ${store.list().length} 条`);

  const tmps = readdirSync(join(dir, '.she', 'preflight')).filter((f) => f.endsWith('.tmp'));
  check('没有残留临时文件', tmps.length === 0, tmps.join(', '));
}

// ─── 3. Tool behaviour ──────────────────────────────────────────────────────
console.log('\n=== 工具行为 ===');
{
  const tools = createPreflightTools(dir, {
    sessionId: 'sess-tool',
    getRequest: () => '改 @file:src/gone.ts',
    listTools: () => ['schedule_create'],
  });
  check('工具名是 preflight_record',
    tools.definitions.map((d) => d.name).join(',') === 'preflight_record',
    tools.definitions.map((d) => d.name).join(','));

  const out = await tools.execute('preflight_record', { stated_intent: '改这个文件', actual_goal: '修好它' });
  check('输出点出不存在的文件', /gone\.ts/.test(out), out.slice(0, 200));
  check('输出要求先 ask_user 再动', /ask_user/.test(out), out.slice(0, 400));
  /*
   * The tool must not set its own ask-policy: whether a question is allowed depends on the
   * active work-mode block, which this module cannot see. It names the CONDITION instead.
   */
  check('输出把 ask_user 限定在两种情形，而不是无条件要求',
    /只有属于「只有用户知道的信息」或「不可逆/.test(out), out.slice(-300));

  const nothing = createPreflightTools(dir, { getRequest: () => '', listTools: () => [] });
  check('没有用户请求时明确拒绝分析',
    /没有可分析的用户请求/.test(await nothing.execute('preflight_record', { stated_intent: 's', actual_goal: 'g' })));

  check('缺参数时返回错误字符串而不抛',
    typeof await tools.execute('preflight_record', { stated_intent: '只有这个' }) === 'string');
  check('未知工具名返回错误',
    /unknown/i.test(await tools.execute('preflight_nope', {})));
}

// ─── 4. Wiring through a real Agent ─────────────────────────────────────────
console.log('\n=== 接入真实 Agent ===');
{
  const cfg = loadConfig(PROJECT_ROOT);
  cfg.workspace.root = dir;
  const store = new KBStore(join(dir, 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, 'kb.sqlite') });
  const shell = new SandboxShell(dir, cfg.sandbox);
  const sandboxTools = createTools(shell, dir, { allowAllCommands: true });
  const names = (a) => (a.allToolDefs ?? []).map((d) => d.name);

  const parent = new Agent(cfg, engine, sandboxTools, null, {
    subagentRunner: { run: async () => ({ description: 'x', ok: true, result: 'ok' }) },
  });
  check('父智能体注册了 preflight_record', names(parent).includes('preflight_record'),
    names(parent).join(', '));

  const child = new Agent(cfg, engine, sandboxTools, null, { isSubagent: true });
  check('子智能体没有 preflight_record（分析的是父级的请求）',
    !names(child).includes('preflight_record'), names(child).join(', '));

  // Reaching a private field: the check runs against dist, where `private` is a
  // TypeScript-only notion. check-subagent.mjs does the same for `allToolDefs`.
  const executor = parent.executors?.get('preflight_record');
  check('工具在父智能体的执行表里', typeof executor === 'function');
  if (typeof executor === 'function') {
    const before = new PreflightStore(dir).list().length;
    const refused = await executor({ stated_intent: 's', actual_goal: 'g' });
    check('未收到用户消息时拒绝分析', /没有可分析的用户请求/.test(String(refused)), String(refused).slice(0, 120));
    check('拒绝时不写记录', new PreflightStore(dir).list().length === before);

    // Simulate the turn: this is the exact field `chat()` sets.
    parent.lastUserRequest = '整理 @file:src/real.ts 并删掉旧日志';
    const accepted = await executor({ stated_intent: '整理文件', actual_goal: '干净的工作区' });
    check('收到请求后给出分析', /Pre-flight pf_/.test(String(accepted)), String(accepted).slice(0, 120));
    check('分析里用上了工作区里的真实文件与风险字眼',
      /real\.ts/.test(String(accepted)) && /删除\/清空/.test(String(accepted)),
      String(accepted).slice(0, 400));
    check('记录落盘到该工作区', new PreflightStore(dir).list().length === before + 1);
  }

  const prompt = getSystemPrompt(dir);
  /*
   * The heading is matched with its newline, not as a bare substring. The loose version
   * passed when the section was renamed to "## Pre-flight Intent Analysis DISABLED",
   * because a substring match does not notice what follows — the exact failure this
   * assertion exists to catch, found by negative-testing it.
   */
  const sectionStart = prompt.indexOf('\n## Pre-flight Intent Analysis\n');
  check('提示词里有 Pre-flight Intent Analysis 段', sectionStart >= 0);
  const section = sectionStart >= 0
    ? prompt.slice(sectionStart, prompt.indexOf('\n## ', sectionStart + 1))
    : '';
  check('该段点名四个字段（字面诉求 / 约束 / 实际目标 / 待澄清）',
    ['stated_intent', 'inferred_constraints', 'actual_goal', 'clarification_needed']
      .every((f) => section.includes(f)),
    section.slice(0, 200));
  check('该段说明 ✗ 会转成给用户的问题', /becomes a question/.test(section), section.slice(0, 600));
  /*
   * The work-mode block says "do not stop to ask" with exactly two exceptions. A pre-flight
   * section that told the model to ask whenever a prerequisite failed would contradict the
   * default mode — the model would hold two rules and no way to pick between them. So the
   * section must defer to that block by name rather than establish its own ask-policy.
   */
  check('该段把「能不能问」交回工作模式段，而不是自定一套',
    /the two the active work-mode block allows/.test(section) && /Re-read that block/.test(section));
  check('该段承诺 ! 不会变成问题', /`!` is never blocking/.test(section));
  check('自动化模式段仍保留那两个例外（本段是引用它，不是取代它）',
    /只有两种情况可以停下来问/.test(getSystemPrompt(dir, undefined, true)));
  check('该段区分硬约束与软偏好', /Hard requirements and soft preferences/.test(section));
  check('可用工具清单里也有它', /`preflight_record`/.test(prompt));

  store.close();
}

removeTempDir(dir);
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
