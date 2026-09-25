/**
 * 鉴权与租户边界 —— 离线，起一个真 server，不调模型。
 *
 * `guardRequest` 回答的是「这个请求是不是从本机来的」，它挡的是浏览器里的网页（靠 Host/Origin）。
 * 它挡不住以同一个用户身份运行的**任何进程** —— 那种进程伪造 Host 和 Origin 没有任何成本；
 * 一旦按文档把服务挂到反代后面（`SHE_ALLOWED_HOSTS`），同一个网络里的每个浏览器都带着
 * 一个**真实的、能对上的** Origin，于是和桌面端站在同一档上。
 *
 * 所以这里加的是另一个独立的问题：**你是谁**，答案由共享密钥给出，而不是由客户端能自己写的头给出。
 * 这个检查要断言的不是「鉴权能拦住请求」，而是几个更容易做错的地方：
 *
 *   1. **默认不开启。** 单人用的本地副本突然要 token 是更差的产品。开启是显式的，且开启后
 *      必须是 fail-closed：漏配 token、token 太短、token 撞车 → 都不许静默降级成「没鉴权」。
 *      最坏的情况不是打得开，而是**操作者以为端口受保护**。
 *   2. **token 只从头里读。** 查询串会被 access.log、shell history、反代日志、浏览器历史
 *      抄走，那些都不是本程序。落到别人的日志里就不算密钥了 —— 连 `?token=` 都要拒。
 *   3. **比较是常数时间的。** 按字符串比对会在第一个不同的字节上返回，一次一个字节就能试出密钥。
 *   4. **租户隔离不是「认证」的副产品。** 会话是按 id 取用的，光认证只会让 A 拿 B 的 id 照样读到
 *      别人的对话。列表接口也必须过滤 —— 标题本身往往就是敏感的部分。
 *   5. **无主会话的归属方向要偏保守。** 单租户时旧会话照旧可读（没有可隔离的对象）；
 *      多租户时拒掉（先问先得正是这个功能要防的错），并给操作者一条 `SHE_TENANT_ADOPT_TO` 的迁移路径。
 *   6. **token 一个字都不许回显。** 响应、审计、日志里都不能出现。
 *
 *   node scripts/tenant-boundary-check.mjs
 */
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
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
const TENANCY_ENTRY = join(SERVER_DIR, 'dist', 'tenancy.js');

