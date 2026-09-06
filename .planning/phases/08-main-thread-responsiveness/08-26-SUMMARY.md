---
phase: 08-main-thread-responsiveness
plan: "26"
subsystem: frontend-processing-callers
tags: [frontend, typescript, tauri, completion-ownership, d-04, d-05, caller-audit]
requires:
  - phase: 08-25
    provides: runProcessingOperation ownership wrapper, fulfilled-result classifiers and the outerOperationId aggregation seam in api.ts/export.ts/studio.ts
  - phase: 08-02
    provides: OperationNotice publisher, module-level operation-ownership pattern and SkillsTab viewScope request guarding
provides:
  - Workspace/request generation guards (processingAdmissionRef in App.tsx, flowAdmissionRef in StudioMode.tsx) that expire on every navigation including A->B->A
  - SkillsTab processing handlers routed through startSkillOperation with explicit per-handler fulfilled classifiers and no second local completion toast
  - Duplicate terminal publishers removed in App.tsx (inbox decide/trash/stage, file queue, export bundle), FilesWorkbench.tsx (runMutation/createFolder/commitRename) and SharedOutboxPane.tsx (handleApply)
  - Plan-12 reconciliation handoff in TodaySyncStatus (provider_outcome_unknown / provider_succeeded_local_commit_failed markers render "외부 처리 결과 확인 필요" and disable ordinary retry for unverified-ID rows)
  - docs/performance/phase08-processing-callers.json with all 365 inventory commands mapped to concrete owner/notice/classifier/refresh evidence and zero unresolved rows
  - startSkillOperation<T> generic with SkillOperationClassification classify seam; 31 focused tests across processingOperations/skillOperations test files
affects: [08-27, 08-28, 08-29]
actuals:
  tokens: 55000
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [generation-ticket view admission (useRef, no new MainApp useState/useEffect), module-owned terminal settlement before view checks, explicit per-handler classify closures flowing into the single OperationNotice, rejection-only contract swallowing at call sites, outerOperationId Studio aggregation with readable inner records, per-row reconciliation markers in a pane-local status component]
key-files:
  created: [docs/performance/phase08-processing-callers.json]
  modified: [src/App.tsx, src/components/settings/tabs/SkillsTab.tsx, src/components/studio/StudioMode.tsx, src/components/today/TodaySyncStatus.tsx, src/components/FilesWorkbench.tsx, src/components/SharedOutboxPane.tsx, src/lib/skillOperations.ts, src/lib/skillOperations.test.ts, src/lib/processingOperations.test.ts, src/lib/i18n/locales/en.ts, src/lib/i18n/locales/ko.ts]
key-decisions:
  - Every user-started processing promise in App/SkillsTab/StudioMode captures a workspace + generation ticket before the await; refresh and state patch run only while the ticket is current, and a newer request in any workspace invalidates older tickets. A->B->A creates a new generation, so a late result from the first A visit cannot overwrite the second A.
  - Terminal settlement and fulfilled classification stay in the module owner (runProcessingOperation / startSkillOperation) before any view-admission check; component cleanup only invalidates view publication, so unsubscribe or navigation cannot discard failure reasons (D-04).
  - SkillsTab handlers carry explicit typed classify closures (add/rescan/remove/create/reset/bundle/adopt -> success-or-info with reasons; install/uninstall -> success/info/error by failure counts) instead of relying on the built-in array/SyncAllOutcome classifier, because their payloads are not SkillRecord[] or SyncAllOutcome; the built-in classifier path is preserved unchanged for syncSource/syncAllSources and direct array results.
  - Duplicate terminal publishers were removed rather than suppressed: component setError/toast after an owned wrapper call deleted in App.tsx (decideInboxItem outcome-error throw, decideInboxKeys file branch, trashInboxTargets, stageInboxFiles, applyQueuedFiles, exportActiveDocumentBundle dispatch branch), FilesWorkbench.tsx (runMutation failed-branch and catch, createFolder catch, commitRename catch) and SharedOutboxPane.tsx (handleApply catch). Each site keeps a swallowing catch because the wrappers rethrow rejections after publishing the one notice.
  - FilesWorkbench.tsx and SharedOutboxPane.tsx are outside the plan's files_modified list but required by the zero-duplicate-terminal-publisher acceptance criterion; recorded as a scope correction in the audit JSON scopeNote.
  - Preflight/approval/read failures keep their existing component owners (approvalGate confirms, dirtyBlocked trash guard, export plan/validate preflight, bootstrapEnv env read, gmail pane branch of decideInboxKeys, hwp_cli unowned invoke branches in StudioMode); only post-start terminal settlement moves to the module owner.
  - Plan-12 handoff implemented as specified in today_outbox.rs contracts: TodaySyncStatus shows "외부 처리 결과 확인 필요" (today.sync.status.verifyExternal) for provider_outcome_unknown/provider_succeeded_local_commit_failed records, suppresses the auth hint, and hides the ordinary retry button when no verified googleTaskId exists; verified known-ID retry is retained.
  - The pre-existing uncommitted src-tauri/src/skill_host/dispatch.rs change (skills_dispatch_background caller-parent preservation, 143+/6-, tests phase08_15_dispatch_caller_parents_* in mod phase08_29_dispatch) was verified against this plan's stale-selection/caller-parent contract and kept as-is; it is reported as verified disposition, not authored by this plan.
