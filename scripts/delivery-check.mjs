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
 *      conversation's plan has unfinished steps — naming them.
 *   3. A plan from another conversation neither blocks a delivery here nor gets claimed by it.
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

  const fullNoLists = await deliver(tools, { kind: 'delivery', title: 'T', status: 'done', mode: 'full', conclusion, evidence });
  check('详版必须显式给出 assumptions 和 risks', /assumptions/.test(fullNoLists.out) && fullNoLists.out.startsWith('Error: '), fullNoLists.out);
  check('归为参数错误', kindOf(fullNoLists.out) === 'invalid_args', kindOf(fullNoLists.out));

  const badKind = await deliver(tools, { kind: 'deliver', title: 'T' });
  check('写错的 kind 会被拒绝，而不是悄悄当 report', badKind.out.startsWith('Error: '), badKind.out);

  check('被拒绝时不会留下半个文件', reports().length === before, reports().join(', '));
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

console.log('\n3. 别会话的计划不该拦住这次交付，也不该被冒充');
{
  const other = toolsFor('sess-other');
  await other.execute('plan_create', { title: '别人的活', steps: ['a', 'b'] });

  const tools = toolsFor('sess-mine');
  const out = await deliver(tools, { kind: 'delivery', title: '无关交付', status: 'done', conclusion, evidence });
  check('另一个会话没做完的计划不拦这次交付', !out.out.startsWith('Error: '), out.out);
  check('也不用它的步骤来吓唬人', !/还没做完的步骤/.test(out.text), out.text.slice(-200));

  await call(tools, 'plan_create', { title: '本会话的活', steps: ['a'] });
  const blocked = await deliver(tools, { kind: 'delivery', title: '本会话', status: 'done', conclusion, evidence });
  check('本会话自己的计划才会拦', blocked.out.startsWith('Error: '), blocked.out);
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
  check('提示词写明简版/详版的取舍', /mode: "brief"/.test(prompt) && /mode: "full"/.test(prompt), null);
  check('提示词区分 delivery 与 report', /kind: "report"/.test(prompt), null);
}

removeTempDir(dir);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  delivery-check`);
process.exit(failures === 0 ? 0 : 1);
