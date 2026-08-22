---
phase: 02-shared-scanner-and-path-invariants
plan: "03"
subsystem: infra
tags: [rust, path-invariants, scanner, skill-host, security]

requires:
  - phase: 02-shared-scanner-and-path-invariants
    plan: "01"
    provides: src-tauri/src/paths.rs require_absolute — the guard predicate this plan wires into the home-root constructors
provides:
  - skill_host/fs.rs maru_home()/install_root_base() guarded by crate::paths::require_absolute on every return path (SCAN-04, D-08/D-09)
  - Regression test skill_host::fs::tests::maru_home_rejects_relative_test_home (relative MARU_TEST_HOME → Err ×3, no cwd tree)
  - Stray Users/ tree deleted from the repo root (SCAN-05, same plan as the guard per D-10)
affects: [skill_host consumers of maru_home/env_root/skills_root/install_root_base — all 15 call sites compile unchanged]

actuals:
  tokens: 1088
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Absolute-base guard: home-root constructors validate their FINAL value via crate::paths::require_absolute on every return path, Err-only (D-08) — one check covers both the test-override and production branches (Pitfall 6)"

key-files:
  created: []
  modified:
    - src-tauri/src/skill_host/fs.rs
    - src-tauri/src/paths.rs
  deleted:
    - Users/ (untracked stray tree — no git ceremony)

key-decisions:
  - "Guard shape: both constructors restructured to a single exit wrapped in require_absolute (single-exit preferred per the plan's action text), rather than wrapping each Ok(...) return — one guard call per function, impossible to add a future unguarded early-return without touching it"
  - "env_root()/skills_root() deliberately get no separate guard — they derive from maru_home() and are covered transitively; duplicating the check would re-fragment the invariant (must_haves.prohibitions)"
  - "require_absolute's temporary #[allow(dead_code)] removed in the same commit the first consumer landed — closes WINDOWS.md ledger entry 1 (02-01 pattern: allow removed with the rewire)"

requirements-completed: [SCAN-04, SCAN-05]

coverage:
  - id: D1
    description: "maru_home() and install_root_base() return Err when the resolved home base is not absolute, on every return path including the test-override branch"
    requirement: SCAN-04
    verification:
      - kind: unit
        ref: "src-tauri/src/skill_host/fs.rs#skill_host::fs::tests::maru_home_rejects_relative_test_home (red-then-green pair below)"
        status: pass
    human_judgment: false
  - id: D2
    description: "No directory tree materializes in the process cwd when the guard fires"
    requirement: SCAN-04
    verification:
      - kind: unit
        ref: "same test — asserts !Path::new(\"relative-home\").exists() after the three constructor calls"
        status: pass
    human_judgment: false
  - id: D3
    description: "Stray Users/ tree deleted from the repo root in the same plan as the guard; verified by filesystem and git checks"
    requirement: SCAN-05
    verification:
      - kind: filesystem
        ref: "test ! -e Users && git status --porcelain -- Users/ empty && git ls-files Users/ empty (all exit 0 post-delete)"
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-08-22
status: complete
---

# Phase 2 Plan 03: SCAN-04 Absolute-Base Guard + SCAN-05 Stray-Tree Delete Summary

**maru_home() and install_root_base() now validate their final value with crate::paths::require_absolute — Err on every return path, proven red-then-green by a regression test that also asserts no tree materializes in the cwd — and the stray Users/ tree at the repo root is deleted in the same plan (D-10).**

## Performance

- **Duration:** 7 min
- **Started:** 2026-08-22T21:54:07Z
- **Completed:** 2026-08-22T22:01:04Z
- **Tasks:** 2
- **Files modified:** 2 modified, 1 untracked tree deleted (Users/)

## Accomplishments

