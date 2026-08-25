# Phase 4: Editor Surface State Extraction - Pattern Map

**Mapped:** 2026-08-26
**Files analyzed:** 7
**Analogs found:** 7 / 7

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/outlinePaneStore.ts` | store | event-driven | `src/lib/appOverlayStore.ts` | exact |
| `src/lib/editorPaneStore.ts` | store | event-driven | `src/lib/editorTabsStore.ts` | exact |
| `src/lib/editorSurfacePersistence.ts` | service | request-response | `src/App.tsx` | role-match |
| `src/components/OutlinePane.tsx` | component | request-response | `src/components/OutlinePane.tsx` | exact |
| `src/components/EditorPane.tsx` | component | request-response | `src/components/EditorPane.tsx` | exact |
| `src/App.tsx` | controller | request-response | `src/App.tsx` | exact |
| `src/__tests__/editorSurfaceState.test.tsx` | test | event-driven | `src/__tests__/editorPreviewDebounce.test.tsx` | role-match |

## Pattern Assignments

### `src/lib/outlinePaneStore.ts` (store, event-driven)

**Analog:** `src/lib/appOverlayStore.ts`

Use this module-slot store shape for facade-local Outline state: immutable top-level replacement, pure `*InState` transitions, and individual `useSyncExternalStore` slice hooks. Compose canonical workspace data rather than mirroring it.

**Imports and state pattern** ([src/lib/appOverlayStore.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/appOverlayStore.ts:1), lines 1-4 and 22-29):

```typescript
import { useSyncExternalStore } from "react";

export interface AppOverlayStoreState {
  settingsOverlay: { tab: string | null } | null;
  commandPaletteOpen: boolean;
  // other stable render-domain slices
}
```

**Pure no-op transition and atomic publish** ([src/lib/appOverlayStore.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/appOverlayStore.ts:59), lines 59-67 and 164-169):

```typescript
export function openSettingsInState(
  state: AppOverlayStoreState,
  tab?: string | null,
): AppOverlayStoreState {
  if (tab === undefined) {
    return state.settingsOverlay !== null ? state : { ...state, settingsOverlay: { tab: null } };
  }
  if (state.settingsOverlay?.tab === tab) return state;
  return { ...state, settingsOverlay: { tab } };
}

function publish(next: AppOverlayStoreState): void {
  if (next === appOverlayStoreState) return;
  appOverlayStoreState = next;
  for (const subscriber of subscribers) subscriber();
}
```

**Stable slice-hook pattern** ([src/lib/appOverlayStore.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/appOverlayStore.ts:236), lines 236-249):

```typescript
function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function useSettingsOverlay(): { tab: string | null } | null {
  return useSyncExternalStore(
    subscribe,
    () => appOverlayStoreState.settingsOverlay,
    () => appOverlayStoreState.settingsOverlay,
  );
}
```

### `src/lib/editorPaneStore.ts` (store, event-driven)

**Analog:** `src/lib/editorTabsStore.ts`

Key the facade-local state by `workspacePath`, `EditorGroupId`, and `tabId` as appropriate. Read tabs and drafts from this canonical owner; do not duplicate `draftContent`.

**Current-snapshot command read** ([src/lib/editorTabsStore.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/editorTabsStore.ts:519), lines 519-529):

```typescript
export function getEditorTabsState(): EditorTabsState {
  return editorTabsState;
}

export function updateTabDraft(tabId: string, content: string): void {
  publish(updateDraftInState(editorTabsState, tabId, content));
}
```

**Identity-cached composite selector and hooks** ([src/lib/editorTabsStore.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/editorTabsStore.ts:646), lines 646-683):

```typescript
let activeTabIdsCache: ActiveEditorTabIds | null = null;

function getActiveTabIdsSnapshot(): ActiveEditorTabIds {
  if (
    !activeTabIdsCache ||
    activeTabIdsCache.activeTabId !== editorTabsState.activeTabId ||
    activeTabIdsCache.leftActiveTabId !== editorTabsState.leftActiveTabId ||
    activeTabIdsCache.rightActiveTabId !== editorTabsState.rightActiveTabId
  ) {
    activeTabIdsCache = {
      activeTabId: editorTabsState.activeTabId,
      leftActiveTabId: editorTabsState.leftActiveTabId,
      rightActiveTabId: editorTabsState.rightActiveTabId,
    };
  }
  return activeTabIdsCache;
}

