---
phase: 08-main-thread-responsiveness
plan: "07"
subsystem: documents
tags: [rust, tauri, documents, concurrency, evidence]
requires:
  - phase: 08-06
    provides: Hierarchical path admission, pinned parents and actual Files wrappers
  - phase: 08-29
    provides: Earlier Skills and Git writer admission and explicit consumer contract
provides:
  - Eleven awaited blocking IPC wrappers with unchanged synchronous APIs
  - Complete document mutation sets and nested managed snapshot leases
  - Actual parent/document and earlier-writer/document concurrency evidence
  - Twenty-three produced tests and exact eleven-row evidence shard
affects: [08-08, 08-25, 08-26, 08-27, 08-28, 08-29]
actuals:
  tokens: 39080
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, full-path admission, pinned parents, borrowed snapshot lease]
key-files:
  created: [docs/performance/phase08-07.json]
  modified: [src-tauri/src/document.rs, src-tauri/src/file_manager.rs, src-tauri/src/vault_guard.rs, src-tauri/src/lib.rs]
key-decisions:
  - Preserve synchronous exports and structured inner errors while moving all eleven IPC bodies to blocking workers.
  - Reserve complete document, allocation and sidecar paths before permissions and binder locks; nested snapshots reuse the existing lease.
  - Keep deterministic local Git fixtures finite by disabling automatic maintenance, and separately track the discovered production subprocess-lifetime gap.
requirements-completed: [PERF-01]
coverage:
  - id: document-worker-boundaries
    description: Eleven actual wrappers yield on the same polling task while a distinct blocking worker is held; payloads and errors survive.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_07
        status: pass
      - kind: other
        ref: cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli
        status: pass
    human_judgment: false
  - id: parent-and-earlier-writer-consumers
    description: Four Files parent/document pairs and six Skills/Git document pairs pass in both orders through lexical, symlink and ancestor paths, including parent replacement and failure release.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_07
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 07
        status: pass
    human_judgment: false
  - id: production-git-maintenance-lifetime
    description: Automatic Git maintenance can outlive the main Git child; production Git/store builders did not disable it at this plan's completion.
    human_judgment: true
    rationale: Root orchestrator assigned a separate Plan29 correction and verification. Deterministic fixture configuration is not evidence that production detached-child lifetime is already fixed.
duration: 15min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 07: Guarded Document Isolation Summary

Eleven document, file-manager and validation commands now await blocking workers. Seven document mutations use the shared hierarchical admission protocol, retaining permission/revision checks, original parent identity and complete sidecar handling. The owned evidence shard records real Files and earlier Skills/Git consumers without changing other command owners.

## Commits and Scope

- Task 07-1: `bcabfc0`, `perf(08-07): isolate document commands and admit complete mutations`.
- Task 07-2: `2f64961`, `test(08-07): prove document and earlier-writer transaction ordering`.
- Two tasks, five implementation/evidence files, plus this SUMMARY. Actual tokens are 39080, rounded-up characters/4 over the 156320-character five-file diff from `1d3e18c` through `2f64961`; three commits count both task commits and SUMMARY. Shared-state bookkeeping is separate.
- Same checkout and branch, normal hooks, explicit staging and English messages without coauthor trailers. No worktree, push, merge, release, external message, dependency or new framework.
- Unrelated Phase07 research/validation changes and untracked runtime/planning files were preserved. Workspace preflight used the existing project context; no vault mutation or new operational memory was needed.

## Exact Command Ownership and Owned Arguments

All registrations are `module::ipc::command` in `src-tauri/src/lib.rs`; wire names are unchanged. Original synchronous names remain callable.

| Module | Commands | Owned IPC arguments |
| --- | --- | --- |
| document | read_document | vault_path: String, document_path: String |
| document | save_document | vault_path: String, document_path: String, content: String, expected_revision: Option<String> |
| document | update_frontmatter_field | vault_path: String, document_path: String, key: String, value: Option<FieldInput>, expected_revision: Option<String> |
| document | create_document | vault_path: String, title: String, doc_type: String, body: String, target_rel_path: Option<String>, extras: Option<CreateDocumentExtras> |
| document | move_document | vault_path: String, document_path: String, target_rel_path: String |
| document | duplicate_document, trash_document | vault_path: String, document_path: String |
| document | create_version | vault_path: String, document_path: String, title: String, content: String, summary: String |
| file_manager | reveal_in_file_manager, open_in_file_manager | vault_path: String, target_path: String |
| vault_guard | vault_validate_note | content: String, rel_path: String |

