/**
 * 知识图谱（实验功能）：把 KB 的组树摊成一张网络图（VOSviewer 的读法，比它简单）。
 *
 * 视口语义（与用户给的 A/B/C/D/E/F 例子一致）：
 *   · 当前层 = 当前组本身 + 它的直接子组 + 它这一层的记忆
 *   · 当前组**标亮**（圆更大 + 外环）；子组与记忆正常色并带标签；祖先虚线边（可点着返回）
 *   · 其余（兄弟分支及其子组）画成**没有标签的小点** —— 一眼能看出"那边还有东西"，
 *     但不会抢走注意力（上一版把它们画成带标签的方块，一屏糊成一片，用户说"不好看也不易观看"）
 *
 * 读法（VOSviewer 式）：滚轮缩放、空白处拖拽平移、拖动节点改位置；缩放时光标下的点不动；
 * 右下角有一个**地铁导览图式小地图**（整层缩略 + 圈出当前视野，点一下跳过去），可折叠。
 *
 * 操作（Windows 资源管理器式，用户明确要求"像 Windows 一样"）：
 *   · 单击选中、双击进入 / 打开、**右键出上下文菜单**（菜单里带快捷键提示）
 *   · Ctrl+C / Ctrl+X / Ctrl+V 复制 / 剪切 / 粘贴到当前组，F2 改名，Enter 打开，Backspace 上一级
 *   · 快捷键全部取自 lib/shortcuts 的 **graph** scope，所以**可以在设置页改**
 *
 * 数据来源：结构来自 /api/kb/tree（返回 { tree: […] }，树里**不含记忆**），
 * 某一层的记忆来自 /api/kb/groups/:id（返回 { group, children, memories }）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { fetchJSON } from '../lib/api';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { t } from '../lib/i18n';
import { actionForChord, chordFromEvent, loadShortcuts, SHORTCUT_ACTIONS } from '../lib/shortcuts';
import { KnowledgeGraphMiniMap, type MiniNode } from './KnowledgeGraphMiniMap';
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
  /** 组里装了多少条记忆（记忆节点是 0）—— 直接写在标签上，不点进去也知道里面有什么。 */
  count: number;
  /** 色相序号（0..5）—— 组件把它写进 --kg-hue，填充与描边都从那儿取。 */
  slot: number;
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

/** 右键菜单里的一项。id 对应 shortcuts 里的 graph.*，用来取标签与快捷键提示。 */
interface MenuItem {
  id: string;
  disabled?: boolean;
  run?: () => void;
}

interface Props {
  onClose: () => void;
  /** 双击记忆时交给上级（现在的编辑器就在本组件里，这个回调留给外部联动）。 */
  onOpenMemory?: (id: string) => void;
}

const CENTER = { x: 700, y: 460 };
/** 灰色小点的上限：多了画不下，也读不出信息。 */
const MAX_DIM = 60;

/**
 * 取色序号（0..5）：哈希只用来定色 —— 同一个节点每次打开都是同一种颜色，换主题换壁纸都不变。
 * 根视图里子组继承顶层分支的颜色，于是"一簇一簇"看得出来。
 */
function slotOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 6;
}

/**
 * 把一组世界坐标点缩放到框里（留边距）。
 * 白板重排后固定 k=1 常常只看到一角，所以进面板与"重置视图"都走这里。
 * 框太小（jsdom 里 getBoundingClientRect 全是 0）就退回 1:1 —— 判据不受影响。
 */
