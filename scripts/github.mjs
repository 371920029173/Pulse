#!/usr/bin/env node
/*
 * github —— 用 gh（已安装 2.96）包一层，省掉手动登录。
 *
 * ⚠️ 这个文件里**不存任何凭据**。账号密码这类东西写进仓库 = 立刻泄露给所有 clone 的人，
 *    也会进 git 历史（删掉也还在）。正确做法是让 gh 自己保管 token：
 *
 *      pnpm gh login        # 走浏览器/设备码；token 存在 gh 自己的密钥环里，不进仓库
 *      pnpm gh setup-git    # 让 git push/pull 复用 gh 的凭据（以后不再问用户名密码）
 *
 *    无人值守（CI/脚本）用环境变量：GH_TOKEN=... （同样不要写进仓库）
 *
 * 子命令：
 *   login            引导 gh auth login（交互式）
 *   setup-git        让 git 复用 gh 凭据
 *   status           gh auth status + 当前远端
 *   api <path>       直接打 REST（自动补 https://api.github.com/）
 *   pr [--state S]   列 PR
 *   issue [--state S]列 issue
 *   release [tag]    列 release，或给 tag 时看单个
 */
import { execFileSync } from 'node:child_process';

const gh = (args, inherit = false) => {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    return { error: out || err.message };
  }
};

const [cmd, ...rest] = process.argv.slice(2);

function needGh() {
  const v = gh(['--version']);
  if (typeof v === 'object' && v.error) {
    console.log('✗ 没找到 gh：先装 https://cli.github.com/ ，再跑 pnpm gh login');
    process.exit(2);
  }
}

switch (cmd) {
  case 'login': {
    needGh();
    console.log('即将进入 gh 的登录流程（浏览器/设备码）。token 由 gh 保管，不会写入本仓库。');
    gh(['auth', 'login'], true);
    break;
  }
  case 'setup-git': {
    needGh();
    console.log('让 git 复用 gh 的凭据……');
    gh(['auth', 'setup-git'], true);
    console.log('完成：以后 git push/pull 不再询问用户名密码。');
    break;
  }
  case 'status': {
    needGh();
    const auth = gh(['auth', 'status']);
    console.log(typeof auth === 'string' ? auth.trim() : `gh 未登录：${auth.error}`);
    const remote = gh(['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef,visibility']);
    if (typeof remote === 'string') {
      const j = JSON.parse(remote);
      console.log(`仓库 ${j.nameWithOwner}（${j.visibility}）默认分支 ${j.defaultBranchRef?.name ?? '?'}`);
      console.log(j.url);
    } else {
      console.log(`（当前目录没有远端：${remote.error}）`);
    }
    break;
  }
  case 'api': {
    needGh();
    const path = rest[0];
    if (!path) {
      console.log('用法: pnpm gh api <path>  例如 pnpm gh api repos/:owner/:repo');
      process.exit(2);
    }
    const full = /^https?:/.test(path) ? path : `https://api.github.com/${path.replace(/^\/+/, '')}`;
    gh(['api', full], true);
    break;
  }
  case 'pr': {
    needGh();
    gh(['pr', 'list', ...(rest.length ? rest : ['--state', 'open'])], true);
    break;
  }
  case 'issue': {
    needGh();
    gh(['issue', 'list', ...(rest.length ? rest : ['--state', 'open'])], true);
    break;
  }
  case 'release': {
    needGh();
    gh(rest[0] ? ['release', 'view', rest[0]] : ['release', 'list'], true);
    break;
  }
  default:
    console.log(`用法: pnpm gh <login|setup-git|status|api|pr|issue|release>

凭据放在哪：gh 自己的密钥环（pnpm gh login），或环境变量 GH_TOKEN。
**不要**把账号密码写进仓库、.env 或 KB —— 那会随 git 历史永久泄露。`);
    process.exit(cmd ? 2 : 0);
}
