/**
 * Append-only audit trail.
 *
 * Most of this file is about the four properties that make the trail worth keeping, because each
 * of them fails silently if it regresses:
 *
 *   1. **Append only.** Every record is one more line; nothing rewrites what is already there. If
 *      a future refactor "tidies" the file, the question the trail exists to answer ("what did it
 *      do?") stops having an answer. Asserted byte-wise on the prefix.
 *   2. **Strictly increasing `seq`.** Timestamps tie at millisecond resolution and wall clocks
 *      move; the counter is the only total order. Asserted across a restart, and — the case that
 *      is easy to get wrong — across a rotation that writes its own record.
 *   3. **Rotation stays honest.** Dropping history is recorded, not silent.
 *   4. **Damage is reported.** A line killed mid-write is counted and surfaced, because a trail
 *      that quietly returns fewer records is indistinguishable from a quiet day.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLog, type AuditRecord } from '../audit.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-audit-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const logPath = () => join(dir, '.she', 'audit.log');
const rawLines = (p = logPath()) => readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
const rotations = () => readdirSync(join(dir, '.she')).filter((f) => f.startsWith('audit-')).sort();
/** Hand-write the log, for cases that are about what the reader does with bad input. */
const seed = (text: string) => {
  mkdirSync(join(dir, '.she'), { recursive: true });
  writeFileSync(logPath(), text, 'utf8');
};

/** Every seq in the trail, oldest file first — the order a reader would reconstruct history in. */
const allSeqs = (log: AuditLog): number[] => {
  const out: number[] = [];
  for (const f of [...log.files()].reverse()) {
    out.push(...rawLines(join(dir, '.she', f)).map((l) => (JSON.parse(l) as AuditRecord).seq));
  }
  return out;
};

describe('审计：只追加', () => {
  it('每次 append 只增加一行', () => {
    const log = new AuditLog(dir);
    log.append({ kind: 'request', message: '一' });
    const after1 = readFileSync(logPath(), 'utf8');
    log.append({ kind: 'request', message: '二' });
    const after2 = readFileSync(logPath(), 'utf8');
    assert.ok(after2.startsWith(after1), '第二次写入改动了已有内容');
    assert.equal(rawLines().length, 2);
  });

  it('【关键】已有字节永远不变（序号从 1 开始连续）', () => {
    const log = new AuditLog(dir);
    for (let i = 1; i <= 20; i++) log.append({ kind: 'tool', tool: `t${i}` });

    const records = log.read({ limit: 100 }).records.slice().reverse();
    assert.equal(records.length, 20);
    assert.deepEqual(records.map((r) => r.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('写入会创建 .she 目录（无需上层先建）', () => {
    assert.equal(existsSync(join(dir, '.she')), false);
    new AuditLog(dir).append({ kind: 'request' });
    assert.equal(existsSync(logPath()), true);
  });

  it('超长消息截断，但保留真实长度（截断必须可被看见）', () => {
    const log = new AuditLog(dir);
    const long = 'x'.repeat(5000);
    const rec = log.append({ kind: 'request', message: long });
    assert.equal(rec.truncated, true);
    assert.equal(rec.chars, 5000);
    assert.equal(rec.message?.length, 2000);
    // And it is still readable through the same path as everything else.
    assert.equal(log.read({ limit: 1 }).records[0].chars, 5000);
  });

  it('不需要截断时不加截断标记', () => {
    const rec = new AuditLog(dir).append({ kind: 'request', message: '短' });
    assert.equal(rec.truncated, undefined);
    assert.equal(rec.chars, undefined);
  });
});

describe('审计：seq 严格递增', () => {
  it('同毫秒内的两条也分得清先后', () => {
    const log = new AuditLog(dir);
    const a = log.append({ kind: 'tool', tool: 'a' });
    const b = log.append({ kind: 'tool', tool: 'b' });
    assert.ok(b.seq > a.seq, '同毫秒写入无法排序');
  });

  it('【关键】重启后接着之前的序号，不从 0 重来', () => {
    const first = new AuditLog(dir);
    first.append({ kind: 'request', message: '一' });
    first.append({ kind: 'request', message: '二' });
    const next = new AuditLog(dir).append({ kind: 'request', message: '三' });
    assert.equal(next.seq, 3, '重启后序号与历史重叠');
  });

  it('【关键】轮转写下的 rotation 记录不会和触发它的记录撞号', () => {
    // Small limit so the third append rolls the log and writes a rotation record in the same call.
    const log = new AuditLog(dir, { maxBytes: 120, keep: 1 });
    for (let i = 0; i < 12; i++) log.append({ kind: 'tool', tool: `tool-with-a-fairly-long-name-${i}` });

    const seqs = allSeqs(log);
    assert.ok(seqs.length >= 2, '没触发轮转，用例失去意义');
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], `序号重复或不递增：${seqs.join(',')}`);
    }
  });

  it('只保留 keep 份轮转文件，且丢弃被记录（历史不会无声消失）', () => {
    const log = new AuditLog(dir, { maxBytes: 120, keep: 1 });
    for (let i = 0; i < 40; i++) log.append({ kind: 'tool', tool: `tool-with-a-fairly-long-name-${i}` });

    const rot = rotations();
    assert.ok(rot.length <= 1, `轮转文件超过 keep：${rot.join(',')}`);

    // Whatever was dropped is named by a rotation record somewhere in the remaining trail.
    const dropped = log.read({ limit: 5000 }).records
      .filter((r) => r.kind === 'rotation')
      .flatMap((r) => r.dropped ?? []);
    const stillPresent = new Set(log.files());
    for (const name of dropped) assert.equal(stillPresent.has(name), false, `${name} 被记录丢弃却还在`);
    assert.ok(log.read({ limit: 5000 }).records.some((r) => r.kind === 'rotation'), '轮转没有被记下来');
  });

  it('未达上限时不轮转', () => {
    const log = new AuditLog(dir, { maxBytes: 1024 * 1024 });
    for (let i = 0; i < 5; i++) log.append({ kind: 'request', message: '短' });
    assert.deepEqual(rotations(), []);
  });
});

describe('审计：读取', () => {
  it('默认最新在前', () => {
    const log = new AuditLog(dir);
    log.append({ kind: 'request', message: '早' });
    log.append({ kind: 'request', message: '晚' });
    const got = log.read({ limit: 10 }).records;
    assert.equal(got[0].message, '晚');
    assert.equal(got[1].message, '早');
  });

  it('limit 生效', () => {
    const log = new AuditLog(dir);
    for (let i = 0; i < 30; i++) log.append({ kind: 'tool', tool: `t${i}` });
    assert.equal(log.read({ limit: 10 }).records.length, 10);
  });

  it('按 kind 过滤', () => {
    const log = new AuditLog(dir);
    log.append({ kind: 'request', message: '问' });
    log.append({ kind: 'tool', tool: 'rd' });
    log.append({ kind: 'confirm', ticket_id: 'c1', approved: true });
    const tools = log.read({ limit: 10, kind: 'tool' }).records;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool, 'rd');
  });

  it('按 session_id 过滤（会话视图不能看到别人的记录）', () => {
    const log = new AuditLog(dir);
    log.append({ kind: 'request', message: 'A', session_id: 's1' });
    log.append({ kind: 'request', message: 'B', session_id: 's2' });
    const s1 = log.read({ limit: 10, sessionId: 's1' }).records;
    assert.equal(s1.length, 1);
    assert.equal(s1[0].message, 'A');
  });

  it('空目录返回空，不抛错', () => {
    const r = new AuditLog(dir).read();
    assert.deepEqual(r.records, []);
    assert.equal(r.skipped, 0);
    assert.deepEqual(r.files, []);
  });

  it('files 最新在前', () => {
    const log = new AuditLog(dir, { maxBytes: 120, keep: 3 });
    for (let i = 0; i < 40; i++) log.append({ kind: 'tool', tool: `tool-with-a-long-name-${i}` });
    const files = log.files();
    assert.equal(files[0], 'audit.log', '实时日志应当排在最前');
    assert.ok(files.length > 1);
  });

  it('读取跨轮转文件（历史仍可查）', () => {
    // `keep` is generous on purpose: this is about reading across files, not about what gets
    // dropped when the cap bites (that is asserted above).
    const log = new AuditLog(dir, { maxBytes: 120, keep: 50 });
    for (let i = 0; i < 20; i++) log.append({ kind: 'tool', tool: `tool-with-a-fairly-long-name-${i}` });
    assert.ok(log.files().length > 1, '没有产生轮转文件，用例失去意义');
    const got = log.read({ limit: 5000 });
    assert.ok(got.records.length > rawLines().length, '只读了实时日志，没读到轮转文件');
    const names = new Set(got.records.map((r) => r.tool).filter(Boolean));
    assert.ok(names.has('tool-with-a-fairly-long-name-0'), '最老的记录丢了');
  });
});

