/**
 * Delivery: the five parts, and "unconfirmed is not done" — offline, no API calls, no ports.
 *
 * A hand-off is where an agent's mistakes become the user's problem, and the two that matter are
 * both invisible in the transcript. A delivery can state a conclusion with nothing behind it —
 * the model saw the output, the user did not, and "it works" reads the same either way. And it
 * can report success over work that was never finished, because the only record of "finished" is
 * the agent's own summary. So this check does not restate the template. It drives the real tool,
 * reads the artifact from the path the tool reported, and asks the plan whether the claim holds:
 *
 *   1. The template: conclusion and evidence are required, brief and full differ, and every
 *      refusal classifies as something the model can act on.
 *   2. Unconfirmed is not done: `done` is refused while anything is open, and while this
 *      WORKSPACE's plan has unfinished steps — naming them.
 *   3. The plan is the workspace's, not the conversation's: an unfinished plan in another
 *      workspace neither blocks a delivery here nor gets claimed by it, while one left open by
 *      another conversation in the SAME project does — and so does a second plan in this one,
 *      since nothing stops a second being created. Closing them honestly (done, or dropped
 *      with a reason) is what lets the delivery through.
 *   4. The artifact on disk says what the tool said, including what is still outstanding.
 *   5. `kind=report` is unchanged, so an analysis document is not forced through a delivery form.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPlanTools, classifyToolResult, getSystemPrompt } from '../packages/agent-runtime/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'she-delivery-'));
mkdirSync(join(dir, '.she'), { recursive: true });

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 600)}`);
  }
};

const toolsFor = (session) => createPlanTools(dir, session);
const call = (tools, name, args) => tools.execute(name, args);
const reports = () => {
  try {
    return readdirSync(join(dir, '.she', 'reports'));
  } catch {
    return [];
  }
};

/**
 * Write, then read the file back from the path the tool REPORTED.
 *
 * Not "the newest file in the directory": timestamps are second-resolution and these run in the
 * same second, so a directory listing would quietly assert against whichever artifact happened to
 * sort last. Reading the reported path also checks that the path is real.
 */
async function deliver(tools, args) {
  const out = await call(tools, 'report_write', args);
  const rel = /\.she\/reports\/[^\s]+\.md/.exec(out)?.[0] ?? null;
  const text = rel ? readFileSync(join(dir, rel), 'utf8') : '';
  return { out, rel, text };
}

const kindOf = (out) => classifyToolResult('report_write', out).kind;
const evidence = ['shell: pnpm db:migrate → exit code: 0', 'grep: schema.sql:42 有新列'];
const conclusion = '迁移脚本跑通了，本地库结构与目标一致';

