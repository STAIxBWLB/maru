---
phase: 08-main-thread-responsiveness
plan: "01"
subsystem: skills
tags: [rust, tauri, git, native-e2e, concurrency]
requires:
  - phase: 06-native-e2e-runner-foundation
    provides: Isolated native WebDriver runner
  - phase: 07-guardrails-before-churn
    provides: Justified registry poison recovery
provides:
  - Async single-source IPC boundary with synchronous domain helper
  - Source and canonical-checkout reservations with fresh-generation commit validation
  - Real native Skills-to-local-Git tracer and deterministic source race evidence
affects: [08-02, 08-03, 08-29, 08-27, 08-28]
actuals:
  tokens: 14931
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, RAII source lease, process-local UUID generations, fresh registry commit]
key-files:
  created:
    - e2e-native/specs/skills-sync.spec.ts
    - docs/performance/phase08-01.json
  modified:
    - src-tauri/src/skill_host/store.rs
    - src-tauri/src/skill_host/fs.rs
    - src/lib/skills.ts
    - src/lib/skills.test.ts
    - e2e-native/helpers/fixtureWorkspace.ts
    - .planning/phases/08-main-thread-responsiveness/08-01-PLAN.md
key-decisions:
  - Source generations observe application registry saves; reset and bundle replacement explicitly invalidate identical configurations.
  - Source reservations use canonical Git worktree identity and fail closed on poisoned bookkeeping.
  - Cross-command destructive path exclusion remains an explicit mandatory 08-29 integration obligation.
requirements-completed: [PERF-02, PERF-01]
coverage:
  - id: source-transactions
    description: Single-source work runs on a blocking worker and rejects deleted or changed sources before fresh commit.
    requirement: PERF-02
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_source_transactions
        status: pass
      - kind: other
        ref: cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli
        status: pass
    human_judgment: false
  - id: native-skills-tracer
    description: Existing Skills controls pull a real local Git commit and persist a valid changed skill inside the disposable native home.
    requirement: PERF-01
    verification:
      - kind: e2e
        ref: e2e-native/specs/skills-sync.spec.ts#syncs a changed local Git skill through the existing Skills control
        status: pass
    human_judgment: false
duration: 15min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 01: Single-source Synchronization Tracer Summary

Single-source Skills synchronization now releases the registry lock during Git work, rejects stale source generations, and completes through the real native UI against a disposable local remote.

## Performance

- Started: 2026-09-05T04:22:30Z
- Completed: 2026-09-05T04:37:29Z
- Tasks: 2
- Changed implementation, test, evidence and plan files: 8
- Actual tokens: 14,931, calculated as rounded-up characters/4 over the realized eight-file diff from ba1d978 through 532995d. The three counted commits are the two task commits plus this summary; subsequent state tracking is separate.

## Accomplishments

- `skills_sync_source` awaits `spawn_blocking`, constructing its progress reporter inside the owned closure. `skills_sync_source_impl` remains synchronous. String errors and progress IDs remain unchanged at the existing frontend wrapper.
- `SourceOperationLease` atomically reserves the registry/source ID and canonical Git worktree root. Duplicate IDs, nested directories and symlink aliases cannot start another network operation. Failure and unwind release ownership; another explicit request succeeds.
- `SourceGeneration` uses opaque incarnation/configuration UUIDs in process-local metadata. Every registry save observes current source configurations; reset and bundle replacement explicitly invalidate unchanged identities. After network work, the transaction reloads current disk state, checks generation and canonical source path, rescans under the registry guard, and saves the latest registry. No persisted schema changed.
- The native fixture seeds a bare Git remote, initial checkout and a later remote commit. Existing Settings > Skills > Sync controls show real backend progress and persist the changed title. All discovered source paths are asserted to remain under the disposable native home.

## Task Commits

1. Task 01-1, native single-source tracer: `efa9c10` (`perf(08-01): isolate single-source sync and prove native Git tracer`).
2. Task 01-2, race edges and caller compatibility: `532995d` (`test(08-01): verify source races and native fixture isolation`).

The Task 01-1 commit was followed by a successful second native and Rust tracer run before Task 01-2 began.

## Verification

| Executed command | Actual result |
| --- | --- |
| `make test-e2e-native` | Three successful runs; each passed all 5 specs and 11 tests, including the named Skills tracer. The second run was the required tracer feedback gate. |
| `pnpm test:e2e:native --spec ./e2e-native/specs/skills-sync.spec.ts` | Final focused run passed 1 spec and 1 test, including the strengthened valid-skill and fixture-home containment assertions. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_source_transactions` | Final run passed 12 tests, 0 failures and 0 ignored tests. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib skill_host::store::tests` | Passed 92 tests, 0 failures and 0 ignored tests, before adding the final deletion test. The new test passed in the final focused run. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_01` | Task 01-1 run passed the registry-availability test and normal-build native-home override exclusion test, 2 total. |
| `pnpm exec vitest run src/lib/skills.test.ts` | Passed 10 tests, including busy, stale and network-error preservation with exactly one invocation. |
| `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | Passed. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | Passed after simplifying the generation map value type. |
| `pnpm exec tsc --noEmit -p tsconfig.e2e-native.json` | Passed. |
| `pnpm exec eslint src/lib/skills.ts src/lib/skills.test.ts e2e-native/helpers/fixtureWorkspace.ts e2e-native/specs/skills-sync.spec.ts` | Passed. |
| `rustfmt --edition 2021 src-tauri/src/skill_host/store.rs src-tauri/src/skill_host/fs.rs` | Formatted the owned Rust files; final `git diff --check` passed. |
| `python3 -m json.tool docs/performance/phase08-01.json` | Passed. |

