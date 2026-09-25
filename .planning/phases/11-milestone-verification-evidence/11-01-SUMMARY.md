---
phase: 11-milestone-verification-evidence
plan: 01
subsystem: testing
tags: [vitest, coverage-v8, cargo-llvm-cov, makefile, ci-evidence]

requires:
  - phase: 10-bundle-and-build-hardening
    provides: a stable Makefile `verify` prerequisite list and CI job set to extend without touching
provides:
  - "`make coverage`: TS coverage (Vitest v8 provider, `pnpm test` scope) + Rust coverage
    (cargo-llvm-cov, whole workspace), HTML per language, terminal totals table, no threshold"
  - "`scripts/coverage-summary.mjs`: exported `summarizeCoverage({ ts, rust })` plus a CLI"
  - "First measured TEST-02 baseline (TS + per-crate Rust), recorded below for future eyeball comparison"
affects: [11-02-ci-coverage-job]

actuals:
  tokens: 3900
  tasks: 3
  commits: 4

tech-stack:
  added: ["@vitest/coverage-v8@4.1.5 (exact pin)", "cargo-llvm-cov 0.9.1 (machine-level, ~/.cargo/bin, not a repo dependency)"]
  patterns:
    - "Non-gating Makefile target with a leading '# Deliberately NOT part of verify' comment naming the requirement/decision IDs, matching test-e2e-native/verify-integration"
    - "CLI module guarded by `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`, matching scripts/check-mode-css-ownership.mjs"

key-files:
  created:
    - scripts/coverage-summary.mjs
    - scripts/coverage-summary.test.ts
  modified:
    - package.json
    - pnpm-lock.yaml
    - Makefile

key-decisions:
  - "cargo-llvm-cov's report omits a crate with zero test-exercised profile data entirely (maru-cli's 4-line main.rs) rather than reporting it as 0% - summarizeCoverage renders 'no files in report' for that group instead of silently dropping the row, exactly as the plan's flagged edge case anticipated"
  - "Preflight check uses `$(CARGO) llvm-cov --version`, not a PATH lookup, since cargo also searches ~/.cargo/bin for subcommands and this shell's PATH does not include it by default"
  - "GraphCanvas.tsx's 6 pre-existing TS7006 implicit-any errors (unrelated file, last touched in PR #330 the day before this phase's base commit) are confirmed unrelated to this plan's diff via a stash test and left unfixed, per the scope-boundary rule; logged to deferred-items.md"

requirements-completed: [TEST-02]

coverage:
  - id: D1
    description: "`make coverage` runs Vitest with the v8 provider over the `pnpm test` scope and writes coverage/ts/index.html + coverage/ts/coverage-summary.json"
    requirement: TEST-02
    verification:
      - kind: unit
        ref: "scripts/coverage-summary.test.ts#renders the TypeScript row with recomputed percentages"
        status: pass
      - kind: other
        ref: "make coverage && test -f coverage/ts/index.html && test -f coverage/ts/coverage-summary.json"
        status: pass
    human_judgment: false
  - id: D2
    description: "`make coverage` runs cargo-llvm-cov over the whole Cargo workspace and writes coverage/rust/html/index.html + coverage/rust/coverage.json, with per-crate + workspace-total rows in the printed table"
    requirement: TEST-02
    verification:
      - kind: unit
        ref: "scripts/coverage-summary.test.ts#groups Rust files by crate and computes per-crate plus workspace totals"
        status: pass
      - kind: other
        ref: "LLVM_COV=... LLVM_PROFDATA=... make coverage && test -f coverage/rust/html/index.html && test -f coverage/rust/coverage.json"
        status: pass
    human_judgment: false
  - id: D3
    description: "With cargo-llvm-cov absent, `make coverage` exits non-zero before any report is produced and prints an install hint"
    requirement: TEST-02
    verification:
      - kind: other
        ref: "make coverage (tool uninstalled) -> exit 2, ~0.03s, no coverage/rust/ created, hint printed"
        status: pass
    human_judgment: false
  - id: D4
    description: "`make verify` and its prerequisite list are unchanged; no minimum-percentage option exists anywhere in the new code"
    requirement: TEST-02
    verification:
      - kind: other
        ref: "grep -E '^verify:' Makefile | grep -c coverage; grep -vE '(coverage\\.thresholds|fail-under|lcov)' guard on Makefile and coverage-summary.mjs"
        status: pass
    human_judgment: false
  - id: D5
    description: "@vitest/coverage-v8 is pinned exactly at 4.1.5 and was installed only after the blocking-human legitimacy checkpoint"
    requirement: TEST-02
    verification:
      - kind: other
        ref: "node -e checks package.json devDependencies['@vitest/coverage-v8'] === '4.1.5'"
        status: pass
    human_judgment: false
  - id: D6
    description: "The first measured totals are recorded once as the baseline, with commit SHA and toolchain versions"
    requirement: TEST-02
    verification: []
    human_judgment: true
    rationale: "A one-time evidence record (see 'Evidence: coverage baseline' below) - there is no automated assertion that a human-readable baseline snapshot is 'correct', only that it was captured; a human should skim it once."

