---
phase: 08-main-thread-responsiveness
plan: "19"
subsystem: watcher-lifetimes
tags: [rust, tauri, notify, watcher, spawn-blocking, concurrency, path-transactions]
requires:
  - phase: 08-18
    provides: Current isolated registration set and same-name pub mod ipc wrapper precedent with state-keyed worker-stage hooks
provides:
  - Eight isolated watcher lifecycle commands with preserved synchronous exports
  - Shared path-transaction admission for the Scratchpad watcher root creation
  - Twelve behavioral tests and exact eight-row evidence
affects: [08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 80000
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, same-name pub mod ipc wrappers, runtime-generic AppHandle<R> commands, owned Arc-wrapped watcher state clones, state-keyed test worker-stage hook, with_path_transactions admission for directory creation, atomic_file PathTransactionTestHook contention fixtures]
key-files:
  created: [docs/performance/phase08-19.json]
  modified: [src-tauri/src/scratchpad_watcher.rs, src-tauri/src/inbox_watcher.rs, src-tauri/src/vault_watcher.rs, src-tauri/src/ops_catalog/watcher.rs, src-tauri/src/lib.rs]
key-decisions:
  - All 8 owned rows, including the inventory's four AUDIT stop rows, are final-disposition ISOLATED because every command body reaches the watcher-slot or control-lock mutex wait (.lock()) or, for starts, recursive native watch registration plus a bounded WalkDir (catalog), which fail the checker's retained-helper BLOCKING scan; the stops were wrapped with the same thin spawn_blocking boundary for a uniform lifecycle boundary.
  - The four watcher state structs now wrap their mutex in Arc and derive Clone, so ipc wrappers move an owned clone sharing the same lock into the blocking worker; the held-hook keys are the Arc pointer identities of those shared mutexes, so concurrently running tests cannot trip each other's hooks.
  - start_scratchpad_watcher's fs::create_dir_all(root) is the only filesystem mutation in the tranche; it is admitted through atomic_file::with_path_transactions (root path, workspace parent snapshot, workspace-registry precondition) inside the blocking worker, before the state control lock publish, with ensure_covered/before_effect revalidation and post-admission access/layout revalidation in start_scratchpad_watcher_in_transaction.
  - Epoch generation claim stays before admission so a concurrent stop still invalidates a slow setup; the ActiveWatcher publish re-checks generation_is_current, preserving stale-start rejection and the superseded-setup invariant without holding any drain-thread guard during teardown waits.
  - Start commands and their emit helpers are generic over tauri::Runtime (AppHandle<R>) following the telegram_io/ai_router precedent, so mock_app fixtures with MockRuntime can drive the real async wrappers; wire payloads, error strings and permission checks are untouched.
requirements-completed: [PERF-01]
coverage:
  - id: WATCHER-LIFETIMES-ISOLATION
    description: All 8 watcher IPC futures preserve meaningful synthetic results and legacy rejections while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_19
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 19
        status: pass
    human_judgment: false
  - id: WATCHER-LIFETIMES-MUTATION-LIFETIME
    description: Shared admission covers the Scratchpad watcher root creation with original parents; cross-domain contention against scratchpad_save in both orders, error-release and idempotent lifecycle races pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_19
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 19: Watcher Lifetimes Command Isolation Summary

All 8 watcher lifecycle commands now run their blocking work (config reads, directory probes, recursive native watch registration, the catalog BU WalkDir, state lock waits) in awaited `spawn_blocking` workers behind same-name `pub mod ipc` wrappers. Wire names, payload types, error strings, watcher epochs, idempotent restart, stale-start rejection, stop-before-start semantics and the Phase 7 generated-directory prune predicate are unchanged.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` work which was not touched.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_19 | Passed: 12 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1683 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 19 | Passed: exact 8 rows, 365 production registrations, 0 native-only commands |

The 12 tests comprise: a same-poll yield + JoinError boundary case for every one of the 8 wrappers (worker held at `spawn_blocking` entry by a `#[cfg(test)]` hook keyed to the test's managed state identity), real tempdir fixtures for each watcher (nonempty results plus unchanged typed/legacy rejections: missing/relative workPath, non-directory vault, empty watch roots, missing workspace_root), a deterministic cross-domain contention fixture proving scratchpad_save waits on the admitted watcher lease and vice versa in both launch orders, a conflict error-release fixture proving a rejected save releases admission so the watcher proceeds with the on-disk content unchanged, an idempotent scratchpad restart/stop generation rotation fixture, and a blocked-start/stop overlap fixture proving lifecycle commands still complete while a start worker is held.

