---
phase: 04-editor-surface-state-extraction
plan: "06"
subsystem: ui
tags: [react, tauri, wkwebview, playwright, vitest, editor, state-isolation]
requires:
  - phase: 04-01
    provides: Activation-gated editor-surface contracts and native-smoke acceptance criteria
  - phase: 04-05
    provides: Facade-driven EditorPane command boundary and automated render-isolation evidence
provides:
  - Final automated, browser, bundle, and real-Tauri verification evidence for the editor-surface extraction
  - Regression coverage for transient HTML mode and risk acknowledgement updates in the Editor facade
affects: [phase-04-verification, shell-decomposition, editor-surface-state-extraction]
actuals:
  tokens: 267
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns:
    - Keyed facade transient slices are the single render source and are not reset from legacy App state on parent renders
    - Native WKWebView smoke complements Chromium-mocked IPC coverage for filesystem save and revision-conflict behavior
key-files:
  created:
    - .planning/phases/04-editor-surface-state-extraction/04-06-SUMMARY.md
  modified:
    - src/App.tsx
    - src/lib/editorPaneStore.ts
    - src/lib/editorSurfaceStore.test.ts
key-decisions:
  - "Keep HTML view mode and risk acknowledgement facade-local after extraction; App no longer replays obsolete htmlPaneModes values into an EditorPane render."
  - "Accept the phase only after one isolated real-Tauri smoke proves the filesystem save and conflict-recovery paths that Chromium mocks cannot cover."
patterns-established:
  - "When a local facade domain changes, cached snapshots retain only unchanged domain identities."
  - "Native smoke uses a distinct debug bundle and disposable workspace so installed production state is untouched."
requirements-completed: [SHELL-01, SHELL-02, SHELL-03, SHELL-04]
coverage:
  - id: D1
    description: Outline and Editor prop boundaries remain below the hard eight-prop budget with unchanged Outline navigation behavior.
    requirement: SHELL-01
    verification:
      - kind: unit
        ref: src/lib/outlinePaneStore.test.ts#keeps OutlinePane within the structural prop budget
        status: pass
      - kind: manual_procedural
        ref: real Tauri smoke, Outline heading activation and source navigation
        status: pass
    human_judgment: false
  - id: D2
    description: The keyed Editor facade preserves left/right tab, draft, and mode separation through a real split-pane workflow.
    requirement: SHELL-02
    verification:
      - kind: unit
        ref: src/lib/editorSurfaceStore.test.ts#keeps EditorPane within the structural prop budget
        status: pass
      - kind: manual_procedural
        ref: real Tauri smoke, split typing, modes, restart, cleanup, and persistence
        status: pass
    human_judgment: false
  - id: D3
    description: Typing and operation updates are isolated to their subscribed render domains and do not bleed between editor groups or shell probes.
    requirement: SHELL-03
    verification:
      - kind: automated_ui
        ref: src/__tests__/editorSurfaceRenderIsolation.test.tsx
        status: pass
      - kind: e2e
        ref: pnpm test:e2e, 203 passed
        status: pass
      - kind: manual_procedural
        ref: real Tauri smoke, independent split drafts and focus
        status: pass
    human_judgment: false
  - id: D4
    description: Preview marks remain React-owned with exact marked-node identity, while native Rich/Source/Preview transitions retain content and focus.
    requirement: SHELL-04
    verification:
      - kind: automated_ui
        ref: src/components/EditorPane.test.tsx#retains preview marks and the same marked DOM node through an unrelated operation update
        status: pass
      - kind: manual_procedural
        ref: real Tauri smoke, Rich Source Preview cycle and preview inspection
        status: pass
    human_judgment: false
metrics:
  duration: 10h 10min
  completed: 2026-08-26
status: complete
---

# Phase 04 Plan 06: Final Editor Surface Verification Summary

**The extracted Outline and Editor surfaces now have complete automated and real-WKWebView evidence for prop reduction, render isolation, preview identity, split editing, persistence, safe saves, and conflict recovery.**

## Performance

- **Duration:** 10h 10min
- **Started:** 2026-08-25T22:02:53Z
- **Completed:** 2026-08-26T08:12:00Z
- **Tasks:** 2/2
- **Files modified:** 4

## Accomplishments

- Ran the complete final evidence ladder: focused facade/component contracts, typecheck, `make verify`, browser E2E, diff checks, prop-budget inspection, and bundle/lazy-surface checks.
- Fixed a facade cache defect found by the final browser gate: transient HTML mode and risk acknowledgement updates now publish a fresh view slice, while App parent renders no longer overwrite that facade-local state from obsolete legacy values.
- Ran the one required native smoke in a real Tauri/WKWebView process using the distinct `Maru Smoke.app` bundle (`kr.maru.smoke`) and disposable Public Local Direct workspace. The installed production Maru process was not touched.
- Confirmed native Outline navigation, left/right isolation, Rich/Source/Preview transitions, save state and disk persistence, external-revision conflict recovery, lifecycle cleanup, restart persistence, and visual/IPC integrity.

## Task Commits

1. **Task 1: Run the complete automated contract and inspect the final lazy/bundle boundary** - `b8324f0` (fix)
2. **Task 2: Run the one focused real-Tauri smoke for the complete editor surface** - no code commit; native evidence recorded here

