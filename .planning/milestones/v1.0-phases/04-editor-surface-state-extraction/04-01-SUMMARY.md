---
phase: 04-editor-surface-state-extraction
plan: "01"
subsystem: testing
tags: [vitest, react, typescript, external-store, render-isolation]
requires:
  - phase: 01-trustworthy-verify-signal
    provides: focused test, lint, and typecheck gates
provides:
  - Wave 0 fail-first facade and lifecycle contracts for Outline and Editor panes
  - React render-isolation and preview DOM-identity regression contracts
  - AST-checked eight-prop boundaries for both panes
affects: [04-02, 04-03, 04-04, 04-05, 04-06]
actuals:
  tokens: 4207
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns:
    - Environment-gated future-contract tests with runtime-only planned-module resolution
    - TypeScript-AST interface-property budgets
    - Deterministic jsdom render counters and DOM identity assertions
key-files:
  created:
    - src/lib/outlinePaneStore.test.ts
    - src/lib/editorSurfaceStore.test.ts
    - src/__tests__/editorSurfaceRenderIsolation.test.tsx
    - src/components/EditorPane.test.tsx
  modified: []
key-decisions:
  - "Keep Wave 0 contracts skipped by default and activate them only with PHASE4_WAVE0_CONTRACT=1 until their owning production plan removes the gate."
  - "Resolve planned modules only inside activated test bodies so absent facade modules cannot break normal collection."
patterns-established:
  - "Pane prop budgets parse InterfaceDeclaration members with the TypeScript AST, not formatted source text."
  - "Render-isolation evidence uses real input/change events and exact named probe counters."
requirements-completed: []
coverage:
  - id: D1
    description: Outline and Editor facade lifecycle contracts are executable and activation-gated.
    verification:
      - kind: unit
        ref: pnpm exec vitest run src/lib/outlinePaneStore.test.ts and src/lib/editorSurfaceStore.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Two-pane render-isolation and preview DOM-identity contracts are collected without affecting the normal test gate.
    verification:
      - kind: automated_ui
        ref: pnpm test -- src/lib/outlinePaneStore.test.ts src/lib/editorSurfaceStore.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx src/components/EditorPane.test.tsx
        status: pass
    human_judgment: false
duration: 6min
completed: 2026-08-25
status: complete
---

# Phase 04 Plan 01: Wave 0 Validation Contracts Summary

**Four activation-gated Vitest contracts now pin the pane-facade boundaries, render isolation, preview DOM identity, and eight-prop limits before production extraction begins.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-08-25T20:24:00Z
- **Completed:** 2026-08-25T20:29:44Z
- **Tasks:** 2/2
- **Files modified:** 4

## Accomplishments

- Added Outline and Editor facade contracts for scoped identity, cleanup, guarded hydration, canonical draft ownership, current-snapshot command ports, and prop budgets.
- Added a deterministic left/right typing harness with named `DocumentList`, `TerminalPanel`, and activity-rail render probes plus changed-slice subscriber evidence.
- Added the preview-mark regression contract for mark classes, stable marked-node identity, and React-owned `previewMarkup` memoization.
- Kept normal test collection green by resolving future production modules only when `PHASE4_WAVE0_CONTRACT=1` activates the intentional fail-first cases.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create fail-first facade, port, lifecycle, and prop-budget contracts** - `fc865e8` (test)
2. **Task 2: Create fail-first render-isolation and preview-identity component contracts** - `988b612` (test)

## Files Created

- `src/lib/outlinePaneStore.test.ts` - Outline facade, cleanup, current-snapshot command-port, and AST prop-budget contracts.
- `src/lib/editorSurfaceStore.test.ts` - Keyed Editor facade, guarded hydration, cleanup, command-port, and AST prop-budget contracts.
- `src/__tests__/editorSurfaceRenderIsolation.test.tsx` - Two-editor typing and changed-domain subscriber render-counter contracts.
- `src/components/EditorPane.test.tsx` - Preview mark and DOM-node identity regression contract.

## Decisions Made

- Use one named environment activation (`PHASE4_WAVE0_CONTRACT`) for all future-facing cases. This keeps the repository gate green between waves while preserving concrete red evidence before each owner implements its production surface.
- Use dynamic runtime module resolution inside active test bodies. The contracts can be collected while the planned facade modules do not yet exist.

## Verification

- Passed existing store controls: `pnpm test -- src/lib/appOverlayStore.test.ts src/lib/editorTabsStore.test.ts`.
- Passed existing component control: `pnpm test -- src/__tests__/editorPreviewDebounce.test.tsx`.
- Passed ESLint for all four new test files and `pnpm typecheck`.
- Passed normal repository test run: 190 files passed, 4 Wave 0 files skipped, 1,858 tests passed, 13 skipped.
- Confirmed each direct activated contract fails only because the planned `outlinePaneStore` or `editorPaneStore` module does not yet exist. This is the required fail-first state, not a runner or fixture failure.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. The activation-gated cases are intentional fail-first contracts owned by later production plans, not runtime or UI stubs.

## Issues Encountered

- The package `pnpm test -- <file>` script includes the repository test roots, so it exercises the full suite rather than isolating one file. Direct `pnpm exec vitest run <file>` activation runs established the required per-file red evidence without changing project scripts.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 04-02 can remove the Outline document and command-port gate, observe the committed red contract, then implement the tracer facade.
- 04-04 and 04-05 can remove the Editor lifecycle and component gates in their ownership order without weakening these assertions.

## Self-Check: PASSED

- Confirmed all four test artifacts exist.
- Confirmed task commits `fc865e8` and `988b612` exist in git history.

---

*Phase: 04-editor-surface-state-extraction*
*Completed: 2026-08-25*
