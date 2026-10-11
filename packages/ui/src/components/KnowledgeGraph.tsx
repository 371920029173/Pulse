/**
 * 知识图谱（实验功能）：把 KB 的组树摊成一张网络图（VOSviewer 的读法，比它简单）。
 *
 * 视口语义（与用户给的 A/B/C/D/E/F 例子一致）：
 *   · 当前层 = 当前组本身 + 它的直接子组 + 它这一层的记忆
 *   · 当前组**标亮**（圆更大 + 外环）；子组与记忆正常色并带标签；祖先虚线边（可点着返回）
 *   · 其余（兄弟分支及其子组）画成**没有标签的小点** —— 一眼能看出"那边还有东西"，
 *     但不会抢走注意力（上一版把它们画成带标签的方块，一屏糊成一片，用户说"不好看也不易观看"）
 *
 * 读法（VOSviewer 式）：滚轮缩放、空白处拖拽平移、拖动节点改位置；缩放时光标下的点不动。
 *
 * 数据来源：结构来自 /api/kb/tree（返回 { tree: […] }，树里**不含记忆**），
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
  /** current=当前组；scope=当前层的孩子；ancestor=祖先（可返回）；dim=其他（小点）。 */
  state: 'current' | 'scope' | 'ancestor' | 'dim';
  /** 内容量：组用 memoryCount，记忆固定 1 —— 决定圆的半径（越大越重）。 */
  weight: number;
}

/** 与 server 的 KbOp 同形（界面不 import @she/kb —— 那是后端的包）。 */
type PendingOp =
  | { kind: 'renameGroup'; id: string; name: string }
  | { kind: 'moveGroup'; id: string; parentId: string | null }
  | { kind: 'copyGroup'; id: string; parentId: string | null }
  | { kind: 'mergeGroups'; from: string; into: string }
  | { kind: 'createGroup'; name: string; parentId: string | null }
  | { kind: 'updateMemory'; id: string; title?: string; content?: string };

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
  /** 双击记忆时交给上级（现在的编辑器就在本组件里，这个回调留给外部联动）。 */
  onOpenMemory?: (id: string) => void;
}

const CENTER = { x: 700, y: 460 };
/** 灰色小点的上限：多了画不下，也读不出信息。 */
const MAX_DIM = 60;

function indexTree(roots: TreeNode[]): { parent: Map<string, string | null> } {
  const parent = new Map<string, string | null>();
  const walk = (nodes: TreeNode[], p: string | null) => {
    for (const n of nodes) { parent.set(n.id, p); walk(n.children ?? [], n.id); }
  };
  walk(roots, null);
  return { parent };
}

