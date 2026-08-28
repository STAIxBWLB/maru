---
phase: 04-editor-surface-state-extraction
verified: 2026-08-26T03:50:00Z
status: passed
score: 4/4 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/4
  gaps_closed:
    - "Typing in the editor does not re-render DocumentList, TerminalPanel, or the activity rail."
  gaps_remaining: []
  regressions: []
---

# Phase 4: Editor Surface State Extraction Verification Report

**Phase Goal:** The two highest-arity panes own their state, and editing stops re-rendering the whole shell.
**Verified:** 2026-08-26T03:50:00Z
**Status:** passed
**Re-verification:** Yes, after 04-07 gap closure and `d49235b` test hardening

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `OutlinePane` reads pane state from module stores with a small prop list. | VERIFIED | `OutlinePaneProps` has four structural entries (`scope`, `commands`, `paneRef`, `slots`) and [OutlinePane.tsx](../../../src/components/OutlinePane.tsx) reads document, file-queue, operation, sidebar, and explorer slices from the keyed facade. `outlinePaneStore.ts` is substantive (441 lines) and the focused facade contracts passed. |
| 2 | `EditorPane` reads pane state from module stores with a small prop list. | VERIFIED | `EditorPaneProps` has four structural entries and [EditorPane.tsx](../../../src/components/EditorPane.tsx) reads document, tabs, view/preview, operation, and presentation through keyed `useEditor*Slice` hooks. `updateEditorPaneDraft()` delegates canonical draft ownership to `editorTabsStore`; it does not duplicate drafts. Focused contracts passed. |
| 3 | Typing in the editor does not re-render `DocumentList`, `TerminalPanel`, or the activity rail. | VERIFIED | The real `MainApp` remains subscribed to `useDocTabs()` and therefore re-executes after `updateTabDraft()`, but the three named production boundaries are memoized and receive stable props. The current jsdom regression mounts actual `MainApp`, requires a nonzero baseline for `MainApp`, `DocumentList`, `TerminalPanel`, and `ActivityRail`, dispatches real `editorTabsStore.updateTabDraft()` calls for both groups, proves `MainApp` rises after the first update, and proves all three unrelated boundaries remain exactly at baseline. This ran in the current checkout. |
| 4 | `EditorPane` has a regression test preserving preview marks and exact marked-node identity after an unrelated update. | VERIFIED | The actual component test renders `EditorPane`, patches only its operation slice, verifies the original `mark.kg-ref-mark` object is still the same DOM node, and confirms the find mark remains. `previewMarkup` is memoized solely on `previewHtml` and is consumed by React's existing `dangerouslySetInnerHTML` sink. |

