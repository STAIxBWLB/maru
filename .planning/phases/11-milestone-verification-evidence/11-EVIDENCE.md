# Phase 11: Evidence Record

This file holds evidence that must outlive CI artifact retention. It is kept separate from
11-VERIFICATION.md, which the verifier regenerates with a whole-file write at the end of
execution and would discard anything a plan wrote into it.

## GATE-08: narrowed Playwright trace re-proof

| Item | Value |
|------|-------|
| Run URL | https://github.com/STAIxBWLB/maru/actions/runs/36146017939 |
| Run ID | 36146017939 |
| Event | `workflow_dispatch` |
| Probe branch | `test/gate08-trace-probe`, deleted |
| Probe SHA | `90f64713c13af7fae5e2a2786980ac1ee23be424`, not on `main` |
| Config commit | `2d2e8660`, `trace: { mode: "retain-on-failure", snapshots: false, screenshots: false },` |
| Failing test | `e2e/startup.spec.ts` > `keeps the full terminal renderer out of the collapsed startup path` |
| `playwright e2e` job conclusion | `failure` |
| `CI decision` job conclusion | `success` |
| `make verify` job conclusion | `success` |
| `native e2e compile check` job conclusion | `success` |
| Artifact name | `playwright-report` |
| Artifact ID | `10869526424` |
| Artifact size | 16,673 bytes |
| Artifact expiry | `2026-10-02T14:21:04Z` |
| Trace path inside artifact | `test-results/startup-keeps-the-full-ter-c2971--the-collapsed-startup-path-chromium/trace.zip` |

### Trace listing

```text
Archive:  trace.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      899  09-25-2026 14:18   resources/src@db4ec8fea9b76de5104002c3c1683c42b7ef240c.txt
    18861  09-25-2026 14:18   resources/0c290a9571c7674ce6c6a507f9eadc80567379d5
    12021  09-25-2026 14:18   test.trace
    24647  09-25-2026 14:18   0-trace.trace
        0  09-25-2026 14:18   0-trace.network
      202  09-25-2026 14:18   0-trace.stacks
---------                     -------
    56630                     6 files
```

### Comparison with v1.0

| Run | Bytes | Entries |
|-----|-------|---------|
| v1.0 narrowed config, 2026-08-22, run 32569215249 | 123,399 | 6 |
| v1.0 wide config | 1,752,382 | 14 |
| This run (2026-09-25, run 36146017939) | 56,630 | 6 |

Verdict: the narrowed config still produces a non-trivial trace containing the action timeline
(`0-trace.trace`, 24,647 bytes) and the failing stack (`0-trace.stacks`, 202 bytes), and
`0-trace.network` is 0 bytes exactly as the `playwright.config.ts` comment documents (snapshots
off disables network capture too). The entry count matches v1.0's narrowed-config measurement
exactly (6 entries), confirming the same trace shape ships today as it did at v1.0. The total
byte count (56,630) is well under half of the v1.0 figure (123,399) and this is reported plainly
rather than smoothed over: the difference traces to the probe test itself, `startup.spec.ts`'s
"keeps the full terminal renderer out of the collapsed startup path" is a shorter, simpler
interaction than whatever spec produced the 2026-08-22 measurement, so its action timeline and
DOM snapshot resource are smaller. The entry composition, not the raw size, is what proves the
config is unchanged, and it matches.

### Cleanup

- `git ls-remote --heads origin test/gate08-trace-probe` printed nothing.
- `git branch --list test/gate08-trace-probe` printed nothing.
- `git worktree list` no longer shows the probe worktree.
- `git merge-base --is-ancestor 90f64713c13af7fae5e2a2786980ac1ee23be424 origin/main` exited 1.
- `git merge-base --is-ancestor 90f64713c13af7fae5e2a2786980ac1ee23be424 HEAD` exited 1.

## TEST-02: coverage baseline

Re-measured after the PR #351 review fix. The first baseline in 11-01-SUMMARY.md (commit
`eb0ea3fd`) came from a `cargo llvm-cov report` call without `--workspace`, which reports only the
default member `maru`, so `maru-cli` always showed "no files in report", and its workspace total
also counted one toolchain std file mapped in by the local Homebrew LLVM. With `report --workspace`
and the workspace total limited to the two crates, the baseline is:

### Coverage totals

| Scope | Lines | Functions |
|---|---|---|
| TypeScript (src + scripts) | 61.03% (16838/27590) | 54.00% (4594/8507) |
| Rust maru (src-tauri/src) | 90.49% (101215/111846) | 80.33% (9578/11923) |
| Rust maru-cli (src-tauri/maru-cli) | 0.00% (0/3) | 0.00% (0/1) |
| Rust workspace total | 90.49% (101215/111849) | 80.33% (9578/11924) |

`maru-cli`'s `main.rs` has 3 instrumented lines and no tests, so 0% is its true figure.

### Measurement record

