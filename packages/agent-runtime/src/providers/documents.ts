/**
 * Non-image attachments: how a document the user attached reaches the model.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS SEPARATE FROM `images.ts`
 *
 * `images.ts` answers "can I send these bytes as a picture". A PDF, a `.md`, a `.csv`
 * cannot be sent that way, and the old behaviour for them was to push one line into the
 * request — `（附件 … 的类型 application/pdf 不支持，已跳过）`. The model was told a file
 * existed and that it would never see it, and the user was told nothing at all: the upload
 * succeeded, the chip appeared, and the answer came back as if no file had been attached.
 *
 * There are two honest ways to hand a document over, and which one applies is a property of
 * the file, not a preference:
 *
 *   - **Text-shaped** (`.md`, `.txt`, `.json`, `.csv`, source code, …): read it and put the
 *     content in the request. Nothing is lost and no tool round-trip is needed.
 *   - **Binary** (`.pdf`, `.docx`, `.xlsx`, `.zip`, …): do NOT fabricate text for it. Say
 *     where the file is and let the agent read it with its own tools. Attachments already
 *     live inside the workspace (`.she/attachments/`), so this is an ordinary file to the
 *     agent — no new capability is needed, only the pointer.
 *
 * The distinction is drawn from the extension and the declared MIME, and where those two
 * disagree the *conservative* one wins (treat as binary). Guessing "this is probably text"
 * and inlining 4 MB of binary would put garbage in the context and hide the real problem.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, statSync } from 'node:fs';
import type { MessageImage } from '@she/shared';
import { formatMb, resolveImages, skippedNotice, type ResolvedImage } from './images.js';

/**
 * Cap on inlined text, per file.
 *
 * 256 KB is roughly 60–70k tokens — already more than a user attaches on purpose, and above
 * the size where a "here is the whole file" paste stops being useful. A truncated file says
 * so, and names the path so the agent can read the rest.
 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Extensions we will inline as text. Anything absent is treated as binary. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.adoc',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.csv', '.tsv', '.log', '.diff', '.patch',
  '.xml', '.html', '.htm', '.svg', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.r', '.lua', '.vue', '.svelte',
]);

/** MIME types that are text even when the extension is unfamiliar. */
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json', 'application/xml', 'application/x-yaml', 'application/yaml',
  'application/javascript', 'application/x-sh', 'application/sql',
]);

/** Extensions `images.ts` recognizes; used to tell "broken image" from "not an image". */
const IMAGE_EXTENSIONS = /^\.(png|jpe?g|webp|gif)$/;

/**
 * Whether this attachment should be inlined as text.
 *
 * Exported so the test can pin the disagreement rule directly instead of only through a
 * whole-turn assertion.
 */
export function isTextAttachment(path: string, mime: string): boolean {
  const declared = String(mime ?? '').split(';')[0].trim().toLowerCase();
  // A declared image type is handled by `images.ts`; it is never text.
  if (declared.startsWith('image/')) return false;

  const extSaysText = TEXT_EXTENSIONS.has(extensionOf(path));

  /*
   * "No type" and "octet-stream" mean the client did not know, not that the file is binary —
   * it is what every browser sends for a dragged file. Those two fall through to the
   * extension, which is the only information actually present.
   */
  if (!declared || declared === 'application/octet-stream') return extSaysText;

  if (TEXT_MIME_EXACT.has(declared) || TEXT_MIME_PREFIXES.some((p) => declared.startsWith(p))) return true;

  /*
   * Anything else declared is a specific, conflicting claim (`application/pdf`, `application/zip`).
   * It wins over the extension: guessing "probably text" and inlining binary would put garbage in
   * the context AND hide the fact that the file was never really read.
   */
  return false;
}

