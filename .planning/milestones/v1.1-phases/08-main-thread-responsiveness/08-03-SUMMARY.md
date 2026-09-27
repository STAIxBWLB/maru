---
phase: 08-main-thread-responsiveness
plan: "03"
subsystem: skills
tags: [rust, tauri, registry, concurrency, ipc, bundles]
requires:
  - phase: 08-02
    provides: Source/worktree reservations, source generations, batch worker and typed outcomes
provides:
  - Registry-free network stages for clone, reconcile and bundle environment repair
  - Exactly 24 async store IPC wrappers with preserved synchronous domain exports
  - Current-stage source/worktree mutation admission and exact command evidence
affects: [08-04, 08-29, 08-26, 08-27, 08-28]
actuals:
  tokens: 54231
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [awaited blocking IPC, pending clone generation, fresh guarded commit, source worktree reservations]
key-files:
  created: [docs/performance/phase08-03.json]
  modified: [src-tauri/src/skill_host/store.rs, src-tauri/src/skill_host/mod.rs, src-tauri/src/cli.rs, src-tauri/src/lib.rs, .planning/phases/08-main-thread-responsiveness/08-03-PLAN.md]
key-decisions:
  - Existing synchronous exports remain authoritative; only nested store IPC wrappers own scheduling.
  - Pending clones survive unrelated saves but explicit remove/reset invalidates their generation; absent established sources never keep an old incarnation.
  - Local bundle recovery stays guarded because it has no network descendant; environment repair runs between fresh guarded validation stages.
  - Shared lexical/alias parent-child admission and background/environment integration remain assigned to 08-29.
requirements-completed: [PERF-02, PERF-01]
coverage:
  - id: network-registry-availability
    description: Clone and reconcile Git stages plus bundle discovery and environment repair release the registry guard and reject stale results before publication.
    requirement: PERF-02
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_03_network_lock
        status: pass
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib skill_host::bundle_update::tests
        status: pass
    human_judgment: false
  - id: remaining-registry-ipc-boundaries
    description: All 24 actual owned wrappers run on a distinct blocking worker while the same Tauri runtime progresses; synchronous CLI callers remain available.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_03_boundary
        status: pass
      - kind: other
        ref: cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli
        status: pass
    human_judgment: false
  - id: mutation-admission-and-evidence
    description: Source/worktree reservations, current registry guards and generation observation preserve local writes, ownership checks and exact exclusive evidence.
    requirement: PERF-02
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib skill_host::store::tests
        status: pass
      - kind: other
        ref: docs/performance/phase08-03.json
        status: pass
    human_judgment: false
duration: 17min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 03: Remaining Registry Commands and Network Stages Summary

All 24 remaining registry commands now await blocking workers. Clone, reconcile Git and bundle environment repair release the registry lock, then validate current source identity and data before committing.

## Performance

- Started: approximately 2026-09-05T04:56Z, following the 08-02 handoff at 04:55:37Z.
- Completed: 2026-09-05T05:12:25Z.
- Tasks: 2; implementation/evidence/plan files: 6.
- Actual tokens: 54,231, rounded-up characters/4 over the realized six-file diff from b67e56f through 704d4e8. Three commits count both task commits and this SUMMARY; subsequent shared-state tracking is separate.

## Accomplishments

- Clone uses a unique staging directory and a reservation for the source ID and canonical destination/worktree. An ephemeral pending generation survives unrelated registry saves, while remove/reset invalidate it. Fresh commit checks identity, destination resolution and collisions, validates the marketplace manifest, then publishes and rescans against the latest registry. Stale staging is cleaned without resurrecting deleted metadata.
- Reconcile snapshots ownership, source generation/path and current content hash, reserves the checkout, then releases REGISTRY_LOCK for Git add/commit/push or discard. Fresh validation gates saved-hash updates. Existing committed/pushed/message outcomes preserve a successful commit with a failed push. Completed Git effects are not rolled back against a replacement source.
- Bundle operations reserve the stable builtin source. Apply checks dirty content before discovery, retains signed discovery/download and archive validation, and prepares/repairs outside the registry lock. Fresh source/state/dirty checks precede the existing journaled swap. Orphan sweeping leaves active preparation trees intact. Local recovery/materialization remains guarded and has no network descendant.
- The exact 24 command names register through store::ipc. Every wrapper owns its inputs and awaits one spawn_blocking task; AppHandle reporters and completion events execute inside the worker. Existing synchronous exports remain available through skill_host/mod.rs and the CLI. Plan 01/02 wrapper ownership and typed source/batch outcomes remain intact.
- Save, Save As, create, delete, install, uninstall, import, unmanage and explicit rescan paths use current-stage source/worktree reservations. Imported origins are checked against active Git checkout ownership. Registry guards still span local mutation/rescan/save; read-file and bundle-status snapshots now remain guarded through the local read. Inventory-only write denial, marker checks, lexical containment and tier validation remain enforced.
- The evidence shard owns exactly 24 rows, including all three former AUDIT rows. Each has a positive helper-chain/platform disposition, worker boundary, synchronous callers, mutation details and executable proof. Default initialization writes reached by nominal read commands are disclosed. The shard references 01/02 without duplicating rows and records mandatory 08-29 integration.

## Task Commits

1. Task 03-1: f326cdd, perf(08-03): release registry during clone reconcile and bundle repair.
2. Task 03-2: 704d4e8, perf(08-03): guard registry worker mutations and close command evidence.

