---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 1
current_phase_name: Trustworthy Verify Signal
status: executing
stopped_at: Completed 01-07-PLAN.md - Phase 1 fully executed, GATE-02 flipped, all 7 plans done
last_updated: "2026-08-22T10:12:57.572Z"
last_activity: 2026-08-22
last_activity_desc: Roadmap created from /gsd-ingest-docs intel + /gsd-map-codebase
progress:
  total_phases: 1
  completed_phases: 1
  total_plans: 7
  completed_plans: 7
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-22)

**Core value:** The filesystem stays the source of truth - everything Maru shows is derived from real files the user owns, and nothing is lost if Maru is uninstalled.
**Current focus:** Phase 1 - Trustworthy Verify Signal

## Current Position

Phase: 1 of 5 (Trustworthy Verify Signal)
Plan: 7 of 7 in current phase
Status: Ready to execute
Last activity: 2026-08-22 - Completed 01-01 (rust-toolchain.toml pin + fmt-check gate)

Progress: [██████████] 100%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: -

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

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

### Pending Todos

None yet.

### Blockers/Concerns

- No `.planning/config.json` exists; defaults assumed - granularity `standard`, `phase_id_convention` sequential, `project_code` null. Regenerate phase IDs if a config lands with different values.
- `src/App.tsx` has no test of any kind. Phases 4-5 depend on Phase 1's hook-dependency gate plus the per-pane tests written during extraction; there is no existing safety net for the decomposition.
- `make verify` runs on ubuntu-22.04 only and e2e runs Chromium against Vite with mocked IPC. Nothing in CI exercises WKWebView, the real PTY, IME input, or the macOS menu - macOS-affecting changes need a real-app run.
- make verify's fmt-check/clippy/build-frontend steps unverified end-to-end pending a concurrent session's hwped.rs/lib.rs work landing in this shared checkout; not caused by 01-06
- make verify's test-rust/fmt-check/clippy steps unverified end-to-end on this shared checkout pending the concurrent hwped session's work landing; not caused by 01-07. CI run on the committed tree is the authoritative composite check and is pending from the team lead

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Concurrency/Perf | PERF-01..04 (sync-command main thread, lock-across-network, poison recovery, watcher pruning) | v2 | 2026-08-22 |
| Security | SEC-01 CSP `script-src blob:` audit, SEC-02 sanitizer regression test | v2 | 2026-08-22 |
| Reliability | REL-01 SIGHUP-immortal terminal session | v2 | 2026-08-22 |
| Testing | TEST-01..04 (native Tauri E2E runner, coverage, remaining component tests, app_menu smoke) | v2 | 2026-08-22 |
| Product | HUB-01 Hub graph-metadata sync - the doc set's only explicit deferral | v2 | 2026-08-22 |

## Session Continuity

Last session: 2026-08-22T10:12:57.566Z
Stopped at: Completed 01-07-PLAN.md - Phase 1 fully executed, GATE-02 flipped, all 7 plans done
Resume file: None