export function extensionOf(path: string): string {
  const base = String(path ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** The human-facing name: the stored name minus the generated prefix when there is one. */
export function displayName(path: string): string {
  const base = String(path ?? '').split(/[\\/]/).pop() ?? '';
  // Stored names look like `<base36>-<8 hex>-<original>.<ext>`; show the original part.
  const m = /^[0-9a-z]+-[0-9a-f]{8}-(.+)$/.exec(base);
  return m ? m[1] : base;
}

export interface ResolvedDocument {
  path: string;
  name: string;
  /** The block appended to the request, already formatted. */
  block: string;
  /** Set when the file was longer than the cap and only the head was inlined. */
  truncated: boolean;
}

export interface ResolvedAttachments {
  /** Pictures, ready to send as image parts. */
  images: ResolvedImage[];
  /** One text block covering every non-image attachment, or '' when there are none. */
  documentText: string;
  /** Everything that could not be sent, with the reason — never dropped silently. */
  skipped: string[];
}

export interface ResolveAttachmentOptions {
  maxImageBytes?: number;
  maxDocumentBytes?: number;
  /** Injectable for tests; defaults to reading the real filesystem. */
  readFile?: (path: string) => Buffer;
  sizeOf?: (path: string) => number;
}

/**
 * Sort every attachment into "send as image", "inline as text", "point at the file", "cannot send".
 *
 * Images are resolved first and by the existing rule, so this function cannot change how a
 * screenshot behaves — that path is the one that already works, and it stays the one that
 * decides.
 */
export function resolveAttachments(
  attachments: MessageImage[] | undefined,
  opts: ResolveAttachmentOptions = {},
): ResolvedAttachments {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p));
  const sizeOf = opts.sizeOf ?? ((p: string) => statSync(p).size);
  const maxDocBytes = opts.maxDocumentBytes ?? MAX_DOCUMENT_BYTES;

  const list = attachments ?? [];
  const { ok: images, skipped } = resolveImages(list, {
    maxBytes: opts.maxImageBytes,
    readFile,
    sizeOf,
  });

  /*
   * A non-image is not an image failure.
   *
   * `resolveImages` reports every non-image as skipped ("类型不支持"). Those lines are correct
   * for what that function was asked, and wrong for this one: the file is about to be handled
   * below, so keeping the line would tell the model that a document it just received was lost.
   * Only the failures that survive this function are carried forward.
   */
  const imageSkipped = skipped.filter((s) => !/类型 .* 不支持|认不出图片类型/.test(s));

  const documents: ResolvedDocument[] = [];
  const documentSkipped: string[] = [];

  for (const item of list) {
    const path = String(item?.path ?? '').trim();
    if (!path) continue;
    const mime = String(item?.mime ?? '').trim();
    // Already counted as an image (or already reported as a broken image).
    if (images.some((i) => i.path === path)) continue;
    if (imageSkipped.some((s) => s.includes(path))) continue;
    if (mime.startsWith('image/') || IMAGE_EXTENSIONS.test(extensionOf(path))) {
      // Declared an image but did not resolve: that failure is already described.
      continue;
    }

    let size: number;
    try {
      size = sizeOf(path);
    } catch {
      documentSkipped.push(`（附件 ${path} 读不到——可能已被移动或删除）`);
      continue;
    }

    const name = displayName(path);
    const kind = mime || extensionOf(path).replace('.', '') || '未知类型';

    if (!isTextAttachment(path, mime)) {
      /*
       * Binary: hand over the pointer, not a fabrication.
       *
       * The path is stated as the agent's own workspace path so a `fs_read` / shell call works
       * without translation. Saying "已保存在" rather than "内容如下" is the whole point — a
       * model that is told it has the content will summarise nothing and answer from nothing.
       */
      documents.push({
        path,
        name,
        truncated: false,
        block: `【附件 ${name}】${kind}，${formatMb(size)}。`
          + `这是个二进制文件，我无法直接读给你；文件已存放在你的工作区里：${path}。`
          + '需要其中的内容时，用 fs_read 或合适的命令去读它。',
      });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = readFile(path);
    } catch {
      documentSkipped.push(`（附件 ${path} 读不到——可能已被移动或删除）`);
      continue;
    }
    if (!bytes.length) {
      documentSkipped.push(`（附件 ${path} 是空文件，已跳过）`);
      continue;
    }

    const truncated = bytes.length > maxDocBytes;
    const head = truncated ? bytes.subarray(0, maxDocBytes) : bytes;
    /*
     * Decoded as UTF-8 and NOT cleaned up beyond that. A file in GBK will show as replacement
     * characters, and that is reported rather than hidden: a length check on the decoded string
     * is the cheapest way to notice, and pretending the text arrived intact is worse than
     * saying it did not.
     */
    const text = head.toString('utf8');
    const mangled = /�/.test(text);
    documents.push({
      path,
      name,
      truncated,
      block: `【附件 ${name}】${kind}，${formatMb(size)}`
        /*
         * 截断时必须把完整路径写出来。
         *
         * 这是这条分支存在的全部理由：只贴了开头却不说到哪去拿剩下的，模型会以为这就是全文，
         * 于是拿一段被腰斩的材料回答问题 —— 而且是**看起来**答得出来。乱码同理。
         */
        + `${truncated ? `，内容超过 ${formatMb(maxDocBytes)}，这里只附上开头；完整文件在 ${path}` : ''}`
        + `${mangled ? `（编码可能不是 UTF-8，部分字符显示为乱码；原文见 ${path}）` : ''}\n`
        + '```\n' + text.trimEnd() + '\n```',
    });
  }

  const skippedAll = [...imageSkipped, ...documentSkipped];
  const parts: string[] = [];
  if (documents.length) parts.push(documents.map((d) => d.block).join('\n\n'));
  /*
   * 两种失败分开写，因为它们的措辞本来就该不一样。
   *
   * 原来只有图片这一种，句子是「图片未能随本消息发送」。一个读不到的 `.csv` 套上去会变成"图片
   * 发送失败"，模型会去找一张根本不存在的图片 —— 措辞在这里决定模型接下来查什么。
   *
   * 反过来也不能一律写成"附件"：图片那条是特意写具体的（见 `skippedNotice`），把它稀释掉等于让
   * 模型在没收到图的时候不知道是"图没来"还是"文件路径错了"。
   */
  if (imageSkipped.length) parts.push(skippedNotice(imageSkipped));
  if (documentSkipped.length) {
    parts.push(`[有文档未能随本消息发送：${documentSkipped.join('；')}]`);
  }

  return {
    images,
    documentText: parts.join('\n\n'),
    skipped: skippedAll,
  };
}
