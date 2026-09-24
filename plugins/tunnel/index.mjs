/**
 * tunnel — expose the local SHE server through a tunnel you already trust.
 *
 * Deliberately does NOT bundle or reimplement a tunnel. Three reasons:
 *
 *  1. Reachability is a security boundary. Whoever gets the URL can drive the
 *     agent, so the choice of provider, the account behind it, and the access
 *     policy must stay with the user — not be hidden inside a feature.
 *  2. Tunnelling well is hard (reconnect, auth, certificates). cloudflared,
 *     ngrok and tailscale already solve it; wrapping them is honest work.
 *  3. A built-in tunnel would need OUR credentials and infrastructure, which
 *     means the traffic passes through a third party by default.
 *
 * So this plugin detects what you have, runs it with a documented command, and
 * surfaces the public URL. If nothing is installed it says so and stops.
 */

import { spawn } from 'node:child_process';

/** Providers we know how to drive, with the exact command and how to find the URL. */
const PROVIDERS = {
  cloudflared: {
    label: 'cloudflared',
    // Quick tunnels need no account; named tunnels are the user's own business.
    args: (port) => ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
    urlPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
    docs: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/',
    note: '免账号的临时隧道，URL 每次不同；服务一停就失效。',
  },
  ngrok: {
    label: 'ngrok',
    args: (port) => ['http', String(port)],
    urlPattern: /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/i,
    docs: 'https://ngrok.com/docs',
    note: '需要先 ngrok config add-authtoken 配好账号。',
  },
  tailscale: {
    label: 'tailscale',
    // Serves the port on the tailnet; the "URL" is the node's name, not https.
    args: (port) => ['serve', '--bg', `http://127.0.0.1:${port}`],
    urlPattern: /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/i,
    docs: 'https://tailscale.com/kb/1242/tailscale-serve',
    note: '走你自己的 tailnet，只有你网络内的设备能访问——最安全的一种。',
  },
};

const isWindows = process.platform === 'win32';

/** The tunnel this process started, so it can be stopped without hunting PIDs. */
let tunnelChild = null;

/** `where`/`which` for the given binary; returns true when present. */
async function hasBinary(ctx, name) {
  const found = await ctx.exec(isWindows ? `where ${name}` : `command -v ${name}`, { timeoutMs: 8000 });
  return found.code === 0 && found.stdout.trim().length > 0;
}

export const tools = [
  {
    name: 'tunnel_providers',
    description:
      'Detect which tunnel CLIs are installed (cloudflared, ngrok, tailscale) and show the exact '
      + 'command that would be run. Use this before tunnel_start.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'tunnel_start',
    description:
      'Start a tunnel to the local SHE server and return the public URL. Requires the chosen CLI '
      + 'to be installed. NOTE: anyone with the URL can control this agent — prefer tailscale, and '
      + 'stop the tunnel when you are done.',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: Object.keys(PROVIDERS), description: 'Which CLI to use' },
        port: { type: 'number', description: 'Local port to expose (default 5577)' },
        seconds: { type: 'number', description: 'How long to wait for the URL (default 25)' },
      },
      required: ['provider'],
    },
  },
  {
    name: 'tunnel_stop',
    description:
      'Stop the tunnel this plugin started. Call this when the URL is no longer needed so the control plane is not left exposed.',
    parameters: { type: 'object', properties: {} },
  },
];

tools[0].run = async (_args, ctx) => {
  const lines = ['隧道工具检测', ''];
  let any = false;
  for (const [key, p] of Object.entries(PROVIDERS)) {
    const ok = await hasBinary(ctx, key);
    if (ok) any = true;
    lines.push(`  ${ok ? '✓' : '✗'} ${p.label.padEnd(12)} ${ok ? '已安装' : '未安装'}`);
    if (ok) lines.push(`      ${p.note}`);
    lines.push(`      文档 ${p.docs}`);
  }
  lines.push('');
  lines.push(any
    ? '要启用：tunnel_start（建议用 tailscale —— 只有你自己的设备能连）'
    : '一个都没有。装一个再回来，或者用飞书遥控（扩展坞里配，不开任何端口）。');
  return lines.join('\n');
};

tools[1].run = async (args, ctx) => {
  const key = String(args.provider ?? '').trim();
  const p = PROVIDERS[key];
  if (!p) return `Error: 未知 provider "${key}"（可选: ${Object.keys(PROVIDERS).join(', ')}）`;

  const port = Number(args.port) || 5577;
  const waitMs = Math.max(5, Math.min(90, Number(args.seconds) || 25)) * 1000;

  if (!(await hasBinary(ctx, key))) {
    return `${p.label} 没有安装，无法启动。\n安装说明: ${p.docs}`;
  }

  const cmd = [key, ...p.args(port)].join(' ');
  ctx.log(`starting tunnel: ${cmd}`);

  /*
   * The provider runs in the foreground and never exits, so we watch its output
   * for the URL and then return — leaving the process running. Killing it here
   * would defeat the point; the user stops it by ending the tunnel themselves
   * (or closing SHE). This is why the command is also printed: so it can be run
   * and stopped by hand if that is preferable.
   */
  const url = await new Promise((resolvePromise) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolvePromise(v); } };

    try {
      /*
       * ctx.exec resolves only when the process exits, so it cannot be used for
       * a long-running foreground process — spawn directly and scan output as it
       * arrives. This is the one place the plugin reaches past `ctx`, and it is
       * why the manifest declares the `shell` permission.
       */
      if (tunnelChild && !tunnelChild.killed) {
        try { tunnelChild.kill(); } catch { /* replaced below */ }
      }
      const child = spawn(key, p.args(port), { cwd: ctx.workspaceRoot, shell: false, windowsHide: true });
      tunnelChild = child;
      const scan = (buf) => {
        const text = String(buf);
        const m = text.match(p.urlPattern);
        if (m) finish(m[0]);
      };
      child.stdout?.on('data', scan);
      child.stderr?.on('data', scan);
      child.on('error', () => finish(null));
      child.on('close', () => finish(null));
      setTimeout(() => finish(null), waitMs);
    } catch {
      finish(null);
    }
  });

  if (!url) {
    return [
      `没能在 ${waitMs / 1000}s 内从 ${p.label} 的输出里找到公网地址。`,
      '',
      '可能原因：需要先登录 / 配置账号，或者首次运行要下载组件。',
      `建议手动跑一次看看：`,
      `  ${cmd}`,
      `文档: ${p.docs}`,
    ].join('\n');
  }

  return [
    `隧道已启动（${p.label}）`,
    '',
    `  公网地址  ${url}`,
    `  指向      http://127.0.0.1:${port}`,
    '',
    '安全提醒：拿到这个地址的人可以操作本机的智能体（读写文件、执行命令）。',
    '  1. 优先用 tailscale —— 只有你自己的设备能连',
    '  2. 临时用完就停掉隧道',
    '  3. 不要把地址发到群里或公开的地方',
    '  4. 用完调用 tunnel_stop',
  ].join('\n');
};

tools[2].run = async () => {
  const child = tunnelChild;
  tunnelChild = null;
  if (!child || child.killed) return '当前没有由本插件启动的隧道。';
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill();
    }
  } catch (err) {
    return `停止失败: ${err.message}`;
  }
  return '隧道已停止。公网地址随之失效。';
};
