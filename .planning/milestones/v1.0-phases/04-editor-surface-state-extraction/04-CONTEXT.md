# Phase 4: Editor Surface State Extraction - Context

**Gathered:** 2026-08-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Move the two highest-arity frontend panes, `OutlinePane` and `EditorPane`, off
their large `MainApp` prop bundles and onto module stores. The phase must make
editor typing stop re-rendering unrelated shell surfaces while preserving the
current UI, split-pane behavior, persistence semantics, document operations,
and preview-mark behavior exactly. It covers SHELL-01 through SHELL-04 only.

`DocumentList`, `TerminalPanel`, and mode-surface routing remain Phase 5 work.
No new product behavior or visible UI change belongs in this phase.

</domain>

<decisions>
## Implementation Decisions

### Store ownership

- **D-01:** Create one pane-specific facade store for each target:
  `OutlinePane` and `EditorPane`. Each facade exposes stable slice hooks rather
  than one whole-pane snapshot. - **Reversibility:** costly - undoing this after
  the panes adopt the facades would touch every migrated read and action site.
- **D-02:** Facades compose data and actions from existing owners such as
  `workspaceStore` and `editorTabsStore`; they do not copy or dual-write state
  those stores already own. A facade directly stores pane-local state only.
- **D-03:** Stores are module singletons keyed explicitly by `workspacePath`,
  `EditorGroupId`, and `tabId` where applicable. Left/right split panes and
  workspace transitions must remain independent without a provider tree.
- **D-04:** Subscription granularity follows render domains, not individual
  fields and not one pane-wide model. Expected slices include document, tabs,
  view/preview, explorer, file queue, and operation state. Snapshot identity
  remains stable when a slice is unchanged.

### State and command boundary

- **D-05:** Pure state transitions are facade actions. Async filesystem work,
  tab orchestration, navigation, dialog opening, and other cross-surface work
  flows through a small typed command port instead of individual callback
  props or store-owned controller logic.
- **D-06:** Define separate least-authority command ports for the two panes,
  `OutlinePaneCommands` and `EditorPaneCommands`. A pane receives only the
  operations it actually invokes; there is no shared broad `ShellCommands`
  capability.
- **D-07:** Construct stable command ports in a dedicated shell adapter or hook
  outside `App.tsx`. Commands read the latest store snapshot when invoked so
  they do not close over stale state. `App.tsx` retains final shell wiring, not
  inline command-object construction.
- **D-08:** Pane-specific progress (`saving`, `opening`) and actionable inline
  conflicts/errors live in facade operation slices. Command methods return
  promises. Notification-only failures continue through the existing global
  `errorStore` toast path.

### Persistence and hydration

- **D-09:** A dedicated persistence adapter hydrates facade persisted slices
  and writes their changes through the existing debounced settings saver.
  `App.tsx` does not pass persisted setting values or change callbacks to the
  target panes.
- **D-10:** Preserve the current persistence contract exactly. Values already
  backed by `MaruSettings` remain persisted; tab-specific HTML mode, risk
  acknowledgement, opening/saving/error state, and other currently transient
  values remain session-only. Add no new settings keys.
- **D-11:** Hydration is atomic per workspace and guarded by workspace identity
  plus a generation token. A late result from a previous workspace must not
  overwrite the active workspace's facade state.
- **D-12:** Explicit lifecycle cleanup removes tab- and workspace-keyed
  transient state when those scopes close. Persisted values remain in settings,
  and unsaved document drafts remain owned by `editorTabsStore`; no LRU or
  process-lifetime cache is introduced.

### Verification evidence

- **D-13:** Prove render isolation with a React component harness and render
  counters. Simulate typing in both left and right editors and assert that
  `DocumentList`, `TerminalPanel`, and the activity rail do not re-render. Also
  prove that a facade publish updates only subscribers to the changed slice.
- **D-14:** Add an `EditorPane` component regression test for #260/#262/#264.
  With unchanged `previewHtml`, a re-render caused by an operation/view slice
  must preserve both preview-mark classes and the marked DOM node's identity.
  This pins markup-object memoization, not just the resulting HTML text.
- **D-15:** Each implementation plan passes its automated store/component tests
  and the normal repository gate. Phase verification additionally runs one
  focused native Tauri smoke covering left/right split panes, Outline,
  Rich/Source/Preview, save, and conflict flows. Native smoke is not repeated
  after every plan.
- **D-16:** `OutlinePane` and `EditorPane` each have a hard budget of at most
  eight props after extraction. Command ports, scope keys, refs, and render
  slots each count as one. Individual state value/change-callback props are not
  allowed. The budget is protected by an automated static or component-level
  assertion.

### Agent's Discretion

- Exact facade module, adapter, hook, and test-harness filenames.
- Exact field membership within each agreed render-domain slice, provided
  ownership is not duplicated and unchanged slices keep stable identity.
- Exact command result types and adapter implementation, provided commands use
  current snapshots and preserve the least-authority port boundary.
