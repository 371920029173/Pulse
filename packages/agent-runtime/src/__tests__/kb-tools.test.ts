/**
 * `kb_*` 的只读形态：共享父级活动库的子任务只许读。
 *
 * 这是委派里唯一一条「子级能永久改父级状态」的通路。隔离只在声明了 `scope` 的写任务上生效，
 * 而只读子任务（最常见的那种）恰恰是**共享**父级的库 —— 它拿到的是和父级一样的记忆规则
 * （「主动 kb_upsert 写回」），写进去的节点又没有任何来源标记：父级既没法复核，事后也分不出
 * 哪条是子级写的。所以这里测的不是「提示词说了不要写」，而是**写调用到达引擎之前就被挡掉**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createKBTools } from '../kb-tools.js';
import type { GroupKBEngine } from '@she/kb';

/**
 * 记录每一次写操作的引擎替身。
 *
 * 断言落在「引擎有没有被要求写」上，而不是落在返回文案上：提示词可以改，文案可以换，但
 * 「共享库的子任务没有改到父级的库」这件事必须在任何实现下都成立。
 */
function fakeEngine() {
  const writes: string[] = [];
  const engine = {
    store: { getAllGroups: () => [] as Array<{ id: string; name: string }> },
    createGroup: (name: string) => {
      writes.push(`createGroup:${name}`);
      return { id: 'g_created' };
    },
    addMemoryMaintained: (groupId: string, _kind: string, title: string) => {
      writes.push(`addMemory:${groupId}:${title}`);
      return { id: 'm_created' };
    },
    addTypedEdge: (sourceId: string, targetId: string, kind: string) => {
      writes.push(`addEdge:${kind}:${sourceId}->${targetId}`);
      return { id: 'e_created' };
    },
    query: () => ({ nodes: [], groupsVisited: [], queryTimeMs: 0, totalNodesScanned: 0 }),
  };
  return { engine: engine as unknown as GroupKBEngine, writes };
}

describe('kb_* 只读形态', () => {
  it('kb_upsert 被拒，而且一个字节都没写进引擎', async () => {
    const { engine, writes } = fakeEngine();
    const tools = createKBTools(engine, { readOnly: true });

    const out = await tools.execute('kb_upsert', {
      groupName: 'project/x',
      title: '子任务的结论',
      content: '这条不该进父级的库',
    });

    assert.deepEqual(writes, [], '只读子任务仍然写到了引擎');
    assert.match(out, /只读/, '拒绝必须说明是为什么');
    assert.match(out, /交付物/, '要同时告诉它结论该放哪 —— 光拒绝会让它重试');
  });

  it('kb_link 同样被拒', async () => {
    const { engine, writes } = fakeEngine();
    const tools = createKBTools(engine, { readOnly: true });

    const out = await tools.execute('kb_link', { sourceId: 'a', targetId: 'b', kind: 'weak' });

    assert.deepEqual(writes, []);
    assert.match(out, /只读/);
  });

  it('读没有被一起关掉 —— kb_query 仍然可用', async () => {
    const { engine } = fakeEngine();
    const tools = createKBTools(engine, { readOnly: true });

    // A read-only child that cannot READ its memory is the amnesia problem all over again.
    const out = await tools.execute('kb_query', { query: '这个项目的 shell 是什么' });
    assert.match(out, /No results found/);
  });

  it('不设只读时写入照常发生 —— 否则这条测试证明不了是开关在起作用', async () => {
    const { engine, writes } = fakeEngine();
    const tools = createKBTools(engine);

    await tools.execute('kb_upsert', { groupName: 'project/x', title: 'T', content: 'C' });

    assert.deepEqual(writes, ['createGroup:project/x', 'addMemory:g_created:T']);
  });

  it('只读形态仍然把工具列出来 —— 调用被拒比「没有这个工具」好', async () => {
    const { engine } = fakeEngine();
    const tools = createKBTools(engine, { readOnly: true });

    const names = tools.definitions.map((d) => d.name);
    assert.ok(names.includes('kb_upsert'), '工具被摘掉的话，子级只会收到「unknown tool」，并被错题本记成自己的错');
    assert.ok(names.includes('kb_link'));
  });
});

/**
 * `kb_query` 的返回体积。
 *
 * 检索是最高频的调用之一（一次任务里查十来遍很正常），而记忆节点的长度分布是极端的：约定、
 * 端口、命令这类只有几十个字，被整篇 ingest 进去的文档和粘进来的日志则是几千个字。全文回显
 * 意味着一次查询命中十条长节点就是十份文档、而且是每查一次重发一遍。所以默认给摘要，但
 * 「摘要」绝不能是悄悄的：截断了要说，原文要有一条明确的取回路径，否则模型会把摘要当原文引用。
 */
