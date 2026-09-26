# Pulse (SHE v2)

**A local coding agent with a group-structure knowledge base and structural-resonance retrieval —
not vector RAG.** Runs on your machine, talks to any OpenAI-compatible endpoint or Anthropic, and
sends nothing anywhere else.

> 本地编程智能体：组结构记忆 + 脉冲种子结构共振检索（不是向量 RAG）。全本地运行，只与你配置的
> 模型接口通信。

---

## 本次更新：修复了一些已知问题并进行大幅升级与优化

**Reliability**
- `lsp_diagnostics` no longer hangs for 15 s on a file that was already opened for go-to-definition
  (the diagnostics pushed on open were cached under the wrong content). That hang used to trip the
  stuck-loop guard and end a whole turn.
- Go-to-definition and friends no longer land one column off on files that start with a UTF-8 BOM.
- `reflection_check` stops flagging provenance notes ("来源：…", "see: …") as forbidden targets, and
  its budget check now compares tool calls with tool calls (8 per active plan step). Drift detection
  also counts an action as on track when it matches the current plan step, and bookkeeping calls
  (plans, reflection, error book, memos) no longer count as drifting.
- `grep` globs are real globs: `*`, `**`, `?`, `[abc]`, `{ts,tsx}`. `*.json*` used to match nothing, silently.

**Automation**
- Plans now drive the agent: while a plan has unfinished steps it keeps going on its own, and stops
  when a step needs the user, when it asks a question, or after two rounds without progress
  (`SHE_PLAN_AUTOPILOT=0` turns this off).
- A scheduled task that fires while its conversation is busy is queued and runs as soon as the turn
  ends, instead of failing in 8 ms and — for a one-shot task — disabling itself.
- "Run now" on a one-shot task no longer consumes its real scheduled fire. Finished one-shot tasks
  are pruned after 7 days and hidden from `schedule_list` by default.

**Interface and knowledge**
- Markdown in chat renders tables (with alignment, horizontal scroll for wide ones), numbered lists,
  block quotes, rules and all heading levels. Tables used to collapse into one line of pipes.
- Leaving a chat mid-turn and coming back re-attaches to the live stream, so reasoning keeps
  streaming instead of appearing all at once when the step ends.
- Several workspaces can share one knowledge base (Settings, then the shared-KB section), and two
  knowledge bases can be merged.
- Importing from Cursor, Claude and Codex keeps a copy of the original context under `.she/imports/`.
- Error book: a call made to fail on purpose can pass `"expect_failure": true` and stays out of the
  book; the list header shows the real total ("显示 5 / 共 6"); entries blocked by policy say what to
  do for that specific reason.
- Knowledge base entries can be edited and retired, and upserting an existing title no longer creates
  a silent duplicate, so an outdated conclusion stops showing up in search. For now this is available
  through the agent tools and the API only; the interface has no buttons for it yet.
- Writing into an auto-split `part-N` group goes to its parent group instead, and a split group that
  fills up again gets a sibling `part` rather than another nested level. Group paths no longer repeat.
- Shorter tool results for new calls: `plan_update` returns only the changed step, progress and the
  next step (`plan_get` shows the whole plan), and `kb_query` lists the top 5 with short summaries
  (`kb_get` fetches the full text by id). History is never rewritten, so the prompt cache keeps hitting.

**Housekeeping**
- Default skills now live in a version-controlled `skills/` folder. `.she/` is gitignored, so a fresh
  clone previously had no skills at all.
- Stale `4577` port defaults (inside a Windows excluded port range) were changed to `5577`, and
  `env_check` no longer tells you to copy `.env.example` when your environment is already set.

## Download

