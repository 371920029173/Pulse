/**
 * 控制面凭据的读取 —— 给门禁脚本用。
 *
 * 第四轮评测 2b 之后，`/api/settings`、`/api/workspaces*`、`/api/config/*` 这几类**改这台机器怎么
 * 跑**的接口要求一份凭据（见 `packages/server/src/control-token.ts`）。门禁脚本起的都是真服务，
 * 所以它们也必须带上。
 *
 * 这里读的是**服务端生成的那份文件**，不是自己造一个 token 塞进环境：
 *
 *   - 造一个（`SHE_CONTROL_TOKEN=test`）会跳过"生成 + 落盘"这条路径，而那正是要验的东西；
 *   - 读文件顺带把文件名、位置、内容形状钉住了 —— 桌面端读的是同一个文件，两处不一致会立刻红。
 *
 * 每个 check 都把自己那个临时 `SHE_APP_DIR` 传进来，所以互不干扰（它们本来就是各自一个临时目录）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 服务端写的文件名。改动它要同时改 `control-token.ts` 与桌面的 `main.cjs`。 */
export const CONTROL_TOKEN_FILE = 'control-token';

/**
 * 读控制面凭据；读不到返回 `null`（而不是抛）。
 *
 * 不抛的理由：`SHE_CONTROL_AUTH=off` 是用户能显式关掉校验的，那时**本来就没有**这个文件，而门禁
 * 不该因为"用户选择关掉"就崩。反过来，如果文件该有却没有，后续的控制面请求会收到 401，那时断言
 * 会红在真正的位置（`check:api` 之类），错误信息也比这里抛一个"文件不存在"有用。
 */
export function readControlToken(appDir) {
  const file = join(appDir, CONTROL_TOKEN_FILE);
  if (!existsSync(file)) return null;
  try {
    const v = readFileSync(file, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 控制面请求要带的头。读不到凭据时返回空对象 —— 交付给断言去发现 401，而不是在这里掩盖。
 */
export function controlHeaders(appDir) {
  const token = readControlToken(appDir);
  return token ? { 'x-she-token': token } : {};
}

/** 凭据文件路径，给"它在哪 / 有没有落盘"这类断言用。 */
export function controlTokenPath(appDir) {
  return join(appDir, CONTROL_TOKEN_FILE);
}

/**
 * 服务端默认的安装私有目录。
 *
 * 必须和 `packages/server/src/index.ts` 的 `appDir()` **逐字一致**：`SHE_APP_DIR`，否则
 * `~/.she-app`。桌面端（`main.cjs` 的 `controlTokenPath()`）抄的是同一条规则 —— 三处不一致的
 * 后果是"请求全 401"，而那种故障看起来像服务端坏了，不像路径配错了。
 */
export function defaultAppDir(env = process.env) {
  return env.SHE_APP_DIR ? resolve(env.SHE_APP_DIR) : join(homedir(), '.she-app');
}

/**
 * 面对一个**不是自己起的**服务时用它（例如 `perf-smoke` 打的是已运行的开发服务）。
 *
 * 自己起服务的 check 应该传自己那个临时 appDir：那才验得到"生成 + 落盘"这条路径。
 */
export function controlHeadersFromEnv(env = process.env) {
  return controlHeaders(defaultAppDir(env));
}
