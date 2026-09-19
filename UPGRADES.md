# SHE — upgrade / add-on ideas

Based on mature coding agents (Cursor / Continue / Aider / Cody class) and what SHE already has.

## Already solid
Streaming chat, tools + confirm tickets, Apply/diff, file tree, sessions, settings, terminal, PulseSeed KB, **Electron desktop window**, **local model presets**, **`.she/rules.md` project rules**, **tray/hotkey**, **session Markdown export**.

## High value next (product)
1. **Desktop window** — done (`pnpm desktop`).
2. **Composer / multi-file edit** — plan → stage multiple patches → batch Apply.
3. **@-mentions richer** — done for `@file` / `@folder` path pickers + server expand (`/api/fs/suggest`); `@symbol` done (heuristic outline; real TS/JS via TypeScript AST (tree-sitter-class); other langs heuristic).
4. **Rules / project memory** — done for `.she/rules.md`; next: preference nodes in KB.
5. **Checkpoints / undo** — done (timeline panel + .she/checkpoints.json + /api/fs/undo).
6. **Background agents** — long tasks with progress cards (one chat can spawn a job).
7. **Image / paste** — screenshot into chat for UI bugs (vision models).
8. **MCP connectors** — optional tool plugins without bloating core.
9. **Local model path** — done (Ollama / LM Studio / OpenRouter presets in Settings).
10. **Indexed code outline** — done via `/api/fs/symbols` heuristics (TS/JS via TypeScript AST (tree-sitter-class); other langs heuristic; still not embedding RAG).
11. **Global hotkey / tray** — done (tray + Ctrl+Shift+S).
12. **Export transcript** — done (`GET /api/sessions/:id/export` + sidebar ↓).

## Packaging track
- Electron window (done)
- Portable zip of desktop + baked UI (wait for confirm)
- Optional NSIS installer later (wait for confirm)

## Out of scope / careful
- Full AGI pulse kernel (belongs to she-v2 research)
- Embedding RAG fallback (hard rule: structural PulseSeed only)


- Multi-file Composer: pending patch stack + apply-all/reject-all + ComposerPanel
