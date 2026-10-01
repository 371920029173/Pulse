/**
 * Real isolation for shell commands (isolation-hardening plan, layer 4.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, GIVEN THE JAIL ALREADY REFUSES ESCAPES
 *
 * Layer 4.1 established the limit: the jail reads the command TEXT, so `node -e "…writeFileSync(
 * 'C:/x')"` was allowed while carrying a note that its paths were never inspected. A note is honest
 * but it is not a boundary — the child could still write anywhere the user could.
 *
 * This module supplies the boundary. The command is not inspected any more; it is CONTAINED, and the
 * paths it can reach are decided by the kernel rather than by a string scan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE BOUNDARY ACTUALLY IS (MEASURED, NOT ASSUMED)
 *
 * Running a command through WSL is NOT by itself containment. WSL automounts the Windows drives at
 * `/mnt/<letter>`, so a plain `wsl -e bash -lc '<cmd>'` can read every file on D: — including
 * directories beside the workspace. Measured on this machine: the out-of-workspace probe file was
 * readable (`outside-readable=YES`).
 *
 * What does contain it is a private mount namespace, entered with `unshare -m`:
 *
 *   1. bind-mount the WORKSPACE to `/ws`
 *   2. mask `/mnt` with an empty tmpfs — one operation that hides every Windows drive
 *   3. run the command in `/ws`
 *
 * Measured with that in place: workspace readable, the same outside file NOT readable
 * (`outside-readable=NO`), `/mnt` holding 0 entries, and `node` still working because it lives at
 * `/usr/bin/node`, not under `/mnt`. The namespace is private, so `/mnt` is back the moment it exits
 * — verified, because a containment trick that leaks mounts would be worse than none.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT COVER — stated here so no caller has to guess
 *
 *   - The Linux filesystem inside the distro. The child runs as root there (this distro's default
 *     user), so it can write outside `/ws` within Linux. The threat being addressed is the user's
 *     WINDOWS data; that is what the boundary covers.
 *   - The network. Nothing here restricts egress, so a command can still fetch and exfiltrate.
 *   - Anything the command does through a Windows binary it can still reach: nothing under /mnt is
 *     visible, but WSL interop can start Windows executables from the translated PATH entries that
 *     survive masking. A Windows process started that way is subject to the host's rules, not this
 *     namespace's.
 *
 * The `detail` string this module returns says the first of those in one line, because that is the
 * one a reader would otherwise get wrong ("sandboxed" reads as "it cannot touch my machine").
 */

import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import type { IsolationInEffect } from '@she/shared';

const IS_WINDOWS = platform() === 'win32';

/** How the shell should run commands. `off` is the default and the previous behaviour. */
export type IsolationMode = 'off' | 'auto' | 'wsl';

/**
 * A resolved boundary. Present only when isolation is actually available and switched on.
 *
 * `distro` is empty when the command should run in WSL's default distro — passing `-d` for a distro
 * the user never named would be a guess, and WSL already has a documented default.
 */
export interface IsolationPlan {
  mode: 'wsl';
  distro: string;
  /** The workspace as WSL sees it, e.g. `/mnt/d/AGI/she-agent-cloud`. */
  workspaceLinux: string;
  /** What to say in the transcript. */
  detail: string;
}

export type IsolationResolution =
  | { plan: IsolationPlan }
  /** Isolation was asked for and could not be provided. Carries why, for the refusal message. */
  | { unavailable: string };

/**
 * Translate a Windows absolute path to its WSL form.
 *
 * Returns null for anything that is not a drive-letter path, INCLUDING a path that is already Linux
 * shaped — the caller then treats the command as unrunnable under isolation rather than guessing.
 * WSL's automount root is `/mnt` in every default install; a machine with a custom automount root
 * fails the existence check inside the container script, which reports it instead of silently
 * running unconfined.
 */
export function toWslPath(winPath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  const rest = m[2].replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return rest ? `/mnt/${m[1].toLowerCase()}/${rest}` : `/mnt/${m[1].toLowerCase()}`;
}

/**
 * The target's path relative to the workspace, as `/sub/dir`, or null when it is outside.
 *
 * Computed on the LINUX forms of both paths because that is where the mount lives. Comparing the
 * Windows forms instead would call `D:\ws2` inside `D:\ws` (a prefix match on text), which is the
 * class of bug the workspace jail's own separator handling exists to avoid.
 */