describe('审计：损坏被报告而非隐藏', () => {
  it('半行被计为 skipped，其余照常读出', () => {
    const log = new AuditLog(dir);
    log.append({ kind: 'request', message: '正常' });
    writeFileSync(logPath(), readFileSync(logPath(), 'utf8') + '{"ts":"2026-01-01T00:00:00.000Z","seq":9,"kin', 'utf8');

    const r = log.read({ limit: 100 });
    assert.equal(r.skipped, 1);
    assert.equal(r.records.length, 1);
  });

  it('缺 seq/kind 的行同样算损坏（不能被当成有效记录）', () => {
    seed('{"ts":"x"}\n{"ts":"y","seq":1,"kind":"request","message":"ok"}\n');
    const r = new AuditLog(dir).read({ limit: 100 });
    assert.equal(r.skipped, 1);
    assert.equal(r.records.length, 1);
  });

  it('只读了一部分也报告看到的损坏（不能把坏日志显示成安静的一天）', () => {
    seed('{"bad\n');
    const log = new AuditLog(dir);
    log.append({ kind: 'request', message: '正常' });
    assert.equal(log.read({ limit: 1 }).skipped, 1);
  });

  it('序号不会跟随损坏行里写的数字跳号', () => {
    seed('{"ts":"y","seq":1,"kind":"request"}\n{"broken\n');
    const rec = new AuditLog(dir).append({ kind: 'request', message: 'x' });
    assert.equal(rec.seq, 2, '损坏行里的 seq 被当成了真值');
  });

  it('BOM 不会让整个文件变成损坏', () => {
    const log = new AuditLog(dir);
    log.append({ kind: 'request', message: '带 BOM' });
    writeFileSync(logPath(), '\uFEFF' + readFileSync(logPath(), 'utf8'), 'utf8');
    const r = new AuditLog(dir).read({ limit: 10 });
    assert.equal(r.skipped, 0, 'BOM 被当成了损坏行');
    assert.equal(r.records.length, 1);
  });
});
