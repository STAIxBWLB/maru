---
phase: 08-main-thread-responsiveness
plan: "05"
subsystem: git-sync
tags: [rust, tauri, concurrency, git, dot, evidence]
requires:
  - phase: 08-04
    provides: Qualified worker pattern and exact command evidence checker
provides:
  - Nine asynchronous Git IPC boundaries with preserved synchronous exports
  - Serialized Git transactions and verified existing dot workers
  - Thirteen hermetic behavioral tests and eleven exact command evidence rows
affects: [08-06, 08-07, 08-25, 08-26, 08-27, 08-28, 08-29]
actuals:
  tokens: 26267
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, owned AppHandle, worker-local State, same-task async probe, conservative Git domain guard]
key-files:
  created: [docs/performance/phase08-05.json]
  modified: [src-tauri/src/git.rs, src-tauri/src/dot_sync.rs, src-tauri/src/lib.rs, .planning/WINDOWS.md]
key-decisions:
  - Git writers hold one fail-closed domain guard through stash/pull/pop or add/commit/push, including aliases and shared stash refs.
  - Owned AppHandle retrieves real ApprovalState only inside the blocking worker, preserving the security store representation.
  - Dot retains existing asynchronous registration and supported schema; unknown local effect roots must fail closed in Plan29.
requirements-completed: [PERF-01]
coverage:
  - id: git-dot-worker-isolation
    description: Eleven actual wrappers isolate blocking work, preserve legacy errors and allow same-task asynchronous progress.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_05
        status: pass
      - kind: other
        ref: cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli
        status: pass
    human_judgment: false
  - id: transactions-and-evidence
    description: Local Git and fake dot fixtures verify transaction ordering, denied actions, failure preservation and exact eleven-row ownership.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_05
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 05
        status: pass
    human_judgment: false
duration: 13min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 05: Git and Workspace Sync Isolation Summary

Nine Git commands now await real blocking workers, and all Git write transactions serialize through their complete operation. Existing dot workers retain their contracts, with invalid requests rejected before even a version-probe process starts.

## Performance

- Started approximately 2026-09-05T05:28Z; completed 2026-09-05T05:41Z.
- Tasks: 2. Implementation/evidence/ledger files: 5.
- Actual tokens: 26267, rounded-up characters/4 over the five-file realized diff from a1c6815 through 3b76643 (105066 characters). Three commits count both tasks and this summary; shared-state tracking is separate.

## Accomplishments

- Converted all nine owned Git registrations to `git::ipc::<name>`: status, changes, diff, message generation, recursive sync scan, submodule listing, pull/rebase, commit/push and commit. Original public synchronous functions and their signatures remain available. Both existing dot commands already used awaited `spawn_blocking`, so their registration paths remain unchanged.
- All directory/config reads, recursive Git subprocesses, provider resolution/environment construction, stdin/output waits, approval consumption, permission checks and domain lock waits occur inside workers. Windows `NoWindow` behavior and constant submodule shell expression remain unchanged. All eleven commands retain `Result<T, String>`; none originally returned `IpcError`. Inner errors pass through untouched; only JoinError receives command-specific context.
- `GIT_ACTION_LOCK` holds through stash/pull/pop or add/commit/push and post-commit status. This conservative Git-domain mutex covers lexical aliases, symlinks and linked-worktree shared stash refs without introducing a second general path system. Poisoning fails closed; the existing six-lock recovery scope is unchanged. Different Git repositories also serialize writes at this stage, a deliberate conservative throughput tradeoff.
- The three status subprocess sites set `GIT_OPTIONAL_LOCKS=0`, suppressing optional index refresh while preserving fixed argv and status payloads. Ordinary reads remain outside the writer guard.
- Dot keeps `DOT_ACTION_LOCK` recovery and full command/refresh lifetime. Existing interval/token/profile/filter/peer acknowledgement validation now runs before binary discovery. Homebrew install/update, mirror/peer operations, filters, home-path and log branches preserve fixed argv and stdin contracts.
- Thirteen new cases cover every actual wrapper boundary, same-task async yield while a distinct blocking thread is held, contextual panic JoinError, real nonempty Git payloads, exact approval errors, zero Git launch on permission/approval denial, one-shot approval consumption, selected-path commits, local bare-remote push and dirty pull, stash retention and real rebase conflict, symlink-alias commits, both other writer entries waiting before validation/process, fake provider readonly argv/stdin/exit failure, fake dot payloads/argv/ack rejection and dot contention/error release.
- Test boundary probes poll the wrapper and async yield from one Tauri runtime task, so spare async workers cannot produce a false pass. Test-local injection is restored before any task migration and compiled out of normal builds.
- `phase08-05.json` records exactly eleven final ISOLATED rows, concrete helper paths, synchronous callers, processing owners and explicit Plan29 integration obligations. Earlier shards remain unchanged and green.

