/**
 * Work groups keep going in automation mode when the leader's summary hands out work.
 *
 * Regression (room 55c2ec65, "寻找C盘的垃圾文件"): the leader closed the only wave with
 * "@研发1 @研发2 @研发3 开工 … @审查 准备终版复核" and the room went idle — `runClusterWave` ran one fixed
 * pass per user message and never read the summary. Also covers the shared group plan, the caps,
 * stop, and that the transcript stays append-only (DeepSeek prefix cache).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LLMMessage, LLMProvider, SheConfig, StreamChunk, ToolDefinition } from '@she/shared';
import { PlanStore } from '@she/agent-runtime';
import { ClusterStore, buildDefaultRoles, runClusterWave, stopClusterRun } from '../cluster.js';
import {
  clusterAutoSettings,
  createGroupPlanTools,
  decideContinuation,
  groupPlanSession,
  isSubstantiveRound,
  mentionedMembers,
  type AutoMember,
} from '../cluster-auto.js';

let dir: string;
const ENV_KEYS = ['SHE_CLUSTER_AUTO', 'SHE_CLUSTER_AUTO_MAX', 'SHE_CLUSTER_AUTO_STALL', 'SHE_CLUSTER_PLAN'];
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-cluster-auto-'));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const ROOM_55C2 = [
  { id: 'leader', name: '领导', phase: 'lead' },
  { id: 'eng#1', name: '研发1', phase: 'work' },
  { id: 'eng#2', name: '研发2', phase: 'work' },
  { id: 'eng#3', name: '研发3', phase: 'work' },
  { id: 'review', name: '审查', phase: 'review' },
] as AutoMember[];

describe('decideContinuation', () => {
  it('room 55c2ec65: the leader assigning work in the summary continues with exactly those members', () => {
    const d = decideContinuation({
      members: ROOM_55C2,
      roundStartedAt: Date.now(),
      roundMessages: [
        { role: 'user', name: '用户', content: '寻找C盘的垃圾文件' },
        { role: 'eng#1', name: '研发1', content: '【研发1 · 系统级只读扫描方案 v1】…' },
        { role: 'review', name: '审查', content: '【审查 · 安全分级与验收口径 v1】…' },
        {
          role: 'leader',
          name: '领导',
          content: '【领导 · 汇总与下一步裁决】\n**4. 交付与时间** 研发1/2/3 按上述口径重跑。\n'
            + '@研发1 @研发2 @研发3 开工，回报只贴：总大小、Top5 目录、被拒目录数、是否达标。@审查 准备终版复核。',
        },
      ],
    });
    assert.equal(d.proceed, true, d.reason);
    assert.deepEqual(d.targets.map((m) => m.name), ['研发1', '研发2', '研发3', '审查']);
  });

  it('stops on a question to the user, on 【收工】, and when nothing is assigned', () => {
    const base = { members: ROOM_55C2, roundStartedAt: Date.now() };
    const ask = decideContinuation({ ...base, roundMessages: [{ role: 'leader', name: '领导', content: '@研发1 扫哪个盘？' }] });
    assert.equal(ask.proceed, false);
    assert.match(ask.reason, /回答问题/);
    const done = decideContinuation({ ...base, roundMessages: [{ role: 'leader', name: '领导', content: '研发1：已完成。【收工】' }] });
    assert.equal(done.proceed, false);
    const idle = decideContinuation({ ...base, roundMessages: [{ role: 'leader', name: '领导', content: '总结：报告见上。' }] });
    assert.equal(idle.proceed, false);
  });

  it('a member promising more work is picked up even without a mention', () => {
    const d = decideContinuation({
      members: ROOM_55C2,
      roundStartedAt: Date.now(),
      roundMessages: [
        { role: 'eng#2', name: '研发2', content: '方案如上，我接下来去执行扫描并回填表格。' },
        { role: 'leader', name: '领导', content: '汇总：方向没问题。' },
      ],
    });
    assert.equal(d.proceed, true);
    assert.deepEqual(d.targets.map((m) => m.name), ['研发2']);
  });

  /**
   * 用户自己的 @ 必须有实际效果。
   *
   * 报告出来的是"单轮"观感：领导汇报而不分派（"总结：报告见上。"）时这一轮就结束了，目标没做完却
   * 要用户再来推一次。用户点名过的成员不该等这个——那是房间里最强的指令。
   */
  it('a user mention keeps the wave going when the leader only reports', () => {
    const workers = ROOM_55C2.filter((m) => m.phase !== 'lead');
    const mention = mentionedMembers('@研发1 复查 C 盘，顺便把日志贴出来', workers);
    assert.deepEqual(mention.map((m) => m.name), ['研发1'], '先证明 goal 里确实解析出了点名');

    const base = {
      members: ROOM_55C2,
      roundStartedAt: Date.now(),
      roundMessages: [{ role: 'leader', name: '领导', content: '总结：报告见上。' }],
    };
    // 没有点名时，仍然是原来的规则：没有分派就停。
    assert.equal(decideContinuation(base).proceed, false);
    // 点名后继续，且目标就是被点的人。
    const d = decideContinuation({ ...base, userDirective: mention });
    assert.equal(d.proceed, true, d.reason);
    assert.deepEqual(d.targets.map((m) => m.name), ['研发1']);
    assert.ok(d.why.some((w) => w.includes('用户点名')), d.why.join('；'));
  });

  it('a user mention adds to the leader\'s assignment instead of replacing it', () => {
    const workers = ROOM_55C2.filter((m) => m.phase !== 'lead');
    const d = decideContinuation({
      members: ROOM_55C2,
      roundStartedAt: Date.now(),
      roundMessages: [{ role: 'leader', name: '领导', content: '@研发3 接着跑。' }],
      userDirective: mentionedMembers('@研发1 你也看一下', workers),
    });
    assert.equal(d.proceed, true);
    // 顺序按成员表来（不是按插入顺序）：研发1 在研发3 之前。
    assert.deepEqual(d.targets.map((m) => m.name), ['研发1', '研发3']);
  });

  /**
   * 点名的效力不能盖过明确收口，否则一次点名会让房间一直跑到轮数上限。
   */
  it('a user mention does NOT override 收工 or a question to the user', () => {
    const workers = ROOM_55C2.filter((m) => m.phase !== 'lead');
    const directive = mentionedMembers('@研发1 去做', workers);
    const done = decideContinuation({
      members: ROOM_55C2,
      roundStartedAt: Date.now(),
      roundMessages: [{ role: 'leader', name: '领导', content: '全部完成。【收工】' }],
      userDirective: directive,
    });
    assert.equal(done.proceed, false, done.reason);
    assert.match(done.reason, /收工/);
    const ask = decideContinuation({
      members: ROOM_55C2,
      roundStartedAt: Date.now(),
      roundMessages: [{ role: 'leader', name: '领导', content: '先清理哪个目录？' }],
      userDirective: directive,
    });
    assert.equal(ask.proceed, false, ask.reason);
    assert.match(ask.reason, /回答问题/);
  });
});

