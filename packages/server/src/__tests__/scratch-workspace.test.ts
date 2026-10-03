/**
 * Which directories count as throwaway, for the "remember my workspace" policy.
 *
 * These pin the behaviour behind "a scratch directory is used now and forgotten on restart". The bug
 * this prevents is not a crash, it is a *sticky* state: the app silently comes back up mounted on a
 * throwaway folder, so the user's own project is on disk and nowhere on screen. That makes the
 * important half of this file the NEGATIVE cases — a predicate that is too eager would refuse to
 * remember the user's real project, which is the same bug pointed the other way and much easier to
 * introduce by widening the pattern.
 *
 * ## On the spellings used here
 *
 * The predicate reads `basename()` and `os.tmpdir()`, so for the NAMING cases the path's separator
 * style is irrelevant: `…/_she-live-test_2` and `D:\…\_she-live-test_2` reach it as the same final
 * segment. Most cases are therefore written with forward slashes, which behave identically on both
 * platforms and keep `portability-check`'s "no drive-letter literal" rule intact.
 *
 * The one case where the Windows spelling could differ in principle is exercised for real, on
 * Windows, with the drive taken from the platform instead of hardcoded — and skipped elsewhere,
 * where a drive letter is not a path at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isScratchWorkspace } from '../scratch-workspace.js';

describe('isScratchWorkspace', () => {
  it('treats anything inside the OS temp directory as scratch', () => {
    const tmp = resolve(tmpdir());
    assert.equal(isScratchWorkspace(tmp), true);
    assert.equal(isScratchWorkspace(join(tmp, 'she-safety-switchA-abc123')), true);
    assert.equal(isScratchWorkspace(join(tmp, 'a', 'b', 'c')), true);
  });

  it('reads the temp check as a path prefix, not a string prefix', () => {
    /*
     * `<temp>` must not swallow a sibling whose name merely starts with it. A naive
     * `startsWith(tmp)` with no separator passes every case above and fails only here.
     */
    assert.equal(isScratchWorkspace(`${resolve(tmpdir())}-not-temp`), false);
  });

  it('treats the repo fixtures that live outside temp as scratch', () => {
    /*
     * The one that was actually hit: a fixture written under the drive root rather than tmpdir, so
     * the temp rule alone would have let it become the remembered workspace.
     */
    assert.equal(isScratchWorkspace('/AGI/_she-live-test_2'), true);
    assert.equal(isScratchWorkspace('/AGI/_she-live-test'), true);
    assert.equal(isScratchWorkspace('/AGI/_e2e_state'), true);
    assert.equal(isScratchWorkspace('/x/she-rail-live-abc'), true);
    assert.equal(isScratchWorkspace('/x/she-restart-abc'), true);
  });

  it('reads the Windows spelling of that same directory as scratch', () => {
    /*
     * The real incident was `<drive>:\<projects-root>\_she-live-test_2` on Windows. The drive comes from the platform
     * rather than being written out, for the reason in this file's header.
     *
     * On POSIX a string like this is one single filename with backslashes in it, not a path — which
     * is why this asserts the platform's own reading instead of pretending the shape is universal.
     */
    const root = process.platform === 'win32' ? resolve(tmpdir()).slice(0, 2) : null;
    if (!root) {
      assert.ok(true, 'POSIX: 盘符路径在 POSIX 上不是路径，跳过（命名规则已由上面的用例覆盖）');
      return;
    }
    assert.equal(isScratchWorkspace(`${root}\\AGI\\_she-live-test_2`), true);
    assert.equal(isScratchWorkspace(`${root}\\AGI\\_e2e_state`), true);
  });

  it('remembers ordinary project directories', () => {
    /*
     * The half that must not regress: every one of these is a real place a user works, and each is
     * plausibly confused with a fixture by a pattern that is even slightly too wide.
     */
    assert.equal(isScratchWorkspace('/Users/me/Desktop/aaa'), false);
    assert.equal(isScratchWorkspace('/AGI3.5'), false);
    assert.equal(isScratchWorkspace('/AGI/she-agent-cloud'), false);
    // `she-` needs its leading underscore: this is a user's folder, not a fixture.
    assert.equal(isScratchWorkspace('/Users/me/she-notes'), false);
    // A directory the user named after tests is still the user's project.
    assert.equal(isScratchWorkspace('/dev/my-tests'), false);
    assert.equal(isScratchWorkspace('/dev/test-workspace'), false);
  });

  it('is not fooled by a fixture prefix appearing later in the path', () => {
    // Anchored to the final segment: a project living under a folder called `_she-old` is a project.
    assert.equal(isScratchWorkspace('/dev/_she-old/my-project'), false);
  });
});
