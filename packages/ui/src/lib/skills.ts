/**
 * Skill profiles — the single source of truth.
 *
 * A profile decides which `_common` + per-profile skill files get injected into
 * the system prompt. The set lived as a hand-written union in four places, and
 * they had already drifted: Settings was missing `general` entirely, so its
 * dropdown could not show it and its load guard silently rejected the value —
 * opening Settings while on the "通用" profile displayed a *different* profile as
 * if it were selected. The labels had drifted too ("文科" vs "创作").
 *
 * Anything that needs the list, the labels, or a validity check imports from here.
 */

export type SkillProfileId = 'dev' | 'liberal' | 'general' | 'custom';

export interface SkillProfileDef {
  id: SkillProfileId;
  /** Short label for buttons and dropdowns. */
  label: string;
  /** One-line explanation, used as a tooltip. */
  title: string;
  /** Directory under `.she/skills/` — kept explicit so a rename cannot desync. */
  dir: string;
}

export const SKILL_PROFILES: SkillProfileDef[] = [
  {
    id: 'dev',
    label: '开发',
    title: '开发档：软件 / 终端 / 代码',
    dir: 'dev',
  },
  {
    id: 'liberal',
    label: '创作',
    title: '创作档：写作 / 研究 / 文档',
    dir: 'liberal',
  },
  {
    id: 'general',
    label: '通用',
    title: '通用档：日常问答，不加载专门技能',
    dir: 'general',
  },
  {
    id: 'custom',
    label: '自定义',
    title: '自定义档：加载 .she/skills/custom（在设置里管理）',
    dir: 'custom',
  },
];

/** Narrow an arbitrary value (a stored string, an API payload) to a profile. */
export function isSkillProfile(v: unknown): v is SkillProfileId {
  return typeof v === 'string' && SKILL_PROFILES.some((p) => p.id === v);
}

/** Label for a profile, falling back to the raw value. */
export function skillProfileLabel(id: string): string {
  return SKILL_PROFILES.find((p) => p.id === id)?.label ?? id;
}
