# Windows packaging (electron-builder)

## What you get
- `release/desktop/Pulse-*-win-x64.exe` — NSIS installer (choose folder, Start Menu + Desktop shortcut)
- `release/desktop/Pulse-Portable-*.exe` — single-file portable

## Brand
Product name / icon: **Pulse** (blue `b` mark). Native Windows title bar (`frame: true`).

## Build
```bat
pnpm build
pnpm --filter @she/desktop dist:win
```

Or from repo root: `pnpm pack:win`

## Honest limits (not full S+ yet)
The installer ships the Electron shell + built UI/server bundles as resources.
Code signing and auto-update are not wired yet — those are the remaining S+ packaging rungs.
Native modules (better-sqlite3) still need a matching Node ABI on first run paths that spawn outside the asar; verify on a clean machine after the first installer lands.

## What actually goes into the runtime

The runtime is `pnpm deploy`-ed from `packages/server`, so **whatever sits in that directory at
build time is what ships**. `pnpm deploy` does not honour `.gitignore`, and an earlier build proved
the cost: the author's `.she/` (knowledge base, session list), a `.playwright-mcp/` page snapshot,
the TypeScript sources, and a `packages/` tree that a previous run had nested into itself were all
inside the installer. Nothing read any of it — the launcher points `SHE_WORKSPACE` at the user's own
folder — so it was silent in both directions: extra weight in every artifact, and someone else's
data distributed with it.

Two things keep it out, and both are needed:

- `files: ["dist"]` in `packages/server/package.json` — the fix. Declares the file set instead of
  relying on remembering to clean up before a build.
- an assertion at the end of `scripts/stage-desktop-runtime.mjs` — the ratchet. It fails the build
  (not a warning, which is read after the installer has been published) naming what got in, so a
  future stray directory cannot ride along unnoticed. Verified both ways: with the field planted
  state is excluded, without it the staging stops.

One side effect is worth knowing rather than fixing: `pnpm deploy` writes a partial copy of its
output into a `packages` subdirectory inside the server package whenever the target directory is
inside another workspace package (`packages/desktop/runtime`), because it resolves the output path
against the deployed package. It is untracked, ~27 files, bounded, and now excluded from the
artifact — but do not be surprised to see it reappear after a staging run. (It is deliberately not
listed here as a path: it does not exist on a clean checkout, so naming it makes the docs gate
report a dangling reference in CI while passing locally, where a previous staging run left it
behind.)

