/**
 * 出口合规护栏 —— 全部离线，本地起一个真 server，不调模型。
 *
 * 这个功能的错误方向很特别：**漏报**的代价是一份凭据离开这台机器（然后被转发、被归档、
 * 被写进工单），而**误报**的代价是用户学会无视这条提示，于是漏报的代价照样付。所以断言分成
 * 两半，两半都不能省：
 *
 *   1. **该抓的抓到**：私钥块、厂商前缀密钥、JWT、`Bearer`、带密码的连接串、凭据赋值。
 *   2. **不该抓的不抓**：git hash、UUID、普通带端口的 URL、`sk-learn` 这种词、句中间的
 *      「confidential」、单纯一个 18 位数字。这半边更容易被忽略，而它才是这条护栏能否
 *      活过第一周的真正原因。
 *
 * 另外三条是行为约定，都是「不要静默」的变体：
 *
 *   - **回答不改写。** 悄悄改回答会让「它说过什么」和「轨迹里记着什么」对不上，而本项目整套
 *     自省（批评者、运行轨迹、交付模板）都靠这个对应关系。所以护栏只报告。
 *   - **交付文件拦下来。** 那是要给别人看、会被转发和归档的东西，凭据写进去就是泄漏 —— 而且
 *     模型还在上下文里，一轮就能改掉。显式 `acknowledge_sensitive` 可以覆盖，故意写成这么长是
 *     为了不能顺手加上。
 *   - **落盘的副本要洗掉值。** 运行轨迹和审计日志都是用户没要求的第二份拷贝，工具**结果**
 *     （`cat .env`、CI 日志）才是密钥最常见的来源，所以那里扫的是值本身，不只是键名。
 *
 *   node scripts/guardrail-check.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const AGENT_DIR = join(ROOT, 'packages', 'agent-runtime');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');

if (!existsSync(SERVER_ENTRY)) {
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

const {
  scanOutbound,
  summariseFindings,
  highFindings,
  redactForRecord,
  renderGuardrailNotice,
  renderGuardrailRefusal,
  guardrailPolicy,
} = await import(pathToFileURL(join(AGENT_DIR, 'dist', 'guardrail.js')).href);
const { Agent, RunTraceStore, createPlanTools } = await import(pathToFileURL(join(AGENT_DIR, 'dist', 'index.js')).href);
const { loadConfig } = await import(pathToFileURL(join(ROOT, 'packages', 'shared', 'dist', 'index.js')).href);
const { KBStore, GroupKBEngine } = await import(pathToFileURL(join(ROOT, 'packages', 'kb', 'dist', 'index.js')).href);
const { SandboxShell, createTools } = await import(pathToFileURL(join(ROOT, 'packages', 'sandbox', 'dist', 'index.js')).href);

const dirs = [];
const tempDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `she-guard-${tag}-`));
  mkdirSync(join(d, '.she'), { recursive: true });
  dirs.push(d);
  return d;
};
process.on('exit', () => { for (const d of dirs) removeTempDir(d); });

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 该抓的抓到
 * ══════════════════════════════════════════════════════════════════════════ */

// Shaped like the real thing on purpose, and fake: `sk-` + 32 chars, an AWS key id, a JWT.
const SECRETS = {
  api_key: 'sk-abcdefghij0123456789ABCDEFGHIJ',
  github: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  bearer: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
  dsn: 'postgres://app:hunter2secret@db.internal:5432/prod',
  assignment: 'CI_JOB_TOKEN=abcdefghijklmnop1234',
  keyblock: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----',
};

