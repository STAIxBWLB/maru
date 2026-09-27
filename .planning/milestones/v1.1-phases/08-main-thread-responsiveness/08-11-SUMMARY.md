---
phase: 08-main-thread-responsiveness
plan: "11"
subsystem: today-transactions
tags: [rust, tauri, today, tasks, concurrency, permissions]
requires:
  - phase: 08-06
    provides: Complete path admission, original parent identities and scoped worker barriers
  - phase: 08-07
    provides: Real document and Files wrappers plus synthetic Trash fixture
  - phase: 08-09
    provides: Read-only capture preparation and borrowed task materialization adapter
  - phase: 08-10
    provides: Serial registration baseline and per-command evidence contract
provides:
  - Ten awaited blocking IPC boundaries with unchanged synchronous APIs and wire errors
  - Admitted Today setup, recovery, rollover and lifecycle mutations with nested alias coverage
  - Consumed capture materialization lease through finalize, rollback and replay
  - Twenty-three executed behavioral tests and exact ten-row command evidence
affects: [08-12, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 38441
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, complete path admission, borrowed transaction lease, original parent snapshots]
key-files:
  created: [docs/performance/phase08-11.json]
  modified: [src-tauri/src/today_store.rs, src-tauri/src/today.rs, src-tauri/src/today_lifecycle.rs, src-tauri/src/today_ai.rs, src-tauri/src/tasks.rs, src-tauri/src/lib.rs]
key-decisions:
  - All ten commands isolate filesystem work and lock waits, including logical-day directory normalization.
  - Today capture preparation and materialization share the complete outer lease before the Today mutex.
  - Existing nested symlink endpoints are admitted and rechecked; cycles or unreadable traversal fail before effects.
  - A read-only Today open returns an existing valid snapshot without recovery or journal repair effects.
requirements-completed: [PERF-01]
coverage:
  - id: ten-owned-command-boundaries
    description: All ten actual wrapper futures yield on their polling task while distinct blocking workers are held, preserve real payloads and typed errors, and map JoinError only.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_11
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 11
        status: pass
    human_judgment: false
  - id: today-lifecycle-capture-admission
    description: Actual Today and lifecycle writers serialize against Files and document commands, preserve manual journal text, reject stale revisions and denied aliases, and retain rollback/recovery/replay behavior.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_11
        status: pass
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib today_store::tests
        status: pass
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib today_lifecycle::tests
        status: pass
    human_judgment: false
duration: 15min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 11: Today Transactions Isolation Summary

Ten Today commands now await blocking workers. Setup, recovery, rollover, AI plan application and task lifecycle writes retain their synchronous domain APIs while complete path admission precedes the Today mutex and lasts through capture creation, journal persistence, rollback and replay.

## Commits and Scope

- Task 11-1: `3cd6c21`, `perf(08-11): isolate Today transactions with complete path admission`.
- Task 11-2: `3a6d1b8`, `perf(08-11): isolate Today AI planning and record command evidence`.
- Two tasks, seven implementation/evidence files; this SUMMARY is the third commit. Shared state advancement is separate. Execution ran approximately 07:44-07:59 UTC on 2026-09-05. Actual tokens are rounded-up characters/4 over the 153764-character seven-file diff from `c299f84` through `3a6d1b8`, not harness usage.
- Lifecycle and AI work were delegated by disjoint file; the parent serialized source freezes, compilation, registration and commits. The documented harness isolation degradation remains in force: same checkout on `docs/phase-08-context`, no new branch/worktree, push, merge or release. Normal hooks, explicit file staging, English commit messages and no coauthor trailers.
- Preserved unrelated Phase07 research/validation edits and untracked runtime/planning artifacts. No provider, installed executable, credential store, system Trash, external message or real workspace was used by fixtures.

## Exact Commands and Owned Inputs

All ten registrations are `module::ipc::command`, with unchanged wire names. Original public synchronous signatures remain available. There is no borrowed State/AppHandle/reporter adaptation and no guard crosses await.

| Module and commands | Exact owned arguments | Result error |
| --- | --- | --- |
| today_store: `today_open`, `today_rollover` | `work_path`, `now_iso`, `timezone`, `day_start`, `sleep_start`: String | String |
| today_store: `today_mutate` | `work_path`, `logical_day`, `expected_revision`: String; `mutation: TodayMutation` | IpcError |
| today_store: `today_finalize_setup` | `work_path: String`; `request: TodayFinalizeSetupRequest` | IpcError |
| today_store: `read_task_events` | `work_path: String`; `month`, `day`: Option<String> | String |
| today: `today_logical_day` | `work_path`, `now_iso`, `timezone`, `day_start`: String | String |
| today_lifecycle: `task_transition` | `work_path: String`; `request: TaskTransitionRequest` | IpcError |
| today_lifecycle: `task_trash` | `work_path`, `task_path`, `expected_task_hash`: String; `remote_delete: Option<bool>` | IpcError |
| today_ai: `today_build_plan_request` | `work_path`, `logical_day`: String | String |
| today_ai: `today_apply_plan_result` | `work_path`, `logical_day`, `expected_revision`, `output_json`, `sleep_start`: String; `valid_refs: Vec<PlanItemRef>` | IpcError |

