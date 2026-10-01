/**
 * Data-safety regression checks.
 *
 *   node scripts/data-safety-check.mjs
 *
 * Spawns the real server against throwaway workspaces to verify that state
 * recovery can never destroy existing data.
 *
 * Why this exists as a test rather than a comment: an earlier build silently
 * overwrote a 299KB session history with an 856-byte file from a different
 * directory. The cause was `recoverLegacyState` treating "has sessions but no
 * messages" as "unusable" and replacing the file wholesale, while also
 * accepting `process.cwd()` as a recovery source — so the outcome depended on
 * how the server happened to be launched.
 *
 * This is the kind of bug that only shows up in production, so it gets pinned
 * down here.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { removeTempDir } from './lib/temp.mjs';
import { killTree } from './lib/kill-tree.mjs';
import { pickSafePort } from './safe-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
/*
 * The app port is picked, not hardcoded, using the same helper the app itself uses.
 *
 * A fixed number can land in a Windows-reserved TCP block (see the note on the stub's port below),
 * which turns this suite into `listen EACCES` for reasons that have nothing to do with data safety.
 * `pickSafePort` skips excluded ranges and probes an actual bind.
 */
const PORT = String(await pickSafePort(Number(process.env.SHE_TEST_PORT) || 5598));
/*
 * The install's own `.env` must not be part of a test run.
 *
 * `updateEnvFile` writes `SHE_WORKSPACE` on every workspace switch, and the server resolves the
 * settings file from the install root — not from the throwaway workspace it was handed. Without the
 * override below, a section that switches workspaces rewrites the REAL `.env` to point at a temp
 * directory. That is not theoretical: on 2026-09-27 a run of this suite left
 * `SHE_WORKSPACE=C:\...\Temp\she-safety-cacheA-…` in the install's `.env`, the desktop window then
 * restarted the backend (it had gone away) and it came up mounted on that temp directory, from which
 * it wrote the temp project into the user's app-level project index — the sidebar then listed a
 * phantom project whose chats answered 404.
 *
 * Every other boot-based suite here already passes `SHE_ENV_FILE`; this one was the exception.
 */
const ENV_FILE = join(ROOT, '.env');
/** Snapshot taken before the first boot; compared against at the end (see the guard below). */
const envBefore = existsSync(ENV_FILE) ? readFileSync(ENV_FILE) : null;
function isolatedEnv(workspace) {
  return {
    ...process.env,
    SHE_ENV_FILE: join(workspace, '.env'),
    SHE_WORKSPACE: workspace,
    SHE_PORT: PORT,
    SHE_APP_DIR: join(workspace, 'appdir'),
  };
}
if (!existsSync(SERVER_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
  process.exit(1);
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/**
 * The parts of a session list that constitute the user's data.
 *
 * Deliberately NOT a raw byte comparison. A schema version bump legitimately
 * rewrites the file, and asserting byte equality would fail for a reason that has
 * nothing to do with data loss — which trains people to just re-record the
 * expectation. What must never change is the conversations themselves.
 */
function sessionFingerprint(parsed) {
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  return JSON.stringify(sessions.map((s) => ({
    id: s.id,
    title: s.title,
    messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
    firstMessage: Array.isArray(s.messages) && s.messages[0] ? s.messages[0].content : null,
    closed: s.closed ?? false,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
}

/** Build a workspace with a pre-seeded session store (or none). */
function makeWorkspace(label, sessions) {
  const dir = mkdtempSync(join(tmpdir(), `she-safety-${label}-`));
  mkdirSync(join(dir, '.she'), { recursive: true });
  if (sessions) {
    writeFileSync(join(dir, '.she', 'sessions.json'), JSON.stringify(sessions, null, 2), 'utf8');
  }
  return dir;
}

/**
 * Wait until nothing answers on PORT any more.
 *
 * Replaces a fixed `await sleep(800)` after the kill, which encoded an assumption about how fast the
 * machine is — and that assumption is what fails under load. Every `bootOnce` in this file reuses the
 * same `PORT`, so if the previous server is still shutting down, the NEXT section's health poll is
 * answered by the PREVIOUS process: `healthy` comes back true, but it is a server on another
 * workspace, and the section then reads the wrong directory.
 *
 * Observed exactly that in a full `check:offline` run: `损坏的讨论组文件同样被留底` failed with
 * `原文没有保留` while the same file passed 6/6 standalone, and the neighbouring assertions about the
 * same quarantine (read back through the API, i.e. against a server the section did talk to) passed —
 * the giveaway that two different servers were involved.
 */
async function waitForPortClosed(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true; // nothing is listening: the port is genuinely free
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Start the server on a throwaway workspace, wait for boot, then stop it. */
/**
 * Boot the server on a throwaway workspace, let recovery finish, then stop it.
 *
 * Also probes `/api/sessions` while it is up, because several assertions are about the app being
 * USABLE after recovery rather than merely about the process starting — "the server came up" was the
 * whole condition of two assertions that could therefore never fail.
 *
 * `probe` runs while the server is still up, for checks that need several requests against one
 * process (a workspace switch, say) rather than a single boot-and-look.
 */
async function bootOnce(workspace, probe) {
  /*
   * Refuse to start on a port that something else is holding. Without this, a leftover server makes
   * the health poll below succeed against the wrong process, and every assertion in the section is
   * then about a workspace we never booted.
   */
  if (!await waitForPortClosed()) {
    console.error(`端口 ${PORT} 在本段启动前仍被占用 —— 以下断言可能读到别的服务，不能当成有效结果`);
  }

  const child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    // Pinned in the child environment, not only in the workspace: ambient variables win over the
    // `.env`, so an exported SHE_PORT would make this probe the developer's own server. SHE_ENV_FILE
    // keeps the install's `.env` out of it entirely — see the note next to `PORT`.
    env: isolatedEnv(workspace),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  const healthy = await new Promise((ok) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) { clearInterval(iv); ok(true); return; }
      } catch { /* not up yet */ }
      if (Date.now() - t0 > 30_000) { clearInterval(iv); ok(false); }
    }, 400);
  });

  /** What `/api/sessions` answered, so "still usable" can be asserted rather than assumed. */
  let sessionsProbe = { status: 0, isArray: false };
  if (healthy) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { signal: AbortSignal.timeout(3000) });
      const body = await r.json();
      sessionsProbe = { status: r.status, isArray: Array.isArray(body?.sessions) };
    } catch { /* left as the failed default */ }
  }

  if (healthy && probe) {
    try { await probe(`http://127.0.0.1:${PORT}`); } catch (err) { console.error(`probe 失败: ${err.message}`); }
  }

  // Recovery runs during boot; give it a moment to finish writing.
  await new Promise((r) => setTimeout(r, 2000));
  killTree(child.pid);
  /*
   * Wait for the port to actually close rather than for a fixed interval. The child we killed is the
   * one that answered above, so this is the handshake that makes the NEXT section's health poll
   * meaningful. If it does not close, say so instead of letting the next section read a stray server.
   */
  if (!await waitForPortClosed()) {
    console.error(`端口 ${PORT} 在 15 秒内仍被占用 —— 下一段可能读到本段这个服务`);
  }
  return { healthy, out, sessionsProbe };
}

