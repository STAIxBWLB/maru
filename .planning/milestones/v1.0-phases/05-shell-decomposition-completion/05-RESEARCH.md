# Phase 5: Shell Decomposition Completion - Research

**Researched:** 2026-08-26
**Domain:** React/Tauri desktop-shell state decomposition
**Confidence:** HIGH

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `DocumentList` has exactly four explicit structural inputs after extraction: `scope`, a least-authority `commands` port, `searchInputRef`, and `paneRef`. State values, capabilities, and ordinary callbacks are not individual props. - **Reversibility:** costly - widening this boundary later would restore the shell coupling and call-site churn this phase removes.
- **D-02:** A shared `documentBrowserStore` is the canonical owner for document-browser state used by both `DocumentList` and `OutlinePane`. Each pane facade composes only the stable slices it needs; neither facade owns or synchronizes a duplicate snapshot. - **Reversibility:** costly - both pane facades and their adapters will depend on this ownership boundary.
- **D-03:** One-shot reveal requests are nonce-bearing intents in `documentBrowserStore`. `DocumentList` acknowledges an intent after handling it, so repeated requests for the same path remain distinguishable without a pending-path prop or global event.
- **D-04:** Render-moment interaction state stays component-local: the immediate search input buffer, deferred query/filter values, viewport, context menu, and drag-hover state. Canonical query, filter, sort, and selection state is published to the store.
- **D-05:** `TerminalPanel` has exactly four structural inputs after extraction: `scope`, a least-authority `commands` port, `graphNode`, and its imperative `ref`. `graphNode` remains a render slot so the terminal domain does not import the Graph implementation. - **Reversibility:** costly - downstream shell and panel composition will rely on this narrow boundary.
- **D-06:** Terminal task, tab, and session state is process-global, preserving the existing cross-workspace and cross-mode continuity. A separate active-context slice carries the latest workspace, cwd, and document context used for new launches.
- **D-07:** Every session-scoped command requires an opaque `TerminalSessionHandle` containing both `sessionId` and `generation`. Bare session IDs are not accepted for input, resize, visibility, selection, search, text, scroll, clear, kill, or related session operations. - **Reversibility:** costly - this intentionally tightens the frontend/backend command contract and every caller must use the generation-bearing handle.
- **D-08:** Terminal ownership is split into three layers: `terminalPanelStore` for observable task/tab/layout/context state, a runtime controller registry for channels, input pumps, native view handles, and generation handles, and component-local DOM/pointer/focus/search/context-menu state. Mutable native objects never enter React external-store snapshots.
- **D-09:** Adding a mode surface requires one central registry descriptor plus one dedicated lazy adapter module. `App.tsx` calls a generic renderer and does not change. Convention-based auto-discovery and mode-specific render callbacks in `App.tsx` are rejected. - **Reversibility:** costly - every mode adapter will target this registry contract.
- **D-10:** A descriptor owns the rendering contract only: mode ID, lazy adapter loader, allowed primary/right placement, availability or feature-gate predicate, and fallback identity. ActivityRail icon, order, label, and shortcut metadata remain in the existing navigation contract; Phase 5 does not redesign navigation ownership.
- **D-11:** A mode adapter receives only `ModeHostScope` and `ModeHostCommands`. It subscribes directly to its mode-specific facade/store slices rather than receiving a large host snapshot, closing over `MainApp` state, or using a broad Context provider.
- **D-12:** Registry entries accept dynamic-import factories. An automated static guard rejects eager mode imports, and the existing bundle-budget gate proves registered surfaces do not collapse into the entry chunk.
- **D-13:** The final `MainApp` ceiling is at most 17 `useState` calls and at most 25 `useEffect` calls. `MainApp` contains zero `DocumentList`-, `TerminalPanel`-, or mode-adapter-specific state/effects. Target-specific callback absence matters more than an arbitrary total `useCallback` ceiling.
- **D-14:** CI keeps an architecture guard for the narrow pane props, forbidden shell-owned target state, and registry-only routing. Phase verification also performs a deliberate add-state drill: add throwaway state inside a pane facade/component, prove `src/App.tsx` has no diff, run the focused contract, then revert the throwaway change.
- **D-15:** Domain updates do not re-execute `MainApp`. The production render-isolation test covers editor typing, document query/filter changes, terminal tab/session updates, and active mode-local state changes; only the actual slice consumers may update.
- **D-16:** Every implementation plan runs its focused tests and `make verify`. Phase completion reruns `make verify`, the full `pnpm test:e2e` suite, a macOS native Tauri smoke, and both deliberate drills.
- **D-17:** Stale/current generation behavior is table-tested for every session-scoped command under a recycled `sessionId`. A stale handle must fail and the current handle must succeed for read and mutation paths.
- **D-18:** The add-mode drill temporarily adds a real lazy adapter and descriptor to the production registry, runs typecheck, renderer tests, the frontend build, and bundle guards, proves `src/App.tsx` has no diff, and then reverts the temporary adapter and descriptor.
- **D-19:** Persistence compatibility uses golden existing settings/localStorage fixtures plus a lifecycle matrix. It proves same-key semantic round trips, late workspace hydration rejection, terminal task/session continuity, and continued non-persistence of transient state. No new settings key is allowed.
- **D-20:** The phase-end macOS native smoke covers Documents query/filter/reveal/favorite/file-queue flows; Terminal spawn/input/output, bottom/right dock, split, resize, Graph switching, hide/show, kill/recreate generation; and registry primary/right placement plus lazy loading. It also observes that unrelated panes and `MainApp` stay render-isolated.

