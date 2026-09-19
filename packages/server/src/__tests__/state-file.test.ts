/**
 * State file loading and version migration.
 *
 * These tests exist because the previous loader had one behaviour for every kind
 * of failure — parse error, unexpected shape, unknown version — and all of them
 * ended the same way: in-memory state became empty and the next write persisted
 * that empty value, destroying the user's chat history or work groups with no copy
 * left behind.
 *
 * The single invariant everything here checks is therefore:
 *
 *   the bytes of an unusable file still exist somewhere after loading
 *
 * Everything else (which shape gets repaired, which gets quarantined) is a
 * judgement call; losing the data is not.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadStateFile, saveStateFile } from '../state-file.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-state-'));
  // The state file lives in a subdirectory, so quarantine behaviour is exercised
  // on a path that did not exist up front (as it would not on a fresh install).
  mkdirSync(join(dir, 'sub'), { recursive: true });
  file = join(dir, 'sub', 'state.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Files sitting beside the state file, i.e. quarantined copies. */
function siblings(): string[] {
  const parent = join(dir, 'sub');
  if (!existsSync(parent)) return [];
  return readdirSync(parent).filter((f) => f !== 'state.json');
}

/** Any bytes at all that still hold the original content. */
function allContentOnDisk(): string {
  const parent = join(dir, 'sub');
  if (!existsSync(parent)) return '';
  return readdirSync(parent).map((f) => readFileSync(join(parent, f), 'utf8')).join('\n');
}

interface Doc { schema_version: string; items: string[] }

const SPEC = {
  version: 'v2',
  empty: (): Doc => ({ schema_version: 'v2', items: [] }),
  parse: (raw: unknown): Doc => {
    const d = raw as Doc;
    if (!Array.isArray(d.items)) throw new Error('items 不是数组');
    return { schema_version: 'v2', items: d.items.filter((i): i is string => typeof i === 'string') };
  },
  migrations: {
    v1: (raw: Record<string, unknown>) => ({ ...raw, schema_version: 'v2' }),
  },
};

describe('读取：正常情况', () => {
  it('文件不存在时返回空值，不报错', () => {
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(r.data.items, []);
    assert.equal(r.recovered, undefined);
  });

  it('读取当前版本的文件', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 'v2', items: ['a', 'b'] }), 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(r.data.items, ['a', 'b']);
    assert.equal(r.recovered, undefined);
  });

  it('读取时不做多余改动，也不产生备份', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 'v2', items: ['a'] }), 'utf8');
    loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(siblings(), []);
  });

  it('空文件视为"还没有状态"，不隔离', () => {
    // A crash mid-write can leave a zero-byte file; that is not corruption worth
    // alarming the user about.
    writeFileSync(file, '', 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(r.data.items, []);
    assert.equal(r.recovered, undefined);
    assert.deepEqual(siblings(), []);
  });

  it('只有空白的文件同样不隔离', () => {
    writeFileSync(file, '   \n\t\n', 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.equal(r.recovered, undefined);
  });
});

describe('读取：损坏的文件必须留底，绝不静默丢弃', () => {
  const CORRUPTIONS: Array<[string, string]> = [
    ['截断的 JSON', '{"schema_version":"v2","items":["a"'],
    ['多了逗号', '{"schema_version":"v2","items":["a",],}'],
    ['根本不是 JSON', 'this is not json at all'],
    ['是 null', 'null'],
    ['是数组而非对象', '["a","b"]'],
    ['是字符串', '"just a string"'],
    ['是数字', '42'],
  ];

  for (const [label, text] of CORRUPTIONS) {
    it(`${label}：返回空值，但原文仍在磁盘上`, () => {
      writeFileSync(file, text, 'utf8');
      const r = loadStateFile<Doc>({ path: file, ...SPEC });

      assert.deepEqual(r.data.items, []);
      assert.ok(r.recovered, '没有报告恢复信息，用户不会知道数据去哪了');
      assert.ok(r.recovered!.backup, '没有给出备份路径');
      // The crucial assertion: the original bytes survive, so the user (or we)
      // can recover by hand. Everything else here is a matter of judgement.
      assert.ok(existsSync(r.recovered!.backup), '备份文件不存在');
      assert.equal(readFileSync(r.recovered!.backup, 'utf8'), text, '备份内容与原文不一致');
    });
  }

  it('恢复信息里带上原因，便于用户判断', () => {
    writeFileSync(file, '{{{', 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.ok(r.recovered!.reason.length > 4, '原因太短，等于没说');
  });

  it('隔离后原位置不再有损坏文件（避免下次再读同一份坏数据）', () => {
    writeFileSync(file, 'broken{', 'utf8');
    loadStateFile<Doc>({ path: file, ...SPEC });
    // Either gone, or replaced by valid content — never the same broken bytes.
    if (existsSync(file)) {
      assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
    }
  });

  it('多个损坏文件分别隔离，不会互相覆盖', () => {
    writeFileSync(file, 'broken1{', 'utf8');
    loadStateFile<Doc>({ path: file, ...SPEC });
    writeFileSync(file, 'broken2{', 'utf8');
    loadStateFile<Doc>({ path: file, ...SPEC });
    assert.equal(siblings().length, 2, '两次损坏只留下一个备份');
  });
});

describe('读取：形状不对但能解析', () => {
  it('缺字段时抛错并隔离，而不是当成空数据', () => {
    // This is the exact case that used to silently empty the session list: valid
    // JSON whose expected array is missing.
    writeFileSync(file, JSON.stringify({ schema_version: 'v2' }), 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.ok(r.recovered, '形状不对却没有隔离');
    assert.match(allContentOnDisk(), /schema_version/);
  });

  it('字段类型不对时同样隔离', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 'v2', items: 'not-an-array' }), 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.ok(r.recovered);
  });
});

