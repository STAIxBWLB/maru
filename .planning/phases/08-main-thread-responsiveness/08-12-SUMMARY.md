---
phase: 08-main-thread-responsiveness
plan: "12"
subsystem: calendar-and-evidence
tags: [rust, tauri, calendar, outbox, evidence, concurrency]
requires:
  - phase: 08-11
    provides: Complete Today/lifecycle leases and borrowed-adapter consumer contracts
provides:
  - Twelve awaited blocking IPC boundaries with unchanged synchronous APIs
  - Calendar and outbox operation ownership across provider settlement
  - Complete local mutation admission and explicit uncertain-outcome reconciliation
  - Exact twelve-row evidence and thirty-three behavioral tests
affects: [08-13, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 63508
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, borrowed path leases, original parent snapshots, operation RAII, manual reconciliation]
key-files:
  created: [docs/performance/phase08-12.json]
  modified: [src-tauri/src/today_calendar.rs, src-tauri/src/today_outbox.rs, src-tauri/src/web_actions.rs, src-tauri/src/evidence_binder.rs, src-tauri/src/lib.rs, src-tauri/src/today_store.rs, src-tauri/src/today_lifecycle.rs, src-tauri/src/scratchpad.rs]
key-decisions:
  - Provider calls hold owned operation reservations but no path lease or domain mutex; fresh local stages retain original parents and selected aliases.
  - External success and local commit rejection are distinct outcomes; uncertain inserts without IDs never enter ordinary retry.
  - Only the exact successfully persisted calendar state path updates its expected alias under the existing lease.
  - Plan26 must classify settlement markers as external-result reconciliation and disable ordinary UI retry.
requirements-completed: [PERF-01]
coverage:
  - id: calendar-evidence-worker-boundaries
    description: Every owned wrapper yields on its polling task while a distinct blocking worker is held, preserving nonempty outputs and typed or legacy errors.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_12
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 12
        status: pass
    human_judgment: false
  - id: complete-local-and-provider-settlement
    description: Real local command races, selected fake provider traces, duplicate rejection, recovery and manual-only uncertain outcomes preserve local state.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_12
        status: pass
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib today_
        status: pass
    human_judgment: false
duration: 23min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 12: Calendar and Evidence Isolation

Twelve commands now await blocking workers while retaining their original synchronous APIs. Calendar/outbox provider stages preserve local ownership without holding domain locks, and uncertain remote insert outcomes require explicit reconciliation rather than automatic reinsertion.

## Performance and Commits

- Started approximately 2026-09-05T08:00Z; completed approximately 08:23Z.
- Two tasks, nine implementation/evidence files. Actual tokens: 63508, ceiling of 254029 realized diff characters divided by four from `44af61e` through `c6e8bf9`. Three commits count the two tasks and this SUMMARY; shared-state bookkeeping is separate.
- Task 12-1: `b965185`, `perf(08-12): isolate calendar outbox and web action transactions`.
- Task 12-2: `c6e8bf9`, `perf(08-12): isolate evidence binder and record command verification`.
- The first task stages only its ten command registrations; the second adds both Binder registrations. Original sync APIs stay available in each committed tree. Normal commit hooks were not bypassed; no coauthor trailer, branch creation, push, merge or release occurred.

## Owned Commands and Inputs

All rows finish ISOLATED and register as their defining module's `ipc::<same_name>` in `lib.rs`. Every wrapper owns its arguments before awaiting `spawn_blocking`; no State/AppHandle adaptation or borrowed runtime representation was needed. Inner `Result<T, String>` or `Result<T, IpcError>` passes through unchanged. Only JoinError receives contextual, display-only `<command>_task_failed` text.

| Module | Commands and original owned arguments |
| --- | --- |
| today_calendar | `today_calendar_commitments`: five String values and Vec<String>; `task_calendar_set_sync`: three String values, PlanItemRef, bool, Option<String>; `today_calendar_publish`: three String values, destination/gws Option<String>, now_iso String |
| today_outbox | `task_integrations_drain`: work_path/now_iso String, gws_path Option<String>; `task_integrations_retry`: work_path String, ids Option<Vec<String>>, now_iso String; `read_task_integrations`: work_path String |
| web_actions | `web_action_repair_task_list_linkage`: original seven String guards/values; `web_actions_import_top`: work_path/logical_day String, dry_run Option<bool>, top_lane_size Option<usize>; `web_actions_scan`: work_path String; `web_actions_apply`: work_path/now_iso String, default_task_list_id Option<String> |
| evidence_binder | `evidence_binder_read`: EvidenceBinderReadRequest; `evidence_binder_mutate`: EvidenceBinderMutateRequest |

