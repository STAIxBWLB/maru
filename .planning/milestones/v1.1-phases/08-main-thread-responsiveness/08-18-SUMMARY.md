---
phase: 08-main-thread-responsiveness
plan: "18"
subsystem: terminal-boundaries
tags: [rust, tauri, terminal, pty, spawn-blocking, concurrency]
requires:
  - phase: 08-17
    provides: Current isolated registration set and exact owned-command evidence schema
provides:
  - Fifteen isolated terminal boundary commands with preserved synchronous exports
  - Unchanged generation tokens, reservation admission/rollback and per-session ordered writer sequence
  - Four behavioral tests and exact fifteen-row evidence
affects: [08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 110000
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, same-name pub mod ipc wrappers, owned TerminalState clone, managed-state-keyed test worker-stage hook, real /bin/cat PTY fixtures via mock_app]
key-files:
  created: [docs/performance/phase08-18.json]
  modified: [src-tauri/src/terminal/mod.rs, src-tauri/src/lib.rs]
key-decisions:
  - All 15 owned rows, including the inventory's eight RETAIN rows, are final-disposition ISOLATED because every session command reaches get_session/get_session_generation, whose TERMINAL_SESSIONS registry wait (.lock()) fails the checker's retained-helper BLOCKING scan; the cheap stream-atomic commands (ack/request_full/set_visibility) were converted with the same thin wrapper for a uniform boundary.
  - The 15 original commands stay public and synchronous with &TerminalState signatures so Rust/CLI callers keep working; wire names and payload/error strings are unchanged and lib.rs registers only terminal::ipc::* paths.
  - Per-session write ordering is preserved without a global queue because every writer (terminal_write/input/input_batch/clear) makes exactly one awaited spawn_blocking call whose payload passes through the existing per-session SharedTerminalWriter mutex; the concurrency fixture proves whole-payload contiguity in both launch orders.
  - The #[cfg(test)] worker-stage hook is keyed by the managed TerminalState identity (Arc pointer of the sessions registry) so concurrently running tests cannot trip each other's boundary hooks.
  - terminal_spawn's body (reservation, spec build, PTY open, child spawn, registry insert, pump/exit thread spawns) moved intact into one blocking worker; the generation token, D-03 reservation rollback and Arc-identity unregister semantics are unchanged, and no terminal lock is held across an await or a child wait.
requirements-completed: [PERF-01]
coverage:
  - id: TERMINAL-BOUNDARIES-ISOLATION
    description: All 15 terminal IPC futures preserve meaningful synthetic results and legacy rejections while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_18
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 18
        status: pass
    human_judgment: false
  - id: TERMINAL-BOUNDARIES-MUTATION-LIFETIME
    description: No filesystem mutation is owned by any terminal command; session identity, reservation rollback, stale-generation rejection, per-session write serialization in both orders and kill/recycle lifecycle pass through the real wrappers.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_18
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 18: Terminal Boundaries Command Isolation Summary

All 15 terminal boundary commands now run their blocking work (PTY creation and process spawn, registry/model/writer/killer lock waits, resize ioctl, bounded grid+scrollback reads) in awaited `spawn_blocking` workers behind same-name `pub mod ipc` wrappers. Wire names, payload types, error strings, generation tokens, reservation admission and rollback, per-session ordered writer sequence and idempotent kill semantics are unchanged.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` work which was not touched.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_18 | Passed: 4 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1671 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 18 | Passed: exact 15 rows, 365 production registrations, 0 native-only commands |

The 4 tests comprise: a same-poll yield + JoinError boundary case for every one of the 15 wrappers (worker held at `spawn_blocking` entry by a `#[cfg(test)]` hook keyed to the test's managed `TerminalState`), a real `/bin/cat` PTY fixture exercising write/search/select/copy/input/batch/ack/visibility/resize/scroll/clear plus unknown-session, stale-generation and idempotent-kill rejections, a concurrent-write fixture proving whole-payload serialization in both launch orders, and a spawn fixture proving reservation rollback on launcher failure, duplicate-id rejection, and kill/recycle generation rotation with stale-handle rejection.

## Corrections and Evidence History

1. `State::clone` clones the borrow, not the `TerminalState`; every wrapper now does `state.inner().clone()` so the owned registry handles cross into `spawn_blocking` (clippy `needless_borrow` then forced `get_session_generation(state, ...)`).
2. `tauri::State` cannot exist outside a managed app, so the fixtures build one with `tauri::test::mock_app()` and `app.manage(TerminalState::default())` (the `telegram_io` phase08_14 precedent). Borrows of a caller-owned `AppHandle` cannot enter the `'static` futures `run` requires: every fixture call goes through owned-argument async helpers or an `async move` block over an owned handle clone (`run_with!`).
3. The first boundary run failed with cross-test interference: the worker-stage hooks matched by command name globally, so hooks registered by the boundary test fired inside the concurrently running real-PTY tests' workers. Hooks are now keyed by the managed `TerminalState` identity (`Arc::as_ptr` of the sessions registry), which also matches the checker requirement that held-hook keys identify the tested state.
4. The pre-existing source-scan test `every_session_command_uses_the_generation_checked_handle_gateway` looked for `pub async fn <command>`; it now scans the synchronous originals (`pub fn <command>(`) since the async same-name wrappers live in `mod ipc` and the generation gateway moved with the original bodies.
5. The full suite emits two pre-existing unused-import warnings in `src-tauri/src/skill_host/mod.rs` and `src-tauri/src/today_ai.rs`; both trace to the preserved uncommitted `skill_host/dispatch.rs` work and are outside this plan's files.

## Frontend Handoff and Limits

- `src/lib/api.ts` and `src/components/TerminalPanel.tsx` keep existing invocation, channel, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. `terminalWrite` and `terminalInput` have no production caller today (TerminalPanel batches through `terminalInputBatch`); the shard records that explicitly. D-04 completion ownership, stale-view protection and exactly-one terminal notices remain Plans25/26.
- No filesystem mutation is owned by any terminal command, so no path-transaction admission was added; session identity is protected by the in-memory registry and generation tokens only.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal-kill escalation was introduced; `ChildKiller::kill` semantics (SIGHUP, no process-group work) are untouched.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan18's contribution.

## Threats and Self-Check

- T-08-18-01: generation-bearing handles validated before every mutation, unchanged reservation/rollback, and real cross-lifecycle tests (duplicate id, stale generation after recycle, both-order write serialization) mitigate owned-session tampering.
- T-08-18-02: awaited blocking workers, same-runtime yield proof on all 15 wrappers, fail-closed unknown-session rejection, idempotent kill latch and disposable PTY fixtures mitigate new async-pool stalls and deadlocks; no terminal lock is held across an await or process join.
- T-08-18-03: mock-app fixtures, synthetic session ids, `/bin/cat` only, and no live workspace, credential, shell history or network claim constrain the proof.

## Self-Check: PASSED

All 15 owned rows are final in docs/performance/phase08-18.json with zero AUDIT, and all required checks pass (phase tests 4/4, full suite 1671/0/3, maru-cli check, clippy, fmt, checker --plan 18). Changes remain uncommitted per the session contract.
