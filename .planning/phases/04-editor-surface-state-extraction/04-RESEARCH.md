# Phase 4: Editor Surface State Extraction - Research

**Researched:** 2026-08-26
**Domain:** React external-store facade extraction for a Tauri desktop editor shell
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### the agent's Discretion

- Exact facade module, adapter, hook, and test-harness filenames.
- Exact field membership within each agreed render-domain slice, provided
  ownership is not duplicated and unchanged slices keep stable identity.
- Exact command result types and adapter implementation, provided commands use
  current snapshots and preserve the least-authority port boundary.
- Exact native-smoke script or checklist wording, provided every flow in D-15
  is exercised once at phase verification.

### Deferred Ideas (OUT OF SCOPE)

- `DocumentList` state extraction, `TerminalPanel` state extraction, and the
  lazy mode registry remain Phase 5.
- Persisting additional per-tab view state, introducing pane-state LRU caches,
  and adding any new visible UI behavior are outside this behavior-preserving
  milestone.
</user_constraints>

## Project Constraints (from AGENTS.md)

- Treat `README.md` as this repository's local source of truth for structure, naming, sensitive-content, storage, and commands. [VERIFIED: AGENTS.md:6-11]
- Preserve the existing project and make the smallest relevant verification run; this research proposes the documented checks only. [VERIFIED: AGENTS.md:10-11]
- Keep source and plan documents in English; write Git commit messages in English. [VERIFIED: AGENTS.md:27-31]
- Do not add a `Co-authored-by` trailer without explicit user instruction. [VERIFIED: AGENTS.md:24-26]

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SHELL-01 | `OutlinePane` reads from module stores instead of a large prop bundle. | Pane facade, render-domain slices, scoped cleanup, and an `OutlinePaneCommands` port. [VERIFIED: .planning/REQUIREMENTS.md:72-75] |
| SHELL-02 | `EditorPane` reads from module stores instead of a large prop bundle. | Per-group and per-tab facade slices, `EditorPaneCommands`, persistence adapter, and stable preview markup. [VERIFIED: .planning/REQUIREMENTS.md:72-75] |
| SHELL-03 | Typing does not re-render unrelated panes. | Stable `useSyncExternalStore` slice snapshots plus two-group render-counter harness. [VERIFIED: .planning/REQUIREMENTS.md:72-75] |
| SHELL-04 | `EditorPane` has a preview-mark regression test. | DOM-node identity assertion around a re-render with unchanged preview HTML. [VERIFIED: .planning/REQUIREMENTS.md:72-75] |
</phase_requirements>

## Summary

This is a brownfield state-boundary extraction, not a state-management migration. Use two module-singleton facade stores that compose the canonical owners, particularly `workspaceStore` and `editorTabsStore`, and retain local-only pane state in explicit workspace/group/tab scopes. Existing stores already publish immutable replacement snapshots and expose stable slice hooks; extend that exact contract. [VERIFIED: src/lib/appOverlayStore.ts:159-169] [VERIFIED: src/lib/editorTabsStore.ts:506-517] [VERIFIED: src/lib/workspaceStore.ts:341-352]

The critical performance mechanism is snapshot identity. React re-renders a `useSyncExternalStore` subscriber only when its snapshot changes by `Object.is`; `getSnapshot` must return the same cached immutable value while its slice is unchanged. [CITED: https://react.dev/reference/react/useSyncExternalStore] Existing tab hooks already use this form: `"return useSyncExternalStore(subscribe, getDocTabsSnapshot, getDocTabsSnapshot);"` and `"return useSyncExternalStore(subscribe, getActiveTabIdsSnapshot, getActiveTabIdsSnapshot);"`. [VERIFIED: src/lib/editorTabsStore.ts:669-683]

Preserve the preview as React-owned DOM. The implementation already computes decorated HTML, then memoizes `previewMarkup` only on that string; a changed operation/view slice must not allocate a new `dangerouslySetInnerHTML` object when the HTML is unchanged. [VERIFIED: src/components/EditorPane.tsx:450-486] The phase must test DOM-node identity, not merely equivalent markup. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:80-85]

