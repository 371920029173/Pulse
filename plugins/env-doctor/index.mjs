/**
 * env-doctor — the "why doesn't this run" first-aid tool.
 *
 * Every one of these checks has cost someone an afternoon: a stale Node, a port
 * still held by a zombie process from a previous run, an API key that was never
 * actually saved. Running them in one call beats discovering them one at a time.
 *
 * Declares `shell` (to query versions and the port) and `read` (to audit .env).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

/** Minimum versions the project states in package.json engines. */
const MIN_NODE_MAJOR = 20;

/**
 * Keys the app needs to actually work. `fallback*` keys are optional, so they
 * are not listed — a missing optional key is not a problem to report.
 */
const REQUIRED_ENV = [
  { key: 'SHE_LLM_PROVIDER', hint: 'LLM 供应商（openai / anthropic）' },
  { key: 'OPENAI_API_KEY', hint: 'DeepSeek / OpenAI 兼容接口的密钥', alt: 'AGI_USE_API_KEY' },
  { key: 'OPENAI_BASE_URL', hint: '接口地址，例如 https://api.deepseek.com' },
  { key: 'OPENAI_MODEL', hint: '模型名，例如 deepseek-flash' },
];

/** Is anything listening on this port right now? */
function portInUse(port) {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.once('error', () => resolvePromise(true));
    server.once('listening', () => server.close(() => resolvePromise(false)));
    server.listen(port, '127.0.0.1');
  });
}

/** Parse KEY=value lines, ignoring comments. Mirrors the app's own parser. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim().replace(/^\uFEFF/, '')] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export const tools = [
  {
    name: 'env_check',
    description:
      "Check the local development environment: runtime versions (node/pnpm/git), whether the "
      + "SHE port is already in use, and which expected .env keys are missing. Use this when "
      + "something 'should work but does not'.",
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'Port to check for occupancy (default 5577)' },
        envFile: { type: 'string', description: 'Path to the env file to audit (default .env)' },
      },
    },
  },
];

tools[0].run = async (args, ctx) => {
  // The port the running server actually uses, not a hardcoded guess (4577 is in a Windows reserved range).
  const port = Number(args.port) || Number(process.env.SHE_PORT) || 5577;
  const envRel = String(args.envFile ?? '.env').trim() || '.env';
  const lines = ['环境体检', ''];
  const problems = [];

  // ── runtimes ───────────────────────────────────────────────────────────────
  lines.push('运行时:');
  for (const [bin, args_] of [['node', '-v'], ['pnpm', '-v'], ['git', '--version']]) {
    const r = await ctx.exec(`${bin} ${args_}`, { timeoutMs: 10_000 });
    if (r.code !== 0) {
      lines.push(`  ✗ ${bin.padEnd(6)} 未安装或不可执行`);
      problems.push(`${bin} 不在 PATH 里`);
      continue;
    }
    const version = (r.stdout || r.stderr).trim().split('\n')[0];
    lines.push(`  ✓ ${bin.padEnd(6)} ${version}`);
  }

  // Node's major version is the single most common "installed but too old".
  const nodeR = await ctx.exec('node -v', { timeoutMs: 10_000 });
  const major = Number((nodeR.stdout.match(/v(\d+)/) ?? [])[1] ?? 0);
  if (major && major < MIN_NODE_MAJOR) {
    problems.push(`Node ${major} 太旧，需要 >= ${MIN_NODE_MAJOR}`);
  }
  lines.push('');

  // ── port ──────────────────────────────────────────────────────────────────
  const busy = await portInUse(port);
  lines.push(`端口 ${port}: ${busy ? '被占用' : '空闲'}`);
  if (busy) {
    // Occupied is not necessarily wrong — it may be SHE itself. Say so.
    lines.push('  （如果 SHE 正在运行，这是正常的；否则先关掉占用它的进程再启动）');
  }
  lines.push('');

  // ── env ───────────────────────────────────────────────────────────────────
  lines.push(`配置 (${envRel}):`);
  const envPath = join(ctx.workspaceRoot, envRel);
  /*
   * A missing .env is only a problem in a SHE checkout. In an ordinary project workspace the
   * configuration lives with the SHE install and is already loaded into this process, so telling
   * the user to "copy .env.example" there was a false alarm (the file does not even exist).
   */
  const isSheCheckout = existsSync(join(ctx.workspaceRoot, '.env.example'));
  const loadedFromProcess = REQUIRED_ENV.every((item) => process.env[item.key] || (item.alt && process.env[item.alt]));
  if (!existsSync(envPath) && (!isSheCheckout || loadedFromProcess)) {
    lines.push(isSheCheckout
      ? '  - 文件不存在，但所需配置已由正在运行的 SHE 加载，无需处理'
      : '  - 当前工作区不是 SHE 源码目录，配置来自 SHE 安装目录，跳过');
  } else if (!existsSync(envPath)) {
    lines.push('  ✗ 文件不存在');
    problems.push(`${envRel} 不存在 —— 从 .env.example 复制一份`);
  } else {
    let env = {};
    try {
      env = parseEnv(readFileSync(envPath, 'utf8'));
    } catch (e) {
      lines.push(`  ✗ 读取失败: ${e.message}`);
    }
    for (const item of REQUIRED_ENV) {
      const has = env[item.key] || (item.alt && env[item.alt]);
      if (has) {
        // Never print the value of anything key-shaped.
        const shown = /KEY|SECRET|TOKEN/i.test(item.key)
          ? `${String(has).slice(0, 4)}…（已隐藏）`
          : has;
        lines.push(`  ✓ ${item.key.padEnd(20)} ${shown}`);
      } else {
        lines.push(`  ✗ ${item.key.padEnd(20)} 缺失 — ${item.hint}`);
        problems.push(`缺少 ${item.key}`);
      }
    }
    // A BOM on the first key is a real, silent failure mode on Windows.
    const raw = readFileSync(envPath, 'utf8');
    if (raw.startsWith('\uFEFF')) {
      lines.push('  ! 文件带 UTF-8 BOM —— 旧解析器会把第一个键读成乱码');
      problems.push('.env 有 BOM，建议改存为无 BOM 的 UTF-8');
    }
  }

  lines.push('');
  if (problems.length) {
    lines.push(`发现 ${problems.length} 个问题:`);
    for (const p of problems) lines.push(`  - ${p}`);
  } else {
    lines.push('没有发现问题。');
  }
  return lines.join('\n');
};
