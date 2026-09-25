import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger, type SheConfig, type LLMMessage, type StreamChunk } from '@she/shared';
import { OpenAIProvider } from '@she/agent-runtime';
import { AnthropicProvider } from '@she/agent-runtime';
import type { LLMProvider } from '@she/shared';
import { loadStateFile, saveStateFile } from './state-file.js';

const log = createLogger('cluster');

export type ClusterRoleId = string;

/** Which wave a role speaks in. */
export type ClusterPhase = 'lead' | 'work' | 'review';

export interface ClusterRole {
  /** Stable key, e.g. 'leader' or a custom slug. */
  key: string;
  name: string;
  title: string;
  /** How many instances of this role to run. 0 disables the role entirely. */
  count: number;
  /** Extra system instructions (from a skill file or generated). */
  skill: string;
  phase: ClusterPhase;
  /** Colour hue (0-360) used by the UI. */
  hue: number;
  isCustom?: boolean;
}

/** A concrete seat in a room: one role instance. */
export interface ClusterMember {
  id: string;
  /** Role this member instantiates. */
  roleKey: string;
  name: string;
  title: string;
  skill: string;
  phase: ClusterPhase;
  hue: number;
  /** 1-based index within the role (领导, 领导2, …). */
  index: number;
}

export interface ClusterMessage {
  id: string;
  role: string;
  name: string;
  content: string;
  created_at: string;
  parallel_group?: string;
}

export interface ClusterRoom {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** Role configuration, editable per room. */
  roles: ClusterRole[];
  members: ClusterMember[];
  messages: ClusterMessage[];
  status: 'idle' | 'running' | 'error';
  last_error?: string;
  /** Parent workspace, so rooms can be filtered per workspace. */
  workspace?: string;
}

interface ClusterFile {
  schema_version: string;
  rooms: ClusterRoom[];
}

/** Current on-disk format for work groups. */
const SCHEMA = '2';

/**
 * Validate and repair a loaded cluster file.
 *
 * Throws only when the value cannot be a cluster file at all, so the caller can
 * quarantine it. A single malformed room is skipped rather than costing the user
 * every work group they built.
 */
function normalizeClusterFile(raw: ClusterFile): ClusterFile {
  if (!raw || typeof raw !== 'object') throw new Error('不是对象');
  if (!Array.isArray(raw.rooms)) throw new Error('rooms 不是数组');

  const rooms: ClusterRoom[] = [];
  for (const entry of raw.rooms) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Partial<ClusterRoom>;
    if (typeof r.id !== 'string' || !r.id) continue;
    rooms.push({
      ...(entry as ClusterRoom),
      // Read unconditionally elsewhere, so they must exist.
      title: typeof r.title === 'string' ? r.title : '未命名讨论组',
      roles: Array.isArray(r.roles) ? r.roles : [],
      members: Array.isArray(r.members) ? r.members : [],
      messages: Array.isArray(r.messages) ? r.messages : [],
      status: r.status === 'running' || r.status === 'error' ? r.status : 'idle',
    });
  }

  return { schema_version: SCHEMA, rooms };
}

/** The built-in roles: the five original ones plus an independent critic. */
export const DEFAULT_ROLES: Omit<ClusterRole, 'skill'>[] = [
  { key: 'leader', name: '领导', title: '拆任务、对齐、汇总', count: 1, phase: 'lead', hue: 220 },
  { key: 'logistics', name: '后勤', title: '路径、依赖、归档、清单', count: 1, phase: 'work', hue: 140 },
  { key: 'copy', name: '文案', title: '说明、文档、口径', count: 1, phase: 'work', hue: 275 },
  { key: 'eng', name: '研发', title: '实现方案、接口、测试', count: 1, phase: 'work', hue: 205 },
  { key: 'review', name: '审查', title: '找漏、风险、验收标准', count: 1, phase: 'review', hue: 40 },
  /*
   * The critic is a SEPARATE seat from the reviewer, and the separation is the whole point.
   *
   * 「审查」 looks at the plan and the design: is the approach right, what is missing, what would
   * break. The critic does something narrower and less forgiving — it takes the claims the work wave
   * just made ("测试已通过", "已经改好了") and asks which of them any evidence in the room supports.
   * Those are different jobs, and the roles that produced the work cannot do the second one about
   * their own output, because the author is the last party able to notice that a claim was never
   * backed by anything.
   *
   * Pinned to `phase: 'review'` so it speaks after the work wave, which is the only ordering in
   * which there is something to criticise.
   */
  { key: 'critic', name: '批评者', title: '逐条核对说法与证据，不接受没有依据的结论', count: 1, phase: 'review', hue: 350 },
];

