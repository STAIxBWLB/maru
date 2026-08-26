---
phase: 05-shell-decomposition-completion
reviewed: 2026-08-26T22:03:52Z
depth: standard
files_reviewed: 65
files_reviewed_list:
  - scripts/check-bundle-budget.mjs
  - scripts/check-shell-extensibility.mjs
  - src-tauri/src/terminal/mod.rs
  - src/__tests__/editorSurfaceRenderIsolation.test.tsx
  - src/App.tsx
  - src/components/DocumentList.test.tsx
  - src/components/DocumentList.tsx
  - src/components/gap/GapPane.tsx
  - src/components/OutlinePane.tsx
  - src/components/TerminalPanel.tsx
  - src/lib/agentRuntimeModeStore.test.ts
  - src/lib/agentRuntimeModeStore.ts
  - src/lib/api.ts
  - src/lib/communicationsModeLifecycle.ts
  - src/lib/communicationsModeStore.test.ts
  - src/lib/communicationsModeStore.ts
  - src/lib/documentBrowserStore.test.ts
  - src/lib/documentBrowserStore.ts
  - src/lib/documentOpsModeLifecycle.ts
  - src/lib/documentOpsModeStore.test.ts
  - src/lib/documentOpsModeStore.ts
  - src/lib/documentShellLifecycle.ts
  - src/lib/draftGapModeAdapters.test.ts
  - src/lib/editorDocumentLifecycle.ts
  - src/lib/knowledgeModeStore.test.ts
  - src/lib/knowledgeModeStore.ts
  - src/lib/modeAdapters/AgentsModeAdapter.tsx
  - src/lib/modeAdapters/CatalogModeAdapter.tsx
  - src/lib/modeAdapters/CommsModeAdapter.tsx
  - src/lib/modeAdapters/DashboardModeAdapter.tsx
  - src/lib/modeAdapters/DiagramModeAdapter.tsx
  - src/lib/modeAdapters/DraftsModeAdapter.tsx
  - src/lib/modeAdapters/E2EFlowModeAdapter.tsx
  - src/lib/modeAdapters/FilesModeAdapter.tsx
  - src/lib/modeAdapters/GapModeAdapter.tsx
  - src/lib/modeAdapters/GraphModeAdapter.tsx
  - src/lib/modeAdapters/InboxModeAdapter.tsx
  - src/lib/modeAdapters/MeetingsModeAdapter.tsx
  - src/lib/modeAdapters/PkmModeAdapter.tsx
  - src/lib/modeAdapters/ScratchpadModeAdapter.tsx
  - src/lib/modeAdapters/SitesModeAdapter.tsx
  - src/lib/modeAdapters/StudioModeAdapter.tsx
  - src/lib/modeAdapters/TasksModeAdapter.tsx
  - src/lib/modeAdapters/TodayModeAdapter.tsx
  - src/lib/modeRegistry.test.ts
  - src/lib/modeRegistry.tsx
  - src/lib/outlinePaneLifecycle.ts
  - src/lib/outlinePaneStore.test.ts
  - src/lib/outlinePaneStore.ts
  - src/lib/planningModeStore.test.ts
  - src/lib/planningModeStore.ts
  - src/lib/shellDecomposition.test.ts
  - src/lib/shellSettingsLifecycle.ts
  - src/lib/shellSettingsStore.test.ts
  - src/lib/shellSettingsStore.ts
  - src/lib/terminalPanelStore.test.ts
  - src/lib/terminalPanelStore.ts
  - src/lib/terminalRuntimeController.ts
  - src/lib/terminalSessionHandle.test.ts
  - src/lib/terminalSurfaceAdapter.ts
  - src/lib/terminalSurfaceLifecycle.ts
  - src/lib/useActiveMissions.ts
  - src/lib/visualModeStore.test.ts
  - src/lib/visualModeStore.ts
  - src/lib/workspaceBootLifecycle.ts
findings:
  critical: 2
  warning: 1
  info: 0
  total: 3
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-08-26T22:03:52Z
**Depth:** standard
**Files Reviewed:** 65
**Status:** issues_found