describe('mentionedMembers', () => {
  const seats = ROOM_55C2.filter((m) => m.phase !== 'lead');
  it('a role name addresses every seat; a seat name only that seat', () => {
    assert.deepEqual(mentionedMembers('@研发 继续', seats).map((m) => m.name), ['研发1', '研发2', '研发3']);
    assert.deepEqual(mentionedMembers('@研发2 补扫', seats).map((m) => m.name), ['研发2']);
    assert.deepEqual(mentionedMembers('@全体 开工', seats).length, seats.length);
  });
  it('a 分工 row counts, a row reporting a finished result does not', () => {
    assert.deepEqual(mentionedMembers('- 研发1：补扫 Prefetch', seats).map((m) => m.name), ['研发1']);
    assert.deepEqual(mentionedMembers('- 研发1：已完成，清单已交付', seats), []);
  });
});

describe('isSubstantiveRound', () => {
  it('acknowledgements and repeats are not progress; new work is', () => {
    const earlier = [{ role: 'eng#1', name: '研发1', content: '系统临时目录合计 3.2GB，Top5 如下：……（很长的一段具体结果）' }];
    assert.equal(isSubstantiveRound([{ role: 'eng#1', name: '研发1', content: '收到，我会按口径重跑。' }], earlier, ROOM_55C2), false);
    assert.equal(isSubstantiveRound([{ ...earlier[0] }], earlier, ROOM_55C2), false);
    assert.equal(
      isSubstantiveRound([{ role: 'eng#1', name: '研发1', content: '重跑完成：C:\\Windows\\Temp 1.1GB，Temp 2.0GB，被拒目录 3 个，达标。' }], earlier, ROOM_55C2),
      true,
    );
  });
});

