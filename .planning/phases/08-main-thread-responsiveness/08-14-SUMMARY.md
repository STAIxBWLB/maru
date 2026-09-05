---
phase: 08-main-thread-responsiveness
plan: "14"
subsystem: message-providers
tags: [rust, tauri, telegram, gmail, outlook, kakao, concurrency]
requires:
  - phase: 08-13
    provides: Current isolated registration set and complete original-parent path admission contracts
provides:
  - Twenty-three isolated message-provider commands with preserved synchronous exports
  - Admitted provider envelope, SQLite session, legacy drop, relay queue and cursor writes
  - Thirty-two behavioral tests and exact twenty-three-row evidence
  - Original-parent polling settlement and existing thread shutdown ordering
affects: [08-15, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 69846
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, owned AppHandle, original parent snapshots, scoped session reservation]
key-files:
  created: [docs/performance/phase08-14.json]
  modified: [src-tauri/src/telegram_io.rs, src-tauri/src/gmail_gws.rs, src-tauri/src/outlook_mso.rs, src-tauri/src/kakao_relay.rs, src-tauri/src/inbox_drop.rs, src-tauri/src/lib.rs]
key-decisions:
  - ApprovalState representation remains unchanged; owned AppHandle retrieves the real State only inside the worker.
  - Telegram local session and declared legacy outputs remain admitted through subprocess completion, without domain or bookkeeping mutex guards across provider work.
  - Every batch or callback retains its original selected parent; independent settlement reacquires a fresh complete transaction.
  - Existing arbitrary custom-script output outside declared paths remains a delegated external-tool boundary, including legacy execution without work_path.
requirements-completed: [PERF-01]
coverage:
  - id: PROVIDER-ISOLATION
    description: All 23 actual IPC futures preserve meaningful synthetic results and error channels while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_14
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 14
        status: pass
    human_judgment: false
  - id: PROVIDER-MUTATION-LIFETIME
    description: Shared admission covers local provider effects, original parents, aliases, policies and real Files/document competitors; polling start/stop and late callbacks preserve lifecycle ordering.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_14
        status: pass
    human_judgment: false
duration: 15min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 14: Message Provider Isolation Summary

All 23 message-provider commands now run their blocking work and lock waits in awaited workers. Shared admission protects provider staging, Telegram session files, declared legacy outputs and Kakao queue/cursor publication; original synchronous APIs and existing send approvals remain intact.

## Execution and Commits

- Task 14-1: `a5f2cd9`, `perf(08-14): isolate message providers and admit staged session effects`.
- Task 14-2: `2547a50`, `perf(08-14): admit Kakao relay effects and close provider isolation evidence`.
- Two tasks, seven implementation/evidence files. This SUMMARY is the third commit; shared state advancement follows separately.
- Approximately 08:38-08:53 UTC on 2026-09-05. Actuals tokens are 69846, the rounded-up characters/4 estimate over the 279381-character seven-file diff from `1568e06` to `2547a50`; this is not harness token accounting.
- Provider file work was delegated independently; this executor coordinated shared producer admission, registrations, compiled checks, evidence and commits. Tests/builds/commits were serialized. Normal commit hooks, English messages and explicit staging were used; no coauthor trailer or hook bypass was added.
- Same checkout/branch retained the orchestrator's documented harness isolation degradation. No branch, worktree, push, merge, release or external message was created. Unrelated Phase07 research/validation and untracked runtime/planning artifacts remain untouched.

## Exact Command and Input Contracts

Twelve originally synchronous commands gained qualified same-name `ipc` wrappers: Telegram seven, Gmail four and Outlook staging one. Eleven existing async entries retain their original registration and have positive executable evidence. All final rows are ISOLATED; there are no final AUDIT, unproved UI or unproved background exceptions. Telegram's finite start/stop adapters are isolated while its existing polling thread remains the background mechanism.

