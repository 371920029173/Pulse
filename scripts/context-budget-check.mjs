/**
 * 动态上下文 / 成本面板的服务端契约。
 *
 * 用户要的是「填 token 定价 → 据此分配最优压缩逻辑 → 取到最小消耗」。这个门禁钉的不是算术
 * （那是 `packages/agent-runtime/src/__tests__/context-budget.test.ts` 的事，纯函数、无端口），
 * 而是**接线**和**一条不能破的承诺**：
 *
 *   1. 定价真的参与决策。同一段会话、同样的档位，只改单价，建议必须跟着改 —— 否则"按你的定价
 *      分配"就只是一句文案，面板会变成一个显示固定建议的装饰品。
 *   2. 没填单价时不许报钱。`pricingConfigured` 为 false 时金额必须是 0，并且回一句"还没填单价"：
 *      把"不知道"说成"免费"比不说更糟，而账单对不上时用户只会怪这个面板。
 *   3. **默认一条历史都不删。** 会删用户内容的杠杆只有两个条件同时成立才动手：用户在设置里显式
 *      打开 `allowHistoryReduction`，且档位到 aggressive。而且"没传这个字段"绝不能被当成 true ——
 *      这是唯一一个能弄丢用户东西的开关。
 *   4. 免责声明逐字出现在接口里，且和决策逻辑同源（面板直接显示服务端下发的这句）。
 *
 * 第 7~10 节是**天花板救援**（用户报的"上下文一到上限整条会话就不可用"）：窗口能不能读、能不能改、
 * 写坏了会不会被吞掉，以及真压一次到底压没压 —— 最后那节跑的是 dist 里那份代码、对着一个本地桩
 * 模型，因为这条路径的失败方式（"压没压看不出来"）在源码层面看不出来。
 *
 * 第 11 节是"更聪明"的那三处：分类账（窗口被谁吃掉了）、压缩原文可回读（压缩不等于永久丢失）、
 * 以及从拒绝报文里学会真实上限 —— 前两处的证据来自第 10 节那一轮，第三处的证据就是第 10.4 节那次
 * 真实 400。
 *
 * 第 12 节是本仓库自己的那两处：换算比用真实用量**自校准**（不再靠写死的常量 + 人工重测），以及
 * 摘要抬头里的**取回锚点**（文件 / 命令 / 报错串 / 知识库组路径）。桩模型按 3.2 报 token 数，所以
 * "它到底学没学到"在这一节是可断言的。
 *
 * 第 13 节是四个"可测量"的读数：压缩经济学（省 = 差值 × 轮数，付 = provider 报的未命中）、取回率
 * （有没有人真去读被压掉的原文）、锚点数、以及这一刻的工具结果预算。前三个都是**事后查得到**的数，
 * 而不是设计时的猜测。
 *
 *   node scripts/context-budget-check.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';
import { killTree } from './lib/kill-tree.mjs';
import { controlHeaders } from './lib/control-auth.mjs';
import { hermeticEnv } from './lib/hermetic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
  }
};

/** 用户要求逐字出现的那句。写死在这里是有意的：它变了就该有人来改这个门禁。 */
const REQUIRED_DISCLAIMER =
  '该功能尽量为您减少开支，但不保证不会使您的开支增加：压缩会让模型为了补上被省掉的上下文而多跑几轮，'
  + '那几轮同样要花钱。请对照账单核对，不要只信这里估算。';

if (!existsSync(SERVER_ENTRY)) {
  console.log('FAIL  packages/server/dist/index.js 不存在 —— 先 pnpm build');
  process.exit(1);
}

const PORT = await pickSafePort(5620);
const workspace = mkdtempSync(join(tmpdir(), 'she-ctx-'));
mkdirSync(join(workspace, '.she'), { recursive: true });
const envFile = join(workspace, '.env');

const child = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: hermeticEnv({
    SHE_WORKSPACE: workspace,
    SHE_PORT: PORT,
    SHE_ENV_FILE: envFile,
    SHE_APP_DIR: join(workspace, 'appdir'),
    SHE_STATE_DIR: workspace,
    /*
     * 桩模型只回 JSON，不实现 SSE。流式与否不影响第 10 节要断言的东西（请求体），但它决定了
     * 桩要不要额外实现一套帧协议 —— 少一套就少一处"桩自己坏了"的可能。
     */
    SHE_LLM_STREAM: 'off',
  }),
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

