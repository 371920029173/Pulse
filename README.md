# Pulse (SHE v2)

**A local coding agent with a group-structure knowledge base and structural-resonance retrieval —
not vector RAG.** Runs on your machine, talks to any OpenAI-compatible endpoint or Anthropic, and
sends nothing anywhere else.

> 本地编程智能体：组结构记忆 + 脉冲种子结构共振检索（不是向量 RAG）。全本地运行，只与你配置的
> 模型接口通信。

---

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
docker build -t pulse:0.2.0 .
docker run --rm -p 127.0.0.1:5577:5577 -v "$PWD/workspace:/workspace" \
  -e OPENAI_API_KEY=sk-... pulse:0.2.0
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

`pnpm check:all` runs the build, 850 unit tests, three evaluators and 32 check scripts, and must pass
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
| **No before/after diff for direct writes** | Diffs exist for staged edits; a write that goes straight through shows only its content |
| **Long-horizon tasks (>10 rounds) uncovered** | So is variance across repeated eval runs |

Deliberately **not** planned: embeddings/vector search (a design choice, not a backlog item), and
being a general-purpose IDE.

## Feedback

Issues and Discussions are open — reports of crashes, odd imports, or "this was confusing" are all
useful, especially from platforms other than Windows 10.

Sponsor the maintainer (once Sponsors is enabled): https://github.com/sponsors/371920029173

---

Apache-2.0 — see [LICENSE](LICENSE)
