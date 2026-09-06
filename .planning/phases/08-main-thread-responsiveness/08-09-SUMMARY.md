---
phase: 08-main-thread-responsiveness
plan: "09"
subsystem: tasks-meetings
tags: [rust, tauri, tasks, meetings, concurrency, permissions]
requires:
  - phase: 08-06
    provides: Complete hierarchical path admission, original parent snapshots and scoped worker barriers
  - phase: 08-07
    provides: Actual Files and document wrappers with structured conflict errors
  - phase: 08-08
    provides: Drafts promotion lease reserving task allocation, index and baseline
provides:
  - Fifteen awaited blocking IPC boundaries with unchanged synchronous APIs
  - Admitted task and meeting mutations with current alias-aware write policy
  - Consumed Drafts task promotion lease and pinned read-only capture preparation
  - Twenty-one behavioral cases and exact fifteen-row evidence
affects: [08-10, 08-11, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 39365
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, borrowed transaction lease, pinned parent snapshots]
key-files:
  created: [docs/performance/phase08-09.json]
  modified: [src-tauri/src/tasks.rs, src-tauri/src/meetings.rs, src-tauri/src/project_activity.rs, src-tauri/src/drafts.rs, src-tauri/src/vault_list.rs, src-tauri/src/lib.rs]
key-decisions:
  - Preserve all fifteen synchronous APIs and String results; await blocking workers before filesystem or admission work.
  - Consume the complete Drafts lease through the task adapter without extension or reacquisition.
  - Compare requested and registered workspace aliases and enforce every matching policy, preserving standalone unregistered behavior.
requirements-completed: [PERF-01]
coverage:
  - id: fifteen-owned-command-boundaries
    description: Every actual wrapper yields on its polling task while a distinct blocking worker is held, preserves results and adds contextual JoinError only.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_09
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 09
        status: pass
    human_judgment: false
  - id: admitted-writes-policy-and-handoff
    description: Real task and meeting writers serialize with Files/document operations, preserve successful patches, release on errors and reject disallowed aliases; Drafts promotion preserves index/baseline/rollback.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_09
        status: pass
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_08_drafts
        status: pass
    human_judgment: false
duration: 10min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 09: Tasks and Meetings Isolation Summary

Fifteen task, meeting and project-activity commands now await blocking workers. Seven owned mutation entries admit their complete path sets before policy checks and disk effects. Drafts task promotion reuses its existing lease, and task moves restore original source bytes if destination creation or rename fails.

## Commits and Scope

- Task 09-1: `7368938`, `perf(08-09): isolate task and meeting commands with admitted writes`.
- Task 09-2: `822b8e5`, `test(08-09): prove task rollback and record command isolation evidence`.
- Two tasks, seven implementation/evidence files. This SUMMARY is the third commit; state advancement is separate. Actual tokens are 39365, rounded-up characters/4 over the 157460-character seven-file diff from `a5aff7b` through `822b8e5`, not harness token usage. Duration is approximately ten minutes, ending 2026-09-05T07:17Z.
- Meetings and project activity were delegated by disjoint file. Parent serialized registrations, builds and commits. Same checkout and branch; explicit staging, normal hooks, English messages and no coauthor trailers.
- Preserved unrelated Phase07 research/validation edits and untracked runtime/planning state. No worktree, branch, push, merge, release, dependency, provider connection or external message was created.

## Exact Owned Commands and Inputs

All registrations are `module::ipc::command`. Original synchronous signatures and wire names remain available. All fifteen return their original `Result<T, String>`; inner errors pass unchanged and only JoinError adds `<command>_task_failed` context. No State, AppHandle, borrowed guard or reporter adaptation is needed.

