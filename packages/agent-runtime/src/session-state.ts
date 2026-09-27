import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 一个会话的私有状态放在哪。
 *
 * 这是**唯一**拼这个路径的地方，故意的：只要有两个地方各拼一次，就会有一个地方忘了校验，而
 * "忘了校验的那个"就是跨会话读写的入口。
 *
 * 为什么要有这一层（2026-09-27 的隔离专项检查实测）：备忘、计划、置信度样本、子代理笔记、运行轨迹
 * 原本都是**工作区级单文件**，于是任何会话都能读到别的会话的计划全文、推理原文和笔记。那些文件之间
 * 只靠"记录里带一个 session_id、读的时候过滤一下"来分账 —— 那对"读"不成立：文件是同一份，路径上没有
 * 任何东西拦着你。这个函数把分账从"过滤"换成"路径不存在"。
 *
 * 为什么 id 非法就抛错、不留兜底桶：拿不到会话 id 的调用点（请求里没带、上下文丢了）如果静默落到一个
 * 共享目录，那个目录就是所有会话的记忆，而且没人会发现 —— 恰好是这一层要根除的形态。宁可抛错。
 *
 * 为什么是**编码**而不是"只接受 ASCII"：会话 id 的形状不止一种。聊天是 `sess_<hex>`，但群计划用的是
 * `cluster:<roomId>`（见 `groupPlanSession`），而 `:` 在 Windows 上不能出现在目录名里（会被当成盘符/
 * 备用数据流，`mkdir` 直接失败）。第一条实现是"白名单只放 [A-Za-z0-9_-]"，结果群计划的 store 一构造就
 * 抛错 —— 被门禁当场抓住。正确的形状是"把任意合法 id 映射成文件系统安全的名字"，而不是"拒绝不像聊天 id
 * 的东西"：编码可逆、不碰撞，而拒绝会让功能凭空消失。
 */
export function sessionStateDir(workspaceRoot: string, sessionId: string): string {
  return join(workspaceRoot, sessionStateRelDir(sessionId));
}

/**
 * 同一个路径，但相对工作区根 —— 给"要报给用户看的路径"用（例如写进笔记摘要的落点）。
 *
 * 存在的理由是"布局只能有一处知道"：这个前缀 `.she/sessions/<编码 id>` 之前在两处各拼了一次
 * （写入方和报给父级的交接消息），其中一处改了另一处没改，父级就会拿到一个指向空气的路径，而它
 * 分辨不出"笔记没写"和"路径错了"。
 */
export function sessionStateRelDir(sessionId: string): string {
  const why = sessionIdProblem(sessionId);
  if (why) throw new Error(`会话 id 不合法（${why}），不能拿它拼状态路径: ${JSON.stringify(sessionId)}`);
  return join(SESSIONS_REL, encodeSessionId(sessionId));
}

/** 所有会话私有状态的父目录（相对工作区）：`.she/sessions/`。 */
export const SESSIONS_REL = join('.she', 'sessions');

/** 所有会话私有状态的父目录：`.she/sessions/`。 */
export function sessionsRoot(workspaceRoot: string): string {
  return join(workspaceRoot, SESSIONS_REL);
}

/**
 * 目录名 → 会话 id，是 `encodeSessionId` 的逆。解不回来（旧版本留下的、手工创建的）返回 null。
 *
 * 需要它是因为"列出有哪些会话"这件事只能从目录名入手：`.she/sessions/` 下的目录名是编码过的，
 * 而调用方要的是能拿去开会话、能拼回 `sessionStateDir` 的 id。解错一个字符就会指向另一个会话，
 * 所以这里对解码结果再跑一遍合法性校验 —— 能解出来但拿回去拼不出同一个路径的，一律当不认识。
 */
export function decodeSessionId(dirName: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(dirName);
  } catch {
    // 手工改过的目录名里可能有个孤立的 `%`，`decodeURIComponent` 会抛。
    return null;
  }
  if (sessionIdProblem(decoded)) return null;
  if (encodeSessionId(decoded) !== dirName) return null;
  return decoded;
}

/**
 * 这个工作区里有过私有状态的会话 id。
 *
 * **列目录不是读内容**：返回的是名字，一个受权限保护的会话不会因此漏出任何计划、笔记或轨迹。
 * 它的用途只有一个 —— 用户显式要求"看别的会话"时的候选清单（面板里的选择器），以及把这些会话
 * 拼回 `sessionStateDir` 去读它们自己的目录。默认路径上没有任何东西调用它。
 *
 * 不解码的就跳过：一个解不出来的目录名属于"不认识"，而不是"某个会话"，猜一个 id 出来比跳过更糟。
 */
export function listSessionIds(workspaceRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionsRoot(workspaceRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const id = decodeSessionId(name);
    if (id) out.push(id);
  }
  return out.sort();
}

/**
 * 会话 id 能不能作为"一个会话的身份"。
 *
 * 这里只管**身份**的合法性，不管它是否适合当目录名 —— 那是编码的事。挡的是真会出问题的东西：
 * 非字符串（`String([1,2])` 是 `"1,2"`，别处已经栽过）、空、纯空白、过长、含路径分隔符或控制字符、
 * 以及 `.` / `..`。返回原因字符串，null 表示通过 —— 用返回值而不是 `asserts`，是因为抛错信息要能说清
 * 到底哪里不合法，而调用点需要 TypeScript 顺手把类型收窄。
 */
export function sessionIdProblem(sessionId: unknown): string | null {
  if (typeof sessionId !== 'string') return '不是字符串';
  if (!sessionId.trim()) return '空';
  if (sessionId.length > 200) return '过长';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(sessionId)) return '含控制字符';
  if (/[/\\]/.test(sessionId)) return '含路径分隔符';
  if (sessionId === '.' || sessionId === '..') return '是相对路径';
  return null;
}

export function assertSessionId(sessionId: unknown): asserts sessionId is string {
  const why = sessionIdProblem(sessionId);
  if (why) throw new Error(`会话 id 不合法（${why}），不能拿它拼状态路径: ${JSON.stringify(sessionId)}`);
}

export function isSafeSessionId(id: unknown): id is string {
  return sessionIdProblem(id) === null;
}

/**
 * 会话 id → 目录名：可逆、跨平台安全、不碰撞。
 *
 * `encodeURIComponent` 已经会转义 `:`、`/`、`\`、空格、中文等，但**留下** `.`、`*`、`!`、`~`、`'`、`(`、`)`。
 * 其中 `.` 必须自己转义：留着它就等于允许 `..` 拼出目录名（Windows 无法创建，POSIX 上能——那才是真的
 * 逃逸）。`*` 在 Windows 上非法，也一并转义。转义后只会剩下 `[A-Za-z0-9\-_!~'()%]`，全部合法。
 */
export function encodeSessionId(sessionId: string): string {
  const why = sessionIdProblem(sessionId);
  if (why) throw new Error(`会话 id 不合法（${why}）: ${JSON.stringify(sessionId)}`);
  return encodeURIComponent(sessionId).replace(/[.*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
