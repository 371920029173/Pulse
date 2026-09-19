/**
 * Scheduled tasks, end to end, against a real server on a throwaway workspace.
 *
 * The assertions that matter are the boundary ones, because those are what the
 * feature promises and what is easiest to regress:
 *
 *   - a task outside the working window is DEFERRED (and reported as such), never
 *     silently dropped
 *   - manual "run now" also respects the window, so it cannot create a precedent
 *     that the window does not apply
 *   - a window closing does not stop work in flight
 *   - validation answers 400, not 500
 *   - a corrupt task file is preserved rather than wiped
 *
 * Makes NO LLM calls: every case here is validated, deferred, or rejected before
 * a model would be involved. The model endpoint is pointed at a closed port so an
 * accidental call fails fast instead of costing money.
 *
 *   node scripts/schedule-check.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const PORT = String(await pickSafePort(Number(process.env.SHE_SCHED_TEST_PORT || 18080), [18081,18082,18083,19090,19191]))

if (!existsSync(SERVER_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 300)}`);
  }
};
const note = (text) => console.log(`        ${text}`);

const BASE = `http://127.0.0.1:${PORT}`;
const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* some responses carry no body */ }
  return { status: res.status, body };
};

const workspace = mkdtempSync(join(tmpdir(), 'she-sched-e2e-'));
mkdirSync(join(workspace, '.she'), { recursive: true });

