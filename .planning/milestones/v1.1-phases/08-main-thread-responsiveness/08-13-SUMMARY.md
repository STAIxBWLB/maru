---
phase: 08-main-thread-responsiveness
plan: "13"
subsystem: graph-and-catalog
tags: [rust, tauri, graph, catalog, concurrency, filesystem]
requires:
  - phase: 08-12
    provides: Complete path admission, borrowed scanner and snapshot adapters, and real-policy fixtures
provides:
  - Eleven awaited blocking IPC boundaries with preserved synchronous APIs
  - Complete graph reciprocal-write and derived-cache admission
  - Twenty-three behavioral tests and exact eleven-row command evidence
affects: [08-14, 08-19, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 38622
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, borrowed path leases, original parent snapshots, atomic cache publication]
key-files:
  created: [docs/performance/phase08-13.json]
  modified: [src-tauri/src/vault_graph.rs, src-tauri/src/kg_refs.rs, src-tauri/src/graph_authoring.rs, src-tauri/src/ops_catalog/mod.rs, src-tauri/src/ops_catalog/scan.rs, src-tauri/src/lib.rs, src-tauri/src/vault.rs, src-tauri/src/document.rs]
key-decisions:
  - Original synchronous String error contracts remain unchanged, including the graph document_conflict prefix.
  - Reciprocal graph documents, versions and rollback share one complete admission; nested snapshots borrow it.
  - KG scanner and cache consumers borrow existing scanner leases; public catalog scan owns admission for every caller.
  - Catalog publication preserves its original final-file symlink-following semantics while using atomic replacement of the resolved target.
requirements-completed: [PERF-01]
coverage:
  - id: graph-catalog-worker-boundaries
    description: All eleven actual wrappers yield on their polling task while a distinct blocking worker is held and retain real outputs and errors.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_13
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 13
        status: pass
    human_judgment: false
  - id: complete-graph-and-cache-transactions
    description: Real Files and document races preserve serial outcomes, reciprocal rollback, snapshots, current policies and original parents.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_13
        status: pass
    human_judgment: false
duration: 11min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 13: Graph and Catalog Isolation

Eleven graph and catalog commands now await blocking workers. Reciprocal relationship changes hold complete source, target and snapshot admission through publication and rollback; graph/reference/catalog cache writers share hierarchical admission with real Files and document operations.

## Performance and Commits

- Started following Plan12 at approximately 2026-09-05T08:25Z; completed approximately 08:36Z.
- Two tasks, nine source/evidence files. Actual tokens: 38622, ceiling of 154486 realized diff characters divided by four from `82a9cc0` through `dcb9343`. Three plan commits count two tasks plus this SUMMARY; shared-state bookkeeping is separate.
- Task13-1: `54d942e`, `perf(08-13): isolate graph commands and admit reciprocal writes`.
- Task13-2: `dcb9343`, `perf(08-13): isolate catalog indexing and record command evidence`.
- Explicit staging split the eight graph registrations from the three catalog registrations so each committed tree retains the correct command definitions. Normal hooks ran; no coauthor trailer, branch creation, push, merge or release occurred. Unrelated Phase07 dirty files and runtime artifacts remain preserved.

## Owned Commands and Inputs

All rows finish ISOLATED and register at their defining module's `ipc::<same_name>` in `lib.rs`. Every wrapper transfers owned arguments into `spawn_blocking` before filesystem access, scan, parse, cache work or admission waits. No State/AppHandle adaptation, dispatcher, block_on, held async guard or new job service was introduced.

| Module | Commands and owned arguments |
| --- | --- |
| vault_graph | vault_graph_read: String and Option<String>; vault_graph_root: String; vault_graph_layout_read: String; vault_graph_layout_save: String and GraphLayoutCache |
| kg_refs | kg_document_refs: two String values; kg_refs_clear: String and Option<String> |
| graph_authoring | graph_link_preview: GraphLinkRequest; graph_link_apply: GraphLinkProposal |
| ops_catalog | catalog_scan: CatalogScanRequest; catalog_query: CatalogQueryRequest; catalog_drilldown: CatalogDrilldownRequest |

Original synchronous exports and their signatures remain available. String results, including graph_link_apply's existing `document_conflict: ...` rejection, remain String; no structured-error migration was added. Only vault_graph_root's async adapter adds an outer Result to report JoinError, preserving the original null/String success payload. All JoinErrors carry contextual display-only `<command>_task_failed` strings. Real document competitors retain typed IpcError channels and DOCUMENT_CONFLICT assertions; ERR-06 has no new exemption.

