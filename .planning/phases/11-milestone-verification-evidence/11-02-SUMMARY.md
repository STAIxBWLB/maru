---
phase: 11-milestone-verification-evidence
plan: 02
subsystem: testing
tags: [github-actions, ci, coverage, cargo-llvm-cov, vitest]

requires:
  - phase: 11-milestone-verification-evidence
    provides: "plan 11-01's `make coverage` target and `scripts/coverage-summary.mjs`, reused unchanged"
provides:
  - "`.github/workflows/coverage.yml`: non-gating `coverage` workflow, push-to-main only, Job Summary totals table, `coverage-report` artifact (30-day retention)"
  - "README.md documentation of `make coverage` and the coverage workflow as non-gating, no threshold"
affects: []

actuals:
  tokens: 1120
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Separate single-job workflow file for a push-to-main-only, non-required check, matching the native-e2e.yml precedent (own trigger scope, no shared decision/dedup job)"
    - "llvm-tools added via `rustup component add llvm-tools` inside the checkout (targets the rust-toolchain.toml pin) rather than a `components:` input on the dtolnay/rust-toolchain@stable step (which would attach to `stable`, not the pin)"

key-files:
  created:
    - .github/workflows/coverage.yml
  modified:
    - README.md

key-decisions:
  - "No deviations from the plan's literal step order, trigger scope, or permissions - both tasks executed as written."

requirements-completed: [TEST-02]

coverage:
  - id: D1
    description: "`.github/workflows/coverage.yml` triggers only on push to main with the same paths-ignore list as ci.yml, no pull-request or dispatch trigger, no needs on/toward the job, no secrets referenced"
    requirement: TEST-02
    verification:
      - kind: other
        ref: "actionlint .github/workflows/coverage.yml (exit 0, no output)"
        status: pass
      - kind: other
        ref: "grep gate: zero non-comment matches for pull_request|workflow_dispatch|needs:|secrets\\."
        status: pass
    human_judgment: false
  - id: D2
    description: "Workflow runs make coverage, appends the coverage-summary.mjs table to $GITHUB_STEP_SUMMARY, and uploads coverage/ as the coverage-report artifact"
    requirement: TEST-02
    verification:
      - kind: other
        ref: "static presence checks: 'make coverage', 'GITHUB_STEP_SUMMARY', 'rustup component add llvm-tools' all present in coverage.yml"
        status: pass
      - kind: other
        ref: "local replay: GITHUB_STEP_SUMMARY=<tmpfile> node scripts/coverage-summary.mjs against a real make coverage output - both TypeScript and Rust workspace total rows written"
        status: pass
    human_judgment: false
  - id: D3
    description: "ci.yml and rust-toolchain.toml unchanged on this branch versus origin/main merge-base"
    requirement: TEST-02
    verification:
      - kind: other
        ref: "git diff --quiet $(git merge-base HEAD origin/main) -- .github/workflows/ci.yml rust-toolchain.toml (exit 0)"
        status: pass
    human_judgment: false
  - id: D4
    description: "README.md documents make coverage (non-gating) in the commands block and the coverage workflow in Verification and CI; make verify still passes"
    requirement: TEST-02
    verification:
      - kind: other
        ref: "grep checks for 'make coverage' and 'coverage-report' in README.md; git diff --stat shows additions only; make verify exit 0 through check-command-isolation (382 command evidence rows)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The coverage workflow's first real run on main is a post-merge check the executor cannot observe (D-01 rules out PR/dispatch triggers)"
    verification: []
    human_judgment: true
    rationale: "GitHub only dispatches a workflow that already exists on the default branch, so the run URL, Job Summary table, and artifact only exist after this plan's PR merges and the next push to main fires. 11-06 records this as pending evidence."

# Metrics
duration: ~25min
completed: 2026-09-25
status: complete
---

# Phase 11 Plan 02: CI Coverage Workflow (Non-Gating) Summary

**`.github/workflows/coverage.yml` runs `make coverage` on every push to `main` only, appends the totals table to the run's Job Summary, uploads both HTML reports as the `coverage-report` artifact, and is never a PR check or a required check.**

## Performance

- **Duration:** ~25 min (includes one full `make coverage` local run to regenerate `coverage/` for the replay proof, and one full `make verify` run)
- **Tasks:** 2
- **Files modified:** 2 (`.github/workflows/coverage.yml` created, `README.md` modified)

## Accomplishments

