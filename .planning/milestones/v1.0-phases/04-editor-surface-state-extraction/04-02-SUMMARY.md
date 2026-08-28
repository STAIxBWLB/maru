---
phase: 04-editor-surface-state-extraction
plan: "02"
subsystem: ui
tags: [react, typescript, useSyncExternalStore, outline, file-queue, facade]
requires:
  - phase: 04-01
    provides: activation-gated facade, command-port, render-isolation, and prop-budget contracts
provides:
  - Keyed Outline document, file-queue, and operation render-domain slices
  - Per-domain subscriptions that preserve unchanged-slice identity
  - A narrow Outline command port for heading navigation and file-queue orchestration
affects: [04-03, 04-04, 04-05, 04-06]
actuals:
  tokens: 13233
  tasks: 2
  commits: 6
tech-stack:
  added: []
  patterns:
    - Workspace-keyed facade state with domain-specific subscriber registries
    - Pure file-queue transitions with stable no-op identity
    - Least-authority command ports that read facade snapshots at invocation time
key-files:
  created: []
  modified:
    - src/lib/outlinePaneStore.ts
    - src/lib/outlinePaneStore.test.ts
    - src/lib/editorSurfaceAdapter.ts
    - src/components/OutlinePane.tsx
    - src/App.tsx
key-decisions:
  - "File queue and selection moved from MainApp useState into the workspace-keyed Outline facade, while App retains async filesystem orchestration and backend write checks."
  - "Separate subscriber registries are keyed by workspace and render domain so a file-queue publish does not notify document-slice consumers."
  - "Actionable file-queue progress and failure live in the operation slice; notification-only failures retain the global error-store path."
patterns-established:
  - "Pane-local state publishes only the changed render-domain subscriber set and preserves all sibling slice identities."
  - "Outline async interactions cross OutlinePaneCommands; direct component actions use tested pure facade transitions."
requirements-completed: [SHELL-01, SHELL-03]
coverage:
  - id: D1
    description: Outline headings render from the stable document facade slice and activate through the current-snapshot command port.
    requirement: SHELL-01
    verification:
      - kind: unit
        ref: pnpm test -- src/lib/outlinePaneStore.test.ts
        status: pass
      - kind: manual_procedural
        ref: Native Tauri tracer, Docs Outline heading activation to Source line
        status: pass
    human_judgment: false
  - id: D2
    description: File-queue publications update only the queue render domain and retain document-slice identity.
    requirement: SHELL-03
    verification:
      - kind: unit
        ref: src/lib/outlinePaneStore.test.ts#publishes file-queue changes only to the file-queue render domain
        status: pass
      - kind: other
        ref: make verify
        status: pass
    human_judgment: false
duration: 13min
completed: 2026-08-25
status: complete
---

# Phase 04 Plan 02: Outline facade and file-queue render isolation Summary

**Outline headings and file-queue interactions now use a workspace-keyed, identity-stable facade with narrow command ports while App retains filesystem orchestration and write authorization.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-08-25T21:03:27Z
- **Completed:** 2026-08-25T21:16:22Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Activated the Outline document tracer, then routed heading activation through the facade and `OutlinePaneCommands` with canonical document and draft ownership retained by `editorTabsStore`.
- Moved file-queue selection and render state into the keyed facade, with separate document, queue, and operation subscribers and identity-preserving pure transitions.
- Routed queue source, external-file, update, and apply operations through the typed port while retaining App's existing backend checks, settings update, refresh, and error behavior.
- Reduced the `OutlinePane` boundary without changing visible content, order, labels, interactions, or geometry.

## Task Commits

Each task was committed atomically:

1. **Task 1: Tracer: active Outline document to heading command through the facade and shell adapter** - `0e5141c` (test), `2606fc7` (feat)
2. **Task 2: Expand the tracer through the file-queue render domain and prove slice isolation** - `abe205c` (test), `21af001` (feat), `77cacdb` (fix), `8fb974a` (fix)

