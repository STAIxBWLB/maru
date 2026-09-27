---
phase: 08-main-thread-responsiveness
plan: "24"
subsystem: native-ui-and-bounded-parsers
tags: [rust, tauri, spawn-blocking, concurrency, native-ui, site-view, passkeys, approval, parsers]
requires:
  - phase: 08-23
    provides: Same-name pub mod ipc wrapper precedent and worker-stage test hooks
provides:
  - Twelve isolated native-ui-and-bounded-parsers commands (1 html_editor, 2 browser_passkeys, 4 site_view, 1 today_notify, 2 approval, 1 korean_date, 1 gaejosik) with preserved synchronous exports
  - Nine retained site_view per-tab UI commands with generic-R signatures, unchanged registrations and positive main-thread affinity evidence
  - Sixteen behavioral tests and exact twenty-one-row evidence
affects: [08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 60000
  tasks: 3
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, same-name pub mod ipc wrappers, owned AppHandle/String/State-clone inputs, run_on_main_thread plus mpsc recv inside the worker for platform-affine passkey calls, module-local OPEN_LOCK confined to the blocking worker, Arc<Mutex<VecDeque>> SiteOpenedUrlState, Arc<Mutex<ApprovalStore>> ApprovalState, generic-R commands driven by tauri::test::mock_app, per-module TEST_LOCK for the global worker-hook registry, Result-returning wrapper for State-referencing async commands]
key-files:
  created: [docs/performance/phase08-24.json]
  modified: [src-tauri/src/html_editor.rs, src-tauri/src/browser_passkeys.rs, src-tauri/src/site_view.rs, src-tauri/src/today_notify.rs, src-tauri/src/approval.rs, src-tauri/src/korean_date.rs, src-tauri/src/linter/gaejosik.rs, src-tauri/src/linter/mod.rs, src-tauri/src/lib.rs]
key-decisions:
  - All 21 owned rows are final; 12 rows are ISOLATED behind a same-name async pub mod ipc wrapper awaiting spawn_blocking over the unchanged synchronous function (html_editor 1, browser_passkeys 2, site_view_open/open_external/open_safari/take_opened_urls 4, today_notify 1, approval 2, korean_date 1, gaejosik 1), and the two CONVERT rows (site_view_open_external, site_view_open_safari) are among them; the remaining 9 site_view per-tab rows (navigate, set_bounds, show, hide, close, close_all, reload, back, forward) keep their UI disposition as pure platform dispatch with no blocking substep of their own.
  - The 9 UI rows were made generic over R: tauri::Runtime with their #[tauri::command] registration unchanged, so the phase08_24 tests can drive them with tauri::test::mock_app; each UI row's checker-reachable helper graph (get_embed, embed_label, embed_labels, embed_rect, emit_to_main, parse_http_url) contains no BLOCKING pattern, which was verified per row before recording the UI disposition.
  - site_view_open keeps its module-local OPEN_LOCK serialization, but the lock is now only ever taken inside the spawn_blocking worker, so a slow native webview creation never stalls the shared async runtime or holds a registry guard across the creation.
  - browser_passkeys status/request_authorization restructured to synchronous cores that post to the main thread via run_on_main_thread and block the calling worker on an mpsc recv; the platform main-thread affinity is preserved while the wait runs on the owned worker, and request_authorization takes the owned Arc<AtomicBool> in-flight flag directly so the wrapper clones it out of State.
  - approval prepare/record keep their original tauri::State-based public signatures (zero churn for the ~10 test modules that call them through app.state()); ApprovalState is now Arc<Mutex<ApprovalStore>>-backed and Clone; the ipc wrappers clone state.inner() and call the private prepare/record methods inside the worker, with #[allow(dead_code)] marking the preserved sync exports (precedent from scheduler.rs).
  - site_view_take_opened_urls returns Result<Vec<String>, String> because Tauri requires owned-Result returns for State-referencing async commands; the Ok payload serializes as the bare array, so the wire is unchanged.
  - Synthetic worker-hook keys collide across parallel tests because the PathTransactionTestHook registry is global; every module using a synthetic key (browser_passkeys, site_view, approval, korean_date) guards its phase08_24 tests with a per-module TEST_LOCK, while modules with natural per-test tempdir keys (html_editor, today_notify, gaejosik) need none.
  - The checker's INTEGRATIONS map assigns none of the seven owned modules a later-plan handoff, so the shard records moduleIntegrationOwner "08-24" and no moduleIntegrations entries; --plan 24 exits 0.
