---
phase: 08-main-thread-responsiveness
plan: "06"
subsystem: workspace-files
tags: [rust, tauri, filesystem, concurrency, admission, evidence]
requires:
  - phase: 08-05
    provides: Qualified asynchronous command boundaries and verified evidence checker
provides:
  - Fifteen awaited blocking IPC boundaries with stable synchronous exports
  - Complete hierarchical and physical-alias mutation admission with pinned parent handles
  - Explicit reusable parent snapshots and scoped consumer test barriers
  - Twenty deterministic behavioral tests and exact fifteen-row evidence
affects: [08-07, 08-10, 08-13, 08-16, 08-17, 08-25, 08-26, 08-27, 08-28, 08-29]
actuals:
  tokens: 47405
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, atomic path-set admission, owned RAII lease, pinned directory identity, scoped test barriers]
key-files:
  created: [docs/performance/phase08-06.json]
  modified: [src-tauri/src/atomic_file.rs, src-tauri/src/vault.rs, src-tauri/src/workspace_files.rs, src-tauri/src/content_search.rs, src-tauri/src/calendar_search.rs, src-tauri/src/lib.rs, src-tauri/src/vault_list.rs, src-tauri/Cargo.toml]
key-decisions:
  - Shared admission owns complete lexical and physical path sets before domain locks; no mutex is held during filesystem work.
  - Pinned directory handles distinguish removal and recreation; independent callbacks use fresh requests with original parent snapshots.
  - Normal directory normalization never creates a vanished workspace; sample initialization remains an explicit creation path.
  - Cache publication remains best-effort and journal recovery completes binder rekeys under admission.
requirements-completed: [PERF-01]
coverage:
  - id: workspace-worker-isolation
    description: All fifteen actual wrappers allow same-task asynchronous progress while a distinct blocking worker is held.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_06
        status: pass
      - kind: other
        ref: cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli
        status: pass
    human_judgment: false
  - id: mutation-admission
    description: Actual Files command races preserve parent identity, permissions, complete rekeys, unrelated progress and lease release on this macOS host.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_06
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 06
        status: pass
    human_judgment: false
  - id: windows-parent-identity
    description: Windows directory handles and volume/file identifiers implement the same stable-parent precondition.
    human_judgment: true
    rationale: Windows code is target-gated; no Windows compile or runtime check was available on this macOS host. Native platform verification is not inferred from macOS results.
duration: 23min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 06: Workspace Scans and File Transactions Summary

Fifteen commands now await blocking workers. Workspace mutations atomically reserve complete path sets, reject replaced parents after waiting, and retain admission through rekeys and rollback. Scans retain document exclusions and nonfatal cache writes.

## Performance

- Started approximately 2026-09-05T05:42Z; completed approximately 2026-09-05T06:05Z.
- Two tasks, nine implementation/evidence files.
- Actual tokens: 47405, rounded-up characters/4 over the 189619-character nine-file diff from 75ce783 through 58d5a9f. Three commits count both tasks and this SUMMARY; shared-state bookkeeping is separate.

## Task Commits

1. `7bc090e`: `perf(08-06): isolate workspace workers and admit complete mutation sets`.
2. `58d5a9f`: `test(08-06): close calendar isolation and workspace mutation evidence`.

Each task commit preserves a compilable registration set. Calendar implementation and registration were held for the second task. Normal commit hooks ran; no coauthor trailer or hook bypass was used.

## Accomplishments

- All fifteen exclusive commands finish ISOLATED. Registrations use vault::ipc, workspace_files::ipc, content_search::ipc and calendar_search::ipc. Original synchronous command functions remain available. Owned arguments enter spawn_blocking before filesystem traversal, subprocess work, permission checks and admission waits. Inner Result payloads pass through unchanged; only JoinError receives contextual String text.
- All fifteen owned commands originally returned String errors, so no typed error was converted or flattened. The existing four IPC-error contract tests, including the recursive guard, pass.
- PathTransactionRequest admits an entire deduplicated subtree set under one short Mutex/Condvar. Equality and component-wise ancestry conflict, so prefix siblings remain independent. Lexical paths retain authorization meaning; canonical targets or nearest existing ancestors plus missing suffixes provide additional physical identities. Dangling symlink entries remain representable; retargeted aliases fail revalidation.
- Parent handles stay open through admission. Unix compares device/inode on pinned directories; Windows opens directory handles with BACKUP_SEMANTICS and compares volume serial/file index. Timestamps are not identities. The reusable PathTransactionParent keeps an Arc<File> for later independently admitted callbacks.
- Files transactions cover source/destination sets, collision-derived target directories, rename journals, binder sidecars and rollback. Conditional legacy registry migration paths are included when needed; a condition that changes while waiting fails before the loader can write outside the set. Permission and lexical checks run inside the admitted operation. An unrelated directory create completes while another create is held.
- scan_workspace_entries also mutates through journal recovery. Recovery reserves the workspace plus captured journal source/destination aliases, normalizes traversal components, checks actual coverage again and completes binder rekeys before removing journals. A failed rekey rolls the rename back. Invalid escaping journals remain untouched rather than operating outside the workspace.
- scan_vault reserves cache and transitive registry-migration paths; cache failures remain best-effort. Full scan, targeted scan and cache return paths retain non-document/generated exclusions, including stale cache rows. Directory normalization no longer creates a missing root; embedded sample initialization still explicitly creates its own tree.
- Tests hold actual IPC workers and poll their futures with a yielding probe on the same Tauri task, ruling out spare-worker false positives. Real fixtures cover nonempty results, exact legacy errors, same-target create/duplicate/paste/queue contention, rename/trash versus create in both admission orders, queue versus rename, replaced parents, permission changes, migration-condition changes, symlink aliases, case aliases, nested real mutations, rekey rollback and error/unwind release.

