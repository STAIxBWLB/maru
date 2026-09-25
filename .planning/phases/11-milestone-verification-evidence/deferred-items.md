# Deferred Items - Phase 11

Out-of-scope discoveries logged during execution, per the scope-boundary rule
(only auto-fix issues directly caused by the current task's changes).

## 11-01: pre-existing `pnpm typecheck` errors in `src/components/graph/GraphCanvas.tsx`

- **Found during:** Task 2 (`pnpm typecheck` acceptance check) and confirmed again ahead of
  Task 3's `make verify`.
- **Symptom:** `tsc -b` reports six `TS7006: Parameter '...' implicitly has an 'any' type`
  errors at `GraphCanvas.tsx:311` (`forEachEdge` callback params `key`, `attrs`, `source`,
  `target`) and `:328` (`forEachNode` callback params `key`, `attrs`).
- **Confirmed unrelated to this plan:** reproduces identically with this plan's Makefile and
  `scripts/coverage-summary.mjs` changes stashed (only the already-committed
  `@vitest/coverage-v8` pin + RED test present); `pnpm-lock.yaml`'s diff for this plan is scoped
  to `@vitest/coverage-v8` and its own transitive deps (babel/istanbul/ast-v8-to-istanbul), no
  `graphology`/`sigma`/`@types/*` version changed. `GraphCanvas.tsx` was last touched in
  `2efa90df` (2026-09-24, PR #330), a day before this phase's base commit; this plan's
  `files_modified` list does not include it and TEST-02's scope is coverage tooling only.
- **Not fixed:** out of scope per the scope-boundary rule (file not touched by this plan, not a
  TEST-02 concern).
- **Status:** Open. Recommend a follow-up phase/issue to type the `graphology` `forEachEdge`/
  `forEachNode` callback params on `GraphCanvas.tsx:311,328`.