| Item | Value |
|------|-------|
| Measured-at commit | Rust report regenerated at `a2258806` (PR #351 review fix); TS summary from the 11-02 `make coverage` run. `src/`, `src-tauri/src/` and `src-tauri/maru-cli/` are unchanged since the phase base `6ca52be5`, so both halves measure the same code. The superseded first measurement was at `eb0ea3fd`. |
| rustc | `rustc 1.97.1 (8bab26f4f 2026-07-14) (Homebrew)` |
| LLVM version | `22.1.8` |
| cargo-llvm-cov | `0.9.1` |
| vitest | `4.1.5` |
| @vitest/coverage-v8 | `4.1.5` (exact pin) |
| TS HTML report | `coverage/ts/index.html` (gitignored, not committed) |
| Rust HTML report | `coverage/rust/html/index.html` (gitignored, not committed) |

The totals above are recorded once, for future comparison by eye. TEST-02 sets no
minimum-percentage threshold; `make coverage` never fails on a percentage, and no
`coverage.thresholds`/`fail-under`/`lcov` gate exists anywhere in the new code (D-04).

### CI readiness

- `actionlint .github/workflows/coverage.yml`: exit 0, no output (11-02-SUMMARY.md D1).
- Local Job Summary replay: `coverage/` regenerated with a real `make coverage` run (228
  Vitest files / 2186 tests pass, 1800 Rust `--lib` tests pass), then
  `GITHUB_STEP_SUMMARY=<tmpfile> node scripts/coverage-summary.mjs` wrote a four-row totals
  table into the stand-in file (11-02-SUMMARY.md D2). That replay predates the `report --workspace`
  fix, so its maru-cli row read "no files in report"; the table above is the re-measured one.
- `git diff --quiet $(git merge-base HEAD origin/main) -- .github/workflows/ci.yml
  rust-toolchain.toml`: exit 0, both files unchanged by the coverage workflow's addition
  (11-02-SUMMARY.md D3).

### Post-merge check

Confirmed on 2026-09-26. `.github/workflows/coverage.yml` triggers only on `push` to `main`
(D-01), so its first run was the push of the phase 11 merge commit `7bbfaf10` (PR #351).

- Run URL: https://github.com/STAIxBWLB/maru/actions/runs/36174321763 (event `push`, job
  `coverage report (non-gating)` = success; the `Write coverage totals to the job summary`
  step succeeded).
- `coverage-report` artifact: uploaded, 5,975,004 bytes, containing `ts/` (HTML +
  `coverage-summary.json`) and `rust/` (`html/` + `coverage.json`).
- Job Summary totals table, reproduced from the artifact's two JSON files with the same
  `scripts/coverage-summary.mjs` (`validateReports` returned null):

| Scope | Lines | Functions |
|---|---|---|
| TypeScript (src + scripts) | 61.03% (16842/27598) | 54.04% (4598/8508) |
| Rust maru (src-tauri/src) | 90.38% (100899/111642) | 80.47% (9573/11897) |
| Rust maru-cli (src-tauri/maru-cli) | 0.00% (0/3) | 0.00% (0/1) |
| Rust workspace total | 90.37% (100899/111645) | 80.46% (9573/11898) |

The CI figures are measured on Linux (ubuntu-22.04, pinned rustc 1.98.0); the local baseline
above is macOS with Homebrew rustc 1.97.1. The Rust line totals differ by about 0.1 point
(platform-conditional code); the TypeScript totals match within rounding. Recorded for
comparison by eye only; TEST-02 sets no threshold (D-04). UAT: 11-UAT.md test 1, pass.

## VALID-01 and SEC-03: reconciled records

Values below are read from each file's current frontmatter, not copied from SUMMARY prose.

| Record | Path | status | nyquist_compliant / threats_open | Audit date |
|--------|------|--------|-----------------------------------|------------|
| Phase 01 Validation | `.planning/milestones/v1.0-phases/01-trustworthy-verify-signal/01-VALIDATION.md` | validated | nyquist_compliant: true | 2026-09-25 |
| Phase 02 Validation | `.planning/milestones/v1.0-phases/02-shared-scanner-and-path-invariants/02-VALIDATION.md` | validated | nyquist_compliant: true | 2026-09-25 |
| Phase 03 Validation | `.planning/milestones/v1.0-phases/03-typed-ipc-error-contract/03-VALIDATION.md` | validated | nyquist_compliant: true | 2026-09-25 |
| Phase 02 Security | `.planning/milestones/v1.0-phases/02-shared-scanner-and-path-invariants/02-SECURITY.md` | verified | threats_open: 0 | 2026-09-25 |
| Phase 03 Security | `.planning/milestones/v1.0-phases/03-typed-ipc-error-contract/03-SECURITY.md` | verified | threats_open: 0 | 2026-08-28, commit `4fd3ea3b` (predates this phase) |

Phase 03's security report already existed before v1.1 Phase 11 started; it is listed here
only to complete the four-report set the v1.0 audit's "Phases 02-03 have no SECURITY.md" gap
referenced.

### GATE-04 pointer resolution

`01-VALIDATION.md`'s GATE-04 row cites `.planning/phases/11-milestone-verification-evidence/11-EVIDENCE.md`
(GATE-08 section). Confirmed: this file exists and contains the `## GATE-08: narrowed
Playwright trace re-proof` heading above.
