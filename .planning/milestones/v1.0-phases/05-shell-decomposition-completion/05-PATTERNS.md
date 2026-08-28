# Phase 5: Shell Decomposition Completion - Pattern Map

**Mapped:** 2026-08-26
**Files analyzed:** 17 implementation and test targets
**Analogs found:** 17 / 17

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/documentBrowserStore.ts` | store | request-response | `src/lib/outlinePaneStore.ts` | role-match |
| `src/lib/outlinePaneStore.ts` | store | request-response | itself, composed with `src/lib/editorTabsStore.ts` | exact extension |
| `src/components/DocumentList.tsx` | component | request-response | `src/components/EditorPaneFacade.tsx` plus its existing local state | role-match |
| `src/lib/terminalPanelStore.ts` | store | request-response | `src/lib/outlinePaneStore.ts` | role-match |
| `src/lib/terminalRuntimeController.ts` | service | event-driven | existing runtime refs in `src/components/TerminalPanel.tsx` | extraction match |
| `src/components/TerminalPanel.tsx` | component | event-driven | its existing reducer/ref boundary | exact extension |
| `src/lib/terminal.ts` | model/utility | transform | itself | exact extension |
| `src/lib/api.ts` | service | request-response | current generation-aware terminal wrappers | exact extension |
| `src-tauri/src/terminal/mod.rs` | service | request-response | `get_session_generation` command family | exact extension |
| `src/lib/modeRegistry.ts` | config/utility | request-response | module-scope lazy declarations in `src/App.tsx` | partial match |
| `src/lib/modeAdapters/*.tsx` | component | request-response | existing lazy pane call sites in `src/App.tsx` | partial match |
| `src/App.tsx` | controller | request-response | existing lazy definitions and `DocumentList`/`TerminalPanel` call sites | exact modification |
| `src/lib/documentBrowserStore.test.ts` | test | request-response | `src/lib/outlinePaneStore.test.ts` | exact role |
| `src/lib/terminalPanelStore.test.ts` | test | request-response | `src/lib/terminal.test.ts` and `src/lib/outlinePaneStore.test.ts` | role-match |
| `src/lib/modeRegistry.test.ts` | test | request-response | AST prop-budget cases in `src/lib/outlinePaneStore.test.ts` | role-match |
| `src/__tests__/editorSurfaceRenderIsolation.test.tsx` | test | event-driven | itself | exact extension |
| `scripts/check-bundle-budget.mjs` | config/test | batch | itself | exact extension |

## Pattern Assignments

### `src/lib/documentBrowserStore.ts` and `src/lib/outlinePaneStore.ts` (store, request-response)

**Analog:** `src/lib/outlinePaneStore.ts`

**Imports and stable-slice subscription** (lines 1-12, 371-415):

```typescript
import { useSyncExternalStore } from "react";

import { useActiveTabIds, useDocTabs } from "./editorTabsStore";

export function useOutlineExplorerSlice(scope: OutlinePaneScope): OutlineExplorerSlice {
  return useSyncExternalStore(
    (subscriber) => subscribeOutlineExplorerSlice(scope, subscriber),
    () => stateFor(scope).explorer,
    () => stateFor(scope).explorer,
  );
}
```

**Core publication pattern** (lines 111-126):

```typescript
function publishWorkspace(scope: OutlinePaneScope, next: OutlinePaneState): void {
  const current = stateFor(scope);
  if (next === current) return;
  statesByWorkspace = { ...statesByWorkspace, [scope.workspacePath]: next };
  if (next.document !== current.document) notify(documentSubscribers, scope.workspacePath);
  if (next.fileQueue !== current.fileQueue) notify(fileQueueSubscribers, scope.workspacePath);
  if (next.operation !== current.operation) notify(operationSubscribers, scope.workspacePath);
  if (next.sidebar !== current.sidebar) notify(sidebarSubscribers, scope.workspacePath);
  if (next.explorer !== current.explorer) notify(explorerSubscribers, scope.workspacePath);
}
```

**Canonical-owner composition and cached identity** (lines 368-389):

```typescript
const tab = tabs.find(
  (candidate) => candidate.id === tabId && candidate.workspacePath === scope.workspacePath,
) ?? null;
if (!tab) return fallback;
const cached = documentSliceCache.get(scope.workspacePath);
if (cached?.tab === tab) return cached.slice;
const slice = { document: tab.document, draftContent: tab.draftContent };
documentSliceCache.set(scope.workspacePath, { tab, slice });
return slice;
```

**Apply:** Create one canonical `documentBrowserStore`; migrate browser domains out of `outlinePaneStore`, then make the Outline facade compose its browser slices. Keep workspace keys only for document-browser state. Store reveal as `{ targetPath, nonce }`; expose an acknowledge action that clears only the matching nonce.

**Lifecycle/test reset pattern** (lines 332-361, 424-441): retain cleanup and a test-only module reset that notifies existing subscribers. Do not introduce a React provider or duplicate `editorTabsStore` document ownership.

---

### `src/components/DocumentList.tsx` (component, request-response)

**Analog:** `src/components/EditorPaneFacade.tsx`, with existing local-state boundary in `src/components/DocumentList.tsx`.

**Facade publication occurs after render** (`src/components/EditorPaneFacade.tsx`, lines 1-36):

```typescript
import { useLayoutEffect } from "react";

export function EditorPaneFacade({ scope, state }: EditorPaneFacadeProps) {
  useLayoutEffect(() => {
    publishEditorPaneFacade(scope, state);
  }, [scope, state]);
  return null;
}
```

**Keep interaction state component-local** (`src/components/DocumentList.tsx`, lines 174-218):

```typescript
const scrollRef = useRef<HTMLDivElement | null>(null);
const [viewport, setViewport] = useState({ scrollTop: 0, height: 720 });
const [inputQuery, setInputQuery] = useState(query);
const [contextMenu, setContextMenu] = useState<...>(null);
const [dragOverTargetPath, setDragOverTargetPath] = useState<string | null>(null);
const deferredQuery = useDeferredValue(query);
```

**Apply:** Replace the 40-prop `DocumentListProps` block at lines 83-130 with exactly `scope`, `commands`, `searchInputRef`, and `paneRef`. Subscribe inside the component to stable browser slices. Preserve the existing immediate input/deferred query, viewport, context-menu, and drag-hover state. Consume and acknowledge nonce-bearing reveal intents in an effect, rather than retaining `pendingRevealTargetPath` props.

---

### `src/lib/terminalPanelStore.ts`, `src/lib/terminalRuntimeController.ts`, and `src/components/TerminalPanel.tsx` (store/service/component, event-driven)

**Analogs:** `src/lib/outlinePaneStore.ts`, `src/lib/terminal.ts`, and the current `TerminalPanel` runtime refs.

**Process-global durable terminal model** (`src/lib/terminal.ts`, lines 23-58, 114-121):

```typescript
export interface TerminalTabsState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  tasks: TerminalTask[];
  activeTaskId: string | null;
}

export const EMPTY_TERMINAL_STATE: TerminalTabsState = {
  tabs: [], activeTabId: null, tasks: [], activeTaskId: null,
};
export const TERMINAL_STORAGE_KEY = "maru:terminal:v1";
```

**Persistence excludes runtime objects** (`src/lib/terminal.ts`, lines 472-566):

```typescript
export function serializeTerminalState(state: TerminalTabsState): PersistedTerminalState {
  return {
    version: 1,
    tasks: state.tasks.map((task) => ({ ...task })),
    sessions: state.tabs.filter((tab) => tab.taskId).map((tab) => ({
      taskId: tab.taskId as string, kind: tab.kind, title: tab.title,
      cwd: tab.cwd, agentSessionId: tab.agentSessionId,
    })),
  };
}
```

**Runtime resources are refs today** (`src/components/TerminalPanel.tsx`, lines 297-337):

```typescript
const [state, dispatch] = useReducer(terminalTabsReducer, EMPTY_TERMINAL_STATE, loadPersistedTerminalState);
const handlesRef = useRef<Map<string, NativeTerminalViewHandle>>(new Map());
const sessionByTabRef = useRef<Map<string, string>>(new Map());
const generationBySessionRef = useRef<Map<string, string>>(new Map());
const channelsBySessionRef = useRef<Map<string, TerminalSpawnHandle["channel"]>>(new Map());
const inputPumpsRef = useRef<Map<string, TerminalInputPump>>(new Map());
```

**Apply:** Make `terminalPanelStore` a module singleton with independent immutable observable slices for task/tab state, layout, active context, and request/error state. It is process-global: do not key tasks/tabs/sessions by workspace. Move the listed maps, pumps, frame cursors, cancellation and disposal logic into `terminalRuntimeController`; retain DOM/pointer/focus/search/context-menu state in `TerminalPanel`. Reduce `TerminalPanelProps` at lines 103-143 to `scope`, `commands`, `graphNode`, and forwarded `ref`.

**Error handling:** preserve current no-throw command wrappers and component error presentation; controller calls must surface backend errors into the observable error slice rather than placing exceptions in store snapshots.

---

### `src/lib/api.ts` and `src-tauri/src/terminal/mod.rs` (service, request-response)

**Analog:** current generation-checked command family.

**Frontend wrapper convention** (`src/lib/api.ts`, lines 2055-2105):

```typescript
export async function terminalInputBatch(
  sessionId: string, generation: string, clientSeq: number, commands: TerminalInputCommand[],
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_input_batch", { sessionId, generation, clientSeq, commands });
}
```

**Backend checked gateway** (`src-tauri/src/terminal/mod.rs`, lines 909-918):

```rust
fn get_session_generation(
    state: &State<'_, TerminalState>, session_id: &str, generation: &str,
) -> Result<Arc<TerminalSession>, String> {
    let session = get_session(state, session_id)?;
    if session.generation != generation {
        return Err(format!("Stale terminal session generation: {session_id}"));
    }
    Ok(session)
}
```

**Apply:** Define one TypeScript/Rust-compatible `TerminalSessionHandle { sessionId, generation }`; update all wrappers and command signatures together. Route `terminal_write`/`terminal_input` (lines 493-538), scroll/clear/text/search (lines 719-813), resize (lines 815-855), and kill (lines 857-894) through `get_session_generation`. Preserve each operation's existing errors and idempotent unknown-session kill handling, but stale handles must reject rather than operate on a recycled ID.

---

### `src/lib/modeRegistry.ts`, `src/lib/modeAdapters/*.tsx`, and `src/App.tsx` (config/component/controller, request-response)

**Analog:** module-scope named-export lazy declarations in `src/App.tsx`.

**Lazy import shape** (`src/App.tsx`, lines 522-542):

```typescript
const LazyGraphView = lazy(() =>
  import("./components/graph/GraphView").then((module) => ({ default: module.GraphView })),
);
```

**Current migration targets:** the nested `surfaceMode` chain begins at `src/App.tsx:8777`; the default PKM fallback carries the DocumentList bundle at lines 9187-9229; TerminalPanel is mounted at lines 9342-9368.

**Apply:** Put an explicit descriptor type and registry in `src/lib/modeRegistry.ts`. Each descriptor owns only mode ID, dynamic `loadAdapter`, allowed primary/right placement, availability predicate, and fallback ID. Each adapter receives exactly `ModeHostScope` and `ModeHostCommands`, subscribes to its own facade slices, and adapts props there. Declare `lazy(loadAdapter)` at module scope in the registry/adapter layer, use a generic lookup plus Suspense host in `App.tsx`, and do not eager-import concrete mode components from the registry.

---

### Tests and build guard (test/batch)

**Analogs:** `src/lib/outlinePaneStore.test.ts`, `src/__tests__/editorSurfaceRenderIsolation.test.tsx`, and `scripts/check-bundle-budget.mjs`.

**AST prop-budget assertion** (`src/lib/outlinePaneStore.test.ts`, lines 116-134):

```typescript
const properties = interfacePropertyNames(outlinePanePath, "OutlinePaneProps");
expect(properties).toEqual(["scope", "commands", "paneRef", "slots"]);
expect(properties).not.toEqual(expect.arrayContaining(["document", "draftContent", "onJumpToLine"]));
```

**Changed-domain-only render proof** (`src/__tests__/editorSurfaceRenderIsolation.test.tsx`, lines 147-197):

```typescript
useSyncExternalStore(surface.subscribeEditorOperation(scope), () => surface.getEditorOperationSlice(scope));
await act(async () => { surface.patchEditorPaneOperation(scope, { saving: true }); });
expect(documentRenders).toBe(before.documentRenders);
expect(operationRenders).toBe(before.operationRenders + 1);
```

**Existing bundle assertion** (`scripts/check-bundle-budget.mjs`, lines 27-40):

```javascript
check("initial JS", largestMatching(/^index-.*\.js$/), 320 * 1024);
if (!files.some((file) => /^GraphView-.*\.js$/.test(file))) {
  throw new Error("bundle-budget: GraphView must remain a lazy chunk");
}
```

**Apply:** Write focused store/registry tests before implementation. Reuse TypeScript AST parsing to enforce exactly four structural props and to reject target-owned App state/effects and eager mode imports. Extend the real `MainApp` harness, not a shallow substitute, to publish document-browser, terminal, and mode-local state and assert `MainApp` does not re-execute. Add stale/current rows for every session wrapper in both frontend and Rust tests. Extend the existing bundle guard only after `pnpm build`, retaining current initial budgets and lazy assets.

## Shared Patterns

### Stable external-store slices

**Sources:** `src/lib/outlinePaneStore.ts:111-126,391-415`; `src/lib/editorPaneStore.ts:360-406`

Apply cached immutable slice identities, domain-specific subscriber sets, and notify-only-changed-domain publication to browser and terminal observable stores. Never place native handles, channels, pumps, or DOM refs in a snapshot.

### Current-snapshot command ports

**Sources:** `src/lib/outlinePaneStore.ts:363-389`; `src/lib/editorSurfaceStore.test.ts:227-241`

Facades expose render slices; least-authority command ports perform shell/native work against the latest state at invocation time. Components must not call Tauri `invoke` directly.

### Persistence boundary

**Source:** `src/lib/terminal.ts:472-566`

Continue using existing settings/localStorage keys and existing serializers. Persist task and relaunchable session metadata only; preserve non-persistence of runtime/interaction state and reject late workspace hydration.

### Error and identity handling

**Sources:** `src-tauri/src/terminal/mod.rs:909-918`; `src-tauri/src/terminal/mod.rs:858-894`

Generation is mandatory session identity at every boundary. Retain operation-specific error strings and idempotent cleanup semantics, while stale handles uniformly fail.

### Lazy loading

**Sources:** `src/App.tsx:522-542`; `scripts/check-bundle-budget.mjs:27-40`

Use dynamic factories and module-scope `lazy` declarations, then prove both source-level no-eager-import policy and emitted lazy chunks.

## No Analog Found

None. The exact registry descriptor and terminal runtime-controller modules are new shapes, but both are direct extractions/compositions of concrete existing code rather than new architectural conventions.

## Metadata

**Analog search scope:** `src/lib/`, `src/components/`, `src/__tests__/`, `src-tauri/src/terminal/`, and `scripts/`
**Files scanned:** 14 primary implementation/test files plus Phase 4 validation artifacts
**Pattern extraction date:** 2026-08-26
