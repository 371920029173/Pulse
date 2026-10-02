/**
 * Which packages must report a unit-test total, and what they reported.
 *
 * Shared by `docs-check.mjs` (which compares the summed total against the documentation) and
 * `test-suites.mjs` (which runs the same suites under a wall clock and names any package that went
 * silent). Both need the same answer to "who was supposed to report?", and two copies of that answer
 * would drift — which is the failure this whole area keeps producing, one level up.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read JSON, tolerating a leading BOM.
 *
 * PowerShell's `Set-Content`/`Out-File` and Notepad write one on Windows, and `JSON.parse` rejects
 * it — so a file a user saved by hand parses as invalid rather than as JSON. That is not a cosmetic
 * gap here: this is the read that decides how many suites MUST report, and a package quietly dropped
 * from that list turns an incomplete measurement into a certified-correct one. (Found by writing
 * exactly such a file: a probe package created with `Set-Content -Encoding utf8` was not counted, and
 * the check went on claiming "应有 6 套" while seven had a `test` script.)
 */
export function readJson(file) {
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** Packages that declare a `test` script — the set that MUST report a count. */
export function packagesWithTests() {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => {
      const pkg = join(ROOT, 'packages', d.name, 'package.json');
      if (!existsSync(pkg)) return false;
      try { return Boolean(readJson(pkg).scripts?.test); } catch { return false; }
    })
    .map((d) => d.name);
}

/**
 * Sum the totals the runners report, and record WHICH package reported each one.
 *
 * The attribution is the point. `pnpm -r` prefixes every line with `packages/<name> <script>: `, so a
 * summary line carries the name of the suite that produced it — and then "which suite is missing?" is
 * answerable instead of a guess.
 */
export function parseSuiteOutput(text) {
  let total = 0;
  let nodeTestSuites = 0;
  let vitestSuites = 0;
  const counted = new Set();

  for (const line of text.split('\n')) {
    const prefixed = /^packages\/([\w.-]+) [^:]*: ?(.*)$/.exec(line);
    const pkg = prefixed ? prefixed[1] : null;
    const body = (prefixed ? prefixed[2] : line).trim();

    const node = /^# tests (\d+)/.exec(body);
    if (node) { total += Number(node[1]); nodeTestSuites++; if (pkg) counted.add(pkg); continue; }

    const vitest = /^Tests +(\d+)/.exec(body);
    if (vitest) { total += Number(vitest[1]); vitestSuites++; if (pkg) counted.add(pkg); }
  }

  return { total, nodeTestSuites, vitestSuites, counted };
}
