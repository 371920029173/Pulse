/**
 * 「有状态文件读不出来，但原样留着」的横幅。
 *
 * 存在的理由是一条真实的信息缺口：文件被隔离之后，界面只是少了几条会话 —— 和「应用把聊天记录
 * 删了」长得一模一样，而且没有任何地方说明差别。用户唯一能看到的证据就是这份横幅，所以它必须
 *
 *   - **常驻**，不是 toast。toast 会自己消失，而这条消息要在用户一小时后回来追问「我的对话呢」
 *     时仍然在屏幕上；这条横幅本身就是对那个问题的回答。
 *   - **带上备份文件的完整路径**。只说「已恢复」等于把用户卡在原地：能救回来的前提是他知道
 *     去哪个文件改名。
 *   - **说清楚是哪一个项目**。隔离是按项目发生的（工作区切换后各项目有自己的 .she 目录），
 *     不说清楚会让人以为是全局出事了。
 *
 * 单独成组件是为了能直接测它 —— 之前这类提示只写进日志，正是「没人看见」这个问题的形状。
 */
import { t } from '../lib/i18n';
import styles from '../styles/App.module.css';

/** One state file the server could not read and kept aside instead of discarding. */
export interface StateRecovery {
  kind: 'sessions' | 'cluster';
  /** Project the file belongs to. A quarantine is per-project, not global. */
  root: string;
  /** Absolute path of the kept-aside copy — the thing the user needs to put back. */
  backup: string;
  reason: string;
}

export interface StateRecoveryNoticeProps {
  recoveries: StateRecovery[];
  onDismiss: () => void;
}

export function StateRecoveryNotice({ recoveries, onDismiss }: StateRecoveryNoticeProps) {
  // Nothing to say — render nothing rather than an empty box.
  if (recoveries.length === 0) return null;

  return (
    <div className={styles.stateNotice} role="alert" data-surface="state-recovery">
      <div className={styles.stateNoticeText}>
        <strong>
          {t('有 {n} 个状态文件无法读取，已原样留底（没有丢弃）', { n: recoveries.length })}
        </strong>
        {recoveries.map((r) => (
          <span key={r.backup} className={styles.stateNoticeItem}>
            {t('{area}无法读取：{reason}。原文件保留在 {backup}', {
              area: r.kind === 'cluster' ? t('讨论组记录') : t('会话记录'),
              reason: r.reason,
              backup: r.backup,
            })}
          </span>
        ))}
      </div>
      <button type="button" className={styles.stateNoticeClose} onClick={onDismiss}>
        {t('知道了')}
      </button>
    </div>
  );
}