- Calendar commitments, integration reads and web scans only read local state. Binder read traverses candidates and inspects files/archives, but its legacy migration is in memory and writes no state.
- Calendar publish captures complete Today state/revisions/events and nested aliases, plus original existing directory handles. Shared admission precedes the Today mutex in `persist_item_sync`; revision retention and state writes remain raw nested participants. A canonical-workspace RAII reservation rejects duplicate publishes before provider insertion while unrelated workspaces progress.
- Calendar rechecks current policy, selected revision and original aliases after admission. Remote success followed by a changed local revision records `calendar_publish_orphan` with event ID and actual remote status, then returns typed `today_conflict` without overwriting the user's edit. A vanished root yields contextual remote counts without recreation. Atomic state replacement may replace its symlink entry; only that exact successfully written path updates its expected alias under the same lease. Other aliases and all original parent pins stay fixed.
- Outbox local requests include Today/outbox/events, task paths from records and nested aliases. Each record's owned RAII token spans provider invocation and local settlement; canonical workspace-record and physical alias keys prevent duplicate recovery. Exact-owner Drop cleanup handles success, failure, unwind and key reuse. No path lease, Today mutex or ownership bookkeeping mutex spans a subprocess.
- Web apply/import/repair admit complete lexical/canonical workspace, resolved task, Today/trash, receipt source/destination, ledger, record and nested alias paths. Existing transitions, Today mutations and outbox writes borrow the outer lease. Receipt moves, journal/ledger changes and rollback stay inside that admission. Git hash-object keeps its existing read-only role.
- Binder mutation reserves lexical/canonical binder subtree, exact state-file alias and optional document source, with conditional registry migration and original parents. `before_effect` precedes the permission loader's possible migration and recovered `BINDER_WRITE_LOCK`. Revision checks, full candidate hashing and atomic writes remain inside the worker. Existing rekey primitives remain raw participants of Plan06/07 complete leases.

## Consumed Plan11 Contracts

- Calendar `persist_item_sync` now receives the admitted lease before acquiring the Today work mutex. Raw `snapshot_revision`, `persist_snapshot` and event append APIs retain their signatures. Calendar selection delegates directly to already-admitted `today_mutate`, with no redundant outer acquisition.
- Outbox supplies `recover_outbox_in_transaction`, `enqueue_record_in_transaction`, `set_record_status_in_transaction` and `write_record_in_transaction`. Plan11 `today_open` recovery and lifecycle complete/reopen/trash callers now pass their existing lease. The original independent synchronous entries remain available.
- Web `apply_receipt` consumes `task_transition_in_transaction`; import consumes `today_mutate_in_transaction`. Neither is called under an already-held Today lock. Lower-level record/event/snapshot writers remain nested rather than independently reacquiring.
- Original source/destination/sidecar and required-parent validation remains active. Shared policy checks use current registered/requested aliases and matching restrictive policies. No historical test bypass was treated as production permission evidence.

## External Outcome and Required Plan26 Handoff

The existing schema and statuses are unchanged. Before a provider call, a Syncing record durably carries `provider_outcome_unknown:` in `lastError`. Active ownership prevents recovery; an inactive marked Syncing record recovers to existing AuthBlocked. Markerless legacy records retain Ready recovery. Ordinary provider failures and known-ID local writeback failures retain their existing backoff behavior.

On successful provider exit followed by local commit rejection, a fresh outbox-only lease may preserve the known provider ID and `provider_succeeded_local_commit_failed:` under the original workspace/outbox/record identity, current permission and last self-written revision. A later explicit retry patches that known task rather than inserting another. An unknown Upsert with no provider ID returns `provider_outcome_requires_reconciliation:` before any selected retry-batch changes. A successful insert response with no ID also becomes manual-only instead of entering automatic reinsertion.

**Plan26 MUST consume both `provider_outcome_unknown:` and `provider_succeeded_local_commit_failed:` markers.** Display `외부 처리 결과 확인 필요`, not the current generic authentication-required label. Disable ordinary UI retry while marked, preserve successful siblings, and use deliberate reconciliation/verified retry. Backend refusal already prevents unknown-ID reinsertion; known-ID explicit retry remains possible. This handoff includes successful responses missing an ID, moved-root recovery and denied local settlement. The current frontend classification is not claimed complete in this plan.

Current completion owners are recorded per row in the evidence shard: `useTodayCalendarSync` publishing/notice/reload, TodaySyncStatus busyRef/try-finally reload, cancelled commitment/read effects, and EvidenceBinderPane loadSeq/mutationSeq/savingRef/optimistic rollback. Durable navigation-safe completion, exactly-one terminal notice and stale-view publication closure remain Plans25/26. No new job service, automatic retry or Phase09 quit mechanism was added.

## Executed Checks

