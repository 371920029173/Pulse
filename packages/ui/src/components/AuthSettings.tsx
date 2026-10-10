/**
 * API 认证：状态 + 开关。
 *
 * 为什么值得占界面一格：服务端的令牌机制一直都在（`SHE_AUTH_TOKEN` / `SHE_AUTH_TOKENS`，见
 * `packages/server/src/tenancy.ts`），但入口只有 `.env` 和文档。而这个 API 能跑 shell、读写工作区、
 * 改自己的设置 —— "默认开放、想关就能关"这件事必须看得见、点得到，而不是只写在 README 的一句警告里。
 *
 * 三个不显眼但要紧的点：
 *  1. **令牌不回显。** 状态只回答"开没开、几个租户"（`/api/auth/status` 就是这么设计的）；输入框是
 *     新值入口，留空即不改。令牌本身不出现在响应、界面或日志里。
 *  2. **开完这一扇窗要能继续用。** 桌面壳是启动时把令牌交给窗口的，运行中打开认证后它不会自动补上；
 *     这里顺手写进 `localStorage['she.authToken']`（`lib/api.ts` 认的三个来源之一），本窗口立刻带上。
 *  3. **服务端说了算。** 每个动作之后重新读一次状态，而不是把"我刚提交的值"当成结果 —— 校验在服务端
 *     （短令牌、重复令牌都由它拒），界面不该复述一份可能过时的规则。
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';
import styles from '../styles/Settings.module.css';

interface AuthStatus {
  enabled: boolean;
  tenants: number;
  header: string;
}

export function AuthSettings() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await fetchJSON<AuthStatus>('/api/auth/status');
      setStatus({
        enabled: Boolean(s.enabled),
        tenants: Number(s.tenants ?? 0),
        header: String(s.header ?? 'x-she-token'),
      });
    } catch {
      // 读不到就说不知道 —— 不能把"读失败"画成"没开"。
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (disable: boolean) => {
      const value = token.trim();
      if (!disable && !value) return;
      setBusy(true);
      setMsg('');
      try {
        await fetchJSON('/api/auth/config', {
          method: 'PUT',
          body: disable ? { disable: true } : { token: value },
        });
        try {
          if (disable) window.localStorage.removeItem('she.authToken');
          else window.localStorage.setItem('she.authToken', value);
        } catch {
          /* 存不进 localStorage 只影响本窗口下一次请求，服务端已经生效 */
        }
        setToken('');
        await load();
        setMsg(disable ? t('已关闭：本机任何进程都能连这个 API。') : t('已开启。本窗口已带上令牌。'));
      } catch (err) {
        setMsg(t('没能保存：{why}', { why: (err as Error).message }));
      } finally {
        setBusy(false);
      }
    },
    [token, load],
  );

  return (
    <div className={styles.field} data-surface="settings-auth">
      <div className={styles.row}>
        <div className={styles.rowTitle}>{t('API 认证')}</div>
        <div className={styles.rowSub}>
          {status === null
            ? t('（状态未知：读不到 /api/auth/status）')
            : status.enabled
              ? t('（已开启，{n} 个租户；令牌从 {header} 头读取）', { n: status.tenants, header: status.header })
              : t('（未开启：本机任何进程都能连这个 API —— 它能跑命令、读写工作区）')}
        </div>
      </div>
      <input
        type="password"
        autoComplete="off"
        placeholder={status?.enabled ? t('换一个令牌（留空则不改）') : t('至少 16 个字符；填了就能开')}
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <div className={styles.row}>
        <button
          type="button"
          className={styles.saveBtn}
          disabled={busy || !token.trim()}
          onClick={() => void save(false)}
        >
          {busy ? t('处理中…') : t('开启 / 更新令牌')}
        </button>
        <button
          type="button"
          className={styles.saveBtn}
          disabled={busy || status?.enabled !== true}
          onClick={() => void save(true)}
        >
          {t('关闭认证')}
        </button>
      </div>
      <p className={styles.hint}>
        {t('令牌只写进 .env（SHE_AUTH_TOKEN；多租户用 SHE_AUTH_TOKENS=租户:令牌,…），不回显、不进日志。本窗口会立刻带上它；桌面壳要重启才带上。')}
      </p>
      {msg ? <p className={styles.hint} role="status">{msg}</p> : null}
    </div>
  );
}
