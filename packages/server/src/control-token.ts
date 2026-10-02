/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 控制面的凭据：把「改这台机器怎么跑」和「让 Agent 干活」分成两个权限
 *
 * 实测（第四轮评测 2b）：不带任何凭据就能 `PUT /api/settings` 改掉 `.env` 里的沙箱档位，
 * 而 `/api/settings` 只过 `guardRequest` —— 那只查 `Host`/`Origin` 头（挡浏览器里的一个网页），
 * 不查"你是谁"。同用户的进程 forge 这两个头毫无难度（`tenancy.ts` 开头就写着这句）。
 *
 * 这里加的是一条**独立的**控制面凭据，和 `tenancy.ts` 那套租户 token 各管各的：
 *
 *   - 租户 token（`SHE_AUTH_TOKEN(S)`）回答"这个请求是谁"，鉴权开就全站都要。
 *   - 控制面凭据回答"这个请求能不能改这台机器的运行档位"，只管设置 / 工作区 / 配置回退
 *     这些**改安装本身**的接口。
 *
 * 为什么要分开：一个在浏览器里用界面的单用户，和"一个 Agent 能不能给自己的工作区换沙箱档位"
 * 是两个问题。前者不该被迫配 token（`tenancy.ts` 里那条取舍仍然成立），后者不该默认允许。
 *
 * ## 凭据放哪、Agent 能不能拿到
 *
 * 生成后落在 `<appDir>/control-token` —— 安装私有目录，默认 `~/.she-app`，**在工作区之外**。
 * 桌面端（`main.cjs`）在开窗前读它并交给 preload，界面因此不需要用户手输任何东西。
 *
 * 这道锁挡得住什么，要说清楚，不能含糊：
 *
 *   - **挡得住**：网络对端、反代后面的浏览器、频道外拿不到这个文件的调用方，以及
 *     **沙箱里的 Agent** —— 后者由 `sandbox` 侧对这个文件单独设了拒绝（见 `tools.ts` 的
 *     `CONTROL_TOKEN_REASON`），所以它既调不动控制面，也读不到凭据。
 *   - **挡不住**：以同一个 OS 用户身份运行、且在工作区外有完整读权限的其它程序。同机同用户的
 *     隔离是操作系统的事，不是一个文件权限能解决的 —— 这一条写在 `tenancy.ts` 里也成立。
 *
 * 换句话说：这条锁把"一行 curl 就能改自己的沙箱"变成一个**跨出工作区、还要绕开沙箱拒绝**的
 * 动作，而那个动作在运行轨迹与审计日志里是可见的。
 *
 * ## 为什么是持久化而不是每次启动重新生成
 *
 * 重新生成会让每次重启把所有已连接的客户端踢下线（桌面的 token 是开窗时读的），而"重启后
 * 界面莫名其妙要重新认证"是那种会被用户用 `SHE_CONTROL_AUTH=off` 绕过去的故障。稳定一份，
 * 换新要走显式动作。
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 文件名。放在 appDir 下，和其它安装私有状态（plugins / theme / background）并列。 */
export const CONTROL_TOKEN_FILE = 'control-token';

/**
 * 凭据的最短长度。
 *
 * 与 `tenancy.ts` 的 `MIN_TOKEN_LENGTH` 同一条理由：短到能被穷举的凭据看起来像保护而不是保护。
 * 生成的一律远超这个数，这条管的是**用户手填**的那条路径。
 */
const MIN_TOKEN_LENGTH = 16;

export interface ControlAuth {
  /**
   * 这次进程要的控制面凭据。
   *
   * `null` 表示控制面**不校验** —— 只在用户显式关掉时发生（`SHE_CONTROL_AUTH=off`），
   * 且启动时会明说。
   */
  token: string | null;
  /** 凭据来自哪里，供启动日志与诊断用。 */
  source: 'env' | 'generated' | 'file' | 'off';
  /** 生成/读取用的文件路径（`off` 时仍有值，方便提示"本该在哪"）。 */
  path: string;
  /** 这次进程**新建**了凭据（第一次在这台机器上跑）。 */
  created: boolean;
}

