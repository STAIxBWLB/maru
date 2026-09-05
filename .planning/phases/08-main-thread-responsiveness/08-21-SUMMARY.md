---
phase: 08-main-thread-responsiveness
plan: "21"
subsystem: export-and-templates
tags: [rust, tauri, spawn-blocking, concurrency, path-transactions, export, hwp, hwpx, templates]
requires:
  - phase: 08-20
    provides: Current isolated registration set and same-name pub mod ipc wrapper precedent with state-keyed worker-stage hooks
provides:
  - Fourteen isolated export, hwped, hwp-cli-template and template-fill commands with preserved synchronous exports
  - Shared path-transaction admission for export plan/dispatch and both template-fill mutations
  - Sixteen behavioral tests and exact fourteen-row evidence
affects: [08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 60000
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, same-name pub mod ipc wrappers, owned String/struct inputs, with_path_transactions admission with require_parent workspace snapshots and workspace-registry preconditions, precomputed admitted write sets mirroring planner destination resolution, plan-vs-dispatch cross-command manifest contention fixtures, shared env-lock for hwp/hwpx binary overrides]
key-files:
  created: [docs/performance/phase08-21.json]
  modified: [src-tauri/src/export/dispatch.rs, src-tauri/src/export/mod.rs, src-tauri/src/hwped.rs, src-tauri/src/hwp_cli_template.rs, src-tauri/src/template_fill.rs, src-tauri/src/lib.rs]
key-decisions:
  - All 14 owned rows are final-disposition ISOLATED; the five CONVERT rows and the three AUDIT rows now run behind a same-name async pub mod ipc wrapper awaiting spawn_blocking over the unchanged synchronous function, while the six already-isolated hwped entries keep their existing top-level async spawn_blocking registrations with only test hooks added.
  - export_dispatch precomputes its admitted set in DispatchPlan::load (manifest.yaml plus every selected output path, absolute-lexical) before entering with_path_transactions, and export_plan mirrors plan_bundle's destination resolution in a local plan_bundle_paths helper so the complete write set (bundle dir + manifest.yaml) is admitted before any effect; both pin the workspace-root parent (require_parent) and attach the workspace-registry precondition, and drift between mirror and real planner fails closed through the per-path lease.ensure_covered re-check.
  - hwp_cli_template_fill and template_fill_hwpx admit [output, parent] plus the vault-root parent; the parent covers the .maru-hwp-cli-* / hwpx stage dirs, assert_maru_can_write and PathTransactionLease::before_effect run inside the transaction, and fill_with_bin re-resolves and re-covers the output immediately before the atomic publish.
  - hwped commands write only into tempdir staging (or the caller-supplied output directory defaulting to a tempdir), so their mutation keys are recorded readOnly with tempdir-staging evidence; their JoinError mapping keeps the shared hwped_task_failed prefix, asserted by a local boundary_hwped helper because the stock boundary helper expects a per-command prefix.
  - MARU_HWP_BIN / MARU_HWPX_BIN fixture overrides across the three test modules are serialized by one shared PHASE08_21_ENV_LOCK mutex with poison-tolerant locking, so parallel tests never observe each other's fake binaries.
  - The checker's INTEGRATIONS map assigns none of the five owned modules a later-plan handoff, so the shard records moduleIntegrationOwner "08-21" and no moduleIntegrations entries; --plan 21 exits 0.
requirements-completed: [PERF-01]
coverage:
  - id: EXPORT-TEMPLATES-ISOLATION
    description: All 14 actual IPC futures preserve meaningful synthetic results and legacy rejections while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_21
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 21
        status: pass
    human_judgment: false
  - id: EXPORT-TEMPLATES-MUTATION-LIFETIME
    description: Shared admission covers export plan/dispatch and both template fills with original parents; plan-vs-dispatch and same-target contention in both orders, error/unwind release and policy denial without effects pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_21
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 21: Export and Templates Command Isolation Summary