const api = (path, init) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  signal: AbortSignal.timeout(8000),
  ...init,
  // 控制面（/api/settings 一类）第四轮起要认凭据：本脚本起的后端用 SHE_APP_DIR=workspace/appdir，
  // 令牌就在那底下，按同样规则找（见 lib/control-auth.mjs）。
  headers: { ...controlHeaders(join(workspace, 'appdir')), ...(init?.headers ?? {}) },
});
const get = async (path) => (await api(path)).json();
const send = (method, path, body) => api(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const plan = () => get('/api/context/plan');
const settings = () => get('/api/settings');
const leverOf = (p, id) => p.allocation.levers.find((l) => l.id === id);

function cleanup() {
  killTree(child.pid);
  removeTempDir(workspace);
}

console.log('\n1. 还没填单价：只报 token，不报钱');
if (!(await waitForHealth())) {
  console.log('  FAIL  服务在 30 秒内就绪');
  console.log(`        ${serverOut.slice(-800)}`);
  cleanup();
  process.exit(1);
}
{
  const p = await plan();
  check('plan 接口可用（空工作区也要能填单价）', p?.allocation != null, JSON.stringify(p).slice(0, 200));
  check('pricingConfigured 为 false', p.pricingConfigured === false);
  check('金额是 0，而不是编出来的数', p.allocation.cost.total === 0, JSON.stringify(p.allocation.cost));
  check('免责声明逐字一致', p.allocation.disclaimer === REQUIRED_DISCLAIMER, p.allocation.disclaimer);
  check('档位 off：一条杠杆都不动', p.allocation.levers.every((l) => !l.applies),
    JSON.stringify(p.allocation.levers.filter((l) => l.applies)));
  check('默认不允许删历史', p.allowHistoryReduction === false);
}

console.log('\n2. 输入便宜、输出贵：钱压在输出，别动上下文');
{
  await send('PUT', '/api/settings', {
    compression: 'auto',
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
  });
  const p = await plan();
  check('单价被存下来并可读回', p.pricing.inputPerMillion === 3 && p.pricing.outputPerMillion === 15,
    JSON.stringify(p.pricing));
  check('报出了按哪套单价算的', /输入 \$3\/M/.test(p.pricingNote), p.pricingNote);
  check('auto 解出 light（输出贵时输入侧不该压狠）', p.allocation.level === 'light', p.allocation.level);
  check('认出了钱在输出侧', p.allocation.heavierSide === 'output', p.allocation.heavierSide);
  check('动推理档位（推理 token 按输出计价）', leverOf(p, 'reasoning')?.applies === true, leverOf(p, 'reasoning')?.why);
  check('不动工具结果（输入侧不是矛盾所在）', leverOf(p, 'tool-results')?.applies === false, leverOf(p, 'tool-results')?.why);
}

console.log('\n3. 同样的会话，只改单价 → 建议必须不同');
{
  await send('PUT', '/api/settings', { pricing: { inputPerMillion: 20, outputPerMillion: 1 } });
  const p = await plan();
  check('auto 解出 aggressive（输入贵）', p.allocation.level === 'aggressive', p.allocation.level);
  check('认出了钱在输入侧', p.allocation.heavierSide === 'input', p.allocation.heavierSide);
  check('动工具结果（输入里最肥的一块）', leverOf(p, 'tool-results')?.applies === true, leverOf(p, 'tool-results')?.why);
  check('不再为了省输出动推理档位', leverOf(p, 'reasoning')?.applies === false, leverOf(p, 'reasoning')?.why);
}

console.log('\n4. 唯一会删东西的杠杆：默认不动手，显式打开才动');
{
  const before = await plan();
  check('档位到 aggressive 但默认开关是关的 → 不删', before.allocation.historyReduction === false);
  check('理由说清了为什么不动手', /设置页/.test(leverOf(before, 'history')?.why ?? ''), leverOf(before, 'history')?.why);

  // 不传这个字段：绝不能被理解成 true。
  await send('PUT', '/api/settings', { compression: 'aggressive' });
  const stillOff = await plan();
  check('没传 allowHistoryReduction 时它保持 false', stillOff.allowHistoryReduction === false);
  check('于是历史仍然不动', stillOff.allocation.historyReduction === false);

  await send('PUT', '/api/settings', { allowHistoryReduction: true });
  const on = await plan();
  check('显式打开 + aggressive → 会删（这是用户自己要的）', on.allocation.historyReduction === true);
  check('杠杆标记了破坏性', leverOf(on, 'history')?.destructive === true);

  // 退回 light：允许着也不动手。
  await send('PUT', '/api/settings', { compression: 'light' });
  const light = await plan();
  check('允许了但档位没到 aggressive → 仍然不删', light.allocation.historyReduction === false);

  await send('PUT', '/api/settings', { allowHistoryReduction: false, compression: 'auto' });
  const restored = await plan();
  check('可以关回去', restored.allowHistoryReduction === false && restored.allocation.historyReduction === false);
}

console.log('\n5. 应用建议：只降不升，且落盘');
{
  /*
   * 先把定价设成**输出贵**：推理 token 按输出计价，只有这种情况下才有可降的空间。
   * 上一节的 input-heavy 结论是"不建议动推理档位"，拿它来测 apply 只会测出"什么都没发生"。
   */
  await send('PUT', '/api/settings', { compression: 'auto', pricing: { inputPerMillion: 3, outputPerMillion: 15 } });

  const before = await settings();
  void before;
  const firstPlan = await plan();
  check('输出贵时给出了一个可降的推理档位', firstPlan.allocation.recommendedThinkingLevel != null,
    String(firstPlan.allocation.recommendedThinkingLevel));

  // 先把推理档位人为抬到最高，才看得出"只会往低走"。
  await send('PUT', '/api/settings', { thinkingLevel: 'max' });

  /*
   * 推荐值是**按当前的推理档位**算出来的（stepDown(current, n)），所以抬到 max 之后要重新读一次
   * plan 才能拿到"此刻的建议"。拿抬高之前那份去比会一直不等 —— 那是断言写错了，不是代码错了。
   */
  const p = await plan();
  const recommended = p.allocation.recommendedThinkingLevel;
  check('抬高后建议值随之变化（说明它是按当前档位算的）',
    recommended != null && recommended !== firstPlan.allocation.recommendedThinkingLevel,
    `${firstPlan.allocation.recommendedThinkingLevel} -> ${recommended}`);

  const r = await send('POST', '/api/context/apply', {});
  const body = await r.json();
  const after = await settings();

  check('apply 可用', r.status === 200 && body.ok === true, JSON.stringify(body).slice(0, 200));
  check('apply 落下的正是 plan 此刻推荐的档位', body.applied === recommended, `${recommended} vs ${body.applied}`);
  check('把推理档位降下来了', body.applied != null && body.applied !== 'max', String(body.applied));
  check('设置里确实是降后的值', after.llm.thinkingLevel === body.applied, after.llm.thinkingLevel);
  check('写进了 .env（重启不会弹回去）',
    existsSync(envFile) && readFileSync(envFile, 'utf8').includes(`SHE_THINKING_LEVEL=${body.applied}`));

  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  check('只降不升（推荐值低于当前值）',
    order.indexOf(body.applied) < order.indexOf('max'),
    `${body.applied} vs max`);

  check('apply 不会顺手打开删历史', (await plan()).allocation.historyReduction === false);

  // 输入重、输出轻时没有可降的地方（推理 token 按输出计价，省它没意义）。
  await send('PUT', '/api/settings', { pricing: { inputPerMillion: 20, outputPerMillion: 1 } });
  const inputHeavy = await plan();
  check('输入占大头时不建议动推理档位', inputHeavy.allocation.recommendedThinkingLevel === null,
    String(inputHeavy.allocation.recommendedThinkingLevel));
}

console.log('\n6. 面板不会自己改配置');
{
  // 一条 GET 也不该产生副作用：读 plan 前后配置必须一样。
  const a = await settings();
  await plan();
  await plan();
  const b = await settings();
  check('反复读 plan 不改任何配置',
    a.context.compression === b.context.compression
    && a.context.allowHistoryReduction === b.context.allowHistoryReduction
    && a.context.pricing.inputPerMillion === b.context.pricing.inputPerMillion,
    JSON.stringify({ a: a.context, b: b.context }));
}

console.log('\n7. 天花板状态：面板看得出「离上限还有多远、压过没有」');
{
  const p = await plan();
  const c = p.context;
  check('plan 带上了窗口信息', typeof c?.window?.tokens === 'number' && c.window.tokens > 0, JSON.stringify(c?.window));
  check('窗口来源被点名（猜的 / 填的分开）', typeof c.window.source === 'string' && c.window.source.length > 0
    && typeof c.window.detail === 'string' && c.window.detail.length > 0, JSON.stringify(c.window));
  check('报出了此刻用掉多少 token（含系统提示词与工具表）', c.usedTokens > 1000, String(c.usedTokens));
  check('阈值与开关都可读', typeof c.threshold === 'number' && typeof c.autoCompact === 'boolean',
    JSON.stringify({ threshold: c.threshold, autoCompact: c.autoCompact }));
  check('没压过时如实说没压（不是"压了但看不出来"）', c.compacted === false && c.compaction === null,
    JSON.stringify({ compacted: c.compacted, compaction: c.compaction }));
}

console.log('\n8. 窗口能改、能落盘、写坏了不改');
{
  const s0 = await settings();
  check('默认是"按模型名识别"（没被填过）', s0.llm.contextWindow === 0 && (await plan()).context.window.source !== 'config',
    JSON.stringify({ configured: s0.llm.contextWindow }));

  await send('PUT', '/api/settings', { compactionLevel: 'aggressive' });
  const pLevel = await plan();
  check('档位能改、能读回，并影响阈值', pLevel.context.compactionLevel === 'aggressive' && pLevel.context.threshold === 0.9,
    JSON.stringify({ level: pLevel.context.compactionLevel, threshold: pLevel.context.threshold }));
  await send('PUT', '/api/settings', { compactionLevel: 'nonsense' });
  check('写坏的档位不生效（保留上一个好值）', (await plan()).context.compactionLevel === 'aggressive');
  await send('PUT', '/api/settings', { compactionLevel: 'balanced' });
  check('回到平衡档 → 阈值回到 0.8', (await plan()).context.threshold === 0.8, JSON.stringify((await plan()).context.threshold));
  await send('PUT', '/api/settings', { contextWindow: 40000 });
  const s1 = await settings();
  const p1 = await plan();
  check('窗口按填的值走，并标明来自配置', s1.llm.contextWindow === 40000
    && p1.context.window.tokens === 40000 && p1.context.window.source === 'config',
    JSON.stringify({ configured: s1.llm.contextWindow, window: p1.context.window }));
  check('阈值跟着窗口一起可读', p1.context.threshold === 0.8, String(p1.context.threshold));
  check('写进了 .env（否则重启就弹回去）', readFileSync(envFile, 'utf8').includes('SHE_CONTEXT_WINDOW=40000'),
    readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('SHE_CONTEXT')).join(' | '));

  await send('PUT', '/api/settings', { compactAtShare: 0.9 });
  check('阈值能改', (await plan()).context.threshold === 0.9, String((await plan()).context.threshold));
  await send('PUT', '/api/settings', { compactAtShare: 1.5 });
  check('写坏的阈值（1.5 = 等于关掉）不生效，保留上一个好值', (await plan()).context.threshold === 0.9,
    String((await plan()).context.threshold));
  await send('PUT', '/api/settings', { contextWindow: 5 });
  check('写坏的窗口（5）不生效，保留上一个好值', (await settings()).llm.contextWindow === 40000);

  await send('PUT', '/api/settings', { autoCompact: false });
  check('自动压缩可以关掉', (await plan()).context.autoCompact === false);
  await send('PUT', '/api/settings', { autoCompact: true });
  check('可以再打开', (await plan()).context.autoCompact === true);

  await send('PUT', '/api/settings', { compactAtShare: 0.8 });
  await send('PUT', '/api/settings', { contextWindow: 0 });
  check('填 0 = 回到自动识别（0 不能被当成"没传"）',
    (await settings()).llm.contextWindow === 0 && (await plan()).context.window.source !== 'config');
}

