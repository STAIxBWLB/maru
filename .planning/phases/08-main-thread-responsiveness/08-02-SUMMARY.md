---
phase: 08-main-thread-responsiveness
plan: "02"
subsystem: skills
tags: [rust, tauri, concurrency, react, notifications, native-e2e]
requires:
  - phase: 08-01
    provides: Single-source transaction, UUID generations and source/worktree reservations
provides:
  - Whole-batch async worker with independently durable source outcomes
  - Known busy/stale IPC codes and skipped counters
  - Workspace-scoped Skills operation ownership and existing-surface completion notices
affects: [08-03, 08-29, 08-27, 08-28]
actuals:
  tokens: 24189
  tasks: 3
  commits: 4
tech-stack:
  added: []
  patterns: [spawn_blocking, expected source snapshots, keyed external store, terminal notice deduplication]
key-files:
  created: [src/lib/skillOperations.ts, src/lib/skillOperations.test.ts, docs/performance/phase08-02.json]
  modified: [src-tauri/src/skill_host/store.rs, src-tauri/src/ipc_error.rs, src-tauri/Cargo.toml, src/lib/types.ts, src/lib/skills.ts, src/lib/errorStore.ts, src/components/settings/tabs/SkillsTab.tsx, src/App.tsx, e2e-native/specs/skills-sync.spec.ts]
key-decisions:
  - Whole-batch defaults, admission, network, scans and assembly stay inside the awaited worker.
  - Batch snapshots include canonical source paths; successful timestamps are returned from the same guarded commit.
  - Skills operations own mutation/listener lifetime; view generations govern only refresh publication.
  - Existing toast notices are deduplicated and retained in completion order until dismissal.
requirements-completed: [PERF-02, PERF-01]
coverage:
  - id: batch-transactions
    description: Whole-batch IPC runs on a worker, skips busy sources, rejects replaced identities and preserves independently committed successes.
    requirement: PERF-02
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_batch_transactions
        status: pass
      - kind: other
        ref: cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli
        status: pass
    human_judgment: false
  - id: surviving-operation-ownership
    description: Unsubscription does not cancel Skills mutations and terminal notices publish once with workspace-scoped progress and stale-view rejection.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: pnpm exec vitest run src/lib/skillOperations.test.ts src/lib/errorStore.test.tsx
        status: pass
    human_judgment: false
  - id: existing-ui-completion
    description: Existing native Skills controls show progress and terminal success while the real local Git change persists in the isolated fixture.
    requirement: PERF-01
    verification:
      - kind: e2e
        ref: e2e-native/specs/skills-sync.spec.ts#syncs a changed local Git skill through the existing Skills control
        status: pass
      - kind: other
        ref: pnpm lint:i18n
        status: pass
    human_judgment: false
duration: 15min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 02: Sync All Outcomes and Surviving Completion Summary

Sync All now processes fixed source identities in an awaited worker, preserves successful siblings when other sources fail or are busy, and reports completion through the existing toast surface after the initiating view unmounts.

## Performance

- Started: approximately 2026-09-05T04:39Z, following the 08-01 state handoff at 04:38:41Z.
- Completed: 2026-09-05T04:54:30Z
- Tasks: 3; changed implementation, test, plan and evidence files: 17.
- Actual tokens: 24189, rounded-up characters/4 over the committed diff from 2de787a through 163d0fc. The four counted commits are three task commits and this SUMMARY; shared-state tracking is separate.

## Accomplishments

- `skills_sync_all_sources<R>` moves owned inputs into `spawn_blocking` before reporter creation, defaults, registry locks or source work. Its synchronous implementation remains available. Join failure alone becomes a contextual display-only `IpcError`; typed inner results survive intact.
- The batch captures UUID generations and canonical paths, then passes each expected snapshot to the existing single-source transaction. Busy sources are skipped without queueing; missing, replaced or retargeted sources fail without resolving replacements. Each successful source saves against fresh registry state and returns its timestamp from that exact commit. The result invariants cover zero and singleton input as well as mixed batches.
- `skills_source_busy` and `skills_source_stale` cross IPC as known contract codes. Other errors keep legacy message text and empty codes. Additive `skipped` and `errorCode` fields preserve partial-result classification in Rust, TypeScript and browser fallback. Source normalizer tests use real known-code objects and never infer codes from text.
- The narrow workspace/source-keyed module store owns mutation promises and progress listeners through settlement. Duplicate starts reuse the existing promise; independent sources and Sync All can proceed. Listener setup failure, late registration and cleanup failure cannot suppress the terminal result. Successful sibling data and detailed failed/skipped reasons remain in the snapshot.
- `SkillsTab` subscribes to progress independently of operation ownership. Refresh publication requires the initiating workspace, a monotonic view generation and the current request ticket; A -> B -> A invalidates old requests. Returning to a workspace reads persisted data and reattaches current progress. The App toast region renders deduplicated success/info/error notices without new MainApp state/effect calls or navigation changes. Korean and English messages include workspace/source labels, reasons and manual retry language.

## Task Commits

1. Task 02-1: `67b3e94`, `perf(08-02): isolate batch sync with typed durable source outcomes`.
2. Task 02-2: `47fa4ed`, `feat(08-02): own Skills operations and terminal notices beyond views`.
3. Task 02-3: `163d0fc`, `feat(08-02): connect persistent Skills progress and completion feedback`.