export function workspaceRelative(workspaceLinux: string, targetLinux: string): string | null {
  const ws = workspaceLinux.replace(/\/+$/, '');
  if (targetLinux === ws) return '';
  if (!targetLinux.startsWith(`${ws}/`)) return null;
  return `/${targetLinux.slice(ws.length + 1)}`;
}

/**
 * The script that runs INSIDE the private mount namespace.
 *
 * Every value is passed base64-encoded and decoded in place. That is not decoration: the command is
 * arbitrary user text and the workspace path can contain spaces, and interpolating either into a
 * shell script is the injection this whole layer exists to stop. Base64's alphabet contains nothing
 * the shell treats specially, so the script cannot be re-parsed by what it carries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIRST LINE IS A TRIPWIRE, NOT A FORMALITY
 *
 * An earlier version of this function contained the masking but NOT `unshare -m`, so it ran
 * `mount -t tmpfs none /mnt` in the SHARED namespace and masked every Windows drive for the whole
 * distro. It was caught because the next command failed with `exit 90` ("workspace not visible") —
 * the symptom was confusing precisely because the damage was somewhere else.
 *
 * The guard compares this process's mount namespace against the one recorded before `unshare` ran
 * and REFUSES to proceed if they are the same. That makes the failure mode "the command does not
 * run" instead of "a machine-wide mount is covered", so the next person to edit this cannot
 * reintroduce it silently.
 */
export function buildConfinedScript(opts: {
  workspaceLinux: string;
  cwdRel: string;
  command: string;
}): string {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  return [
    'set -eu',
    // Strict on BOTH counts. `${SHE_NS0:-unset}` looked like enough, but the literal "unset" never
    // equals a real namespace id, so INVOKING THE SCRIPT WITHOUT THE WRAPPER made the guard pass —
    // which is exactly the case it exists for. It must refuse when the variable is missing.
    '[ -n "${SHE_NS0:-}" ] || {',
    `  printf '%s\\n' 'sandbox: 缺少 SHE_NS0，无法确认已进入私有挂载命名空间，拒绝运行' >&2`,
    `  exit ${NOT_IN_NAMESPACE_EXIT}`,
    '}',
    '[ "$(readlink /proc/self/ns/mnt 2>/dev/null)" != "$SHE_NS0" ] || {',
    `  printf '%s\\n' 'sandbox: 未进入私有挂载命名空间，拒绝遮盖共享的 /mnt' >&2`,
    `  exit ${NOT_IN_NAMESPACE_EXIT}`,
    '}',
    `WS=$(printf %s '${b64(opts.workspaceLinux)}' | base64 -d)`,
    `REL=$(printf %s '${b64(opts.cwdRel)}' | base64 -d)`,
    `CMD=$(printf %s '${b64(opts.command)}' | base64 -d)`,
    // Said in the container's own words, and with a distinctive exit code, so a caller can tell
    // "the workspace is not reachable from WSL" from "the command failed".
    '[ -d "$WS" ] || { printf \'%s\\n\' "sandbox: 工作区在 WSL 里不可见: $WS" >&2; exit 90; }',
    'mkdir -p /ws',
    'mount --bind "$WS" /ws',
    // One operation hides every Windows drive. Hiding them one by one would leave a window where
    // an unlisted mount is still reachable, and would fail open if a new one appeared.
    'mount -t tmpfs none /mnt',
    'cd "/ws${REL}"',
    // `exec` so the command's exit code reaches the caller unchanged; `-l` because tools resolve
    // through the login PATH (/usr/bin/node included), which the masking does not disturb.
    'exec bash -lc "$CMD"',
  ].join('\n');
}

/**
 * The argv that runs `script` inside the distro, with no argument able to need quoting.
 *
 * Structure, outermost first:
 *
 *   1. base64 for the inner script — so neither the command nor a path with spaces can be re-parsed
 *      by anything between here and bash;
 *   2. record the CURRENT mount namespace in `SHE_NS0`, which the inner script checks itself against;
 *   3. `unshare -m --propagation private bash`, reading the decoded script from stdin.
 *
 * `--propagation private` matters: without it, mounts created inside are propagated BACK to the
 * parent, which is how a containment step would end up changing the machine it was meant to isolate.
 */
export function buildWslArgv(distro: string, script: string): string[] {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const outer = [
    'set -eu',
    'SHE_NS0=$(readlink /proc/self/ns/mnt 2>/dev/null || printf unset)',
    'export SHE_NS0',
    `printf %s '${encoded}' | base64 -d | unshare -m --propagation private bash`,
  ].join('\n');
  const argv = ['-e', 'bash', '-c', outer];
  return distro ? ['-d', distro, ...argv] : argv;
}