/*
 * 类名走**静态查表**而不是 styles[state]：动态拼的类名死 CSS 棘轮看不见，
 * 会把状态类报成没人用的类（仓库为这类误判吃过一次亏）。
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
  /** 用户拖过的位置；没拖过的按布局算。拖动只改这里，不落库。 */
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  /** 视图变换：平移 + 缩放（滚轮缩放、空白处拖拽平移）。 */
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);

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

  const loadTree = useCallback(() => {
    /*
     * 形状是**服务端说了算**：GET /api/kb/tree 返回 { tree: buildGroupTree() }。
     * 这里踩过一次：组件读的是自己想出来的 `r.roots`（测试 stub 也用了同一个想出来的形状），
     * 于是"测试全绿、真机空板"。所以除了读对字段，还加一条**形状断言**。
     */
    fetchJSON<{ tree?: TreeNode[] } | TreeNode[]>('/api/kb/tree')
      .then((r) => {
        if (Array.isArray(r)) { setTree(r); return; }
        if (Array.isArray(r?.tree)) { setTree(r.tree); return; }
        setError(t('返回的形状不对：期望 {tree: […] }'));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => { loadTree(); }, [loadTree]);

  useEffect(() => {
    if (!current) { setLevel(null); return; }
    let alive = true;
    fetchJSON<LevelData>(`/api/kb/groups/${encodeURIComponent(current)}`)
      .then((d) => { if (alive) setLevel(d); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [current]);

  const { parent } = useMemo(() => indexTree(tree ?? []), [tree]);

  /** 这一层要画哪些节点，各自什么状态。 */
  const views = useMemo<NodeView[]>(() => {
    if (!tree) return [];
    const out: NodeView[] = [];
    const seen = new Set<string>();
    const push = (id: string, name: string, state: NodeView['state'], weight = 1) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, kind: 'group', name, state, weight });
    };

    const all = new Map<string, TreeNode>();
    const collect = (nodes: TreeNode[]) => { for (const n of nodes) { all.set(n.id, n); collect(n.children ?? []); } };
    collect(tree);

    if (!current) {
      // 根视图：顶层组 + 它们的直接子组（用户例子：白板上就展示根组、A、B）
      for (const n of tree) {
        push(n.id, n.name, 'scope', 1 + (n.memoryCount ?? 0));
        for (const c of n.children ?? []) push(c.id, c.name, 'scope', 1 + (c.memoryCount ?? 0));
      }
    } else {
      // 祖先链（含当前组）
      const chain: string[] = [];
      let walkId: string | null = current;
      while (walkId) { chain.unshift(walkId); walkId = parent.get(walkId) ?? null; }
      for (const id of chain) {
        const n = all.get(id);
        if (n) push(id, n.name, id === current ? 'current' : 'ancestor', 1 + (n.memoryCount ?? 0));
      }
      // 当前层的子组 + 记忆
      for (const c of level?.children ?? []) push(c.id, c.name ?? '?', 'scope', 1 + (all.get(c.id)?.memoryCount ?? 0));
      for (const m of level?.memories ?? []) {
        if (m.isRetired) continue;
        out.push({ id: m.id, kind: 'memory', name: m.title, state: 'scope', weight: 1 });
      }
      // 兄弟分支及其子组：**只当小点**（不写标签），这是"看得清"的关键
      const parentId = parent.get(current) ?? null;
      const siblings = parentId ? (all.get(parentId)?.children ?? []) : tree;
      for (const s of siblings) {
        if (s.id === current) continue;
        push(s.id, s.name, 'dim', 1 + (s.memoryCount ?? 0));
        for (const c of s.children ?? []) push(c.id, c.name, 'dim', 1 + (c.memoryCount ?? 0));
      }
    }
    const dims = out.filter((v) => v.state === 'dim');
    return dims.length > MAX_DIM ? out.filter((v) => v.state !== 'dim' || dims.slice(0, MAX_DIM).includes(v)) : out;
  }, [tree, current, level, parent]);

  /** 半径：内容越多越大（对数压缩，免得一个巨大的组把别的都盖住）；小点固定很小。 */
  const radiusOf = (v: NodeView) => {
    if (v.state === 'dim') return 6;
    if (v.kind === 'memory') return 14;
    return Math.round(18 + Math.log2(Math.max(1, v.weight)) * 3.4);
  };

  /**
   * 径向布局（确定性，不用力导向 —— 力导向每帧都在动，既写不出稳定判据，用户也没法建立空间记忆）。
   * 环半径按节点数自适应，免得几十个子组挤成一团。
   */
  const layout = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    const cur = views.find((v) => v.state === 'current');
    const ancestors = views.filter((v) => v.state === 'ancestor');
    const scopeGroups = views.filter((v) => v.state === 'scope' && v.kind === 'group');
    const scopeMems = views.filter((v) => v.state === 'scope' && v.kind === 'memory');
    const dims = views.filter((v) => v.state === 'dim');

    if (cur) pos[cur.id] = { x: CENTER.x, y: CENTER.y };
    ancestors.slice().reverse().forEach((v, i) => { pos[v.id] = { x: CENTER.x, y: CENTER.y - 150 - i * 80 }; });

    /** 环半径：按周长够不够放（每个节点留 2r+间隔）。 */
    const ringRadius = (n: number, r: number, min: number) => Math.max(min, Math.ceil((n * (2 * r + 30)) / (2 * Math.PI)));

    if (!cur) {
      // 根视图：顶层组与它们的子组各占一环
      const first = views.filter((v) => v.state === 'scope').slice(0, Math.ceil(views.length / 2));
      const rest = views.filter((v) => !first.includes(v));
      const put = (list: NodeView[], radius: number) => {
        list.forEach((v, i) => {
          const a = -Math.PI / 2 + (i / Math.max(1, list.length)) * Math.PI * 2;
          pos[v.id] = { x: CENTER.x + Math.cos(a) * radius, y: CENTER.y + Math.sin(a) * radius };
        });
      };
      put(first, ringRadius(first.length, 30, 220));
      put(rest, ringRadius(rest.length, 26, 380));
    } else {
      const dr = ringRadius(scopeGroups.length, 30, 200);
      scopeGroups.forEach((v, i) => {
        const a = -Math.PI / 2 + (i / Math.max(1, scopeGroups.length)) * Math.PI * 2;
        pos[v.id] = { x: CENTER.x + Math.cos(a) * dr, y: CENTER.y + Math.sin(a) * dr };
      });
      // 记忆再外一圈（错开半个格，免得和子组叠在同一条射线上）
      const mr = ringRadius(scopeMems.length, 20, dr + 130);
      scopeMems.forEach((v, i) => {
        const a = -Math.PI / 2 + Math.PI / Math.max(2, scopeMems.length + 1) + (i / Math.max(1, scopeMems.length)) * Math.PI * 2;
        pos[v.id] = { x: CENTER.x + Math.cos(a) * mr, y: CENTER.y + Math.sin(a) * mr };
      });
      const dimR = ringRadius(dims.length, 10, Math.max(mr, dr) + 150);
      dims.forEach((v, i) => {
        const a = -Math.PI / 2 + (i / Math.max(1, dims.length)) * Math.PI * 2;
        pos[v.id] = { x: CENTER.x + Math.cos(a) * dimR, y: CENTER.y + Math.sin(a) * dimR };
      });
    }
    return pos;
  }, [views]);

  const posOf = (id: string) => moved[id] ?? layout[id] ?? { x: CENTER.x, y: CENTER.y };

  /** 连线：当前组→孩子、祖先→下一个祖先；根视图画顶层→子组。 */
  const edges = useMemo(() => {
    const out: Array<{ a: string; b: string }> = [];
    if (!current) {
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
  }, [views, current, parent, tree]);

  const onNodePointerDown = (v: NodeView, e: React.PointerEvent) => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = posOf(v.id);
    // 屏幕坐标 → 画布坐标要**除以缩放比**，否则放大之后拖不动、缩小之后一拖飞老远
    dragRef.current = {
      id: v.id,
      dx: e.clientX - rect.left - (p.x * view.k + view.x),
      dy: e.clientY - rect.top - (p.y * view.k + view.y),
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();   // 别把画布的平移也带上
  };
  const onBoardPointerMove = (e: React.PointerEvent) => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const d = dragRef.current;
    if (d) {
      const nx = (e.clientX - rect.left - d.dx - view.x) / view.k;
      const ny = (e.clientY - rect.top - d.dy - view.y) / view.k;
      setMoved((m) => ({ ...m, [d.id]: { x: nx, y: ny } }));
      return;
    }
    const p = panRef.current;
    if (p) {
      setView((v) => ({ ...v, x: p.vx + (e.clientX - rect.left - p.x), y: p.vy + (e.clientY - rect.top - p.y) }));
    }
  };
  const endPointer = () => { dragRef.current = null; panRef.current = null; };

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
      // 树里的记忆只有标题，正文要另取
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
    const chain: Array<{ id: string | null; name: string }> = [{ id: null, name: t('目录根') }];
    if (!current) return chain;
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
        <button type="button" className={styles.chip} onClick={() => { setView({ x: 0, y: 0, k: 1 }); setMoved({}); }}>
          {t('重置视图')}
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
        {t('滚轮缩放、空白处拖动平移；双击组进入它，双击祖先返回那一层；灰点是别的分支（不在当前层）。')}
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

      <div
        className={styles.board}
        ref={boardRef}
        onPointerMove={onBoardPointerMove}
        onPointerUp={endPointer}
        onPointerLeave={endPointer}
        onPointerDown={(e) => {
          const r = boardRef.current?.getBoundingClientRect();
          panRef.current = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0), vx: view.x, vy: view.y };
        }}
        onWheel={(e) => {
          const r = boardRef.current?.getBoundingClientRect();
          const px = e.clientX - (r?.left ?? 0); const py = e.clientY - (r?.top ?? 0);
          setView((v) => {
            const k = Math.min(2.5, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0012)));
            const ratio = k / v.k;
            return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
          });
        }}
      >
        {!tree ? <div className={styles.empty}>{t('读取中…')}</div> : null}
        {tree && views.length === 0 ? <div className={styles.empty}>{t('还没有组。')}</div> : null}

        <svg className={styles.canvas}>
          {/* 视图变换：世界坐标写在这里面；平移与缩放都只改这一个 transform */}
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {edges.map((e) => {
              const a = posOf(e.a); const b = posOf(e.b);
              return <line key={`${e.a}->${e.b}`} className={styles.edge} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
            })}
            {views.map((v) => {
              const p = posOf(v.id);
              const r = radiusOf(v);
              const cls = [styles.node, STATE_CLASS[v.state], KIND_CLASS[v.kind]].filter(Boolean).join(' ');
              return (
                <g
                  key={v.id}
                  className={`${cls} ${selected === v.id ? styles.selected : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${v.kind === 'group' ? t('组') : t('记忆')}：${v.name}`}
                  onPointerDown={(e) => onNodePointerDown(v, e)}
                  onDoubleClick={() => enter(v)}
                  onClick={() => setSelected(v.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(v); } }}
                >
                  {v.state === 'current' ? <circle className={styles.ring} r={r + 6} /> : null}
                  <circle className={styles.circle} r={r} />
                  {v.state !== 'dim' ? (
                    <text className={styles.label} y={r + 15} textAnchor="middle">
                      {v.name.length > 18 ? `${v.name.slice(0, 18)}…` : v.name}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>

        {views.some((v) => v.state === 'dim') ? (
          <div className={styles.more}>{t('灰点是其他分支（每个 6 像素，最多画 {n} 个）', { n: MAX_DIM })}</div>
        ) : null}
      </div>
    </div>
  );
}
