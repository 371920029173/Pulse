/**
 * MCP 允许根收敛到工作区（评测报告 2c / 漏洞汇总 V3、D3）。
 *
 * 实测过的反差：`mcp_filesystem` 的允许目录是 `C:\Users\Administrator\Desktop`，列出桌面 60+ 项
 * 没问题，而工作区本身回 `not in allowed directories`。**能读你的桌面，读不到你自己的代码树。**
 *
 * 这个文件钉住三件事：
 *
 *   1. 收敛真的发生 —— 工作区外的目录被换成工作区。
 *   2. 收敛是**可见**的 —— 原始根留在 `confinedRoots` 里（悄悄改掉用户配置比不收敛更糟）。
 *   3. 不误伤 —— 工作区内的根原样保留；非文件系统型服务器（哪怕传绝对路径）一律不碰。
 *
 * `cursorMcpPaths()` 读的是 `os.homedir()` / `APPDATA`，两者都在调用时才取值，所以这里可以指到
 * 临时目录上，把"这台机器上碰巧装了什么"从断言里去掉。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverMcpServers } from '../mcp.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `she-mcp-roots-${tag}-`));
  dirs.push(d);
  return d;
};

/**
 * 起一个假 home：把 Cursor 的 `mcp.json` 写在里面，再把 `homedir()`/`APPDATA` 指过去。
 *
 * 返回一个还原函数 —— 这个测试改的是**进程级**环境变量，不还原就会污染同进程里别的一堆用例
 * （`node --test` 一个文件一个进程，但文件内是共享的）。
 */
function withFakeCursorConfig(servers: Record<string, unknown>): { workspace: string; restore: () => void } {
  const home = tempDir('home');
  const appData = join(home, 'AppData', 'Roaming');
  const cursorDir = join(appData, 'Cursor', 'User');
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');

  const workspace = tempDir('ws');
  mkdirSync(join(workspace, '.she'), { recursive: true });

  const before = { home: process.env.USERPROFILE, home2: process.env.HOME, app: process.env.APPDATA };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = appData;
  return {
    workspace,
    restore: () => {
      for (const [key, val] of [['USERPROFILE', before.home], ['HOME', before.home2], ['APPDATA', before.app]] as const) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    },
  };
}

describe('文件系统型 MCP：允许根从工作区派生', () => {
  it('工作区外的目录被收敛成工作区，且原始根被记录下来', () => {
    // portability-check:allow —— 盘符字面量是**夹具数据**，不是给某个盘写死的默认值：这条断言测的是
    // 「工作区外的根会被收敛成工作区」，所以必须给一个工作区外的绝对路径，而且两个平台各写一个才
    // 真的测得到（只写 POSIX 那个，Windows 上这条用例等于没跑）。
    const outside = process.platform === 'win32' ? 'C:\\Users\\someone\\Desktop' : '/home/someone/Desktop';
    const { workspace, restore } = withFakeCursorConfig({
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', outside],
      },
    });
    try {
      const servers = discoverMcpServers(workspace);
      const fs = servers.find((s) => s.name === 'filesystem');
      assert.ok(fs, '没发现 filesystem 服务器');

      const roots = fs.args.filter((a) => !a.startsWith('-') && a !== '@modelcontextprotocol/server-filesystem');
      assert.deepEqual(roots, [resolve(workspace)], '允许根没有被收敛到工作区');
      // 包名和 `-y` 必须原样保留：改掉它们服务器根本起不来。
      assert.ok(fs.args.includes('-y'));
      assert.ok(fs.args.includes('@modelcontextprotocol/server-filesystem'));

      // 收敛可见 —— 面板要能把"我们改过你的配置"说出来。
      assert.deepEqual(fs.confinedRoots, [outside], '原始根没有被记录下来，收敛就成了静默篡改');
    } finally {
      restore();
    }
  });

  it('工作区内的根原样保留（不把用户写对的配置"修正"成别的）', () => {
    const { workspace, restore } = withFakeCursorConfig({
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    });
    try {
      const fs = discoverMcpServers(workspace).find((s) => s.name === 'filesystem');
      // `.` 不是绝对路径，看起来不像目录 —— 这种参数不动它，服务器按自己的 cwd 解释。
      assert.ok(fs);
      assert.equal(fs.confinedRoots, undefined, '不该报告一次没发生的收敛');
    } finally {
      restore();
    }
  });

  it('同一个工作区写两遍不会重复（收敛后去重）', () => {
    // portability-check:allow —— 同上：夹具要一个工作区**内**会被重复写入的根，这里取系统目录当例子，
    // 盘符只是它在 Windows 上的写法。
    const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const { workspace, restore } = withFakeCursorConfig({
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', outside, outside],
      },
    });
    try {
      const fs = discoverMcpServers(workspace).find((s) => s.name === 'filesystem');
      assert.ok(fs);
      const ws = resolve(workspace);
      assert.equal(fs.args.filter((a) => a === ws).length, 1, `工作区根出现了多次: ${JSON.stringify(fs.args)}`);
    } finally {
      restore();
    }
  });

  it('非文件系统型服务器不碰（传绝对路径是配置意图本身）', () => {
    // portability-check:allow —— 夹具：非文件系统型服务器要指向"另一个仓库"，所以需要一个工作区外的
    // 绝对路径；它不来自任何默认值，两个平台各写一个才测得到。
    const other = process.platform === 'win32' ? 'C:\\other\\repo' : '/other/repo';
    const { workspace, restore } = withFakeCursorConfig({
      // 名字里没有 filesystem，包名也没有 —— 收敛它会毁掉"这个服务器指向那个仓库"这件事。
      somethingElse: { command: 'npx', args: ['-y', 'some-other-mcp', other] },
    });
    try {
      const s = discoverMcpServers(workspace).find((x) => x.name === 'somethingElse');
      assert.ok(s);
      assert.deepEqual(s.args, ['-y', 'some-other-mcp', other], '非文件系统服务器不应被改写');
      assert.equal(s.confinedRoots, undefined);
    } finally {
      restore();
    }
  });

  it('一个根都不剩时补上工作区（不能让服务器把 cwd 当根）', () => {
    const { workspace, restore } = withFakeCursorConfig({
      // 只有一个 `~` 根，且 home 被指到别处 —— 收敛后参数表里一个目录都不剩。
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~'] },
    });
    try {
      const fs = discoverMcpServers(workspace).find((s) => s.name === 'filesystem');
      assert.ok(fs);
      const roots = fs.args.filter((a) => !a.startsWith('-') && a !== '@modelcontextprotocol/server-filesystem');
      assert.deepEqual(roots, [resolve(workspace)], `没有补上工作区: ${JSON.stringify(fs.args)}`);
    } finally {
      restore();
    }
  });
});
