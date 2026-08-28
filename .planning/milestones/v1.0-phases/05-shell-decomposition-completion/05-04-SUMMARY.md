---
phase: 05-shell-decomposition-completion
plan: "04"
subsystem: shell-mode-routing
tags: [react, typescript, external-store, settings, lazy-loading, vite]
requires:
  - phase: 05-03
    provides: narrowed shell boundaries and process-global panel store conventions
provides:
  - Canonical normalized shell settings snapshots with stable domain-slice subscriptions
  - Descriptor-driven lazy PKM and E2E mode host routing
  - Static and emitted-chunk guards for registered lazy mode adapters
affects: [05-05, shell-decomposition, mode-adapters, settings-persistence]
actuals:
  tokens: 5072
  tasks: 3
  commits: 6
tech-stack:
  added: []
  patterns: [useSyncExternalStore settings slices, descriptor lazy factories, narrow mode host scope and command ports]
key-files:
  created:
    - src/lib/shellSettingsStore.ts
    - src/lib/shellSettingsStore.test.ts
    - src/lib/modeRegistry.tsx
    - src/lib/modeRegistry.test.ts
    - src/lib/modeAdapters/PkmModeAdapter.tsx
    - src/lib/modeAdapters/E2EFlowModeAdapter.tsx
  modified:
    - src/App.tsx
    - scripts/check-bundle-budget.mjs
key-decisions:
  - "Normalized MaruSettings now has one module-store owner, while MainApp subscribes to its current snapshot."
  - "PKM and E2E descriptors own dynamic loaders, placement, availability, and fallback identity; ActivityRail metadata remains in App."
  - "Lazy adapters receive only ModeHostScope and ModeHostCommands and subscribe to their own domain facades."
patterns-established:
  - "Settings consumers use stable domain slices so unrelated settings domains do not publish to them."
  - "A mode is added through one registry descriptor and one dedicated dynamic-import adapter module."
requirements-completed: [SHELL-07, SHELL-08]
coverage:
  - id: D1
    description: Canonical shell settings normalization, same-key persistence semantics, and stale hydration guard
    requirement: SHELL-08
    verification:
      - kind: unit
        ref: src/lib/shellSettingsStore.test.ts
        status: pass
      - kind: other
        ref: make verify
        status: pass
    human_judgment: false
  - id: D2
    description: PKM and E2E descriptor routing with dedicated lazy adapter chunks
    requirement: SHELL-07
    verification:
      - kind: unit
        ref: src/lib/modeRegistry.test.ts
        status: pass
      - kind: other
        ref: pnpm build and pnpm check:bundle-budget
        status: pass
    human_judgment: false
duration: 8min
completed: 2026-08-26
status: complete
---

# Phase 05 Plan 04: Shell Mode Registry Summary

**Canonical shell settings slices and descriptor-driven PKM/E2E lazy adapters keep settings persistence compatible while removing the two migrated surfaces from App-specific lazy declarations.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-08-26T14:40:24Z
- **Completed:** 2026-08-26T14:48:18Z
- **Tasks:** 3/3
- **Files modified:** 8
- **Verification:** focused tests, `pnpm typecheck`, `pnpm build`, `pnpm check:bundle-budget`, and `make verify` passed.

## Accomplishments

- Moved canonical normalized `MaruSettings` snapshots to `shellSettingsStore`, with stable layout, document-browser, terminal/graph, AI, composer, meeting, and task subscriptions.
- Guarded settings hydration with the active workspace-load request identity and kept existing normalization/serialization keys intact.
- Added the generic `ModeSurfaceHost` contract and migrated PKM plus feature-gated E2E to descriptor lookup with dedicated dynamic adapter modules.
- Extended bundle checks to reject eager PKM/E2E adapter imports and require separate emitted adapter chunks without changing entry budgets.

## Task Commits

1. **Task 1: Move canonical settings ownership and golden persistence contracts out of MainApp** - `d204bbc` (test), `a3d0369` (feat)
2. **Task 2: Trace PKM through the generic lazy registry host** - `eb8e9c1` (test), `acfac11` (feat)
3. **Task 3: Add the E2E feature-gated adapter and lock the lazy descriptor rules** - `07ac0ed` (test), `933b3f2` (feat)

## Files Created/Modified

- `src/lib/shellSettingsStore.ts` - canonical settings owner, stable slice cache, and guarded hydration.
- `src/lib/shellSettingsStore.test.ts` - normalized same-key persistence and stale hydration tests.
- `src/lib/modeRegistry.tsx` - descriptor, scope/command contracts, dynamic loader factories, and Suspense host.
- `src/lib/modeRegistry.test.ts` - PKM and E2E descriptor contracts.
- `src/lib/modeAdapters/PkmModeAdapter.tsx` - lazy Documents/editor workbench adapter boundary.
- `src/lib/modeAdapters/E2EFlowModeAdapter.tsx` - lazy feature-gated E2E adapter boundary.
- `src/App.tsx` - external-store settings subscription and generic host calls for both migrated modes.
- `scripts/check-bundle-budget.mjs` - PKM/E2E dynamic-source and emitted-chunk checks.

## Decisions Made

- Retained App's ActivityRail navigation metadata and existing persistence helpers; descriptors govern only rendering contracts.
- Used the current workspace-load request ID for store hydration so a late response cannot overwrite the active workspace settings.
- Kept the existing numeric entry budgets and proved the two adapters are emitted as their own chunks.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added the stable store updater to App hook dependencies**
- **Found during:** Task 1
- **Issue:** Replacing React state with the settings store exposed missing `setMaruSettings` dependencies in settings effects and callbacks.
- **Fix:** Added the stable updater dependency and used the current load request identity in the hydration path.
- **Files modified:** `src/App.tsx`
- **Verification:** `pnpm lint`, `pnpm typecheck`, and `make verify` passed.
- **Committed in:** `a3d0369`

**Total deviations:** 1 auto-fixed (Rule 1)

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Later shell modes can add a descriptor and dedicated adapter while retaining ActivityRail ownership in App.
- The shell settings store exposes stable mode-ready slices without adding persistence keys or transient runtime data.

## Self-Check: PASSED

- All eight plan-owned source and test files exist.
- All six TDD RED/GREEN task commits are present in git history.

---
*Phase: 05-shell-decomposition-completion*
*Completed: 2026-08-26*