**Score:** 4/4 truths verified (0 present but behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/lib/outlinePaneStore.ts` | Keyed stable Outline facade | VERIFIED | 441 substantive lines; workspace-keyed state, per-domain subscribers, no-op identity guards, guarded hydration, and workspace cleanup. |
| `src/lib/editorPaneStore.ts` | Keyed stable Editor facade | VERIFIED | 475 substantive lines; `{workspacePath, group, tabId}` keys, canonical draft delegation, separate render domains, and tab/group/workspace cleanup. |
| `src/lib/editorSurfaceAdapter.ts` | Least-authority command ports | VERIFIED | 319 substantive lines; command factories read current state at invocation and route shell effects through typed ports. |
| `src/lib/editorSurfacePersistence.ts` | Existing settings bridge | VERIFIED | 124 substantive lines; persists only `rightPaneTab` and `editorPaneViewModes`, uses App's existing request identity, and cleans both facades. |
| `src/components/OutlinePane.tsx` | Facade-driven Outline surface | VERIFIED | Four structural props and five facade slice hooks; no individual state/change-callback prop bundle remains. |
| `src/components/EditorPane.tsx` | Facade-driven Editor surface | VERIFIED | Four structural props, five facade hooks, canonical tab-store draft path, and React-owned preview markup. |
| `src/App.tsx` | Memoized real shell boundaries with stable callback props | VERIFIED | `ActivityRail` is a production `memo` boundary; DocumentList and TerminalPanel are supplied from the real `MainApp` route with hoisted callback identities. |
| `src/lib/shellSurfaceRenderProbe.ts` | No-op production render observer seam | VERIFIED | 29-line module; observer is null by default and only test setup can install it. It reports only boundary names and cannot alter user state or rendering. |
| `src/__tests__/editorSurfaceRenderIsolation.test.tsx` | Non-vacuous MainApp isolation regression | VERIFIED | Imports real `MainApp` and `editorTabsStore`; no `ShellProbe` or component replacement exists. It demands nonzero counters before assertions and covers left and right draft publishes. |
| `src/components/EditorPane.test.tsx` | Preview identity regression | VERIFIED | Uses actual `EditorPane` and exact-node (`toBe`) identity assertion after an unrelated operation update. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `OutlinePane.tsx` | `outlinePaneStore.ts` | `useOutline*Slice(scope)` | WIRED | Five scoped store hooks are imported and used from the production component. |
| `OutlinePane.tsx` | `editorSurfaceAdapter.ts` | `OutlinePaneCommands` | WIRED | Cross-surface Outline actions cross the typed command port. |
| `editorPaneStore.ts` | `editorTabsStore.ts` | `getEditorTabsState` and `updateTabDraft` | WIRED | The facade reads current canonical tab state and `updateEditorPaneDraft()` delegates the write; drafts are not copied into facade-local state. |
| `EditorPane.tsx` | `editorPaneStore.ts` | `useEditor*Slice(scope)` | WIRED | Production component consumes all five render-domain hooks. |
| `EditorPane.tsx` | React preview DOM | `useMemo([previewHtml])` plus `dangerouslySetInnerHTML` | WIRED | Exact source assertion and component DOM-identity test passed. |
| `editorTabsStore.updateTabDraft` | real `MainApp` | `useDocTabs()` replacement snapshot | WIRED | The test observes the real `MainApp` counter increase after the first actual store publish. |
| real `MainApp` | `DocumentList`, `TerminalPanel`, `ActivityRail` | `React.memo` production boundaries and stable props | WIRED | The mounted production components start at nonzero render counts and remain at exactly those counts through the first, repeated-left, and independent-right draft updates. |

### Data-Flow Trace

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| `OutlinePane` | document, draft, queue, sidebar, explorer | keyed facade slices composed from live workspace/tab state | Yes | FLOWING |
| `EditorPane` | active document, draft, tabs, operation, transient view state | canonical `editorTabsStore` plus keyed local facade state | Yes | FLOWING |
| shell render regression | draft publication | real `updateTabDraft()` against the live editor-tab store | Yes | FLOWING |
| shell boundary counters | production render calls | `MainApp`, `DocumentList`, `TerminalPanel`, and `ActivityRail` call the same no-op-by-default observer | Yes | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Facade contracts, prop budgets, real-shell isolation, preview identity, and facade publication | `pnpm exec vitest run src/lib/outlinePaneStore.test.ts src/lib/editorSurfaceStore.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx src/components/EditorPane.test.tsx src/components/EditorPaneFacade.test.tsx` | 5 files, 25 tests passed | PASS |
| Full repository verification | `make verify` | typecheck, ESLint, release/icon/i18n guards, frontend tests, Rust tests, rustfmt, clippy, production build, and bundle checks passed | PASS |
| Browser end-to-end suite | `pnpm test:e2e` | 203 tests passed; `test-results/.last-run.json` records `status: passed` | PASS |
| Diff hygiene | `git diff --check` | no whitespace errors | PASS |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| SHELL-01 | 04-01, 04-02, 04-03, 04-06, 04-07 | `OutlinePane` reads module-store state instead of the ~71-prop bundle. | SATISFIED | Four structural props, keyed facade hooks, current-snapshot command port, and guarded persistence/cleanup tests. |
| SHELL-02 | 04-01, 04-04, 04-05, 04-06, 04-07 | `EditorPane` reads module-store state instead of the ~55-prop bundle. | SATISFIED | Four structural props, keyed facade hooks, canonical `editorTabsStore` draft ownership, and stable command port. |
| SHELL-03 | 04-01, 04-02, 04-03, 04-04, 04-05, 04-06, 04-07 | Typing no longer re-renders unrelated panes. | SATISFIED | Current real-MainApp regression provides nonzero production-boundary baselines, actual left/right store updates, required MainApp increase, and exact stability for DocumentList, TerminalPanel, and ActivityRail. |
| SHELL-04 | 04-01, 04-05, 04-06, 04-07 | `EditorPane` covers the preview-mark regression path. | SATISFIED | Actual EditorPane test asserts mark classes and exact node identity after an unrelated operation update; browser E2E also covers preview find marks through a re-render. |

All four requirement IDs declared by Phase 4 plan frontmatter are accounted for in `REQUIREMENTS.md`. No orphaned Phase 4 requirement exists.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| None | - | No unreferenced `TBD`, `FIXME`, or `XXX` marker in Phase 4 source/test scope. | - | No blocker found. |

## Re-verification Notes

The previous blocker was valid: it found a synthetic counter that could not observe the real shell and a non-memoized inline activity rail. The gap closure replaces that evidence path with production components. The observer has no production behavior until a test explicitly installs it, and the test fails if any named boundary did not mount, so the result cannot be a zero-count or inert-sibling pass.

`MainApp` still legitimately re-executes after a draft snapshot because it consumes `useDocTabs()`. The Phase 4 contract is that the unrelated named shell surfaces do not re-render; the regression test proves that behavior while separately requiring the `MainApp` counter to increase. The remaining broader `MainApp` decomposition is intentionally Phase 5 work, but none of its criteria are needed to satisfy Phase 4's explicit shell-isolation contract.

No CSS, visible copy, dependency, settings schema, Tauri/Rust, save/conflict, or lazy-mode import path changed after the previously observed native Tauri/WKWebView smoke. The direct native smoke remains valid evidence for those unchanged paths, and the fresh automated suites above cover the changed React boundary wiring.

---

_Verified: 2026-08-26T03:50:00Z_
_Verifier: the agent (gsd-verifier)_
