---
phase: 08-main-thread-responsiveness
plan: "15"
subsystem: jobs-and-setup
tags: [rust, tauri, jobs, scheduler, launchd, terminal-hooks, concurrency]
requires:
  - phase: 08-14
    provides: Current isolated registration set and complete original-parent path admission contracts
provides:
  - Nineteen isolated jobs/scheduler/launchd/terminal-hooks commands with preserved synchronous exports
  - Admitted jobs manifest, logs, plist/LaunchAgents, schedule and agent-context-hint writes
  - Thirty behavioral tests and exact nineteen-row evidence
  - Alias-ancestor parent pinning in the shared path transaction helper
affects: [08-16, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 90000
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, owned AppHandle, alias-ancestor parent pinning, lexical admission root, scoped scheduler claim]
key-files:
  created: [docs/performance/phase08-15.json]
  modified: [src-tauri/src/jobs.rs, src-tauri/src/scheduler.rs, src-tauri/src/launchd_migration.rs, src-tauri/src/terminal_hooks.rs, src-tauri/src/atomic_file.rs, src-tauri/src/lib.rs]
key-decisions:
  - PathTransactionRequest now pins an identity-checked parent handle at the deepest existing ancestor of every physical alias, not only of lexical paths, so renaming an alias target fails revalidation instead of slipping through string-equal dangling resolution.
  - All five scheduler admission sites build the transaction from the command's lexical workspace root (canonical path kept as the IO target), keeping symlinked workspaces observable to hooks, conflicts and alias-parent revalidation.
  - JOBS_LOCK stays a short bookkeeping reservation for fresh manifest snapshots; the scheduler run-now claim is a separate process-local set released before dispatch handoff.
  - outlook_mso's pre-existing parallel-suite readiness flake was fixed by raising the test-only PROVIDER_READINESS_TIMEOUT from 300ms to 5s (production stays 10s); proven pre-existing on the pristine tree.
requirements-completed: [PERF-01]
coverage:
  - id: JOBS-SETUP-ISOLATION
    description: All 19 actual IPC futures preserve meaningful synthetic results and error channels while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_15
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 15
        status: pass
    human_judgment: false
  - id: JOBS-SETUP-MUTATION-LIFETIME
    description: Shared admission covers jobs manifests, logs, plist/LaunchAgents, schedules and agent-context hints with original parents and aliases; cross-domain contention in both orders, error/unwind release and alias-parent revalidation pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_15
        status: pass
    human_judgment: false
duration: cross-session
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 15: Jobs and Setup Isolation Summary

All 19 jobs, scheduler, launchd-migration and terminal-hooks commands now run their blocking work and lock waits in awaited workers. Shared admission protects job manifests, logs, LaunchAgents plists, schedules and agent-context hints; original synchronous APIs, wire names and approval checks remain intact.

## Execution and Commits

This plan crossed sessions: the implementation trunk landed uncommitted from a prior session; this session root-caused and fixed the two red tests, closed a latent admission-identity gap, authored the evidence shard and committed everything.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_15 | Passed: 30 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1636 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 15 | Passed: exact 19 rows, 365 production registrations, 0 native-only commands |

The 30 tests comprise jobs 8, scheduler 8, launchd 6 and terminal-hooks 8. Every actual wrapper has a meaningful result/rejection fixture and a same-runtime yield while a distinct blocking worker is held. Mutation cases cover same-target serialization in both orders, error/unwind admission release, parent rename/recreate revalidation, symlink-alias preservation and jobs start/stop/run lifecycle races with fixed local fixture programs.

## Corrections and Evidence History

1. `jobs_descendant_alias_parents_revalidate_before_effects` ("script" variant) failed because `PathTransactionRequest` pinned parent handles only for lexical paths; the physical alias was tracked as a resolved-path string, and a renamed alias target resolves to the identical string through the broken-symlink fallback. `atomic_file.rs::new()` now pins a parent handle at the deepest existing ancestor of every alias using the same open/`same_identity` logic as lexical parents. To-be-created paths pin their existing allocation ancestor (no false positives from sibling creation); legitimately dangling links pin a real ancestor and only its rename/replace fails the transaction.
2. `scheduler_files_parent_and_document_both_orders_aliases` timed out because `set_enabled_impl` built its transaction from the canonicalized workspace while the command's lexical identity (and the test's observation hooks) used the symlinked caller path. The admitted root is now lexical; the same pattern was extended to the four other admission sites (`add_impl`, `scheduler_add`, `scheduler_add_blocking`, `remove_impl`, `scheduler_run_now_blocking`) that shared the latent canonicalize-first gap.
3. The full-suite regression gate surfaced a pre-existing flake: `phase08_14_outlook_auth_actual_wrapper_result_and_same_task_yield` exceeds its 300ms test-only readiness probe under parallel load (proven identical on the pristine tree with this plan's changes stashed). The test-only constant is now 5s; production remains 10s and all timeout-classification tests pass explicit durations.
4. `check-command-isolation --all` reports `08-29 missing 08-16 completed handoff`, identical before and after this shard. That failure traces to the pre-existing uncommitted `skill_host/dispatch.rs` caller-parents work owned by a later plan; overlay validation halts before row validation, so this shard cannot influence it. dispatch.rs is preserved untouched for 08-25/26/29.

## Frontend Handoff and Limits

- `src/lib/api.ts` and `src/components/jobs/JobsTab.tsx` keep existing jobs/scheduler invocation, busy and error handling; `src/components/agents/AgentsPane.tsx` keeps terminal-hooks and agent-context-hint flows. D-04 completion ownership, stale-view protection and exactly-one terminal notices remain Plans25/26.
- `scheduler_run_now` hands its captured parent snapshots to `skills_dispatch_background_with_parents`; the dispatch.rs change carrying that symbol is uncommitted work owned by a later plan and is deliberately not claimed here.
- Admission excludes cooperating in-process writers only. launchctl effects run with fixed argv against the real user domain; tests use fixture labels and disposable homes, and make no live launchd claim beyond fixture observation.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced.
- PERF-01/PERF-02 remain globally pending. This SUMMARY records only Plan15's contribution; next is Plan16, wave17.

## Threats and Self-Check

- T-08-15-01: original-parent and alias-ancestor snapshots, current policy/configuration and real cross-domain both-order tests mitigate owned-write tampering.
- T-08-15-02: awaited blocking workers, same-runtime yield proof, fail-closed revalidation and unwind release mitigate new async-pool stalls and deadlocks.
- T-08-15-03: disposable homes, fixture launchctl labels, synthetic schedules/jobs and selected fake executables constrain the proof; no live user launchd or credential claim is made.

## Self-Check: PASSED

Both task scopes are complete, all 19 owned rows are final in docs/performance/phase08-15.json, and all seven required checks pass. This SUMMARY is committed before state advances to the next plan, and the uncommitted dispatch.rs work remains preserved.
