# Phase 5: Shell Decomposition Completion - Context

**Gathered:** 2026-08-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Complete the behavior-preserving shell decomposition for SHELL-05 through
SHELL-08. `DocumentList` and `TerminalPanel` stop receiving large state and
callback bundles, mode selection becomes a lazy registry lookup, and domain
updates stop re-executing `MainApp`. Adding pane-local state or a mode surface
must not require an edit to `src/App.tsx`.

The phase preserves every visible behavior, existing persistence boundary,
terminal session-safety invariant, and lazy chunk. It adds no product feature,
navigation redesign, settings key, or new state library.

</domain>

<decisions>
## Implementation Decisions

### DocumentList ownership boundary

- **D-01:** `DocumentList` has exactly four explicit structural inputs after extraction: `scope`, a least-authority `commands` port, `searchInputRef`, and `paneRef`. State values, capabilities, and ordinary callbacks are not individual props. - **Reversibility:** costly - widening this boundary later would restore the shell coupling and call-site churn this phase removes.
- **D-02:** A shared `documentBrowserStore` is the canonical owner for document-browser state used by both `DocumentList` and `OutlinePane`. Each pane facade composes only the stable slices it needs; neither facade owns or synchronizes a duplicate snapshot. - **Reversibility:** costly - both pane facades and their adapters will depend on this ownership boundary.
- **D-03:** One-shot reveal requests are nonce-bearing intents in `documentBrowserStore`. `DocumentList` acknowledges an intent after handling it, so repeated requests for the same path remain distinguishable without a pending-path prop or global event.
- **D-04:** Render-moment interaction state stays component-local: the immediate search input buffer, deferred query/filter values, viewport, context menu, and drag-hover state. Canonical query, filter, sort, and selection state is published to the store.

### TerminalPanel ownership boundary

- **D-05:** `TerminalPanel` has exactly four structural inputs after extraction: `scope`, a least-authority `commands` port, `graphNode`, and its imperative `ref`. `graphNode` remains a render slot so the terminal domain does not import the Graph implementation. - **Reversibility:** costly - downstream shell and panel composition will rely on this narrow boundary.
- **D-06:** Terminal task, tab, and session state is process-global, preserving the existing cross-workspace and cross-mode continuity. A separate active-context slice carries the latest workspace, cwd, and document context used for new launches.
- **D-07:** Every session-scoped command requires an opaque `TerminalSessionHandle` containing both `sessionId` and `generation`. Bare session IDs are not accepted for input, resize, visibility, selection, search, text, scroll, clear, kill, or related session operations. - **Reversibility:** costly - this intentionally tightens the frontend/backend command contract and every caller must use the generation-bearing handle.
- **D-08:** Terminal ownership is split into three layers: `terminalPanelStore` for observable task/tab/layout/context state, a runtime controller registry for channels, input pumps, native view handles, and generation handles, and component-local DOM/pointer/focus/search/context-menu state. Mutable native objects never enter React external-store snapshots.

### Lazy mode registry contract

- **D-09:** Adding a mode surface requires one central registry descriptor plus one dedicated lazy adapter module. `App.tsx` calls a generic renderer and does not change. Convention-based auto-discovery and mode-specific render callbacks in `App.tsx` are rejected. - **Reversibility:** costly - every mode adapter will target this registry contract.
- **D-10:** A descriptor owns the rendering contract only: mode ID, lazy adapter loader, allowed primary/right placement, availability or feature-gate predicate, and fallback identity. ActivityRail icon, order, label, and shortcut metadata remain in the existing navigation contract; Phase 5 does not redesign navigation ownership.
- **D-11:** A mode adapter receives only `ModeHostScope` and `ModeHostCommands`. It subscribes directly to its mode-specific facade/store slices rather than receiving a large host snapshot, closing over `MainApp` state, or using a broad Context provider.
- **D-12:** Registry entries accept dynamic-import factories. An automated static guard rejects eager mode imports, and the existing bundle-budget gate proves registered surfaces do not collapse into the entry chunk.

### Completion proof