## Transaction and Producer Contracts

- Graph preview admits its selected paths and conditional legacy registry migration before permission/schema loaders. Apply reserves lexical and resolved source and reciprocal target documents, their versions directories, missing .maru creation paths, physical aliases and original existing parents. Admission precedes all loaders and remains held through fresh revision comparison, snapshots, both atomic writes, rollback and readback. The supplied proposal never replaces fresh backend content or permission validation.
- `snapshot_if_managed` consumes `document::write_version_snapshot_in_transaction`, never reacquiring the independent snapshot API. Existing version metadata/body semantics remain intact. Failed second-document atomic replacement rolls back the first graph write; the second document's preserved original bytes and both prior snapshots survive. Cross-workspace reciprocal writes and independently requested snapshots contend on the complete target set.
- Graph's existing self-relation rejection now also recognizes two supported aliases of the same physical note, avoiding two reciprocal patches clobbering one target. It uses the existing graph_relation_self rejection and has an actual alias fixture assertion.
- Layout save reserves the lexical/resolved cache file, publication directory, missing .maru creation path and existing physical endpoints. Its original whole-map replacement, version normalization and atomic final-symlink replacement semantics remain unchanged; no invented wire revision field or merge of deleted nodes was added.
- KG reference computation reserves the workspace source tree, selected document, exact ref cache, scanner index, allocation directories and required registry endpoints, including physical cache-file aliases. `vault_stamp` and `compute_document_refs` pass the existing lease to `read_vault_cache_in_transaction` and `scan_vault_in_transaction`. Cache hits, watcher-stamp behavior, spans, best-effort cache publication and clear counts remain unchanged. Clear-all reloads candidates under admission and verifies coverage before deletion.
- Public `ops_catalog::scan::scan_catalog_impl` enters admission for every synchronous caller, then invokes its borrowed adapter. The complete cache set includes creation ancestors, catalog file and directory, final symlink target and its publication parent. Original-parent and alias checks precede atomic publication. Final-file symlinks, including dangling file links with an existing target parent, continue to be followed as under the original fs::write API. Query and drilldown only read/parse/traverse and need no mutation lease.
- Admission uses original snapshots before the first effect; nested operations only verify coverage under that same lease. No blanket alias refresh, set extension or reacquisition was introduced. Replaced, removed or retargeted selected parents fail without recreating an old workspace. Existing domain locks are not exempted; these graph/cache modules introduce no new domain mutex.

Consumed producer handoffs are deliberately small: `vault::vault_cache_path` becomes pub(crate) to discover the exact scanner cache alias; `document::write_version_snapshot` keeps its independent synchronous signature with a documented dead_code allowance after graph adopts the existing borrowed adapter; catalog scan.rs adds the producer delegate and borrowed body. No stored-state representation changed. The catalog watcher currently emits `catalog://refresh` and the frontend calls the admitted catalog_scan; watcher command lifetime remains Plan19.

## Executed Checks

| Check | Actual result |
| --- | --- |
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_13 | Final 23 passed, 0 failed/ignored; 4.19 seconds after 24.90 seconds compilation |
| graph_authoring::tests | 3 passed |
| vault_graph::tests | 13 passed |
| kg_refs::tests | 18 passed |
| ops_catalog::scan::tests | 11 passed, 1 existing live-workspace smoke ignored |
| ops_catalog::index::tests | 4 passed |
| document::tests | 21 passed |
| vault::tests | 38 passed, 1 existing live-workspace benchmark ignored |
| evidence_binder::tests | 15 passed |
| workspace_files::tests | 18 passed |
| ipc_error::tests | 4 passed, recursive ERR-06 included |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo check --manifest-path src-tauri/Cargo.toml --lib | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Final passed |
| node scripts/check-command-isolation.mjs --plan 13 | Passed: exactly 11 rows, 365 production registrations, no native-only commands |
| GSD verify artifacts | 5/5 passed |
| git diff --check and staged scope review | Passed |

