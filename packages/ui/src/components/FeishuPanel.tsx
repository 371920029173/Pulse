import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { toast } from '../lib/toast';
import styles from '../styles/Dock.module.css';

/**
 * Feishu remote control.
 *
 * Extracted from the Dock so the Dock can be purely about plugins. This is the
 * one remote-access path that ships enabled, and it is deliberately the safest:
 * the desktop dials OUT over a long connection, so there is no listening port
 * and no public URL, and only allowlisted `open_id`s can drive the agent.
 */

export interface FeishuStatus {
  configured: boolean;
  hasSecret: boolean;
  running: boolean;
  connected: boolean;
  pairing: boolean;
  appId: string | null;
  allowedUserCount: number;
  lastEventAt: string | null;
  lastError: string | null;
  recent: { at: string; from: string; text: string; accepted: boolean; reason?: string }[];
}

export function FeishuPanel() {
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ appId: '', appSecret: '', allowedUsers: '' });

  const load = useCallback(async () => {
    try {
      setStatus(await fetchJSON<FeishuStatus>('/api/feishu/status'));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Poll while connected so the recent-message list stays live.
  useEffect(() => {
    if (!status?.running) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [status?.running, load]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await fetchJSON('/api/feishu/config', {
        method: 'PUT',
        body: { appId: form.appId, appSecret: form.appSecret, allowedUsers: form.allowedUsers },
      });
      toast('飞书配置已保存');
      setForm((f) => ({ ...f, appSecret: '' }));
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [form, load]);

  const toggle = useCallback(async (pairing = false) => {
    setBusy(true);
    try {
      const r = await fetchJSON<{ running: boolean }>(
        status?.running ? '/api/feishu/stop' : '/api/feishu/start',
        { method: 'POST', body: status?.running ? {} : { pairing } },
      );
      toast(status?.running ? '飞书遥控已断开' : pairing ? '配对模式已连接（不会执行指令）' : '飞书遥控已连接');
      void r;
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [status?.running, load]);

  /** Add a discovered open_id to the allowlist and save in one step. */
  const allowUser = useCallback(async (openId: string) => {
    const next = [...new Set([
      ...form.allowedUsers.split(',').map((s) => s.trim()).filter(Boolean),
      openId,
    ])].join(',');
    setForm((f) => ({ ...f, allowedUsers: next }));
    setBusy(true);
    try {
      await fetchJSON('/api/feishu/config', { method: 'PUT', body: { appId: form.appId, allowedUsers: next } });
      toast('已加入白名单，重新连接后生效');
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [form.allowedUsers, form.appId, load]);

  return (
    <div className={styles.remote}>
      <div className={styles.remoteHead}>
        <span className={`${styles.dot} ${status?.running && status?.connected ? styles.dotOn : ''}`} />
        <span className={styles.remoteTitle}>飞书遥控</span>
        <button type="button" className={styles.small} onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '配置'}
        </button>
        {!status?.running && status?.configured && status?.allowedUserCount === 0 ? (
          <button
            type="button"
            className={styles.small}
            disabled={busy}
            title="先连上，然后用飞书给机器人发消息，把返回的 open_id 填进白名单"
            onClick={() => void toggle(true)}
          >
            {busy ? '处理中…' : '配对模式'}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.small}
          disabled={busy || !status?.configured}
          onClick={() => void toggle(false)}
        >
          {busy ? '处理中…' : status?.running ? '断开' : '连接'}
        </button>
      </div>

      {status?.running ? (
        <>
          <div className={styles.remoteHint}>
            {status.pairing
              ? '配对模式：给机器人发一条消息，它会回你的 open_id，这里也会显示。此模式下不会执行任何指令。'
              : '已连上飞书。在飞书里私聊机器人即可操控这个对话；群里需要 @ 一下机器人。'}
          </div>
          <div className={styles.remoteMeta}>
            应用 {status.appId} · 授权账号 {status.allowedUserCount} 个
            {status.lastEventAt ? ` · 最后一条 ${new Date(status.lastEventAt).toLocaleTimeString()}` : ''}
          </div>
          {status.recent.length > 0 ? (
            <div className={styles.fsRecent}>
              {status.recent.slice(0, 5).map((r, i) => (
                <div key={`${r.at}-${i}`} className={styles.fsRecentRow}>
                  <span className={r.accepted ? styles.fsOk : styles.fsNo}>{r.accepted ? '✓' : '×'}</span>
                  <span className={styles.fsRecentText}>{r.text || '(空)'}</span>
                  {!r.accepted && r.from.startsWith('ou_') ? (
                    <button
                      type="button"
                      className={styles.fsAllow}
                      disabled={busy}
                      title={`把 ${r.from} 加入白名单`}
                      onClick={() => void allowUser(r.from)}
                    >
                      允许 {r.from.slice(0, 10)}…
                    </button>
                  ) : !r.accepted && r.reason ? (
                    <span className={styles.fsRecentWhy}>{r.reason}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.remoteMeta}>{status.pairing ? '等你在飞书里发第一条消息…' : ''}</div>
          )}
          {status.lastError ? <div className={styles.error}>{status.lastError}</div> : null}
        </>
      ) : (
        <div className={styles.remoteHint}>
          连上后，出门在外用手机飞书就能继续这个对话。
          走飞书长连接，不需要公网地址，也不会在局域网开端口。
        </div>
      )}

      {open ? (
        <div className={styles.fsForm}>
          <label className={styles.fsField}>
            <span>App ID</span>
            <input
              value={form.appId}
              placeholder="cli_xxxxxxxxxxxx"
              onChange={(e) => setForm((v) => ({ ...v, appId: e.target.value }))}
            />
          </label>
          <label className={styles.fsField}>
            <span>App Secret</span>
            <input
              type="password"
              value={form.appSecret}
              placeholder={status?.hasSecret ? '已保存（留空则不修改）' : '粘贴 App Secret'}
              onChange={(e) => setForm((v) => ({ ...v, appSecret: e.target.value }))}
            />
          </label>
          <label className={styles.fsField}>
            <span>授权账号 open_id</span>
            <textarea
              rows={2}
              value={form.allowedUsers}
              placeholder="多个用英文逗号分隔。留空则谁都不能用。"
              onChange={(e) => setForm((v) => ({ ...v, allowedUsers: e.target.value }))}
            />
          </label>
          <div className={styles.fsHelp}>
            在 <b>open.feishu.cn</b> 建一个<b>企业自建应用</b>，然后：
            <br />1. 复制 <b>App ID / App Secret</b>（填在上面）
            <br />2. 权限加 <code>im:message</code> + <code>im:message:send_as_bot</code>
            <br />3. 事件订阅选 <b>长连接</b>，订阅 <code>im.message.receive_v1</code>
            <br />4. <b>发布版本</b>（不发布不会推事件）
            <br />
            <span className={styles.fsHelpNote}>
              还不知道自己的 open_id？先保存 App ID / Secret，
              点上面的 <b>配对模式</b>，然后在飞书里给机器人随便发一句话 ——
              这里会显示你的 open_id，点一下就能加入白名单。
            </span>
          </div>
          <button type="button" className={styles.small} disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存配置'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
