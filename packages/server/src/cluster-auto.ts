/**
 * Auto-continuation and the shared plan for work groups (cluster rooms).
 *
 * A wave used to be exactly one pass (lead → work → review → lead summary) per user message. The
 * summary is where the leader hands out the next assignments, and nothing ever read it: the group
 * stopped right after being told what to do next, and waited for the user to say "继续". In
 * automation mode that is a turn-based group pretending to be an autonomous one.
 *
 * Everything here is deterministic and pure (apart from the plan store), so the rules can be
 * tested without a model:
 *   - `decideContinuation` — after a round, is there outstanding assigned work, and for whom?
 *   - `isSubstantiveRound` — did the round produce anything new (the stall guard)?
 *   - `createGroupPlanTools` — the single-agent plan tools, scoped to one room.
 *
 * Conversation history stays append-only: continuation is expressed by APPENDING a system note to
 * the room, never by editing what was already said (the DeepSeek prefix cache depends on it).
 */
import { createPlanTools, renderPlan, type Plan } from '@she/agent-runtime';
// Not re-exported from the package index; the dist module is the same code the single-agent loop runs.
import { planAutopilot } from '@she/agent-runtime/dist/plan-tools.js';
import type { ToolDefinition } from '@she/shared';

export interface AutoMember {
  id: string;
  name: string;
  phase: 'lead' | 'work' | 'review';
}

export interface AutoMessage {
  role: string;
  name: string;
  content: string;
}

export interface ClusterAutoSettings {
  /** Automation mode on and not disabled with SHE_CLUSTER_AUTO=0. */
  enabled: boolean;
  /** Extra rounds allowed per user message (SHE_CLUSTER_AUTO_MAX, default 20). */
  maxRounds: number;
  /** Consecutive rounds without substantive output before stopping (SHE_CLUSTER_AUTO_STALL, default 2). */
  stallRounds: number;
  /** Whether members get the plan tools (SHE_CLUSTER_PLAN=0 turns them off). */
  planTools: boolean;
}

function intEnv(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function clusterAutoSettings(
  config: { automationMode?: boolean },
  env: Record<string, string | undefined> = process.env,
): ClusterAutoSettings {
  const off = (v: string | undefined) => v === '0' || v === 'false';
  const maxRounds = intEnv(env.SHE_CLUSTER_AUTO_MAX, 20, 0);
  return {
    enabled: config.automationMode !== false && !off(env.SHE_CLUSTER_AUTO) && maxRounds > 0,
    maxRounds,
    stallRounds: intEnv(env.SHE_CLUSTER_AUTO_STALL, 2, 1),
    planTools: !off(env.SHE_CLUSTER_PLAN),
  };
}

// ─── Reading the round ──────────────────────────────────────────────────────

/** The leader explicitly closing the task. */
const DONE_MARK = /【\s*(收工|完成|结束|已收工)\s*】/;
/** A line that hands out work. */
const ASSIGN_CUE = /@|请|负责|跟进|继续|下一步|接下来|待办|TODO|去做|着手|认领|交给|需要|尽快|本轮|这一轮|下一轮|补充|修复|改为|改成/i;
/** A name followed by a colon/arrow — the shape of a 分工表 row. */
const ROW_TAIL = '\\s*(?:[:：→]|->)';
/** A row that only reports a finished result. */
const REPORT_ONLY = /已完成|已交付|已经完成|LGTM|没问题|已通过|已确认/;
/** A member saying they will do more. */
const COMMIT_CUE = /(我|本人)(下一轮|下轮|接下来|稍后|随后|之后会|马上|这就|会继续|将继续|继续跟进|会去|去跑|去执行|去验证|下一步)/;
/** Ends with a question — someone is asking the user. */
const QUESTION_END = /[?？]\s*[)）」』"'`*_~]*\s*$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "研发2" → "研发": the leader often names the role, not the seat. */
function roleNameOf(name: string): string {
  return name.replace(/\d+$/, '');
}

/**
 * Members a message hands work to.
 *
 * `@名字` always counts. A bare name counts on a line that also assigns (a cue word, or the
 * `名字：…` row shape of a 分工表) — unless that row only reports something already finished.
 * A role name without the seat number ("@研发" in a room with 研发1/研发2) addresses every seat
 * of that role; "研发1" never matches 研发10 or the other seats.
 */
export function mentionedMembers(text: string, members: AutoMember[]): AutoMember[] {
  const hit = new Set<string>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    // "@全体 …" addresses every seat on the list it was given.
    if (/@\s*(全体|所有人|大家|全员|all)/i.test(line)) return [...members];
    for (const m of members) {
      if (hit.has(m.id)) continue;
      const names = [m.name];
      const role = roleNameOf(m.name);
      if (role && role !== m.name) names.push(role);
      for (const n of names) {
        const esc = escapeRe(n);
        if (new RegExp(`@\\s*${esc}(?!\\d)`).test(line)) { hit.add(m.id); break; }
        if (!new RegExp(`${esc}(?!\\d)`).test(line)) continue;
        const row = new RegExp(`${esc}(?!\\d)${ROW_TAIL}`).test(line);
        const cue = ASSIGN_CUE.test(line);
        if ((row || cue) && !(REPORT_ONLY.test(line) && !cue)) { hit.add(m.id); break; }
      }
    }
  }
  return members.filter((m) => hit.has(m.id));
}

