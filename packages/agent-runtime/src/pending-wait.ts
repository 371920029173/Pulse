import type { ConfirmTicketInfo } from '@she/shared';

/**
 * 「这一轮停在哪、在等谁、等了多久」—— 一件以前只能靠猜的事。
 *
 * 在这之前，暂停是有状态的（`runPaused`），但那个状态**没有出口**：`/api/chat/pending-confirm` 只回一张
 * 工单，界面上能看到的是一张确认卡片；而工单的 TTL 是 120 秒，过了之后点"批准"得到的是 `confirm ticket
 * expired`，同时**这一轮还停在那里**。于是用户看到的是一张点不动的卡片，没人告诉他：这一轮在等的是他，
 * 已经等了多久，以及接下来该怎么办。
 *
 * 更坏的一种读法是把"工单过期"读成"这一轮结束了"。它没有结束 —— 它停着等一个人。这句区别必须写出来，
 * 因为从这里往回退一步就是"过一会儿自己继续"，而那正是「人一直不回应就暂停，不自己做危险的事」要防的。
 *
 * 这一块**故意做成纯函数**：`paused` 和工单都是入参，`now` 也能注入。过期这件事因此可以在单测里被
 * 确定地走一遍，而不是靠等 120 秒，也不是靠去读源码里有没有那行 `if`。
 */
export interface PendingWait {
  kind: 'confirm' | 'apply';
  /**
   * 等的是谁。写成一个字段而不是句子里的一句话，是因为将来会有别的等待对象（另一个智能体、外部服务），
   * 而界面需要的是能判断的值，不是一段需要解析的文字。
   */
  waitingOn: 'user';
  /** 开始等的时刻（ISO）。取工单自己的 `created_at` —— 那是权威来源，不是这里再记一次。 */
  since: string | null;
  /** 工单失效的时刻（ISO）。`apply` 那条路没有工单，所以可能是 null。 */
  expiresAt: string | null;
  /** 工单已经失效，而**这一轮仍然停着**。 */
  expired: boolean;
  /** 一句能直接显示给人的话。 */
  note: string;
}

export function describeWaiting(
  paused: 'confirm' | 'apply' | null,
  ticket: Pick<ConfirmTicketInfo, 'tool' | 'summary' | 'created_at' | 'expires_at'> | null,
  now: number = Date.now(),
): PendingWait | null {
  if (!paused) return null;

  const since = ticket?.created_at ?? null;
  const expiresAt = ticket?.expires_at ?? null;
  const expired = expiresAt ? now > Date.parse(expiresAt) : false;
  const what = paused === 'confirm' ? '确认一个危险操作' : '应用一份补丁';

  const note = expired
    ? `工单已经过期（${expiresAt}），而这一轮**仍然停着**等你${what}：它不会自行批准，也不会自行放弃或改做别的。`
      + '要继续就让它再跑一次那个操作（重新发起），或者直接停掉这一轮。'
    : `这一轮停着等你${what}${since ? `（从 ${since} 起）` : ''}。`;

  return { kind: paused, waitingOn: 'user', since, expiresAt, expired, note };
}