**Primary recommendation:** Implement the `OutlinePane` facade and command port first, then the keyed `EditorPane` facade plus persistence adapter, with render-isolation and preview-identity tests written before the final native smoke. [VERIFIED: .planning/ROADMAP.md:365-379] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:18-91]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Pane render state and subscriptions | Browser / Client | - | React panes consume stable facade slices; no new backend state is needed. [VERIFIED: src/lib/appOverlayStore.ts:231-249] |
| Tab and unsaved-draft ownership | Browser / Client | - | `editorTabsStore` already owns tab documents and drafts, so facades may read but must not duplicate it. [VERIFIED: src/lib/editorTabsStore.ts:12-18] |
| Persisted UI preferences | Frontend Server (shell adapter) | Browser / Client | The shell adapter bridges facade slices to the existing settings saver; the Tauri app has no SSR server. [VERIFIED: src/App.tsx:1790-1823] |
| File, save, snapshot, and conflict operations | API / Backend | Browser / Client | Command ports route async work through existing application commands and expose only pane-authorized operations. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:40-50] |
| Settings storage | Database / Storage | Browser / Client | Existing `MaruSettings` owns persisted pane preferences; no new settings keys are permitted. [VERIFIED: src/lib/settings.ts:194-220] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:56-62] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Existing React | `^19.2.0` | Component rendering and `useSyncExternalStore` subscriptions. | Already the project dependency and the API React documents for external stores. [VERIFIED: package.json:61-62] [CITED: https://react.dev/reference/react/useSyncExternalStore] |
| Existing Vitest + jsdom | `^4.1.5` + `^29.1.1` | Unit/component harness, fake timers, render counters, DOM identity assertions. | The current component test uses `createRoot`, `act`, and Vitest under `@vitest-environment jsdom`. [VERIFIED: package.json:76-80] [VERIFIED: src/__tests__/editorPreviewDebounce.test.tsx:1-10] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Existing Tauri CLI | `^2.10.0` | Run the one focused native verification. | Only at phase verification, after automated plans are green. [VERIFIED: package.json:22-26] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:80-88] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Module-singleton facade stores | Context/provider tree or a new store package | Rejected by the locked no-provider/no-new-library direction and would widen the behavior-preserving change. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:28-38] |
| Stable render-domain slices | A single whole-pane snapshot | Rejected because it reintroduces unrelated subscription updates. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:33-38] |

**Installation:** None. This phase adds no external package. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:107-111]

## Package Legitimacy Audit

Not applicable: this phase installs no external packages. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:107-111]

## Architecture Patterns

### System Architecture Diagram

```text
OutlinePane / EditorPane
          |
          v
stable facade slice hooks -- unchanged slice identity --> React skips unrelated renders
          |
          +--> workspaceStore / editorTabsStore (canonical shared owners)
          |
          +--> keyed facade-local state (workspacePath, EditorGroupId, tabId)
          |
          v
least-authority command port --> shell adapter --> existing async operations + settings saver
          |                                              |
          v                                              v
operation slice / inline conflict                         MaruSettings persistence
```

The React layer owns rendering and facade-local state; existing stores remain the only owners of shared workspace and draft data. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:23-38] [VERIFIED: src/lib/editorTabsStore.ts:12-18]

### Recommended Project Structure

```text
src/
├── lib/
│   ├── outlinePaneStore.ts        # facade state, pure transitions, stable slice hooks
│   ├── editorPaneStore.ts         # facade state keyed by workspace/group/tab
│   └── editorSurfacePersistence.ts # atomic hydrate/write adapter over existing saver
├── components/
│   ├── OutlinePane.tsx            # facade hooks + OutlinePaneCommands only
│   └── EditorPane.tsx             # facade hooks + EditorPaneCommands only
└── __tests__/
    └── editorSurfaceState.test.tsx # render counters, prop budget, preview identity
```

These filenames are discretionary planning names, not locked API. [ASSUMED]

### Pattern 1: Stable per-render-domain snapshot

**What:** Publish a new top-level store object only for a real transition, retain unchanged slice references, and have each hook return exactly its slice. [VERIFIED: src/lib/appOverlayStore.ts:50-53] [VERIFIED: src/lib/appOverlayStore.ts:159-169] [VERIFIED: src/lib/appOverlayStore.ts:231-249]

**When to use:** For document, tabs, view/preview, explorer, file queue, and operation domains defined by D-04, never for a computed whole-pane object. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:33-38]

**Example:**

```typescript
return useSyncExternalStore(subscribe, getDocTabsSnapshot, getDocTabsSnapshot);
```

Source and verbatim values: `"return useSyncExternalStore(subscribe, getDocTabsSnapshot, getDocTabsSnapshot);"`. [VERIFIED: src/lib/editorTabsStore.ts:669-671]

### Pattern 2: Current-snapshot command ports

**What:** Construct one stable `OutlinePaneCommands` or `EditorPaneCommands` object outside `App.tsx`; each command obtains state at invocation time and returns a promise for async work. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:40-50]