# Metrics
duration: 40min
completed: 2026-09-25
status: complete
---

# Phase 11 Plan 01: Coverage Tooling (TypeScript + Rust) Summary

**`make coverage` measures TypeScript (Vitest v8) and Rust (cargo-llvm-cov, per-crate) coverage as one non-gating command, ending with a printed totals table; the first measurement is recorded below as the TEST-02 baseline.**

## Performance

- **Duration:** ~40 min (this continuation session; Task 1's package-legitimacy checkpoint was answered in a prior session)
- **Tasks:** 3 (Task 1 checkpoint resolved before this session; Tasks 2-3 executed here)
- **Files modified:** 5 (package.json, pnpm-lock.yaml, Makefile, scripts/coverage-summary.mjs, scripts/coverage-summary.test.ts) plus 1 new phase-scoped doc (deferred-items.md)

## Task 1: Package Legitimacy Checkpoint (answered before this session)

Per the plan's acceptance criteria, recording both answers verbatim as relayed by the orchestrator:

> "둘 다 승인" = approved, both installs.
> - npm: approved, `@vitest/coverage-v8@4.1.5` as an exact-pinned devDependency
>   (`pnpm add -D -E @vitest/coverage-v8@4.1.5`). Verified on the registry: repository
>   `git+https://github.com/vitest-dev/vitest.git`, version 4.1.5 published, and
>   `vitest@4.1.5` peerDependencies name `@vitest/coverage-v8: 4.1.5`.
> - cargo: approved, local `cargo install cargo-llvm-cov --locked` into `~/.cargo/bin`.
>   Verified on crates.io: repository `https://github.com/taiki-e/cargo-llvm-cov`,
>   created 2021-01-22, max stable 0.9.1.

Both installs proceeded exactly as approved (see Task Commits below); the installed cargo-llvm-cov version was 0.9.1, matching the max-stable figure quoted above.

## Accomplishments

- `make coverage` target added to the Makefile (outside `verify`, per D-01/D-04), running the exact `pnpm test` Vitest scope under the v8 coverage provider, then cargo-llvm-cov across the whole Cargo workspace, ending in one printed totals table
- `scripts/coverage-summary.mjs` exports `summarizeCoverage({ ts, rust })`: recomputes percentages from covered/total (never trusts an input `pct`), renders `n/a (0/0)` for a zero denominator, groups Rust files by crate with backslash-path normalization, and renders `no files in report` for an empty crate group instead of dropping the row
- A preflight (`$(CARGO) llvm-cov --version`) fails `make coverage` loudly and fast (~0.03s) with an install hint when cargo-llvm-cov is absent, before either language's coverage run starts
- First-ever TEST-02 baseline measured and recorded below

## Task Commits

Each task was committed atomically (TDD RED/GREEN pairs for both tracer and expansion tasks):

1. **Task 2 RED:** `test(11-01): add failing test for coverage-summary TypeScript row` - `52ba216`
2. **Task 2 GREEN:** `feat(11-01): make coverage TypeScript half, Vitest v8 to terminal totals` - `f3b7828`
3. **Task 3 RED:** `test(11-01): add failing tests for Rust per-crate coverage grouping` - `06754b5`
4. **Task 3 GREEN:** `feat(11-01): make coverage Rust half, per-crate totals, cargo-llvm-cov preflight` - `eb0ea3f`

_Task 1 (`checkpoint:human-verify`, `gate="blocking-human"`) produced no commit - the `@vitest/coverage-v8@4.1.5` install itself is staged as part of the Task 2 RED commit above, since `pnpm add` and writing the RED test happened together at the start of Task 2's action list._

## Files Created/Modified

- `scripts/coverage-summary.mjs` - `summarizeCoverage({ ts, rust })` plus a CLI reading `coverage/ts/coverage-summary.json` and `coverage/rust/coverage.json`
- `scripts/coverage-summary.test.ts` - 9 behavior cases: TS row math, header, zero-denominator, pct-field-ignored, Rust per-crate/workspace-total math, empty-crate fallback, backslash normalization, TS-row-first ordering
- `Makefile` - new `.PHONY: coverage` target (preflight + Vitest line + two cargo-llvm-cov lines + summary line), placed after `verify-integration`
- `package.json` / `pnpm-lock.yaml` - `@vitest/coverage-v8` devDependency pinned at exact `4.1.5`
- `.planning/phases/11-milestone-verification-evidence/deferred-items.md` - new file, logs the pre-existing unrelated GraphCanvas.tsx typecheck gap

## Decisions Made

- cargo-llvm-cov omits a crate with zero test-exercised profile data from its JSON export entirely, rather than reporting 0%. `summarizeCoverage` treats "no files matched this crate" as a distinct `no files in report` state per group, matching the plan's flagged edge case precisely (maru-cli's 4-line `main.rs` has no tests).
- The Makefile preflight calls `$(CARGO) llvm-cov --version` rather than checking `command -v cargo-llvm-cov` on PATH, because cargo resolves its own subcommands from `~/.cargo/bin` independently of the shell's PATH, and this shell's PATH does not include that directory by default.
- GraphCanvas.tsx's pre-existing `pnpm typecheck` errors (6 `TS7006` implicit-any errors at lines 311/328, from PR #330, one day before this phase's base commit) were confirmed unrelated to this plan's diff via a `git stash` test (the errors reproduce identically with only the already-committed `@vitest/coverage-v8` pin + RED test present, before any Makefile or `coverage-summary.mjs` change existed) and via a `pnpm-lock.yaml` diff inspection (this plan's lockfile diff is scoped to `@vitest/coverage-v8` and its own transitive deps only - no `graphology`/`sigma`/`@types/*` version changed). Left unfixed per the scope-boundary rule and logged to `deferred-items.md`.