console.log('1. 交付模板：结论和证据不是可选项');
{
  const tools = toolsFor('sess-a');
  const before = reports().length;

  const noStatus = await deliver(tools, { kind: 'delivery', title: 'T', conclusion, evidence });
  check('不给 status 会被拒绝', noStatus.out.startsWith('Error: '), noStatus.out);
  check('归为参数错误（模型能改）', kindOf(noStatus.out) === 'invalid_args', kindOf(noStatus.out));

  const noConclusion = await deliver(tools, { kind: 'delivery', title: 'T', status: 'done', evidence });
  check('不给 conclusion 会被拒绝', /conclusion/.test(noConclusion.out) && noConclusion.out.startsWith('Error: '), noConclusion.out);
  check('归为参数错误', kindOf(noConclusion.out) === 'invalid_args', kindOf(noConclusion.out));

  const noEvidence = await deliver(tools, { kind: 'delivery', title: 'T', status: 'done', conclusion });
  check('不给 evidence 会被拒绝', /evidence/.test(noEvidence.out) && noEvidence.out.startsWith('Error: '), noEvidence.out);
  const emptyEvidence = await deliver(tools, { kind: 'delivery', title: 'T', status: 'done', conclusion, evidence: [] });
  check('evidence 是空数组也被拒绝（空证据 = 断言）', emptyEvidence.out.startsWith('Error: '), emptyEvidence.out);

  /*
   * 第四轮 7a：原来只校验「非空」，于是 `["done"]` 满足全部规则 —— 那一节的全部意义就是让结论
   * 可以被推翻，却能被结论自己填满。这里钉住「非空 ≠ 有内容」，并确认拒绝会点名是哪一条。
   */
  const placeholder = await deliver(tools, {
    kind: 'delivery', title: 'T', status: 'done', conclusion, evidence: [conclusion],
  });
  check('证据只是把结论说一遍（原样抄 conclusion）会被拒绝', placeholder.out.startsWith('Error: '), placeholder.out);
  check('拒绝里点名了那条假证据', /无法核对|只是把结论/.test(placeholder.out), placeholder.out);
  check('归为参数错误（模型能改）', kindOf(placeholder.out) === 'invalid_args', kindOf(placeholder.out));

  for (const thin of ['done', '已完成', 'ok', '没问题', '状态: 完成']) {
    const out = await deliver(tools, { kind: 'delivery', title: 'T', status: 'done', conclusion, evidence: [thin] });
    check(`占位证据「${thin}」被拒绝`, out.out.startsWith('Error: '), out.out);
  }

  /*
   * 只提到话题、没有结果的句子同样是断言。
   *
   * 这一组回填的是判据自己的一个洞：`测试`、`日志`、`输出`、`命令` 这些词原来单独就算信号，于是
   * 「测试通过」能过 —— 而它和「把结论又说了一遍」是同一句话，只是多了一个话题名词。判据离它要挡
   * 的东西只差一个词，等于没挡。
   */
  for (const topical of ['测试通过', '跑了测试，全绿', '日志显示一切正常', '命令跑完了']) {
    const out = await deliver(tools, { kind: 'delivery', title: 'T', status: 'done', conclusion, evidence: [topical] });
    check(`只提话题、没有结果的「${topical}」被拒绝`, out.out.startsWith('Error: '), out.out);
  }

  const mixed = await deliver(tools, {
    kind: 'delivery', title: 'T', status: 'done', conclusion,
    evidence: ['shell: pnpm test → exit code: 0', 'done'],
  });
  check('混着一条真的和一条假的，整单还是会被拒绝（不是只看第一条）', mixed.out.startsWith('Error: '), mixed.out);
  check('并且点名的是那条假的', /"done"/.test(mixed.out), mixed.out);

  const fullNoLists = await deliver(tools, { kind: 'delivery', title: 'T', status: 'done', mode: 'full', conclusion, evidence });
  check('详版必须显式给出 assumptions 和 risks', /assumptions/.test(fullNoLists.out) && fullNoLists.out.startsWith('Error: '), fullNoLists.out);
  check('归为参数错误', kindOf(fullNoLists.out) === 'invalid_args', kindOf(fullNoLists.out));

  const badKind = await deliver(tools, { kind: 'deliver', title: 'T' });
  check('写错的 kind 会被拒绝，而不是悄悄当 report', badKind.out.startsWith('Error: '), badKind.out);

  check('被拒绝时不会留下半个文件', reports().length === before, reports().join(', '));

  /*
   * 控制组：门槛不是「必须写命令」。一条 file:line、一个文件名，都是读者能自己去查的东西，
   * 必须放行 —— 否则规则会退化成「照我写的格式写」，模型只会学着凑格式。
   */
  const locOnly = await deliver(tools, {
    kind: 'delivery', title: '定位型证据', status: 'done', conclusion,
    evidence: ['packages/server/src/index.ts:975 短路了策略检查', '读了 config.ts 里的默认值'],
  });
  check('file:line / 文件名就算证据（不要求必须有命令输出）', !locOnly.out.startsWith('Error: '), locOnly.out);

  /*
   * 收紧之后仍然要放行这些：不带扩展名的路径、errno、被引下来的报错原文。判据要的是「指向哪个
   * 东西」，不是「必须写成某个格式」—— 否则模型只会学着凑格式，而不是把输出带回来。
   */
  const otherShapes = await deliver(tools, {
    kind: 'delivery', title: '别的形状的证据', status: 'done', conclusion,
    evidence: ['读了 src/index 的导出', '删除失败，errno 是 ENOENT'],
  });
  check('不带扩展名的路径 / errno 也算证据（判据要的是指向东西，不是格式）',
    !otherShapes.out.startsWith('Error: '), otherShapes.out);
}

