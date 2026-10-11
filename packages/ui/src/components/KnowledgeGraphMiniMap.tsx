/**
 * 白板的小地图（用户要的「地铁导览图」）。
 *
 * 地铁图那套读法：细线直连（不做曲线）、小圆点当站、当前看的范围用一个方框圈出来。
 * 数据全是 props —— 由白板把**世界坐标**算好传进来，这里只做缩放映射，不碰数据、不发请求。
 *
 * 两个容易写错的地方：
 *   · 边界要把**视口方框**也算进去，不能只框节点 —— 缩小到 0.25 倍时视口比节点大得多，
 *     只按节点算边界，方框会跑到小地图外面去。
 *   · 点了小地图是"把主视图移到这个点"，不是"移动这个点"：所以要按主视图的**中心**反算平移，
 *     而不是把世界坐标直接当成平移量。
 *
 * 注释里千万别写 JSX 注释的字面写法（花括号 + 星号 + 结尾那两个字符）——
 * 那串字符里的结尾符号会**提前闭合块注释**，整个文件语法就坏了。
 * 这已经栽过一次：块注释被提前闭合，esbuild 报 Unexpected "}"，App 导不进来、界面直接空白。
 * 另外仓库的 i18n 棘轮会把 JSX 注释里带引号的中文当成硬编码界面文案。
 */
import { useMemo } from 'react';
import { t } from '../lib/i18n';
import styles from '../styles/KnowledgeGraph.module.css';

export interface MiniNode {
  id: string;
  x: number;
  y: number;
  r: number;
  state: 'current' | 'scope' | 'ancestor' | 'dim';
  kind: 'group' | 'memory';
}

interface Props {
  nodes: MiniNode[];
  edges: Array<{ a: string; b: string }>;
  /** 主视图此刻看得见的世界坐标范围（左上角 + 宽高）。 */
  world: { x: number; y: number; w: number; h: number };
  /** 点/拖小地图：把主视图中心移到这个世界坐标点。 */
  onJump: (x: number, y: number) => void;
}

/** 小地图自己的像素尺寸（css 里也是这个比例）。 */
const W = 200;
const H = 140;
const PAD = 12;

export function KnowledgeGraphMiniMap({ nodes, edges, world, onJump }: Props) {
  const byId = useMemo(() => {
    const m = new Map<string, MiniNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  /** 世界坐标 → 小地图像素：等比缩到框里，再居中。 */
  const map = useMemo(() => {
    if (!nodes.length) return null;
    let minX = world.x, minY = world.y, maxX = world.x + world.w, maxY = world.y + world.h;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const k = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h);
    const ox = (W - w * k) / 2 - minX * k;
    const oy = (H - h * k) / 2 - minY * k;
    return { k, ox, oy };
  }, [nodes, world]);

  if (!map) return null;
  const px = (x: number) => map.ox + x * map.k;
  const py = (y: number) => map.oy + y * map.k;

  const clickAt = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // 像素 → 世界坐标（上是等比缩放 + 居中，反着算回去）
    const wx = (e.clientX - r.left - map.ox) / map.k;
    const wy = (e.clientY - r.top - map.oy) / map.k;
    onJump(wx, wy);
  };

  return (
    <svg
      className={styles.mini}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="button"
      tabIndex={0}
      aria-label={t('小地图（点一下把主视图移过去）')}
      onMouseDown={clickAt}
      onMouseMove={(e) => { if (e.buttons & 1) clickAt(e); }}
    >
      {edges.map((e) => {
        const a = byId.get(e.a); const b = byId.get(e.b);
        if (!a || !b) return null;
        return <line key={`${e.a}->${e.b}`} className={styles.miniEdge} x1={px(a.x)} y1={py(a.y)} x2={px(b.x)} y2={py(b.y)} />;
      })}
      {nodes.map((n) => (
        <circle
          key={n.id}
          className={n.state === 'dim' ? styles.miniNodeDim : styles.miniNode}
          cx={px(n.x)}
          cy={py(n.y)}
          r={n.state === 'dim' ? 2 : n.kind === 'memory' ? 3 : 4}
        />
      ))}
      {/* 主视图此刻的范围（视野框） */}
      <rect
        className={styles.miniViewport}
        x={px(world.x)}
        y={py(world.y)}
        width={Math.max(2, world.w * map.k)}
        height={Math.max(2, world.h * map.k)}
      />
    </svg>
  );
}