export function useActiveTabIds(): ActiveEditorTabIds {
  return useSyncExternalStore(subscribe, getActiveTabIdsSnapshot, getActiveTabIdsSnapshot);
}
```

### `src/lib/editorSurfacePersistence.ts` (service, request-response)

**Analog:** `src/App.tsx` persistence and workspace-load guards.

Keep persisted fields limited to the existing `MaruSettings.ui.editorPaneViewModes` and `rightPaneTab` contract. Receive the generation and workspace identity from the shell; hydrate in one guarded facade transition. Do not add settings keys or persist HTML acknowledgement/operation state.

**Normalized debounced saver path** ([src/App.tsx](/Users/yj.lee/workspace/work/dev/maru/src/App.tsx:1790), lines 1790-1822):

```typescript
const updateSettings = useCallback((updater, options?) => {
  setMaruSettings((current) => {
    const next = normalizeMaruSettings(
      typeof updater === "function" ? updater(current) : updater,
    );
    if (settingsWritable && settingsWorkPath) {
      const saver = settingsContextualSaverRef.current;
      if (saver) {
        saver.schedule(next, { workPath: settingsWorkPath, base: current });
        if (options?.flush) void saver.flush();
      }
    }
    return next;
  });
}, [settingsWorkPath, settingsWritable]);
```

**Late-workspace guard** ([src/App.tsx](/Users/yj.lee/workspace/work/dev/maru/src/App.tsx:3648), lines 3648-3666):

```typescript
const loadWorkspace = useCallback(async (path, visibility, preferRelPath = null) => {
  const requestId = ++loadWorkspaceRequestRef.current;
  updateWorkspaceState(path, { loading: true, refreshing: false, startupIoReady: false });

  const restorePrimaryTab = async (nextEntries, source) => {
    if (requestId !== loadWorkspaceRequestRef.current) return false;
    updateWorkspaceState(path, { entries: nextEntries });
    // hydrate only for the still-current workspace/generation
  };
}, []);
```

### `src/components/OutlinePane.tsx` (component, request-response)

**Analog:** the existing `OutlinePane` prop boundary.

Replace this large destructured prop bundle with facade slice hooks plus one `OutlinePaneCommands` port and only needed scope/ref/render-slot props (maximum eight total). Keep local input state and presentation subcomponents in this file.

**Current oversized prop boundary to remove** ([src/components/OutlinePane.tsx](/Users/yj.lee/workspace/work/dev/maru/src/components/OutlinePane.tsx:77), lines 77-155):

```typescript
interface OutlinePaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  entries: VaultEntry[];
  readOnly: boolean;
  workspacePath: string | null;
  // document, explorer, file queue, right-tab, share, and sidebar callbacks
  onJumpToLine: (line: number) => void;
  onUpdateField: (...) => Promise<void>;
  onApplyFileQueue: () => Promise<unknown>;
  onOpenCommandPalette: () => void;
}
```

**Preserve render-domain derivation within the component** ([src/components/OutlinePane.tsx](/Users/yj.lee/workspace/work/dev/maru/src/components/OutlinePane.tsx:279), lines 279-300):

```typescript
const { t } = useTranslation();
const isPkm = appMode === "pkm";
const visibleTabs: readonly RightPaneTab[] = isPkm
  ? ["workspace", "outline", "explorer", "files", "shareOutbox", "skills", "guideline", "evidence", "info"]
  : appMode === "inbox" ? ["workspace", "shareOutbox"] : ["workspace"];
const tab: RightPaneTab = visibleTabs.includes(activeTab) ? activeTab : visibleTabs[0];
const headings = useMemo(() => extractOutline(draftContent), [draftContent]);
```

### `src/components/EditorPane.tsx` (component, request-response)

**Analog:** the existing `EditorPane` prop boundary and preview invariant.

Read document/tabs/view/operation slices from the keyed facade, receive the least-authority `EditorPaneCommands` port, and retain React-owned preview rendering exactly. The `paneGroup` scope and refs count toward the <=8 prop budget.

**Current oversized prop boundary to replace** ([src/components/EditorPane.tsx](/Users/yj.lee/workspace/work/dev/maru/src/components/EditorPane.tsx:87), lines 87-150):

```typescript
interface EditorPaneProps {
  document: DocumentPayload | null;
  openingEntry: VaultEntry | null;
  draftContent: string;
  saving: boolean;
  dirty: boolean;
  viewMode: EditorViewMode;
  tabs: EditorTabSummary[];
  // tab, save, split, navigation, view, HTML, and KG callback props
  onChange: (content: string) => void;
  onSave: () => void;
  onViewModeChange: (mode: EditorViewMode) => void;
}
```

**Preview identity invariant** ([src/components/EditorPane.tsx](/Users/yj.lee/workspace/work/dev/maru/src/components/EditorPane.tsx:450), lines 450-486; [src/components/EditorPane.tsx](/Users/yj.lee/workspace/work/dev/maru/src/components/EditorPane.tsx:1067), lines 1067-1072):

```typescript
const previewHtml = useMemo(
  () => decoratePreviewHtml(previewBaseHtml, { kgSpans, kgSource: kgSpanSource, kgTitleFor, findQuery, findCurrent, resolveWikilink }),
  [previewBaseHtml, kgSpans, kgSpanSource, kgTitleFor, findQuery, findCurrent],
);
const previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml]);

<article
  ref={previewRef}
  className="preview-surface"
  onClick={handlePreviewClick}
  dangerouslySetInnerHTML={previewMarkup}
