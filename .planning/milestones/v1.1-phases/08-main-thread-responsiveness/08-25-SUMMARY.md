---
phase: 08-main-thread-responsiveness
plan: "25"
subsystem: frontend-processing-completion-ownership
tags: [frontend, typescript, tauri, completion-ownership, d-04, d-05]
requires:
  - phase: 08-24
    provides: Final native-ui isolation shards whose processingCaller rows name api.ts/studio.ts/export.ts wrappers as the Plan25 frontend handoff
  - phase: 08-02
    provides: OperationNotice publisher, useSyncExternalStore error/toast surface and module-level operation-ownership pattern
provides:
  - src/lib/processingOperations.ts with runProcessingOperation, ProcessingOperationContext, ProcessingCompletion, getProcessingOperationsSnapshot, subscribeProcessingOperations, getProcessingOperation and the ProcessingWrapperOptions outer-owner seam
  - classifyWorkspaceMutationCompletion, classifyInboxCompletion, classifyShareOutboxCompletion, classifyBinaryViewerHwpxCompletion in src/lib/api.ts
  - classifyExportDispatchCompletion in src/lib/export.ts
  - classifyTemplatePrepareCompletion, classifyTemplateFillCompletion in src/lib/studio.ts
  - Fifteen owned api.ts processing wrappers (12 explicitly named by the plan plus create_workspace_directory, rename_workspace_entry and trash_inbox_items completing the singleton/batch workspace-mutation and inbox-trash rows) plus exportDispatch, templatePrepareHwpxTemplate and templateFillHwpx
  - One hundred and forty focused tests across four test files with zero retries, unchanged payload identity and exactly one classified terminal notice per flow
affects: [08-26, 08-27, 08-28, 08-29]
actuals:
  tokens: 45000
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [runProcessingOperation owning wrapper, immutable external-store operation records, publishOperationNotice terminal toast, typed fulfilled-result classifiers, rejection-only contract for channel-less payloads, outerOperationId notice suppression for Studio flow ownership, activeLocale plain-TS i18n resolution, controlled-promise vitest lifetimes]
key-files:
  created: [src/lib/processingOperations.ts, src/lib/processingOperations.test.ts]
  modified: [src/lib/api.ts, src/lib/api.test.ts, src/lib/export.ts, src/lib/export.test.ts, src/lib/studio.ts, src/lib/studio.test.ts, src/lib/i18n.ts, src/lib/i18n/locales/ko.ts, src/lib/i18n/locales/en.ts, src/components/SharedOutboxPane.tsx]
key-decisions:
  - runProcessingOperation(context, run, classifyResult) settles exactly once, classifies and publishes in the module owner before any view-admission concept exists, returns the original fulfilled payload by identity, and rethrows the original rejection (Error, String or typed {code,message} wire object) unchanged; a throwing classifier still settles the record once with an all-failed completion and rethrows.
  - The terminal notice is an OperationNotice on the existing errorStore surface; message text is built from new processing.operation.* i18n templates with the label resolved through activeLocale() (localStorage/detect rules, ko fallback) so plain-TS module owners need no React tree.
  - apply_file_queue uses the plan's permitted rejection-only contract (classifier returns null): FileQueueApplyOutcome carries no per-item failure channel, so fulfillment stays silent for the caller's inline view refresh while rejections publish exactly one error notice; binary_viewer_extract_hwpx got a real typed classifier on html/sections/warnings instead.
  - prepare_share_outbox_files had no api.ts wrapper (SharedOutboxPane invoked it directly), so prepareShareOutboxFiles was added to api.ts with the pane switched onto it; the wire payload { workPath, sources, options: { author, replace, dryRun } } is unchanged.
  - manualFallback template prepare maps to a new informational "manual" completion status (reason plus manual next step), never a success claim; template fill with failed validation or unmatched fields is partial-success retaining the generated outputPath in succeeded, per "never equate output existence with full success".
  - Every wrapper gained an optional trailing ProcessingWrapperOptions ({ operationId, outerOperationId }); outerOperationId suppresses only the inner notice while the classified record stays in the snapshot, which is the Plan 26 seam for aggregating template->export Studio flows under one user-flow owner. No StudioMode.tsx/App.tsx/SkillsTab.tsx edits were made (Plan 26 scope).
  - createWorkspaceDirectory, renameWorkspaceEntry and trashInboxItems were included beyond the plan's literal list because classifyWorkspaceMutationCompletion/classifyInboxCompletion explicitly name their singleton outcome shapes and they are user-started processing rows routed through api.ts in the phase08-06/08-10 shards; gmail/outlook/telegram decide/stage wrappers are outside the plan's explicit allowlist and keep their pane-local completion handling.