## Verification

| Executed check | Actual result |
| --- | --- |
| Rust `phase08_batch_transactions` | 5 passed, 0 failed/ignored. Actual wrapper cases hold defaults and per-source work separately, prove same-runtime async progress before release, and verify a distinct blocking-worker thread. |
| Rust `phase08_source_transactions` | 12 passed, 0 failed/ignored, including deletion, ABA/config changes, aliases and release/manual retry regressions. |
| Rust `phase08_` final combined regression | 18 passed, 0 failed/ignored: 5 batch, 12 source and 1 normal-build home-isolation case. |
| Rust `ipc_error::tests` | 4 passed, including the recursive code-emitter flattening guard and known-code pin. |
| Vitest Skills, skillOperations, errorStore and types files | 36 passed across 4 files: 15 wrapper, 13 lifetime/admission, 7 error/notice and 1 cross-language type contract tests. |
| `cargo check -p maru-cli` | Passed. |
| `cargo clippy --lib -- -D warnings` | Passed. |
| `pnpm typecheck` | Passed, including final view publication changes. |
| `pnpm lint:i18n` | Passed, 3742 locale keys in parity. |
| Focused ESLint and native TypeScript checks | Passed. |
| Rebuilt native Skills smoke | Final run passed 1 spec/1 test in 1.5 seconds with no WebDriver replay. Real local Git content persisted as a valid skill, all source paths stayed in the disposable native home, and the existing toast showed `workspace / native-local-git: 동기화를 완료했습니다.` |
| GSD artifact check | 13/13 declared artifacts passed. |
| JSON parse, rustfmt and `git diff --check` | Passed. |

The exact owned command row and portable proof are in `docs/performance/phase08-02.json`. Raw synthetic native evidence remains at `test-results/native-e2e/phase08-01-skills-sync.json`. The runtime test proves this wrapper boundary; phase-wide saturation and latency are still owned by 08-27/28.

## Deviations from Plan

1. **[Rule 2 - Verification scope] Dev-only Tauri test support.** Added the existing Tauri dependency's dev-only `test` feature in Cargo.toml, generic AppHandle support for Sync All and a narrow erased progress emitter. This lets the test call the actual command wrapper with MockRuntime. The parent approved the scope addition. No dependency package, production test bridge or wire-event change was added.
2. **[Rule 2 - Transaction correctness] Precise snapshot and outcome seams.** Extracted the per-snapshot loop as `skills_sync_all_sources_blocking`, added canonical path capture and returned the timestamp from the same guarded source commit. This prevents pre-turn symlink replacement and avoids a second registry read discarding already successful output. The public single-source helper still returns its original Vec payload. Additive `errorCode` records partial failure codes without string parsing. The plan records these corrections.
3. **[Rule 2 - UI verification scope] Existing native smoke and view helpers.** Extended the native tracer to observe the existing toast. Added narrow admission/selector/view-scope inputs and tested the same inputs used by SkillsTab. Manual refresh retains its progress logs while guarding publication and cleanup by view/request identity.
4. **[Rule 1 - Observed verification fixes] Test visibility and native runner timing.** The first Rust compile required the test hook to be crate-visible. The first direct native command reused the old binary and timed out; rebuilt following the Makefile sequence. A later rebuilt run passed after WebDriver replayed the script at 30 seconds. The spec now returns diagnostics after 25 seconds and uses observed progress, terminal notice and actual persisted Git effects, without assuming final progress-event ordering relative to invoke settlement. The final run passed in 1.5 seconds without replay. Failed/timed-out runs were not counted as successful evidence.

## Threat Dispositions and Handoff

- T-08-02-01: mitigated within the owned source transaction by fixed identities, canonical path validation, fresh guarded commit and preserved successful siblings. Shared parent/child filesystem admission remains the explicit 08-29 obligation after producer 08-06.
- T-08-02-02: finite awaited worker, nonqueued source ownership and cleanup/manual-retry tests cover this command. Operation disposal never cancels backend work; no queue, scheduler or automatic retry was introduced. Saturation proof remains 08-27.
- T-08-02-03: local synthetic Git and isolated native home only, no live provider or credential access. New Rust hooks are test-only; Tauri MockRuntime support is dev-only. Final production artifact isolation remains 08-28.
- Both `integrationRequired` and `moduleIntegrationOwner` are `08-29`. Preserve the whole-batch worker, expected snapshot transaction, scoped lifetime store and typed outcomes during that integration.
- The shared-ID gate returned 0/2 ready; neither PERF-01 nor PERF-02 is marked globally complete by this plan.
- Existing test-build warnings in today_ai/scheduler and the embedded runner's absent external tauri-driver/global-helper diagnostics remain outside this scope. No unrelated file was changed.
- STATE.md was already 268 lines at entry to final tracking; no unrelated history was truncated to satisfy a shorter-template target.

## Self-Check: PASSED

All three task commits exist; planned implementation/test artifacts and the evidence shard exist; final focused tests are nonempty and pass; no tracked files were deleted; unrelated Phase 7 edits and untracked runtime files are preserved. Ready for 08-03. Native navigation/saturation closure remains staged in 08-27/28, and cross-domain source/default integration remains staged in 08-29.
