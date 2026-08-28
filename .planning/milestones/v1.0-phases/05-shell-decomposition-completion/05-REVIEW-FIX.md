---
phase: 05-shell-decomposition-completion
fixed_at: 2026-08-27T07:37:40+09:00
review_path: .planning/phases/05-shell-decomposition-completion/05-REVIEW.md
iteration: 2
findings_in_scope: 2
fixed: 2
skipped: 0
status: all_fixed
---

# Phase 05: Code Review Fix Report

**Fixed at:** 2026-08-27T07:37:40+09:00
**Source review:** `.planning/phases/05-shell-decomposition-completion/05-REVIEW.md`
**Iteration:** 2

**Summary:**

- Findings in scope: 2
- Fixed: 2
- Skipped: 0

## Fixed Issues

### WR-01: Graph watcher test bypasses the watcher event path

**Files modified:** `src/lib/modeAdapters/GraphModeAdapter.test.tsx`
**Commit:** `c7a8535`
**Applied fix:** The test now waits for the nested-vault listener registration, dispatches `vault://index-delta` through that registered callback, advances the real 150 ms debounce inside `act`, and verifies the nested path reaches `scanVaultPaths` and its delta reaches `GraphView`.

### WR-02: Workspace-removal test does not assert index or favorites cleanup

**Files modified:** `src/lib/documentBrowserStore.test.ts`
**Commit:** `cd4476b`
**Applied fix:** The cleanup fixture now publishes a non-empty document index and favorite, then asserts both return to the empty scope after workspace removal alongside selection and reveal cleanup.

## Verification

Per-finding focused tests and lint ran in the isolated worktree. After its commits were fast-forwarded and the worktree removed, the following gates ran in the main checkout:

- Focused tests: 2 files passed, 4 tests passed.
- ESLint for both changed test files: passed.
- `pnpm typecheck`: passed.

---

_Fixed: 2026-08-27T07:37:40+09:00_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 2_
