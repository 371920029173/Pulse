/**
 * Pre-flight intent analysis: the deterministic half.
 *
 * These tests exist because the deterministic half is the half that has to be RIGHT:
 * the model fills in the goals, but a missing `@file:` or a tool this agent does not
 * have is a fact the code asserts. Every assertion here is one of the facts a plan gets
 * built on, so a regression is a plan that starts on a false premise.
 *
 * The analysis takes an injectable `pathExists`, so these run without touching disk —
 * and can therefore assert on paths that deliberately do not exist.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  analyzeRequest,
  buildRecord,
  renderRecord,
  PreflightStore,
  createPreflightTools,
} from '../preflight.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-preflight-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A context with everything present, so each test can remove exactly one thing. */
const ctx = (over: Partial<Parameters<typeof analyzeRequest>[1]> = {}) => ({
  workspaceRoot: dir,
  tools: ['schedule_create', 'lsp_definition', 'ask_user', 'fs_read'],
  ...over,
});

describe('analyzeRequest — explicit path references', () => {
  it('a missing @file: is a blocking prerequisite', () => {
    const e = analyzeRequest('改一下 @file:src/nope.ts', ctx());
    const p = e.prerequisites.find((x) => x.kind === 'path')!;
    assert.equal(p.ok, false, '不存在的文件应被判为不可用');
    assert.equal(p.blocking, true, '用户指着的文件不存在，必须挡下来');
    assert.ok(e.blockingQuestions.length >= 1, '应产生一个必须问的问题');
    assert.ok(e.confidenceCeiling < 1, `有阻塞项时置信度上限必须下调，实际 ${e.confidenceCeiling}`);
  });

  it('an existing @file: passes', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'real.ts'), 'export const x = 1;\n', 'utf8');
    const e = analyzeRequest('看 @file:src/real.ts', ctx());
    const p = e.prerequisites.find((x) => x.kind === 'path')!;
    assert.equal(p.ok, true, '存在的文件应通过');
    assert.equal(e.blockingQuestions.length, 0);
    assert.equal(e.confidenceCeiling, 1, '没有阻塞项时不应压低置信度');
  });

  it('a path escaping the workspace is refused, not checked for existence', () => {
    // The sandbox owns the refusal; pre-flight must not disagree with it, so it asks the
    // same helper and reports the same verdict rather than doing its own path maths.
    const e = analyzeRequest('读 @file:../../etc/passwd', ctx());
    const p = e.prerequisites.find((x) => x.kind === 'path')!;
    assert.equal(p.ok, false);
    assert.match(String(p.detail), /工作区之外/, `应说明越界，实际: ${p.detail}`);
    // The injected pathExists is NOT consulted here: a path outside the jail is not a
    // question about the filesystem.
    assert.equal(e.prerequisites.some((x) => x.what.includes('passwd') && x.ok), false);
  });

  it('@folder: is recognised as a folder reference', () => {
    const e = analyzeRequest('扫一遍 @folder:packages', ctx());
    assert.ok(e.prerequisites.some((p) => p.what === '@folder:packages'), '应识别 @folder:');
  });

  it('a bare path in prose is NOT a prerequisite', () => {
    // `packages/server/src/audit.ts` is just as likely to be a file the user wants
    // CREATED. Blocking on it would fire on ordinary requests, which is how a check
    // teaches people to ignore it.
    const e = analyzeRequest('新建 packages/server/src/audit.ts', ctx());
    assert.equal(e.prerequisites.filter((p) => p.kind === 'path').length, 0,
      '未加 @file: 的裸路径不应被当作前置条件');
    assert.equal(e.blockingQuestions.length, 0);
  });

  it('the same path with two markers keeps each marker', () => {
    // Recovering the marker with `indexOf` reported the first one for both.
    const e = analyzeRequest('@folder:src 里的 @file:src/a.ts', ctx({ pathExists: () => true }));
    const whats = e.prerequisites.filter((p) => p.kind === 'path').map((p) => p.what);
    assert.deepEqual(whats, ['@folder:src', '@file:src/a.ts']);
  });
});

describe('analyzeRequest — symbol references', () => {
  it('@symbol: without a language server is reported but does not block', () => {
    const e = analyzeRequest('@symbol:GroupKBEngine 在哪定义', ctx({ tools: ['grep', 'fs_read'] }));
    const p = e.prerequisites.find((x) => x.kind === 'symbol')!;
    assert.equal(p.ok, false);
    assert.equal(p.blocking, false, '没有 LSP 仍可用 grep 兜底，不应挡住任务');
    assert.match(String(p.detail), /语言服务器/);
  });

  it('@symbol: passes when an LSP tool is registered', () => {
    const e = analyzeRequest('@symbol:Foo', ctx());
    assert.equal(e.prerequisites.find((x) => x.kind === 'symbol')!.ok, true);
  });
});

