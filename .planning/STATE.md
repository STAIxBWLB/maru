---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 03
current_phase_name: typed-ipc-error-contract
status: executing
stopped_at: Completed 03-04-PLAN.md
last_updated: "2026-08-23T14:18:18.980Z"
last_activity: 2026-08-23
last_activity_desc: Phase 03 plan 03 complete - frontend IPC error branch sites migrated to err.code, todayErrorCode retired
progress:
  total_phases: 3
  completed_phases: 3
  total_plans: 14
  completed_plans: 14
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-23)

**Core value:** The filesystem stays the source of truth - everything Maru shows is derived from real files the user owns, and nothing is lost if Maru is uninstalled.
**Current focus:** Phase 03 - Typed IPC Error Contract

## Current Position

Phase: 03 (Typed IPC Error Contract) - EXECUTING
Plan: 4 of 4 complete (03-01, 03-02, 03-03); wave 3 (03-04) next
Status: Ready to execute
Last activity: 2026-08-23 - 03-03 frontend branch-site migration landed; ERR-01/ERR-03 marked complete

Progress: [██████████] 100% (3/4 plans)

## Performance Metrics

**Velocity:**

- Total plans completed: 10
- Average duration: -
- Total execution time: -

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 7 | - | - |
| 2 | 3 | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 8min | 2 tasks | 2 files |
| Phase 01 P02 | 37min | 3 tasks | 42 files |
| Phase 01-trustworthy-verify-signal P03 | 51min | 3 tasks | 2 files |
| Phase 01 P04 | 20min | 4 tasks | 7 files |
| Phase 01 P05 | 15min | 3 tasks | 8 files |
| Phase 01-trustworthy-verify-signal P06 | 20min | 3 tasks | 4 files |
| Phase 01-trustworthy-verify-signal P07 | 70min | 3 tasks | 30 files |
| Phase 02 P01 | 9min | 3 tasks | 6 files |
| Phase 02 P02 | 5min | 3 tasks | 4 files |
| Phase 02 P03 | 7min | 2 tasks | 3 files |
| Phase 03 P02 | ~50min | 2 tasks | 6 files |
| Phase 03 P03 | 15min | 2 tasks | 9 files |
| Phase 03 P04 | ~35min | 2 tasks | 0 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Milestone 1 is structural debt paydown scoped to the Tech Debt section of `.planning/codebase/CONCERNS.md`; no feature work
- Verification gates land in Phase 1 before the App.tsx decomposition, because moving 68 `useState` / 50 `useEffect` without a hook-dependency gate reproduces #260/#262/#264
- The 64 SPEC constraints are invariants to preserve, not features to build; 0 ADRs means none is decision-locked and a future ADR can override any of them
- [Phase 1]: Pinned rust-toolchain.toml to rustc 1.98.0, resolved live via rustup update stable (D-11), not the RESEARCH.md-predicted value
- [Phase 1]: Re-measured clippy count on rustc 1.98.0 matched RESEARCH.md's 75 exactly; 36 auto-fixed via cargo clippy --fix, 39 fixed by hand with zero suppression attributes added
- [Phase 1]: Two too_many_arguments violations on #[tauri::command] IPC boundaries fixed by bundling params into a struct and updating the paired frontend invoke() call in the same commit, rather than adding a new allow(clippy::too_many_arguments)
- [Phase 1]: D-12 held under empirical proof: retain-on-failure captured a first-attempt trace with zero retries in a real CI run (GATE-04)
- [Phase 1]: GATE-04's CI proof required workflow_dispatch, not a branch push, since ci.yml's push trigger is scoped to branches: [main]
- [Phase 1]: skill-name-drift deleted outright from TODO_LEDGER (not marked done) - GATE-07 requires the shipped ledger to list only open items
- [Phase 1]: @types/node@22.20.1 approved at the blocking-human package-legitimacy checkpoint after independent live npm registry re-verification (349.7M weekly downloads, DefinitelyTyped repo)
- [Phase 1]: tsconfig.e2e.json left composite:true out, deviating from the plan's literal action text - it introduced a spurious TS6307 project-boundary error (e2e/workbench-layout.spec.ts importing src/lib/settings.ts) unrelated to the real e2e type backlog; tsc -b accepts the solution-file reference without it
- [Phase 1]: GATE-03 not marked complete in REQUIREMENTS.md - it is one requirement spanning e2e/ and scripts/, and plan 01-04 only finishes the e2e/ half; scripts/ is plan 01-05
- [Phase 1]: Kept composite: true on tsconfig.scripts.json (unlike 01-04's tsconfig.e2e.json deviation); scripts/ has no cross-project import so the TS6307 boundary error 01-04 hit never triggers
- [Phase 1]: Re-measured scripts/ error count: 42 across 8 files, not RESEARCH.md's stored 44/9; all 42 traced to one destructured-options JSDoc-inference gap
- [Phase 1]: GATE-03 marked complete in REQUIREMENTS.md: 01-05 finishes the scripts/ half 01-04 deliberately left open
- [Phase 1]: eslint@10.9.0, typescript-eslint@8.67.0, eslint-plugin-react-hooks@7.1.1 approved at the blocking-human legitimacy checkpoint after independent live-registry re-verification
- [Phase 1]: App.tsx re-measured at 22 real violations (13 no-unused-vars + 9 exhaustive-deps), not the plan's 12+10; deleting one dead useCallback retired a no-unused-vars fix and its paired exhaustive-deps violation together, landing the final committed split at 12+8
- [Phase 1]: make verify's fmt-check failed solely on a concurrent unrelated session's Rust files (hwped.rs, lib.rs) sharing this checkout; reported and not diagnosed per the team lead's instruction, everything in 01-06's own scope (typecheck, test, eslint, cargo test --lib) verified green independently
- [Phase 1]: src/ backlog re-measured at exactly 52 errors + 7 warnings across 28 files, matching 01-06's prediction; e2e/ needed zero fixes (already ESLint-clean and typecheck-clean before this plan touched it)
- [Phase 1]: 12 separate eslint-disable-next-line directives added in one TerminalPanel.tsx unmount-cleanup block (one per ref read ESLint reports independently), not a single block-level disable, to keep every directive individually load-bearing
- [Phase 1]: Positional/required-interface unused args (favoriteIds, settings, warnings, hdbg, headerBg) renamed with a leading underscore rather than deleted, since deletion would have required touching call sites or type signatures outside this plan's fix-not-rewrite mandate
- [Phase 1]: GATE-02 flipped - make lint added to the verify prerequisite list immediately after typecheck, proven red-then-green on both react-hooks/exhaustive-deps and no-unused-vars via deliberate break-and-revert on src/components/today/useTodayTasks.ts
- [Phase 1]: Full make verify could not be proven green on the shared checkout - test-rust failed on 12 outlook_mso timeout tests racing a concurrent session's own cargo test --workspace process, and cargo clippy/fmt-check both fail solely inside the concurrent session's uncommitted src-tauri/src/hwped.rs; neither traces to this plan's diff (zero Rust files touched). Each gate this plan owns was verified individually instead (make lint both directions, pnpm typecheck, pnpm test, make test-e2e, all green); CI is the authoritative composite check, to be triggered by the team lead
- [Phase ?]: [Phase 2]: mod paths; registered between outlook_mso and project_activity (true alphabetical, rustfmt-verified) - plan-stated ops_catalog/outlook_mso slot violates the strictly-alphabetical registry convention
- [Phase ?]: [Phase 2]: vault.rs could_include_dot_folder_named deleted (lost its only caller when rg_visibility went unconditional) rather than kept as dead code under the clippy gate
- [Phase ?]: [Phase 2]: ensure_within error message kept byte-identical (Path escapes the .maru directory) - live user-visible string in a behavior-preserving phase (RESEARCH Pitfall 4)
- [Phase ?]: [Phase 2]: 02-02 union-proof fixture leaves written as .md documents instead of the plan's literal .pyc/extensionless/.py leaves - scan_vault only collects md/markdown/html/htm, so the literal fixture could never go red and the SCAN-02 proof required the change
- [Phase ?]: [Phase 2]: 02-03 guard shape - maru_home()/install_root_base() restructured to a single exit wrapped in require_absolute, so a future early-return cannot bypass the check without restructuring the exit
- [Phase ?]: [Phase 2]: 02-03 env_root()/skills_root() get no separate guard - they derive from maru_home() and are covered transitively; duplicating the check would re-fragment the invariant
- [Phase ?]: [Phase 2]: 02-03 require_absolute's temporary allow(dead_code) removed in the same commit the first consumer landed - closes WINDOWS.md ledger entry 1
- [Phase 3]: 03-01 ratified the 7-command branch-on scope over CONTEXT's "four commands" wording - same four codes, seven commands; graph_link_apply stays display-only and OUT
- [Phase 3]: 03-01 ERR-04 pre-migration baseline measured at B = 1138 before any edit, matching the planning-time figure; 03-02 records against B-10 and 03-04 asserts within [B-20, B]
- [Phase 3]: 03-01 leaves `cargo clippy -- -D warnings` transiently red on three not-yet-consumed code constants rather than adding a suppression attribute - the phase prohibition holds and 03-02 clears it
- [Phase 3]: 03-01's human-verify checkpoint was approved without per-step smoke observations being reported back, so no real-app evidence exists for the migrated path yet
- [Phase ?]: [Phase 3]: 03-02 found web_actions.rs (not in the plan's file list) calls today_mutate and task_transition directly; its call sites and one internal conflict-code branch needed the same map_err adapter / code-based check as the plan's own adapter sites, added as Rule 3 fallout
- [Phase ?]: [Phase 3]: 03-02 also fixed document.rs's update_frontmatter_field (uncalled out in PATTERNS.md), which calls assert_expected_revision directly and needed the same map_err adapter as today_apply_plan_result
- [Phase ?]: [Phase 3]: 03-02 measured the post-migration ERR-04 count at 1128, exactly B-10 against 03-01's baseline B=1138, confirming no signature outside the 10-item migration set changed
- [Phase ?]: [Phase 3]: 03-02 migrated eleven prefix-string test assertions, not the six PATTERNS.md/PLAN.md enumerated by line number, since every unwrap_err() on a migrated command now yields IpcError regardless of which error path fired
- [Phase ?]: All three today_conflict fixture throw sites migrated to raw wire shape (not just the two the plan named by line), keeping the one-normalization-point invariant intact
- [Phase ?]: ERR-01 and ERR-03 marked complete after verifying all four contract codes have a frontend reader and the residual substring-matcher grep is zero; ERR-02 left open for 03-04's formal two-sided rename drill
- [Phase ?]: ERR-02 drill extended to three sub-drills (Rust value pin, Rust name/build, TS union/tsc) so the web_actions.rs:860 branch site is proven build-protected, not just the pin test

### Scope Exceptions

- **hwp-editor bridge (`hwped_*`), recorded 2026-08-23.** Six Tauri commands
  (`src-tauri/src/hwped.rs`, wrappers in `src/lib/hwped.ts`) spawning the `hwp`
  binary landed from a parallel track while this milestone was running. They are a
  new product feature, which the milestone charter excludes, so they are recorded
  here as an adopted exception rather than milestone work: this milestone owns the
  gate signal, not the feature. Phases 1 and 2 each reported `make verify` as
  unprovable locally because this file failed `clippy` and `fmt-check` while
  untracked (`01-06-SUMMARY.md`, `01-07-SUMMARY.md`, `02-02-SUMMARY.md`); those two
  clippy findings and the formatting diffs are fixed in the same commit that adopts
  it, so the composite gate runs against the same tree CI sees.

- The bridge's error strings (`cli_missing:`, `hwp_timeout:`, `hwp_failed:`,
  `hwp_parse_failed:`, `hwped_bad_request:`) stay `Result<T, String>` and are
  **exempt from the Phase 3 typed contract**. `src/lib/hwped.ts` contains no error
  branching at all, so they are display-only - exactly the class ERR-04 protects
  from migration.

- Still owed, deliberately deferred until the hwp-editor implementation track
  reports complete: the Phase 2.1 planning artifacts, the HWPE-01..03 requirement
  registration, and the Semantica Phases 6-9 roadmap entries drawn from
  `docs/semantica-adoption-plan.md`.

### Pending Todos

None yet.

### Blockers/Concerns

- **Phase 3's ERR-04 count band is coupled to `hwped.rs`.** The pinned command reports 1,138, and `hwped.rs` contributes 19 of those matches; without it the tree reads 1,119 and the post-migration count lands at 1,109, below `03-04-PLAN.md`'s `[1118, 1138]` band. The baseline is now anchored to a commit rather than a date - re-confirmed 2026-08-23 on the committed tree at 34f96ee - and `03-02`/`03-04` cite that provenance. Residual risk: the hwp-editor track is still active, so `03-04` now requires a re-measurement at the start of the plan rather than treating drift as exceptional.
- `src/App.tsx` has no test of any kind. Phases 4-5 depend on Phase 1's hook-dependency gate plus the per-pane tests written during extraction; there is no existing safety net for the decomposition.
- `make verify` runs on ubuntu-22.04 only and e2e runs Chromium against Vite with mocked IPC. Nothing in CI exercises WKWebView, the real PTY, IME input, or the macOS menu - macOS-affecting changes need a real-app run.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Concurrency/Perf | PERF-01..04 (sync-command main thread, lock-across-network, poison recovery, watcher pruning) | v2 | 2026-08-22 |
| Security | SEC-01 CSP `script-src blob:` audit, SEC-02 sanitizer regression test | v2 | 2026-08-22 |
| Reliability | REL-01 SIGHUP-immortal terminal session | v2 | 2026-08-22 |
| Testing | TEST-01..04 (native Tauri E2E runner, coverage, remaining component tests, app_menu smoke) | v2 | 2026-08-22 |
| Product | HUB-01 Hub graph-metadata sync - the doc set's only explicit deferral | v2 | 2026-08-22 |

## Session Continuity

Last session: 2026-08-23T14:18:18.972Z
Stopped at: Completed 03-04-PLAN.md
Resume file: None
