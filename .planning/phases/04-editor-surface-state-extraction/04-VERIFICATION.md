---
phase: 04-editor-surface-state-extraction
verified: 2026-08-26T00:10:52Z
status: gaps_found
score: 3/4 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "Typing in the editor does not re-render DocumentList, TerminalPanel, or the activity rail"
    status: failed
    reason: "MainApp still subscribes to the changing document-tab array, so every real draft update re-renders MainApp. The activity rail is rendered inline from MainApp through a non-memoized ActivityModeButton, so it re-renders on each edit. The green isolation test mounts synthetic sibling probes instead of MainApp and therefore cannot exercise this path."
    artifacts:
      - path: "src/App.tsx"
        issue: "MainApp calls useDocTabs() at line 808 and emits the activity rail inline at line 8485; ActivityModeButton is an ordinary function at line 583."
      - path: "src/__tests__/editorSurfaceRenderIsolation.test.tsx"
        issue: "The test's ShellProbe components are static siblings of EditorProbe, not the actual MainApp, DocumentList, TerminalPanel, or activity rail."
      - path: "src/lib/editorTabsStore.ts"
        issue: "updateTabDraft publishes a replacement tabs array, which changes the useDocTabs() snapshot consumed by MainApp."
    missing:
      - "Remove the draft-changing useDocTabs subscription from the shell render path or isolate the shell surfaces behind real memoized/store-backed boundaries."
      - "Replace the synthetic probe with a MainApp-level render-counter regression that edits a real tab and observes DocumentList, TerminalPanel, and the activity rail."
---

# Phase 4: Editor Surface State Extraction Verification Report

**Phase Goal:** The two highest-arity panes own their state, and editing stops re-rendering the whole shell.
**Verified:** 2026-08-26T00:10:52Z
**Status:** gaps_found
**Re-verification:** No, initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `OutlinePane` reads pane state from module stores with a small prop list. | VERIFIED | `OutlinePaneProps` has exactly `scope`, `commands`, `paneRef`, and `slots`; the component reads five `useOutline*Slice` hooks. `outlinePaneStore.ts` provides workspace-keyed slice subscriptions and `App.tsx` hydrates/cleans the facade. Focused contract passed. |
| 2 | `EditorPane` reads pane state from module stores with a small prop list. | VERIFIED | `EditorPaneProps` has four structural props and reads document, tabs, view, operation, and presentation through `useEditor*Slice` hooks. `editorPaneStore.ts` composes canonical draft data from `editorTabsStore`, while `EditorPaneFacade` publishes shell presentation after commit. Focused contract passed. |
| 3 | Typing in either editor does not re-render `DocumentList`, `TerminalPanel`, or the activity rail. | FAILED | A real `updateTabDraft()` replaces `editorTabsState.tabs`; `MainApp` calls `useDocTabs()` and therefore re-renders. Its activity rail is inline and uses non-memoized `ActivityModeButton`. The passing test only counts synthetic sibling `ShellProbe`s, so it does not cover the actual shell route. |
| 4 | `EditorPane` has a regression test preserving preview marks and exact marked-node identity after an unrelated update. | VERIFIED | `EditorPane.test.tsx` renders an actual `EditorPane`, updates the operation slice, asserts the same `mark.kg-ref-mark` element object, and checks the find mark remains. `EditorPane.tsx` memoizes `previewMarkup` solely on `previewHtml` and React owns the `dangerouslySetInnerHTML` sink. Focused contract passed. |

**Score:** 3/4 truths verified (0 present, behavior-unverified)

## Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/lib/outlinePaneStore.ts` | Keyed stable Outline facade | VERIFIED | 441 substantive lines; separate document/file-queue/operation/sidebar/explorer subscriber maps, no-op guards, workspace cleanup, and `useSyncExternalStore` hooks. |
| `src/lib/editorPaneStore.ts` | Keyed stable Editor facade | VERIFIED | 475 substantive lines; `{workspacePath, group, tabId}` keys, canonical draft composition, domain notifications, guarded view-mode hydration, and tab/group/workspace cleanup. |
| `src/lib/editorSurfaceAdapter.ts` | Least-authority command ports | VERIFIED | 319 substantive lines; command factories obtain the current state at invocation and route effects back to the shell. |
| `src/lib/editorSurfacePersistence.ts` | Existing settings bridge | VERIFIED | 124 substantive lines; uses App request IDs, persists only `rightPaneTab` and `editorPaneViewModes`, and cleans both facade stores. |
| `src/components/OutlinePane.tsx` | Facade-driven Outline surface | VERIFIED | Imports and consumes the five Outline store hooks; four-prop AST contract passes. |
| `src/components/EditorPane.tsx` | Facade-driven Editor surface | VERIFIED | Imports and consumes five Editor store hooks; four-prop AST contract passes. |
| `src/__tests__/editorSurfaceRenderIsolation.test.tsx` | Real shell render isolation proof | FAILED | It proves store-domain notification isolation only; it does not mount the actual shell components named by SHELL-03. |
| `src/components/EditorPane.test.tsx` | Preview identity regression | VERIFIED | Actual rendered-node identity assertion passes. |
| `src/components/EditorPaneFacade.tsx` | Post-commit presentation publication | VERIFIED | Uses `useLayoutEffect`; the dedicated facade regression passed after `9b23e8f`. |

## Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `OutlinePane.tsx` | `outlinePaneStore.ts` | `useOutline*Slice(scope)` | WIRED | Five keyed hooks are imported and rendered from the component. |
| `OutlinePane.tsx` | `editorSurfaceAdapter.ts` | `OutlinePaneCommands` | WIRED | The only cross-surface actions use the typed command port. |
| `editorPaneStore.ts` | `editorTabsStore.ts` | canonical tabs/drafts | WIRED | `getEditorPaneState()` reads current tab-store state and `updateEditorPaneDraft()` delegates to `updateTabDraft()`. |
| `EditorPane.tsx` | `editorPaneStore.ts` | `useEditor*Slice(scope)` | WIRED | The component uses document, tabs, view/preview, operation, and presentation slices. |
| `EditorPane.tsx` | React preview DOM | `useMemo([previewHtml])` + `dangerouslySetInnerHTML` | WIRED | Exact implementation and behavioral identity test are present. |
| draft edit | actual shell isolation | `editorTabsStore -> MainApp` | NOT WIRED CORRECTLY | The remaining `useDocTabs()` subscription at `App.tsx:808` invalidates the shell; no real-shell counter protects this path. |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| `OutlinePane` | document/draft | `editorTabsStore` through `useDocTabs` and active IDs | Yes | FLOWING |
| `EditorPane` | document/tab/draft | `editorTabsStore` through `getEditorTabsState` and `updateTabDraft` | Yes | FLOWING |
| `EditorPane` | transient view/operation/presentation | keyed `editorPaneStore` state and post-commit facade publication | Yes | FLOWING |
| shell activity rail | draft update invalidation | `MainApp.useDocTabs()` | Yes, but undesired | FAILED isolation |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Facade contracts, prop budgets, preview identity, facade publication | `pnpm exec vitest run src/lib/outlinePaneStore.test.ts src/lib/editorSurfaceStore.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx src/components/EditorPane.test.tsx src/components/EditorPaneFacade.test.tsx` | 5 files, 25 tests passed | PASS |
| Repository verification gate | `make verify` | Completed typecheck, lint, frontend tests, Rust tests, clippy, production build, and bundle checks without an observed failure | PASS |
| Browser end-to-end suite | `pnpm test:e2e` | 203 tests completed; `test-results/.last-run.json` records `status: passed`. This still does not prove SHELL-03 because the suite does not mount a render counter for the real shell. | PASS, NOT EVIDENCE FOR GAP |

## Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| SHELL-01 | 04-01, 04-02, 04-03, 04-06 | `OutlinePane` reads module-store state instead of the ~71-prop bundle. | SATISFIED | Four structural props, keyed facade hooks, current-snapshot command port, guarded persistence/cleanup contracts. |
| SHELL-02 | 04-01, 04-04, 04-05, 04-06 | `EditorPane` reads module-store state instead of the ~55-prop bundle. | SATISFIED | Four structural props, keyed facade hooks, canonical `editorTabsStore` draft ownership, and stable command port. |
| SHELL-03 | 04-01, 04-02, 04-03, 04-04, 04-05, 04-06 | Typing no longer re-renders unrelated panes. | BLOCKED | The actual App shell continues to subscribe to changing drafts and re-renders the inline activity rail. Synthetic counter test misses this route. |
| SHELL-04 | 04-01, 04-05, 04-06 | Component test covers preview-mark regression. | SATISFIED | Actual `EditorPane` test asserts mark classes and exact node identity after operation update. |

All requirement IDs declared by Phase 4 plan frontmatter are accounted for. No orphaned Phase 4 requirement was found in `REQUIREMENTS.md`.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `src/__tests__/editorSurfaceRenderIsolation.test.tsx` | 67-80 | Synthetic shell probes instead of real shell components | BLOCKER | Produces a green isolation result while the user-visible shell still re-renders on a real draft update. |

No unreferenced `TBD`, `FIXME`, or `XXX` markers were found in Phase 4 source/test files. No CSS, dependency-manifest, Tauri backend, or new settings-key change was introduced by the Phase 4 source commits. The unrelated dirty `docs/design-qa/*.png` files were preserved and not examined as Phase 4 work.

## Gaps Summary

The facade extraction is substantively implemented and its preview regression is real. However, the phase's central performance outcome is not achieved: a document draft update still changes the `useDocTabs()` snapshot consumed at the top of `MainApp`, which re-executes the inline activity rail. The current render-isolation test cannot falsify that behavior because it replaces the real shell with inert sibling probes.

This is not deferrable to a later phase: no later milestone criterion specifically commits to removing the remaining `MainApp` draft subscription or adding an actual-shell render-isolation regression. It is therefore a BLOCKER for Phase 4 completion.

---

_Verified: 2026-08-26T00:10:52Z_
_Verifier: the agent (gsd-verifier)_