## Summary

The shell extraction preserves the terminal handle type boundary, but it regresses the Graph mode's independent data lifecycle and introduces synchronous external-store writes during `MainApp` rendering. The new document-browser singleton also is not released when a workspace is removed. The current tests primarily assert architecture/source shape, so these runtime paths can pass the existing gates.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Graph mode no longer loads or watches its actual graph workspace

**Classification:** BLOCKER

**File:** `src/lib/modeAdapters/GraphModeAdapter.tsx:32-38`

**Issue:** The adapter resolves `graphDataPath` and reads `workspaceStates[graphDataPath]`, but it never starts the cache/authoritative scan or `useVaultWatcherSync` lifecycle that was removed from `MainApp`. For the normal nested-vault case, that path is not the active workspace and has no other loader, so Graph opens with an empty model and subsequent filesystem changes are never observed. In addition, the new `onGraphChanged` callbacks rescan `inboxWorkspacePath`/`settingsWorkPath`, not this resolved `graphDataPath`, at `src/App.tsx:7169-7171` and `src/App.tsx:8289-8291`; applying a graph relation therefore cannot refresh the graph's own index.

**Fix:** Move the previous graph cache scan, authoritative rescan, and watcher subscription into `GraphModeAdapter`, keyed by its resolved `graphDataPath` and visibility. Keep the adapter's own current-path/generation guard. Expose a graph-local refresh callback from that adapter (or pass the resolved data path through a narrow port) so `onGraphChanged` rescans exactly `graphDataPath`. Add a runtime test opening a nested vault that has not previously been loaded, then asserting initial entries and a watcher delta reach `GraphView`.

### CR-02: Mode host stores are synchronously mutated during `MainApp` render

**Classification:** BLOCKER

**File:** `src/App.tsx:7356`, `src/App.tsx:7458`, `src/App.tsx:7552`, `src/App.tsx:7997-8069`

**Issue:** These `bind*` calls notify `useSyncExternalStore` subscribers while `MainApp` is still rendering. The document-ops call is especially unconditional: it constructs a fresh nested host/prop object each render, and `documentOpsModeController.bind()` treats the changed object identities as new snapshots (`src/lib/documentOpsModeStore.ts:140-145`). Once Files, Studio, or Catalog is mounted, any unrelated `MainApp` render synchronously schedules that adapter during the parent render, producing React's cross-component update warning and risking render churn/inconsistent pre-commit snapshots. The communications and planning bindings have the same invalid render-time publication path when their memoized hosts change.

**Fix:** Build stable host objects with `useMemo`, then publish them from `useLayoutEffect` (or a dedicated non-render bridge component) with complete dependencies. Do this for document-ops, communications, and planning bindings; the adapter should render `null` or a prior compatible host until the effect publishes. Add an integration test that mounts the active adapter, triggers an unrelated shell render, and asserts no React render-phase update warning and no extra adapter publication.

## Warnings

### WR-01: Removed workspace leaves document-browser singleton state and reveal intents live

**Classification:** WARNING

**File:** `src/lib/documentBrowserStore.ts:302-314`; `src/App.tsx:3758-3762`

**Issue:** `cleanupDocumentBrowserWorkspace()` is implemented but has no production caller. Removing a workspace clears workspace, tab, and editor-surface records, but retains its document index, selection, favorites snapshot, and any nonce-bearing reveal intent in the global browser store. Re-adding the same path can render the stale snapshot before the post-render publisher catches up, and repeated add/remove cycles leak every old workspace snapshot.

**Fix:** Import and invoke `cleanupDocumentBrowserWorkspace(path)` in `handleRemoveWorkspace` alongside `removeWorkspaceState` and editor-surface cleanup. Add a lifecycle test that publishes browser state and a reveal intent, removes the workspace, then confirms a fresh scope returns `EMPTY_STATE` with no pending intent.

---

_Reviewed: 2026-08-26T22:03:52Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
