/**
 * 「检查状态这个玩意每次都出现」——"知道了"必须跨重启。
 *
 * 之前存在 sessionStorage：关掉窗口就忘，于是每次开应用都再看到一遍同样的横幅。
 * 现在按备份路径记在 localStorage：同一份备份不再提示，**新的**隔离仍然提示。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { addDismissed, loadDismissed } from '../lib/recoveryAck';

beforeEach(() => { localStorage.clear(); });

describe('状态提示的「知道了」', () => {
  it('没点过时是空的', () => {
    expect(loadDismissed()).toEqual([]);
  });

  it('点过之后，重新读还在（等价于关掉窗口再打开）', () => {
    addDismissed(['.she/sessions.json.unusable-1']);
    expect(loadDismissed()).toEqual(['.she/sessions.json.unusable-1']);
  });

  it('重复点不会越记越长；新出现的隔离路径照记', () => {
    addDismissed(['a']);
    addDismissed(['a', 'b']);
    expect(loadDismissed()).toEqual(['a', 'b']);
  });

  it('存的内容坏掉时不影响启动（当成没记过）', () => {
    localStorage.setItem('she.dismissedRecoveries', '{oops');
    expect(loadDismissed()).toEqual([]);
  });
});