No borrowed State, reporter or runtime handle needs adaptation in these eleven commands. Every blocking read, parse, process launch and admission wait begins inside `spawn_blocking`. Join failure adds contextual display-only text; save/frontmatter inner `IpcError` passes through unchanged. Typed admission uses a nested Result inside `with_path_transactions`, preserving conflict codes instead of converting them to String.

## Mutation Sets and Nested Work

- Save and frontmatter reserve the exact document plus `.maru/versions`; create reserves the validated destination with the original nearest existing parent. Original workspace identity is always required.
- Move reserves source, destination and `.maru/binder`, retaining admission through parent creation, rename/copy fallback, binder rekey and rollback. Duplicate reserves the exact source physical alias plus the allocation directory, covering every collision-selected destination. Trash reserves source plus `.maru/trash/documents`; this existing document command uses workspace-local recoverable trash, not system Trash.
- Version creation reserves the selected source and complete versions tree, including unique snapshot publication and atomic temporary files. Managed save/frontmatter invoke `write_version_snapshot_in_transaction` with the current lease. Their test verifies two complete prior-body snapshots and unchanged current body without deadlock or reacquisition.
- All mutation entries capture complete lexical/physical sets before existing domain work, use `with_workspace_registry` for conditional legacy-loader migration, then validate lease coverage, ownership, permissions, revisions and destination state. Pinned directory handles reject both missing and replaced original parents. No new document domain mutex is introduced; existing `BINDER_WRITE_LOCK` remains nested after shared admission.
- The direct synchronous `write_version_snapshot` API remains available to `graph_authoring::snapshot_if_managed` and admits its finite snapshot independently. That caller currently holds no domain guard. Whole graph proposal mutation integration remains the later graph owner's obligation; a snapshot alone does not claim to serialize the entire reciprocal graph transaction. Existing Studio/graph document reads remain synchronous.
- Frontmatter still uses the existing shared frontmatter content operation and preserves comment/order/body bytes. Unsupported HTML frontmatter behavior, missing-file revision conflict and non-contract legacy errors remain intact.

## Executed Evidence

| Check | Actual result |
| --- | --- |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_07 | Final 23 passed, 0 failed/ignored; 18.53 seconds after compilation. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib document::tests | 21 passed, 0 failed/ignored. |
| cargo test --manifest-path src-tauri/Cargo.toml --lib ipc_error::tests | Final 4 passed, including recursive ERR-06 guard. |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed. |
| cargo check --manifest-path src-tauri/Cargo.toml --lib | Passed, including qualified production registrations. |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed. |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Final passed. |
| node scripts/check-command-isolation.mjs --plan 07 | Passed: exactly 11 rows, 365 production registrations, zero native-only commands. |
| git diff --check | Passed. |
| requirements.ready-ids for PERF-01/PERF-02 | 0/2 ready; global requirements remain pending. |

The 23 selector matches comprise seven document tests, ten earlier-writer consumer tests, three file-manager tests, two validator tests and one harmless child fixture entry. Child process executions of that exact entry do not add unique test counts.

- All eleven actual futures are polled and then yield on the same async task while a separate worker is held; injected panic verifies contextual JoinError. A spare runtime worker is not the responsiveness proof.
- Real rename/save, rename/create, trash/save and trash/create run in both admission orders with lexical, child-symlink and ancestor-symlink paths (24 combinations). Child-first commits complete bytes before the parent proceeds. Parent-first rejects the waiting child without restoring the old tree. Rename checks binder rekey; trash retains the existing historical binder behavior.
- Same-revision frontmatter/save run both orders: exactly one typed conflict, complete winner bytes and preserved unrelated body/comment content. All seven document mutations have same-target admission contention and denied-write release followed by success. Move collision rolls back source and binder bytes, then successful retry rekeys.
- Actual Skills save, Skills sync and Git pull each contend with document save/create in both orders and lexical/symlink/ancestor configurations (36 combinations). Overlapping Skills edits return the established single conflict; otherwise complete serial results or an established stale sync result preserve successful content.
- Each of those six pairs covers both orders with original parent removal and replacement (24 cases), plus six injected writer failures releasing waiting documents. Two network-held cases prove healthy registry listing and metadata-only removal complete before checkout release. No test manually wraps an unguarded helper in artificial admission.
- `crossDomainConsumers` in this plan's own shard records all six required Plan29 pairs. The earlier overlay remains unchanged and retains its historical awaiting-producer text; final Plan28 checks consume the new producer evidence.