describe('版本迁移', () => {
  it('从旧版本升级并保留内容', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 'v1', items: ['保留我'] }), 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(r.data.items, ['保留我']);
    assert.equal(r.data.schema_version, 'v2');
    assert.equal(r.migratedFrom, 'v1');
    assert.equal(r.recovered, undefined, '迁移不是损坏，不该隔离');
  });

  it('没有版本号的文件按最早版本处理', () => {
    writeFileSync(file, JSON.stringify({ items: ['老文件'] }), 'utf8');
    const r = loadStateFile<Doc>({
      path: file, ...SPEC,
      migrations: { ...SPEC.migrations, '*': (raw) => ({ ...raw, schema_version: 'v2' }) },
    });
    assert.deepEqual(r.data.items, ['老文件']);
  });

  it('没有任何可用迁移时隔离，而不是当成空数据', () => {
    writeFileSync(file, JSON.stringify({ items: ['无处可去'] }), 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.ok(r.recovered, '没有迁移路径却没有隔离');
    assert.match(allContentOnDisk(), /无处可去/);
  });

  it('未知（更新）的版本号也要留底，不能猜着写回', () => {
    // Happens after a downgrade: the file is from a newer build. Guessing at its
    // shape risks writing nonsense over it.
    writeFileSync(file, JSON.stringify({ schema_version: 'v99', items: ['未来格式'] }), 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.ok(r.recovered);
    assert.match(r.recovered!.reason, /v99/);
    assert.match(allContentOnDisk(), /未来格式/);
  });

  it('迁移链出现循环时停止并隔离，不会挂死', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 'a', items: [] }), 'utf8');
    const r = loadStateFile<Doc>({
      path: file,
      version: 'z',
      empty: () => ({ schema_version: 'z', items: [] }),
      parse: SPEC.parse,
      migrations: {
        a: (raw) => ({ ...raw, schema_version: 'b' }),
        b: (raw) => ({ ...raw, schema_version: 'a' }),
      },
    });
    assert.ok(r.recovered, '循环没有被检测到');
    assert.match(r.recovered!.reason, /循环/);
  });

  it('多步迁移链能走到底', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 'a', items: ['链'] }), 'utf8');
    const r = loadStateFile<Doc>({
      path: file,
      version: 'c',
      empty: () => ({ schema_version: 'c', items: [] }),
      parse: (raw) => ({ schema_version: 'c', items: (raw as Doc).items }),
      migrations: {
        a: (raw) => ({ ...raw, schema_version: 'b' }),
        b: (raw) => ({ ...raw, schema_version: 'c' }),
      },
    });
    assert.deepEqual(r.data.items, ['链']);
    assert.equal(r.data.schema_version, 'c');
  });
});

describe('saveStateFile', () => {
  it('写出可被读回的 JSON', () => {
    saveStateFile(file, { schema_version: 'v2', items: ['x'] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items, ['x']);
  });

  it('自动创建父目录', () => {
    const deep = join(dir, 'a', 'b', 'c', 'state.json');
    saveStateFile(deep, { schema_version: 'v2', items: [] });
    assert.equal(existsSync(deep), true);
  });

  it('原子写入：不留下临时文件', () => {
    saveStateFile(file, { schema_version: 'v2', items: [] });
    assert.deepEqual(siblings().filter((f) => f.includes('.tmp')), []);
  });

  it('覆盖写入不会丢失新内容', () => {
    saveStateFile(file, { schema_version: 'v2', items: ['一'] });
    saveStateFile(file, { schema_version: 'v2', items: ['一', '二'] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items, ['一', '二']);
  });
});