All 14 export, hwped, hwp-cli-template and template-fill commands now run their blocking work (manifest planning and re-validation, converter process spawns, bounded template scans, hwp/hwpx process probes, atomic publishes) in awaited `spawn_blocking` workers. Wire names, payload types, error strings, exported byte identity, filled-document bytes and the write-policy behavior are unchanged.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` work which was not touched.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_21 | Passed: 16 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1708 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 21 | Passed: exact 14 rows, 365 production registrations, 0 native-only commands |

The 16 tests comprise: a same-poll yield + JoinError boundary case driving all 14 real async wrappers (workspace-root/manifest-path/tempdir-keyed worker-stage hooks; hwped asserted with the shared `hwped_task_failed:` prefix via the local `boundary_hwped` helper), a nonempty real-fixture result plus unchanged typed/legacy rejection case for every command (export plan/validate against a real planned manifest, export dispatch through the real converter chain, all six hwped wrappers against a fake hwp 0.9.0 binary, hwp_cli_template fields/fill, template get_fields/prepare/fill against a real hwpx zip fixture with kordoc_lite substitution), a deterministic plan-vs-dispatch manifest serialization fixture in both launch orders proving the last admitted writer wins the manifest, same-target both-orders serialization fixtures for hwp_cli_template_fill and template_fill_hwpx proving the second admitted writer owns the final published bytes (verified inside the rewritten zip's Contents/section0.xml), and policy-denial/error-release fixtures for export_plan, hwp_cli_template_fill and template_fill_hwpx proving a read-only registry denial and a filesystem error both release admission with no partial effects and a retry after the error succeeds.

## Corrections and Evidence History

1. `template_fill` phase08_21 assertions originally expected the fake hwpx fill to publish the values JSON bytes; the fake now copies the real template zip so kordoc_lite rewrites a valid hwpx, and the assertions unzip `Contents/section0.xml` and check the marker value substitution instead.
2. The template real-fixture `.docx` legacy rejection only fires for an existing file (missing files fail earlier in `resolve_template_path` with "Template file does not exist"), so the fixture now writes the docx before asserting the requires-a-.hwpx-template error.
3. `export_dispatch` carried a clippy needless_borrow on the `record_output_success` call; fixed to pass `cargo clippy --lib -- -D warnings` with no semantic change.
4. A `PoisonError` cascade from env-override guards is neutralized by `unwrap_or_else(|p| p.into_inner())` locking on the shared `PHASE08_21_ENV_LOCK`.
5. `cargo fmt` reflowed the new code in all five modules; the focused tests were re-run green after formatting. The first post-fmt focused run showed one transient failure that passed on three subsequent runs and in the final full suite, which ran after the clippy fix: 1708 passed, 0 failed, 3 ignored.
6. The checker's INTEGRATIONS map assigns none of the five owned modules a later-plan handoff, so the shard records `moduleIntegrationOwner: "08-21"` and no moduleIntegrations entries; `--plan 21` exits 0.

## Frontend Handoff and Limits

- `src/lib/export.ts` (export_plan/export_validate/export_dispatch), `src/lib/hwped.ts` (all six hwped commands) and `src/lib/studio.ts` plus `src/components/studio/StudioMode.tsx` (template_get_fields/template_prepare_hwpx_template/template_fill_hwpx/hwp_cli_template_fields/hwp_cli_template_fill) keep existing invocation, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. D-04 completion ownership, stale-view protection and navigation-safe terminal notices remain Plans25/26; each row's `processingCaller` annotates the call sites and current completion ownership.
- Owned argument types (unchanged on the wire): `export_plan(req: ExportPlanRequest)`, `export_validate(manifest_path: String)`, `export_dispatch(req: ExportDispatchRequest)`; `hwped_read(document, workspace_root)`, `hwped_render(document, options, workspace_root)`, `hwped_edit(document, ops_argv, verify, allow_partial, workspace_root)`, `hwped_compose(spec, name)`, `hwped_validate(document, workspace_root)`, `hwped_capabilities()`; `hwp_cli_template_fields(request)`, `hwp_cli_template_fill(work_path, request)`; `template_get_fields(work_path, request)`, `template_prepare_hwpx_template(work_path, source_path)`, `template_fill_hwpx(work_path, request)`. New Rust helpers are limited to the `<command>_in_transaction` adapters and the `fill_impl`/`plan_bundle_paths`/`DispatchPlan` admission mirrors; no command accepts `State` or another borrowed runtime object.
- Mutation admission keys: export bundle dir + manifest.yaml + pinned workspace-root parent (export_plan), manifest + every selected output + pinned workspace-root parent (export_dispatch), resolved .hwpx output + parent dir + vault-root parent (hwp_cli_template_fill, template_fill_hwpx). All four mutation entries carry the workspace-registry precondition and run policy checks inside the transaction.
- Error precedence in hwp_cli_template_fill now puts values/alias/extension rejections before cli_missing, matching the wire behavior that values/alias/extension are request-validation errors; documented in the row contract.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced; export source-changed re-plan semantics, Studio write-policy checks and hwp/hwpx released-version gates are intact.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan21's contribution.

## Threats and Self-Check

- T-08-21-01: the complete write set is admitted before effects with pinned root-parent and alias snapshots, policy checks re-run inside the transaction, and the both-orders/denial fixtures prove no lost update, no permission bypass and no effect on a denied write.
- T-08-21-02: awaited finite blocking closures, same-runtime yield proof on all 14 wrappers, precomputed admitted sets, RAII release on success/error/unwind, and no guard across an await mitigate new async-pool stalls and deadlocks.
- T-08-21-03: Home-isolated fixtures, synthetic fake hwp/hwpx binaries, disposable tempdir workspaces and the test-only worker-stage hooks constrain the proof; no live workspace, credential, network endpoint or native test hook is claimed.

## Self-Check: PASSED

All 14 owned rows are final in docs/performance/phase08-21.json with zero AUDIT, and all required checks pass (phase tests 16/16, full suite 1708/0/3, maru-cli check, clippy, fmt, checker --plan 21). Changes remain uncommitted per the session contract.
