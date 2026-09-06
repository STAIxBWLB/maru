---
phase: 08-main-thread-responsiveness
plan: "08"
subsystem: scratchpad-drafts
tags: [rust, tauri, scratchpad, drafts, gap, concurrency]
requires:
  - phase: 08-06
    provides: Complete hierarchical admission, pinned parents and scoped fixture barriers
  - phase: 08-07
    provides: Actual document wrappers and nested mutation lease pattern
provides:
  - Thirty awaited blocking IPC boundaries with unchanged synchronous APIs
  - Admitted scratchpad, shelf, drafts and Gap mutation chains
  - Actual production-policy wrapper checks and complete draft rollback
  - Thirty-two behavioral cases and exact thirty-row evidence
affects: [08-09, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 94948
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, owned AppHandle, pinned parents, borrowed transaction lease]
key-files:
  created: [docs/performance/phase08-08.json]
  modified: [src-tauri/src/scratchpad.rs, src-tauri/src/shelf.rs, src-tauri/src/drafts.rs, src-tauri/src/gap.rs, src-tauri/src/lib.rs, src-tauri/src/vault_list.rs]
key-decisions:
  - Preserve all thirty synchronous signatures and legacy String errors while moving IPC work and admission waits into blocking workers.
  - Reuse complete leases through scratchpad transitions, draft lineage and rollback; snapshot dynamic Gap inputs under workspace admission.
  - Exercise the actual production permission function through scoped test opt-in, and require Plan09 to consume the nested task-promotion lease.
requirements-completed: [PERF-01]
coverage:
  - id: thirty-owned-worker-boundaries
    description: Thirty actual wrappers yield on their polling task while a distinct blocking worker is held, preserving payloads and contextual errors.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_08
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 08
        status: pass
    human_judgment: false
  - id: admitted-domain-writes-and-policy
    description: Real same-target and cross-domain operations preserve revisions, parents, lineage, index and baseline bytes, with actual production policy rejection after admission.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_08
        status: pass
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib scratchpad::tests
        status: pass
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib drafts::tests
        status: pass
    human_judgment: false
duration: 18min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 08: Scratchpad and Draft Isolation Summary

Thirty scratchpad, shelf, drafts and Gap commands now await blocking workers. Complete path admission covers implicit index adoption, registry migration, source/destination allocation, lineage, baseline and rollback effects. The owned shard records thirty exact rows with no AUDIT dispositions.

## Commits and Scope

- Task 08-1: `55cecfe`, `perf(08-08): isolate scratchpad shelf and drafts transactions`.
- Task 08-2: `d9136c1`, `perf(08-08): isolate gap analysis and record command evidence`.
- Two tasks, seven implementation/evidence files. The SUMMARY is a separate third commit; state advancement follows it separately. Actual tokens are 94948, rounded-up characters/4 over the 379792-character seven-file diff from `ac27cd2` through `d9136c1`, not harness token usage. Duration is approximate.
- Same checkout and branch, explicit file staging and normal Git hooks, English messages without coauthor trailers. Scratchpad, shelf and drafts implementation was delegated by disjoint file; parent serialized registration, verification and commits.
- Preserved unrelated Phase07 research/validation changes and untracked runtime/planning files. No branch, worktree, push, merge, release, dependency, provider connection or external message was created.

## Exact Command Ownership and Arguments

Every current registration is `module::ipc::command`; all original public synchronous names remain available. All thirty existing result types are `Result<T, String>`. Inner errors are unchanged; worker JoinError is display-only `<command>_task_failed` context. ERR-06 continues to protect typed errors elsewhere without exemptions.