export const WORKSPACE_NOT_IN_WSL_EXIT = 90;
/** Distinct from `WORKSPACE_NOT_IN_WSL_EXIT`: the boundary could not be entered at all. */
export const NOT_IN_NAMESPACE_EXIT = 91;

/**
 * The probe run inside WSL to decide whether isolation is possible.
 *
 * Checks the three things that can each be true while isolation is not:
 *
 *   - a usable `node`, of the right version;
 *   - that it is a LINUX node. WSL puts the Windows PATH into the Linux PATH, and on this machine 36
 *     `/mnt/...` entries arrive that way — so a `node.exe` shim can satisfy `command -v node` and
 *     report a version while being unusable for a Linux command. `check:wsl`'s original probe had
 *     exactly this hole; a Windows binary there would have been a false green.
 *   - `unshare` and `mount`, without which the namespace cannot be entered at all.
 *
 * Prints one tab-separated line; never exits non-zero for a condition the caller should read.
 */
export const ISOLATION_PROBE = [
  'set -u',
  'n=$(command -v node 2>/dev/null || true)',
  '[ -n "$n" ] || { printf "NO\\tno node in WSL"; exit 0; }',
  'case "$n" in /mnt/*) printf "NO\\tnode resolves to %s, which is a Windows binary" "$n"; exit 0;; esac',
  'v=$("$n" -v 2>/dev/null || echo "")',
  'case "$v" in v1[0-9].*|v[0-9].*) printf "NO\\tnode %s is older than the required 20" "$v"; exit 0;; esac',
  'p=$("$n" -p "process.platform" 2>/dev/null || echo "")',
  '[ "$p" = linux ] || { printf "NO\\tnode reports platform %s" "$p"; exit 0; }',
  'command -v unshare >/dev/null 2>&1 || { printf "NO\\tno unshare (cannot enter a mount namespace)"; exit 0; }',
  'command -v mount >/dev/null 2>&1 || { printf "NO\\tno mount"; exit 0; }',
  'd=${WSL_DISTRO_NAME:-unknown}',
  'printf "OK\\t%s\\t%s\\t%s" "$d" "$v" "$n"',
].join('\n');

/**
 * What to say about a boundary once it is in effect.
 *
 * Kept next to the mechanism so that the claim and the mechanism cannot drift apart.
 */
export function isolationDetail(distro: string): string {
  return `已在 WSL(${distro}) 的私有挂载命名空间里运行：工作区是唯一可见的 Windows 路径（其余盘符已被 tmpfs 遮盖）。`
    + '不覆盖的部分：发行版内部的文件系统（Linux 侧仍是 root）、网络出站，以及经 WSL 互操作启动的 Windows 程序。';
}

/**
 * Probe WSL once per process.
 *
 * `spawnSync` because the sandbox builds a spawn call synchronously and cannot await a probe mid
 * command; failure to probe must not be a per-command cost, so the answer is memoised. The probe is
 * a single short-lived `wsl.exe`, which on this machine costs about a second on the first call.
 */
let probed: IsolationResolution | null = null;

export function resetIsolationProbeCache(): void {
  probed = null;
}

