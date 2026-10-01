/**
 * `rooms.json` 写入前的拒绝。
 *
 * 和 `assertWritableSessions` 同一件事，也是同一个理由：`normalizeClusterFile` 会静默跳过
 * 没有 id 的房间，并把不是数组的 `messages` / `members` / `roles` 换成空数组。这些"修复"
 * 放在读取侧是对的（读的是别人的文件），放在写入侧就是丢数据 —— 写下去之后文件看起来完全
 * 健康，用户的工作组连同它的讨论记录下次启动就没了，而且没有任何隔离或提示。
 *
 * 所以这里钉两条：
 *   1. 那些形状必须在写入前被拒绝；
 *   2. 拒绝时磁盘上的旧副本一字未动（这才是可恢复的结果）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClusterStore, assertWritableRooms } from '../cluster.js';
import type { ClusterFile, ClusterRoom } from '../cluster.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-cluster-store-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('assertWritableRooms：加载器会静默丢掉的形状，必须在写入前拒绝', () => {
  const room = (over: Partial<ClusterRoom> = {}): ClusterRoom => ({
    id: 'r1',
    title: '讨论组',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    roles: [],
    members: [],
    messages: [],
    status: 'idle',
    ...over,
  });
  const file = (rooms: ClusterRoom[]): ClusterFile => ({ schema_version: '2', rooms });

  it('缺 id 的房间被拒绝（加载时会连讨论记录一起丢掉）', () => {
    assert.throws(() => assertWritableRooms(file([room({ id: '' })])), /没有 id/);
  });

  it('messages / members / roles 不是数组都被拒绝', () => {
    for (const field of ['messages', 'members', 'roles'] as const) {
      assert.throws(
        () => assertWritableRooms(file([room({ [field]: 'nope' as unknown as [] })])),
        new RegExp(field),
        `${field} 不是数组时没有被拒绝`,
      );
    }
  });

  it('id 重复被拒绝', () => {
    assert.throws(() => assertWritableRooms(file([room(), room()])), /重复/);
  });

  it('正常数据通过', () => {
    assert.doesNotThrow(() => assertWritableRooms(file([])));
    assert.doesNotThrow(() => assertWritableRooms(file([room()])));
  });

  // 端到端：走真实 store，确认 persist() 真的带上了校验，而且失败不改磁盘。
  it('【关键】store 拒绝写入时，rooms.json 里的旧内容一字未动', () => {
    const store = new ClusterStore(dir);
    const good = store.create(dir, '好讨论组');
    const path = join(dir, '.she', 'cluster', 'rooms.json');
    const before = readFileSync(path, 'utf8');
    assert.match(before, new RegExp(good.id), '前提：好讨论组已经落盘');

    // A room the loader would silently skip, injected the way only a bug could produce it.
    (store as unknown as { data: ClusterFile }).data.rooms.push({ id: '' } as ClusterRoom);
    assert.throws(() => store.create(dir, '再来一个'), /拒绝写入/);

    assert.equal(readFileSync(path, 'utf8'), before, '拒绝写入却改动了 rooms.json');
    const reopened = new ClusterStore(dir);
    assert.deepEqual(reopened.list().map((r) => r.id), [good.id], '重开后好讨论组不见了');
  });
});