| Command or check | Actual result |
| --- | --- |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_12 | Final 33 passed, 0 failed/ignored; 10.06 seconds after compilation |
| cargo test --manifest-path src-tauri/Cargo.toml --lib today_ | 122 passed, 0 failed/ignored; includes Plan11 and ordinary calendar/outbox/backoff behavior |
| cargo test --manifest-path src-tauri/Cargo.toml --lib web_actions::tests | Final 39 passed, 0 failed/ignored |
| cargo test --manifest-path src-tauri/Cargo.toml --lib evidence_binder::tests | 15 passed, 0 failed/ignored |
| cargo test --manifest-path src-tauri/Cargo.toml --lib tasks::tests | 21 passed, 0 failed/ignored |
| cargo test --manifest-path src-tauri/Cargo.toml --lib document::tests | 21 passed, 0 failed/ignored |
| cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_files::tests | 18 passed, 0 failed/ignored |
| cargo test --manifest-path src-tauri/Cargo.toml --lib ipc_error::tests | 4 passed, recursive ERR-06 included |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo check --manifest-path src-tauri/Cargo.toml --lib | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Final passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 12 | Passed: exactly 12 rows, 365 production registrations, no native-only commands |
| GSD artifact verification | 5/5 passed |
| git diff --check and staged scope review | Passed; unrelated planning files preserved |

All twelve actual futures yield on their polling task while a distinct blocking worker is held, then preserve JoinError. Separate nonempty fixture tests cover typed/legacy errors, same-target contention, current permissions, failed/unwind release, Files rename/trash and document races in both orders with supported aliases, complete Binder rekey and original-parent rejection. Provider success/failure is a captured fake transport outcome, not live integration proof.

## Deviations and Actual Failures

1. **Rule 2, duplicate provider ownership.** Calendar had no provider idempotency key in its insert argv. Temporarily removing only reservation acquisition from the actual wrapper path produced two captured inserts against the required one and exit101. The original source was restored byte-for-byte, and protected execution passes with one insert. Added narrow `CALENDAR_PUBLISH_ACTIVE`/`CalendarPublishReservation` and `ACTIVE_OUTBOX`/`OutboxFlight`, plus request builders and marker constants; these approved identifiers are necessary local ownership helpers, not a dispatcher or queue.
2. **Rule 2, uncertain provider results.** The approved durable marker/manual-refusal correction conservatively changes new interrupted or missing-ID insert recovery. It preserves legacy markerless recovery and normal provider-error/backoff behavior. External success is never represented as rolled back merely because local persistence failed.
3. **Rule 3, prior consumer adapters.** Minimal `today_store.rs`/`today_lifecycle.rs` changes consume borrowed Outbox APIs. Targeted dead-code annotations preserve original independent synchronous helpers after production callers switch adapters. The repair adapter has a documented `too_many_arguments` allowance for its lease plus unchanged seven wire values, after clippy rejected 8/7; no API shape was changed to satisfy lint.
4. **Rule 3, shared fixture publication.** A required legacy web test observed partial registry JSON while a new policy fixture used the existing shared helper. The parent-approved cfg(test) `scratchpad::phase08_08::registry` now publishes identical JSON through `write_atomic`; calendar's local fixture does likewise. All 39 web tests then pass. Atomic publication addresses partial JSON, not a claim of complete semantic isolation for every historical test lacking the Home lock. New fixtures retain the shared Home/config lock.
5. **Calendar alias self-write correction.** The actual state-file symlink fixture initially failed after a successful remote insert because the command mistook its own atomic replacement for external retargeting. Updating only that exact written state's expected alias under admission resolves it; a separate actual external event-file retarget still rejects local commit. A missing temporary registry parent and an incorrect test-helper module import were also corrected before final runs.

## Limits and Threat Dispositions

- T-08-12-01: current permission/revision checks, complete shared sets, original pins, admitted borrowed adapters and real rejection/race cases mitigate the owned mutation boundary. This is application-local exclusion, not locking independent external editors/processes.
- T-08-12-02: awaited blocking workers, same-polling-task proof, short ownership bookkeeping and RAII release mitigate newly concurrent work. Native saturation remains Plans27/28.
- T-08-12-03: every provider test selects and asserts an existing captured fake executable. Fixtures use synthetic data, disposable Home/config, local hash-object with test-local Git settings and scoped TrashFixture. No real calendar events, messages, provider HTTP, installed provider CLI fallback, credentials, system Trash or Finder/open was invoked.
- A vanished or retargeted original outbox/root cannot safely receive a durable settlement update and is never recreated. The pre-provider marker survives when its record survives or moves, preventing blind recovery; complete loss or external replacement of that record cannot provide exactly-once delivery. Calendar reservations prevent concurrent duplicates, not crash-proof or manual-retry exactly-once behavior.
- Existing today_ai/scheduler test-build warnings and the macOS linker unwind-size warning remain unchanged; production clippy passes without warnings.
- Only macOS fixtures ran. Windows/native-app/production-artifact proof is not inferred. Plan29's prior installed-Claude fallback and unknown initial external-effect disclosure remain historical and unchanged; this plan does not reinterpret them as safe.
- PERF-01/PERF-02 remain globally pending until sibling, frontend and native gates complete. This SUMMARY records the Plan12 contribution only.

## Self-Check: PASSED

Both task commits, all required artifacts and the exact twelve final evidence rows exist. Required checks pass, no unrelated dirty files were staged, and SUMMARY is committed before state advances to Plan13 (wave14).
