---
phase: "08"
slug: main-thread-responsiveness
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-05"
---

# Phase 8 Validation Strategy

Final planning map for 29 plans and 62 tasks, derived from 08-RESEARCH.md and 08-PLAN-MAP.md. All implementation, tests and benchmark execution remain pending.

## Test Infrastructure

| Property | Value |
|---|---|
| Frameworks | Cargo library tests, Vitest, Playwright, native WebdriverIO |
| Existing configuration | src-tauri/Cargo.toml, vite.config.ts, playwright.config.ts, e2e-native/wdio.conf.ts |
| Fast Rust check | `cargo test --manifest-path src-tauri/Cargo.toml --lib skill_host` |
| Type/IPC compatibility | `pnpm typecheck` and `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` |
| Full hermetic suite | `make verify` |
| Native suite | `make test-e2e-native` |
| Timing estimate | Measure after compilation; do not treat build time as command latency |

## Sampling Rate

- After each task: its named focused behavior tests; fail on nonzero exit or zero matched tests.
- After each wave: affected Rust modules, frontend tests, typecheck and CLI compilation.
- Before UAT: full hermetic suite plus isolated native behavior/concurrency checks.
- Fast feedback target: under 60 seconds after cached builds; slow full/native gates explicitly separate.

## Per-Task Verification Map

Every command runs from repository root. Each test selector must match at least one non-skipped case. Producer paths and task-local acceptance conditions are in the corresponding PLAN; no execution result is claimed.

