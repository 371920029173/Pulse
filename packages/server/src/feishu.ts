import { createLogger } from '@she/shared';

const log = createLogger('feishu');

/**
 * Feishu (Lark) bridge — remote control over the user's own IM, instead of
 * exposing an HTTP port on the LAN.
 *
 * Why this shape:
 *  - **Long connection (WebSocket)**: the desktop dials OUT to Feishu, so no
 *    public URL, no ngrok, no port forwarding, no firewall hole. That is what
 *    makes it both safer and more convenient than a self-hosted web endpoint.
 *  - **Allowlist by open_id**: only the account(s) the user names can drive the
 *    agent. A bot that answers anyone is a remote shell for whoever finds it.
 *  - **No filesystem/shell surface**: only conversation text crosses the
 *    boundary. The agent still runs tools locally under its own sandbox policy.
 */

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** open_ids permitted to control the agent. Empty means "nobody yet". */
  allowedUsers: string[];
  /** Bot replies are truncated to this many characters (IM messages are long-form limited). */
  maxReplyChars: number;
}

export interface FeishuStatus {
  configured: boolean;
  running: boolean;
  /** Set while the long connection is established. */
  connected: boolean;
  /**
   * True while connected without an allowlist.
   *
   * Pairing mode exists to break a chicken-and-egg problem: you cannot learn
   * your own `open_id` until the bot receives a message, but the bot refuses to
   * start without an allowlist. In pairing mode the agent is unreachable —
   * messages only echo the sender's id back so it can be allowlisted.
   */
  pairing: boolean;
  appId: string | null;
  allowedUserCount: number;
  lastEventAt: string | null;
  lastError: string | null;
  /** Recent inbound messages, for the UI to show it is working. */
  recent: { at: string; from: string; text: string; accepted: boolean; reason?: string }[];
}

export interface FeishuDeps {
  /** Deliver a user message to the active conversation; resolves with the reply. */
  ask: (text: string) => Promise<string>;
  /** Current conversation title, shown in the bot's replies. */
  title: () => string;
}

const RECENT_MAX = 20;

