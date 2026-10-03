import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SheConfig } from '@she/shared';
import { KBStore, tokenizeQuery } from '../store.js';
import { GroupKBEngine } from '../engine.js';
import {
  isQueryStopToken, queryTerms, detectConcepts, groupConcepts, fallbackUnits, unitMatches, EXPANSION_WEIGHT,
} from '../retrieval-lexicon.js';

const kbConfig = (dbPath: string): SheConfig['kb'] => ({
  dbPath,
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
});

describe('query segmentation (retrieval-lexicon)', () => {
  it('drops function-word and cross-word bigrams from the query, keeps subject words', () => {
    for (const stop of ['如何', '后如', '的错', '什么']) assert.equal(isQueryStopToken(stop), true, stop);
    for (const word of ['覆辙', '避免', '超时', '计划']) assert.equal(isQueryStopToken(word), false, word);
    assert.equal(isQueryStopToken('the'), true);
    assert.equal(isQueryStopToken('lsp_diagnostics'), false);
  });

  it('keeps underscore identifiers whole (their parts would match unrelated text)', () => {
    const { terms } = queryTerms('zzz_no_such_symbol_zzz', tokenizeQuery);
    assert.deepEqual(terms.map((t) => t.token), ['zzz_no_such_symbol_zzz']);
  });

  it('keeps the query words when the query is nothing but function words', () => {
    const { own } = queryTerms('如何', tokenizeQuery);
    assert.ok(own.length > 0, '全是虚词时不能变成空查询');
  });

  it('adds English singulars and the parts of hyphenated words at a lower weight', () => {
    const { terms } = queryTerms('self-reflection habits', tokenizeQuery);
    const w = (t: string) => terms.find((x) => x.token === t)?.weight ?? 0;
    assert.equal(w('habits'), 1);
    assert.equal(w('habit') > 0 && w('habit') < 1, true);
    assert.equal(w('reflection') > 0, true, 'self-reflection 的组成部分也要能命中');
  });
});

describe('concept expansion (retrieval-lexicon)', () => {
  it('maps a meaning-only phrase to the words the error book is written in, with a reason', () => {
    const { terms, concepts } = queryTerms('程序出错后如何避免重蹈覆辙 记录犯过的错', tokenizeQuery);
    assert.deepEqual(concepts.map((c) => c.concept.id), ['mistake']);
    const fail = terms.find((t) => t.token === '失败');
    assert.ok(fail, '「犯过的错」应扩展出「失败」');
    assert.ok(fail!.weight <= EXPANSION_WEIGHT, '扩展词的权重必须低于用户自己打的词');
    assert.match(fail!.via, /→mistake$/);
    assert.equal(terms.find((t) => t.token === '覆辙')?.via, '', '用户自己的词不带 via');
  });

  it('matches Latin concept words as whole words only (plural-tolerant)', () => {
    assert.deepEqual(detectConcepts('my mistakes').map((c) => c.concept.id), ['mistake']);
    assert.deepEqual(detectConcepts('a terror movie').map((c) => c.concept.id), []);
  });

  it('bridges English queries to the concept, whatever language the notes are in', () => {
    const { terms } = queryTerms('lessons learned', tokenizeQuery);
    assert.ok(terms.some((t) => t.token === '教训'), 'lessons → 教训');
  });

  it('derives group concepts from the name, the ancestors and the member titles', () => {
    const shell = groupConcepts({ name: 'shell', ancestorNames: ['errors'], memberTitles: ['shell · nonzero_exit'] });
    assert.equal(shell.get('shell')?.source, 'name');
    assert.equal(shell.get('mistake')?.source, 'ancestor');
    assert.equal(shell.get('mistake')?.weight, 0.8);
    const notes = groupConcepts({ name: 'notes', ancestorNames: [], memberTitles: ['成本基准', '别的'] });
    assert.equal(notes.get('cost')?.source, 'members');
    assert.equal(notes.get('cost')?.weight, 0.3, '一半成员标题提到 → 0.6 × 1/2');
  });

  it('builds fallback units (CJK bigrams, Latin words) without function words', () => {
    const g = fallbackUnits('如何 the migration 迁移');
    assert.ok(g.has('migration') && g.has('迁移'));
    assert.ok(!g.has('如何') && !g.has('the'));
  });

  it('matches a Latin fallback unit by shared prefix, not by stray trigrams', () => {
    assert.equal(unitMatches('migrat', fallbackUnits('database migration scripts')), true);
    assert.equal(unitMatches('hydration', fallbackUnits('iteration duration ration')), false, '共享 -ation 不算');
    assert.equal(unitMatches('recipe', fallbackUnits('record received')), false);
    assert.equal(unitMatches('迁移', fallbackUnits('迁移脚本')), true);
  });
});