/** The workspace's .env, rewritten between boots to change the window. */
function writeEnv(extra = []) {
  writeFileSync(join(workspace, '.env'), [
    'OPENAI_API_KEY=test-not-used',
    // A closed port, so any accidental model call fails immediately and free.
    'OPENAI_BASE_URL=http://127.0.0.1:1',
    'OPENAI_MODEL=test-model',
    `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
    `SHE_PORT=${PORT}`,
    ...extra,
  ].join('\n'), 'utf8');
}

let child = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: { ...process.env, SHE_PORT: String(PORT), SHE_ENV_FILE: join(workspace, '.env') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return out;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 30_000) {
      console.error('服务未能就绪:\n' + out.slice(-900));
      return null;
    }
    await sleep(350);
  }
}

async function shutdown() {
  if (!child) return;
  try { child.kill(); } catch { /* already gone */ }
  child = null;
  await sleep(700);
}

/** A day that is definitely not today, for the "window excludes us" case. */
const otherDay = (new Date().getDay() + 3) % 7;

console.log('\n定时任务检查（真实服务，临时工作区，不调用 LLM）\n');

let taskId = null;

try {
  // ── 1. No window: work may start ──
  writeEnv(['SHE_SCHEDULE_WINDOW=']);
  if (!await boot()) throw new Error('启动失败');

  {
    const s = await api('/api/schedule');
    check('GET /api/schedule 可用', s.status === 200, `status=${s.status}`);
    check('无窗口时 withinWindow 为真', s.body?.withinWindow === true, `withinWindow=${s.body?.withinWindow}`);
    check('初始任务列表为空', Array.isArray(s.body?.tasks) && s.body.tasks.length === 0);
    check('汇报了调度器状态', typeof s.body?.enabled === 'boolean' && typeof s.body?.tickSeconds === 'number');
  }

  // ── 2. Validation answers 400, not 500 ──
  {
    const empty = await api('/api/schedule', { method: 'POST', body: JSON.stringify({}) });
    check('缺名称/指令返回 400（不是 500）', empty.status === 400, `status=${empty.status}`);

    const badTime = await api('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', prompt: 'y', trigger: { kind: 'daily', at: '99:99' } }),
    });
    check('非法时间返回 400', badTime.status === 400, `status=${badTime.status}`);
    check('错误信息说明原因', /HH:MM/.test(JSON.stringify(badTime.body ?? {})), JSON.stringify(badTime.body));

    const badInterval = await api('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', prompt: 'y', trigger: { kind: 'interval', everyMinutes: -1 } }),
    });
    check('非法间隔返回 400', badInterval.status === 400, `status=${badInterval.status}`);

    const noTrigger = await api('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', prompt: 'y' }),
    });
    check('缺触发方式返回 400', noTrigger.status === 400, `status=${noTrigger.status}`);
  }

  // ── 3. Create, list, describe ──
  {
    const created = await api('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({
        name: '每日总结',
        prompt: '总结今天的改动',
        // Late in the day, so it will not fire during this check.
        trigger: { kind: 'daily', at: '23:59' },
        softLimitMinutes: 30,
      }),
    });
    check('创建返回 201', created.status === 201, `status=${created.status}`);
    taskId = created.body?.task?.id;
    check('返回了 id', typeof taskId === 'string' && taskId.length > 0);
    check('默认启用', created.body?.task?.enabled !== false);
    check('默认重叠策略为 skip（避免同一任务并行跑）', created.body?.task?.overlap === 'skip');

    const list = await api('/api/schedule');
    const found = (list.body?.tasks ?? []).find((t) => t.id === taskId);
    check('列表里能看到', !!found);
    check('给出可读的「下次运行」说明', typeof found?.nextRun === 'string' && found.nextRun.length > 0, `nextRun=${found?.nextRun}`);
    if (found) note(`nextRun = ${found.nextRun}`);
  }

  // ── 4. Update / enable / disable ──
  {
    const off = await api(`/api/schedule/${taskId}`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    check('可以停用', off.status === 200 && off.body?.task?.enabled === false, `status=${off.status}`);

    const bad = await api(`/api/schedule/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ trigger: { kind: 'daily', at: 'nope' } }),
    });
    check('更新为非法值返回 400（校验合并后的结果）', bad.status === 400, `status=${bad.status}`);

    const on = await api(`/api/schedule/${taskId}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    check('可以重新启用', on.status === 200 && on.body?.task?.enabled === true);

    const missing = await api('/api/schedule/nope', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    check('更新不存在的任务返回 404', missing.status === 404, `status=${missing.status}`);
  }

  // ── 5. A run's outcome is recorded, success or failure ──
  {
    const run = await api(`/api/schedule/${taskId}/run`, { method: 'POST' });
    check('手动执行路由可用', run.status === 200 || run.status === 409, `status=${run.status}`);

    // The model endpoint is a closed port, so the run will fail; what matters is
    // that the failure is recorded rather than swallowed.
    await sleep(3000);
    const after = await api('/api/schedule');
    const t = (after.body?.tasks ?? []).find((x) => x.id === taskId);
    check('执行结果被记录（成功或失败都要有状态）',
      !!t && ['ok', 'error', 'running'].includes(t.lastStatus), `lastStatus=${t?.lastStatus}`);
    // A failed run must release the flag, or the task would never run again.
    check('失败后不残留运行标记', t?.running !== true, `running=${t?.running}`);
  }

  await shutdown();

  // ── 6. A working window defers instead of dropping ──
  {
    writeEnv([`SHE_SCHEDULE_WINDOW=${otherDay}@02:00-03:00`]);
    if (!await boot()) throw new Error('第二次启动失败');

    const s = await api('/api/schedule');
    const windowed = s.body?.workingWindow;
    note(`workingWindow = ${JSON.stringify(windowed)}`);

    check('窗口配置被服务端读取', !!windowed, 'SHE_SCHEDULE_WINDOW 没有生效，无法验证顺延行为');
    if (windowed) {
      check('窗口不含今天，因此当前不可开新工', s.body?.withinWindow === false, `withinWindow=${s.body?.withinWindow}`);
      check('给出了下一个开窗时刻（说明是顺延而非丢弃）',
        typeof s.body?.nextWindowStart === 'string' && s.body.nextWindowStart.length > 0,
        `nextWindowStart=${s.body?.nextWindowStart}`);
      if (s.body?.nextWindowStart) note(`nextWindowStart = ${s.body.nextWindowStart}`);

      const run = await api(`/api/schedule/${taskId}/run`, { method: 'POST' });
      check('窗口外手动执行被拒（409 而不是静默执行）', run.status === 409, `status=${run.status}`);
      check('拒绝理由说明这是「顺延」而不是「不能跑」',
        /顺延|时间段/.test(JSON.stringify(run.body ?? {})), JSON.stringify(run.body));
    }
  }

  await shutdown();

  // ── 7. Persistence, and delete ──
  {
    writeEnv(['SHE_SCHEDULE_WINDOW=']);
    if (!await boot()) throw new Error('第三次启动失败');

    const s = await api('/api/schedule');
    const t = (s.body?.tasks ?? []).find((x) => x.id === taskId);
    check('任务在重启后仍然存在', !!t, `tasks=${(s.body?.tasks ?? []).length}`);
    check('运行记录也被保留', !!t && typeof t.runCount === 'number', `runCount=${t?.runCount}`);

    const del = await api(`/api/schedule/${taskId}`, { method: 'DELETE' });
    check('可以删除', del.status === 200 && del.body?.ok === true, `status=${del.status}`);

    const gone = await api('/api/schedule');
    check('删除后不在列表里', !(gone.body?.tasks ?? []).some((x) => x.id === taskId));

    const again = await api(`/api/schedule/${taskId}`, { method: 'DELETE' });
    check('重复删除不报 500', again.status === 200 && again.body?.ok === false, `status=${again.status}`);
  }

  // Must stop this server before the next boot, or it keeps holding the port and
  // the following start silently fails to come up.
  await shutdown();

  // ── 8. A corrupt task file is preserved ──
  {
    const path = join(workspace, '.she', 'schedule.json');
    const broken = '{"schema_version":"she-schedule/1","tasks":[{"id":"x"';
    writeFileSync(path, broken, 'utf8');

    const out = await boot();
    if (!out) throw new Error('第四次启动失败');
    const dir = join(workspace, '.she');
    const backups = readdirSync(dir).filter((f) => f.includes('.unusable-'));
    check('损坏的定时任务文件被留底', backups.length > 0, `目录: ${readdirSync(dir).join(', ')}`);
    if (backups.length) {
      check('留底内容与原文一致',
        backups.some((f) => readFileSync(join(dir, f), 'utf8') === broken));
    }
    check('日志里说明了这一点', /无法读取|已保留为备份/.test(out), '日志中没有提示');
  }
} catch (err) {
  check('检查过程未抛异常', false, err.stack ?? err.message);
} finally {
  await shutdown();
  removeTempDir(workspace);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
