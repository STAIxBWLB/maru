---
phase: 08-main-thread-responsiveness
plan: "27"
subsystem: native-responsiveness-harness
tags: [tauri, rust, native-e2e, wdio, saturation, source-race, perf-01, perf-02, regression-test]
requires:
  - phase: 08-26
    provides: processing-operations ownership wrappers, per-handler fulfilled classifiers and the 365-command caller audit whose owned-wrapper seams this plan drives under native saturation
  - phase: 08-02
    provides: OperationNotice publisher and SkillsTab view-scope request guarding the D-04 UI flow asserts against
provides:
  - src-tauri/src/native_e2e.rs feature-gated saturation/source-race harness (two-worker runtime install, same-runtime async probe, allowlisted load control with fixture-root validation, isolated/blockingAsync modes, change/revert fixture source through the registry transaction seams) with a deadlock regression test
  - e2e-native/specs/responsiveness.spec.ts (10 tests) plus e2e-native/helpers/responsivenessSamples.ts chunked sampler and saturation fixtures in e2e-native/helpers/fixtureWorkspace.ts
  - artifacts/native-responsiveness/{calibration,thresholds,negative-control,fixed-run}.json with measured numbers (probe bound 27ms, parse bound 32ms, negative control probe p95 4789ms, fixed-run p95 2/7ms at maxConcurrent 4 on a 2-worker runtime)
  - docs/performance/phase08-native-allowlist.json registering native_e2e_async_probe and native_e2e_load_control as native-only commands (365 production registrations + 2 native-only)
  - Load-control seams in git.rs/vault.rs/store.rs with source-aware arm matching and the deterministic pre-work window inside sync_source_transaction between lease admission and the pre-network revalidation
affects: [08-28, 08-29]
actuals:
  tokens: 0
  tasks: 3
  commits: 0
tech-stack:
  added: []
  patterns: [feature-gated harness module behind default-off cargo feature, build-gated VITE_NATIVE_E2E bridge namespace, cfg(test) fixture-root injection seam to keep env-mutating tests race-free, source-scoped op arming so Sync All admissions are not delayed by an arm for one source, neutral { settled } envelope around executeAsync results to dodge WebKit error-shaped-callback surfacing, deterministic pre-work window placed between lease admission and revalidation so mid-window mutations are caught by the existing generation guard]
key-files:
  created: [src-tauri/src/native_e2e.rs, e2e-native/helpers/responsivenessSamples.ts, e2e-native/specs/responsiveness.spec.ts, docs/performance/phase08-native-allowlist.json]
  modified: [src-tauri/src/lib.rs, src-tauri/src/git.rs, src-tauri/src/vault.rs, src-tauri/src/skill_host/store.rs, src/lib/nativeE2eBridge.ts, src/App.tsx, e2e-native/wdio.conf.ts, e2e-native/helpers/fixtureWorkspace.ts, scripts/check-native-e2e-isolation.mjs]
