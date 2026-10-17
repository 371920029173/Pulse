/*
 * 回退安全壳的判据。
 *
 * 这一组测试存在的唯一理由：**回退是唯一会丢数据的操作**。所以每条断言都对应一种
 * "会毁掉用户工作"的具体情形：
 *   ① 脏文件被静默覆盖  → 必须有 blocker 且执行被拒
 *   ② 没票就动手        → 必须抛错，且文件没变
 *   ③ 票和计划对不上    → 必须抛错（计划在出票后被改过）
 *   ④ 没拍快照就动手    → 快照必须存在且内容等于原文件
 *   ⑤ 回退一个文件顺手改了别的 → 另一个脏文件必须原样
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRevert, createTicket, executeRevert } from '../index.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-rev-'));
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'r@t']);
  run(['config', 'user.name', 'r']);
  /*
   * 关掉 autocrlf：否则 Windows 上 checkout 出来的是 CRLF，
   * "回退后的字节与目标 rev 一致"这条判据永远红 —— 红的是测试环境，不是代码。
   */
  run(['config', 'core.autocrlf', 'false']);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  run(['add', '-A']);
  run(['commit', '-qm', 'base']);
  return dir;
}

test('计划：干净文件可回退，条目带 +/- 行数与目标 rev 是否存在', () => {
  const dir = repo({ 'src/a.ts': 'line1\nline2\n' });
  try {
    const rev = execFileSync('git', ['rev-parse', 'HEAD~0'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'src/a.ts'), 'line1\nline2\nline3\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'second'], { cwd: dir });

    const plan = planRevert(dir, { rev, paths: ['src/a.ts'] });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0]!.dirty, false, '已提交的改动不算脏');
    assert.equal(plan.entries[0]!.existsInRev, true);
    assert.equal(plan.entries[0]!.added, 1, '相对目标 rev 多了一行');
    assert.equal(plan.blockers.length, 0);
    assert.match(plan.planHash, /^[0-9a-f]{16}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('脏文件：进 blockers，出票被拒（不许拿用户的未提交改动去覆盖）', () => {
  const dir = repo({ 'src/a.ts': 'v1\n' });
  try {
    const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'src/a.ts'), 'v1\n未提交的改动\n');
    const plan = planRevert(dir, { rev, paths: ['src/a.ts'] });
    assert.equal(plan.entries[0]!.dirty, true);
    assert.ok(plan.blockers.length > 0, '脏文件必须有 blocker');
    assert.throws(() => createTicket(dir, plan), /阻断/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有票据不许动手，文件原样', () => {
  const dir = repo({ 'src/a.ts': 'v1\n' });
  try {
    const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const plan = planRevert(dir, { rev, paths: ['src/a.ts'] });
    assert.throws(() => executeRevert(dir, plan, 'deadbeef'), /票据/);
    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'v1\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('正常回退：出票 → 快照 → 执行，内容回到目标 rev，且快照里留着回退前的原文', () => {
  const dir = repo({ 'src/a.ts': 'v1\n' });
  try {
    const rev1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'src/a.ts'), 'v2 新增\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'v2'], { cwd: dir });
    const before = readFileSync(join(dir, 'src/a.ts'), 'utf8');

    const plan = planRevert(dir, { rev: rev1, paths: ['src/a.ts'] });
    const token = createTicket(dir, plan);
    const res = executeRevert(dir, plan, token);

    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'v1\n', '内容必须回到目标 rev');
    assert.deepEqual(res.restored, ['src/a.ts']);
    assert.ok(res.snapshotId, '必须留下快照 id');

    const snapDir = join(dir, '.she', 'map', 'snapshots', res.snapshotId);
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest[0].path, 'src/a.ts');
    assert.equal(readFileSync(join(snapDir, 'src__a.ts'), 'utf8'), before, '快照里是回退前的原文');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('票据一次一票；计划被改过则拒绝（哈希对不上）', () => {
  const dir = repo({ 'src/a.ts': 'v1\n' });
  try {
    const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const plan = planRevert(dir, { rev, paths: ['src/a.ts'] });
    const token = createTicket(dir, plan);
    executeRevert(dir, plan, token);
    assert.throws(() => executeRevert(dir, plan, token), /用过/);

    const plan2 = planRevert(dir, { rev, paths: ['src/a.ts'] });
    const token2 = createTicket(dir, plan2);
    const tampered = { ...plan2, rev: 'HEAD' };
    assert.throws(() => executeRevert(dir, tampered, token2), /不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回退一个文件不碰别的：另一个脏文件必须原样', () => {
  const dir = repo({ 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n' });
  try {
    const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'src/a.ts'), 'a2\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'a2'], { cwd: dir });
    writeFileSync(join(dir, 'src/b.ts'), 'b1\n用户正在改的东西\n');

    const plan = planRevert(dir, { rev, paths: ['src/a.ts'] });
    const token = createTicket(dir, plan);
    executeRevert(dir, plan, token);

    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'a1\n');
    assert.equal(readFileSync(join(dir, 'src/b.ts'), 'utf8'), 'b1\n用户正在改的东西\n', '别的脏文件一个字节都不许动');
    const snaps = readdirSync(join(dir, '.she', 'map', 'snapshots'));
    assert.equal(snaps.length, 1, '快照只存本次涉及的路径');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('目标 rev 里没有这个文件 → 阻断（回退等于删除，必须显式确认）', () => {
  const dir = repo({ 'keep.txt': 'k\n' });
  try {
    const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'fresh.txt'), 'new\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'add fresh'], { cwd: dir });
    const plan = planRevert(dir, { rev, paths: ['fresh.txt'] });
    assert.equal(plan.entries[0]!.existsInRev, false);
    assert.ok(plan.blockers.some((b) => b.includes('删除')));
    assert.equal(existsSync(join(dir, '.she', 'map', 'snapshots')), false, '拒绝时不产生快照');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
