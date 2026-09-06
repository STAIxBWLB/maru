---
phase: 08-main-thread-responsiveness
plan: "28"
subsystem: exhaustive-closure-and-production-isolation
tags: [closure, command-isolation, native-e2e, ship-isolation, perf-01, perf-02, phase-final]
requires:
  - phase: 08-27
    provides: feature-gated native saturation/source-race harness with measured artifacts and the two-entry native-only allowlist
  - phase: 08-26
    provides: the 365-command caller/notice audit (docs/performance/phase08-processing-callers.json) whose fulfilled-classifier/retention/failure-reason fields close each row's processingCaller
provides:
  - node scripts/check-command-isolation.mjs --all --expected-count 365 passing closure (365 evidence rows, 365 production registrations, 2 native-only commands) wired into hermetic make verify
  - final processingCaller closure merged into all 365 shard rows (classifier/successRetention/failureReasons/singleTerminalNoticeOwner) from the 08-26 audit
  - docs/performance/phase08-final.json merged evidence and decision/source audit (365 compact command rows + D-01..D-05/PERF-01/PERF-02/D-09/D-10 source audit)
  - Final 08-COMMAND-INVENTORY.md with a **FINAL** disposition column (356 ISOLATED / 9 UI, zero AUDIT) and definition lines refreshed against current sources
  - Extended scripts/check-native-e2e-isolation.mjs scanning the produced bundle and binary for the two native-only command symbols in addition to the bridge namespace, plugin crate names and MARU_NATIVE_RESPONSIVENESS_HOOK
  - Recorded feature-on rejection (exit 1, all markers) and normal-artifact pass (exit 0) for both the bundle and the default-feature binary
affects: [08-29]
actuals:
  tokens: 0
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [surgical JSON text insertion to preserve committed evidence formatting, checker-side closure assertions keyed on evidence schema rather than re-execution, per-needle violation messages in the artifact scanner, closure gate wired as a make verify prerequisite so every PR re-verifies evidence/registration parity]
key-files:
  created: [docs/performance/phase08-final.json]
  modified: [scripts/check-command-isolation.mjs, scripts/check-command-isolation.test.mjs, scripts/check-native-e2e-isolation.mjs, Makefile, docs/native-e2e.md, README.md, .planning/phases/08-main-thread-responsiveness/08-COMMAND-INVENTORY.md, docs/performance/phase08-01.json, docs/performance/phase08-02.json, docs/performance/phase08-03.json, docs/performance/phase08-04.json, docs/performance/phase08-05.json, docs/performance/phase08-06.json, docs/performance/phase08-07.json, docs/performance/phase08-08.json, docs/performance/phase08-09.json, docs/performance/phase08-10.json, docs/performance/phase08-11.json, docs/performance/phase08-12.json, docs/performance/phase08-13.json, docs/performance/phase08-14.json, docs/performance/phase08-15.json, docs/performance/phase08-16.json, docs/performance/phase08-17.json, docs/performance/phase08-18.json, docs/performance/phase08-19.json, docs/performance/phase08-20.json, docs/performance/phase08-21.json, docs/performance/phase08-22.json, docs/performance/phase08-23.json, docs/performance/phase08-24.json]
key-decisions:
  - "The --all closure failure (08-01/skills_sync_source: final processingCaller missing classifier) was resolved by merging the already-committed 08-26 caller audit into each shard row's processingCaller, not by weakening the gate: 365/365 rows gained classifier/successRetention/failureReasons/singleTerminalNoticeOwner with a closureSource back-reference, inserted as text so the committed evidence formatting diff stays 2190 insertions, 0 deletions."
  - "New closure assertions are keyed on the shared mutation admission contract (P08-02): mutation rows now fail on exact-path-only exclusion phrasing or existing-domain-guard exemption phrasing, and skills_sync_all_sources additionally requires its actual-wrapper same-runtime batch case in --all mode; every assertion was first proven against a fixture that deliberately removes the proof and fails."
  - "The artifact scanner's two native-only command names serve as the frontend allowlist marker: the bridge namespace check alone could pass while the VITE_NATIVE_E2E-gated invoke() strings survived dead-code elimination, so dist/assets is now scanned for native_e2e_async_probe and native_e2e_load_control as well."
