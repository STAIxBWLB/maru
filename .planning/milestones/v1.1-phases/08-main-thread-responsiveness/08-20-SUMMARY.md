---
phase: 08-main-thread-responsiveness
plan: "20"
subsystem: studio-and-diagrams
tags: [rust, tauri, spawn-blocking, concurrency, path-transactions, studio, diagram]
requires:
  - phase: 08-19
    provides: Current isolated registration set and same-name pub mod ipc wrapper precedent with state-keyed worker-stage hooks
provides:
  - Nineteen isolated studio and diagram commands with preserved synchronous exports
  - Shared path-transaction admission for studio state writes, body application and every diagram mutation
  - Nine behavioral tests and exact nineteen-row evidence
affects: [08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 90000
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, same-name pub mod ipc wrappers, owned String/Vec/struct inputs, with_path_transactions admission with require_parent workspace snapshots and workspace-registry preconditions, document-cross-domain contention fixtures, once-computed timestamp admitted-set equality]
key-files:
  created: [docs/performance/phase08-20.json]
  modified: [src-tauri/src/studio/mod.rs, src-tauri/src/diagram/mod.rs, src-tauri/src/lib.rs]
key-decisions:
  - All 19 owned rows are final-disposition ISOLATED; the six CONVERT rows and the thirteen AUDIT rows alike now run behind a same-name async pub mod ipc wrapper awaiting spawn_blocking over the unchanged synchronous function, because every body reaches at least one bounded filesystem walk or read/modify/write that failed the checker's retained-helper BLOCKING scan once registration moved off the sync path.
  - Every mutation enters atomic_file::with_path_transactions inside the blocking worker over its complete write set with the pinned workspace-root parent (PathTransactionRequest::require_parent) and the workspace-registry precondition; policy checks (assert_maru_can_write), revision/existence validation and PathTransactionLease::before_effect all run inside the transaction, preserving the original error strings and fast paths (missing-file Ok(false) for the two deletes, Document file does not exist for apply-body).
  - diagram_backup_document computes its millisecond timestamp once and passes it into diagram_backup_document_in_transaction, so the admitted destination and temporary paths are exactly the paths the copy and rename publish, keeping the admitted set and the effect set identical.
  - Held/boundary test hooks are keyed to the actually-admitted paths (the state.json file for studio saves, the diagram/snapshot/preset target files for diagram mutations, the workspace root for the worker-entry yield proof), never to synthetic strings.
  - The checker's INTEGRATIONS map assigns neither studio/mod.rs nor diagram/mod.rs a later-plan handoff, so the shard records moduleIntegrationOwner "08-20" and no moduleIntegrations entries; --plan 20 exits 0.
requirements-completed: [PERF-01]
coverage:
  - id: STUDIO-DIAGRAMS-ISOLATION
    description: All 19 actual IPC futures preserve meaningful synthetic results and legacy rejections while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_20
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 20
        status: pass
    human_judgment: false
  - id: STUDIO-DIAGRAMS-MUTATION-LIFETIME
    description: Shared admission covers studio state writes, apply-body and every diagram mutation with original parents; same-target and cross-domain contention in both orders, error/unwind release and policy denial without effects pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_20
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 20: Studio and Diagrams Command Isolation Summary