The 12 named Rust cases and exact owned command evidence are retained in `docs/performance/phase08-01.json`. They cover registry availability/unrelated edits, deletion at all three edges, identical remove/re-add, actual upsert change/revert, duplicate admission and independent progress, failure/unwind/manual retry, alias/nested/symlink contention, empty/absent input, fresh external configuration/timestamp-only changes, reset incarnation, symlink retargeting, and removed-checkout byte-stable registry/no recreation.

Raw native proof is retained outside fixture cleanup at `test-results/native-e2e/phase08-01-skills-sync.json`; its portable facts and observed progress messages are also recorded in the committed evidence shard. The final title is `Native synced skill`, produced by actual `git pull --ff-only` and confirmed in the registry.

## Deviations from Plan

1. **[Rule 2 - Native isolation] Expanded scope to `skill_host/fs.rs`.** Its home resolver bypassed the existing native fixture override. Added the existing feature-gated override and native CODEX_HOME isolation, then proved normal builds ignore the native override. The parent approved this necessary scope correction before implementation. Native Git also disables global/system configuration and terminal prompts. No live Skills directory was intentionally used as a test target.
2. **[Rule 2 - Verification scope] Added tests to the existing `src/lib/skills.test.ts`.** This is the executable proof that the unchanged public wrapper preserves raw errors and never retries. The paired plan file now declares this existing test file.
3. **[Clarified staged ownership] Corrected the active-checkout deletion wording.** The owned removal command only deletes registry metadata; source reservations do not serialize every other filesystem writer. This plan proves rejection of missing/retargeted paths without registry write-back or directory recreation. Cross-command destructive exclusion remains mandatory in the already-reviewed 08-29 overlay after 08-06 supplies shared path admission. No phase-wide exclusion or latency claim is made here.
4. **[Rule 1 - Verification fixes] Corrected observed test/setup failures.** The first Rust fixture used `.` although the existing helper creates `skills/`; fixed the subdirectory. Clippy rejected the new map type complexity; reused `SourceSnapshot` without suppression. The deletion test initially assumed a null timestamp despite add already rescanning; replaced it with byte-identical registry and pre-cleanup filesystem assertions. The strengthened native valid-skill assertion exposed the fixture's existing tier-placement violation; moved the disposable checkout under a nested public-catalog suffix while preserving its `cloned` kind. Final focused native validation passed.

## Safety and Threat Dispositions

- T-08-01-01, tampering: mitigated for the owned transaction by fresh registry reload, UUID/configuration/path validation, retained source ownership and guarded rescan/save. Cross-domain parent/child exclusion remains explicitly assigned to 08-29.
- T-08-01-02, denial of service: mitigated for this finite command by the blocking worker, nonqueued source reservations, no guard across await, and error/unwind release tests. Native saturation/latency proof is owned by 08-27, not claimed by this tracer.
- T-08-01-03, disclosure: mitigated by isolated native home/config, synthetic local Git remote, disabled global/system Git config, and no arbitrary invoke bridge. The two Rust edge controls are `cfg(test)` only. Final phase-wide production artifact scanning remains owned by 08-28.
- No automatic retry, job center, source-edit UI, external service integration, dependency, persisted generation schema, installed-app change, remote push or release was added.

## Issues and Integration Handoff

- The stock native service still emits diagnostics about absent external tauri-driver and global Tauri helpers; embedded-driver tests all pass. These pre-existing runner messages were not changed.
- Rust test compilation reports an existing unused import in `today_ai.rs`; the owned library clippy gate passes. No unrelated file was edited.
- `integrationRequired` and `moduleIntegrationOwner` are both `08-29`. Preserve the synchronous source transaction and snapshot/commit seams for that overlay.
- Sync All still uses its existing helper and is exclusively owned by 08-02. Busy/stale typed errors, frontend surviving completion and the full command inventory remain later-plan work.
- Generations cover application mutations and fresh disk configuration comparison, not cross-process serialization or identical offline ABA.
- The required frontmatter IDs describe this plan's contribution. The shared-ID readiness query returned 0/2 ready, so neither PERF-01 nor PERF-02 was marked globally complete.

## Self-Check: PASSED

Both task commits exist; the native spec and evidence JSON exist; all final focused tests are nonempty and passing; no tracked files were deleted. No blocking stub or skipped test was introduced. Ready for 08-02.
