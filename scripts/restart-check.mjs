/**
 * Everything survives a restart — including an abrupt one.
 *
 *   node scripts/restart-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * "Settings are not kept, changes are not kept, and history is not read" was the complaint
 * that started this project's cleanup. The fixes are real — an atomic `.env` writer, a
 * versioned state file with quarantine-and-recover, a startup session picker that prefers one
 * with messages — but every existing test exercises ONE process. None of them ever restarted a
 * server.
 *
 * That gap matters because the whole class of bug lives in the seam: what was written to disk,
 * whether the next boot reads the same file, and whether the two disagree about a key name or a
 * schema version. A test that mutates state and reads it back in the same process cannot see
 * any of that; it is the reason the original defect shipped at all.
 *
 * So this boots a server, makes changes through the API, KILLS it without a graceful shutdown,
 * boots a second server, and checks every piece of state is back. The hard kill is deliberate:
 * it is the case a user actually hits (crash, power loss, task manager) and the one where a
 * non-atomic write leaves a truncated file.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { request } from 'node:http';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');

let PORT = Number(process.env.SHE_RESTART_TEST_PORT || 0);
if (!PORT) PORT = await pickSafePort(18300);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

function raw(path, { method = 'GET', body } = {}) {
  return new Promise((resolveP) => {
    const u = new URL(BASE + path);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolveP({ status: res.statusCode, text }));
      },
    );
    req.on('error', (e) => resolveP({ status: 0, text: String(e.message) }));
    if (payload) req.write(payload);
    req.end();
  });
}
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let workspace = null;
let appDir = null;
let child = null;

async function boot(label) {
  if (!existsSync(SERVER_ENTRY)) {
    console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
    process.exit(1);
  }
  /*
   * Pin every path in the CHILD environment, not only in the .env file.
   *
   * Ambient variables beat `.env`, so a developer who has exported SHE_PORT or SHE_APP_DIR
   * would otherwise make this check talk to their own running server — and "everything
   * persisted" would be reporting on a server that was never restarted.
   */
  child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      SHE_ENV_FILE: join(workspace, '.env'),
      SHE_PORT: String(PORT),
      SHE_WORKSPACE: workspace,
      SHE_APP_DIR: appDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  const t0 = Date.now();
  for (;;) {
    const probe = await raw('/api/health');
    if (probe.status === 200) return;
    if (Date.now() - t0 > 40_000) {
      console.error(`${label} 未能就绪:\n${out.slice(-1200)}`);
      await kill();
      process.exit(1);
    }
    await sleep(300);
  }
}

/** Kill without a graceful shutdown, the way a crash or the task manager does. */
async function kill() {
  if (!child) return;
  const pid = child.pid;
  child = null;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  // Wait for the port to actually free, rather than guessing at a sleep.
  for (let i = 0; i < 60; i++) {
    const probe = await raw('/api/health');
    if (probe.status === 0) return;
    await sleep(200);
  }
}

workspace = mkdtempSync(join(tmpdir(), 'she-restart-'));
appDir = join(workspace, 'appdir');
mkdirSync(join(workspace, '.she'), { recursive: true });
mkdirSync(appDir, { recursive: true });