## Corrections and Limitations

1. **Minimal snapshot adapter.** A borrowed `write_version_snapshot_in_transaction` helper was added beyond the plan's command-named adapter examples because both managed writers share this existing non-command API. It avoids nested reacquisition while preserving the direct graph caller's signature and existing permission responsibilities. No producer module changed.
2. **Fixture expectations and source guard.** Initial file-manager argv expectation missed macOS canonical `/private/var`; expected argv now uses the real validation result. Create-document fixtures now assert the complete existing heading/body/trailing-newline contract. A delegated spare-runtime Tokio probe was removed because this project has no direct Tokio dependency and actual same-task probes already exist. ERR-06 initially rejected test-channel stringification; heterogeneous test channels now preserve IpcError, without source-guard exemptions. Boundary JoinError adapters explicitly assert an empty code before comparing its display-only message.
3. **File-manager isolation.** Success selects the current existing test executable and runs one exact harmless child test, asserting marker and captured production argv, with bounded kill/reap cleanup. Failure uses an existing executable whose temporary interpreter is absent on Unix. An earlier direct captured nonexistent path had no resolver fallback and did not launch a user application; the final fixture nevertheless follows the stricter existing-executable contract. Existing platform argument builders are preserved. Actual Finder/Explorer/window display is not claimed; existing success means process launch acceptance.
4. **Git maintenance is a real production follow-up.** A repeat consumer run failed while `.git/objects/maintenance.lock` disappeared during a content scan. Disposable fixture repositories and setup commands now set `gc.auto=0` and `maintenance.auto=false`, removing detached maintenance from deterministic tests. Read-only audit found production `git::git_command` and `store::store_git_command` did not set those options; automatic maintenance could outlive the Git parent and therefore its lease. This must not be dismissed as fixture-only. The root orchestrator assigned a separate Plan29 minimal correction and verification after this plan. This plan changes neither producer nor its evidence ownership and does not claim that production gap is fixed.
5. **Platform and lifecycle bounds.** Only macOS fixtures ran. Windows compile/runtime, native saturation and final artifact isolation remain later gates. D-04 frontend call sites, current notice owners and existing navigation behavior are annotated; Plans25/26 still implement final lifetime and notice ownership. No automatic retry, new job service or Phase09 quit behavior was added.
6. Existing today_ai/scheduler test-build warnings remain unrelated; production clippy is clean. Plan29's earlier dispatch-fixture historical limitation is unchanged, not reinterpreted by these tests.

## Threats and Handoff

- T-08-07-01: complete path sets, pinned parents, current ownership/revision/permission checks and real serial/conflict tests mitigate the owned mutation surface. This is in-process application admission, not universal exclusion of independent external processes.
- T-08-07-02: blocking workers, same-polling-task proof, bounded barriers and RAII release cover the new command concurrency. The discovered Git automatic-maintenance lifetime remains the root-coordinated Plan29 follow-up above.
- T-08-07-03: disposable roots, local bare Git, captured file-manager children and no live provider/application execution constrain fixture effects. Native artifact verification remains Plan28.
- Plan07's owned implementation and consumer evidence are complete. Plan08 (wave9) is next; Plans16/17 final adapter handoffs and Plans25-28 remain unfinished. PERF-01/PERF-02 are not globally closed.

## Self-Check: PASSED

Both task commits, all five implementation/evidence artifacts and the exact eleven registration rows exist. Required produced checks pass. Shared-state advancement follows this SUMMARY; unrelated dirty files remain preserved.