key-decisions:
  - The load-control self-deadlock (arm_load_control and change_fixture_source calling control_status() while holding the same std Mutex guard) was fixed by scoping the guards and pinned by a regression test (phase08_27_arm_status_disarm_do_not_deadlock) that runs the arm round-trip on a spawned thread with a 2s recv budget; the test was verified to fail in ~2s against the reintroduced bug before the fix was restored.
  - The deterministic pre-work window for skills_sync_source lives inside sync_source_transaction between admit_source_operation and the existing pre-network revalidation, not around the whole command; the command-level placement captured the source snapshot after the window, so a settings change during the window was invisible (D-01), a duplicate sync admitted after the in-flight lease released (D-02), and Sync All admitted source A after its in-flight sync completed (D-03). The tail of sync_source_transaction after admission became a closure so both feature and default builds run it identically.
  - Arm matching is source-aware: ArmedControl carries the ArmOp source_id and LoadWindow::begin refuses calls for a different source, because op-level arming delayed every Sync All source by the 2.5s window and moved the busy admission past the in-flight lease release. blockingAsync remains op-level because the negative control stalls any caller of the armed op.
  - The D-01 no-write-back assertion targets the fixture pending marker (FIXTURE_PENDING_DESCRIPTION in the update commit) instead of the base title, because the app's production startup behavior rescans the whole catalog whenever it is empty (agentRuntimeModeStore skills:refresh), legitimately persisting old-checkout records mid-run; seed and update commits keep the same frontmatter name so sibling specs' title assertions are untouched.
  - Fixture skill directories are unique per source (skills/<source-id>) so the app's real duplicate_source validation cannot invalidate synced fixture skills once two or more sources carry records; all four sources previously shared the directory name native-sync.
  - WebKit's async-script bridge surfaces a callback argument shaped like an error (an object with an error field) as a WebDriverError, so pollBridgeCall returns the keyed slot inside a neutral { settled } envelope and unwraps it Node-side; expected command rejections (source_changed, unknown_source) now arrive as settled outcomes the assertions can inspect.
  - The load-control regression test injects the fixture root through a cfg(test) seam instead of mutating MARU_NATIVE_E2E_HOME, which outranks MARU_TEST_HOME in maru_home_dir and would race the parallel lib suite.
requirements-completed: [PERF-01, PERF-02]
coverage:
  - id: PERF-01-NATIVE-SATURATION
    description: On a real 2-worker Tokio runtime (TOKIO_WORKER_THREADS=2 installed before Tauri init and asserted by the probe), four real operations (two git_status on dirty repos, scan_vault over a 2000-file tree, skills_sync_source with a real git pull) overlap deterministically while 120-sample probe and parse series at 25ms cadence meet frozen idle-derived bounds with zero missing samples across loaded and recovery windows in three consecutive rounds.
    requirement: PERF-01
    verification:
      - kind: e2e-native
        ref: pnpm exec wdio run e2e-native/wdio.conf.ts --spec ./e2e-native/specs/responsiveness.spec.ts (10/10 pass; calibration probe idle p95 2ms, parse idle p95 7ms; frozen bounds probe 27ms / parse 32ms / maxStall 250ms; negative control blockingAsync probe loaded p95 4789ms vs 27ms bound violates frozen bounds as required; fixed run 3 rounds maxConcurrent 4, probe loaded/recovery p95 2ms, parse p95 7ms, maxStall 8-9ms, missing 0)
        status: pass
      - kind: e2e-native
        ref: make test-e2e-native (full native suite, 6/6 spec files, 23 tests including skills-sync and all 10 responsiveness tests)
        status: pass
      - kind: unit
        ref: cargo test --features native-e2e --lib phase08_native_harness (6 passed including the deadlock regression)
        status: pass
    human_judgment: false
  - id: PERF-02-SOURCE-RACE
    description: Source-race guards hold under deterministic mid-window mutation on the real app and runtime - a change or change/revert during the pre-work window rejects the in-flight sync with source_changed while latest settings survive (D-01); a duplicate sync reports source_busy and the operation runs once (D-02); Sync All skips the busy source and persists the others (D-03); a UI-started sync completes across a screen change with exactly one notice and no forced navigation (D-04); one failing source keeps the others' successes with manual-only retry (D-05); a source removed during sync is never resurrected by its late write-back and the tombstone is recorded (PERF-02).
    requirement: PERF-02
    verification:
      - kind: e2e-native
        ref: responsiveness.spec.ts D-01..D-05 + PERF-02 (all pass in the standalone run and inside make test-e2e-native)
        status: pass
      - kind: unit
        ref: cargo test --lib (1756 passed / 3 ignored default features; 1761 passed under --features native-e2e, exact +6-1 feature accounting) covering the existing phase08_source_transactions guard suite the window relocation touches
        status: pass
    human_judgment: false
  - id: SHIP-ISOLATION
    description: The responsiveness hook exists only in the native-e2e feature build - the default debug binary carries no MARU_NATIVE_RESPONSIVENESS_HOOK marker, the bridge namespace folds away without VITE_NATIVE_E2E=1, and the two native-only commands are registered in the command-isolation allowlist.
    requirement: PERF-01
    verification:
      - kind: script
        ref: node scripts/check-native-e2e-isolation.mjs --binary src-tauri/target/debug/maru (default build; hook marker absent, exit 0)
        status: pass
      - kind: script
        ref: node scripts/check-command-isolation.mjs --integration 29 and --plan 01 02 06 (PASS; 365 production registrations + 2 native-only commands)
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 27: Native Saturation and Source-Race Harness Summary

