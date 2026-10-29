/*
 * 一个很小的读取器：读不懂就**隔离**，绝不"当空"。
 *
 * 项目里已经出现第四、第五处同一个写法：
 *     try { return JSON.parse(read...) } catch { return [] }   // 下一次写盘 = 覆盖用户的文件
 * plans / memo 已经各自修过。这里给剩下的小状态文件（projects 的最近项目、tenancy 的租户表）
 * 提供一个共用实现，避免再逐个抄一遍、也避免下次新增状态文件时又抄错。
 *
 * 隔离的文件名带时间戳，永远不覆盖原文件 —— 这是仓库规则里的那一条：
 * "a file we cannot use is moved aside, never overwritten"。
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';

export interface Quarantine {
  backup: string;
  reason: string;
}

export function readJsonOrQuarantine<T>(
  file: string,
  fallback: T,
  onCorrupt?: (q: Quarantine) => void,
): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch (err) {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let where = file;
    try {
      renameSync(file, backup);
      where = backup;
    } catch {
      /* 改不动：至少让调用方知道读失败了，不要静默覆盖 */
    }
    onCorrupt?.({ backup: where, reason: (err as Error)?.message ?? String(err) });
    return fallback;
  }
}