describe('analyzeRequest — time expressions', () => {
  it('a time expression alone is evidence, not a scheduler requirement', () => {
    // "明天要开会" mentions a time but asks the agent for nothing later.
    const e = analyzeRequest('明天要开会，帮我准备材料', ctx({ tools: [] }));
    assert.ok(e.timeExpressions.length >= 1, `应识别时间词，实际: ${JSON.stringify(e.timeExpressions)}`);
    const p = e.prerequisites.find((x) => x.kind === 'time')!;
    assert.equal(p.blocking, false, '只是提到时间，不应要求排程工具');
  });

  it('time + a scheduling verb with no schedule tool is blocking', () => {
    // This is the case that silently produced a text reply instead of a reminder.
    const e = analyzeRequest('明天早上 9 点提醒我检查构建', ctx({ tools: ['grep'] }));
    const p = e.prerequisites.find((x) => x.kind === 'time')!;
    assert.equal(p.ok, false);
    assert.equal(p.blocking, true, '没有排程工具时「提醒」不会发生，必须说明');
    assert.ok(e.blockingQuestions.some((q) => q.includes('稍后执行')), JSON.stringify(e.blockingQuestions));
  });

  it('time + a scheduling verb passes when the tool is present', () => {
    const e = analyzeRequest('每天检查一次构建', ctx());
    assert.equal(e.prerequisites.find((x) => x.kind === 'time')!.ok, true);
    assert.equal(e.blockingQuestions.length, 0);
  });

  it('a version number is not a time expression', () => {
    const e = analyzeRequest('把 v1.2.3 升到 2.0.0', ctx());
    assert.equal(e.timeExpressions.length, 0, `不应把版本号当时间，实际: ${JSON.stringify(e.timeExpressions)}`);
  });
});

describe('analyzeRequest — inherited context', () => {
  it('always states the workspace boundary as a hard constraint', () => {
    const e = analyzeRequest('随便做点什么', ctx());
    const c = e.constraints.find((x) => x.source === 'workspace')!;
    assert.equal(c.hardness, 'hard');
  });

  it('reports the skill profile and manual mode as constraints', () => {
    const e = analyzeRequest('随便做点什么', ctx({ skillProfile: 'liberal', automationMode: false }));
    assert.ok(e.constraints.some((c) => c.source === 'profile' && c.text.includes('liberal')));
    assert.ok(e.constraints.some((c) => c.source === 'session' && c.hardness === 'hard' && c.text.includes('手动')));
  });

  it('an open plan is a soft constraint, never an instruction to resume', () => {
    const e = analyzeRequest('你好', ctx({ activePlanGoal: '把门禁跑绿' }));
    const c = e.constraints.find((x) => x.source === 'session' && x.text.includes('把门禁跑绿'))!;
    assert.equal(c.hardness, 'soft');
    assert.match(c.text, /否则当普通对话/, '旧计划不是长期指令');
  });

  it('destructive wording is surfaced as a risk constraint', () => {
    const e = analyzeRequest('把旧日志删掉', ctx());
    assert.ok(e.riskHints.includes('删除/清空'), JSON.stringify(e.riskHints));
    assert.ok(e.constraints.some((c) => c.text.includes('确认门')));
  });
});