describe('kb_query 的返回体积', () => {
  /** 一个能返回指定节点的引擎替身 —— 断言的是工具输出，不是引擎。 */
  function engineWith(nodes: Array<{ title: string; content: string }>, kind = 'fact') {
    const engine = {
      store: { getAllGroups: () => [] as Array<{ id: string; name: string }> },
      createGroup: () => ({ id: 'g' }),
      addMemoryMaintained: () => ({ id: 'm' }),
      addTypedEdge: () => ({ id: 'e' }),
      query: () => ({
        nodes: nodes.map((n, i) => ({ id: `n${i}`, title: n.title, content: n.content, kind })),
        traces: nodes.map(() => ({ finalScore: 0.9, activationLevel: 0.9, groupPath: ['project', 'x'] })),
        groupsVisited: ['project/x'],
        queryTimeMs: 1,
        totalNodesScanned: nodes.length,
      }),
    };
    return createKBTools(engine as unknown as GroupKBEngine);
  }

  const SHORT = '端口约定：服务统一用 5577。';
  const LONG = `历史结论（很长的节点）：${'背景说明。'.repeat(80)}结尾只在这里出现`;

  it('短节点原文照给 —— 摘要是为了砍长文档，不是为了砍记忆', async () => {
    const tools = engineWith([{ title: '端口', content: SHORT }]);
    const out = await tools.execute('kb_query', { query: '端口' });
    assert.ok(out.includes(SHORT), `短节点必须原样返回: ${out}`);
    assert.ok(!/全文|截断|full=true/.test(out), `没截断就不要提截断: ${out}`);
  });

  it('长节点只给摘要，并说明怎么取原文', async () => {
    const tools = engineWith([{ title: '长文档', content: LONG }]);
    const out = await tools.execute('kb_query', { query: '历史' });
    assert.ok(!out.includes('结尾只在这里出现'), `长正文不该整篇回显: ${out.slice(0, 300)}`);
    assert.ok(out.length < LONG.length, '摘要必须比原文短');
    assert.match(out, /full=true/, '要给出取回原文的办法，否则模型只能猜剩下的内容');
    assert.match(out, /摘要/, '被截断这件事必须说出来，不能悄悄改内容');
  });

  it('full=true 才拿全文 —— 需要逐字核对时（命令、数字、路径）用它', async () => {
    const tools = engineWith([{ title: '长文档', content: LONG }]);
    const out = await tools.execute('kb_query', { query: '历史', full: true });
    assert.ok(out.includes('结尾只在这里出现'), `full=true 要给全文: ${out.slice(0, 300)}`);
    assert.ok(!/full=true/.test(out), '已经给了全文就不该再提示展开');
  });

  it('full 的说明写在工具描述里，模型才知道有这个开关', () => {
    const tools = engineWith([]);
    const def = tools.definitions.find((d) => d.name === 'kb_query')!;
    assert.ok(def.parameters.properties && 'full' in (def.parameters.properties as object), '参数表里要有 full');
    assert.match(def.description, /full/, '描述里要说明什么时候用 full');
  });

  /**
   * `budget` 是**扫描预算**，不是结果条数上限。
   *
   * 引擎里真正的上限是 `MAX_RESULTS = 40`（见 `engine.ts`），而 `budget` 只约束脉冲传播的
   * 工作量；注释里写得很清楚，加大 budget「只会增加结果，不会减少」。可工具描述原先写的是
   * 「Omit to scan without a result cap」——听起来像「给了 budget 就有条数上限」。实测过这个
   * 误解的代价：在真库上查询「shell 命令」命中 25 条（8478 字符），带 budget=12 只降到 7696、
   * 带 budget=8 也只降到 3405；想靠这个参数把一次查询压短，是拿不到那个效果的。描述必须说它
   * 真正限制的是什么，否则模型会为了省钱去做一个不省钱的调用。
   */
  it('budget 的说明不谎称它是结果条数上限', () => {
    const tools = engineWith([]);
    const def = tools.definitions.find((d) => d.name === 'kb_query')!;
    const props = def.parameters.properties as Record<string, { description?: string }>;
    const desc = props.budget?.description ?? '';
    assert.ok(desc, 'budget 要有说明');
    assert.doesNotMatch(desc, /result cap/, '不能说它是 result cap —— 它限制的是扫描');
    assert.ok(
      /scan|扫描|explore/i.test(desc),
      `说明要讲清它限制的是扫描范围: ${desc}`,
    );
    assert.match(
      desc,
      /fewer results|不是.*条数|not.*cap/i,
      `要明说不能拿它要「更少的结果」: ${desc}`,
    );
  });
});
