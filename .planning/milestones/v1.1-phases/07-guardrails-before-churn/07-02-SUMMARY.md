---
phase: 07-guardrails-before-churn
plan: 02
subsystem: concurrency
tags: [mutex-poisoning, poison-recovery, lock-recovery, perf-03, rust, tauri]

requires:
  - phase: 07-guardrails-before-churn
    provides: the phase's guardrails-before-churn framing and the fs.rs:216 recovery idiom precedent (D-03 position)
provides:
  - src-tauri/src/lock_recovery.rs — the shared recover_guard helper (one eprintln warn per recovery, D-01) with colocated unit tests
  - Poison recovery wired into all six named process-global locks across five files, each with a lock-specific D-03 justification comment
  - Retirement of the six poison error strings (zero live producers; only assertion-only test fixtures remain)
affects: [phase-08, phase-09, phase-10, perf-02, make-verify]

actuals:
  tokens: 3974
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "recover_guard(LockResult, module_tag, lock_name) -> MutexGuard: Ok arm returns unchanged; Err arm emits exactly one bracketed-tag eprintln warn and returns poisoned.into_inner()"
    - "Per-lock D-03 justification comments at the static declaration or acquisition site, each naming that lock's own disk-resident guarded state"
    - "into_inner recovery does not clear the poison flag: every later acquisition still returns Err and recovers again (repeated recoveries each emit one warn)"

key-files:
  created:
    - src-tauri/src/lock_recovery.rs
  modified:
    - src-tauri/src/lib.rs
    - src-tauri/src/skill_host/store.rs
    - src-tauri/src/jobs.rs
    - src-tauri/src/dot_sync.rs
    - src-tauri/src/evidence_binder.rs
    - src-tauri/src/terminal/mod.rs

key-decisions:
  - "Terminal lock names in warn lines use TERMINAL_SESSIONS / TERMINAL_RESERVATIONS / TERMINAL_KILLER so five sites emitting the two retired shared strings are distinguishable in stderr; the tag stays [terminal] per the plan"
  - "Source-assertion test for the exactly-one-warn invariant uses include_str! with split needles so the test's own source does not contain the counted tokens"
  - "Mutual-exclusion test calls Mutex::clear_poison after recovery so try_lock results isolate exclusion from poisoning (MSRV 1.77.2+, stable since 1.77.0)"

patterns-established:
  - "Poison recovery gate: any future lock may call recover_guard only with its own D-03 justification naming disk-re-derived guarded state; blanket into_inner() on invariant-bearing state remains prohibited (PERF-03 out-of-scope)"

requirements-completed: [PERF-03]

coverage:
  - id: D1
    description: "recover_guard returns the guard on Ok with no warn and on Err(poisoned) with exactly one bracketed-tag stderr warn line; poisoned fresh mutex recovers to a usable guard"
    requirement: PERF-03
    verification:
      - kind: unit
        ref: "src-tauri/src/lock_recovery.rs#clean_lock_returns_usable_guard, poisoned_lock_recovers_to_usable_guard, helper_emits_exactly_one_warn_line (cargo test --lib lock_recovery: 4 passed)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Recovered guard preserves mutual exclusion: a second acquirer blocks until the recovered guard drops"
    requirement: PERF-03
    verification:
      - kind: unit
        ref: "src-tauri/src/lock_recovery.rs#recovered_guard_preserves_mutual_exclusion (clear_poison + try_lock isolation)"
        status: pass
    human_judgment: false
  - id: D3
    description: "REGISTRY_LOCK, JOBS_LOCK, DOT_ACTION_LOCK, BINDER_WRITE_LOCK recover via recover_guard with lock-specific D-03 justifications; signatures, guard scopes, and INSPECTION_CACHE unchanged"
    requirement: PERF-03
    verification:
      - kind: unit
        ref: "cargo test --lib skill_host (107), jobs (13), dot_sync (4), evidence_binder (15) all green; cargo clippy --lib -- -D warnings exit 0"
        status: pass
      - kind: other
        ref: "grep: skills_registry_lock_poisoned / jobs_lock_poisoned / dot_action_lock_poisoned / evidence_binder_lock_poisoned each zero hits in their lock files; INSPECTION_CACHE byte-untouched (git diff context lines only)"
        status: pass
    human_judgment: false
  - id: D4
    description: "All five terminal acquisition sites recover; killer keeps closing latched per D-02 (existing PTY sessions kept, new commands keep working)"
    requirement: PERF-03
    verification:
      - kind: unit
        ref: "cargo test --lib terminal (76 passed); cargo test --lib default threads (1253 passed — no process-global static left poisoned)"
        status: pass
      - kind: other
        ref: "grep: terminal_killer_poisoned / terminal_registry_poisoned zero hits in terminal/mod.rs; recovered killer arm has no closing.store(false) (only the kill-failure arm does)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Six retired poison strings exist only as assertion-only fixtures and both still pass"
    requirement: PERF-03
    verification:
      - kind: unit
        ref: "src/lib/ipcError.test.ts:10 negative assertion within pnpm test run (1974 passed)"
        status: pass
      - kind: other
        ref: "repo-wide grep over src-tauri/src and src returns exactly the two assertion-only hits (src-tauri/src/ipc_error.rs:237-238, src/lib/ipcError.test.ts:10); cargo test --lib covers the ipc_error.rs legacy test"
        status: pass
    human_judgment: false