All 19 studio and diagram commands now run their blocking work (bounded directory scans, finite file reads, read-modify-writes, atomic publishes, the snapshot prune) in awaited `spawn_blocking` workers behind same-name `pub mod ipc` wrappers. Wire names, payload types, error strings, exported byte identity, snapshot identity, the managed report-asset guard and the Studio write-policy behavior are unchanged.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` work which was not touched.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_20 | Passed: 9 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1692 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 20 | Passed: exact 19 rows, 365 production registrations, 0 native-only commands |

The 9 tests comprise: a same-poll yield + JoinError boundary case driving all 19 real async wrappers (workspace-root-keyed worker-stage hook, export-to-path keyed by its selected target), a nonempty real-fixture result plus unchanged typed/legacy rejection case for every command (Studio save/read/list/apply/delete with frontmatter byte preservation; diagram save/load/list/delete with byte-exact exports, snapshot save/list/restore identity, v7 backup, pattern save/list/delete, report asset), a deterministic same-target studio save serialization fixture in both launch orders proving the last admitted writer wins the file, a cross-domain both-orders fixture proving studio_apply_body and document save_document contend on one admitted document path (stale revision maps to the DOCUMENT_CONFLICT typed error), a diagram save versus document save both-orders fixture, a diagram delete-then-save serialization fixture, and a policy-denial/error-release fixture proving a read-only registry denial and a filesystem error both release admission with no partial effects.

## Corrections and Evidence History

1. `diagram_backup_document` originally recomputed its millisecond timestamp inside the worker; after admission that would let the admitted destination/temporary set drift from the written set and fail `ensure_covered`. The timestamp is now computed once before `PathTransactionRequest::new` and passed into `diagram_backup_document_in_transaction`.
2. The first both-orders studio save run failed because the swap leg launched the "second" payload first, so the last writer (asserted as "second") was actually the "first" title; the fixture now derives the expected title from the actually-second-launched payload in both orders.
3. The two delete commands keep their original missing-file `Ok(false)` fast path before the write-policy check, so a delete of a nonexistent row in a read-only workspace still returns `Ok(false)` exactly as before; only an existing file triggers the Delete policy check.
4. `cargo fmt` reflowed the new `atomic_file` import and three ipc signatures in `diagram/mod.rs`; no semantic change, and the focused tests were re-run green after formatting.
5. The full-suite first run showed one failure in `agent_host::status::phase08_17::...account_and_usage_fixture_results_and_legacy_rejections` (an 08-17 provider probe), which passes in isolation and is unrelated to this shard's files; the final full-suite rerun is 1692 passed, 0 failed, 3 ignored.
6. The checker's INTEGRATIONS map assigns neither owned module a later-plan handoff, so the shard records `moduleIntegrationOwner: "08-20"` and no moduleIntegrations entries; `--plan 20` exits 0.

## Frontend Handoff and Limits

- `src/lib/studio.ts` (studio_state_list/read/save/delete, studio_apply_body), `src/lib/diagram.ts` (all fourteen diagram commands), `src/lib/diagram/reportInsert.ts` (`diagram_write_report_asset` managed-block splice) and `src/components/diagram/modals/ImportExportDialog.tsx` (`diagram_export_blob_to_path`) keep existing invocation, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. D-04 completion ownership, stale-view protection and navigation-safe terminal notices remain Plans25/26; each row's `processingCaller` annotates the call sites and current completion ownership.
- Owned argument types (unchanged on the wire): `studio_state_list(work_path: String)`, `studio_state_read(work_path: String, doc_id: String)`, `studio_state_save(work_path: String, state: StudioState)`, `studio_state_delete(work_path: String, doc_id: String)`, `studio_apply_body(work_path: String, document_path: String, body_markdown: String)`; diagram commands take `workspace: String` plus (`name`/`body`, `name`, `kind`+`bytes`, `doc_id`+`snapshot_ts`[+`content`], `file_name`+`bytes`) with `diagram_export_blob_to_path(target_path: String, kind: String, bytes: Vec<u8>)`. New Rust helpers are limited to the `<command>_in_transaction` adapters; no `<command>_blocking` helper was needed because no owned command accepts `State` or another borrowed runtime object.
- Mutation admission keys: studio state directory + state.json (save), studio state directory (delete), the resolved workspace document path (apply_body, contending with `document::save_document` on one key); diagram target file (save/delete/export_blob/pattern save+delete), user-selected export target (export_blob_to_path), v7 source + timestamped destination + temporary file (backup), snapshot directory + file with the directory covering every prune deletion (save_snapshot), and the managed report asset path (write_report_asset). All seven workspace mutation entries pin the workspace-root parent and carry the workspace-registry precondition.
- None of the 19 commands reaches `skills_dispatch_background`, so the pre-existing uncommitted `skills_dispatch_background_with_parents` symbol in `skill_host/dispatch.rs` is not referenced by this shard and dispatch.rs is preserved untouched.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced; Studio revision/approval behavior (schema stamp, updated_at stamp, write-policy checks) and the managed report-asset ASCII/extension guard are intact.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan20's contribution.

## Threats and Self-Check

- T-08-20-01: the complete write set is admitted before effects with pinned original-parent and alias snapshots, policy and revision checks re-run inside the transaction, and the both-orders/denial fixtures prove no lost update, no permission bypass and no effect on a denied write.
- T-08-20-02: awaited finite blocking closures, same-runtime yield proof on all 19 wrappers, once-computed admitted sets, RAII release on success/error/unwind, and no guard across an await mitigate new async-pool stalls and deadlocks.
- T-08-20-03: Home-isolated fixtures, synthetic fixture paths, disposable tempdir workspaces and the test-only worker-stage hooks constrain the proof; no live workspace, credential, network endpoint or native test hook is claimed.

## Self-Check: PASSED

All 19 owned rows are final in docs/performance/phase08-20.json with zero AUDIT, and all required checks pass (phase tests 9/9, full suite 1692/0/3, maru-cli check, clippy, fmt, checker --plan 20). Changes remain uncommitted per the session contract.