requirements-completed: [PERF-01]
coverage:
  - id: NATIVE-UI-PARSERS-ISOLATION
    description: All 12 isolated IPC futures preserve meaningful synthetic results and typed rejections while yielding on their own polling task with a distinct blocked worker; the 9 UI rows dispatch on MockRuntime with typed rejections unchanged.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_24
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 24
        status: pass
    human_judgment: false
  - id: NATIVE-UI-PARSERS-CONCURRENCY
    description: site_view_open lock serialization and approval same-target record contention both serialize in either order with no mixed state; in-flight passkey rejection and recovery, take_opened_urls bounded drain and containment rejections pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_24
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 24: Native UI and Bounded Parsers Command Isolation Summary

All 21 native-ui-and-bounded-parsers commands now have final dispositions. Twelve (1 `html_editor`, 2 `browser_passkeys`, 4 `site_view`, 1 `today_notify`, 2 `approval`, 1 `korean_date`, 1 `gaejosik`) run their blocking work (asset-scope grants, main-thread passkey dispatches, webview creation lock waits, external-browser process spawns, opened-URL queue drains, workspace checks, notification dispatch, approval store writes, whole-document parser/linter scans) in awaited `spawn_blocking` workers. The nine per-tab `site_view` UI commands stay on their original registration as pure platform dispatch. Wire names, payload types, error strings, permission checks and the synchronous internal callers are unchanged.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land, alongside the pre-existing uncommitted `skill_host/dispatch.rs` work which was not touched.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_24 | Passed: 16 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1756 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed (after dead-code/import findings fixed) |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed (after one cargo fmt pass) |
| node scripts/check-command-isolation.mjs --plan 24 | Passed: exact 21 rows, 365 production registrations, 0 native-only commands |

The 16 tests comprise: a same-poll yield + JoinError boundary case per module driving all 12 real async wrappers (html_editor, browser_passkeys, site_view, today_notify, approval, korean_date, gaejosik), a nonempty real-fixture result plus unchanged typed/legacy rejection case per module (asset containment against a real tempdir vault, passkey unsupported/in-flight paths on the entitlement-less test binary, site_view URL/label validation and queue drain on MockRuntime, today_notify granted/denied outcomes on a notification-plugin MockRuntime app, approval prepare/record/consume and kind validation, korean_date phrase fixtures, gaejosik rule/dismissal fixtures), a deterministic both-orders case proving two concurrent record_approval calls on the same id leave the last-completed decision as the consistent store state, and a UI dispatch case driving all nine per-tab site_view commands with typed rejections.

## Corrections and Evidence History

1. The approval both-orders test needed three compile fixes after its first run: the prepare future needed `async move` (with the AppHandle cloned inside the block) because `App<MockRuntime>` is not Send-shareable; the mpsc order sender had to be cloned for the first of two concurrent record workers; and the request id had to be cloned into the second worker. Completion order equals mutex acquisition order, so taking the second received decision as the last write is deterministic under either scheduling.
2. `cargo clippy --lib -- -D warnings` flagged the two preserved synchronous approval exports as dead in non-test builds (production registers only the ipc paths) and the korean_date ipc module's glob import as unused; the approval functions carry `#[allow(dead_code)]` with the "Stable synchronous Rust API; desktop registration uses ipc." precedent from scheduler.rs, and the glob import became an explicit `#[cfg(test)] use super::WORKER_HOOK_KEY;` because the wrapper body already calls `super::parse_korean_date_cmd` directly. Both fixes are behavior-neutral.
3. The site_view_opened-URL queue (`SiteOpenedUrlState.queue`) is now `Arc<Mutex<VecDeque<String>>>` with a Clone state so the take_opened_urls wrapper can own the queue across the await; the enqueue path (macOS open-requested flow) is unchanged.
4. Synthetic worker-hook keys collide across parallel tests because the `PathTransactionTestHook` registry is global: a `boundary()` hook registered by one test intercepts a parallel test's worker calling `test_stage` with the same (path, stage). Every module using a synthetic key (browser_passkeys, site_view, approval, korean_date) now guards its phase08_24 tests with a per-module `TEST_LOCK`; modules with natural per-test tempdir keys (html_editor, today_notify, gaejosik) need none.
5. `cargo fmt` reflowed the new wrappers and tests; the focused phase08_24 tests (16/16), clippy and the full suite (1756/0/3) were re-run green after formatting, and the checker `--plan 24` ran last.

