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
 *   A file that cannot be used is MOVED ASIDE, never overwritten — and what can be
 *   read is read, instead of starting from empty.
 *
 * Recovery is then a matter of renaming one file back, which is something a user
 * can do without us. That is why the reason and the backup path are returned
 * rather than only logged.
 *
 * The write side needs its own rule, because the read side is deliberately
 * forgiving — it repairs what it can (drops an entry with no id, coerces a
 * missing array) so that reading somebody else's slightly odd file still gets
 * the user their data. Applied to our OWN writes that forgiveness turns into
 * silent loss: a record the loader would drop is a record that disappears on the
 * next start, with the file on disk looking healthy the whole time.
 *
 *   Never write a value the loader would not read back intact.
 *
 * And the write must reach the platter before the rename that publishes it — see
 * the third rule on `saveStateFile`.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Makes each temp file unique within this process.
 *
 * Per-process alone was not enough: two stores opened on one path share a pid,
 * so their temp files collided and one could rename the other's partial write
 * into place.
 */
let writeSeq = 0;

/**
 * What this process last wrote, per path — so an unchanged save can be skipped.
 *
 * `persistHistory()` is called from ~25 routes and again every couple of seconds while a turn
 * streams, and every save rewrites the WHOLE store: the session file holds every conversation's
 * transcript, so it is megabytes. Measured on a real workspace: 5.3 MB rewritten per save,
 * several times a minute, for content that had not changed at all — and when the workspace sits
 * in an indexed place (a folder on the Desktop), each rewrite also costs an index update and an
 * antivirus re-scan, which is what the user sees as the machine stalling.
 *
 * Skipping only when the bytes are identical AND the file on disk is still the one we left (same
 * size, same mtime) keeps the old behaviour for a file that was edited by hand or by another
 * process: that write still happens.
 */
const lastWritten = new Map<string, { text: string; size: number; mtimeMs: number }>();

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
  /**
   * Reject a value that must not reach the disk.
   *
   * Called before every write. Throwing leaves the existing file exactly as it
   * was — the previous good copy stays readable, which is the whole point: a
   * bug in memory must not be able to destroy what is already stored.
   *
   * This is NOT `parse`. `parse` is the load-side repair function and is allowed
   * to normalise; a validator decides whether the data survives a round trip
   * unchanged, and should reject anything `parse` would quietly drop.
   */
  validate?: (data: T) => void;
}

/** The version recorded in a state file, if it is readable at all. */
function versionOf(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && typeof (raw as { schema_version?: unknown }).schema_version === 'string') {
    return (raw as { schema_version: string }).schema_version;
  }
  return null;
}

/**
 * Salvage the usable prefix of a damaged JSON document.
 *
 * The failure this exists for (measured 2026-10-11): a power cut during a save left a
 * 21 MB `sessions.json` present at full size with its last 43% filled with NULs. All the
 * loader could say was "not valid JSON", so it started from an empty store — the user's
 * whole conversation vanished from the interface even though 57% of it was sitting intact
 * on disk. The bytes were safe; nothing could read them.
 *
 * The rule here: **keep everything that is provably complete.** Walk the text like a
 * tokenizer, remembering the end of the last completed value and which containers were
 * open at that moment; when the text stops being valid JSON (a raw control character, an
 * unterminated string, a token that is not a literal), cut back to that remembered point
 * and close the containers that were open there. A cut is only accepted if the *caller*
 * can parse it back into this store's shape.
 *
 * This decides what is READABLE. It never touches what is KEPT: the caller still moves the
 * original bytes aside, torn tail and all, before anything else is written.
 *
 * Returns null when nothing can be proven complete, or when the document is fine as-is.
 */
export function salvageJsonPrefix(raw: string): { text: string; kept: number; dropped: number } | null {
  // A BOM is not part of the document; JSON.parse rejects it, and a real-world file
  // (hand-edited, or written by an editor that adds one) should not be thrown away for it.
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const n = body.length;
  const stack: string[] = [];
  let markText = -1;
  let markOpen: string[] = [];
  let i = 0;
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  const finish = (end: number): { text: string; kept: number; dropped: number } | null => {
    if (markText < 0) return null;
    // Consumed to the end with nothing open: the document is simply fine, leave it alone.
    if (end >= n && markOpen.length === 0) return null;
    const closers = markOpen.slice().reverse().map((c) => (c === '{' ? '}' : ']')).join('');
    return { text: body.slice(0, markText) + closers, kept: markText, dropped: raw.length - markText };
  };

  while (i < n) {
    const c = body[i];
    if (isWs(c)) { i++; continue; }

    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const code = body.charCodeAt(j);
        if (code === 0x5c) { j += 2; continue; }
        if (code === 0x22) { closed = true; j++; break; }
        if (code < 0x20) break;                 // raw control character inside a string: damage (the NUL tail)
        j++;
      }
      if (!closed) return finish(i);
      i = j;
      let k = i;
      while (k < n && isWs(body[k])) k++;
      if (body[k] === ':') { i = k + 1; continue; }          // a key, not a completed value
      // Only a string that is followed by something legal after a value counts as complete.
      // At the end of the text inside a container the role is ambiguous — a key missing its
      // value and a value are the same bytes — so keep the previous mark instead of guessing.
      if (k < n && body[k] !== ',' && body[k] !== '}' && body[k] !== ']') return finish(i);
      if (k >= n && stack.length > 0) return finish(i);
      markText = i;
      markOpen = stack.slice();
      continue;
    }

    if (c === '{' || c === '[') { stack.push(c); i++; continue; }

    if (c === '}' || c === ']') {
      const open = stack.pop();
      if (!open || (c === '}') !== (open === '{')) return finish(i);
      i++;
      markText = i;
      markOpen = stack.slice();
      continue;
    }

    if (c === ',' || c === ':') { i++; continue; }

    let j = i;
    while (j < n && !isWs(body[j]) && !',:]}[{'.includes(body[j])) j++;
    if (!/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(body.slice(i, j))) return finish(i);
    i = j;
    markText = i;
    markOpen = stack.slice();
  }

  // Ran out of text while still inside containers: truncated, not corrupted.
  return stack.length ? finish(n) : null;
}