requirements-completed: [PERF-01]
coverage:
  - id: FRONTEND-PROCESSING-COMPLETION-OWNERSHIP
    description: All fifteen api.ts processing wrappers plus exportDispatch, templatePrepareHwpxTemplate and templateFillHwpx publish exactly one correctly classified terminal notice (success only for all-success, info for partial/empty/manual, error for all-failed/rejection) carrying the initiating workspace, retain successful outputs and actionable reasons on mixed/all-failed fulfilled payloads, preserve original payload and rejection identity, settle after unsubscribe and A->B->A navigation, and never retry.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/api.test.ts
        status: pass
      - kind: unit
        ref: pnpm exec vitest run src/lib/export.test.ts src/lib/studio.test.ts src/lib/processingOperations.test.ts
        status: pass
    human_judgment: false
  - id: FRONTEND-PROCESSING-NESTED-OWNERSHIP
    description: Inner wrappers with an explicit outerOperationId classify and record but suppress their terminal notice, keeping the single-terminal-notice-owner contract for Studio template->export flows; rejection-only applyFileQueue fulfillment never fabricates success.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/export.test.ts src/lib/studio.test.ts src/lib/api.test.ts
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 25: File-Processing Completion Ownership Summary

D-04/D-05 frontend ownership is implemented for the reviewed user-started processing rows. `src/lib/processingOperations.ts` provides `runProcessingOperation(context, run, classifyResult)`: the module owner runs the existing invoke wrapper, classifies the fulfilled payload with an explicit typed classifier (promise resolution alone is never success), records an immutable `ProcessingOperationRecord`, publishes exactly one terminal `OperationNotice` (success / info / error) through the existing errorStore toast surface, and returns or rethrows the caller's original payload or rejection untouched. Component-local setters and view refresh are untouched; navigation cannot discard failure reasons because classification and publication happen in the module before any admission check.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` work which was not touched.

| Command | Disposition |
|---|---|
| pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/api.test.ts | Passed: 75 passed, 0 failed |
| pnpm exec vitest run src/lib/export.test.ts src/lib/studio.test.ts src/lib/processingOperations.test.ts | Passed: 40 passed, 0 failed |
| pnpm test (full suite, regression check) | 2086 passed, 1 failed; the single failure (`src/lib/i18n.test.ts` `syncAllComplete` placeholder) and the `scripts/check-command-isolation.test.mjs` suite-less file fail identically on pristine HEAD — pre-existing, unrelated to Plan 25 |
| pnpm lint (eslint src e2e e2e-native --max-warnings 0) | Passed |
| pnpm lint:i18n | Passed: 3763 keys in parity, no hardcoded UI strings |
| pnpm typecheck | Fails on pristine HEAD with the same two errors in `scripts/check-command-isolation.test.mjs` (TS2550 `Map.groupBy`, TS2739 networkWork overlay type); zero errors in any Plan-25-changed src file |
| cargo check / cargo test | Not run: no Rust file changed by this plan |

## Owned wrappers and classification behavior

api.ts (15 wrappers, all preserve signatures, wire payloads, browser fallbacks and the normalizeIpcError boundary):

- `classifyWorkspaceMutationCompletion` reads singleton/array `WorkspaceMutationOutcome.status` done/error — wraps `applyFileQueue` is rejection-only (see below), `createWorkspaceDirectory`, `renameWorkspaceEntry`, `duplicateWorkspaceEntries`, `pasteWorkspaceEntries`, `trashWorkspaceEntries`.
- `classifyInboxCompletion` reads singleton/array `InboxDecisionOutcome`, `InboxDropStageOutcome` and `InboxTrashOutcome` ok/error — wraps `trashInboxItems`, `stageInboxDropFiles`, `acceptInboxItem(s)`, `applyInboxDecisions`, `rejectInboxItem(s)`. Labels come from fileName/id/originalPath; successful references keep targetPath/originalPath.
- `classifyShareOutboxCompletion` reads `ShareOutboxResult.ok/error/output` — new `prepareShareOutboxFiles` wrapper; `SharedOutboxPane.tsx` now calls it instead of raw `invoke`.
- `classifyBinaryViewerHwpxCompletion` reads `BinaryViewerHwpxPreview.html/sections/warnings` — wraps `binaryViewerExtractHwpx`; empty extraction with warnings is all-failed, never a silent success.
- `applyFileQueue` uses the plan's rejection-only contract: the `FileQueueApplyOutcome` wire type has no failure channel, so the classifier returns null, fulfillment stays silent for the FilesWorkbench inline refresh, and a rejection publishes exactly one error notice.

