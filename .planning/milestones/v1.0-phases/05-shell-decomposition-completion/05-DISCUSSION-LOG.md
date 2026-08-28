# Phase 5: Shell Decomposition Completion - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md; this log preserves the alternatives considered.

**Date:** 2026-08-26
**Phase:** 5-Shell Decomposition Completion
**Areas discussed:** DocumentList ownership boundary, TerminalPanel ownership boundary, Lazy mode registry contract, Completion proof

---

## DocumentList ownership boundary

### Explicit component boundary

| Option | Description | Selected |
|--------|-------------|----------|
| `scope + commands + DOM refs` | Keep workspace scope, least-authority command port, `searchInputRef`, and `paneRef`; move ordinary state and callbacks behind the facade. | Yes |
| `scope + commands` | Internalize focus and pane access as well as state. | |
| `scope + commands + refs + capabilities` | Keep read/write and file-operation capabilities as explicit props. | |

**User's choice:** `scope + commands + DOM refs`

### Canonical browser-state owner

| Option | Description | Selected |
|--------|-------------|----------|
| Shared `documentBrowserStore` | Give DocumentList and OutlinePane facades stable slices from one canonical domain owner. | Yes |
| DocumentList facade owns shared state | Make OutlinePane depend on the other pane's facade. | |
| Synchronized facade snapshots | Keep two facade copies synchronized through an adapter. | |

**User's choice:** Shared `documentBrowserStore`

### Reveal delivery

| Option | Description | Selected |
|--------|-------------|----------|
| Store intent + acknowledge | Publish `{ targetPath, nonce }` and acknowledge it after handling. | Yes |
| Imperative handle | Expose `DocumentListHandle.reveal(targetPath)`. | |
| Window event | Send a global custom event carrying the path. | |

**User's choice:** Store intent + acknowledge

### Component-local interaction state

| Option | Description | Selected |
|--------|-------------|----------|
| Keep render-moment state local | Keep input buffer, deferred values, viewport, context menu, and drag hover local. | Yes |
| Keep only search local | Move viewport and interaction state into a pane-keyed store. | |
| Move all state to the store | Make the component nearly stateless, including DOM/pointer state. | |

**User's choice:** Keep render-moment state local

---

## TerminalPanel ownership boundary

### Explicit component boundary

| Option | Description | Selected |
|--------|-------------|----------|
| `scope + commands + graphNode + ref` | Keep the Graph surface as a render slot and move settings/layout/context/launch state behind the facade. | Yes |
| `scope + commands + ref` | Resolve Graph directly inside TerminalPanel. | |
| `scope + commands + graphNode + settings + ref` | Keep settings as a broad reactive prop. | |

**User's choice:** `scope + commands + graphNode + ref`

### Store scope

| Option | Description | Selected |
|--------|-------------|----------|
| Process-global + active-context slice | Preserve tasks and sessions across workspace/mode changes while launches use the latest context. | Yes |
| Workspace-keyed | Restore a separate terminal set per workspace. | |
| Panel-instance keyed | Prepare for multiple independent terminal panels. | |

**User's choice:** Process-global + active-context slice

### Generation safety

| Option | Description | Selected |
|--------|-------------|----------|
| Opaque `TerminalSessionHandle` | Require `{ sessionId, generation }` for every session-scoped command and reject bare IDs. | Yes |
| Resolve a logical tab ID | Let an adapter resolve the current handle at call time. | |
| Per-call map lookup | Preserve generation lookup as a call-site convention. | |

**User's choice:** Opaque `TerminalSessionHandle`

### Runtime layering

| Option | Description | Selected |
|--------|-------------|----------|
| Three-layer separation | Observable store, native runtime-controller registry, and component-local DOM interaction state. | Yes |
| Runtime objects in the store | Put channels, maps, and native handles in external-store snapshots. | |
| Runtime registry in the component | Extract layout/tabs only and retain lifecycle ownership in TerminalPanel. | |

**User's choice:** Three-layer separation

---

## Lazy mode registry contract

### Add-mode change boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Registry descriptor + adapter | Add one descriptor and one lazy adapter; leave `App.tsx` unchanged. | Yes |
| Automatic discovery | Use `import.meta.glob` so no registry edit is needed. | |
| Render callbacks remain in App | Move loader lookup only and preserve App branches. | |

**User's choice:** Registry descriptor + adapter

### Descriptor responsibility

