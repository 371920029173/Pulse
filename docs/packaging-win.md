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
