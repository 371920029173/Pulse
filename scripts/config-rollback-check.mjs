/**
 * 配置的 last-good 回退 —— 全部离线，本地起一个真 server，不调模型。
 *
 * 状态文件从 `state-file.ts` 起就有「读不了就挪到一边、给你留一份」，配置文件一直什么都没有。
 * 这个不对称有个很尖的边：状态文件坏了，代价是一份可恢复的副本加一条警告；配置文件坏了，
 * 整个应用起不来 —— 而且是在用户最看不到原因的时候起不来，因为那个本该打印原因的进程根本没起来。
 *
 * 坏法都很普通：手写 YAML 里一个 tab、编辑器自动保存到一半、`git merge` 留下的冲突标记。
 * 文件离正确只差一次敲击，在任何时候都能在文本编辑器里改好 —— 所以有用的行为不是「拒绝启动」，
 * 而是「用上一次能用的那套启动，并且说清楚你现在这个文件哪里不对」。
 *
 * 于是这个检查断言的重点不是「能回退」，而是**回退不能变成静默跑错配置**：
 *
 *   1. **回退必须被看见。** 记录里必须有文件名、原因、快照时间，`/api/health` 必须报
 *      `degraded`。一个悄悄不生效的配置，比一个没生效的配置更糟。
 *   2. **只管「用不了」，不管「写得怪」。** 解析不了、顶层是列表 → 回退；未知键、缺必填
 *      → 走各自的路径（警告或抛错），因为那些情况下文件是**读得懂**的，用户正在写。
 *   3. **坏文件一个字都不许动。** 不覆盖、不挪走、不截断 —— 用户正在编辑它。快照也不能被
 *      坏内容覆盖，否则第一次坏掉就把安全网烧了。
 *   4. **没有安全网时不许静默退回默认值。** 快照不存在、或快照自己也坏了 → 抛原来的错。
 *      这才是 `tryLoadYaml` 当初「宁可大声失败」要防的那件事。
 *
 *   node scripts/config-rollback-check.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
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
const SHARED_ENTRY = join(ROOT, 'packages', 'shared', 'dist', 'index.js');

if (!existsSync(SERVER_ENTRY) || !existsSync(SHARED_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY} 或 ${SHARED_ENTRY}\n请先 pnpm -r build`);
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

const {
  loadConfig,
  tryLoadYaml,
  getConfigRecovery,
  getConfigFileInUse,
  clearConfigRecovery,
  lastGoodConfigPath,
  lastGoodConfigMetaPath,
} = await import(pathToFileURL(SHARED_ENTRY).href);

const dirs = [];
const tempDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `she-config-${tag}-`));
  dirs.push(d);
  return d;
};

/** A config file, and the two paths derived from it. */
function fixture(tag, body) {
  const dir = tempDir(tag);
  const file = join(dir, 'she.config.yaml');
  if (body !== null) writeFileSync(file, body, 'utf8');
  return { dir, file, snapshot: lastGoodConfigPath(file), meta: lastGoodConfigMetaPath(file) };
}

/**
 * Load with the file under test selected through `SHE_CONFIG_FILE`, the way an operator would.
 *
 * Isolated from ambient state in two ways, because otherwise this suite asserts the developer's
 * shell rather than the fallback logic:
 *   - environment overrides are cleared (they are MEANT to beat the file — that is how
 *     `OPENAI_MODEL` works — so an ambient one would mask the file's value);
 *   - `SHE_ENV_FILE` is pointed at a path that does not exist, because `resolveEnvFile` falls back
 *     to `.env` in the current directory, and this repo has one with a real key in it.
 * Everything is restored afterwards.
 */