Inner errors pass through unchanged. JoinError alone becomes display-only `<command>_task_failed` with an empty code for typed commands. The recursive ERR-06 guard has no new exception. `today_logical_day` was originally classified RETAIN, but its reached `normalize_existing_dir` performs filesystem work; its final disposition is ISOLATED. Event-log and AI-context reads also have real filesystem payloads and are isolated, not assumed bounded by file size.

## Admission and Preserved Domain Behavior

- Store mutation requests reserve `.maru/today`, revisions, events, outbox, finalize journals, `tasks`, active allocation and daily journals. Lifecycle requests additionally reserve the exact source note, resolved task root/active/archive buckets, actual target parent and `.maru/trash/tasks`. Collision-selected filenames, event files, receipts and rollback are inside the admitted subtree sets.
- Original lexical workspace aliases and resolved endpoints both participate. Existing nested symlink endpoints are discovered with `WalkDir::follow_links(true)` and `path_is_symlink`, including directory-to-file chains. The shared helper adds physical keys and pins original existing parents. Borrowed adapters rescan and `ensure_covered` the current endpoints before effects; they cannot extend the lease while waiting. Unreadable trees and alias cycles fail before writes rather than silently skipping an endpoint. These conservative scans are finite operation work on blocking workers and may inspect unrelated files inside an admitted allocation subtree.
- Every entry includes conditional legacy registry migration coverage. Shared admission precedes the Today work mutex, which precedes any event append mutex. Current write policy, containment, revision/hash and destination state remain authoritative. The lease stays alive across successful writes, rollback, errors and unwind. `today_open` also admits outbox recovery before its existing Today guard; no nested admission occurs.
- Read-only/delegated `today_open` can return an already valid snapshot, with no recovery, event or projection effect. A missing/new day still fails. Actual policy tests cover aliases in both registration directions, restrictive duplicate registrations and policy changes while an admitted worker waits.
- Lifecycle completion preserves prepared-outbox-before-note, ready-before-bucket-move ordering. Complete, reopen, cancel, defer and local trash retain real frontmatter, hashes, events and synthetic integration records. No provider drain was introduced. Existing `task_trash` is the local `.maru/trash/tasks` move, not a system-Trash operation.
- AI request building only reads persisted context. AI output parsing uses synthetic captured model text; application reaches the authoritative admitted `today_mutate` path. Two actual apply requests with one revision yield one success and one structured conflict, then an explicit fresh retry succeeds.

## Consumed Plan09 Capture Handoff

`today_finalize_setup` now acquires its complete shared lease before the Today mutex, including task allocation, state/revisions/events, journal projection, finalize journal/receipt and all rollback paths. `prepare_capture_task_materialization` remains read-only and runs inside that admitted lifetime. The materialization call is now `tasks::materialize_capture_task_in_transaction(lease, &work, &prepared)`; no second request or domain lock is acquired.

Positive tests create a nonempty capture task and rewrite the plan reference, replay the original receipt without another task, reject an incomplete borrowed set before task creation, and force the second of two captures to fail. The first capture is then rolled back and the same corrected request succeeds on manual retry. Actual `today_open` crash recovery removes unchanged transaction-created files and preserves user-edited siblings. The existing Drafts-to-task borrowed adapter and its rollback regressions remain green.

The independent delayed `tasks::materialize_capture_task` API retains its fresh request and original `PreparedCaptureTask` workspace/target-parent snapshots. Once Today moved to the borrowed API, this retained compatibility path became unused in production. Three narrowly scoped, non-test `expect(dead_code)` annotations document that exact function and its two fields; no implementation or visibility changed.

## Executed Verification

All regression subprocesses used disposable Home/config overrides; new scoped tests additionally own the shared fixture Home lock. No result below represents merely planned execution.