describe('GroupKBEngine meaning-only retrieval and fallback', () => {
  let dir: string;
  let store: KBStore;
  let engine: GroupKBEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'she-kb-lexicon-'));
    const dbPath = join(dir, 'kb.sqlite');
    store = new KBStore(dbPath);
    engine = new GroupKBEngine(store, kbConfig(dbPath));
    const errors = engine.createGroup('errors');
    const fsRead = engine.createGroup('fs_read', errors.id);
    const project = engine.createGroup('project');
    const env = engine.createGroup('env', project.id);
    engine.addMemory(fsRead.id, 'fact', 'fs_read · not_found', '工具：fs_read｜失败类型：not_found｜去路：先 fs_list 确认路径');
    engine.addMemory(env.id, 'fact', '环境：shell 为 Windows cmd', 'cmd 没有 cat，用 type')
    engine.addMemory(project.id, 'fact', '项目记录：数据库 migration 脚本', '迁移脚本放在 db/ 下');
    engine.addMemory(project.id, 'fact', '项目总览', '这是项目的总体说明');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes a meaning-only query to the error book, and says why', () => {
    const res = engine.query('怎样才能不再犯同样的错误');
    assert.equal(res.nodes[0]?.title, 'fs_read · not_found');
    assert.match(res.traces[0]!.reason, /concept route .*→mistake/);
  });

  it('bridges an English meaning-only query to Chinese notes', () => {
    const res = engine.query('what went wrong before');
    assert.equal(res.nodes[0]?.title, 'fs_read · not_found');
  });

  it('leaves plain BM25 unchanged when no weighted terms are passed', () => {
    const plain = store.bm25Search('如何 cmd').map((h) => [h.mem.id, h.score]);
    const explicit = store.bm25Search('如何 cmd', {
      terms: tokenizeQuery('如何 cmd').map((token) => ({ token, weight: 1 })),
    }).map((h) => [h.mem.id, h.score]);
    assert.deepEqual(plain, explicit);
  });

  it('bumps the store generation on group and memory writes, not on reads', () => {
    const g0 = store.generation;
    engine.query('cmd');
    assert.equal(store.generation, g0, '查询（含访问计数）不算结构变化');
    engine.createGroup('plans');
    assert.ok(store.generation > g0);
  });

  it('prefers the nested group whose full path the query spells out', () => {
    const res = engine.query('project/env');
    assert.equal(res.nodes[0]?.title, '环境：shell 为 Windows cmd');
  });

  it('returns weak matches only as a labelled fallback, never in the primary list', () => {
    // "migrat" is no token of any note, so the primary pass finds nothing; it is a prefix of "migration".
    const res = engine.query('migrat');
    assert.equal(res.nodes.length, 0, '兜底结果不能混进主结果');
    assert.ok(res.fallback, '主检索落空时应给出兜底');
    assert.equal(res.fallback!.nodes[0]?.title, '项目记录：数据库 migration 脚本');
    assert.match(res.fallback!.traces[0]!.reason, /^fallback overlap/);
    assert.match(res.fallback!.reason, /主检索/);
  });

  it('does not run the fallback when the primary hit is confident', () => {
    const res = engine.query('fs_read not_found');
    assert.equal(res.nodes[0]?.title, 'fs_read · not_found');
    assert.equal(res.fallback, undefined);
  });

  it('finds nothing for an unknown identifier whose parts appear in a note', () => {
    engine.addMemory(engine.createGroup('shell', engine.createGroup('errors2').id).id, 'fact',
      'shell · not_found', 'ls: cannot access: No such file or directory');
    const res = engine.query('zzz_no_such_symbol_zzz');
    assert.equal(res.nodes.length, 0);
  });

  it('returns no fallback for a query that shares nothing with the library', () => {
    const res = engine.query('quantum entanglement recipe');
    assert.equal(res.nodes.length, 0);
    assert.equal(res.fallback, undefined);
  });
});