export function resolveWslIsolation(workspaceRoot: string, distro = ''): IsolationResolution {
  if (probed) return withWorkspace(probed, workspaceRoot);

  if (!IS_WINDOWS) {
    // `unshare`/`mount` exist on Linux and macOS, but the workspace translation and the tmpfs
    // masking are written against WSL's automount layout. Claiming support here would be a
    // boundary nobody tested, so this platform says plainly that it has none.
    probed = { unavailable: '真隔离目前只在 Windows + WSL2 上实现（本平台未验证，不假装支持）' };
    return withWorkspace(probed, workspaceRoot);
  }

  const r = spawnSync('wsl.exe', ['-e', 'bash', '-c', ISOLATION_PROBE], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  if (r.error) {
    probed = { unavailable: `调不动 wsl.exe：${r.error.message}` };
    return withWorkspace(probed, workspaceRoot);
  }
  const line = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find((s) => s.startsWith('OK\t') || s.startsWith('NO\t'));
  if (!line) {
    const detail = ((r.stderr ?? '').trim() || '没有输出').split(/\r?\n/)[0];
    probed = { unavailable: `WSL 探测没有给出结论：${detail.slice(0, 200)}` };
    return withWorkspace(probed, workspaceRoot);
  }
  if (line.startsWith('NO\t')) {
    probed = { unavailable: line.slice(3) };
    return withWorkspace(probed, workspaceRoot);
  }

  // "OK\t<distro>\t<version>\t<node path>" — destructured positionally, so the leading "OK" must be
  // skipped by exactly one slot. An earlier version skipped two here and shifted the version into
  // the distro, which then produced `wsl -d v22.23.3` and `WSL_E_DISTRO_NOT_FOUND` on every command.
  const [, probedDistro = '', version = ''] = line.split('\t');
  const chosen = distro || probedDistro;
  void version;
  probed = { plan: { mode: 'wsl', distro: chosen, workspaceLinux: '', detail: '' } };
  return withWorkspace(probed, workspaceRoot);
}

/**
 * Fill in the workspace-dependent half of a cached plan.
 *
 * The probe result is about the MACHINE (which distro, which node) and is safe to cache; the
 * workspace translation is about the current workspace, and the server builds a shell per workspace.
 * Caching the translated path would send a second workspace's commands into the first one's
 * directory — the same class of stale-binding bug the cluster store had.
 */
function withWorkspace(resolution: IsolationResolution, workspaceRoot: string): IsolationResolution {
  if ('unavailable' in resolution) return resolution;

  const workspaceLinux = toWslPath(workspaceRoot);
  if (!workspaceLinux) {
    return { unavailable: `工作区不是盘符开头的绝对路径，无法映射进 WSL：${workspaceRoot}` };
  }
  return {
    plan: {
      mode: 'wsl',
      distro: resolution.plan.distro,
      workspaceLinux,
      detail: isolationDetail(resolution.plan.distro),
    },
  };
}

/**
 * Decide whether a command should be isolated, and translate that into the pieces the spawn needs.
 *
 * Returns null when isolation is off — the caller then spawns on the host exactly as before, so the
 * default path is byte-for-byte the old behaviour.
 */
export function planIsolation(
  mode: IsolationMode,
  workspaceRoot: string,
  cwd: string,
  distro = '',
): { plan: IsolationPlan; cwdRel: string } | { error: string } | null {
  if (mode === 'off') return null;

  const resolved = resolveWslIsolation(workspaceRoot, distro);
  if ('unavailable' in resolved) {
    /*
     * `wsl` is an explicit request: falling back to the host would run the command with no boundary
     * while the user believes there is one, which is the false green the plan forbids. `auto` is a
     * preference, so it degrades to the host — and the absence of an `isolation` field on the result
     * is what says so.
     */
    if (mode === 'wsl') return { error: `已要求真隔离（wsl），但用不了：${resolved.unavailable}` };
    return null;
  }

  const cwdLinux = toWslPath(cwd) ?? resolved.plan.workspaceLinux;
  const cwdRel = workspaceRelative(resolved.plan.workspaceLinux, cwdLinux);
  if (cwdRel === null) {
    return { error: `工作目录不在工作区内，隔离后不可见：${cwd}` };
  }
  return { plan: resolved.plan, cwdRel };
}

/** The disclosure for a result, or undefined when the command ran on the host. */
export function isolationInEffect(plan: IsolationPlan | null): IsolationInEffect | undefined {
  if (!plan) return undefined;
  return { mode: plan.mode, detail: plan.detail };
}

/**
 * The environment for the `wsl.exe` call itself.
 *
 * WSL translates the Windows PATH into the Linux one and prints one warning per entry it cannot
 * translate to its OWN stderr. On this machine that is `F:\_cursor_setup\scoop\shims`, so every
 * isolated command came back with three `wsl: Failed to translate ...` lines attached — which the
 * model reads as the command's output. Noise in stderr is not cosmetic here: stderr is where a real
 * failure is reported, and a preamble of scary-looking lines is what makes someone skim past it.
 *
 * Handing WSL a minimal PATH removes the entries that fail. Nothing is lost on the Linux side: the
 * command runs under `bash -l`, which builds its own PATH from /etc/profile, so `/usr/bin/node` and
 * everything else still resolve. `WSLENV` is emptied for the same reason — it is the switch that
 * decides which of these variables get forwarded at all.
 */
export function isolationSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // portability-check:allow — this whole function exists to hand a WINDOWS path to wsl.exe, which
  // only runs on Windows; `C:\Windows\System32` is the platform it is talking to, not a fixed
  // assumption about the host. The module already branches on IS_WINDOWS.
  return { ...base, PATH: 'C:\\Windows\\System32', WSLENV: '' };
}