/>;
```

### `src/App.tsx` (controller, request-response)

**Analog:** current `renderEditorPane` and `OutlinePane` wiring.

Reduce this controller to facade initialization/scope lifecycle, persistence-adapter lifecycle, and stable command-port creation outside inline JSX. Do not move async orchestration into either store.

**Editor wiring being replaced** ([src/App.tsx](/Users/yj.lee/workspace/work/dev/maru/src/App.tsx:8119), lines 8119-8164):

```typescript
const renderEditorPane = (group: EditorGroupId, tab: AnyTab | null, tabId: string | null) => {
  const workspace = tab
    ? workspaceRegistry.workspaces.find((item) => item.path === tab.workspacePath) ?? null
    : activeDocumentWorkspace;
  const docTab = isBinaryTab(tab) ? null : (tab as EditorTab | null);
  return (
    <EditorPane
      paneGroup={group}
      document={docTab?.document ?? null}
      draftContent={docTab?.draftContent ?? ""}
      saving={saving && resolvedActiveTabId === tabId && !binaryTab}
      viewMode={editorPaneViewModes[group]}
      // callback bundle follows
    />
  );
};
```

**Outline wiring being replaced** ([src/App.tsx](/Users/yj.lee/workspace/work/dev/maru/src/App.tsx:9107), lines 9107-9146):

```typescript
{outlineOpen && visibleAppMode !== "files" && !rightWorkbenchOpen ? (
  <OutlinePane
    document={document}
    draftContent={draftContent}
    entries={activeDocumentEntries}
    readOnly={!activeWorkspaceCanModify}
    workspacePath={activeDocumentWorkspacePath}
    activeLine={activeOutlineLine}
    onJumpToLine={jumpToOutlineLine}
    onClose={() => updateLayoutSettings({ outlineOpen: false })}
    onUpdateField={updateField}
    // explorer, queue, share, and sidebar bundle follows
  />
) : null}
```

### `src/__tests__/editorSurfaceState.test.tsx` (test, event-driven)

**Analog:** `src/__tests__/editorPreviewDebounce.test.tsx` plus `src/lib/appOverlayStore.test.ts`.

Use a jsdom React root and `act` for render counters and preview DOM identity. Test facade pure transitions separately with identity assertions. Include the automated <=8-prop contract for both panes.

**Component-harness setup** ([src/__tests__/editorPreviewDebounce.test.tsx](/Users/yj.lee/workspace/work/dev/maru/src/__tests__/editorPreviewDebounce.test.tsx:1), lines 1-30):

```typescript
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
```

**Pure-transition identity assertion** ([src/lib/appOverlayStore.test.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/appOverlayStore.test.ts:51), lines 51-54):

```typescript
it("is a no-op when the same tab is already set", () => {
  const state = stateOf({ settingsOverlay: { tab: "comms" } });
  expect(openSettingsInState(state, "comms")).toBe(state);
});
```

## Shared Patterns

### Stable external-store slices

**Sources:** `src/lib/appOverlayStore.ts`, `src/lib/editorTabsStore.ts`, `src/lib/workspaceStore.ts`

**Apply to:** both facade stores and all new render-domain hooks.

All store actions calculate a pure next state, preserve the input identity for a no-op, then publish atomically. A hook must return an existing slice reference or an explicitly cached composite, never a freshly assembled object. Existing workspace actions demonstrate path-scoped updates while retaining the rest of the state tree ([src/lib/workspaceStore.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/workspaceStore.ts:377), lines 377-392).

```typescript
export function updateWorkspaceState(path: string, patch: Partial<WorkspaceEntriesState>): void {
  publish(updateWorkspaceStateInState(workspaceStoreState, path, patch));
}
```

### Current-snapshot command ports

**Source:** `src/lib/editorTabsStore.ts`

**Apply to:** `OutlinePaneCommands`, `EditorPaneCommands`, and the shell adapter.

Commands must use `get...State()` at invocation time rather than capture render-scope values. Keep async filesystem/tab orchestration in the adapter/App layer; only pure transitions belong in stores.

### Persistence and stale-result guards

**Sources:** `src/App.tsx`, `src/lib/settings.ts`

**Apply to:** the persistence adapter and App lifecycle integration.

Persist only existing fields: `editorPaneViewModes` and `rightPaneTab` are already defined in the settings contract ([src/lib/settings.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/settings.ts:194), lines 194-205) and initialized with left/right values ([src/lib/settings.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/settings.ts:493), lines 493-505). Guard each asynchronous hydrate using the active workspace path and an incremented generation, following `loadWorkspaceRequestRef`.

### Error handling

**Source:** `src/lib/errorStore.ts`

**Apply to:** notification-only command failures.

Leave actionable pane errors/conflicts in the facade operation slice; send notification-only errors through the existing global store (`setError`) rather than adding a new toast path.

## No Analog Found

None. The persistence adapter is new as a module boundary, but its saver and stale-request behavior have direct in-place analogs in `src/App.tsx`.

## Metadata

**Analog search scope:** `src/lib/`, `src/components/`, `src/__tests__/`, `src/App.tsx`
**Files scanned:** 10
**Pattern extraction date:** 2026-08-26