- **SCAN-04 guard (Task 1):** `maru_home()` and `install_root_base()` restructured to a single exit wrapped in `crate::paths::require_absolute(base)` — the FINAL value is validated on every return path, including the test-override early-return branch (D-08/D-09, Pitfall 6). Err-only: no `assert!`, no `panic`, no `debug_assert!` anywhere in the guard path. `env_root()`/`skills_root()` derive from `maru_home()` and are covered transitively — no duplicated check.
- **Regression test (Task 1, TDD red→green):** `skill_host::fs::tests::maru_home_rejects_relative_test_home` sets `MARU_TEST_HOME=relative-home` under `test_maru_home_lock()`, restores the previous env value on all paths (fixture Drop idiom), and asserts all three constructors (`maru_home`, `env_root`, `install_root_base`) return `Err` and that `!Path::new("relative-home").exists()`.
- **Dead-code allowance retired:** the temporary `#[allow(dead_code)]` on `require_absolute` in paths.rs removed in the GREEN commit — its first consumer landed; WINDOWS.md ledger entry 1 marked fixed.
- **SCAN-05 (Task 2):** stray `Users/` tree deleted from the repo root after safety checks confirmed it fully untracked and matching the expected stray shape (regenerable tooling caches only).

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: failing regression test for relative MARU_TEST_HOME** - `2ac1bc6` (test)
2. **Task 1 GREEN: require_absolute guard on both constructors + allow(dead_code) removal** - `60a9d0b` (feat)
3. **Task 2: Users/ deletion** — no commit: the tree was fully untracked (verified by `git ls-files Users/` returning empty pre-delete), so `rm -rf Users/` produces no git change by design (plan: "No git ceremony")

**Plan metadata:** recorded below (docs commit)

## Test Count Evidence

- **Baseline (post-02-02, HEAD d1d2339):** 1212 passed, 0 failed, 3 ignored (1211 from 02-01 + 1 vault union-proof test from 02-02)
- **Final (after Task 1 GREEN):** **1213 passed, 0 failed, 3 ignored** — delta over the 02-01 baseline is exactly **+2**: +1 from 02-02 (already run — ordering: 02-02 first, then 02-03) and +1 from this task's new test. This matches the plan's allowed delta (+2 when 02-02 has run first).
- **Red-then-green proof (Task 1):**
  - RED run (test against unguarded code, commit `2ac1bc6`): `test result: FAILED. 2 passed; 1 failed` — `skill_host::fs::tests::maru_home_rejects_relative_test_home` panicked at `src/skill_host/fs.rs:288:9` with:
    ```
    maru_home() must reject a relative base, got: Ok("relative-home/.maru")
    ```
    — proving the unguarded override branch returned `Ok` on a relative base.
  - GREEN run (after the guard, commit `60a9d0b`): `test result: ok. 3 passed; 0 failed` for the full `skill_host::fs` module, including the new test.
- **Post-delete suite (Task 2 acceptance):** full `cargo test --lib` re-run after `rm -rf Users/`: `test result: ok. 1213 passed; 0 failed; 3 ignored` — the deleted tree was never a build input.
- **Owned-gate checks (Task 1 acceptance greps):**
  - `grep -c 'require_absolute' src-tauri/src/skill_host/fs.rs` → **3** (1 import + 2 guard call sites; ≥ 2 required)
  - `grep -c 'use crate::paths::require_absolute' src-tauri/src/skill_host/fs.rs` → **1**
  - `grep -n 'debug_assert\|assert!' src-tauri/src/skill_host/fs.rs` → only test-body assertions at fs.rs:298–311 (the regression test itself); zero assertion macros in the guard path — guard is Err-only (D-08)

## SCAN-05 Deletion Evidence

- **Pre-delete `git ls-files Users/`** → empty output, exit 0 (tree fully untracked — no tracked path, so no checkpoint required)
- **Pre-delete `find Users -maxdepth 3 -type d`** →
  ```
  Users
  Users/yj.lee
  Users/yj.lee/.maru
  Users/yj.lee/.maru/env
  ```
  Deeper listing (`-maxdepth 6`) showed `Users/yj.lee/.maru/env/node_modules/{@types,@playwright,.bin,@blocknote,@codemirror,@vitejs,@tauri-apps,@radix-ui,@sigma,...}` — the expected stray shape: regenerable tooling caches, no authored content (RESEARCH Runtime State Inventory).
- **Post-delete:** `test ! -e Users` exit 0; `git status --porcelain -- Users/` empty; `git ls-files Users/` empty — all three checks pass.

