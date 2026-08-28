---
phase: 05-shell-decomposition-completion
verified: 2026-08-28T08:44:02Z
status: passed
score: 8/8 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  gaps_closed:
    - "Native D-20 completion matrix now has committed per-flow observations."
  gaps_remaining: []
  regressions: []
---

# Phase 5: Shell Decomposition Completion Verification Report

**Phase Goal:** `src/App.tsx` is a shell, not a state container - a new pane can be added without touching it.
**Verified:** 2026-08-28T08:44:02Z
**Status:** passed
**Re-verification:** Yes - after native UAT evidence

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `DocumentList` reads canonical browser state through its exact four-input boundary. | VERIFIED | `DocumentListProps` contains only `scope`, `commands`, `searchInputRef`, and `paneRef`; it subscribes to document-browser slices. `documentBrowserStore` has keyed immutable slices, nonce/ack reveal handling, and cleanup. Focused and full Vitest passed. |
| 2 | `TerminalPanel` is a four-input facade over process-global observable state and a separate runtime controller. | VERIFIED | `TerminalPanelProps` has `scope`, `commands`, `graphNode` plus forwarded ref; `terminalPanelStore` carries only task/tab/layout/context/request/error data while channels, pumps, handles, and disposal live in `terminalRuntimeController`. No terminal-domain Graph import or direct component IPC was found. |
| 3 | Every session-scoped terminal command is generation-handle-only and rejects a stale recycled handle. | VERIFIED | TypeScript wrappers accept `TerminalSessionHandle`; every Rust terminal command obtains `get_session_generation(&state, &handle)` before operating. `cargo test terminal` passed 76 tests, including the stale/current all-command matrix and idempotent unknown kill behavior. |
| 4 | Mode selection is an explicit registry lookup with 18 lazy adapters, placements, availability predicates, and fallbacks. | VERIFIED | `modeRegistry.tsx` has exactly 18 typed descriptors, each using module-scope `lazy` over a dynamic import. `ModeSurfaceHost` enforces availability and placement. Architecture and registry tests passed; the bundle gate verified emitted lazy adapters. |
| 5 | Pane and mode updates do not re-execute `MainApp`, and shell-owned target state is absent. | VERIFIED | Real-`MainApp` render tests cover editor, document-browser, terminal, and graph publications. AST guard enforces <=17 `useState`, <=25 `useEffect`, no target bindings, and no mode ternary; focused/current full Vitest passed. |
| 6 | Adding real pane-local state or a real lazy mode leaves `src/App.tsx` unchanged and restores all sources. | VERIFIED | `node scripts/check-shell-extensibility.mjs` exited 0: state drill, production descriptor/adapter drill, focused tests, typecheck, build, and bundle checks all passed; post-run search found no drill residue. |
| 7 | Persistence and lifecycle remain compatible without mutable runtime resources entering snapshots; Graph's nested workspace flow remains real. | VERIFIED | Existing `maru:terminal:v1` serializer remains; tests reject channels/generation/DOM fields in store snapshots; settings hydrate through existing-key guards. `GraphModeAdapter` resolves a nested vault, caches/scans it, registers the real watcher path, and tests its 150 ms delta/debounce flow. |
| 8 | Native macOS behavior is observed across the complete D-20 matrix. | VERIFIED | Committed `05-UAT.md` records five passed native flows: Documents data/file effects with byte-identical output, real PTY/dock/split/Graph/collapse/recreate, right/primary lazy placement, stale/current generation coverage, and visible render isolation. |

**Score:** 8/8 truths verified

### Locked Decision Coverage