console.log('\n2. 未确认不标完成');
{
  const tools = toolsFor('sess-b');

  const openClaim = await deliver(tools, {
    kind: 'delivery', title: 'T', status: 'done', conclusion, evidence,
    open: ['线上库还没跑（需要运维窗口）'],
  });
  check('有「待确认」却写 status=done 会被拒绝', openClaim.out.startsWith('Error: '), openClaim.out);
  check('拒绝里点名那一项', /线上库还没跑/.test(openClaim.out), openClaim.out);
  check('并归为参数错误（自相矛盾，不是状态问题）', kindOf(openClaim.out) === 'invalid_args', kindOf(openClaim.out));

  const pointless = await deliver(tools, { kind: 'delivery', title: 'T', status: 'needs_confirmation', conclusion, evidence });
  check('没有任何待确认却写 needs_confirmation 也会被拒绝', pointless.out.startsWith('Error: '), pointless.out);

  await call(tools, 'plan_create', { title: '迁移', steps: ['备份', '跑迁移', '验证'] });
  await call(tools, 'plan_update', { step_id: 's1', status: 'done' });

  const overPlan = await deliver(tools, { kind: 'delivery', title: 'T', status: 'done', conclusion, evidence });
  check('计划还没做完时 status=done 被拒绝', overPlan.out.startsWith('Error: '), overPlan.out);
  check('拒绝里点名没做完的步骤', /s2 跑迁移/.test(overPlan.out) && /s3 验证/.test(overPlan.out), overPlan.out);
  check('归为「前提没满足」而不是 unknown', kindOf(overPlan.out) === 'precondition', kindOf(overPlan.out));

  const partial = await deliver(tools, {
    kind: 'delivery', title: '部分交付', status: 'partial', conclusion, evidence,
    open: ['s3 验证还没跑'],
  });
  check('同一件事写成 partial 就能交', !partial.out.startsWith('Error: '), partial.out);
  check('回执里报出状态/证据数/待确认数/未完成步骤数',
    /status=partial/.test(partial.out) && /待确认 1 项/.test(partial.out) && /未完成的计划步骤 2 个/.test(partial.out),
    partial.out);
  check('产物路径是真的（能读回内容）', partial.text.length > 0, partial.rel);

  check('产物里写着「交付状态: 部分完成」', /交付状态: 部分完成/.test(partial.text), partial.text.slice(0, 200));
  check('产物里有结论、证据、待确认三段',
    /## 结论/.test(partial.text) && /## 证据/.test(partial.text) && /## 待确认/.test(partial.text), null);
  check('结论与证据是写进去的那份',
    partial.text.includes(conclusion) && /pnpm db:migrate/.test(partial.text), null);
  check('产物自动带上「计划里还没做完的步骤」，并带上真实状态',
    /计划里还没做完的步骤/.test(partial.text) && /s2 跑迁移 \[active\]/.test(partial.text)
    && /s3 验证 \[pending\]/.test(partial.text), partial.text.slice(-400));

  await call(tools, 'plan_update', { step_id: 's2', status: 'done' });
  await call(tools, 'plan_update', { step_id: 's3', status: 'done' });
  const allowed = await deliver(tools, { kind: 'delivery', title: '收口', status: 'done', conclusion, evidence });
  check('计划做完后 status=done 通过', !allowed.out.startsWith('Error: '), allowed.out);
  check('通过后产物里不再有「还没做完的步骤」', !/还没做完的步骤/.test(allowed.text), allowed.text.slice(-200));
}

console.log('\n3. 别的工作区的计划不拦；同一项目里别人留下的未收口计划该拦，且能收口');
{
  /*
   * 另一个**工作区**：路径上不存在，所以既不拦这次交付，也不会被冒充成"我的步骤"。
   */
  const otherRoot = mkdtempSync(join(tmpdir(), 'she-delivery-other-'));
  const other = createPlanTools(otherRoot, 'sess-other');
  await other.execute('plan_create', { title: '别的项目里的活', steps: ['a', 'b'] });

  const tools = toolsFor('sess-mine');
  const out = await deliver(tools, { kind: 'delivery', title: '无关交付', status: 'done', conclusion, evidence });
  check('另一个工作区没做完的计划不拦这次交付', !out.out.startsWith('Error: '), out.out);
  check('也不用它的步骤来吓唬人', !/还没做完的步骤/.test(out.text), out.text.slice(-200));
  removeTempDir(otherRoot);

  /*
   * 同一个工作区里，**另一条会话**留下的未收口计划：看得见，所以拦得住。
   *
   * 这正是"一个项目一份计划"的代价，也是它买来的东西 —— 上一轮对话没做完的活，这一轮能接着做，
   * 而不是随对话消失。所以这里不是"要隔离掉"的噪声，而是必须兑现的承诺：拦住，并且点名。
   */
  const peer = toolsFor('sess-peer');
  await peer.execute('plan_create', { title: '同事没做完的活', steps: ['起服务', '验接口'] });

  const blocked = await deliver(tools, { kind: 'delivery', title: '本工作区', status: 'done', conclusion, evidence });
  check('【关键】同一工作区里别人留下的未收口计划会拦住这次 done', blocked.out.startsWith('Error: '), blocked.out);
  check('拒绝里点名那些步骤（能接着做，不是只被拦住）',
    /起服务/.test(blocked.out) && /验接口/.test(blocked.out), blocked.out);

  /*
   * 出口是"诚实地收口"，不是"把 done 写进去"：标成 dropped 并给出理由，剩下那步做完 —— 之后才过。
   */
  await call(tools, 'plan_update', { step_id: 's1', status: 'dropped', note: '这块改由运维窗口执行，本轮不做' });
  const stillBlocked = await deliver(tools, { kind: 'delivery', title: '只收了一半', status: 'done', conclusion, evidence });
  check('只 dropped 一步还不够：剩下那步没做完仍然拦着', stillBlocked.out.startsWith('Error: '), stillBlocked.out);
  await call(tools, 'plan_update', { step_id: 's2', status: 'done' });
  const after = await deliver(tools, { kind: 'delivery', title: '收口后', status: 'done', conclusion, evidence });
  check('把步骤收口（dropped 带理由 + done）之后 done 通过', !after.out.startsWith('Error: '), after.out);

  /*
   * 6a：`plan_create` 不拦第二份计划，所以「还没做完」的账必须按**所有** open 计划算。
   *
   * 只算最近动过的那一份时，回执里那句「还没做完的步骤」对一份计划是真的、对另一份只字不提 ——
   * 而读到它的人会以为这就是全部。步骤 id（s1/s2）在各份计划里本来就重复，所以拒绝与产物都带
   * 计划名，否则读者不知道该去哪份里收口。
   */
  await toolsFor('sess-two-a').execute('plan_create', { title: '第一件没做完的活', steps: ['备份'] });
  await toolsFor('sess-two-b').execute('plan_create', { title: '第二件没做完的活', steps: ['起服务'] });

  const two = await deliver(tools, { kind: 'delivery', title: '两份都开着', status: 'done', conclusion, evidence });
  check('【关键】两份未收口计划都会拦住 done（不是只看最近动过的那份）', two.out.startsWith('Error: '), two.out);
  check('拒绝里两份计划都点名',
    /第一件没做完的活/.test(two.out) && /第二件没做完的活/.test(two.out), two.out);

  const partialTwo = await deliver(tools, {
    kind: 'delivery', title: '两份都开着但要交', status: 'partial', conclusion, evidence,
    open: ['两份计划都没做完'],
  });
  check('同一件事写成 partial 能交', !partialTwo.out.startsWith('Error: '), partialTwo.out);
  check('产物里两份计划的未完成步骤都列了出来，各带计划名',
    /第一件没做完的活 · s1 备份 \[active\]/.test(partialTwo.text)
    && /第二件没做完的活 · s1 起服务 \[active\]/.test(partialTwo.text),
    partialTwo.text.slice(-500));
}

console.log('\n4. 简版 / 详版：区别在「有没有想过」，不在字数');
{
  const tools = toolsFor('sess-c');
  const brief = await deliver(tools, {
    kind: 'delivery', title: '简版', status: 'partial', conclusion, evidence, open: ['没跑回归'],
  });
  check('简版不要求 assumptions / risks', !brief.out.startsWith('Error: '), brief.out);
  check('简版标着「简版」', /简版/.test(brief.text), brief.text.slice(0, 200));
  check('简版省略空的小节（没有假设就不印假设）', !/## 假设/.test(brief.text), brief.text.slice(0, 300));

  const full = await deliver(tools, {
    kind: 'delivery', title: '详版', status: 'partial', mode: 'full', conclusion, evidence,
    assumptions: ['迁移窗口内业务可以停 5 分钟'],
    risks: ['回滚脚本没在预发验证过'],
    open: ['没跑回归'],
  });
  check('详版可以给出假设和风险', !full.out.startsWith('Error: '), full.out);
  check('详版标着「详版」', /详版/.test(full.text), full.text.slice(0, 200));
  check('详版印出假设', /## 假设/.test(full.text) && /迁移窗口内业务可以停/.test(full.text), null);
  check('详版印出风险', /## 风险/.test(full.text) && /回滚脚本/.test(full.text), null);

  const fullEmpty = await deliver(tools, {
    kind: 'delivery', title: '详版无假设', status: 'partial', mode: 'full', conclusion, evidence,
    assumptions: [], risks: [], open: ['没跑回归'],
  });
  check('详版里空的小节印成「（无）」而不是消失', /## 假设/.test(fullEmpty.text) && /（无）/.test(fullEmpty.text), fullEmpty.text.slice(0, 400));
  check('没错过空列表时不会报错', !fullEmpty.out.startsWith('Error: '), fullEmpty.out);
}

console.log('\n5. kind=report 还是原来那个东西');
{
  const tools = toolsFor('sess-d');
  const out = await deliver(tools, {
    title: '分析报告',
    summary: '一句话摘要',
    sections: [{ heading: '发现', body: '- 第一点\n- 第二点' }],
  });
  check('report 不需要 conclusion/evidence/status', /Report written/.test(out.out), out.out);
  check('report 产物里没有「交付状态」那一行', !/交付状态/.test(out.text), out.text.slice(0, 200));
  check('report 的小节照常写出', /## 发现/.test(out.text) && /第一点/.test(out.text), null);
  check('文件名区分 report 与 delivery', /-report-/.test(out.rel) && reports().some((f) => /-delivery-/.test(f)), reports().join(', '));
}

console.log('\n6. 提示词里写了这套交付规则');
{
  const prompt = getSystemPrompt('dev');
  check('提示词有「## Delivering work」段', /## Delivering work/.test(prompt), null);
  check('提示词列出结论/证据/假设/风险/待确认',
    /conclusion/.test(prompt) && /evidence/.test(prompt) && /assumptions/.test(prompt)
    && /risks/.test(prompt) && /open questions/.test(prompt), null);
  check('提示词写明「未验证的不能算 done」', /Not verified is not \`done\`/.test(prompt), null);
  check('提示词写明证据会被查内容、不只是查非空', /checked for substance/.test(prompt), null);
  check('提示词写明简版/详版的取舍', /mode: "brief"/.test(prompt) && /mode: "full"/.test(prompt), null);
  check('提示词区分 delivery 与 report', /kind: "report"/.test(prompt), null);
  /*
   * 交付闸门读的是**工作区**的计划文件，所以提示词必须说同一件事：不然模型会以为"别人的计划拦住了
   * 我"是 bug 而去绕过它，或者反过来以为换个对话就能把没做完的活甩掉。
   */
  check('提示词写明计划属于工作区、不是这条对话的',
    /\.she\/plans\.json/.test(prompt) && /belong to the WORKSPACE/.test(prompt), null);
  check('提示词写明别的对话留下的未收口计划会拦住这次的 done',
    /left open by another chat/.test(prompt) && /report_write/.test(prompt), null);
  check('提示词写明备忘是工作区共享的一本',
    /\.she\/memo\.json/.test(prompt) && /Every chat in this project reads and writes the same one/.test(prompt), null);
}

removeTempDir(dir);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  delivery-check`);
process.exit(failures === 0 ? 0 : 1);