console.log('\n9. 手动压缩：压不动就说压不动，不假装成功');
{
  const r = await send('POST', '/api/context/compact', {});
  const body = await r.json();
  check('端点可用', r.ok === true, String(r.status));
  check('没有可压的边界时 ok:false 且给出理由', body.ok === false && /压不动/.test(String(body.reason)),
    JSON.stringify(body).slice(0, 300));
  check('顺带回一份压缩前的状态', body.status && typeof body.status.usedTokens === 'number',
    JSON.stringify(body.status ?? null).slice(0, 200));
}

console.log('\n10. 真压一次：跑的是用户实际会跑的那份 dist（本地桩模型，无外网）');
{
  /*
   * 桩模型：OpenAI 兼容的 JSON，不发外网。
   *
   * 它同时承担"模型写摘要"和"模型端说太长"两个角色 —— 后者用一条真实的 400 报文
   * （`maximum context length`），因为 provider 会把这条报文原样带进 Error，而"到底哪句话算溢出"
   * 正是这条兜底最容易判错的地方。
   */
  const stub = {
    requests: [],
    digestCalls: 0,
    rejectNext: 0,
  };
  const llm = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 不是 JSON 就当空体 */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const isDigest = messages.some((m) => m.role === 'system' && String(m.content).includes('压缩成一份摘要'));
      const promptChars = (Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0)
        + messages.reduce((n, m) => n + String(m?.content ?? '').length, 0);
      const promptTokens = Math.max(1, Math.ceil(promptChars / 3.2));
      const reply = (content) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'stub', object: 'chat.completion', model: 'stub',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          // 报一个**可信**的 prompt tokens（按字符数算出来的）：固定报 100 会让"换算比自校准"
          // 收到量级不对的样本（那一条护栏会把它丢掉），于是第 12 节就测不到东西。
          usage: {
          prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5,
          // 全算未命中：这样"压缩之后实际付了多少"有一个确定的数，判据能断言它（见第 13 节）。
          prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: promptTokens,
        },
        }));
      };
      if (isDigest) {
        stub.digestCalls++;
        reply('摘要：' + 'z'.repeat(80));
        return;
      }
      stub.requests.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })));
      if (stub.rejectNext > 0) {
        stub.rejectNext--;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: "This model's maximum context length is 65536 tokens. Please reduce the length of the messages.",
            type: 'invalid_request_error',
          },
        }));
        return;
      }
      reply('stub ok');
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const llmBase = `http://127.0.0.1:${llm.address().port}`;

  const bulk = (blocks) => {
    const out = [];
    for (let i = 0; i < blocks; i++) {
      out.push({ role: 'user', content: `block ${i} ` + 'x'.repeat(10_000) });
      out.push({ role: 'assistant', content: `ack ${i}` });
    }
    return out;
  };
  const newSession = async (title) => {
    const r = await (await send('POST', '/api/sessions', { title })).json();
    return r.id ?? r.session?.id;
  };
  const chat = async (sid, message) => (await send('POST', '/api/chat', { session_id: sid, message, stream: false })).json();
  const compactionRecords = () => {
    const root = join(workspace, '.she', 'sessions');
    const out = [];
    if (!existsSync(root)) return out;
    for (const d of readdirSync(root)) {
      const f = join(root, d, 'compaction.json');
      if (!existsSync(f)) continue;
      try { out.push({ dir: d, ...JSON.parse(readFileSync(f, 'utf8')) }); } catch { out.push({ dir: d, broken: true }); }
    }
    return out;
  };

  try {
    await send('PUT', '/api/settings', {
      baseUrl: llmBase, apiKey: 'stub-key', model: 'stub',
      contextWindow: 40000, compactAtShare: 0.8, autoCompact: false,
    });

    // ── 10.1 开关关掉：到阈值也不压，历史完整发出 ──
    const sidOff = await newSession('ctx-off');
    await send('PUT', '/api/chat/history', {
      session_id: sidOff,
      // 前面两条是**真决定**：被折叠那一段里必须有一条「该记住的」，下面的候选断言才有意义。
      messages: [
        { role: 'user', content: '约定：界面文案一律走 t()，i18n 棘轮基线只许降不许升。' },
        { role: 'assistant', content: '记下了：文案走 t()，基线只降不升。' },
        ...bulk(12),
      ],
    });
    stub.requests.length = 0;
    const offReply = await chat(sidOff, '关掉开关的这一轮');
    const offReq = stub.requests.at(-1) ?? [];
    check('这一轮真的答上了（模型是本地桩，不是它自己出错）', /stub ok/.test(String(offReply.content)),
      JSON.stringify(offReply).slice(0, 200));
    check('关掉开关后，请求里一份摘要都没有', !offReq.some((m) => m.content.startsWith('[压缩记录]')),
      `请求 ${offReq.length} 条`);
    check('关掉开关后，被折叠的那一段仍然完整发出', offReq.some((m) => m.content.startsWith('block 0 ')),
      `请求 ${offReq.length} 条`);

    // ── 10.2 手动压：开关管的是"自动"，用户按按钮是显式要求 ──
    const manual = await (await send('POST', '/api/context/compact', { session_id: sidOff })).json();
    check('手动压真的压了（压完更小）', manual.ok === true
      && Number(manual.afterTokens) < Number(manual.beforeTokens),
      JSON.stringify({ ok: manual.ok, before: manual.beforeTokens, after: manual.afterTokens, reason: manual.reason }));
    const manualRecord = compactionRecords().find((r) => r.reason === 'manual');
    check('被折叠那一段里的「该记住的」进了压缩记录（候选 + 条号）',
      Array.isArray(manualRecord?.kbCandidates) && manualRecord.kbCandidates.length > 0
        && manualRecord.kbCandidates.every((c) => typeof c.at === 'number' && typeof c.title === 'string'),
      JSON.stringify(manualRecord?.kbCandidates ?? null).slice(0, 300));
    check('日志能读出被压范围（压了哪一段）',
      Boolean(manualRecord) && manualRecord.coveredFrom === 0 && manualRecord.coveredTo === manualRecord.covered - 1,
      JSON.stringify({ covered: manualRecord?.covered, from: manualRecord?.coveredFrom, to: manualRecord?.coveredTo }));
    check('日志能读出留了什么（压那一刻保留的条数）',
      typeof manualRecord?.keptCount === 'number' && manualRecord.keptCount >= 0,
      JSON.stringify({ keptCount: manualRecord?.keptCount }));
    check('压缩记录落了盘，并写清来源是模型还是机械提取', Boolean(manualRecord)
      && (manualRecord.source === 'model' || manualRecord.source === 'extractive'),
      JSON.stringify(manualRecord ?? null).slice(0, 200));
    check('摘要正文有界（它自己不能长成新的问题）', Boolean(manualRecord) && manualRecord.digest.length <= 8000,
      String(manualRecord?.digest?.length));

    const afterManual = await chat(sidOff, '压完之后再问一句');
    const afterReq = stub.requests.at(-1) ?? [];
    check('候选清单真的随 [压缩记录] 发给了模型（连查证要求一起）',
      afterReq.some((m) => m.content.startsWith('[压缩记录]')
        && /kb_query/.test(m.content) && /kb_upsert/.test(m.content)),
      JSON.stringify(afterReq.map((m) => String(m.content).slice(0, 40))).slice(0, 300));
    check('压完之后每一轮都带同一份冻结摘要', afterReq.some((m) => m.content.startsWith('[压缩记录]')),
      `请求 ${afterReq.length} 条`);
    check('压完之后最早的轮次不再发出去', !afterReq.some((m) => m.content.startsWith('block 0 ')),
      `请求 ${afterReq.length} 条`);
    check('这一轮也答上了', /stub ok/.test(String(afterManual.content)), JSON.stringify(afterManual).slice(0, 120));

    // ── 10.3 自动（阈值）：开着开关就自己压 ──
    await send('PUT', '/api/settings', { autoCompact: true, contextWindow: 40000 });
    const sidAuto = await newSession('ctx-auto');
    await send('PUT', '/api/chat/history', { session_id: sidAuto, messages: bulk(12) });
    stub.requests.length = 0;
    const autoReply = await chat(sidAuto, '开着开关的这一轮');
    const autoReq = stub.requests.at(-1) ?? [];
    check('开着开关时，发出去的请求已经带上了摘要', autoReq.some((m) => m.content.startsWith('[压缩记录]')),
      `请求 ${autoReq.length} 条`);
    check('阈值那一份摘要标着 reason=threshold', compactionRecords().some((r) => r.reason === 'threshold'),
      JSON.stringify(compactionRecords().map((r) => r.reason)));
    check('这一轮答上了', /stub ok/.test(String(autoReply.content)), JSON.stringify(autoReply).slice(0, 120));

    // ── 10.4 模型端说"太长"：当场压一次，再发一遍 ──
    await send('PUT', '/api/settings', { contextWindow: 200000 });
    const sidOverflow = await newSession('ctx-overflow');
    await send('PUT', '/api/chat/history', { session_id: sidOverflow, messages: bulk(12) });
    stub.requests.length = 0;
    stub.rejectNext = 1;
    const rescueReply = await chat(sidOverflow, '窗口猜小了的那一轮');
    check('被拒之后重发了一次（而不是把这一轮判死）', stub.requests.length === 2, `桩收到 ${stub.requests.length} 次`);
    check('第一次发的是原样的请求', stub.requests[0] && !stub.requests[0].some((m) => m.content.startsWith('[压缩记录]')));
    check('第二次发的是压缩后的请求', stub.requests[1] && stub.requests[1].some((m) => m.content.startsWith('[压缩记录]')));
    check('会话活下来了（这一轮答上了）', /stub ok/.test(String(rescueReply.content)),
      JSON.stringify(rescueReply).slice(0, 200));
    check('这一份摘要标着 reason=overflow', compactionRecords().some((r) => r.reason === 'overflow'),
      JSON.stringify(compactionRecords().map((r) => r.reason)));
    const status = (await plan()).context;
    check('面板上看得出来压过、以及压小了多少钱', status.compacted === true
      && Number(status.compaction?.afterTokens) < Number(status.compaction?.beforeTokens),
      JSON.stringify(status.compaction ?? null).slice(0, 200));
  } finally {
    await new Promise((r) => llm.close(() => r()));
  }
}