requirements-completed: [PERF-01, PERF-02]
coverage:
  - id: CLOSURE-ALL
    description: Every one of the 365 original production commands and zero added production rows has exactly one final justified disposition; zero AUDIT/unowned/unresolved rows; live generate_handler registrations match the inventory 1:1; the 29-integration overlay joins as reference only; completed 16/17 handoffs and the 07 document-race consumer evidence are required and present.
    requirement: PERF-01
    verification:
      - kind: script
        ref: node scripts/check-command-isolation.mjs --all --expected-count 365 (PASS; 365 command evidence rows, 365 production registrations, 2 native-only commands)
        status: pass
      - kind: script
        ref: node --test scripts/check-command-isolation.test.mjs (96/96 pass, including the new fixtures rejecting a synchronous skills_sync_all_sources boundary, a missing actual-wrapper same-runtime batch test, exact-path-only mutation exclusion, existing-domain-guard exemption, and the pre-existing 07 pair/order and processing-caller fixtures)
        status: pass
    human_judgment: false
  - id: SHIP-ISOLATION-ARTIFACTS
    description: Normal frontend and default-feature binary contain no responsiveness probe/control or WebDriver hooks; feature-on artifacts are observably rejected.
    requirement: PERF-01
    verification:
      - kind: script
        ref: node scripts/check-native-e2e-isolation.mjs against the native-e2e dist (exit 1, reports __MARU_NATIVE_E2E__ + both command names) and against the feature binary src-tauri/target/debug/maru (exit 1, reports both plugin crate names, MARU_NATIVE_RESPONSIVENESS_HOOK and both command symbols) — recorded 2026-09-06
        status: pass
      - kind: script
        ref: pnpm build:frontend then touch src-tauri/build.rs + cargo build (default features); bundle half and --binary half both exit 0 on the produced artifacts; re-verified inside make release-checks against the tauri debug no-bundle binary before the debug prune
        status: pass
    human_judgment: false
  - id: PHASE-SUCCESS-CRITERIA
    description: ROADMAP Phase 8 success criteria mapping (see decisionSourceAudit in docs/performance/phase08-final.json).
    requirement: PERF-01
    verification:
      - kind: unit
        ref: "Criterion 1 (skills_sync_source releases REGISTRY_LOCK over the network; removed source not resurrected): store.rs generation-guard transaction suite plus phase08_01_deleted_source_never_returns_at_all_three_edges and the 08-27 native PERF-02 case"
        status: pass
      - kind: unit
        ref: "Criterion 2 (every network/subprocess/unbounded-walk command off the main thread): closure counts 356 ISOLATED + 9 UI across all 365 rows, enforced structurally by the checker (async registration, awaited spawn_blocking, no blocking preamble) plus recorded native/frontend tests per row"
        status: pass
      - kind: e2e-native
        ref: "Criterion 3 (concurrency load test, unrelated latency flat): 08-27 fixed run on a real 2-worker runtime - probe p95 2ms, parse p95 7ms, max stall 9ms, missing 0 at maxConcurrent 4, with the blockingAsync negative control violating the frozen probe bound (4789ms vs 27ms)"
        status: pass
    human_judgment: false
duration: same-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 28: Exhaustive Closure and Production Isolation Summary

The phase is closed. All 365 original production commands carry exactly one final justified disposition (356 ISOLATED, 9 UI; zero AUDIT, zero unowned, zero unresolved), the live `generate_handler` registration set matches the inventory 1:1, and the two native-only harness commands stay behind the feature gate with a separate allowlist. Production artifacts were proven hook-free by scanning actual produced outputs, with the feature-on artifacts observably rejected first.

## Execution and Commits

This plan executed in one session; no commit was made per the session contract. All changes stay uncommitted for the parent to land.