console.log('\n1. 该抓的抓到');
{
  const cases = [
    ['私钥块', SECRETS.keyblock, 'private_key'],
    ['OpenAI / DeepSeek 风格的 sk-', SECRETS.api_key, 'api_key'],
    ['GitHub ghp_', SECRETS.github, 'api_key'],
    ['AWS AKIA', SECRETS.aws, 'api_key'],
    ['JWT', SECRETS.jwt, 'jwt'],
    ['Bearer 令牌', SECRETS.bearer, 'bearer'],
    ['带密码的连接串', SECRETS.dsn, 'connection_string'],
    ['大写键名赋值', SECRETS.assignment, 'credential_assignment'],
    ['中文「密钥是…」', '你的密钥是 abcd1234efgh5678，别再贴出来了', 'credential_assignment'],
  ];
  for (const [label, text, kind] of cases) {
    const found = scanOutbound(`这是回答：${text}\n后面还有一句正常的话。`);
    check(`抓到「${label}」`, found.some((f) => f.kind === kind), JSON.stringify(found));
  }
  const inCode = scanOutbound(['```bash', `export OPENAI_API_KEY="${SECRETS.api_key}"`, '```'].join('\n'));
  check('代码块里也抓得到', inCode.some((f) => f.severity === 'high'), JSON.stringify(inCode));
}