**When to use:** Every cross-surface operation, including save, navigation, file queue application, dialogs, and tab orchestration. Keep pure local transitions as facade actions. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:40-45]

### Pattern 3: Atomic scoped hydration and cleanup

**What:** The persistence adapter receives workspace identity plus an incremented generation, applies persisted slices as one facade transition only if both still match, and deletes transient `{ workspacePath, EditorGroupId, tabId }` records on scope closure. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:56-69]

**When to use:** Workspace switch, settings event, tab close, split close, and unmount. Do not migrate unsaved drafts from `editorTabsStore` or turn HTML mode/risk acknowledgement into persisted settings. [VERIFIED: src/App.tsx:819-826] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:61-69]

### Anti-Patterns to Avoid

- **Facade mirror:** Do not copy tabs, documents, or drafts into a facade; compose canonical-store reads. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:23-28]
- **Whole-pane subscription:** Do not return a freshly assembled model from `getSnapshot`; cached unchanged slices are the render-isolation mechanism. [CITED: https://react.dev/reference/react/useSyncExternalStore]
- **Controller store:** Do not put Tauri/filesystem orchestration inside a store; use the narrow command ports. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:40-50]
- **Preview repair effect:** Do not imperatively alter the preview container after React renders it. [VERIFIED: src/components/EditorPane.tsx:166-183]
- **Cross-scope cache:** Do not retain tab/workspace transient records through close; no LRU or process-lifetime cache. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:64-69]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| External-store subscription | New state library or Context hierarchy | Existing module slot + `useSyncExternalStore` conventions | Existing stores already model atomic publish, subscriptions, pure transitions, and stable slice identity. [VERIFIED: src/lib/appOverlayStore.ts:50-53] [VERIFIED: src/lib/workspaceStore.ts:102-109] |
| Draft ownership | Facade duplicate or secondary persistence | `editorTabsStore` | It owns `draftContent`; D-12 forbids moving it. [VERIFIED: src/lib/editorTabsStore.ts:12-18] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:64-69] |
| Settings writes | A new local-storage or ad hoc debounce path | Existing normalized debounced settings saver | Current updater normalizes and schedules via the contextual saver. [VERIFIED: src/App.tsx:1790-1823] |
| Preview highlighting | DOM mutation/reapplication effect | `decoratePreviewHtml` + memoized `previewMarkup` | React owns every rendered preview node, avoiding erase-on-re-render. [VERIFIED: src/components/EditorPane.tsx:450-486] |

**Key insight:** The phase succeeds when the facade is a read/transition boundary, not a second source of truth. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:23-28]

## Common Pitfalls

### Pitfall 1: A changed slice allocates all slices

**What goes wrong:** Typing publishes an object that makes unrelated pane snapshots appear changed, so `DocumentList`, `TerminalPanel`, or the activity rail re-render. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:71-79]

**How to avoid:** Unit-test pure transitions for no-op identity, cache any composite hook snapshot, and render-counter test each changed render domain from both editor groups. [VERIFIED: src/lib/editorTabsStore.ts:646-663] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:71-79]

### Pitfall 2: Split-pane scope bleed

**What goes wrong:** A singleton keyed only by tab or only by workspace conflates left/right HTML mode, focus, operation state, or refs. [VERIFIED: src/App.tsx:819-826] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:28-32]

**How to avoid:** Include `workspacePath`, `EditorGroupId`, and `tabId` where relevant; exercise left and right typing separately and assert each pane remains independent. [VERIFIED: src/lib/editorTabsStore.ts:34-35] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:28-32]

### Pitfall 3: Late hydration overwrites the new workspace

**What goes wrong:** An old async settings read publishes after a workspace change. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:61-63]

**How to avoid:** Make facade hydration a single guarded transition with path and generation equality before publish; test an intentionally late first response. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:61-63]

### Pitfall 4: Preview marks survive text assertions but lose DOM identity

**What goes wrong:** A new `dangerouslySetInnerHTML` object causes React to replace the preview subtree during an unrelated update. [VERIFIED: src/components/EditorPane.tsx:480-486]

**How to avoid:** Save a marked element reference, trigger an operation/view update without changing `previewHtml`, then assert both required classes and `toBe` identity. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:80-85]

### Pitfall 5: Broad command ports recreate prop drilling

**What goes wrong:** A shared shell command object lets panes gain undeclared powers and preserves `App.tsx` as a hidden controller. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:45-50]

**How to avoid:** Type two least-authority ports and enforce the <=8 prop budget in a static or component assertion. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:45-50] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:86-91]

