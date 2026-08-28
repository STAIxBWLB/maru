---
phase: 05-shell-decomposition-completion
plan: "01"
subsystem: ui
tags: [react, typescript, useSyncExternalStore, document-browser, outline]
requires:
  - phase: 04-editor-surface-state-extraction
    provides: Stable facade slices and least-authority command ports
provides:
  - Workspace and visibility keyed document browser store with stable slices
  - Four-input DocumentList facade and nonce-safe reveal intents
  - Outline composition over canonical browser selection and filter values
affects: [05-02, 05-04, shell-decomposition]
actuals:
  tokens: 9875
  tasks: 2
  commits: 4
tech-stack:
  added: []
  patterns: [module-slot external store, stable browser slices, nonce-bearing intents]
key-files:
  created: [src/lib/documentBrowserStore.ts, src/lib/documentBrowserStore.test.ts]
  modified: [src/App.tsx, src/components/DocumentList.tsx, src/lib/outlinePaneStore.ts]
key-decisions:
  - "DocumentList receives only scope, commands, searchInputRef, and paneRef."
  - "Outline composes browser selection and filtering from documentBrowserStore instead of mirroring them."
patterns-established:
  - "Browser commands retain App orchestration while pane state is published through keyed external-store slices."
  - "One-shot reveal work is represented by nonce-bearing intents and nonce-safe acknowledgement."
requirements-completed: [SHELL-05, SHELL-08]
coverage:
  - id: D1
    description: Four-input, store-backed DocumentList with stable slice identities and repeated reveal handling
    requirement: SHELL-05
    verification:
      - kind: unit
        ref: src/lib/documentBrowserStore.test.ts and src/components/DocumentList.test.tsx
        status: pass
    human_judgment: false
  - id: D2
    description: Outline composes selection and filtering from the canonical document browser owner
    requirement: SHELL-08
    verification:
      - kind: unit
        ref: src/lib/outlinePaneStore.test.ts
        status: pass
    human_judgment: false
duration: 1h
completed: 2026-08-26
status: complete
---

# Phase 05 Plan 01: Document Browser Facade Summary

**A keyed document-browser external store now drives a four-input DocumentList and provides canonical selection/filter records to Outline.**

## Performance

- **Duration:** 1h
- **Started:** 2026-08-26T13:00:00Z
- **Completed:** 2026-08-26T14:10:04Z
- **Tasks:** 2/2
- **Files modified:** 8

## Accomplishments

- Added immutable, workspace/visibility-keyed browser slices with focused subscriptions and explicit cleanup.
- Reduced DocumentList to its D-01 structural boundary while retaining App-owned filesystem and write-gate orchestration through a typed command port.
- Replaced path-only document reveal handling with nonce-bearing intents so identical targets can be handled independently.
- Removed Outline's duplicate selection/filter sidebar fields and composed the canonical browser records instead.

## Task Commits

1. **Task 1: Trace document browse, select, and repeated reveal** - `2cdcb30` (test), `911378b` (feat)
2. **Task 2: Complete browser ownership and Outline composition** - `39a1bb7` (test), `e54a18a` (feat)

## Files Created/Modified

- `src/lib/documentBrowserStore.ts` - keyed browser state, slice hooks, reveal lifecycle, and cleanup.
- `src/lib/documentBrowserStore.test.ts` - stable-identity and nonce-safe reveal contracts.
- `src/components/DocumentList.tsx` - store-backed four-prop facade with local interaction state preserved.
- `src/components/DocumentList.test.tsx` - TypeScript AST prop-boundary contract.
- `src/lib/outlinePaneStore.ts` - browser-slice composition without duplicate sidebar ownership.
- `src/lib/outlinePaneStore.test.ts` - canonical-owner regression coverage.
- `src/components/OutlinePane.tsx` - consumes composed browser selection/filter values.
- `src/App.tsx` - publishes browser snapshots post-render and provides the retained command adapter.

## Decisions Made

- Kept filesystem operations, workspace capability checks, and write gates behind App's typed command callbacks; the component does not invoke native APIs directly.
- Keyed browser records by workspace plus visibility, allowing private and public browser state to remain distinct.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Ignore undefined fields during slice publication**
- **Found during:** Task 1
- **Issue:** A partial query update overwrote unchanged slice fields with `undefined`, breaking the stable-identity contract.
- **Fix:** Publication now applies only defined patch fields.
- **Files modified:** `src/lib/documentBrowserStore.ts`
- **Verification:** `src/lib/documentBrowserStore.test.ts` passes.
- **Committed in:** `911378b`

**Total deviations:** 1 auto-fixed (Rule 1)

## Issues Encountered

- A pre-existing concurrent `make verify` process was active in the shared checkout. Focused/full Vitest coverage, `pnpm typecheck`, `pnpm lint`, and a frontend build were run independently; no failure was attributable to this plan's files.

## TDD Gate Compliance

- RED commits: `2cdcb30`, `39a1bb7`
- GREEN commits: `911378b`, `e54a18a`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Later shell-decomposition plans can reuse the stable keyed-slice and command-port pattern.
- The Documents/Outline browser path has a single source for selected path and document filter state.

## Self-Check: PASSED

- Created store and focused tests exist on disk.
- All four task commits are present in git history.
- Focused/full Vitest suite, typecheck, and lint passed after the final implementation commit.

---

*Phase: 05-shell-decomposition-completion*
*Completed: 2026-08-26*