console.log('\n2. 机密标记是一种声明，不是猜');
{
  const marked = scanOutbound('机密\n\n以下是内部资料摘要：…');
  check('行首的「机密」被记为 note（不是 high）',
    marked.some((f) => f.kind === 'confidential_marker' && f.severity === 'note'), JSON.stringify(marked));
  const english = scanOutbound('CONFIDENTIAL\n\nQuarterly numbers follow.');
  check('英文 CONFIDENTIAL 同样识别', english.some((f) => f.kind === 'confidential_marker'), JSON.stringify(english));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 不该抓的不抓
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n3. 不该抓的不抓（这半边决定这条护栏能不能活过第一周）');
{
  const noise = [
    ['git 短 hash', '修复见 commit cafbf9e，改了 agent.ts。'],
    ['完整 git hash', 'commit 9eba9e261a08702ecfbda87874b71fc36eb14f9d 是批次 H'],
    ['UUID', '会话 id 是 e4509b46-c615-4698-b414-13253a9a8eb3'],
    ['带端口的普通 URL', '服务在 http://127.0.0.1:18281/api/health'],
    ['没有密码的 URL 用户信息', 'repo 地址是 git@github.com:org/repo.git'],
    ['像前缀的词', '我读了 sk-learn 的文档，也看过 npm run build'],
    ['句中间的 confidential 讨论', '这个文件里写着 confidential 这个词，但那只是文档在解释它。'],
    ['18 位数字', '订单号 123456789012345678，对不上再去查。'],
    ['谈到 token 但没有值', '我检查了 TOKEN 的读取顺序，env 会覆盖配置文件。'],
    ['base64 数据块', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='],
    ['普通 shell 命令', 'pnpm check:offline && node scripts/docs-check.mjs'],
  ];
  for (const [label, text] of noise) {
    const found = scanOutbound(text);
    check(`不误报：${label}`, found.length === 0, JSON.stringify(found));
  }
  check('空字符串不产生任何发现', scanOutbound('').length === 0, null);
  check('纯正常回答不产生任何发现',
    scanOutbound('我把 agent.ts 里的重复调用检测改成用 verdict.retryable 了，测试全过。').length === 0, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 遮罩与去重
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n4. 报出来的东西里不能有原值');
{
  const text = `把 ${SECRETS.api_key} 换成新的；顺便 ${SECRETS.dsn}`;
  const found = scanOutbound(text);
  check('两处都记下来了', found.length === 2, JSON.stringify(found));
  const rendered = renderGuardrailNotice(found);
  check('【关键】渲染出来的提示里不含完整密钥', !rendered.includes(SECRETS.api_key), rendered);
  check('【关键】渲染出来的提示里不含连接串密码', !rendered.includes('hunter2secret'), rendered);
  check('提示里保留了头尾，能对上号', /sk-abc…/.test(rendered), rendered);
  check('提示里说清了没有改回答', /未改动你的回答/.test(rendered), rendered);
  check('提示里给出可执行的下一步', /不要把它转发/.test(rendered), rendered);

  // A DSN contains `user:pass@host`; a `Bearer`-shaped fragment inside it must not be reported twice.
  const overlapping = scanOutbound('redis://default:Bearer_abcdefghijklmnop@cache:6379');
  check('重叠的形状只报一次（一条泄漏报三遍就没人读了）', overlapping.length === 1, JSON.stringify(overlapping));

  const counts = summariseFindings(scanOutbound(`A: ${SECRETS.api_key}\nB: ${SECRETS.github}`));
  check('同类的两处合并成一个计数', counts.length === 1 && counts[0].count === 2, JSON.stringify(counts));
  check('只有 high 会被当成阻断项', highFindings(scanOutbound('机密\n\nsk-abcdefghij0123456789ABCDEFGHIJ')).length === 1, null);
}

console.log('\n5. 落盘副本的洗值');
{
  const text = `先看这个：\n${SECRETS.api_key}\n再记一下 ${SECRETS.dsn}\n机密\n`;
  const cleaned = redactForRecord(text);
  check('【关键】洗过之后没有完整密钥', !cleaned.includes(SECRETS.api_key), cleaned);
  check('【关键】洗过之后没有连接串密码', !cleaned.includes('hunter2secret'), cleaned);
  check('洗掉的地方留了标记（不是空白，读的人知道这里少了东西）', /\[已隐去：接口密钥\]/.test(cleaned), cleaned);
  check('【关键】机密标记本身不许被洗掉（洗掉就等于抹掉分类）', /机密/.test(cleaned), cleaned);
  check('普通文字原样保留', cleaned.includes('先看这个：') && cleaned.includes('再记一下'), cleaned);

  const refusal = renderGuardrailRefusal(scanOutbound(text));
  check('拒绝文案点名了问题种类', /接口密钥/.test(refusal), refusal);
  check('拒绝文案给出改法', /占位符/.test(refusal), refusal);
  check('拒绝文案说明覆盖开关', /acknowledge_sensitive/.test(refusal), refusal);
  check('【关键】拒绝文案里也没有原值', !refusal.includes(SECRETS.api_key), refusal);
}

console.log('\n6. 策略开关');
{
  check('默认是 warn（不能默认改写别人的东西）', guardrailPolicy(undefined) === 'warn', guardrailPolicy(undefined));
  check('SHE_GUARDRAIL=off 会关掉', guardrailPolicy('off') === 'off', guardrailPolicy('off'));
  check('大小写与空格都容忍', guardrailPolicy(' OFF ') === 'off', guardrailPolicy(' OFF '));
  check('看不懂的值退回 warn（宁可多提示）', guardrailPolicy('maybe') === 'warn', guardrailPolicy('maybe'));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 真 Agent：报告但不改写，并且写进运行轨迹
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n7. 真 Agent：只报告，不改写回答');

const cfg = loadConfig(ROOT);

function makeAgent(ws, answer) {
  const store = new KBStore(join(ws, 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(ws, 'kb.sqlite') });
  const shell = new SandboxShell(ws, { ...cfg.sandbox, allowAllCommands: true });
  const base = createTools(shell, ws, { allowAllCommands: true });
  const config = loadConfig(ROOT);
  config.workspace.root = ws;
  config.llm = { ...config.llm, model: 'stub', baseUrl: 'http://stub.invalid' };
  const runs = new RunTraceStore(ws);
  const agent = new Agent(config, engine, base, null, { runTrace: runs });
  agent.provider = { name: 'stub', async chat() { return { role: 'assistant', content: answer }; } };
  return { agent, store, runs };
}

const ANSWER = `你的 key 是 ${SECRETS.api_key}，已经写进 .env 了。`;

{
  const ws = tempDir('agent');
  const { agent, store, runs } = makeAgent(ws, ANSWER);
  const chunks = [];
  const reply = await agent.chat('我的 key 是什么', (c) => chunks.push(c));
  check('【关键】回答本身没有被改写（说的和记的必须对得上）', reply.content === ANSWER, reply.content);
  const status = chunks.filter((c) => c.type === 'status').map((c) => c.content).join('\n');
  check('【关键】用户当场被告知了', /不该外发/.test(status), status);
  check('状态提示里不含完整密钥', !status.includes(SECRETS.api_key), status);

  const report = agent.getGuardrailReport();
  check('报告以结构化形式留着（不是只能从提示里读）', report?.findings.length === 1, JSON.stringify(report));
  check('报告里记着策略', report?.policy === 'warn', report?.policy);
  check('累计历史也留着（「这个工作区漏过吗」要答得出来）', agent.getGuardrailHistory().length === 1, null);

  const run = runs.list()[0];
  const detail = runs.read(run.id);
  const steps = detail.events.filter((e) => e.kind === 'step').map((e) => e.text).join('\n');
  check('【关键】运行轨迹里留了一行（事后能查）', /出口合规护栏/.test(steps), steps.slice(-300));
  check('【关键】轨迹里没有密钥的值', !JSON.stringify(detail.events).includes(SECRETS.api_key), null);

  store.close();
}

{
  const ws = tempDir('agent-off');
  const { agent, store } = makeAgent(ws, ANSWER);
  process.env.SHE_GUARDRAIL = 'off';
  try {
    const chunks = [];
    await agent.chat('我的 key 是什么', (c) => chunks.push(c));
    check('关掉之后不提示', !chunks.some((c) => c.type === 'status' && /不该外发/.test(String(c.content))), null);
    check('关掉之后不产生报告', agent.getGuardrailReport() === null, JSON.stringify(agent.getGuardrailReport()));
  } finally {
    delete process.env.SHE_GUARDRAIL;
    store.close();
  }
}

{
  const ws = tempDir('agent-clean');
  const { agent, store } = makeAgent(ws, '改完了，测试全过。');
  const chunks = [];
  await agent.chat('做完了吗', (c) => chunks.push(c));
  check('干净的回答不打扰用户', !chunks.some((c) => c.type === 'status' && /不该外发/.test(String(c.content))), null);
  check('干净的回答也留下报告（只是空的，便于确认检查真的跑了）',
    agent.getGuardrailReport()?.findings.length === 0, JSON.stringify(agent.getGuardrailReport()));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 交付文件：这里要拦，因为它是给别人看的
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n8. 交付文件拦下来（回答只是提示，交付是拒绝）');
{
  const ws = tempDir('report');
  const tools = createPlanTools(ws, null);
  const write = tools.execute;

  const withSecret = await write('report_write', {
    kind: 'report',
    title: '部署说明',
    summary: `连接串是 ${SECRETS.dsn}`,
    sections: [],
  });
  check('【关键】带凭据的交付被拒绝', /^Error:/.test(withSecret), withSecret);
  check('拒绝文案说明是敏感内容', /敏感内容/.test(withSecret), withSecret);
  check('【关键】拒绝时文件确实没写出来',
    !existsSync(join(ws, '.she', 'reports')), readdirSafe(join(ws, '.she', 'reports')));
  check('【关键】拒绝文案里没有原值', !withSecret.includes('hunter2secret'), withSecret);


  const placeheld = await write('report_write', {
    kind: 'report',
    title: '部署说明',
    summary: '连接串见 .env 的 DATABASE_URL，形如 postgres://app:<PASSWORD>@host:5432/prod',
    sections: [],
  });
  check('把值换成占位符就能写出来', /Report written/.test(placeheld), placeheld);

  const acknowledged = await write('report_write', {
    kind: 'report',
    title: '轮换记录',
    summary: `旧 key（已吊销）：${SECRETS.api_key}`,
    sections: [],
    acknowledge_sensitive: true,
  });
  check('显式 acknowledge_sensitive 可以覆盖（故意的选择被放行，不是被禁止）',
    /Report written/.test(acknowledged), acknowledged);
  check('覆盖后确实写进了文件',
    existsSync(join(ws, '.she', 'reports')), readdirSafe(join(ws, '.she', 'reports')));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 9. 真 server：第二份拷贝（轨迹 / 审计）里没有值
 *
 * The model is a local stub rather than an unreachable URL, and that is the whole point of the
 * section: the interesting copies are the ones produced AFTER a successful turn — the answer, the
 * findings, the guardrail audit record. Pointing at a dead port would leave all of them empty and
 * the assertions would pass by having nothing to check, which is the failure mode this suite is
 * supposed to be immune to.
 *
 * The stub answers with a credential, because that is the only input that exercises both halves:
 * the answer path (reported, not rewritten) and the record path (values stripped).
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n9. 真 server：第二份拷贝（轨迹 / 审计）里没有值');

const LLM_ANSWER = `你的 key 是 ${SECRETS.api_key}，已经写进 .env 了。连接串是 ${SECRETS.dsn}`;
const stubLlm = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let wantsStream = false;
    try { wantsStream = JSON.parse(Buffer.concat(chunks).toString('utf8')).stream === true; } catch { /* non-streaming */ }
    if (wantsStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: LLM_ANSWER } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: LLM_ANSWER }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 },
    }));
  });
});
const LLM_PORT = await pickSafePort(Number(process.env.SHE_GUARD_LLM_PORT || 18301), [18302, 18303, 19304]);
await new Promise((r) => stubLlm.listen(LLM_PORT, '127.0.0.1', r));