describe('clusterAutoSettings', () => {
  it('follows automation mode and the env caps', () => {
    assert.equal(clusterAutoSettings({ automationMode: true }, {}).enabled, true);
    assert.equal(clusterAutoSettings({ automationMode: true }, {}).maxRounds, 20);
    assert.equal(clusterAutoSettings({ automationMode: false }, {}).enabled, false);
    assert.equal(clusterAutoSettings({ automationMode: true }, { SHE_CLUSTER_AUTO: '0' }).enabled, false);
    assert.equal(clusterAutoSettings({ automationMode: true }, { SHE_CLUSTER_AUTO_MAX: '3' }).maxRounds, 3);
  });
});

describe('createGroupPlanTools', () => {
  it('scopes plans to the room', async () => {
    const other = new PlanStore(dir, 'chat-1').create('别的会话', ['a']);
    const tools = createGroupPlanTools(dir, 'r1');
    assert.deepEqual(tools.definitions.map((d) => d.name).sort(), ['plan_add_steps', 'plan_create', 'plan_get', 'plan_update']);
    assert.match(await tools.execute('plan_update', { step_id: 's1', status: 'done' }), /还没有计划/);
    assert.match(await tools.execute('plan_create', { title: 'G', steps: ['研发：扫描', '审查：复核'] }), /Created plan/);
    assert.match(await tools.execute('plan_create', { title: 'G2', steps: ['x'] }), /已经有进行中的计划/);
    assert.match(await tools.execute('plan_update', { plan_id: other.id, step_id: 's1', status: 'done' }), /不是本群的计划/);
    assert.match(await tools.execute('plan_update', { step_id: 's1', status: 'done' }), /已更新/);
    assert.equal(tools.current()?.sessionId, groupPlanSession('r1'));
    assert.equal(tools.current()?.steps[0].status, 'done');
    assert.equal(new PlanStore(dir).get(other.id)?.steps[0].status, 'active');
  });
});

// ─── runClusterWave with a scripted model ───────────────────────────────────

interface Call { name: string; phase: string; user: string; tools?: ToolDefinition[] }
type Script = (c: Call, n: number, msgs: LLMMessage[]) => Partial<LLMMessage> | Promise<Partial<LLMMessage>>;

function fakeFactory(script: Script, calls: Call[]) {
  const perMember = new Map<string, number>();
  return (): LLMProvider => ({
    name: 'fake',
    async chat(messages, tools, onChunk?: (c: StreamChunk) => void) {
      const sys = String(messages[0]?.content ?? '');
      const name = /你是：([^（\n]+)（/.exec(sys)?.[1] ?? '?';
      const phase = /阶段：([^\n]+)/.exec(sys)?.[1] ?? '?';
      const call = { name, phase, user: String(messages[1]?.content ?? ''), tools };
      // Only the first request of a member turn counts as a turn (tool follow-ups do not).
      if (messages.length === 2) calls.push(call);
      const n = perMember.get(name) ?? 0;
      if (messages.length === 2) perMember.set(name, n + 1);
      const out = await script(call, messages.length === 2 ? n : n - 1, messages);
      if (out.content) onChunk?.({ type: 'text', content: out.content });
      return { role: 'assistant', content: out.content ?? '', tool_calls: out.tool_calls };
    },
  });
}

function setup(roles: Record<string, number> = { leader: 1, eng: 1, review: 1 }) {
  const store = new ClusterStore(dir);
  const room = store.create(dir, 't');
  const all = buildDefaultRoles(dir).map((r) => ({ ...r, count: roles[r.key] ?? 0 }));
  store.setRoles(room.id, all, dir);
  const config = {
    llm: { apiKey: 'k', provider: 'openai', model: 'm', baseUrl: 'http://x', maxTokens: 1, temperature: 0 },
    workspace: { root: dir },
    automationMode: true,
  } as unknown as SheConfig;
  return { store, roomId: room.id, config };
}

