/*
 * 界面状态跟着**项目**走，不再跟着端口走。
 *
 * 用户报的两件事同一个根因：
 *   ·「这个玩意还是每次重启都弹」（状态文件恢复横幅的"知道了"）—— 我上一版把它存进 localStorage；
 *   ·「推理设置为高、输入框里没发出去的字，下次打开希望还在」—— 草稿、推理档位、技能档也都在 localStorage。
 *
 * localStorage 按「协议://主机:端口」隔离，而桌面端每个窗口的后端端口**每次启动都可能变**
 * （这台机器的 Hyper-V 保留端口段让"猜一个空闲端口"四十次全败，于是改成向系统要一个 —— 见
 * packages/desktop/backend-pool.cjs；.she/desktop-ws-<端口>.log 那一串就是痕迹）。
 * 端口一变，origin 就变了，localStorage 是空的 —— 上述全部状态归零。
 *
 * 做法：落到**工作区级**的服务端状态文件 `.she/ui-state.json`（键是 `she.*` 的字符串表）。
 *   读：启动时先 GET 回来灌进 localStorage，**必须在首次渲染之前**（各处都在 useState 初始化里同步读）。
 *   写：定时把当前值整份送回（上次送出、这次没有的键发 null = 删除），另在页面隐藏/卸载时补一次。
 * `she.authToken` **永不参与**：那是这一扇窗口自己的凭据，不该落到磁盘上的状态文件里。
 *
 * 失败一律当"没有变化"：拿不到服务端就退回老行为（本次会话照常，只是不跨重启），绝不因为同步问题
 * 影响界面。
 */
const PREFIX = 'she.';
const EXCLUDE = new Set(['she.authToken']);
const SYNC_MS = 1500;
const MAX_VALUE_CHARS = 200_000;

function usable(key: string): boolean {
  return key.startsWith(PREFIX) && !EXCLUDE.has(key);
}

/** 当前这一份（`she.*`，除凭据）。 */
export function snapshotUiState(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !usable(k)) continue;
      const v = localStorage.getItem(k);
      if (typeof v === 'string' && v.length <= MAX_VALUE_CHARS) out[k] = v;
    }
  } catch { /* 隐私模式等：当成空的 */ }
  return out;
}

/**
 * 把上一次的快照灌回 localStorage。**要在首次渲染之前 await**。
 * 只写服务端有、本地没有的键？不 —— 服务端这份就是"上次离开时的样子"，整份写回；
 * 本地已有的同键值以服务端为准（同一台机器、同一个工作区，服务端更新）。
 */
export async function hydrateUiState(): Promise<void> {
  try {
    const res = await fetch('/api/ui-state', { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const data = (await res.json()) as { state?: Record<string, unknown> };
    const state = data?.state ?? {};
    for (const [k, v] of Object.entries(state)) {
      if (!usable(k) || typeof v !== 'string') continue;
      try { localStorage.setItem(k, v); } catch { /* 配额满：跳过这一个键 */ }
    }
  } catch { /* 服务端不可达：退回老行为 */ }
}

let lastSent: Record<string, string> = {};
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** 送一次（增删都带）。返回是否真的发了请求。 */
export async function flushUiState(): Promise<boolean> {
  if (inFlight) return false;
  const now = snapshotUiState();
  const entries: Record<string, string | null> = {};
  let changed = false;
  for (const [k, v] of Object.entries(now)) if (lastSent[k] !== v) { entries[k] = v; changed = true; }
  for (const k of Object.keys(lastSent)) if (!(k in now)) { entries[k] = null; changed = true; }
  if (!changed) return false;
  inFlight = true;
  try {
    const res = await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    // 只有真写进去才认账；否则下一次 tick 会再试（没有重试计数：状态很小，代价可忽略）
    if (res.ok) lastSent = now;
    return res.ok;
  } catch {
    return false;
  } finally {
    inFlight = false;
  }
}

/** 起后台同步（幂等：重复调用不会再起一个定时器）。 */
export function startUiStateSync(): void {
  if (timer) return;
  lastSent = snapshotUiState();
  timer = setInterval(() => { void flushUiState(); }, SYNC_MS);
  try {
    window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushUiState(); });
    window.addEventListener('beforeunload', () => { void flushUiState(); });
  } catch { /* 非浏览器环境（测试） */ }
}