| Module | Commands and exact owned argument types |
| --- | --- |
| scratchpad | `scratchpad_list`, `scratchpad_create_idea`, `scratchpad_cleanup_plan`, `scratchpad_migrate_legacy_memos`: `work_path: String`, plus `title: String` for create. |
| scratchpad | `scratchpad_read`: `work_path: String`, `collection: ScratchpadCollection`, `relative_path: String`. |
| scratchpad | `scratchpad_save`: read arguments plus `format: ScratchpadFormat`, `content: String`, `expected_revision: Option<String>`, `force: bool`. |
| scratchpad | `scratchpad_rename`: read arguments plus `new_relative_path: String`, `expected_revision: String`; `scratchpad_trash`: read arguments plus `expected_revision: String`. |
| scratchpad | `scratchpad_transition_idea`: `work_path: String`, `relative_path: String`, `stage: IdeationStage`, `expected_revision: String`; `scratchpad_cleanup_apply`: `work_path: String`, `selections: Vec<TempCleanupSelection>`. |
| shelf | `store_shelf_files`: `vault_path: String`, `sources: Vec<String>`, `operation: FileStoreOperation`; `store_shelf_files_as`: `sources: Vec<String>`, `target_dir: String`, `operation: FileStoreOperation`. |
| shelf | `list_memos`: `vault_path: String`; `read_memo`: `vault_path: String`, `memo_path: String`; `save_memo`: `vault_path: String`, `name: String`, `format: MemoFormat`, `content: String`; `delete_memo`: `vault_path: String`, `memo_path: String`, `expected_revision: Option<String>`; `save_memo_as`: `vault_path: Option<String>`, `target_path: String`, `content: String`. |
| drafts | `drafts_list`, `drafts_promote_default_dir`: `work_path: String`; `drafts_read`: `work_path: String`, `id: String`. |
| drafts | `drafts_save`: `app: AppHandle<R>`, `work_path: String`, `id: String`, `body: String`, `expected_updated_at: String`; `drafts_create`: `app: AppHandle<R>`, `work_path: String`, `kind: DraftKind`, `title: String`, `source: ScratchpadSource`, `importance: Option<DraftImportance>`, `confidence: Option<f32>`, `origin_refs: Option<Vec<String>>`, `body: String`. |
| drafts | `drafts_set_status`: `app: AppHandle<R>`, `work_path: String`, `id: String`, `status: DraftStatus`; `drafts_discard`: app/work/id. |
| drafts | `drafts_promote`: `app: AppHandle<R>`, `work_path: String`, `id: String`, `target: DraftPromoteTarget`, `target_path: Option<String>`, `approval_id: Option<String>`; `drafts_relink_promoted`: app/work/id plus `target_path: String`. |
| gap | `gap_analyze`, `gap_append_log`: `work_path: String`, `draft_id: String`; `gap_log_list`: `work_path: String`, `limit: Option<u32>`; `gap_reports_list`: `work_path: String`. |

Scratchpad, shelf and Gap need no State adaptation. Six drafts event commands use owned generic `<command>_blocking<R>` helpers. Original concrete AppHandle synchronous APIs delegate to those helpers unchanged. Promotion owns AppHandle, retrieves the live `ApprovalState` inside the worker, consumes approval there, then invokes the same blocking helper. Mock-runtime tests exercise actual registered wrapper bodies; no fabricated State, borrowed reporter or guard crosses await.

## Admission and Effects

- Scratchpad reserves its configured subtree, workspace config and exact selected endpoints, with `.maru/drafts` for transition lineage and `.maru` staging/marker plus legacy memo paths for migration. Original workspace and nearest existing endpoint parents are pinned. Nested read/save/rename and `update_idea_origin_refs_in_transaction` reuse admission through transition rollback.
- Shelf reserves all source paths plus destination allocation subtree for copy/move, including collision names and fallback. Memo CRUD reserves scratchpad/config/exact memo paths and borrows scratchpad adapters. Save As reserves its exact target and original workspace parent. Original arbitrary-file store policy remains unchanged; memo permissions retain their existing guards.
- Drafts reserves original lexical and physical configured body roots, config and complete `.maru/drafts` index/baseline subtree. Promotion adds exact document target or resolved task active allocation subtree. Relink preserves baseline bytes. Orphan adoption in `drafts_list` remains a guarded write. Create/save/promotion restore or remove body, target and baseline on failed index commit; discard commits index before Trash and restores original index bytes if Trash fails, avoiding successful deletion followed by failed index publication.
- Gap reserves the workspace snapshot because promoted targets are selected dynamically from its index. Analysis, report listing and log reads remain free of domain content writes, but conditional registry migration is covered. Append reads baseline/document, compares the latest log row and appends under the same lease; double clicks produce one identical entry. Its existing append mutex is acquired after shared admission. The unused rewrite helper independently admits its exact log path.
- All entries include `with_workspace_registry`, check coverage and call `before_effect` before permission loaders can migrate legacy state. Ownership, capabilities, revisions and destination state are checked after admission. No existing domain guard is an exemption. No executor registry, block_on, retry queue or new job service was added.

## Executed Verification

