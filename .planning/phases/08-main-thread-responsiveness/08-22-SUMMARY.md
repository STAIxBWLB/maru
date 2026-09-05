---
phase: 08-main-thread-responsiveness
plan: "22"
subsystem: workspace-configuration
tags: [rust, tauri, spawn-blocking, concurrency, path-transactions, workspace-config, vault-list, maru-dir]
requires:
  - phase: 08-21
    provides: Current isolated registration set and same-name pub mod ipc wrapper precedent with worker-stage test hooks
provides:
  - Thirty isolated workspace-configuration commands (21 maru_dir, 5 vault_list, 4 workspace) with preserved synchronous exports
  - Shared path-transaction admission for eleven maru_dir mutations, the five vault_list registry writers and register_workspace_roots
  - Fifteen behavioral tests and exact thirty-row evidence
affects: [08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 60000
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, same-name pub mod ipc wrappers, owned String/struct/JSON inputs, with_path_transactions admission with require_parent workspace snapshots and workspace-registry preconditions, shared maru_mutation_admission helper covering .maru plus .maruignore, registry_mutation_admission covering registry plus legacy vault list, pub(crate) in-transaction adapters for cross-module nested writers, MARU_TEST_HOME-redirectable global settings store]
key-files:
  created: [docs/performance/phase08-22.json]
  modified: [src-tauri/src/maru_dir.rs, src-tauri/src/vault_list.rs, src-tauri/src/workspace.rs, src-tauri/src/lib.rs]
key-decisions:
  - All 30 owned rows are final-disposition ISOLATED; the two CONVERT rows (list_maru_rules, list_maru_templates) and the 28 AUDIT rows now run behind a same-name async pub mod ipc wrapper awaiting spawn_blocking over the unchanged synchronous function, and lib.rs registers only the ipc paths so the canonical registration becomes src-tauri/src/lib.rs::<module>::ipc::<command>.
  - The nine explicit maru_dir mutations (update_maru_workspace, bootstrap_maru_dir, save_maru_rule, delete_maru_rule, save_maru_template, delete_maru_template, save_maru_mcp, save_maru_projects, save_maru_settings) admit [work/.maru, work/.maruignore] through the new maru_mutation_admission helper (require_parent(work) plus the workspace-registry precondition); save_maru_ignore admits only work/.maruignore with an inline PathTransactionRequest; save_maru_settings adds the global settings.json path (global_settings_json_path) as an extra admitted path.
  - read_maru_settings also admits the same set as the save because its one-shot legacy migration can create the global and workspace-state settings files; a new both-orders test proves the read serializes with the settings save. list_workspaces is recorded as a mutation row for the same reason via its delegated list_workspace_roots admission.
  - vault_list serializes every registry read-modify-write (including list_workspace_roots, whose load may migrate the legacy vault list) through registry_mutation_admission over [registry output, legacy path]; register_workspace_roots runs detect_at before admission, admits [private/.maru, private/.maruignore, registry output, legacy path] with require_parent(private), and consumes the lease through the pub(crate) vault_list in-transaction adapters so nested upserts never re-acquire (which would self-deadlock).
  - maru_dir::maru_home_dir now honors MARU_TEST_HOME under cfg(test), keeping the single require_absolute exit and the T-06-03 native-e2e guard, so the settings commands are hermetic in tests.
  - The checker's INTEGRATIONS map assigns none of the three owned modules a later-plan handoff, so the shard records moduleIntegrationOwner "08-22" and no moduleIntegrations entries; --plan 22 exits 0.
requirements-completed: [PERF-01]
coverage:
  - id: WORKSPACE-CONFIG-ISOLATION
    description: All 30 actual IPC futures preserve meaningful synthetic results and legacy rejections while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_22
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 22
        status: pass
    human_judgment: false
  - id: WORKSPACE-CONFIG-MUTATION-LIFETIME
    description: Shared admission covers the maru_dir mutations, the vault_list registry writers and register_workspace_roots with original parents; same-target contention in both orders, cross-domain disjoint-progress, error/unwind release and not-registered rejections without effects pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_22
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 22: Workspace Configuration Command Isolation Summary