## Code Examples

Verified patterns from this repository:

### Stable snapshot hook

```typescript
return useSyncExternalStore(subscribe, getActiveTabIdsSnapshot, getActiveTabIdsSnapshot);
```

Source and verbatim values: `"return useSyncExternalStore(subscribe, getActiveTabIdsSnapshot, getActiveTabIdsSnapshot);"`. [VERIFIED: src/lib/editorTabsStore.ts:681-683]

### Preview markup identity guard

```typescript
const previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml]);
```

Source and verbatim values: `"const previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml]);"`. [VERIFIED: src/components/EditorPane.tsx:480-486]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Large `App.tsx` prop bundles | Module-slot stores with per-slice `useSyncExternalStore` hooks | Existing repository convention | Phase 4 extends the established architecture instead of adding a library. [VERIFIED: src/lib/appOverlayStore.ts:7-12] |
| Imperative preview decorations | Decorated HTML plus memoized markup object | Current `EditorPane` implementation | Preserve the established preview DOM invariant during extraction. [VERIFIED: src/components/EditorPane.tsx:166-183] [VERIFIED: src/components/EditorPane.tsx:480-486] |

**Deprecated/outdated:** Whole-pane prop bundles for the two target panes are the debt being removed; Phase 5 explicitly retains the remaining pane extraction and lazy-mode registry work. [VERIFIED: .planning/ROADMAP.md:365-397]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `src/lib/outlinePaneStore.ts`, `src/lib/editorPaneStore.ts`, `src/lib/editorSurfacePersistence.ts`, and `src/__tests__/editorSurfaceState.test.tsx` are suitable filenames. | Recommended Project Structure | Low; planner may rename while keeping the required ownership boundaries. |
| A2 | A focused native smoke can be recorded as a checklist rather than an existing automation script. | Validation Architecture | Medium; planner must choose a reproducible invocation/checklist before execution. |

## Open Questions

1. **Which existing asynchronous workspace load provides the facade generation source?**
   - What we know: The phase requires a workspace identity plus generation guard. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:61-63]
   - What's unclear: The exact currently authoritative generation counter is not a locked filename or API.
   - Recommendation: In Wave 0, locate the active workspace-load transition and have the persistence adapter own an incremented facade hydration generation at that boundary. [ASSUMED]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Typecheck, Vitest, build | Yes | `v25.9.0` | None. [VERIFIED: local command] |
| pnpm | Repository scripts | Yes | `9.15.0` | None. [VERIFIED: local command] |
| Rust cargo | `make verify` and native app | Yes | `1.98.0` | None. [VERIFIED: local command] |
| Tauri CLI | Final focused native smoke | Yes | `2.10.1` | Manual smoke via `pnpm tauri:dev`. [VERIFIED: local command] [VERIFIED: package.json:22-26] |

**Missing dependencies with no fallback:** None. [VERIFIED: local command]

**Missing dependencies with fallback:** None. [VERIFIED: local command]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `^4.1.5` with jsdom `^29.1.1`. [VERIFIED: package.json:76-80] |
| Config file | `vite.config.ts` is present; component tests declare jsdom where needed. [VERIFIED: src/__tests__/editorPreviewDebounce.test.tsx:1-10] |
| Quick run command | `pnpm test -- src/lib/editorTabsStore.test.ts src/__tests__/editorPreviewDebounce.test.tsx` (replace with new focused paths when created). [ASSUMED] |
| Full suite command | `make verify`; it includes typecheck, lint, guards, unit tests, Rust checks, and frontend build. [VERIFIED: README.md:431-436] |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SHELL-01 | Outline facade reads stable slices, delegates commands, and meets prop budget. | unit + component | focused Vitest command | No, Wave 0. [ASSUMED] |
| SHELL-02 | Editor facade preserves keyed left/right/tab state, persistence, and prop budget. | unit + component | focused Vitest command | No, Wave 0. [ASSUMED] |
| SHELL-03 | Left/right typing increments only expected render counters; changed facade slice notifies only its subscribers. | component harness | focused Vitest command | No, Wave 0. [ASSUMED] |
| SHELL-04 | Unchanged preview HTML preserves mark classes and the same marked DOM node through operation/view update. | component regression | focused Vitest command | No, Wave 0. [ASSUMED] |

### Sampling Rate

