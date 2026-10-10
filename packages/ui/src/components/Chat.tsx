import React, { useRef, useEffect, useState, useCallback, useMemo, memo } from 'react';
import type { ChatMessage, ToolCallData, ConfirmTicket, PendingPatch } from '../hooks/useChat';
import { continuePrompt } from '../hooks/useChat';
import { DiffPanel } from './DiffPanel';
import { ComposerPanel } from './ComposerPanel';
import { Markdown } from './Markdown';
import { IconSend, IconStop, IconPaperclip } from './Icons';
import { t } from '../lib/i18n';
import { fetchJSON, uploadAttachment, attachmentUrl, type UploadedAttachment } from '../lib/api';
import styles from '../styles/Chat.module.css';
import { toast } from '../lib/toast';
import { loadShortcuts, matchesChord, type ShortcutMap } from '../lib/shortcuts';
import { AskCard } from './AskCard';
import { SKILL_PROFILES, type SkillProfileId } from '../lib/skills';
import { highlight } from '../lib/highlight';
import { loadDraft, saveDraft } from '../lib/draft';

export type { SkillProfileId } from '../lib/skills';

/**
 * Thinking depth.
 *
 * These are the seven values the endpoint's `reasoning_effort` enum accepts
 * (`none|minimal|low|medium|high|xhigh|max`).
 *
 * Measured behaviour on the configured model (median reasoning length on a hard
 * task): none = 0, minimal/low ≈ 5.5k, medium ≈ 11k, high/xhigh/max ≈ 14–17k.
 * So the seven values collapse into about four distinguishable tiers — the
 * `note` on each entry says which neighbours it matches, rather than implying a
 * precision the model does not deliver.
 */
export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const THINK_LEVELS: { id: ThinkingLevel; short: string; title: string }[] = [
  { id: 'none', short: '关', title: '关：完全不思考，最快（实测 reasoning 0 tokens）' },
  { id: 'minimal', short: '极简', title: '极简：很短的思考（实测与「低」基本同档）' },
  { id: 'low', short: '低', title: '低：少量推理（实测与「极简」基本同档）' },
  { id: 'medium', short: '中', title: '中：默认强度，明显多于低档' },
  { id: 'high', short: '高', title: '高：深度推理，显著多于中档' },
  { id: 'xhigh', short: '很高', title: '很高：实测与「高」「最大」基本同档' },
  { id: 'max', short: '最大', title: '最大：实测与「高」「很高」基本同档' },
];

interface ChatProps {
  messages: ChatMessage[];
  isLoading: boolean;
  /** tool_call_id -> progress line for a call that has not returned yet (a blocked shell_wait). */
  toolProgress?: Map<string, string>;
  pendingConfirm: ConfirmTicket | null;
  pendingPatch: PendingPatch | null;
  pendingPatches?: PendingPatch[];
  draftInsert?: string | null;
  onDraftConsumed?: () => void;
  /** Title of the active conversation, shown in the header. */
  sessionTitle?: string | null;
  /** 上一轮长时间没有进展（看门狗判定）—— 提示条据此出现。 */
  /** 刚才有一次发送被"上一轮还在进行"挡住了 —— 必须让用户看见。 */
  sendBlocked?: boolean;
  /** 草稿按会话分键存在 localStorage；关掉窗口再回来还在。 */
  draftKey?: string | null;
  /**
   * Present only in work-group mode: the agents sharing this conversation.
   * Rendered as a strip so you can see who is thinking / who has spoken.
   */
  groupPeers?: { id: string; name: string; hue: number; active: boolean; done: boolean }[];
  onSend: (text: string, images?: Array<{ path: string; mime: string; name?: string; url?: string }>) => void;
  onInterject?: (text: string) => void;
  onStop: () => void;
  onConfirm: () => void;
  onDismissConfirm: () => void;
  onApplyPatch: () => void;
  onRejectPatch: () => void;
  onApplyPatchById?: (patchId: string) => void;
  onRejectPatchById?: (patchId: string) => void;
  onApplyAllPatches?: () => void;
  onRejectAllPatches?: () => void;
  onDropPaths?: (paths: string[]) => void;
  skillProfile?: SkillProfileId;
  onSkillProfile?: (p: SkillProfileId) => void;
  thinkingLevel?: ThinkingLevel;
  onThinkingLevel?: (l: ThinkingLevel) => void;
  /** Rewind the conversation to (and including) a given message index. */
  onRewindTo?: (index: number) => void;
  /** Bring external agent context (Cursor/Claude Code/Codex) into this chat. */
  onImportContext?: () => void;
  /** Plans and timeline are scoped to this conversation. */
  onOpenPlans?: () => void;
  onOpenTimeline?: () => void;
  /** Manage custom skills from the composer. */
  onOpenSkills?: () => void;
  /** Open the scheduled-tasks panel. */
  onOpenSchedule?: () => void;
  /**
   * Open the cache-management panel (token pricing → compression strategy).
   *
   * Lives here rather than on the status bar: it CHANGES configuration, and the status
   * bar is the read-only telemetry row. It also belongs with 计划 / 时间线 / 技能库,
   * which are all "act on this conversation" and all sit under the composer.
   */
  onOpenCache?: () => void;
  focusChat?: boolean;
  onToggleFocus?: () => void;
}

interface SuggestHit {
  path: string;
  type: 'file' | 'dir' | 'symbol';
  name: string;
  line?: number;
  kind?: string;
  preview?: string;
}

/**
 * The one-line description of what a tool call acted on.
 *
 * Cursor shows the target of each step ("Read src/app.ts", "Run npm test")
 * rather than just the tool's name, so the transcript reads as a list of
 * actions instead of "shell, shell, fs_read". Picks the argument that actually
 * identifies the work; falls back to a compact arg dump.
 */
function summarizeToolArgs(name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    /*
     * Arguments stream in as fragments, so this is expected mid-call. Returning
     * '' keeps the header clean; dumping the fragment showed raw JSON like
     * `{"path": "she_hello.json", "content": "{\n` in the transcript.
     */
    return '';
  }
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const byName: Record<string, () => string> = {
    shell: () => pick('command'),
    fs_read: () => pick('path'),
    fs_write: () => pick('path'),
    fs_list: () => pick('path') || '.',
    grep: () => [pick('pattern'), pick('path')].filter(Boolean).join('  in  '),
    kb_query: () => pick('query'),
    kb_get: () => pick('id'),
    kb_upsert: () => [pick('groupName'), pick('title')].filter(Boolean).join(' / '),
    kb_link: () => [pick('sourceId'), pick('kind'), pick('targetId')].filter(Boolean).join(' '),
    kb_ingest_scan: () => pick('path') || pick('root'),
    web_search: () => pick('query'),
    web_fetch: () => pick('url'),
    ask_user: () => pick('question'),
    plan_create: () => pick('title') || pick('goal'),
    report_write: () => pick('title') || pick('path'),
    plan_update: () => [pick('plan_id'), pick('step_id'), pick('status')].filter(Boolean).join(' '),
    plan_add_steps: () => pick('plan_id') || pick('title'),
    kb_edit: () => pick('nodeId') || pick('id'),
    kb_retire: () => pick('nodeId') || pick('id'),
    kb_ingest_place: () => [pick('item_id'), pick('groupName')].filter(Boolean).join(' → '),
    memo_add: () => pick('text'),
    memo_update: () => pick('id') || pick('text'),
    memo_remove: () => pick('id'),
    errorbook_lookup: () => pick('query') || pick('tool'),
    errorbook_forget: () => pick('id'),
    schedule_create: () => [pick('name'), pick('at')].filter(Boolean).join(' @ '),
    schedule_cancel: () => pick('id'),
    skill_read: () => pick('name'),
    shell_wait: () => pick('id'),
    shell_kill: () => pick('id'),
    fs_patch: () => pick('path'),
    apply_patch: () => pick('path'),
    lsp_diagnostics: () => pick('path'),
    lsp_hover: () => pick('path'),
    lsp_definition: () => pick('path'),
    lsp_references: () => pick('path'),
    mcp_call: () => [pick('server'), pick('tool')].filter(Boolean).join(' / '),
  };
  const out = byName[name]?.();
  if (out) return out;

  /*
   * 表里没有的工具（新加的、MCP 的、插件的）**不再直接吐 JSON**。
   *
   * 直接输出整个 args 的 JSON，让记录看起来像调试日志：用户报的"渲染出问题"里就有一半
   * 是这个 —— 屏幕上出现 errorbook_forget {"id":"…","reason":"…"} 这样的行。这里先按一组
   * "通常就是目标"的键取名（与上面的表同一条原则：挑那个真正说明这次干了什么的参数），
   * 一个都取不到才退回 JSON —— 那时 JSON 至少还是唯一能说明问题的东西。
   */
  const generic = pick('query', 'command', 'path', 'url', 'text', 'name', 'title', 'id', 'nodeId', 'step_id', 'server', 'reason', 'tool');
  if (generic) return generic.slice(0, 80);

  const json = JSON.stringify(args);
  return json === '{}' ? '' : json.slice(0, 80);
}

