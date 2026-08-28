---
phase: 04-editor-surface-state-extraction
plan: "05"
subsystem: ui
tags: [react, typescript, editor, facade-store, render-isolation, preview]
requires:
  - phase: 04-01
    provides: Activation-gated Editor facade contracts
  - phase: 04-04
    provides: Keyed Editor facade and guarded lifecycle persistence
provides:
  - EditorPane facade slices with a four-prop structural boundary
  - Stable least-authority EditorPaneCommands ports with current-scope dispatch
  - Automated two-group render-isolation and preview-node identity evidence
affects: [04-06, editor-surface-state-extraction]
actuals:
  tokens: 14148
  tasks: 2
  commits: 5
tech-stack:
  added: []
  patterns:
    - Keyed facade presentation slices with canonical editorTabsStore drafts
    - Stable command ports that dispatch through current App handlers
    - Per-domain render probes and React-owned preview identity regression tests
key-files:
  created: []
  modified:
    - src/lib/editorPaneStore.ts
    - src/lib/editorSurfaceAdapter.ts
    - src/components/EditorPane.tsx
    - src/App.tsx
    - src/components/EditorPane.test.tsx
    - src/__tests__/editorSurfaceRenderIsolation.test.tsx
key-decisions:
  - "EditorPane receives only scope, commands, and optional editor refs; all render values are read from keyed facade slices."
  - "EditorPaneCommands objects are stable across App renders and dispatch against current keyed scope and current shell handlers."
  - "Preview markup remains memoized solely on previewHtml and React remains the only preview DOM writer."
patterns-established:
  - "A facade-owned pure draft action may publish only the exact document domain while canonical drafts remain in editorTabsStore."
  - "Render-isolation counters must live in independent subscriber components so an operation update cannot inflate sibling-domain counts."
requirements-completed: [SHELL-02, SHELL-03, SHELL-04]
coverage:
  - id: D1
    description: EditorPane reads keyed facade slices and invokes cross-surface work through a distinct least-authority command port under the structural prop budget.
    requirement: SHELL-02
    verification:
      - kind: unit
        ref: src/lib/editorSurfaceStore.test.ts#Editor facade component migration contract
        status: pass
      - kind: other
        ref: pnpm typecheck
        status: pass
    human_judgment: false
  - id: D2
    description: Left and right editor typing updates only the owning document subscriber, and operation publication wakes only the operation subscriber.
    requirement: SHELL-03
    verification:
      - kind: automated_ui
        ref: src/__tests__/editorSurfaceRenderIsolation.test.tsx
        status: pass
      - kind: other
        ref: make verify
        status: pass
    human_judgment: false
  - id: D3
    description: Preview marks remain React-owned and retain their exact DOM node identity through an unrelated operation update.
    requirement: SHELL-04
    verification:
      - kind: automated_ui
        ref: src/components/EditorPane.test.tsx#retains preview marks and the same marked DOM node through an unrelated operation update
        status: pass
      - kind: other
        ref: make verify
        status: pass
    human_judgment: false
metrics:
  duration: 15min
  completed: 2026-08-25
status: complete
---

# Phase 04 Plan 05: Editor facade commands and render isolation Summary

**EditorPane now consumes keyed facade slices through a four-prop boundary, dispatches shell work through stable least-authority ports, and preserves preview marks without cross-pane render fan-out.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-08-25T21:44:00Z
- **Completed:** 2026-08-25T21:58:51Z
- **Tasks:** 2/2
- **Files modified:** 8

## Accomplishments

- Migrated EditorPane document, tab, view/preview, operation, and presentation reads onto exact keyed facade slices, leaving canonical drafts in editorTabsStore.
- Replaced the prop bundle with scope, stable EditorPaneCommands, and optional editor refs; asynchronous and cross-surface operations keep using App's retained authorization and orchestration paths.
- Activated and passed two-group typing counters, changed-domain-only publication, prop-budget checks, and direct EditorPane preview-mark DOM identity evidence.

## Task Commits

1. **Task 1: Migrate EditorPane to facade slices and its least-authority command port** - `48f6b0b` (test), `afc18a7` (feat)
2. **Task 2: Prove two-group render isolation and preview-mark DOM identity** - `e6b768e` (test), `db06add` (feat), `d7f1a93` (fix)

## Files Created/Modified

- `src/lib/editorPaneStore.ts` - Keyed presentation/domain APIs and exact-scope publication helpers.
- `src/lib/editorSurfaceAdapter.ts` - Complete EditorPaneCommands adapter with stable-dispatch support.
- `src/components/EditorPane.tsx` - Four-prop facade-driven editor surface and React-owned preview rendering.
- `src/App.tsx` - Shell presentation synchronization and current-handler dispatch refs for left/right ports.
- `src/lib/editorSurfaceStore.test.ts` - Activated command-port and prop-budget contract.
- `src/__tests__/editorSurfaceRenderIsolation.test.tsx` - Left/right typing and independent subscriber-count proof.
- `src/components/EditorPane.test.tsx` - Direct preview mark class and DOM-node identity regression.
- `src/__tests__/editorPreviewDebounce.test.tsx` - Existing debounce test migrated to the facade boundary.

## Decisions Made

- Keep canonical documents and draft writes in editorTabsStore; the facade publishes only the affected document render domain.
- Keep stable left/right ports in App and route each invocation through current scope plus current handler refs, preventing stale closures without prop rebuilding.
- Preserve the existing sanitized preview string and `previewMarkup` memoization; no imperative preview container mutation was introduced.

## Verification

- Red first: the activated Task 1 contracts reported the stale command snapshot and 55 EditorPane props; Task 2 contracts reported missing domain subscribe APIs.
- Passed focused facade/component contracts, `pnpm typecheck`, and scoped ESLint.
- Passed `make verify`, including frontend tests, Rust library tests, rustfmt, clippy, production build, and bundle checks.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Keep command-port identity stable across App renders**

- **Found during:** Task 2 final review
- **Issue:** The first facade wiring rebuilt EditorPaneCommands in the render factory, allowing unnecessary child invalidation and stale closure risk.
- **Fix:** Added stable left/right ports backed by current-scope and current-handler refs, then extended the adapter with a typed dispatch path.
- **Files modified:** `src/App.tsx`, `src/lib/editorSurfaceAdapter.ts`
- **Verification:** Focused contracts, TypeScript, ESLint, and `make verify` pass.
- **Committed in:** `d7f1a93`

**2. [Rule 1 - Bug] Separate render-domain probes in the isolation harness**

- **Found during:** Task 2 verification
- **Issue:** Four subscriptions in one probe component made every counter rise when any one domain published, masking the isolation contract.
- **Fix:** Rendered each domain subscriber as an independent probe component.
- **Files modified:** `src/__tests__/editorSurfaceRenderIsolation.test.tsx`
- **Verification:** The operation-only publication assertion passes with document, tabs, and view counters unchanged.
- **Committed in:** `db06add`

**Total deviations:** 2 auto-fixed Rule 1 correctness fixes. Both preserve the planned facade boundary and add no UI or product scope.

## Known Stubs

None. The stub scan found only intentional empty initializers, nullable test cleanup, and existing input placeholder text.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 04-06 can use the complete Editor facade boundary and its render-isolation contracts for final shell verification.
- No blocker remains for the phase's remaining plan.

## Self-Check: PASSED

- Confirmed all seven production/test artifacts and this summary exist.
- Confirmed task commits `48f6b0b`, `afc18a7`, `e6b768e`, `db06add`, and `d7f1a93` exist in git history.

---

*Phase: 04-editor-surface-state-extraction*
*Completed: 2026-08-25*
