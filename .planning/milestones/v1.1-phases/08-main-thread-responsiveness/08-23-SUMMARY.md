---
phase: 08-main-thread-responsiveness
plan: "23"
subsystem: settings-and-native-flows
tags: [rust, tauri, spawn-blocking, concurrency, path-transactions, inbox-settings, telegram-config, sites, e2e-flow]
requires:
  - phase: 08-22
    provides: Same-name pub mod ipc wrapper precedent, shared path-transaction admission helpers and worker-stage/transaction-stage test hooks
provides:
  - Eleven isolated settings-and-native-flows commands (4 inbox_settings, 2 telegram_config, 3 sites, 2 e2e_flow) with preserved synchronous exports
  - Shared path-transaction admission for the six owned mutations (inbox runtime config, inbox settings, telegram monitor config, sites registry read-seed and save, e2e artifact tree)
  - Seventeen behavioral tests and exact eleven-row evidence
affects: [08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 60000
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, same-name pub mod ipc wrappers, owned String/struct/JSON inputs, with_path_transactions admission with require_parent snapshots, read-seed mutation classification for read_sites, post-lease event emits, AppHandle-generic sync save entry points, incrementally extended candidate transaction-stage hooks for internally generated run ids, widened Held test-helper timeouts]
key-files:
  created: [docs/performance/phase08-23.json]
  modified: [src-tauri/src/inbox_settings.rs, src-tauri/src/telegram_config.rs, src-tauri/src/sites.rs, src-tauri/src/e2e_flow.rs, src-tauri/src/atomic_file.rs, src-tauri/src/lib.rs]
key-decisions:
  - All 11 owned rows are final-disposition ISOLATED; the two CONVERT rows (scan_work_sites, maru_e2e_run) and the nine AUDIT rows now run behind a same-name async pub mod ipc wrapper awaiting spawn_blocking over the unchanged synchronous function, and lib.rs registers only the ipc paths so the canonical registration becomes src-tauri/src/lib.rs::<module>::ipc::<command>.
  - save_inbox_runtime_config admits [work/workspace.config.yaml] with require_parent(work) through inbox_runtime_config_admission; save_inbox_settings admits [vault/.maru] with require_parent(vault) through inbox_settings_admission; both validate and rewrite inside the lease and emit their inbox:// runtime_config_updated events only after the lease drops.
  - save_telegram_monitor_config resolves the effective monitor config path first (explicit monitor_config_path wins over the work default), admits exactly that file through telegram_monitor_admission, and runs ensure_secret_config_path authorization, the block-scoped YAML rewrite and set_secret_file_mode inside the lease; the telegram://monitor_config_updated emit stays outside the lease.
  - read_sites is recorded as a mutation row, not a readOnly row, because first use seeds the versioned default envelope; it shares sites_registry_admission (~/.maru/sites.json) with save_sites, and the both-orders test proves read serializes with save in either launch order.
  - maru_e2e_run admits only [work/.maru/e2e-runs] through e2e_run_admission and runs every artifact effect (storage dir creation, report/slide/event/template writes, final metadata write) inside the lease; the nested skills/template/event writers keep their own admission and intentionally stay outside this lease, and the store-layer source_busy guard remains the concurrent-run gate.
  - The phase08_06 Held test helper timeouts were widened from 5s to 15s (callback and wait) because the e2e run's deterministic preamble takes about five seconds; this only delays detection of a genuinely hung transaction and does not change any production behavior.
  - The checker's INTEGRATIONS map assigns none of the four owned modules a later-plan handoff, so the shard records moduleIntegrationOwner "08-23" and no moduleIntegrations entries; --plan 23 exits 0.
requirements-completed: [PERF-01]
coverage:
  - id: SETTINGS-NATIVE-ISOLATION
    description: All 11 actual IPC futures preserve meaningful synthetic results and typed rejections while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_23
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 23
        status: pass
    human_judgment: false
  - id: SETTINGS-NATIVE-MUTATION-LIFETIME
    description: Shared admission covers the six owned mutations with pinned parents; same-target contention in both orders, cross-domain disjoint-progress, error/unwind release and readOnly positive-no-mutation evidence pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_23
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 23: Settings and Native Flows Command Isolation Summary