- **D-13:** The final `MainApp` ceiling is at most 17 `useState` calls and at most 25 `useEffect` calls. `MainApp` contains zero `DocumentList`-, `TerminalPanel`-, or mode-adapter-specific state/effects. Target-specific callback absence matters more than an arbitrary total `useCallback` ceiling.
- **D-14:** CI keeps an architecture guard for the narrow pane props, forbidden shell-owned target state, and registry-only routing. Phase verification also performs a deliberate add-state drill: add throwaway state inside a pane facade/component, prove `src/App.tsx` has no diff, run the focused contract, then revert the throwaway change.
- **D-15:** Domain updates do not re-execute `MainApp`. The production render-isolation test covers editor typing, document query/filter changes, terminal tab/session updates, and active mode-local state changes; only the actual slice consumers may update.
- **D-16:** Every implementation plan runs its focused tests and `make verify`. Phase completion reruns `make verify`, the full `pnpm test:e2e` suite, a macOS native Tauri smoke, and both deliberate drills.
- **D-17:** Stale/current generation behavior is table-tested for every session-scoped command under a recycled `sessionId`. A stale handle must fail and the current handle must succeed for read and mutation paths.
- **D-18:** The add-mode drill temporarily adds a real lazy adapter and descriptor to the production registry, runs typecheck, renderer tests, the frontend build, and bundle guards, proves `src/App.tsx` has no diff, and then reverts the temporary adapter and descriptor.
- **D-19:** Persistence compatibility uses golden existing settings/localStorage fixtures plus a lifecycle matrix. It proves same-key semantic round trips, late workspace hydration rejection, terminal task/session continuity, and continued non-persistence of transient state. No new settings key is allowed.
- **D-20:** The phase-end macOS native smoke covers Documents query/filter/reveal/favorite/file-queue flows; Terminal spawn/input/output, bottom/right dock, split, resize, Graph switching, hide/show, kill/recreate generation; and registry primary/right placement plus lazy loading. It also observes that unrelated panes and `MainApp` stay render-isolated.

### Agent's Discretion

- Exact facade slice names and field grouping, provided canonical ownership is not duplicated and unchanged slices keep stable identity.
- Exact adapter, runtime-controller, guard, fixture, and test filenames.
- Exact command result types and native-smoke harness mechanics, provided the locked generation, persistence, render-isolation, and coverage matrices are exercised.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and locked project constraints

- `.planning/REQUIREMENTS.md` section "App Shell Decomposition" - SHELL-05 through SHELL-08.
- `.planning/ROADMAP.md` section "Phase 5: Shell Decomposition Completion" - goal, success criteria, remaining prop bundles, lazy registry requirement, terminal generation invariant, and deliberate drill.
- `.planning/PROJECT.md` sections "Context", "Constraints", and "Key Decisions" - behavior preservation, module-store mandate, import direction, no-UI-change boundary, bundle budget, and verification signal.
- `.planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md` - inherited facade, stable-slice, least-authority command, hydration, cleanup, prop-budget, and render-isolation decisions.
- `README.md` sections "Architecture", "Integrated terminal reliability contract", "Development", and "Critical invariants" - project ownership, terminal runtime behavior, canonical checks, and storage rules.

### Codebase evidence and conventions

- `.planning/codebase/CONCERNS.md` sections "Tech Debt", "Fragile Areas", and "Test Coverage Gaps" - remaining shell bundles, mode chain, terminal lifecycle risk, and missing component coverage.
- `.planning/codebase/CONVENTIONS.md` sections "Module Design", "State", "Persisted Settings", and "Lazy chunks" - module-slot stores, stable slice hooks, persistence behavior, import layering, and code splitting.
- `.planning/codebase/STRUCTURE.md` sections "Mode routing inside src/App.tsx", "New shared state", and "Testing" - current integration points and expected module locations.

### Live implementation anchors