export.ts: `exportDispatch` wrapped with `classifyExportDispatchCompletion` from `results[].success/output_path/format/reason`, falling back to `summarizeValidation(response.validation)` when a failed result carries no reason; manifest/validation payloads pass through unchanged.

studio.ts: `templatePrepareHwpxTemplate` wrapped with `classifyTemplatePrepareCompletion` (ready+preparedPath = success; manualFallback = informational "manual" with its reason, never a success claim; other/empty preparedPath = all-failed). `templateFillHwpx` wrapped with `classifyTemplateFillCompletion` (validationOk with no failed checks/unmatched fields = success; otherwise partial-success retaining outputPath in succeeded while failed checks and unmatched fields carry actionable reasons — output existence is never equated with full success). Browser fallbacks (`template_prepare_requires_tauri` / `template_fill_requires_tauri`) are preserved.

## Corrections and Evidence History

1. The first implementation of the classifier-throw path let a throwing classifier skip settlement entirely (no record, no notice); `runProcessingOperation` now catches classifier errors, settles the record once with an all-failed completion, publishes the error notice and rethrows.
2. Typed wire rejections (`{ code, message }` plain objects from Tauri) rendered as "[object Object]" in the notice reason; `rejectionReason` now extracts `code: message` mirroring the IpcError display format, while the caller still receives the original object by identity.
3. `pnpm typecheck` and the full vitest suite both fail on pristine HEAD for reasons predating this plan (committed 08-29 checker test type errors and an i18n placeholder drift); both were verified failing identically in a detached HEAD worktree, so Plan 25 introduces zero regressions there.
4. Two ko.ts label values were initially written with mojibake by the editing channel and were repaired ("새 디렉터리", "문서 내보내기"); `lint:i18n` and a U+FFFD scan confirm the dictionaries are clean.

## Frontend Handoff and Limits

- Plan 26 seams are in place but not wired: `ProcessingWrapperOptions.outerOperationId` suppresses only the inner notice while the classified record stays readable via `getProcessingOperation(operationId)`, so StudioMode can aggregate template->export under one user-flow owner; `subscribeProcessingOperations`/`getProcessingOperationsSnapshot` give the view layer an immutable store for stale-view protection and provider reconciliation markers.
- Ordinary reads/scans stay unwrapped: `describeFileQueueSources`, all `scan_*`/`read_*` wrappers, `exportPlan`/`exportValidate`, `templateGetFields`, `hwpCliTemplateFields`/`hwpCliTemplateFill` and the gmail/outlook/telegram decide/stage wrappers were not given operation owners; comms decide/stage rows keep their pane-local completion handling and are outside the plan's explicit allowlist.
- No automatic retry, duplicate queue, job center, new dependency, live-workspace/credential hook or Phase 9 quit escalation was introduced; wrappers keep single-invoke semantics (tests assert `invoke` called exactly once).
- PERF-01/PERF-02 remain globally outstanding; this SUMMARY records only Plan 25's frontend completion-ownership contribution. No Rust evidence is claimed.

## Threats and Self-Check

- T-08-25-01: no backend permission, containment or revision behavior changed — wrappers call the same registered commands with the same owned arguments; denied-write fixtures in the mixed/all-filled tests assert typed rejection propagation unchanged.
- T-08-25-02: finite promise lifetimes only; the operation record settles once (duplicate settle guarded), subscribers are plain Set cleanup with no cancellation or retry on unmount, and late registration cannot republish (notice dedup by operationId plus settled guard).
- T-08-25-03: notices carry only workspace paths, user labels and backend-provided reason strings; no credentials, no live-workspace data; tests use synthetic fixture paths only; production artifacts gained no test hooks (the i18n/testing dictionary import is test-only, pre-existing pattern).

## Self-Check: PASSED

Both task verify commands pass exactly (75/75 and 40/40), lint and lint:i18n pass, changed src files are typecheck-clean, and the only full-suite/typecheck failures are pre-existing on pristine HEAD. Changes remain uncommitted per the session contract.