/**
 * One readable line for a tool's output.
 *
 * Internal protocol payloads (`needs_apply`, `needs_confirm`) used to be shown
 * verbatim as raw JSON, which made the transcript look like a debug log.
 */
function resultPreviewText(result: string): string {
  const t = result.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (o.needs_apply) return '已暂存改动，等待应用';
      if (o.needs_confirm) return '需要确认后执行';
      if (typeof o.error === 'string') return o.error;
    } catch { /* not JSON, fall through */ }
  }
  return (t.split('\n').find((l) => l.trim()) ?? '').slice(0, 70);
}

/**
 * Render a unified diff with add/remove colouring.
 *
 * Diff lines are highlighted for their language too: a `-` / `+` prefix would
 * otherwise defeat the tokenizer, so the prefix is stripped, the remainder is
 * highlighted, and the prefix is re-attached visually via the row class.
 */
function DiffView({ unified, lang }: { unified: string; lang?: string }) {
  const lines = unified.split('\n');
  return (
    <pre className={styles.diffView}>
      {lines.map((l, i) => {
        const kind = l.startsWith('@@')
          ? styles.diffHunk
          : l.startsWith('+')
            ? styles.diffAdd
            : l.startsWith('-')
              ? styles.diffDel
              : styles.diffCtx;
        /*
         * Skip prefix lines and hunk headers for highlighting: the leading +/-
         * is diff syntax, not code. Tokenising it would mis-detect operators and
         * mis-colour the line. The +/- glyph is re-inserted as a dim marker.
         */
        const isCode = /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l);
        const marker = isCode ? l[0] : '';
        const body = isCode ? l.slice(1) : l;
        return (
          <div key={i} className={`${styles.diffLine} ${kind}`}>
            {isCode ? <span className={styles.diffMarker}>{marker}</span> : null}
            {isCode ? <HighlightedLine code={body} lang={lang} /> : (l || ' ')}
          </div>
        );
      })}
    </pre>
  );
}

/** Best-effort language from a file path, for highlighting. */
function langFromPath(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', py: 'python', json: 'json',
    sh: 'bash', bash: 'bash', ps1: 'powershell', css: 'css', scss: 'css',
    html: 'xml', xml: 'xml', md: 'markdown', yml: 'yaml', yaml: 'yaml',
    sql: 'sql', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', cc: 'cpp', hpp: 'cpp', h: 'cpp', toml: 'ini', ini: 'ini',
  };
  return map[ext] ?? '';
}

