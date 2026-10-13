/**
 * 「状态文件无法读取」横幅的"知道了"要**跨重启**记住。
 *
 * 用户报的原话：「检查状态这个玩意每次都出现」。之前它存在 sessionStorage —— 关掉窗口就忘，
 * 于是每次开应用都再看到一遍同一句话。
 *
 * 备份文件本身照旧留着（数据安全不受影响），这里只记"这条已经看过了"；按**备份路径**记，
 * 所以新隔离出来的文件仍然会提示（那条路径没记过）。
 * 和草稿一样走 localStorage（同一个先例：lib/draft.ts）。
 *
 * 读写都不抛：存不下（隐私模式、配额满）就退回"下次再提示一次"，不影响正确性。
 */
const KEY = 'she.dismissedRecoveries';
/** 记到 200 条就够用一辈子了；再多就是坏数据，砍掉最旧的。 */
const MAX = 200;

export function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(-MAX);
  } catch {
    return [];
  }
}

export function addDismissed(paths: string[]): string[] {
  const next = [...new Set([...loadDismissed(), ...paths.filter((p) => typeof p === 'string' && p)])].slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存不下就算了：下次开窗口还会提示一次，不影响正确性 */
  }
  return next;
}
