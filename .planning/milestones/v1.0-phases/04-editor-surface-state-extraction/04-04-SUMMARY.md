---
phase: 04-editor-surface-state-extraction
plan: "04"
subsystem: ui
tags: [react, typescript, useSyncExternalStore, editor, persistence, lifecycle]
requires:
  - phase: 04-01
    provides: Activation-gated Editor facade contracts
  - phase: 04-03
    provides: Guarded settings persistence adapter and workspace cleanup pattern
provides:
  - Workspace, split-group, and tab keyed Editor facade state with stable render slices
  - Guarded atomic Editor view-mode hydration through existing Maru settings
  - Explicit Editor transient-state cleanup at tab, split-group, and workspace boundaries
affects: [04-05, 04-06, editor-surface-state-extraction]
tech-stack:
  added: []
  patterns:
    - Keyed module facade with useSyncExternalStore render-domain hooks
    - Canonical draft composition from editorTabsStore without facade dual writes
    - Existing-request-id guarded settings hydration
key-files:
  created:
    - src/lib/editorPaneStore.ts
  modified:
    - src/lib/editorSurfaceStore.test.ts
    - src/lib/editorSurfacePersistence.ts
    - src/App.tsx
key-decisions:
  - "Editor view mode is workspace and split-group scoped, while HTML mode, risk acknowledgement, and operation state remain tab-local transient facade state."
  - "The persistence adapter reuses App's loadWorkspaceRequestRef and normalized settings writer instead of owning another generation counter or settings key."
  - "App removes facade-local transient records only after canonical editorTabsStore close operations, preserving draft ownership."
actuals:
  tokens: 7855
  tasks: 2
  commits: 4
metrics:
  duration: 12min
  completed: 2026-08-26
status: complete
---

# Phase 04 Plan 04: Keyed Editor facade and guarded persistence Summary

**Editor pane state now composes canonical tabs and drafts with workspace, split-group, and tab isolation, while view-mode persistence remains generation-safe and transient state is explicitly cleaned.**

## Performance

- **Duration:** 12 min
- **Tasks:** 2/2
- **Files modified:** 4
- **Verification:** Focused Vitest, TypeScript, ESLint, and full `make verify` passed.

## Accomplishments

- Activated the Wave 0 Editor store contract, recorded red evidence for the missing facade and persistence APIs, then made the store cases green.
- Added `editorPaneStore` with explicit three-part scopes, stable document/tabs/view-preview/operation slices, per-domain subscriptions, pure no-op transitions, and exact cleanup helpers.
- Kept documents, tabs, and unsaved drafts in `editorTabsStore`; facade reads reflect canonical draft updates without a second write path.
- Extended the existing persistence adapter to atomically hydrate left/right view modes only when App's current workspace path and request id both match.
- Routed App view-mode changes and tab, right-split, and workspace lifecycle paths through the facade adapter without persisting HTML state, acknowledgements, or operation errors.

## Task Commits

1. **Task 1: Create the keyed Editor facade and prove render-domain/scope isolation**
   - `1813e93` test: activate the Editor facade store contract
   - `b0e19ac` feat: add keyed Editor facade store
2. **Task 2: Extend guarded persistence and App lifecycle wiring for Editor scopes**
   - `dd5c6c3` test: add Editor persistence lifecycle contract
   - `6df7306` feat: wire Editor facade persistence lifecycle

## Decisions Made

- Persist `editorPaneViewModes` by workspace and editor group only; per-tab HTML mode and acknowledgement remain transient.
- Treat `loadWorkspaceRequestRef` as the sole hydration generation source.
- Clean facade records after the canonical tab close operation so cleanup never deletes an unsaved draft itself.

## Verification

- Red first: activated store tests failed because `editorPaneStore` did not exist; persistence tests then failed because guarded Editor mode methods were absent.
- Passed `pnpm test -- src/lib/editorSurfaceStore.test.ts` with 192 test files passed, 1,875 tests passed, and 6 intentional future-migration cases skipped.
- Passed `pnpm typecheck` and scoped ESLint for all changed source and test files.
- Passed `make verify`, including full frontend tests, 1,219 Rust library tests, rustfmt, clippy, production frontend build, and bundle budget checks.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserve view-preview slice identity during operation updates**

- **Found during:** Task 2 focused contract run
- **Issue:** Introducing workspace/group mode ownership rebuilt an unchanged `viewPreview` slice when only an operation value changed.
- **Fix:** Cached the resolved group mode with the snapshot and retained the existing view-preview reference until that mode changes.
- **Files modified:** `src/lib/editorPaneStore.ts`
- **Verification:** The render-domain identity contract and full focused test run pass.
- **Committed in:** `6df7306`

## Known Stubs

None.

## Self-Check: PASSED

- Confirmed `src/lib/editorPaneStore.ts`, `src/lib/editorSurfaceStore.test.ts`, `src/lib/editorSurfacePersistence.ts`, and `src/App.tsx` exist.
- Confirmed task commits `1813e93`, `b0e19ac`, `dd5c6c3`, and `6df7306` exist in git history.

## Next Phase Readiness

- 04-05 can migrate `EditorPane` onto the established facade slices and command port while retaining its preview rendering invariants.
- 04-06 can use the keyed store and App lifecycle seams for render-isolation and final shell verification.

---

*Phase: 04-editor-surface-state-extraction*
*Completed: 2026-08-26*