| Option | Description | Selected |
|--------|-------------|----------|
| Rendering contract only | Own ID, lazy loader, placement, availability/feature gate, and fallback identity. | Yes |
| Complete mode manifest | Also own navigation icon, label, order, and shortcut. | |
| Lazy loader only | Leave placement and feature gates in host branches. | |

**User's choice:** Rendering contract only

### Adapter input

| Option | Description | Selected |
|--------|-------------|----------|
| Small host contract | Receive `ModeHostScope + ModeHostCommands` and subscribe to mode-specific slices. | Yes |
| MainApp closure | Let a registry render callback close over the entire host state. | |
| Broad Context provider | Publish one large `ModeHostContext` to all adapters. | |

**User's choice:** Small host contract

### Lazy-chunk enforcement

| Option | Description | Selected |
|--------|-------------|----------|
| Dynamic-import contract + guard | Reject eager registry imports and retain entry-chunk budget verification. | Yes |
| `React.lazy` convention only | Rely on review to catch eager imports. | |
| Per-mode chunk tests | Add a separate chunk test whenever a mode is added. | |

**User's choice:** Dynamic-import contract + guard

---

## Completion proof

### MainApp hook ceiling

| Option | Description | Selected |
|--------|-------------|----------|
| Phase-scoped ceiling | At most 17 `useState` and 25 `useEffect`; zero target-specific state/effects in MainApp. | Yes |
| Ultra-thin ceiling | At most 8 `useState`, 12 `useEffect`, and 40 `useCallback`. | |
| Structural proof only | Record counts without a numeric gate. | |

**User's choice:** Phase-scoped ceiling

### Add-pane-state proof

| Option | Description | Selected |
|--------|-------------|----------|
| Guard + deliberate drill | Keep a CI architecture guard and perform one throwaway-state drill at phase verification. | Yes |
| Guard only | Depend only on static/AST checks. | |
| Drill only | Demonstrate the current structure without a continuing CI guard. | |

**User's choice:** Guard + deliberate drill

### Render isolation

| Option | Description | Selected |
|--------|-------------|----------|
| MainApp remains stable | Domain updates re-render only actual slice consumers, not MainApp itself. | Yes |
| Phase 4 behavior | Permit MainApp re-execution while unrelated memoized panes stay stable. | |
| Pane-to-pane only | Ignore MainApp and check only sibling pane counts. | |

**User's choice:** MainApp remains stable

### Verification cadence

| Option | Description | Selected |
|--------|-------------|----------|
| Per-plan gate + phase-end full story | Focused tests and `make verify` per plan; final verify, e2e, native smoke, and drills. | Yes |
| Focused per plan, full gate once | Delay repository-wide checks until phase completion. | |
| Automated repository checks only | Omit native smoke and deliberate drills. | |

**User's choice:** Per-plan gate + phase-end full story

### Stale-generation coverage

| Option | Description | Selected |
|--------|-------------|----------|
| Every session command | Table-test stale and current handles for all session reads and mutations under ID reuse. | Yes |
| Mutations plus representative reads | Test every mutating command and sample read commands. | |
| One representative command | Pin input batch only and trust the type elsewhere. | |

**User's choice:** Every session command

### Add-mode proof

| Option | Description | Selected |
|--------|-------------|----------|
| Temporary production entry | Add a real adapter/descriptor, run build and bundle checks, prove no App diff, then revert. | Yes |
| Test fixture only | Simulate the registry without touching the production import graph. | |
| Static assertion only | Check source structure without executing the workflow. | |

**User's choice:** Temporary production entry

### Persistence proof

| Option | Description | Selected |
|--------|-------------|----------|
| Golden fixtures + lifecycle matrix | Exercise same-key round trips, hydration races, terminal continuity, and transient-state non-persistence. | Yes |
| Schema/default checks only | Check fields and defaults without realistic existing data. | |
| Native smoke only | Rely on one interactive application run. | |

**User's choice:** Golden fixtures + lifecycle matrix

### Native smoke scope

| Option | Description | Selected |
|--------|-------------|----------|
| Three-target end-to-end matrix | Cover Documents, Terminal, Registry, generation reuse, placement, lazy loading, and render isolation. | Yes |
| Terminal lifecycle only | Leave Documents and registry to browser tests. | |
| Core happy paths | Check document selection, one terminal input, and one mode transition. | |

**User's choice:** Three-target end-to-end matrix

---

## Agent's Discretion

The user did not delegate any product or architecture decision to the agent.
Only exact slice grouping, filenames, result types, and test-harness mechanics
remain implementation discretion within the locked contracts.

## Deferred Ideas

None. The discussion stayed within the behavior-preserving Phase 5 boundary.
