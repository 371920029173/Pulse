/**
 * Metrics endpoint check.
 *
 * Runs a real server against a throwaway workspace and verifies the endpoint's
 * contract. Deliberately makes NO LLM calls: this must be free to run in a gate.
 *
 * What it can therefore prove is the shape and the initial state — not that the
 * numbers move correctly. The movement case needs real turns and real tokens; it
 * is covered by the agent eval, which reports the same cache figures per task.
 * Splitting it that way keeps the free check free and puts the paid check where
 * paid work already happens.
 *
 *   node scripts/metrics-check.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
const PORT = String(await pickSafePort(Number(process.env.SHE_METRICS_TEST_PORT || 18080), [18081,18082,18083,19090,19191]))

if (!existsSync(SERVER_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
};

const workspace = mkdtempSync(join(tmpdir(), 'she-metrics-'));
mkdirSync(join(workspace, '.she'), { recursive: true });

const child = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: { ...process.env, SHE_WORKSPACE: workspace, SHE_PORT: PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverOut = '';
child.stdout.on('data', (c) => { serverOut += c; });
child.stderr.on('data', (c) => { serverOut += c; });

/** Wait for the server to answer, or give up. */
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

function cleanup() {
  try { child.kill(); } catch { /* already gone */ }
  removeTempDir(workspace);
}

console.log('\n指标端点检查（用临时工作区启动真实服务，不调用 LLM）\n');

if (!(await waitForHealth())) {
  console.error('服务未能在 30 秒内就绪');
  console.error(serverOut.slice(-800));
  cleanup();
  process.exit(1);
}

try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/metrics`, { signal: AbortSignal.timeout(5000) });
  check('端点存在且返回 200', r.status === 200, `status=${r.status}`);
  const m = await r.json();

  console.log('\n  返回内容：');
  console.log(`    轮次      ${m.turns?.total ?? '?'}`);
  console.log(`    缓存命中率 ${m.tokens?.cacheHitRate ?? '?'}   工具种类 ${m.tools?.length ?? '?'}`);
  console.log(`    模型      ${m.llm?.provider ?? '?'} / ${m.llm?.model ?? '?'}`);
  console.log(`    工作区    ${m.workspace ?? '?'}`);
  console.log('');

  check('有 uptimeMs 与 startedAt', typeof m.uptimeMs === 'number' && typeof m.startedAt === 'string');
  check('有轮次计数', typeof m.turns?.total === 'number' && typeof m.turns?.ok === 'number' && typeof m.turns?.failed === 'number');
  check('有耗时统计（avg 与 p95）', typeof m.turns?.avgMs === 'number' && typeof m.turns?.p95Ms === 'number');
  check('有 token 分类（含推理）',
    typeof m.tokens?.prompt === 'number' && typeof m.tokens?.completion === 'number'
    && typeof m.tokens?.reasoning === 'number');
  check('有缓存命中与未命中计数',
    typeof m.tokens?.cacheHit === 'number' && typeof m.tokens?.cacheMiss === 'number');
  check('缓存命中率在 0~1 之间（越小说明前缀在变，成本越高）',
    typeof m.tokens?.cacheHitRate === 'number' && m.tokens.cacheHitRate >= 0 && m.tokens.cacheHitRate <= 1,
    `实际 ${m.tokens?.cacheHitRate}`);
  check('tools 是数组', Array.isArray(m.tools));
  check('有错误计数（请求失败与崩溃分开）',
    typeof m.errors?.requestFailures === 'number' && typeof m.errors?.crashes === 'number');
  check('汇报了模型与工作区', !!m.llm?.model && !!m.workspace);
  check('起始状态为零（新进程，未服务任何轮次）',
    m.turns.total === 0 && m.tokens.total === 0 && m.tokens.cacheHit === 0,
    `turns=${m.turns.total} tokens=${m.tokens.total}`);

  // A bad session id must not corrupt metrics, and must not be counted as a turn.
  const bad = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'x', session_id: ['not', 'a', 'string'] }),
    signal: AbortSignal.timeout(5000),
  });
  check('非法 session_id 返回 400（而不是 500）', bad.status === 400, `status=${bad.status}`);

  const after = await (await fetch(`http://127.0.0.1:${PORT}/api/metrics`, { signal: AbortSignal.timeout(5000) })).json();
  check('被拒绝的请求不计入轮次（否则失败率会被污染）', after.turns.total === 0, `turns=${after.turns.total}`);
} catch (err) {
  check('指标端点可用', false, err.message);
}

cleanup();
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
