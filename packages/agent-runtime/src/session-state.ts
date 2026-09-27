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
  const why = sessionIdProblem(sessionId);
  if (why) throw new Error(`会话 id 不合法（${why}），不能拿它拼状态路径: ${JSON.stringify(sessionId)}`);
  return join(workspaceRoot, '.she', 'sessions', encodeSessionId(sessionId));
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
