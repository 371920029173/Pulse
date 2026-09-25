/**
 * 子任务的知识库笔记：写完怎么收回来、收回来之后回执里写什么。
 *
 * 这里钉的是一条实测出来的浪费：子级在自己的库副本里写下结论，副本随子任务一起删掉，那些
 * 结论只剩「它有没有记得在散文里再说一遍」这一条出路。收割就是为了让「写下来」重新有用 ——
 * 所以规则也得当成对外契约测：哪些节点算它的笔记、哪些不算、回执里到底给父级看多少。
 *
 * 反向的一半同样重要：收割不是把子级的库并进父级的库。父级看到的是一个列表，入库与否由它
 * 自己决定，这正是交接单里对子级的承诺。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectHarvestNotes,
  renderKbHarvest,
  createSubagentTools,
  HARVEST_INLINE_MAX,
} from '../subagent-tools.js';
import type { HarvestCandidate, SubagentResult } from '../subagent-tools.js';

const note = (over: Partial<HarvestCandidate> = {}): HarvestCandidate => ({
  title: '端口 5577 是 UI 的',
  kind: 'fact',
  content: '父级的 UI 在 5577，服务端在 5578；改端口要两边一起改。',
  ...over,
});

describe('收割：哪些算它的笔记', () => {
  it('普通节点按写入顺序收进来，标题和正文都在', () => {
    const harvest = selectHarvestNotes([note(), note({ title: '第二条', content: '正文二' })]);
    assert.equal(harvest.written, 2);
    assert.deepEqual(harvest.notes.map((n) => n.title), ['端口 5577 是 UI 的', '第二条']);
    assert.equal(harvest.notes[1]?.content, '正文二');
  });

  it('【关键】错题本的自省条目不算它的笔记 —— 那些是拿父级的目标衡量子级得出来的', () => {
    const harvest = selectHarvestNotes([
      note(),
      note({ title: '目标漂移 · reflection', kind: 'tool_outcome', metadata: { errorbook: true } }),
      note({ title: '重复失败:kb_query · reflection', kind: 'tool_outcome', metadata: { errorbook: true } }),
    ]);
    assert.deepEqual(harvest.notes.map((n) => n.title), ['端口 5577 是 UI 的']);
    assert.equal(harvest.written, 1);
    assert.equal(harvest.selfReview, 2, '要数出来，不能悄悄吞掉');
  });

  it('回执里给的摘要是开头一段，摘要文件里是全文', () => {
    const long = 'x'.repeat(400);
    const harvest = selectHarvestNotes([note({ content: long })]);
    const first = harvest.notes[0]!;
    assert.ok(first.excerpt.length < 200, `摘要是开头一段，实际 ${first.excerpt.length}`);
    assert.equal(first.content, long, '副本已经删了，全文必须留在手上');
  });

  it('空库收出空结果，而不是 undefined 之类要调用方判断的东西', () => {
    const harvest = selectHarvestNotes([]);
    assert.deepEqual(harvest, { notes: [], written: 0, selfReview: 0 });
  });
});

describe('收割：回执里怎么写', () => {
  it('没有笔记也没有自省时不占一行', () => {
    assert.deepEqual(renderKbHarvest({ notes: [], written: 0, selfReview: 0 }), []);
  });

  it('逐条列出标题和开头，并说清副本已经没了、要留就得自己搬', () => {
    const lines = renderKbHarvest(selectHarvestNotes([note()])).join('\n');
    assert.match(lines, /端口 5577 是 UI 的/);
    assert.match(lines, /副本已随子任务清理/);
    assert.match(lines, /kb_upsert/, '不说搬进主库的办法，父级只能看着');
  });

  it('笔记多到超过一行行的上限时，如实说还有多少条没列', () => {
    const many = Array.from({ length: HARVEST_INLINE_MAX + 3 }, (_, i) => note({ title: `笔记 ${i}` }));
    const lines = renderKbHarvest(selectHarvestNotes(many)).join('\n');
    assert.match(lines, new RegExp(`${HARVEST_INLINE_MAX + 3} 条`), '总数要说原始条数');
    assert.match(lines, /还有 3 条没有列在这里/);
  });

  it('摘要有文件时给出路径，父级能直接 fs_read', () => {
    const lines = renderKbHarvest({
      ...selectHarvestNotes([note()]),
      digestPath: '.she/subagent-notes/sess_1.md',
    }).join('\n');
    assert.match(lines, /\.she\/subagent-notes\/sess_1\.md/);
  });

  it('自省条目单独报数，并说明为什么不并入', () => {
    const lines = renderKbHarvest(
      selectHarvestNotes([note({ metadata: { errorbook: true } })]),
    ).join('\n');
    assert.match(lines, /1 条它自己的自省记录/);
    assert.match(lines, /误报居多/);
  });
});

describe('收割：接到 task_spawn 的回执里', () => {
  it('子级写过笔记时，笔记块出现在交付物后面', async () => {
    const runner = {
      async run(req: { description: string }): Promise<SubagentResult> {
        return {
          description: req.description,
          ok: true,
          result: '结论是 X。',
          kbHarvest: selectHarvestNotes([note()]),
        };
      },
    };
    const tools = createSubagentTools(runner);
    const out = await tools.execute('task_spawn', {
      tasks: [{ description: '查端口', prompt: '查一下端口' }],
    });
    const at = out.indexOf('结论是 X。');
    assert.ok(at >= 0, out);
    assert.ok(out.indexOf('端口 5577 是 UI 的') > at, '笔记块要跟在交付物后面');
  });

  it('没写笔记的子级回执和以前一样，不出现空标题', async () => {
    const runner = {
      async run(req: { description: string }): Promise<SubagentResult> {
        return {
          description: req.description,
          ok: true,
          result: '结论是 X。',
          kbHarvest: { notes: [], written: 0, selfReview: 0 },
        };
      },
    };
    const tools = createSubagentTools(runner);
    const out = await tools.execute('task_spawn', {
      tasks: [{ description: '查端口', prompt: '查一下端口' }],
    });
    assert.doesNotMatch(out, /知识库副本里写下的笔记/);
  });
});