## Files Created/Modified

- `src-tauri/src/skill_host/fs.rs` — `use crate::paths::require_absolute;` added; `maru_home()` and `install_root_base()` restructured to single-exit guarded returns; new regression test `maru_home_rejects_relative_test_home` in the existing `mod tests`
- `src-tauri/src/paths.rs` — temporary `#[allow(dead_code)]` (and its comment) removed from `require_absolute`; first consumer landed
- `Users/` — deleted (was untracked; filesystem-level removal only)

## Decisions Made

- **Single-exit guard shape:** both constructors bind the final value to `base` and end with `require_absolute(base)` rather than wrapping each `Ok(...)` return — one guard call per function means a future early-return cannot bypass the check without restructuring the exit (the plan accepted either shape and preferred single-exit for readability)
- **No guard on env_root()/skills_root():** they call `maru_home()?`, so the Err propagates transitively; a separate check would duplicate the invariant the phase exists to unify (must_haves.prohibitions)
- **All 15 downstream call sites untouched:** they already propagate `Result` (`?` / let-else); the guard changes only the error-production side, so the compile check across the full lib build is the compatibility proof (must_haves.truths)

## Deviations from Plan

None — the plan executed exactly as written. Both tasks' actions, verification, and acceptance criteria were followed literally; the guard shape chosen (single-exit) was one of the two shapes the plan explicitly allowed and its stated preference.

## Issues Encountered

- **Concurrent-session gate failures (out of scope, Phase 1/02-01 precedent):** `cargo clippy -- -D warnings` fails on exactly 2 errors, both in the concurrent hwped session's uncommitted `src-tauri/src/hwped.rs` (`needless_borrow` :164, `useless_format` :381) — byte-identical to the failure set 02-01 recorded. `cargo fmt --check` diffs likewise come solely from `hwped.rs`. Owned files proven individually green: `rustfmt --edition 2021 --check` passes on `src/skill_host/fs.rs` and `src/paths.rs`, the clippy error list contains zero entries outside hwped.rs, the full `cargo test --lib` suite is green (1213/0), and the production lib build is warning-free. CI is the authoritative composite.
- **Pre-existing test-build warnings (out of scope):** the test target emits 4 pre-existing warnings in `today_ai.rs` (unused import, cfg(test)) and `scheduler.rs` (dead code) — present before this plan's diff, untouched here per the scope boundary.

## Threat Flags

None — the plan's threat register covered all touched surface: T-02-07 (guard on the home-root constructors) mitigated by Task 1, T-02-08 (env-mutating test racing parallel tests) mitigated by the test's lock + restore-on-all-paths fixture. The regression test ran inside the full 1213-test suite with no interference. No new endpoints, auth paths, or trust-boundary schema changes introduced.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 02 is complete with this plan: the shared union (02-01/02-02), canonical containment helper (02-01), and the absolute-base guard (02-03) are all landed; WINDOWS.md is at `open_count: 0`.
- Watch-item carried forward unchanged: the concurrent hwped session's uncommitted files (`hwped.rs`, hwped hunks in `lib.rs`, `src/lib/hwped.ts`) remain in the tree; future work on this checkout must keep staging only owned files and treating their clippy/fmt failures as out-of-scope.
- Downstream callers of `maru_home()`/`install_root_base()` now inherit a hard failure on non-absolute bases; if any future test or host environment legitimately sets a relative `MARU_TEST_HOME`, it will fail loudly by design.

---
*Phase: 02-shared-scanner-and-path-invariants*
*Completed: 2026-08-22*

## Self-Check: PASSED

- FOUND: .planning/phases/02-shared-scanner-and-path-invariants/02-03-SUMMARY.md
- FOUND: src-tauri/src/skill_host/fs.rs (guarded constructors, committed in 60a9d0b)
- FOUND: src-tauri/src/paths.rs (allow(dead_code) removed, committed in 60a9d0b)
- CONFIRMED DELETED: Users/ (filesystem + git checks green)
- FOUND commits: 2ac1bc6 (Task 1 RED), 60a9d0b (Task 1 GREEN)
