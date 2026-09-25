# Working in this repository

Operational notes for an agent (or a person) making changes here. `CONTRIBUTING.md` covers
the setup; this file covers the things that are easy to get wrong.

## Verify with one command

```bash
pnpm check:offline   # everything that needs no API key — this is what CI runs
pnpm check:all       # the above, plus the model-backed self-verification evaluation
```

`check:offline` chains the build, the unit suites, the offline retrieval evaluation, and every
`check:*` covering security, shell quoting, host binding, the turn lock, custom stylesheets, UI
structure, API wiring, the built bundle, log rotation, a real restart cycle, UTF-8 round-trips,
accessibility, portability, metrics, scheduling, LSP, i18n coverage, control styling, and the
container structure. `check:all` adds `eval:verify`, which calls a model and therefore needs a key.

Deliberately not counted: the step count changed four times while this file was being written, and a
number that must be edited on every unrelated change tells a reader nothing that "runs everything"
does not. Say what runs; do not count it. (`check:docs` still fails on a stale count if someone
writes one, so the number cannot rot quietly.)

`check:offline` exists as a named target rather than a hand-picked list in the workflow, because the
workflow used to run three checks out of twenty-one and the other eighteen had never executed on
Linux. One shared definition means CI and a local run cannot diverge.

Helper scripts used by the gate (not separate pnpm check:* aliases):

- `scripts/safe-port.mjs` — pick a Windows-safe listen port.
- `scripts/stage-desktop-runtime.mjs` — stage the packaged desktop runtime before electron-builder.
  It uses `pnpm deploy --node-linker=hoisted`, and **that flag is load-bearing.** pnpm's default
  virtual store keeps a package's dependencies as SIBLINGS of it, reached through symlinks; resolving
  those into plain directories (which the previous version did, with a Python `copytree`) leaves the
  dependencies unreachable and the packaged app dies at startup with `ERR_MODULE_NOT_FOUND`. It was
  latent for as long as no workspace package had a runtime dependency of its own.
- `scripts/packaged-smoke.mjs` — boots the packaged server and probes it. Runs as `check:packaged`,
  which `pnpm pack:win` chains, so an installer that cannot start fails the build instead of reaching
  a user. `SHE_RUNTIME=staged` points it at `packages/desktop/runtime` to test the staging step
  without paying for a full electron-builder run.

Individual pieces, when you want a faster loop:

```bash
pnpm -r test                 # unit tests only, seconds
pnpm check:shell             # shell quoting + command allowlist
pnpm check:ui                # control styling: fills, hover, heights, dead CSS
pnpm check:theme             # custom stylesheet: brick refusal, escape hatch, revert
pnpm check:uistruct          # UI structure: root-level state, overlays in both branches
pnpm check:api               # every endpoint the UI calls is actually routed
pnpm check:plugins           # plugin end to end: install, agent can call it, uninstall takes effect
pnpm check:preflight         # pre-flight intent analysis: missing refs, no scheduler, confidence ceiling
pnpm check:toolresult        # tool failures are classified, and every Error: message has a remedy
pnpm check:dist              # the built bundle contains the wiring the browser needs
pnpm check:logs              # logs are capped and crash.log is only for crashes
pnpm check:restart           # hard-kill + reboot: settings, sessions, groups, schedules all survive
pnpm check:encoding          # non-ASCII survives the round trip (API, disk, restart)

node scripts/vendor-fonts.mjs --force   # re-fetch the vendored webfonts (needs network; rarely needed)
pnpm check:i18n              # localisation ratchet
pnpm check:docs              # docs match the code (paths, counts, no markers)
node scripts/security-check.mjs   # boots its own server; needs no setup
node scripts/disk-probe.mjs 15    # who is reading the disk (Windows; samples 15s)
```

Only `eval:agent` and `eval:verify` spend money (they call a model, ~200k tokens per full
run). Everything else is offline and free — run it as often as you like. `--only <task>`
limits an evaluator to one task.

## Comments explain WHY

The strongest convention here, and the one most worth preserving. A comment should say
what was tried and why the obvious alternative is wrong:

```ts
/*
 * `shell: true` rather than spawning cmd.exe directly: Node escapes arguments when
 * building the Windows command line and cmd.exe re-parses it, so quotes did not survive
 * — `node -p "1+1"` printed `1+1`. Fixed by letting Node build the command line.
 */
```

A comment restating what the code does is noise. A comment recording a trap that cost an
hour is worth more than the code it sits above. When you fix a bug, leave behind the
evidence that makes it hard to reintroduce.

## No TODO / FIXME

This repository is at zero and should stay there. If work is incomplete, say so in the
response or in a doc — a marker in the code tells the next reader nothing about whether it
still matters.

## Known traps

