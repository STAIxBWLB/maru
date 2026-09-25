# Deferred Items - Phase 11

Out-of-scope discoveries logged during plan execution, per the executor's Scope
Boundary rule (do not auto-fix issues unrelated to the current task).

## 11-04 (VALID-01 Nyquist reconciliation)

- **`src/components/graph/GraphCanvas.tsx` implicit-any regression (TS7006)**,
  discovered 2026-09-25 while running `make verify` / `pnpm typecheck` for
  Tasks 1-3. `graph.forEachEdge((key, attrs, source, target) => ...)` at line
  311 and `graph.forEachNode((key, attrs) => ...)` at line 328 no longer infer
  their callback parameter types from `graphology-types@0.24.8` /
  `sigma@3.0.3`, so `tsc -b` fails at the very first target of `make verify`.
  Confirmed pre-existing and unrelated to this plan: zero diff to
  `GraphCanvas.tsx` in this plan's commits, reproduced on a fresh
  `pnpm install --frozen-lockfile` worktree at HEAD `9446eb0a` (the plan's
  starting commit) before any task ran. `pnpm lint`, `cargo fmt --check`,
  `cargo clippy -- -D warnings`, and the full `cargo test --lib` (1800 passed)
  all ran clean independently. Not fixed here per D-10 scope (this plan may
  only touch the three VALIDATION.md files under `.planning/milestones/`) and
  per the Scope Boundary rule (unrelated file, not caused by this plan's
  changes). Tracked in `.planning/WINDOWS.md` (entry recording this deviation)
  and cited in `11-04-SUMMARY.md`.
  **Suggested fix:** annotate the callback parameters explicitly
  (`(key: string, attrs: SigmaEdgeAttributes, source: string, target: string)`
  and `(key: string, attrs: SigmaNodeAttributes)`) or add generic type
  arguments to `renderer.getGraph()`'s call site so `forEachEdge`/`forEachNode`
  infer correctly again.