/** Highlight one line of code, falling back to plain text. */
function HighlightedLine({ code, lang }: { code: string; lang?: string }) {
  const { html, known } = useMemo(() => highlight(code, lang ?? ''), [code, lang]);
  if (!known) return <>{code}</>;
  return <span className="hljs" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * A staged file's full content, highlighted when a grammar exists.
 *
 * Separate from `HighlightedLine` because this needs its own block-level wrapper, but it follows the
 * same rule and for the same reason: **highlighted HTML may be injected; raw text never may.** The
 * previous version wrote the raw content when no grammar matched, which made any unparseable file an
 * XSS vector in the app's own origin.
 */
function WrittenFile({ content, lang }: { content: string; lang?: string }) {
  const { html, known } = useMemo(() => highlight(content, lang ?? ''), [content, lang]);
  return (
    <pre className={styles.toolCallCode}>
      {known
        ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        : <code>{content}</code>}
    </pre>
  );
}

/**
 * The file content a `fs_write` call is about to write.
 *
 * This is what makes an edit legible: previously a write showed only
 * `fs_write she_hello.json` and you had to expand a JSON argument blob to find
 * out what actually went into the file.
 */
function extractWrite(args: Record<string, unknown>): { path: string; content: string } | null {
  const path = typeof args.path === 'string' ? args.path : '';
  const content = args.content;
  if (!path || typeof content !== 'string') return null;
  return { path, content };
}

/** Does this tool call modify a file? Drives the code/diff rendering. */
function isFileWrite(name: string): boolean {
  return name === 'fs_write' || name === 'fs_patch' || name === 'apply_patch';
}

/**
 * A single tool call, shown as a concise action line.
 *
 * Previously this was a tiny chip reading `> fs_list v` — no target, 12px text,
 * and the result lived in a separate bubble, so the transcript did not convey
 * what the agent actually did.
 */
function ToolCallCard({
  toolCall,
  denied,
  result,
  progress,
}: {
  toolCall: ToolCallData;
  denied?: boolean;
  result?: string;
  /** Live line from a call that has not returned yet (e.g. a shell_wait blocking on a job). */
  progress?: string;
}) {
  const [open, setOpen] = useState(false);
  const name = toolCall.function.name;
  let argsObj: Record<string, unknown> = {};
  try {
    argsObj = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  } catch { /* still streaming in */ }

  const summary = summarizeToolArgs(name, toolCall.function.arguments);
  const resultPreview = result ? resultPreviewText(result) : '';
  const isWrite = isFileWrite(name);
  const written = isWrite ? extractWrite(argsObj) : null;

  // A staged write returns a unified diff; render that instead of a raw blob.
  let diff: string | null = null;
  if (result) {
    try {
      const o = JSON.parse(result) as { needs_apply?: { unified?: string } };
      if (o?.needs_apply?.unified) diff = o.needs_apply.unified;
    } catch { /* not a patch payload */ }
  }

  const verb = isWrite ? 'Edit' : name === 'shell' ? 'Run' : name === 'fs_read' ? 'Read' : name === 'grep' ? 'Search' : name;
  /**
   * A call with no result yet is still running.
   *
   * The animation matters most for knowledge-base lookups: those take a visible
   * amount of time, and without a live indicator the transcript looked frozen.
   */
  const running = result === undefined;
  /**
   * 会转圈的那一类：慢查询。`web_search` 也在里面 —— 它一次调用最坏要等一个源超时（默认 15 秒）
   * 再换下一个，没有转圈的卡看起来就是"卡住了"。
   */
  const isSearch = name === 'kb_query' || name === 'grep' || name === 'kb_ingest_scan' || name === 'web_search';

  return (
    <div className={`${styles.toolCallCard} ${denied ? styles.toolCallCardDenied : ''} ${running ? styles.toolCallRunning : ''}`} data-surface="tool">
      {/*
        A real <button>, not a div with onClick.

        The header expands and collapses the tool output, so it is a control — and a
        div is not reachable by keyboard, not announced as interactive, and not
        operable with Enter or Space. The visible affordance was identical, which is
        why this looked fine and was still unusable without a mouse.
      */}
      <button
        type="button"
        className={styles.toolCallHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? t('收起 {verb} 的详情', { verb }) : t('展开 {verb} 的详情', { verb })}
      >
        <div className={`${styles.toolCallLabel} ${denied ? styles.toolCallLabelDenied : ''}`}>
          <span className={`${styles.toolCallIcon} ${running && isSearch ? styles.searchIcon : ''}`}>
            {denied ? '⚠' : running && isSearch ? '◍' : '▸'}
          </span>
          {/* Verb + target reads as an action, the way a mature agent reports it. */}
          <span className={styles.toolCallVerb}>{verb}</span>
          {summary ? <span className={styles.toolCallSummary}>{summary}</span> : null}
          {running ? (
            <span className={styles.toolCallRunningLabel}>
              {isSearch ? '检索中' : '执行中'}
              <span className={styles.dots}><i /><i /><i /></span>
            </span>
          ) : null}
        </div>
        <span className={styles.toolCallRight}>
          {(diff || written) ? <span className={styles.toolCallChip}>{diff ? 'diff' : 'code'}</span> : null}
          {!diff && result ? <span className={styles.toolCallMeta}>{result.length} 字</span> : null}
          <span className={`${styles.toolCallChevron} ${open ? styles.toolCallChevronOpen : ''}`}>▾</span>
        </span>
      </button>

      {/* Sweep bar while the call is in flight, so a slow lookup is visibly alive. */}
      {running ? <div className={styles.toolCallProgress} aria-hidden /> : null}

      {/*
        What a still-running call is waiting for.

        Only shown while `running`: once the result exists this line is stale, and a card that says
        "still waiting" under a finished output is worse than one that says nothing.
      */}
      {running && progress ? (
        <div className={styles.toolCallLiveProgress}>{progress}</div>
      ) : null}

      {/* Collapsed: show the change itself, so edits are visible at a glance. */}
      {!open && diff ? <DiffView unified={diff} lang={langFromPath(written?.path ?? summary)} /> : null}
      {/*
        A whole file, syntax-highlighted when we have a grammar for it.

        This used to be `dangerouslySetInnerHTML={{ __html: highlight(...).html || clipCode(content) }}`.
        The `||` fallback was the bug: for a path with no registered language (`.txt`, `.log`, `.env`,
        a dotfile, no extension) `highlight()` returns an empty string, so the RAW file content was
        assigned as HTML. `<img src=x onerror=...>` written into any such file executed in the app
        origin — which holds the API, the file tools, and the stored keys — and the content is
        model-controlled, so a prompt injection in any file the agent read could reach it.

        `highlight()` escapes its own output, so the highlighted branch was safe; `HighlightedLine`
        is the pattern that was already used correctly a hundred lines up: render a React text node
        when the language is unknown.
      */}
      {!open && !diff && written ? <WrittenFile content={clipCode(written.content)} lang={langFromPath(written.path)} /> : null}
      {/* A KB lookup gets a structured, foldable hit list instead of raw text. */}
      {!open && !diff && !written && name === 'kb_query' && result ? (
        <KbResult content={result} />
      ) : null}
      {!open && !diff && !written && name !== 'kb_query' && resultPreview ? (
        <div className={styles.toolCallResultPreview}>{resultPreview}</div>
      ) : null}

      {open && (
        <div className={styles.toolCallBody}>
          {diff ? (
            <div className={styles.toolCallSection}>
              <div className={styles.toolCallSectionLabel}>{t('改动')}</div>
              <DiffView unified={diff} lang={langFromPath(written?.path ?? summary)} />
            </div>
          ) : null}
          {written ? (
            <div className={styles.toolCallSection}>
              <div className={styles.toolCallSectionLabel}>写入 {written.path}</div>
              <pre className={styles.toolCallCode}>{written.content}</pre>
            </div>
          ) : null}
          <div className={styles.toolCallSection}>
            <div className={styles.toolCallSectionLabel}>{t('参数')}</div>
            <pre className={styles.toolCallPre}>
              {Object.keys(argsObj).length ? JSON.stringify(argsObj, null, 2) : '(接收中…)'}
            </pre>
          </div>
          {result && !diff ? (
            <div className={styles.toolCallSection}>
              <div className={styles.toolCallSectionLabel}>{t('返回')}</div>
              <pre className={styles.toolCallPre}>
                {result}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Keep a collapsed code preview short; the full body is one click away. */
function clipCode(text: string, maxLines = 12): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… 还有 ${lines.length - maxLines} 行`;
}

/**
 * Parse a `kb_query` result into rows, one per found node.
 *
 * The tool returns a formatted list that is useful but noisy:
 *
 *   Found 6 nodes across 3 groups (12.3ms, 88 scanned)
 *   [1] title (fact) score=0.812
 *       group: ops | env
 *       preview text
 *       [Node: abc123]
 *
 * Rendering it as structured rows lets the list be folded to a couple of
 * entries instead of dumping every hit into the transcript.
 */
interface KbHit { index: number; title: string; kind: string; score: string; group: string; preview: string; id: string }

function parseKbQueryResult(text: string): { summary: string; hits: KbHit[] } {
  const lines = text.split('\n');
  const summary = lines[0] ?? '';
  const hits: KbHit[] = [];
  let cur: KbHit | null = null;
  for (const line of lines.slice(1)) {
    const head = /^\[(\d+)\]\s+(.*?)\s+\((\w+)\)\s+score=([\d.]+)/.exec(line);
    if (head) {
      if (cur) hits.push(cur);
      cur = { index: Number(head[1]), title: head[2], kind: head[3], score: head[4], group: '', preview: '', id: '' };
      continue;
    }
    if (!cur) continue;
    const grp = /^\s+group:\s+(.*)$/.exec(line);
    if (grp) { cur.group = grp[1].trim(); continue; }
    const idm = /\[Node:\s*([^\]]+)\]/.exec(line);
    if (idm) { cur.id = idm[1].trim(); continue; }
    const body = line.trim();
    if (body && !cur.preview) cur.preview = body;
  }
  if (cur) hits.push(cur);
  return { summary, hits };
}

/** Collapsible list of knowledge-base hits. */
function KbResult({ content }: { content: string }) {
  const { summary, hits } = parseKbQueryResult(content);
  const [showAll, setShowAll] = useState(false);
  const VISIBLE = 2;
  const shown = showAll ? hits : hits.slice(0, VISIBLE);

  // Unrecognised shape (no hits parsed) — fall back to plain text so nothing is hidden.
  if (hits.length === 0) return <pre className={styles.toolCallPre}>{content}</pre>;

  return (
    <div className={styles.kbResult}>
      <div className={styles.kbSummary}>{summary}</div>
      {shown.map((h) => (
        <div key={`${h.index}-${h.id}`} className={styles.kbHit}>
          <div className={styles.kbHitHead}>
            <span className={styles.kbHitRank}>{h.index}</span>
            <span className={styles.kbHitTitle}>{h.title}</span>
            <span className={styles.kbHitScore}>{h.score}</span>
          </div>
          {h.group ? <div className={styles.kbHitGroup}>{h.group}</div> : null}
          {h.preview ? <div className={styles.kbHitPreview}>{h.preview}</div> : null}
        </div>
      ))}
      {hits.length > VISIBLE ? (
        <button type="button" className={styles.kbMore} onClick={() => setShowAll((v) => !v)}>
          {showAll ? `收起（只显示前 ${VISIBLE} 条）` : `展开全部 ${hits.length} 条 ▾`}
        </button>
      ) : null}
    </div>
  );
}

async function copyText(text: string) {
  const value = text.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
}

/**
 * The model's chain of thought.
 *
 * Collapsed by default: the header shows the live label, the first line and
 * the length, so the chain is visibly there. One click shows the full text,
 * with no inner height cap (the transcript already scrolls).
 */
function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  // Collapsed by default (user setting). The header still shows the live
  // label, first line and length, and one click opens the full text.
  const [open, setOpen] = useState(false);
  /**
   * Once the reader opens or closes this block by hand, that choice wins.
   *
   * Without this the streaming effect below would re-open (or a re-render would
   * re-close) a block the user had just set, which read as the chain
   * "collapsing by itself".
   */
  const userToggled = useRef(false);
  const wasStreaming = useRef(Boolean(streaming));

  useEffect(() => {
    wasStreaming.current = Boolean(streaming);
  }, [streaming]);

  const chars = text.length;
  const firstLine = (text.split('\n').find((l) => l.trim()) ?? '').trim();

  return (
    <div className={styles.reasoning} data-surface="reasoning">
      <button
        type="button"
        className={styles.reasoningHeader}
        onClick={() => { userToggled.current = true; setOpen((v) => !v); }}
        title={open ? '收起思考过程' : '展开思考过程'}
      >
        <span className={styles.reasoningChevron}>{open ? '▾' : '▸'}</span>
        <span className={styles.reasoningLabel}>
          {streaming && !userToggled.current ? t('思考中…') : t('思维链')}
        </span>
        {!open && firstLine ? (
          <span className={styles.reasoningPreview}>{firstLine}…</span>
        ) : null}
        <span className={styles.reasoningMeta}>{chars} 字</span>
      </button>
      {open ? (
        <div className={styles.reasoningFlow}>
          <pre className={styles.reasoningBody}>{text}</pre>
        </div>
      ) : null}
    </div>
  );
}
function ToolResultCard({ name, content }: { name?: string; content: string }) {
  const [open, setOpen] = useState(false);
  const label = name || '工具';
  const firstLine = (content.split('\n')[0] || '').slice(0, 72);
  return (
    <div className={styles.toolResult}>
      <button
        type="button"
        className={styles.toolResultHeader}
        onClick={() => setOpen((v) => !v)}
        title={open ? '折叠' : '展开完整返回'}
      >
        <span className={styles.toolResultChevron}>{open ? '▾' : '▸'}</span>
        <span className={styles.toolResultLabel}>{label}</span>
        <span className={styles.toolResultPreview}>{firstLine}</span>
        <span className={styles.toolResultMeta}>{content.length} 字</span>
      </button>
      {open && (
        <pre className={styles.toolResultBody}>{content}</pre>
      )}
    </div>
  );
}

/**
 * One rendered message.
 *
 * Memoized because `messages` is replaced on every streamed token: without
 * this, a 100-message conversation re-rendered every bubble (and every
 * collapsible tool card inside it) on each chunk. `onRewind` is stable from
 * the parent, so a shallow compare is enough.
 */
const MessageBubble = memo(function MessageBubble({
  msg,
  index,
  onRewind,
  toolResults,
  toolProgress,
  renderedCallIds,
  onContinue,
}: {
  msg: ChatMessage;
  index: number;
  onRewind?: (index: number) => void;
  /** Present only on the latest turn's notice that offers 继续. */
  onContinue?: () => void;
  /** tool_call_id -> result text, so a call can show what it returned. */
  toolResults?: Map<string, string>;
  /** tool_call_id -> progress line, for a call that has not returned yet. */
  toolProgress?: Map<string, string>;
  /** Tool-call ids whose own card is on screen (suppresses the duplicate row). */
  renderedCallIds?: Set<string>;
}) {
  if (msg.role === 'tool') {
    /*
     * Suppress the standalone result row.
     *
     * A tool call and its output are one unit: the call card already renders
     * `result` (preview when collapsed, full body when expanded). Emitting a
     * second row for the same output doubled every step in the transcript —
     * `fs_write …` followed by the raw output of `fs_write …`.
     *
     * Orphans (a result whose call was trimmed out of the visible window) are
     * still shown, so nothing is silently lost.
     */
    if (msg.toolCallId && renderedCallIds?.has(msg.toolCallId)) return null;
    return (
      <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
        <ToolResultCard name={msg.toolName} content={msg.content} />
      </div>
    );
  }
  if (msg.role === 'system') {
    /*
     * A notice (reply cut off at the length ceiling, connection dropped, turn failed) is styled
     * so it cannot be mistaken for routine status, and offers 继续 when the reply can be resumed.
     */
    if (msg.notice) {
      return (
        <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
          <div className={`${styles.bubbleWrap}`}>
            <div
              className={`${styles.bubble} ${styles.bubbleSystem} ${styles.bubbleNotice}`}
              data-surface="bubble"
              data-notice={msg.notice.kind}
              role="status"
            >
              <span>{msg.content}</span>
              {msg.notice.action === 'continue' && onContinue ? (
                <button type="button" className={styles.noticeContinueBtn} title={t('接着上一条回答往下写（追加新的一轮，不改动已有内容）')} onClick={onContinue}>
                  {t('继续')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
        <div className={`${styles.bubbleWrap}`}>
          <div className={`${styles.bubble} ${styles.bubbleSystem}`} data-surface="bubble">{msg.content}</div>
          {msg.content ? (
            <button type="button" className={styles.copyBtn} title={t('复制')} onClick={() => void copyText(msg.content)}>
              复制
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  /**
   * Guard against an empty bubble.
   *
   * A tool-loop round can produce no prose and no reasoning (tool call only),
   * and a streaming round starts as an empty assistant message. Rendering those
   * left a small unexplained dark blob in the transcript.
   */
  if (!msg.content?.trim() && !msg.reasoning?.trim() && !(msg.toolCalls?.length)) {
    return null;
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    return (
      <>
        {msg.reasoning ? <ReasoningBlock text={msg.reasoning} streaming={msg.isStreaming} /> : null}
        {msg.content && (
          <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
            <div className={styles.bubbleWrap}>
              <div className={`${styles.bubble} ${styles.bubbleAssistant}`}
                data-surface="bubble">
                <Markdown text={msg.content} />
                {msg.isStreaming && <span className={styles.streamingDot} />}
              </div>
              {!msg.isStreaming ? (
                <button type="button" className={styles.copyBtn} title={t('复制')} onClick={() => void copyText(msg.content)}>
                  复制
                </button>
              ) : null}
            </div>
          </div>
        )}
        {msg.toolCalls.map((tc) => (
          <div key={tc.id} className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
            <ToolCallCard toolCall={tc} result={toolResults?.get(tc.id)} progress={toolProgress?.get(tc.id)} />
          </div>
        ))}
      </>
    );
  }
  const isUser = msg.role === 'user';
  // A turn that is only a chain is not an empty reply. Showing "（空回复）"
  // under a collapsed header is what made the chain look missing.
  const body = msg.content || (msg.isStreaming || msg.reasoning ? '' : '（空回复）');
  return (
    <>
    {!isUser && msg.speaker ? (
      <div className={styles.speakerRow}>
        <span className={styles.speakerAvatar} style={{ background: `hsl(${msg.speaker.hue} 68% 52%)` }}>
          {msg.speaker.name.slice(0, 1)}
        </span>
        <span className={styles.speakerName}>{msg.speaker.name}</span>
      </div>
    ) : null}
    {!isUser && msg.reasoning ? (
      <ReasoningBlock text={msg.reasoning} streaming={msg.isStreaming && !msg.content} />
    ) : null}

    {/*
      Assistant prose is NOT a bubble.
      Boxing every assistant message made the transcript a stack of identical
      cards — the "same bubble everywhere" flatness. A coding agent's reply is
      the document itself, so it renders as plain flowing text; only the user's
      own words get a container. This is the single biggest visual difference
      from tools like Cursor / Claude Code.
    */}
    {isUser ? (
      <div className={`${styles.messageRow} ${styles.messageRowUser}`}>
        <div className={styles.bubbleWrap}>
          {msg.images?.length ? (
            <div className={styles.bubbleImages}>
              {msg.images.map((im) => (
                im.mime?.startsWith('image/') && im.url ? (
                  <a key={im.path} className={styles.bubbleImageLink} href={attachmentUrl(im.url)} target="_blank" rel="noreferrer" title={im.name ?? im.path}>
                    <img className={styles.bubbleImage} src={attachmentUrl(im.url)} alt={im.name ?? t('附件')} />
                  </a>
                ) : (
                  /* Non-images are named, not thumbnailed: the agent reads the file itself. */
                  <span key={im.path} className={styles.bubbleFileChip}>{im.name ?? im.path}</span>
                )
              ))}
            </div>
          ) : null}
          <div className={`${styles.bubble} ${styles.bubbleUser}`} data-surface="bubble">
            {body}
          </div>
          {!msg.isStreaming && msg.content ? (
            <button
              type="button"
              className={`${styles.copyBtn} ${styles.copyBtnUser}`}
              title={t('复制')}
              onClick={() => void copyText(msg.content)}
            >
              复制
            </button>
          ) : null}
          {!msg.isStreaming && onRewind ? (
            <button
              type="button"
              className={styles.rewindBtn}
              title={t('从这里撤销：本条及其之后的对话都会被删除，并回到这一轮重新开始')}
              onClick={() => onRewind(index)}
            >
              撤销到此
            </button>
          ) : null}
        </div>
      </div>
    ) : (body || msg.isStreaming) ? (
      <div className={`${styles.messageRow} ${styles.messageRowAssistant} ${styles.proseRow}`}>
        <div className={styles.prose} data-surface="prose">
          <Markdown text={body} />
          {msg.isStreaming && <span className={styles.streamingDot} />}
        </div>
        {!msg.isStreaming && msg.content ? (
          <button
            type="button"
            className={styles.copyBtn}
            title={t('复制')}
            onClick={() => void copyText(msg.content)}
          >
            复制
          </button>
        ) : null}
        {!msg.isStreaming && onRewind ? (
          <button
            type="button"
            className={styles.rewindBtn}
            title={t('从这里撤销：本条及其之后的对话都会被删除，并回到这一轮重新开始')}
            onClick={() => onRewind(index)}
          >
            撤销到此
          </button>
        ) : null}
      </div>
    ) : null}
    </>
  );
});

function mentionQuery(value: string, caret: number): { kind: 'file' | 'folder' | 'path' | 'symbol'; start: number; end: number; q: string } | null {
  const left = value.slice(0, caret);
  const m = left.match(/@(file:|folder:|symbol:)?([^\s@]*)$/);
  if (!m) return null;
  const tag = m[1];
  const kind = tag === 'file:' ? 'file' : tag === 'folder:' ? 'folder' : tag === 'symbol:' ? 'symbol' : 'path';
  return { kind, start: caret - m[0].length, end: caret, q: m[2] || '' };
}

const ATTACHMENT_BADGE: Record<string, string> = {
  '.pdf': 'PDF', '.md': 'MD', '.markdown': 'MD', '.txt': 'TXT', '.json': 'JSON',
  '.csv': 'CSV', '.tsv': 'TSV', '.log': 'LOG', '.yaml': 'YAML', '.yml': 'YAML',
  '.xml': 'XML', '.html': 'HTML', '.css': 'CSS', '.js': 'JS', '.ts': 'TS',
  '.tsx': 'TSX', '.jsx': 'JSX', '.py': 'PY', '.go': 'GO', '.rs': 'RS',
  '.java': 'JAVA', '.sql': 'SQL', '.sh': 'SH', '.ps1': 'PS1', '.zip': 'ZIP',
  '.docx': 'DOC', '.doc': 'DOC', '.xlsx': 'XLS', '.ppt': 'PPT', '.pptx': 'PPT',
};

/**
 * The label a chip shows for a non-image file: `PDF`, `CSV`, `BIN`.
 *
 * Three or four characters, because the badge is a fixed square — anything longer moves the
 * filename, which is the part the user is actually reading.
 */
function attachmentBadge(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return ATTACHMENT_BADGE[ext] ?? (ext ? ext.slice(1, 5).toUpperCase() : 'FILE');
}

/**
 * The stored name without the generated prefix: `m3k1a2b3-9f0d1e2a-报告.pdf` → `报告.pdf`.
 *
 * The prefix is what keeps two pastes of `image.png` apart on disk, and it is noise in a chip.
 * If the shape ever changes the whole name is shown, which is merely ugly rather than wrong.
 */
function attachmentDisplayName(name: string): string {
  const m = /^[0-9a-z]+-[0-9a-f]{8}-(.+)$/.exec(name);
  return m ? m[1] : name;
}

export function Chat({
  messages,
  isLoading,
  toolProgress,
  pendingConfirm,
  pendingPatch,
  pendingPatches = [],
  onSend,
  onInterject,
  onStop,
  skillProfile = 'dev',
  onSkillProfile,
  thinkingLevel = 'medium',
  onThinkingLevel,
  onRewindTo,
  onConfirm,
  onDismissConfirm,
  onApplyPatch,
  onRejectPatch,
  onApplyPatchById,
  onRejectPatchById,
  onApplyAllPatches,
  onRejectAllPatches,
  draftInsert,
  onDraftConsumed,
  sessionTitle,
  sendBlocked,
  draftKey,
  groupPeers,
  onDropPaths,
  onImportContext,
  onOpenPlans,
  onOpenTimeline,
  onOpenSkills,
  onOpenSchedule,
  onOpenCache,
  focusChat = false,
  onToggleFocus,
}: ChatProps) {
  const [input, setInput] = useState('');

  /*
   * 草稿跟着会话走。
   *
   * 抱怨很具体："关闭窗口后不会保留窗口内未发送的消息"。所以存 localStorage
   * （sessionStorage 的生命周期就是那个窗口，正是要修的行为），按会话分键，
   * 切回来时把草稿放回输入框；发送后 input 变空，saveDraft 顺手把键删掉。
   */
  useEffect(() => {
    setInput(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    saveDraft(draftKey, input);
  }, [draftKey, input]);
  const [dragging, setDragging] = useState(false);
  /*
   * Files waiting to be sent with the next message.
   *
   * A pasted screenshot has no path — unlike a dropped file, the clipboard only carries bytes —
   * so it cannot be referenced with `@path` the way a drop is. It is uploaded immediately instead,
   * and the chip shows the thumbnail from the stored copy: uploading at paste time is what lets
   * the user see what they actually attached before spending a turn on it.
   */
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [hits, setHits] = useState<SuggestHit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  /**
   * Whether new output should pull the viewport down.
   *
   * Previously every `messages` change called scrollIntoView, so the transcript
   * yanked itself to the bottom while the model streamed — reading anything
   * earlier was impossible. Now we follow only while the user is already near
   * the bottom, and offer an explicit jump back otherwise.
   */
  const stickToBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!draftInsert) return;
    setInput((prev) => {
      const chunk = draftInsert;
      if (!prev.trim()) return chunk;
      return prev.replace(/\s*$/, '') + (prev.endsWith('\n') ? '' : '\n') + chunk;
    });
    onDraftConsumed?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draftInsert, onDraftConsumed]);

  /**
   * tool_call_id -> result text.
   *
   * Tool results arrive as their own messages, so without this pairing the
   * transcript showed a call and its output as two unrelated bubbles.
   */
  const toolResults = useMemo(() => {
    const m = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) m.set(msg.toolCallId, msg.content);
    }
    return m;
  }, [messages]);

  /**
   * Tool-call ids whose card is actually on screen.
   *
   * Built from the VISIBLE window, not the whole history: a result row whose
   * call was trimmed out of the window must still render on its own, otherwise
   * the output would silently disappear.
   */
  const renderedCallIds = useMemo(() => {
    const s = new Set<string>();
    for (const msg of messages) {
      for (const tc of msg.toolCalls ?? []) if (tc.id) s.add(tc.id);
    }
    return s;
  }, [messages]);

  /** Follow the transcript only when the reader is already at the bottom. */
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = gap < 80;
      stickToBottomRef.current = near;
      setAtBottom(near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  /**
   * Land on the newest row, and STAY there.
   *
   * `scrollIntoView({ behavior: 'smooth' })` stopped being enough the moment the rows got
   * `content-visibility: auto` (`.messageRow`, styles/Chat.module.css): rows outside the viewport are
   * laid out at the `contain-intrinsic-size` guess, so the offset a smooth animation aims at is stale
   * as soon as the animation passes a row and its real height replaces the guess. The visible symptom
   * was the user's report: press 回到最新 and land short of the newest message.
   *
   * Instant assignment, then re-assign while the height is still settling (each pass realises the rows
   * near the bottom, so the next `scrollHeight` is the truer one). No smooth: an animation cannot
   * chase a target that moves under it.
   */
  const landAtLatest = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    let passes = 0;
    const land = () => {
      el.scrollTop = el.scrollHeight;
      passes += 1;
      if (passes < 3 && el.scrollHeight - el.scrollTop - el.clientHeight > 2) {
        requestAnimationFrame(land);
      }
    };
    land();
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    landAtLatest();
  }, [messages, pendingConfirm, pendingPatch, landAtLatest]);

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    setAtBottom(true);
    landAtLatest();
  }, [landAtLatest]);

  /*
   * Mention autocomplete.
   *
   * Two races used to be possible, both visible as "the menu shows results for what I typed a moment
   * ago": the debounce timer was never cleared on unmount, and the fetch was neither aborted nor
   * sequenced, so a slow response for `@a` could land after the response for `@abc` and overwrite it
   * (or reopen the menu after the user had moved on). A sequence token fixes the ordering; the
   * unmount cleanup fixes the rest.
   */
  const suggestSeq = useRef(0);
  const refreshSuggest = useCallback((value: string, caret: number) => {
    const mq = mentionQuery(value, caret);
    if (!mq) {
      suggestSeq.current++;
      setMentionOpen(false);
      setHits([]);
      return;
    }
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    suggestTimer.current = window.setTimeout(async () => {
      const seq = ++suggestSeq.current;
      try {
        let list: SuggestHit[] = [];
        if (mq.kind === 'symbol') {
          const data = await fetchJSON<{ symbols: Array<{ name: string; kind: string; path: string; line: number; preview: string }> }>(
            `/api/fs/symbols?q=${encodeURIComponent(mq.q)}&limit=12`,
          );
          if (seq !== suggestSeq.current) return;
          list = (data.symbols || []).map((sym) => ({
            type: 'symbol' as const,
            path: sym.path,
            name: sym.name,
            line: sym.line,
            kind: sym.kind,
            preview: sym.preview,
          }));
        } else {
          const data = await fetchJSON<{ hits: SuggestHit[] }>(
            `/api/fs/suggest?q=${encodeURIComponent(mq.q)}&limit=12`,
          );
          if (seq !== suggestSeq.current) return;
          list = data.hits || [];
          if (mq.kind === 'file') list = list.filter((h) => h.type === 'file');
          if (mq.kind === 'folder') list = list.filter((h) => h.type === 'dir');
        }
        setHits(list);
        setHitIndex(0);
        setMentionOpen(list.length > 0);
      } catch {
        if (seq !== suggestSeq.current) return;
        setMentionOpen(false);
        setHits([]);
      }
    }, 120);
  }, []);

  // Cancel a pending lookup when the surface goes away, so it cannot update state after unmount.
  useEffect(() => () => {
    suggestSeq.current++;
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
  }, []);

  /**
   * File/folder references attached to the next message.
   *
   * Previously picking a suggestion spliced a raw `@file:src/App.tsx` token into
   * the textarea, so the user composed prose with machine syntax in it. They are
   * now shown as removable chips and only converted to `@file:`/`@folder:`
   * tokens at send time, which the server's expandMentions already understands.
   */
  const [refs, setRefs] = useState<{ type: 'file' | 'dir' | 'symbol'; path: string; line?: number; name?: string }[]>([]);

  const applyHit = useCallback((hit: SuggestHit) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? input.length;
    const mq = mentionQuery(input, caret);
    if (!mq) return;
    setRefs((prev) => {
      if (hit.type === 'symbol') {
        const key = hit.path + ':' + (hit.line || 0) + ':' + hit.name;
        return prev.some((r) => r.type === 'symbol' && r.path + ':' + (r.line || 0) + ':' + (r.name || '') === key)
          ? prev
          : [...prev, { type: 'symbol', path: hit.path, line: hit.line, name: hit.name }];
      }
      return prev.some((r) => r.type === hit.type && r.path === hit.path)
        ? prev
        : [...prev, { type: hit.type === 'dir' ? 'dir' : 'file', path: hit.path }];
    });
    // Drop the "@..." fragment the user was typing; the chip replaces it.
    const next = (input.slice(0, mq.start) + input.slice(mq.end)).replace(/\s{2,}/g, ' ');
    setInput(next);
    setMentionOpen(false);
    setHits([]);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      const pos = mq.start;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
    });
  }, [input]);

  const removeRef = useCallback((type: 'file' | 'dir' | 'symbol', path: string, line?: number, name?: string) => {
    setRefs((prev) => prev.filter((r) => {
      if (type === 'symbol') return !(r.type === 'symbol' && r.path === path && r.line === line && r.name === name);
      return !(r.type === type && r.path === path);
    }));
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    // While an upload is in flight there is nothing to send yet: the chip is not there, so a
    // message sent now would go out without the file the user thinks they just pasted.
    if (attachBusy) return;
    if (!trimmed && refs.length === 0 && attachments.length === 0) return;
    // Re-attach references as tokens for the server; the UI never showed them.
    const prefix = refs
      .map((r) => {
        if (r.type === 'dir') return `@folder:${r.path}`;
        if (r.type === 'symbol') return `@file:${r.path} /* symbol ${r.name}@L${r.line || '?'} */`;
        return `@file:${r.path}`;
      })
      .join(' ');
    const message = [prefix, trimmed].filter(Boolean).join(' ');
    setRefs([]);
    /*
     * An attachment with no words still says something ("what is wrong here?"), so the message may
     * be empty on the wire. The server and the providers treat images and text as independent
     * parts; inventing placeholder text here would be a sentence the user never wrote.
     */
    const images = attachments.map((a) => ({ path: a.path, mime: a.mime, name: a.name, url: a.url }));
    // While a turn is running the same box appends context instead of
    // interrupting it — the agent folds it in at the next iteration.
    if (isLoading) {
      onInterject?.(message);
      /*
       * The chips STAY when interjecting.
       *
       * A mid-turn addition is text only, so clearing them here would delete the attachment the
       * user is looking at while telling them nothing — they would believe the image went out with
       * the interjection. Leaving them in the box is the honest signal: still not sent.
       */
      setInput('');
      setMentionOpen(false);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      return;
    }
    setAttachments([]);
    onSend(message, images);
    setInput('');
    setMentionOpen(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, isLoading, onSend, onInterject, refs, attachments, attachBusy]);

  /** 继续 on a cut-off reply: appends a continuation turn, never edits the reply already sent. */
  const handleContinue = useCallback(() => { onSend(continuePrompt()); }, [onSend]);
  /** Only a notice after the latest user message offers 继续 — an older one would resume the wrong reply. */
  const lastUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
    return -1;
  }, [messages]);

  /** Live shortcut map: reloaded when the settings dialog changes bindings. */
  const shortcutsRef = useRef<ShortcutMap>(loadShortcuts());
  useEffect(() => {
    const sync = () => { shortcutsRef.current = loadShortcuts(); };
    window.addEventListener('she:shortcuts-changed', sync);
    return () => window.removeEventListener('she:shortcuts-changed', sync);
  }, []);

  /** Timestamp of the last bare Enter, used to detect a double-Enter interrupt. */
  const lastEnterRef = useRef(0);
  const DOUBLE_ENTER_MS = 500;

  /**
   * Continuous slider position (0..3, fractional while dragging).
   * Kept separate from the committed level so the thumb glides smoothly and
   * only snaps to a level once released.
   */
  const [thinkRaw, setThinkRaw] = useState(() =>
    Math.max(0, THINK_LEVELS.findIndex((lv) => lv.id === thinkingLevel)),
  );
  useEffect(() => {
    setThinkRaw(Math.max(0, THINK_LEVELS.findIndex((lv) => lv.id === thinkingLevel)));
  }, [thinkingLevel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mentionOpen && hits.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setHitIndex((i) => (i + 1) % hits.length); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setHitIndex((i) => (i - 1 + hits.length) % hits.length); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
          e.preventDefault();
          applyHit(hits[hitIndex]);
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); setMentionOpen(false); return; }
      }

      // User-configurable bindings (Settings → 快捷键).
      const keys = shortcutsRef.current;

      if (matchesChord(e, keys['chat.interrupt'] ?? '')) {
        e.preventDefault();
        onStop?.();
        return;
      }

      if (matchesChord(e, keys['chat.interject'] ?? '')) {
        e.preventDefault();
        handleSend();
        return;
      }

      if (matchesChord(e, keys['chat.send'] ?? 'Enter')) {
        e.preventDefault();
        // While a turn is running a single send-chord appends context rather
        // than interrupting; a quick double press interrupts instead.
        if (isLoading) {
          const now = Date.now();
          if (now - lastEnterRef.current <= DOUBLE_ENTER_MS) {
            lastEnterRef.current = 0;
            onStop?.();
            return;
          }
          lastEnterRef.current = now;
        }
        handleSend();
        return;
      }
      // `chat.newline` intentionally falls through to the textarea default.
    },
    [mentionOpen, hits, hitIndex, applyHit, handleSend, isLoading, onStop],
  );

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);
      const el = e.target;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      refreshSuggest(value, el.selectionStart ?? value.length);
    },
    [refreshSuggest],
  );

  /**
   * Upload files and hang them on the message.
   *
   * One path for all three ways in — the picker, a paste, and a drop that carried no real path —
   * because they were three separate implementations before and only the paste one was ever
   * exercised. Each file is uploaded on its own so one rejection (too large, wrong type) does not
   * discard the rest; the failures are collected and shown together.
   */
  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setAttachError(null);
    setAttachBusy(true);
    const failed: string[] = [];
    try {
      for (const file of files) {
        try {
          // A pasted image arrives as `image.png` from the clipboard; keep a real name if there is one.
          const uploaded = await uploadAttachment(file, file.name || 'pasted');
          setAttachments((prev) => [...prev, uploaded]);
        } catch (err) {
          failed.push(`${file.name || '未命名'}：${(err as Error).message}`);
        }
      }
    } finally {
      setAttachBusy(false);
      if (failed.length) setAttachError(t('上传失败：{list}', { list: failed.join('；') }));
    }
  }, []);

  /**
   * Paste: an image becomes an attachment, anything else pastes as usual.
   *
   * Only `preventDefault` when we actually took an image, so pasting text, a path, or a code block
   * keeps the browser's behaviour — including the `@file:` references the composer already
   * understands.
   */
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) files.push(f);
    }
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  }, [addFiles]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const removeAttachment = useCallback((name: string) => {
    setAttachments((prev) => prev.filter((a) => a.name !== name));
  }, []);

  /** `12.3KB` / `1.4MB`. Chips show this instead of raw bytes. */
  const humanSize = useCallback((bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }, []);

  return (
    <div
      className={`${styles.container}${dragging ? ' ' + styles.dragOver : ''}`}
      onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const paths: string[] = [];
        const uploadable: File[] = [];
        const files = e.dataTransfer.files;
        for (let i = 0; i < files.length; i++) {
          const f = files[i] as File & { path?: string };
          /*
           * A real filesystem path means the shell gave us one, and a `@file:` reference is
           * strictly better than an upload: the agent reads the live file, and edits land in
           * place. In a plain browser `f.path` is absent and `f.name` is only a basename, which
           * resolves to nothing — so those files are uploaded instead of referenced. This is the
           * case that made "拖动文件" look broken: the drop silently produced a reference to a
           * file that was never there.
           */
          if (f.path) paths.push(f.path);
          else uploadable.push(f);
        }
        const uri = e.dataTransfer.getData('text/plain');
        if (uri && !paths.includes(uri) && !uploadable.length) paths.push(uri);
        if (uploadable.length) void addFiles(uploadable);
        if (paths.length) onDropPaths?.(paths);
      }}
    >
      {dragging && <div className={styles.dropOverlay}>{t('松开以引用到对话')}</div>}
      <div className={styles.header}>
        <span className={styles.headerTitle}>{sessionTitle || '对话'}</span>
        <div className={styles.headerActions}>
        </div>
      </div>

      {/* Work-group mode: who is in this conversation, and what they are doing. */}
      {groupPeers && groupPeers.length > 0 ? (
        <div className={styles.peerStrip}>
          {groupPeers.map((p) => (
            <span
              key={p.id}
              className={`${styles.peerChip} ${p.active ? styles.peerActive : ''} ${p.done ? styles.peerDone : ''}`}
              title={p.active ? `${p.name} 正在发言` : p.done ? `${p.name} 本轮已发言` : `${p.name} 待命`}
            >
              <span className={styles.peerAvatar} style={{ background: `hsl(${p.hue} 68% 56%)` }}>
                {p.name.slice(0, 1)}
              </span>
              <span className={styles.peerName}>{p.name}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className={styles.messages} ref={messagesRef} data-surface="transcript">
        {messages.length === 0 ? (
          <div className={styles.emptyMessages}>
            <div className={styles.emptyOrb} aria-hidden />
            <div className={styles.emptyIcon}>✦</div>
            <div className={styles.emptyText}>{t('开始对话')}</div>
            <div className={styles.emptyHint}>
                  用 @file: / @folder: / @symbol: 挂工作区；#标题 走结构共振（非 RAG）
            </div>
            <div className={styles.emptyShortcuts}>
              <kbd>Enter</kbd> {t('发送 ·')} <kbd>Shift</kbd>+<kbd>Enter</kbd> {t('换行 ·')} <kbd>Ctrl</kbd>+<kbd>K</kbd> 命令面板
            </div>
            <div className={styles.emptyShortcuts}>
              拖入壁纸可换背景 · 拖入项目目录可挂载工作区
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble
                key={i}
                msg={msg}
                index={i}
                onRewind={onRewindTo}
                toolResults={toolResults}
                toolProgress={toolProgress}
                renderedCallIds={renderedCallIds}
                onContinue={msg.notice?.action === 'continue' && i > lastUserIdx && !isLoading ? handleContinue : undefined}
              />
            ))}
          </>
        )}
        {isLoading ? (
          <div className={styles.skeletonRow} aria-hidden>
            <div className={`she-skeleton ${styles.skeletonBubble}`} />
          </div>
        ) : null}
        {/* Sticky so it stays at the bottom edge of the scrollport rather than
            scrolling away with the content. */}
        {!atBottom && messages.length > 0 ? (
          <button type="button" className={styles.jumpLatest} onClick={jumpToLatest} title={t('回到最新')}>
            ↓ 回到最新
          </button>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      {pendingPatches.length > 1 && onApplyAllPatches && onRejectAllPatches && onApplyPatchById && onRejectPatchById ? (
        <ComposerPanel
          patches={pendingPatches}
          busy={isLoading}
          onApplyOne={onApplyPatchById}
          onRejectOne={onRejectPatchById}
          onApplyAll={onApplyAllPatches}
          onRejectAll={onRejectAllPatches}
        />
      ) : pendingPatch ? (
        <DiffPanel patch={pendingPatch} busy={isLoading} onApply={onApplyPatch} onReject={onRejectPatch} />
      ) : null}

      {pendingConfirm && (
        <div className={styles.confirmBar} role="dialog" aria-label={t('需要确认')} data-surface="confirm">
          <div className={styles.confirmHead}>
            <span className={styles.confirmHeadIcon} aria-hidden>⚠</span>
            <span>{t('需要确认')}</span>
          </div>
          <div className={styles.confirmSummary}>
            <code className={styles.confirmTool}>{pendingConfirm.tool}</code> {pendingConfirm.summary}
          </div>
          <div className={styles.confirmTicket}>{pendingConfirm.ticket_id}</div>
          <div className={styles.confirmActions}>
            <button className={styles.confirmYes} onClick={onConfirm} disabled={isLoading}>{t('确认执行')}</button>
            <button className={styles.confirmNo} onClick={onDismissConfirm} disabled={isLoading}>{t('取消')}</button>
          </div>
        </div>
      )}

      {/*
        发不出去时的提示条。
        只有这一种情况还留着：这一轮在跑、而这次发送被拒绝了（要塞进去的字还在框里）。
        「90 秒没新进展就算卡住」那条已经拿掉 —— 一次工具调用本来就几分钟没有新帧（长命令、
        长思考都是），它在正常路径上就会亮，等于训练人忽略它。要停随时能停：运行中发送键
        就是「停止」，还有连按两次 Enter 的打断快捷键。
      */}
      {isLoading && sendBlocked ? (
        <div className={styles.runNotice} role="status" data-surface="run-notice">
          <span className={styles.runNoticeText}>
              t('上一轮还在进行 —— 先停掉它，或者等它结束')
          </span>
          <button type="button" className={styles.runNoticeBtn} onClick={onStop}>
            {t('打断这一轮')}
          </button>
        </div>
      ) : null}

      <AskCard onAnswer={(text) => onSend(text)} />

      <div className={styles.inputArea} data-surface="input">
        {mentionOpen && hits.length > 0 && (
          <div className={styles.mentionMenu} data-surface="mention">
            {hits.map((h, i) => {
              const parts = h.path.split('/');
              const leaf = h.type === 'symbol' ? `${h.name}()` : (parts.pop() ?? h.path);
              const parent = h.type === 'symbol' ? `${h.path}:${h.line ?? '?'} · ${h.kind || 'symbol'}` : parts.join('/');
              return (
                <button
                  key={h.type + ':' + h.path + ':' + (h.line || '') + ':' + h.name}
                  type="button"
                  className={`${styles.mentionItem} ${i === hitIndex ? styles.mentionItemActive : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); applyHit(h); }}
                >
                  {/* Icon carries the file/folder distinction; the old text label
                      ("目录"/"文件") pushed the path out of view. */}
                  <span className={styles.mentionKind}>{h.type === 'dir' ? '📁' : '📄'}</span>
                  <span className={styles.mentionLeaf}>{leaf}</span>
                  {parent ? <span className={styles.mentionPath}>{parent}</span> : null}
                </button>
              );
            })}
          </div>
        )}

        {/* Attached references, shown as pills rather than raw @tokens. */}
        {refs.length > 0 ? (
          <div className={styles.refChips}>
            {refs.map((r) => (
              <span key={`${r.type}:${r.path}`} className={styles.refChip} title={r.path}>
                <span className={styles.refChipIcon}>{r.type === 'dir' ? '📁' : r.type === 'symbol' ? '⌘' : '📄'}</span>
                <span className={styles.refChipName}>{r.type === 'symbol' ? `${r.name} · ${r.path.split('/').pop()}:${r.line ?? '?'}` : r.path.split('/').pop()}</span>
                <button
                  type="button"
                  className={styles.refChipRemove}
                  onClick={() => removeRef(r.type, r.path, r.line, r.name)}
                  title={t('移除引用')}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className={styles.inputWrapper}>
          {/*
            Attachment chips sit above the box, inside the same rounded frame.
            A picture shows its thumbnail — the whole point of pasting a screenshot is not having
            to describe it, and the clipboard name is always `image.png`, so the strip is how the
            user checks they pasted the right one. Everything else shows a type badge plus the
            filename and size, because for a document those are the only identifying things there
            are, and a chip that showed neither is what made upload look unfinished.
          */}
          {attachments.length || attachError || attachBusy ? (
            <div className={styles.attachRow}>
              {attachments.map((a) => (
                <div key={a.name} className={styles.attachChip} title={`${a.path} · ${a.mime || '未知类型'} · ${humanSize(a.bytes)}`}>
                  {/*
                    A picture shows itself; anything else shows what it is.
                    The old chip printed the first four characters of the extension and nothing
                    else, so a dropped `报告.pdf` and a dropped `数据.csv` looked identical — the
                    user could not tell what they had attached, which is most of "上传过于简陋".
                  */}
                  {a.mime.startsWith('image/') ? (
                    <img className={styles.attachThumb} src={attachmentUrl(a.url)} alt={a.name} />
                  ) : (
                    <span className={styles.attachExt}>{attachmentBadge(a.name)}</span>
                  )}
                  <span className={styles.attachMeta}>
                    <span className={styles.attachName}>{attachmentDisplayName(a.name)}</span>
                    <span className={styles.attachSize}>{humanSize(a.bytes)}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.attachRemove}
                    onClick={() => removeAttachment(a.name)}
                    title={t('移除附件')}
                    aria-label={t('移除附件')}
                  >×</button>
                </div>
              ))}
              {attachBusy ? <div className={`${styles.attachChip} ${styles.attachBusy}`}>{t('上传中…')}</div> : null}
              {attachError ? <div className={styles.attachError}>{attachError}</div> : null}
            </div>
          ) : null}

          <div className={styles.inputRow}>
            {/*
              The only visible way to add a file.
              Paste and drag existed and worked, but nothing said so: a user who wanted to attach a
              PDF looked for a paperclip, did not find one, and concluded attachments were
              image-only. `accept` is deliberately wide and names no types — the server decides
              what it will store, and a narrow `accept` is how a browser silently greys out the
              file the user came to pick.
            */}
            <button
              type="button"
              className={styles.attachBtn}
              onClick={() => fileInputRef.current?.click()}
              disabled={attachBusy}
              title={t('添加文件（也可以直接拖进来或粘贴）')}
              aria-label={t('添加文件')}
            ><IconPaperclip size={16} /></button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className={styles.attachInput}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                // Cleared so picking the same file twice in a row still fires a change event.
                e.currentTarget.value = '';
                if (picked.length) void addFiles(picked);
              }}
            />

          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder={
              isLoading
                ? '补充信息…（Enter 追加 · 连按两次 Enter 打断 · Shift+Enter 换行）'
                : '@file: / @folder: / @symbol: · 用 📎 添加文件、拖进来或粘贴（Enter 发送 · Shift+Enter 换行）'
            }
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
          />
          {/*
            Cursor-style send control: one button.
            空闲 → ↑ 发送；运行中 → ■ 点击打断。输入非空时按钮高亮。
          */}
          {isLoading ? (
            <button
              className={`${styles.sendBtn} ${styles.sendBtnStop}`}
              onClick={onStop}
              title={t('打断当前执行（已收到的内容保留）')}
              aria-label={t('停止')}
            ><IconStop size={16} /></button>
          ) : (
            <button
              className={`${styles.sendBtn} ${attachBusy || (!input.trim() && attachments.length === 0) ? styles.sendBtnDisabled : ''}`}
              onClick={handleSend}
              disabled={attachBusy || (!input.trim() && attachments.length === 0)}
              title={attachBusy ? t('附件上传中…') : t('发送（Enter）')}
              aria-label={t('发送')}
            ><IconSend size={17} /></button>
          )}
          </div>
        </div>

        <div className={styles.modeSwitchRow}>
          <div className={styles.modeSwitch}>
            {/* Generated from the shared profile list; the button's data-profile
                drives its per-profile colour (see Chat.module.css). */}
            {SKILL_PROFILES.map((p) => (
              <button
                key={p.id}
                type="button"
                data-profile={p.id}
                className={`${styles.modeBtn} ${skillProfile === p.id ? styles.modeBtnActive : ''}`}
                onClick={() => onSkillProfile?.(p.id)}
                title={p.title}
              >{p.label}</button>
            ))}
          </div>

          <div className={styles.thinkSlider} title={t('推理深度：越高越慢但越稳')}>
            <span className={styles.thinkLabel}>{t('推理')}</span>
            <div className={styles.thinkTrackWrap}>
              <input
                type="range"
                className={styles.thinkRange}
                min={0}
                max={THINK_LEVELS.length - 1}
                // Continuous value with snapping on commit: a discrete `step`
                // makes the native control feel notchy, which is exactly what
                // "smooth" is asking for the opposite of.
                step={0.01}
                value={thinkRaw}
                onChange={(e) => {
                  // Dragging reports fractional values. Committing each one
                  // saved settings and rebuilt agents, which killed the turn
                  // and left the composer looking stuck until the thumb moved.
                  setThinkRaw(Number(e.target.value));
                }}
                onPointerUp={(e) => {
                  const raw = Number((e.target as HTMLInputElement).value);
                  const idx = Math.round(raw);
                  const lv = THINK_LEVELS[idx];
                  setThinkRaw(idx);
                  if (lv && lv.id !== thinkingLevel) onThinkingLevel?.(lv.id);
                  (e.target as HTMLInputElement).blur();
                }}
                onKeyUp={(e) => {
                  if (!e.key.startsWith('Arrow')) return;
                  const raw = Number((e.target as HTMLInputElement).value);
                  const idx = Math.round(raw);
                  const lv = THINK_LEVELS[idx];
                  setThinkRaw(idx);
                  if (lv && lv.id !== thinkingLevel) onThinkingLevel?.(lv.id);
                }}
                aria-label={t('推理深度')}
              />
              <div className={styles.thinkTicks}>
                {THINK_LEVELS.map((lv, i) => (
                  <button
                    key={lv.id}
                    type="button"
                    className={`${styles.thinkTick} ${thinkingLevel === lv.id ? styles.thinkTickActive : ''}`}
                    style={{ left: `${(i / (THINK_LEVELS.length - 1)) * 100}%` }}
                    onClick={() => { setThinkRaw(i); onThinkingLevel?.(lv.id); }}
                    title={lv.title}
                    aria-label={lv.title}
                  />
                ))}
              </div>
            </div>
            <span className={`${styles.thinkValue} ${thinkingLevel === 'high' ? styles.thinkValueHigh : ''}`}>
              {THINK_LEVELS.find((lv) => lv.id === thinkingLevel)?.short ?? '中'}
            </span>
          </div>
        </div>

        {/* Chat-scoped actions: import context, plan and timeline all belong to
            THIS conversation, so they sit under the composer rather than in the
            global status bar. */}
        <div className={styles.chatActions}>
          {onImportContext ? (
            <button type="button" className="she-btn she-btn--chip" onClick={onImportContext} title={t('把 Cursor / Claude Code / Codex 的对话上下文搬进本对话')}>
              导入对话
            </button>
          ) : null}
          {onOpenPlans ? (
            <button type="button" className="she-btn she-btn--chip" onClick={onOpenPlans} title={t('本对话的长程计划')}>
              计划
            </button>
          ) : null}
          {onOpenTimeline ? (
            <button type="button" className="she-btn she-btn--chip" onClick={onOpenTimeline} title={t('本对话的检查点时间线')}>
              时间线
            </button>
          ) : null}
          {onOpenSkills ? (
            <button
              type="button"
              className="she-btn she-btn--chip"
              onClick={onOpenSkills}
              title={t('打开技能库：新建 / 编辑 / 删除自定义技能（写入 .she/skills/custom/）')}
              >
                技能库
              </button>
            ) : null}
            {onOpenSchedule ? (
              <button
                type="button"
                className="she-btn she-btn--chip"
                onClick={onOpenSchedule}
                title={t('定时任务：让助手在指定时间自动干活，并设置允许工作的时间段')}
              >
                定时任务
              </button>
            ) : null}
            {onOpenCache ? (
              <button
                type="button"
                className="she-btn she-btn--chip"
                onClick={onOpenCache}
                title={t('缓存管理：填写 token 单价，按成本分配压缩策略（含提示缓存命中情况）')}
              >
                {t('缓存管理')}
              </button>
            ) : null}
          <span className={styles.inputHintInline}>{t('Enter 发送 · Shift+Enter 换行 · Tab 选中 @ 联想')}</span>
        </div>
      </div>
    </div>
  );
}
