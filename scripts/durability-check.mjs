#!/usr/bin/env node
/**
 * 状态文件的耐久性：写盘必须「先 fsync、后 rename」。
 *
 * 为什么要有这条判据：2026-10-11 蓝屏（0xEF）把 digbug 工作区的 sessions.json 写坏 ——
 * 文件在、大小对、尾部 43%（853 万字符）全是 NUL，前端加载时判坏隔离，用户的对话在界面上
 * 消失。根因就是写路径「tmp → rename」少了 fsync：NTFS 只保证元数据顺序，rename 立刻生效，
 * 而数据可能还在写缓存里。改动在 packages/server/src/state-file.ts 的 saveStateFile。
 *
 * 为什么用「源码顺序」判定而不是跑一遍：断电这件事没法在单元测试里复现，能守的不是「fsync 真的
 * 生效了」，而是「这个调用没有被删掉、也没有被挪到 rename 后面」—— 那正是回归时最先丢掉的东西。
 * 一个自测（给判定器喂坏写法，必须判失败）保证这条判据本身不是永远说 PASS 的装饰。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 判定：`saveStateFile` 的函数体里，第一个 fsyncSync 必须出现在第一个 renameSync 之前。
 * 只看函数体（从 `export function saveStateFile` 起），避免把文件里别处的调用算进来。
 */
export function judge(source) {
  const fn = source.indexOf('export function saveStateFile');
  if (fn === -1) return { ok: false, why: '源码里找不到 saveStateFile' };
  const body = source.slice(fn);
  const rename = body.indexOf('renameSync(');
  const fsync = body.indexOf('fsyncSync(');
  if (rename === -1) return { ok: false, why: '函数体里找不到 renameSync' };
  if (fsync === -1) return { ok: false, why: 'rename 之前没有 fsyncSync（断电会写出 NUL 尾巴）' };
  if (fsync > rename) return { ok: false, why: 'fsyncSync 出现在 renameSync 之后（先发布名字再落盘，等于没做）' };
  return { ok: true, why: '' };
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

console.log('\n状态文件耐久性检查（先 fsync、后 rename）\n');

// ── 真源码 ──────────────────────────────────────────────────────────────────
const src = readFileSync(join(root, 'packages', 'server', 'src', 'state-file.ts'), 'utf8');
const real = judge(src);
check('【关键】saveStateFile：fsync 在 rename 之前', real.ok, real.why);

// ── 自测：判定器必须抓得住坏写法 ─────────────────────────────────────────────
const good = 'export function saveStateFile() {\n  fsyncSync(fd);\n  renameSync(tmp, path);\n}\n';
check('自测：好写法 → 判通过', judge(good).ok === true, '判定器把好写法判坏了');

const after = 'export function saveStateFile() {\n  renameSync(tmp, path);\n  fsyncSync(fd);\n}\n';
const afterOut = judge(after);
check('自测：fsync 在 rename 之后 → 判失败', afterOut.ok === false, `判定器居然说 PASS（${afterOut.why || '无理由'}）`);

const missing = 'export function saveStateFile() {\n  writeFileSync(tmp, text);\n  renameSync(tmp, path);\n}\n';
check('自测：整段 fsync 被删掉 → 判失败', judge(missing).ok === false, '判定器居然说 PASS');

// 真实源码里把 fsync 那段拿掉，判定器必须红（不是只有玩具样本才抓得住）
const neutered = src.replace(/const fd = openSync\(tmp, 'r\+'\);[\s\S]*?closeSync\(fd\);\n/, '');
check('自测：把真文件里的 fsync 段删掉 → 判失败', neutered !== src && judge(neutered).ok === false,
  neutered === src ? '正则没匹配到（判据本身该修）' : '判定器居然说 PASS');

// ── 状态写入都得走这条路 ────────────────────────────────────────────────────
const serverSrc = join(root, 'packages', 'server', 'src');
for (const f of ['sessions.ts', 'schedule.ts', 'cluster.ts']) {
  const s = readFileSync(join(serverSrc, f), 'utf8');
  const uses = s.includes('saveStateFile(');
  const direct = /writeFileSync\(\s*this\.path/.test(s);
  check(`${f} 走 saveStateFile（而不是自己 writeFileSync this.path）`, uses && !direct,
    uses ? '自己直写 this.path，绕过了耐久写入' : '没找到 saveStateFile 调用');
}

if (failed) {
  console.log(`\n${failed} 项失败\n`);
  process.exit(1);
}
console.log('\n全部通过\n');