## Files Created/Modified

- `src/lib/outlinePaneStore.ts` - Workspace-keyed Outline state, pure queue transitions, stable render-domain hooks, and domain-specific subscriptions.
- `src/lib/outlinePaneStore.test.ts` - Red-first tracer and file-queue subscriber/identity evidence.
- `src/lib/editorSurfaceAdapter.ts` - Narrow Outline heading and queue command methods that read current state when invoked.
- `src/components/OutlinePane.tsx` - Facade-backed queue rendering and pure queue actions with no migrated queue props.
- `src/App.tsx` - Final facade wiring plus retained asynchronous queue orchestration and capability checks.

## Decisions Made

- Use per-workspace, per-domain subscriber maps rather than one facade-wide notification set. A queue update therefore cannot invalidate document subscribers.
- Keep queue update/selection transitions pure in `outlinePaneStore`; let the adapter call App only for orchestration and persistence side effects.
- Keep queue progress and actionable failure in the operation slice, while the existing global error store continues to surface notification-only failures.

## Verification

- Red first: the new queue contract failed because `subscribeOutlineDocumentSlice` did not yet exist.
- Passed `pnpm test -- src/lib/outlinePaneStore.test.ts` and `pnpm typecheck` after the final implementation.
- Passed `make verify`, including lint, full Vitest suite, Rust library tests, rustfmt, clippy, frontend build, and bundle-budget checks.
- Native tracer evidence approved before Task 2: a fresh current-checkout Tauri process opened Docs and Outline, displayed seven existing headings, and selecting `운영 참고` switched the focused editor to Source mode and scrolled to the matching `## 운영 참고` line. The process was stopped afterward; the installed Maru process was not touched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Restore no-op facade identity during hydration**

- **Found during:** Task 2
- **Issue:** Rehydrating with every existing slice produced a new top-level facade object, breaking the established no-op identity contract.
- **Fix:** Return the current facade state when document, file-queue, and operation slices are unchanged.
- **Files modified:** `src/lib/outlinePaneStore.ts`
- **Verification:** `src/lib/outlinePaneStore.test.ts` identity assertion passes.
- **Committed in:** `21af001`

**2. [Rule 1 - Bug] Correct facade migration lint regressions**

- **Found during:** Task 2 full verification
- **Issue:** The moved-file callback omitted the keyed scope dependency, and two stale imports remained after extraction.
- **Fix:** Added the scope dependency and removed unused imports.
- **Files modified:** `src/App.tsx`, `src/components/OutlinePane.tsx`, `src/lib/outlinePaneStore.ts`
- **Verification:** `make verify` passes lint with zero warnings.
- **Committed in:** `77cacdb`

**3. [Rule 2 - Missing Critical] Use the tested pure transition in production**

- **Found during:** Task 2 final review
- **Issue:** App duplicated the queue-item update transition instead of using the facade helper pinned by the queue contract.
- **Fix:** Route the production update callback through `updateOutlineFileQueueItem`.
- **Files modified:** `src/App.tsx`
- **Verification:** Focused facade tests and typecheck pass.
- **Committed in:** `8fb974a`

**Total deviations:** 3 auto-fixed (2 bugs, 1 missing critical correctness integration).

## Issues Encountered

None remaining. The initial full-gate run exposed only the lint regressions documented above; the final full gate passed.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Self-Check: PASSED

- Confirmed all five production/test artifacts and this summary exist.
- Confirmed commits `0e5141c`, `2606fc7`, `abe205c`, `21af001`, `77cacdb`, and `8fb974a` exist in git history.

## Next Phase Readiness

- 04-03 can expand the proven Outline facade through explorer, share, sidebar, persistence, and cleanup domains.
- The document and file-queue contracts now provide the stable subscriber and command-port conventions for the remaining Outline migration.

---

*Phase: 04-editor-surface-state-extraction*
*Completed: 2026-08-25*
