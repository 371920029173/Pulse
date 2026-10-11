/**
 * 知识图谱（实验功能）：把 KB 的组树摊成一张白板。
 *
 * 这一版（s2）只管**看与走**：节点与连线、拖动、双击进层、上一级、左上角路线图。
 * 节点上的**改动**（改名/移动/合并/编辑正文……）走 s3 的"操作序列 + 保存并确认"，
 * 所以这里双击记忆只是选中它 —— 不做没有落点的假动作。
 *
 * 视口语义（与用户给的 A/B/C/D/E/F 例子一致）：
 *   · 当前层 = 当前组本身 + 它的直接子组 + 它这一层的记忆
 *   · 当前组**标亮**；它的子组与记忆是**正常色**；其余（兄弟分支、更深的层）**变灰**且不进交互
 *   · 根视图（current = null）= 所有顶层组；组树的上层用"祖先链"表示，双击祖先即返回那一层
 *
 * 数据来源：结构来自 /api/kb/tree（嵌套 GroupTreeNode，树里**不含记忆**），
 * 某一层的记忆来自 /api/kb/groups/:id（返回 { group, children, memories }）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { t } from '../lib/i18n';
import styles from '../styles/KnowledgeGraph.module.css';

/** 与 server 的 GroupTreeNode 对齐（树里只有计数，没有记忆本身）。 */
interface TreeNode {
  id: string;
  name: string;
  children: TreeNode[];
  memoryCount: number;
  isDormant?: boolean;
}
interface Memory {
  id: string;
  title: string;
  kind?: string;
  isRetired?: boolean;
}
interface LevelData {
  group: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
  memories: Memory[];
}

interface NodeView {
  id: string;
  kind: 'group' | 'memory';
  name: string;
  /** current=当前组；scope=当前层的孩子（正常色）；ancestor=祖先（可点着返回）；dim=其他（灰）。 */
  state: 'current' | 'scope' | 'ancestor' | 'dim';
  depth: number;
}

/** 与 server 的 KbOp 同形（界面不 import @she/kb —— 那是后端的包）。 */
type PendingOp =
  | { kind: 'renameGroup'; id: string; name: string }
  | { kind: 'moveGroup'; id: string; parentId: string | null }
  | { kind: 'copyGroup'; id: string; parentId: string | null }
  | { kind: 'mergeGroups'; from: string; into: string }
  | { kind: 'createGroup'; name: string; parentId: string | null }
  | { kind: 'updateMemory'; id: string; title?: string; content?: string };

/** 把一条待同步操作描述成人话（列表里逐条给用户看）。 */
function describeOp(op: PendingOp, nameOf: (id: string) => string): string {
  switch (op.kind) {
    case 'renameGroup': return t('改名：{name}', { name: nameOf(op.id) });
    case 'moveGroup': return t('移动：{name}', { name: nameOf(op.id) });
    case 'copyGroup': return t('复制：{name}', { name: nameOf(op.id) });
    case 'mergeGroups': return t('合并：{from} → {into}', { from: nameOf(op.from), into: nameOf(op.into) });
    case 'createGroup': return t('新建组：{name}', { name: op.name });
    case 'updateMemory': return t('改正文');
    default: return t('操作');
  }
}

interface Props {
  onClose: () => void;
  /** 双击记忆时交给上级（s3 里打开编辑面板）。 */
  onOpenMemory?: (id: string) => void;
}

const NODE_W = 168;
const NODE_H = 46;

/** 把嵌套树摊平成 id → 父 id 的映射，顺便记住每个节点在第几层。 */
function indexTree(roots: TreeNode[]): { parent: Map<string, string | null>; depth: Map<string, number> } {
  const parent = new Map<string, string | null>();
  const depth = new Map<string, number>();
  const walk = (nodes: TreeNode[], p: string | null, d: number) => {
    for (const n of nodes) {
      parent.set(n.id, p);
      depth.set(n.id, d);
      walk(n.children ?? [], n.id, d + 1);
    }
  };
  walk(roots, null, 0);
  return { parent, depth };
}

/*
 * 类名走**静态查表**而不是 styles[state]：动态拼的类名死 CSS 棘轮看不见，
 * 会把 .current/.scope/.ancestor/.dim 报成没人用的类（仓库为这类误判吃过一次亏）。
 */
const STATE_CLASS: Record<NodeView['state'], string> = {
  current: styles.current,
  scope: styles.scope,
  ancestor: styles.ancestor,
  dim: styles.dim,
};
const KIND_CLASS = { group: '', memory: styles.memory } as const;

