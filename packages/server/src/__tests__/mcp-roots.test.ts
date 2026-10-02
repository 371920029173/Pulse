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
import { discoverMcpServers, mcpSpawnSpec } from '../mcp.js';

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

/**
 * MCP 子进程的 cwd（评测报告 9b）。
 *
 * 实测：`C:\Users\Administrator\.playwright-mcp` 里 340 项 —— 截图与 console 日志，全是智能体用
 * playwright 通道做界面验证时留下的，而工作区在 `D:\AGI\she-agent-cloud`。根因不是 playwright，
 * 是 `spawn` 没给 cwd：playwright MCP 按 `join(cwd, '.playwright-mcp')` 算产物目录（`playwright-core`
 * 的 `outputDir()`，cwd 不可写时才退到系统临时目录），而 cwd 继承自 SHE 的启动方式。
 *
 * 这里钉住：cwd 恒为工作区；cwd 派生产物的服务器要回显产物去哪了；换 cwd 不会把相对命令弄坏。
 */
describe('MCP 进程的 cwd：产物与相对路径都留在工作区', () => {
  it('每个发现的服务器都以工作区为 cwd', () => {
    const { workspace, restore } = withFakeCursorConfig({
      anything: { command: 'node', args: ['server.js'] },
    });
    try {
      const servers = discoverMcpServers(workspace);
      assert.ok(servers.length > 0);
      for (const s of servers) {
        assert.equal(s.cwd, resolve(workspace), `${s.name} 的 cwd 不是工作区：${s.cwd}`);
      }
    } finally {
      restore();
    }
  });

  it('playwright 一族的服务器回显产物目录已落在工作区内', () => {
    const { workspace, restore } = withFakeCursorConfig({
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    try {
      const pw = discoverMcpServers(workspace).find((s) => s.name === 'playwright');
      assert.ok(pw);
      assert.equal(pw.confinedOutputDir, join(resolve(workspace), '.playwright-mcp'),
        '产物目录没有被回显 —— 那 340 项是怎么来的就没人说得清了');
    } finally {
      restore();
    }
  });

  it('别的服务器不套 playwright 的产物目录说法', () => {
    const { workspace, restore } = withFakeCursorConfig({
      memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    });
    try {
      const mem = discoverMcpServers(workspace).find((s) => s.name === 'memory');
      assert.ok(mem);
      assert.equal(mem.confinedOutputDir, undefined, '不该给不按 cwd 产出物件的服务器编一个产物目录');
    } finally {
      restore();
    }
  });

  it('相对命令被钉成工作区里的绝对路径（换 cwd 不会让原本能起的服务器起不来）', () => {
    const { workspace, restore } = withFakeCursorConfig({});
    try {
      // SHE 自己的文件：这里才能既写相对命令又控制工作区目录。
      mkdirSync(join(workspace, 'tools'), { recursive: true });
      const script = join(workspace, 'tools', 'my-mcp.js');
      writeFileSync(script, '// not run by this test\n', 'utf8');
      writeFileSync(join(workspace, '.she', 'mcp.json'), JSON.stringify({
        mcpServers: { local: { command: './tools/my-mcp.js', args: [] } },
      }), 'utf8');

      const s = discoverMcpServers(workspace).find((x) => x.name === 'local');
      assert.ok(s);
      assert.equal(s.command, script, `相对命令没被钉成绝对路径: ${s.command}`);

      // 裸名字留给 PATH —— 钉成路径反而会让 `node`/`npx` 起不来。
      writeFileSync(join(workspace, '.she', 'mcp.json'), JSON.stringify({
        mcpServers: { bare: { command: 'npx', args: ['-y', 'some-mcp'] } },
      }), 'utf8');
      const bare = discoverMcpServers(workspace).find((x) => x.name === 'bare');
      assert.ok(bare);
      assert.equal(bare.command, 'npx');
    } finally {
      restore();
    }
  });

  it('Windows 上过 shell 时，带空格的命令与参数自己补引号（cmd.exe 不替我们做）', () => {
    const win = process.platform === 'win32';
    // 用拼出来的路径，避免在源码里写盘符字面量（那会被 portability 门禁拦下）。
    const spaced = join(tmpdir(), 'Program Files', 'my mcp', 'server.js');
    const spec = mcpSpawnSpec({
      name: 'spaced', command: spaced, args: ['-y', spaced, '--already', '"quoted"'], source: 'she', cwd: tmpdir(),
    });

    assert.equal(spec.options.shell, win, '过不过 shell 是平台决定');
    assert.equal(spec.options.cwd, tmpdir(), 'cwd 必须带到 spawn 选项里，否则产物又跑出边界');
    if (win) {
      // 实测过：`shell: true` 时 Node 用空格把命令和参数拼成一行交给 cmd.exe，带空格的参数
      // 到了子进程手里会被拆成好几个 —— 不加引号就是"配置没错、起来就崩"。
      assert.equal(spec.command, `"${spaced}"`);
      assert.equal(spec.args[1], `"${spaced}"`);
      assert.equal(spec.args[0], '-y', '没有空白的参数不该被动');
      assert.equal(spec.args[3], '"quoted"', '已经带引号的参数保留原样，不猜用户的引号意图');
    } else {
      assert.equal(spec.command, spaced, 'POSIX 不过 shell，参数原样传');
    }
  });

  it('工作区内大小写不同的根算同一个目录（不报一次没发生的收敛）', () => {
    const { workspace, restore } = withFakeCursorConfig({});
    try {
      const ws = resolve(workspace);
      // Windows 上大小写不同是同一个目录，POSIX 上不是 —— 断言按平台分支。
      const sameDir = process.platform === 'win32' ? ws.toUpperCase() : ws;
      writeFileSync(join(workspace, '.she', 'mcp.json'), JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', sameDir] },
        },
      }), 'utf8');

      const fs = discoverMcpServers(workspace).find((s) => s.name === 'filesystem');
      assert.ok(fs);
      assert.equal(fs.confinedRoots, undefined, '把工作区内的根判成区外，会报出一次没发生的收敛');
      assert.ok(fs.args.includes(sameDir), '工作区内的根应当原样保留');
    } finally {
      restore();
    }
  });
});