## Verification

- Focused four-file contract command passed immediately before native approval: 194 test files and 1,882 tests passed. No `PHASE4_WAVE0_CONTRACT` activation guard remains.
- `pnpm typecheck`, `make verify`, and `pnpm test:e2e` passed. The full browser run passed 203 tests; `make verify` included 1,882 frontend tests, 1,219 Rust tests, rustfmt, clippy, production build, and bundle budget checks.
- `OutlinePaneProps` and `EditorPaneProps` each expose 4 props, below the maximum 8. The focused harness pins left/right typing deltas and unchanged DocumentList, TerminalPanel, and activity-rail counters; operation publication wakes only its operation subscriber.
- The preview regression confirms both preview-mark classes and the exact marked DOM node survive an unrelated operation update.
- Production bundle output remained green: initial JS 298.9 KiB gzip of 320 KiB, initial CSS 61.2 KiB gzip of 70 KiB, with GraphView, RichMarkdownEditor, and dictionaries retained as lazy chunks. `git diff --check` passed.

## Native Smoke Evidence

- **Outline:** PASS. `beta.md` opened and its headings appeared in source order: `Phase 4 Smoke Beta`, `Independent Pane`, `Final Section`. Activating `Final Section` focused and scrolled Source to the exact `## Final Section` line without geometry changes.
- **Split isolation:** PASS. A right split opened with left beta Source and right alpha in a different tab/mode. Each pane showed only its own draft marker; focus and modes did not cross groups.
- **Modes and restart:** PASS. Right alpha completed Source -> Rich -> Preview with unchanged content while left remained Source. A fresh-process restart restored the split plus independent pane tab/mode state; Preview showed the expected headings/body with no focus leakage.
- **Save:** PASS. Editing beta added `Saved beta marker.`; UI moved `저장됨` -> `저장 필요`, enabled Save, then returned to `저장됨` with Save disabled. The saving transition was faster than one accessibility snapshot, but completion state was observed and disk inspection confirmed the marker at line 15.
- **Conflict recovery:** PASS. After an external alpha edit changed `Alpha opening paragraph.` to `External alpha edit.`, a distinct Maru draft added `Maru conflict draft marker.`. Save displayed `document_conflict: expected revision ... found ...`; Maru retained `저장 필요` and its draft marker, while disk contained only the external edit at line 9 and no Maru marker.
- **Cleanup and persistence:** PASS. Closing right alpha collapsed the split. Public -> Private switching showed no conflict banner or dirty-operation bleed. Returning and reopening alpha recovered its scoped dirty conflict draft; selecting clean beta and reopening right created a clean Source scope without stale alpha state. The fresh-process restart also proved persisted split, right tab, and independent modes.
- **Visual/native integrity:** PASS. Outline/editor and final-split screenshots showed no visual or geometry regression. No Tauri, serde, or IPC error was emitted by the running app; stdout polling was empty. Electron `SecCodeCopyGuestWithAttributes ... ENOENT` appeared only in Orca's computer-use client, not Maru/Tauri.
- **Isolation and cleanup:** The smoke PID was stopped, the temporary workspace registration was removed with `activeByVisibility.public=null` verified by `jq`, the temporary directory moved to Trash, and no smoke process remained.

## Decisions Made

- Preserve HTML view/risk state solely in the keyed Editor facade after migration, preventing a parent App render from restoring stale legacy state.
- Treat the native smoke as required evidence, not a formality, because real WKWebView, filesystem persistence, and revision-conflict handling are outside Chromium mocked-IPC coverage.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Publish updated HTML transient state from the Editor facade**

- **Found during:** Task 1 browser E2E verification
- **Issue:** Cached `viewPreview` references survived an HTML mode/risk acknowledgement update, while later parent renders could replay stale legacy values. Five HTML editor E2E flows failed as a result.
- **Fix:** Rebuild the view slice when its local reference changes, retain only unchanged slice identities, and stop App from replaying legacy HTML mode/risk values into the facade. Added a store regression test.
- **Files modified:** `src/App.tsx`, `src/lib/editorPaneStore.ts`, `src/lib/editorSurfaceStore.test.ts`
- **Verification:** Focused contracts, typecheck, `make verify`, targeted HTML E2E, and full browser E2E all pass.
- **Committed in:** `b8324f0`

**Total deviations:** 1 auto-fixed Rule 1 correctness fix.

## Issues Encountered

- The first full Playwright run exposed five correlated HTML-editor failures. They were traced to the facade migration, fixed under Rule 1, and the full 203-test browser suite passed on rerun.

## Known Stubs

None. The changed source and verification artifact contain no incomplete UI data flow or placeholder implementation.

## User Setup Required

None - native verification used an isolated disposable workspace and required no external configuration.

## Next Phase Readiness

- Phase 04 has final deterministic and native evidence for SHELL-01 through SHELL-04.
- Phase 05 can extract the remaining shell surfaces while preserving the facade slice, command-port, and native-smoke patterns established here.

## Self-Check: PASSED

- Confirmed this summary exists and task commit `b8324f0` is present in git history.
- Confirmed the final working tree contains only this intentional planning artifact before metadata commit.

---

*Phase: 04-editor-surface-state-extraction*
*Completed: 2026-08-26*
