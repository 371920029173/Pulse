/**
 * The product version, read from the root manifest.
 *
 * It used to be hardcoded wherever it was reported (`/api/health`, the MCP client
 * info). Bumping `package.json` then left those reporting a stale number, which is
 * the kind of drift nobody notices until something depends on it.
 *
 * Its own module so both `index.ts` and `mcp.ts` can use it without importing each
 * other — `index.ts` imports `mcp.ts`, so the value cannot live there.
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<root>/packages/server/src|dist` → `<root>` */
const PROJECT_ROOT = resolve(HERE, '../../..');

/** Read once. A running process has no reason to re-read its own manifest. */
export const PRODUCT_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    // A missing or malformed manifest must not stop the server from starting.
    return '0.0.0';
  }
})();

export function productVersion(): string {
  return PRODUCT_VERSION;
}
