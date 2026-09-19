/**
 * Skill profile definitions.
 *
 * These were the source of a real bug: the set of profiles lived as a
 * hand-written union in four places and had already drifted. Settings was missing
 * `general`, so its load guard rejected the value and opening Settings while on
 * the "通用" profile displayed a *different* profile as if it were selected. The
 * labels had drifted too ("文科" vs "创作").
 *
 * A user also reported that `dev` and `liberal` looked identical. That was a
 * symptom of the same drift, so the distinctness of the profiles is asserted here
 * rather than left to inspection.
 */
import { describe, it, expect } from 'vitest';
import { SKILL_PROFILES, isSkillProfile, skillProfileLabel } from '../lib/skills';

describe('技能档位定义', () => {
  it('四个档位都在', () => {
    const ids = SKILL_PROFILES.map((p) => p.id).sort();
    expect(ids).toEqual(['custom', 'dev', 'general', 'liberal']);
  });

  it('每个档位都有非空标签与说明', () => {
    for (const p of SKILL_PROFILES) {
      expect(p.label.trim(), `${p.id} 缺 label`).not.toBe('');
      expect(p.title.trim(), `${p.id} 缺 title`).not.toBe('');
      expect(p.dir.trim(), `${p.id} 缺 dir`).not.toBe('');
    }
  });

  it('标签互不重复（用户会同时看到它们）', () => {
    const labels = SKILL_PROFILES.map((p) => p.label);
    expect(new Set(labels).size, `档位标签有重复: ${labels.join(', ')}`).toBe(labels.length);
  });

  it('说明互不重复（否则按钮看起来一样）', () => {
    const titles = SKILL_PROFILES.map((p) => p.title);
    expect(new Set(titles).size, `档位说明有重复: ${titles.join(', ')}`).toBe(titles.length);
  });

  it('dev 与 liberal 明显不同（曾经被报告为"看起来一样"）', () => {
    const dev = SKILL_PROFILES.find((p) => p.id === 'dev');
    const lib = SKILL_PROFILES.find((p) => p.id === 'liberal');
    expect(dev).toBeTruthy();
    expect(lib).toBeTruthy();
    expect(dev!.label).not.toBe(lib!.label);
    expect(dev!.title).not.toBe(lib!.title);
    expect(dev!.dir).not.toBe(lib!.dir);
  });

  it('dir 与 id 一致（重命名无法悄悄脱节）', () => {
    for (const p of SKILL_PROFILES) {
      expect(p.dir, `${p.id} 的目录与 id 不一致`).toBe(p.id);
    }
  });
});

describe('isSkillProfile', () => {
  it('接受已知档位', () => {
    for (const p of SKILL_PROFILES) expect(isSkillProfile(p.id)).toBe(true);
  });

  it('拒绝未知值', () => {
    for (const bad of ['', 'DEV', 'dev ', 'unknown', null, undefined, 42, {}, []]) {
      expect(isSkillProfile(bad), `${JSON.stringify(bad)} 不该被接受`).toBe(false);
    }
  });
});

describe('skillProfileLabel', () => {
  it('已知档位返回其中文标签', () => {
    expect(skillProfileLabel('dev')).toBe('开发');
    expect(skillProfileLabel('general')).toBe('通用');
  });

  it('未知值原样返回，而不是显示 undefined', () => {
    expect(skillProfileLabel('mystery')).toBe('mystery');
    expect(skillProfileLabel('')).toBe('');
  });
});