export function endsWithQuestion(text: string): boolean {
  return QUESTION_END.test(String(text ?? '').trim());
}

export function planSignature(plan: Plan | undefined): string {
  return plan ? `${plan.id}|${plan.status}|${plan.steps.map((s) => `${s.id}:${s.status}`).join(',')}` : '';
}

/** A step blocked with `ask`/`stop` — by its own declaration it needs a person. */
function parkedStep(plan: Plan | undefined) {
  if (!plan || plan.status !== 'open') return undefined;
  return plan.steps.find((s) => s.status === 'blocked' && (s.onFailure === 'ask' || s.onFailure === 'stop'));
}

export interface ContinuationDecision {
  proceed: boolean;
  /** Why it continues or stops — shown in the status line / the room. */
  reason: string;
  /** Who speaks in the next round (never a lead seat: the lead always summarises). */
  targets: AutoMember[];
  /** Human-readable causes, e.g. "领导点名：研发". */
  why: string[];
  /** The plan autopilot's nudge, when the plan is what keeps the group going. */
  planNudge?: string;
}

/**
 * After a round: is there outstanding assigned work, and who should pick it up?
 *
 * Continues when the leader's closing message assigns work to members (by `@名字` or a 分工 row),
 * when a member said they will do more, or when the group plan has runnable steps that this round
 * moved (the same rule as the single-agent `planAutopilot`). Stops when the leader closes with
 * 【收工】, when the round ends in a question to the user, or when a plan step is parked on
 * ask/stop.
 */