**[Latest release →](https://github.com/371920029173/Pulse/releases/latest)**

| File | What it is |
|---|---|
| `Pulse-<ver>-win-x64.exe` | Windows installer — Start Menu entry, clean uninstall |
| `Pulse-Portable-<ver>.exe` | Windows, no installation — run it from anywhere |

> **The installer is not code-signed, so Windows will warn you.** In the SmartScreen dialog click
> **More info** → **Run anyway**. Windows 11 is stricter about this than Windows 10, and the browser
> may also ask you to "Keep" the download. SHA256 checksums are in the release notes.

Node.js is **not** required for the packaged build — the runtime bundles its own.

## Platform status

| Platform | Status |
|---|---|
| Windows 10 | Developed and run on it daily |
| Linux | **Verified** — CI runs the full offline gate on `ubuntu-latest` |
| Windows 11 | Expected to work, **never run.** No version-specific code, and the font stacks prefer Win11's own fonts before falling back to bundled ones |
| macOS | **Never run.** Portable code and a static audit only |

## Quick start

**From the release:** install, launch, pick a workspace folder (that folder is the sandbox boundary
— pick a project, not your whole disk), then paste an API key in Settings.

**From source:**

```bash
git clone https://github.com/371920029173/Pulse && cd Pulse
pnpm install && pnpm build
cp .env.example .env        # then edit .env
pnpm dev                    # opens at http://127.0.0.1:5577
```

Or use the one-click launcher, which checks prerequisites, builds only when artefacts are stale,
starts the backend, waits until it actually answers, then opens the window:

```bash
SHE.bat              # Windows: start (desktop window, falls back to the browser)
SHE-stop.bat         # Windows: stop
./she.sh             # macOS / Linux: start, stop, restart, status, --browser
```

Requires Node.js ≥ 20, pnpm, and Git.

**CLI**, for scripted use — the same engine without the interface:

```bash
pnpm she chat                 # interactive chat with the agent
pnpm she kb ingest <path>     # ingest files into the group KB
pnpm she kb query <text>      # query with an activation trace
pnpm she kb stats             # KB statistics
pnpm she doctor               # check system health
pnpm she server               # start the API server for the web UI
```

## Configure

```env
SHE_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
OPENAI_BASE_URL=https://api.deepseek.com    # any OpenAI-compatible endpoint
OPENAI_MODEL=deepseek-chat
```

`.env` holds secrets; `she.config.yaml` holds structured settings (model registry, KB, sandbox,
working windows). Both are optional — every value has a default. `SHE_CONFIG_FILE` relocates the
config, and multiple models can be registered so you are not locked to one vendor.

> **Permissions:** by default the agent asks before running dangerous commands.
> `SHE_ALLOW_ALL_COMMANDS=true` lifts that entirely — read `.env.example` before enabling it.
> The local API has **no authentication**, so binding address is the security boundary; see
> [Deployment](#deployment) before exposing it beyond this machine.

## What it does

- **Agent loop** — tool calling with streaming reasoning, runaway-loop detection, self-verification
  before reporting success
- **Tools** — files, shell, grep, git, knowledge base, plans, memos, reports, `ask_user`, subagents,
  language-server code intelligence, scheduled tasks, computer use (Windows, opt-in)
- **Knowledge base** — group-structure memory with activation traces; every result explains *which
  groups and edges* produced it
- **Sandbox** — workspace jail including symlinks, destructive-command patterns, an optional
  fail-closed command allowlist, and one-shot confirmation tickets bound to their arguments
- **Sessions** — isolated conversations, history, closed-vs-deleted, checkpoint undo, message rewind,
  and state files that quarantine instead of clearing when unreadable
- **Multi-agent** — discussion rooms with configurable roles per room
- **Skills** — Markdown playbooks under `skills/` (`_common`, `dev`, `liberal`, `general`, `custom`),
  picked by the active profile. A file with the same name in a workspace's `.she/skills/` overrides
  the bundled one
- **Integrations** — MCP servers, plugins (install from a catalog, scaffold, edit source), Feishu
  remote control over a long connection (no exposed port)
- **Interface** — Electron desktop (multi-window) and web; syntax highlighting, diffs, collapsible
  reasoning, Chinese/English UI, and a user stylesheet
- **Deployment** — cross-platform launcher, container image, configurable bind address and allowed hosts

## Deployment

The server listens on `127.0.0.1` by default. `SHE_HOST=0.0.0.0` accepts container or LAN traffic;
for a domain, list it in `SHE_ALLOWED_HOSTS` (the request guard rejects unknown `Host` headers,
which is what blocks DNS rebinding).

```bash
docker build -t pulse:0.3.0 .
docker run --rm -p 127.0.0.1:5577:5577 -v "$PWD/workspace:/workspace" \
  -e OPENAI_API_KEY=sk-... pulse:0.3.0
```

> **There is no authentication on this API.** It can run shell commands, read and write your
> workspace, and change its own settings — so publishing the port is equivalent to handing over the
> machine. `-p 127.0.0.1:5577:5577` (above) keeps it loopback-only. For LAN or phone access put it
> behind a reverse proxy with auth, and never expose it directly to the internet.

`GET /api/metrics` reports turns, latency (avg/p95), token breakdown, tool usage and failures, and
the prompt-cache hit rate. Watch the cache number: prompt caching is prefix-based, so a change that
rewrites the request prefix moves every later turn from ~97% cached to full price with no visible
symptom — see [docs/context-and-caching.md](docs/context-and-caching.md).

## Documentation

| Doc | Contents |
|---|---|
| [architecture.md](architecture.md) | Design and package layout |
| [docs/retrieval.md](docs/retrieval.md) | How structural-resonance retrieval works, and its measured limits |
| [docs/testing.md](docs/testing.md) | Test inventory, the checks that gate a change, and how to run them |
| [docs/custom-stylesheet.md](docs/custom-stylesheet.md) | Restyling the UI, and how a bad stylesheet is made recoverable |
| [docs/plugins.md](docs/plugins.md) | Writing a plugin: `ctx` API, permissions, debugging |
| [docs/feishu-remote.md](docs/feishu-remote.md) | Phone remote control in 5 minutes |
| [docs/packaging-win.md](docs/packaging-win.md) | Building the Windows installer |
| [SECURITY.md](SECURITY.md) | Threat model and the guards that implement it |
| [AGENTS.md](AGENTS.md) | Conventions and traps for anyone (human or agent) changing this repo |
| [CHANGELOG.md](CHANGELOG.md) | What changed, with the reasoning |

Most docs are written in Chinese; the code and comments are English.

## Project status

`pnpm check:all` runs the build, the unit tests of every package, three evaluators and the check scripts, and must pass
before a change is considered done. It is green locally and on Linux CI. See
[docs/testing.md](docs/testing.md) for the per-check breakdown.

**Known gaps, stated plainly** — this project tries to be honest about what is not proven:

| Gap | What that means |
|---|---|
| **Windows 11 and macOS never run** | Expected to work; only Windows 10 and Linux have actually been exercised |
| **Container image never built** | The structure is checked statically; `docker build` has not been run |
| **Retrieval is only compared against BM25** | The configured provider has no `/embeddings` endpoint, so "better than vector search" is **not** a claim this can make |
| **Small evaluation sets** | 16 retrieval cases, 10 agent tasks, 5 verification tasks, one model |
| **Accessibility is only statically checked** | Focusability, keyboard dismissal and button names are verified; contrast, screen readers and tab order are not |
| **UI localization is incomplete** | 631 user-facing strings are still hardcoded Chinese; the infrastructure and a no-regression ratchet are in place |
| **Long-horizon evals are still small** | Long tasks and run-to-run variance are now measured, but on few cases and one model |
| **Token cost is still high on long turns** | History is sent whole and append-only so the prompt cache keeps hitting (~90% on DeepSeek). New `plan_update` and `kb_query` results are shorter, but past context is never trimmed |

Deliberately **not** planned: embeddings/vector search (a design choice, not a backlog item), and
being a general-purpose IDE.

## Feedback

Issues and Discussions are open — reports of crashes, odd imports, or "this was confusing" are all
useful, especially from platforms other than Windows 10.

Sponsor the maintainer (once Sponsors is enabled): https://github.com/sponsors/371920029173

---

Apache-2.0 — see [LICENSE](LICENSE)