## Owned Inputs

- Status/changes: `String vault_path`; diff adds `String file_path`.
- Message generation: `String vault_path`, `Vec<String> paths`, `String runtime`, `Option<String> command_override`.
- Scan: `String vault_path`, `Option<bool> include_excluded`; submodules: `String workspace_path`.
- Pull: `String repo_path`; commit: `String vault_path`, `String message`, `Option<Vec<String>> paths`.
- Commit/push: owned `AppHandle<R>`, `String repo_path`, `String message`, `Option<Vec<String>> paths`, `Option<String> approval_id`. The worker obtains genuine managed `State<ApprovalState>` and immediately calls the unchanged synchronous function. AppHandle is injected, so wire argument names/shapes do not change.
- Dot overview: no inputs. Dot run: owned `DotSyncActionRequest`.

## Task Commits

1. `827ed6e`: `perf(08-05): isolate Git IPC and serialize sync transactions`.
2. `3b76643`: `test(08-05): prove Git lifecycle and exact command isolation evidence`.

## Executed Checks

| Check | Actual result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_05` | Final 13 passed, 0 failed/ignored, 0.82 seconds after compilation. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib git::tests` | 14 passed, 0 failed/ignored. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib dot_sync::` | 7 passed, 0 failed/ignored. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib approval::tests` | 4 passed, 0 failed/ignored. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc_error::tests` | 4 passed, including recursive contract guard. |
| `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | Passed. |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Passed with desktop registration. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | Passed after fixing the new collapsible match. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed. |
| `node scripts/check-command-isolation.mjs --plan 05` | Passed: 11 rows, 365 production registrations, 0 native-only commands. |
| Same checker for plans 01, 02, 03, 04 | Passed: 1, 1, 24, 7 rows respectively. |
| `git diff --check`, deletion and stub scans | Passed; no deleted tracked files or unfinished stubs. |

No native rebuild is required by this plan; native saturation and feature-off artifact closure remain 27/28. Existing test-build warnings in today_ai.rs and scheduler.rs remain outside scope; normal library clippy is clean.

## Deviations and Issues

1. **Owned State adaptation:** The plan suggested an owned-input helper for borrowed State. ApprovalState contains a non-Clone mutex. Following the parent's explicit direction, the wrapper owns AppHandle and obtains real State inside the worker, avoiding any ApprovalState representation change. Minimal Runtime generic support enables MockRuntime tests. ApprovalState source remains untouched. Recorded and closed in WINDOWS entry4 after behavioral/build verification.
2. **Required serialization/test seams:** Added a narrow Git-domain mutex, `git_command` constructor and test-only fixture helpers beyond the proposed wrapper-name list. They prevent newly concurrent write sequences from interleaving and isolate all test Git children from global/system config, signing, hooks, credentials and non-file transports. Existing repository-reading status regression now uses a disposable repository; mutation regressions sandbox the workspace registry.
3. **Optional index writes:** Audit found that Git status can refresh the index. Disabled only optional status locks/refresh, keeping status/scan inspection genuinely read-only and all explicit Git write locks intact.
4. **Dot preflight validation:** Moved existing rejection conditions ahead of version probes without changing valid request argv. Tests preserve the peer-secret acknowledgement error. Denial precedence now reports invalid input before missing CLI when both apply.
5. **External source-version drift:** Read-only inspection of sibling dotfiles-v2 source `internal/cli/sync_json.go` found schemaVersion2, while Maru currently accepts schemaVersion1. This is source evidence, not an installed-runtime fact. No real dot was invoked, no sibling file was edited, and the supported Maru wire contract remains unchanged.