| Module and commands | Exact owned argument types |
| --- | --- |
| tasks: `scan_task_notes` | `work_path: String`, `root: Option<String>` |
| tasks: `read_task_metadata` | `work_path: String`, `rel_path: String` |
| tasks: `create_task_note` | `work_path: String`, `draft: CreateTaskDraft`, `root: Option<String>` |
| tasks: `update_task_status` | `work_path: String`, `rel_path: String`, `status: TaskStatus`, `root: Option<String>` |
| tasks: `update_task_schedule_fields` | `work_path: String`, `rel_path: String`, `fields: UpdateTaskScheduleFields` |
| tasks: `update_task_details` | `work_path: String`, `rel_path: String`, `fields: UpdateTaskDetailsFields`, `root: Option<String>` |
| tasks: `move_task_note` | `work_path: String`, `rel_path: String`, `target_bucket: TaskBucket`, `root: Option<String>` |
| tasks: `append_tasks_log` | `work_path: String`, `line: String` |
| tasks: `read_tasks_log` | `work_path: String`, `limit: Option<usize>`, `event_filter: Option<Vec<String>>` |
| meetings: `scan_meeting_notes` | `work_path: String`, `root: Option<String>` |
| meetings: `read_meeting_metadata` | `work_path: String`, `rel_path: String` |
| meetings: `read_meeting_guides` | `work_path: String` |
| meetings: `append_meetings_log` | `work_path: String`, `line: String` |
| meetings: `read_meetings_log` | `work_path: String`, `limit: Option<usize>`, `event_filter: Option<Vec<String>>` |
| project_activity: `scan_project_activity` | `work_path: String`, `meeting_window_days: Option<u32>` |

## Admission and Domain Behavior

- Create admits the selected bucket allocation subtree, including collision-selected filenames. Status/details/move admit the exact source and complete configured tasks subtree, covering target buckets, conflict-safe allocation and rollback. Schedule patch admits the exact source. Task log admits its exact log path; meeting append admits `.maru` and its exact log. Original lexical workspace endpoints and resolved endpoints both participate; physical aliases and pinned nearest-existing parents come from the shared producer.
- Each mutation request includes `with_workspace_registry`, pins the original workspace, and enters admission in its blocking worker. Task borrowed adapters call `ensure_covered`, registry coverage and `before_effect`; current policy, containment, bucket state and file bytes are read afterward. Meetings uses its admitted closure and original ownership guard. There is no existing task/meeting domain mutex to exempt or duplicate. Whole writes, moves and rollback remain admitted.
- Task metadata patches preserve unrelated frontmatter and body bytes. Both successful concurrent field edits survive. Status/details check move permission before changing bytes; destination failure restores the original source under the same lease. Existing status/bucket and calendar/schedule field semantics remain covered by original tests.
- Original append commands had no permission guard. Added production Modify checks inside admission; meeting append also verifies document ownership. A held admitted worker observes a later readOnly policy and rejects before its log/task write.
- Ordinary reads do not initialize directories or migrate registry state. Project activity's reached project registry helper reads existing JSON/YAML only. Log reads cap result rows but read the full file, so the entire read remains in a worker. Meeting guide settings now resolve through the existing pure `skill_host::fs::maru_home`, preserving production location while honoring scoped test/native home overrides.

## Consumed Drafts Handoff and Next Capture Consumer

- `drafts::drafts_promote_in_transaction` now calls `tasks::create_task_note_in_transaction(lease, work_path, draft, root)` using its existing body/config/index/baseline and resolved `tasks/active` allocation lease. The adapter verifies that entire task allocation without extending or reacquiring the lease. Actual task promotion completes and freezes the exact frontmatter-bearing task bytes. Existing Drafts index-failure regression confirms target/body/baseline/index rollback remains intact. A separate incomplete-lease test fails before creation.
- `tasks::prepare_capture_task_materialization(work: &Path, logical_day: &str, capture_id: &str, draft: CreateTaskDraft)` is now read-only. `PreparedCaptureTask` retains original workspace and nearest-existing target-parent snapshots; its original Clone and Debug traits remain available, with a manual Debug implementation omitting opaque handles. No serialization or wire representation changes.
- `tasks::materialize_capture_task(work: &Path, prepared: &PreparedCaptureTask)` constructs a fresh exact-target request with both original snapshots and conditional registry migration coverage. It delegates to `materialize_capture_task_in_transaction(lease: &PathTransactionLease, work: &Path, prepared: &PreparedCaptureTask)`. Replay still returns the original capture row, unrelated capture IDs still conflict, and removed/recreated original workspace identity rejects without recreating tasks.
- **Required Plan11 handoff:** `today_store::today_finalize_setup` calls prepare around line840 and materialize around line859 while owning the existing Today domain transaction. Plan11 must acquire its complete outer shared lease before that domain guard, covering dynamic task allocation plus Today journal/plan/receipt and rollback paths, then call `materialize_capture_task_in_transaction` with the same operation's lease. Preparation and consumption must remain under that admitted lifetime; independent delayed consumption uses the fresh outer entry and original snapshots. The whole Today finalize transaction, journal ordering and rollback admission remain Plan11-owned and are not claimed closed here.