| Task | Wave | Requirements | Automated commands | Threat refs | Execution |
|---|---|---|---|---|---|
| 08-01-1 | 1 | PERF-02, PERF-01 | `make test-e2e-native`; `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_source_transactions` | T-08-01-01/02/03 | pending |
| 08-01-2 | 1 | PERF-02, PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_source_transactions`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-01-01/02/03 | pending |
| 08-02-1 | 2 | PERF-02, PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_batch_transactions`; `pnpm exec vitest run src/lib/skills.test.ts`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-02-01/02/03 | pending |
| 08-02-2 | 2 | PERF-02, PERF-01 | `pnpm exec vitest run src/lib/skillOperations.test.ts src/lib/errorStore.test.tsx` | T-08-02-01/02/03 | pending |
| 08-02-3 | 2 | PERF-02, PERF-01 | `pnpm typecheck`; `pnpm lint:i18n`; `pnpm exec vitest run src/lib/skillOperations.test.ts` | T-08-02-01/02/03 | pending |
| 08-03-1 | 3 | PERF-02, PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_03_network_lock`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-03-01/02/03 | pending |
| 08-03-2 | 3 | PERF-02, PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_03_boundary`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-03-01/02/03 | pending |
| 08-04-1 | 4 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_04`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-04-01/02/03 | pending |
| 08-04-2 | 4 | PERF-01 | `node --test scripts/check-command-isolation.test.mjs`; `node scripts/check-command-isolation.mjs --plan 04` | T-08-04-01/02/03 | pending |
| 08-05-1 | 5 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_05`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-05-01/02/03 | pending |
| 08-05-2 | 5 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_05`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 05` | T-08-05-01/02/03 | pending |
| 08-06-1 | 6 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_06`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-06-01/02/03 | pending |
| 08-06-2 | 6 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_06`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 06` | T-08-06-01/02/03 | pending |
| 08-29-1 | 7 | PERF-02, PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_29`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-29-01/02/03 | pending |
| 08-29-2 | 7 | PERF-02, PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_29`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-29-01/02/03 | pending |
| 08-29-3 | 7 | PERF-02, PERF-01 | `node --test scripts/check-command-isolation.test.mjs`; `node scripts/check-command-isolation.mjs --integration 29`; `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_source_transactions`; `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_batch_transactions` | T-08-29-01/02/03 | pending |
| 08-07-1 | 8 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_07`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-07-01/02/03 | pending |
| 08-07-2 | 8 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_07`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 07` | T-08-07-01/02/03 | pending |
| 08-08-1 | 9 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_08`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-08-01/02/03 | pending |
| 08-08-2 | 9 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_08`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 08` | T-08-08-01/02/03 | pending |
| 08-09-1 | 10 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_09`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-09-01/02/03 | pending |
| 08-09-2 | 10 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_09`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 09` | T-08-09-01/02/03 | pending |
| 08-10-1 | 11 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_10`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-10-01/02/03 | pending |
| 08-10-2 | 11 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_10`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 10` | T-08-10-01/02/03 | pending |
| 08-11-1 | 12 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_11`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-11-01/02/03 | pending |
| 08-11-2 | 12 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_11`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 11` | T-08-11-01/02/03 | pending |
| 08-12-1 | 13 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_12`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-12-01/02/03 | pending |
| 08-12-2 | 13 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_12`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 12` | T-08-12-01/02/03 | pending |
| 08-13-1 | 14 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_13`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-13-01/02/03 | pending |
| 08-13-2 | 14 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_13`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 13` | T-08-13-01/02/03 | pending |
| 08-14-1 | 15 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_14`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-14-01/02/03 | pending |
| 08-14-2 | 15 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_14`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 14` | T-08-14-01/02/03 | pending |
| 08-15-1 | 16 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_15`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-15-01/02/03 | pending |
| 08-15-2 | 16 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_15`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 15` | T-08-15-01/02/03 | pending |
| 08-16-1 | 17 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_16`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-16-01/02/03 | pending |
| 08-16-2 | 17 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_16`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 16` | T-08-16-01/02/03 | pending |
| 08-17-1 | 18 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_17`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-17-01/02/03 | pending |
| 08-17-2 | 18 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_17`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 17` | T-08-17-01/02/03 | pending |
| 08-18-1 | 19 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_18`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-18-01/02/03 | pending |
| 08-18-2 | 19 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_18`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 18` | T-08-18-01/02/03 | pending |
| 08-19-1 | 20 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_19`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-19-01/02/03 | pending |
| 08-19-2 | 20 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_19`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 19` | T-08-19-01/02/03 | pending |
| 08-20-1 | 21 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_20`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-20-01/02/03 | pending |
| 08-20-2 | 21 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_20`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 20` | T-08-20-01/02/03 | pending |
| 08-21-1 | 22 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_21`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-21-01/02/03 | pending |
| 08-21-2 | 22 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_21`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 21` | T-08-21-01/02/03 | pending |
| 08-22-1 | 23 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_22`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-22-01/02/03 | pending |
| 08-22-2 | 23 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_22`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 22` | T-08-22-01/02/03 | pending |
| 08-23-1 | 24 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_23`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-23-01/02/03 | pending |
| 08-23-2 | 24 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_23`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 23` | T-08-23-01/02/03 | pending |
| 08-24-1 | 25 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_24`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-24-01/02/03 | pending |
| 08-24-2 | 25 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_24`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-24-01/02/03 | pending |
| 08-24-3 | 25 | PERF-01 | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_24`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; `node scripts/check-command-isolation.mjs --plan 24` | T-08-24-01/02/03 | pending |
| 08-25-1 | 26 | PERF-01 | `pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/api.test.ts`; `pnpm typecheck` | T-08-25-01/02/03 | pending |
| 08-25-2 | 26 | PERF-01 | `pnpm exec vitest run src/lib/export.test.ts src/lib/studio.test.ts src/lib/processingOperations.test.ts`; `pnpm typecheck` | T-08-25-01/02/03 | pending |
| 08-26-1 | 27 | PERF-01, PERF-02 | `pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/skillOperations.test.ts`; `pnpm typecheck` | T-08-26-01/02/03 | pending |
| 08-26-2 | 27 | PERF-01, PERF-02 | `pnpm exec vitest run src/lib/processingOperations.test.ts`; `pnpm typecheck` | T-08-26-01/02/03 | pending |
| 08-27-1 | 28 | PERF-01, PERF-02 | `cargo test --manifest-path src-tauri/Cargo.toml --features native-e2e --lib phase08_native_harness`; `pnpm typecheck` | T-08-27-01/02/03 | pending |
| 08-27-2 | 28 | PERF-01, PERF-02 | `cargo test --manifest-path src-tauri/Cargo.toml --features native-e2e --lib phase08_native_harness`; `pnpm typecheck` | T-08-27-01/02/03 | pending |
| 08-27-3 | 28 | PERF-01, PERF-02 | `make test-e2e-native` | T-08-27-01/02/03 | pending |
| 08-28-1 | 29 | PERF-01, PERF-02 | `node --test scripts/check-command-isolation.test.mjs`; `node scripts/check-command-isolation.mjs --all --expected-count 365`; `make verify`; `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | T-08-28-01/02/03 | pending |
| 08-28-2 | 29 | PERF-01, PERF-02 | `pnpm build:frontend`; `make release-checks`; `node scripts/check-command-isolation.mjs --all --expected-count 365` | T-08-28-01/02/03 | pending |

## Wave 0 Requirements

Existing test frameworks are installed. Plans must create missing race,
operation-lifetime, inventory and native responsiveness test artifacts before
using them as verification. Do not count uncreated test paths or empty selectors
as passing. Each artifact must have an explicit producer plan and dependency.

## Manual-Only Verifications

No new OS IME or native menu feature is in scope. Required concurrency and
navigation behaviors must be automated using the real native app. Any behavior
that cannot be observed remains explicitly unverified; do not replace it with
an approval marker or browser mocks.

## Native Calibration Contract

Measure IPC inside the webview with monotonic timestamps, not WebDriver
round-trip duration. Verify runtime worker count before saturation. Freeze
limits before the fixed run and retain raw baseline/load/recovery samples,
operation outcomes, overlap and fixture sizes. Preliminary research bounds
are engineering proposals, not demonstrated performance or user-approved SLOs.
A failed negative control invalidates the harness; broadening thresholds just
to pass is prohibited.

## Validation Sign-Off