| Decisions | Status | Code/test evidence |
| --- | --- | --- |
| D-01 to D-04 | VERIFIED | `documentBrowserStore.ts`, `DocumentList.tsx`, `outlinePaneStore.ts`, and their contract tests prove four props, canonical slices, nonce-safe reveal, and local interaction state. |
| D-05 to D-08 | VERIFIED | `TerminalPanel.tsx`, `terminalPanelStore.ts`, `terminalRuntimeController.ts`, API/Rust handle gateway, and the 76-test terminal matrix prove the boundary, global continuity, generation handles, and three-layer split. |
| D-09 to D-12 | VERIFIED | `modeRegistry.tsx`, 18 named adapter modules, `ModeSurfaceHost`, registry tests, build, and bundle gate prove descriptor-only lazy routing and placement/gate/fallback rules. |
| D-13 to D-15 | VERIFIED | `shellDecomposition.test.ts` and the real `MainApp` render-isolation harness passed, enforcing hook ceilings, target ownership absence, and non-vacuous consumer isolation. |
| D-16 to D-18 | VERIFIED | Current `make verify` exit 0; 211 Vitest files / 1,942 tests; Playwright 203/203; terminal matrix 76; current extensibility drill exit 0 with `App.tsx` restored. |
| D-19 | VERIFIED | Existing terminal storage key and settings normalization/hydration paths remain; focused store tests verify stale hydration, same-key behavior, cleanup, and transient exclusion. |
| D-20 | VERIFIED | Committed `05-UAT.md` (2967760) records all five required native flow results in a disposable Tauri workspace, including filesystem checksum, live PTY output, right/primary lazy placement, teardown/recreate continuity, and visible isolation. |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/lib/documentBrowserStore.ts` | Canonical browser slices and reveal lifecycle | VERIFIED | Substantive keyed store with slice-specific subscribers, publish, nonce request/ack, and workspace cleanup; consumed by Documents and Outline. |
| `src/components/DocumentList.tsx` | Four-input store-backed document browser | VERIFIED | Exact interface, direct external-store slice reads, local viewport/input/menu/drag state, and nonce acknowledgement. |
| `src/lib/terminalPanelStore.ts` + `src/lib/terminalRuntimeController.ts` | Observable terminal state separated from mutable resources | VERIFIED | Process-global store and separate controller are both substantive and wired by `TerminalPanel`. |
| `src/lib/api.ts` + `src-tauri/src/terminal/mod.rs` | Handle-only terminal IPC gateway | VERIFIED | Opaque handle wire contract and authoritative Rust generation gateway are present and exercised. |
| `src/lib/modeRegistry.tsx` + `src/lib/modeAdapters/` | 18 descriptor-owned lazy surfaces | VERIFIED | All adapters are dedicated modules dynamically imported by the registry; `App.tsx` uses the generic host. |
| `src/lib/*ModeStore.ts` | Mode-local state outside the shell | VERIFIED | Visual, agent runtime, communications, knowledge, document ops, and planning stores are substantive, adapter-consumed, and covered by architecture/isolation tests. |
| `src/lib/shellDecomposition.test.ts`, `scripts/check-shell-extensibility.mjs`, `src/__tests__/editorSurfaceRenderIsolation.test.tsx` | Durable architectural and behavior proof | VERIFIED | Each ran in the current verification; drills restored the touched source byte-for-byte. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `DocumentList.tsx` | `documentBrowserStore.ts` | `useDocumentBrowserSlice` | WIRED | Component reads its rendered browser state from stable external-store slices and acknowledges nonce-bearing reveal intents. |
| `outlinePaneStore.ts` | `documentBrowserStore.ts` | Composed browser records | WIRED | Source and contract tests show shared browser ownership, not synchronized mirrors. |
| `TerminalPanel.tsx` | terminal store/controller/API | Hooks plus opaque handles | WIRED | Store slices drive render; controller carries mutable resources; every wrapper call supplies a handle. |
| `api.ts` | Rust terminal commands | `{ handle }` camelCase IPC payload | WIRED | Rust deserializes `TerminalSessionHandle` and gateway tests cover all commands. |
| `App.tsx` | `ModeSurfaceHost` | Generic host call | WIRED | No `surfaceMode ===` routing branch remains; App renders registry descriptors for primary/right/panel placements. |
| Registry | adapter modules | Dynamic factory + `React.lazy` | WIRED | Build produced named lazy chunks and the budget guard passed. |
| `GraphModeAdapter.tsx` | workspace cache/scanner/watcher | Resolved graph data path | WIRED | Nested-vault test invokes the listener, waits through debounce, and verifies `scanVaultPaths` output reaches `GraphView`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| `DocumentList.tsx` | `queryFilter`, selection, favorites, queue, reveal | Workspace/visibility-keyed browser store published post-commit | Actual workspace index and shell command port data | FLOWING |
| `TerminalPanel.tsx` | task/tab/layout/context/request/error slices | Process-global terminal store; live PTY resources in controller | Runtime terminal tasks, current context, and PTY event channels | FLOWING |
| `GraphModeAdapter.tsx` | `entries`, nested vault root, graph focus | `vaultGraphRoot`, cache, scanner, watcher delta | Current resolved graph workspace data, including nested-vault deltas | FLOWING |
| Mode adapters | Mode hosts and local slices | Dedicated external stores and existing canonical owners | Real workspace/settings/agent/document/task data, not hardcoded props | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Architecture and render-isolation contracts | `pnpm test -- src/lib/shellDecomposition.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx` | 211 files, 1,942 tests passed | PASS |
| Terminal stale/current command behavior | `cd src-tauri && cargo test terminal` | 76 passed, including recycled-session matrix | PASS |
| Extensibility | `node scripts/check-shell-extensibility.mjs` | Exit 0; state/mode drills restored source; bundle 298.7 KiB JS and 61.2 KiB CSS | PASS |
| Full repository verification | `make verify` | Exit 0; 211 Vitest files / 1,942 tests and 1,225 Rust tests | PASS |
| Browser E2E suite | `pnpm test:e2e` | 203 passed | PASS |

### Probe Execution

Step 7c: SKIPPED. No Phase 5 probe script is declared; the production extensibility drill is the declared runnable check and was executed above.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| SHELL-05 | 05-01, 05-11 | `DocumentList` uses a module store instead of the large prop bundle. | SATISFIED | Exact four-prop facade, canonical browser store, Outline composition, reveal/cleanup tests. |
| SHELL-06 | 05-02, 05-03, 05-11 | `TerminalPanel` uses module store/controller ownership instead of the large prop bundle. | SATISFIED | Exact boundary, runtime separation, handle-only IPC, and 76-pass stale/current matrix. |
| SHELL-07 | 05-04 through 05-11 | New mode surfaces use registry entries instead of a nested ternary branch. | SATISFIED | Exactly 18 dynamic descriptors/adapters, generic host, lazy emitted chunks, and drill proof. |
| SHELL-08 | 05-01, 05-03 through 05-11 | Pane state no longer requires `App.tsx` edits. | SATISFIED | Store ownership extraction, zero target owner guard, non-vacuous render isolation, byte-identical App drill, and completed native UAT. |

No orphaned Phase 5 requirements were found, and there are no later milestone phases to which a gap could be deferred.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `DocumentList.tsx` | 540, 551 | Localized search placeholder attribute | Info | UI text, not a stub. |
| `TerminalPanel.tsx` | 973, 2229, 2343 | Restored-terminal/search placeholder text | Info | Deliberate UI/rehydration behavior, not a missing implementation. |

No unreferenced `TBD`, `FIXME`, or `XXX` markers were found in the scoped production artifacts. The existing dirty files are unrelated design-QA images and `.planning/research/`; no Phase 5 source or drill residue is uncommitted.

### Gaps Summary

No gaps found. The committed native UAT closes the only prior behavior-unverified truth; all four requirements and D-01 through D-20 are now verified.

---

_Verified: 2026-08-28T08:44:02Z_
_Verifier: the agent (gsd-verifier)_