## Owned Inputs

- sample_workspace_path: no wire input.
- scan_vault, scan_workspace_files and scan_workspace_entries: String vault_path and Option<ScanOptions>.
- scan_vault_paths: String vault_path, Vec<String> rel_paths and Option<ScanOptions>.
- read_vault_cache: String vault_path.
- create_workspace_directory: String vault_path, parent_path and name.
- rename_workspace_entry: String vault_path, source_path and new_name.
- duplicate_workspace_entries: String vault_path and Vec<String> source_paths.
- paste_workspace_entries: String vault_path, Vec<String> source_paths, String target_dir and FileQueueOperation.
- trash_workspace_entries: String vault_path and Vec<String> target_paths.
- describe_file_queue_sources: Vec<String> paths.
- apply_file_queue: String vault_path and Vec<FileQueueApplyItem>.
- search_workspace_contents: String workspace_path, String query and Option<ContentSearchOptions>.
- search_calendar_notes: String work_path, Vec<String> roots and String query.

No State, AppHandle or borrowed guard adaptation was needed in these fifteen rows. Wire names and camelCase argument handling remain unchanged.

## Executed Checks

| Check | Actual result |
| --- | --- |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_06 | Final 20 passed, 0 failed/ignored, approximately 0.10 seconds after compilation. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib vault::tests | Default parallel harness: 38 passed; existing real-workspace benchmark remains ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_files::tests | Final default parallel harness: 18 passed, 0 failed/ignored. |
| Existing content_search::tests / calendar_search::tests / atomic_file::tests | 20 / 5 / 4 passed, using isolated process test-home/config with --test-threads=1. |
| Existing ipc_error::tests / document::tests / workspace::tests | 4 / 21 / 6 passed with the same isolated process configuration. |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Final passed. |
| cargo check --manifest-path src-tauri/Cargo.toml --lib | Final passed, including desktop registration. |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Final passed. |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed. |
| node scripts/check-command-isolation.mjs --plan 06 | Passed: exactly 15 rows, 365 production registrations, 0 native-only commands. |
| git diff --check, added-stub scan, post-commit deletion checks | Passed; no newly added placeholder or tracked-file deletion. |

The real macOS fixture volume accepted CaseFolder/casefolder as aliases; canonicalize returned identical physical paths. A real create/create case-alias race passed. Conservative lowercase exclusion keys add protection on macOS/Windows but are not evidence for every Unicode normalization/case-equivalence rule. Authorization paths remain unchanged.

Windows identity code is present, with the existing windows-sys dependency's Win32_Storage_FileSystem feature enabled. No Windows target build or runtime test was performed; rustup is not available on this host. No new native app rebuild/run was required. Native saturation and feature-off artifact closure remain Plans27/28.

## Producer API and Consumer Obligations

All APIs below are pub(crate) in src-tauri/src/atomic_file.rs unless stated otherwise.