function fitTransform(
  box: { width: number; height: number } | undefined,
  pts: Array<{ x: number; y: number }>,
): { x: number; y: number; k: number } {
  if (!box || box.width < 10 || box.height < 10 || !pts.length) return { x: 0, y: 0, k: 1 };
  const pad = 90;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const k = Math.min(1.2, Math.max(0.25, Math.min(box.width / (maxX - minX), box.height / (maxY - minY))));
  return { k, x: box.width / 2 - ((minX + maxX) / 2) * k, y: box.height / 2 - ((minY + maxY) / 2) * k };
}

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
  const [newGroup, setNewGroup] = useState<{ parentId: string | null; name: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 最近一次同步落下的快照路径 —— 有它才有"回滚到同步前"。 */
  const [lastSnapshot, setLastSnapshot] = useState<string | null>(null);
  /** 右键菜单：node=右键点到的节点，null=点在空白处（那时菜单里是"粘贴 / 新建子组"）。 */
  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeView | null } | null>(null);
  /** 快捷键表：用户改过的绑定存在 localStorage，面板打开时读一次。 */
  const shortcuts = useMemo(() => loadShortcuts(), []);
  /** 小地图开合：记在 sessionStorage —— 关掉白板再开还是关的，重启应用回到默认（开）。 */
  const [showMap, setShowMap] = useState(() => {
    try { return sessionStorage.getItem('she.graph.minimap') !== '0'; } catch { return true; }
  });
  const toggleMap = () => setShowMap((s) => {
    const next = !s;
    try { sessionStorage.setItem('she.graph.minimap', next ? '1' : '0'); } catch { /* 无痕模式等：不影响功能 */ }
    return next;
  });

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
    const push = (id: string, name: string, state: NodeView['state'], weight = 1, count = 0, slot = 0) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, kind: 'group', name, state, weight, count, slot });
    };

    const all = new Map<string, TreeNode>();
    const collect = (nodes: TreeNode[]) => { for (const n of nodes) { all.set(n.id, n); collect(n.children ?? []); } };
    collect(tree);

    if (!current) {
      // 根视图：顶层组 + 它们的直接子组（用户例子：白板上就展示根组、A、B）
      // 子组继承顶层分支的色相 —— 一圈下来是几簇颜色，不是一片同色
      tree.forEach((n, i) => {
        const slot = i % 6;
        push(n.id, n.name, 'scope', 1 + (n.memoryCount ?? 0), n.memoryCount ?? 0, slot);
        for (const c of n.children ?? []) push(c.id, c.name, 'scope', 1 + (c.memoryCount ?? 0), c.memoryCount ?? 0, slot);
      });
    } else {
      // 祖先链（含当前组）
      const chain: string[] = [];
      let walkId: string | null = current;
      while (walkId) { chain.unshift(walkId); walkId = parent.get(walkId) ?? null; }
      for (const id of chain) {
        const n = all.get(id);
        if (n) push(id, n.name, id === current ? 'current' : 'ancestor', 1 + (n.memoryCount ?? 0), n.memoryCount ?? 0, slotOf(id));
      }
      // 当前层的子组 + 记忆
      for (const c of level?.children ?? []) push(c.id, c.name ?? '?', 'scope', 1 + (all.get(c.id)?.memoryCount ?? 0), all.get(c.id)?.memoryCount ?? 0, slotOf(c.id));
      for (const m of level?.memories ?? []) {
        if (m.isRetired) continue;
        out.push({ id: m.id, kind: 'memory', name: m.title, state: 'scope', weight: 1, count: 0, slot: slotOf(m.id) });
      }
      // 兄弟分支及其子组：**只当小点**（不写标签），这是"看得清"的关键
      const parentId = parent.get(current) ?? null;
      const siblings = parentId ? (all.get(parentId)?.children ?? []) : tree;
      for (const s of siblings) {
        if (s.id === current) continue;
        push(s.id, s.name, 'dim', 1 + (s.memoryCount ?? 0), s.memoryCount ?? 0, slotOf(s.id));
        for (const c of s.children ?? []) push(c.id, c.name, 'dim', 1 + (c.memoryCount ?? 0), c.memoryCount ?? 0, slotOf(c.id));
      }
    }
    const dims = out.filter((v) => v.state === 'dim');
    return dims.length > MAX_DIM ? out.filter((v) => v.state !== 'dim' || dims.slice(0, MAX_DIM).includes(v)) : out;
  }, [tree, current, level, parent]);

  /**
   * 标签怎么写才看得见（用户的第二次反馈："还是看不到内容"）。
   *
   * 组的名字是**整条路径**（project/digbug/findings/part-4）：按头部截断的话，同一层的标签全长成
   * "project/digbug/fin…"，彼此一样、也看不出在哪一层 —— 等于没有信息。所以组从**尾部**取，上面的
   * 层用 "…/" 表示；组再带上它装了多少条记忆。记忆的标题是自然语言，从头截断本来就对。
   */
  const labelFor = (v: NodeView): string => {
    const LIMIT = 22;
    let text = v.name;
    if (text.length > LIMIT) {
      if (v.kind === 'memory') {
        text = `${text.slice(0, LIMIT)}…`;
      } else {
        const tail = text.slice(-LIMIT);
        const cut = tail.indexOf('/');
        text = `…/${cut > 0 && cut < tail.length - 1 ? tail.slice(cut + 1) : tail}`;
      }
    }
    return v.kind === 'group' && v.count > 0 ? `${text} · ${v.count}` : text;
  };

  /** 节点的色相：写进 --kg-hue，填充/描边都从那儿取（不用动态类名 —— 死 CSS 棘轮看不见动态类名）。 */
  const hueOf = (v: NodeView) => `var(--graph-node-${(v.slot % 6) + 1})`;

  /** 半径：内容越多越大（对数压缩，免得一个巨大的组把别的都盖住）；小点固定很小。 */
  const radiusOf = (v: NodeView) => {
    if (v.state === 'dim') return 6;
    if (v.kind === 'memory') return 14;
    return Math.round(18 + Math.log2(Math.max(1, v.weight)) * 3.4);
  };

  /**
   * 径向布局（确定性；不用力导向 —— 力导向每帧都在动，写不出稳定判据，用户也没法建立空间记忆）。
   *
   * 2026-10-12 重写：旧算法拿**固定**半径（30/26px）估环周长，节点越多、越大，环就越不够长 ——
   * 四十个节点挤成一圈、标签互相盖住（用户："这些点排列的有点密集"）。现在两件事做对了：
   *   · 每个节点按**真实半径**和**标签宽度**占弧长（标签比圆宽得多，那才是拥挤的真正原因）；
   *   · 一环装不下就按弧长预算再开一环（半径递增）；根视图还按层级分环（顶层一圈、子组一圈）。
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

    const GAP = 28;         // 相邻节点之间至少留这么多像素
    const CHAR_W = 6.8;     // 12px 字号下一个字符的近似宽度
    const MAX_RING = 620;   // 一环的半径上限；超了就把剩下的节点放到下一环
    const RING_STEP = 120;  // 环与环之间的半径差

    /** 这个节点在环上要占多少弧长：圆的直径与标签宽度取大者。 */
    const arcOf = (v: NodeView) => {
      const d = 2 * radiusOf(v) + GAP;
      if (v.state === 'dim') return d + 6;
      return Math.max(d, Math.min(labelFor(v).length, 24) * CHAR_W + 20);
    };

    /**
     * 把一组节点铺到环上（大节点在前，位置稳定）。返回最外圈的半径。
     * 角度按**弧长**分配，不是按个数均分 —— 标签宽的节点自然拿到更大的张角。
     */
    const placeRings = (list: NodeView[], baseRadius: number): number => {
      const queue = list.slice().sort((a, b) => (b.weight - a.weight) || a.id.localeCompare(b.id));
      let ring = 0;
      let outer = baseRadius;
      while (queue.length) {
        const budget = 2 * Math.PI * MAX_RING;
        const take: NodeView[] = [];
        let used = 0;
        while (queue.length) {
          const a = arcOf(queue[0]);
          if (take.length && used + a > budget) break;
          take.push(queue.shift()!);
          used += a;
        }
        const radius = Math.max(baseRadius + ring * RING_STEP, used / (2 * Math.PI));
        let cum = 0;
        for (const v of take) {
          const a = arcOf(v);
          const angle = -Math.PI / 2 + ((cum + a / 2) / used) * Math.PI * 2;
          pos[v.id] = { x: CENTER.x + Math.cos(angle) * radius, y: CENTER.y + Math.sin(angle) * radius };
          cum += a;
        }
        outer = radius;
        ring++;
        if (ring > 8) break;   // 保险丝：真出意外也不至于转不出来
      }
      return outer;
    };

    /** 下一圈该从哪个半径起：给内圈最大的节点与外圈最大的节点都留出身位，两环才不会撞。 */
    const ringAfter = (radius: number, inner: NodeView[], outer: NodeView[]) =>
      radius
      + (inner.length ? Math.max(...inner.map(radiusOf)) : 0)
      + (outer.length ? Math.max(...outer.map(radiusOf)) : 0)
      + 30;

    if (!cur) {
      // 根视图：顶层组一圈，它们的子组再外一圈（层次看得出来，也不会互相挤）
      const topLevel = views.filter((v) => v.state === 'scope' && (parent.get(v.id) ?? null) === null);
      const second = views.filter((v) => v.state === 'scope' && !topLevel.includes(v));
      const r1 = placeRings(topLevel, 200);
      if (second.length) placeRings(second, ringAfter(r1, topLevel, second));
    } else {
      const rGroups = placeRings(scopeGroups, 230);
      const rMems = scopeMems.length ? placeRings(scopeMems, ringAfter(rGroups, scopeGroups, scopeMems)) : rGroups;
      if (dims.length) placeRings(dims, ringAfter(Math.max(rMems, rGroups), [...scopeGroups, ...scopeMems], dims));
    }
    return pos;
  }, [views, parent]);

  const posOf = (id: string) => moved[id] ?? layout[id] ?? { x: CENTER.x, y: CENTER.y };

  /*
   * 进面板 / 换层时自动"看得全"一次。
   * 只在"这一层该画什么"变了时跑（views 的依赖就是树、当前组、层级）——用户随后的缩放与平移不受干扰。
   */
  useEffect(() => {
    const box = boardRef.current?.getBoundingClientRect();
    setView(fitTransform(box, views.map((v) => moved[v.id] ?? layout[v.id] ?? { x: CENTER.x, y: CENTER.y })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views]);

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
      /*
       * 树里的记忆只有标题，正文要另取。
       *
       * 形状**来自服务端**：GET /api/kb/memories/:id → { memory: { id, title, content, … }, retired, version, history }。
       * 2026-10-12 之前这里按想当然的形状读（平铺的 title/content），于是编辑器永远空白 —— 而测试里的 stub
       * 也是编的，两边一起绿。和当年"空树"（读 r.roots）是同一类坑：stub 的形状必须抄服务端。
       *
       * 读回形状不对时**不出空编辑器**，直说 —— 否则用户一保存就把空内容写回去了。
       */
      void fetchJSON<{ memory?: { id: string; title?: string; content?: string } }>(`/api/kb/memories/${encodeURIComponent(v.id)}`)
        .then((r) => {
          const m = r?.memory;
          if (!m || typeof m.content !== 'string') {
            setNotice(t('这条记忆读回来的形状不对（缺 memory.content），先不改它，免得把空内容写回去'));
            return;
          }
          setEditing({ id: m.id, title: m.title ?? '', content: m.content });
        })
        .catch((e: Error) => setNotice(t('打不开这条记忆：{message}', { message: e.message })));
      onOpenMemory?.(v.id);
      return;
    }
    setCurrent(v.id);
  };
  const goUp = () => setCurrent((c) => (c ? (parent.get(c) ?? null) : null));

  const beginRename = (v: NodeView | null) => { if (v?.kind === 'group') setRenaming({ id: v.id, name: v.name }); };
  const beginCopy = (v: NodeView | null) => { if (v?.kind === 'group') setClipboard({ mode: 'copy', id: v.id }); };
  const beginCut = (v: NodeView | null) => { if (v?.kind === 'group') setClipboard({ mode: 'cut', id: v.id }); };
  const beginCreate = (parentId: string | null) => setNewGroup({ parentId, name: '' });
  const resetView = () => {
    setMoved({});
    // 以布局为准（刚清掉拖动），把整张图缩放到看得全
    const box = boardRef.current?.getBoundingClientRect();
    setView(fitTransform(box, views.map((v) => layout[v.id] ?? { x: CENTER.x, y: CENTER.y })));
  };

  /**
   * 快捷键动作的分发：作用对象是**当前选中的节点**（和资源管理器一致 —— 先选，再按）。
   * 绑定值可能被用户在设置页改过，所以走 id 而不是写死键。
   */
  const runAction = (id: string) => {
    const v = views.find((x) => x.id === selected) ?? null;
    switch (id) {
      case 'graph.open': if (v) enter(v); break;
      case 'graph.up': goUp(); break;
      case 'graph.rename': beginRename(v); break;
      case 'graph.copy': beginCopy(v); break;
      case 'graph.cut': beginCut(v); break;
      case 'graph.paste': paste(); break;
      case 'graph.resetView': resetView(); break;
      default: break;
    }
    setMenu(null);
  };

  /*
   * 白板快捷键：注册在 **window 的捕获阶段**，理由是一个真实的顺序陷阱 ——
   * useEscapeToClose 把监听挂在 document 的冒泡阶段；真实事件冒泡是
   * target → … → document → window，所以 window 上的**冒泡**监听反而最后跑，
   * 想"菜单开着时 Escape 只关菜单、不动面板"就来不及了（它的 handler 已经关掉了面板）。
   * 捕获阶段是 window → document → target，先跑就有机会 preventDefault，
   * 而 useEscapeToClose 明确写着"defaultPrevented 就放手"。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 在输入框里打字时白板让路：F2 / Ctrl+C 在文本框里属于文字编辑
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (e.key === 'Escape' && menu) { e.preventDefault(); setMenu(null); return; }
      const action = actionForChord(shortcuts, chordFromEvent(e), 'graph');
      if (!action) return;
      e.preventDefault();
      runAction(action.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  /** 菜单项：标签与快捷键提示都取自快捷键表，和设置页里显示的完全一致。 */
  const labelOf = (id: string) => {
    const a = SHORTCUT_ACTIONS.find((x) => x.id === id);
    return a?.label ?? id;
  };
  const chordOf = (id: string) => shortcuts[id as keyof typeof shortcuts] ?? SHORTCUT_ACTIONS.find((a) => a.id === id)?.defaultChord ?? '';

  const menuItems = (node: NodeView | null): MenuItem[] => {
    if (!node) {
      return [
        { id: 'graph.paste', disabled: !clipboard, run: paste },
        { id: 'graph.newGroup', run: () => beginCreate(current) },
        { id: 'graph.resetView', run: resetView },
      ];
    }
    if (node.kind === 'memory') {
      return [{ id: 'graph.open', run: () => enter(node) }];
    }
    return [
      { id: 'graph.open', run: () => enter(node) },
      { id: 'graph.rename', run: () => beginRename(node) },
      { id: 'graph.copy', run: () => beginCopy(node) },
      { id: 'graph.cut', run: () => beginCut(node) },
      { id: 'graph.paste', disabled: !clipboard, run: paste },
      { id: 'graph.merge', disabled: !current || node.id === current, run: () => addOp({ kind: 'mergeGroups', from: node.id, into: current! }) },
      { id: 'graph.newGroup', run: () => beginCreate(node.id) },
    ];
  };
  /** 菜单里那些**没有**默认快捷键的项 —— 单独给中文标签（不进快捷键表，免得占键位）。 */
  const extraLabel: Record<string, string> = {
    'graph.newGroup': t('新建子组'),
    'graph.merge': t('并入当前组'),
  };

  /** 小地图要的：节点的世界坐标 + 半径 + 状态（小地图只做缩放，不算布局）。 */
  const miniNodes = useMemo<MiniNode[]>(
    () => views.map((v) => ({ id: v.id, x: posOf(v.id).x, y: posOf(v.id).y, r: radiusOf(v), state: v.state, kind: v.kind })),
    [views, moved, layout],
  );
  /** 主视图此刻看得见的世界坐标范围；DOM 尺寸读不到时给个合理默认，下一帧就对了。 */
  const worldView = useMemo(() => {
    const w = boardRef.current?.clientWidth || 1200;
    const h = boardRef.current?.clientHeight || 620;
    return { x: -view.x / view.k, y: -view.y / view.k, w: w / view.k, h: h / view.k };
  }, [view]);

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
    <div className={styles.panel} role="dialog" aria-label={t('知识图谱')} onClick={() => setMenu(null)}>
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
        <button type="button" className={styles.chip} onClick={resetView}>
          {t('重置视图')}
        </button>
        <button type="button" className={styles.chip} onClick={toggleMap}>
          {showMap ? t('隐藏小地图') : t('小地图')}
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
        {t('滚轮缩放、空白处拖动平移；双击组进入它；右键出菜单；Ctrl+C/X/V、F2、Enter、Backspace 都可用（设置页可改）。')}
      </p>
      {error ? <div className={styles.error}>{t('加载失败：{message}', { message: error })}</div> : null}
      {notice ? <div className={styles.notice}>{notice}</div> : null}

      <div className={styles.ops}>
        <span className={styles.opsLabel}>{t('操作')}</span>
        <button type="button" className={styles.chip} disabled={!selected} onClick={() => beginRename(views.find((x) => x.id === selected) ?? null)}>{t('改名')}</button>
        <button type="button" className={styles.chip} disabled={!selected} onClick={() => beginCopy(views.find((x) => x.id === selected) ?? null)}>{t('复制')}</button>
        <button type="button" className={styles.chip} disabled={!selected} onClick={() => beginCut(views.find((x) => x.id === selected) ?? null)}>{t('剪切')}</button>
        <button type="button" className={styles.chip} disabled={!clipboard} onClick={paste}>{t('粘贴到这里')}</button>
        <button type="button" className={styles.chip} disabled={!selected || !current} onClick={() => {
          const v = views.find((x) => x.id === selected);
          if (v?.kind === 'group' && current && v.id !== current) addOp({ kind: 'mergeGroups', from: v.id, into: current });
        }}>{t('并入当前组')}</button>
        <button type="button" className={styles.chip} onClick={() => beginCreate(current)}>{t('新建子组')}</button>
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

      {newGroup ? (
        <div className={styles.editor}>
          <label className={styles.editorLabel} htmlFor="kg-newgroup">
            {t('在「{name}」下新建组', { name: newGroup.parentId ? nameOf(newGroup.parentId) : t('目录根') })}
          </label>
          <input id="kg-newgroup" className={styles.input} value={newGroup.name} autoFocus
            onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
          <button type="button" className={styles.chip} disabled={!newGroup.name.trim()} onClick={() => {
            addOp({ kind: 'createGroup', name: newGroup.name.trim(), parentId: newGroup.parentId });
            setNewGroup(null);
          }}>{t('加入待同步')}</button>
          <button type="button" className={styles.chip} onClick={() => setNewGroup(null)}>{t('取消')}</button>
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
        onContextMenu={(e) => {
          // 空白处右键：菜单里是"粘贴 / 新建子组 / 重置视图"（Windows 的桌面菜单就是这个意思）
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, node: null });
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
                  style={{ '--kg-hue': hueOf(v) } as CSSProperties}
                  transform={`translate(${p.x},${p.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${v.kind === 'group' ? t('组') : t('记忆')}：${v.name}`}
                  onPointerDown={(e) => onNodePointerDown(v, e)}
                  onDoubleClick={() => enter(v)}
                  onClick={() => setSelected(v.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();   // 别让画布的空白菜单也冒出来
                    setSelected(v.id);
                    setMenu({ x: e.clientX, y: e.clientY, node: v });
                  }}
                  /* 只留 Space：Enter 已经由白板快捷键（graph.open）统一处理，两边都做会开两次 */
                  onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); enter(v); } }}
                >
                  {v.state === 'current' ? <circle className={styles.ring} r={r + 6} /> : null}
                  <circle className={styles.circle} r={r} />
                  {v.state !== 'dim' ? (
                    <>
                      {/* 悬停看全名：标签放不下整条路径 */}
                      <title>{v.kind === 'group' ? t('组：{name}（{n} 条记忆）', { name: v.name, n: v.count }) : v.name}</title>
                      <text className={styles.label} y={r + 15} textAnchor="middle">
                        {labelFor(v)}
                      </text>
                    </>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>

        {views.some((v) => v.state === 'dim') ? (
          <div className={styles.more}>{t('灰点是其他分支（每个 6 像素，最多画 {n} 个）', { n: MAX_DIM })}</div>
        ) : null}

        {showMap ? (
          <KnowledgeGraphMiniMap
            nodes={miniNodes}
            edges={edges}
            world={worldView}
            onJump={(wx, wy) => {
              // "把主视图中心移到这里"：世界坐标 → 平移量要按中心反算，不能直接当平移用
              const r = boardRef.current?.getBoundingClientRect();
              if (!r) return;
              setView((v) => ({ ...v, x: r.width / 2 - wx * v.k, y: r.height / 2 - wy * v.k }));
            }}
          />
        ) : null}
      </div>

      {menu ? (
        <div className={styles.menu} style={{ left: menu.x, top: menu.y }} role="menu" aria-label={t('操作菜单')}>
          {menuItems(menu.node).map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              disabled={it.disabled}
              onClick={() => { it.run?.(); setMenu(null); }}
            >
              <span className={styles.menuLabel}>{extraLabel[it.id] ?? labelOf(it.id)}</span>
              <span className={styles.menuChord}>{chordOf(it.id)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
