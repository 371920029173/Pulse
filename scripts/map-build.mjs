#!/usr/bin/env node
/*
 * map:build —— 在当前工作区建/重建地图（走 packages/map 的 dist，和将来工具用的是同一份实现）。
 *
 * 用法：
 *   node scripts/map-build.mjs            # 全仓
 *   node scripts/map-build.mjs packages   # 只建一个子树（渐进式接入）
 */
import { buildMap, describe } from '../packages/map/dist/index.js';

const scope = process.argv[2];
const started = Date.now();

const res = buildMap({ root: process.cwd(), ...(scope ? { scope } : {}) });

console.log(
  `${describe(process.cwd())}\n` +
    `耗时 ${Date.now() - started}ms｜分片 ${res.shards}｜文件 ${res.files}｜目录 ${res.dirs}\n` +
    `排除：构建产物 ${res.skipped.excluded}｜凭据 ${res.skipped.secret}｜二进制 ${res.skipped.binary}｜超大 ${res.skipped.large}`,
);
