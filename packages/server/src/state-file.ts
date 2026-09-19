/**
 * Versioned state files that cannot silently eat user data.
 *
 * Both the session list and the work-group list used to load like this:
 *
 *   try {
 *     this.data = JSON.parse(readFileSync(path, 'utf8'));
 *   } catch {
 *     this.data = <empty>;     // and then the next write persists this
 *   }
 *
 * Every failure mode collapses into the same outcome: a truncated write, a disk
 * error, a hand-edit with a trailing comma, or merely an older/newer shape — any
 * of them replaced the user's entire chat history or work groups with nothing,
 * permanently and without a copy.
 *
 * The rule this module enforces instead:
 *
 *   A file that cannot be used is MOVED ASIDE, never overwritten.
 *
 * Recovery is then a matter of renaming one file back, which is something a user
 * can do without us. That is why the reason and the backup path are returned
 * rather than only logged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LoadOutcome<T> {
  data: T;
  /** Where the unusable file was moved, and why. Present only after a recovery. */
  recovered?: { backup: string; reason: string };
  /** The version the file was upgraded from, when a migration ran. */
  migratedFrom?: string;
}

export interface StateFileSpec<T> {
  path: string;
  /** Version this build writes and understands. */
  version: string;
  /** A fresh, empty value. */
  empty: () => T;
  /** Validate and normalise a parsed value. Throw to reject it. */
  parse: (raw: unknown) => T;
  /**
   * Upgrades keyed by the version they upgrade FROM. Each returns a value that
   * the next step (or `parse`) can consume.
   */
  migrations?: Record<string, (raw: Record<string, unknown>) => Record<string, unknown>>;
}

/** The version recorded in a state file, if it is readable at all. */
function versionOf(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && typeof (raw as { schema_version?: unknown }).schema_version === 'string') {
    return (raw as { schema_version: string }).schema_version;
  }
  return null;
}

/**
 * Move an unusable file aside.
 *
 * Deliberately not `rm`: the whole point is that the data survives. Falls back to
 * copying when a rename fails (a rename can fail across devices or if the file is
 * briefly locked on Windows).
 *
 * The name must be unique. A timestamp alone collides when two recoveries happen
 * within the same millisecond, and the second rename would then land on top of
 * the first backup — destroying the very data this is protecting.
 */
function quarantine(path: string, reason: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backup = `${path}.unusable-${stamp}`;
  for (let n = 1; existsSync(backup); n++) {
    backup = `${path}.unusable-${stamp}-${n}`;
  }
  try {
    renameSync(path, backup);
  } catch {
    // Last resort: a copy keeps the bytes even if the original stays in place.
    writeFileSync(backup, readFileSync(path));
    rmSync(path, { force: true });
  }
  void reason;
  return backup;
}

/**
 * Load a versioned state file.
 *
 * Never throws for bad input — a malformed file is a recoverable condition, not a
 * reason to refuse to start. When the file cannot be used it is quarantined and
 * the caller receives a fresh empty value.
 */
export function loadStateFile<T>(spec: StateFileSpec<T>): LoadOutcome<T> {
  const { path, version, empty, parse, migrations = {} } = spec;

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // The write below will surface a real error if the directory is unusable.
  }

  if (!existsSync(path)) return { data: empty() };

  let raw: unknown;
  try {
    const text = readFileSync(path, 'utf8');
    // A file that is present but empty is not valid JSON; treating it as "no
    // state yet" avoids quarantining a file that a crash left at zero bytes.
    if (text.trim() === '') return { data: empty() };
    raw = JSON.parse(text);
  } catch (err) {
    return { data: empty(), recovered: { backup: quarantine(path, 'invalid JSON'), reason: `文件不是合法 JSON: ${(err as Error).message}` } };
  }

  // `JSON.parse('null')` succeeds and yields null, so an explicit check is needed
  // — otherwise the property access below throws and we lose the reason.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: empty(), recovered: { backup: quarantine(path, 'not an object'), reason: '文件内容不是一个对象' } };
  }

  let record = raw as Record<string, unknown>;
  const found = versionOf(record);
  let migratedFrom: string | undefined;

  if (found !== version) {
    if (found === null) {
      // No version at all: an early build, or a hand-written file. Try to migrate
      // from the earliest known version rather than discarding it.
      const first = migrations['*'];
      if (!first) {
        return {
          data: empty(),
          recovered: { backup: quarantine(path, 'missing version'), reason: '文件没有 schema_version，且没有可用的迁移' },
        };
      }
      record = first(record);
      migratedFrom = 'unversioned';
    } else if (migrations[found]) {
      // Chain migrations: each step may bring us to another known version, so we
      // keep going until we reach ours or run out of steps.
      let current = record;
      let versionCursor: string = found;
      const seen = new Set<string>();
      while (versionCursor !== version) {
        if (seen.has(versionCursor)) {
          return {
            data: empty(),
            recovered: { backup: quarantine(path, 'migration loop'), reason: `迁移链出现循环: ${versionCursor}` },
          };
        }
        seen.add(versionCursor);
        const step = migrations[versionCursor];
        if (!step) break;
        current = step(current);
        const next = versionOf(current);
        if (!next) {
          // The step did not stamp a version; assume it completed the upgrade.
          current = { ...current, schema_version: version };
          break;
        }
        versionCursor = next;
      }
      if (!migratedFrom) migratedFrom = found;
      record = { ...current, schema_version: version };
    } else {
      // Unknown version. This happens after a downgrade, where the file is from a
      // NEWER build. Guessing at its shape risks writing nonsense back over it, so
      // it is set aside intact and the user keeps a recoverable copy.
      return {
        data: empty(),
        recovered: {
          backup: quarantine(path, 'unknown version'),
          reason: `无法识别的 schema_version: ${found}（当前 ${version}）`,
        },
      };
    }
  }

  try {
    return { data: parse(record), migratedFrom };
  } catch (err) {
    return {
      data: empty(),
      recovered: { backup: quarantine(path, 'shape rejected'), reason: `内容校验失败: ${(err as Error).message}` },
    };
  }
}

/**
 * Write a state file atomically.
 *
 * A partially written file is one of the ways the state above gets corrupted in
 * the first place, so the write goes to a temporary file that is then renamed
 * over the target.
 */
export function saveStateFile<T>(path: string, data: T): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/** Path a quarantined file would be written to for a given reason, for messages. */
export function quarantineHint(path: string): string {
  return join(dirname(path), `${path.split(/[\\/]/).pop()}.unusable-<时间戳>`);
}
