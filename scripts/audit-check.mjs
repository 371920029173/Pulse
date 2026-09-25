/**
 * Audit trail: append-only, ordered, and honest about its own damage — offline, no API calls.
 *
 * The other stores in `.she/` can be rewritten, so "what did it do?" is a question their contents
 * cannot answer after the fact. The audit log exists only for that question, which makes a small
 * set of properties load-bearing, and each of them fails SILENTLY:
 *
 *   1. **Append only.** Nothing rewrites an existing line. A "tidy up" refactor that rewrote the
 *      file would leave every assertion in this file green while destroying the one property that
 *      makes the trail worth keeping — so it is asserted byte-wise, on the prefix.
 *   2. **Strictly increasing `seq`.** Timestamps tie at millisecond resolution and wall clocks
 *      move. The counter is the only total order, and the case that breaks it is subtle: rolling
 *      the log appends its own `rotation` record, so if `seq` were picked before the roll, that
 *      record and the one that triggered it would claim the same number.
 *   3. **Rotation is recorded.** If a cap forces old files out, the drop is itself a record.
 *      History that vanishes without a trace is the failure the trail is supposed to prevent.
 *   4. **Damage is reported.** A line killed mid-write is counted and surfaced through the API.
 *      Returning fewer records quietly is indistinguishable from a quiet day.
 *
 * It also drives the REAL server, because some of those properties only exist at the junctions:
 * `/api/audit` must read what the writer writes, a forged ticket must not be recorded as a human
 * approval, and a rejected request must not be recorded as work.
 *
 *   node scripts/audit-check.mjs
 */
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const AUDIT_MODULE = join(SERVER_DIR, 'dist', 'audit.js');

if (!existsSync(SERVER_ENTRY) || !existsSync(AUDIT_MODULE)) {
  console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
  }
};

const { AuditLog } = await import(pathToFileURL(AUDIT_MODULE).href);