All 30 workspace-configuration commands (21 in `maru_dir.rs`, 5 in `vault_list.rs`, 4 in `workspace.rs`) now run their blocking work (config JSON parses, bounded managed-directory listings, registry read-modify-writes, skeleton bootstraps, atomic publishes) in awaited `spawn_blocking` workers. Wire names, payload types, error strings, the legacy migration semantics and the write-policy behavior are unchanged.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` work which was not touched.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_22 | Passed: 15 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1723 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed (after one cargo fmt pass) |
| node scripts/check-command-isolation.mjs --plan 22 | Passed: exact 30 rows, 365 production registrations, 0 native-only commands |

The 15 tests comprise: a same-poll yield + JoinError boundary case driving all 30 real async wrappers (work-path-keyed worker-stage hooks for maru_dir and workspace, registry-path-keyed for vault_list and list_workspaces), a nonempty real-fixture result plus unchanged typed/legacy rejection case for every command (workspace detect/read-config/register/list against real workspace.config.yaml fixtures, vault_list add/refresh/set-active/remove against a real registry fixture including the not-registered rejections, maru_dir reads and mutations against real .maru skeleton fixtures), deterministic both-orders serialization fixtures (save_maru_rule same-target, update-vs-save meta/settings, settings read-vs-save, vault_list registry upserts, register_workspace_roots against a concurrent add on a disjoint root), a cross-domain case proving a registry writer progresses while a .maru writer stays blocked, and error-release/retry-recovers cases for maru_dir, vault_list and register_workspace_roots proving an error releases admission with no partial effect.

## Corrections and Evidence History

1. `phase08_22_workspace_meta_and_settings_serialize_both_orders` originally asserted both writers' markers survived; the two commands write different files (workspace.json owner_name vs the global settings themeMode), so the assertions now derive the per-arm markers from the launch order and both effects are checked independently; the 30 ms not-complete assertion remains the actual serialization proof.
2. The vault_list real-fixture refresh rejection now uses a separate unknown-root path instead of re-adding then refreshing the same path, so the Workspace is not registered rejection is exercised on a genuinely unregistered root.
3. `read_maru_settings` was found to perform a one-shot legacy migration write (creating the global and workspace-state settings files when the legacy file exists and the targets are missing); it now admits the same set as `save_maru_settings` through `maru_mutation_admission`, and the new `phase08_22_settings_read_serializes_with_save_both_orders` proves the read serializes with the save in either launch order. `list_workspaces` is recorded as a mutation row for the same reason via its delegated `list_workspace_roots` admission.
4. `registry_mutation_admission` carried a clippy needless_question_mark (an `Ok(expr?)` wrapper); fixed to pass `cargo clippy --lib -- -D warnings` with no semantic change.
5. `cargo fmt` reflowed the new wrappers and fixtures in all three modules; the focused phase08_22 tests were re-run green after formatting, and the full suite ran after the clippy fix.

## Frontend Handoff and Limits

- `src/lib/maruDir.ts` (all 21 maru_dir commands plus detect_workspace, read_workspace_config, register_workspace_roots, list_workspaces) and `src/lib/api.ts` (the five vault_list registry commands) keep existing invocation, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. D-04 completion ownership, stale-view protection and navigation-safe terminal notices remain Plans25/26; each row's `processingCaller` annotates the call sites and current completion ownership.
- Owned argument types (unchanged on the wire): `read_maru_workspace(work_path)`, `update_maru_workspace(work_path, patch: MaruWorkspaceMetaPatch)`, `bootstrap_maru_dir(work_path)`, `read_maru_ignore(work_path)`, `save_maru_ignore(work_path, patterns: Vec<String>)`, `list_maru_rules(work_path)`, `read_maru_rule(work_path, name)`, `save_maru_rule(work_path, name, content)`, `delete_maru_rule(work_path, name)`, `list_maru_templates(work_path)`, `read_maru_template(work_path, name)`, `save_maru_template(work_path, name, content)`, `delete_maru_template(work_path, name)`, `read_maru_mcp(work_path)`, `save_maru_mcp(work_path, value: JsonValue)`, `read_maru_projects(work_path)`, `list_workspace_projects(work_path, include_inactive: Option<bool>)`, `save_maru_projects(work_path, value: JsonValue)`, `read_maru_skills(work_path)`, `read_maru_settings(work_path)`, `save_maru_settings(work_path, value: JsonValue, base_value: Option<JsonValue>)`; `list_workspace_roots()`, `add_workspace_root(entry: WorkspaceRootEntry)`, `refresh_workspace_capabilities(path)`, `remove_workspace_root(path)`, `set_active_workspace_root(path, visibility)`; `detect_workspace(path)`, `read_workspace_config(work_path)`, `register_workspace_roots(work_path)`, `list_workspaces()`. No command accepts `State` or another borrowed runtime object.
- New Rust helpers are limited to the admission helpers (`maru_mutation_admission`, `registry_mutation_admission`), the `<command>_in_transaction` adapters (`update_maru_workspace_in_transaction`, `save_maru_ignore_in_transaction`, `save_maru_settings_in_transaction`, `upsert_workspace_root_in_transaction` and `set_active_workspace_root_in_transaction` as pub(crate) for the cross-module register flow, `refresh_workspace_capabilities_in_transaction`, `remove_workspace_root_in_transaction`, `register_workspace_roots_in_transaction`) and the cfg(test) MARU_TEST_HOME branch in `maru_home_dir`.
- Mutation admission keys: [work/.maru, work/.maruignore, pinned work parent] for the nine maru_dir mutations (plus the global settings store for save/read settings), [work/.maruignore, pinned work parent] for save_maru_ignore, [registry output, legacy vault list] for the five vault_list writers, and [private/.maru, private/.maruignore, registry output, legacy vault list, pinned private parent] for register_workspace_roots. Every mutation entry carries the workspace-registry precondition and runs validation inside the transaction.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced; the idempotent never-overwrite bootstrap semantics, the legacy settings/vault-list migrations and the leaf-name containment rejections are intact.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan22's contribution.

## Threats and Self-Check

- T-08-22-01: every mutation admits its complete write set with pinned parents and the registry precondition before any effect, per-path ensure_covered re-checks fail closed on drift, and the both-orders/not-registered fixtures prove no lost update, no permission bypass and no effect on a rejected write.
- T-08-22-02: awaited finite blocking closures, same-runtime yield proof on all 30 wrappers, precomputed admitted sets, RAII release on success/error/unwind, pub(crate) in-transaction adapters instead of nested re-acquisition, and no guard across an await mitigate new async-pool stalls and deadlocks.
- T-08-22-03: Home-isolated fixtures, disposable tempdir workspaces, synthetic config/registry fixtures and the test-only worker-stage hooks constrain the proof; no live workspace, credential, network endpoint or native test hook is claimed.

## Self-Check: PASSED

All 30 owned rows are final in docs/performance/phase08-22.json with zero AUDIT, and all required checks pass (phase tests 15/15, full suite 1723/0/3, maru-cli check, clippy, fmt, checker --plan 22). Changes remain uncommitted per the session contract.
