/** 未发送的草稿：关掉窗口、刷新、切回来都还在。 */
const PREFIX = 'she.draft.';

/**
 * 草稿按会话分键。
 *
 * 用户的抱怨是"关闭窗口后不会保留窗口内未发送的消息"——所以这里用 localStorage，
 * **不是** sessionStorage：后者的生命周期就是那个窗口，窗口一关草稿就没了，正是要修的行为。
 */
export function draftKey(sessionId?: string | null): string {
  return PREFIX + ((sessionId ?? '').trim() || 'default');
}

/** 读草稿。读不到（或浏览器禁用存储）就是空串，不抛错。 */
export function loadDraft(sessionId?: string | null): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

/** 存草稿；空文本等于删除（不要留一堆空键）。 */
export function saveDraft(sessionId: string | null | undefined, text: string): void {
  try {
    const k = draftKey(sessionId);
    if (text) localStorage.setItem(k, text);
    else localStorage.removeItem(k);
  } catch {
    /* 隐私模式 / 存储禁用：草稿只是便利功能，不能因为它把输入弄崩 */
  }
}

export function clearDraft(sessionId?: string | null): void {
  saveDraft(sessionId, '');
}
