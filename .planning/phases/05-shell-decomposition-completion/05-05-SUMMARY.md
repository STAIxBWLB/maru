---
phase: 05-shell-decomposition-completion
plan: "05"
subsystem: ui
tags: [react, typescript, lazy-loading, mode-registry, graph, sites]
requires:
  - phase: 05-shell-decomposition-completion
    provides: registry tracer and generic ModeSurfaceHost from 05-04
provides:
  - Dedicated lazy Diagram, Graph, and Sites adapters registered through one mode registry
  - Isolated visual-mode slices for Diagram projection, Graph focus, and ordered Sites open requests
  - Bundle guard coverage for all visual adapter chunks and dynamic registry factories
affects: [shell decomposition, terminal panel graph slot, mode registry]
actuals:
  tokens: 10519
  tasks: 2
  commits: 4
tech-stack:
  added: []
  patterns: [visual-mode external-store slices, dedicated lazy mode adapters, ordered native URL intents]
key-files:
  created:
    - src/lib/visualModeStore.ts
    - src/lib/modeAdapters/DiagramModeAdapter.tsx
    - src/lib/modeAdapters/GraphModeAdapter.tsx
    - src/lib/modeAdapters/SitesModeAdapter.tsx
  modified:
    - src/App.tsx
    - src/lib/modeRegistry.tsx
    - scripts/check-bundle-budget.mjs
key-decisions:
  - "Graph has one adapter for primary, right, and terminal-panel placement."
  - "Native Sites URLs are nonce-bearing store intents and are acknowledged only after consumption."
  - "Visual surfaces use registry dynamic imports, while rail metadata remains in App."
requirements-completed: [SHELL-07, SHELL-08]
coverage:
  - id: D1
    description: "Diagram, Graph, and Sites render through dedicated lazy registry adapters."
    requirement: SHELL-07
    verification:
      - kind: unit
        ref: "src/lib/modeRegistry.test.ts"
        status: pass
      - kind: other
        ref: "pnpm build && pnpm check:bundle-budget"
        status: pass
    human_judgment: false
  - id: D2
    description: "Visual mode updates are isolated and Sites requests preserve ordered acknowledgement."
    requirement: SHELL-08
    verification:
      - kind: unit
        ref: "src/lib/visualModeStore.test.ts"
        status: pass
      - kind: integration
        ref: "pnpm test -- src/lib/visualModeStore.test.ts src/lib/modeRegistry.test.ts src/lib/graph src/lib/siteViewOpenRequests.test.ts"
        status: pass
    human_judgment: false
duration: 11min
completed: 2026-08-26
status: complete
---

# Phase 05 Plan 05: Visual Mode Adapter Completion Summary

**Diagram, Graph, and Sites now use isolated state slices and dedicated lazy adapters without adding visual-mode render branches to MainApp.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-08-26T14:50:00Z
- **Completed:** 2026-08-26T15:01:22Z
- **Tasks:** 2/2
- **Files modified:** 9

## Accomplishments

- Moved Diagram document projections and revision-checked saves behind a dedicated registry adapter.
- Added Graph primary/right/panel rendering and Sites URL queue acknowledgement to the visual-mode controller.
- Extended bundle guards to require separate Diagram, Graph, and Sites lazy chunks and dynamic registry factories.

## Task Commits

1. **Task 1: Move Diagram state and rendering into its lazy adapter** - `11911c5`, `5e1ebf6` (test, feat)
2. **Task 2: Migrate Graph and Sites, preserving multi-placement and queued native events** - `a31e25c`, `f662afd` (test, feat)

## Files Created/Modified

- `src/lib/visualModeStore.ts` - isolated immutable slices, subscribers, and Sites native-request bridge.
- `src/lib/modeAdapters/DiagramModeAdapter.tsx` - canonical tab/workspace projection for Diagram.
- `src/lib/modeAdapters/GraphModeAdapter.tsx` - graph settings, focus, nested-vault projection, and placement-neutral rendering.
- `src/lib/modeAdapters/SitesModeAdapter.tsx` - queued native URLs and right-pane close integration.
- `src/lib/modeRegistry.tsx` - Diagram, Graph, and Sites dynamic descriptors.
- `src/App.tsx` - generic mode host and terminal-panel Graph slot composition.
- `scripts/check-bundle-budget.mjs` - visual adapter lazy-chunk and eager-import checks.

## Decisions Made

- Graph uses one descriptor with `primary`, `right`, and `panel` placements, avoiding a second terminal-specific Graph import.
- Sites request IDs remain owned by the visual-mode controller so duplicate URLs can be distinct intents and each handled URL is removed once.
- Activity rail labels, order, icons, and shortcuts remain in the existing App navigation contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Updated the bundle guard for adapter chunk names**

- **Found during:** Task 2
- **Issue:** The prior guard required a `GraphView-*` chunk, but the new lazy boundary intentionally emits `GraphModeAdapter-*`.
- **Fix:** Required all three visual adapter chunks and their dynamic registry factories while retaining the entry-budget checks.
- **Files modified:** `scripts/check-bundle-budget.mjs`
- **Verification:** `pnpm build && pnpm check:bundle-budget` passed.
- **Committed in:** `f662afd`

**Total deviations:** 1 auto-fixed (Rule 3)

## Issues Encountered

None.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The registry now has dedicated lazy visual adapters and can support the remaining shell-decomposition surfaces without restoring mode-specific rendering to `App.tsx`.

## Self-Check: PASSED

- Visual mode store, three adapters, mode registry, tests, and bundle guard are present.
- Task commits `11911c5`, `5e1ebf6`, `a31e25c`, and `f662afd` exist in git history.
