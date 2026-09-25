import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ConfidenceMirror,
  detectDrift,
  deriveReflections,
  goalTerms,
  prohibitionObject,
  renderCalibration,
  renderDrift,
  renderReflection,
} from '../reflection.js';
import type { CalibrationReport, DriftReport, ReflectionSources } from '../reflection.js';

/**
 * 自省：漂移检测、置信度镜像、反思到教训。
 *
 * 这三样都是「关于 agent 自己」的判断，不是关于任务的判断，所以它们的失败方式也特殊：错了不会被任何
 * 别的检查发现，只会让 agent 从此不再相信它们。因此断言的重点是**什么时候它必须闭嘴**：
 *
 *   1. 漂移检测只在有证据时开口（点名了被排除的对象、连续多个动作和目标词完全不重合），
 *      而且倾向误报而不是漏报——误报的代价是看一眼目标，漏报的代价是整个任务跑偏；
 *   2. 置信度镜像样本不足时说 `unknown`，并且「有工具调用」和「没有工具调用」的轮次不能混算，
 *      否则不做事的轮次会被读成「说对了」；
 *   3. 反思只把测出来的东西写成教训，清白的一轮什么都不写。
 */

const dir = () => mkdtempSync(join(tmpdir(), 'she-reflect-'));

// ─── 漂移 ───────────────────────────────────────────────────────────────────

describe('detectDrift — 什么时候开口', () => {
  it('动作始终带着目标里的词就不报', () => {
    const report = detectDrift({
      goal: '把登录超时的问题修好，并补上回归测试',
      actions: [
        { tool: 'grep', args: '登录超时' },
        { tool: 'fs_read', args: 'packages/auth/session.ts' },
        { tool: 'shell', args: 'pnpm test auth' },
      ],
    });
    assert.equal(report.level, 'none');
    assert.equal(report.replan, false);
    assert.equal(renderDrift(report), '', '没漂移就不要往提示词里塞空话');
  });

  it('连续三个动作和目标完全无关 → 提醒', () => {
    const report = detectDrift({
      goal: '把登录超时的问题修好',
      actions: [
        { tool: 'shell', args: 'git log --oneline' },
        { tool: 'shell', args: 'du -sh node_modules' },
        { tool: 'shell', args: 'npm outdated' },
      ],
    });
    assert.equal(report.level, 'watch');
    assert.equal(report.signals[0].kind, 'goal_unrelated');
    assert.equal(report.replan, false);
  });

  it('五个动作都无关 → 升级为漂移，要求重写计划', () => {
    const report = detectDrift({
      goal: '把登录超时的问题修好',
      actions: [
        { tool: 'shell', args: 'git log' },
        { tool: 'shell', args: 'du -sh .' },
        { tool: 'shell', args: 'npm outdated' },
        { tool: 'shell', args: 'ls -la' },
        { tool: 'shell', args: 'df -h' },
      ],
    });
    assert.equal(report.level, 'drift');
    assert.equal(report.replan, true);
    assert.match(report.advice ?? '', /实际目标/);
  });

  it('动作太少就不猜（一两个动作看不出方向）', () => {
    const report = detectDrift({
      goal: '把登录超时的问题修好',
      actions: [{ tool: 'shell', args: 'git log' }, { tool: 'shell', args: 'ls' }],
    });
    assert.equal(report.level, 'none');
  });

  it('目标是空的就不报（没有基准可比）', () => {
    const report = detectDrift({ goal: '', actions: [{ tool: 'shell' }, { tool: 'shell' }, { tool: 'shell' }] });
    assert.equal(report.level, 'none');
  });
});

