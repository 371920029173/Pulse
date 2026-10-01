/**
 * 状态文件被隔离时的横幅。
 *
 * 为什么值得单独测：这些提示原先**只写进日志**，而用户看到的界面只是少了几条会话 —— 和
 * 「应用把聊天记录删了」完全无法区分。所以这里钉的不是文案，是三件必须成立的事：
 *
 *   1. 它真的渲染出来（不是只留在日志里）；
 *   2. 它给出备份文件的**完整路径** —— 只说「已恢复」而不说文件在哪，用户依然无从下手；
 *   3. 「知道了」能关掉它，而不是每轮轮询都重新弹一遍。
 *
 * 反过来说，没有待报告的内容时它必须是空的：一条常驻的「一切正常」横幅会让真正的警告贬值。
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StateRecoveryNotice } from '../components/StateRecoveryNotice';
import type { StateRecovery } from '../components/StateRecoveryNotice';

const BACKUP = 'D:/AGI/demo/.she/sessions.json.unusable-2026-09-29T13-47-33-123Z';

const recovery = (over: Partial<StateRecovery> = {}): StateRecovery => ({
  kind: 'sessions',
  root: 'D:/AGI/demo',
  backup: BACKUP,
  reason: '文件不是合法 JSON: Unexpected end of JSON input',
  ...over,
});

describe('StateRecoveryNotice', () => {
  it('【关键】会话文件被隔离时，界面上真的出现提示', () => {
    render(<StateRecoveryNotice recoveries={[recovery()]} onDismiss={vi.fn()} />);
    // The whole point: a quarantine must not be visible only in the log.
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('【关键】给出备份文件的完整路径，用户才能自己改回来', () => {
    render(<StateRecoveryNotice recoveries={[recovery()]} onDismiss={vi.fn()} />);
    expect(screen.getByText(new RegExp(BACKUP.replace(/[/.]/g, '\\$&')))).toBeTruthy();
  });

  it('带上原因，用户能判断是不是自己手改坏的', () => {
    render(<StateRecoveryNotice recoveries={[recovery()]} onDismiss={vi.fn()} />);
    expect(screen.getByText(/不是合法 JSON/)).toBeTruthy();
  });

  it('明说是哪一类文件：会话和讨论组分开讲', () => {
    const { container } = render(
      <StateRecoveryNotice
        recoveries={[
          recovery(),
          recovery({ kind: 'cluster', backup: 'D:/AGI/demo/.she/cluster/rooms.json.unusable-1', reason: '内容不是一个对象' }),
        ]}
        onDismiss={vi.fn()}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/会话记录/);
    expect(text).toMatch(/讨论组记录/);
  });

  it('多份备份都列出来，不是只报第一条', () => {
    const { container } = render(
      <StateRecoveryNotice
        recoveries={[
          recovery(),
          recovery({ backup: 'D:/AGI/demo/.she/sessions.json.unusable-2' }),
        ]}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.textContent ?? '').toMatch(/unusable-2/);
  });

  it('点「知道了」会请求关闭（不是关不掉）', () => {
    const onDismiss = vi.fn();
    render(<StateRecoveryNotice recoveries={[recovery()]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /知道了/ }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('没有待报告的内容时什么都不渲染（常驻提示会贬值）', () => {
    const { container } = render(<StateRecoveryNotice recoveries={[]} onDismiss={vi.fn()} />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