The native responsiveness harness is implemented and green end to end. A feature-gated Rust module (`native_e2e.rs`) installs a deterministic two-worker Tokio runtime before Tauri initializes, serves a same-runtime async probe, and drives allowlisted load control (arm/disarm/change/revert) that holds a 2500ms pre-work interval inside the real blocking closures of `git_status`, `scan_vault` and `skills_sync_source`. The WebKit spec calibrates idle responsiveness, freezes thresholds, proves the blockingAsync negative control violates the frozen probe bound (loaded p95 4789ms vs a 27ms bound), then proves the isolated saturation run meets those bounds with four overlapping real operations on two workers across three full rounds - probe p95 2ms, parse p95 7ms, max stall 9ms, zero missing samples, maxConcurrent 4. Six source-race D-cases (D-01..D-05, PERF-02) exercise the generation-guard, busy-lease, skip, notice and tombstone semantics through the same bridge.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land.

| Command | Disposition |
|---|---|
| cargo test --features native-e2e --lib phase08_native_harness | 6 passed, 0 failed |
| cargo test --lib (default features, full) | 1756 passed, 0 failed, 3 ignored (one web_actions flake on a first parallel run passed standalone and on this clean rerun) |
| cargo test --features native-e2e --lib (full) | 1761 passed, 0 failed, 3 ignored (1756 - 1 feature-excluded + 6 harness tests) |
| cargo clippy --lib -- -D warnings and --features native-e2e | Passed (both configurations, final state) |
| cargo fmt -- --check | Passed |
| cargo check -p maru-cli | Passed |
| pnpm exec vitest run src scripts (pnpm test gate) | 2090 passed, 0 failed (216 files); the chained node --test half reports 91 integration29 checks pass |
| pnpm typecheck | Passed |
| pnpm lint (eslint src e2e e2e-native --max-warnings 0) | Passed |
| pnpm lint:i18n | Passed: 3768 keys in parity |
| node scripts/check-command-isolation.mjs --integration 29 / --plan 01 / 02 / 06 | PASS (365 production registrations, 2 native-only commands) |
| node scripts/check-command-isolation.mjs --plan 05 | FAIL - pre-existing evidence drift: phase08-05.json names phase08_05::pull_and_commit_push_wait_for_transaction_before_validation_or_process, which is absent from git.rs at pristine HEAD as well; unrelated to this plan |
| node scripts/check-native-e2e-isolation.mjs --binary src-tauri/target/debug/maru (default build) | PASS, exit 0; MARU_NATIVE_RESPONSIVENESS_HOOK absent (MARU_NATIVE_E2E_HOME string present but inert without the feature, per D-09/D-10) |
| pnpm exec wdio run e2e-native/wdio.conf.ts --spec ./e2e-native/specs/responsiveness.spec.ts | 10/10 passed; all four artifacts written |
| make test-e2e-native (rebuilds frontend + feature binary, all specs) | 6/6 spec files passed, 23 tests, in 2:43 |

## Harness shape