const EMPTY_SESSIONS = (title) => ({
  schema_version: 'she-sessions/0.1',
  active_id: 's1',
  sessions: [{ id: 's1', title, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', messages: [] }],
});

const WITH_MESSAGES = {
  schema_version: 'she-sessions/0.1',
  active_id: 's1',
  sessions: [{
    id: 's1', title: '有历史', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    messages: [{ role: 'user', content: '重要对话' }],
  }],
};

console.log('\n数据安全回归（会启动真实服务，用临时工作区）\n');

// ── 1. The exact shape that lost data before ──
{
  const ws = makeWorkspace('empty', EMPTY_SESSIONS('空会话但存在'));
  const file = join(ws, '.she', 'sessions.json');
  const before = sessionFingerprint(JSON.parse(readFileSync(file, 'utf8')));
  const { healthy } = await bootOnce(ws);
  const after = existsSync(file) ? sessionFingerprint(JSON.parse(readFileSync(file, 'utf8'))) : null;
  record(
    '「有会话但没消息」不被覆盖（曾因此丢过 299KB 历史）',
    healthy && after === before,
    after === before ? '' : `内容被改写了: ${before} -> ${after}`,
  );
  removeTempDir(ws);
}

// ── 2. Normal case must also be preserved ──
{
  const ws = makeWorkspace('full', WITH_MESSAGES);
  const file = join(ws, '.she', 'sessions.json');
  const before = sessionFingerprint(JSON.parse(readFileSync(file, 'utf8')));
  const { healthy } = await bootOnce(ws);
  const after = existsSync(file) ? sessionFingerprint(JSON.parse(readFileSync(file, 'utf8'))) : null;
  record('有消息的会话保持原样', healthy && after === before, after === before ? '' : `内容被改写了: ${before} -> ${after}`);
  removeTempDir(ws);
}

// ── 3. An empty workspace may legitimately be recovered ──
{
  const ws = makeWorkspace('none', null);
  const file = join(ws, '.she', 'sessions.json');
  const { sessionsProbe } = await bootOnce(ws);
  const recovered = existsSync(file);
  /*
   * The condition used to be bare `healthy` — "the process started" — which is not what this is
   * about. A workspace with no state must still produce a USABLE conversation list, and that is what
   * is asserted now: the endpoint answers 200 with an array. Delete the whole recovery path and this
   * still fails if the app can no longer start without a state file.
   */
  record(
    '空工作区启动后会话列表可用（不是 500，也不是非数组）',
    sessionsProbe.status === 200 && sessionsProbe.isArray,
    `status=${sessionsProbe.status} isArray=${sessionsProbe.isArray}${recovered ? '（已从别处恢复）' : ''}`,
  );
  removeTempDir(ws);
}

// ── 4. A corrupt file: the quarantine suffix and the preserved bytes ──
//      This section used to assert `healthy` (again) while looking for a `.bak-` suffix that the code
//      has never written — the real suffix is `.unusable-`. Both halves were wrong, so it reported a
//      tick whatever happened. The property is now checked directly: the bytes must survive under the
//      name the code actually uses.
{
  const ws = makeWorkspace('backup', null);
  const file = join(ws, '.she', 'sessions.json');
  const original = JSON.stringify({
    schema_version: 'she-sessions/0.2',
    active_id: null,
    sessions: [{ id: 'keepme', title: '要保住的内容', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', messages: [] }],
  });
  // Corrupt it in the way a torn write does: valid prefix, truncated tail.
  writeFileSync(file, `${original.slice(0, Math.floor(original.length / 2))}`, 'utf8');
  const truncated = readFileSync(file, 'utf8');

  const { healthy } = await bootOnce(ws);
  const sheDir = join(ws, '.she');
  const quarantined = readdirSync(sheDir).filter((f) => f.includes('.unusable-'));
  const preserved = quarantined.some((f) => readFileSync(join(sheDir, f), 'utf8') === truncated);

  record(
    '损坏文件按 .unusable- 留底（.bak- 从来没被写过）',
    healthy && quarantined.length > 0,
    quarantined.length ? `备份: ${quarantined.join(', ')}` : `没有留底（目录: ${readdirSync(sheDir).join(', ')}）`,
  );
  record('留底的是原始字节，不是空壳', preserved, preserved ? '' : '备份内容与原始损坏内容不一致');
  removeTempDir(ws);
}

// ── 5. A corrupt file must be quarantined, never silently emptied ──
{
  const ws = makeWorkspace('corrupt', null);
  const file = join(ws, '.she', 'sessions.json');
  // A truncated write: the realistic way this happens.
  const broken = '{"schema_version":"she-sessions/0.2","active_id":null,"sessions":[{"id":"s1"';
  writeFileSync(file, broken, 'utf8');

  const { healthy, out } = await bootOnce(ws);
  const sheDir = join(ws, '.she');
  const quarantined = readdirSync(sheDir).filter((f) => f.includes('.unusable-'));
  const survived = quarantined.some((f) => readFileSync(join(sheDir, f), 'utf8') === broken);

  record(
    '损坏的会话文件被隔离保留，而不是清空（曾会静默毁掉全部历史）',
    healthy && survived,
    survived ? `备份: ${quarantined.join(', ')}` : `没有留下原文备份（目录: ${readdirSync(sheDir).join(', ')}）`,
  );
  record(
    '损坏时明确告知用户（否则等同于"记录莫名其妙没了"）',
    /无法读取|已保留为备份/.test(out),
    /无法读取|已保留为备份/.test(out) ? '' : '日志里没有提示',
  );
  removeTempDir(ws);
}

// ── 6. A file from an unknown (newer) version must not be guessed at ──
{
  const ws = makeWorkspace('future', null);
  const file = join(ws, '.she', 'sessions.json');
  const future = JSON.stringify({
    schema_version: 'she-sessions/9.9',
    active_id: null,
    sessions: [{ id: 'future1', title: '来自未来版本', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', messages: [] }],
  });
  writeFileSync(file, future, 'utf8');

  const { healthy } = await bootOnce(ws);
  const sheDir = join(ws, '.she');
  const kept = readdirSync(sheDir)
    .filter((f) => f.includes('.unusable-'))
    .some((f) => readFileSync(join(sheDir, f), 'utf8') === future);

  record('未知版本的会话文件被原样留底（降级后不丢数据）', healthy && kept, kept ? '' : '原文没有保留');
  removeTempDir(ws);
}

// ── 7. A corrupt work-group file must be handled the same way ──
{
  const ws = makeWorkspace('rooms', null);
  const clusterDir = join(ws, '.she', 'cluster');
  mkdirSync(clusterDir, { recursive: true });
  const broken = '{"schema_version":"2","rooms":[{"id":"r1","title":"重要讨论组"';
  writeFileSync(join(clusterDir, 'rooms.json'), broken, 'utf8');

  const { healthy } = await bootOnce(ws);
  const kept = readdirSync(clusterDir)
    .filter((f) => f.includes('.unusable-'))
    .some((f) => readFileSync(join(clusterDir, f), 'utf8') === broken);
  record('损坏的讨论组文件同样被留底，不会静默清空', healthy && kept, kept ? '' : '原文没有保留');
  removeTempDir(ws);
}

// ── 8. An older but valid version must be MIGRATED, not quarantined ──
{
  const ws = makeWorkspace('oldver', null);
  const file = join(ws, '.she', 'sessions.json');
  writeFileSync(file, JSON.stringify({
    schema_version: 'she-sessions/0.1',
    active_id: 's1',
    sessions: [{
      id: 's1', title: '老版本会话', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      messages: [{ role: 'user', content: '老版本的重要内容' }],
    }],
  }, null, 2), 'utf8');

  const { healthy } = await bootOnce(ws);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  const keptMessage = JSON.stringify(after).includes('老版本的重要内容');
  const quarantined = readdirSync(join(ws, '.she')).filter((f) => f.includes('.unusable-'));
  const bumped = after.schema_version !== 'she-sessions/0.1';

  record(
    '旧版本文件就地升级，内容完整保留（不是当成损坏隔离掉）',
    healthy && keptMessage && bumped && quarantined.length === 0,
    keptMessage
      ? `版本 ${after.schema_version}${quarantined.length ? '，但出现了隔离' : ''}`
      : '内容丢失了',
  );
  removeTempDir(ws);
}

// ── 9. A request aimed at an unknown session must not land in someone else's ──
/*
 * The shape of a real loss: `POST /api/chat {"session_id": "sess_typo"}`.
 *
 * `persistHistory` used to have no branch for an id the store did not know, so it fell through to
 * `syncActive` — which writes into the ACTIVE conversation. Measured: a 29-message conversation was
 * replaced by the four messages of the request that addressed an unknown id, and the file went from
 * 786KB to 290KB. The model is a local stub here because what is under test is where the transcript
 * is written, not what was said.
 */
{
  const ws = makeWorkspace('unknown-id', {
    schema_version: 'she-sessions/0.1',
    active_id: 's1',
    sessions: [
      {
        id: 's1', title: '用户正在读的会话',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        messages: [{ role: 'user', content: '重要对话一' }, { role: 'assistant', content: '重要回答' }],
      },
      {
        id: 's2', title: '另一个会话',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        messages: [{ role: 'user', content: '另一个会话的内容' }],
      },
    ],
  });
  const file = join(ws, '.she', 'sessions.json');
  const only = (parsed, ids) => sessionFingerprint({
    sessions: (parsed?.sessions ?? []).filter((s) => ids.includes(s.id)),
  });

  const stub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '收到。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  /*
   * The stub's port comes from the OS, not from `PORT + 1`.
   *
   * Windows reserves blocks of TCP ports (Hyper-V/WSL roll a fresh set every time the VM starts) and
   * binding inside one fails with EACCES while nothing is listening. `PORT + 1` landed in such a
   * block on 2026-09-29 — reserved range 5545-5644 — so this suite died with `listen EACCES:
   * 127.0.0.1:5599`, which reads like a defect in the code under test and is nothing of the sort.
   * Listening on 0 cannot collide: the OS only hands out ports that are free and not excluded.
   */
  const llmPort = stub.address().port;
  const child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...isolatedEnv(ws),
      SHE_LLM_PROVIDER: 'openai',
      OPENAI_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      OPENAI_MODEL: 'stub',
      OPENAI_API_KEY: 'stub-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const healthy = await new Promise((ok) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) { clearInterval(iv); ok(true); return; }
      } catch { /* not up yet */ }
      if (Date.now() - t0 > 30_000) { clearInterval(iv); ok(false); }
    }, 400);
  });

  const before = only(JSON.parse(readFileSync(file, 'utf8')), ['s1', 's2']);
  let status = 0;
  let body = '';
  if (healthy) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'sess_typo_does_not_exist', message: '你好' }),
        signal: AbortSignal.timeout(60_000),
      });
      status = r.status;
      body = await r.text();
    } catch (err) {
      body = `fetch failed: ${err.message}`;
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  killTree(child.pid);
  try { stub.close(); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 800));

  const after = JSON.parse(readFileSync(file, 'utf8'));
  const survived = only(after, ['s1', 's2']) === before;
  const homed = (after.sessions ?? []).some((s) => s.id === 'sess_typo_does_not_exist');
  record(
    '【关键】向不存在的 session id 发消息，不改写别的会话（曾把 786KB 历史压成 290KB）',
    healthy && survived,
    survived ? '' : `被改写了: ${before} -> ${only(after, ['s1', 's2'])}`,
  );
  record(
    '被寻址的 id 有它自己的归处（要么新建，要么被明确拒绝）',
    !healthy || homed || status >= 400,
    `status=${status}${homed ? '，已为它建了会话' : ''}`,
  );
  record('屏幕上正在读的会话没有被换掉', after.active_id === 's1', `active_id=${after.active_id}`);
  if (status >= 400) record('拒绝时说清了为什么', body.length > 0, body.slice(0, 200));
  removeTempDir(ws);
}