const OUTPUTS = [
  '系统临时目录：C:\\Windows\\Temp 共 1.2GB，其中 7 天前的文件 980MB，可安全清理。',
  '用户缓存：Chrome Cache 640MB、Edge Cache 210MB、缩略图缓存 90MB，均可重建。',
  '更新残留：SoftwareDistribution\\Download 2.3GB；Windows.old 不存在；CBS 日志 150MB。',
  '大文件 Top5：hiberfil.sys 6.4GB（KEEP）、pagefile.sys 4GB（KEEP）、D3DSCache 300MB（SAFE）。',
  '重复文件线索：Downloads 下 3 组安装包重复，合计 1.1GB，需用户确认后处理。',
];
const work = (i: number) => OUTPUTS[(i - 1) % OUTPUTS.length];

describe('runClusterWave automation', () => {
  it('continues after the leader assigns work, only with the assignee, until 【收工】 — append-only', async () => {
    const { store, roomId, config } = setup();
    const calls: Call[] = [];
    let summaries = 0;
    let afterRound1: string[] = [];
    const room = await runClusterWave({
      config, store, roomId, goal: '寻找C盘的垃圾文件',
      providerFactory: fakeFactory((c, n) => {
        if (c.name === '领导' && c.phase === '汇总与下一步') {
          summaries++;
          if (summaries === 1) {
            afterRound1 = store.get(roomId)!.messages.map((m) => m.id);
            return { content: '裁决如下。@研发 开工，回报总大小。' };
          }
          return { content: '全部完成【收工】' };
        }
        if (c.name === '研发') return { content: work(n + 1) };
        return { content: `${c.name} 的意见：验收口径 A、B、C，逐条复核路径 C:\\x。` };
      }, calls),
    });
    assert.equal(room.status, 'idle');
    const seq = calls.map((c) => `${c.name}/${c.phase}`);
    assert.deepEqual(seq, [
      '领导/拆解与分工', '研发/并行产出', '审查/并行审查', '领导/汇总与下一步',
      '研发/并行产出', '领导/汇总与下一步',
    ]);
    // Append-only: everything from round 1 is still there, in order, unchanged.
    assert.deepEqual(room.messages.slice(0, afterRound1.length).map((m) => m.id), afterRound1);
    assert.ok(room.messages.some((m) => m.role === 'system' && m.content.includes('自动续跑 第 1/20 轮')));
    // Prefix cache: the member's second prompt extends its first.
    const [p1, p2] = calls.filter((c) => c.name === '研发').map((c) => c.user);
    assert.ok(p2.startsWith(p1.slice(0, p1.lastIndexOf('\n\n'))), 'second prompt must extend the first');
  });

  it('automation mode off keeps the single wave', async () => {
    const { store, roomId, config } = setup();
    (config as { automationMode: boolean }).automationMode = false;
    const calls: Call[] = [];
    await runClusterWave({
      config, store, roomId, goal: 'g',
      providerFactory: fakeFactory((c) => ({ content: c.name === '领导' ? '@研发 开工' : work(1) }), calls),
    });
    assert.equal(calls.length, 4);
  });

  /**
   * 用户 "@名字" 的端到端效果：领导只汇报、不分派时，被点名的成员仍然开工。
   *
   * 修之前这里只会跑 1 轮（4 次调用），也就是"我不管就没人会去执行"。
   */
  it('keeps working for a user-mentioned member even when the leader only reports', async () => {
    process.env.SHE_CLUSTER_AUTO_MAX = '1';
    const { store, roomId, config } = setup();
    const calls: Call[] = [];
    const room = await runClusterWave({
      config, store, roomId, goal: '@研发 扫一遍 C 盘的垃圾文件',
      providerFactory: fakeFactory((c, n) => {
        if (c.name === '领导') return { content: '总结：报告见上。' };
        return { content: work(n + 1) };
      }, calls),
    });
    assert.equal(room.status, 'idle');
    // 单轮是 4 次调用（拆解/产出/审查/汇总）；多出来的一轮说明点名生效。
    assert.ok(calls.length > 4, `点名后应有自动续跑，实际只有 ${calls.length} 次调用`);
    assert.equal(calls.filter((c) => c.name === '研发').length, 2);
    assert.ok(room.messages.some((m) => m.content.includes('用户点名')), '续跑说明里要写明是用户点名');
    assert.match(room.messages[room.messages.length - 1].content, /自动续跑结束/);
  });

  it('stops after two rounds without substantive output', async () => {
    const { store, roomId, config } = setup();
    const calls: Call[] = [];
    const room = await runClusterWave({
      config, store, roomId, goal: 'g',
      providerFactory: fakeFactory((c) => ({ content: c.name === '领导' ? '@研发 继续' : '收到，马上做。' }), calls),
    });
    assert.equal(calls.filter((c) => c.name === '研发').length, 3); // wave + 2 auto rounds
    assert.match(room.messages[room.messages.length - 1].content, /连续 2 轮没有新的实质产出/);
  });

  it('respects SHE_CLUSTER_AUTO_MAX', async () => {
    process.env.SHE_CLUSTER_AUTO_MAX = '1';
    const { store, roomId, config } = setup();
    const calls: Call[] = [];
    const room = await runClusterWave({
      config, store, roomId, goal: 'g',
      providerFactory: fakeFactory((c, n) => ({ content: c.name === '领导' ? '@研发 继续' : work(n + 1) }), calls),
    });
    assert.equal(calls.filter((c) => c.name === '研发').length, 2);
    assert.match(room.messages[room.messages.length - 1].content, /上限 1 轮/);
  });

  it('a group plan drives the next rounds to the step owners', async () => {
    const { store, roomId, config } = setup();
    const calls: Call[] = [];
    const room = await runClusterWave({
      config, store, roomId, goal: 'g',
      providerFactory: fakeFactory((c, n, msgs) => {
        const followUp = msgs.length > 2;
        if (c.name === '领导' && c.phase === '拆解与分工' && !followUp) {
          assert.ok(c.tools?.some((t) => t.name === 'plan_create'), 'leader gets plan tools');
          return {
            tool_calls: [{
              id: 't1', type: 'function',
              function: { name: 'plan_create', arguments: JSON.stringify({ title: '盘点', steps: ['研发：扫描', { title: '审查：复核', dependsOn: ['s1'] }] }) },
            }],
          };
        }
        if (c.name === '领导') return { content: followUp ? '计划已建。' : '按计划推进。' };
        if (followUp) return { content: `${c.name} 已更新计划。` };
        if (c.name === '研发' && n >= 1) {
          return { tool_calls: [{ id: 'u1', type: 'function', function: { name: 'plan_update', arguments: '{"step_id":"s1","status":"done"}' } }] };
        }
        if (c.name === '审查' && n >= 1) {
          return { tool_calls: [{ id: 'u2', type: 'function', function: { name: 'plan_update', arguments: '{"step_id":"s2","status":"done"}' } }] };
        }
        return { content: work(n + 1) };
      }, calls),
    });
    const seq = calls.map((c) => `${c.name}/${c.phase}`);
    assert.deepEqual(seq.slice(4), [
      '研发/并行产出', '领导/汇总与下一步', // s1 runnable → its owner
      '审查/并行审查', '领导/汇总与下一步', // s2 runnable → its owner
    ]);
    const plan = new PlanStore(dir, groupPlanSession(roomId)).mine();
    assert.equal(plan, undefined, 'plan is closed');
    assert.ok(room.messages.some((m) => m.content.includes('〔plan_create〕')));
  });

  it('stopClusterRun interrupts a running wave cleanly', async () => {
    const { store, roomId, config } = setup();
    const calls: Call[] = [];
    const room = await runClusterWave({
      config, store, roomId, goal: 'g',
      providerFactory: fakeFactory((c) => {
        if (c.name === '研发') {
          stopClusterRun(roomId);
          return { content: work(1) };
        }
        return { content: '@研发 开工' };
      }, calls),
    });
    assert.equal(room.status, 'idle');
    assert.equal(room.messages[room.messages.length - 1].content, '（已中断）');
    assert.ok(!calls.some((c) => c.phase === '汇总与下一步'));
  });
});