### the agent's Discretion

- Exact facade slice names and field grouping, provided canonical ownership is not duplicated and unchanged slices keep stable identity.
- Exact adapter, runtime-controller, guard, fixture, and test filenames.
- Exact command result types and native-smoke harness mechanics, provided the locked generation, persistence, render-isolation, and coverage matrices are exercised.

### Deferred Ideas (OUT OF SCOPE)

None - discussion stayed within the behavior-preserving Phase 5 scope.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SHELL-05 | `DocumentList` reads its state from module stores instead of a ~40-prop bundle | Use a shared `documentBrowserStore`, four-input facade, nonce/ack reveal intent, and slice-level tests. |
| SHELL-06 | `TerminalPanel` reads its state from module stores instead of a ~25-prop bundle | Extract observable state to `terminalPanelStore`, keep native runtime objects in a controller, and make every session command consume a generation-bearing handle. |
| SHELL-07 | Adding a mode surface is a registry entry, not an added branch in a ~190-line nested ternary chain | Replace the shell ternary with a descriptor lookup and a lazy adapter contract, then guard against eager imports. |
| SHELL-08 | Adding state to a pane no longer requires editing `src/App.tsx` | Add static ownership/prop guards, production render-isolation coverage, and the required add-state/add-mode drills. |

## Project Constraints (from AGENTS.md)

- Treat [README.md](/Users/yj.lee/workspace/work/dev/maru/README.md) as the local source of truth before changing this repository.
- Keep the change scoped, use the documented verification commands, and update README only if project commands, folder rules, or policies themselves change.
- Documentation and plans are English; do not add a UI-SPEC or visible UI redesign for this behavior-preserving phase.
- Markdown must use normal Markdown, no inline HTML, hard-break whitespace, or literal document-format symbols in body text.
- Preserve unrelated concurrent work, including the existing `docs/design-qa/*.png` edits. Do not stage, revert, or otherwise modify them.

## Summary

Phase 5 is an internal ownership migration, not a UI project. The existing shell already has the two prerequisites: Phase 4 facade stores expose stable `useSyncExternalStore` slices and a current-snapshot command-port pattern, while `MainApp` still mounts the remaining large `DocumentList` and `TerminalPanel` bundles and owns the nested lazy-mode chain. [VERIFIED: src/lib/outlinePaneStore.ts:371-415] The established facade hooks use `useSyncExternalStore`; [VERIFIED: src/App.tsx:9189-9229] the current `DocumentList` call site passes state and callbacks individually.

The most consequential implementation hazard is terminal identity. The backend's checked command path already compares a session generation, but `terminal_write`, `terminal_input`, `terminal_scroll`, `terminal_clear`, `terminal_text`, `terminal_search`, `terminal_resize`, and `terminal_kill` currently obtain a session by bare ID. [VERIFIED: src-tauri/src/terminal/mod.rs:494-541,719-890] The implementation must tighten this whole command family together, not only move frontend state. This enables the locked stale/current handle matrix and prevents a recycled ID from operating on the wrong PTY.