/** Suggested custom roles the UI can offer as one-click presets. */
export const ROLE_PRESETS: { key: string; name: string; title: string; phase: ClusterPhase; hue: number }[] = [
  { key: 'data', name: '数据', title: '指标、统计、表格、可视化', phase: 'work', hue: 190 },
  { key: 'security', name: '安全', title: '权限、注入、密钥、合规风险', phase: 'review', hue: 0 },
  { key: 'design', name: '设计', title: '交互、视觉、可用性', phase: 'work', hue: 320 },
  { key: 'qa', name: '测试', title: '用例、边界、回归、验收', phase: 'review', hue: 95 },
  { key: 'ops', name: '运维', title: '部署、监控、回滚、容量', phase: 'work', hue: 25 },
  { key: 'research', name: '调研', title: '方案对比、竞品、取舍依据', phase: 'work', hue: 250 },
];

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSkillFor(key: string, name: string): string {
  const map: Record<string, string> = {
    leader:
      '你是领导。拆任务、定成功标准、点名谁先做、最后汇总。发言短、可执行。不要替别人写长文。',
    logistics:
      '你是后勤。关注环境、路径、依赖、检查清单、归档位置。输出 checklist。不做深度代码设计。',
    copy:
      '你是文案。把方案写成清晰中文说明/用户可见文案。不编造未确认事实。',
    eng:
      '你是研发。给出可落地的技术步骤、接口/文件改动点、风险。当前回合以方案为主；需要工具时明确写出下一步命令。',
    review:
      '你是审查。只挑问题：遗漏、风险、验收缺口。用条目列出；没有问题就说 LGTM + 仍需验证项。',
    critic:
      '你是批评者，和产出者分开。你的工作只有一件：把前面各位的「已经完成/已经通过/已经修复」'
      + '逐条拿出来，问「群里有什么能证明它」。\n'
      + '规则：\n'
      + '- 每条结论必须给出出处：谁说的 + 他引用的原话或输出。给不出出处的，直接标「无依据」，不要替它补理由。\n'
      + '- 不接受「应该没问题」「看起来正常」「逻辑上是对的」——这些不是证据。\n'
      + '- 不要重复审查角色的风险清单；只核对「说法 vs 证据」。\n'
      + '- 也不要说「全部没问题」。没有问题的项直接跳过，最后只列没通过的项；一条都没有时，只写一行：'
      + '「批评者：N 条结论都有出处」并说明你核对了哪 N 条。\n'
      + '- 你自己不要提出新方案，也不要修改别人的结论；你只判断依据够不够。',
  };
  return map[key] ?? `你是${name}。只做「${name}」职责范围内的事，发言简洁可执行，需要其他角色配合时点名。不要假装已执行未发生的操作。`;
}