/** 用户显式关掉的写法。除了 `0`/`false` 之外的任何值都算"给了一条凭据"。 */
function isOff(raw: string | undefined): boolean {
  return raw === '0' || raw === 'false';
}

/**
 * 解决这一次进程要用的控制面凭据。
 *
 * 优先级：显式给定 > 已有文件 > 生成一份。顺序是刻意的 —— 显式给定让测试与运维有确定答案，
 * 已有文件让重启不改变任何东西，只有两样都没有时才生成（第一次跑）。
 *
 * 失败方向：写不出文件（只读盘、权限不对）时**不静默降级成不校验**，而是抛出。理由和
 * `tenancy.ts` 里 token 太短就拒绝启动一样 —— "以为被保护着"比"知道没被保护"危险得多。
 */
export function resolveControlAuth(
  appDir: string,
  env: Record<string, string | undefined> = process.env,
): ControlAuth {
  const file = join(appDir, CONTROL_TOKEN_FILE);

  if (isOff(env.SHE_CONTROL_AUTH)) {
    return { token: null, source: 'off', path: file, created: false };
  }

  const given = env.SHE_CONTROL_TOKEN?.trim();
  if (given) {
    if (given.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `SHE_CONTROL_TOKEN 只有 ${given.length} 个字符，至少需要 ${MIN_TOKEN_LENGTH} 个。`
        + '过短的凭据挡不住任何人，静默接受它比不校验更危险。',
      );
    }
    return { token: given, source: 'env', path: file, created: false };
  }

  try {
    const existing = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    if (existing) return { token: existing, source: 'file', path: file, created: false };
  } catch {
    /*
     * 读不动这个文件 —— 落到"生成一份"。
     *
     * 不在这里抛：读失败最常见的原因是文件根本不存在（`existsSync` 与 `readFileSync` 之间
     * 的竞态、或某些平台上 `existsSync` 对符号链接的判断），而那条路径下面会正常走到生成。
     * 真的写不进去时，写的那一步会抛，不会静默变成"不校验"。
     */
  }

  const token = randomBytes(32).toString('base64url');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 });
    /*
     * Windows 上 `mode` 基本不生效（文件继承目录 ACL），所以显式再 chmod 一次。
     * 拿不到预期权限也不算失败：同用户进程本来就挡不住（见文件头的说明），
     * 这里只是尽量把"别的账户也能读"这种更糟的情况排除掉。
     */
    try { chmodSync(file, 0o600); } catch { /* 平台不支持，不阻断 */ }
  } catch (err) {
    throw new Error(
      `控制面凭据无法写入 ${file}：${(err as Error).message}。`
      + '控制面需要这份凭据才能启动（不校验比校验更危险），请修好该目录的写权限，'
      + '或显式用 SHE_CONTROL_TOKEN 给一份。',
    );
  }
  return { token, source: 'generated', path: file, created: true };
}

/**
 * 这次的请求有没有拿出控制面凭据。
 *
 * 接受和租户 token 同一个头（`x-she-token`）以及 `Authorization: Bearer`，这样调用方只需要
 * 记住一种写法 —— 两个开关用两套头只会让人配错。
 *
 * 比较用 `timingSafeEqual`：长度先比是为了让它能安全调用（长度不同它会抛），而长度本身不是
 * 秘密。这不是在防本机同用户的穷举（那种攻击者可直接读文件），是在防**远端**按响应时间逐字节
 * 试 —— 和 `tenancy.ts` 里同一条理由。
 */
export function presentsControlToken(headers: Record<string, string | string[] | undefined>, token: string): boolean {
  const single = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '');
  const candidates = [
    single(headers['x-she-token']),
    (() => {
      const auth = single(headers.authorization);
      return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
    })(),
  ].filter(Boolean);

  return candidates.some((c) => timingSafeEqualStr(c, token));
}

/** 常数时间比较两个字符串。长度不同直接返回 false —— 长度不是秘密，而 `timingSafeEqual` 拒收不同长度。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