console.log('\n11. 分类账 / 原文可回读 / 学会窗口（都走真 server）');
{
  const c = (await plan()).context;

  // 分类账：第 10 节那一轮真压过一次，所以摘要那一格必须大于 0。
  const b = c.breakdown;
  check('plan 给出分类账', Boolean(b) && typeof b.system === 'number' && typeof b.toolResults === 'number',
    JSON.stringify(b ?? null));
  const sum = b.system + b.tools + b.digest + b.toolResults + b.conversation;
  check('分类之和与 usedTokens 一致（面板两处不能互相矛盾）', Math.abs(sum - c.usedTokens) <= 4,
    `分类和 ${sum} · usedTokens ${c.usedTokens}`);
  check('摘要那一格大于 0（第 10 节刚压过）', b.digest > 0, String(b.digest));
  check('系统提示词与工具表各占一格（固定开销看得见）', b.system > 1000 && b.tools > 1000,
    `system ${b.system} · tools ${b.tools}`);

  // 原文可回读：摘要抬头给出的路径必须真的能读。
  const rel = c.compaction?.sourcePath;
  check('压缩记录带上了原文路径', typeof rel === 'string' && rel.length > 0, String(rel));
  if (typeof rel === 'string' && rel.length > 0) {
    const abs = join(workspace, rel);
    check('那个路径真的存在（不是指向不存在的东西）', existsSync(abs), abs);
  }

  // 学会窗口：第 10.4 节那次拒绝的报文里写着 65536，而我们当时按 20 万判断。
  check('窗口改成从拒绝报文里学到的数', c.window.tokens === 65536, JSON.stringify(c.window));
  check('并点名来源是「学到的」', c.window.source === 'learned', String(c.window.source));
  check('学到的值落了盘（下次构造直接用）',
    existsSync(join(workspace, '.she', 'context-window.json')),
    join(workspace, '.she', 'context-window.json'));
}