duration: 11min
completed: 2026-09-05
status: complete
---

# Phase 7 Plan 2: PERF-03 Lock Poison Recovery Summary

**A shared `recover_guard` helper converts the six named process-global locks from poison-bricking (`*_poisoned` error until app restart) to poison-recovering, each with its own co-located D-03 justification and exactly one `[module]` stderr warn line per recovery.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-09-05T00:36:13Z
- **Completed:** 2026-09-05T00:47:00Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- `src-tauri/src/lock_recovery.rs` lands `recover_guard`: Ok arm returns the guard unchanged, Err arm emits one `eprintln!("[{tag}] {name} was poisoned; recovering guard")` and returns `poisoned.into_inner()`. The module doc pins the contract — unit mutexes guarding disk-re-derived state only, per-call-site D-03 justification required — which is the guard against T-7-04 blanket recovery.
- All six locks recover: REGISTRY_LOCK (store.rs), JOBS_LOCK (jobs.rs), DOT_ACTION_LOCK (dot_sync.rs), BINDER_WRITE_LOCK (evidence_binder.rs, both inline sites), and the terminal reservations/sessions/killer locks (five acquisition sites in terminal/mod.rs). Each carries a justification naming its own guarded state; INSPECTION_CACHE and every other `*_poisoned` string in the crate are byte-untouched.
- Terminal recovery honors D-02: the recovered killer arm keeps `closing` latched exactly like the Ok arm (no `closing.store(false, ...)` on the recovered path), so existing PTY sessions stay and new commands keep working.
- The six retired strings (`skills_registry_lock_poisoned`, `jobs_lock_poisoned`, `dot_action_lock_poisoned`, `evidence_binder_lock_poisoned`, `terminal_killer_poisoned`, `terminal_registry_poisoned`) have zero live producers; the only remaining references are the two assertion-only fixtures (`ipc_error.rs:237-238` legacy test, `ipcError.test.ts:10` negative assertion), both still green.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: failing recovery tests** - `4b302d8` (test)
2. **Task 1 GREEN: recover_guard + REGISTRY_LOCK wiring** - `a466523` (feat)
3. **Task 2: JOBS_LOCK / DOT_ACTION_LOCK / BINDER_WRITE_LOCK recovery** - `27164f9` (feat)
4. **Task 3: terminal five-site recovery + string retirement sweep** - `0aa46e8` (feat)

_Note: Task 1 is a tdd="true" tracer, so it carries RED + GREEN commits per the TDD task flow. The tracer verify re-ran green end-to-end before expansion._

## Files Created/Modified
- `src-tauri/src/lock_recovery.rs` — the shared recovery helper + 4 colocated tests on fresh `Arc<Mutex<()>>` values (new)
- `src-tauri/src/lib.rs` — `mod lock_recovery;` between `linter` and `maru_dir` (strictly alphabetical)
- `src-tauri/src/skill_host/store.rs` — REGISTRY_LOCK D-03 comment + `registry_guard` recovery; signature unchanged
- `src-tauri/src/jobs.rs` — JOBS_LOCK D-03 comment + `jobs_guard` recovery
- `src-tauri/src/dot_sync.rs` — DOT_ACTION_LOCK D-03 comment + inline recovery in `run_dot_action`
- `src-tauri/src/evidence_binder.rs` — BINDER_WRITE_LOCK D-03 comment + both inline recoveries; INSPECTION_CACHE untouched
- `src-tauri/src/terminal/mod.rs` — five acquisition sites recover; D-02 closing semantics preserved

