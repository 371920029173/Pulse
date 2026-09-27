/**
 * 会话状态目录：跨会话隔离靠的是"路径上不存在"，不是"读的时候过滤一下"。
 *
 * 这几条断言是这一层的地基，所以钉在最便宜的地方。真正端到端的验证（起真服务、两个会话互相看不见）
 * 由 `scripts/session-isolation-check.mjs` 负责。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { encodeSessionId, isSafeSessionId, sessionStateDir } from '../session-state.js';

/*
 * A root without a drive letter on purpose.
 *
 * These tests are about the SHAPE of the path (`<root>/.she/sessions/<id>`), not about Windows, and a
 * literal `D:/...` in a test suite is a real problem on the machines this ships to: it reads as "this
 * only runs here", breaks the portability gate that greps the repo for hardcoded drives, and fails
 * on macOS/Linux where there is no D:. A relative root resolves the same everywhere.
 */
const ROOT = join('tmp', 'ws');

describe('sessionStateDir', () => {
  it('落在 <工作区>/.she/sessions/<id> 下', () => {
    const dir = sessionStateDir(ROOT, 'sess_abc123');
    assert.deepEqual(dir.split(/[\\/]/).slice(-3), ['.she', 'sessions', 'sess_abc123']);
  });

  it('两个会话拿到的是两个不同目录（这是整个隔离的前提）', () => {
    assert.notEqual(sessionStateDir(ROOT, 'sess_a'), sessionStateDir(ROOT, 'sess_b'));
  });

  it('会话目录挂在工作区里面（不是工作区外的兄弟目录）', () => {
    const root = resolve(ROOT);
    const dir = resolve(sessionStateDir(ROOT, 'sess_a'));
    assert.ok(dir.startsWith(root), `${dir} 应当在工作区 ${root} 里面`);
  });

  it('【关键】非法 id 一律抛错，不给兜底桶', () => {
    // 兜底桶 = 所有会话共享的目录，而且没人会发现。宁可抛错。
    for (const bad of ['', '   ', '..', '.', '../evil', 'a/b', 'a\\b', 'x'.repeat(201), 'a\nb', '\u0000']) {
      assert.throws(() => sessionStateDir(ROOT, bad), /不合法/, `应当拒绝 ${JSON.stringify(bad)}`);
    }
  });

  it('非字符串输入也不放过（请求里塞进来的东西）', () => {
    for (const bad of [undefined, null, 42, {}, [], ['a']]) {
      assert.throws(() => sessionStateDir(ROOT, bad as never), /不合法/, `应当拒绝 ${JSON.stringify(bad)}`);
    }
  });

  it('会话 id 的形状不止一种，全都要能用', () => {
    // 聊天是 sess_<hex>，群计划是 cluster:<roomId>（见 groupPlanSession）。第一条实现只放行
    // [A-Za-z0-9_-]，群计划一构造就抛错 —— 被门禁抓住。id 也是身份，不是文件名。
    for (const ok of ['sess_584c8f2e6fe8', 'sess-A_b', 'a', 'x'.repeat(64), 'cluster:r1', 'cluster:216ba787']) {
      assert.equal(isSafeSessionId(ok), true, `应当放行 ${ok}`);
      assert.ok(sessionStateDir(ROOT, ok).length > 0);
    }
  });

  it('不会拼出工作区外的路径（逃逸样本全是拒绝）', () => {
    const root = ROOT;
    // 盘符样本必须留着：它是"绝对路径被当成 id 传进来"的最常见形状。
    // portability-check:allow —— 夹具，不是给某个盘写死的默认值
    for (const bad of ['../../etc/passwd', '..\\..\\windows', 'C:/other', 'a/../../b']) {
      assert.throws(() => sessionStateDir(root, bad), /不合法/);
    }
  });
});

describe('encodeSessionId', () => {
  it('普通 id 原样保留（磁盘上还是认得出的名字）', () => {
    assert.equal(encodeSessionId('sess_584c8f2e6fe8'), 'sess_584c8f2e6fe8');
  });

  it('【关键】冒号被编码 —— `cluster:r1` 在 Windows 上不能当目录名', () => {
    // NTFS 里 `:` 是备用数据流/盘符分隔符，mkdir('cluster:r1') 直接失败。所以不是拒绝这种 id，
    // 而是把它编码成安全的名字。
    const dir = encodeSessionId('cluster:r1');
    assert.doesNotMatch(dir, /:/);
    assert.equal(dir, 'cluster%3Ar1');
  });

  it('【关键】点号也被编码，`..` 拼不出目录名', () => {
    assert.doesNotMatch(encodeSessionId('a.b'), /[.]/);
    // 上面那些点号样本在 assertSessionId 就被拒了，这里确认编码本身不会留下可用的 `..`
    assert.equal(encodeSessionId('a..b'), 'a%2E%2Eb');
  });

  it('星号被编码（Windows 非法字符）', () => {
    assert.equal(encodeSessionId('a*b'), 'a%2Ab');
  });

  it('结果里只剩文件系统安全的字符', () => {
    for (const id of ['sess_1', 'cluster:r1', '中文会话', 'a b', "o'brien", 'x(y)']) {
      const enc = encodeSessionId(id);
      assert.doesNotMatch(enc, /[<>:"/\\|?*]/, enc);
      assert.doesNotMatch(enc, /[. ]$/, `不能以点或空格结尾: ${enc}`);
    }
  });

  it('编码可逆、且不同 id 不会撞到同一个目录（否则两个会话会共用一份状态）', () => {
    const ids = ['sess_a', 'cluster:a', 'cluster:a-1', 'a.b', 'a%2Eb', '中文', 'a', 'a-'];
    const encoded = ids.map((i) => encodeSessionId(i));
    assert.equal(new Set(encoded).size, ids.length, `编码后碰撞: ${JSON.stringify(encoded)}`);
    for (const [id, enc] of ids.map((i, n) => [i, encoded[n]] as const)) {
      assert.equal(decodeURIComponent(enc.replace(/%2E/gi, '.').replace(/%2A/gi, '*')), id, enc);
    }
  });
});