console.log('\n12. 自校准与取回锚点');
{
  /*
   * 自带一个桩：第 10 节那个在它的 finally 里已经关掉了（关掉之后的聊天全打在关闭的端口上，一个
   * usage 都没有）。桩按"字符 ÷ 3.2"报 prompt tokens —— 也就是这个端点"用的是另一套分词器"。
   */
  const tin = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 空体 */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const chars = (Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0)
        + messages.reduce((n, m) => n + String(m && m.content ? m.content : '').length, 0);
      const promptTokens = Math.max(1, Math.ceil(chars / 3.2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'stub-cal', object: 'chat.completion', model: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content: 'stub ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5,
          // 全算未命中：这样"压缩之后实际付了多少"有一个确定的数，判据能断言它（见第 13 节）。
          prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: promptTokens,
        },
      }));
    });
  });
  await new Promise((r) => tin.listen(0, '127.0.0.1', r));

  try {
    await send('PUT', '/api/settings', {
      baseUrl: `http://127.0.0.1:${tin.address().port}`, apiKey: 'stub-key', model: 'stub',
    });

    // 开一条干净的会话，连问三轮：换算比按中位数校准，少于三个样本按规矩不动。
    const created = await (await send('POST', '/api/sessions', { title: 'ctx-cal' })).json();
    const sid = created.id ?? created.session?.id;
    for (const q of ['一', '二', '三']) {
      await send('PUT', '/api/chat/history', { session_id: sid, messages: [{ role: 'user', content: 'x'.repeat(2000) }] });
      const r = await send('POST', '/api/chat', { session_id: sid, message: q, stream: false });
      check(`第 ${q} 轮答上了（否则样本就攒不够）`, r.ok, String(r.status));
    }

    const c = (await get(`/api/context/plan?session_id=${sid}`)).context;
    const e = c.estimate;
    check('plan 给出换算比与样本数', Boolean(e) && typeof e.charsPerToken === 'number' && typeof e.samples === 'number',
      JSON.stringify(e ?? null));
    check('样本够三轮', e.samples >= 3, `样本 ${e.samples}`);
    check('换算比按真实用量动过了（桩按 3.2 报，先验是 3.47）', e.charsPerToken < 3.45 && e.charsPerToken >= 2.5,
      `${e.charsPerToken} · 样本 ${e.samples}`);
    const calFile = join(workspace, '.she', 'estimate-calibration.json');
    check('换算比落了盘（重启不用重新学）', existsSync(calFile), calFile);
    check('落盘的是量出来的那个数（不是先验）',
      existsSync(calFile) && Number(JSON.parse(readFileSync(calFile, 'utf8')).charsPerToken) < 3.45,
      existsSync(calFile) ? readFileSync(calFile, 'utf8') : '(没有文件)');

    /*
     * 取回锚点：这条会话的历史是纯文本块（'xxxx'），抽不出任何可检索的串 —— 所以抬头**不该**印一个
     * 空表。印了就是在暗示"有线索"，而实际什么都没有。（正例在单测里：单测那段历史带路径、命令、
     * 报错串和知识库组路径。）
     */
    const digest = c.compaction ?? null;
    check('没压过 / 抽不出锚点时都不印空表', digest === null || typeof digest.sourcePath === 'string',
      JSON.stringify(digest ?? null).slice(0, 200));

    // ── 13. 四个读数：经济学 / 取回率 / 锚点 / 预算（同一条桩，但换一条会话真压一次）──
    console.log('\n13. 四个读数：经济学 / 取回率 / 锚点 / 预算');
    await send('PUT', '/api/settings', { contextWindow: 40000 });
    const c2r = await (await send('POST', '/api/sessions', { title: 'ctx-econ' })).json();
    const sid2 = c2r.id ?? c2r.session?.id;
    const big = [];
    for (let i = 0; i < 12; i++) {
      big.push({ role: 'user', content: `block ${i} ` + 'x'.repeat(10_000) });
      big.push({ role: 'assistant', content: `ack ${i}` });
    }
    await send('PUT', '/api/chat/history', { session_id: sid2, messages: big });
    for (const q of ['一', '二', '三']) {
      const r = await send('POST', '/api/chat', { session_id: sid2, message: q, stream: false });
      check(`第 ${q} 轮答上了（否则账算不出来）`, r.ok, String(r.status));
    }

    const c2 = (await get(`/api/context/plan?session_id=${sid2}`)).context;
    check('压过至少一次', c2.memory.compactions >= 1 && c2.memory.foldedMessages > 0,
      JSON.stringify(c2.memory));
    const ec = c2.economics;
    check('给出这次压缩的账', Boolean(e) && typeof ec.savedTokens === 'number', JSON.stringify(e ?? null));
    check('省下的 = (前 − 后) × 轮数',
      ec.savedTokens === Math.max(0, c2.compaction.beforeTokens - c2.compaction.afterTokens) * ec.rounds,
      `省 ${ec.savedTokens} · 轮数 ${ec.rounds}`);
    check('付掉的是 provider 报的未命中（不是我们估的）', ec.paidTokens > 0 && ec.settled === true,
      `付 ${ec.paidTokens}`);
    check('净额 = 省 − 付', ec.netTokens === ec.savedTokens - ec.paidTokens, `净 ${ec.netTokens}`);
    check('这一刻的预算是个数、且落在 [800, 16000]', typeof c2.budgetChars === 'number'
      && c2.budgetChars >= 800 && c2.budgetChars <= 16_000, String(c2.budgetChars));
    check('取回率是个数（本轮没人读过 compacted/，所以是 0）', c2.memory.retrievals === 0,
      String(c2.memory.retrievals));
    check('锚点数是个数（纯文本历史抽不出锚点 → 0）', c2.memory.anchors === 0, String(c2.memory.anchors));
  } finally {
    await new Promise((r) => tin.close(() => r()));
  }
}

cleanup();
console.log(`\n${failures === 0 ? 'PASS  context-budget-check' : `FAIL (${failures})  context-budget-check`}`);
process.exit(failures === 0 ? 0 : 1);
