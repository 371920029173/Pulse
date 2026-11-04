/*
 * 任务树的工具面：tree_create / tree_add / tree_update / tree_get / tree_ask / tree_report
 * 以及多棵树之后的 tree_list / tree_switch / tree_delete。
 *
 * 注册方式跟随 plan-tools 的 `reg(def, fn)` 约定，因此可以直接挂在同一个工具集里
 * （用户要求："模型侧的按键和计划放一块就好"）。
 *
 * 多棵树的理由（用户 2026-11-04）：一个会话里常常有**几件互不相干的活**。原来 tree_create
 * 第二棵会被拒，模型只好把新活硬塞进旧树里，旧树的进度就被搅成一团 —— 拒绝创建不是约束，
 * 是逼着调用方造假。现在 create 总是新建并把新树设为当前树，切换/删除各有一个工具，
 * 只有"删到一棵不剩"才拒绝（见 task-tree.ts 的 remove）。
 */
import { TaskTreeStore, type TreeStatus, type TreeNode, type TreeFile } from './task-tree.js';
import type { ToolDefinition } from '@she/shared';

type Reg = (def: ToolDefinition, fn: (a: Record<string, unknown>) => Promise<string>) => void;

const MARK: Record<TreeStatus, string> = {
  pending: '[ ]', active: '[>]', blocked: '[!]', shelved: '[~]', done: '[x]', dropped: '[-]',
};

function line(n: TreeNode, depth: number): string {
  const ev = n.evidence.length ? `  证据 ${n.evidence.length} 条` : (n.status === 'done' ? '  ⚠ 无证据' : '');
  const q = n.questions.filter((x) => !x.answeredAt).length ? `  ❓待答 ${n.questions.filter((x) => !x.answeredAt).length}` : '';
  const tries = n.attempts ? `  已试 ${n.attempts} 次` : '';
  return `${'  '.repeat(depth)}${MARK[n.status]} ${n.id} ${n.title}${ev}${q}${tries}${n.note ? `  — ${n.note}` : ''}`;
}

/**
 * 树的只读渲染：按父子顺序展开，末尾附待答问题与最近决策。
 *
 * `index` / `total` 是"这是第几棵、一共几棵"（多棵树之后必须有，否则模型看到一份渲染
 * 根本不知道自己现在站在哪棵树上，而 tree_update 又只作用于当前那棵 —— 那是会写错的）。
 */