Each ordinary Rust selector in the table ran via `cargo test --manifest-path src-tauri/Cargo.toml --lib <selector>`. Final ordinary regressions total 145 passed, 0 failed and 2 existing opt-in tests ignored, under explicit disposable outer MARU_TEST_HOME/MARU_TEST_CONFIG_DIR. The 23 new tests comprise graph-authoring 9, vault-graph 2, KG references 6 and catalog 6. All eleven actual futures demonstrate same-polling-task yield with a distinct held blocking worker, then contextual JoinError; this is not merely spare-runtime-worker progress. Real-command cases exercise every new writer's contention/error/unwind release, document conflicts, Files rename/Trash in both orders with aliases, exact external cache aliases, parent replacement and reciprocal rollback. Tests use no live graph generation script or provider.

## Deviations and Verification History

1. Rule2 producer integration: protecting only catalog_scan would leave the public scan producer outside admission. The minimal scan.rs adapter makes its actual writer participate. Original fs::write followed a final symlink; atomic publication explicitly resolves that target and reserves its parent to preserve the prior behavior.
2. Rule2 physical identity: graph's lexical-only self-relation comparison could treat two aliases of one note as separate reciprocal targets. The existing self-relation error now covers physical equality, with no new field or code.
3. First named 23-test run passed in 3.88 seconds. Fixture review then found the KG scanner's reached workspace-access check could still use the historical cfg(test) bypass. Final fixtures explicitly register a synthetic direct primary and own the scoped PrimaryWorkspaceAccessFixture. The final 23-test pass exercises that real policy path. Missing .maru creation coverage and a physical-self assertion were also finalized before that final run.
4. Formatting verification initially rejected only the changed catalog import grouping in lib.rs. The grouping was corrected and the full format check passed; no lint rule was disabled.
5. The first ordinary regression invocation lacked outer test-home/config overrides. All selected document/workspace roots were synthetic and the two live-workspace opt-in tests stayed ignored, but some legacy tests do not own a scoped Home, so their policy loaders could consult installed registry/configuration. No pre-run observation established whether that lookup caused a legacy migration or other external effect. Absence of such effects is not claimed. The final entire 145-test regression sequence ran with explicit temporary outer Home/config; this corrected evidence does not erase the initial invocation. No credentials/provider verification, installed integration execution or user-file cleanup was performed to speculate about the earlier effects.

## Frontend and Remaining Obligations

- GraphView's overlayRequestRef owns overlay/hint/refreshing settlement. Layout-load effects cancel stale seed updates; debounced layout save currently discards failures as a disposable-cache operation and has no terminal notice. GraphModeAdapter cancels stale nested-root publication.
- GraphRelationReviewDialog owns preview cancellation, applying/error state and onApplied/close; applying a proposal is still user initiated. The backend completes even if its initiating component disappears; durable notification ownership is not claimed here.
- App KG editor focus checks request, owner, tab and current editor before publication. Highlight-toggle completion lacks the same stale-result ownership; Plan25/26 must resolve that. kg_refs_clear is currently an exported API without a production frontend caller.
- CatalogPane refresh owns report/entries/loading/error; the scan report is retained before a later query failure. Manual and watcher refresh use that same path. DrilldownDialog uses cancelled effect ownership. Durable terminal notification still belongs to Plan25/26.
- No automatic retry, duplicate queue, job center or Phase09 quit/terminal escalation was added. Plan12 provider-outcome reconciliation markers and its explicit Plan26 handoff remain unchanged.
- PERF-01/PERF-02 remain globally pending until sibling/backend/frontend/native gates close. This SUMMARY records only the Plan13 contribution.

## Threats and Limits

- T-08-13-01: complete shared path sets, original parents, current real-policy/revision checks and actual parent/document races mitigate tampering at the owned write boundary. Reciprocal rollback and snapshot tests verify the existing partial-failure behavior.
- T-08-13-02: awaited blocking workers, deterministic same-task proof, complete RAII lifetime and error/unwind release mitigate async-pool stalls and newly concurrent transaction waits.
- T-08-13-03: final new fixtures use disposable Home/config, synthetic documents, scoped real-policy access and exact TrashFixture redirection. The initial ordinary-regression environment limitation above remains explicit.
- This is in-process admission, not exclusion of independent external editors/processes. Only macOS fixtures ran; no Windows/native-app/release-artifact saturation proof is inferred. Existing today_ai/scheduler test warnings and macOS linker unwind-size warning remain; production clippy is clean. Plan29's earlier installed-Claude fallback and unknown historical effects remain unchanged.

## Self-Check: PASSED

Both task commits, all required artifacts and eleven final evidence rows exist. Required produced checks pass, the unrelated dirty state is preserved, and this SUMMARY is committed before state advances to Plan14, wave15.