| Command | Disposition |
|---|---|
| node scripts/check-command-isolation.mjs --all --expected-count 365 | PASS (365 evidence rows, 365 production registrations, 2 native-only commands) |
| node --test scripts/check-command-isolation.test.mjs | 96/96 pass (was 91; +5 new plan-28 fixtures) |
| node scripts/check-command-isolation.mjs --plan 01..24 / --integration 29 | PASS in every mode after the merge |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full, default features) | 1756 passed, 0 failed, 3 ignored (clean rerun; see flake note) |
| cargo clippy --lib -- -D warnings and --features native-e2e | Passed (both configurations) |
| cargo fmt -- --check | Passed |
| cargo check -p maru-cli | Passed |
| make test-cli / make cli-smoke-debug | Passed (maru 1.1.3; doctor --quiet; skills dirty -> []) |
| pnpm test | 216 files, 2090 passed, 0 failed; node --test half 96/96 |
| pnpm typecheck / pnpm lint / pnpm lint:i18n | Passed (3768 keys in parity) |
| make verify | PASS, exit 0 (now includes check-command-isolation) |
| make release-checks | PASS, exit 0 (final attempt on a quiet machine; three earlier attempts under parallel load each hit a different timing-sensitive flake - see below) |
| pnpm tauri build --debug --no-bundle | Built src-tauri/target/debug/maru |
| node scripts/check-native-e2e-isolation.mjs --binary src-tauri/target/debug/maru | PASS, exit 0 (release-checks placement, before the debug prune) |
| node scripts/check-native-e2e-isolation.mjs (bundle half, native-e2e dist) | Rejected, exit 1 - all three bundle markers |
| node scripts/check-native-e2e-isolation.mjs --binary (feature binary) | Rejected, exit 1 - all five binary markers |

## What changed

- **Evidence merge (28-1).** Each of the 365 shard rows in `docs/performance/phase08-01.json`..`phase08-24.json` gained the final processingCaller closure (`classifier`, `successRetention`, `failureReasons`, `singleTerminalNoticeOwner: true`, `closureSource`) from the committed 08-26 caller audit, which was validated row-by-row for name/module/disposition consistency before merging (365/365 exact match, zero mismatches). Insertion was done as surgical text edits so the diff is 2190 insertions and 0 deletions - no committed evidence was reformatted.
- **Checker hardening (28-1).** `scripts/check-command-isolation.mjs` now rejects mutation rows whose evidence phrases an exact-path-only exclusion or an existing-domain-guard exemption (Shared mutation admission contract, P08-02), and requires `skills_sync_all_sources` in --all mode to keep its async spawn_blocking boundary and record its actual-wrapper same-runtime batch case. Five new fixtures in `scripts/check-command-isolation.test.mjs` prove each assertion fires (batch proof deleted/renamed, sync boundary, both exemption phrasings); the pre-existing 07 parent/child pair/order and processing-caller fixtures keep covering the rest of the plan's fixture list.
- **Inventory closure (28-1).** `08-COMMAND-INVENTORY.md` gained a **FINAL** disposition column for all 365 rows (356 ISOLATED / 9 UI, zero AUDIT) with owning-plan attribution, definition line numbers refreshed against current sources, and counts text updated to record the closure.
- **Merged audit (28-1).** `docs/performance/phase08-final.json` joins the 365 rows with the decision/source audit (D-01..D-05, PERF-01, PERF-02, D-09, D-10 each mapped to physical tests/native artifacts), the 29-integration overlay summary, ship-isolation evidence and the native responsiveness artifact list.
- **Artifact scanner extension (28-2).** `scripts/check-native-e2e-isolation.mjs` now also scans `dist/assets/*.js` and the produced binary for `native_e2e_async_probe` and `native_e2e_load_control` (per-needle violation messages), alongside the existing bridge namespace, plugin crate and hook-marker needles.
- **Hermetic wiring (28-2).** `make verify` gained `check-command-isolation` (the --all closure gate) after `build-frontend`; the native runtime gate stays in its release-preflight/release-checks placement. `docs/native-e2e.md` documents the harness shape, fixed fixtures, two-worker runtime, calibration/negative control, artifact paths and the exact normal-rebuild commands; README lists the closure gate command and the new verify coverage.

## Isolation proof sequence

1. **Feature-on rejection, bundle:** the native-e2e dist left by 08-27 failed the extended guard with exit 1, reporting `__MARU_NATIVE_E2E__`, `native_e2e_async_probe`, `native_e2e_load_control` in `dist/assets/index-*.js`.
2. **Feature-on rejection, binary:** `cargo build --features native-e2e` produced a binary the guard rejected with exit 1, reporting both plugin crate name forms, `MARU_NATIVE_RESPONSIVENESS_HOOK` and both command symbols.
3. **Normal artifacts pass:** `pnpm build:frontend` (bundle half self-scans, exit 0), then `touch src-tauri/build.rs && cargo build` (default features) and `--binary` scan exit 0. Re-verified inside the release chain against the tauri debug no-bundle binary before `clean:tauri-debug` pruned it.
4. **No leaks:** no leftover maru/wdio/webdriver test processes (the long-running Maru.app and kakao-relay processes predate this session and are user apps) and no `maru-native-e2e-*` or `maru-command-evidence-*` temp roots remain.