## Decisions Made
- Terminal warn-line lock names are `TERMINAL_SESSIONS` / `TERMINAL_RESERVATIONS` / `TERMINAL_KILLER` so the five sites that shared two retired strings are distinguishable in stderr; the module tag stays `[terminal]` per the plan.
- The exactly-one-warn test asserts by source via `include_str!` with split needles (`concat!("epri", "ntln!")`), so the test's own text never contains the counted tokens; stderr capture was not attempted (per plan).
- The mutual-exclusion test calls `Mutex::clear_poison()` after recovery so `try_lock` results isolate exclusion from the persistent poison flag (the flag survives `into_inner` recovery by design — every later acquisition recovers again and emits its own warn, which the poisoned-path test also asserts).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Initial tests assumed into_inner recovery clears the poison flag**
- **Found during:** Task 1 GREEN (first run: 3 of 4 tests failed)
- **Issue:** The tests asserted `mutex.lock().is_ok()` after recovering and dropping the guard. `PoisonError::into_inner()` recovers the guard but does not clear the poison flag — every later `lock()` still returns `Err`. That is the intended production shape (callers route every acquisition through `recover_guard`; repeated recoveries each emit one warn), so the tests, not the helper, were wrong.
- **Fix:** Re-asserted the real contract: after recovery the mutex still reads `lock().is_err()`, and `recover_guard` keeps returning usable guards on every subsequent acquisition.
- **Files modified:** src-tauri/src/lock_recovery.rs
- **Verification:** `cargo test --lib lock_recovery` 4/4 green
- **Committed in:** `a466523` (GREEN commit)

**2. [Rule 1 - Bug] Source-assertion test counted its own comment/doc tokens**
- **Found during:** Task 1 GREEN (warn-count test failed with counts 3 and 2 instead of 1)
- **Issue:** `helper_emits_exactly_one_warn_line` counts `eprintln!` / the warn text in `include_str!` of its own file; the module doc and the function doc comment contained those literals, inflating the counts.
- **Fix:** Reworded the doc comments to describe the line without quoting it; the test needles stay split (`concat!`) so only the helper's single real occurrence is counted.
- **Files modified:** src-tauri/src/lock_recovery.rs
- **Verification:** count assertions equal 1 exactly; 4/4 green
- **Committed in:** `a466523` (GREEN commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1, both inside the tracer's test file)
**Impact on plan:** Neither deviation touched production code beyond the plan; both corrected the test harness's assumptions to match real poisoning semantics. Recovery behavior matches the plan's `<behavior>` bullets exactly.

## TDD Gate Compliance

- RED gate: `test(07-02)` commit `4b302d8` (failing — unresolved `recover_guard`, verified by cargo exit failure)
- GREEN gate: `feat(07-02)` commit `a466523` (tests pass)
- No REFACTOR commit needed (no cleanup beyond fmt)

## Issues Encountered
- None beyond the two test-harness deviations above. `pnpm test -- ipcError` ran the full vitest suite (1974 tests, all green), which covers the negative assertion with margin.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- PERF-03 is live: a panic under any of the six locks now costs one stderr warn line instead of bricking the feature until app restart. Phases 8-10 churn lands on this safety net.
- Recovery is deliberately NOT extended to the other `*_poisoned` strings (approval, mission_state, today_*, telegram, gap, agent_host, terminal model/resize/master/writer) — those guard invariant-bearing or non-disk-re-derived state and stay poison-bricking by design. Any future addition to the recovery set needs its own D-03 justification (the helper's module doc is the enforcement point).
- Full `make verify` composite not run here (Rust + build chain); every gate this plan owns was verified individually (module suites, full `cargo test --lib` at default threads, clippy, fmt, pnpm test). CI is the authoritative composite check.

## Self-Check: PASSED
- src-tauri/src/lock_recovery.rs exists: FOUND
- Commits 4b302d8 / a466523 / 27164f9 / 0aa46e8 present in git log: FOUND
- Plan-level verification re-run after all tasks: `cargo test --lib lock_recovery` 4/4; `cargo test --lib` 1253 passed (default threads — no process-global static poisoned); `cargo clippy --lib -- -D warnings` exit 0; `cargo fmt --check` exit 0; `pnpm test` 1974 passed (includes ipcError.test.ts:10 negative assertion); repo-wide grep for the six retired strings returns exactly the two assertion-only hits.

---
*Phase: 07-guardrails-before-churn*
*Completed: 2026-09-05*
