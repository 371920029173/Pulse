/**
 * 逐工作区后端：窗口独立性（窗口隔离）检查。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么这件事需要一个门禁
 *
 * 「独立窗口」的失败模式全部都是**静默**的：
 *
 *   · 两个窗口开同一个工作区 → 两个后端进程 → 两个进程各自在内存里存一份会话快照、各自回写
 *     sessions.json → 先写的那条被后写的覆盖 → 用户看到"聊天记录自己消失了"。没有任何报错，
 *     日志也干净，只是数据在丢。
 *   · 池没有去重并发请求 → 同一个工作区在同一瞬间被开两次 → 同上，但只在"点得快"的时候出现。
 *   · 池把已注册的端口又分给别人 → 两个后端抢一个端口，一个起不来，那个窗口白屏。
 *
 * 这三条都不会让任何一个既有测试变红，所以它们必须有自己的检查。分两层：
 *
 *   1. 单元测试（packages/desktop/__tests__/backend-pool.test.cjs）—— 用假的子进程验证池的
 *      不变量：同一工作区只起一个、并发只起一个、端口不重复分配、子进程夭折时换端口重试、
 *      失败不被缓存。
 *   2. 接线检查（本文件的第 4、5、6 节）—— 光有池而没接进 Electron，等于没修。用**静态断言**盯住
 *      几处关键接线：少了任何一处，功能会退回到"多开几个窗口共用一个后端"的旧行为，而那正是
 *      用户报的 bug，且界面上完全看不出来。
 *
 * 两节专门写的是**真实发生过的**两次失败，不是假想：
 *
 *   · 第 2 节 —— 端口写死区间（5700–5739），而这台机器上那段被 Windows 整段保留，一个都绑不上。
 *   · 第 4 节 —— 失败被吞成 null，渲染进程读成"不支持"于是回退到共享切换，把别的窗口一起带走。
 *     先坏在端口，后坏在回退，两个叠起来才表现成「新窗口强制打开旧窗口的工作区」。
 *
 *   node scripts/window-isolation-check.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 300)}`);
  }
};

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

console.log('\n逐工作区后端与窗口隔离检查\n');

/* ─── 1. 池的不变量（真跑单元测试） ─── */
console.log('=== 1. 池的不变量 ===');
{
  const r = spawnSync(process.execPath, ['--test', 'packages/desktop/__tests__/backend-pool.test.cjs'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // 断言的是"全绿"，不只是退出码：--test 在 0 个用例时也返回 0，而"检查跑了个寂寞"正是这类
  // 门禁最容易出现的假通过。
  const pass = /^# pass (\d+)$/m.exec(out);
  const fail = /^# fail (\d+)$/m.exec(out);
  check('后端池单元测试全部通过', r.status === 0 && Number(pass?.[1]) >= 11 && Number(fail?.[1]) === 0,
    `status=${r.status} pass=${pass?.[1]} fail=${fail?.[1]}`);
}

/* ─── 2. 端口不能靠猜 ─── */
console.log('=== 2. 端口分配：问系统，不猜区间 ===');
{
  /*
   * 这一节是这次真实事故的回填。上一版写死 `portStart: 5700, portSpan: 40`，而实测这台机器
   * 5700–5739 **一个都绑不上** —— Windows/Hyper-V 保留了 5641–5740，且保留段在 `netstat` 里看不到。
   * 于是每次换工作区都失败成「没有可用端口」，而失败又触发了回退（见第 4 节），最后表现成
   * 「新窗口强制打开旧窗口的工作区」。写死区间这条路不值得再走一次，所以钉住它。
   */
  const pool = read('packages/desktop/backend-pool.cjs');
  check('端口由系统分配（绑 0 号端口再读回）', pool.includes('port: 0'),
    '没有绑 0 号端口，说明还在猜端口');
  check('不再有"固定区间"的概念', !/portStart|portSpan/.test(pool),
    'portStart/portSpan 又出现了：任何写死的区间都可能整段被系统保留');
  const main = read('packages/desktop/main.cjs');
  check('桌面壳不再给池传端口区间', !/portStart|portSpan/.test(main));
  check('子进程起不来会换端口重试（而不是留下死条目）',
    pool.includes('this.claimed.delete(port)') && pool.includes('retrying'),
    '少了重试路径，一次端口抢占会把死掉的后端永久挂在工作区上');
}

/* ─── 3. 池按工作区（而不是按窗口）做主键 ─── */
console.log('=== 3. 状态归属：一个工作区一个后端 ===');
{
  const pool = read('packages/desktop/backend-pool.cjs');
  check('池的存在理由写在文件里（换成按窗口为键会丢会话）',
    pool.includes('sessions.json') && pool.includes('workspace'),
    '池没有解释"为什么键是工作区"');
  check('SHE_STATE_DIR 被显式移除（状态必须跟着工作区走）',
    read('packages/desktop/main.cjs').includes('delete env.SHE_STATE_DIR'),
    '少了这一行，两个后端会共用一个状态目录');
  check('SHE_KB_PATH 同样被移除（否则每个项目看到同一堆笔记）',
    read('packages/desktop/main.cjs').includes('delete env.SHE_KB_PATH'));
  check('后端由 SHE_WORKSPACE 决定挂载哪个工作区',
    read('packages/desktop/main.cjs').includes('SHE_WORKSPACE: root'));
}

/* ─── 4. 失败绝不回退到共享后端 ─── */
console.log('=== 4. 失败路径：不许悄悄回退 ===');
{
  /*
   * 这是比端口更难查的那一半。原来 `she:openWorkspace` 在失败时 catch 住并返回 null，渲染进程
   * 把 null 读成"这个 shell 不支持"，于是回退到页面内的 `POST /api/workspaces/switch` —— 把**共享**
   * 后端切走，也就是把别的窗口一起带走。两件事必须分开：
   *   · 返回 null = 这个 shell 没有池（浏览器 / 旧 shell），**只有**这种情况允许回退；
   *   · 抛错 = 有池但没做到（没端口 / 起不来 / 超时），**绝不能**回退。
   */
  const main = read('packages/desktop/main.cjs');
  check('没有池时才返回 null（唯一允许回退的信号）',
    main.includes('if (!pool) return null;'),
    '没有这个判断，渲染进程无法区分"不支持"和"失败了"');
  check('不再把失败吞成 null', !main.includes('openWorkspace failed'),
    '又出现了"失败就返回 null"的写法 —— 渲染进程会把它当成"不支持"并回退，进而污染其它窗口');
  const home = read('packages/ui/src/components/Home.tsx');
  check('Home 只在原生不可用/不支持时回退到共享切换',
    home.includes('window.sheDesktop?.openWorkspace') && home.includes("'/api/workspaces/switch'"));
  /*
   * 精确到"原生调用与回退语句之间"，而不是整段里有没有 catch —— 外层那个 try/catch 是正当的
   * （它负责把错误显示出来）。危险的形状只有一种：在两者之间插一个 catch，把**抛错**变成**回退**。
   * 第一版写成 `openWorkspace[\s\S]{0,400}?\}\s*catch` 就误报了外层那个，等于检查没用。
   */
  const nativeIdx = home.indexOf('window.sheDesktop?.openWorkspace');
  const postIdx = home.indexOf("'/api/workspaces/switch'");
  const between = nativeIdx >= 0 && postIdx > nativeIdx ? home.slice(nativeIdx, postIdx) : null;
  check('原生调用与回退语句之间没有吞错的 catch（失败不能被当成"不支持"）',
    between !== null && !/\bcatch\b/.test(between),
    between === null ? '两个锚点没找到' : '中间出现了 catch：抛错会被降级成回退，正是事故形态');
  check('原生切换排在 POST 之前', between !== null,
    '顺序反了就等于先污染共享后端、再切窗口');
}

/* ─── 5. 接线：池真的接进了桌面壳 ─── */
console.log('=== 5. 桌面壳接线 ===');
{
  const main = read('packages/desktop/main.cjs');
  check('main.cjs 引入了池', main.includes("require('./backend-pool.cjs')"));
  check('启动器那个后端被登记进池（否则第一个工作区会被重复开一个进程）',
    main.includes('pool.register('));
  check('只在界面由 API 提供时才启用池（Vite 代理下池是假的）',
    main.includes('url === API_ORIGIN'),
    '界面走开发服务器时，池无法生效，必须显式禁用而不是装作生效');
  check('窗口记录了各自的 origin（新窗口要加入同一个后端）',
    main.includes('windowOrigin') && main.includes('windowOrigin.get(from)'));
  check('退出时关掉自己起的后端', main.includes('pool.stopAll()'));
}

/* ─── 6. 接线：渲染进程走原生切换 ─── */
console.log('=== 6. 渲染进程接线 ===');
{
  const preload = read('packages/desktop/preload.cjs');
  check('preload 暴露了 openWorkspace', preload.includes('she:openWorkspace'));
  const types = read('packages/ui/src/vite-env.d.ts');
  check('桥的类型声明里有 openWorkspace', types.includes('openWorkspace'));
  const app = read('packages/ui/src/App.tsx');
  check('App 认领 ?ws= 交接（换 origin 后不会退回落地页）',
    app.includes("get('ws')") && app.includes('handoffWs'));
}

/* ─── 7. 接线：设置改动要广播到其它窗口的后端 ─── */
console.log('=== 7. 设置跨窗口同步 ===');
{
  /*
   * 配置活在**每个后端进程自己的** `config` 里，而 `.env` 是**共享文件**且只在启动时读一次。
   * 于是「窗口 A 改设置，窗口 B 的运行中后端跟不跟上」成了逐工作区后端换来的一笔代价。
   * 实测（2026-10-01）：A 把输入单价改成 7，A 读回 `7/15/0`，B 仍是 `1/15/0`。
   *
   * 这条链路少任何一环，不一致就会回来，而且界面上完全看不出来 —— 所以要钉住。
   */
  const main = read('packages/desktop/main.cjs');
  check('main.cjs 有 she:settingsChanged 处理器',
    main.includes("ipcMain.handle('she:settingsChanged'"));
  check('改动转发到池里的其它后端，且复用 PUT /api/settings（不另造一套重载逻辑）',
    main.includes("postJSON(entry.origin, '/api/settings', payload, 'PUT')"),
    '另写一套"重读配置"就得把 process.env 同步/结构变更重建 agent/状态迁移再实现一遍，必然漂移；'
    + '动词也必须是 PUT —— /api/settings 没有 POST 路由，写成 POST 只会得到 404');
  check('工作区相关字段被剥掉（否则会把别的窗口的后端搬到另一个项目）',
    /SETTINGS_NOT_FORWARDED\s*=\s*\[[^\]]*'workspaceRoot'[^\]]*'kbDbPath'/.test(main),
    'workspaceRoot 描述"这个后端服务哪个项目"，转发它就是制造跨窗口污染');
  check('跳过发送方自己的后端（它已经应用过，重发会重建它的 agent）',
    main.includes('entry.origin === sender'));

  const preload = read('packages/desktop/preload.cjs');
  check('preload 暴露了 settingsChanged', preload.includes('she:settingsChanged'));
  const types = read('packages/ui/src/vite-env.d.ts');
  check('桥的类型声明里有 settingsChanged', types.includes('settingsChanged'));

  const api = read('packages/ui/src/lib/api.ts');
  check('putSettings 会通知桌面壳', api.includes('settingsChanged?.('));

  /*
   * 最要紧的一条：**不许**绕过 `putSettings` 直接写。
   *
   * 广播属于"以后多加一个调用点就会忘"的那类代码。谁再写一处
   * `fetchJSON('/api/settings', { method: 'PUT', ... })`，那一项设置就悄悄退回"只在本窗口生效"，
   * 而测试和界面都不会有任何反应。
   */
  const uiDir = join(ROOT, 'packages/ui/src');
  const bypass = [];
  for (const entry of readdirSync(uiDir, { recursive: true })) {
    // `readdirSync` 在 Windows 上给的是反斜杠路径，直接 endsWith('lib/api.ts') 会漏掉排除项，
    // 于是把 putSettings 的实现本身报成违规 —— 检查自己踩了一次可移植性，先归一化。
    const name = String(entry).split('\\').join('/');
    if (!/\.tsx?$/.test(name)) continue;
    // `lib/api.ts` 就是 putSettings 的实现，PUT 只允许出现在这里。
    if (name.endsWith('lib/api.ts')) continue;
    const src = readFileSync(join(uiDir, name), 'utf8');
    if (/['"]\/api\/settings['"]\s*,\s*\{[^}]*method:\s*['"]PUT['"]/.test(src)) bypass.push(name);
  }
  check('没有绕过 putSettings 的直连写（否则那一项设置不会广播）', bypass.length === 0, bypass.join(', '));
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
