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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const PORT = process.env.SHE_TEST_PORT || '5598';
/** Port for the stub model in section 9 — the server is pointed at it instead of a real provider. */
const LLM_PORT = Number(PORT) + 1;

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

/** Start the server on a throwaway workspace, wait for boot, then stop it. */
/**
 * Boot the server on a throwaway workspace, let recovery finish, then stop it.
 *
 * Also probes `/api/sessions` while it is up, because several assertions are about the app being
 * USABLE after recovery rather than merely about the process starting — "the server came up" was the
 * whole condition of two assertions that could therefore never fail.
 */
async function bootOnce(workspace) {
  const child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    // Pinned in the child environment, not only in the workspace: ambient variables win over the
    // `.env`, so an exported SHE_PORT would make this probe the developer's own server.
    env: {
      ...process.env,
      SHE_WORKSPACE: workspace,
      SHE_PORT: PORT,
      SHE_APP_DIR: join(workspace, 'appdir'),
    },
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

  // Recovery runs during boot; give it a moment to finish writing.
  await new Promise((r) => setTimeout(r, 2000));
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
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
  await new Promise((r) => stub.listen(LLM_PORT, '127.0.0.1', r));
  const child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      SHE_WORKSPACE: ws,
      SHE_PORT: PORT,
      SHE_APP_DIR: join(ws, 'appdir'),
      SHE_LLM_PROVIDER: 'openai',
      OPENAI_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
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
  try { child.kill(); } catch { /* already gone */ }
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

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  console.log('\n失败项:');
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
