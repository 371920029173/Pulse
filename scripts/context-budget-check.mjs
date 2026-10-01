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
 *   node scripts/context-budget-check.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';
import { killTree } from './lib/kill-tree.mjs';

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
  env: {
    ...process.env,
    SHE_WORKSPACE: workspace,
    SHE_PORT: PORT,
    SHE_ENV_FILE: envFile,
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

cleanup();
console.log(`\n${failures === 0 ? 'PASS  context-budget-check' : `FAIL (${failures})  context-budget-check`}`);
process.exit(failures === 0 ? 0 : 1);
