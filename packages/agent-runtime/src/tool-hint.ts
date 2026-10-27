/*
 * 工具提示行（补 2.0 的"模型用不好工具"这一半）。
 *
 * 问题不是工具不够，而是**选择噪声**：工具表有 40+ 个，描述都在系统提示词里，
 * 而模型真正决定"下一步调哪个"的时刻在回合末尾 —— 距离那条提示几万到几十万 token。
 *
 * 所以每轮在请求末尾给一行"这一轮最相关的几个工具"。三个约束：
 *   1. **不改工具表本身** —— 工具表是前缀的一部分，动它等于每轮全价重算；
 *   2. 这一行只在**尾部追加**，与召回块同位置，缓存不受影响；
 *   3. 认不出来就不给（闲聊轮加一行"去用 map_wiring"只会干扰）。
 */
import type { TaskKind } from './recall-router.js';

interface Hint {
  tools: string[];
  why: string;
}

const TABLE: Record<TaskKind, Hint> = {
  code: {
    tools: ['map_impact', 'fs_read', 'shell'],
    why: '改代码前先看影响面，再读原文件，最后跑命令验证',
  },
  history: {
    tools: ['kb_query', 'kb_get', 'map_history'],
    why: '问历史/决定时先查库，原文用 kb_get，文件来历用 map_history',
  },
  writing: {
    tools: ['fs_write', 'kb_query', 'read'],
    why: '写文档前先查已有约定，写完读回来自查',
  },
  chat: { tools: [], why: '' },
};

/**
 * 一行工具提示。`available` 是这一轮真的注册了的工具名 —— 提示里点一个不存在的工具，
 * 比不提示更糟（模型会去调它，然后失败）。
 */
export function toolHintLine(kind: TaskKind, available: readonly string[]): string {
  const hint = TABLE[kind];
  if (!hint || !hint.tools.length) return '';
  const usable = hint.tools.filter((t) => available.includes(t));
  if (!usable.length) return '';
  return `【这轮常用的工具】${usable.join(' / ')} —— ${hint.why}`;
}
