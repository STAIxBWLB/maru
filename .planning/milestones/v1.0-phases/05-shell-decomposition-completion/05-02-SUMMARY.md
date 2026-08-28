---
phase: 05-shell-decomposition-completion
plan: "02"
subsystem: terminal
tags: [tauri, rust, typescript, ipc, terminal, session-generation]
requires:
  - phase: 05-shell-decomposition-completion
    provides: Document browser facade baseline from 05-01
provides:
  - Opaque generation-bearing TerminalSessionHandle at every terminal IPC boundary
  - Handle-only frontend terminal command wrappers and runtime registry
  - Recycled-session stale/current command matrix contracts
affects: [05-03, 05-04, shell-decomposition]
actuals:
  tokens: 10966
  tasks: 2
  commits: 4
tech-stack:
  added: []
  patterns: [opaque session handles, nested IPC payloads, authoritative Rust generation validation]
key-files:
  created: [src/lib/terminalSessionHandle.test.ts]
  modified: [src/lib/api.ts, src/components/TerminalPanel.tsx, src-tauri/src/terminal/mod.rs]
key-decisions:
  - "TerminalSessionHandle is the only frontend identity accepted by session-scoped terminal wrappers."
  - "Rust validates the handle against the authoritative registry before every read or mutation."
  - "Unknown terminal kills remain idempotent, but a stale handle for a recycled ID is rejected."
patterns-established:
  - "Spawned terminal identities are retained as opaque handles in runtime refs, never reconstructed at individual call sites."
  - "All Tauri terminal commands receive nested camelCase handle payloads and share one generation gate."
requirements-completed: [SHELL-06]
coverage:
  - id: D1
    description: Handle-only TypeScript wrappers and TerminalPanel runtime propagation
    requirement: SHELL-06
    verification:
      - kind: unit
        ref: src/lib/terminalSessionHandle.test.ts
        status: pass
      - kind: unit
        ref: src/components/TerminalPanel.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Rust handle deserialization and stale/current recycled-session command matrix
    requirement: SHELL-06
    verification:
      - kind: unit
        ref: src-tauri/src/terminal/mod.rs terminal tests
        status: pass
      - kind: integration
        ref: cd src-tauri && cargo test terminal
        status: pass
    human_judgment: false
duration: 10m
completed: 2026-08-26
status: complete
---

# Phase 05 Plan 02: Terminal Handle Contract Summary

**Terminal session operations now carry one opaque `(sessionId, generation)` handle from React through every Tauri command, preventing stale recycled IDs from reaching a new PTY.**

## Performance

- **Duration:** 10m
- **Started:** 2026-08-26T14:12:33Z
- **Completed:** 2026-08-26T14:22:29Z
- **Tasks:** 2/2
- **Files modified:** 4

## Accomplishments

- Replaced string and split-generation frontend command parameters with `TerminalSessionHandle` and a single nested `handle` IPC payload.
- Stored the spawn-returned opaque handle in `TerminalPanel` runtime refs, preserving input pump ordering, frame acknowledgement, selection, search, resize, scroll, visibility, and kill behavior.
- Added a serde-compatible Rust handle and routed all session-scoped commands through the shared generation gateway.
- Added frontend inventory/type contracts and Rust stale/current matrix coverage for every planned read and mutation path.

## Task Commits

1. **Task 1: Make the TypeScript terminal command surface handle-only** - `fa6ee28` (test), `428449f` (feat)
2. **Task 2: Enforce the handle at every Rust command and prove the recycled-ID matrix** - `d345e04` (test), `0983cd2` (feat)

## Files Created/Modified

- `src/lib/api.ts` - opaque handle constructor, spawn result, and handle-only terminal IPC wrappers.
- `src/lib/terminalSessionHandle.test.ts` - wrapper inventory, opaque identity, and TerminalPanel propagation contracts.
- `src/components/TerminalPanel.tsx` - stable runtime handle registry passed through all terminal paths.
- `src-tauri/src/terminal/mod.rs` - deserializable handle, authoritative generation validation, and stale/current matrix tests.

## Decisions Made

- Retained a single spawned handle per session generation in the panel runtime registry rather than rebuilding session ID/generation pairs at call sites.
- Kept unknown-session kill idempotent while returning the existing stale-generation error for a recycled current ID.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Full `make verify` reported existing Rust test-build warnings in `today_ai.rs` and `scheduler.rs`; the gate completed successfully and no warning originates in this plan's files.

## TDD Gate Compliance

- RED commits: `fa6ee28`, `d345e04`
- GREEN commits: `428449f`, `0983cd2`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Terminal store/controller extraction can now use a single safe session identity without preserving a bare-ID path.
- Future terminal operations must accept `TerminalSessionHandle` and use the shared Rust generation gateway.

## Self-Check: PASSED

- `src/lib/terminalSessionHandle.test.ts` and the modified terminal implementation files exist.
- All four task commits are present in git history.
- Targeted frontend tests, `pnpm typecheck`, `cd src-tauri && cargo test terminal`, and `make verify` passed after the final implementation commit.

---

*Phase: 05-shell-decomposition-completion*
*Completed: 2026-08-26*