- New `coverage` workflow: `push` to `main` only (same `paths-ignore` as `ci.yml`), `permissions: contents: read`, `concurrency: coverage-${{ github.ref }}`, single `coverage` job with no `needs:`
- Toolchain step order matches the plan exactly: `dtolnay/rust-toolchain@stable`, then `cargo --version` + `rustup component add llvm-tools` inside the checkout (targets the `rust-toolchain.toml` pin, not `stable`), then `Swatinem/rust-cache@v2` with a distinct `ubuntu-22.04-coverage` cache key, `taiki-e/install-action@cargo-llvm-cov`, the Linux Tauri apt list, `pnpm install --frozen-lockfile`, `make coverage`, the Job Summary append, and the `coverage-report` artifact upload (`path: coverage/`, `retention-days: 30`)
- `actionlint` clean on the new file
- Job Summary step proven locally: `coverage/` regenerated with a real `make coverage` run (228 Vitest files / 2186 tests pass, 1800 Rust `--lib` tests pass), then `GITHUB_STEP_SUMMARY=<tmpfile> node scripts/coverage-summary.mjs` wrote the full four-row totals table into the stand-in file
- README.md: `make coverage` line added to the commands block (marked non-gating, needs cargo-llvm-cov + llvm-tools) and a paragraph added to `## Verification and CI` naming the workflow, its push-to-main-only scope, the `coverage-report` artifact, the Job Summary table, and the absence of a threshold
- `make verify` re-run clean end to end: typecheck, lint, version/icon/i18n/DOM/type-token guards, TS + Rust tests, `fmt`, `clippy -D warnings`, frontend build + bundle budgets, `check-command-isolation` (382 command evidence rows) - confirms `GraphCanvas.tsx`'s 11-01-documented worktree-only typecheck artifact does not reproduce in this main checkout, matching 11-01's orchestrator correction

## Task Commits

1. **Task 1: Tracer, push-to-main coverage workflow** - `e1a83916` (feat)
2. **Task 2: Document `make coverage` and the coverage workflow in README.md** - `17cca7c6` (docs)

## Files Created/Modified

- `.github/workflows/coverage.yml` - new workflow: `name: coverage`, `on.push.branches: [main]` with the `ci.yml` `paths-ignore` list, one `coverage` job (checkout, pnpm, Node, Rust stable, llvm-tools, `Swatinem/rust-cache@v2`, `cargo-llvm-cov` install, Linux Tauri apt deps, `pnpm install --frozen-lockfile`, `make coverage`, Job Summary append, `coverage-report` artifact upload)
- `README.md` - one `make coverage` line in the commands block; one paragraph in `## Verification and CI` naming the workflow, its scope, the artifact, and the no-threshold guarantee

## Decisions Made

None beyond the plan's own stated corrections (the `rustup component add llvm-tools` step targeting the toolchain pin, already specified in the plan's `flagged_assumptions` and executed as written) - plan executed exactly as written.

## Deviations from Plan

None - plan executed exactly as written. `coverage/ts/coverage-summary.json` and `coverage/rust/coverage.json` from plan 11-01 were gitignored and not present in this checkout (expected, since `coverage/` is not committed), so the Task 1 precondition's stated recovery path - re-running `make coverage` with the LLVM env from 11-01 Task 3 - was exercised to regenerate them before the local replay proof, exactly as the precondition anticipated.

## Issues Encountered

- `coverage/` did not exist at plan start (gitignored, not carried over from the 11-01 session). Regenerated via `LLVM_COV=/opt/homebrew/opt/llvm@22/bin/llvm-cov LLVM_PROFDATA=/opt/homebrew/opt/llvm@22/bin/llvm-profdata make coverage`, matching 11-01's documented toolchain. Result: 228 Vitest files / 2186 tests pass, 1800 Rust `--lib` tests pass (0 failed, 3 ignored), totals table matches 11-01's baseline within measurement noise (61.03% / 90.49% Rust workspace vs 11-01's 61.03% / 90.47% - a handful of lines/functions shifted between the two measurement sessions, unrelated to this plan's diff, which touches no `src` or `src-tauri/src` files).
- A jsdom console warning ("Not implemented: navigation to another Document") appeared once in the Vitest run's stderr; confirmed harmless - `Test Files 228 passed (228)`, `Tests 2186 passed (2186)` on the same run, no failures.

## User Setup Required

None - no external service configuration required. `cargo-llvm-cov` and `llvm-tools` are already installed per 11-01; the CI workflow installs `taiki-e/install-action@cargo-llvm-cov` and `rustup component add llvm-tools` itself on the hosted runner.

## Next Phase Readiness

- TEST-02 is now fully landed: 11-01's `make coverage` target (local) plus this plan's `coverage` workflow (CI, non-gating). Marked complete in REQUIREMENTS.md.
- **Post-merge check remaining (flagged in the plan):** the workflow's first real run happens on the first push to `main` after this phase's PR merges. This cannot be observed from inside this plan (D-01 rules out PR and dispatch triggers, and GitHub only runs a workflow that already exists on the default branch). 11-06 (phase evidence closure) should record the first run's URL, its Job Summary table, and the `coverage-report` artifact as pending until that push happens.
- `ci.yml` and `rust-toolchain.toml` remain untouched on this branch (verified via `git diff --quiet` against the `origin/main` merge-base) - the PR path is byte-identical to before this plan.

---
*Phase: 11-milestone-verification-evidence*
*Completed: 2026-09-25*

## Self-Check: PASSED

- Created files verified on disk: `.github/workflows/coverage.yml`.
- Modified files verified on disk: `README.md` (`make coverage` line and `coverage-report` paragraph present).
- Commits verified in `git log`: `e1a83916`, `17cca7c6`.
- `actionlint .github/workflows/coverage.yml` re-confirmed exit 0.
- `git diff --quiet $(git merge-base HEAD origin/main) -- .github/workflows/ci.yml rust-toolchain.toml` re-confirmed exit 0 (both files unchanged).