| Command | Actual result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_08` | Final 32 passed, 0 failed/ignored; 5.78 seconds after compilation. Scratchpad 9, shelf 7, drafts 10, Gap 6. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib scratchpad::tests` | 25 passed, including directory/file lineage rollback. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib shelf::tests` | 7 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib drafts::tests` | Final 36 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib gap::tests` | 31 passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc_error::tests` | 4 passed, including recursive ERR-06. |
| `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | Passed. |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Passed. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | Final passed after removing needless borrowed references. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed. |
| `node scripts/check-command-isolation.mjs --plan 08` | Passed: exactly 30 evidence rows, 365 production registrations, no native-only commands. |
| `git diff --check` | Passed. |
| `requirements.ready-ids` with Plan08 path and `PERF-01,PERF-02` | 0/2 ready; global requirements remain open. |

Every actual wrapper yields on the same polling task while a distinct blocking worker is held, and the injected worker failure verifies contextual JoinError. Same-target cases cover every new writer with failure release. Scratchpad has 56 real Files parent rename/trash combinations across all seven mutations, both orders and workspace aliases, plus document save, read/rename/trash, parent disappearance/replacement and registry migration. Shelf verifies all five writers against parent rename and physical aliases. Drafts verifies same-revision saves, approval, all writers, complete rollback, promotion versus Files/document writers, and read versus actual rename/local document trash. Gap verifies concurrent duplicate append, document-save ordering with lexical/child/ancestor aliases, parent rename during read/append and denied-write release.

## Corrections and Limitations

1. **Real permission branch.** Existing `assert_scratchpad_workspace_access` bypassed registry access in test builds, and the underlying production function was itself cfg(not(test)). Removed only that attribute from `vault_list::assert_primary_private_workspace` and added a path-scoped RAII opt-in in the scratchpad test module. Selected temporary fixtures now invoke the exact production function; other tests retain their historical behavior. Actual wrappers reject foreign workspaces and readOnly writes, including policy changes after admission. No production permission bypass or guard exemption was introduced.
2. **Gap write permission.** Audit found explicit log append checked primary-workspace access but omitted the existing write-capability guard. Added `assert_maru_can_write(..., Modify)` inside its admitted worker; real readOnly/post-admission tests demonstrate no log creation while read-only analysis remains allowed.
3. **Minimal helper deviations.** Added `update_idea_origin_refs_in_transaction` for the existing non-command nested lineage writer rather than naming it after an unrelated command. Seven otherwise-unused retained drafts synchronous APIs have narrowly scoped dead_code allowances with compatibility comments; business/permission/error guards have none. Generic event helpers preserve original concrete synchronous signatures and stored state representation.
4. **Regression corrections.** Initial compile caught malformed test assertions and a duplicate generated Gap wrapper module, both fixed. Existing drafts tests exposed five `/var` versus `/private/var` configured-root failures from admission suffix calculation; preserve the configured path and canonicalize only the alias calculation. All 36 existing drafts tests then passed. Clippy reported only new needless borrows, removed without semantic changes.
5. **Scope bounds.** Admission conservatively serializes the scratchpad/drafts subtrees and Gap workspace snapshots. Independent workspaces remain separate; independent external editors/processes remain outside in-process exclusion. Existing scratchpad managed-root symlink rejection is preserved, while supported workspace aliases are tested. Only macOS ran; Windows native runtime, saturation and produced-artifact isolation remain later gates. Tests use temporary roots, existing cfg(test) local Trash behavior, workspace-local document Trash and scoped Files TrashFixture. No system Trash, installed CLI, Finder, provider, user Git or credentials were exercised. Existing unrelated today_ai/scheduler test-build warnings remain; production clippy is clean.

## Threats and Next Consumer

- T-08-08-01 mitigated for owned paths by complete admission, current production ownership/capability/revision checks, denied writes and complete rollback evidence.
- T-08-08-02 mitigated by awaited blocking workers, same-polling-task evidence, bounded fixture barriers and RAII release. Native load verification remains Plan27.
- T-08-08-03 mitigated by temporary scoped fixtures and no native/external process invocation in this tranche; final artifact isolation remains Plan28.
- **Required Plan09 handoff:** `drafts::drafts_promote_in_transaction` currently calls `tasks::create_task_note` while holding body/config/index/baseline plus resolved `tasks/active` allocation admission. That existing synchronous task helper has no admission today and all its effects occur inside the outer lease. When Plan09 adds task admission, it must provide `create_task_note_in_transaction` and switch this exact dependent caller to the borrowed lease. Reacquiring admission here would deadlock. This plan neither invents a future adapter nor claims the later tasks surface complete.
- D-04 call sites, current initiating completion owners and navigation limitations are recorded per row. Plans25/26 still own the shared lifetime/notice path; no Phase09 quit behavior is added. Plan09 is next at wave10; PERF-01/PERF-02 are not globally complete.

## Self-Check: PASSED

Both task commits, all seven implementation/evidence files and thirty current registration rows exist. Required produced checks pass, the owned shard has zero AUDIT entries, and unrelated dirty files remain preserved. SUMMARY commit precedes separate shared-state advancement.