## Evidence: coverage baseline

Measured at commit `eb0ea3fd` (this plan's Task 3 GREEN commit - the code state below was unchanged between measurement and commit).

**Toolchain versions:**

- `rustc 1.97.1 (8bab26f4f 2026-07-14) (Homebrew)`, LLVM version `22.1.8`
- `cargo-llvm-cov 0.9.1` (installed via `cargo install cargo-llvm-cov --locked`, per the Task 1 approval)
- `vitest` `4.1.5` (installed), `@vitest/coverage-v8` `4.1.5` (exact pin)

**RED run (cargo-llvm-cov not yet installed, before step 6 of Task 3):**

```
coverage: cargo-llvm-cov is not installed, so the Rust half cannot run.
coverage: install it with: cargo install cargo-llvm-cov --locked
coverage: then either run: rustup component add llvm-tools
coverage: or export LLVM_COV and LLVM_PROFDATA pointing at an LLVM whose
coverage: major version matches `rustc --version --verbose` (for example Homebrew llvm).
```

Exit code 2, elapsed ~0.03s. Neither Vitest nor cargo ran; `coverage/rust/` was not created.

**GREEN run (cargo-llvm-cov 0.9.1 installed, `LLVM_COV`/`LLVM_PROFDATA` exported to the Homebrew LLVM 22 binaries):**

1800 Rust `--lib` tests passed (0 failed, 3 ignored), 228 Vitest test files / 2181 tests passed. Final totals table:

```
### Coverage totals
| Scope | Lines | Functions |
|---|---|---|
| TypeScript (src + scripts) | 61.03% (16838/27590) | 54.04% (4594/8501) |
| Rust maru (src-tauri/src) | 90.47% (101190/111846) | 80.32% (9577/11923) |
| Rust maru-cli (src-tauri/maru-cli) | no files in report | no files in report |
| Rust workspace total | 90.47% (101201/111860) | 80.32% (9581/11928) |
```

`coverage/rust/coverage.json` contains 119 files, all under `src-tauri/src/`; none under `src-tauri/maru-cli/src/` (main.rs is 4 lines with no tests, so cargo-llvm-cov emits no profile entry for it at all - confirmed by direct inspection of the JSON, not just the printed table). This matches the plan's own documented alternative acceptance path ("or the maru-cli row reads 'no files in report' and the SUMMARY says so").

**HTML entry points:** `coverage/ts/index.html`, `coverage/rust/html/index.html` (both gitignored, not committed).

## Deviations from Plan

None - plan executed exactly as written. Task 1's checkpoint answers (approve both installs) match the plan's expected default path.

## Issues Encountered

- **`pnpm typecheck` / `make verify` fail at the `typecheck` target due to pre-existing, unrelated `GraphCanvas.tsx` errors** (6 `TS7006` implicit-any errors, `forEachEdge`/`forEachNode` callback params at lines 311 and 328). Confirmed unrelated to this plan via `git stash` (reproduces identically with only the RED-commit state present) and a `pnpm-lock.yaml` diff review (no `graphology`/`sigma`/`@types/*` version changed by this plan's `pnpm add`). `make verify` output:

  ```
  pnpm typecheck
  > tsc -b
  src/components/graph/GraphCanvas.tsx(311,22): error TS7006: Parameter 'key' implicitly has an 'any' type.
  src/components/graph/GraphCanvas.tsx(311,27): error TS7006: Parameter 'attrs' implicitly has an 'any' type.
  src/components/graph/GraphCanvas.tsx(311,34): error TS7006: Parameter 'source' implicitly has an 'any' type.
  src/components/graph/GraphCanvas.tsx(311,42): error TS7006: Parameter 'target' implicitly has an 'any' type.
  src/components/graph/GraphCanvas.tsx(328,22): error TS7006: Parameter 'key' implicitly has an 'any' type.
  src/components/graph/GraphCanvas.tsx(328,27): error TS7006: Parameter 'attrs' implicitly has an 'any' type.
   ELIFECYCLE  Command failed with exit code 2.
  make: *** [typecheck] Error 2
  ```

  Because `make` stops at the first failing target, `lint`/`test-ts`/`test-rust`/`fmt-check`/`clippy`/`build-frontend`/`check-command-isolation` never ran under this single invocation. This plan's own scope was verified individually instead (matching the Phase 1 precedent recorded in `.planning/STATE.md`): `pnpm exec vitest run scripts/coverage-summary.test.ts` (9/9 pass), the full `pnpm test` Vitest half (228 files / 2181 tests pass, run as part of `make coverage`), `node --test scripts/check-command-isolation.test.mjs` (96/96 pass), the full Rust `--lib` suite (1800/1800 pass, 3 ignored, run as part of `make coverage`'s cargo-llvm-cov pass), and `cargo fmt --check` (exit 0). Logged in full to `deferred-items.md` for a follow-up phase/issue to type `GraphCanvas.tsx`'s callback params.

## User Setup Required

None - no external service configuration required. `cargo-llvm-cov` is a local machine-level tool (`~/.cargo/bin`), not a project setup step; it is removable with `cargo uninstall cargo-llvm-cov`.

## Next Phase Readiness

- `make coverage` and `scripts/coverage-summary.mjs` are ready for plan 11-02 (the push-only CI coverage job) to reuse directly.
- The pre-existing `GraphCanvas.tsx` typecheck gap is open and logged in `deferred-items.md`; it blocks a fully green `make verify`/`pnpm typecheck` run on this base commit independent of this plan, and should be picked up as a small follow-up fix outside TEST-02 scope.

---
*Phase: 11-milestone-verification-evidence*
*Completed: 2026-09-25*

## Self-Check: PASSED

- Created files verified on disk: `scripts/coverage-summary.mjs`, `scripts/coverage-summary.test.ts`, `.planning/phases/11-milestone-verification-evidence/deferred-items.md`, this SUMMARY.md.
- Commits verified in `git log`: `52ba2167`, `f3b78288`, `06754b57`, `eb0ea3fd`.
- All Task 2 and Task 3 acceptance criteria re-verified passing (see Evidence section above); the sole open item (`GraphCanvas.tsx` pre-existing typecheck gap) is documented, not silently dropped.