## Executed Checks

| Check | Actual result |
| --- | --- |
| phase08_03_network_lock | 7 passed, 0 failed/ignored; real temporary Git clone/discard, registry availability, pending remove/reset rejection, dirty/owner denial, successful bundle swap and stale/dirty repair rejection. |
| phase08_03_boundary | 6 passed, 0 failed/ignored; all 24 actual wrappers exercise distinct blocking threads, same-runtime async progress and contextual JoinError mapping. Nonempty payload, legacy/typed error, concurrent-write, alias/import and generation-route cases pass. |
| Full skill_host::store::tests regression | 111 passed, 0 failed/ignored, including prior source/batch tests and existing install/import/ownership/bundle behavior. The final canonical clone-destination check was additionally covered by the final 7-case network and 6-case boundary reruns. |
| skill_host::bundle_update::tests | 13 passed, including signed local-channel publication, capped HTTP/signature flow, archive traversal/symlink/hash rejection and journal recovery. |
| ipc_error::tests | 4 passed, including the recursive no-flattening guard. |
| cli::tests | 12 passed. |
| cargo check -p maru-cli | Passed, preserving synchronous CLI compatibility. |
| cargo check --lib | Passed, including qualified Tauri registration. |
| cargo clippy --lib -- -D warnings | Passed. |
| cargo fmt -- --check | Passed. |
| Exact inline ownership/registration/evidence check | 24/24 unique owned rows; no 01/02 overlap; each registered wrapper and required evidence field present. |
| GSD verify artifacts | 4/4 declared artifacts passed. |
| JSON parse and git diff --check | Passed. |
| Shared requirements ready-ids | 0/2 ready; neither requirement marked globally complete. |

MockRuntime tests call the actual wrappers. Their injected panic occurs at a cfg(test) worker edge before effects and proves JoinError mapping without contacting a provider. Successful bundle transaction fixtures inject synthetic discovery/download/repair at the existing synchronous seams and exercise real extraction, filesystem swap and registry persistence; separate unchanged signed-channel tests prove cryptographic validation. No native saturation or Windows runtime result is claimed.

## Deviations from Plan

1. **[Rule 2 - Verified scope clarification] Local bundle recovery.** Fresh transitive inspection showed ensure_active_bundle reaches only local recovery/materialization, contrary to the plan's network-capable wording. Kept it under the existing guard, moved the actual env-repair network stage out, and taught orphan sweeping about active builtin reservations. The plan records this clarification. Files: store.rs and 08-03-PLAN.md; verified by the network and signed-bundle cases.
2. **[Rule 2 - Testable domain boundary] Existing exports and finite seams.** Preserved original synchronous public command names rather than duplicating every function under a new suffix. Added nested same-name IPC wrappers, generic AppHandle support for the four app-bearing domain/wrapper pairs, and narrowly named clone/check/apply blocking seams. lib.rs uses qualified registrations; wrappers call synchronous module reexports. CLI and clippy verification passed without a new dependency or block_on production workaround.
3. **[Rule 1 - Concurrency correctness] Pending versus established generations and consistent local reads.** Restricting absent-generation retention to pending clones prevents inventory pruning from preserving an old incarnation. Added a command-level test for default change/revert, leased inventory prune/re-add, import/unmanage, adopt and reset. Read-file and bundle-status guards now cover complete local snapshots. Clone revalidates its destination's canonical identity before publication.
4. **[Rule 1 - Observed compile fixes] Test visibility and optional hashes.** Initial compilation exposed insufficient test-hook visibility and String versus optional content-hash comparison. Corrected both, then reran the required tests. Qualified registration and synchronous reexport use also removed intermediate unused-wrapper/import warnings; final library clippy is clean.

No package, persisted registry schema, new endpoint, retry queue, job center or external message was introduced. Existing unrelated test-build warnings in today_ai/scheduler remain outside scope.

## Threat Dispositions and Handoff

- T-08-03-01: mitigated within this stage by source/worktree reservations, fresh identity/path/hash/state validation, pending-clone invalidation, retained signed validation and denied-owner/dirty tests. Exact lexical/alias parent-child protection across modules remains mandatory in 08-29.
- T-08-03-02: all 24 wrappers await finite blocking work and preserve nonqueued source admission. Error/unwind cleanup and async progress are exercised. Existing Git/setup subprocess timeout policy is unchanged; phase-wide saturation/latency is owned by 08-27.
- T-08-03-03: only disposable homes, local Git repositories, synthetic archives and existing local signed-channel fixtures were used. New observation hooks are cfg(test) only. No live provider or credential was used; final feature-off artifact scanning remains 08-28.
- Preserve synchronous store entry points, source snapshots/commit seams, local guards, pending generation behavior and active preparation ownership when integrating 08-29. The shared protocol must include default/background materialization, env repair, tool install targets and lexical/alias ancestors. This stage does not claim cross-process locking or identical offline ABA detection.
- Backend work owns its lifetime after view changes. Existing caller feedback is preserved; remaining processing/refresh closure belongs to 08-25/26 where applicable. Source sync notification proof stays in 08-02.
- No blocking stub, skipped test, unrun plan verify or architectural blocker remains. Ready for 08-04.

## Self-Check: PASSED

Both task commits exist, all declared artifacts and the 24-row shard exist, required final tests are nonempty and pass, and no tracked file was deleted. Unrelated dirty Phase 7 files and untracked runtime/planning files are preserved. Shared IDs remain pending.
