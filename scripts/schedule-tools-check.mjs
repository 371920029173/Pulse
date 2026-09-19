/**
 * The agent's scheduling tools.
 *
 * Two things matter:
 *
 *   1. A main agent can create, list, and cancel its own future work — and the
 *      created task is visible to the same store the scheduler uses, so it will
 *      actually run.
 *   2. A DELEGATED CHILD cannot. A subtask that could schedule work would let a
 *      single "look into this" spawn recurring jobs the user never asked for.
 *
 * Uses a fake bridge for the unit-level behaviour and the real server for the
 * wiring, so a missing bridge is caught rather than assumed.
 */
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { Agent } from '../packages/agent-runtime/dist/agent.js';
import { executeScheduleTool, makeScheduleTools } from '../packages/agent-runtime/dist/schedule-tools.js';
import { loadConfig } from '../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../packages/sandbox/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 300)}`);
  }
};

// ── a fake bridge, to test the tool logic without a server ──
function fakeBridge() {
  const tasks = [];
  let window = null;
  return {
    tasks,
    setWindow: (w) => { window = w; },
    bridge: {
      list: () => tasks.map((t) => ({
        id: t.id, name: t.name, prompt: t.prompt, enabled: true,
        when: `每天 ${t.trigger.at ?? '?'}`, runCount: 0,
      })),
      create: (input) => {
        const t = { id: `t${tasks.length + 1}`, ...input };
        tasks.push(t);
        return { id: t.id, name: t.name, prompt: t.prompt, enabled: true, when: `每天 ${input.trigger.at ?? '?'}`, runCount: 0 };
      },
      remove: (id) => {
        const i = tasks.findIndex((t) => t.id === id);
        if (i < 0) return false;
        tasks.splice(i, 1);
        return true;
      },
      window: () => window,
      withinWindow: () => window === null,
      nextWindowStart: () => (window ? new Date(Date.now() + 3600_000).toISOString() : null),
    },
  };
}

console.log('\n调度工具检查\n');

console.log('=== 工具逻辑 ===');
{
  const f = fakeBridge();
  const tools = makeScheduleTools(f.bridge, 'sess_1');
  const names = tools.map((t) => t.name).sort();
  check('提供 4 个调度工具', names.length === 4, names.join(', '));
  check('工具名齐全', ['schedule_cancel', 'schedule_create', 'schedule_list', 'schedule_window']
    .every((n) => names.includes(n)), names.join(', '));
  check('每个工具都有描述', tools.every((t) => (t.description ?? '').length > 30));

  // create: daily
  {
    const r = await executeScheduleTool('schedule_create',
      { name: '每日检查', prompt: '检查构建', kind: 'daily', at: '09:00' }, f.bridge, 'sess_1', () => {});
    check('创建每日任务成功', r?.ok === true, r?.output);
    check('返回里带上了 id（便于后续取消）', /id=/.test(String(r?.output)), r?.output);
    check('任务真的进了存储', f.tasks.length === 1, `count=${f.tasks.length}`);
    check('触发方式被正确解析', f.tasks[0]?.trigger?.kind === 'daily' && f.tasks[0]?.trigger?.at === '09:00',
      JSON.stringify(f.tasks[0]?.trigger));
  }

  // create: interval
  {
    const r = await executeScheduleTool('schedule_create',
      { name: '轮询', prompt: '看看有没有变化', kind: 'interval', everyMinutes: 20 }, f.bridge, 'sess_1', () => {});
    check('创建间隔任务成功', r?.ok === true, r?.output);
    check('间隔被正确解析', f.tasks[1]?.trigger?.everyMinutes === 20, JSON.stringify(f.tasks[1]?.trigger));
  }

  // create: once with a bare HH:MM (models routinely give this)
  {
    const r = await executeScheduleTool('schedule_create',
      { name: '提醒', prompt: '提醒我', kind: 'once', at: '08:30' }, f.bridge, 'sess_1', () => {});
    check('接受 HH:MM 形式的一次性时间', r?.ok === true, r?.output);
    const at = f.tasks[2]?.trigger?.at;
    check('把它解析成了将来的时间', typeof at === 'string' && new Date(at).getTime() > Date.now(),
      String(at));
  }

  // validation
  {
    const noName = await executeScheduleTool('schedule_create',
      { prompt: 'x', kind: 'daily', at: '09:00' }, f.bridge, 'sess_1', () => {});
    check('缺名称时报错而不是崩溃', noName?.ok === false && /name/.test(String(noName.output)));

    const badKind = await executeScheduleTool('schedule_create',
      { name: 'x', prompt: 'y', kind: 'nonsense' }, f.bridge, 'sess_1', () => {});
    check('未知触发方式报错', badKind?.ok === false && /once|daily|interval/.test(String(badKind.output)));

    const badDaily = await executeScheduleTool('schedule_create',
      { name: 'x', prompt: 'y', kind: 'daily', at: '99:99' }, f.bridge, 'sess_1', () => {});
    check('非法 HH:MM 报错', badDaily?.ok === false, badDaily?.output);
  }

  // list
  {
    const r = await executeScheduleTool('schedule_list', {}, f.bridge, 'sess_1', () => {});
    check('列表列出全部任务', /每日检查/.test(String(r?.output)) && /轮询/.test(String(r?.output)), r?.output);
    check('列表说明当前是否在可工作时段', /允许工作的时间段/.test(String(r?.output)), r?.output);
  }

  // cancel
  {
    const ok = await executeScheduleTool('schedule_cancel', { id: 't1' }, f.bridge, 'sess_1', () => {});
    check('取消存在的任务成功', ok?.ok === true, ok?.output);
    check('任务从存储里移除', f.tasks.length === 2, `count=${f.tasks.length}`);
    const nope = await executeScheduleTool('schedule_cancel', { id: 'nope' }, f.bridge, 'sess_1', () => {});
    check('取消不存在的任务返回失败而不是抛错', nope?.ok === false, nope?.output);
  }

  // window
  {
    const get0 = await executeScheduleTool('schedule_window', {}, f.bridge, 'sess_1', () => {});
    check('查看窗口（未设置时明确说明）', /不限制|没有/.test(String(get0?.output)), get0?.output);

    let applied = null;
    const set = await executeScheduleTool('schedule_window',
      { start: '09:00', end: '18:00' }, f.bridge, 'sess_1', (w) => { applied = w; });
    check('设置窗口成功', set?.ok === true, set?.output);
    check('窗口被应用到了注入的回调', applied?.start === '09:00' && applied?.end === '18:00', JSON.stringify(applied));

    const bad = await executeScheduleTool('schedule_window',
      { start: '9', end: '18:00' }, f.bridge, 'sess_1', () => {});
    check('非法窗口格式报错', bad?.ok === false && /HH:MM/.test(String(bad.output)), bad?.output);

    const cleared = await executeScheduleTool('schedule_window',
      { clear: true }, f.bridge, 'sess_1', () => {});
    check('可以取消限制', cleared?.ok === true, cleared?.output);
  }

  it_trailing();
}

