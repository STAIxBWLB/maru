---
phase: 05-shell-decomposition-completion
plan: "03"
subsystem: terminal-shell
tags: [react, tauri, terminal, external-store, render-isolation]
requires:
  - phase: 05-01
    provides: document browser facade and shell slice conventions
  - phase: 05-02
    provides: generation-bearing TerminalSessionHandle IPC contract
provides:
  - Process-global observable terminal task, tab, layout, context, request, and error slices
  - Mutable terminal runtime controller registry isolated from React snapshots
  - Four-input TerminalPanel boundary with an injected Graph render slot
affects: [05-04, shell-decomposition, terminal-runtime]
actuals:
  tokens: 9350
  tasks: 2
  commits: 4
tech-stack:
  added: []
  patterns: [useSyncExternalStore terminal slices, runtime-controller registry, least-authority terminal command port]
key-files:
  created:
    - src/lib/terminalPanelStore.ts
    - src/lib/terminalRuntimeController.ts
    - src/lib/terminalSurfaceAdapter.ts
  modified:
    - src/components/TerminalPanel.tsx
    - src/App.tsx
    - src/__tests__/editorSurfaceRenderIsolation.test.tsx
key-decisions:
  - "Terminal reducer state is process-global while launch context remains a separately published slice."
  - "Native terminal resources remain in a controller registry and are never exposed in external-store snapshots."
  - "TerminalPanel accepts only scope, commands, graphNode, and its forwarded ref."
patterns-established:
  - "Terminal state changes subscribe through stable render-domain slices instead of re-executing MainApp."
  - "A panel command adapter reads current shell settings and delegates retained layout mutations."
requirements-completed: [SHELL-06, SHELL-08]
coverage:
  - id: D1
    description: Process-global terminal state and transient runtime exclusion
    requirement: SHELL-06
    verification:
      - kind: unit
        ref: src/lib/terminalPanelStore.test.ts
        status: pass
      - kind: integration
        ref: cargo test terminal
        status: pass
    human_judgment: false
  - id: D2
    description: Four-input TerminalPanel facade and render isolation from MainApp
    requirement: SHELL-08
    verification:
      - kind: unit
        ref: src/__tests__/editorSurfaceRenderIsolation.test.tsx
        status: pass
      - kind: other
        ref: make verify
        status: pass
    human_judgment: false
duration: 14min
completed: 2026-08-26
status: complete
---

# Phase 05 Plan 03: Terminal Panel Ownership Summary

**Process-global terminal slices, isolated native runtime registries, and a four-input TerminalPanel facade that no longer re-executes MainApp for terminal state changes.**

## Performance

- **Duration:** 14 min
- **Tasks:** 2/2
- **Files modified:** 7
- **Verification:** focused terminal tests, `pnpm typecheck`, `cargo test terminal`, and `make verify` passed.

## Accomplishments

- Added independent task/tab, layout, active-context, request, and error store slices with cached external-store snapshots.
- Added a process-level runtime controller for native view, session handle, channel, input pump, frame, visibility, and handler registries.
- Replaced the TerminalPanel prop bundle with `scope`, `commands`, `graphNode`, and the existing imperative ref; retained Graph as an injected render slot.
- Extended the production MainApp render harness to prove terminal task/tab/context publishes do not re-render MainApp, DocumentList, or ActivityRail.

## Task Commits

1. **Task 1: Split observable terminal state from mutable runtime resources** - `ed34977` (test), `1d7ce9f` (feat)
2. **Task 2: Replace the shell bundle with scope, commands, graphNode, and ref** - `c21a7ca` (test), `263038a` (feat)

## Files Created/Modified

- `src/lib/terminalPanelStore.ts` - process-global terminal slices and stable subscriptions.
- `src/lib/terminalRuntimeController.ts` - mutable runtime-resource registry and disposal ownership.
- `src/lib/terminalSurfaceAdapter.ts` - least-authority terminal shell command port.
- `src/components/TerminalPanel.tsx` - store-backed four-input terminal facade.
- `src/App.tsx` - terminal slice hydration, command port, and narrowed panel call site.
- `src/lib/terminalPanelStore.test.ts` - store continuity, identity, and transient-exclusion tests.
- `src/__tests__/editorSurfaceRenderIsolation.test.tsx` - exact boundary and real-shell terminal isolation coverage.

## Decisions Made

- Kept process continuity in the observable terminal store while publishing active launch context separately.
- Preserved 05-02 generation-bearing handle use by retaining session-handle registries outside React snapshots.
- Left DOM, pointer, focus, search, menu, and immediate resize-draft state component-local.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Restored stable React refs around controller-owned registries**
- **Found during:** Task 1
- **Issue:** Direct object wrappers around controller registries invalidated existing hook dependency guarantees.
- **Fix:** Kept controller-owned maps while wrapping them with stable `useRef` identities, and updated the affected hook dependency arrays.
- **Files modified:** `src/components/TerminalPanel.tsx`
- **Verification:** `pnpm lint`, focused terminal tests, and `make verify` passed.
- **Committed in:** `1d7ce9f`

**Total deviations:** 1 auto-fixed (Rule 1)

## Issues Encountered

- `cargo test terminal` reports four existing warnings in `today_ai.rs` and `scheduler.rs`; no changed file is involved and the terminal suite passes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Terminal state is now available through stable process-global slices and a narrow shell facade for subsequent panel/mode decomposition.
- No known stubs or new threat surfaces were introduced.

## Self-Check: PASSED

- All seven plan-owned source and test files exist.
- All four task commits are present in git history.
