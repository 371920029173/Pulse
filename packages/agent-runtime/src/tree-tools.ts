/*
 * 任务树的工具面：tree_create / tree_add / tree_update / tree_get / tree_ask / tree_report。
 *
 * 注册方式跟随 plan-tools 的 `reg(def, fn)` 约定，因此可以直接挂在同一个工具集里
 * （用户要求："模型侧的按键和计划放一块就好"）。
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

/** 树的只读渲染：按父子顺序展开，末尾附待答问题与最近决策。 */
export function renderTree(file: TreeFile, opts?: { trail?: boolean }): string {
  const lines: string[] = [];
  const done = file.nodes.filter((n) => n.status === 'done').length;
  lines.push(`任务树（会话 ${file.sessionId}）— ${done}/${file.nodes.length} 完成`);
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

  /* ── tree_create ── */
  reg(
    {
      name: 'tree_create',
      description: 'Create the task tree for THIS conversation (one tree per chat; it does not sync across chats). '
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
        const file = store.create(String(a.title), a.intent ? String(a.intent) : undefined,
          Array.isArray(a.subtasks) ? (a.subtasks as string[]).map(String) : []);
        return renderTree(file);
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_add ── */
  reg(
    {
      name: 'tree_add',
      description: 'Grow the tree while working: a SUBTASK (parentId) or a SIBLING of an existing node (siblingOf). '
        + 'Add nodes when you discover work that the plan did not foresee — that is the point of the tree.',
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
        return `已加节点 ${n.id}「${n.title}」（父 ${n.parentId ?? '—'}）。\n${renderTree(store.get()!)}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_update ── */
  reg(
    {
      name: 'tree_update',
      description: 'Update one node: status, note, evidence (a command and its exit code, a file:line, a test result), '
        + 'or record a decision (choice + why, and whether it was made automatically). A node marked done without evidence is flagged.',
      parameters: {
        type: 'object',
        properties: {
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
        return `${n.id} → ${n.status}\n${renderTree(store.get()!)}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  );

  /* ── tree_get ── */
  reg(
    {
      name: 'tree_get',
      description: 'Read the tree: nodes, statuses, pending questions (with their deadline), and — with trail — the recent '
        + 'status changes and the decisions taken automatically.',
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
      const must = budget.exhausted ? `⛔ 预算用尽：${budget.reason} —— 现在必须 tree_report（summary/outcome 会自动判成 partial 或 blocked），不要再加节点、不要再开新分支。\n` : '';
      return head + must + renderTree(file, { trail: a.trail === true });
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
      description: 'The ONLY way a task tree ends: report at the exit. Three exits — everything done, truly blocked, or budget '
        + 'exhausted (partial). Include per-node evidence, the decisions you took automatically, the questions left shelved, and '
        + 'what you did not verify.',
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
      file.reports.push({ at: new Date().toISOString(), outcome, summary: String(a.summary) });
      return parts.join('\n');
    },
  );
}
