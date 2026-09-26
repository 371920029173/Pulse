/**
 * Turning an attached image into something an endpoint will accept.
 *
 * Two endpoints, two shapes, one reading of the file: OpenAI-compatible wants a data URL and
 * Anthropic wants raw base64 with a `media_type`. Both therefore need the same three things —
 * the bytes, the MIME type to declare, and a decision about what to do when the file is missing,
 * too big, or not an image at all.
 *
 * The rules here are deliberately non-fatal. An attachment is a convenience the user reached for;
 * a stale path or a 12 MB screenshot must not turn the whole turn into a failure. What is NOT
 * allowed is dropping it silently — every skipped image comes back as a reason, and the callers
 * put that reason into the request as text, so the model (and the transcript) says "I was told
 * there was an image and could not read it" instead of quietly answering about something else.
 */
import { readFileSync, statSync } from 'node:fs';
import type { MessageImage } from '@she/shared';

/**
 * What we will send. Anything else is refused with a reason rather than passed through: an
 * endpoint that rejects one part rejects the whole request, and a 400 mid-turn is far worse than
 * a missing picture.
 */
export const IMAGE_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/**
 * Per-image cap, before base64 inflation (which adds ~33%).
 *
 * 5 MB is above a full-screen PNG screenshot (~1–2 MB) and below anything that would make the
 * request body absurd; the JSON body limit on the server side is 32 MB, so several attachments
 * still fit.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ResolvedImage {
  /** What to declare to the endpoint. */
  mime: string;
  /** Raw base64, no `data:` prefix — the Anthropic shape. */
  base64: string;
  /** `data:<mime>;base64,<…>` — the OpenAI shape. */
  dataUrl: string;
  bytes: number;
  /** The path it came from, for logs and for telling the user which attachment failed. */
  path: string;
}

export interface ResolvedImages {
  ok: ResolvedImage[];
  /** One human-readable line per image that could not be sent, with the reason. */
  skipped: string[];
}

export interface ResolveImageOptions {
  maxBytes?: number;
  /** Injectable for tests; defaults to reading the real filesystem. */
  readFile?: (path: string) => Buffer;
  /** Injectable for tests; defaults to `statSync`. */
  sizeOf?: (path: string) => number;
}

/** Normalise `image/jpg` (seen in the wild) and drop any `;charset=` suffix. */
export function normalizeImageMime(raw: string): string {
  const base = String(raw ?? '').split(';')[0].trim().toLowerCase();
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

/** Guess from the extension when the client did not say (a dropped file has no MIME). */
export function guessImageMime(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    default: return '';
  }
}

/**
 * Read every attached image, keeping the ones we can send and explaining the others.
 *
 * Order is preserved: the model sees the images in the order the user attached them, which is the
 * only cue it has about which is which when the text says "the second one".
 */
export function resolveImages(
  images: MessageImage[] | undefined,
  opts: ResolveImageOptions = {},
): ResolvedImages {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p));
  const sizeOf = opts.sizeOf ?? ((p: string) => statSync(p).size);
  const ok: ResolvedImage[] = [];
  const skipped: string[] = [];

  for (const image of images ?? []) {
    const path = String(image?.path ?? '').trim();
    if (!path) {
      skipped.push(`（有一张图片没有路径，已跳过）`);
      continue;
    }
    /*
     * A declared type we accept wins; otherwise trust the extension.
     *
     * The fallback is load-bearing, not politeness: drag-and-drop routinely reports
     * `application/octet-stream` or an empty type, so a rule that only accepted a declared
     * `image/*` would silently drop every pasted screenshot — the exact failure this module
     * exists to prevent.
     */
    const allowed = (m: string) => (IMAGE_MIME_ALLOWLIST as readonly string[]).includes(m);
    const declared = normalizeImageMime(image.mime);
    const mime = allowed(declared) ? declared : guessImageMime(path);
    if (!mime) {
      skipped.push(declared
        ? `（附件 ${path} 的类型 ${declared} 不支持，已跳过）`
        : `（附件 ${path} 认不出图片类型，已跳过）`);
      continue;
    }
    // Size is checked before reading, so an oversized file is never loaded into memory.
    let size: number;
    try {
      size = sizeOf(path);
    } catch {
      skipped.push(`（附件 ${path} 读不到——可能已被移动或删除）`);
      continue;
    }
    if (size > maxBytes) {
      skipped.push(`（附件 ${path} 有 ${formatMb(size)}，超过上限 ${formatMb(maxBytes)}，已跳过）`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFile(path);
    } catch {
      skipped.push(`（附件 ${path} 读不到——可能已被移动或删除）`);
      continue;
    }
    if (!bytes.length) {
      skipped.push(`（附件 ${path} 是空文件，已跳过）`);
      continue;
    }
    const base64 = bytes.toString('base64');
    ok.push({ mime, base64, dataUrl: `data:${mime};base64,${base64}`, bytes: size, path });
  }

  return { ok, skipped };
}

export function formatMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
}

/**
 * The line appended to a message when one or more images could not be sent.
 *
 * It exists so the model can say "the image did not come through" instead of describing a
 * screenshot it never received — the failure mode this whole module is written to avoid.
 */
export function skippedNotice(skipped: string[]): string {
  if (!skipped.length) return '';
  return `[图片未能随本消息发送：${skipped.join('；')}]`;
}