**PowerShell 5.1 reads a `.ps1` as ANSI without a UTF-8 BOM.** Non-ASCII text becomes
mojibake and breaks the script's *syntax*, not just its output. This has cost time three
times. Either write `.ps1` files as pure ASCII, or write them with a BOM — never rely on
plain UTF-8.

**State files must never be silently replaced.** Anything under `.she/` goes through
`state-file.ts`, which quarantines an unreadable file and reports why. The rule is that a
file we cannot use is *moved aside*, never overwritten: an earlier build treated any parse
failure as "no data" and saved that over the user's conversations.

**Two command controls, two different guarantees.** `DESTRUCTIVE_PATTERNS` is a denylist
(fail-open — it only blocks forms someone thought of). `allowedCommands` is a denylist's
opposite: fail-closed, refusing everything not named, checking *every* command in a line
so `ls && rm -rf /` cannot slip through. When touching the sandbox, keep both properties:
the denylist stays permissive, the allowlist stays strict.

**Platform branches are load-bearing.** Process termination, shell invocation, temp paths
and the file jail all differ per platform. `pnpm check:portability` audits for a
platform-specific call added without a branch for the other side.

**Two ratchets will fail your build on purpose.** `check:i18n` fails when the count of
hardcoded Chinese strings rises (the key *is* the Chinese source text, so a missing
translation degrades to Chinese rather than a raw key). `check:ui` fails when dead CSS
grows or a control loses its `:hover`. Lowering either number is progress; raising it needs
a reason.

**Watch the prompt-cache hit rate.** `/api/metrics` reports it. Prompt caching is
prefix-based, so anything that changes the *start* of the request (re-ordering tools,
regenerating a summary each turn) moves every subsequent turn to full price with no
visible symptom. See `docs/context-and-caching.md` for the measurements.

## Where things live

| Area | Path |
|---|---|
| Agent loop, tools, prompt | `packages/agent-runtime/src` |
| HTTP API, sessions, scheduler, plugins | `packages/server/src` |
| Filesystem jail, shell, confirm tickets, computer use | `packages/sandbox/src` |
| Knowledge base (structure + retrieval) | `packages/kb/src` |
| Config, types, model registry, env handling | `packages/shared/src` |
| React UI | `packages/ui/src` |
| Electron shell | `packages/desktop` |
| Evaluators | `evals/` |
| Regression check scripts | `scripts/` |

## Adding a check

Every check script follows the same shape, and it is worth copying rather than inventing:

1. **Start what you need.** Do not assume a running server or a built artefact — nine of the
   check scripts boot their own server on a throwaway workspace. A check whose
   result depends on ambient state passes or fails for reasons unrelated to the code. Pin
   the settings you depend on (`SHE_PORT`, `SHE_WORKSPACE`, `SHE_APP_DIR`) in the CHILD
   ENVIRONMENT rather than only in the `.env` you write: ambient variables win over `.env`,
   so a developer who has exported `SHE_PORT` would otherwise make your check probe their
   own running server instead of the code under test.
2. **Print `PASS`/`FAIL` per assertion** with the actual value, so a failure is
   diagnosable without re-running.
3. **Exit non-zero on failure**, and wire it into `check:all` in `package.json`.
4. **Negative-test it once.** Deliberately introduce the failure it exists to catch and
   confirm it fires. Two of the checks in this repository were themselves broken when
   first written — one missed single-line JSX, another counted classes assembled at
   runtime — and only a deliberate failure revealed it.
5. **No fixed sleeps for synchronisation.** Poll the condition you actually need. A fixed
   delay encodes an assumption about machine speed, and that assumption is what fails
   under load.
6. **Assert on the artefact the user runs, not only on the source.** This one cost a full
   feature. A bulk edit wrote a literal `\n` instead of a newline, merging two comment lines
   — and the merged line began with `//`, so the assignment below it was swallowed into the
   comment. The element was created, never given any CSS, and every saved stylesheet did
   nothing. Every unit test passed, because they all read source; the browser runs a
   bundle. `check:dist` now greps the built bundle for the wiring that has no server-side
   test, and fails if it is missing or older than the newest source file.
   (The count is deliberately not quoted here: it changes with the suite, and a stale number
   in prose is worse than none. `check:docs` validates the totals that *are* quoted.)
7. **Strip comments before matching text.** `check:dist` first flagged the Google Fonts link
   it was written to prevent — because `index.html` *explains* that link in a comment. A
   check that fails on the prose describing the rule is a check someone deletes.

## Testing a model-facing change

Changes to the agent loop, tool definitions, or the system prompt need `pnpm eval:agent`
on top of the unit tests — the unit tests use stub providers and cannot see whether the
model still understands its instructions. Compare token usage before and after: the prompt
and tool schemas are re-sent every round, so that is where the cost lives.