const auditPathOf = (root) => join(root, '.she', 'audit.log');
const linesOf = (root) => readFileSync(auditPathOf(root), 'utf8').split(/\r?\n/).filter(Boolean);
/** Rotated files, oldest first. `audit.log` is excluded: the dash in the rotation name separates them. */
const rotationsOf = (root) => readdirSync(join(root, '.she')).filter((f) => f.startsWith('audit-')).sort();
/** Every `seq` on disk, oldest file first — the order a reader reconstructs history in. */
function allSeqs(root, log) {
  const out = [];
  for (const f of [...log.files()].reverse()) {
    for (const l of readFileSync(join(root, '.she', f), 'utf8').split(/\r?\n/).filter(Boolean)) {
      out.push(JSON.parse(l).seq);
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The record: append only, ordered, truncation visible, damage reported
 * ══════════════════════════════════════════════════════════════════════════ */

const dir = mkdtempSync(join(tmpdir(), 'she-audit-'));

console.log('\n1. 只追加：已有字节不会被改写');
{
  const log = new AuditLog(dir);
  const snapshots = [];
  for (let i = 1; i <= 5; i++) {
    log.append({ kind: 'request', message: `第 ${i} 次`, session_id: 'sess-a' });
    snapshots.push(readFileSync(auditPathOf(dir), 'utf8'));
  }
  const final = readFileSync(auditPathOf(dir), 'utf8');
  check('每次写入之后，之前的内容仍是原文的前缀（没有重写历史）',
    snapshots.every((s) => final.startsWith(s)), null);
  check('五次写入就是五行', linesOf(dir).length === 5, `实际 ${linesOf(dir).length} 行`);

  const back = log.read({ limit: 100 }).records.slice().reverse();
  check('序号从 1 开始连续', back.map((r) => r.seq).join(',') === '1,2,3,4,5', back.map((r) => r.seq).join(','));
  check('读回来与写进去一致（往返不丢字段）',
    back.every((r, i) => r.message === `第 ${i + 1} 次` && r.session_id === 'sess-a' && r.kind === 'request'), null);
  check('每条都有时间戳', back.every((r) => typeof r.ts === 'string' && r.ts.includes('T')), null);
}

console.log('\n2. seq 严格递增：同毫秒、重启、轮转都不会撞号');
{
  const log = new AuditLog(dir);
  const one = log.append({ kind: 'tool', tool: 'read_file' });
  const two = log.append({ kind: 'tool', tool: 'read_file' });
  check('同一毫秒内两条也分得清先后', two.seq > one.seq, `${one.seq} → ${two.seq}`);

  const afterRestart = new AuditLog(dir).append({ kind: 'tool', tool: 'grep' });
  check('重启后接着之前的序号（不从 0 重来）', afterRestart.seq === two.seq + 1,
    `${two.seq} → ${afterRestart.seq}`);

  /*
   * Rotate: a small cap so the roll happens inside the window, and `keep` low enough that files are
   * really dropped — the drop is what writes a `rotation` record, and that record is the one that
   * used to collide with the record that triggered it.
   */
  const rollDir = mkdtempSync(join(tmpdir(), 'she-audit-roll-'));
  const roll = new AuditLog(rollDir, { maxBytes: 140, keep: 1 });
  for (let i = 0; i < 30; i++) roll.append({ kind: 'tool', tool: `tool-with-a-fairly-long-name-${i}` });

  check('轮转确实发生了', roll.files().length > 1, roll.files().join(', '));
  const seqs = allSeqs(rollDir, roll);
  let monotonic = true;
  for (let i = 1; i < seqs.length; i++) if (!(seqs[i] > seqs[i - 1])) monotonic = false;
  check(`轮转写下的 rotation 记录没有和触发它的记录撞号（${seqs.length} 条，最老 → 最新）`,
    monotonic, seqs.join(','));
  check('保留份数不超过上限', rotationsOf(rollDir).length <= 1, roll.files().join(', '));

  const dropped = roll.read({ limit: 5000 }).records
    .filter((r) => r.kind === 'rotation')
    .flatMap((r) => r.dropped ?? []);
  const present = new Set(roll.files());
  check('丢掉的轮转文件被记录了下来（历史不会无声消失）',
    dropped.length > 0 && dropped.every((n) => !present.has(n)),
    `dropped=${dropped.join(', ') || '(无)'}  present=${[...present].join(', ')}`);

  removeTempDir(rollDir);
}

console.log('\n3. 长消息截断，但"被截断"这件事本身记下来了');
{
  const rec = new AuditLog(dir).append({ kind: 'request', message: 'x'.repeat(5000) });
  check('超过上限会截断', rec.message.length === 2000 && rec.truncated === true, `长度 ${rec.message.length}`);
  check('原文长度仍然可查（截断的记录不会读成一条很短的完整消息）', rec.chars === 5000, `chars=${rec.chars}`);
}

console.log('\n4. 损坏被报告，而不是被当成"什么都没发生"');
{
  const badDir = mkdtempSync(join(tmpdir(), 'she-audit-bad-'));
  mkdirSync(join(badDir, '.she'), { recursive: true });
  const log = new AuditLog(badDir);
  log.append({ kind: 'request', message: '正常' });
  // Exactly the shape a process killed mid-append leaves behind.
  appendFileSync(auditPathOf(badDir), '{"ts":"2026-01-01T00:00:00.000Z","seq":99,"kin', 'utf8');

  const r = log.read({ limit: 100 });
  check('半行被计为 skipped', r.skipped === 1, `skipped=${r.skipped}`);
  check('好的记录照常读出', r.records.length === 1 && r.records[0].message === '正常', null);
  check('只读到一部分时也报告看到的损坏',
    new AuditLog(badDir).read({ limit: 1 }).skipped === 1, null);
  check('损坏行里写的 seq 不被采信（序号从最后一条好记录继续）',
    new AuditLog(badDir).append({ kind: 'request', message: 'x' }).seq === 2, null);

  /*
   * A BOM is what a Windows editor leaves behind, and it must not turn the whole file into
   * "damaged": that would report the trail as broken on every Windows machine, and a warning that
   * is always on is a warning nobody reads.
   */
  const bomDir = mkdtempSync(join(tmpdir(), 'she-audit-bom-'));
  new AuditLog(bomDir).append({ kind: 'request', message: '带 BOM' });
  writeFileSync(auditPathOf(bomDir), '\uFEFF' + readFileSync(auditPathOf(bomDir), 'utf8'), 'utf8');
  const bomRead = new AuditLog(bomDir).read({ limit: 10 });
  check('BOM 不会让整个文件变成"损坏"',
    bomRead.skipped === 0 && bomRead.records.length === 1,
    `skipped=${bomRead.skipped} records=${bomRead.records.length}`);

  removeTempDir(badDir);
  removeTempDir(bomDir);
}

console.log('\n5. 过滤与上限');
{
  const fDir = mkdtempSync(join(tmpdir(), 'she-audit-filter-'));
  const log = new AuditLog(fDir);
  log.append({ kind: 'request', message: '问 A', session_id: 's1' });
  log.append({ kind: 'tool', tool: 'read_file', session_id: 's1', ok: true, ms: 12 });
  log.append({ kind: 'confirm', ticket_id: 't1', approved: true, tool: 'shell', session_id: 's2' });
  log.append({ kind: 'request', message: '问 B', session_id: 's2' });

  check('默认最新在前', log.read({ limit: 10 }).records[0].message === '问 B', null);
  check('limit 生效', log.read({ limit: 2 }).records.length === 2, null);
  check('按 kind 过滤', log.read({ limit: 10, kind: 'tool' }).records.length === 1, null);
  check('按 session_id 过滤（一个会话看不到另一个会话的记录）',
    log.read({ limit: 10, sessionId: 's1' }).records.length === 2, null);
  check('kind 与 session 过滤可以叠加',
    log.read({ limit: 10, kind: 'request', sessionId: 's2' }).records.length === 1, null);
  check('没有日志时返回空而不是抛错',
    new AuditLog(join(dir, 'not-created-yet')).read().records.length === 0, null);

  removeTempDir(fDir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The junctions: what the real server does with the trail
 * ══════════════════════════════════════════════════════════════════════════ */

const PORT = String(await pickSafePort(Number(process.env.SHE_AUDIT_TEST_PORT || 18061), [18062, 18063, 18064, 19091]));
const workspace = mkdtempSync(join(tmpdir(), 'she-audit-live-'));

const child = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: workspace,
    SHE_PORT: PORT,
    SHE_APP_DIR: join(workspace, 'appdir'),
    SHE_STATE_DIR: workspace,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverOut = '';
child.stdout.on('data', (c) => { serverOut += c; });
child.stderr.on('data', (c) => { serverOut += c; });

async function waitForHealth(timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const api = (path, init) => fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(8000), ...init });
const audit = async (qs = '') => (await api(`/api/audit${qs}`)).json();
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function cleanup() {
  try { child.kill(); } catch { /* already gone */ }
  removeTempDir(workspace);
}

console.log('\n6. /api/audit：读写格式对得上，且只读');
if (!(await waitForHealth())) {
  console.log(`  FAIL  服务在 30 秒内就绪`);
  console.log(`        ${serverOut.slice(-800)}`);
  cleanup();
  removeTempDir(dir);
  console.log(`\nFAIL (1)  audit-check`);
  process.exit(1);
}

try {
  check('GET /api/audit 返回 200', (await api('/api/audit')).status === 200, null);
  const empty = await audit();
  check('空工作区返回空列表（而不是报错或伪造记录）', empty.records.length === 0, JSON.stringify(empty).slice(0, 200));
  check('返回 files 与 skipped_lines 字段',
    Array.isArray(empty.files) && typeof empty.skipped_lines === 'number', JSON.stringify(empty).slice(0, 200));

  /*
   * A rejected request is not work, and must not be recorded as though it were. The audit call sits
   * after validation on purpose; this is what keeps it there.
   */
  const badReq = await post('/api/chat', { session_id: 'sess-x' });
  check('缺 message 的请求返回 400（而不是 500）', badReq.status === 400, `status=${badReq.status}`);
  check('被拒的请求不写进审计（拒绝不是做过的事）', (await audit()).records.length === 0, null);

  /*
   * A forged or stale ticket must not become a record saying a human approved something. This fresh
   * workspace has no pending ticket, so this is the forged case — and it is refused with a status,
   * not logged as an approval and then failed mid-stream.
   */
  const forged = await post('/api/chat/confirm', { ticket_id: 'ticket-that-never-existed' });
  check('没有在等的工单时确认被拒绝（不是 200）', forged.status >= 400, `status=${forged.status}`);
  check('伪造的确认不会留下"人工已批准"记录',
    (await audit()).records.every((r) => r.kind !== 'confirm'), null);

  /*
   * Write through the real writer and read it back over HTTP. This is the assertion that the two
   * halves agree on a format: the server reads the file `AuditLog` writes, not a shape of its own
   * invention that happens to look similar.
   */
  const writer = new AuditLog(workspace);
  writer.append({ kind: 'request', session_id: 'sess-live', message: '线上写一条' });
  writer.append({ kind: 'tool', session_id: 'sess-live', tool: 'read_file', ms: 7, ok: true });

  const live = await audit();
  check('服务读得到 AuditLog 写下的记录（两边格式一致）', live.records.length === 2, JSON.stringify(live.records).slice(0, 300));
  check('最新在前', live.records[0].tool === 'read_file', JSON.stringify(live.records[0]));
  check('字段完整读回（seq / ts / kind / session_id）',
    live.records.every((r) => typeof r.seq === 'number' && typeof r.ts === 'string' && typeof r.kind === 'string'), null);
  check('files 里报出实时日志文件名', live.files.includes('audit.log'), live.files.join(', '));

  const tools = await audit('?kind=tool');
  check('?kind=tool 只回工具记录', tools.records.length === 1 && tools.records.every((r) => r.kind === 'tool'), null);
  check('?session_id= 只回该会话的记录', (await audit('?session_id=sess-live')).records.length === 2, null);
  check('?session_id= 查不到时返回空，而不是退回全部',
    (await audit('?session_id=nobody')).records.length === 0, null);
  check('?limit=1 只回一条', (await audit('?limit=1')).records.length === 1, null);
  check('未知 kind 返回 400（拼错的过滤器不能静默变成"全部"）',
    (await api('/api/audit?kind=tools')).status === 400, null);

  /*
   * Damage over HTTP: a half-line must show up as `skipped_lines`, because a count the API never
   * reports is a count the UI cannot warn about.
   */
  appendFileSync(auditPathOf(workspace), '{"ts":"2026-01-01T00:00:00.000Z","seq":999,"ki', 'utf8');
  const damaged = await audit();
  check('损坏的行通过 skipped_lines 报告出来', damaged.skipped_lines === 1, `skipped_lines=${damaged.skipped_lines}`);
  check('损坏不影响其余记录返回', damaged.records.length === 2, null);

  /*
   * Read-only. There is no endpoint that writes, edits or clears a record — a trail a client can
   * modify answers a different question from the one it is kept for.
   */
  const writes = await Promise.all([
    post('/api/audit', {}),
    api('/api/audit', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    api('/api/audit', { method: 'DELETE' }),
  ]);
  check('没有写入 / 修改 / 清空审计的接口',
    writes.every((r) => r.status === 404 || r.status === 405),
    writes.map((r) => r.status).join(', '));
  check('被拒的写入没有改动文件', (await audit()).records.length === 2, null);
} catch (err) {
  check('审计端点可用', false, err.message);
}

cleanup();
removeTempDir(dir);

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The wiring that cannot be exercised without a model turn
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n7. 三处接线与只读界面');
{
  const serverSrc = readFileSync(join(SERVER_DIR, 'src', 'index.ts'), 'utf8');

  /*
   * The tool junction lives inside the agent's tool observer, which only fires during a real turn —
   * and this check has to stay free, so it is asserted structurally. A missing kind means a silent
   * hole in the trail, which is the failure this whole file exists to prevent.
   */
  check('request 在 /api/chat 里记录', /auditSafe\(\{\s*kind:\s*'request'/.test(serverSrc), null);
  check('tool 在工具观察器里记录',
    /setToolObserver\([\s\S]{0,4000}?auditSafe\(\{\s*kind:\s*'tool'/.test(serverSrc), null);
  check('confirm 在 /api/chat/confirm 里记录', /auditSafe\(\{\s*kind:\s*'confirm'/.test(serverSrc), null);
  check('确认前先校验工单（否则伪造的 ticket_id 会变成"已批准"）',
    /pendingConfirm\.ticket_id !== body\.ticket_id[\s\S]{0,900}?auditSafe/.test(serverSrc), null);
  check('写审计失败不会拖垮这一轮（审计是记录，不是关卡）',
    /function auditSafe[\s\S]{0,300}?catch/.test(serverSrc), null);

  const uiSrc = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'components', 'AuditPanel.tsx'), 'utf8');
  check('界面面板只读：没有 POST / PUT / DELETE 调用',
    !/method:\s*'(POST|PUT|DELETE)'/i.test(uiSrc), null);
  check('界面用 GET /api/audit 取记录', /\/api\/audit/.test(uiSrc), null);
  check('界面把损坏行数展示出来', /skipped/.test(uiSrc), null);
  check('面板在 App.tsx 里接上了（命令面板能打开）',
    /AuditPanel/.test(readFileSync(join(ROOT, 'packages', 'ui', 'src', 'App.tsx'), 'utf8')), null);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  audit-check`);
process.exit(failures === 0 ? 0 : 1);