- Exact native-smoke script or checklist wording, provided every flow in D-15
  is exercised once at phase verification.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements

- `.planning/REQUIREMENTS.md` section "App Shell Decomposition" - SHELL-01
  through SHELL-04 and the Phase 5 boundary.
- `.planning/ROADMAP.md` section "Phase 4: Editor Surface State Extraction" -
  goal, success criteria, sequence, preview invariant, and bundle-budget gate.
- `.planning/PROJECT.md` sections "Context", "Constraints", and "Key
  Decisions" - module-store mandate, output-identical behavior, import
  direction, preview-mark rule, and no-UI-change boundary.
- `README.md` sections "Architecture", "Development", and "Critical
  invariants" - project module ownership and the canonical verification
  commands.

### Evidence and established patterns

- `.planning/codebase/CONCERNS.md` sections "Tech Debt", "Fragile Areas", and
  "Test Coverage Gaps" - current prop bundles, shell-wide re-render mechanism,
  preview-mark regression history, and missing component coverage.
- `.planning/codebase/CONVENTIONS.md` sections "Module Design", "State", and
  "Persisted Settings" - module-slot stores, stable slice hooks, settings
  normalization, and component layering.
- `.planning/codebase/STRUCTURE.md` sections "Mode routing inside
  src/App.tsx", "New shared state", and "Testing" - current integration points
  and expected file locations.

### Live implementation anchors

- `src/lib/errorStore.ts` - minimal module-slot store and global toast path.
- `src/lib/appOverlayStore.ts` - one state object with stable per-slice
  `useSyncExternalStore` hooks and pure state helpers.
- `src/lib/workspaceStore.ts` - workspace-scoped shared-state precedent.
- `src/lib/editorTabsStore.ts` - canonical owner of document tabs and unsaved
  drafts.
- `src/components/EditorPane.tsx` - current props, split-pane scope, preview
  decoration invariant, and memoized preview markup.
- `src/components/OutlinePane.tsx` - current props and composed utility-rail
  surfaces.
- `src/App.tsx` - current `renderEditorPane` and `OutlinePane` wiring that this
  phase reduces.

No external specification or ADR governs this phase; the internal requirements
and decisions above are the complete contract.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/lib/errorStore.ts`: smallest proven module-slot store and the existing
  notification-only error destination.
- `src/lib/appOverlayStore.ts`: stable per-slice snapshot pattern and pure
  `*InState` helpers suitable for the two new facades.
- `src/lib/workspaceStore.ts`: workspace identity, shared data, and
  workspace-scoped subscription precedent.
- `src/lib/editorTabsStore.ts`: existing tab/group/draft state that facade
  stores must reference rather than duplicate.
- `src/components/EditorPane.tsx` `decoratePreviewHtml` and `previewMarkup`:
  implementation and invariant the D-14 test must protect.

### Established Patterns

- Shared cross-pane state uses module slots plus `useSyncExternalStore`; React
  Context is reserved for tree-scoped values and no new state library is
  allowed.
- One subscriber set may expose per-slice hooks when each getter returns a
  stable slice reference, as demonstrated by `appOverlayStore` and
  `workspaceStore`.
- UI components do not call Tauri `invoke` directly. Async work stays behind
  typed `src/lib/` facades or feature modules.
- Persisted settings are normalized, cloned, and debounced through the existing
  settings pipeline; transient per-tab state is not silently promoted into
  persisted behavior.
- Heavy mode surfaces and editors remain lazy chunks, and the entry bundle is
  gated by `scripts/check-bundle-budget.mjs`.

### Integration Points

- `src/App.tsx` `renderEditorPane` constructs left/right `EditorPane` instances
  and currently threads document, tab, mode, capability, and operation state.
- The `OutlinePane` call in `src/App.tsx` currently combines active-document,
  explorer, file-queue, right-tab, share, and sidebar state.
- Existing settings saver refs and workspace-load generation guards are the
  persistence adapter's bridge during extraction.
- Co-located Vitest component tests and the browser-mode Playwright suite are
  the automated proof layer; final phase verification adds the focused native
  Tauri smoke from D-15.

</code_context>

<specifics>
## Specific Ideas

- Use pane-specific facade names and least-authority port names so ownership is
  visible in imports and type errors.
- Treat the eight-prop cap as a hard regression budget, not an approximate
  cleanup target.
- The render-isolation proof must cover both editor groups, because a singleton
  store without explicit keys can otherwise pass for the left pane and bleed
  into the right pane.
- The preview regression test must check DOM identity as well as mark presence;
  content-only assertions do not detect unnecessary `innerHTML` replacement.

</specifics>

<deferred>
## Deferred Ideas

- `DocumentList` state extraction, `TerminalPanel` state extraction, and the
  lazy mode registry remain Phase 5.
- Persisting additional per-tab view state, introducing pane-state LRU caches,
  and adding any new visible UI behavior are outside this behavior-preserving
  milestone.

</deferred>

---

*Phase: 4-Editor Surface State Extraction*
*Context gathered: 2026-08-26*