describe('detectDrift — 约束', () => {
  it('硬约束被触碰 → 直接漂移，且点名是哪个对象', () => {
    const report = detectDrift({
      goal: '修好构建',
      constraints: [{ text: '不要修改 packages/migrations 下的任何文件', hardness: 'hard' }],
      actions: [{ tool: 'fs_write', args: 'packages/migrations/003_add.sql' }],
    });
    assert.equal(report.level, 'drift');
    assert.equal(report.replan, true);
    const signal = report.signals.find((s) => s.kind === 'constraint_violated');
    assert.ok(signal);
    assert.equal(signal!.major, true);
    assert.match(signal!.detail, /migrations/);
    assert.match(report.advice ?? '', /先问用户/);
  });

  it('软约束被触碰只是提醒，不是漂移（偏好不是规则）', () => {
    const report = detectDrift({
      goal: '修好构建',
      constraints: [{ text: '尽量别动 cluster.ts', hardness: 'soft' }],
      actions: [{ tool: 'fs_write', args: 'cluster.ts' }],
    });
    assert.equal(report.level, 'watch');
    assert.equal(report.replan, false);
  });

  it('提不出具体对象的约束不产生信号（否则每条偏好都会误报）', () => {
    const report = detectDrift({
      goal: '修好构建',
      constraints: ['不要拖太久', '保持代码整洁'],
      actions: [{ tool: 'fs_write', args: 'a.ts' }],
    });
    assert.equal(report.signals.length, 0);
    assert.equal(report.level, 'none');
  });

  it('不是禁止句的约束不查（「配置是 JSON」不是禁令）', () => {
    const report = detectDrift({
      goal: '修好构建',
      constraints: ['配置文件必须是 JSON'],
      actions: [{ tool: 'fs_write', args: 'config.ts' }],
    });
    assert.equal(report.level, 'none');
  });

  it('反引号里的对象按原样比对', () => {
    const report = detectDrift({
      goal: 'x',
      constraints: ['不要碰 `session-store.ts`'],
      actions: [{ tool: 'fs_write', args: 'src/session-store.ts' }],
    });
    assert.equal(report.signals[0].kind, 'constraint_violated');
  });
});

describe('goalTerms / prohibitionObject', () => {
  it('中文按二元组切，短句也能和别的句子重合', () => {
    const terms = goalTerms('修复登录超时');
    assert.ok(terms.includes('登录'));
    assert.ok(terms.includes('超时'));
  });

  it('结构词不进目标词（否则「里的」会匹配一切）', () => {
    const terms = goalTerms('不要修改 packages/server 里的 cluster.ts');
    assert.ok(!terms.includes('里的'));
    // 路径是一个整体 token：比对是「动作文本是否包含这个词」，所以拆不拆开都能匹配到子路径。
    assert.ok(terms.includes('packages/server'));
  });

  it('禁止句里取最长的那两个具体对象', () => {
    const objects = prohibitionObject('不要修改 packages/server 里的 cluster.ts');
    assert.deepEqual(objects, ['packages/server', 'cluster.ts']);
  });

  it('模糊偏好取到的是短语本身，只有动作里真出现这句话才算越界', () => {
    // 「拖太久」不是一个能出现在工具参数里的对象，所以这类约束事实上永远不会触发——这是宁可留下
    // 一个无害的词，也不去猜「哪些中文短语算具体对象」的原因。
    assert.deepEqual(prohibitionObject('不要拖太久'), ['拖太久']);
    const report = detectDrift({
      goal: '修好登录超时',
      constraints: ['不要拖太久'],
      actions: [{ tool: 'shell', args: 'pnpm test auth' }],
    });
    assert.equal(report.level, 'none');
  });
});

describe('detectDrift — 预算与步骤', () => {
  it('超预算算提醒', () => {
    const report = detectDrift({ goal: 'x', stepsUsed: 9, stepBudget: 5 });
    assert.equal(report.level, 'watch');
    assert.match(report.advice ?? '', /收尾/);
  });

  it('当前步骤不含目标词只算提醒，不算漂移（「跑测试」是合理的步骤）', () => {
    const report = detectDrift({ goal: '修好登录超时', currentStep: '跑离线门禁并提交' });
    assert.equal(report.level, 'watch');
    assert.equal(report.replan, false);
  });
});