**Primary recommendation:** Plan in four ordered slices: establish tests and static guards, extract the shared document-browser facade, extract the terminal store/controller plus generation-handle IPC contract, then introduce lazy mode adapters and the generic registry renderer before the final deliberate drills.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Document browser canonical state and reveal intents | Browser / Client | API / Backend | Query/filter/selection and the nonce/ack intent are UI state; filesystem operations remain behind existing command adapters. |
| Terminal observable state | Browser / Client | API / Backend | Task/tab/layout/context snapshots render in React, while PTY mutations cross the typed Tauri IPC boundary. |
| Terminal session identity validation | API / Backend | Browser / Client | The Rust command boundary must reject a stale generation; a frontend map alone cannot protect a recycled server-side session. [VERIFIED: src-tauri/src/terminal/mod.rs:909-918] `if session.generation != generation {` enforces the checked path. |
| Mutable terminal runtime resources | Browser / Client | API / Backend | Channels, pumps, view handles, and focus/DOM coordination are runtime-controller resources, not immutable React store data. |
| Mode routing and code splitting | Browser / Client | CDN / Static | The registry selects a lazy adapter in the client; Vite emits the dynamic-import chunk that the bundle guard verifies. [CITED: https://react.dev/reference/react/lazy] `lazy` defers a component loader until first render. |
| Persisted shell settings | Browser / Client | Database / Storage | Existing settings/localStorage persistence remains the owner; the phase may adapt its values but must not add a key. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | Existing `^19.2.0` | Stable facade subscriptions and lazy mode adapters | The manifest quote is `"react": "^19.2.0"`. [VERIFIED: package.json:61-62] React documents `useSyncExternalStore` as the external-store subscription API and requires cached immutable snapshots. [CITED: https://react.dev/reference/react/useSyncExternalStore] |
| TypeScript | Existing `~5.9.3` | Narrow command ports, opaque terminal handle, exhaustive registry descriptors | The manifest quote is `"typescript": "~5.9.3"`. [VERIFIED: package.json:77-80] Keep this phase within the existing strict typecheck rather than adding a state package. |
| Vitest + Playwright | Existing `^4.1.5` and `^1.59.1` | Store/component contracts and end-to-end behavior preservation | The manifest quotes are `"vitest": "^4.1.5"` and `"@playwright/test": "^1.59.1"`. [VERIFIED: package.json:67-80] |

### Supporting

| Library / tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| Existing Tauri IPC + Rust terminal module | Repository implementation | Enforce session identity where the PTY registry is authoritative | Use for every session command; do not encode the generation convention only in a React map. [VERIFIED: src-tauri/src/terminal/mod.rs:909-918] |
| Existing Vite bundle guard | Repository script | Preserve entry-chunk and lazy-surface budget | Extend the guard/static test for every registry adapter; run after the production build. [VERIFIED: scripts/check-bundle-budget.mjs:1-30] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Module-slot stores | A new client-state library or Context-provider tree | Rejected by locked project constraints and would create a second state pattern during a behavior-preserving refactor. |
| Explicit registry descriptors | Convention-based auto-discovery | Rejected by D-09 because the renderer contract, allowed placement, availability, and fallback must remain inspectable and statically guardable. |

**Installation:** None. This phase installs no external packages. [VERIFIED: .planning/phases/05-shell-decomposition-completion/05-CONTEXT.md:10-14] `It adds no product feature, navigation redesign, settings key, or new state library.`

## Package Legitimacy Audit

Not applicable. The approved approach uses existing React, TypeScript, Vitest, Playwright, Tauri, and repository modules; no package installation is in phase scope.

## Architecture Patterns

### System Architecture Diagram

```text
ActivityRail / existing navigation contract
  -> active mode
  -> mode registry descriptor
  -> lazy adapter factory
  -> Suspense fallback
  -> adapter subscribes only to its facade slices

PKM primary surface
  -> DocumentList(scope, commands, searchInputRef, paneRef)
  -> documentBrowserStore stable slices + nonce/ack reveal intent
  -> existing command adapters
  -> workspace/document APIs

Shared Panel
  -> TerminalPanel(scope, commands, graphNode, ref)
  -> terminalPanelStore observable task/tab/layout/context slices
  -> runtime controller registry (channels, pumps, native handles, generation handles)
  -> typed terminal IPC(TerminalSessionHandle)
  -> Rust get_session_generation
  -> PTY registry
```

### Recommended Project Structure

```text
src/
├── lib/
│   ├── documentBrowserStore.ts       # canonical browser state and reveal intents
│   ├── terminalPanelStore.ts         # observable terminal state, slices, persistence bridge
│   ├── terminalRuntimeController.ts  # channels, pumps, native handles, handle registry
│   ├── modeRegistry.ts               # descriptor type and generic lookup/renderer helpers
│   └── modeAdapters/                 # one lazily loaded adapter per registered mode
├── components/
│   ├── DocumentList.tsx              # four structural inputs, local interaction state
│   └── TerminalPanel.tsx             # four structural inputs, local DOM/pointer/focus state
└── __tests__/
    └── editorSurfaceRenderIsolation.test.tsx # extended real-shell isolation proof
```

File names other than the locked `documentBrowserStore` and `terminalPanelStore` are discretionary. Keep all shared business/state mechanics in `src/lib/`; do not import components from that layer. [VERIFIED: .planning/PROJECT.md:95-102] `src/lib/ must not import from src/components/`.

### Pattern 1: Stable facade slices, not a whole-shell snapshot

**What:** Publish immutable, cached snapshots by render domain. Each pane subscribes only to the domains it renders, while the command port reads the latest state at invocation time.

**When to use:** For document-browser and terminal observable state that currently forces `MainApp` to rerun. Do not use this store for DOM refs, native terminal handles, channels, input pumps, or context-menu hover state.

**Example:**

```typescript
const slice = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
```

Source: [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore). React requires unchanged snapshots to retain identity; the repository already uses this form in its facade hooks. [CITED: https://react.dev/reference/react/useSyncExternalStore] [VERIFIED: src/lib/outlinePaneStore.ts:391-415]

### Pattern 2: Opaque terminal handle at the IPC boundary

**What:** Define one handle type containing the session ID and generation, accept it in every frontend wrapper and Rust command, and route every lookup through the checked helper.

**When to use:** Every terminal read and mutation, including input, resize, visibility, selection, search, text, scroll, clear, and kill. This is a contract migration, so frontend wrappers and Rust command signatures must move as one task.

**Why:** The existing checked helper rejects a generation mismatch, while several current commands bypass it with `get_session`. [VERIFIED: src-tauri/src/terminal/mod.rs:494-541] `let session = get_session(&state, &session_id)?;` is present on bare-ID commands. [VERIFIED: src-tauri/src/terminal/mod.rs:909-918] `if session.generation != generation {` is the required backend comparison.

### Pattern 3: Lazy descriptor plus adapter

**What:** Keep mode-specific prop adaptation in a dedicated adapter module and make the registry descriptor hold a dynamic-import factory, allowed placement, availability predicate, and fallback identity. `App.tsx` supplies one generic host scope/commands value and renders by lookup.

**When to use:** Every mode that is currently an arm of the `surfaceMode` branch. Do not move activity-rail icon/order/label/shortcut metadata into the registry.

**Example:**

```typescript
const LazyAdapter = lazy(loadAdapter);
```

Source: [React `lazy`](https://react.dev/reference/react/lazy). React caches the loader promise and resolved component, but the loader must be declared outside a render path. [CITED: https://react.dev/reference/react/lazy]

### Anti-Patterns to Avoid

- **Mirroring canonical document-browser data in both `OutlinePane` and `DocumentList`:** it creates dual writes and stale slice identity. Compose both facades from `documentBrowserStore` instead.
- **Putting native terminal objects into an external-store snapshot:** mutable handles violate stable immutable snapshot semantics and broaden re-render fan-out.
- **Leaving a bare-ID escape hatch for one terminal operation:** the stale-generation invariant becomes non-uniform and cannot be table-tested honestly.
- **Building registry descriptors with eager component imports:** it defeats code splitting even if the renderer uses `lazy`.
- **Keeping adapter-specific subscriptions in `MainApp`:** it fails SHELL-08 because a mode-local publish still reruns the shell.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-component state subscription | A bespoke React effect/event-bus subscription layer | Existing module-slot stores with `useSyncExternalStore` | React defines snapshot identity and subscription cleanup semantics; the repository already has a tested precedent. [CITED: https://react.dev/reference/react/useSyncExternalStore] |
| Terminal identity comparison | Per-caller map checks that remember a generation string | One opaque handle and Rust `get_session_generation` gateway | The authoritative PTY registry lives in Rust and is the only location that can reject a recycled ID. [VERIFIED: src-tauri/src/terminal/mod.rs:909-918] |
| Mode discovery | Filesystem scanning or runtime auto-registration | Typed explicit descriptor registry | Static tests can prove every loader is dynamic and every placement/fallback is deliberate. |
| Bundle safety | A new performance harness | Existing `pnpm build` plus `scripts/check-bundle-budget.mjs`, extended with a registry-import guard | The established guard already enforces the entry budget and lazy output chunks. [VERIFIED: scripts/check-bundle-budget.mjs:8-30] |

**Key insight:** The phase's complexity is ownership and lifecycle, not state-container mechanics. Reuse the existing stores, adapters, persistence writer, reducer, and build gates; add only the missing façades, controller boundary, registry, and proof.

## Common Pitfalls

### Pitfall 1: Session generation survives only on stream operations

**What goes wrong:** Input batching, acknowledgements, visibility, selection, and copy may be generation-checked while resize, search, text, scroll, clear, kill, legacy input, or write still accept the recycled ID.

**Why it happens:** The current frontend and Rust APIs mix checked and bare-ID signatures. [VERIFIED: src/lib/api.ts:2056-2105] the checked wrappers take both `sessionId` and `generation`; [VERIFIED: src/lib/api.ts:2110-2163] resize through kill use only `sessionId` today.

**How to avoid:** Inventory every exported terminal wrapper and every Tauri command before changing state ownership, change all signatures to the opaque handle, and add stale/current table rows for each read and mutation path.

**Warning signs:** Any occurrence of a session-scoped wrapper or `get_session` that does not receive a handle/generation; a current-handle success test with no corresponding stale-handle failure test.

### Pitfall 2: Store publishes from render or re-create unchanged snapshots

**What goes wrong:** React warns about updates during render, resubscribes repeatedly, or re-renders unrelated subscribers.

**Why it happens:** A facade publication runs in render, or a selector returns a new object despite unchanged inputs.

**How to avoid:** Publish shell-derived values after commit, cache slice identities, and test unchanged-domain subscribers. The existing `EditorPaneFacade` deliberately publishes in `useLayoutEffect`. [VERIFIED: src/components/EditorPaneFacade.tsx:12-31]

**Warning signs:** `Cannot update a component while rendering`, repeated subscriber renders after a no-op, or React's cached-snapshot error. [CITED: https://react.dev/reference/react/useSyncExternalStore]

### Pitfall 3: Reveal requests collapse when the path repeats

**What goes wrong:** Revealing the same document twice does nothing on the second request.

**Why it happens:** A single pending path is compared by value and is not cleared/acknowledged after consumption.

**How to avoid:** Store a nonce-bearing intent, have `DocumentList` acknowledge it after handling, and test two sequential requests for the same path.

**Warning signs:** `pendingRevealTargetPath` remains a shell prop or a test covers only different paths. [VERIFIED: src/App.tsx:966-968] `const [pendingExplorerReveal, setPendingExplorerReveal]` currently keeps the intent in `MainApp`.

### Pitfall 4: Lazy registry accidentally imports all modes into the entry graph

**What goes wrong:** The code looks declarative but a top-level import or an eagerly evaluated adapter pulls mode code into `index-*.js`.

**Why it happens:** Replacing a ternary with a registry is not, by itself, a dynamic import guarantee.

**How to avoid:** Store import factories, call `lazy` outside render, add an AST/text guard rejecting eager mode imports, and run the real production build plus bundle budget check.

**Warning signs:** A registry module imports a concrete mode component, or the build no longer contains required lazy chunk assets. [VERIFIED: scripts/check-bundle-budget.mjs:19-29] the guard already asserts named lazy assets for GraphView, RichMarkdownEditor, and dictionaries.

### Pitfall 5: Terminal process-global continuity is accidentally keyed to workspace

**What goes wrong:** Switching workspace or mode destroys/recreates tasks, tabs, channels, or restored session placeholders.

**Why it happens:** The terminal facade follows the per-workspace pattern of the document/editor stores without respecting D-06.

**How to avoid:** Keep task/tab/session observable state process-global; only the active launch context changes with workspace/document selection. Preserve the existing persisted task/session serializer semantics. [VERIFIED: src/lib/terminal.ts:472-554] `PersistedTerminalState` serializes tasks and relaunchable session metadata, not live PTYs.

## Code Examples

Verified patterns from official sources:

### External-store subscription

```typescript
const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
```

Source: [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore). Keep `subscribe` stable and return a cached immutable snapshot until a real domain change. [CITED: https://react.dev/reference/react/useSyncExternalStore]

### Lazy adapter declaration

```typescript
const LazyAdapter = lazy(loadAdapter);
```

Source: [React `lazy`](https://react.dev/reference/react/lazy). Declare this at module scope, not inside the generic renderer, so component identity and loader caching remain stable. [CITED: https://react.dev/reference/react/lazy]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Shell-wide prop drilling and nested mode routing | Stable module-store slices, least-authority command ports, and named lazy surfaces | Phase 4 established the facade precedent; Phase 5 completes it | New pane state and mode-specific adaptation move out of `App.tsx`. [VERIFIED: src/lib/outlinePaneStore.ts:391-415] |

**Deprecated/outdated:**

- A broad `MainApp` prop bundle for the two target panes: replace it with the locked four-input boundaries.
- A nested `surfaceMode` rendering chain: replace it with the locked descriptor lookup, not another conditional helper.

## Assumptions Log

All implementation-significant decisions are locked in CONTEXT.md or verified against the live repository. No user confirmation is needed before planning.

## Open Questions

None. The exact names of adapters, controllers, fixtures, and slice groups are explicitly discretionary; the generation, persistence, lazy-loading, render-isolation, and no-UI-change contracts are locked.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Typecheck, Vitest, Vite build, bundle guard | Yes | `v25.9.0` [VERIFIED: local runtime] | None needed |
| pnpm | Repository scripts | Yes | `9.15.0` [VERIFIED: local runtime] | None needed |
| Rust/Cargo | Tauri command-contract and terminal tests | Yes | `rustc 1.98.0`, Cargo `1.98.0` [VERIFIED: local runtime] | None needed |
| macOS host | Required phase-end native Tauri smoke | Yes | `26.6.2` [VERIFIED: local runtime] | No CI replacement; Chromium E2E is insufficient |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `^4.1.5`, React jsdom component harnesses, Rust `cargo test`, and Playwright `^1.59.1` [VERIFIED: package.json:67-80] |
| Config file | `playwright.config.ts`; TypeScript project references include `tsconfig.app.json`, `tsconfig.e2e.json`, and `tsconfig.scripts.json` [VERIFIED: README.md:490-492] |
| Quick run command | `pnpm test -- src/lib/documentBrowserStore.test.ts src/lib/terminalPanelStore.test.ts src/components/TerminalPanel.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx` |
| Full suite command | `make verify && pnpm test:e2e` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SHELL-05 | Four-input `DocumentList`; shared canonical browser slices; repeated reveal acknowledgement; local interaction state stays local | Unit + component + static prop contract | `pnpm test -- src/lib/documentBrowserStore.test.ts src/components/DocumentList.test.tsx` | No, Wave 0 |
| SHELL-06 | Four-input terminal facade; process-global continuity; stale handle rejected/current handle accepted for every session command | TS/Rust unit + component + command-contract table | `pnpm test -- src/lib/terminalPanelStore.test.ts src/components/TerminalPanel.test.ts && cd src-tauri && cargo test terminal` | Store test no, Wave 0; component/Rust tests exist and need extension |
| SHELL-07 | Descriptor lookup renders the correct lazy adapter without eager imports and preserves chunk output | Registry renderer/static guard + production build | `pnpm test -- src/lib/modeRegistry.test.ts && pnpm build` | No, Wave 0 |
| SHELL-08 | Pane/mode updates do not execute `MainApp`; add-state/add-mode drills leave `src/App.tsx` unchanged | Real-shell render harness + static architecture guard + manual drill | `pnpm test -- src/__tests__/editorSurfaceRenderIsolation.test.tsx && pnpm typecheck` | Existing harness, extend in Wave 0 |

### Sampling Rate

- **Per task commit:** focused test command for that task, plus `pnpm typecheck` whenever a public prop, command, or registry type changes.
- **Per wave merge:** `make verify`.
- **Phase gate:** `make verify`, full `pnpm test:e2e`, production build/bundle guard, macOS native smoke, generation matrix, add-state drill, and add-mode drill.

### Wave 0 Gaps

- [ ] `src/lib/documentBrowserStore.test.ts` and a `DocumentList` facade/prop-budget test for SHELL-05.
- [ ] `src/lib/terminalPanelStore.test.ts` plus a Rust/frontend generation-handle table that covers every session-scoped wrapper for SHELL-06.
- [ ] `src/lib/modeRegistry.test.ts` or equivalent static guard for descriptor shape, dynamic import factories, placement/fallback policy, and no eager mode imports for SHELL-07.
- [ ] Extend `src/__tests__/editorSurfaceRenderIsolation.test.tsx` beyond draft typing to document browser publishes, terminal publishes, and a mode-local publish for SHELL-08.
- [ ] Golden existing settings/localStorage fixtures and lifecycle cases for same-key round trip, stale hydration rejection, terminal continuity, and transient-state non-persistence.

## Security Domain

### Applicable ASVS Categories

The planning template uses the ASVS 4.x category labels. OWASP lists V2 Authentication, V3 Session Management, V4 Access Control, V5 Validation/Sanitization/Encoding, and V6 Stored Cryptography in that taxonomy. [CITED: https://devguide.owasp.org/en/08-culture-process/04-asvs/]

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No behavior change | Do not change authentication or provider credentials in this phase. |
| V3 Session Management | Yes | Treat generation as part of terminal session identity at every Tauri command boundary; stale handles must fail. [VERIFIED: src-tauri/src/terminal/mod.rs:909-918] |
| V4 Access Control | No behavior change | Preserve existing command authorization/write gates; this phase only relocates shell state. |
| V5 Input Validation | Yes | Validate the opaque session handle at Rust entry points, retain existing typed IPC wrappers, and avoid direct component `invoke` calls. |
| V6 Cryptography | No behavior change | Do not add cryptography or alter credential/storage handling. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Recycled session ID receives a stale UI operation | Tampering | Require generation-bearing handle for all session reads/mutations, check it against the current Rust session, and table-test stale failure/current success. |
| Mutable native object escapes into a React snapshot | Denial of service / Tampering | Keep channels, pumps, handles, and DOM refs in the runtime controller or component refs; publish only immutable observable data. |
| Registry change eagerly imports a sensitive or heavy mode | Denial of service | Restrict descriptors to dynamic-import factories and enforce the static/bundle guard. |
| Store action bypasses existing command adapter | Elevation of privilege | Keep filesystem/native work behind typed `src/lib` command ports; no direct component IPC. |

## Sources

### Primary (HIGH confidence)

- [README.md](/Users/yj.lee/workspace/work/dev/maru/README.md) - architecture, terminal reliability contract, documented validation commands, and native-smoke limitation.
- [05-CONTEXT.md](/Users/yj.lee/workspace/work/dev/maru/.planning/phases/05-shell-decomposition-completion/05-CONTEXT.md) - locked ownership, generation, registry, persistence, and verification decisions.
- [src/App.tsx](/Users/yj.lee/workspace/work/dev/maru/src/App.tsx) - current target prop bundles, lazy imports, and mode ternary integration point.
- [src/components/DocumentList.tsx](/Users/yj.lee/workspace/work/dev/maru/src/components/DocumentList.tsx) and [src/components/TerminalPanel.tsx](/Users/yj.lee/workspace/work/dev/maru/src/components/TerminalPanel.tsx) - present target prop and runtime ownership boundaries.
- [src-tauri/src/terminal/mod.rs](/Users/yj.lee/workspace/work/dev/maru/src-tauri/src/terminal/mod.rs) and [src/lib/api.ts](/Users/yj.lee/workspace/work/dev/maru/src/lib/api.ts) - actual mixed generation/bare-ID terminal contract.

### Secondary (MEDIUM confidence)

- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore) - subscription, snapshot identity, and stability rules.
- [React `lazy`](https://react.dev/reference/react/lazy) - lazy loader declaration, caching, and Suspense behavior.
- [OWASP ASVS developer guide](https://devguide.owasp.org/en/08-culture-process/04-asvs/) - ASVS category taxonomy used for the security applicability review.

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - all tools are already declared in the repository manifest and existing scripts; no new package selection is needed.
- Architecture: HIGH - ownership and boundaries are locked by CONTEXT.md and verified against current target call sites and terminal command implementation.
- Pitfalls: HIGH - each pitfall is tied to a current prop/runtime/IPC boundary or to official React behavior.

**Research date:** 2026-08-26
**Valid until:** 2026-09-25
