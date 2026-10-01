'use strict';

/*
 * Unit tests for the per-workspace backend pool.
 *
 * These run as plain Node with the child process injected, because the property that matters is not
 * "does spawn work" — it is "does the pool ever start a second server for one workspace", and that
 * is exactly what a real spawn would make slow and flaky to assert.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BackendPool, workspaceKey } = require('../backend-pool.cjs');

/*
 * Built with `path.join` from a relative name rather than a literal drive path: the portability
 * check rejects hardcoded `C:\` / `/home/...` style roots in tests, and a fixture directory is all
 * these need to be.
 */
const A = path.resolve(path.join('fixtures', 'project-a'));
const B = path.resolve(path.join('fixtures', 'project-b'));

/** A pool with the child process faked out, plus the records the assertions read. */
function makePool(overrides = {}) {
  const spawned = [];
  const killed = [];
  /*
   * Deterministic stand-in for the OS allocator. The real one binds port 0 and reads back what it
   * got; a test cannot assert on a number it does not choose, so the allocator is injected and hands
   * out 6100, 6101, … in order.
   */
  let nextPort = 6100;
  const pool = new BackendPool({
    log: () => {},
    allocatePort: async () => (nextPort += 1) - 1,
    waitHealthy: async () => true,
    spawnChild: (root, port) => {
      const child = {
        root,
        port,
        kill: () => { killed.push(port); },
      };
      spawned.push({ root, port, child });
      return child;
    },
    ...overrides,
  });
  return { pool, spawned, killed };
}

test('workspaceKey：Windows 下把大小写归一', () => {
  const upper = workspaceKey(A.toUpperCase());
  const lower = workspaceKey(A.toLowerCase());
  if (process.platform === 'win32') {
    // 同一个目录的两种写法必须落到同一个后端，否则会开出两个进程抢同一份 sessions.json。
    assert.equal(upper, lower);
  } else {
    // POSIX 大小写敏感，两个字符串本来就是两个目录，不该被当成同一个。
    assert.notEqual(upper, lower);
  }
});

test('已注册的后端会被复用，不会再起一个进程', async () => {
  const { pool, spawned } = makePool();
  pool.register(A, 'http://127.0.0.1:5777');

  const entry = await pool.ensure(A);

  assert.equal(entry.origin, 'http://127.0.0.1:5777');
  assert.equal(entry.spawned, false);
  assert.equal(spawned.length, 0);
  // 它属于启动器，不属于这个池，所以不该被池停掉。
  pool.stopAll();
});

test('新工作区只起一个后端，重复询问复用同一个', async () => {
  const { pool, spawned } = makePool();

  const first = await pool.ensure(A);
  const again = await pool.ensure(A);

  assert.equal(spawned.length, 1);
  assert.equal(again, first);
  assert.equal(first.origin, `http://127.0.0.1:${first.port}`);
  assert.equal(first.spawned, true);
});

test('并发进入同一工作区只起一个后端', async () => {
  const { pool, spawned } = makePool();

  const [x, y] = await Promise.all([pool.ensure(A), pool.ensure(A)]);

  // 没有 pending 去重的话，这里会是 2 —— 也就是两个进程写同一份会话文件。
  assert.equal(spawned.length, 1);
  assert.equal(x, y);
});

test('不同工作区拿到不同端口与不同 origin', async () => {
  const { pool, spawned } = makePool();

  const a = await pool.ensure(A);
  const b = await pool.ensure(B);

  assert.notEqual(a.origin, b.origin);
  assert.notEqual(a.port, b.port);
  assert.equal(spawned.length, 2);
  // 这正是"窗口 A 切工作区会污染窗口 B"被修掉的地方：两个进程，两份全局状态。
  assert.deepEqual(pool.list().map((e) => e.port).sort(), [a.port, b.port].sort());
});

test('端口按系统分配，不再扫描固定区间', async () => {
  /*
   * 上一版是 `portStart: 5700` + `portSpan: 40`，而实测这台机器上 5700–5739 **一个都绑不上**
   * （Windows 保留了 5641–5740），于是每次换工作区都失败。这个用例钉住"分配交给系统"这件事：
   * 只要构造时不再传 portStart/portSpan，且没提供 allocatePort 时会走系统分配。
   */
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'backend-pool.cjs'), 'utf8',
  );
  assert.match(src, /port: 0/, '默认分配必须绑 0 号端口让系统给一个');
  assert.doesNotMatch(src, /portStart/, '不该再有固定区间的概念');
});

test('已登记占用的端口会被跳过，不会分给别的工作区', async () => {
  // 系统每次都从 6100 开始给。6100 已经属于启动器那个后端，所以必须跳到下一个。
  let next = 6100;
  const { pool, spawned } = makePool({ allocatePort: async () => next++ });
  pool.register(A, 'http://127.0.0.1:6100');

  const b = await pool.ensure(B);

  assert.equal(b.port, 6101);
  assert.equal(spawned.length, 1);
});

test('stopAll 只停自己起的进程，不动启动器那个', async () => {
  const { pool, killed } = makePool();
  pool.register(A, 'http://127.0.0.1:5777');
  const b = await pool.ensure(B);

  pool.stopAll();

  assert.deepEqual(killed, [b.port]);
});

test('启动超时：抛错但保留条目，避免下一个窗口再起一个进程', async () => {
  const { pool, spawned } = makePool({ waitHealthy: async () => false });

  await assert.rejects(() => pool.ensure(A), /后端启动超时/);

  // 进程还在（可能只是慢），所以这个工作区仍然算"已占用"。
  assert.equal(spawned.length, 1);
  assert.ok(pool.find(A));

  // 再问一次必须复用，而不是再开一个。
  const entry = await pool.ensure(A);
  assert.equal(spawned.length, 1);
  assert.equal(entry.port, 6100);
});

test('分配不到端口：报错，且失败不会被缓存住', async () => {
  let broken = true;
  const { pool, spawned } = makePool({
    allocatePort: async () => {
      if (broken) throw new Error('系统没有分配可用端口');
      return 6200;
    },
  });

  await assert.rejects(() => pool.ensure(A), /没有分配可用端口/);
  assert.equal(spawned.length, 0);

  // 恢复之后再问，必须真的重试 —— 而不是拿到上面那个已经失败的 promise。
  broken = false;
  const entry = await pool.ensure(A);
  assert.equal(entry.port, 6200);
  assert.equal(spawned.length, 1);
});

test('子进程没起来就退出：换端口重试，不留下死条目', async () => {
  /*
   * 这是"端口由系统分配"带来的代价：探针绑完就关，子进程再去绑之前，端口可能已经被别人拿走。
   * 上一版没有这条重试路径，会把一个已经死掉的条目挂在工作区上，之后每个窗口都继承一个死后端 ——
   * 比一开始就报错更难查。
   */
  let next = 6300;
  // 6300 上的进程立刻退出；6301 上的一切正常。
  const deadPort = 6300;
  const { pool, spawned } = makePool({
    allocatePort: async () => next++,
    isAlive: (child) => child.port !== deadPort,
    waitHealthy: async (origin) => !origin.endsWith(`:${deadPort}`),
  });

  const entry = await pool.ensure(A);

  assert.equal(spawned.length, 2, '应该换端口重试一次');
  assert.equal(entry.port, 6301);
  assert.equal(pool.find(A).port, 6301, '条目必须指向活着的那个，而不是第一次那个死掉的');
});
