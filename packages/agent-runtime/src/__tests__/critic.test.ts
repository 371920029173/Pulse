import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractClaims, reviewClaims, renderCriticReview, actionableFindings } from '../critic.js';
import type { RunEvent } from '../run-trace.js';

/**
 * 独立批评者：把说法和运行轨迹对上。
 *
 * 这个文件唯一有价值的性质是**它和作者用的不是同一份信息**：作者说的是它记得的，批评者看的是盘上
 * 记着的。所以断言的重点是：
 *
 *   1. 只有可核对的说法才进结论——没点名工具、没引用输出的句子只报 `unverifiable`，不参与判定，
 *      否则批评者会变成「什么都反对」的噪音源；
 *   2. 有工具名 + 轨迹里最后一次调用失败 = 矛盾，这是唯一能「证明」说法错的情形，必须判不通过；
 *   3. 引用对不上只是「无依据」（保留意见），因为转述是合法的，把转述判成失败会让人绕开它。
 */

const ev = (over: Partial<RunEvent>): RunEvent => ({ seq: 1, ts: '2026-01-01T00:00:00.000Z', kind: 'tool', ...over });

/** 一次成功的 shell 调用，args/result 里带一个可引用的长 token。 */
const okShell = (seq = 1): RunEvent => ev({
  seq,
  kind: 'tool',
  tool: 'shell',
  args: '{"command":"pnpm check:offline"}',
  result: 'exit code: 0\n全部 33 个检查脚本通过',
  ok: true,
});
const failShell = (seq = 2): RunEvent => ev({
  seq,
  kind: 'tool',
  tool: 'shell',
  args: '{"command":"pnpm check:offline"}',
  result: 'exit code: 1\nFAIL (2) reflection-check',
  ok: false,
  failure: 'nonzero_exit',
});

describe('extractClaims', () => {
  it('只挑出「声称做完了」的句子', () => {
    const claims = extractClaims([
      '我打算先看 session.ts。',
      '已跑通 pnpm check:offline，33 个脚本全过。',
      '- 已经修复了超时判断。',
      '下一步会补测试。',
    ].join('\n'));
    assert.equal(claims.length, 2);
    assert.match(claims[0], /已跑通/);
    assert.match(claims[1], /已经修复了超时判断/);
  });

  it('去掉列表符号和标题，留下句子本身', () => {
    const [claim] = extractClaims('## 结论\n- 已完成迁移');
    assert.equal(claim, '已完成迁移');
  });

  it('太短的片段不算说法', () => {
    assert.deepEqual(extractClaims('已完成'), []);
  });

  it('没有完成性说法就是空（不要凭空造出待核对项）', () => {
    assert.deepEqual(extractClaims('我准备开始做这件事，先看一下目录结构。'), []);
  });
});

describe('reviewClaims — 矛盾', () => {
  it('说某工具成功、轨迹里它最后一次是失败的 → 不通过', () => {
    const review = reviewClaims({
      claims: ['shell 里 pnpm check:offline 已通过'],
      trace: [okShell(1), failShell(2)],
    });
    assert.equal(review.verdict, 'fail');
    const finding = review.findings[0];
    assert.equal(finding.status, 'contradicted');
    assert.match(finding.detail, /nonzero_exit/);
    assert.equal(finding.matchedRun, 'shell#2');
  });

  it('工具名本身不算「引用的依据」（否则点名工具的说法必然失败）', () => {
    const review = reviewClaims({
      claims: ['shell 已跑通'],
      trace: [failShell(1), okShell(2)],
    });
    assert.equal(review.verdict, 'pass');
    assert.equal(review.findings[0].status, 'unverifiable');
  });

  it('矛盾只在算法说的那一个工具上判（别的工具失败不算这条的账）', () => {
    const review = reviewClaims({
      claims: ['fs_read 已经读到了配置文件'],
      trace: [ev({ seq: 1, kind: 'tool', tool: 'fs_read', result: '{"content":"..."}', ok: true }), failShell(2)],
    });
    assert.equal(review.verdict, 'pass');
  });

  it('工具名要整词匹配（read 不能匹配到 read_file 里）', () => {
    const review = reviewClaims({
      claims: ['read 已经完成了'],
      trace: [ev({ seq: 1, kind: 'tool', tool: 'read_file', result: 'ok', ok: true })],
      availableTools: ['read_file'],
    });
    assert.equal(review.findings[0].status, 'unverifiable');
  });
});

