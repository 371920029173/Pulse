/**
 * Where pasted and dropped attachments live, and how they are read back.
 *
 * The files go under `.she/attachments/`, not into a temp directory, for two reasons that both
 * come from how a turn actually flows:
 *
 * - The transcript stores an image as a PATH. Providers read the bytes at request time, and the
 *   same path is replayed on every later request of that conversation. A temp directory that gets
 *   swept would leave those later turns with a dangling reference — the model would be told "this
 *   image is gone", repeatedly, for an image it saw once.
 * - The user can also reference the file by path (`@.she/attachments/…`) and the agent can read it
 *   with `fs_read`, so the attachment is an ordinary workspace file rather than a special case.
 *
 * Names are generated, never trusted: the original name is kept only as a suffix so a human can
 * still tell what it was, and the random prefix keeps two pastes of `image.png` from colliding.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { guessImageMime, normalizeImageMime, resolveImageMime } from '@she/agent-runtime';
import { HttpError } from './router.js';

/** Same cap the providers enforce, with headroom: the file must survive the round trip. */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

export function attachmentsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.she', 'attachments');
}

const EXT_ALLOWLIST = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.md', '.json', '.csv', '.log'];

/** The extension to store under: the original when it is one we accept, else by MIME, else `.bin`. */
export function attachmentExt(rawName: string, mime: string): string {
  const lower = String(rawName ?? '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  if (EXT_ALLOWLIST.includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  // Not an extension we keep, so fall back to what the bytes claim to be.
  const byMime = resolveImageMime(mime, rawName);
  const map: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  };
  return map[byMime] ?? '.bin';
}

/** Strip directories and anything that is not safe in a filename, keeping a readable tail. */
export function safeAttachmentLabel(rawName: string): string {
  const base = String(rawName ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').replace(/^_+/, '').slice(-40);
  return cleaned || 'attachment';
}

export interface SavedAttachment {
  /** Absolute path — what the transcript stores and the providers read. */
  path: string;
  /** Repo-relative path, for showing the user something shorter and portable. */
  relPath: string;
  /** Generated file name, for serving it back to the browser. */
  name: string;
  mime: string;
  bytes: number;
}

export function saveAttachment(
  workspaceRoot: string,
  buffer: Buffer,
  rawName: string,
  declaredMime: string,
): SavedAttachment {
  if (!buffer.length) throw new HttpError(400, '附件是空的');
  if (buffer.length > ATTACHMENT_MAX_BYTES) {
    throw new HttpError(413, `附件过大（上限 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB）`);
  }
  const dir = attachmentsDir(workspaceRoot);
  mkdirSync(dir, { recursive: true });
  const ext = attachmentExt(rawName, declaredMime);
  /*
   * The label keeps the original name minus its extension, so `shot.jpeg` becomes
   * `…-shot.jpg` rather than `…-shot.jpeg.jpg`. The extension on the stored name is the one
   * derived above and nothing else, so the two can never disagree.
   */
  const label = safeAttachmentLabel(rawName);
  const dot = label.lastIndexOf('.');
  const stem = dot > 0 && EXT_ALLOWLIST.includes(label.slice(dot).toLowerCase()) ? label.slice(0, dot) : label;
  const name = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${stem || 'attachment'}${ext}`;
  const target = join(dir, name);
  writeFileSync(target, buffer);
  return {
    path: target,
    relPath: join('.she', 'attachments', name),
    name,
    /*
     * Same rule the providers send with, applied here so the stored type and the sent type cannot
     * drift: a clipboard paste reports an empty type, and a drag-and-drop reports
     * `application/octet-stream`. Both must end up as a real image MIME, or the image is stored
     * under a name nothing will read back as an image.
     */
    mime: resolveImageMime(declaredMime, name) || normalizeImageMime(declaredMime) || attachmentMime(name),
    bytes: buffer.length,
  };
}

/**
 * Resolve a name for serving back to the browser, refusing anything outside the attachments dir.
 *
 * Separators and `..` are refused outright rather than normalised away. Flattening `../a.png` to
 * `a.png` would be harmless, but it would also silently serve a DIFFERENT file than the one asked
 * for, and a bug that does that is much harder to notice than a 403. Names are generated by
 * `saveAttachment`, so nothing legitimate ever contains either.
 */
export function resolveAttachmentFile(workspaceRoot: string, name: string): string {
  const dir = attachmentsDir(workspaceRoot);
  const raw = String(name ?? '').trim();
  if (!raw || raw.startsWith('.') || raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new HttpError(400, '附件名不合法');
  }
  const full = resolve(dir, raw);
  const base = resolve(dir) + sep;
  if (!full.startsWith(base)) throw new HttpError(403, '附件名不合法');
  return full;
}

/** How many attachments one turn may carry. Far past deliberate use; it guards the request. */
export const MAX_CHAT_IMAGES = 8;

/** What to declare when serving an attachment back to the browser. */
export function attachmentMime(name: string): string {
  const image = resolveImageMime('', name);
  if (image) return image;
  const ext = String(name ?? '').toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'json': return 'application/json';
    case 'csv': return 'text/csv';
    case 'md': case 'txt': case 'log': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/** How many attachments are already stored, for the diagnostics line in Settings. */
export function countAttachments(workspaceRoot: string): number {
  try {
    return readdirSync(attachmentsDir(workspaceRoot)).length;
  } catch {
    return 0;
  }
}