## Executed Verification

Regression selectors ran with disposable process-level home/config overrides, while the new scoped tests also own their temporary Home guards.

| Command | Actual result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_09` | Final 21 passed, 0 failed/ignored, 1.56 seconds after compilation: tasks11, meetings7, project activity2, Drafts promotion1. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib tasks::tests` | 21 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib meetings::tests` | 11 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib project_activity::tests` | 11 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib drafts::tests` | 36 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_08_drafts` | 10 passed, including task-promotion rollback. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib today_store::tests::finalize` | 5 passed, including materialization replay and rollback. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib vault_list::tests` | 17 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc_error::tests` | 4 passed, including recursive ERR-06. |
| `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | Passed for both tasks. |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Passed. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | Passed. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed. |
| `node scripts/check-command-isolation.mjs --plan 09` | Passed: exactly15 rows, zero AUDIT, 365 production registrations, no native-only commands. |
| `git diff --check` | Passed. |

Every actual wrapper proves same-polling-task yield with a distinct held blocking worker. Every new task writer has same-target contention, failure release and fresh production-policy denial. Actual Files workspace-parent rename runs against all six task writers in both orders, including supported workspace aliases; parent-first rejects without resurrection. Meeting append additionally proves physical symlink-parent exclusion and complete-line append serialization. Actual document save demonstrates structured `document_conflict`, later task/meeting progress and latest-byte patching. No typed error is flattened, including test channels.

## Corrections, Threats and Limits

- **Approved shared permission correction:** `vault_list::assert_maru_can_write` formerly matched raw path strings, allowing alias requests or alias registry entries to miss a restrictive policy. It now compares both using existing `comparable_root` and requires every matching entry to allow the action. Actual wrappers cover canonical registry/alias request and alias registry/canonical request for readOnly and delegated policies, a direct duplicate alongside restrictive alias, and allowed direct aliases. Unregistered standalone behavior remains unchanged; no registry migration/rewrite or parent-root ownership semantics changed.
- **Approved dependent scope:** only the exact Drafts promotion call and its successful-promotion regression changed in `drafts.rs`; no unrelated producer implementation changed. Capture changes remain in the owned tasks module, with the explicit Plan11 lifetime handoff above.
- Initial compilation reported one new unused local, removed before the task commit. The orchestration script's naive positive-count check treated `10 passed` as containing `0 passed`; the actual ten-case run succeeded, and the three remaining regression selectors were then executed separately with corrected parsing. No test failure was hidden. Existing unrelated today_ai/scheduler test-build warnings remain; production clippy is clean.
- T-08-09-01 mitigated for owned entries by complete admission, current capability/containment checks, alias-policy enforcement, denied-write tests and rollback preservation. T-08-09-02 mitigated by finite awaited workers, same-task yield evidence and RAII release; native saturation remains Plan27. T-08-09-03 mitigated by temporary roots/scoped hooks and no external/native process invocation; final artifact isolation remains Plan28.
- No installed Claude/dot, Git, Finder/open, system Trash, provider, credentials or live workspace was used by these tests. Only macOS execution is proven; Windows/native final gates remain open. In-process admission does not exclude external editors or processes. Conservative task subtree admission may serialize independent task mutations sharing a root.
- D-04 API/component completion owners are listed per row, including API-only commands with no current component call. TasksPane local create/status/details settlement and meeting run/review audit settlement remain their existing owners. Plans25/26 still own durable cross-navigation notices and stale refresh prevention; this shard makes no final frontend-lifetime claim. No automatic retry, duplicate queue, job center or Phase09 quit behavior was added.
- PERF-01 is this plan's contribution, not global closure. Unfinished siblings, PERF-02 and native phase gates remain open. Next is Plan10, wave11.

## Self-Check: PASSED

Both task commits and all seven implementation/evidence files exist. Twenty-one focused tests and the exact15 command shard pass. The SUMMARY is committed before shared-state advancement, and unrelated dirty state remains preserved.