describe('buildRecord', () => {
  const evidence = (text = '做个东西') => analyzeRequest(text, ctx());

  it('clamps a confidence the checked facts do not support', () => {
    const e = analyzeRequest('@file:missing.ts', ctx());
    const r = buildRecord(e, { stated_intent: 's', actual_goal: 'g', confidence: 0.99 });
    assert.equal(r.confidence, e.confidenceCeiling, '应被压到上限');
    assert.equal(r.confidenceClamped, true, '必须记录被下调过，而不是悄悄改数');
    assert.match(renderRecord(r), /已从更高值下调/, '渲染时要说明下调了');
  });

  it('leaves a confidence below the ceiling alone', () => {
    const r = buildRecord(evidence(), { stated_intent: 's', actual_goal: 'g', confidence: 0.4 });
    assert.equal(r.confidence, 0.4);
    assert.equal(r.confidenceClamped, false);
  });

  it('defaults to full confidence when the model omits it and nothing is blocked', () => {
    const r = buildRecord(evidence(), { stated_intent: 's', actual_goal: 'g' });
    assert.equal(r.confidence, 1);
  });

  it('merges the deterministic questions ahead of the model own', () => {
    const e = analyzeRequest('@file:gone.ts', ctx());
    const r = buildRecord(e, {
      stated_intent: 's',
      actual_goal: 'g',
      clarification_needed: ['用哪种格式？'],
    });
    assert.ok(r.clarification_needed[0].includes('gone.ts'), '有检查支撑的问题排前面');
    assert.ok(r.clarification_needed.includes('用哪种格式？'), '模型自己的问题也要保留');
  });

  it('de-duplicates an identical question', () => {
    const e = analyzeRequest('@file:gone.ts', ctx());
    const q = e.blockingQuestions[0];
    const r = buildRecord(e, { stated_intent: 's', actual_goal: 'g', clarification_needed: [q] });
    assert.equal(r.clarification_needed.filter((x) => x === q).length, 1);
  });

  it('refuses an empty intent or goal instead of storing a hollow record', () => {
    assert.throws(() => buildRecord(evidence(), { stated_intent: '  ', actual_goal: 'g' }));
    assert.throws(() => buildRecord(evidence(), { stated_intent: 's', actual_goal: '' }));
  });
});

describe('PreflightStore', () => {
  it('round-trips a record through disk', () => {
    const store = new PreflightStore(dir, 'sess-1');
    const r = buildRecord(analyzeRequest('做个东西', ctx()), { stated_intent: 's', actual_goal: 'g' });
    store.save(r);
    const back = store.latest();
    assert.equal(back?.id, r.id);
    assert.equal(back?.actual_goal, 'g');
    assert.equal(back?.sessionId, 'sess-1');
  });

  it('keeps every record rather than the last one', () => {
    const store = new PreflightStore(dir);
    for (const g of ['一', '二', '三']) {
      store.save(buildRecord(analyzeRequest('x', ctx()), { stated_intent: 's', actual_goal: g }));
    }
    assert.equal(store.list().length, 3);
    assert.equal(store.list()[0].actual_goal, '三', '最新的排最前');
  });

  it('skips an unreadable file instead of hiding the good ones', () => {
    // A half-written or hand-edited record must not take the whole directory down with it.
    const store = new PreflightStore(dir);
    store.save(buildRecord(analyzeRequest('x', ctx()), { stated_intent: 's', actual_goal: '好记录' }));
    writeFileSync(join(dir, '.she', 'preflight', 'zz-broken.json'), '{ not json', 'utf8');
    const all = store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].actual_goal, '好记录');
  });

  it('writes no temp files behind', () => {
    const store = new PreflightStore(dir);
    store.save(buildRecord(analyzeRequest('x', ctx()), { stated_intent: 's', actual_goal: 'g' }));
    const files = readdirSync(join(dir, '.she', 'preflight'));
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, `残留临时文件: ${files.join(', ')}`);
  });
});

describe('preflight tool', () => {
  const toolsFor = (request: string) => createPreflightTools(dir, {
    sessionId: 'sess-1',
    getRequest: () => request,
    listTools: () => ['schedule_create', 'ask_user'],
  });

  it('is exposed as preflight_record', () => {
    const names = toolsFor('x').definitions.map((d) => d.name);
    assert.deepEqual(names, ['preflight_record']);
  });

  it('records the analysis and reports the blocking question', async () => {
    const out = await toolsFor('改 @file:src/gone.ts').execute('preflight_record', {
      stated_intent: '改这个文件',
      actual_goal: '修好它',
    });
    assert.match(out, /pre-flight/i, out);
    assert.match(out, /gone\.ts/, '输出里要点出那个不存在的文件');
    assert.match(out, /ask_user/, '要明确要求先问再动');
    assert.ok(existsSync(join(dir, '.she', 'preflight')), '记录应落盘');
  });

  it('says there is nothing to analyse when no user request is on the turn', async () => {
    const out = await toolsFor('').execute('preflight_record', { stated_intent: 's', actual_goal: 'g' });
    assert.match(out, /没有可分析的用户请求/);
  });

  it('a missing required argument is reported, not thrown', async () => {
    const out = await toolsFor('x').execute('preflight_record', { stated_intent: '只有这个' });
    assert.equal(typeof out, 'string');
    assert.match(out, /actual_goal/);
  });

  it('an unknown tool name returns an error string', async () => {
    const out = await toolsFor('x').execute('preflight_nope', {});
    assert.match(out, /unknown/i);
  });
});