export function decideContinuation(input: {
  roundMessages: AutoMessage[];
  members: AutoMember[];
  plan?: Plan;
  roundStartedAt: number;
  /**
   * Members the USER named with `@` in the message that started this wave.
   *
   * Without this, `@` only worked in one direction: the leader's closing summary could address
   * members, but a person writing "@研发1 去查 X" was talking to nobody — the mention sat in the
   * goal text as prose. Worse, it made the room look single-turn: a leader that *reports* instead
   * of *assigning* ("总结：报告见上。") ended the run, and the unfinished goal waited for the user
   * to prod it. A user mention is the strongest instruction in the room, so it both seeds the
   * targets and keeps the wave from stopping on "没有待处理的分派".
   *
   * It deliberately does NOT override the explicit stops: 【收工】, a question to the user, and a
   * plan step parked on ask/stop still end the wave. Overriding those would make one mention run
   * the room to the round cap. Cost stays bounded by the cap and the stall guard.
   */
  userDirective?: AutoMember[];
}): ContinuationDecision {
  const { members } = input;
  const byId = new Map(members.map((m) => [m.id, m]));
  const spoken = input.roundMessages.filter((m) => m.role !== 'user' && m.role !== 'system');
  const leadMsgs = spoken.filter((m) => byId.get(m.role)?.phase === 'lead');
  const closing = leadMsgs[leadMsgs.length - 1] ?? spoken[spoken.length - 1];
  const stop = (reason: string): ContinuationDecision => ({ proceed: false, reason, targets: [], why: [] });

  if (!closing) return stop('这一轮没有人发言');
  if (endsWithQuestion(closing.content)) return stop('在等你回答问题');
  if (DONE_MARK.test(closing.content)) return stop(`${closing.name}宣布收工`);
  const parked = parkedStep(input.plan);
  if (parked) return stop(`计划步骤「${parked.title}」卡住了（onFailure=${parked.onFailure}），需要你来定`);

  const workers = members.filter((m) => m.phase !== 'lead');
  const targets = new Map<string, AutoMember>();
  const why: string[] = [];

  const named = mentionedMembers(closing.content, workers);
  if (named.length) {
    for (const m of named) targets.set(m.id, m);
    why.push(`${closing.name}点名：${named.map((m) => m.name).join('、')}`);
  }

  const committed: AutoMember[] = [];
  for (const msg of spoken) {
    const m = byId.get(msg.role);
    if (!m || m.phase === 'lead' || !COMMIT_CUE.test(msg.content)) continue;
    if (!committed.some((c) => c.id === m.id)) committed.push(m);
  }
  if (committed.length) {
    for (const m of committed) targets.set(m.id, m);
    why.push(`说了还要继续做：${committed.map((m) => m.name).join('、')}`);
  }

  let planNudge: string | undefined;
  const ap = planAutopilot(input.plan, { turnStartedAt: input.roundStartedAt, reply: closing.content });
  if (ap.proceed && input.plan) {
    planNudge = ap.nudge;
    // The runnable step's owner, when its title names one; otherwise the whole work wave.
    const done = new Set(input.plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
    const runnable = input.plan.steps.filter(
      (s) => s.status === 'active' || (s.status === 'pending' && s.dependsOn.every((d) => done.has(d))),
    );
    let owners = mentionedMembers(runnable.map((s) => `${s.title}：${s.note ?? ''}`).join('\n'), workers);
    if (!owners.length) {
      // Titles like "研发 实现接口" have no cue word; fall back to plain name occurrence.
      owners = workers.filter((m) => runnable.some((s) => s.title.includes(m.name) || s.title.includes(roleNameOf(m.name))));
    }
    if (!owners.length && !targets.size) owners = workers.filter((m) => m.phase === 'work');
    for (const m of owners) targets.set(m.id, m);
    why.push(`计划还有可执行的步骤：${runnable.map((s) => `${s.id} ${s.title}`).join('；')}`);
  }

  /*
   * The person's own mention, applied last so it is added to whatever the leader already assigned.
   *
   * A leader that assigns nothing no longer ends the wave on its own when the user named someone:
   * "没有待处理的分派" was accurate about the *summary* and wrong about the room's outstanding work.
   */
  const directed = input.userDirective ?? [];
  if (directed.length) {
    for (const m of directed) targets.set(m.id, m);
    why.push(`用户点名：${directed.map((m) => m.name).join('、')}`);
  }

  if (!targets.size) return stop('没有待处理的分派');
  return {
    proceed: true,
    reason: why.join('；'),
    targets: members.filter((m) => targets.has(m.id)),
    why,
    planNudge,
  };
}

// ─── Stall guard ────────────────────────────────────────────────────────────

const ACK_ONLY = /^(收到|好的|明白|了解|ok|没问题|同意|可以)/i;

function squash(s: string): string {
  return String(s ?? '').replace(/\s+/g, '');
}

/** Dice coefficient over character bigrams: 1 means the same text. */
export function textSimilarity(a: string, b: string): number {
  const x = squash(a);
  const y = squash(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) { overlap++; grams.set(g, n - 1); }
  }
  return (2 * overlap) / (x.length - 1 + y.length - 1);
}

/**
 * Did a round produce anything new from the members who were asked to work?
 *
 * The leader's summary does not count — it always writes something — and neither do failures,
 * bare acknowledgements ("收到，我会做") or a repeat of what the same member said before. A plan
 * that moved counts as progress on its own (the caller compares plan signatures).
 */
