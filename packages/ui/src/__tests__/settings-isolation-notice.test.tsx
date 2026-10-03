/**
 * 设置页「沙箱与权限」里那一格：真隔离到底在不在，命令是在隔离里跑还是在你这台电脑上跑。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么这值得一个渲染测试，而不是只断言接口字段
 *
 * 服务端从第五轮起就把这一格算好放进 `/api/settings` 了（`isolation.bypassed` / `isolation.notice`），
 * 启动日志里也有一句 —— 而界面上**一个字都没有**：没有任何组件读过那个字段。于是"接口里有"与
 * "用户看得见"之间差着整整一层，而这一层正是所有"界面看不见"类缺陷的所在地。
 *
 * 这里钉三件事：
 *
 *   1. 服务端给的提示真的渲染出来（不是只躺在响应体里）；
 *   2. **没有提示时一个字都不出现** —— 一条常驻的"一切正常"会把真正的警告贬值（同
 *      `StateRecoveryNotice` 的判据）；
 *   3. 「所有」档那句"现在的实际规则"自己就写明了命令直接在主机上运行，即使用户不看上面那条提示，
 *      这一档的含义也不会被误读成"只是不弹确认框"。
 *
 * `fetchJSON` 被 mock 而不是起服务：这里是**视图**的性质（服务端字段由 `check:shell` 的接线断言与
 * `check:sandbox-isolation` 的 4b 节盯着）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchJSON = vi.fn();
vi.mock('../lib/api', () => ({
  fetchJSON: (...args: unknown[]) => fetchJSON(...args),
  putSettings: vi.fn(),
}));

const { Settings } = await import('../components/Settings');

/** POSIX root on purpose: the panel prints it verbatim and does no path handling. */
const NOTICE = '「允许工作区外命令」选了「所有」：命令直接在主机上运行，真隔离这一档不再生效';
/*
 * 断言用的片段必须**只出现在提示里**。用「直接在主机上运行」会被档位说明撞上：三个档位的说明永远
 * 都渲染（那是"选它会怎样"的文档，与当前选中项无关，见 `policyList`），而「所有」那一句里就写着
 * "命令直接在主机上运行（真隔离让开）"。第一次写这条断言时正是这么假通过的 —— 负向断言尤其容易。
 */
const NOTICE_ONLY = /真隔离这一档不再生效/;

const payload = (over: {
  notice?: string | null;
  policy?: 'all' | 'readonly' | 'deny';
  outsideAllow?: boolean;
} = {}) => ({
  llm: { provider: 'openai', model: 'm', baseUrl: 'http://127.0.0.1:1', hasKey: true, maxTokens: 4096, temperature: 0.2 },
  workspace: { root: '/srv/projects/demo' },
  kb: { dbPath: '/srv/projects/demo/.she/kb.sqlite' },
  skills: { profile: 'dev' },
  automationMode: false,
  sandbox: {
    allowAllCommands: over.policy === 'all',
    denyDestructiveByDefault: over.policy !== 'all',
    outsideWorkspace: { allow: over.outsideAllow ?? true, policy: over.policy ?? 'readonly' },
    notice: null,
  },
  isolation: {
    mode: 'auto',
    available: true,
    bypassed: over.notice != null,
    notice: over.notice ?? null,
  },
});

function show(over: Parameters<typeof payload>[0] = {}) {
  fetchJSON.mockResolvedValue(payload(over));
  return render(
    <Settings
      onClose={vi.fn()}
      theme="dark"
      onToggleTheme={vi.fn()}
      locale="zh"
      onLocale={vi.fn()}
      focusSection="sandbox"
    />,
  );
}

describe('设置页 · 沙箱与权限', () => {
  beforeEach(() => {
    fetchJSON.mockReset();
  });

  it('【关键】服务端说"隔离被这一档让开了"，界面上就真的看得见这句话', async () => {
    show({ notice: NOTICE, policy: 'all' });
    expect(await screen.findByText(NOTICE_ONLY)).toBeTruthy();
  });

  it('没有提示时一个字都不出现（常驻的"一切正常"会让真正的警告贬值）', async () => {
    show({ notice: null, policy: 'readonly' });
    // 等这一节渲染出来（勾选框是它的固定内容），再断言那句提示不存在。
    await screen.findByText('允许工作区外命令');
    await waitFor(() => expect(screen.queryByText(NOTICE_ONLY)).toBeNull());
  });

  it('【关键】「所有」档的"现在的实际规则"自己写明直接在主机上运行（不看提示也不会误读）', async () => {
    show({ notice: null, policy: 'all' });
    expect(
      await screen.findByText('一切命令直接放行、不再询问，且直接在主机上运行（不在真隔离里，也不是 WSL）'),
    ).toBeTruthy();
  });

  it('「只读」档的"现在的实际规则"不提主机直连（那一档的边界还在）', async () => {
    show({ notice: null, policy: 'readonly' });
    await screen.findByText('允许工作区外命令');
    expect(screen.queryByText(NOTICE_ONLY)).toBeNull();
    expect(screen.getByText('工作区内自由执行；工作区外的写操作需要你点确认')).toBeTruthy();
  });
});