- `src/App.tsx` - current `MainApp`, DocumentList and TerminalPanel wiring, and nested mode routing being removed.
- `src/components/DocumentList.tsx` - current prop surface and component-local input, viewport, context-menu, and drag interaction state.
- `src/components/TerminalPanel.tsx` - current prop surface, terminal reducer, session maps, generation checks, native runtime objects, and DOM interactions.
- `src/lib/outlinePaneStore.ts` - existing workspace-keyed pane facade that will compose document-browser slices.
- `src/lib/editorPaneStore.ts` - keyed stable-slice facade and lifecycle precedent from Phase 4.
- `src/lib/workspaceStore.ts` - canonical workspace-scoped shared-state precedent.
- `src/lib/editorTabsStore.ts` - canonical tab/draft owner whose publishes must no longer re-execute `MainApp`.
- `src/lib/api.ts` - current terminal IPC wrappers and session command argument shapes.
- `src/lib/terminal.ts` - terminal task/tab reducer and pure state helpers.
- `scripts/check-bundle-budget.mjs` - existing entry-chunk and lazy-surface safety net.
- `src/__tests__/editorSurfaceRenderIsolation.test.tsx` - production `MainApp` render observer and Phase 4 isolation harness to strengthen.

No external specification or ADR governs this phase. The internal requirements, prior context, and decisions above are the complete contract.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/lib/outlinePaneStore.ts` and `src/lib/editorPaneStore.ts`: stable per-domain `useSyncExternalStore` hooks, keyed lifecycle, current-snapshot commands, and facade composition patterns.
- `src/lib/workspaceStore.ts` and `src/lib/editorTabsStore.ts`: existing canonical owners to compose rather than copy.
- `src/lib/shellRenderObserver.ts` and `src/__tests__/editorSurfaceRenderIsolation.test.tsx`: no-op production counters and a real-`MainApp` harness for the stronger D-15 proof.
- `src/lib/terminal.ts`: pure task/tab reducer suitable for the observable terminal store layer.
- `src/components/TerminalPanel.tsx`: existing generation maps, channels, input pumps, native view handles, and lifecycle comments that identify the runtime-controller extraction boundary.
- `scripts/check-bundle-budget.mjs`: existing bundle proof to extend rather than replace.

### Established Patterns

- Shared cross-pane state uses module slots plus `useSyncExternalStore`; React Context is tree-scoped only and no new state library is allowed.
- Pane facades expose stable render-domain slices and least-authority command ports. Canonical owners are composed, never mirrored through dual writes.
- Async filesystem, navigation, dialog, and native-runtime work stays behind typed `src/lib/` adapters; components do not call Tauri `invoke` directly.
- Persisted settings keep their existing keys, normalization, cloning, and debounced write paths. Transient interaction state remains transient.
- Heavy mode surfaces use named-export `React.lazy` imports and a Suspense fallback; the entry chunk is budget-gated.

### Integration Points

- Replace the `DocumentList` prop bundle near the primary PKM fallback in `src/App.tsx` with a four-input facade boundary.
- Replace the bottom/right `TerminalPanel` prop bundle with store hydration, a runtime controller, and four structural inputs.
- Replace the `surfaceMode === ...` nested branch with the generic registry renderer while preserving primary/right workbench placement.
- Move mode-specific subscriptions and prop adaptation into lazy adapters so `MainApp` does not observe their local updates.
- Strengthen the existing production render-isolation harness, settings tests, terminal command tests, and bundle guard rather than creating parallel proof systems.

</code_context>

<specifics>
## Specific Ideas

- Treat both target panes as four-input boundaries, stricter than the inherited eight-prop maximum.
- Use nonce + acknowledge rather than path equality for repeated reveal requests.
- Treat the terminal generation as part of session identity at the type boundary, not as a map lookup convention remembered by individual call sites.
- Keep mutable terminal runtime objects outside external-store snapshots.
- Define phase completion with the explicit `MainApp` ceilings of 17 `useState` and 25 `useEffect` calls.
- Prove extensibility by actually adding and reverting throwaway pane state and a throwaway production registry mode, not only by inspecting source.

</specifics>

<deferred>
## Deferred Ideas

None - discussion stayed within the behavior-preserving Phase 5 scope.

</deferred>

---

*Phase: 5-Shell Decomposition Completion*
*Context gathered: 2026-08-26*