All 11 settings-and-native-flows commands (4 in `inbox_settings.rs`, 2 in `telegram_config.rs`, 3 in `sites.rs`, 2 in `e2e_flow.rs`) now run their blocking work (config YAML/JSON parses, settings rewrites, monitor config block rewrites, bounded site scans, deterministic E2E artifact writes) in awaited `spawn_blocking` workers. Wire names, payload types, error strings, the redaction behavior, the seed-on-absence semantics and the source_busy concurrent-run gate are unchanged.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` work which was not touched.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_23 | Passed: 17 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1740 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed (after four needless-Ok fixes) |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed (after one cargo fmt pass) |
| node scripts/check-command-isolation.mjs --plan 23 | Passed: exact 11 rows, 365 production registrations, 0 native-only commands |

The 17 tests comprise: a same-poll yield + JoinError boundary case driving all 11 real async wrappers, a nonempty real-fixture result plus unchanged typed/legacy rejection case per module (inbox runtime config + settings against real workspace.config.yaml/.maru fixtures, telegram monitor config against a real secret-mode YAML fixture, sites read/save/scan against a real registry fixture and scan-root fixture, e2e run/read against a real workspace artifact tree), deterministic both-orders serialization fixtures (save_inbox_settings same-target, telegram save same-target, sites registry read-vs-save, e2e run vs the save_maru_template writer), a cross-domain case proving the workspace.config.yaml write progresses while the vault/.maru settings write stays blocked, and error-release/retry-recovers cases for inbox, telegram, sites and the e2e run proving an error releases admission with no partial effect.

## Corrections and Evidence History

1. `phase08_23_e2e_run_serializes_with_template_writer_both_orders` needed three design corrections. First, the template-first arm's waiting hook was keyed to `work/.maru`, but the run's artifact admission covers `work/.maru/e2e-runs` and `test_stage` matches exact admitted paths, so the hook never fired. Second, keying the waiting hook to the e2e-runs path also failed, because while the template writer holds the `.maru` lease the run blocks even earlier, at its first `.maru`-area acquisition: the run-event store at `.maru/runs/skills/maru-e2e-<millis>/events.jsonl`, whose run id is generated inside the command once its blocking task is scheduled. Third, the fix registers `before-admission` hooks for a candidate run-id window that extends incrementally until one fires, then proves the run cannot complete while the template lease is held; the run-first arm is unchanged (template writer's `.maru` admission waits behind the run's e2e-runs lease).
2. The shared `phase08_06::Held` helper timeouts were widened from 5s to 15s (callback `recv_timeout` and `wait`): the e2e run's deterministic preamble takes about five seconds, so a five-second held lease expired before the run reached its event-store admission. Passing tests are unaffected; only genuine-hang detection is delayed.
3. The four new admission helpers (`inbox_runtime_config_admission`, `inbox_settings_admission`, `sites_registry_admission`, `telegram_monitor_admission`) carried clippy `needless_question_mark` (`Ok(expr?)` wrappers); each was flattened to pass `cargo clippy --lib -- -D warnings` with no semantic change.
4. `cargo fmt` reflowed the new wrappers, admission helpers and fixtures; the focused phase08_23 tests were re-run green (17/17, three consecutive runs of the e2e both-orders test) after formatting and the clippy fixes, and the full suite ran last.

## Frontend Handoff and Limits

- `src/lib/api.ts` (`readInboxRuntimeConfig`, `saveInboxRuntimeConfig`, `readInboxSettings`, `saveInboxSettings`, `readTelegramMonitorConfig`, `saveTelegramMonitorConfig`), `src/lib/maruDir.ts` (`readSites`, `saveSites`, `scanWorkSites`) and `src/lib/e2eFlow.ts` (`runE2EFlow`, `readE2EFlow`) keep existing invocation, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. D-04 completion ownership, stale-view protection and navigation-safe terminal notices remain Plans25/26; each row's `processingCaller` annotates the call sites and current completion ownership.
- Owned argument types (unchanged on the wire): `read_inbox_runtime_config(work_path)`, `save_inbox_runtime_config(work_path, config)`, `read_inbox_settings(vault_path)`, `save_inbox_settings(vault_path, settings)`, `read_telegram_monitor_config(work_path?, monitor_config_path?)`, `save_telegram_monitor_config(work_path?, monitor_config_path?, config)`, `read_sites()`, `save_sites(value)`, `scan_work_sites(dir)`, `maru_e2e_run(work_path, baseline_average_ms?)`, `maru_e2e_read(work_path, run_id)`. The two save commands that emit take `AppHandle<R: tauri::Runtime>` internally; no command accepts `State` or another borrowed runtime object.
- New Rust helpers are limited to the five admission helpers (`inbox_runtime_config_admission`, `inbox_settings_admission`, `telegram_monitor_admission`, `sites_registry_admission`, `e2e_run_admission`), the cfg(test) worker-stage key helpers in each `ipc` module, and the Held timeout widening in `atomic_file.rs` (test-only).
- Mutation admission keys: [work/workspace.config.yaml, pinned work parent] for save_inbox_runtime_config, [vault/.maru, pinned vault parent] for save_inbox_settings, [resolved monitor config path] for save_telegram_monitor_config, [~/.maru/sites.json] for read_sites (seed) and save_sites, and [work/.maru/e2e-runs] for maru_e2e_run. Every mutation entry revalidates via `lease.before_effect()` before its first effect and runs validation inside the transaction.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced; the idempotent never-overwrite skeleton semantics, the telegram redaction behavior, the sites seed-on-absence envelope and the store-layer source_busy concurrent-run failure are intact.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan23's contribution.

## Threats and Self-Check

- T-08-23-01: every mutation admits its complete write set with pinned parents before any effect, per-path `ensure_covered` re-checks fail closed on drift, and the both-orders fixtures prove no lost update, no permission bypass and no effect on a rejected write.
- T-08-23-02: awaited finite blocking closures, same-runtime yield proof on all 11 wrappers, RAII release on success/error/unwind, event emits moved outside the lease, and no guard across an await mitigate new async-pool stalls and deadlocks; the Held timeout widening is test-only.
- T-08-23-03: Home-isolated fixtures, disposable tempdir workspaces/vaults, synthetic config/registry fixtures and the test-only worker/transaction-stage hooks constrain the proof; no live workspace, credential, network endpoint or native test hook is claimed.

## Self-Check: PASSED

All 11 owned rows are final in docs/performance/phase08-23.json with zero AUDIT, and all required checks pass (phase tests 17/17, full suite 1740/0/3, maru-cli check, clippy, fmt, checker --plan 23). Changes remain uncommitted per the session contract.