const ENV_OVERRIDES = [
  'OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY',
  'AGI_USE_API_KEY', 'SHE_MODEL', 'SHE_LLM_PROVIDER', 'SHE_SUBAGENT_MODEL', 'SHE_WORKSPACE',
  'SHE_KB_PATH', 'SHE_THINKING_LEVEL', 'SHE_LLM_MAX_TOKENS', 'SHE_LLM_TEMPERATURE',
  'SHE_SKILL_PROFILE', 'SHE_BUDGET_ENABLED', 'SHE_BUDGET_MAX_TOOL_ROUNDS', 'SHE_BUDGET_MAX_TOOL_CALLS',
  'SHE_BUDGET_MAX_TOKENS', 'SHE_BUDGET_MAX_SECONDS', 'SHE_SCHEDULE_ENABLED', 'SHE_SCHEDULE_WINDOW',
  'SHE_ENV_FILE', 'SHE_CONFIG_FILE',
];

function loadFrom(file) {
  clearConfigRecovery();
  const saved = new Map();
  for (const k of ENV_OVERRIDES) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  process.env.SHE_CONFIG_FILE = file;
  process.env.SHE_ENV_FILE = join(dirname(file), 'no-such.env');
  try {
    return { config: loadConfig(dirname(file)), error: null };
  } catch (err) {
    return { config: null, error: err };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const GOOD = [
  '# 手写的注释：回退不应该把它弄丢',
  'llm:',
  '  provider: openai',
  '  model: rollback-good',
  '  thinking: low',
  '',
].join('\n');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 好配置：快照被写下来，而且是一个字节一个字节的副本
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n1. 能用的配置会给自己留一份快照');
{
  const f = fixture('good', GOOD);
  const { config, error } = loadFrom(f.file);
  check('好配置照常加载', error === null && config?.llm.model === 'rollback-good', error?.message ?? JSON.stringify(config?.llm));
  check('没有回退发生（recovery 是 null）', getConfigRecovery() === null, JSON.stringify(getConfigRecovery()));
  check('报告里指出用的是哪个文件', getConfigFileInUse() === resolve(f.file), getConfigFileInUse());
  check('快照写在配置文件旁边（不是别的目录）', f.snapshot === `${f.file}.last-good`, f.snapshot);
  check('快照存在', existsSync(f.snapshot), f.snapshot);
  check('【关键】快照是原文副本，注释和键序都还在',
    existsSync(f.snapshot) && readFileSync(f.snapshot, 'utf8') === GOOD, readFileSync(f.snapshot, 'utf8').slice(0, 120));
  const meta = existsSync(f.meta) ? JSON.parse(readFileSync(f.meta, 'utf8')) : null;
  check('sidecar 记下了来源文件与时间', meta?.file === resolve(f.file) && typeof meta?.takenAt === 'string', JSON.stringify(meta));
  check('未知键不算「用不了」（文件是读得懂的）', tryLoadYaml(f.file)?.llm !== undefined, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 坏配置：用快照起来，而且把原因说出来
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n2. 配置文件坏掉时用上一次能用的那套启动');
{
  const f = fixture('broken', GOOD);
  loadFrom(f.file); // establish the snapshot
  check('先确认快照已就位', existsSync(f.snapshot), null);

  const BROKEN = 'llm:\n  model: [没闭合的列表\n  provider: openai\n';
  writeFileSync(f.file, BROKEN, 'utf8');
  const { config, error } = loadFrom(f.file);

  check('【关键】坏配置不再让进程起不来', error === null, error?.message);
  check('【关键】读到的是上一次能用的值', config?.llm.model === 'rollback-good', config?.llm.model);
  const rec = getConfigRecovery();
  check('【关键】回退被记录下来了（不是悄悄发生的）', rec !== null, JSON.stringify(rec));
  check('记录里有坏掉的文件名', rec?.file === resolve(f.file), rec?.file);
  check('记录里有原因', typeof rec?.reason === 'string' && rec.reason.length > 0, rec?.reason);
  check('记录里有快照路径', rec?.snapshot === f.snapshot, rec?.snapshot);
  check('记录里有快照时间', typeof rec?.takenAt === 'string' && !Number.isNaN(Date.parse(rec.takenAt)), rec?.takenAt);
  check('原因里带着「无法解析」的说法（用户能据此定位）', /无法解析/.test(String(rec?.reason)), rec?.reason);

  check('【关键】坏文件一个字都没动（用户还在编辑它）', readFileSync(f.file, 'utf8') === BROKEN, null);
  check('没有把坏文件挪到一边', readdirSync(f.dir).filter((n) => n.includes('unusable')).length === 0, readdirSync(f.dir).join(', '));
  check('【关键】快照没有被坏内容覆盖（安全网还活着）', readFileSync(f.snapshot, 'utf8') === GOOD, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 修好之后回到正常，并且快照跟着更新
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n3. 修好之后回到正常路径，快照跟着前进');
{
  const f = fixture('fix', GOOD);
  loadFrom(f.file);
  writeFileSync(f.file, 'llm:\n  model: [坏了\n', 'utf8');
  loadFrom(f.file);
  check('坏的时候确实在回退状态', getConfigRecovery() !== null, null);

  const FIXED = 'llm:\n  model: rollback-second\n';
  writeFileSync(f.file, FIXED, 'utf8');
  const { config, error } = loadFrom(f.file);
  check('修好之后正常加载，用的是新值', error === null && config?.llm.model === 'rollback-second', config?.llm.model);
  check('回退状态被清掉了（不会一直挂着告警）', getConfigRecovery() === null, JSON.stringify(getConfigRecovery()));
  check('快照前进到新的这一份', readFileSync(f.snapshot, 'utf8') === FIXED, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 没有安全网时不许静默退回默认值
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n4. 没有安全网时，还是大声失败');
{
  const f = fixture('nosnap', 'llm:\n  model: [坏了\n');
  check('这个 fixture 没有快照', !existsSync(f.snapshot), f.snapshot);
  const { config, error } = loadFrom(f.file);
  check('【关键】没有快照时不回退，直接抛错', error !== null, JSON.stringify(config?.llm));
  check('错误里点名了文件', /she\.config\.yaml/.test(String(error?.message)), error?.message);
  check('这时候不记回退状态（因为没有回退）', getConfigRecovery() === null, JSON.stringify(getConfigRecovery()));
}

{
  const f = fixture('badsnap', GOOD);
  loadFrom(f.file);
  writeFileSync(f.snapshot, 'llm:\n  model: [快照自己也坏了\n', 'utf8');
  writeFileSync(f.file, 'llm:\n  model: [坏了\n', 'utf8');
  const { config, error } = loadFrom(f.file);
  check('【关键】快照自己也坏了 → 抛原来的错，而不是跑默认配置',
    error !== null && config === null, error?.message ?? JSON.stringify(config?.llm));
  check('错误信息是「当前文件」的原因，不是快照的', /无法解析/.test(String(error?.message)), error?.message);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 可恢复的是「读不了」，不是「写得怪」
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n5. 只有「用不了」才回退，「写得怪」走自己的路径');
{
  const f = fixture('list', GOOD);
  loadFrom(f.file);
  writeFileSync(f.file, '- 顶层是列表\n- 不是映射\n', 'utf8');
  const { config, error } = loadFrom(f.file);
  check('顶层是列表也算用不了 → 回退', error === null && getConfigRecovery() !== null, error?.message);
  check('原因说的是顶层必须是映射', /顶层必须是一个映射/.test(String(getConfigRecovery()?.reason)), getConfigRecovery()?.reason);
}

{
  const f = fixture('unknownkey', GOOD);
  loadFrom(f.file);
  writeFileSync(f.file, `${GOOD}llmmodell:\n  typo: 1\n`, 'utf8');
  const { config, error } = loadFrom(f.file);
  check('未知顶层键不算用不了 → 不回退，正常加载', error === null && getConfigRecovery() === null, error?.message);
  check('未知键被记进配置里（由上层警告，不是被吞掉）',
    Object.keys(config ?? {}).includes('llmmodell'), Object.keys(config ?? {}).join(','));
}

{
  const f = fixture('empty', GOOD);
  loadFrom(f.file);
  writeFileSync(f.file, '', 'utf8');
  const { error } = loadFrom(f.file);
  check('空文件当「还没有配置」，不回退也不报错', error === null && getConfigRecovery() === null, error?.message);
  check('【关键】空文件不会把好快照覆盖成「什么都没配」', readFileSync(f.snapshot, 'utf8') === GOOD, null);

  // The same hole, one step further: if the empty file DID become the snapshot, then a later
  // breakage would silently fall back to defaults — the outcome this whole feature exists to
  // prevent. Asserted by breaking the file and checking the good values still come back.
  writeFileSync(f.file, 'llm:\n  model: [又坏了\n', 'utf8');
  const { config } = loadFrom(f.file);
  check('【关键】空文件之后又坏掉时，回退到的仍是有内容的配置，不是默认值',
    config?.llm.model === 'rollback-good', config?.llm.model);
}

{
  // No config file anywhere, and no SHE_CONFIG_FILE pointing at one: defaults, no snapshot.
  const dir = tempDir('none');
  clearConfigRecovery();
  const savedCfg = process.env.SHE_CONFIG_FILE;
  const savedEnv = process.env.SHE_ENV_FILE;
  delete process.env.SHE_CONFIG_FILE;
  process.env.SHE_ENV_FILE = join(dir, 'no-such.env');
  let outcome;
  try {
    outcome = { config: loadConfig(dir), error: null };
  } catch (err) {
    outcome = { config: null, error: err };
  } finally {
    if (savedCfg === undefined) delete process.env.SHE_CONFIG_FILE;
    else process.env.SHE_CONFIG_FILE = savedCfg;
    if (savedEnv === undefined) delete process.env.SHE_ENV_FILE;
    else process.env.SHE_ENV_FILE = savedEnv;
  }
  check('目录里没有配置文件 → 用默认值，不报错', outcome.error === null && outcome.config !== null, outcome.error?.message);
  check('没有配置文件就不写快照（没有可备份的对象）',
    !existsSync(lastGoodConfigPath(join(dir, 'she.config.yaml'))), null);
}

{
  // Explicit SHE_CONFIG_FILE pointing at nothing stays loud — it is a typo, not a missing default,
  // and this behaviour is what the refactor had to preserve.
  const f = fixture('missing', null);
  const { config, error } = loadFrom(f.file);
  check('【关键】SHE_CONFIG_FILE 指向不存在的文件仍然抛错（不静默退回默认值）',
    error !== null && config === null, error?.message ?? JSON.stringify(config?.llm).slice(0, 80));
  check('错误里点名了那个路径', /she\.config\.yaml/.test(String(error?.message)), error?.message);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 真 server：回退必须能从健康检查里看到，也能显式回退
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n6. 真 server：/api/health 报 degraded，显式回退把文件放回去');

const PORT = String(await pickSafePort(Number(process.env.SHE_CONFIG_TEST_PORT || 18281), [18282, 18283, 18284, 19293]));
const ws = tempDir('she-config-live-');
const cfgDir = join(ws, 'cfg');
mkdirSync(cfgDir, { recursive: true });
const cfgFile = join(cfgDir, 'she.config.yaml');
const LIVE_GOOD = 'llm:\n  model: live-good\n  provider: openai\n';
const LIVE_BROKEN = 'llm:\n  model: [live 坏了\n';
writeFileSync(cfgFile, LIVE_GOOD, 'utf8');

const spawnServer = () => spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: ws,
    SHE_PORT: PORT,
    SHE_APP_DIR: join(ws, 'appdir'),
    SHE_STATE_DIR: ws,
    SHE_CONFIG_FILE: cfgFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

async function waitForHealth(timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const api = (path, init) => fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(8000), ...init });
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

let child = spawnServer();
let serverOut = '';
const capture = (c) => { serverOut += c; };
child.stdout.on('data', capture);
child.stderr.on('data', capture);

const first = await waitForHealth();
check('第一次启动（配置是好的）', first !== null, serverOut.slice(-400));
check('健康检查报的是「没有降级」', first?.config?.degraded === false, JSON.stringify(first?.config));
check('健康检查带上正在用的配置文件', first?.config?.file === resolve(cfgFile), first?.config?.file);
check('第一次启动后快照已存在', existsSync(`${cfgFile}.last-good`), null);

await api('/api/config/recovery').then((r) => r.json()).then((r) => {
  check('GET /api/config/recovery 结构正确（正常态）',
    r.degraded === false && r.recovery === null && r.snapshot?.exists === true, JSON.stringify(r).slice(0, 300));
}).catch((e) => check('GET /api/config/recovery 结构正确（正常态）', false, String(e)));

try { child.kill(); } catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 600));

// Break it, and restart: this is the moment the whole feature exists for.
writeFileSync(cfgFile, LIVE_BROKEN, 'utf8');
child = spawnServer();
serverOut = '';
child.stdout.on('data', capture);
child.stderr.on('data', capture);

const second = await waitForHealth();
check('【关键】配置文件坏了，server 仍然起得来', second !== null, serverOut.slice(-500));
check('【关键】健康检查报 degraded —— 不能给运维一个绿灯', second?.config?.degraded === true, JSON.stringify(second?.config));
check('【关键】回退原因是配置解析失败', /无法解析/.test(String(second?.config?.recovery?.reason)), second?.config?.recovery?.reason);
check('运维日志里也写清楚了（不只是接口里有）', /无法使用，改用上一次能用的配置/.test(serverOut), serverOut.slice(-400));

const beforeRollback = await (await api('/api/config/recovery')).json();
check('回退接口能读到快照时间', typeof beforeRollback?.snapshot?.takenAt === 'string', JSON.stringify(beforeRollback?.snapshot));
check('回退接口报的是「现在跑的」那个文件', beforeRollback?.recovery?.file === resolve(cfgFile), beforeRollback?.recovery?.file);

const rolled = await (await post('/api/config/rollback')).json();
check('显式回退成功', rolled?.ok === true, JSON.stringify(rolled).slice(0, 300));
check('【关键】回退后，配置文件内容就是快照原文', readFileSync(cfgFile, 'utf8') === LIVE_GOOD, readFileSync(cfgFile, 'utf8'));
check('坏掉的那一份被留在一边，不是被删掉',
  typeof rolled?.kept === 'string' && existsSync(rolled.kept) && readFileSync(rolled.kept, 'utf8') === LIVE_BROKEN, String(rolled?.kept));
check('响应里说明要重启才生效', /重启/.test(String(rolled?.note)), rolled?.note);

const audit = await (await api('/api/audit?kind=config&limit=20')).json();
const rollbackRecords = (audit?.records ?? []).filter((r) => r.change === 'rollback_config');
check('【关键】回退进审计（否则「谁把它改回去了」没法回答）', rollbackRecords.length >= 1, JSON.stringify(audit?.records ?? []).slice(0, 300));
check('审计里写明从哪到哪', /回退到/.test(String(rollbackRecords[0]?.note)), rollbackRecords[0]?.note);

// The running process still uses what it loaded — which is the honest answer, and the reason
// the response says "restart".
const after = await (await api('/api/health')).json();
check('回退不会假装立刻换了配置（重启才生效）', after?.config?.degraded === true, JSON.stringify(after?.config));

try { child.kill(); } catch { /* already gone */ }
for (const d of dirs) removeTempDir(d);

console.log('');
if (failures) {
  console.log(`${failures} 项失败`);
  process.exit(1);
}
console.log('配置回退检查通过');
void rmSync;