The initial permission fixture wrote its registry at the wrong directory level; fixed the fixture to use `<test-config>/com.maru.app/workspaces.json`. Approval expectation and a missing Future test import were corrected to the actual existing contract/API. All final checks pass.

## Integration Contract for Plan29

- `integrationRequired: "08-29"` and `moduleIntegrationOwner: "08-29"` remain explicit. Plan06 provides shared admission; Plan29 enters it before GIT_ACTION_LOCK or DOT_ACTION_LOCK. Domain guards are not cross-domain exclusion.
- Git must declare the whole lexical checkout, physical alias, actual per-worktree git directory and common git directory, including index/lock/ref/reflog/object, stash, FETCH_HEAD/ORIG_HEAD and rebase/rollback paths. Linked-worktree stash refs are shared. Include config parent/output for permission-loader legacy vaults.json -> workspaces.json migration. Revalidate parent identity, aliases, permissions, approval and current disk state after admission. Keep registry locks released during network and admission waits.
- Provider message generation reads checkout/config and derives scratchpad/drafts/temp paths through agent_runtime_env and scratchpad resolvers. Existing external provider logs/cache or arbitrary override effects are delegated behavior, not app-owned filesystem containment.
- Dot selects its own configured workspace. Local app-owned effect roots must come from supported CLI configuration/status (`workspacePath`, `storeDir`, local `target.path`) and requested configuration changes, not an assumed Maru workspace. Unknown or unsupported status/effect roots must fail closed before mutation.
- Read-only sibling source references for later integration: `internal/syncer/local_store.go::resolveLocalPaths`, `internal/syncer/helpers.go::Paths`, `internal/syncer/peer_commands.go::PeerHomePathsFile`, and `internal/config/state.go::StatePath`. These describe `<workspace>/.dotfiles/{sync,peer}`, legacy `.dotfiles/gdrive-sync`, config/state/filter files, dynamic filters, baseline/import manifests, tombstone/log files, peer home-path/conflict/plan files and workspace .gitignore. Global config is `(XDG_CONFIG_HOME or ~/.config)/dotfiles/config.yaml`. Scheduler paths are LaunchAgents or systemd user profile units; cache locks/logs are additional local paths.
- Keep local roots/config/scheduler paths separate from remote host destinations, home-path replication, Homebrew prefix/cache and CLI self-update effects. This plan claims no cross-process or arbitrary external-program exclusion.
- Plan29 still owns actual parent rename/trash races and full alias/ancestry/rollback admission. Final07 supplies document consumer races; final16/17 handoffs and the zero-new-command-row Plan29 overlay remain unchanged.
- Processing caller mapping identifies CommitDialog, GitStatusBadge/dashboard/workspaceStore and DotSyncPanel. Existing component callbacks own completion and errors; 25/26 must close unmount-safe notices and retained partial success. In particular, commit may persist before push failure, and a dot action may persist before overview refresh failure. No automatic retry is introduced.

## Safety and Threat Dispositions

- T-08-05-01: worker-local validation, current permission re-read, one-shot approval and conservative domain transactions verified. Cross-domain path admission remains the explicit29 obligation.
- T-08-05-02: same-task yielding and distinct blocking-thread proof verified; transaction/error release tested. No new queue, scheduler, job center or Phase9 quit behavior.
- T-08-05-03: disposable real Git repositories/local bare remotes and fake provider/dot fixtures only. No actual user repository mutation, live remote, dot service, credentials or native hook. Production artifact isolation remains27/28.
- PERF-01 is a shared contribution, not phase-wide closure. No new network endpoint, auth surface, dependency or persisted schema was introduced.

## Self-Check: PASSED

Both task commits exist; all five implementation/evidence files exist; all eleven rows are final and the exact gate passes. No unrelated dirty Phase07 files or runtime artifacts were staged. Ready for 08-06.