export function isSubstantiveRound(round: AutoMessage[], earlier: AutoMessage[], members: AutoMember[]): boolean {
  const lead = new Set(members.filter((m) => m.phase === 'lead').map((m) => m.id));
  for (const m of round) {
    if (m.role === 'user' || m.role === 'system' || lead.has(m.role)) continue;
    const text = String(m.content ?? '').trim();
    const body = squash(text);
    if (body.length < 30) continue;
    if (/^（发言失败|^\(空回应\)/.test(text)) continue;
    if (ACK_ONLY.test(text) && body.length < 80) continue;
    let prev: AutoMessage | undefined;
    for (let i = earlier.length - 1; i >= 0; i--) {
      if (earlier[i].role === m.role) { prev = earlier[i]; break; }
    }
    if (prev && textSimilarity(prev.content, text) >= 0.9) continue;
    return true;
  }
  return false;
}

/** The note appended to the room before an automatic round. Appended, never edited in. */
export function renderContinuationNote(
  round: number,
  max: number,
  decision: ContinuationDecision,
  plan: Plan | undefined,
): string {
  const lines = [
    `【系统·自动续跑 第 ${round}/${max} 轮】上一轮还有没做完的分派，这一轮由 ${decision.targets.map((m) => m.name).join('、')} 接着做。`,
    ...decision.why.map((w) => `- ${w}`),
    '被点名的成员：直接动手完成自己那部分，给出可核对的产出（文件、命令、原文），不要只回复「收到」；做完计划里的步骤就 plan_update。',
    '领导最后汇总：还有活就用「@名字 + 任务」继续分派；全部完成写【收工】；需要用户拍板就用问号结尾提问。',
  ];
  if (plan && plan.status === 'open') lines.push('', '当前群计划：', renderPlan(plan));
  return lines.join('\n');
}

// ─── Group plan tools ───────────────────────────────────────────────────────

export const GROUP_PLAN_TOOLS = ['plan_create', 'plan_update', 'plan_add_steps', 'plan_get'] as const;

/** Plans are stored in the workspace plan file, stamped with this pseudo session id per room. */
export function groupPlanSession(roomId: string): string {
  return `cluster:${roomId}`;
}

/**
 * The single-agent plan tools, scoped to one room.
 *
 * Same store and same rules (`.she/plans.json`, dependencies, onFailure), with three differences:
 * only the plan tools are offered (no ask_user / report_write — the group has no turn to end),
 * a call without `plan_id` goes to THIS room's open plan instead of whatever plan is newest in the
 * workspace, and a plan belonging to another chat or room cannot be touched from here.
 */
export function createGroupPlanTools(workspaceRoot: string, roomId: string): {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  current: () => Plan | undefined;
} {
  const session = groupPlanSession(roomId);
  const inner = createPlanTools(workspaceRoot, session);
  const allowed = new Set<string>(GROUP_PLAN_TOOLS);
  const definitions = inner.definitions.filter((d) => allowed.has(d.name));
  const current = () => inner.store.mine();

  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (!allowed.has(name)) return `Error: 群聊里只能用 ${GROUP_PLAN_TOOLS.join(' / ')}`;
    const mine = current();
    if (name === 'plan_create') {
      if (mine) {
        return `Error: 本群已经有进行中的计划 ${mine.id}「${mine.title}」——用 plan_add_steps 追加步骤，或先把剩余步骤标成 dropped`;
      }
      return inner.execute(name, args);
    }
    const given = String(args.plan_id ?? '').trim();
    if (!given) {
      if (!mine) return 'Error: 本群还没有计划——先由领导用 plan_create 建一个';
      return inner.execute(name, { ...args, plan_id: mine.id });
    }
    const target = inner.store.get(given);
    if (target && target.sessionId !== session) {
      return `Error: ${target.id} 不是本群的计划（本群计划：${mine?.id ?? '无'}）`;
    }
    return inner.execute(name, args);
  };

  return { definitions, execute, current };
}