// ── 10. 打开另一个项目的会话，不能把会话轨道里的东西弄丢 ──
{
  /*
   * The shape the user hit on 2026-09-27: they had a chat pinned to another project (an old copy of
   * the same project, from before it was moved) and clicking it made a work group vanish from the
   * rail — while the agent in the first chat simultaneously lost its knowledge base, because the
   * switch remounted the KB and closed the store that agent was holding.
   *
   * Both come from one place: opening a chat that lives in another directory mounts THAT project,
   * swapping the state directory (sessions AND rooms) and remounting the KB. What must not happen is
   * either store going missing from the user's view, or a live agent losing its database.
   */
  const sessionsOf = (id, title, directory) => ({
    schema_version: 'she-sessions/0.1',
    active_id: id,
    sessions: [{
      id,
      title,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      messages: [],
      ...(directory ? { directory } : {}),
    }],
  });

  const wsA = makeWorkspace('switchA', sessionsOf('sess_a', 'A 的会话'));
  // B's chat names B as its own directory — that mismatch is the whole trigger for the switch.
  const wsB = makeWorkspace('switchB');
  writeFileSync(
    join(wsB, '.she', 'sessions.json'),
    JSON.stringify(sessionsOf('sess_b', 'B 的会话', wsB), null, 2),
    'utf8',
  );

  let roomListed = false;
  let chatSurvived = false;
  let roomOpens = false;
  let writeLanded = false;
  let seen = '';
  let switchDetail = '';

  const { healthy } = await bootOnce(wsA, async (base) => {
    const call = async (method, path, body) => {
      const r = await fetch(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      let parsed = null;
      try { parsed = await r.json(); } catch { /* not json */ }
      return { status: r.status, body: parsed };
    };

    // A work group belonging to A, created while A is the mounted project.
    const created = await call('POST', '/api/cluster/rooms', { title: '切换前的工作群' });
    const roomId = created.body?.id;
    if (!roomId) { switchDetail = `建群失败 status=${created.status}`; return; }

    /*
     * Visit B and come back before clicking: the app-level project index only records the directory
     * a switch moves TO, so this is what makes B's chat findable at all — and it is also why a real
     * user's rail keeps showing projects they have visited.
     */
    await call('POST', '/api/workspaces/switch', { root: wsB });
    await call('POST', '/api/workspaces/switch', { root: wsA });

    // The click: a chat pinned to another directory activates ITS project.
    const clicked = await call('POST', '/api/sessions/sess_b/activate');
    switchDetail = `click status=${clicked.status}`;

    const rail = await call('GET', '/api/conversations');
    const items = Array.isArray(rail.body?.items) ? rail.body.items : [];
    seen = items.map((i) => `${i.kind}:${i.id}`).join(' ') || '(空)';
    /*
     * 点开 B 的会话 = 把 B 挂载进来，所以轨道此后就该是 **B 的**。
     *
     * 这一段原先断言的是"群和 A 的会话仍留在轨道里"。那是旧契约：轨道把所有已知项目的会话合并
     * 成一条列表。2026-10-01 按用户的要求改掉了 —— "在一个工作区里只能看到属于这一个工作区的
     * chat"，"我看到别的项目的对话"就是用户一直在报的那件事。合并列表存在的理由是"切走会掉东西"，
     * 而"会切走"本身正是合并列表造成的，这个循环被拆掉之后两边都不需要了。
     *
     * 所以这里改钉新契约的两头：
     *   - 轨道现在列的是 B 的会话（sess_b 在，A 的 sess_a 不在）—— 这是隔离本身；
     *   - 手上那个 A 的群 id **仍然打得开、也写得到**（`roomOpens` / `writeLanded`，下面照旧）——
     *     这才是这一段真正防的 bug：一个 id 被交到手上就不该变成 404。
     */
    roomListed = items.some((i) => i.id === 'sess_b');
    chatSurvived = !items.some((i) => i.id === 'sess_a');

    roomOpens = (await call('GET', `/api/cluster/rooms/${roomId}`)).status === 200;

    const sent = await call('POST', `/api/cluster/rooms/${roomId}/message`, { content: '来自 B 的一句话' });
    const reread = await call('GET', `/api/cluster/rooms/${roomId}`);
    writeLanded = sent.status < 400 && (reread.body?.messages?.length ?? 0) > 0;
  });

  record(
    '【关键】点了另一个项目的会话之后，轨道变成那个项目的（sess_b 在，A 的 sess_a 不在）',
    healthy && roomListed && chatSurvived,
    roomListed && chatSurvived ? switchDetail : `切走之后轨道只剩：${seen}`,
  );
  record(
    '【关键】切走之后，原来那个项目的东西不是"被丢了"：手上的群 id 仍然打得开',
    healthy && roomOpens,
    roomOpens ? '' : 'GET /api/cluster/rooms/<id> 没有返回 200',
  );
  record(
    '给另一个项目的群发消息，落在群自己所在的那个项目里',
    healthy && writeLanded,
    writeLanded ? '' : '消息没有回到那个群自己的存储',
  );
  removeTempDir(wsA);
  removeTempDir(wsB);
}

// ── 11. 同一个目录的两种写法，是同一个项目 ──
if (process.platform === 'win32') {
  /*
   * The live index on 2026-09-27 held both `d:\AGI\_she-live-test` and `D:\AGI\_she-live-test` —
   * one directory, two spellings. Keyed by spelling that is two SessionStores over one
   * `sessions.json`: each keeps its own in-memory list and persists it wholesale, so a chat created
   * through one spelling disappears when the other spelling next writes. That is the shape of
   * "点第二个 chat，东西就不见了" — the loss is silent and looks like the rail dropping items.
   */
  const flipDriveCase = (p) => {
    const m = /^([A-Za-z]):/.exec(p);
    if (!m) return null;
    const letter = m[1];
    const flipped = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
    return flipped + p.slice(1);
  };
  const ws = makeWorkspace('spelling', EMPTY_SESSIONS('拼写测试'));
  const other = flipDriveCase(ws);
  if (other && other !== ws) {
    // Seed the app-level index with both spellings, exactly as the live one had them.
    mkdirSync(join(ws, 'appdir'), { recursive: true });
    writeFileSync(
      join(ws, 'appdir', 'projects.json'),
      JSON.stringify({ roots: [ws, other] }, null, 2),
      'utf8',
    );

    let detail = '';
    let allListed = false;
    let titlesKept = false;
    const { healthy } = await bootOnce(ws, async (base) => {
      const call = async (method, path, body) => {
        const r = await fetch(base + path, {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        let parsed = null;
        try { parsed = await r.json(); } catch { /* not json */ }
        return { status: r.status, body: parsed };
      };

      const x = await call('POST', '/api/sessions', { title: '先建的 X', directory: ws });
      // In the duplicated-store build this listing is what brings the second spelling's store into
      // existence, with a copy of the file as it is right now.
      await call('GET', '/api/sessions');
      const y = await call('POST', '/api/sessions', { title: '后建的 Y', directory: ws });
      const z = await call('POST', '/api/sessions', { title: '在另一种拼写下建的 Z', directory: other });

      const listed = await call('GET', '/api/sessions');
      const rail = new Map((listed.body?.sessions || []).map((s) => [s.id, s]));
      const wanted = [['X', x.body?.id], ['Y', y.body?.id], ['Z', z.body?.id]];
      const missing = wanted.filter(([, id]) => !id || !rail.has(id)).map(([n]) => n);
      allListed = missing.length === 0;
      detail = missing.length
        ? `轨道上少了 ${missing.join('/')}（一共 ${rail.size} 条：${[...rail.values()].map((s) => s.title).join(' | ')}）`
        : '';

      const onDisk = JSON.parse(readFileSync(join(ws, '.she', 'sessions.json'), 'utf8'));
      const byId = new Map((onDisk.sessions || []).map((s) => [s.id, s]));
      const lost = wanted
        .filter(([, id]) => !id || !byId.has(id))
        .map(([n]) => `${n}(整个没了)`);
      for (const [name, id] of wanted) {
        const s = byId.get(id);
        if (s && s.title !== { X: '先建的 X', Y: '后建的 Y', Z: '在另一种拼写下建的 Z' }[name]) {
          lost.push(`${name} 的标题变成「${s.title}」`);
        }
      }
      titlesKept = lost.length === 0;
      if (titlesKept) detail = `盘上 ${byId.size} 个会话，标题都在`;
      else if (allListed) detail = lost.join('；');
    });

    record(
      '【关键】同一个目录的两种写法不能在轨道里变成两份（新建的会话曾从列表里消失）',
      healthy && allListed,
      allListed ? 'X/Y/Z 都在轨道上' : detail,
    );
    record(
      '【关键】同一个目录的两种写法不能各自持有一份存储，把对方的会话写没',
      healthy && titlesKept,
      titlesKept ? detail : detail || '盘上的会话被另一种拼写的副本覆盖了',
    );
    removeTempDir(ws);
  }
}

// ── 12. 群是在哪个项目里建的，切走之后就要还在（这一次：轨道先被轮询过） ──
{
  /*
   * 第 10 段测不出「真实的坏法」，因为它只在最后才读一次轨道 —— 而真实的界面是**不停**在轮询的。
   *
   * 轮询会在你还没打开那个项目时就给它的存储建一个缓存实例（读到的是当时的空文件）。之后你一
   * 旦切到那个项目、在那里建了群，写是通过「挂载中」的那个实例落盘的，而读却从缓存里那个旧实
   * 例拿 —— 同一个 rooms.json 上两个实例，轨道就成了空的。2026-09-27 真机上就是这样：群里明明
   * 有一条记录躺在 D:\AGI\_she-live-test\.she\cluster\rooms.json 里，轨道一条群都不显示，点进
   * 去还是 404。
   *
   * 这一段的顺序是照抄那次的：先轮询轨道（把 B 的存储缓存起来）→ 切到 B → 在 B 建群 →
   * 切回 A → 轨道必须还列着那个群。
   */
  const wsA = makeWorkspace('cacheA', EMPTY_SESSIONS('A 的会话'));
  /* A distinct id: two stores both holding `s1` would be deduped by the rail, which hides which
   * project a listed chat came from. */
  const bSessions = EMPTY_SESSIONS('B 的会话');
  bSessions.sessions[0].id = 'sess_b';
  bSessions.active_id = 'sess_b';
  const wsB = makeWorkspace('cacheB', bSessions);
  /*
   * B must already be a KNOWN project before the first rail read — that is the precondition the
   * earlier attempt at this test missed, and it is exactly the live situation (the user had visited
   * those directories hours before, so the app-level index listed them). Without this, the poll
   * below never touches B's store, no stale copy is ever made, and the test passes on the broken
   * code — which is what happened.
   */
  mkdirSync(join(wsA, 'appdir'), { recursive: true });
  writeFileSync(
    join(wsA, 'appdir', 'projects.json'),
    JSON.stringify({ roots: [wsA, wsB] }, null, 2),
    'utf8',
  );

  let detail = '';
  let listed = false;
  let opens = false;
  let messageLands = false;

  const { healthy } = await bootOnce(wsA, async (base) => {
    const call = async (method, path, body) => {
      const r = await fetch(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      let parsed = null;
      try { parsed = await r.json(); } catch { /* not json */ }
      return { status: r.status, body: parsed };
    };

    /*
     * 界面式的轮询：此时 B 还没被打开，但它是「已知项目」，所以这一读就给 B 的存储建了一个缓存实例
     * （读到的是当时的空文件）。这一行是下面那条断言的前提，不是装饰 —— 少了它，坏代码也能过。
     */
    const poll = await call('GET', '/api/conversations');
    /*
     * 注意这段的前提在新契约下换了个形式：轨道不再列 B 的会话，所以"B 是已知项目"不能再靠
     * "轨道上看得见 B"来证明（那个断言本身就是旧契约的一部分，现在会一直为假）。改成读
     * `/api/workspaces` 的清单 —— 那才是"这个项目是已知的"的事实来源。
     */
    const known = await call('GET', '/api/workspaces');
    const knownRoots = (known.body?.workspaces ?? []).map((w) => resolve(w.root ?? w));
    if (!knownRoots.some((r) => r === resolve(wsB))) {
      detail = `前置条件没满足：轮询之后 B 还不是已知项目（那测的就不是缓存问题），已知=${knownRoots.join(' | ')}`;
    }

    await call('POST', '/api/workspaces/switch', { root: wsB });
    const made = await call('POST', '/api/cluster/rooms', { title: '在 B 里建的群' });
    const roomId = made.body?.id;

    /*
     * 在 B 里就必须看得见 B 的群 —— 这一句取代了原来"切回 A 之后还看得见 B 的群"。
     *
     * 原断言防的是真 bug：轮询给 B 的存储建了缓存实例，之后在 B 建群写的是挂载中那份，读却从
     * 缓存那份拿，于是轨道是空的、点开还 404。那个 bug 的形状是"写进去的东西读不出来"，和
     * "在哪个工作区"无关 —— 所以正确地钉住它的方式是**在 B 里读**（同一个 rooms.json 上的两份
     * 实例照样会让这句为假），而不是要求它跑到 A 的轨道上去。
     */
    const railInB = await call('GET', '/api/conversations');
    const itemsInB = Array.isArray(railInB.body?.items) ? railInB.body.items : [];
    listed = Boolean(roomId) && itemsInB.some((i) => i.kind === 'cluster' && i.id === roomId);
    if (!listed) {
      detail = `在 B 里轨道上只有 ${itemsInB.map((i) => `${i.kind}:${i.id}`).join(' ') || '(空)'}`;
    }

    await call('POST', '/api/workspaces/switch', { root: wsA });
    const railInA = await call('GET', '/api/conversations');
    const itemsInA = Array.isArray(railInA.body?.items) ? railInA.body.items : [];
    /* 切回 A 之后，B 的群不该跟着过来 —— 这是隔离的另一面。 */
    let leakedToA = itemsInA.some((i) => i.kind === 'cluster' && i.id === roomId);
    if (listed && leakedToA) {
      listed = false;
      detail = '切回 A 之后，B 的群还挂在 A 的轨道上（隔离没生效）';
    }

    const opened = await call('GET', `/api/cluster/rooms/${roomId}`);
    opens = opened.status === 200 && opened.body?.title === '在 B 里建的群';
    if (opens === false && !detail) detail = `GET /api/cluster/rooms/<id> → ${opened.status}`;

    const sent = await call('POST', `/api/cluster/rooms/${roomId}/message`, { content: '落在 B 里的一句话' });
    const reread = await call('GET', `/api/cluster/rooms/${roomId}`);
    messageLands = sent.status < 400 && (reread.body?.messages?.length ?? 0) > 0;
    if (!messageLands && !detail) detail = `给群发消息 status=${sent.status}`;

    const onDisk = JSON.parse(readFileSync(join(wsB, '.she', 'cluster', 'rooms.json'), 'utf8'));
    if (listed && !(onDisk.rooms || []).some((r) => r.id === roomId)) {
      listed = false;
      detail = '轨道显示有，但 B 的 rooms.json 里没有 —— 读的不是同一个文件';
    }
  });

  record(
    '【关键】在某个项目里建的群，在那个项目的轨道上看得见（曾因缓存实例读不到、点开 404）',
    healthy && listed,
    listed ? '群在 B 的轨道里' : detail,
  );
  record(
    '切回另一个项目之后，那个群不会跟着过来（隔离）',
    healthy && listed,
    listed ? '' : detail || 'B 的群出现在 A 的轨道上',
  );
  record(
    '切回 A 之后，手上那个 B 的群 id 仍然打得开（不是"被丢了"）',
    healthy && opens,
    opens ? '' : `GET /api/cluster/rooms/<id> → ${opens}`,
  );
  record(
    '在那个项目里给群发的消息，真的落在那个项目的 rooms.json 里',
    healthy && messageLands,
    messageLands ? '' : detail || '消息没落到群里',
  );
  removeTempDir(wsA);
  removeTempDir(wsB);
}

// ── 13. 隔离不能只写在日志里：接口要说出来，而且要说对 ──
//
// 第 5 段盯的是「启动日志里有提示」。日志对用户不等于提示：文件被隔离之后，界面只是少了几条
// 会话 —— 和应用把聊天记录删了长得一模一样，差别只在日志里，而用户不会去看日志。真实后果是
// 用户以为数据被删了，然后重新开始用，备份文件从此没人管。
//
// 所以这一段钉的是「磁盘 → 接口」这条链上必须成立的三件事：健康的项目不能谎报；损坏时必须
// 报出被留底的那一份；报出来的路径必须真的存在、里面真的是原文（指路必须可执行，否则提示
// 只是让人更着急）。另外顺带钉一条写入侧的不变量：跑完之后磁盘上的文件必须是「能被原样读回」
// 的形状 —— 加载器会静默丢掉的记录，我们不该写出去。
{
  // (a) 健康项目不报：常驻的假警告会让真警告失效。
  const ws = makeWorkspace('notice-ok', WITH_MESSAGES);
  const file = join(ws, '.she', 'sessions.json');
  let body = null;
  const { healthy } = await bootOnce(ws, async (base) => {
    const r = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(3000) });
    body = await r.json();
  });
  record(
    '健康项目不谎报隔离（recovery 为空）',
    healthy && body !== null && !body.recovery,
    `recovery=${JSON.stringify(body?.recovery)}`,
  );

  /*
   * 写入侧的不变量：刚刚启动、刚刚写过文件的这个状态，必须是加载器能原样读回的。
   *
   * 这正是 `assertWritableSessions` 在运行时挡的那一类形状（缺 id 的记录会被加载器丢掉、
   * messages 不是数组会被换成空）。在这里从磁盘上再验一遍，是因为它同时看住了「加载器将来
   * 变宽容」这条路：只要写出去的形状还是能被读回，两边就不会悄悄错开。
   */
  const onDisk = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const writable = Array.isArray(onDisk?.sessions)
    && onDisk.sessions.every((s) => typeof s.id === 'string' && s.id && Array.isArray(s.messages));
  record(
    '服务自己写的 sessions.json 是「能原样读回」的形状（没有加载器会丢掉的记录）',
    healthy && writable,
    writable ? '' : `落盘形状不合法: ${JSON.stringify(onDisk?.sessions)?.slice(0, 200)}`,
  );
  removeTempDir(ws);
}

{
  // (b) 损坏的会话文件：接口必须报出备份，而且指的路要能走通。
  const ws = makeWorkspace('notice-bad', null);
  const file = join(ws, '.she', 'sessions.json');
  const broken = '{"schema_version":"she-sessions/0.2","active_id":null,"sessions":[{"id":"s1"';
  writeFileSync(file, broken, 'utf8');

  let body = null;
  const { healthy } = await bootOnce(ws, async (base) => {
    const r = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(3000) });
    body = await r.json();
  });
  const notice = body?.recovery ?? null;
  record(
    '【关键】损坏会话文件时接口给出 recovery（用户才分得清"被留底"和"被删除"）',
    healthy && Boolean(notice) && typeof notice.reason === 'string',
    notice ? '' : `recovery=${JSON.stringify(body?.recovery)}`,
  );

  const backupExists = Boolean(notice?.backup) && existsSync(notice.backup);
  const backupIsOriginal = backupExists && readFileSync(notice.backup, 'utf8') === broken;
  record(
    '【关键】接口报出的备份路径真实存在，且内容就是原文（提示要能照着做）',
    backupIsOriginal,
    backupIsOriginal ? '' : `backup=${notice?.backup} exists=${backupExists}`,
  );
  removeTempDir(ws);
}

