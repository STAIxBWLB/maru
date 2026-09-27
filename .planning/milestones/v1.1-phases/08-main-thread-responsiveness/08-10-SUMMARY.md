---
phase: 08-main-thread-responsiveness
plan: "10"
subsystem: ipc
status: complete
tags: [tauri, rust, inbox, outbox, binary-viewer, secrets, path-transactions]
requires:
  - phase: 08-06
    provides: Complete hierarchical path admission, original-parent snapshots and scoped fixtures
  - phase: 08-07
    provides: Admitted document mutations and actual parent rename/trash consumers
  - phase: 08-09
    provides: Current alias-aware workspace write policy and preceding registration tranche
provides:
  - Thirty-four final command rows with awaited blocking boundaries and synchronous domain APIs
  - Serialized Inbox decisions and local outbox preparation with successful sibling retention
  - Admitted file-based secret migration, writes and deletion with disposable fixture proof
affects: [08-11, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 91425
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [owned async IPC wrappers, original parent snapshots, borrowed mutation leases, scoped process fixtures]
key-files:
  created: [docs/performance/phase08-10.json]
  modified:
    - src-tauri/src/inbox.rs
    - src-tauri/src/inbox_classifier.rs
    - src-tauri/src/share_outbox.rs
    - src-tauri/src/binary_viewer.rs
    - src-tauri/src/secrets.rs
    - src-tauri/src/lib.rs
key-decisions:
  - Inbox batch entries retain the original workspace parent snapshot and reserve complete per-item source/output/receipt sets without nesting admission.
  - Shared Outbox prepares local copies; fixed no-telegram and disabled Python bytecode writes match its existing module and UI contract.
  - Binary preview parses archives in memory; external open keeps its existing delegated application lifetime and does not claim editor exclusion.
requirements-completed: [PERF-01]
coverage:
  - id: IPC-34
    description: Thirty-four commands complete their actual finite work in awaited blocking workers
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_10
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 10
        status: pass
    human_judgment: false
  - id: INBOX-TRANSACTIONS
    description: Competing decisions preserve settled siblings and original parents through file operations and failures
    verification:
      - kind: integration
        ref: src-tauri/src/inbox.rs#phase08_10_inbox_competing_accept_reject_and_batch_keep_settled_siblings
        status: pass
      - kind: integration
        ref: src-tauri/src/inbox.rs#phase08_10_inbox_all_writers_parent_rename_trash_both_orders_and_aliases
        status: pass
    human_judgment: false
  - id: LOCAL-OUTBOX
    description: Local output and receipt preparation preserve successful siblings without provider sends or bytecode-cache effects
    verification:
      - kind: integration
        ref: src-tauri/src/share_outbox.rs#phase08_10_prepare_writes_fixture_output_receipt_and_retains_sibling_failure
        status: pass
      - kind: integration
        ref: src-tauri/src/share_outbox.rs#phase08_10_share_mutators_vs_real_workspace_parent_rename_trash_orders
        status: pass
    human_judgment: false
  - id: SECRET-FILES
    description: All three secret mutators participate in admission and fail closed on changed parent or alias state
    verification:
      - kind: integration
        ref: src-tauri/src/secrets.rs#phase08_10_secrets_all_mutators_parent_rename_trash_both_orders_and_aliases
        status: pass
    human_judgment: false
duration: 20 min
completed: 2026-09-05
---

# Phase 08 Plan 10: Inbox Processing Isolation Summary

Thirty-four Inbox, classifier, local outbox, binary-viewer and secret-file commands now await blocking workers; complete mutation admission preserves selected parents, settled siblings and current disk results.

## Execution

- Implementation timing: 2026-09-05T07:22:12Z to 2026-09-05T07:42:01Z, approximately 20 minutes; preflight excluded.
- Tasks: 2. Implementation/evidence files: 7.
- Task 10-1: `f21c17a`, isolate Inbox, classifier and local outbox processing.
- Task 10-2: `a1e2506`, isolate binary viewers and secrets, register all owned rows and record exact evidence.
- Both commits ran normal hooks, used explicit owned-file staging and contain no coauthor trailer or tracked-file deletion. Task 10-1 stages only its registration subset, keeping each task commit coherent.
- Sequential checkout execution retained the orchestrator's documented harness isolation degradation. No branch, push, merge, release or external message occurred.

## Accomplishments

- Inbox's fourteen rows include thirteen new same-name `ipc` wrappers and the existing isolated `scan_inbox_processed_snapshot` registration. Classification's two pure format/parse operations also run in workers because their input strings are unbounded. Successful prompt IPC payload remains a string; the original synchronous formatter still returns `String`.
- Seven Inbox mutation commands reserve complete source, destination allocation, configuration and receipt paths before filesystem effects and permission loaders. Accept/reject/apply batches preserve the original selected workspace parent across individual entries. Approval consumption occurs in the blocking worker, completes before per-item admission, and holds no approval guard while waiting. Event publication remains after actual completion.
- Concurrent accept/reject decisions cannot reprocess a moved item. Successful sibling outputs and receipts remain visible after another entry fails. Raw-tree validation rejects symlinks before copying any original, and a failed final item move removes that decision's new copies while leaving its pending manifest and source available for explicit retry.
- All five Shared Outbox commands use blocking workers. Read-config and scan remain read-only; save-root, ensure-root and prepare admit configuration/atomic siblings, source files, outgoing allocation and receipt paths, including existing nested output aliases. Dynamic configuration/coverage is checked again after admission. The process and its local side effects remain inside the lease.
- Shared Outbox passes `--no-telegram`, runs from the selected workspace and sets `PYTHONDONTWRITEBYTECODE=1` after inherited/run environment values. The existing module promises staged copies, and its UI options contain no explicit send action. The bundled script supports the flag. Separate provider/send paths remain unchanged.
- All seven binary-viewer rows isolate byte reads, format detection, ZIP/HWPX parsing, asset-scope admission and native launch. HWPX extraction produces an in-memory preview, not an extracted directory. ZIP path traversal is rejected. External application lifetime remains delegated after launch; this plan does not claim to serialize an editor's later writes.
- All six secret-file rows preserve their synchronous APIs. Migration/write/delete reserve the original workspace, managed/legacy roots, candidates, output and private-atomic siblings. Refreshed migration paths must remain covered before effects. Permission normalization, compatibility symlinks and all local effects stay under admission. These are file-based `.maru/secrets` and `.secrets` operations; no keychain access was added.

## Owned Inputs and Compatibility

All wire names remain unchanged. Registration is `module::ipc::command`, except the already-async `inbox::scan_inbox_processed_snapshot`. Existing `Result<T, String>` payload/error contracts stay intact. Worker failures use display-only `<command>_task_failed` context; typed document errors remain `IpcError` through production and test channels. ERR-06 has no exemption.

| Module/commands | Owned worker inputs |
| --- | --- |
| Inbox scan-drop | `vault_path: String`, `scan_options: Option<ScanOptions>` |
| Inbox scan-entries | `work_path: String`, `scan_options: Option<ScanOptions>`, `intake_mode: Option<String>` |
| Inbox processed list/snapshot | `work_path: String`, `channel: Option<String>`, `statuses: Option<Vec<String>>`, `query: Option<String>`, `limit: Option<usize>` |
| Inbox detail; source runs/counts | Detail uses two `String`s (`work_path`, `item_dir`); runs/counts use `work_path: String` |
| Inbox trash | `AppHandle<R>`, `work_path: String`, `Vec<InboxTrashTarget>`, `approval_id: Option<String>` |
| Inbox stage | `AppHandle<R>`, `work_path: String`, `channel/drop_path: Option<String>`, `source_paths: Vec<String>` |
| Inbox accept one/batch | `AppHandle<R>`, `vault_path: String`, `id: String` and `target_folder: Option<String>`, or `Vec<InboxAcceptRequest>`; `approval_id: Option<String>` |
| Inbox reject one/batch | `AppHandle<R>`, `vault_path: String`, `id: String` or `ids: Vec<String>`, `approval_id: Option<String>` |
| Inbox apply | `AppHandle<R>`, `work_path: String`, `Vec<InboxApplyDecision>`, `approval_id: Option<String>` |
| Classifier | `InboxDropItem` for prompt; `raw: String` for parser |
| Share read/ensure/scan; save; prepare | `work_path: String`; save adds `root: String`; prepare adds `Vec<ShareOutboxSource>` and `ShareOutboxApplyOptions` |
| Binary viewers | `vault_path/target_path: String`; text adds `max_bytes: Option<u64>`; asset preparation adds `AppHandle<R>` |
| Secrets scan/doctor; migration; text | `work_path: String`; migration adds `dry_run: Option<bool>` and `selected: Option<Vec<String>>`; text read/delete add `rel_path: String`; write adds `contents: String` |

App-bearing Inbox and asset functions are generic over the existing Tauri runtime, preserving concrete app callers. Approval IPC wrappers own `AppHandle<R>` and retrieve live `ApprovalState` inside the worker before calling the unchanged State-taking synchronous entry. No State representation change, fabricated State, borrowed guard across await, block_on or generic dispatcher was introduced.

`workspace_files::copy_source` and `move_source` remain unchanged synchronous byte/tree primitives. Inbox's admitted command-owned helpers borrow `PathTransactionLease`; nested copy/move/receipt helpers verify coverage without extending or reacquiring admission. Other admitted consumers therefore retain their existing lock order.

## Executed Verification

| Check | Actual result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_10` | 40 passed, 0 failed/ignored, 5.39 seconds after compilation. Inbox 10, classifier 6, binary 5, secrets 10, share 9, including two inert child-entry tests. |
| Focused final local preparation test | 1 passed after setting/asserting final `PYTHONDONTWRITEBYTECODE=1`; source bytes, local output, receipt, sibling failure and replace retry all verified. |
| Existing Inbox/classifier/Share/Binary/Secrets selectors | 50 / 11 / 11 / 14 / 8 passed. Legacy Share selection explicitly excluded `phase08_10`. |
| Existing `workspace_files::tests` | 18 passed; consumed copy/move primitives and batch behavior unchanged. |
| `ipc_error::tests` | 4 passed, including recursive ERR-06 guard. |
| `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | Passed. |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Passed. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | Passed after two doc-list continuations and one needless borrow were corrected. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed. |
| `node scripts/check-command-isolation.mjs --plan 10` | Passed: exactly 34 final rows, 365 production registrations, 0 native-only commands; no final AUDIT. |
| `git diff --check` and task-commit deletion checks | Passed. |

Every actual wrapper has a same-polling-task yield test while its distinct blocking worker is held, plus contextual JoinError coverage and meaningful domain outcomes. Mutation cases cover same-target contention, failure/unwind release, actual parent rename/trash commands in both orders and supported aliases. Inbox also covers live policy changes, restrictive duplicate registry entries and typed document-save conflicts.

All runtime fixtures used disposable filesystem roots; mutating or registry-reading tests used the shared `Home` lock plus both test-home/config overrides. Native launch and preparation selected the existing current test executable before invocation. Each Trash call had an exact source-to-temporary-destination fixture. Synthetic secrets contained only dummy values. No installed opener, provider, real system Trash, live credentials or actual send was invoked.

## Deviations and Issues

1. **[Rule 2 - Missing critical] Local preparation effect set.** The bundled script could send Telegram from a configuration flag despite the module/UI staging contract, resolve relative roots from its script directory and create Python bytecode caches outside output admission. Fixed explicit no-send argv, workspace cwd and final bytecode suppression. Monthly/receipt fragments and nested output aliases are validated/reserved. The focused process fixture proves final argv/env/cwd and real local bytes. This is a contract correction, not removal of a user-requested send operation.
2. **[Rule 2 - Missing critical] Inbox partial-copy failure handling.** Prevalidated all raw descendants before copies and retained new-copy ownership until the final item move. A failed move removes only that decision's new copies; successful siblings and pending source bytes survive. The explicit failure/retry fixture proves the result.
3. **[Rule 3 - Blocking] Fixture and lint corrections.** Initial unexecuted child drafts needed scoped Trash fixtures, owned callback captures and uniform receiver outputs. Runtime expectations were corrected for Inbox's actual `dropFile` kind, macOS canonical temporary paths and earlier lease-coverage rejection of stale secret aliases. Clippy required a doc paragraph boundary exposed by command-attribute removal and one borrowed-reference correction. No guard exception or production permission bypass was added.

The added small path/process helper symbols are confined to owned modules and implement the required admission/fixture contracts. No dependency, job service, automatic retry or unrelated cleanup was introduced. Existing today_ai/scheduler test-build warnings remain unrelated; production clippy is clean.

## Handoff and Limits

- This completes Plan10 only. `requirements-completed: [PERF-01]` records its contribution; shared PERF-01/PERF-02 remain open until all sibling and native gates finish.
- Evidence annotates current frontend callers: App Inbox handlers and carry/events, aiInvoke classifier lifecycle, SharedOutboxPane results, BinaryViewer/Files preview request ownership, and SecretsTab completion. Plans25/26 still own common navigation-safe completion, stale-refresh suppression and single terminal notices. No final D-04 claim is made here.
- Tests ran on macOS. Windows/native saturation and final production artifact isolation remain Plans27/28. Detached external editors are not covered after launch.
- Ready for Plan11, wave12. The earlier Plan09 Today capture borrowed-lease obligation remains for Plan11. No shared producer primitive or earlier evidence shard was changed.
- Unrelated dirty Phase07 RESEARCH/VALIDATION and untracked `.claude/`, milestone lock/state and Phase07 PATTERNS were preserved.

## Self-Check: PASSED

Both task commits exist, all seven implementation/evidence files exist, exact command ownership is 14 + 2 + 5 + 7 + 6 = 34, and required executed gates pass. This SUMMARY is committed before state advancement.