const PORT = String(await pickSafePort(Number(process.env.SHE_GUARD_TEST_PORT || 18291), [18292, 18293, 19294]));
const ws = tempDir('she-guard-live-');
writeFileSync(join(ws, '.env'), `LEAKED_API_KEY=${SECRETS.api_key}\n`, 'utf8');
writeFileSync(join(ws, 'secrets.txt'), `token: ${SECRETS.bearer}\n`, 'utf8');

const child = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: ws,
    SHE_PORT: PORT,
    SHE_APP_DIR: join(ws, 'appdir'),
    SHE_STATE_DIR: ws,
    SHE_LLM_PROVIDER: 'openai',
    /*
     * The real variable names matter here, and getting them wrong is silent: the config layer reads
     * `OPENAI_BASE_URL` / `OPENAI_MODEL` (not `SHE_LLM_BASE_URL` / `SHE_LLM_MODEL`), so a typo
     * leaves the provider pointed at the public API — the turn then retries a real endpoint for a
     * minute and the failure surfaces as a guardrail timeout. Both were wrong here until the stub
     * made the run fast enough that the difference was visible.
     */
    OPENAI_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
    OPENAI_MODEL: 'stub',
    OPENAI_API_KEY: 'stub-key',
    SHE_GUARDRAIL: 'warn',
    /*
     * No tool-round cap.
     *
     * `SHE_MAX_TOOL_ROUNDS=1` looks like "keep the test short" and is the opposite: the turn opens
     * with the built-in kb_query / errorbook_lookup / fs_list rounds, so a cap of one cuts the loop
     * off BEFORE the model ever answers — the run fails with `max_iterations`, no answer exists, and
     * the guardrail assertions then fail for a reason that has nothing to do with the guardrail. The
     * stub below answers without tool calls, so the loop ends on its own after one model round.
     */
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
/**
 * A turn takes as long as it takes.
 *
 * The default 8s is right for a status read and wrong for `/api/chat`: the turn has to reach the
 * model, possibly run a tool round, then be criticised and scanned. A timeout here would look
 * exactly like a guardrail failure, so the budget is set from the thing being measured.
 */