| Module | Commands and owned worker values |
| --- | --- |
| telegram_io | fetch: TelegramIoState clone plus TelegramFetchOptions; accept: AppHandle<R>, work_path String, TelegramMessage, approval Option<String>; reject: AppHandle<R>, message_id String, approval Option<String>; stage: AppHandle<R>, work_path String, Vec<TelegramMessage>, approval Option<String>; auth: TelegramFetchOptions; start: AppHandle<R>, TelegramIoState clone, TelegramFetchOptions, interval Option<u64>; stop/status: TelegramIoState clone |
| gmail_gws | fetch: vault_path/query Option<String>, max Option<u32>; stage: AppHandle<R>, work_path String, Vec<GmailMessage>, approval Option<String>; auth: vault_path Option<String>; single decision: AppHandle<R>, vault_path Option<String>, message_id String, GmailDecision, approval Option<String>; batch: AppHandle<R>, vault_path Option<String>, Vec<GmailDecisionRequest>, approval Option<String> |
| outlook_mso | fetch: work_path Option<String>, max Option<u32>, m365_path Option<String>; stage: AppHandle<R>, work_path String, Vec<OutlookMessage>, approval Option<String>; auth: work_path/m365_path Option<String>; single: AppHandle<R>, work_path Option<String>, message_id String, OutlookDecision, approval/m365_path Option<String>; batch: AppHandle<R>, work_path Option<String>, Vec<OutlookDecisionRequest>, approval/m365_path Option<String> |
| kakao_relay | status: work_path String; messages: work_path/room_slug String, limit Option<u32>; stage: AppHandle<R>, work_path String, dry_run bool, approval Option<String>; enqueue: AppHandle<R>, work_path/chat/text String, attachment/approval Option<String>; results: work_path String, Vec<String> ids |

Original synchronous exports remain available. Generic AppHandle<R> supports existing concrete app callers and real MockRuntime state fixtures. ApprovalState still owns its original store; no Arc conversion, fabricated State, borrowed guard across await, block_on or dispatcher was introduced. Approval checks happen inside the worker and release their short mutex before path admission or provider execution.

All owned commands originally use String errors and retain that channel. Existing `gws_probe_task_failed`, `telegram_probe_task_failed`, `m365_task_failed`, `m365_probe_task_failed` and `kakao_relay_task_failed` contexts survive for retained wrappers; new wrappers add command-specific display-only JoinError context. StageOutcome and bulk provider outcomes retain per-item errors and successful siblings. Actual document competitors retain typed IpcError and DOCUMENT_CONFLICT assertions; ERR-06 has no added exemption.

## Shared Mutation and Lifetime Contracts