requirements-completed: [PERF-01, PERF-02]
coverage:
  - id: FRONTEND-CALLER-AUDIT-CLOSURE
    description: All 365 inventory commands map to a concrete frontend caller, owning wrapper/store, terminal-notice dedupe key, fulfilled classifier and domain fields, successful-result retention, actionable failure-reason source, progress ownership and view guard; zero unresolved rows; dormant commands (hwped_*, shelf memos, unused skills wrappers) record checked symbol references instead of invented UI; no ordinary read produces a success notice.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/skillOperations.test.ts
        status: pass
      - kind: audit
        ref: docs/performance/phase08-processing-callers.json
        status: pass
    human_judgment: false
  - id: D-04-VIEW-GUARD-CONSOLIDATION
    description: Persisted mutations finish after navigation but no stale component data overwrites B or later A; fulfilled mixed/all-failed results produce exactly one correctly classified notice across toast channels with retained reasons/successes; A->B->A creates a new generation in App, Skills and Studio flows.
    requirement: PERF-02
    verification:
      - kind: unit
        ref: pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/skillOperations.test.ts
        status: pass
      - kind: regression
        ref: pnpm test (full suite, 2090 passed)
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 26: Scope Visible Refreshes and Close Processing Callers Summary

D-04/D-05 caller closure is implemented for the user-started processing surface. App.tsx, SkillsTab.tsx and StudioMode.tsx now capture a workspace + generation ticket before every owned processing promise, delegate mutation settlement and fulfilled classification to the Plan-25/08-02 module owners, and remove their duplicate terminal toasts. The 365-command inventory is fully dispositioned in `docs/performance/phase08-processing-callers.json` with zero unresolved rows.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` caller-parents work (verified, not touched).

| Command | Disposition |
|---|---|
| pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/skillOperations.test.ts | Passed: 31 passed, 0 failed |
| pnpm test (full suite, regression check) | 2090 passed, 0 failed; the single failed suite `scripts/check-command-isolation.test.mjs` ("No test suite found") reproduces identically on pristine HEAD - pre-existing, unrelated to Plan 26 |
| pnpm typecheck | Passed (zero errors in final state) |
| pnpm lint (eslint src e2e e2e-native --max-warnings 0) | Passed |
| pnpm lint:i18n | Passed: 3768 keys in parity (3763 baseline + 5 new keys) |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full) | Passed: 1756 passed, 0 failed, 3 ignored |

## Owned wrappers and guards

- App.tsx: `processingAdmissionRef` + `beginProcessingAdmission(workspace)` issue generation tickets; `decideInboxItem`, `decideInboxKeys` (file branch; gmail branch keeps its pane-local owner), `trashInboxTargets`, `stageInboxFiles`, `applyQueuedFiles` and `exportActiveDocumentBundle` refresh/patch only while their ticket is current, and their post-start `setError` duplicates were removed (kept: approval preflights, export plan/validate preflight, queue-item inline detail). `agentErrorMessage` and the approval gate are untouched.
- SkillsTab.tsx: `runSkillProcessing<T>` routes addSource, rescanSource, applyBundleUpdate, removeSource (optimistic removal guarded by a captured `isCurrent` closure), createManagedSkill, installSkills, uninstallInstalls, adoptExternalLinks and resetRegistry through `startSkillOperation` with explicit per-handler classifiers; the local progress/toast machinery (`runOperation`, `runBackendProgressOperation`, `updateOperationProgress`, `recordOperationError`, `SkillProgressEvent` import) is deleted. Component-owned survivors: refreshWithProgress, checkBundleUpdate, loadBundleStatus, bootstrapEnv (skills-env:// event flow), openSkillEditor, syncSource/syncAllSources (08-02 routing).
- StudioMode.tsx: `flowAdmissionRef` + `beginAdmittedFlow(workspace)`; the workspaceRoot effect bumps the generation on every switch. `scanHwpFields`/`fillHwpTemplate` wrap the owned `templatePrepareHwpxTemplate`/`templateFillHwpx` calls in inner try/catch that swallow rejections (module owns the notice) while unowned hwp_cli/read branches keep the outer component catch as the single publisher; `runExport` treats exportPlan failures as preflight (component setError) and exportDispatch failures as wrapper-owned.
- FilesWorkbench.tsx / SharedOutboxPane.tsx (scope correction, outside files_modified): runMutation's failed-branch and catch setError, createFolder/commitRename catch setError, and handleApply catch setError removed; dirtyBlocked preflight and all read/config setErrors retained.
- TodaySyncStatus.tsx (Plan-12 handoff): reconciliation markers `provider_outcome_unknown:` / `provider_succeeded_local_commit_failed:` render the warn badge "외부 처리 결과 확인 필요", suppress the auth hint, and disable ordinary retry for rows without a verified googleTaskId; verified known-ID retry is retained (Rust already rejects unknown-ID upsert retry in today_outbox.rs).
- i18n: en/ko gained `skills.operation.complete|partial|error`, `today.sync.status.verifyExternal` and `today.sync.verifyExternalHint`.

## dispatch.rs disposition (verified, not authored)

The pre-existing uncommitted `src-tauri/src/skill_host/dispatch.rs` change threads `parents: Vec<PathTransactionParent>` from `skills_dispatch_background` into `DispatchWrites.caller_parents` and re-validates via `require_caller_parents` on event writes, mission writes and owned writes. This matches the stale-selection/caller-parent contract this plan audits: background stream/completion callbacks cannot apply proposals to a replaced parent selection. Its two tests `phase08_15_dispatch_caller_parents_reject_replacement_before_first_effect` and `phase08_15_dispatch_caller_parents_survive_into_real_proposal_callbacks` (mod `phase08_29_dispatch`) pass as part of the full 1756-test cargo run. The code was kept as-is.

## Caller audit

`docs/performance/phase08-processing-callers.json` records all 365 inventory commands: 18 owned-wrapper rows (runProcessingOperation with named classifiers and view guards), 11 skill-operation rows (startSkillOperation), 5 mission-event rows (module-level mission owners with event settlement, including dispatch.rs caller-parent evidence), 21 today-pane rows (Plan-12 reconciliation handoff on retry/drain), 4 skill-editor-window rows, 6 proposal-approval rows, 3 inline-request rows, 105 ordinary-read rows, 168 component-owned-sync-write rows, 1 component-owned outer flow (hwp_cli_template_fill), 1 component-owned event flow (skills_env_bootstrap), 20 dormant rows with checked symbol references (hwped_* engine bridge, shelf memos, unused skills wrappers) and 2 test-only rows. `unresolvedRows: 0`.

## Corrections and Evidence History

1. The plan's "WorkspaceMutationOutcome.status=error handling" branch lives in FilesWorkbench.runMutation, not App.tsx; the fix was applied there plus the two sibling catch publishers, and recorded as a scope correction.
2. `t` was dropped from three App.tsx dependency arrays during notice consolidation but is still used by prompt/approval/preflight strings; exhaustive-deps flagged it and the arrays were corrected.
3. StudioMode's unified fill response was narrowed to `TemplateFillResponse` (the hwp_cli subtype adds only templateAlias/templateSlug, unused after the call), and the skillOperations explicit-classify test mock gained a typed parameter for TS2493.
4. Baseline drift vs 08-25's summary: the i18n placeholder failure recorded there no longer reproduces (suite now 2090 passed); the only pre-existing full-suite failure today is the suite-less `scripts/check-command-isolation.test.mjs`, verified identical on pristine HEAD via stash.

## Frontend Handoff and Limits

- PERF-01/PERF-02 remain globally outstanding across the phase; this SUMMARY records only Plan 26's caller-closure contribution.
- Dormant commands gained no UI (per plan); if a future surface adopts hwped_* or the unused skills wrappers, those rows must graduate to owned wrappers before shipping user-started flows.
- today_outbox.rs, dispatch.rs and all other Rust sources were not modified by this plan.

## Threats and Self-Check

- T-08-26-01: no backend permission, containment or revision behavior changed; owned inputs and revision checks (today_conflict, caller parents) are consumed, not altered.
- T-08-26-02: finite promise lifetimes only; tickets are plain useRef generations with no guard held across awaits beyond the boolean check, no retry, no queue.
- T-08-26-03: notices carry workspace paths, labels and backend reason strings only; the audit JSON records synthetic/symbol evidence, no credentials or live-workspace data; production artifacts gained no test hooks.

## Self-Check: PASSED

Both task verify commands pass exactly (31/31 focused tests; typecheck clean), the full vitest suite shows zero test failures (only the pre-existing suite-less file failure identical on pristine HEAD), lint/lint:i18n/cargo check/clippy pass, and the full 1756-test cargo run passes including the verified dispatch.rs caller-parents tests. The caller audit has 365 rows and zero unresolved. Changes remain uncommitted per the session contract.
