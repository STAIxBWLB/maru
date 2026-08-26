---
phase: 04-editor-surface-state-extraction
reviewed: 2026-08-25T23:53:22Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - src/App.tsx
  - src/__tests__/editorSurfaceRenderIsolation.test.tsx
  - src/components/EditorPane.test.tsx
  - src/components/EditorPane.tsx
  - src/components/OutlinePane.tsx
  - src/lib/editorPaneStore.ts
  - src/lib/editorSurfaceAdapter.ts
  - src/lib/editorSurfacePersistence.ts
  - src/lib/editorSurfaceStore.test.ts
  - src/lib/outlinePaneStore.test.ts
  - src/lib/outlinePaneStore.ts
findings:
  critical: 0
  warning: 1
  info: 0
  total: 1
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-08-25T23:53:22Z
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

The editor and outline facade migration was reviewed at standard depth, including its command ports, persistence bridge, and focused contract tests. The focused test suite passed (24 tests), but the App shell now publishes external-store updates while React is rendering. This can notify an already-mounted `EditorPane` from its parent render and produces unsupported render-phase updates.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Editor facade is mutated during `MainApp` render

**File:** `src/App.tsx:8310`
**Issue:** `renderEditorPane` runs during `MainApp`'s render and calls `setEditorPanePresentation` plus `patchEditorPaneViewPreview`. Those functions synchronously notify `useSyncExternalStore` subscribers (`src/lib/editorPaneStore.ts:267-270` and `src/lib/editorPaneStore.ts:297-305`). When the same scope is already mounted, a change such as save/opening state, document label, or entries dispatches a subscriber update while React is rendering its parent. React may warn about updating `EditorPane` while rendering `MainApp`, and can defer the child snapshot so the editor briefly renders stale state.

**Fix:** Publish facade presentation and view state in a `useLayoutEffect` (keyed by a stable scope identity and the individual slice values), or make the render-time facade read pure and defer notification until after commit. Do not invoke subscriber callbacks from `renderEditorPane`.

---

_Reviewed: 2026-08-25T23:53:22Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