- `inbox_drop::stage_message_json` was a reached raw writer shared by all three providers. The minimal producer integration adds independent admission and `stage_message_json_with_parent` / `stage_message_outcome_with_parent`. Each stage batch captures its selected workspace parent once; later siblings cannot write into a removed/recreated parent. Public synchronous producer entry points remain available.
- Envelope admission covers the configured inbox root, channel allocation directory, exact timestamp/provider/id JSON target, workspace.config.yaml, actual legacy .maru/inbox.json, missing .maru allocation and conditional registry-migration paths. Exact existing file aliases are included. Configuration, parent identity, alias resolution and current Create policy are checked before writes. The original final-file symlink-following `fs::write` and same-second/same-id overwrite behavior remain serialized; no new filename/revision schema was invented. Successful earlier siblings survive later failures.
- No provider uses an outer envelope lease that then reacquires the producer. All actual shared producer callers were enumerated and use independent per-envelope settlement, with the original parent supplied by their batch. No existing Inbox borrowed-copy/move or accepted-item transaction was changed.
- Telegram fetch and auth really write a Telethon SQLite session. Their complete finite subprocess lease covers the selected filename, possible appended .session filename, both filenames' -journal/-wal/-shm and allocation parent. Original parent and alias checks run before process effects. A workspace-owned session has a short registry permission/migration preflight followed by current policy and migration-coverage validation under the session lease. No global registry ancestor is held across provider work.
- The existing Telegram run serialization is represented by an Arc Mutex<bool>/Condvar reservation. Waiters wait in blocking workers; the reservation bookkeeping mutex is dropped during the provider process and RAII releases ownership after success, error or unwind. This is a narrowly scoped session reservation preserving prior serialized behavior, not a job queue or service.
- When legacy_auto_drop has a selected work_path, the same finite lease also covers the declared workspace, configured inbox/drop allocation tree and existing descendant aliases. The fake legacy process proves unchanged argv and actual configured output-parent races. Auth still explicitly uses output-json. Legacy execution without work_path remains supported; arbitrary custom-script output outside known configured paths is the existing delegated-tool boundary, not a claimed completely protected write graph.
- Telegram fetch checks selected configuration before launching and reacquires fresh original-parent admission after provider return. Polling retains the existing dedicated thread. Start/stop use a lifecycle guard; stop removes the poller handle and drops its lock before joining, and the polling thread does not need the lifecycle lock. Callback publication uses fresh admission and the original start parent, preventing stale status/message publication into a replaced workspace. Concurrent starts, status progress, stop/reap and late callbacks have actual-entry fixtures.
- Kakao staging admits relay source paths, actual message/media files, configured inbox/drop, exact destination aliases, cursor/cache publication and necessary creation ancestors. Nested copies verify coverage under that lease. Existing stable-media checks, seen rings, backfill behavior, partial parse errors and cursor behavior remain.
- Kakao enqueue admits the original attachment source, configured relay root and outbox/pending/attachments directories, physical aliases and original existing parents. Current workspace and configured relay policy checks precede local writes. Existing approval, request schema, UUID, attachment bytes and queue paths remain. Relative attachment inputs retain their original cwd-based interpretation with absolute exclusion keys. Enqueue success proves a queued request, never remote delivery.
- Gmail and Outlook remote decisions have no subsequent owned local filesystem settlement. Their existing fixed argv, approval checks, label/category operations, events and partial-success outcomes remain, without filesystem/domain locks across remote calls. This does not claim remote exactly-once or exclusion against independent remote clients. Existing provider deadlines are unchanged; previously unbounded Command::output calls gain scheduling isolation, not an invented duration bound.

## Executed Verification

| Check | Actual result |
| --- | --- |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_14 | Final 32 passed, 0 failed/ignored; 9.13 seconds after 27.82 seconds compilation |
| gmail_gws::tests | 19 passed |
| outlook_mso::tests | 36 passed |
| telegram_io::tests | 7 passed |
| kakao_relay::tests, excluding phase08_14 | 20 passed |
| inbox_drop::tests | 2 passed |
| inbox::tests | 50 passed |
| workspace_files::tests | 18 passed |
| document::tests | 21 passed |
| ipc_error::tests | 4 passed, recursive ERR-06 included |
| skill_host::store::tests::builtin_env_setup_does_not_require_workspace_config | 1 passed |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo check --manifest-path src-tauri/Cargo.toml --lib | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 14 | Passed: exact23 rows, 365 production registrations, 0 native-only commands |
| GSD verify artifacts | 5/5 passed |
| git diff --check and explicit staged-scope reviews | Passed |

Ordinary selectors ran as `cargo test --manifest-path src-tauri/Cargo.toml --lib <selector>`; Kakao added `-- --skip phase08_14`. Those regressions total 178 passed, 0 failed/ignored. Every cargo test process, including all three named-suite attempts and every ordinary selector, had explicit disposable outer MARU_TEST_HOME and MARU_TEST_CONFIG_DIR. New fixtures additionally use the shared Home lock, synthetic source/config/approval data, exact fake executable selection assertions and exact TrashFixture routing. Kakao fixture queue roots are asserted within disposable paths before publication. No installed CLI/auth integration, live account, user session/credential, real relay queue, system Trash, Finder or opener was invoked.

The 32 new tests comprise Gmail7, Outlook8, Telegram12 and Kakao5. Every actual wrapper has a meaningful result/rejection fixture and a same-polling-task yield while a distinct blocking worker is held; spare-runtime-worker progress is insufficient and is not used as proof. Actual mutation cases cover same-target serialization, error/unwind release, Files rename/Trash in both orders and aliases, current policy/configuration, retained siblings, replaced original parents and a Kakao attachment/document race preserving typed stale-revision failure.

