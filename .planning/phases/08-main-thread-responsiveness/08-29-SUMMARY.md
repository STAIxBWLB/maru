---
phase: 08-main-thread-responsiveness
plan: "29"
subsystem: cross-domain-filesystem-admission
tags: [rust, tauri, skills, git, concurrency, evidence]
requires:
  - phase: 08-06
    provides: Complete hierarchical path admission, pinned parent snapshots and real Files wrappers
provides:
  - Shared admission for earlier Skills, Git, env, dispatch and dot mutation routes
  - Explicit event-store and mission-state lease adapters for later final owners
  - Thirty-seven executed integration tests and a seven-module evidence overlay
affects: [08-07, 08-16, 08-17, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 78982
  tasks: 3
  commits: 4
tech-stack:
  added: []
  patterns: [source-first reservation, complete path sets, owned background lease, explicit borrowed adapters, pinned callback parents]
key-files:
  created: [docs/performance/phase08-29-integration.json]
  modified: [src-tauri/src/skill_host/store.rs, src-tauri/src/git.rs, src-tauri/src/skill_host/env.rs, src-tauri/src/skill_host/dispatch.rs, src-tauri/src/dot_sync.rs, src-tauri/src/agent_host/event_store.rs, src-tauri/src/mission_state.rs, scripts/check-command-isolation.mjs, scripts/check-command-isolation.test.mjs]
key-decisions:
  - Preserve list initialization through short conditional metadata/default-recovery admission; plain registry getters no longer create directories.
  - Network leases exclude registry metadata and its ancestors; source ownership survives fresh complete commit admission.
  - Approved child execution shares one explicit lease through exit and stream join; independent proposal callbacks reuse original parent snapshots.
  - Dot schema-v1 bootstrap effects participate; unresolved installation/update targets fail before launch.
requirements-completed: [PERF-02, PERF-01]
coverage:
  - id: earlier-writer-parent-races
    description: Actual Skills save, Skills sync and Git pull serialize against real rename and Trash wrappers in both orders and through aliases.
    requirement: PERF-02
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_29
        status: pass
    human_judgment: false
  - id: background-and-callback-admission
    description: Environment completion, dispatch event/mission writes and finite dot local mutations retain complete admission and release on failure.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_29
        status: pass
      - kind: other
        ref: cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli
        status: pass
    human_judgment: false
  - id: seven-module-evidence
    description: Separate integration overlay validates seven modules without adding exclusive command rows; Plan07 now supplies document evidence, while final adapter-owner handoffs remain pending.
    verification:
      - kind: unit
        ref: node --test scripts/check-command-isolation.test.mjs
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --integration 29
        status: pass
    human_judgment: false
  - id: automatic-git-maintenance-lifetime
    description: Both production Git builders suppress automatic maintenance per invocation; effective configuration and real local pull Trace2 prove no automatic maintenance child escapes the waited command.
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_29_maintenance
        status: pass
    human_judgment: false
  - id: initial-fixture-escape-history
    description: The first dispatch launch-error fixture could select the installed Claude executable; historical external effects cannot be established or excluded.
    human_judgment: true
    rationale: No prior network/filesystem observation exists and panic removed the temporary run evidence. Corrected fixture proof does not establish isolation of the initial launch.
duration: 25min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 29: Earlier Writer Admission Integration Summary

Earlier filesystem writers now share complete hierarchical admission with the real Files rename/Trash operations. Thirty-seven produced tests pass, including all six Skills-save/Skills-sync/Git-pull versus rename/Trash pairs, both admission orders, aliases, metadata availability, same-task async progress and callback lifetimes.

## Performance and Commits

- Started approximately 2026-09-05T06:07Z; completed approximately 2026-09-05T06:32Z.
- Three tasks, ten implementation/evidence files; no worktree, branch change, push, merge or release.
- Actual tokens: 78982, rounded-up characters/4 over the 315925-character ten-file diff from 41186df through fcb3af0. The four plan commits count three task commits plus this SUMMARY; shared-state bookkeeping is separate.
- Task 29-1: 72e8484, `perf(08-29): admit skill and Git mutations across workspace parents`.
- Task 29-2: d114f9d, `perf(08-29): admit dispatch callbacks and dot local effects`.
- Task 29-3: fcb3af0, `test(08-29): record complete cross-domain admission evidence`.
- Commits use explicit file staging, normal hooks and English messages without coauthor trailers. Dirty Phase07 research/validation files and runtime artifacts were preserved.

## Complete Sets and Lock Order

- Skills keeps the nonblocking source-ID/canonical-checkout reservation before shared path waits. Save, save-as, delete, install, import and unmanage retain source ownership, capture complete target sets, then reload and validate under REGISTRY_LOCK. Exact selected-file paths add physical aliases for descendant symlinks; optional file revisions preserve new-file creation while rejecting intervening edits or creation. Full source sets include the raw lexical configuration, canonical tree, Git worktree, Git directory and common Git directory. Exact identity vectors detect non-Git-to-Git and metadata retargeting even inside already covered trees.
- Source sync and reconciliation retain source ownership across separate checkout/network and fresh registry/checkout commit leases. Each transition validates the original pinned parent, current source incarnation/configuration, Git mapping and content. Commit scans fresh bytes and merges into the latest registry. Removed sources, replaced parents and changed content are discarded with existing conflict/stale behavior and manual retry; completed siblings remain intact.
- Clone reserves checkout and unique staging before the subprocess, then reacquires checkout/staging/registry together before publication. Cleanup acquires its own finite set with the original parent snapshot when necessary. Bundle work separates local default settlement, network/staging/env preparation and final complete bundle/install/registry admission. Staging, pristine, active, backup, journal/state and next-bundle paths are included. Nested run_env_repair_blocking receives the borrowed lease explicitly and checks the precomputed env/setup set. No registry lease spans download, Git work or env repair.
- A checkout that lexically or physically contains Skills registry metadata is rejected with source_layout_conflict before network admission, instead of reserving a registry ancestor for network work. Metadata-only source removal reserves only registry metadata, never active checkout bytes.
- load_registry_unlocked/load_registry/get_skill are now actual reads: the old unconditional standard-directory creation was removed. Existing list/default initialization behavior is preserved with short admission of registry plus only missing default/recovery targets. Healthy list and metadata removal finish while actual network work or path admission is held. Reset precomputes its exact backup and missing initialization paths, so it can invalidate an active source without waiting for its checkout lease.
- Git commit, selected commit/push and pull/rebase reserve the full lexical worktree and separate Git/common metadata before GIT_ACTION_LOCK. A short registry/legacy-loader preflight preserves initial permission denial before any Git subprocess; migration coverage is explicit. After full admission and the domain lock, permissions are checked before further Git identity discovery or mutation. Existing approval, sensitive-path, stash/rebase/pop and failure retention behavior stays intact. Read-only Git probes disable optional index writes.
- Environment status/bootstrap/repair resolve store defaults separately, retain the original parent snapshot, then admit env and setup-owned trees. The lease moves into the existing background worker and lasts through child exit, both output joins and final status.json. Target node/input/output/temp/log trees and setup-local lockfile/cache effects are represented. Cache destinations are explicit; tests pin /bin/bash and remove BASH_ENV/ENV. System package-manager and external uv bootstrap effects are existing delegated effects, not a claimed universally protected write graph.
- Dispatch proposal callbacks admit finite event and mission transactions using the original cwd/home snapshots. A moved/deleted cwd is not recreated; independent mission completion can still persist under its unchanged original home. Approved execution reserves declared cwd/add_dirs plus event and mission json/tmp/log paths through child exit and stream join. DispatchChild reaps on error/unwind. Explicit shared lease binding lets stop signal an admitted child without waiting for that child's exit; callback serialization also protects mission temporary files.
- Event-store direct and borrowed append APIs admit before append_lock_for. Mission registration, touch, finish, fail, hydration/idle persistence and stop follow admission before missions/pids guards. Direct synchronous APIs remain available. Their final module owners remain Plans 17 and 16 respectively.

## Dot Source Contract

The accepted schema is version1. Evidence came from local dotfiles-v2 tag v2.63.0 (source commit 4ac6761), not an installed dot execution; current sibling source emits version2 and was not silently treated as installed compatibility.

- Actual keys: workspacePath, storeDir, target.kind/spec/path/host, logPath, includePath, excludePath, ignorePath, allowPath; peer wraps profile and adds homePathsPath.
- Local workspace/mirror source and destination, peer home destinations/conflict/lock paths, profile config/state/filter/log/manifests and immediate scheduler effects are included. Remote host/path values are never guessed to be local paths.
- Discovery precedes DOT_ACTION_LOCK; admitted execution rechecks versioned mapping, config/home-path bytes and pinned parents before launch. Complete admission lasts through the finite synchronous subprocess boundary.
- PeerDiff and PeerDoctor actually bootstrap local layout and can write .gitignore, so they participate. ReadFilter, ReadLog and ReadPeerHomePaths have positive read-only evidence. Unresolved targets and install/update actions without a finite supported local-effect contract return contextual errors before launch.
- Tests use captured in-memory fixed-argv program fixtures with real temporary filesystem effects; they do not launch installed dot. Independent later daemon, editor or external process writes remain outside in-process exclusion.

## Executed Checks

| Check | Actual result |
| --- | --- |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_29 | Final 37 passed, 0 failed/ignored; 17.35 seconds after compilation. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_source_transactions | 12 passed, 0 failed/ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_batch_transactions | 5 passed, 0 failed/ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib skill_host::store::tests::phase08_03 | Final 13 passed, covering boundaries, clone/bundle/reconcile network availability, reset and env repair. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib skill_host::store::tests | 121 passed, 0 failed/ignored; 41.12 seconds. This broader run preceded the final registry-ancestor guard, which has its own subsequently passing actual-wrapper case. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_04 | Final 7 passed, 0 failed/ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib git::phase08_05 | Final 10 passed, 0 failed/ignored, including both permission boundaries. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib dot_sync::phase08_05 | Final 3 passed, 0 failed/ignored. |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Final passed. |
| cargo check --manifest-path src-tauri/Cargo.toml --lib | Final passed. |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Final passed. |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Final passed. |
| node --test scripts/check-command-isolation.test.mjs | Final 91 passed, 0 failed/skipped; approximately 3.13 seconds. |
| node scripts/check-command-isolation.mjs --integration 29 | Passed: seven modules, 365 production registrations, zero added command evidence rows. |
| git diff --check | Passed. |

Produced test attribution is store 11, Git 7, env 5, dispatch 7, mission 1 and dot 6, totaling 37. Event-store proof is shared with dispatch cases and is not counted again. Every domain has an actual wrapper proof that polls the command and yields on the same async task while a distinct blocking worker is held; spare-worker availability is not used as the new responsiveness proof. Structural checker validation does not rerun or replace behavioral tests.

A combined phase08_ diagnostic run reported 106/108 before correcting the last permission-test expectation and the new parent-Git fixture. Final focused cases and relevant regression suites above pass. Existing today_ai/scheduler test-build warnings remain unrelated; production clippy is clean. Windows runtime/compile and native artifact saturation were not exercised on this macOS host.

## Deviations, Failures and Fixture Isolation

1. **Bounded list contract correction, agreed with the parent orchestrator.** Literal no-admission list behavior conflicts with the existing initializing list API. Plain getters are now reads; initializing lists keep explicit short conditional metadata/default transactions. This preserves existing registration behavior and passes live fixture metadata-availability tests.
2. **Git permission discovery correction.** Complete path discovery needs authorized read-only rev-parse before the domain lock. Tests now separately prove initial denial causes zero Git processes and a policy flip after authorized discovery causes zero subsequent Git processes. No process hook was suppressed and permission checks were not weakened.
3. **D-02 concurrency correction.** Moving source reservation before path/domain waits exposes source_busy for overlapping same-source saves. The prior test that expected both requests to queue was updated to verify the immediate busy result and an explicit retry after both original attempts settle. Successful sibling content remains complete.
4. **Checker correctness.** Missing mutating commandRefs and duplicate references were initially accepted. Two red fixture failures reproduced those gaps; the minimal validator change and nineteen new fixtures now reject them while preserving exclusive command inventory ownership.
5. **Workflow ordering.** Implementation and inline tracer tests were developed together; no pre-change red run of the entire parent-pair matrix was recorded. Follow-up regressions and checker gaps were observed failing and corrected. Only the actual executed final proof is claimed.
6. **Initial dispatch fixture escape, material historical limitation.** An absent configured override fell back to the installed Claude executable. The command used a synthetic managed-skill prompt, plan permission, a temporary cwd/add-dir, null stdin and piped output; no selected user document was provided. However HOME/config/environment inheritance, startup hooks, MCP and network were not isolated. The successful UUID established child launch, not the absence or presence of external effects. Panic removed temporary evidence. Without prior observation, external requests or writes outside the fixture cannot be established or excluded. A subsequent process listing showed no live Maru test process or orphaned Claude child; existing user processes were not touched. No credential/config inspection was performed to speculate about effects.
7. **Corrected fixture proof.** Every new dispatch fake asserts its exact resolved path. The launch-error fixture is an existing temporary executable whose temporary interpreter is absent; it proves ENOENT and cli_missing without resolver fallback. The Git provider fixture also asserts its selected temporary binary before both invocations. Git subprocesses ignore inherited configuration, hooks, signing and credentials and permit only local file transport. Dot uses captured in-memory programs. Test-only env subprocesses pin /bin/bash and remove inherited shell startup variables. Final passing results apply to these corrected fixtures and do not erase the initial escape history.

## Threats and Later Obligations

- T-08-29-01: complete lexical/physical sets, pinned parents, source/Git/content/config rechecks and real parent races mitigate cross-domain tampering. Independent external-process/cross-process exclusion is not claimed.
- T-08-29-02: nonqueued source reservation, no domain-lock-held path wait, separate network/commit sets, borrowed callback adapters, stop-lease reuse and error/unwind tests mitigate the new deadlock/availability surface.
- T-08-29-03: corrected synthetic fixture selection and explicit initial-escape disclosure constrain the evidence claim. Historical external effects remain unknown.
- Plan29 owns final integration for store, Git, env, dispatch and dot. Mission-state and event-store adapters are staged prerequisites; Plans16/17 must provide their final tested moduleIntegrations handoffs.
- documentRaceConsumer is exactly 08-07 with selector phase08_07_earlier_writer_document_races: Skills save, Skills sync and Git pull each versus document save/create, both orders and aliases. Those six document pairs were pending at original Plan29 completion; Plan07 has now supplied them in docs/performance/phase08-07.json. The original execution does not claim to have produced that later evidence.
- Plan28 --all closure requires the supplied Plan07 document cases and still-pending final 16/17 handoffs. The current --integration29 pass is deliberately narrower. PERF-01 and PERF-02 are not globally completed: requirements.ready-ids returned 0/2 ready because sibling plans remain unfinished.
- No automatic retry, duplicate queue, new job service, Phase09 quit behavior or new command owner was added. Ready for Plan07, wave8.

## Corrective Addendum: Automatic Git Maintenance

Correction commit `8a3bebb` follows the completed Plan07 execution. It addresses the actual .git/objects/maintenance.lock race observed by Plan07: automatic Git maintenance can detach from an otherwise waited Git child, so the original Plan29 subprocess lifetime claim had a real production gap. Local Git 2.55 manuals document auto-maintenance as enabled by default and auto-detach as enabled unless configured otherwise. GIT_OPTIONAL_LOCKS alone does not disable automatic maintenance.

The production change is limited to the two existing command builders, `git::git_command` and `store::store_git_command`. Both now add `-c gc.auto=0 -c maintenance.auto=false` before caller arguments. Existing config arguments, approval/permission behavior and hooks are preserved. The overrides are per invocation; no user or repository configuration is persisted. All existing clone, pull, commit and reconcile callers inherit the policy, including Git subprocesses launched internally by pull.

Two focused tests first failed against the original builders because Git resolved fixture repository `maintenance.auto=true`. Both now pass. Each test verifies effective values false/0 against repository opt-in, global option ordering before the caller subcommand, and unchanged `.git/config` bytes. It then pulls real changed commits from a temporary local bare remote using pull/rebase for git.rs and pull/ff-only for store.rs. Trace2 captures real child starts and successful exits: an explicit foreground positive control re-enables maintenance and observes its child, while the protected pull observes zero maintenance/gc children and the expected new note bytes. Fixture setup always disables automatic work, including the red test run; the positive control forces foreground execution and does not create a detached daemon.

| Corrective check | Actual result |
| --- | --- |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_29_maintenance | Red: 0 passed/2 failed on effective-config assertion; green: 2 passed/0 failed/0 ignored, 0.40 seconds. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib git::phase08_05 | 10 passed, 0 failed/ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib git::phase08_29_git | 7 passed, 0 failed/ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_source_transactions | 12 passed, 0 failed/ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_batch_transactions | 5 passed, 0 failed/ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_03_network_lock | 7 passed, 0 failed/ignored, including clone, reconcile, bundle and metadata availability. |
| CLI/app cargo check, production clippy with warnings denied, rustfmt check | All passed. |

The original full 37-case run remains historical evidence. There are now 39 cumulative named Plan29 cases, including these 2 focused corrective cases; the complete 39-case selector was not rerun for this bounded correction. The original performance/commit metrics above describe the original three-task execution. Corrective evidence is separately recorded under automaticMaintenanceCorrection in the integration overlay, and Plan07's pending production-maintenance item is resolved by reference to that proof.

The correction suppresses automatic maintenance initiated by these Maru Git commands. Independently scheduled maintenance, remote-server administration and deliberate user-hook subprocesses remain outside the in-process exclusion contract. The earlier dispatch fixture escape and unknown historical external effects remain disclosed above. No plan counter, STATE.md or ROADMAP.md changed; Plan08 remains next, and final 16/17 handoffs plus phase-wide closure remain pending.

## Self-Check: PASSED

All three task commits, ten source/evidence artifacts and the 37 named produced tests exist. Required produced checks pass, the seven-module overlay adds no command rows, later obligations remain explicit, and unrelated dirty state is preserved.
