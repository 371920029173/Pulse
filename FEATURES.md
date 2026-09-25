# SHE — mature agent capability checklist

Target: day-to-day parity with mature coding agents (Cursor-class), plus PulseSeed KB.
Desktop window: **done** — Electron shell in `@she/desktop`, launched by `pnpm desktop` (or the
`SHE.bat` / `she.sh` launcher, which starts the backend first).

## Core (must-have)
| Feature | Status | Notes |
|---|---|---|
| Streaming chat | done | SSE `/api/chat` |
| Tool loop (read/write/shell/grep/…) | done | sandbox + confirm tickets |
| Dangerous-op confirm | done | UI Confirm/Cancel; the ticket is never shown to the model |
| Stop generation | done | abort server-side, for every turn type |
| Multi-session sidebar | done | persisted in .she/sessions.json; create/switch/delete |
| Settings UI (key/model/workspace) | done | sidebar Settings |
| Workspace file tree | done | `/api/fs/tree` + `/api/fs/read` + sidebar Files |
| Apply / diff edits | done | DiffPanel + `/api/fs/apply|reject` (path re-validated at apply) |
| Inline terminal panel | done | bottom panel + /api/terminal/exec + confirm tickets |
| Checkpoints / undo | done | 时间线面板 + StatusBar Undo + /api/fs/undo |
| KB browse + PulseSeed trace | done | |
| Structural KB retrieve (no RAG) | done | |
| Doctor / health | done | CLI + `/api/health` |
| Append-only audit trail | done | `.she/audit.log` + `GET /api/audit` + read-only panel (Ctrl+K → 打开审计记录) |
| Run traces (per-turn steps) | done | `.she/runs/*.jsonl` + `GET /api/runs[/:id]` + read-only panel (Ctrl+K → 打开运行轨迹); evidence checked against real runs |

## Packaging
| Deliverable | Status |
|---|---|
| Portable zip | done | `pnpm release` → `release/`; `pnpm release:verify` installs and boots it |
| Cross-platform launcher | done | `SHE.bat` / `she.sh` → `scripts/she.mjs` (the old `.cmd` scripts are gone) |
| Electron desktop window | done | `@she/desktop`; multi-window, native title bar, task-aware shutdown |
| Container image | structural check only | `Dockerfile` + `check:docker`; not built (no docker here) |

## UI flexibility
- Resizable sidebar / PulseSeed trace panes (drag handles; widths persist per WINDOW, so a second
  window does not inherit the first's layout)
- Light + dark themes (`data-theme`, StatusBar / Ctrl+K)
- **User stylesheet** — `~/.she-app/theme.css`, editable by hand or from Settings; validated before
  save, scoped preview, and two escape hatches that work when the UI is invisible
- Settings toggle **允许所有命令** → `sandbox.allowAllCommands` (skips confirm tickets + destructive
  deny; persists `SHE_ALLOW_ALL_COMMANDS`). An explicit value in the same request wins, in both
  directions.

## Capability notes
- AGI-3.5-v2 is **not** an LLM — it is a scaffolding project. The adapter that once read
  its directory was removed: it was never wired into anything, and it carried a hardcoded
  absolute path from the author's machine.

| Symbol outline / `@symbol:` | done | `/api/fs/outline` + `/api/fs/symbols`; Chat `@symbol:`; sidebar FileOutline (TS/JS AST, not RAG) |
