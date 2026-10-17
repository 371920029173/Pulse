/*
 * 文件 → 闸门：改了这个文件，哪些 check 会红。
 *
 * 这张表在这里的价值，是把"我记得好像有个检查会红"变成一次调用就能得到答案。
 * 规则是**显式表**，不是从 package.json 反推语义（反推会猜错，而且猜错的方式很安静）：
 * 每条规则都写清为什么，改规则的 diff 也就自解释了。
 *
 * `package.json` 里实际存在的 check 名字由调用方传进来做校验：表里写了但脚本不存在，
 * 就是一条会误导模型的死规则 —— 那比没有更坏。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GateRule {
  /** 路径前缀（posix）。 */
  prefix: string;
  /** 会因此变红的 check 脚本名（package.json 里的 key）。 */
  checks: string[];
  /** 为什么。 */
  why: string;
}

export const GATE_RULES: GateRule[] = [
  { prefix: 'packages/ui/', checks: ['check:ui', 'check:uistruct', 'check:theme', 'check:i18n'], why: 'UI 控件样式、结构、自定义样式表、硬编码中文四条棘轮都盯着 packages/ui' },
  { prefix: 'packages/ui/src/locales/', checks: ['check:i18n'], why: '文案键本身就是中文原文，漏翻译会降级而不是报 key' },
  { prefix: 'packages/desktop/', checks: ['check:packaged'], why: '打包后的运行时才暴露的启动问题' },
  { prefix: 'packages/server/', checks: ['check:api', 'check:security'], why: 'UI 调用的每个端点必须真的被路由；控制面接口有安全约束' },
  { prefix: 'packages/sandbox/', checks: ['check:shell', 'check:portability'], why: '命令白名单与跨平台分支都在这里，错一条就是安全洞或只能在 Linux 上跑' },
  { prefix: 'packages/agent-runtime/', checks: ['check:plugins', 'check:toolresult'], why: '工具注册与失败分类改变会直接影响模型行为' },
  { prefix: 'packages/kb/', checks: ['check:restart', 'check:encoding'], why: 'KB 要在重启后仍然完好，非 ASCII 必须原样往返' },
  { prefix: 'packages/shared/', checks: ['check:dist'], why: '共享类型被打进产物，构建后才暴露问题' },
  { prefix: 'scripts/', checks: ['check:docs'], why: '脚本数量/名称会被文档检查比对' },
  { prefix: 'docs/', checks: ['check:docs'], why: '文档里的路径与计数必须和代码一致' },
  { prefix: 'evals/', checks: ['eval:verify'], why: '评测器改动要跑模型才能验证（需要 key，离线门禁不含它）' },
];

/** 测试文件：跑它所在的包就够了。 */
const TEST_HINT = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$/i;

export interface GateHit {
  check: string;
  why: string;
  /** 这个 check 在 package.json 里真的存在吗。 */
  exists: boolean;
}

export function gateFor(root: string, paths: string[]): GateHit[] {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    scripts = {};
  }

  const hits = new Map<string, GateHit>();
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/');
    for (const rule of GATE_RULES) {
      if (!path.startsWith(rule.prefix) && !(rule.prefix.endsWith('/') && path === rule.prefix.slice(0, -1))) continue;
      for (const check of rule.checks) {
        if (!hits.has(check)) hits.set(check, { check, why: rule.why, exists: check in scripts });
      }
    }
    if (TEST_HINT.test(path)) {
      const pkg = path.split('/').slice(0, 2).join('/');
      const key = `test:${pkg}`;
      if (!hits.has(key)) hits.set(key, { check: key, why: '测试文件：改它要跑所属包的测试', exists: true });
    }
  }
  /* 兜底：什么规则都没命中时，至少告诉模型"这是全量门禁的事"。 */
  if (hits.size === 0) hits.set('check:offline', { check: 'check:offline', why: '未命中具体规则，按全量离线门禁处理', exists: 'check:offline' in scripts });
  return [...hits.values()];
}