export function renderTree(file: TreeFile, opts?: { trail?: boolean; index?: number; total?: number }): string {
  const lines: string[] = [];
  /*
   * 根节点不算"任务"：它是目标本身，状态永远是 active，要等 tree_report 才收口。
   * 原来分母用 file.nodes.length，于是"7 个子任务做完、只差收口"也显示成 0/8 ——
   * 用户看到的就是"这树怎么一直不动"（2026-11-03 实测）。
   */
  const tasks = file.nodes.filter((n) => n.id !== file.rootId);
  const done = tasks.filter((n) => n.status === 'done').length;
  /*
   * 第 N 棵/共 M 棵插在计数**之前**、用 `·` 隔开，且不改动后半段（"…/… 完成"）。
   * 现有判据（scripts/tree-check.mjs ⑮）是按 `/2\/2 完成/` 匹配的，动后半段就是
   * 把一条与本改动无关的断言弄坏。
   */
  const where = opts?.index && opts.total ? ` · 第 ${opts.index} 棵/共 ${opts.total} 棵` : '';
  lines.push(`任务树（会话 ${file.sessionId}）${where} — ${done}/${tasks.length} 完成`);
  const byParent = new Map<string | null, TreeNode[]>();
  for (const n of file.nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  const walk = (id: string | null, depth: number): void => {
    for (const n of byParent.get(id) ?? []) {
      lines.push(line(n, depth));
      walk(n.id, depth + 1);
    }
  };
  /*
   * 先把根节点（目标本身）打出来，再走子节点。
   *
   * `walk(rootId, 0)` 是"列出 rootId 的子节点"，根自己永远不在里面 —— 于是一棵只建了
   * "目标 + 一个子任务"的树会把目标那一行整个藏掉，而计数却是 2。
   */
  const rootNode = file.nodes.find((n) => n.id === file.rootId);
  if (rootNode) lines.push(line(rootNode, 0));
  walk(file.rootId, 0);

  const pendingQ = file.nodes.flatMap((n) => n.questions.filter((q) => !q.answeredAt).map((q) => ({ n, q })));
  if (pendingQ.length) {
    lines.push('', '待答问题：');
    for (const { n, q } of pendingQ) {
      lines.push(`  ${q.id}（节点 ${n.id}）${q.text}`);
      lines.push(`     选项: ${q.options.join(' / ')}；推荐: ${q.recommend}；不可逆: ${q.reversible ? '否' : '是'}；截止 ${q.deadlineAt.slice(11, 16)}`);
    }
  }
  if (opts?.trail) {
    const events = file.nodes.flatMap((n) => n.log.map((l) => ({ id: n.id, ...l }))).slice(-10).reverse();
    if (events.length) {
      lines.push('', '最近状态变更（新 → 旧）：');
      for (const e of events) lines.push(`  ${e.at.slice(5, 16).replace('T', ' ')}  ${e.id}: ${e.from} → ${e.to}${e.note ? `  — ${e.note}` : ''}`);
    }
    const auto = file.nodes.flatMap((n) => n.decisions.filter((d) => d.auto).map((d) => ({ id: n.id, ...d })));
    if (auto.length) {
      lines.push('', '自动决策（无人值守期间替你做的）：');
      for (const d of auto) lines.push(`  ${d.id}: ${d.choice} — ${d.why}`);
    }
  }
  return lines.join('\n');
}

export function registerTaskTreeTools(
  reg: Reg,
  store: TaskTreeStore,
  opts?: { startedAt?: number },
): void {
  const startedAt = opts?.startedAt ?? Date.now();

  /**
   * 渲染当前树，并顺带标出"第几棵/共几棵"。
   *
   * 每次渲染多读一次所有树文件（`store.list()`），几棵树的规模下完全可以接受 ——
   * 换来的是模型永远知道自己在哪棵树上，这个信息比那几毫秒值钱。
   */
  const render = (file: TreeFile, extra?: { trail?: boolean }): string => {
    const all = store.list();
    const idx = all.findIndex((t) => t.active) + 1;
    return renderTree(file, { ...extra, index: idx > 0 ? idx : 1, total: all.length });
  };

  /* ── tree_create ── */
  reg(
    {
      name: 'tree_create',
      description: 'Create a task tree for THIS conversation and make it the current tree. '
        + 'You may have SEVERAL trees in one conversation: calling this always creates a NEW one (even if a tree already exists) '
        + 'and switches to it, so the previous tree stays untouched — use tree_list / tree_switch / tree_delete to work between them. '
        + 'Use it for unattended long work: you are expected to decide and solve things yourself, and only report at the exit '
        + '(all done / truly blocked / budget exhausted). Unlike plan_*, the tree is not pushed step by step; you grow it as you go '
        + 'with tree_add (subtask under a node, or a sibling of it).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The goal (root node)' },
          intent: { type: 'string', description: 'Why this goal exists / what "done" means' },
          subtasks: { type: 'array', items: { type: 'string' }, description: 'Optional initial subtasks' },
        },
        required: ['title'],
      },
    },
    async (a) => {
      try {
        const file = store.createNew(String(a.title), a.intent ? String(a.intent) : undefined,
          Array.isArray(a.subtasks) ? (a.subtasks as string[]).map(String) : []);
        return `已新建一棵任务树（id ${store.activeId()}），它就是当前树。\n${render(file)}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_list ── */
  reg(
    {
      name: 'tree_list',
      description: 'List every task tree in this conversation: id, goal, done/total nodes, how many reports it has, when it was last '
        + 'updated, and which one is CURRENT (the tree that tree_add / tree_update / tree_get / tree_report operate on). '
        + 'Use it before tree_switch / tree_delete, or when you are unsure which tree you are working on.',
      parameters: { type: 'object', properties: {} },
    },
    async () => {
      const all = store.list();
      if (!all.length) return '这个会话还没有任务树（先 tree_create）';
      const rows = all.map((t) => `${t.active ? '▶' : ' '} ${t.id}  ${t.title}  — ${t.done}/${t.total} 完成`
        + `${t.reports ? `，已汇报 ${t.reports} 次` : ''}  更新于 ${t.updatedAt.slice(0, 16).replace('T', ' ')}`);
      return [
        `任务树共 ${all.length} 棵（▶ = 当前树，tree_* 都作用于它）：`,
        ...rows,
        '',
        '切换用 tree_switch（id）；删掉某一棵用 tree_delete（id，至少保留一棵）。',
      ].join('\n');
    },
  );

  /* ── tree_switch ── */
  reg(
    {
      name: 'tree_switch',
      description: 'Make another task tree the CURRENT one. Everything (tree_add / tree_update / tree_get / tree_report, and the '
        + 'autopilot that continues the work) then acts on the switched-to tree; the tree you left keeps its state untouched. '
        + 'The id comes from tree_list.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Tree id from tree_list' } },
        required: ['id'],
      },
    },
    async (a) => {
      try {
        const file = store.switch(String(a.id));
        return `已切换到任务树 ${String(a.id)}。现在 tree_* 都作用于它。\n${render(file)}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_delete ── */
  reg(
    {
      name: 'tree_delete',
      description: 'Delete one task tree by id (a tree that has become irrelevant: finished, superseded, or a mistaken one). '
        + 'Refused when it is the LAST tree in this conversation — at least one must remain, because every other tree_* tool acts on '
        + 'the current tree. Deleting the current tree moves the pointer to another one. This cannot be undone.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Tree id from tree_list' } },
        required: ['id'],
      },
    },
    async (a) => {
      try {
        const { id, activeId } = store.remove(String(a.id));
        const after = store.get();
        const head = `已删除任务树 ${id}；当前树改成 ${activeId}。`;
        return after ? `${head}\n${render(after)}` : head;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_add ── */
  reg(
    {
      name: 'tree_add',
      description: 'Grow the CURRENT tree while working: a SUBTASK (parentId) or a SIBLING of an existing node (siblingOf). '
        + 'Add nodes when you discover work that the plan did not foresee — that is the point of the tree. '
        + 'If the work belongs to a different goal, tree_create a new tree instead of hanging it here.',
      parameters: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: 'Add as a child of this node' },
          siblingOf: { type: 'string', description: 'Add as a sibling of this node (same parent)' },
          title: { type: 'string' },
          intent: { type: 'string', description: 'Why this node is needed' },
        },
        required: ['title'],
      },
    },
    async (a) => {
      try {
        const n = store.add({
          parentId: a.parentId ? String(a.parentId) : undefined,
          siblingOf: a.siblingOf ? String(a.siblingOf) : undefined,
          title: String(a.title),
          intent: a.intent ? String(a.intent) : undefined,
        });
        return `已加节点 ${n.id}「${n.title}」（父 ${n.parentId ?? '—'}）。\n${render(store.get()!)}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_update ── */
  reg(
    {
      name: 'tree_update',
      description: 'Update one node of the CURRENT tree: status, note, evidence (a command and its exit code, a file:line, a test result), '
        + 'or record a decision (choice + why, and whether it was made automatically). A node marked done without evidence is flagged.',
      parameters: {
        type: 'object',
        properties: {
          halt: { type: 'boolean', description: '急停：立刻停止自动续跑（不需要重启后端）。用 note 说明原因。' },
          resume: { type: 'boolean', description: '解除急停，让自动续跑恢复。' },
          id: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'active', 'blocked', 'shelved', 'done', 'dropped'] },
          note: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          decision: {
            type: 'object',
            properties: {
              choice: { type: 'string' },
              why: { type: 'string' },
              auto: { type: 'boolean', description: 'true when you decided this on your own because nobody is watching' },
            },
            required: ['choice', 'why'],
          },
        },
        required: ['id'],
      },
    },
    async (a) => {
      /* 急停 / 恢复：这条路必须能在不重启后端的情况下用，否则卡住的循环只能靠重启收场。 */
      if (a.halt === true || a.resume === true) {
        if (a.halt === true) store.halt(String(a.note ?? '用户/模型主动急停'));
        else store.resume();
        const after = store.get();
        return (a.halt === true ? '已急停：自动续跑停止。' : '已恢复：自动续跑继续。') + '\n' + (after ? render(after) : '（还没有任务树）');
      }
      try {
        const n = store.update(String(a.id), {
          status: a.status ? String(a.status) as TreeStatus : undefined,
          note: a.note !== undefined ? String(a.note) : undefined,
          evidence: Array.isArray(a.evidence) ? (a.evidence as string[]).map(String) : undefined,
          decision: a.decision && typeof a.decision === 'object'
            ? {
              choice: String((a.decision as Record<string, unknown>).choice ?? ''),
              why: String((a.decision as Record<string, unknown>).why ?? ''),
              auto: (a.decision as Record<string, unknown>).auto === true,
            }
            : undefined,
        });
        return `${n.id} → ${n.status}\n${render(store.get()!)}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_get ── */
  reg(
    {
      name: 'tree_get',
      description: 'Read the CURRENT tree: nodes, statuses, pending questions (with their deadline), and — with trail — the recent '
        + 'status changes and the decisions taken automatically. The header says which tree it is (第 N 棵/共 M 棵); '
        + 'use tree_list to see the others and tree_switch to change which one this is.',
      parameters: {
        type: 'object',
        properties: { trail: { type: 'boolean', description: 'Include recent transitions and automatic decisions' } },
      },
    },
    async (a) => {
      const swept = store.sweep();
      const file = store.get();
      if (!file) {
        const r = store.recoveryInfo();
        return r ? `⚠ 任务树文件读不懂，已隔离到 ${r.backup}（${r.reason}）` : '还没有任务树（先 tree_create）';
      }
      const head = swept.auto.length
        ? `（无人值守：${swept.auto.length} 个超时问题按「相信」自动采纳了推荐值）\n`
        : swept.blocked ? '（有 blocking 问题超时未答且策略为「不相信」→ 这棵树的某个分支无法继续）\n' : '';
      /*
       * 预算到顶时把话说到「必须收口」这一层：只写"超时了"模型会继续做下一步，
       * 而这条信息出现的唯一理由就是让它停手汇报。
       */
      const budget = store.budget();
      const must = budget.exhausted ? `⛔ 到这里为止：${budget.reason} —— 现在必须 tree_report（summary/outcome 会自动判成 partial 或 blocked），不要再加节点、不要再开新分支。\n` : '';
      return head + must + render(file, { trail: a.trail === true });
    },
  );

  /* ── tree_ask ── */
  reg(
    {
      name: 'tree_ask',
      description: 'Ask ONE question while unattended, then keep working: the branch is shelved, other branches continue. '
        + 'Give options plus your recommended one. If nobody answers within the timeout: with the "trust" setting your recommendation '
        + 'is taken (and logged as automatic); with "do not trust" it stays shelved. A question you mark reversible=false (delete, '
        + 'overwrite uncommitted work, force push, anything outward-facing) is NEVER auto-answered — it always waits for a human.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node the question belongs to' },
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommend: { type: 'string', description: 'What you would pick if nobody answers' },
          blocking: { type: 'boolean', description: 'true = without an answer this node (and maybe the tree) cannot continue' },
          reversible: { type: 'boolean', description: 'false = irreversible; then it is never auto-answered' },
        },
        required: ['id', 'text', 'recommend'],
      },
    },
    async (a) => {
      try {
        /*
         * 不给 id 就挂到"正在做的那个节点"：无人值守时的提问总是关于手上这条分支，
         * 而漏传 id 换来一句"没有这个节点：undefined"对模型没有任何信息量。
         */
        const treeNow = store.get();
        const fallback = treeNow?.nodes.find((n) => n.status === 'active')
          ?? treeNow?.nodes.find((n) => n.status !== 'done' && n.status !== 'dropped');
        const nodeId = String(a.id ?? '') || fallback?.id || '';
        if (!nodeId) return 'Error: 树里没有可挂的节点 —— 先 tree_create，或用 id 指定一个节点';
        const q = store.ask(nodeId, {
          text: String(a.text),
          options: Array.isArray(a.options) ? (a.options as string[]).map(String) : [],
          recommend: String(a.recommend),
          blocking: a.blocking === true,
          reversible: a.reversible !== false,
        });
        return `已提问 ${q.id}（节点 ${nodeId}），截止 ${q.deadlineAt}。`
          + `\n${q.reversible ? '到期按设置处理（相信→自动采纳，不相信→继续搁置）' : '这是不可逆问题：**永远不会**自动采纳，只会等你回答'}`
          + (q.blocking ? '\n标记为 blocking：若到期仍无人回答且设置为「不相信」，这棵树的该分支将判定无法继续。' : '');
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_report ── */
  reg(
    {
      name: 'tree_report',
      description: 'The ONLY way a task tree ends: report at the exit of the CURRENT tree. Three exits — everything done, truly blocked, '
        + 'or budget exhausted (partial). Include per-node evidence, the decisions you took automatically, the questions left shelved, and '
        + 'what you did not verify. Reporting closes THIS tree only; another tree in the same conversation keeps its own state.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What is now true' },
          open: { type: 'array', items: { type: 'string' }, description: 'What is NOT done / NOT verified, each naming what would settle it' },
        },
        required: ['summary'],
      },
    },
    async (a) => {
      const file = store.get();
      if (!file) return '还没有任务树（先 tree_create）';
      const { outcome, reason } = store.outcome(startedAt);
      const done = file.nodes.filter((n) => n.status === 'done');
      const noEvidence = done.filter((n) => !n.evidence.length);
      const shelved = file.nodes.filter((n) => n.status === 'shelved');
      const auto = file.nodes.flatMap((n) => n.decisions.filter((d) => d.auto).map((d) => `${n.id}: ${d.choice}`));
      const open = Array.isArray(a.open) ? (a.open as string[]).map(String) : [];
      const parts = [
        `## 结论`,
        String(a.summary),
        '',
        `## 出口判定：${outcome}（${reason}）`,
        `完成 ${done.length}/${file.nodes.length} 个节点`,
        '',
        '## 证据（逐节点）',
        ...(done.length
          ? done.map((n) => `- ${n.id} ${n.title}: ${n.evidence.length ? n.evidence.join('；') : '⚠ 无证据'}`)
          : ['（没有完成的节点）']),
        '',
        '## 自动决策（无人值守期间做的）',
        ...(auto.length ? auto.map((x) => `- ${x}`) : ['（无）']),
        '',
        '## 仍然搁置的问题',
        ...(shelved.length
          ? shelved.flatMap((n) => n.questions.filter((q) => !q.answeredAt).map((q) => `- ${n.id} ${q.text}（推荐 ${q.recommend}，不可逆 ${q.reversible ? '否' : '是'}）`))
          : ['（无）']),
        '',
        '## 未完成 / 未验证',
        ...(open.length ? open.map((x) => `- ${x}`) : ['（无）']),
      ];
      if (noEvidence.length) {
        parts.push('', `⚠ 有 ${noEvidence.length} 个节点标了 done 却没有证据：${noEvidence.map((n) => n.id).join('、')}`
          + '（把证据补上，或把它改成 dropped 并说明原因）');
      }
      store.recordReport(outcome, String(a.summary));
      return parts.join('\n');
    },
  );
}