const postTurn = (path, body, timeoutMs = 60_000) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
  signal: AbortSignal.timeout(timeoutMs),
});

if (!(await waitForHealth())) {
  check('server 起得来', false, serverOut.slice(-500));
} else {
  const policy = await (await api('/api/guardrail')).json();
  check('GET /api/guardrail 报出策略', policy?.policy === 'warn', JSON.stringify(policy).slice(0, 200));
  check('还没有轮次时 last 是 null（不是编一个空对象）', policy?.last === null, JSON.stringify(policy?.last));

  // A request whose message IS a credential — the audit trail is a second copy of it — and whose
  // answer is another credential. Both copies have to come back clean.
  const chat = await postTurn('/api/chat', { message: `帮我看看这个 key：${SECRETS.api_key}`, stream: false });
  check('这一轮真的跑成功了（模型是本地 stub，不是超时）', chat.ok, `${chat.status} ${(await chat.text().catch(() => '')).slice(0, 300)}`);

  const audit = await (await api('/api/audit?limit=50')).json();
  const requests = (audit?.records ?? []).filter((r) => r.kind === 'request');
  check('请求进了审计', requests.length >= 1, JSON.stringify(audit?.records ?? []).slice(0, 300));
  check('【关键】审计里的请求不含完整密钥',
    !JSON.stringify(audit?.records ?? []).includes(SECRETS.api_key), JSON.stringify(requests.slice(-2)));
  check('审计里留下了隐去标记', /已隐去/.test(JSON.stringify(requests.slice(-2))), JSON.stringify(requests.slice(-2)));

  // The server's own copy of the answer/findings, via the guardrail route.
  const after = await (await api('/api/guardrail')).json();
  check('护栏接口能读到本轮发现（说明模型确实答出了密钥）',
    after?.counts?.history >= 1 || after?.counts?.last >= 1, JSON.stringify(after).slice(0, 300));
  check('【关键】护栏接口返回的是遮罩预览', !JSON.stringify(after).includes(SECRETS.api_key), JSON.stringify(after).slice(0, 500));
  const guardRecords = ((await (await api('/api/audit?kind=guardrail&limit=20')).json())?.records ?? []);
  check('护栏在审计里留了记录（事后能查「哪天开始出现」）', guardRecords.length >= 1, JSON.stringify(guardRecords).slice(0, 300));
  check('【关键】护栏审计记录里也没有原值',
    !JSON.stringify(guardRecords).includes(SECRETS.api_key)
      && !JSON.stringify(guardRecords).includes('hunter2secret'), JSON.stringify(guardRecords).slice(0, 400));

  // The trace: both the prompt (which quoted a key) and any quoted tool result must be clean.
  const runs = await (await api('/api/runs?limit=5')).json();
  const runIds = (runs?.runs ?? []).map((r) => r.id);
  let traceText = '';
  for (const id of runIds) {
    const detail = await (await api(`/api/runs/${id}`)).json();
    traceText += JSON.stringify(detail);
  }
  check('跑完的轮次留下了运行轨迹（否则这条断言是空过的）', runIds.length >= 1, JSON.stringify(runs).slice(0, 300));
  check('【关键】运行轨迹里没有模型密钥', !traceText.includes(SECRETS.api_key), traceText.slice(0, 300));
  check('【关键】运行轨迹里没有连接串密码', !traceText.includes('hunter2secret'), traceText.slice(0, 300));
  check('轨迹里看得见护栏这一行（不是只有值被删掉了）', /出口合规护栏|不该外发/.test(traceText), traceText.slice(0, 400));

  try { child.kill(); } catch { /* already gone */ }
}
try { stubLlm.close(); } catch { /* already gone */ }

console.log('');
if (failures) {
  console.log(`${failures} 项失败`);
  process.exit(1);
}
console.log('出口合规护栏检查通过');

/** `readdirSync` that returns a readable list instead of throwing when the directory is absent. */
function readdirSafe(dir) {
  try {
    return JSON.stringify(readFileSync(dir, 'utf8'));
  } catch {
    return '(不存在)';
  }
}