export function KnowledgeGraph({ onClose, onOpenMemory }: Props) {
  useEscapeToClose(onClose);

  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [level, setLevel] = useState<LevelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** 用户拖过的位置；没拖过的按布局算。拖动只改这里，不落库（s3 的改动才落库）。 */
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  /** 待同步的操作序列 —— 在点「确认同步」之前，一条都不落库。 */
  const [ops, setOps] = useState<PendingOp[]>([]);
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; id: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string; content: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 最近一次同步落下的快照路径 —— 有它才有"回滚到同步前"。 */
  const [lastSnapshot, setLastSnapshot] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const loadTree = useCallback(() => {
    fetchJSON<{ roots?: TreeNode[] } | TreeNode[]>('/api/kb/tree')
      .then((r) => setTree(Array.isArray(r) ? r : (r.roots ?? [])))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => { loadTree(); }, [loadTree]);

  // 当前层的详细信息（含记忆）；根视图不需要
  useEffect(() => {
    if (!current) { setLevel(null); return; }
    let alive = true;
    fetchJSON<LevelData>(`/api/kb/groups/${encodeURIComponent(current)}`)
      .then((d) => { if (alive) setLevel(d); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [current]);

  const { parent, depth } = useMemo(() => indexTree(tree ?? []), [tree]);

  /** 这一层要画哪些节点，各自什么状态。 */
  const views = useMemo<NodeView[]>(() => {
    if (!tree) return [];
    const out: NodeView[] = [];
    const seen = new Set<string>();
    const push = (id: string, name: string, state: NodeView['state'], d: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, kind: 'group', name, state, depth: d });
    };

    const all = new Map<string, TreeNode>();
    const collect = (nodes: TreeNode[]) => { for (const n of nodes) { all.set(n.id, n); collect(n.children ?? []); } };
    collect(tree);

    if (!current) {
      /*
       * 根视图：顶层组各自都是"当前"，**并把它们的直接子组也画出来**。
       * 用户给的例子是「根组下有 A、B，那此时白板上就只展示根组、A、B 三个节点」——
       * 即比顶层多一层；只画顶层的话，双击进层之前什么都看不到。
       */
      for (const n of tree) {
        push(n.id, n.name, 'current', 0);
        for (const c of n.children ?? []) push(c.id, c.name, 'scope', 1);
      }
    } else {
      // 祖先链（含当前组）：当前标亮，其余祖先可点着返回
      const chain: string[] = [];
      let walkId: string | null = current;
      while (walkId) { chain.unshift(walkId); walkId = parent.get(walkId) ?? null; }
      for (const id of chain) {
        const n = all.get(id);
        if (n) push(id, n.name, id === current ? 'current' : 'ancestor', depth.get(id) ?? 0);
      }
      // 当前层的子组 + 记忆
      for (const c of level?.children ?? []) push(c.id, c.name ?? '?', 'scope', (depth.get(current) ?? 0) + 1);
      for (const m of level?.memories ?? []) {
        if (m.isRetired) continue;
        out.push({ id: m.id, kind: 'memory', name: m.title, state: 'scope', depth: (depth.get(current) ?? 0) + 1 });
      }
      // 兄弟分支：只画它们的根，灰色的"这里还有别的东西"
      const parentId = parent.get(current) ?? null;
      const siblings = parentId ? (all.get(parentId)?.children ?? []) : tree;
      for (const s of siblings) {
        if (s.id === current) continue;
        // 兄弟分支：连它的直接子组一起画成灰的（用户例子里的 B/E/F 就是这三位）
        push(s.id, s.name, 'dim', depth.get(s.id) ?? 0);
        for (const c of s.children ?? []) push(c.id, c.name, 'dim', (depth.get(s.id) ?? 0) + 1);
      }
    }

    // 算不完的部分只报个数（灰节点太多会糊成一片）
    const MAX_DIM = 40;
    const dims = out.filter((v) => v.state === 'dim');
    if (dims.length > MAX_DIM) {
      const keep = new Set(dims.slice(0, MAX_DIM).map((v) => v.id));
      return out.filter((v) => v.state !== 'dim' || keep.has(v.id));
    }
    return out;
  }, [tree, current, level, parent, depth]);

  const hiddenDimCount = useMemo(() => {
    if (!tree) return 0;
    const total = (() => { let n = 0; const walk = (nodes: TreeNode[]) => { for (const x of nodes) { n++; walk(x.children ?? []); } }; walk(tree); return n; })();
    return Math.max(0, total - views.length);
  }, [tree, views.length]);

  /** 自动布局：当前/祖先走一条竖线，孩子铺一排，记忆再一排。拖过的用拖过的位置。 */
  const layout = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    const cur = views.filter((v) => v.state === 'current' || v.state === 'ancestor');
    cur.forEach((v, i) => { pos[v.id] = { x: 40, y: 40 + i * (NODE_H + 16) }; });
    const scopeGroups = views.filter((v) => v.state === 'scope' && v.kind === 'group');
    const scopeMems = views.filter((v) => v.state === 'scope' && v.kind === 'memory');
    scopeGroups.forEach((v, i) => { pos[v.id] = { x: 260 + i * (NODE_W + 20), y: 40 }; });
    scopeMems.forEach((v, i) => { pos[v.id] = { x: 260 + i * (NODE_W + 20), y: 40 + NODE_H + 24 }; });
    const dims = views.filter((v) => v.state === 'dim');
    dims.forEach((v, i) => { pos[v.id] = { x: 260 + (i % 6) * (NODE_W + 20), y: 40 + 2 * (NODE_H + 40) + Math.floor(i / 6) * (NODE_H + 20) }; });
    return pos;
  }, [views]);

  const posOf = (id: string) => moved[id] ?? layout[id] ?? { x: 40, y: 40 };

  /** 连线：谁连着谁（当前组→它的孩子；祖先→下一个祖先；根视图不画线）。 */
  const edges = useMemo(() => {
    const out: Array<{ a: string; b: string }> = [];
    if (!current) {
      // 根视图的连线：顶层组 → 它的直接子组（与上面多画的那一层对应）
      for (const n of tree ?? []) for (const c of n.children ?? []) out.push({ a: n.id, b: c.id });
      return out;
    }
    for (const v of views) {
      if (v.state === 'scope') out.push({ a: current, b: v.id });
      else if (v.state === 'ancestor') {
        const child = views.find((x) => (parent.get(x.id) ?? null) === v.id && x.state !== 'dim');
        if (child) out.push({ a: v.id, b: child.id });
      }
    }
    return out;
  }, [views, current, parent]);

  const onPointerDown = (v: NodeView, e: React.PointerEvent) => {
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const p = posOf(v.id);
    dragRef.current = { id: v.id, dx: e.clientX - rect.left - p.x, dy: e.clientY - rect.top - p.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const board = boardRef.current;
    if (!d || !board) return;
    const rect = board.getBoundingClientRect();
    setMoved((m) => ({ ...m, [d.id]: { x: Math.max(0, e.clientX - rect.left - d.dx), y: Math.max(0, e.clientY - rect.top - d.dy) } }));
  };
  const endDrag = () => { dragRef.current = null; };

  const nameOf = (id: string) => views.find((v) => v.id === id)?.name ?? '';
  const targetParent = current ?? null;

  /** 统一的入口：所有改动都只进待同步序列。 */
  const addOp = (op: PendingOp) => { setOps((list) => [...list, op]); setNotice(null); };

  const paste = () => {
    if (!clipboard) return;
    addOp(clipboard.mode === 'copy'
      ? { kind: 'copyGroup', id: clipboard.id, parentId: targetParent }
      : { kind: 'moveGroup', id: clipboard.id, parentId: targetParent });
    if (clipboard.mode === 'cut') setClipboard(null);
  };

  const saveAll = async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await fetchJSON<{ snapshot: string; applied: number; failedAt: number | null; error: string | null }>(
        '/api/kb/batch', { method: 'POST', body: { ops } });
      setLastSnapshot(r.snapshot);
      if (r.failedAt === null) {
        setOps([]); setNotice(t('已同步 {n} 项改动（快照：可回滚）', { n: r.applied }));
      } else {
        setNotice(t('同步在第 {n} 项失败：{message}（可回滚到同步前）', { n: r.failedAt + 1, message: r.error ?? '' }));
      }
      loadTree();
    } catch (e) {
      setNotice(t('同步失败：{message}', { message: (e as Error).message }));
    } finally { setBusy(false); setConfirming(false); }
  };

  const rollback = async () => {
    if (!lastSnapshot) return;
    setBusy(true); setNotice(null);
    try {
      await fetchJSON('/api/kb/rollback', { method: 'POST', body: { snapshot: lastSnapshot } });
      setLastSnapshot(null); setOps([]); setEditing(null); setRenaming(null);
      setNotice(t('已回滚到最近一次同步之前'));
      loadTree();
    } catch (e) {
      setNotice(t('回滚失败：{message}', { message: (e as Error).message }));
    } finally { setBusy(false); }
  };

  const enter = (v: NodeView) => {
    setSelected(v.id);
    if (v.kind === 'memory') {
      // 树里的记忆只有标题，正文要另取（/api/kb/memories/:id 返回完整节点）
      void fetchJSON<{ id: string; title?: string; content?: string }>(`/api/kb/memories/${encodeURIComponent(v.id)}`)
        .then((m) => setEditing({ id: m.id, title: m.title ?? '', content: m.content ?? '' }))
        .catch((e: Error) => setNotice(t('打不开这条记忆：{message}', { message: e.message })));
      onOpenMemory?.(v.id);
      return;
    }
    setCurrent(v.id);
  };
  const goUp = () => setCurrent((c) => (c ? (parent.get(c) ?? null) : null));

  const crumb = useMemo(() => {
    if (!current) return [];
    const chain: Array<{ id: string | null; name: string }> = [{ id: null, name: t('目录根') }];
    const ids: string[] = [];
    let walkId: string | null = current;
    while (walkId) { ids.unshift(walkId); walkId = parent.get(walkId) ?? null; }
    for (const id of ids) {
      const v = views.find((x) => x.id === id);
      chain.push({ id, name: v?.name ?? id.slice(0, 6) });
    }
    return chain;
  }, [current, parent, views]);

  return (
    <div className={styles.panel} role="dialog" aria-label={t('知识图谱')}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t('知识图谱（实验）')}</h2>
        <div className={styles.crumb} aria-label={t('当前位置')}>
          {crumb.map((c, i) => (
            <span key={c.id ?? 'root'} className={styles.crumbItem}>
              {i > 0 ? <span className={styles.crumbSep}>/</span> : null}
              <button
                type="button"
                className={`${styles.crumbBtn} ${i === crumb.length - 1 ? styles.crumbNow : ''}`}
                onClick={() => setCurrent(c.id)}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>
        <button type="button" className={styles.chip} onClick={goUp} disabled={!current}>
          {t('上一级')}
        </button>
        <span className={styles.pending}>
          {ops.length ? t('待同步 {n} 项', { n: ops.length }) : t('没有待同步的改动')}
          {ops.length ? <button type="button" className={styles.linkBtn} onClick={() => setOps([])}>{t('清空')}</button> : null}
        </span>
        <button type="button" className={styles.chip} onClick={() => setConfirming(true)} disabled={busy || !ops.length}>
          {t('保存并确认')}
        </button>
        <button type="button" className={styles.chip} onClick={() => void rollback()} disabled={busy || !lastSnapshot}>
          {t('回滚到同步前')}
        </button>
        <button type="button" className={styles.chip} onClick={onClose}>{t('关闭')}</button>
      </div>

      {confirming ? (
        <div className={styles.confirm}>
          {t('将按顺序应用 {n} 项改动，并先落一份整库快照（同步后仍可回滚）：', { n: ops.length })}
          <ul className={styles.opList}>
            {ops.map((op, i) => <li key={i} className={styles.opItem}>{describeOp(op, nameOf)}</li>)}
          </ul>
          <button type="button" className={styles.chip} onClick={() => void saveAll()} disabled={busy}>{t('确认同步')}</button>
          <button type="button" className={styles.chip} onClick={() => setConfirming(false)}>{t('取消')}</button>
        </div>
      ) : null}

      <p className={styles.hint}>
        {t('拖动节点可移动位置；双击组进入它，双击祖先（或左上角的层级）返回那一层；灰色的节点不在当前层。')}
      </p>
      {error ? <div className={styles.error}>{t('加载失败：{message}', { message: error })}</div> : null}

      {notice ? <div className={styles.notice}>{notice}</div> : null}

      <div className={styles.ops}>
        <span className={styles.opsLabel}>{t('操作')}</span>
        <button type="button" className={styles.chip} disabled={!selected} onClick={() => {
          const v = views.find((x) => x.id === selected);
          if (v?.kind === 'group') setRenaming({ id: v.id, name: v.name });
        }}>{t('改名')}</button>
        <button type="button" className={styles.chip} disabled={!selected} onClick={() => {
          const v = views.find((x) => x.id === selected);
          if (v?.kind === 'group') setClipboard({ mode: 'copy', id: v.id });
        }}>{t('复制')}</button>
        <button type="button" className={styles.chip} disabled={!selected} onClick={() => {
          const v = views.find((x) => x.id === selected);
          if (v?.kind === 'group') setClipboard({ mode: 'cut', id: v.id });
        }}>{t('剪切')}</button>
        <button type="button" className={styles.chip} disabled={!clipboard} onClick={paste}>{t('粘贴到这里')}</button>
        <button type="button" className={styles.chip} disabled={!selected || !current} onClick={() => {
          const v = views.find((x) => x.id === selected);
          if (v?.kind === 'group' && current && v.id !== current) addOp({ kind: 'mergeGroups', from: v.id, into: current });
        }}>{t('并入当前组')}</button>
        <input className={styles.input} value={newGroupName} placeholder={t('新组名…')}
          onChange={(e) => setNewGroupName(e.target.value)} />
        <button type="button" className={styles.chip} disabled={!newGroupName.trim()} onClick={() => {
          addOp({ kind: 'createGroup', name: newGroupName.trim(), parentId: targetParent });
          setNewGroupName('');
        }}>{t('新建子组')}</button>
        {clipboard ? <span className={styles.opsLabel}>{t('剪贴板：{name}（{mode}）', { name: nameOf(clipboard.id), mode: clipboard.mode === 'copy' ? t('复制') : t('剪切') })}</span> : null}
      </div>

      {renaming ? (
        <div className={styles.editor}>
          <label className={styles.editorLabel} htmlFor="kg-rename">{t('新名字')}</label>
          <input id="kg-rename" className={styles.input} value={renaming.name}
            onChange={(e) => setRenaming({ id: renaming.id, name: e.target.value })} />
          <button type="button" className={styles.chip} disabled={!renaming.name.trim()} onClick={() => {
            addOp({ kind: 'renameGroup', id: renaming.id, name: renaming.name.trim() });
            setRenaming(null);
          }}>{t('加入待同步')}</button>
          <button type="button" className={styles.chip} onClick={() => setRenaming(null)}>{t('取消')}</button>
        </div>
      ) : null}

      {editing ? (
        <div className={styles.editor}>
          <label className={styles.editorLabel} htmlFor="kg-title">{t('标题')}</label>
          <input id="kg-title" className={styles.input} value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          <label className={styles.editorLabel} htmlFor="kg-content">{t('正文')}</label>
          <textarea id="kg-content" className={styles.textarea} value={editing.content} rows={6}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          <button type="button" className={styles.chip} onClick={() => {
            addOp({ kind: 'updateMemory', id: editing.id, title: editing.title, content: editing.content });
            setEditing(null);
          }}>{t('加入待同步')}</button>
          <button type="button" className={styles.chip} onClick={() => setEditing(null)}>{t('取消')}</button>
        </div>
      ) : null}

      <div className={styles.board} ref={boardRef} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerLeave={endDrag}>
        {!tree ? <div className={styles.empty}>{t('读取中…')}</div> : null}
        {tree && views.length === 0 ? <div className={styles.empty}>{t('还没有组。')}</div> : null}

        <svg className={styles.canvas}>
          {edges.map((e) => {
            const a = posOf(e.a); const b = posOf(e.b);
            return <line key={`${e.a}->${e.b}`} className={styles.edge}
              x1={a.x + NODE_W / 2} y1={a.y + NODE_H / 2} x2={b.x + NODE_W / 2} y2={b.y + NODE_H / 2} />;
          })}
          {views.map((v) => {
            const p = posOf(v.id);
            const cls = [styles.node, STATE_CLASS[v.state], KIND_CLASS[v.kind]].filter(Boolean).join(' ');
            return (
              <g key={v.id} className={`${cls} ${selected === v.id ? styles.selected : ''}`}
                transform={`translate(${p.x},${p.y})`}
                role="button" tabIndex={0}
                aria-label={`${v.kind === 'group' ? t('组') : t('记忆')}：${v.name}`}
                onPointerDown={(e) => onPointerDown(v, e)}
                onDoubleClick={() => enter(v)}
                onClick={() => setSelected(v.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(v); } }}
              >
                <rect className={styles.rect} width={NODE_W} height={NODE_H} rx={10} />
                <text className={styles.label} x={12} y={v.kind === 'memory' ? 20 : 28}>{v.name.length > 18 ? `${v.name.slice(0, 18)}…` : v.name}</text>
                {v.kind === 'memory'
                  ? <text className={styles.sub} x={12} y={36}>{t('记忆')}</text>
                  : null}
              </g>
            );
          })}
        </svg>

        {hiddenDimCount > 0
          ? <div className={styles.more}>{t('另有 {n} 个灰色节点未画出（不在当前层）', { n: hiddenDimCount })}</div>
          : null}
      </div>
    </div>
  );
}
