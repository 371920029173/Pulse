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

/** The five built-in roles, matching the original design. */
export const DEFAULT_ROLES: Omit<ClusterRole, 'skill'>[] = [
  { key: 'leader', name: '领导', title: '拆任务、对齐、汇总', count: 1, phase: 'lead', hue: 220 },
  { key: 'logistics', name: '后勤', title: '路径、依赖、归档、清单', count: 1, phase: 'work', hue: 140 },
  { key: 'copy', name: '文案', title: '说明、文档、口径', count: 1, phase: 'work', hue: 275 },
  { key: 'eng', name: '研发', title: '实现方案、接口、测试', count: 1, phase: 'work', hue: 205 },
  { key: 'review', name: '审查', title: '找漏、风险、验收标准', count: 1, phase: 'review', hue: 40 },
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
        if (t) return t.slice(0, 8000);
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
    const count = Math.max(0, Math.min(9, Math.floor(role.count)));
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
    return this.data.rooms.map((r) => ({ ...r, messages: r.messages.slice(-200) }));
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
      count: Math.max(0, Math.min(9, Math.floor(Number(r.count) || 0))),
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
    Math.min(config.llm.maxTokens, 2048),
    config.llm.temperature,
    level,
  );
}

function transcriptFor(room: ClusterRoom, limit = 24): string {
  return room.messages
    .slice(-limit)
    .map((m) => `[${m.name}] ${m.content}`)
    .join('\n\n');
}

async function memberSpeak(opts: {
  config: SheConfig;
  room: ClusterRoom;
  member: ClusterMember;
  userGoal: string;
  phase: string;
  parallelGroup?: string;
  store: ClusterStore;
  onEvent?: (ev: StreamChunk & { member?: string; phase?: string }) => void;
}): Promise<ClusterMessage> {
  const { config, room, member, userGoal, phase, parallelGroup, store, onEvent } = opts;
  const provider = createProvider(config);
  const system = `你在 SHE 自动化讨论群里发言。
角色：${member.name}（${member.title}）
阶段：${phase}
规则：
- 用中文，简洁，面向协作。
- 只做自己职责内的事；需要别人做的事点名角色。
- 不要假装已经执行了未发生的命令。
- 可以引用群里前人发言。

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
      if (chunk.type === 'text' && chunk.content) {
        text += chunk.content;
        onEvent?.({ ...chunk, member: member.id, phase });
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
          ? new AnthropicProvider(fb.apiKey || config.llm.apiKey, fb.model || config.llm.model, 2048, 0.3)
          : new OpenAIProvider(
              fb.apiKey || config.llm.apiKey,
              fb.baseUrl || config.llm.baseUrl,
              fb.model || config.llm.model,
              2048,
              0.3,
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
 *   lead phase  → sequential (领导拆解)
 *   work phase  → parallel (后勤 / 文案 / 研发 …)
 *   review phase→ sequential (审查)
 *   lead phase  → sequential again (领导汇总)
 *
 * Roles with count 0 are simply absent from `room.members`, so the wave adapts
 * to whatever the user configured.
 */
export async function runClusterWave(opts: {
  config: SheConfig;
  store: ClusterStore;
  roomId: string;
  goal: string;
  onEvent?: (ev: StreamChunk & { member?: string; phase?: string }) => void;
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
  };

  try {
    // ── 1. lead phase (first lead member splits the work) ──
    const leads = membersOf('lead');
    const lead = leads[0];
    if (lead) {
      await speak(lead, '拆解与分工');
    }

    // ── 2. work phase, in parallel ──
    const workers = membersOf('work');
    if (workers.length) {
      const parallelId = randomUUID().slice(0, 8);
      const names = workers.map((m) => m.name).join(' / ');
      opts.onEvent?.({
        type: 'status',
        content: `并行波次：${names}`,
        phase: '并行产出',
      } as any);

      // Snapshot the transcript once so parallel speakers see the same context
      // instead of racing each other's writes.
      const snap = snapshot();
      await Promise.all(
        workers.map((m) =>
          memberSpeak({
            config: opts.config,
            room: snap,
            member: m,
            userGoal: opts.goal,
            phase: '并行产出',
            parallelGroup: parallelId,
            store: opts.store,
            onEvent: opts.onEvent,
          }),
        ),
      );
    }

    // ── 3. review phase ──
    for (const m of membersOf('review')) {
      await speak(m, '审查');
    }

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