// ─── 置信度镜像 ─────────────────────────────────────────────────────────────

const calibration = (over: Partial<CalibrationReport> = {}): CalibrationReport => ({
  samples: 0,
  meanClaimed: 0,
  actualRate: 0,
  bias: 0,
  bucket: 'unknown',
  clampRate: 0,
  worst: [],
  advice: null,
  ...over,
});

describe('ConfidenceMirror', () => {
  const observe = (m: ConfidenceMirror, claimed: number, attempted: number, succeeded: number, clamped = false) =>
    m.observe({ claimed, attempted, succeeded, clamped });

  it('样本不足三个时不下结论', () => {
    const m = new ConfidenceMirror(dir());
    observe(m, 0.9, 4, 1);
    observe(m, 0.9, 4, 1);
    assert.equal(m.report().bucket, 'unknown');
    assert.equal(renderCalibration(m.report()), '', '结论不足就不要往提示词里写');
  });

  it('自评长期高于实际成功率 → 偏乐观，且给出可执行的建议', () => {
    const m = new ConfidenceMirror(dir());
    observe(m, 0.95, 4, 2);
    observe(m, 0.9, 4, 2);
    observe(m, 0.9, 4, 3);
    const r = m.report();
    assert.equal(r.bucket, 'overconfident');
    assert.ok(r.bias > 0.25, `偏差应显著，实际 ${r.bias}`);
    assert.match(r.advice ?? '', /已核对的事实/);
    assert.match(renderCalibration(r), /偏乐观/);
  });

  it('自评低于实际成功率 → 偏保守，也是偏差', () => {
    const m = new ConfidenceMirror(dir());
    observe(m, 0.3, 4, 4);
    observe(m, 0.4, 4, 4);
    observe(m, 0.3, 4, 4);
    assert.equal(m.report().bucket, 'underconfident');
    assert.match(renderCalibration(m.report()), /偏保守/);
  });

  it('对得上就是 calibrated，不硬找问题', () => {
    const m = new ConfidenceMirror(dir());
    observe(m, 0.75, 4, 3);
    observe(m, 0.75, 4, 3);
    observe(m, 0.75, 4, 3);
    const r = m.report();
    assert.equal(r.bucket, 'calibrated');
    assert.equal(r.advice, null);
    assert.equal(renderCalibration(r), '');
  });

  it('没有工具调用的轮次不进实际成功率（否则「什么都没做」会被读成「说对了」）', () => {
    const m = new ConfidenceMirror(dir());
    observe(m, 0.4, 4, 1);
    observe(m, 0.4, 4, 1);
    observe(m, 0.4, 4, 1);
    const before = m.report().actualRate;
    // 一轮只报「很确信」但一个工具都没调：如果它被算成 1.0，偏保守的结论会被冲掉。
    observe(m, 0.95, 0, 0);
    assert.equal(m.report().actualRate, before);
    assert.ok(m.report().bias > 0.25, '报告里的自评均值仍然把它算进去');
  });

  it('成功的次数不会超过尝试的次数（调用方数错也不能造出 >1 的「成功率」）', () => {
    const m = new ConfidenceMirror(dir());
    const s = m.observe({ claimed: 0.5, attempted: 2, succeeded: 9 });
    assert.equal(s.succeeded, 2);
    assert.equal(s.attempted, 2);
  });

  it('落盘后换一个实例还能读到（习惯要跨会话才看得见）', () => {
    const root = dir();
    observe(new ConfidenceMirror(root), 0.9, 4, 2);
    observe(new ConfidenceMirror(root), 0.9, 4, 2);
    observe(new ConfidenceMirror(root), 0.9, 4, 2);
    const reopened = new ConfidenceMirror(root);
    assert.equal(reopened.samples().length, 3);
    assert.equal(reopened.report().bucket, 'overconfident');
  });

  it('文件损坏时当成空历史，不抛异常', () => {
    const root = dir();
    mkdirSync(join(root, '.she', 'reflection'), { recursive: true });
    writeFileSync(join(root, '.she', 'reflection', 'confidence.json'), '{ 这不是 JSON', 'utf8');
    const m = new ConfidenceMirror(root);
    assert.deepEqual(m.samples(), []);
    assert.equal(m.report().bucket, 'unknown');
  });

  it('清空之后连文件里的历史一起没', () => {
    const root = dir();
    observe(new ConfidenceMirror(root), 0.9, 4, 2);
    const m = new ConfidenceMirror(root);
    m.clear();
    assert.equal(JSON.parse(readFileSync(join(root, '.she', 'reflection', 'confidence.json'), 'utf8')).samples.length, 0);
    assert.equal(m.samples().length, 0);
  });

  it('只保留最近 N 条（旧习惯不该永远挂在那里）', () => {
    const m = new ConfidenceMirror(dir(), 3);
    for (let i = 0; i < 5; i++) observe(m, 0.5, 2, 1);
    assert.equal(m.samples().length, 3);
  });

  it('窗口决定报告的是哪一段习惯', () => {
    const m = new ConfidenceMirror(dir());
    for (let i = 0; i < 6; i++) observe(m, 0.2, 4, 4); // 偏保守的旧历史
    for (let i = 0; i < 3; i++) observe(m, 0.95, 4, 1); // 最近的偏乐观
    assert.equal(m.report({ window: 3 }).bucket, 'overconfident');
    // 全部混在一起时旧数据把当前习惯盖住了——所以窗口是必须的，否则「已经改好了」永远显示不出来。
    assert.equal(m.report().bucket, 'underconfident');
  });

  it('预检被压过上限的比例也算进建议里', () => {
    const m = new ConfidenceMirror(dir());
    for (let i = 0; i < 4; i++) observe(m, 0.9, 4, 2, true);
    assert.match(renderCalibration(m.report()), /压到上限/);
  });

  it('领域偏差只在样本够时报告', () => {
    const m = new ConfidenceMirror(dir());
    m.observe({ claimed: 0.9, attempted: 4, succeeded: 1, clamped: false, topic: '迁移脚本' });
    m.observe({ claimed: 0.9, attempted: 4, succeeded: 1, clamped: false, topic: '迁移脚本' });
    m.observe({ claimed: 0.9, attempted: 4, succeeded: 1, clamped: false, topic: '迁移脚本' });
    assert.equal(m.report().worst[0].topic, '迁移脚本');
  });
});