if (!existsSync(SERVER_ENTRY) || !existsSync(TENANCY_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY} 或 ${TENANCY_ENTRY}\n请先 pnpm -r build`);
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

const TOKEN_A = 'tenant-a-token-0123456789';
const TOKEN_B = 'tenant-b-token-0123456789';

const tenancy = await import(pathToFileURL(TENANCY_ENTRY).href);
const {
  parseTenantTokens,
  loadTenancy,
  authenticate,
  presentedTokens,
  isPublicRoute,
  TenantLedger,
  runInTenant,
  currentTenant,
  AUTH_HEADER,
} = tenancy;

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 配置解析：错配要大声失败，不能静默变成「没鉴权」
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n1. token 列表的解析与校验');

{
  const off = loadTenancy({});
  check('两个变量都不设 → 鉴权关闭（单人本地副本是默认形态）', off.enabled === false, JSON.stringify(off));
  check('关闭时也有一个隐式租户可用', off.implicit === 'local', off.implicit);
  check('关闭时任何请求都放行', authenticate({}, off).ok === true, JSON.stringify(authenticate({}, off)));
}

{
  const one = loadTenancy({ SHE_AUTH_TOKEN: TOKEN_A });
  check('只设 SHE_AUTH_TOKEN → 开启，一个 default 租户', one.enabled === true && one.tenants.length === 1, JSON.stringify(one.tenants.map((t) => t.id)));
  check('单租户时系统租户就是它自己（定时任务有主）', one.system === 'default', one.system);
}

{
  const two = loadTenancy({ SHE_AUTH_TOKENS: `acme:${TOKEN_A},beta:${TOKEN_B}` });
  check('SHE_AUTH_TOKENS 支持 id:token 对', two.enabled === true && two.tenants.length === 2, JSON.stringify(two.tenants.map((t) => t.id)));
  check('多租户时系统租户是独立的 system（不冒充某个租户）', two.system === 'system', two.system);
  check('不带 id 的裸 token 会拿到位置化 id', parseTenantTokens([`${TOKEN_A},${TOKEN_B}`]).map((t) => t.id).join(',') === 'default,tenant-2',
    JSON.stringify(parseTenantTokens([`${TOKEN_A},${TOKEN_B}`])));
}

for (const [label, env] of [
  ['太短的 token', { SHE_AUTH_TOKEN: 'short' }],
  ['两个租户用同一个 token', { SHE_AUTH_TOKENS: `a:${TOKEN_A},b:${TOKEN_A}` }],
]) {
  let threw = null;
  try { loadTenancy(env); } catch (err) { threw = err; }
  check(`【关键】${label} → 启动即抛错，而不是静默接受`,
    threw !== null, threw === null ? '没有抛错（等于假装受保护）' : undefined);
  check(`   抛错说明了原因（${label}）`, /至少需要|token 重复/.test(String(threw?.message)), threw?.message);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 取值与比较：只认头、常数时间、不回显
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n2. token 的取法');

{
  check('认 x-she-token', presentedTokens({ [AUTH_HEADER]: TOKEN_A }).join() === TOKEN_A, null);
  check('认 Authorization: Bearer', presentedTokens({ authorization: `Bearer ${TOKEN_A}` }).join() === TOKEN_A, null);
  check('Bearer 大小写不敏感', presentedTokens({ authorization: `bearer ${TOKEN_A}` }).join() === TOKEN_A, null);
  check('【关键】查询串不是取值来源（会被别人的日志抄走）',
    presentedTokens({ host: `127.0.0.1?token=${TOKEN_A}` }).length === 0, null);
  check('Authorization 不是 Bearer 时不当成 token', presentedTokens({ authorization: `Basic ${TOKEN_A}` }).length === 0, null);
}

{
  const cfg = loadTenancy({ SHE_AUTH_TOKENS: `acme:${TOKEN_A},beta:${TOKEN_B}` });
  check('acme 的 token 解析到 acme', JSON.stringify(authenticate({ [AUTH_HEADER]: TOKEN_A }, cfg)) === JSON.stringify({ ok: true, tenant: 'acme' }),
    JSON.stringify(authenticate({ [AUTH_HEADER]: TOKEN_A }, cfg)));
  check('beta 的 token 解析到 beta', JSON.stringify(authenticate({ [AUTH_HEADER]: TOKEN_B }, cfg)) === JSON.stringify({ ok: true, tenant: 'beta' }),
    JSON.stringify(authenticate({ [AUTH_HEADER]: TOKEN_B }, cfg)));

  const missing = authenticate({}, cfg);
  check('【关键】没带 token → 拒绝', missing.ok === false, JSON.stringify(missing));
  check('拒绝理由不包含「没带 token」以外的信息，也不回显',
    !String(missing.reason).includes(TOKEN_A) && !String(missing.reason).includes(TOKEN_B), missing.reason);

  const wrong = authenticate({ [AUTH_HEADER]: `${TOKEN_A}x` }, cfg);
  check('【关键】token 只差一个字符 → 拒绝', wrong.ok === false, JSON.stringify(wrong));
  check('拒绝理由里不含任何 token 片段', !String(wrong.reason).includes(TOKEN_A.slice(0, 8)), wrong.reason);
}

{
  // Public surface: the liveness probe only, and only GET.
  check('/api/health 免鉴权（桌面端与离线检查靠它探活）', isPublicRoute('GET', '/api/health') === true, null);
  check('【关键】配置回退视图不免鉴权（它会说出工作区里的文件名）', isPublicRoute('GET', '/api/config/recovery') === false, null);
  check('【关键】鉴权状态接口不免鉴权（它要回显调用者的租户）', isPublicRoute('GET', '/api/auth/status') === false, null);
  check('health 的其它方法不免鉴权', isPublicRoute('POST', '/api/health') === false, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 账本：无主会话的方向，以及异步上下文
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n3. 会话归属账本');

{
  const dir = mkdtempSync(join(tmpdir(), 'she-tenant-ledger-'));
  const ledger = new TenantLedger(dir);
  const two = loadTenancy({ SHE_AUTH_TOKENS: `acme:${TOKEN_A},beta:${TOKEN_B}` });
  const one = loadTenancy({ SHE_AUTH_TOKEN: TOKEN_A });

  ledger.claim('s1', 'acme');
  check('自己建的会话自己读得到', ledger.canAccess('s1', 'acme', two) === true, null);
  check('【关键】别人的会话读不到', ledger.canAccess('s1', 'beta', two) === false, null);
  check('【关键】多租户下无主会话也不给读（不搞先问先得）', ledger.canAccess('s-orphan', 'beta', two) === false, null);
  check('【关键】单租户下无主会话仍可读（开 token 不该让昨天的对话消失）', ledger.canAccess('s-orphan', 'default', one) === true, null);
  check('没有请求上下文的干活方（定时任务）不被自己的隔离挡住', ledger.canAccess('s1', undefined, two) === true, null);
  check('鉴权关闭时一切照旧', ledger.canAccess('s1', 'beta', loadTenancy({})) === true, null);

  ledger.claim('s2', 'beta');
  ledger.claim('s3', 'acme');
  const adopted = ledger.adopt(['s-orphan', 's1', 's-never'], 'acme');
  check('adopt 只认领无主的，不抢已有归属', adopted === 2, `认领了 ${adopted} 个`);
  check('adopt 之后 s-orphan 归 acme', ledger.ownerOf('s-orphan') === 'acme', null);
  check('【关键】adopt 不会把 s2（beta 的）改走', ledger.ownerOf('s2') === 'beta', ledger.ownerOf('s2'));
  check('认领后的 s-never 仍不许 beta 读', ledger.canAccess('s-never', 'beta', two) === false, null);

  removeTempDir(dir);
}

{
  const dir = mkdtempSync(join(tmpdir(), 'she-tenant-als-'));
  const ledger = new TenantLedger(dir);
  check('没有请求上下文时 currentTenant() 是 undefined', currentTenant() === undefined, String(currentTenant()));
  const seen = await runInTenant('acme', async () => {
    await new Promise((r) => setTimeout(r, 5));
    const afterAwait = currentTenant();
    await Promise.resolve();
    return [afterAwait, currentTenant()];
  });
  check('【关键】租户上下文能穿过 await（工具调用三层深也知道自己属于谁）',
    seen.join(',') === 'acme,acme', seen.join(','));
  check('出了作用域就恢复成 undefined（不会漏给下一个请求）', currentTenant() === undefined, String(currentTenant()));
  void ledger;
  removeTempDir(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 真 server：401、隔离、审计、不回显
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n4. 真 server：无 token 拒之，跨租户读不到');

const dirs = [];
const tempDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `she-tenant-${tag}-`));
  dirs.push(d);
  return d;
};

const PORT = String(await pickSafePort(Number(process.env.SHE_TENANT_TEST_PORT || 18291), [18292, 18293, 18294, 19294]));
const ws = tempDir('live');
mkdirSync(join(ws, '.she'), { recursive: true });

const child = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: ws,
    SHE_PORT: PORT,
    SHE_APP_DIR: join(ws, 'appdir'),
    SHE_STATE_DIR: ws,
    SHE_AUTH_TOKENS: `acme:${TOKEN_A},beta:${TOKEN_B}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverOut = '';
child.stdout.on('data', (c) => { serverOut += c; });
child.stderr.on('data', (c) => { serverOut += c; });

const base = `http://127.0.0.1:${PORT}`;
const api = (path, { token, ...init } = {}) => fetch(`${base}${path}`, {
  signal: AbortSignal.timeout(8000),
  ...init,
  headers: { ...(init.headers ?? {}), ...(token ? { [AUTH_HEADER]: token } : {}) },
});
const post = (path, body, token) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
  token,
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

async function waitForHealth(timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
      // A 401 here would mean health is gated, which is itself a failure worth surfacing.
      if (r.status === 401) return { __unauthorized: true };
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const health = await waitForHealth();
check('server 起来了', health !== null && health.__unauthorized !== true, serverOut.slice(-500));
check('启动日志说清了鉴权已开启', /鉴权：已开启，2 个租户/.test(serverOut), serverOut.slice(-500));
check('启动日志说了从哪里读 token', new RegExp(AUTH_HEADER).test(serverOut), serverOut.slice(-300));
check('【关键】启动日志里没有 token 本身', !serverOut.includes(TOKEN_A) && !serverOut.includes(TOKEN_B), serverOut.slice(-600));

{
  const r = await api('/api/health');
  check('【关键】无 token 也探得活（桌面端要能问「起来了没」）', r.status === 200, `status=${r.status}`);
}

{
  const r = await api('/api/sessions');
  const body = await json(r);
  check('【关键】无 token 读会话列表 → 401', r.status === 401, `status=${r.status} body=${JSON.stringify(body)}`);
  check('401 响应体里没有 token', !JSON.stringify(body ?? {}).includes(TOKEN_A), JSON.stringify(body));
}

{
  const r = await api('/api/sessions', { token: `${TOKEN_A}zz` });
  check('【关键】错 token → 401', r.status === 401, `status=${r.status}`);
}

{
  const r = await api('/api/config/recovery');
  check('【关键】配置回退视图同样要 token', r.status === 401, `status=${r.status}`);
}

{
  const r = await api('/api/auth/status', { token: TOKEN_A });
  const body = await json(r);
  check('带对 token → /api/auth/status 200', r.status === 200, `status=${r.status}`);
  check('它说出调用者属于哪个租户', body?.tenant === 'acme', JSON.stringify(body));
  check('它告诉客户端 token 放在哪个头（不让人去猜、也不让人用查询串）', body?.header === AUTH_HEADER, JSON.stringify(body));
  check('【关键】它不回显 token', !JSON.stringify(body ?? {}).includes(TOKEN_A), JSON.stringify(body));
  check('它不列出别的租户 id（那等于报出这台机器上还有谁）',
    !JSON.stringify(body ?? {}).includes('beta'), JSON.stringify(body));
}

let sessionA = null;
{
  const r = await post('/api/sessions', { title: 'A 的会话' }, TOKEN_A);
  const body = await json(r);
  sessionA = body?.id ?? null;
  check('acme 建会话成功', r.status === 200 || r.status === 201, `status=${r.status}`);
  check('拿到了会话 id', typeof sessionA === 'string' && sessionA.startsWith('sess_'), String(sessionA));
}

{
  const listA = await json(await api('/api/sessions?all=1', { token: TOKEN_A }));
  check('acme 在自己的列表里看得到', (listA?.sessions ?? []).some((s) => s.id === sessionA), JSON.stringify(listA?.sessions ?? []).slice(0, 300));

  const listB = await json(await api('/api/sessions?all=1', { token: TOKEN_B }));
  check('【关键】beta 的列表里没有 acme 的会话（标题本身也是敏感信息）',
    !(listB?.sessions ?? []).some((s) => s.id === sessionA), JSON.stringify(listB?.sessions ?? []).slice(0, 300));
  check('beta 列表里也没有 acme 的标题', !JSON.stringify(listB ?? {}).includes('A 的会话'), JSON.stringify(listB ?? {}).slice(0, 300));

  const convB = await json(await api('/api/conversations', { token: TOKEN_B }));
  check('【关键】/api/conversations 也过滤', !JSON.stringify(convB ?? {}).includes(sessionA), JSON.stringify(convB ?? {}).slice(0, 300));

  const readB = await api(`/api/sessions/${sessionA}`, { token: TOKEN_B });
  check('【关键】beta 拿着 id 直取 → 404（不说「存在但你不许看」）', readB.status === 404, `status=${readB.status}`);

  const closeB = await post(`/api/sessions/${sessionA}/close`, {}, TOKEN_B);
  check('【关键】beta 也关不掉 acme 的会话', closeB.status === 404, `status=${closeB.status}`);

  const closeA = await post(`/api/sessions/${sessionA}/close`, {}, TOKEN_A);
  check('acme 自己关得掉（隔离没有把自己也挡住）', closeA.status === 200, `status=${closeA.status}`);
}

{
  const auditPath = join(ws, '.she', 'audit.log');
  const raw = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
  const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const refusals = lines.filter((r) => r.kind === 'auth');
  check('【关键】被拒绝的请求进了审计（「什么时候开始的」要答得出来）', refusals.length >= 3, `找到 ${refusals.length} 条`);
  check('审计里写了它想访问哪个路由', typeof refusals[0]?.path === 'string' && refusals[0].path.includes('/api/'), JSON.stringify(refusals[0]));
  check('审计里区分了「完全没带 token」和「token 不对」',
    refusals.some((r) => r.presented === false) && refusals.some((r) => r.presented === true),
    JSON.stringify(refusals.map((r) => r.presented)));
  check('【关键】审计里没有 token', !raw.includes(TOKEN_A) && !raw.includes(TOKEN_B), null);

  const status = await api('/api/audit?kind=auth&limit=20', { token: TOKEN_A });
  check('审计能按 kind=auth 查（新 kind 接进了校验白名单）', status.status === 200, `status=${status.status}`);
}

child.kill();
await new Promise((r) => setTimeout(r, 600));
for (const d of dirs) removeTempDir(d);

console.log('');
if (failures) {
  console.log(`${failures} 项失败`);
  process.exit(1);
}
console.log('租户边界检查通过');