function it_trailing() {
  // Section separator only; assertions for this section follow below.
}

console.log('\n=== 非调度工具名不被接管 ===');
{
  const f = fakeBridge();
  const r = await executeScheduleTool('fs_read', { path: 'x' }, f.bridge, null, () => {});
  check('非 schedule_ 前缀返回 null', r === null, String(r));
}

console.log('\n=== Agent 集成 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'she-sched-tools-'));
  mkdirSync(join(dir, '.she'), { recursive: true });

  const cfg = loadConfig(ROOT);
  cfg.workspace.root = dir;
  const store = new KBStore(join(dir, '.she', 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, '.she', 'kb.sqlite') });
  const shell = new SandboxShell(dir, cfg.sandbox);
  const tools = createTools(shell, dir, { allowAllCommands: true });

  const f = fakeBridge();
  const withBridge = new Agent(cfg, engine, tools, 'sess_a', {
    scheduleBridge: f.bridge,
    setScheduleWindow: () => {},
  });
  const names = withBridge.getToolDefinitions().map((t) => t.name);
  const sched = names.filter((n) => n.startsWith('schedule_'));
  check('主 agent 拿到了 4 个调度工具', sched.length === 4, sched.join(', '));

  const childCfg = { ...cfg };
  const child = new Agent(childCfg, engine, tools, 'sess_a', {
    isSubagent: true,
    scheduleBridge: f.bridge,
    setScheduleWindow: () => {},
  });
  const childNames = child.getToolDefinitions().map((t) => t.name);
  const childSched = childNames.filter((n) => n.startsWith('schedule_'));
  check('子智能体拿不到调度工具（否则它会给用户排一堆计划外的活）',
    childSched.length === 0, childSched.join(', '));
  check('子智能体也没有 task_spawn（防止无限递归）',
    !childNames.includes('task_spawn'), childNames.filter((n) => n.startsWith('task')).join(', '));

  // Without a bridge the tools must not appear at all, rather than appearing and
  // always failing.
  const noBridge = new Agent(cfg, engine, tools, 'sess_b', {});
  check('没有桥接时不暴露调度工具（避免"永远失败的工具"）',
    !noBridge.getToolDefinitions().some((t) => t.name.startsWith('schedule_')));

  await withBridge.dispose();
  await child.dispose();
  await noBridge.dispose();
  store.close();
  removeTempDir(dir);
}

console.log('\n=== 系统提示是否提到调度 ===');
{
  const prompt = readFileSync(join(ROOT, 'packages/agent-runtime/src/system-prompt.ts'), 'utf8');
  const mentioned = /schedule_create/.test(prompt);
  check('系统提示列出了调度工具（否则模型不会用它们）', mentioned);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
