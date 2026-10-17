/*
 * 项目地图的数据形状（P0 契约，见 docs/project-map-schema.md）。
 *
 * 这里只有类型，没有逻辑：形状先定死，后面每个阶段（建图 / 组结构 / 符号表 / git 层 /
 * 查询面 / 契约图 / 治理）都按它落盘。改这里的字段等于改存储格式 —— 要升 schemaVersion
 * 并写迁移，别偷偷改语义。
 */

/** 地图只描述"谁在哪、是什么"，不存源码正文。 */
export const MAP_SCHEMA_VERSION = 1 as const;

/** 视角适配器：同一份节点数据，三种聚合方式，可叠加。 */
export type MapView = 'dir' | 'package' | 'repo' | 'target';

/**
 * 节点身份 = (branch, path)。
 *
 * **孪生文件是特性**：`main:src/a.ts` 与 `feat/x:src/a.ts` 是两个节点，各自积累标签与注记，
 * 还能挂到不同的组上。跨分支看同一个文件是"按 path 聚合"的视图，不是同一个节点。
 */
export interface MapNodeKey {
  branch: string;
  /** 仓库相对路径，一律 posix 斜杠。 */
  path: string;
}

export type MapNodeKind = 'dir' | 'file' | 'symbol';

/** 文件/目录节点。`sha1` 是内容身份，`rev` 是标注时看到的版本。 */
export interface MapNode extends MapNodeKey {
  kind: MapNodeKind;
  /** git blob sha1；目录为 undefined。 */
  sha1?: string;
  /** 标注/扫描时的 HEAD 短 sha。 */
  rev?: string;
  /** 最近一次被 agent 读到/改到的时间（ISO8601）。 */
  lastSeen?: string;
  /** ≤16 字：这是什么。 */
  label?: string;
  /** 一句：干什么。 */
  what?: string;
  /** 什么时候该读它（最省 token 的那一段）。 */
  when?: string;
  /** label 描述的那一版内容；与当前 sha1 不等即 stale。 */
  labelSha1?: string;
  stale?: boolean;
  /** 组（DAG）：目录轴 / 功能轴 / 层轴，一个文件可属多个。 */
  groups?: string[];
  /** 构建单元视角：生成物（codegen / protobuf / minified vendor）标 true。 */
  generated?: boolean;
  lang?: string;
  size?: number;
  /** 引用热度（被 import 的次数），用于 ROI 与塌缩顺序。 */
  inDegree?: number;
}

/** 注记：模型自己的短记忆，绑 rev；文件改过之后标 mayBeStale，不静默信任。 */
export interface MapNote extends MapNodeKey {
  id: string;
  kind: 'pitfall' | 'invariant' | 'why' | 'todo' | 'deadend';
  text: string;
  /** 写注记时看到的版本与内容。 */
  rev?: string;
  sha1?: string;
  at: string;
  /** 内容已变，注记可能过时。 */
  mayBeStale?: boolean;
  /** 已提升进 KB 的节点 id。 */
  promotedTo?: string;
}

export type MapEdgeKind = 'contains' | 'import' | 'contract' | 'twin' | 'group';

/**
 * 边的置信度。
 *
 * `certain` 只能是机器可复核的事实（"B 的 import 指向 A"）。
 * `candidate` 是**潜在威胁**档：单端证据、名字相近、契约形状未对齐 —— 永不伪装成 certain，
 * 与 KB 的边类型纪律一致（共现/时序不升格为因果）。
 */
export type MapConfidence = 'certain' | 'candidate';

export interface MapEdge {
  from: string;
  to: string;
  kind: MapEdgeKind;
  confidence: MapConfidence;
  /** 证据：具体到命令/行，不是"看起来像"。 */
  evidence: string[];
  /** 什么情况下这条边就不成立了（candidate 必填）。 */
  falsifiers?: string[];
  /**
   * 纯类型导入（`import type` / `import { type X }`）。
   * 它只影响"要不要重编译"，不影响运行时会不会炸 —— 影响面必须把两者分开报。
   */
  typeOnly?: boolean;
}

/** 契约种类：跨语言故障全在这几类里。 */
export type MapContractKind = 'http' | 'event' | 'db' | 'config' | 'proto';

/**
 * 契约边：创建时记录潜在依赖，再与使用端对账。
 *
 * 对账成功（两端都定位到、形状相容）→ confidence: 'certain'；
 * 只有一端或形状不符 → 'candidate'，并进"潜在威胁"清单。
 */
export interface MapContractEdge extends MapEdge {
  kind: 'contract';
  contract: MapContractKind;
  /** 契约标识，例如 "POST /api/sessions/:id/move" / "env:SHE_PORT" / "table:sessions"。 */
  key: string;
  /** 形状签名（字段名/方法/参数），用于对账。 */
  shape?: string;
  threat?: boolean;
}

/** 三视角探测结果：包 / 仓 / 构建单元。探不到时 primary 为 'dir'，地图退回目录轴。 */
export interface MapViews {
  packages: Array<{ name: string; root: string; kind: 'npm' | 'go' | 'python' | 'rust'; manifest: string }>;
  repos: Array<{ name: string; root: string; kind: 'git' | 'submodule' }>;
  targets: Array<{ root: string; kind: 'bazel' | 'cmake' | 'make' | 'tsconfig'; file: string }>;
  primary: 'package' | 'repo' | 'target' | 'dir';
  evidence: string[];
}

/** 根分片。 */
export interface MapIndex {
  schemaVersion: typeof MAP_SCHEMA_VERSION;
  /** 仓库根（绝对路径，用于校验分片是否属于同一工作区）。 */
  root: string;
  /** 当前分支（地图默认视图）。 */
  branch: string;
  /** 已知分支（孪生体所在）。 */
  branches: string[];
  shards: Array<{ key: string; paths: number; nodes: number; mtime: string }>;
  counts: { files: number; dirs: number; symbols: number; edges: number; notes: number };
  /** 三视角探测结果（探不到时 primary='dir'）。 */
  views?: MapViews;
  /** 有 fetch 调用但 URL 是变量拼接、无法对账的数量（如实记账，不假装检查过）。 */
  contractUnresolved?: number;
  /** 排除规则的快照，便于审计"为什么这个文件不在图上"。 */
  excludes: { patterns: string[]; maxFileBytes: number };
  updatedAt: string;
}

/** 一个分片。 */
export interface MapShard {
  key: string;
  branch: string;
  nodes: MapNode[];
  edges: MapEdge[];
  notes: MapNote[];
}

/** 查询预算：超了就塌缩最不活跃的子树，脏/热/有注记的永不塌缩。 */
export interface MapBudget {
  maxTokens: number;
  maxNodes: number;
}