// ─── 反思 ───────────────────────────────────────────────────────────────────

const driftOf = (over: Partial<DriftReport> = {}): DriftReport =>
  ({ level: 'none', score: 0, signals: [], advice: null, replan: false, ...over });

const sources = (over: Partial<ReflectionSources> = {}): ReflectionSources => ({
  goal: '修好登录超时',
  drift: driftOf(),
  calibration: calibration(),
  failures: [],
  runFailed: false,
  ...over,
});

describe('deriveReflections', () => {
  it('干净的一轮什么都不写（错题本不是日志）', () => {
    assert.deepEqual(deriveReflections(sources()), []);
  });

  it('漂移写成「目标漂移」，证据是检测到的那几条', () => {
    const notes = deriveReflections(sources({
      drift: driftOf({
        level: 'drift',
        replan: true,
        signals: [{ kind: 'goal_unrelated', major: true, weight: 0.7, detail: '最近 5 个动作没有提到目标里的任何词' }],
      }),
    }));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].topic, '目标漂移');
    assert.match(notes[0].lesson, /实际目标/);
    assert.match(notes[0].evidence, /最近 5 个动作/);
  });

  it('越过约束比漂移更严重，排在前面', () => {
    const notes = deriveReflections(sources({
      drift: driftOf({
        level: 'drift',
        signals: [
          { kind: 'goal_unrelated', major: true, weight: 0.7, detail: '无关' },
          { kind: 'constraint_violated', major: true, weight: 0.8, detail: '约束「不要改 x」排除的对象「x」出现在了动作里' },
        ],
      }),
    }));
    assert.equal(notes[0].topic, '越过约束');
    assert.equal(notes[1].topic, '目标漂移');
  });

  it('偏乐观才写「过度自信」，对得上就不写', () => {
    const over = deriveReflections(sources({
      calibration: calibration({ bucket: 'overconfident', samples: 6, meanClaimed: 0.9, actualRate: 0.5, bias: 0.4 }),
    }));
    assert.equal(over[0].topic, '过度自信');
    assert.match(over[0].evidence, /0\.90/);

    const ok = deriveReflections(sources({ calibration: calibration({ bucket: 'calibrated', samples: 9 }) }));
    assert.deepEqual(ok, []);
  });

  it('偏保守不写成教训（那是自谦，不是错误）', () => {
    const notes = deriveReflections(sources({
      calibration: calibration({ bucket: 'underconfident', samples: 6, meanClaimed: 0.3, actualRate: 0.8, bias: -0.5 }),
    }));
    assert.deepEqual(notes, []);
  });

  it('同一工具一轮内失败两次才写，一次不写', () => {
    const once = deriveReflections(sources({
      failures: [{ tool: 'shell', kind: 'nonzero_exit', detail: 'exit 1' }],
    }));
    assert.deepEqual(once, []);

    const twice = deriveReflections(sources({
      failures: [
        { tool: 'shell', kind: 'nonzero_exit', detail: 'exit 1' },
        { tool: 'shell', kind: 'nonzero_exit', detail: 'exit 1' },
      ],
    }));
    assert.equal(twice[0].topic, '重复失败:shell');
    assert.match(twice[0].evidence, /失败 2 次/);
  });

  it('工具自己给了去路就用它，别再让人想一遍', () => {
    const notes = deriveReflections(sources({
      failures: [
        { tool: 'shell', kind: 'invalid_args', detail: 'a', remedy: '检查参数拼写' },
        { tool: 'shell', kind: 'invalid_args', detail: 'b' },
      ],
    }));
    assert.match(notes[0].lesson, /检查参数拼写/);
  });

  it('撞上轮数上限写成「循环失控」', () => {
    const notes = deriveReflections(sources({ runFailed: true, runReason: 'max_iterations' }));
    assert.equal(notes[0].topic, '循环失控');
  });

  it('一轮最多三条（多的会把自己埋掉）', () => {
    const notes = deriveReflections(sources({
      drift: driftOf({
        level: 'drift',
        signals: [
          { kind: 'constraint_violated', major: true, weight: 0.8, detail: '越界' },
          { kind: 'goal_unrelated', major: true, weight: 0.7, detail: '无关' },
        ],
      }),
      calibration: calibration({ bucket: 'overconfident', samples: 6, meanClaimed: 0.9, actualRate: 0.5, bias: 0.4 }),
      failures: [
        { tool: 'shell', kind: 'nonzero_exit', detail: 'a' },
        { tool: 'shell', kind: 'nonzero_exit', detail: 'b' },
        { tool: 'fs_read', kind: 'not_found', detail: 'c' },
        { tool: 'fs_read', kind: 'not_found', detail: 'd' },
      ],
      runFailed: true,
      runReason: 'max_iterations',
    }));
    assert.equal(notes.length, 3);
    assert.deepEqual(notes.map((n) => n.topic), ['越过约束', '目标漂移', '循环失控']);
  });

  it('一行渲染带主题，便于回执里说明写了什么', () => {
    assert.match(renderReflection({ topic: '目标漂移', lesson: '重读目标', evidence: 'e', severity: 8 }), /\[目标漂移\]/);
  });
});
