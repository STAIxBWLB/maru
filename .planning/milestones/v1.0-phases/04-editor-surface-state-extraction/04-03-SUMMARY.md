---
phase: 04-editor-surface-state-extraction
plan: "03"
subsystem: ui
tags: [react, typescript, facade-store, outline, persistence, workspace-lifecycle]
requires:
  - phase: 04-01
    provides: Outline facade contract and static prop-budget guard
  - phase: 04-02
    provides: Workspace-keyed document, file-queue, and operation slices
provides:
  - Complete Outline sidebar and explorer facade slices with structural props only
  - Least-authority command port for every Outline-invoked shell effect
  - Guarded right-pane settings hydration and workspace cleanup adapter
affects: [04-04, 04-05, 04-06, editor-surface-state-extraction]
actuals:
  tokens: 12640
  tasks: 2
  commits: 5
tech-stack:
  added: []
  patterns:
    - Workspace-keyed facade subscriptions by render domain
    - Command-port delegation for cross-surface Outline effects
    - Existing-settings persistence guarded by App loadWorkspace request ids
key-files:
  created:
    - src/lib/editorSurfacePersistence.ts
  modified:
    - src/lib/outlinePaneStore.ts
    - src/lib/outlinePaneStore.test.ts
    - src/lib/editorSurfaceAdapter.ts
    - src/components/OutlinePane.tsx
    - src/App.tsx
key-decisions:
  - "OutlinePane now receives only scope, commands, pane ref, and render slots; sidebar and explorer values are facade slices."
  - "The persistence adapter consumes App's existing loadWorkspace request id and never owns a second generation counter."
  - "Workspace cleanup drops only facade-local Outline records, leaving editorTabsStore drafts and MaruSettings untouched."
patterns-established:
  - "Render-domain publishes retain sibling snapshot identities and notify only their domain subscribers."
  - "Pane event handlers call OutlinePaneCommands, whose implementations delegate to retained App orchestration."
requirements-completed: [SHELL-01, SHELL-03]
coverage:
  - id: D1
    description: Outline sidebar and explorer render domains are facade-backed while the component has four structural props.
    requirement: SHELL-01
    verification:
      - kind: unit
        ref: src/lib/outlinePaneStore.test.ts#keeps OutlinePane within the structural prop budget
        status: pass
      - kind: other
        ref: pnpm typecheck
        status: pass
    human_judgment: false
  - id: D2
    description: Async and cross-surface Outline effects are exposed only through the narrow command port.
    requirement: SHELL-01
    verification:
      - kind: unit
        ref: src/lib/outlinePaneStore.test.ts#exposes shell effects only through the command port
        status: pass
      - kind: other
        ref: pnpm lint
        status: pass
    human_judgment: false
  - id: D3
    description: Persisted right-pane state hydrates only for the current workspace request and workspace cleanup preserves canonical drafts.
    requirement: SHELL-03
    verification:
      - kind: unit
        ref: src/lib/outlinePaneStore.test.ts#rejects a late workspace hydration before its one facade publish
        status: pass
      - kind: unit
        ref: src/lib/outlinePaneStore.test.ts#saves only rightPaneTab and removes facade-local workspace records
        status: pass
    human_judgment: false
duration: 9min
completed: 2026-08-25
status: complete
---

# Phase 04 Plan 03: Complete Outline facade and guarded persistence Summary

**Outline now reads sidebar and explorer render domains from a keyed facade, invokes only a narrow command port, and persists right-pane state through App's existing guarded settings pipeline.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-08-25T21:20:39Z
- **Completed:** 2026-08-25T21:28:48Z
- **Tasks:** 2/2
- **Files modified:** 6

## Accomplishments

- Replaced the remaining Outline prop bundles with stable sidebar and explorer facade slices. `OutlinePaneProps` now contains only `scope`, `commands`, `paneRef`, and `slots`.
- Routed pane-invoked navigation, dialogs, explorer operations, inspector edits, file queue work, and right-pane selection through `OutlinePaneCommands`, while App keeps the existing authorization and orchestration behavior.
- Added a reusable persistence adapter that bridges only `MaruSettings.ui.rightPaneTab`, rejects stale workspace loads using App's authoritative request id, and removes facade-local workspace state without touching canonical drafts.

## Task Commits

1. **Task 1: Complete the Outline facade, narrow command port, and eight-prop contract** - `7c8fe53` (test), `fbcbb01` (feat)
2. **Task 2: Hydrate, persist, and clean Outline state through the guarded persistence adapter** - `babd678` (test), `22960ed` (feat), `8bcd0e1` (fix)

## Files Created/Modified

- `src/lib/outlinePaneStore.ts` - Adds keyed sidebar and explorer slices, scoped subscriptions, and an identity-preserving persisted tab transition.
- `src/lib/editorSurfaceAdapter.ts` - Defines the complete least-authority `OutlinePaneCommands` port.
- `src/lib/editorSurfacePersistence.ts` - Guards hydration with workspace identity plus App's request id and writes through the existing settings updater.
- `src/components/OutlinePane.tsx` - Reads facade slices and sends all effects through the command port.
- `src/App.tsx` - Composes facade slices, supplies existing shell operations, routes persistence, and cleans up removed workspaces.
- `src/lib/outlinePaneStore.test.ts` - Pins structural props, render isolation, stale hydration rejection, settings-key preservation, and draft ownership.

## Decisions Made

- Keep render values in facade slices but leave canonical document drafts in `editorTabsStore` and settings persistence in the existing normalized saver path.
- Use the authoritative `loadWorkspaceRequestRef` as the only freshness token. The adapter has no independent counter.
- Keep render slots structural so the existing Skills, Guideline, Evidence, and Share Outbox content remains visually and behaviorally unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Remove stale type imports after prop-bundle extraction**

- **Found during:** Task 2 verification
- **Issue:** `OutlinePane.tsx` retained seven now-unused type imports after the sidebar and explorer props were replaced by facade hooks, causing the repository lint gate to fail.
- **Fix:** Removed only the stale imports.
- **Files modified:** `src/components/OutlinePane.tsx`
- **Verification:** `pnpm lint`, `pnpm typecheck`, and focused facade tests pass.
- **Committed in:** `8bcd0e1`

**Total deviations:** 1 auto-fixed (Rule 1 bug)

## Issues Encountered

None remaining.

## Known Stubs

None. The placeholder-like strings found during the scan are existing user-facing input placeholders and empty alt text, not data-flow stubs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 04-04 can reuse the persistence adapter and scoped cleanup pattern for the Editor facade.
- Outline has a complete facade/port boundary without introducing settings keys, backend commands, or visible UI changes.

## Self-Check: PASSED

- Confirmed all six production/test artifacts and this summary exist.
- Confirmed commits `7c8fe53`, `fbcbb01`, `babd678`, `22960ed`, and `8bcd0e1` exist in git history.

---

*Phase: 04-editor-surface-state-extraction*
*Completed: 2026-08-25*
