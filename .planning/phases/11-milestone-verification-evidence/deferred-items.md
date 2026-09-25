# Deferred Items - Phase 11

Out-of-scope discoveries logged during execution.

## `pnpm typecheck` fails inside fresh agent worktrees (environment, not a code regression)

- **Found during:** 11-01 Task 2 and 11-04 Task 1, both running `pnpm typecheck` / `make verify` inside
  freshly installed agent worktrees under `.claude/worktrees/`.
- **Symptom:** `tsc -b` reports six `TS7006: Parameter '...' implicitly has an 'any' type` errors at
  `src/components/graph/GraphCanvas.tsx:311` (`forEachEdge` callback) and `:328` (`forEachNode` callback).
- **Not a regression in the code:** the same commit (`9446eb0a`) passes `pnpm typecheck` (exit 0) in the
  main checkout, and CI `make verify` is green on `main` (run for `12a65187`). The executors' first reading,
  "pre-existing implicit-any errors", was wrong and is corrected here.
- **Cause:** the fresh worktree install links `graphology` and `graphology-types` through pnpm's global
  virtual store (`~/.local/share/pnpm/virtual-store/...`), while the main checkout links them through the
  local `node_modules/.pnpm` store. The versions are identical (`graphology@0.26.0`,
  `graphology-types@0.24.8`); only the link layout differs, and under the global-store layout TypeScript
  loses the callback parameter inference.
- **Impact on this phase:** none on the delivered artifacts. Every phase-owned check was verified
  separately (see 11-01-SUMMARY.md and 11-04-SUMMARY.md), and the phase gate `make verify` runs in the
  main checkout.
- **Possible hardening (not scheduled):** annotate the two callback signatures in `GraphCanvas.tsx`
  explicitly so type checking does not depend on the install layout, or pin the pnpm virtual-store mode
  for agent worktrees.