- PathTransactionRequest::new(IntoIterator<Item=PathBuf>) requires absolute complete paths and captures aliases plus nearest existing parent handles. require_parent(&Path) adds an exact required existing directory. with_workspace_registry() conditionally adds the existing legacy-loader input/output paths and rechecks the migration condition after waiting.
- with_path_transactions(request, closure) acquires one RAII lease and passes &PathTransactionLease to a synchronous Result<T,String> closure. PathTransactionRequest::acquire() returns an owned lease for dedicated background-thread lifetimes. For typed domain results, map only acquire's String error to IpcError, then return the typed in-transaction result untouched. No lease or domain guard crosses an async await.
- PathTransactionParent::capture(&Path) is Clone through an owned Arc<File>. require_parent_snapshot(&snapshot) validates and retains that original directory identity in a fresh request. Use this for independently scheduled callbacks; do not recapture the same pathname after replacement and call it the original parent.
- Lease::ensure_covered(paths) verifies the entire nested lexical/physical set without extending admission. ensure_workspace_registry() prevents nested callers from invoking a migrating permission loader without coverage. Workspace create/rename/duplicate/paste/trash/queue have explicit *_in_transaction(lease, original arguments...) adapters that preserve original validations.
- Lease::before_effect() revalidates original parent/alias selection before the FIRST effect in that lease. Subsequent nested rekey/rollback calls retain coverage and domain checks, but do not reject changes made by their own transaction. This is documented in Rustdoc and tested by actual rename followed by nested create. It is not a reusable stale-check substitute for later independent work.
- Plan29 network-to-commit work must release its network lease, atomically acquire the fresh complete registry/sidecar commit set, and revalidate current source/config/content while retaining source-operation reservation. No nested set extension, domain-lock-held admission wait or automatic retry is introduced. Repeated callbacks use fresh requests with original parent snapshots; a whole owned background transaction may move the owned lease to its dedicated thread and retain it through completion/rollback.
- Shared admission precedes BINDER_WRITE_LOCK and every other applicable domain lock. Plan29 must add it before earlier Git/Skills/env/dispatch/dot guards; those existing guards are not exemptions. Metadata registry paths must remain outside network leases so reads and metadata-only removal can progress.
- cfg(test) PathTransactionTestHook::new(explicit_path, stage, callback) provides path-scoped before-admission, admitted and pre-effect stages. Worker stages are worker:<command>. Callbacks execute without holding admission bookkeeping. atomic_file::phase08_06::Held supplies bounded one-shot hold/release support; its Drop releases a waiting fixture. Home uses the existing shared test-home lock and restores environment values. workspace_files::phase08_06::TrashFixture maps one explicit source path to one disposable destination through the real Trash wrapper, preventing tests from using the user's system Trash.
- Plan29 consumes real workspace parent wrappers immediately. Plan07 owns document wrappers and all earlier-writer/document pairs; this plan does not simulate admission around unconverted document functions. Existing inbox.rs copy_source/move_source calls remain byte/tree primitives; Plan10 must admit their entire owning transactions. kg_refs.rs retains synchronous scanner/cache consumers. Later domain adapters must reuse an existing lease when nesting these admitted functions.
- Evidence maps FilesWorkbench.runMutation and App.applyQueuedFiles ownership. Mixed Files outcomes preserve successful targets. Queue groups can partially persist before another group rejects. Plans25/26 own surviving completion, retained successes, actionable errors and one terminal notice. The current shard records these obligations rather than claiming the frontend lifecycle work is already complete.

## Deviations and Issues

1. **[Rule 2, approved scope correction] Registry resolver visibility and Windows feature.** Exposed only existing workspace_registry_path/legacy_vault_list_path as pub(crate); permission behavior is unchanged. Enabled one existing windows-sys feature for stable Windows handles. Parent approved both narrow corrections.
2. **[Rule 1] Implicit workspace resurrection.** normalize_existing_dir previously called create_dir_all. Removed this implicit creation, preserving explicit sample creation. Missing-root, document and workspace regressions pass.
3. **[Rule 1] Recovery correctness.** Final audit found unnormalized journal paths and missing recovery binder rekeys. Added complete alias sets, lexical coverage checks and rekey/rollback; actual aliased recovery and escaping-journal fixtures pass. This directly protects the newly parallel recovery entry.
4. **[Rule 2] Producer/test helper scope.** Added reusable parent snapshots, explicit registry-coverage checks and scoped fixture helpers beyond the plan's initial proposed-name list, as required by the immediate Plan29/07 consumer contracts. No dispatcher, job service or production test port was added.
5. **[Rule 1, test isolation] Existing global config fixture race.** New identity checks exposed an existing vault test changing process-wide test configuration while peer scans ran. Owned vault/workspace filesystem tests now use the existing common Home lock/sandbox; both module suites pass in the default parallel harness. Git and vault_list fixture writers already use that same lock. The first serialized diagnostic run is not presented as the final parallel proof.

Initial test errors were corrected to the actual fixture contracts: canonical temporary roots on macOS, the default inbox/downloads root, mandatory registry label/visibility fields and the existing binder path-ID format. Clippy findings in new code were fixed. Existing today_ai/scheduler test-build warnings and the pre-existing ignored live-workspace benchmark remain unchanged.

## Safety and Threat Dispositions

- T-08-06-01: complete source/destination/sidecar admission, pinned parents, alias/permission rechecks, nested coverage, recovery validation and real denial/rollback fixtures mitigate the new concurrent mutation surface. This is in-process exclusion, not a cross-process TOCTOU guarantee or containment claim over arbitrary external programs.
- T-08-06-02: lock waits and work occur in blocking workers; same-task probes, unrelated-directory progress and error/unwind release pass. Native saturation remains Plan27.
- T-08-06-03: only explicit disposable fixture roots, local subprocess reads and test-gated Trash routing were exercised. No user repository, credential, live sync or provider was used. Final produced-artifact isolation remains Plan28.
- No automatic retry, duplicate queue, job center, Phase9 quit behavior, push, merge or external message was added.
- PERF-01 remains globally pending because sibling plans and phase-wide native proof are unfinished.

## Self-Check: PASSED

Both task commits and all nine source/evidence artifacts exist. The final twenty behavioral tests and fifteen-row gate pass. No unrelated dirty Phase07 files or runtime artifacts were staged. Ready for Plan29, wave7, before Plan07.