- [x] Final task IDs, concrete commands and threat references populated.
- [ ] Every task has an automated behavior check or explicit prerequisite.
- [ ] No three consecutive tasks without automated feedback.
- [ ] Missing test artifacts have producer tasks before consumers.
- [ ] All commands state observable failure signals and reject empty selections.
- [ ] Fast and full/native feedback costs distinguished.
- [ ] Planning validation reviewed; execution status remains pending.

**Approval:** pending plan-checker review

## Producer ordering

- 01-1 creates native skills-sync.spec.ts and inline transaction smoke tests; 01-2 adds full race cases before their focused run.
- 02-1 creates phase08_batch_transactions::actual_wrapper_allows_async_progress cases for held defaults/admission and per-source work, proving same-runtime yielding work finishes before barrier release, plus batch tests and updates existing skills.test.ts; 02-2 creates skillOperations tests before 02-3 consumes them.
- 04-2 creates the shard checker/test before 05-24 use it. 01-04 shard checks are included in final 28.
- 05-24 each create inline phase08_NN tests in their owned modules before their own cargo selector runs.
- 06-1 produces atomic_file::with_path_transactions, PathTransactionRequest and PathTransactionLease plus cfg(test) admission/pre-effect barriers before 29 and 07-24 consume them. Its phase08_06 cases cover atomic complete-path-set admission, component-wise parent conflicts, successful symlink aliases, stable required-parent identity, unrelated progress, reversed path order and error/unwind release. Shared admission always precedes existing domain guards; they are never exemptions. Borrowed State entry points retain sync signatures through owned helpers.
- 29 executes at wave 7 immediately after 06. 29-1 produces inline phase08_29_skills/git/env tests using real Skills save/sync and Git pull against 06 parent rename/trash wrappers (all six pairs, both orders, aliases, stable-parent checks, error/unwind release). It also proves registry list and metadata-only removal availability during network/path waits, nonblocking duplicate/alias and batch skipped outcomes, and env background lease lifetime. 29-2 produces inline phase08_29_dispatch/dot tests for event/mission callback paths and finite local subprocess sets; explicit borrowed-lease adapters in event_store/mission_state are staged prerequisites for 17/16. No test file outside declared scopes is needed.
- 29-3 produces phase08-29-integration.json and validates --integration 29 with checker support produced by 04; exactly seven module records, five final owners and two staged owners, zero command inventory rows. It reruns source/batch regressions including actual_wrapper_allows_async_progress. The focused gate checks the 07 document requirement as an explicit future producer obligation, never as passing behavior. Final 28 requires actual 07 results.
- 07-2 produces phase08_07_parent_child_races with real parent rename/trash versus child save/create wrappers, all four pairs in both orderings, after-revision/pre-write barriers, frontmatter/save contention and error release. Missing cases, parent recreation, lost updates, partial rekeys or deadlock fail the phase08_07 selector. 07-1 first produces document wrappers/admission; 07-2 also produces phase08_07_earlier_writer_document_races in document.rs: actual Skills save/sync and Git pull versus document save/create, all six pairs in both orders with aliases, changed-parent rejection, error release and registry availability. No manual test-side admission around unguarded save counts. Missing pairs/orders, empty selectors, lost updates, parent recreation or blocked registry access fail the focused selector and final closure. Plans 08-24 add real cross-domain contention for their writers and document shared admission plus domain-lock order.
- 25-1 creates processingOperations tests and WorkspaceMutation/Inbox typed classifiers before 25-2/26 consume them. Actual-wrapper cases resolve all-success, mixed and all-failed payloads after unsubscribe/workspace change and require unchanged payloads, retained successes/reasons, exactly one correct notice and no retries. 25-2 extends export/studio tests for results[].success=false, template manualFallback/validation failure and nested outer-owner classification.
- 26 tests component/store notice consolidation across OperationNotice and existing error toast channels, including App's fulfilled Inbox errors; caller evidence names each payload classifier, reason source, retained success and single notice owner.
- 27-1 creates native_e2e.rs inline phase08_native_harness tests; 27-2 extends fixtures and sample helper; 27-3 creates/executes responsiveness.spec.ts.
- 28 consumes the 29 integration overlay and 07 crossDomainConsumers plus all completed shards, processing caller map and native raw evidence; absence is a nonzero gate, including batch-wrapper scheduling, hierarchical cross-domain contention and fulfilled-domain-failure notice evidence.

## Frozen native protocol

Two verified Tauri async runtime workers; four real overlapping calls: git_status on two separate repositories, scan_vault on 2000 Markdown files, skills_sync_source against local bare Git remote. Probe series: native_e2e_async_probe (one async yield on same runtime) and production parse_korean_date_cmd. Webview performance.now timestamps, 25ms target cadence, 40 warm-up then 120 samples for each idle/load/recovery window, three rounds. Thresholds frozen after three idle calibration rounds: p95 <= max(calibrated idle p95*2, calibrated idle p95+25ms), max <=250ms, no missing samples. Blocking-async control must violate latency bounds; isolated restored run must pass. Store raw samples, overlap/results, fixture sizes, revision/worker count and threshold hash in artifacts/native-responsiveness before fixture cleanup. Feature-on and normal produced-artifact isolation red/green proof is required in 28.