## Corrections and Evidence History

1. Shared inbox_drop admission and pinned-parent adapters are a minimal root-approved producer correction outside the original six-file list. Its reached legacy configuration is .maru/inbox.json, not .maru/inbox.yaml; the complete set uses the actual path. No unrelated producer framework was added.
2. Session admission was added after inspecting Telegram's real SQLite effects; scheduling isolation alone would leave session writers outside the shared contract. The later known legacy output extension preserves the original argv and no-work execution instead of disabling the feature to simplify tests.
3. First named run: 27/28 passed; Kakao's new alias observation hook used the pre-resolution lexical alias while the command selected the canonical path, so its barrier timed out. The hook was corrected and the fixture expanded to actual Trash and typed document contention.
4. Second named run: 30/31 passed; the newly expanded Telegram alias/Trash fixture had the equivalent observation-key mismatch. The canonical hook was corrected, and the new legacy local-output case was added. Final32 passes. These were test-observation failures, not evidence of passed unexecuted cases.
5. The initial evidence checker rejected the Outlook bulk row's omitted actual `decide_outlook_item_with_session` helper. The row now names the real call path and passes the exact checker. Precise dead-code annotations retain otherwise unreferenced public synchronous APIs; no warning rule was globally disabled.
6. Existing today_ai/scheduler test warnings and the macOS linker unwind-size warning remain. Production clippy is clean. No earlier Plan29 installed-Claude fallback or Plan13 outer-environment history is erased by this plan's corrected isolation.

## Frontend Handoff and Limits

- App.tsx processCommsChannelNow owns fetch/stage approval, busy/finally, retained messages, errors and inbox refresh. decideInboxKeys owns existing per-item processing outcomes. Gmail success events and Outlook decision events retain their existing behavior. Fetch and a later stage are separate IPC calls, so no spanning parent token across those separate frontend requests is claimed.
- Telegram polling setup uses existing setTelegramPolling and existing silent catches. Auth uses the existing readiness/settings state. accept/reject are exported APIs with no current production frontend caller found. Backend work survives the invoking future; durable notification ownership remains Plans25/26.
- KakaoRelayPanel owns viewer loading/error and explicit send/result-polling state. pollSeqRef invalidates polling on unmount; its current viewer and send settlement do not yet establish the common cross-navigation completion contract. Queued, delivered, failed and still-pending outcomes must remain distinct in Plan26.
- D-04 common lifetime, stale-view protection and exactly-one terminal notices, plus D-05 fulfilled-payload classifiers and manual retry, remain Plans25/26. Plan12's `provider_outcome_unknown:` and `provider_succeeded_local_commit_failed:` reconciliation handoff is unchanged and mandatory for Plan26.
- Admission excludes cooperating in-process writers only. Independent relays, editors, remote clients, package managers and arbitrary user scripts can act outside these local declarations. Only macOS fake-fixture execution is proven; Windows/native-app saturation and production artifact closure remain Plans27/28.
- No automatic retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced. Existing explicit send/auth/retry features remain.
- PERF-01/PERF-02 remain globally pending. This SUMMARY records only Plan14's contribution; next is Plan15, wave16.

## Threats and Self-Check

- T-08-14-01: original-parent and alias snapshots, current policy/configuration, complete local effect sets and real cross-domain tests mitigate owned-write tampering.
- T-08-14-02: awaited blocking workers, same-task yield proof, session RAII, admission release and existing polling shutdown ordering mitigate new async-pool stalls and deadlocks. Existing external-process duration limits remain as documented.
- T-08-14-03: disposable outer and inner fixtures, selected fake executables, synthetic sessions/messages/attachments and exact redirected Trash constrain the proof; no live connected-provider claim is made.

## Self-Check: PASSED

Both task commits and all seven implementation/evidence artifacts exist, all23 owned rows are final and required checks pass. This SUMMARY is committed before state advances to the next plan, and unrelated dirty state remains preserved.