function loadSkillFile(workspaceRoot: string, key: string): string | null {
  const candidates = [
    join(workspaceRoot, '.she', 'skills', 'custom', `cluster-${key}.md`),
    join(workspaceRoot, '.she', 'skills', 'custom', `cluster-${key}.MD`),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const t = readFileSync(p, 'utf8').trim();
        if (t) return t;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Build the default role configuration, loading skill files when present. */
export function buildDefaultRoles(workspaceRoot: string): ClusterRole[] {
  return DEFAULT_ROLES.map((r) => ({
    ...r,
    skill: loadSkillFile(workspaceRoot, r.key) ?? defaultSkillFor(r.key, r.name),
  }));
}

/** Expand a role configuration into concrete member seats. */
export function expandMembers(roles: ClusterRole[]): ClusterMember[] {
  const members: ClusterMember[] = [];
  for (const role of roles) {
    const count = Math.max(0, Math.floor(role.count));
    for (let i = 0; i < count; i++) {
      members.push({
        id: count === 1 ? role.key : `${role.key}#${i + 1}`,
        roleKey: role.key,
        name: count === 1 ? role.name : `${role.name}${i + 1}`,
        title: role.title,
        skill: role.skill,
        phase: role.phase,
        hue: role.hue,
        index: i + 1,
      });
    }
  }
  return members;
}

export class ClusterStore {
  private path: string;
  private data: ClusterFile;
  /** Set when the previous file could not be used and was moved aside. */
  private recovery: { backup: string; reason: string } | null = null;

  constructor(baseDir: string) {
    const dir = join(baseDir, '.she', 'cluster');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'rooms.json');
    this.data = { schema_version: SCHEMA, rooms: [] };
    this.load();
  }

  /**
   * Load the work-group file.
   *
   * The previous version silently flattened any parse failure into an empty list,
   * and the next mutation then wrote that empty list over the user's rooms. A
   * damaged file is now quarantined instead, so the rooms remain on disk and
   * recoverable — see `state-file.ts`.
   */
  private load(): void {
    const outcome = loadStateFile<ClusterFile>({
      path: this.path,
      version: SCHEMA,
      empty: () => ({ schema_version: SCHEMA, rooms: [] }),
      parse: (raw) => normalizeClusterFile(raw as ClusterFile),
      migrations: {
        // Version 1 wrote the same shape; kept so a version bump cannot strand
        // anyone who already has rooms on disk.
        '1': (raw) => ({ ...raw, schema_version: SCHEMA }),
        '*': (raw) => ({ ...raw, schema_version: SCHEMA }),
      },
    });

    this.data = outcome.data;
    // Skip the empty stub the old code wrote for users who never made a room.
    if (outcome.recovered) {
      this.recovery = outcome.recovered;
      // Reported, not silent: otherwise a quarantined file looks identical to the
      // user's work groups having been deleted.
      log.error(
        `讨论组文件无法读取，已保留为备份而不是丢弃。原因: ${outcome.recovered.reason}；`
        + `备份: ${outcome.recovered.backup}`,
      );
      this.persist();
    }
    if (!existsSync(this.path)) this.persist();
  }

  /** The recovery notice from load, if the last file was unusable. */
  get recoveryNotice(): { backup: string; reason: string } | null {
    return this.recovery;
  }

  private persist(): void {
    saveStateFile(this.path, this.data);
  }

  list(): ClusterRoom[] {
    return this.data.rooms.map((r) => ({ ...r }));
  }

  get(id: string): ClusterRoom | undefined {
    return this.data.rooms.find((r) => r.id === id);
  }

  /** Re-expand members after a role configuration change. */
  private applyRoles(room: ClusterRoom, workspaceRoot: string): void {
    room.members = expandMembers(room.roles);
    // Sanity: keep at least one speaker so a wave can always run.
    if (!room.members.length) {
      const fallback = buildDefaultRoles(workspaceRoot);
      room.roles = fallback;
      room.members = expandMembers(fallback);
    }
  }

  reloadMemberSkills(workspaceRoot: string, roomId?: string): void {
    const rooms = roomId ? this.data.rooms.filter((r) => r.id === roomId) : this.data.rooms;
    for (const room of rooms) {
      room.roles = room.roles.map((role) => {
        // Custom roles keep whatever skill the user/agent wrote.
        if (role.isCustom) return role;
        return { ...role, skill: loadSkillFile(workspaceRoot, role.key) ?? role.skill };
      });
      this.applyRoles(room, workspaceRoot);
    }
    this.persist();
  }

  create(workspaceRoot: string, title?: string): ClusterRoom {
    const roles = buildDefaultRoles(workspaceRoot);
    const members = expandMembers(roles);
    const room: ClusterRoom = {
      id: randomUUID().slice(0, 8),
      title: title?.trim() || '协作群',
      created_at: nowIso(),
      updated_at: nowIso(),
      roles,
      members,
      messages: [
        {
          id: randomUUID().slice(0, 10),
          role: 'system',
          name: '系统',
          content: `工作群已创建。成员：${members.map((m) => m.name).join(' / ')}。可并行发言。`,
          created_at: nowIso(),
        },
      ],
      status: 'idle',
      workspace: workspaceRoot,
    };
    this.data.rooms.unshift(room);
    this.persist();
    return room;
  }

  /**
   * Replace a room's role configuration.
   * `roles` is the full desired set; counts of 0 disable a role.
   */
  setRoles(roomId: string, roles: ClusterRole[], workspaceRoot: string): ClusterRoom | null {
    const room = this.get(roomId);
    if (!room) return null;
    room.roles = roles.map((r) => ({
      ...r,
      count: Math.max(0, Math.floor(Number(r.count) || 0)),
    }));
    this.applyRoles(room, workspaceRoot);
    room.updated_at = nowIso();
    this.persist();
    return room;
  }

  /** Add or update a single role (used by the custom-role editor). */
  upsertRole(roomId: string, role: ClusterRole, workspaceRoot: string): ClusterRoom | null {
    const room = this.get(roomId);
    if (!room) return null;
    const idx = room.roles.findIndex((r) => r.key === role.key);
    if (idx >= 0) room.roles[idx] = { ...room.roles[idx], ...role, isCustom: true };
    else room.roles.push({ ...role, isCustom: true });
    this.applyRoles(room, workspaceRoot);
    room.updated_at = nowIso();
    this.persist();
    return room;
  }

  removeRole(roomId: string, roleKey: string, workspaceRoot: string): ClusterRoom | null {
    const room = this.get(roomId);
    if (!room) return null;
    room.roles = room.roles.filter((r) => r.key !== roleKey);
    this.applyRoles(room, workspaceRoot);
    room.updated_at = nowIso();
    this.persist();
    return room;
  }

  rename(roomId: string, title: string): ClusterRoom | null {
    const room = this.get(roomId);
    if (!room) return null;
    room.title = title.trim() || room.title;
    room.updated_at = nowIso();
    this.persist();
    return room;
  }

  remove(roomId: string): void {
    this.data.rooms = this.data.rooms.filter((r) => r.id !== roomId);
    this.persist();
  }

  append(roomId: string, msg: Omit<ClusterMessage, 'id' | 'created_at'> & { id?: string; created_at?: string }): ClusterMessage | null {
    const room = this.get(roomId);
    if (!room) return null;
    const full: ClusterMessage = {
      id: msg.id || randomUUID().slice(0, 10),
      created_at: msg.created_at || nowIso(),
      role: msg.role,
      name: msg.name,
      content: msg.content,
      parallel_group: msg.parallel_group,
    };
    room.messages.push(full);
    room.updated_at = full.created_at;
    this.persist();
    return full;
  }

  setStatus(roomId: string, status: ClusterRoom['status'], last_error?: string): void {
    const room = this.get(roomId);
    if (!room) return;
    room.status = status;
    room.last_error = last_error;
    room.updated_at = nowIso();
    this.persist();
  }

  reloadSkills(roomId: string, workspaceRoot: string): ClusterRoom | null {
    const room = this.get(roomId);
    if (!room) return null;
    room.roles = buildDefaultRoles(workspaceRoot);
    this.applyRoles(room, workspaceRoot);
    room.updated_at = nowIso();
    this.persist();
    return room;
  }
}

function createProvider(config: SheConfig): LLMProvider {
  const level = config.llm.thinkingLevel || 'medium';
  if (config.llm.provider === 'anthropic') {
    return new AnthropicProvider(config.llm.apiKey, config.llm.model, config.llm.maxTokens, Math.min(config.llm.temperature, 0.5));
  }
  return new OpenAIProvider(
    config.llm.apiKey,
    config.llm.baseUrl,
    config.llm.model,
    config.llm.maxTokens,
    config.llm.temperature,
    level,
  );
}

function transcriptFor(room: ClusterRoom): string {
  return room.messages
    .map((m) => `[${m.name}] ${m.content}`)
    .join('\n\n');
}

/**
 * Words that assert an outcome. Shared in spirit with `critic.ts` in agent-runtime, kept separate
 * because the two check different records (a run trace there, a room transcript here) and a shared
 * list would invite one to be tuned for the other's false positives.
 */
const ROOM_ASSERTION = /(已经|已|全部|都|通过|跑通|修好|修复|验证过|确认过|完成|成功|没问题|可以了)/;

/**
 * Anything in a message that could serve as evidence for the claim next to it.
 *
 * A fenced block, an inline code span, a shell transcript line, a path or a command-shaped token, or
 * a quoted passage. This is deliberately loose: the audit below flags messages with NONE of these,
 * and the cost of a loose definition is a claim the critic still has to look at — while a tight one
 * would flag ordinary prose that does name its files.
 */
const ROOM_EVIDENCE = /```|`[^`]{2,}`|^\s*\$\s|\b[\w./\\-]{4,}\b|「[^」]{2,}」|"[^"]{2,}"/m;

export interface RoomClaimFinding {
  /** Who said it. */
  name: string;
  /** The sentence that asserts an outcome. */
  claim: string;
  /** Why it is being handed to the critic. */
  detail: string;
}

/**
 * Claims made by the work wave that carry no visible evidence.
 *
 * This is the part of the critic's job that does not need a model, and running it deterministically
 * first changes what the critic is FOR. Without it, the critic role is a sixth model reading the same
 * transcript and agreeing in the same fluent tone; with it, the critic starts from a list of specific
 * sentences that assert success and contain no code block, no output, no path and no quotation, and
 * has something falsifiable to work on.
 *
 * It is a FILTER, not a verdict. Nothing is failed here, and a finding is not proof of a problem —
 * "已经改好了" with the file named in the previous sentence is a legitimate report. That is why the
 * output is a list handed to the room rather than a status change on the room.
 */
export function auditRoomClaims(messages: ClusterMessage[], members: ClusterMember[]): RoomClaimFinding[] {
  const phaseOf = new Map(members.map((m) => [m.id, m.phase]));
  const findings: RoomClaimFinding[] = [];
  for (const m of messages) {
    // Only the work wave: the lead's summary is expected to restate others' results, and the review
    // wave's own output must not be audited by the rule it is about to apply.
    if (phaseOf.get(m.role) !== 'work') continue;
    if (ROOM_EVIDENCE.test(m.content)) continue;
    for (const sentence of m.content.split(/(?<=[。！？!?;；\n])/)) {
      const claim = sentence.replace(/^\s*(?:[-*•]|\d+[.、)]|#{1,6})\s*/, '').trim();
      if (claim.length < 6 || !ROOM_ASSERTION.test(claim)) continue;
      findings.push({
        name: m.name,
        claim,
        detail: '这条结论没有任何可核对的依据（没有代码块、没有输出、没有路径、没有引用原文）',
      });
    }
  }
  return findings;
}

/** The audit as a room message, or an empty string when there is nothing to hand over. */
export function renderClaimAudit(findings: RoomClaimFinding[]): string {
  if (!findings.length) return '';
  return [
    `【系统·独立核对清单】工作阶段有 ${findings.length} 条结论没有附带任何可核对的依据：`,
    ...findings.map((f) => `- ${f.name}：「${f.claim}」—— ${f.detail}`),
    '',
    '请批评者逐条处理：要出处，或者标为无依据。不要把这条清单当成结论，它只是待核对项。',
  ].join('\n');
}

async function memberSpeak(opts: {
  config: SheConfig;
  room: ClusterRoom;
  member: ClusterMember;
  userGoal: string;
  phase: string;
  parallelGroup?: string;
  store: ClusterStore;
  onEvent?: (ev: StreamChunk & { member?: string; phase?: string; name?: string }) => void;
}): Promise<ClusterMessage> {
  const { config, room, member, userGoal, phase, parallelGroup, store, onEvent } = opts;
  const provider = createProvider(config);
  const roster = room.members
    .map((m) => `- ${m.name}（${m.title}，阶段 ${m.phase}）${m.id === member.id ? ' ← 这是你' : ''}`)
    .join('\n');
  const system = `你在 SHE 自动化讨论群里发言。
你是：${member.name}（${member.title}）
阶段：${phase}

## 团队名册
下面这些人才是这个群里的成员。点名、交接、分工只能用这些名字。不要发明名单上没有的人，也不要假装自己是别人。
${roster || '（当前没有其他成员）'}

规则：
- 用中文，简洁，面向协作。
- 只做自己职责内的事；需要别人做的事，点名册上的名字。
- 不要假装已经执行了未发生的命令。
- 可以引用群里前人发言。并行时你们同时写，看不到彼此这一轮还没写完的内容。

## 角色 skill
${member.skill}`;

  const user = `用户总目标：
${userGoal}

## 最近群消息
${transcriptFor(room)}

请以「${member.name}」身份完成本阶段发言。`;

  onEvent?.({ type: 'status', content: `${member.name} 开始`, member: member.id, phase, memberState: 'running' } as any);

  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let text = '';
  try {
    const reply = await provider.chat(messages, undefined, (chunk) => {
      if ((chunk.type === 'text' || chunk.type === 'reasoning') && chunk.content) {
        if (chunk.type === 'text') text += chunk.content;
        onEvent?.({ ...chunk, member: member.id, name: member.name, phase });
      }
    });
    if (!text && reply.content) text = reply.content;
  } catch (err) {
    // fallback provider once
    const fb = config.llm.fallback;
    if (fb && (fb.apiKey || fb.baseUrl)) {
      onEvent?.({ type: 'status', content: `${member.name} 主接口失败，改备用…`, member: member.id, phase });
      const fbProvider =
        (fb.provider || 'openai') === 'anthropic'
          ? new AnthropicProvider(fb.apiKey || config.llm.apiKey, fb.model || config.llm.model, config.llm.maxTokens, config.llm.temperature)
          : new OpenAIProvider(
              fb.apiKey || config.llm.apiKey,
              fb.baseUrl || config.llm.baseUrl,
              fb.model || config.llm.model,
              config.llm.maxTokens,
              config.llm.temperature,
              config.llm.thinkingLevel || 'medium',
            );
      const reply = await fbProvider.chat(messages);
      text = reply.content || '';
    } else {
      throw err;
    }
  }

  const content = (text || '(空回应)').trim();
  const saved = store.append(room.id, {
    role: member.id,
    name: member.name,
    content,
    parallel_group: parallelGroup,
  });
  onEvent?.({ type: 'status', content: `${member.name} 完成`, member: member.id, phase, memberState: 'done' } as any);
  return saved!;
}

/**
 * One automated wave, driven by the room's role configuration:
 *   lead        → one speaker splits the work
 *   work        → every worker at once
 *   review      → every reviewer at once
 *   lead        → one speaker summarises after both waves
 *
 * Roles with count 0 are simply absent from `room.members`, so the wave adapts
 * to whatever the user configured.
 */
export async function runClusterWave(opts: {
  config: SheConfig;
  store: ClusterStore;
  roomId: string;
  goal: string;
  onEvent?: (ev: StreamChunk & { member?: string; phase?: string; name?: string }) => void;
}): Promise<ClusterRoom> {
  const room = opts.store.get(opts.roomId);
  if (!room) throw new Error('room not found');
  if (room.status === 'running') throw new Error('room already running');
  if (!opts.config.llm.apiKey) throw new Error('LLM API key missing — set in Settings');
  if (!room.members.length) throw new Error('该工作群没有任何角色（每个角色数量都是 0）');

  opts.store.reloadMemberSkills(opts.config.workspace.root, opts.roomId);
  opts.store.setStatus(opts.roomId, 'running');
  opts.store.append(opts.roomId, {
    role: 'user',
    name: '用户',
    content: opts.goal,
  });

  const snapshot = () => opts.store.get(opts.roomId)!;
  const membersOf = (phase: ClusterPhase) => snapshot().members.filter((m) => m.phase === phase);

  const speak = async (
    member: ClusterMember,
    phaseLabel: string,
    parallelGroup?: string,
  ) => {
    try {
      await memberSpeak({
        config: opts.config,
        room: snapshot(),
        member,
        userGoal: opts.goal,
        phase: phaseLabel,
        parallelGroup,
        store: opts.store,
        onEvent: opts.onEvent,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.store.append(opts.roomId, {
        role: member.id,
        name: member.name,
        content: `（发言失败：${msg}）`,
        parallel_group: parallelGroup,
      });
      opts.onEvent?.({
        type: 'status',
        content: `${member.name} 失败：${msg}`,
        member: member.id,
        phase: phaseLabel,
      } as any);
    }
  };

  try {
    // ── 1. lead phase (first lead member splits the work) ──
    const leads = membersOf('lead');
    const lead = leads[0];
    if (lead) {
      await speak(lead, '拆解与分工');
    }

    // Snapshot once per wave so parallel speakers share a context and do not
    // wait on each other's replies. Lead split and the final summary stay
    // single-speaker because they have to read what the wave just said.
    const runParallel = async (members: ClusterMember[], phaseLabel: string) => {
      if (!members.length) return;
      const parallelId = randomUUID().slice(0, 8);
      opts.onEvent?.({
        type: 'status',
        content: `并行：${members.map((m) => m.name).join(' / ')}`,
        phase: phaseLabel,
      } as any);
      const snap = snapshot();
      const settled = await Promise.allSettled(
        members.map((m) =>
          memberSpeak({
            config: opts.config,
            room: snap,
            member: m,
            userGoal: opts.goal,
            phase: phaseLabel,
            parallelGroup: parallelId,
            store: opts.store,
            onEvent: opts.onEvent,
          }),
        ),
      );
      // One speaker throwing used to reject the whole wave, so the other
      // members' finished work never reached review. Record the failure and
      // let the rest of the room continue.
      for (let i = 0; i < settled.length; i++) {
        const item = settled[i];
        if (item.status !== 'rejected') continue;
        const member = members[i];
        const msg = item.reason instanceof Error ? item.reason.message : String(item.reason);
        opts.store.append(opts.roomId, {
          role: member.id,
          name: member.name,
          content: `（发言失败：${msg}）`,
          parallel_group: parallelId,
        });
        opts.onEvent?.({
          type: 'status',
          content: `${member.name} 失败：${msg}`,
          member: member.id,
          phase: phaseLabel,
        } as any);
      }
    };

    await runParallel(membersOf('work'), '并行产出');

    /*
     * The independent check runs BETWEEN the waves, and it is not a speaker.
     *
     * A deterministic pass over what the work wave actually wrote, appended as a system message so
     * the review wave reads it as part of the transcript. Doing it this way rather than asking a model
     * to "please be critical of the others" is what makes the critic independent: the list is produced
     * by the same kind of rule the agent's own delivery check uses, and no amount of confident phrasing
     * in the work messages changes it.
     */
    const reviewMembers = membersOf('review');
    if (reviewMembers.length) {
      const audit = auditRoomClaims(snapshot().messages, snapshot().members);
      if (audit.length) {
        opts.store.append(opts.roomId, {
          role: 'system',
          name: '系统',
          content: renderClaimAudit(audit),
        });
        opts.onEvent?.({
          type: 'status',
          content: `独立核对：${audit.length} 条结论没有依据，已交给${reviewMembers.map((m) => m.name).join('/')}`,
          phase: '并行审查',
        } as any);
      }
    }

    await runParallel(reviewMembers, '并行审查');

    // ── 4. lead phase closes out (a second lead member, or the same one) ──
    const summarizer = leads[1] ?? lead;
    if (summarizer) {
      await speak(summarizer, '汇总与下一步');
    }

    opts.store.setStatus(opts.roomId, 'idle');
    opts.onEvent?.({ type: 'done' });
    return snapshot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.store.setStatus(opts.roomId, 'error', msg);
    opts.store.append(opts.roomId, { role: 'system', name: '系统', content: `运行失败：${msg}` });
    opts.onEvent?.({ type: 'error', error: msg });
    throw err;
  }
}

/**
 * Ask the LLM to write a skill for one role.
 * Used by the custom-role editor ("描述需求让 AI 帮忙生成 skill").
 */
export async function generateRoleSkill(
  config: SheConfig,
  role: { name: string; title: string },
  requirement?: string,
): Promise<string> {
  if (!config.llm.apiKey) throw new Error('LLM API key missing');
  const provider = createProvider(config);
  const prompt = `为 SHE 工作群的「${role.name}」角色写一份 skill（Markdown）。
职责概述：${role.title}
${requirement ? `用户补充要求：${requirement}` : ''}

要求：中文；包含「职责 / 输入 / 输出格式 / 禁忌 / 与其他角色交接」五个小节；300-600 字；
并行工作时不要抢占其他角色的职责；不要写代码块围栏外的寒暄或解释。`;
  const reply = await provider.chat([
    { role: 'system', content: '你只输出 Markdown skill 正文，不要任何前后缀说明。' },
    { role: 'user', content: prompt },
  ]);
  return (reply.content || defaultSkillFor(role.name, role.name)).trim();
}

/** Ask leader LLM to write cluster-*.md skills into custom/. */
export async function initClusterIdentitySkills(config: SheConfig, workspaceRoot: string): Promise<string[]> {
  if (!config.llm.apiKey) throw new Error('LLM API key missing');
  const provider = createProvider(config);
  const dir = join(workspaceRoot, '.she', 'skills', 'custom');
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];

  await Promise.all(
    DEFAULT_ROLES.map(async (m) => {
      const prompt = `为 SHE 自动化讨论群生成角色 skill（Markdown）。角色：${m.name}（${m.key}）职责：${m.title}。
要求：中文；含「职责 / 输入 / 输出格式 / 禁忌 / 与其他角色交接」；300-600字；并行时不抢他人职责；不要代码块围栏外的废话。`;
      const reply = await provider.chat([
        { role: 'system', content: '你只输出 Markdown skill 正文。' },
        { role: 'user', content: prompt },
      ]);
      const body = (reply.content || defaultSkillFor(m.key, m.name)).trim() + '\n';
      const file = join(dir, `cluster-${m.key}.md`);
      writeFileSync(file, body, 'utf8');
      written.push(file);
    }),
  );

  return written;
}