{
  // (c) 讨论组同理：群文件被留底之后，轨道的接口也要说得出来。
  const ws = makeWorkspace('notice-rooms', null);
  const dir = join(ws, '.she', 'cluster');
  mkdirSync(dir, { recursive: true });
  const broken = '{"schema_version":"2","rooms":[{"id":"r1","title":"重要讨论组"';
  writeFileSync(join(dir, 'rooms.json'), broken, 'utf8');

  let body = null;
  const { healthy } = await bootOnce(ws, async (base) => {
    const r = await fetch(`${base}/api/conversations`, { signal: AbortSignal.timeout(3000) });
    body = await r.json();
  });
  const list = Array.isArray(body?.recoveries) ? body.recoveries : [];
  const clusterNotice = list.find((n) => n.kind === 'cluster') ?? null;
  const pointsAtOriginal = Boolean(clusterNotice?.backup)
    && existsSync(clusterNotice.backup)
    && readFileSync(clusterNotice.backup, 'utf8') === broken;
  record(
    '【关键】讨论组文件被留底时，会话轨道的接口报出它（否则群看起来就是被删了）',
    healthy && clusterNotice !== null,
    clusterNotice ? '' : `recoveries=${JSON.stringify(body?.recoveries)}`,
  );
  record(
    '讨论组的备份路径同样真实存在且内容为原文',
    pointsAtOriginal,
    pointsAtOriginal ? '' : `backup=${clusterNotice?.backup}`,
  );
  removeTempDir(ws);
}

const failed = results.filter((r) => !r.pass);

/*
 * The install's `.env` is compared against a snapshot taken before the first server boot.
 *
 * A test that quietly edits the user's settings is worse than no test: it made this suite pass while
 * leaving the app pointed at a temp workspace, and nothing in the output said so. Hash rather than
 * mtime, because a rewrite that keeps the same content is harmless.
 */
{
  const after = existsSync(ENV_FILE) ? readFileSync(ENV_FILE) : null;
  const same = (envBefore === null && after === null)
    || (envBefore !== null && after !== null && envBefore.equals(after));
  record(
    '整套检查没有改动安装目录的 .env（否则测试会把用户的工作区改到临时目录）',
    same,
    same ? '' : `${ENV_FILE} 被改动了`,
  );
}

console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  console.log('\n失败项:');
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