describe('reviewClaims — 依据', () => {
  it('点名了工具但轨迹里没有它的调用 → 无依据', () => {
    const review = reviewClaims({
      claims: ['已经用 grep 找到了所有调用点'],
      trace: [okShell(1)],
      availableTools: ['shell', 'grep'],
    });
    assert.equal(review.verdict, 'concerns');
    assert.equal(review.findings[0].status, 'unbacked');
    assert.match(review.findings[0].detail, /没有它的任何调用记录/);
  });

  it('引用的 token 在轨迹里能找到 → 有依据', () => {
    const review = reviewClaims({
      claims: ['已经跑过 check:offline 这个脚本'],
      trace: [okShell(1)],
    });
    assert.equal(review.findings[0].status, 'backed');
    assert.match(review.findings[0].detail, /check:offline/);
  });

  it('引用的 token 哪里都找不到 → 无依据（保留意见，不是失败）', () => {
    const review = reviewClaims({
      claims: ['已经按 design-notes-v3.md 的约定改完了'],
      trace: [okShell(1)],
    });
    assert.equal(review.findings[0].status, 'unbacked');
    assert.equal(review.verdict, 'concerns');
    assert.match(review.findings[0].detail, /design-notes-v3\.md/);
  });

  it('引用太长的问题：短词不算依据，避免「总是能对上」', () => {
    const review = reviewClaims({ claims: ['已经完成了 abc 这一步'], trace: [okShell(1)] });
    // `abc` 只有三个字符，不构成可核对引用，所以这条只能是 unverifiable 而不是 backed。
    assert.equal(review.findings[0].status, 'unverifiable');
  });

  it('中文长句不算引用（中文没有词边界，散文天然就是长串）', () => {
    const review = reviewClaims({
      claims: ['整体逻辑已经理顺了，应该没问题。'],
      trace: [okShell(1)],
    });
    assert.equal(review.findings[0].status, 'unverifiable');
  });
});

describe('reviewClaims — 说不出所以然的说法', () => {
  it('没点名工具也没引用输出的说法只报 unverifiable，不进结论', () => {
    const review = reviewClaims({
      claims: ['整体逻辑已经理顺了，应该没问题。'],
      trace: [okShell(1)],
    });
    assert.equal(review.verdict, 'pass');
    assert.equal(review.findings[0].status, 'unverifiable');
    assert.equal(review.checked, 0, '能核对的条数是判定依据的分母');
    assert.match(review.summary, /不计入结论/);
  });

  it('轨迹完全是空的时候不炸，也不会「通过」得理直气壮', () => {
    const review = reviewClaims({ claims: ['已经修好了'], trace: [] });
    assert.equal(review.verdict, 'pass');
    assert.equal(review.toolRuns, 0);
    assert.equal(review.findings[0].status, 'unverifiable');
  });

  it('接受 RunReadResult 形态（从盘上读回来的那种）', () => {
    const review = reviewClaims({
      claims: ['shell 已通过'],
      trace: { events: [okShell(1)], run: {} as never, skipped: 0 },
    });
    assert.equal(review.verdict, 'pass');
    assert.equal(review.toolRuns, 1);
  });

  it('非工具事件不参与（step / end 不是调用）', () => {
    const review = reviewClaims({
      claims: ['shell 已经跑完'],
      trace: [
        ev({ seq: 1, kind: 'step', text: '准备' }),
        ev({ seq: 2, kind: 'end', ok: true }),
      ],
    });
    assert.equal(review.toolRuns, 0);
    assert.equal(review.findings[0].status, 'unverifiable');
  });
});

describe('renderCriticReview', () => {
  it('没问题时不写「全部通过」（写了就会被跳过）', () => {
    const review = reviewClaims({ claims: ['shell 里 check:offline 已通过'], trace: [okShell(1)] });
    assert.equal(review.verdict, 'pass');
    assert.equal(renderCriticReview(review), '');
  });

  it('有矛盾时列出可执行的条目', () => {
    const review = reviewClaims({ claims: ['shell 里 pnpm check:offline 已通过'], trace: [okShell(1), failShell(2)] });
    const text = renderCriticReview(review);
    assert.match(text, /不通过/);
    assert.match(text, /\[contradicted\]/);
  });

  it('无依据也给出来（保留意见要有可读的原因）', () => {
    const review = reviewClaims({ claims: ['已经用 grep 找全了调用点'], trace: [okShell(1)], availableTools: ['shell', 'grep'] });
    const text = renderCriticReview(review);
    assert.match(text, /有保留/);
    assert.match(text, /grep/);
  });
});

describe('actionableFindings', () => {
  it('矛盾排最前，其次是没依据的；能对上的不列', () => {
    const review = reviewClaims({
      claims: ['shell 里 pnpm check:offline 已通过', '已经用 grep 找全了调用点', 'fs_read 已读完'],
      trace: [okShell(1), failShell(2)], // 最后一条 fs_read 没调用过
      availableTools: ['shell', 'grep', 'fs_read'],
    });
    const codes = actionableFindings(review).map((f) => f.status);
    assert.deepEqual(codes, ['contradicted', 'unbacked', 'unbacked']);
  });
});