## Corrections and Evidence History

1. The four watcher state structs held their mutex by value, so `State::inner().clone()` could not produce an owned share; each struct now wraps the mutex in `Arc` and derives `Clone`, and the held-hook keys are the `Arc` pointer identities of those mutexes (the 08-18 TerminalState precedent), which also isolates concurrently running tests.
2. `tauri::AppHandle` defaults to the Wry runtime, so the start commands and their emit helpers are generic over `tauri::Runtime` (`AppHandle<R>`), matching the telegram_io/ai_router precedent; `tauri::test::mock_app()` fixtures then drive the real async wrappers with `AppHandle<MockRuntime>`.
3. The first contention run failed because the `PathTransactionTestHook` on the scratchpad root fired for *every* transaction containing the root (the contending save blocked inside the hook callback too, deadlocking the fixture); the hook callback now arms once via an `AtomicBool`, and the held key remains the actually-admitted root path.
4. The missing-workPath rejection fixture initially lived under `std::env::temp_dir()` (/var -> /private/var alias) and tripped the scratchpad containment check; it now uses a non-existent path directly under `/` so the legacy `Cannot resolve Scratchpad watcher workPath` rejection is exercised.
5. The checker's INTEGRATIONS map assigns none of this plan's four modules a later-plan handoff, so the shard records `moduleIntegrationOwner: "08-19"` and no moduleIntegrations entries; `--plan 19` exits 0.

## Frontend Handoff and Limits

- `src/lib/api.ts` (start/stop vault, inbox and scratchpad watchers), `src/components/catalog/CatalogPane.tsx` (`catalog_watcher_start`/`catalog_watcher_stop`) and `src/lib/scratchpadApi.test.ts` keep existing invocation, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. D-04 completion ownership, stale-view protection and navigation-safe terminal notices remain Plans25/26; each row's `processingCaller` annotates the call sites and current completion ownership.
- Only `start_scratchpad_watcher` owns a filesystem mutation (scratchpad root directory creation); it is admitted through `atomic_file::with_path_transactions` before the state control lock, held through creation and publish, and released on every path (the RAII lease covers error and unwind). The other seven commands are read-only lifecycle/registration commands and record positive no-mutation evidence.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced; the catalog pending-flush thread cadence and notify watch teardown semantics are untouched.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan19's contribution.

## Threats and Self-Check

- T-08-19-01: lexical workspace access/layout validation re-runs inside the admitted transaction, the workspace parent handle and workspace-registry precondition are pinned before effects, and the both-orders/conflict fixtures prove no lost update or permission bypass on the owned mutation path.
- T-08-19-02: awaited finite blocking closures, same-runtime yield proof on all 8 wrappers, epoch-claim-before-admission superseded rejection, once-armed deterministic barriers and disposable fixture roots mitigate new async-pool stalls and deadlocks; no watcher guard is held across an await or a drain-thread join.
- T-08-19-03: mock-app fixtures, synthetic fixture paths, `atomic_file::phase08_06::Home` isolation and no live workspace, credential, network endpoint or native test hook claim constrain the proof.

## Self-Check: PASSED

All 8 owned rows are final in docs/performance/phase08-19.json with zero AUDIT, and all required checks pass (phase tests 12/12, full suite 1683/0/3, maru-cli check, clippy, fmt, checker --plan 19). Changes remain uncommitted per the session contract.
