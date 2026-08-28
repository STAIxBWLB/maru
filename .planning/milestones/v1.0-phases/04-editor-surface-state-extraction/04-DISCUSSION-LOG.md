# Phase 4: Editor Surface State Extraction - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md; this log preserves the alternatives considered.

**Date:** 2026-08-26
**Phase:** 4-editor-surface-state-extraction
**Areas discussed:** Store ownership, State and command boundary, Persistence and hydration, Verification evidence
**Interaction mode:** Text mode; the user selected all four proposed gray areas.

---

## Store ownership

### Facade boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Pane-specific facade stores | One facade for `OutlinePane` and one for `EditorPane`, each with stable slice hooks | Yes |
| Extend existing stores | Add pane-specific slices and actions directly to `workspaceStore` and `editorTabsStore` | |
| Multiple feature-specific stores | Split explorer, file queue, editor view, and preview state into separate stores | |

**User's choice:** Pane-specific facade stores

### Existing-store data

| Option | Description | Selected |
|--------|-------------|----------|
| Reference composition without duplicate storage | Compose existing selectors/actions and own pane-local state only | Yes |
| Copy into facade snapshots | Mirror existing data through `App.tsx` synchronization | |
| Facade as new source of truth | Move ownership from existing stores into the new facades | |

**User's choice:** Reference composition without duplicate storage

### Store instance scope

| Option | Description | Selected |
|--------|-------------|----------|
| Module singleton with explicit keys | Key by workspace, editor group, and tab | Yes |
| Store instance per pane | Construct and inject a separate store object for each pane | |
| Active pane only | Keep a single unkeyed active snapshot | |

**User's choice:** Module singleton with explicit keys

### Subscription granularity

| Option | Description | Selected |
|--------|-------------|----------|
| Render-domain slices | Group document, tabs, view/preview, explorer, file queue, and operation state by render domain | Yes |
| One hook per field | Expose a selector hook for nearly every former prop | |
| One pane model | Return the entire pane snapshot from one hook | |

**User's choice:** Render-domain slices

**Notes:** The facades must preserve split-pane and workspace independence without duplicating `workspaceStore` or `editorTabsStore` state.

---

## State and command boundary

### State transitions and orchestration

| Option | Description | Selected |
|--------|-------------|----------|
| State actions plus a command port | Facade actions own pure state transitions; a typed port owns async and cross-surface work | Yes |
| Store owns every command | Put filesystem, navigation, and dialog orchestration in facade actions | |
| Keep individual callbacks | Move values to stores but retain the existing callback props | |

**User's choice:** State actions plus a command port

### Command authority

| Option | Description | Selected |
|--------|-------------|----------|
| Least-authority port per pane | Separate `OutlinePaneCommands` and `EditorPaneCommands` containing only used operations | Yes |
| Shared `ShellCommands` | Pass the same broad command surface to both panes | |
| Multiple feature ports | Inject separate documents, tabs, explorer, and navigation ports | |

**User's choice:** Least-authority port per pane

### Port construction

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated shell adapter or hook | Construct stable ports outside `App.tsx` and read current snapshots at invocation time | Yes |
| `useMemo` in `App.tsx` | Bundle existing callbacks inside the shell component | |
| Construct inside panes | Import APIs and build orchestration in each component | |

**User's choice:** Dedicated shell adapter or hook

### Async operation state

| Option | Description | Selected |
|--------|-------------|----------|
| Facade operation slices | Store pane progress and actionable inline errors in facade slices; use `errorStore` for notification-only failures | Yes |
| Component-local state | Manage saving and errors with pane `useState` | |
| `App.tsx` state | Keep status/error state in the shell and pass it through props | |

**User's choice:** Facade operation slices

**Notes:** Command ports return promises, have stable identity, and read current snapshots rather than closing over stale state.

---

## Persistence and hydration

### Persistence adapter

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated persistence adapter | Hydrate facade state and save persisted slices through the current debounced settings saver | Yes |
| `App.tsx` mediation | Keep settings values and change callbacks in the shell | |
| Pane-managed settings | Let each component call settings APIs directly | |

**User's choice:** Dedicated persistence adapter

### Persisted-state boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve current semantics | Persist only values already backed by `MaruSettings`; add no new settings keys | Yes |
| Persist more pane state | Add tab modes and more operation state to workspace settings | |
| Session-only panes | Stop restoring the currently persisted pane values | |

**User's choice:** Preserve current semantics

### Hydration timing

| Option | Description | Selected |
|--------|-------------|----------|
| Workspace-scoped atomic hydration | Publish one workspace snapshot guarded by workspace identity and generation | Yes |
| Sequential slice hydration | Publish slices independently as each becomes available | |
| Mount-time lazy hydration | Load state when each pane mounts | |

**User's choice:** Workspace-scoped atomic hydration

### Transient-state cleanup

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit lifecycle cleanup | Remove tab/workspace transient slices at scope close; keep persisted values and editor drafts with their current owners | Yes |
| Bounded LRU | Retain a limited cache of recently closed scopes | |
| Process-lifetime retention | Never remove keyed state until application exit | |

**User's choice:** Explicit lifecycle cleanup

**Notes:** Late hydration from an old workspace must never overwrite the active workspace. Unsaved drafts remain owned by `editorTabsStore`.

---

## Verification evidence

### Render-isolation proof

| Option | Description | Selected |
|--------|-------------|----------|
| Component harness with render counters | Simulate left/right typing and assert unrelated shell surfaces do not render | Yes |
| Store tests only | Verify selector snapshots and subscribers without mounting the component tree | |
| React Profiler test | Measure commits and duration through a profiling harness | |

**User's choice:** Component harness with render counters

### Preview-mark regression

| Option | Description | Selected |
|--------|-------------|----------|
| DOM identity and mark survival | Preserve mark classes and the marked node identity across a re-render with unchanged HTML | Yes |
| Mark content only | Assert that marked content remains after re-render | |
| Helper unit test only | Test `decoratePreviewHtml` output without mounting `EditorPane` | |

**User's choice:** DOM identity and mark survival

### Native verification timing

| Option | Description | Selected |
|--------|-------------|----------|
| Focused native smoke at phase completion | Run automated gates per plan and one real-app smoke during phase verification | Yes |
| Browser-mode only | Stop at component tests, Playwright, and `make verify` | |
| Native smoke per plan | Exercise the real app after every implementation plan | |

**User's choice:** Focused native smoke at phase completion

### Prop budget

| Option | Description | Selected |
|--------|-------------|----------|
| Maximum eight props per pane | Count command ports, scope keys, refs, and render slots; reject state value/change callback props | Yes |
| At least 80 percent reduction | Compare against the current approximate prop counts | |
| No numeric budget | Rely on architecture review | |

**User's choice:** Maximum eight props per pane

**Notes:** The native smoke covers split panes, Outline, Rich/Source/Preview, save, and conflict flows once after automated phase verification.

---

## Agent's Discretion

- Exact facade, adapter, hook, and test-harness filenames.
- Exact field grouping inside the agreed render-domain slices.
- Exact command result types and internal adapter implementation.
- Exact native-smoke script or checklist wording, within the selected flow matrix.

## Deferred Ideas

- `DocumentList`, `TerminalPanel`, and mode routing remain Phase 5.
- New settings keys, persisted per-tab state, LRU state retention, and visible UI changes remain out of scope.
