---
phase: 04-editor-surface-state-extraction
plan: "07"
subsystem: ui
tags: [react, tauri, render-isolation, editor-tabs, memoization]
requires:
  - phase: 04-editor-surface-state-extraction
    provides: OutlinePane and EditorPane facade stores with real editorTabsStore draft ownership
provides:
  - MainApp-level render-isolation coverage for production DocumentList, TerminalPanel, and ActivityRail boundaries
  - Stable callback props for the DocumentList shell boundary
  - No-op production render observer seam for focused regressions
affects: [phase-04-verification, app-shell, editor-tabs]
actuals:
  tokens: 7942
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns: [memoized production shell boundary, static render observer seam]
key-files:
  created: [src/lib/shellSurfaceRenderProbe.ts]
  modified: [src/App.tsx, src/components/DocumentList.tsx, src/components/TerminalPanel.tsx, src/__tests__/editorSurfaceRenderIsolation.test.tsx]
key-decisions:
  - "MainApp may observe editor tab snapshots, while unrelated shell surfaces are protected by stable production memo boundaries."
  - "Render instrumentation records only static component target names and is inactive unless a test installs an observer."
patterns-established:
  - "MainApp isolation tests mount the production boundary and publish real editorTabsStore drafts."
requirements-completed: [SHELL-01, SHELL-02, SHELL-03, SHELL-04]
coverage:
  - id: D1
    description: "Production DocumentList, TerminalPanel, and ActivityRail remain isolated during real left and right editor draft publishes."
    requirement: "SHELL-03"
    verification:
      - kind: unit
        ref: "src/__tests__/editorSurfaceRenderIsolation.test.tsx#keeps the real MainApp shell surfaces isolated for left and right draft publishes"
        status: pass
    human_judgment: false
  - id: D2
    description: "Outline and Editor facade prop/ownership contracts plus the preview marked-node identity invariant remain intact."
    requirement: "SHELL-01"
    verification:
      - kind: unit
        ref: "pnpm exec vitest run src/lib/outlinePaneStore.test.ts src/lib/editorSurfaceStore.test.ts src/components/EditorPane.test.tsx src/components/EditorPaneFacade.test.tsx"
        status: pass
    human_judgment: false
  - id: D3
    description: "The normal repository, browser, bundle, and diff hygiene gates remain green after the shell-boundary change."
    requirement: "SHELL-04"
    verification:
      - kind: other
        ref: "make verify; pnpm test:e2e; pnpm check:bundle-budget; git diff --check"
        status: pass
    human_judgment: false
duration: 13min
completed: 2026-08-26
status: complete
---

# Phase 4 Plan 7: Real Shell Render Isolation Summary

**MainApp now keeps the real DocumentList, TerminalPanel, and activity rail from executing on left or right editor draft publishes while the canonical tab-store and keyed editor facades remain current.**

## Performance

- **Duration:** 13 min
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added a no-op-by-default static-name render observer to the actual MainApp, DocumentList, TerminalPanel, and memoized ActivityRail implementations.
- Extracted the existing activity rail unchanged into a memoized production boundary and replaced all DocumentList inline callback props with current-snapshot-safe callbacks.
- Replaced synthetic shell probes with a real MainApp regression that performs clean-to-dirty, repeated-left, and independent-right `updateTabDraft()` publishes.

## RED/GREEN Evidence

- **RED baseline:** the prior verifier demonstrated that a real `updateTabDraft()` invalidated MainApp through `useDocTabs()` and re-executed the inline activity rail; the previous test only counted synthetic sibling `ShellProbe` components.
- **GREEN:** the new production-boundary test mounts exported `MainApp`, installs observers on actual component entries, and asserts all three shell counters remain unchanged after each real left/right publish while `getEditorTabsState()` and `getEditorPaneState()` expose current drafts.

## Task Commits

1. **Task 1: Protect and count the real MainApp shell surfaces on one draft-update path** - `05960d6` (`fix`)
2. **Task 2: Expand the real-shell regression to both editor groups and re-run the Phase 4 evidence ladder** - `d54fddc` (`test`)

## Verification

- `pnpm exec vitest run src/lib/outlinePaneStore.test.ts src/lib/editorSurfaceStore.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx src/components/EditorPane.test.tsx src/components/EditorPaneFacade.test.tsx` - PASS (5 files, 25 tests)
- `pnpm typecheck` - PASS
- `pnpm exec eslint src/App.tsx src/components/DocumentList.tsx src/components/TerminalPanel.tsx src/lib/shellSurfaceRenderProbe.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx --max-warnings 0` - PASS
- `make verify` - PASS
- `pnpm test:e2e` - PASS (203 tests)
- `pnpm check:bundle-budget` - PASS (initial JS 298.9 KiB gzip, CSS 61.2 KiB gzip; lazy GraphView, RichMarkdownEditor, and locale chunks retained)
- `git diff --check` - PASS

## Decisions Made

- MainApp remains the canonical subscriber for editor tab orchestration, but draft-only publishes cannot re-execute unrelated production shell surfaces with unchanged inputs.
- The render observer contains no document, workspace, callback, or prop data; tests restore its prior observer in cleanup.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Test harness] Stabilized the production MainApp mount in jsdom**
- **Found during:** Task 1
- **Issue:** The direct production mount exposed jsdom's incomplete localStorage shim and a null test IPC response for the logical-day watcher.
- **Fix:** Installed test-local localStorage methods and retained the real Today module while overriding only `todayLogicalDay` with a deterministic response.
- **Files modified:** `src/__tests__/editorSurfaceRenderIsolation.test.tsx`
- **Verification:** MainApp mounts with its real DocumentList, TerminalPanel, ActivityRail, and editorTabsStore path; focused test passes without unhandled errors.
- **Committed in:** `05960d6`

**Total deviations:** 1 auto-fixed (Rule 3 test harness).
**Impact on plan:** Required for deterministic production-boundary coverage only; no product behavior or production dependency changed.

## Issues Encountered

- The shared checkout had another long-running Cargo test process while `make verify` reached its Rust stage. It was preserved; the completed repository gate reported success.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The sole Phase 4 shell-isolation gap now has direct production-boundary evidence.
- A fresh `gsd-verifier` run should replace the previous `gaps_found` report; no hand edits were made to `04-VERIFICATION.md`.

## Self-Check: PASSED

- `src/lib/shellSurfaceRenderProbe.ts` exists and both task commits are present.
- No `docs/design-qa/*.png` file was staged or committed by this plan.