- `src-tauri/src/native_e2e.rs` (feature-gated): `install_test_runtime` builds the Tokio runtime from `TOKIO_WORKER_THREADS` and asserts the worker count; `native_e2e_async_probe` is a one-yield poll_fn handshake scheduled by the Tauri runtime itself (never spawn_blocking); `native_e2e_load_control` accepts only allowlisted actions/ops, validates every path against the canonical fixture root (parent of `MARU_NATIVE_E2E_HOME`), and mutates one fixture-owned source through the existing registry guard transactions. `with_load_control` sleeps the deterministic interval then runs the real work while the `LoadWindow` records active counters and overlap windows; `is_blocking_async` stalls inline for the negative control.
- `src-tauri/src/skill_host/store.rs`: the sync tail after `admit_source_operation` runs as a closure behind `with_load_control("skills_sync_source", Some(source_id), None, tail)`, so the lease is held before the window, mutations during the window hit the pre-network revalidation (generation or existence), and the write-back stays guarded by the commit-stage revalidation. `sync_source_transaction` callers (`skills_sync_source`, `skills_sync_all_sources`, `skills_rescan_source`) all flow through the same seam.
- `src/lib/nativeE2eBridge.ts` + `src/App.tsx`: the bridge namespace installs at app mount behind the literal `VITE_NATIVE_E2E === "1"` gate (folds away in production builds); the harness install merged into the existing menuCommand dispatcher effect to respect the D-13 hook ceiling.
- `e2e-native/wdio.conf.ts`: `TOKIO_WORKER_THREADS=2` is exported in `onPrepare` before the launcher spawns the app; fixtures seed in the same hook.
- Spec: chunked in-page sampler (probe + parse series at 25ms cadence behind per-window executeAsync scripts), keyed fire-and-poll bridge slots, `browser.setTimeout({ script: 110000 })` in the suite `before` (WebKit's default 30s script timeout kills long rounds), and a suite `after` that disarms load control, restores the fail-source remote and reseeds fixtures for later spec files.

## D-case results

- D-01: change and change/revert during the window both reject the in-flight sync with `source_changed`; latest settings (skills-race, then restored subdir) survive; the pending commit's description never lands in the registry.
- D-02: the duplicate sync rejects immediately with `source_busy: native-sync-a is already syncing`; the first sync succeeds once and persists `lastSyncedAt`.
- D-03: Sync All reports A skipped (`skipped: true, ok: false`), exactly one skip, zero failures, and B's success persisted with a valid record.
- D-04: a UI-started sync (settings > Skills tab > source card > Sync > confirm) completes after navigating to Documents with exactly one existing-surface notice and no forced navigation back; result persisted on disk with a valid skill record.
- D-05: the broken-remote source fails with an actionable reason, Sync All keeps A's success and reports exactly one failure, and one manual retry succeeds after the remote is restored; nothing retries automatically.
- PERF-02: removing the source mid-window rejects the sync with `unknown_source`, the removal survives the late write-back, and the tombstone lands in `removedSourceIds`.

## Corrections and Evidence History

1. **Mutex self-deadlock (root cause of every native-suite hang):** the first `arm_load_control` implementation called `control_status()` - which re-locks the same std Mutex - while its own guard was alive (`change_fixture_source` repeated the pattern). The permanently blocked holder then queued every later `loadControl` call, and with both Tokio workers parked behind queued `loadControl` IPC the app wedged - explaining calibration passing then arm hanging, and D-cases timing out on plain `loadControl`. A temporary `debug-hang.spec.ts` reproduced it; the fix scopes both guards, and `phase08_27_arm_status_disarm_do_not_deadlock` pins it (verified: with the bug reintroduced the test fails via its 2s recv timeout; with the fix it passes). The repro spec was deleted after verification.
2. **Window placement:** wrapping the whole `skills_sync_source` command meant the source snapshot was captured after the pre-work window, so mid-window mutations were invisible and busy admissions landed after the in-flight sync finished (D-01/D-02/D-03 all failed for this one reason). The window moved between lease admission and the pre-network revalidation.
3. **Source-scoped arming:** with op-level arming, Sync All's other sources each absorbed the 2.5s window and A's busy admission landed after the in-flight lease release; `ArmedControl.source_id` + `LoadWindow::begin` source matching fixed D-03 while leaving saturation arming unchanged.
4. **WebKit error-shaped callback:** a settled slot shaped `{ ok: false, error: "source_changed..." }` surfaced as a thrown WebDriverError from `executeAsync` instead of a value; the `{ settled }` envelope in `pollBridgeCall` makes expected rejections inspectable (D-01, PERF-02).
5. **Fixture duplicate_source:** all four seeded sources shared the skill directory name `native-sync`, so once two sources carried records the app's real cross-source duplicate-name validation marked them invalid (D-04). Directories are now unique per source (`skills/<source-id>`).
6. **Startup catalog-refresh pollution:** the app's production behavior (`agentRuntimeModeStore` schedules `refreshSkills({ refresh: true })` when the cached catalog read returns zero skills) rescans every source and saves the registry mid-run; D-01's old "no B skill" assertion was reinterpreted against the pending-commit marker (`FIXTURE_PENDING_DESCRIPTION`) so a legitimate old-content record cannot be mistaken for the discarded sync's write-back.
7. Earlier-session serialization bugs (kept fixed): executeAsync serializes only the inline function so module-scope constants (`RESULTS_KEY`) were ReferenceErrors - all round scripts inline their literals; WebKit's 30s async-script timeout required `browser.setTimeout({ script: 110000 })`; long rounds are chunked per browser window; and two concurrent wdio runs must never share a machine (embedded-driver port 4445 collision plus the `killSurvivingAppProcesses` backstop cross-kills the other run's app - several earlier "hangs" were this contamination, not app bugs).
8. The negative-control collect path proved sufficient as written (blockingAsync ops are inline stalls, so the round's probe series freezes without any Node-side op-slot polling).

## Handoff and Limits

- PERF-01/PERF-02 are now proven at the native layer for the allowlisted operation set; the phase-level requirements remain marked complete only for the seams this plan owns (saturation window + source-race guards), consistent with prior plans' partial claims.
- The harness covers exactly three allowlisted ops (`git_status`, `scan_vault`, `skills_sync_source`); extending saturation to more converted commands is a one-line `LOAD_CONTROL_OPS` + arm-validation change plus fixtures.
- `cargo build` (default) was the last build of `src-tauri/target/debug/maru`, so the debug binary on disk is hook-free; `make test-e2e-native` rebuilds the feature binary when needed.
- `restoreSkillFixtures` (suite `after`) reseeds checkouts with `git reset --hard` to the recorded seed HEAD and restores the registry from the seeded backup, so later spec files keep their pending commits; it never deletes directories, preserving the app-side filesystem watchers.

## Threats and Self-Check

- T-08-27-01: no production command, permission or registry semantics changed; the load-control seams are no-ops unless the feature build arms them, and source-aware arm matching only narrows when the window applies.
- T-08-27-02: the deterministic window is a std::thread::sleep inside the already-blocking spawn_blocking closure - it never holds an async worker await point, and the negative control's inline stall is the only path that deliberately parks workers (that is the measurement).
- T-08-27-03: fixture roots are per-run mkdtemp directories exported only through the native-e2e launcher; the changeSource seam refuses any source whose canonical path escapes the fixture root, and no live workspace, credential or public remote is touched (bare remotes are local bare repos).
- T-08-27-04: the `{ settled }` envelope and keyed slot pattern keep expected rejections observable without weakening command error contracts; the bridge exposes no arbitrary command/path port.

## Self-Check: PASSED

All ten spec tests pass standalone and inside the full native suite (6/6 spec files); the four artifacts carry measured numbers consistent with the frozen thresholds (negative control violates, fixed run meets with 10x margin); the deadlock regression test demonstrably catches the original bug; both cargo suites (default and feature) pass with exact test-count accounting; the frontend suite passes 2090/2090 with typecheck, lint, lint:i18n, clippy and fmt clean; ship-isolation scans confirm the hook marker is absent from the default binary; and the only command-isolation failure (`--plan 05`) reproduces on pristine HEAD and names a case missing from the code, not a regression from this plan. Changes remain uncommitted per the session contract.