- **Per task commit:** focused Vitest files plus `pnpm typecheck`. [VERIFIED: package.json:27-33]
- **Per wave merge:** `make verify`. [VERIFIED: README.md:431-436]
- **Phase gate:** green `make verify`, unchanged lazy/bundle guard, then one focused native smoke for left/right split, Outline, Rich/Source/Preview, save, and conflict. [VERIFIED: package.json:13-15] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:80-88]

### Wave 0 Gaps

- [ ] Facade pure-transition tests, including no-op and unchanged-slice identity. [ASSUMED]
- [ ] A render-counter component harness with left/right editor typing and unaffected-shell probes. [ASSUMED]
- [ ] An `EditorPane` component regression test for preview mark class and node identity. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:80-85]
- [ ] An automated <=8 prop assertion for both panes. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:86-91]

## Security Domain

OWASP identifies authentication, session management, access control, validation/sanitization/encoding, and cryptography as distinct ASVS areas. [CITED: https://devguide.owasp.org/en/03-requirements/05-asvs/]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | No authentication behavior is in this phase boundary. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:8-18] |
| V3 Session Management | No | No session behavior is in this phase boundary. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:8-18] |
| V4 Access Control | Yes | Preserve existing capability checks by routing filesystem actions through narrow command ports, not pane-local APIs. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:40-50] |
| V5 Input Validation | Yes | Preserve the sanitized, React-owned preview pipeline; do not introduce raw DOM mutation or a new HTML sink. [VERIFIED: src/components/EditorPane.tsx:166-183] [VERIFIED: src/components/EditorPane.tsx:1067-1072] |
| V6 Cryptography | No | This phase does not add cryptographic handling. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:8-18] |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A broad pane command exposes unintended file actions | Elevation of privilege | Separate least-authority `OutlinePaneCommands` and `EditorPaneCommands`; preserve existing backend checks. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:45-50] |
| Preview refactor reintroduces unsafe or stale DOM writes | Tampering | Keep decorations in sanitized HTML and memoize the markup object on the HTML string. [VERIFIED: src/components/EditorPane.tsx:166-183] [VERIFIED: src/components/EditorPane.tsx:480-486] |
| Late workspace hydration writes stale scoped state | Tampering | Check workspace identity and generation before atomic hydrate. [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:61-63] |

## Sources

### Primary (HIGH confidence)

- `src/lib/appOverlayStore.ts`, `src/lib/workspaceStore.ts`, and `src/lib/editorTabsStore.ts` - established module-slot, pure-transition, and stable-slice patterns. [VERIFIED: src/lib/appOverlayStore.ts:50-53] [VERIFIED: src/lib/workspaceStore.ts:102-109] [VERIFIED: src/lib/editorTabsStore.ts:506-517]
- `src/components/EditorPane.tsx` - preview decoration and markup-object identity invariant. [VERIFIED: src/components/EditorPane.tsx:166-183] [VERIFIED: src/components/EditorPane.tsx:450-486]
- `src/App.tsx` and `src/lib/settings.ts` - current prop wiring, transient HTML state, normalized persistence, and existing settings saver. [VERIFIED: src/App.tsx:7905-8225] [VERIFIED: src/App.tsx:1790-1823] [VERIFIED: src/lib/settings.ts:47-61]
- `README.md` - documented verification commands. [VERIFIED: README.md:398-436]

### Secondary (MEDIUM confidence)

- [React `useSyncExternalStore` reference](https://react.dev/reference/react/useSyncExternalStore) - immutable cached snapshot and stable subscription requirements. [CITED: https://react.dev/reference/react/useSyncExternalStore]
- [OWASP ASVS developer guide](https://devguide.owasp.org/en/03-requirements/05-asvs/) - category relevance framing. [CITED: https://devguide.owasp.org/en/03-requirements/05-asvs/]

### Tertiary (LOW confidence)

- None; planning filenames and the native-smoke recording form are listed in the Assumptions Log rather than treated as verified facts. [ASSUMED]

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - existing dependencies, scripts, and component-test shape were opened in this session. [VERIFIED: package.json:11-33] [VERIFIED: package.json:61-80]
- Architecture: HIGH - relevant stores, pane props, persistence, and split-pane wiring were opened in this session. [VERIFIED: src/App.tsx:760-850] [VERIFIED: src/App.tsx:7905-8225]
- Pitfalls: HIGH - the preview invariant is documented in the live component and phase context. [VERIFIED: src/components/EditorPane.tsx:166-183] [VERIFIED: .planning/phases/04-editor-surface-state-extraction/04-CONTEXT.md:80-85]

**Research date:** 2026-08-26
**Valid until:** 2026-09-25, unless concurrent frontend work changes the target stores or panes.
