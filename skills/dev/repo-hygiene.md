# 开发档 · Repo hygiene

Use for refactors, build breaks, dependency bumps, or build failures.

## Checklist
1. Reproduce with the package script (pnpm build / test) in the right package.
2. Prefer root-cause in types/imports over shotgun edits.
3. After UI changes: hard refresh 4578.
4. After server/config/KB path changes: restart API process.
5. Do not commit secrets (.env, keys).