| Command | Actual result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_11` | Task1 final 20 passed; Task2 final 23 passed, 0 failed/ignored, 4.66 seconds after compilation. Store10, logical-day1, lifecycle9, AI3. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib today_store::tests` | 24 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib today_lifecycle::tests` | 11 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib today_ai::tests` | 23 passed, including the three new AI cases. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib tasks::tests` | 21 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib drafts::tests` | 36 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_08_drafts` | 10 passed, preserving borrowed task promotion and rollback. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc_error::tests` | Final 4 passed, including recursive ERR-06. |
| `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | Passed for both tasks; final production output has no warnings. |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Passed. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | Passed. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed. |
| `node scripts/check-command-isolation.mjs --plan 11` | Passed: exactly10 rows, zero AUDIT, 365 production registrations, no native-only commands. |

Actual race matrices use real Today/lifecycle, Files rename/trash and document-save wrappers, never manual admission around an unguarded target. They cover parent-first/child-first and workspace aliases; physical sidecar/destination aliases including a two-level event-file alias; every new writer's same-target contention and unwind/error release; original-parent replacement; stale document hashes; and daily-journal manual content preservation. The blocking boundary tests poll each command on the same task, require a distinct held blocking worker and an async yield before release, and assert contextual JoinError separately from meaningful successful payloads.

## Frontend Completion Ownership

The evidence shard records exact current caller paths. TodayPane owns snapshot reload, its serialized mutation queue, finalize result application and identity checks; TodayExecute and TodayYesterday own current transition busy flags/notices and refresh. Dashboard/App callers own their existing Today read results. `planningModeStore` owns rollover-in-flight, cancellation checks and existing notification/banner flow. Execute/Review own event refreshes. `taskTrash` and both AI command APIs are exported but currently have no mounted production component consumer; the current UI planner is deterministic.

No new automatic retry, duplicate queue, job center or quit behavior was added. D-01/D-02/D-03 source-operation behavior from earlier plans is unchanged. D-04 navigation-safe shared settlement and exactly-one terminal notice, plus D-05 complete payload classification and retained sibling reporting, remain Plans25/26 work; this backend shard does not claim those frontend lifetimes finished.

## Required Plan12 Consumer Handoff

- `today_calendar::persist_item_sync` currently holds `work_lock_for` and calls raw `snapshot_revision`/`persist_snapshot`. Plan12 must acquire its complete path set before that guard, including affected Today state/revisions/events/outbox and any task/journal paths plus aliases and registry coverage. These raw storage helpers remain synchronous participants in that outer lease. `task_calendar_set_sync` currently directly calls `today_mutate`; if it gains outer admission, use `today_mutate_in_transaction` rather than reacquiring.
- `today_outbox::{recover_outbox,enqueue_record,set_record_status}` and the event append from `drain_record` are currently raw helpers. Plan11 calls them under the complete Today/lifecycle outer leases. When Plan12 adds independent admission, it must provide borrowed counterparts and switch Plan11 nested consumers before enabling that admission. Provider/background commit stages require fresh complete requests retaining original parent snapshots; no guard may span provider/network work. Current raw unowned caller routes are not claimed globally isolated or admitted by Plan11.
- `web_actions::apply_receipt` calls `task_transition`; its import path also calls `today_mutate`. These original sync functions now admit internally. If Plan12 gives web-actions an outer lease, use `task_transition_in_transaction`/`today_mutate_in_transaction` before any already-held Today guard, with complete task, receipt, source/destination and rekey coverage. The adapters themselves still acquire the Today guard, so do not call them while already holding that guard.
- `append_task_event_at`, `append_task_event_for`, `persist_snapshot`, `snapshot_revision` and `project_journal` retain their low-level synchronous signatures; do not add independent admission to a nested helper without updating its outer callers. Their Plan11 call chains are admitted; the remaining calendar/outbox routes belong to Plan12.

## Deviations from Plan

1. **[Rule 2 - Missing critical] Read-only open effects.** Existing open recovery/projection could write before the later create/modify guard. Added current capability handling inside admission: an existing valid snapshot remains readable without repair effects. Actual denied-policy/alias tests prove this behavior.
2. **[Rule 3 - Blocking dependency] Retained capture API lint.** The required Plan09 handoff removed the last production caller of the independent capture entry, exposing two production dead-code warnings. Parent-approved minimal annotations in `tasks.rs` preserve the original API and both pinned snapshots, with no blanket allowance or functional producer change. Final CLI/lib/clippy and task/Drafts regressions pass; included in `3cd6c21`.
3. **Fixture/compiler corrections.** An initial temporary AI registration staging experiment hit duplicate command macros; restored the unchanged AI source for the independently compiling Task1 tree, then applied AI wrappers in Task2. One fixture tuple used `&PathBuf` versus `&Path`; normalized the borrowed types. ERR-06 caught three nearby current-directory IO `.to_string()` mappings; contextual IO messages corrected them without a guard exception. Final exact tests and all acceptance gates pass.

## Threat Dispositions and Limitations

- T-08-11-01 mitigated for owned routes by complete alias-aware admission, current capability/revision/hash validation, original-parent rejection and actual recovery/rollback evidence.
- T-08-11-02 mitigated for these finite operations by awaited blocking workers, same-task yield proof, admitted-before-domain ordering and error/unwind release. No global latency, cancellation or quit-durability claim.
- T-08-11-03 mitigated in these fixtures by disposable synthetic data and compile-time test barriers. No model, installed launcher, provider, credential, native Trash or external send ran. Plan29's earlier dispatch-fixture escape and its historically unknown external effects remain unchanged in its own SUMMARY.
- Host verification is macOS. Windows, native saturation/calibrated latency and final shipped-artifact isolation remain Plans27/28 verifier gates. Existing today_ai/scheduler test-build warnings remain unrelated; production clippy is clean. No dependency, platform integration, retry framework or production test API was added.
- Descriptor-less prohibitions still require the final verifier's explicit evidence; this SUMMARY does not replace native/ship gates. PERF-01 and PERF-02 remain globally incomplete under the shared-ID rule. Plan12 (wave13) is next; Phase08 is not complete.

## Self-Check: PASSED

Both task commits exist, all seven owned/dependency artifacts are present, exact ten-command evidence passes, relevant regression and compilation gates pass, and unrelated dirty files remain preserved. Ready for Plan12.