## Frontend Handoff and Limits

- `src/lib/api.ts` (`prepareHtmlEditorAssets`, `prepareApproval`, `recordApproval`), `src/lib/browserPasskeys.ts` (`browserPasskeyStatus`, `browserPasskeyRequestAuthorization`), `src/lib/siteView.ts` (all 13 site_view helpers), `src/lib/today.ts` (`notifyNewDay`), `src/lib/koreanDate.ts` (`parseKoreanDate`) and `src/lib/studio.ts` (`gaejosikLint`) keep existing invocation, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. D-04 completion ownership, stale-view protection and navigation-safe terminal notices remain Plans25/26; each row's `processingCaller` annotates the call sites and current completion ownership.
- Owned argument types (unchanged on the wire): `prepare_html_editor_assets(vaultPath, documentPath)`, `browser_passkey_status()`, `browser_passkey_request_authorization()`, `site_view_open(tabId, url, bounds)`, `site_view_navigate/set_bounds/show/hide/close/close_all/reload/back/forward(tabId, ...)`, `site_view_open_external/open_safari(url)`, `site_view_take_opened_urls()`, `today_notify_new_day(workPath, logicalDay, title?, body?)`, `prepare_approval(kind, summary, target?, payloadPreview?)`, `record_approval(id, decision, rememberKind?)`, `parse_korean_date_cmd(input, nowIso)`, `gaejosik_lint(workPath, markdown, dismissedIds)`. Commands that need the runtime take `AppHandle<R: tauri::Runtime>`; wrappers clone owned state out of `State` before the worker and never carry a borrowed `State` or guard across the await.
- New Rust surface is limited to the `pub mod ipc` wrappers in the seven modules, the generic-R signatures, the `Arc`-backed `SiteOpenedUrlState`/`ApprovalState`, the browser_passkeys synchronous cores (`status_on_main_thread` kept as the sync dispatch entry), the module-local `TEST_LOCK`s, and the `worker_hook_key`/`WORKER_HOOK_KEY` cfg(test) helpers.
- All 21 rows are read-only with respect to the filesystem (asset-scope grants, webview creation, notification dispatch, process spawns and in-memory store/queue/parser work), so every `mutationKey` records `readOnly: true` with positive no-mutation evidence and no path-transaction admission is required.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced; the single-flight passkey claim, the OPEN_LOCK open serialization, the MAX_OPENED_URLS queue bound, the approval consume-once semantics and the parser/linter rule sets are intact.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan24's contribution.

## Threats and Self-Check

- T-08-24-01: no owned command mutates the filesystem (all rows are read-only with positive evidence), containment validation (vault pinning, http/https-only URLs, embed-label alphabet, workspace-directory checks) still runs inside the worker before any effect, and denied-write fixtures assert the typed rejections; there is no permission bypass.
- T-08-24-02: awaited finite blocking closures, same-runtime yield proof on all 12 wrappers, RAII release on success/error/unwind (InFlightGuard, OPEN_LOCK guard, mutex guards), no guard across an await, and the lock-confined site_view_open plus the serialized approval store mitigate async-pool stalls and deadlocks; the UI rows carry no blocking substep by construction.
- T-08-24-03: Home-isolated fixtures, disposable tempdir workspaces/vaults, MockRuntime apps, synthetic /maru/phase08_24 worker-stage keys and the entitlement-less test binary constrain the proof; no live workspace, credential, network endpoint or native test hook is claimed, and the passkey Safari-open rationale (avoiding recursive reopen of the provisioned passkey build) is preserved.

## Self-Check: PASSED

All 21 owned rows are final in docs/performance/phase08-24.json with zero AUDIT, and all required checks pass (phase tests 16/16, full suite 1756/0/3, maru-cli check, clippy, fmt, checker --plan 24). Changes remain uncommitted per the session contract.
