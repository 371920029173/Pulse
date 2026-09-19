/**
 * Module smoke test.
 *
 * The cheapest way to catch a whole class of regression: every component module
 * must import cleanly and export a component whose name matches its file. A typo
 * in an import path, a syntax error, a top-level access to something missing, or
 * a component renamed without updating its importers — all of it surfaces here
 * instead of as a blank screen after a build.
 *
 * Modules are discovered rather than listed, so a new component is covered
 * automatically. The downside of discovery is that a broken glob silently tests
 * nothing, so the count is asserted too.
 *
 * This is deliberately shallow: it says nothing about appearance, only that the
 * app still loads.
 */
import { describe, it, expect } from 'vitest';

const componentModules = import.meta.glob('../components/*.tsx');
const libModules = import.meta.glob('../lib/*.ts');

/** `../components/Chat.tsx` -> `Chat` */
const stemOf = (path: string) => path.replace(/^.*\//, '').replace(/\.tsx?$/, '');

describe('组件模块', () => {
  const paths = Object.keys(componentModules).sort();

  /**
   * Modules that intentionally export MANY components.
   *
   * The convention everywhere else is one component per file, named after the file.
   * An icon set is the legitimate exception: splitting 14 icons into 14 files would
   * be worse for every reader. Listed explicitly rather than auto-detected so a
   * typo'd component name cannot quietly become "a collection".
   */
  const MULTI_EXPORT = new Set(['Icons']);

  it('发现到了组件（防止 glob 失效导致零覆盖）', () => {
    expect(paths.length, '没有发现任何组件，glob 可能写错了').toBeGreaterThan(20);
  });

  for (const path of paths) {
    const name = stemOf(path);

    it(`${name}: 可导入且导出组件`, async () => {
      const mod = (await componentModules[path]()) as Record<string, unknown>;
      expect(mod, `${path} 是空模块`).toBeTruthy();

      if (MULTI_EXPORT.has(name)) {
        // Still assert these ARE components: a collection is no excuse for a module
        // that exports data or nothing at all.
        const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function');
        expect(fns.length, `${path} 应当导出多个组件`).toBeGreaterThan(1);
        const notComponent = Object.entries(mod)
          .filter(([, v]) => typeof v !== 'function')
          .map(([k]) => k);
        expect(notComponent, `${path} 里这些导出不是组件: ${notComponent.join(', ')}`).toEqual([]);
        return;
      }

      // The convention throughout this codebase: a named export matching the file.
      // Enforcing it here means a rename cannot silently break importers.
      expect(typeof mod[name], `${path} 应当导出名为 ${name} 的组件`).toBe('function');
    });
  }
});

describe('lib 模块', () => {
  const paths = Object.keys(libModules).sort();

  it('发现到了 lib 模块', () => {
    expect(paths.length).toBeGreaterThan(2);
  });

  for (const path of paths) {
    it(`${stemOf(path)}: 可导入且有导出`, async () => {
      const mod = (await libModules[path]()) as Record<string, unknown>;
      expect(Object.keys(mod).length, `${path} 没有导出任何东西`).toBeGreaterThan(0);
    });
  }
});

describe('入口模块', () => {
  it('App: 可导入且导出 App 组件', async () => {
    const mod = (await import('../App')) as Record<string, unknown>;
    expect(typeof mod.App).toBe('function');
  });
});