const ENV_BODY = [
  '# user comment that must survive',
  'OPENAI_API_KEY=not-used-by-this-check',
  'OPENAI_BASE_URL=http://127.0.0.1:1',
  `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
  `SHE_APP_DIR=${appDir.replace(/\\/g, '/')}`,
  `SHE_PORT=${PORT}`,
  '',
].join('\n');
writeFileSync(join(workspace, '.env'), ENV_BODY, 'utf8');

/* ─────────────── First boot: make changes ─────────────── */

await boot('第一次启动');

const created = {};

// 1. Settings.
{
  const r = await raw('/api/settings', {
    method: 'PUT',
    body: { model: 'restart-probe-model', thinkingLevel: 'xhigh', maxTokens: 4096 },
  });
  check('设置写入返回 200', r.status === 200, `status=${r.status}`);
}

// 2. Skill profile.
{
  const r = await raw('/api/skills/profile', { method: 'PUT', body: { profile: 'liberal' } });
  check('技能档位写入返回 200', r.status === 200, `status=${r.status}`);
}

// 3. A session WITH messages, and a second empty one created afterwards.
//    Startup must prefer the one with content — picking the empty one is what made history
//    look like it had vanished.
{
  const a = await raw('/api/sessions', { method: 'POST', body: { title: '有内容的会话' } });
  created.session = json(a)?.id;
  check('会话创建成功', Boolean(created.session), `status=${a.status}`);

  await raw('/api/chat/history', {
    method: 'PUT',
    body: {
      session_id: created.session,
      messages: [
        { role: 'user', content: '重启后我应该还在' },
        { role: 'assistant', content: '我在。' },
      ],
    },
  });
  await sleep(300);

  const b = await raw('/api/sessions', { method: 'POST', body: { title: '空的新会话' } });
  created.emptySession = json(b)?.id;
  check('空会话也创建成功（用来验证启动选择逻辑）', Boolean(created.emptySession), `status=${b.status}`);
}

// 4. A work group with a custom role.
{
  const r = await raw('/api/cluster/rooms', { method: 'POST', body: { title: '重启验证群' } });
  const room = json(r);
  created.room = room?.id;
  check('讨论群创建成功', Boolean(created.room), `status=${r.status}`);

  // Roles are an ARRAY, and a new one is identified by `name` — the earlier guess at
  // `{key,label}` was rejected, which is why these shapes are read off the running server
  // rather than assumed.
  if (created.room) {
    const rr = await raw(`/api/cluster/rooms/${created.room}/roles`, {
      method: 'POST',
      body: { name: '验证角色', title: '专门用来验证重启', count: 2, phase: 'work' },
    });
    check('自定义角色新增成功', rr.status < 300, `status=${rr.status} body=${rr.text.slice(0, 100)}`);
  }
}

// 5. A scheduled task and a working window.
{
  const r = await raw('/api/schedule', {
    method: 'POST',
    // `kind`, not `type` — validated server-side, and the wrong key is a 400 rather than a
    // silently-never-firing task.
    body: { name: '重启验证任务', prompt: '检查持久化', trigger: { kind: 'daily', at: '03:30' } },
  });
  created.task = json(r)?.id ?? json(r)?.task?.id;
  check('定时任务创建成功', Boolean(created.task), `status=${r.status} body=${r.text.slice(0, 140)}`);

  const w = await raw('/api/schedule/window', {
    method: 'PUT',
    body: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  });
  check('允许工作的时间段写入成功', w.status === 200, `status=${w.status} body=${w.text.slice(0, 100)}`);
}

// 6. A memo.
{
  const r = await raw('/api/memo', { method: 'POST', body: { text: '重启后这条备忘要还在' } });
  check('备忘创建成功', r.status === 201, `status=${r.status}`);
}

// 7. A custom skill file.
{
  const r = await raw('/api/skills/save', {
    method: 'POST',
    body: { profile: 'custom', name: 'restart-probe.md', content: '# 重启验证技能\n' },
  });
  check('技能文件保存成功', r.status < 300, `status=${r.status}`);
}

// 8. A user stylesheet.
{
  const r = await raw('/api/theme', { method: 'PUT', body: { css: ':root { --accent: #abcdef; }' } });
  check('自定义样式保存成功', r.status === 200, `status=${r.status}`);
}

// 9. Theme-independent settings that previously had the layered-config bug.
{
  const r = await raw('/api/settings', { method: 'PUT', body: { automationMode: true, allowAllCommands: false } });
  check('自动化相关设置写入成功', r.status === 200, `status=${r.status}`);
}

// Give the writer a moment, then kill HARD.
await sleep(600);
await kill();

/*
 * Nothing may be lost even though the process was killed mid-flight.
 *
 * The `.env` must still be valid: an atomic writer is what keeps this true, and a torn write
 * here is the original defect (the file was rewritten in place).
 */
{
  const envText = readFileSync(join(workspace, '.env'), 'utf8');
  check('.env 硬杀后仍然存在且非空', envText.trim().length > 0, `${envText.length} 字节`);
  check('.env 保留了用户注释', envText.includes('# user comment that must survive'), '');

  const keys = [...envText.matchAll(/^([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
  check('.env 没有重复键（重复会让读取结果不确定）', new Set(keys).size === keys.length,
    keys.filter((k, i) => keys.indexOf(k) !== i).join(', ') || '无');

  /*
   * Every meaningful line must still be a well-formed assignment.
   *
   * This is the check that catches a torn write: if the process died mid-rewrite, the file
   * would end in a partial line like `SHE_ALLOW_ALL_COMMANDS=tr` — which parses as a value,
   * silently, and is exactly how a setting ends up "not kept".
   */
  const bad = envText.split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .filter((l) => !/^[A-Z0-9_]+\s*=/.test(l.trim()));
  check('.env 每一行都是完整的赋值（没有半截行）', bad.length === 0,
    bad.join(' / ').slice(0, 120));
}

/* ─────────────── Second boot: everything must be back ─────────────── */

await boot('第二次启动');

// Settings.
{
  const s = json(await raw('/api/settings'));
  check('设置：模型保留', s?.llm?.model === 'restart-probe-model', `model=${s?.llm?.model}`);
  check('设置：思考强度保留', s?.llm?.thinkingLevel === 'xhigh', `thinkingLevel=${s?.llm?.thinkingLevel}`);
  check('设置：maxTokens 保留', Number(s?.llm?.maxTokens) === 4096, `maxTokens=${s?.llm?.maxTokens}`);
  check('设置：自动化模式保留', s?.automationMode === true, `automationMode=${s?.automationMode}`);
  check('设置：允许所有命令保留', s?.sandbox?.allowAllCommands === false, `allowAllCommands=${s?.sandbox?.allowAllCommands}`);
  check('设置：技能档位保留', s?.skills?.profile === 'liberal', `profile=${s?.skills?.profile}`);
}

// Session and its history.
{
  const list = json(await raw('/api/sessions'));
  const ids = (list?.sessions ?? list ?? []).map((x) => x.id);
  check('会话：两个会话都还在', ids.includes(created.session) && ids.includes(created.emptySession),
    `ids=${ids.join(',')}`);

  const h = json(await raw(`/api/chat/history?session_id=${created.session}`));
  const msgs = h?.messages ?? [];
  check('会话：历史消息保留', msgs.length === 2, `${msgs.length} 条`);
  check('会话：消息内容正确', msgs[0]?.content === '重启后我应该还在', JSON.stringify(msgs[0]?.content));

  /*
   * The startup pick. An empty session created last must not win: choosing it is exactly what
   * made the user think their history had been deleted on restart.
   */
  const act = json(await raw('/api/sessions'));
  const active = act?.active_id ?? act?.activeId;
  // The full list is in the detail because the interesting failure is "active points at a
  // session that is neither of these two", and the two ids alone do not say which one it is.
  // (`messages` is stripped from this payload, so the background flag and the timestamp are
  // what identify a candidate here, not a count.)
  const dump = (act?.sessions ?? [])
    .map((s) => `${s.id}${s.background ? '(后台)' : ''}@${s.updated_at}`)
    .join(' ');
  check('会话：重启后激活的是有内容的那条（否则看起来像历史丢了）',
    !active || active === created.session,
    `active=${active} 有内容=${created.session} 空会话=${created.emptySession} 全部=${dump}`);
}

// Work group.
{
  const r = json(await raw('/api/cluster/rooms'));
  const rooms = r?.rooms ?? r ?? [];
  const room = rooms.find((x) => x.id === created.room);
  check('讨论群保留', Boolean(room), `rooms=${rooms.length}`);
  check('讨论群的自定义角色保留',
    Boolean(room) && JSON.stringify(room.roles ?? []).includes('验证角色'),
    JSON.stringify(room?.roles ?? []).slice(0, 100));
}

// Scheduled task.
{
  const r = json(await raw('/api/schedule'));
  const tasks = r?.tasks ?? [];
  const task = tasks.find((x) => x.id === created.task);
  check('定时任务保留', Boolean(task), `tasks=${tasks.length}`);
  check('定时任务的时间保留', task?.trigger?.at === '03:30', JSON.stringify(task?.trigger));

  // The working window is `workingWindow` here, and its fields are `start`/`end`.
  const win = r?.workingWindow;
  check('允许工作的时间段保留',
    Boolean(win && win.start === '09:00' && win.end === '18:00'),
    JSON.stringify(win));
  check('工作时间段的星期保留',
    Boolean(win) && JSON.stringify(win.days) === JSON.stringify([1, 2, 3, 4, 5]),
    JSON.stringify(win?.days));

  /*
   * A run of this task must not have taken the conversation.
   *
   * Whether the scheduler fires inside this check's window is timing-dependent, so the session
   * may or may not exist — but if it does, it is a job log, not the user's chat: it must be
   * marked `background` and it must not be `active_id`. The assertion above ("the one that
   * opens is the one with content") catches the end effect; this pins the mechanism, so the
   * check fails for the right reason even when the scheduler happens not to fire.
   */
  const sessionsAfter = json(await raw('/api/sessions'));
  const job = (sessionsAfter?.sessions ?? []).find((s) => s.title === '重启验证任务');
  if (job) {
    check('定时任务的会话标成后台', job.background === true, JSON.stringify(job.background));
    check('定时任务的会话不是当前对话',
      (sessionsAfter?.active_id ?? sessionsAfter?.activeId) !== job.id,
      `active=${sessionsAfter?.active_id} job=${job.id}`);
  } else {
    check('定时任务这一刻没有产生会话（也就无从抢走当前对话）', true, '');
  }
}

// Memo. The list is `{ entries: [...] }`.
{
  const r = json(await raw('/api/memo'));
  const list = r?.entries ?? [];
  check('备忘保留', list.some((m) => m.text === '重启后这条备忘要还在'),
    list.map((m) => m.text).join(' | ').slice(0, 80));
}

// Skill file.
{
  const r = await raw('/api/skills/files?profile=custom');
  check('自定义技能文件保留', r.text.includes('restart-probe.md'), r.text.slice(0, 140));
}

// Stylesheet.
{
  const t = json(await raw('/api/theme'));
  check('自定义样式保留', t?.css === ':root { --accent: #abcdef; }', JSON.stringify(t?.css));
}

/* ─────────────── Third boot: a corrupted state file must not lose data ─────────────── */

await kill();

{
  // Truncate the session file the way a partial write would.
  const sessionsFile = join(workspace, '.she', 'sessions.json');
  if (existsSync(sessionsFile)) {
    const text = readFileSync(sessionsFile, 'utf8');
    writeFileSync(sessionsFile, text.slice(0, Math.floor(text.length / 2)), 'utf8');
  }
}

await boot('第三次启动（状态文件已损坏）');

{
  const list = json(await raw('/api/sessions'));
  const ids = (list?.sessions ?? []).map((x) => x.id);
  check('损坏的状态文件不会让服务起不来', Array.isArray(ids) && ids.length > 0,
    `${ids.length} 个会话`);

  /*
   * The data must be kept, not discarded.
   *
   * `quarantine()` renames to `<file>.unusable-<timestamp>` — deliberately not `rm`, because
   * the point is that a corrupt file may still hold recoverable conversations. Asserting the
   * suffix alone would pass on an empty placeholder, so the backup's CONTENT is checked too.
   */
  const dir = join(workspace, '.she');
  const backups = existsSync(dir) ? readdirSync(dir).filter((n) => n.includes('.unusable-')) : [];
  check('损坏的文件被留底（后缀 .unusable-）', backups.length > 0, backups.join(', ') || '（没找到）');

  const withData = backups.filter((n) => {
    try { return readFileSync(join(dir, n), 'utf8').trim().length > 0; } catch { return false; }
  });
  check('留底的文件里有原始内容（不是空壳）', withData.length > 0,
    backups.map((n) => `${n}:${readFileSync(join(dir, n), 'utf8').length}B`).join(', '));

  // And the app must still be usable: the recovered state is empty, not broken.
  const created = await raw('/api/sessions', { method: 'POST', body: { title: '损坏后新建' } });
  check('损坏恢复后仍能新建会话', created.status === 201, `status=${created.status}`);
}

// ── 4. 【关键】遗留的工作区壁纸副本会被清理，但不是重复的绝不动 ──
//
//      The wallpaper moved to the app directory (a user preference, like the theme), and the old
//      version's workspace-local copy was never cleaned up — 146 MB of dead video inside a
//      project directory on this machine. Deleting the wrong file here is worse than leaving it
//      alone, so the rule is narrow and the non-duplicate cases are asserted explicitly.
{
  const legacyDir = join(workspace, '.she', 'background');
  const globalDir = join(appDir, 'background');
  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  const DUP = 'she-test-dup.mp4';
  const ONLY_WORKSPACE = 'she-test-only-workspace.mp4';
  const DIFFERENT = 'she-test-different.mp4';

  // A true duplicate: same name, same size.
  writeFileSync(join(legacyDir, DUP), 'AAAA-duplicate-bytes', 'utf8');
  writeFileSync(join(globalDir, DUP), 'AAAA-duplicate-bytes', 'utf8');

  // Only in the workspace: never touched, it may be the user's own file.
  writeFileSync(join(legacyDir, ONLY_WORKSPACE), 'user file, not ours', 'utf8');

  // Same name, different size: NOT a duplicate, so it must be kept.
  writeFileSync(join(legacyDir, DIFFERENT), 'short', 'utf8');
  writeFileSync(join(globalDir, DIFFERENT), 'much longer content', 'utf8');

  await kill();
  await boot('遗留壁纸清理');

  check('重复的工作区壁纸副本被清掉', !existsSync(join(legacyDir, DUP)), join(legacyDir, DUP));
  check('只存在于工作区的文件不会被删（可能是用户自己的）',
    existsSync(join(legacyDir, ONLY_WORKSPACE)), join(legacyDir, ONLY_WORKSPACE));
  check('同名但大小不同的文件不会被删（不是重复）',
    existsSync(join(legacyDir, DIFFERENT)), join(legacyDir, DIFFERENT));
  check('清理不会动到全局壁纸', existsSync(join(globalDir, DUP)) && existsSync(join(globalDir, DIFFERENT)),
    `dup=${existsSync(join(globalDir, DUP))} diff=${existsSync(join(globalDir, DIFFERENT))}`);
}

await kill();
/*
 * Keep the workspace when something failed, so the state file can be inspected.
 *
 * A failing restart check is a claim about what is ON DISK; without the file there is nothing
 * to look at but the symptom. The path is printed so it can be opened directly.
 */
if (results.every((r) => r.ok)) {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
} else {
  console.log(`\n  （有失败，保留工作区以便排查：${workspace}）`);
}

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${!r.ok && r.detail ? ` — ${r.detail}` : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