## Phase success criteria (ROADMAP Phase 8)

1. **Registry lock released over the network; removed source never resurrected.** `skills_sync_source` runs its network stage outside REGISTRY_LOCK with generation/incarnation revalidation; `src-tauri/src/skill_host/store.rs::tests::phase08_01_deleted_source_never_returns_at_all_three_edges` rejects with `unknown_source` at before_admission/network/before_commit edges and asserts no skill or source reappears, `adding_source_clears_removed_source_tombstone` pins the tombstone, and the 08-27 native PERF-02 case reproduced it against the real app.
2. **Every network/subprocess/unbounded-walk command off the main thread.** Final closure: 356 ISOLATED + 9 UI rows across all 365 commands (the 9 UI rows are platform-dispatch-bound with offload-only incidental I/O and positive affinity evidence). Structural enforcement is the checker itself (async registration, awaited spawn_blocking, no blocking work before the boundary, no blocking helper in retained chains), with per-row recorded behavioral evidence.
3. **Concurrency load test with flat unrelated latency.** The 08-27 native fixed run on a real 2-worker runtime: four overlapping real operations across three rounds, probe p95 2ms / parse p95 7ms / max stall 9ms / zero missing samples at maxConcurrent 4, with the blockingAsync negative control violating the frozen probe bound (loaded p95 4789ms vs 27ms) so the pass cannot be vacuous.

## Corrections and Evidence History

1. **--all closure failure resolved by merge, not gate weakening.** The gate failed at `08-01/skills_sync_source: final processingCaller missing classifier` because the 08-26 producer recorded the caller audit as a separate file. The merge preserved every committed value and added a `closureSource` back-reference per row.
2. **First full JSON re-serialization was reverted.** The initial merge rewrote all 24 shard files with standard formatting (4494 insertions / 2600 deletions); it was reverted and redone as text insertion to keep the evidence diff reviewable.
3. **Parallel-suite flakes under load (pre-existing, not from this plan).** Three single-command `make release-checks` attempts under heavy parallel load each stopped at a *different* timing-sensitive test: `web_actions::tests::repair_refuses_missing_or_mismatched_receipt_and_provider_linked_note`, `web_actions::tests::stale_blob_sha_marks_retry_needed_and_applies_nothing`, then `skill_host::bundle_update::tests::interrupted_channel_publication_keeps_active_revision_until_metadata_commit`. Each failed test passed standalone immediately, and full `cargo test --lib` runs passed 1756/0/3 repeatedly on a quiet machine. The release chain was also executed constituent-by-constituent to green, and the final `make release-checks` attempt on a quiet machine passed end to end with exit 0. The pattern is systemic test-isolation flakiness under load, not a regression from this plan (which changed no Rust); flagging for a future hardening pass, not papering over it here.

## Handoff and Limits

- `artifacts/native-responsiveness/*.json` remains untracked/local per 08-27; the fixed-run numbers quoted above come from those files and the 08-27 summary.
- The checker remains a drift gate: it validates evidence schema, registration parity and source scans; recorded behavioral evidence is not re-executed by the gate (its own output says so).
- Plans 08-29 (integration overlay producer) is complete and committed; this plan consumed its overlay as reference only.

## Threats and Self-Check

- T-08-28-01 (tampering): no mutation gate was loosened; two new rejection fixtures make exemption phrasings fail closed, and the merge added no new write paths.
- T-08-28-02 (denial of service): no scheduling or lifecycle change; the closure gate is a read-only source/evidence scan and the artifact scanner only reads produced outputs.
- T-08-28-03 (information disclosure): the merged final.json cites synthetic fixture paths and test names only; no credentials, live workspace paths or user data appear.

## Self-Check: PASSED

All checker modes pass on the live tree; the closure gate runs inside `make verify`; both halves of the isolation guard reject the feature-on artifacts and accept the normal ones with real exit codes; every plan-named verification command was executed with counts quoted above, and the final `make release-checks` passed end to end (exit 0); earlier red was only the pre-existing parallel-suite flake family under load (three different tests on three loaded runs, all green standalone and on quiet full reruns), and no gate, test or checker assertion was weakened to force closure. Changes remain uncommitted per the session contract.