/** Salvage + this store's own shape check, on text already in memory. Never touches disk. */
function trySalvage<T>(text: string, parse: (raw: unknown) => T): { data: T; kept: number; dropped: number } | null {
  const salvaged = salvageJsonPrefix(text);
  if (!salvaged) return null;
  try {
    return { data: parse(JSON.parse(salvaged.text)), kept: salvaged.kept, dropped: salvaged.dropped };
  } catch {
    return null;    // even the intact prefix does not pass this store's checks
  }
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
 * the caller receives what could be salvaged from it (or a fresh empty value when
 * nothing could be).
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
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
    // A file that is present but empty is not valid JSON; treating it as "no
    // state yet" avoids quarantining a file that a crash left at zero bytes.
    if (text.trim() === '') return { data: empty() };
    raw = JSON.parse(text);
  } catch (err) {
    /*
     * Damaged file: salvage first, quarantine always.
     *
     * The order matters. Salvage runs on the text in memory, so the outcome is
     * decided before the file is touched; `quarantine` then moves the ORIGINAL
     * bytes aside exactly once, whatever the outcome — the torn tail included,
     * because it is evidence and it may still be readable by a person.
     */
    const salvaged = trySalvage(text, parse);
    const backup = quarantine(path, 'invalid JSON');
    const base = `文件不是合法 JSON: ${(err as Error).message}`;
    if (salvaged) {
      return {
        data: salvaged.data,
        recovered: { backup, reason: `${base}；已尽力恢复完整部分（保留 ${salvaged.kept} 字符，丢弃尾部 ${salvaged.dropped} 字符）` },
      };
    }
    return { data: empty(), recovered: { backup, reason: base } };
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
 *
 * Three rules, each learned from a failure of this store:
 *
 *   - Validation happens BEFORE the file is touched. The failure mode being
 *     prevented is "we wrote something the loader would then reject or repair",
 *     and after the rename it is too late to take that back.
 *   - The temporary name is unique per call, not just per process. Two stores
 *     opened on one path (the shape of a real defect here: a workspace switch
 *     that left the old instance writing) would otherwise share a temp file and
 *     rename each other's half-written bytes into place.
 *   - **Data reaches the platter before the rename.** NTFS — and most filesystems —
 *     only orders metadata: `renameSync` publishes the new name immediately while
 *     the bytes just written may still sit in the write cache. Measured
 *     2026-10-11: a power loss left digbug's `sessions.json` present at full size
 *     with the last 43% (8.5M chars) as NULs, the loader quarantined it, and the
 *     conversation disappeared from the UI. `fsyncSync` before the rename is what
 *     makes the rename mean "this content is durable", not merely "this name
 *     exists". Without it, atomicity is a promise about the *name* only.
 *
 * A failed write removes its temp file: a stray `sessions.json.<pid>.tmp` beside
 * the real one is indistinguishable from state to anyone looking, and the next
 * reader would have to guess which file is live.
 */
export function saveStateFile<T>(
  path: string,
  data: T,
  opts: { validate?: (data: T) => void } = {},
): void {
  if (opts.validate) opts.validate(data);

  const text = JSON.stringify(data, null, 2) + '\n';
  const previous = lastWritten.get(path);
  if (previous && previous.text === text) {
    try {
      const now = statSync(path);
      if (now.size === previous.size && now.mtimeMs === previous.mtimeMs) return;
    } catch {
      // Missing or unreadable: fall through and write it.
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++writeSeq}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    /*
     * Flush before publishing the name — the ordering is the whole point.
     *
     * The classic way to lose a whole file here: rename lands (metadata is
     * journaled), power goes out before the data is written back (it was still
     * in cache), and the file exists at full size filled with NULs. That is
     * exactly what happened to a 21 MB sessions.json on 2026-10-11, and it cost
     * the tail of a real conversation.
     *
     * The flush costs a few milliseconds on a file this size. The `lastWritten`
     * skip above already removes the saves that would have written identical
     * bytes, so only a save that actually changes something pays for it.
     */
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    try {
      const stat = statSync(path);
      lastWritten.set(path, { text, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      lastWritten.delete(path);
    }
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing further to do; the target still holds the previous good copy.
    }
    throw err;
  }
}

/** Path a quarantined file would be written to for a given reason, for messages. */
export function quarantineHint(path: string): string {
  return join(dirname(path), `${path.split(/[\\/]/).pop()}.unusable-<时间戳>`);
}