export class FeishuBridge {
  private cfg: FeishuConfig;
  private deps: FeishuDeps;
  private client: unknown = null;
  private ws: { start: (args: unknown) => Promise<void>; close?: () => void } | null = null;
  private running = false;
  private connected = false;
  private pairing = false;
  private lastEventAt: string | null = null;
  private lastError: string | null = null;
  private recent: FeishuStatus['recent'] = [];
  /** Serialise turns: the agent has one conversation, so replies must not interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cfg: FeishuConfig, deps: FeishuDeps) {
    this.cfg = cfg;
    this.deps = deps;
  }

  updateConfig(cfg: FeishuConfig): void {
    this.cfg = cfg;
  }

  isConfigured(): boolean {
    return Boolean(this.cfg.appId && this.cfg.appSecret);
  }

  status(): FeishuStatus {
    return {
      configured: this.isConfigured(),
      running: this.running,
      connected: this.connected,
      pairing: this.pairing,
      appId: this.cfg.appId ? `${this.cfg.appId.slice(0, 8)}…` : null,
      allowedUserCount: this.cfg.allowedUsers.length,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      recent: this.recent,
    };
  }

  private note(from: string, text: string, accepted: boolean, reason?: string): void {
    this.recent.unshift({ at: new Date().toISOString(), from, text: text.slice(0, 120), accepted, reason });
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
  }

  /**
   * Check that the App ID / Secret are actually valid.
   *
   * Without this the long connection is fire-and-forget: `ws.start()` does not
   * resolve on success, so a typo'd secret left the UI reporting "已连上飞书"
   * while nothing was connected. Getting a tenant access token is the cheapest
   * way to prove the credentials work before claiming success.
   */
  private async verifyCredentials(): Promise<void> {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code !== 0) {
      throw new Error(
        `飞书拒绝了这个应用凭据（code ${data.code}: ${data.msg ?? '未知原因'}）。` +
        '请检查 App ID / App Secret 是否复制完整。',
      );
    }
  }

  /**
   * Start the long connection.
   *
   * Requires the Feishu app to have "长连接" event subscription enabled and to
   * subscribe to `im.message.receive_v1`.
   *
   * `pairing: true` starts WITHOUT an allowlist so the user can discover their
   * own `open_id`. In that mode the agent is never invoked — see onMessage.
   */
  async start(opts?: { pairing?: boolean }): Promise<FeishuStatus> {
    if (this.running) return this.status();
    if (!this.isConfigured()) {
      throw new Error('未配置飞书 App ID / App Secret');
    }

    const pairing = Boolean(opts?.pairing);
    if (!this.cfg.allowedUsers.length && !pairing) {
      throw new Error(
        '请先填写允许使用的飞书用户 open_id（否则任何人都能操控）。' +
        '不知道自己的 open_id 时，改用「配对模式」：连上后给机器人发一条消息，这里会显示你的 id。',
      );
    }

    // Prove the credentials before reporting success.
    try {
      await this.verifyCredentials();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.lastError = m;
      this.running = false;
      this.connected = false;
      throw new Error(m.includes('飞书拒绝') ? m : `连接飞书失败：${m}`);
    }

    // Loaded lazily so the dependency is only needed when the feature is used.
    const lark = await import('@larksuiteoapi/node-sdk');
    const { Client, WSClient, EventDispatcher, LoggerLevel } = lark as unknown as {
      Client: new (o: unknown) => unknown;
      WSClient: new (o: unknown) => { start: (a: unknown) => Promise<void>; close?: () => void };
      EventDispatcher: new (o: unknown) => { register: (h: Record<string, unknown>) => unknown };
      LoggerLevel: { warn: number };
    };

    const baseConfig = { appId: this.cfg.appId, appSecret: this.cfg.appSecret };
    const client = new Client({ ...baseConfig, loggerLevel: LoggerLevel.warn });
    this.client = client;

    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.onMessage(data as FeishuMessageEvent);
      },
    });

    const ws = new WSClient({
      ...baseConfig,
      loggerLevel: LoggerLevel.warn,
      autoReconnect: true,
    });
    this.ws = ws;

    // Do not await start(): it stays open for the process lifetime.
    void ws.start({ eventDispatcher: dispatcher }).catch((err: Error) => {
      this.connected = false;
      this.lastError = err.message;
      log.error(`Feishu long connection failed: ${err.message}`);
    });

    this.running = true;
    this.connected = true;
    this.pairing = pairing;
    this.lastError = null;
    log.info(`Feishu bridge started (long connection)${pairing ? ' [pairing mode: agent unreachable]' : ''}`);
    return this.status();
  }

  async stop(): Promise<FeishuStatus> {
    try { this.ws?.close?.(); } catch { /* ignore */ }
    this.ws = null;
    this.client = null;
    this.running = false;
    this.connected = false;
    this.pairing = false;
    log.info('Feishu bridge stopped');
    return this.status();
  }

  /** Handle one inbound message. */
  private async onMessage(ev: FeishuMessageEvent): Promise<void> {
    const msg = ev?.message;
    const sender = ev?.sender;
    if (!msg || !sender) return;

    this.lastEventAt = new Date().toISOString();

    const openId = sender.sender_id?.open_id ?? '';
    const text = extractText(msg);

    // p2p = direct chat with the bot; group chats additionally require an @mention.
    const isDirect = msg.chat_type === 'p2p';
    const mentioned = (msg.mentions ?? []).length > 0;
    if (!isDirect && !mentioned) return; // ignore ambient group chatter

    if (!openId) {
      this.note('unknown', text, false, '无法识别发送者 open_id');
      return;
    }

    // Pairing mode: never reach the agent. Echo the id so the local user can
    // allowlist it. This is what makes it safe to start without an allowlist.
    if (this.pairing) {
      this.note(openId, text, false, '配对模式：未接管对话');
      await this.reply(
        msg.message_id,
        `配对模式：你的 open_id 是\n${openId}\n\n把它填进 SHE 的「授权账号 open_id」并保存，然后重新连接，我就能帮你干活了。（当前不会执行任何指令）`,
      );
      return;
    }

    if (!this.cfg.allowedUsers.includes(openId)) {
      this.note(openId, text, false, '不在允许名单内');
      log.warn(`Feishu message from non-allowlisted open_id ${openId} ignored`);
      await this.reply(msg.message_id, '这个机器人只对已授权账号开放。');
      return;
    }
    if (!text.trim()) return;

    this.note(openId, text, true);

    // Commands that do not need the model.
    const cmd = text.trim().toLowerCase();
    if (cmd === '/help' || cmd === '帮助') {
      await this.reply(msg.message_id, helpText(this.deps.title()));
      return;
    }
    if (cmd === '/status' || cmd === '状态') {
      await this.reply(msg.message_id, `当前对话：${this.deps.title()}`);
      return;
    }

    // Serialise so two messages cannot interleave in one conversation.
    this.queue = this.queue.then(async () => {
      try {
        const reply = await this.deps.ask(text);
        await this.reply(msg.message_id, reply || '（无回复）');
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.lastError = m;
        await this.reply(msg.message_id, `执行出错：${m}`);
      }
    });
    await this.queue;
  }

  private async reply(messageId: string, text: string): Promise<void> {
    const client = this.client as {
      im?: { message?: { reply?: (o: unknown) => Promise<unknown>; create?: (o: unknown) => Promise<unknown> } };
    } | null;
    if (!client?.im?.message) return;

    const clipped = text.length > this.cfg.maxReplyChars
      ? text.slice(0, this.cfg.maxReplyChars) + `\n\n…（已截断，共 ${text.length} 字）`
      : text;

    try {
      await client.im.message.reply?.({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text: clipped }), msg_type: 'text' },
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.lastError = `回复失败: ${m}`;
      log.error(`Feishu reply failed: ${m}`);
    }
  }
}

interface FeishuMessageEvent {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id: string;
    chat_type?: string;
    mentions?: unknown[];
    content?: string;
  };
}

/** Feishu delivers text as `{"text":"..."}`; mention placeholders are stripped. */
function extractText(msg: NonNullable<FeishuMessageEvent['message']>): string {
  let raw = '';
  try {
    const parsed = JSON.parse(msg.content ?? '{}') as { text?: string };
    raw = parsed.text ?? '';
  } catch {
    raw = '';
  }
  // "@_user_1" style placeholders are how mentions appear in the text body.
  return raw.replace(/@_user_\d+/g, '').trim();
}

function helpText(title: string): string {
  return [
    `SHE 远程遥控`,
    `当前对话：${title}`,
    '',
    '直接发消息即可，会送进桌面端正在进行的对话。',
    '',
    '可用命令：',
    '/status  查看当前对话',
    '/help    显示这条说明',
  ].join('\n');
}
