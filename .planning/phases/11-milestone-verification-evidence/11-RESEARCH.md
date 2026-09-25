# Phase 11: Milestone Verification & Evidence - Research

**Researched:** 2026-09-25
**Domain:** Test coverage tooling (Vitest v8 + cargo-llvm-cov), CI evidence capture (Playwright trace probe), retroactive Nyquist validation reconciliation, retroactive security audit
**Confidence:** HIGH for repo-internal facts (all read this session with line citations); MEDIUM for CI-cost estimates and coverage-provider defaults (no live CI run executed in this research pass); LOW/ASSUMED only where flagged.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Coverage runs from a local `make coverage` target and from a non-gating CI job that runs on push to `main` only, never on PRs. It stays outside `make verify`, and the CI job must not be a required check.
- **D-02:** Output is an HTML report per language, a totals line per language printed to the terminal at the end of the run, and in CI a totals table written to the GitHub Job Summary with the HTML uploaded as an artifact. No lcov and no external coverage service.
- **D-03:** Tooling defaults: Vitest coverage with the v8 provider over the same scope as `pnpm test` (`src` and `scripts`), and `cargo-llvm-cov` over the whole Cargo workspace (the app lib and `maru-cli`) with per-crate totals. The Vitest coverage package version must match the installed `vitest` (^4.1.5). The researcher confirms both tools work on the current toolchain before the plan commits to them.
- **D-04:** No threshold and no fail condition. The first measured totals are recorded once as the baseline in the phase artifacts so later runs can be compared by eye.
- **D-05:** Re-run a fresh deliberate CI failure against the current `playwright.config.ts` trace setting (`{ mode: "retain-on-failure", snapshots: false, screenshots: false }`). The 2026-08-22 probe (run 32569215249) is not accepted as closing evidence: its artifact has expired and the v1.0 audit did not accept it.
- **D-06:** Mechanism: a temporary branch adds one failing assertion to an existing e2e spec and is run with `gh workflow run ci.yml --ref <branch>` (`ci.yml` already has `workflow_dispatch`). No PR is opened and `main` is never touched. After the evidence is captured, the probe branch is deleted locally and on the remote. The user approved this method, including the branch push, the dispatch, and the branch deletion.
- **D-07:** Evidence recorded in the phase verification artifact: run URL and ID, artifact name, the failing test name, the config commit, and the `unzip -l` listing of the trace zip (entry names and byte sizes), compared against the v1.0 figures (123,399 bytes across 6 entries). The trace binary is not committed.
- **D-08:** Run the validate-phase workflow for v1.0 phases 01, 02, and 03 in turn. Map every requirement in each VALIDATION.md to the tests that actually shipped, replace the pre-execution `TBD` / `W0` / `pending` rows, and set `status: validated` and `nyquist_compliant` from the result.
- **D-09:** Gap policy: a requirement a unit test can cover and that has no automated test gets a small test in this phase. Gate-behavior checks proven by break-and-revert (the GATE-01..05 kind) are classified manual-only, citing the recorded evidence in the phase SUMMARY files.
- **D-10:** Edit the v1.0 archive in place under `.planning/milestones/v1.0-phases/`. Only the three VALIDATION.md files change and `02-SECURITY.md` is added. No other archived document is edited.
- **D-11:** `.planning/milestones/v1.0-MILESTONE-AUDIT.md` keeps its original frontmatter and verdict. A "Resolved in v1.1 Phase 11" section is appended with one entry per debt item (GATE-04 trace, Nyquist 01-03, Phase 02 security report), each linking its evidence. The audit's claim that Phase 03 had no SECURITY.md is noted as already resolved by `03-SECURITY.md` (commit `4fd3ea3b`, 2026-08-28).
- **D-12:** A retroactive secure-phase audit of the 8 `T-02-*` threats declared in the `<threat_model>` blocks of `02-01..02-03-PLAN.md`, checked against current HEAD, written to `.planning/milestones/v1.0-phases/02-shared-scanner-and-path-invariants/02-SECURITY.md` in the `03-SECURITY.md` format (frontmatter `status`, `threats_open`, `asvs_level`; trust boundaries; per-threat verdict with code evidence).
- **D-13:** An open threat with a small, local fix is fixed in this phase. A larger one is recorded as open in the report and proposed as a GitHub issue, which is registered only after user approval.
- **D-14:** TEST-02, GATE-08, VALID-01, and SEC-03 are marked complete in `.planning/REQUIREMENTS.md` only when their evidence exists as described above.

### Claude's Discretion

- Coverage config details: reporters, include/exclude globs, output directory (`coverage/` is already gitignored), and whether the main-push job lives in `ci.yml` or its own workflow file.
- Which existing e2e spec carries the probe assertion.
- Where the coverage baseline is recorded (phase VERIFICATION or a dedicated section).
- Plan order and wave split across the four items, which are independent of each other.

### Deferred Ideas (OUT OF SCOPE)

None. The discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TEST-02 | TS and Rust coverage measured and reported as a non-gating artifact outside `make verify` | Standard Stack, Code Examples, Package Legitimacy Audit, Environment Availability |
| GATE-08 | A fresh deliberate CI failure proves the narrowed Playwright trace still produces a trace | GATE-08 Probe Mechanics section, Code Examples |
| VALID-01 | Nyquist validation metadata for v1.0 phases 01-03 matches what validate-phase reports | VALID-01 Reconciliation Inventory section (the most load-bearing output of this research) |
| SEC-03 | v1.0 Phase 02 gets a security report | SEC-03 Threat Register Audit section |
</phase_requirements>

## Summary

This phase touches four independent, low-risk evidence gaps, none of which changes product
behavior. The two tooling items (TEST-02, GATE-08) are new but small: Vitest's own `@vitest/coverage-v8`
plugin at the exact version paired with the installed `vitest@4.1.5` [VERIFIED: pnpm-lock.yaml:4150],
and `cargo-llvm-cov` (crates.io, `taiki-e`, OK verdict) for the Rust half. Neither tool is installed
in this research environment (no `cargo-llvm-cov` binary, no `rustup` at all - this machine builds
Rust via a Homebrew `rustc 1.97.1`, not the repo's pinned `rust-toolchain.toml` 1.98.0), so their
CI/toolchain compatibility could not be positively demonstrated end-to-end; recommendations below
are correct by documentation and package-registry evidence but the plan should budget one
`checkpoint:human-verify` or CI dry-run before treating cargo-llvm-cov as proven on this repo's
pinned toolchain.

The two reconciliation items (VALID-01, SEC-03) are almost entirely investigation, not new code.
For VALID-01, every requirement row across the three archived v1.0 VALIDATION.md files was traced
to a real, currently-passing test in this session (see the inventory table); no requirement is
actually missing an automated test - the archived files are simply stuck in pre-execution `TBD`/`pending`
state and need their status flipped to reflect tests that already shipped. For SEC-03, all 8
`T-02-*` threats declared in the 02-01..02-03 PLAN.md threat_model blocks were independently traced
to mitigating code at HEAD; the retroactive audit is expected to find `threats_open: 0`, meaning
D-13's "fix one, open-issue one" branch likely does not trigger, but the plan should not assume
this and must still run the actual audit dispatch (`gsd_run query init.phase-op` correctly resolves
archived phase directories under `.planning/milestones/v1.0-phases/`, confirmed by direct query in
this session, so `/gsd-validate-phase 01` and `/gsd-secure-phase 02` can run against the archive
in place, satisfying D-08/D-10/D-12 literally).

**Primary recommendation:** Treat this phase as four small, sequenceable waves - TEST-02 (add
coverage tooling + `make coverage` + CI job), GATE-08 (branch, dispatch, capture, delete), VALID-01
(run validate-phase three times, add the handful of genuinely-missing unit tests below), SEC-03
(run secure-phase once, write 02-SECURITY.md) - then append the v1.0-MILESTONE-AUDIT.md resolution
section and flip the four REQUIREMENTS.md rows.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| TS coverage measurement | Build/Test tooling (Vitest config + CI) | Local dev (`make coverage`) | Coverage is a test-runner concern layered on the existing Vitest invocation; no app-tier code changes |
| Rust coverage measurement | Build/Test tooling (Cargo workspace + CI) | Local dev | `cargo-llvm-cov` wraps `cargo test`; no `src-tauri/src/**` production code changes |
| CI evidence job placement | CI / Backend (workflow config) | - | `ci.yml` already owns all other verify/e2e jobs; a new job is additive, not a new surface |
| GATE-08 trace probe | CI / Backend (workflow dispatch + e2e job) | Test tier (`e2e/*.spec.ts`) | The probe is a temporary edit to an existing Playwright spec, run through the existing e2e job |
| VALID-01 reconciliation | Planning/docs tier (`.planning/milestones/v1.0-phases/**`) | Test tier (adds a handful of unit tests where genuinely missing) | Mostly a metadata/status correction; a few real unit tests close true gaps |
| SEC-03 retroactive audit | Planning/docs tier (`.planning/milestones/v1.0-phases/02-*/02-SECURITY.md`) | Backend (`src-tauri/src/*.rs`, if a small fix is needed) | Threats already appear mitigated in code; the audit documents this, no new mitigation code is expected |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@vitest/coverage-v8` | `4.1.5` (exact, not `^`) | TS/JS coverage provider for Vitest | First-party Vitest package (same repo/maintainers as the already-installed `vitest`), V8's native coverage is the documented Vitest default provider and requires no source instrumentation step [CITED: vitest.dev coverage guide, training knowledge] |
| `cargo-llvm-cov` | `0.9.1` (crates.io, per WebSearch; not independently re-verified against crates.io API this session) [ASSUMED - version only] | Rust coverage via LLVM source-based instrumentation across the whole Cargo workspace | Maintained by `taiki-e` (same author as widely-used `cargo-hack`, `install-action`); wraps `cargo test` directly so it needs no separate test harness [VERIFIED: package-legitimacy check, crates.io, OK verdict, 131021 weekly downloads, repo `github.com/taiki-e/cargo-llvm-cov`] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `taiki-e/install-action@cargo-llvm-cov` | latest pinned by the action | CI-only installer for `cargo-llvm-cov` that avoids a `cargo install` compile step per run | Use in the new CI coverage job only; not needed locally if the developer already has the binary |
| `llvm-tools` rustup component | matches `rust-toolchain.toml` channel (1.98.0) | Provides the LLVM profiling instrumentation `cargo-llvm-cov` links against | Required alongside `cargo-llvm-cov`; add via `components: llvm-tools` on the `dtolnay/rust-toolchain@stable` CI step (that action's toolchain choice is overridden by the repo's `rust-toolchain.toml` once cargo runs inside the repo, so requesting `llvm-tools` there attaches it to whichever toolchain rustup actually resolves) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@vitest/coverage-v8` | `@vitest/coverage-istanbul` | Requires Babel-based instrumentation, slower, and is the non-default Vitest provider; D-03 already locks in v8 |
| `cargo-llvm-cov` | `tarpaulin` | Linux-only historically, weaker macOS support (this repo has a macOS-only native-e2e path and Tauri desktop targets); `cargo-llvm-cov` supports macOS/Windows/Linux uniformly and is the tool named in D-03 |
| Committing coverage HTML | Uploading as CI artifact only | D-02 already specifies artifact + Job Summary, not committed output; `coverage/` is already gitignored [VERIFIED: .gitignore:47 `coverage/`] |

**Installation:**
```bash
pnpm add -D @vitest/coverage-v8@4.1.5
# cargo-llvm-cov is not a Cargo.toml dependency (D-03) - install as a cargo subcommand:
cargo install cargo-llvm-cov --locked   # local, one-time
rustup component add llvm-tools          # local, one-time (if rustup is present)
```

**Version verification performed this session:**
- `npm view @vitest/coverage-v8@4.1.5 version` returned `4.1.5` - the exact version exists on the npm registry and is the version `vitest@4.1.5`'s own `peerDependencies` block names as its `@vitest/coverage-v8` counterpart [VERIFIED: pnpm-lock.yaml:4150 `'@vitest/coverage-v8': 4.1.5` inside `vitest@4.1.5`'s peerDependencies; npm registry lookup confirms the version is published].
- `cargo llvm-cov --version` and `which cargo-llvm-cov` both failed in this environment - **not installed locally, and this environment has no `rustup` at all** (`rustup show` -> `command not found`), so the `llvm-tools` component step could not be exercised. `cargo`/`rustc` here are Homebrew-installed at `1.97.1`, which does not match the repo's pinned `rust-toolchain.toml` (`1.98.0`) [VERIFIED: src-tauri/rust-toolchain.toml:2 `channel = "1.98.0"`; local `rustc --version` -> `1.97.1 (Homebrew)`]. This is an environment limitation of the research session, not a repo problem - CI's `dtolnay/rust-toolchain@stable` step plus the repo's `rust-toolchain.toml` override resolves the pin correctly today (existing `test-rust`/`clippy`/`fmt-check` CI jobs already depend on this and pass), so the same mechanism should extend cleanly to a new coverage job that also uses `dtolnay/rust-toolchain@stable`.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@vitest/coverage-v8` | npm | published today per latest tag (`5.0.2`); the specific pinned `4.1.5` release is contemporaneous with `vitest@4.1.5` itself, already a direct devDependency | 27,762,064/week | `github.com/vitest-dev/vitest` | SUS | Flagged - reason is `too-new` on the package's *latest* tag (5.0.2), not the pinned 4.1.5 release; planner must add a `checkpoint:human-verify` before `pnpm add -D @vitest/coverage-v8@4.1.5` even though it is a first-party sibling of the already-trusted `vitest` package |
| `cargo-llvm-cov` | crates.io | first published 2021-01-22 | 131,021/week | `github.com/taiki-e/cargo-llvm-cov` | OK | Approved - not a Cargo.toml dependency (installed as a cargo subcommand / CI action per D-03), no postinstall script signal, established multi-year maintainer |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** `@vitest/coverage-v8` - flagged only because the `@vitest/*` scope publishes very frequently (the whole Vitest monorepo just cut a `5.0.0` major within the last day per npm's `time` field); the exact pinned version (`4.1.5`) is the vitest-matched sibling of a package this repo already trusts. Still gate the install behind `checkpoint:human-verify` per protocol - do not treat the sibling relationship as a substitute for the checkpoint.

*`cargo-llvm-cov` was checked via `--ecosystem crates`, matching the correct registry for a Rust tool; no cross-ecosystem confusion risk here since it has no npm/PyPI equivalent name collision found in this session.*

## Architecture Patterns

### System Architecture Diagram

```
Developer workstation                  GitHub Actions (push to main only)
+----------------------+                +---------------------------------------+
| make coverage         |                | job: coverage (new)                  |
|  -> pnpm exec vitest   |                |  if: github.event_name == 'push'     |
|     run src scripts    |                |  1. checkout                          |
|     --coverage         |---- same ----->|  2. setup pnpm/node (mirrors verify)  |
|  -> cd src-tauri &&    |     commands   |  3. setup rust stable + llvm-tools    |
|     cargo llvm-cov     |                |  4. taiki-e/install-action cargo-llvm-cov |
|     --workspace --html |                |  5. apt-get Tauri linux deps (same as |
|                        |                |     verify job - src-tauri must build)|
| terminal totals line   |                |  6. pnpm install --frozen-lockfile    |
| per language           |                |  7. vitest run src scripts --coverage |
+-----------+------------+                |     --exclude check-command-isolation |
            |                             |     -> print TS totals to terminal    |
            | HTML written to             |     -> append totals table to         |
            | coverage/ (gitignored)      |        $GITHUB_STEP_SUMMARY           |
            v                             |  8. cargo llvm-cov --workspace --html |
    Local browser (open                   |     --output-dir ../coverage-rust     |
    coverage/index.html)                  |     -> summary-only totals appended   |
                                           |        to $GITHUB_STEP_SUMMARY        |
                                           |  9. upload-artifact: coverage HTML    |
                                           |     (TS + Rust), non-required check   |
                                           +---------------------------------------+

GATE-08 probe (separate, one-time, manual dispatch):
  local branch --(edit e2e/startup.spec.ts, 1 failing assertion)--> git push
  --(gh workflow run ci.yml --ref <branch>)--> CI e2e job runs --(fails)-->
  "Upload e2e artifacts on failure" step --> artifact "playwright-report"
  --(gh run download <run-id> -n playwright-report)--> local unzip -l
  trace.zip --> record byte/entry counts in 11-VERIFICATION.md --> revert spec,
  delete branch locally and on remote

VALID-01 / SEC-03 (docs-tier, no new runtime path):
  /gsd-validate-phase 01|02|03  --> gsd_run query init.phase-op resolves phase_dir
  under .planning/milestones/v1.0-phases/**  --> gsd-nyquist-auditor reads
  PLAN+SUMMARY+impl files --> updates that phase's VALIDATION.md in place

  /gsd-secure-phase 02  --> resolves 02-shared-scanner-and-path-invariants/
  --> gsd-security-auditor verifies the 8 T-02-* threats against HEAD code
  --> writes 02-SECURITY.md (new file) in the 03-SECURITY.md format
```

### Recommended Project Structure

No new directories. New/changed files only:

```
Makefile                     # + `coverage` target (mirrors verify-integration's "deliberately NOT part of verify" comment pattern)
package.json                 # + @vitest/coverage-v8 devDependency
.github/workflows/ci.yml     # + `coverage` job (push-only, non-required)
coverage/                    # already gitignored; HTML output lands here, both TS and Rust subtrees
.planning/phases/11-milestone-verification-evidence/11-VERIFICATION.md
                              # coverage baseline totals + GATE-08 probe evidence (D-07)
.planning/milestones/v1.0-phases/01-.../01-VALIDATION.md   # status: draft -> validated
.planning/milestones/v1.0-phases/02-.../02-VALIDATION.md   # status: draft -> validated
.planning/milestones/v1.0-phases/02-.../02-SECURITY.md     # new file (D-12)
.planning/milestones/v1.0-phases/03-.../03-VALIDATION.md   # status: draft -> validated
.planning/milestones/v1.0-MILESTONE-AUDIT.md               # append "Resolved in v1.1 Phase 11" section
.planning/REQUIREMENTS.md                                   # flip TEST-02/GATE-08/VALID-01/SEC-03 to Complete (D-14)
```

### Pattern 1: Non-gating Makefile target with an explanatory "why not in verify" comment

**What:** Every existing target that is deliberately outside `verify` (`verify-integration`, `test-e2e-native`) carries a comment block directly above it explaining why, referencing the owning requirement ID.
**When to use:** For the new `coverage` target, to keep the convention consistent.
**Example:**
```makefile
# Deliberately NOT part of `verify`: coverage is a diagnostic artifact, not a
# gate (TEST-02, D-01/D-04 - no threshold, no fail condition). Run manually or
# via the push-only CI job in ci.yml.
.PHONY: coverage
coverage: node_modules $(ICON_PATH) ## TS + Rust coverage reports (non-gating, TEST-02)
	$(PNPM) exec vitest run src scripts --exclude '**/check-command-isolation.test.mjs' --coverage
	cd $(TAURI_DIR) && $(CARGO) llvm-cov --workspace --html --output-dir ../coverage/rust
	cd $(TAURI_DIR) && $(CARGO) llvm-cov --workspace --summary-only
```
[Source: pattern matched from Makefile:258-266 `verify-integration` and Makefile:233-241 `test-e2e-native` comment style, both read this session]

### Pattern 2: CI job gated on `github.event_name == 'push'`, independent of the `decision` dedup job

**What:** `ci.yml`'s existing `decision` job dedupes the expensive `verify`/`e2e`/`native-e2e-compile` jobs on a push that already passed as a PR (comparing tree SHAs). A coverage job should NOT depend on `decision`/`run_full`, because D-01 asks for coverage "on push to main only" as its own concern, not as part of the expensive-verification dedup logic; every push to `main` is a legitimate point to refresh the coverage baseline, including ones that were already PR-validated.
**When to use:** For the new `coverage` job.
**Example:**
```yaml
  coverage:
    name: coverage report
    if: github.event_name == 'push'
    runs-on: ubuntu-22.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.15.0 }
      - uses: actions/setup-node@v5
        with: { node-version: 22.22.3, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with: { components: llvm-tools }
      - uses: taiki-e/install-action@cargo-llvm-cov
      - name: Install Linux Tauri dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
            libayatana-appindicator3-dev librsvg2-dev
      - run: pnpm install --frozen-lockfile
      - run: make coverage
      - name: Write coverage totals to job summary
        run: |
          echo "### Coverage totals" >> "$GITHUB_STEP_SUMMARY"
          # append TS + Rust totals lines here
      - uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/
          retention-days: 30
```
[Source: modeled on ci.yml's existing `verify`/`e2e` job steps, read in full this session - `.github/workflows/ci.yml:101-230`]

### Anti-Patterns to Avoid

- **Adding coverage thresholds:** D-04 explicitly forbids this. Do not set `coverage.thresholds` in a Vitest config or `--fail-under-lines` on `cargo-llvm-cov`.
- **Making the coverage job a required check:** There are currently **no required status checks configured on `main` at all** [VERIFIED: `gh api repos/:owner/:repo/branches/main/protection` returned no `required_status_checks` key this session], so there is nothing to accidentally add the job to - but do not add branch-protection configuration as part of this phase, and do not make any other job `needs: coverage`.
- **Re-using the `decision` job's `run_full` output to gate coverage:** conflates two different concerns (expensive-verification dedup vs. "did this push happen").

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| V8 coverage collection/merging | A custom `node --experimental-test-coverage` wrapper or manual `v8.Coverage` API usage | `@vitest/coverage-v8` | Vitest already owns the test-runner process; its coverage provider integrates with its own reporter/watch lifecycle for free |
| Rust source-based coverage | Hand-parsing `-C instrument-coverage` LLVM profile data | `cargo-llvm-cov` | It already wraps `llvm-profdata`/`llvm-cov` invocation, workspace member discovery, and HTML rendering; hand-rolling this duplicates a well-maintained tool for no benefit |
| CI trace-capture proof | Trusting Playwright's documented `retain-on-failure` behavior without re-proving it against the *current* shipped config | A real, fresh `gh workflow run` probe (D-05/D-06) | This is precisely the class of "very likely fine" claim the v1.0 audit refused to accept as closing evidence; the phase's own goal is that the audit trail be as trustworthy as the product |

**Key insight:** All four items in this phase are "trust but verify" work, not construction work. The single largest time sink risk is treating VALID-01/SEC-03 as if new tests or new mitigations are needed by default - the investigation in this research session found the opposite in almost every case: the tests and mitigations already exist and only the metadata needs correcting.

## VALID-01 Reconciliation Inventory

This is the requirement-to-test map built by reading every `01/02/03-VALIDATION.md` row and
independently grepping/reading the implementation this session (not read off SUMMARY.md claims
alone). All three files currently carry `status: draft` and stale `TBD`/`W0`/`pending` markers;
none of that reflects "no test exists" - it reflects "validate-phase was never re-run after the
plans executed."

### Phase 01 (`01-trustworthy-verify-signal`) - all 7 rows are gate-behavior, manual-only by design

01-VALIDATION.md's own Wave 0/Manual-Only sections already correctly classify GATE-01..07 as
break-and-revert gate checks, not unit-testable behavior (there is no "function" to unit-test for
"does `make verify` go red when Rust is unformatted"). The evidence already exists and is cited
inline in `01-VERIFICATION.md`'s "Required Artifacts" table [VERIFIED: 01-VERIFICATION.md:60-69,
read this session] and in each `01-0N-SUMMARY.md`'s break-and-revert record referenced there.

| Requirement | Classification | Evidence already on file |
|---|---|---|
| GATE-01 (fmt+clippy gate) | manual-only (break-and-revert) | `01-01-SUMMARY.md`, `01-02-SUMMARY.md`; `Makefile` `verify` target lists `fmt-check clippy` [VERIFIED: Makefile:376] |
| GATE-02 (hook-dep + unused-symbol lint) | manual-only | `01-07-SUMMARY.md`; `eslint.config.js` 4-rule flat config, `lint` wired into `verify` [VERIFIED: Makefile:376 `lint` present] |
| GATE-03 (typecheck e2e/ + scripts/) | manual-only | `01-05-SUMMARY.md`; `tsconfig.e2e.json`/`tsconfig.scripts.json` referenced from `tsconfig.json` |
| GATE-04 (CI trace on e2e failure) | manual-only, CI-only | This is the same claim GATE-08 re-proves; 01-VERIFICATION.md's "Human Verification Required" section already records the 2026-08-22 resolution (run 32569215249), which GATE-08 supersedes with fresh evidence |
| GATE-05 (pinned Rust toolchain) | manual-only | `rust-toolchain.toml` present, `channel = "1.98.0"` [VERIFIED: src-tauri/rust-toolchain.toml:2] |
| GATE-06 (`@types/dompurify` removed) | automated | `package.json` has no `@types/dompurify`, has `dompurify: ^3.4.1` [VERIFIED: package.json:60, absence of the types package confirmed by full-file read] |
| GATE-07 (truthful E2E ledger) | automated (grep) | `src/lib/e2eFlow.ts` `TODO_LEDGER` - cited already in 01-VERIFICATION.md:69 |

**Wave 0 requirements:** all already satisfied per 01-VERIFICATION.md's own findings. **No new
tests needed for Phase 01.** The plan's action here is purely: run `/gsd-validate-phase 01`, let it
confirm the Manual-Only classification stands, set `status: validated`, `nyquist_compliant: true`.

### Phase 02 (`02-shared-scanner-and-path-invariants`) - every row has a real, currently-passing test

| Requirement row (02-VALIDATION.md) | Automated command in the file | Test confirmed present this session | Status |
|---|---|---|---|
| 02-01 Task 1 - `paths.rs` module (SCAN-01, SCAN-03) | `cargo test --lib -- paths:: workspace_files:: content_search::` | `src-tauri/src/paths.rs` has 14 `#[test]` functions incl. `ensure_within_accepts_descendant`, `ensure_within_rejects_dotdot_escape`, `ensure_within_rejects_unrelated_absolute_path`, `require_absolute_accepts_absolute_path`, `require_absolute_rejects_relative_path`, `is_under_generated_dir_*` (4 tests) [VERIFIED: src-tauri/src/paths.rs:149-233, read this session] | COVERED - flip `[File Exists]` from created-marker to checked, `[Status]` to green |
| 02-01 Task 2 - `rg_visibility` reconciliation (SCAN-02) | `cargo test --lib content_search::` | `rg_hidden_and_git_traversal_follow_dot_folder_allowlist` exists at `src-tauri/src/content_search.rs:871`; `exclude_git: true` set unconditionally at lines 272/876/888/900 [VERIFIED: grep this session] | COVERED |
| 02-02 Task 1-3 - vault/secrets/project_activity/evidence_binder rewire (SCAN-01, SCAN-02) | `cargo test --lib -- vault:: secrets:: project_activity:: evidence_binder:: inbox::` | All four modules import and use `crate::paths::GENERATED_DIRS` [VERIFIED: `vault.rs:18,421,559,628`; `secrets.rs:4,809` with `should_prune` at `secrets.rs:791-814`; `project_activity.rs:20,331`; `evidence_binder.rs:6,1542` - all read this session]; `vault.rs` has a dedicated test (`vault.rs:1512-1525` docstring + fixture writing `__pycache__/cached.md` etc., confirming the union-proof test exists) | COVERED |
| 02-01 Task 3 - `ensure_within` promotion into `paths.rs` (SCAN-03) | `cargo test --lib maru_dir::` | `maru_dir.rs:26` imports `ensure_within`/`require_absolute`/`native_e2e_dir_override` from `crate::paths`, used at `maru_dir.rs:937,1178` [VERIFIED: grep this session] | COVERED |
| 02-03 Task 1 - `require_absolute` guard in `maru_home()`/`install_root_base()` (SCAN-04) | `cargo test --lib skill_host::fs` | `skill_host/fs.rs:22-31` (`maru_home`) and `:45-52` (`install_root_base`) both call `require_absolute(base)` on every return path; regression test `maru_home_rejects_relative_test_home` at `skill_host/fs.rs:300` [VERIFIED: read this session] | COVERED |
| 02-03 Task 2 - stray `Users/` tree deleted (SCAN-05) | `test ! -e Users` + guard test above | No `Users` directory exists at repo root and no git history entry for one under that name was found this session [VERIFIED: `find . -maxdepth 1 -iname Users` empty] | COVERED |

**No new tests needed for Phase 02 either.** The one nuance: 02-VALIDATION.md's Manual-Only section
lists "Composite `make verify` green on committed tree" as manual due to a shared-checkout
contention note from 2026-08-23 (a concurrent `hwped` session's dirty files) - this is stale and
should be dropped or re-verified fresh against the current clean tree; it does not need a new test,
just a fresh `make verify` run confirmation during the validate-phase pass.

### Phase 03 (`03-typed-ipc-error-contract`) - every row has a real, currently-passing test; one metric has drifted (informational, not a gap)

| Requirement row (03-VALIDATION.md) | Automated command in the file | Test confirmed present this session | Status |
|---|---|---|---|
| ERR-01 (`normalizeIpcError` type-guards) | `pnpm vitest run src/lib/ipcError.test.ts` | File exists with 5 `it(...)` cases: accepts contract-coded body, degrades unknown code to plain Error, drops empty-code prefix, idempotent re-normalization, passthrough for null/string/Error/shapeless [VERIFIED: src/lib/ipcError.test.ts:1-60, read this session] | COVERED |
| ERR-02 (cross-language code-rename drill) | `cargo test --lib ipc_error` + `pnpm typecheck` + rename drill | `src-tauri/src/ipc_error.rs` has `ipc_error_codes_are_stable` (:202) and `ipc_error_wire_shape_round_trips` (:215); **additionally**, `src/lib/types.test.ts` is a permanent cross-language guard added by `03-04` that reads `ipc_error.rs` via Vite `?raw` and diffs its `pub const` values against the TS `IPC_ERROR_CODES` union - this closes a gap the original 3-drill plan left open (a Rust-only rename with its own pin-test updated stayed green everywhere except this new guard) [VERIFIED: 03-04-SUMMARY.md frontmatter `coverage` D1-D4, and file existence confirmed] | COVERED - this row is actually *better* covered than the VALIDATION.md draft describes; the draft predates `src/lib/types.test.ts` |
| ERR-03 (residual `.includes()` matcher grep + `reportInsert`/`today` tests) | `pnpm vitest run src/lib/diagram/reportInsert.test.ts src/components/today` + grep | `src/lib/diagram/reportInsert.test.ts` and `src/lib/today.test.ts` both exist [VERIFIED: `find` this session]; 03-04-SUMMARY.md D6 records the residual grep at zero matches | COVERED |
| ERR-04 (`Result<_, String>` count baseline) | `grep -roE 'Result<.*, String>' src-tauri/src --include="*.rs" \| wc -l` (VALIDATION.md cites baseline 1,138) | The command itself exists and runs; re-run this session returned **1,845**, not 1,138 or the post-migration 1,128 recorded in `03-04-SUMMARY.md` | **DRIFTED METRIC, not a coverage gap** - see note below |
| D-09 (wire shape round-trip, message text unchanged) | `cargo test --lib ipc_error` | `no_code_emitting_path_flattens_its_error_to_string` (:146), `ipc_error_wire_shape_round_trips` (:215) both exist [VERIFIED: grep this session] | COVERED |

**ERR-04 drift note (important for the planner):** the VALIDATION.md's stored baseline (1,138) and
03-04-SUMMARY.md's re-confirmed post-migration count (1,128) both predate seven subsequent v1.1
phases of active development (04 through 10) that touched `src-tauri/src/**` extensively - the
current count of 1,845 reflects that legitimate growth, not contract drift. This is **not** a
VALID-01 gap to fix with a new test; it is a live grep-based "baseline" check whose recorded number
is a point-in-time historical fact, not a live invariant. When validate-phase runs, record this
plainly: the mechanism (the grep command) is still valid and still runs; the specific number in the
draft file is historical and should either be left as the historical Phase 3 baseline (with a note
that current HEAD reads differently) or updated to note both figures. Do not attempt to force the
current tree back to 1,138/1,128 - there is no requirement that the raw match count stay fixed
across later phases, only that ERR-02/ERR-03's actual code-path guarantees hold, which they do.

**Summary for the planner:** across all three phases, zero requirements are missing an automated
test. D-09's gap policy ("a requirement a unit test can cover and has no automated test gets a
small test") therefore applies to **no rows** - this phase's VALID-01 work is pure metadata
reconciliation (running validate-phase three times, letting it read the tests above, and setting
`status: validated` / `nyquist_compliant: true`), not new test-writing. Budget accordingly; do not
plan wave time for "write missing unit tests" beyond a contingency buffer in case the
gsd-nyquist-auditor subagent's live cross-reference disagrees with this session's manual mapping.

## SEC-03 Threat Register Audit

All 8 `T-02-*` threats from the `<threat_model>` blocks in `02-01-PLAN.md`, `02-02-PLAN.md`, and
`02-03-PLAN.md` [VERIFIED: read via `awk` extraction this session] were checked against current
HEAD. **All 8 are mitigated in code today; none appears open.**

| Threat ID | Category | Component | Severity | Disposition (planned) | Code evidence at HEAD | Verdict |
|---|---|---|---|---|---|---|
| T-02-01 | Tampering/Elevation | `ensure_within` (paths.rs) | medium | mitigate | `ensure_within` at `paths.rs:78`, with 4 dedicated unit tests (descendant/equal/dotdot-escape/unrelated-absolute) at `paths.rs:149-172` [VERIFIED] | CLOSED |
| T-02-02 | Information disclosure | scanner prune lists (`workspace_files.rs`, `content_search.rs`) | medium | mitigate | 14-entry `GENERATED_DIRS` union at `paths.rs:42-57` including `.git`/`.venv`; `exclude_git: true` set unconditionally at `content_search.rs:272,876,888,900`, test `rg_hidden_and_git_traversal_follow_dot_folder_allowlist` at `content_search.rs:871` [VERIFIED] | CLOSED |
| T-02-03 | Tampering | symlink-following containment bypass | low | accept (no code change expected) | Design rationale comment still present at `vault.rs:690-695` explaining lexical containment is deliberate (`canonicalize()` would falsely reject user symlinks; `..` traversal blocked by `lexical_normalize`) [VERIFIED] | CLOSED (accepted risk, unchanged) |
| T-02-04 | Information disclosure | `evidence_binder.rs::is_excluded_dir` | high | mitigate | `.maru` exclusion ORed with the shared union at `evidence_binder.rs:1540-1542` [VERIFIED] | CLOSED |
| T-02-05 | Information disclosure | `vault.rs::ScanFilter::is_excluded_path` | medium | mitigate | `generated_dirs` injected-parameter signature preserved; `inbox.rs`'s three empty-slice call sites (`inbox.rs:1034,1115,1178`) confirmed present, keeping inbox drop folders outside the union as designed [VERIFIED] | CLOSED |
| T-02-06 | Information disclosure | `secrets.rs::should_prune` | low | accept | `should_prune` at `secrets.rs:791-814` widens prune set via `GENERATED_DIRS` (line 809) while the `.maru/secrets`/`.secrets` prefix rules stay separately enforced at lines 796-805 [VERIFIED] | CLOSED |
| T-02-07 | Tampering | `skill_host/fs.rs::maru_home` / `install_root_base` | high | mitigate | Both functions wrap their final return in `require_absolute(base)` (`fs.rs:31` and `:52`); regression test `maru_home_rejects_relative_test_home` at `fs.rs:300` [VERIFIED] | CLOSED |
| T-02-08 | Tampering | env-mutating guard test race | medium | mitigate | `test_maru_home_lock()` fixture idiom present and used at `fs.rs:218,253,273,304` [VERIFIED] | CLOSED |

**Expected retroactive audit outcome:** `threats_open: 0`. Per D-13, "an open threat with a small,
local fix is fixed in this phase" and "a larger one is recorded as open and proposed as a GitHub
issue" - **neither branch is expected to trigger**, since no threat appears open. The plan should
still run the actual `/gsd-secure-phase 02` dispatch rather than skip it on this research's say-so
(per `secure-phase.md`'s own short-circuit logic: `threats_open: 0 AND register_authored_at_plan_time: true
AND asvs_level == 1` -> skip directly to writing `02-SECURITY.md`, since all three PLAN.md files did
carry parseable `<threat_model>` blocks [VERIFIED: `register_authored_at_plan_time` would resolve
`true`] and Phase 1/3's existing SECURITY.md files both used `asvs_level: 1` [VERIFIED:
`01-SECURITY.md:7`]). This means the audit is likely to be fast (no auditor subagent dispatch
needed at all under the short-circuit rule) - budget the wave accordingly, but do not skip the
actual command.

**02-SECURITY.md format to follow** (from `03-SECURITY.md`, read in full this session): frontmatter
`phase`, `slug`, `status`, `threats_open`, `asvs_level`, `created`; body sections `## Trust
Boundaries` (table), `## Threat Register` (table with Threat ID/Category/Component/Severity/
Disposition/Mitigation/Status), `## Accepted Risks Log`, `## Security Audit Trail`, `## Sign-Off`
checklist. `01-SECURITY.md` is structurally identical and can serve as the second reference D-12
names - both were read this session and share the same shape.

## GATE-08 Probe Mechanics

- **Mechanism already exists:** `ci.yml` has `workflow_dispatch:` at the top level (line 21)
  [VERIFIED: .github/workflows/ci.yml:21], so `gh workflow run ci.yml --ref <branch>` works with no
  workflow edits.
- **Config is unchanged since v1.0:** `playwright.config.ts`'s only git history entry is commit
  `2d2e8660` (2026-08-22, "Phase 1: make a green `make verify` mean something (#276)") [VERIFIED:
  `git log --oneline -- playwright.config.ts`], which is the PR merge commit that squashed the
  narrowing work the old `01-VERIFICATION.md` refers to as `a064994`. There have been **no further
  commits to this file** since v1.0 closed, so today's config is byte-identical to what the earlier
  (now-expired) 2026-08-22 probe exercised. Record `2d2e8660` as "the config commit" for D-07.
- **Candidate spec:** `e2e/startup.spec.ts` - a single, fast, self-contained test with two hard
  assertions (`expect(marks).toContain("workspace:first-usable")` and
  `expect(marks).not.toContain("terminal:full-mount-request")`) [VERIFIED: read in full this
  session, 27 lines]. Flipping the second assertion (`.not.toContain` -> `.toContain`, or adding an
  impossible `toHaveCount(1)` on a selector known to be absent) produces a clean, deterministic
  failure with no flake risk, unlike interaction-heavy specs (drag/drop, multi-step forms).
- **Artifact retrieval:** the "Upload e2e artifacts on failure" step uploads `playwright-report/`
  and `test-results/` under one artifact named `playwright-report`, `retention-days: 7`
  [VERIFIED: .github/workflows/ci.yml:221-229]. Retrieve with:
  ```bash
  gh run list --workflow=ci.yml --branch <probe-branch> --limit 1 --json databaseId,conclusion
  gh run download <run-id> -n playwright-report -D ./gate08-probe
  find ./gate08-probe -name 'trace.zip'
  unzip -l ./gate08-probe/test-results/<spec-dir>/trace.zip
  ```
  `gh` is authenticated and functional in this environment and `ci.yml` runs frequently on this
  repo (confirmed via `gh run list` this session), so the dispatch-and-download loop is a live,
  exercised path, not a hypothetical one.
- **Comparison baseline:** v1.0's proof recorded **123,399 bytes across 6 entries** for the
  narrowed config vs. **1,752,382 bytes / 14 entries** for the old wide config [VERIFIED:
  01-VERIFICATION.md:191 and playwright.config.ts:20-24 comment, both read this session]. Since the
  config is unchanged, D-07's fresh probe should reproduce a very similar (not necessarily
  byte-identical - timestamps/stack line numbers vary) entry count and size in that neighborhood;
  a result wildly different from ~123 KB / 6 entries would itself be a finding worth flagging.
- **Cleanup:** `git push origin --delete <branch>` after capture, plus local `git branch -D
  <branch>`, per D-06's approved method. No PR, no `main` touch.

## v1.0 Audit Append Location

`.planning/milestones/v1.0-MILESTONE-AUDIT.md` is 156 lines, ending with `## Closeout
Recommendation` [VERIFIED: read in full this session]. Per D-11 ("keeps its original frontmatter
and verdict... a section is appended"), add a new final section **after** `## Closeout
Recommendation`:

```markdown
## Resolved in v1.1 Phase 11

- **GATE-04 trace re-proof:** [link to 11-VERIFICATION.md's GATE-08 evidence section] - a fresh
  deliberate CI failure against the unchanged narrowed trace config (commit `2d2e8660`) confirmed
  a downloadable, non-trivial `trace.zip`. See GATE-08 in `.planning/REQUIREMENTS.md`.
- **Nyquist metadata, Phases 01-03:** [links to the three updated VALIDATION.md files] - all three
  now carry `status: validated`; reconciliation found every requirement already had a shipped,
  passing test (no coverage gap existed, only stale pre-execution metadata).
- **Phase 02 security report:** [link to `02-shared-scanner-and-path-invariants/02-SECURITY.md`] -
  retroactive audit of all 8 `T-02-*` threats found all closed at HEAD. Note: the claim above that
  "Phases 02-03 have no SECURITY.md" was already half-resolved before this phase started -
  `03-SECURITY.md` was added in commit `4fd3ea3b` (2026-08-28), pre-dating this phase; only Phase
  02 was still missing one.
```

Do not touch the `tech_debt:` frontmatter list, `gaps:`, `scores:`, or the `## Verdict`/`##
Technical Debt Accepted at Closeout` prose - those are the historical record D-11 says to preserve.

## Common Pitfalls

### Pitfall 1: No existing Vitest `test` config block to extend

**What goes wrong:** A plan might look for a `vitest.config.ts` or a `test: {}` block inside
`vite.config.ts` to add `coverage: {...}` options to, and find nothing.
**Why it happens:** This repo runs Vitest entirely off CLI arguments (`vitest run src scripts
--exclude ...`) with zero config-file `test` block [VERIFIED: `vite.config.ts` read in full this
session - only `plugins`, `clearScreen`, `server`, `envPrefix` keys exist].
**How to avoid:** Add coverage flags on the command line (`--coverage`, and if include/exclude
scoping is needed, `--coverage.include`/`--coverage.exclude`), not via a new config block, to match
the codebase's existing convention. Only add a `test: {}` block if CLI flags become unwieldy.
**Warning signs:** A `vitest.config.ts` appearing in the diff where none existed before is worth a
second look against this convention.

### Pitfall 2: Vitest's default coverage scope is "files touched by tests," not "all files in src/scripts"

**What goes wrong:** Assuming `--coverage` alone reports coverage for every file under `src/` and
`scripts/`, including files no test ever imports.
**Why it happens:** `@vitest/coverage-v8`'s default behavior only instruments files that are
actually loaded during the test run, unless `coverage.all: true` plus `coverage.include` globs are
set.
**How to avoid:** D-02/D-03 do not ask for a specific denominator (no threshold to enforce), so the
default "files touched by tests" scope is acceptable and matches D-03's phrasing ("same scope as
`pnpm test`") literally - `pnpm test` only ever exercises files its own test suite imports. Do not
add `coverage.all: true` unless the plan explicitly wants the wider (and typically much lower)
percentage that produces.
**Warning signs:** A coverage percentage that looks implausibly high for a codebase this size is a
sign the default (narrower, common) scope is in effect - which is expected, not a bug.

### Pitfall 3: `scripts/check-command-isolation.test.mjs` and coverage

**What goes wrong:** Forgetting that this file runs via `node --test`, not Vitest, and would
otherwise be picked up by Vitest's default test-file glob.
**Why it happens:** `package.json`'s existing `test` script already explicitly excludes it
(`--exclude '**/check-command-isolation.test.mjs'`) precisely because it needs `node --test`, not
Vitest [VERIFIED: package.json:31].
**How to avoid:** The `make coverage` / CI coverage command must carry the identical `--exclude`
flag, or Vitest will attempt to run (and fail on, or silently skip) that file. Its own coverage is
out of scope for D-03 as written (Vitest v8 coverage cannot instrument a `node --test` run without
separate `node --experimental-test-coverage` tooling, which D-03 does not ask for).
**Warning signs:** A coverage run that errors on `check-command-isolation.test.mjs`, or that
reports it as 0% covered noise in the HTML report.

### Pitfall 4: Toolchain mismatch between this research environment and CI/repo pin

**What goes wrong:** Assuming `cargo-llvm-cov` "just works" because it is a well-regarded tool,
without accounting for the fact that it needs the `llvm-tools` rustup component matched to the
exact active toolchain.
**Why it happens:** This repo pins `rust-toolchain.toml` to `1.98.0`; CI's `dtolnay/rust-toolchain@stable`
step does not request `llvm-tools` today (existing jobs don't need it) - the plan must add
`components: llvm-tools` specifically to the new coverage job's toolchain step, not assume it comes
free with `stable`.
**How to avoid:** Add `components: llvm-tools` explicitly on the coverage job's `dtolnay/rust-toolchain@stable`
step (this research could not verify this end-to-end locally - no `rustup` present in this
environment at all - so treat it as a `checkpoint:human-verify` or first-CI-run confirmation, not a
closed fact).
**Warning signs:** `cargo llvm-cov` CI step failing with a "no llvm-tools component" or similar
linker/profile-data error.

### Pitfall 5: ERR-04's grep baseline looks like a regression when it is not

**What goes wrong:** Re-running `03-VALIDATION.md`'s literal ERR-04 command during VALID-01
reconciliation and treating the 1,845 result (vs. the stored 1,138/1,128) as a validation failure.
**Why it happens:** The number is a point-in-time historical measurement from Phase 3, not a live
invariant; seven subsequent phases (04-10) added `Result<_, String>` signatures across the Rust
codebase as part of ordinary feature work, none of which is required to preserve the raw count.
**How to avoid:** See the "ERR-04 drift note" above. Record both numbers with dates/commits; do not
treat the delta as something to "fix."
**Warning signs:** A plan task that tries to reduce the current `Result<_, String>` count back
toward 1,138 - that is out of scope and would touch production code beyond a "small test" (violates
the phase's own code-change boundary: "Code changes are limited to the coverage tooling, small
tests that close genuine VALID-01 gaps, and small fixes for open SEC-03 threats").

## Code Examples

### Vitest coverage invocation matching `pnpm test`'s existing scope

```bash
# Source: pattern matched from package.json:31's existing `test` script, this session
pnpm exec vitest run src scripts --exclude '**/check-command-isolation.test.mjs' --coverage
```

### cargo-llvm-cov across the whole workspace (both members)

```bash
# Source: taiki-e/cargo-llvm-cov README pattern (training knowledge) + this repo's
# src-tauri/Cargo.toml:19-22 `[workspace] members = [".", "maru-cli"]`, `default-members = ["."]`
# read this session - `--workspace` overrides default-members so both crates are covered.
cd src-tauri
cargo llvm-cov --workspace --html --output-dir ../coverage/rust
cargo llvm-cov --workspace --summary-only
```

### GitHub Step Summary totals table

```bash
# Source: GitHub Actions documented $GITHUB_STEP_SUMMARY mechanism (training knowledge);
# ci.yml already uses this exact pattern for the CI-decision dedup message
# (.github/workflows/ci.yml:97-99, read this session).
{
  echo "### Coverage totals"
  echo "| Language | Lines | Functions |"
  echo "|---|---|---|"
  echo "| TypeScript | <ts-pct>% | <ts-fn-pct>% |"
  echo "| Rust | <rust-pct>% | <rust-fn-pct>% |"
} >> "$GITHUB_STEP_SUMMARY"
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| No coverage measurement of any kind (TEST-02 was deferred to v2 at v1.0 closeout) | Non-gating coverage as a first-class evidence artifact | This phase (v1.1 Phase 11) | Establishes a baseline for future eyeball comparison; does not change any gate |
| GATE-04 proof accepted on documented Playwright behavior + a since-expired CI artifact | Fresh, re-runnable, repo-recorded evidence (byte/entry counts committed to `11-VERIFICATION.md`, not relying on a 7-day CI artifact) | This phase | Evidence survives CI artifact retention, closing the exact failure mode that left v1.0's proof unverifiable |
| Nyquist validation metadata frozen at `status: draft` for 3 of 5 v1.0 phases | All 5 v1.0 phases at `status: validated` | This phase | `v1.0-MILESTONE-AUDIT.md`'s `nyquist.overall: not_validated` becomes fully compliant |

**Deprecated/outdated:** none - this phase does not remove or replace any existing tool.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `cargo-llvm-cov`'s current crates.io version is `0.9.1` | Standard Stack | Low - the plan should pin via `cargo install cargo-llvm-cov --locked` or the `taiki-e/install-action` (which resolves its own pinned version), not hardcode `0.9.1` anywhere; the exact patch version is not load-bearing |
| A2 | `dtolnay/rust-toolchain@stable` + `components: llvm-tools` will attach the component to the `rust-toolchain.toml`-resolved `1.98.0` toolchain in CI, matching the existing pattern where `stable` requests are overridden by the repo's pin | Common Pitfalls (Pitfall 4), Package Legitimacy | Medium - if wrong, the new coverage CI job fails on first run with a missing-component error; this is a fast, visible, non-destructive failure (CI job, not merge-blocking per D-01), so the cost of being wrong is one red CI run, not corrupted evidence |
| A3 | `@vitest/coverage-v8`'s "too-new" SUS signal is solely about the package's latest (5.0.2) release cadence and does not indicate any actual legitimacy problem with the specific pinned `4.1.5` release | Package Legitimacy Audit | Low-Medium - if wrong, the checkpoint:human-verify step catches it before install; the package is a first-party sibling of already-trusted `vitest`, reducing real risk |

**If this table is empty:** N/A - see rows above.

## Open Questions

1. **Will the gsd-nyquist-auditor subagent's live run agree with this session's manual VALID-01 mapping?**
   - What we know: every requirement row was traced to a specific, currently-existing test this
     session, with file:line citations.
   - What's unclear: the actual `/gsd-validate-phase` dispatch runs a fresh subagent that re-reads
     everything independently and may weigh "COVERED vs PARTIAL" differently, especially for
     ERR-04's drifted metric.
   - Recommendation: run the actual workflow per D-08 rather than hand-writing VALIDATION.md from
     this research; treat this inventory as the pre-flight expectation, not a substitute for the
     dispatch.

2. **Will `/gsd-secure-phase 02`'s short-circuit rule actually fire, or will `register_authored_at_plan_time` resolve `false`?**
   - What we know: all three `02-0N-PLAN.md` files carry parseable `<threat_model>` blocks with
     Trust Boundaries and STRIDE Threat Register tables in the expected shape [VERIFIED this
     session].
   - What's unclear: whether the live workflow's parser accepts the exact table shape used (it
     matches `01`/`03`'s already-accepted format closely, but was not run through the actual
     parser this session).
   - Recommendation: if the short-circuit doesn't fire, expect a `gsd-security-auditor` subagent
     dispatch instead of a direct write - budget a few extra minutes, not a new wave.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `cargo-llvm-cov` | TEST-02 (Rust coverage) | (dash) not installed in this research environment | (dash) | Install via `cargo install cargo-llvm-cov --locked` locally, or `taiki-e/install-action@cargo-llvm-cov` in CI (no local fallback needed if the plan only wires the CI job first and treats local `make coverage` as a nice-to-have) |
| `rustup` | `llvm-tools` component install | (dash) not installed in this research environment (Homebrew-managed `cargo`/`rustc` instead) | (dash) | CI already uses `dtolnay/rust-toolchain@stable`, which is rustup-based and unaffected by this local machine's setup; a developer on this machine would need to install rustup separately to run `make coverage` locally for the Rust half |
| `@vitest/coverage-v8` | TEST-02 (TS coverage) | (dash) not yet a devDependency | 4.1.5 (to be pinned) | none needed - straightforward `pnpm add -D` once the legitimacy checkpoint clears |
| `gh` CLI (authenticated) | GATE-08 probe dispatch/download | yes, confirmed working this session (`gh run list` succeeded) | (unspecified, functional) | none needed |
| GitHub Actions `workflow_dispatch` on `ci.yml` | GATE-08 probe | yes, already present | n/a | none needed |

**Missing dependencies with no fallback:** none - every gap above has a working fallback or is a
CI-only requirement unaffected by this local research machine's limitations.

**Missing dependencies with fallback:** `cargo-llvm-cov` and `rustup` locally (fallback: CI-first
validation, or a one-time local install as a plan task, not a blocker).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5 (TS), `cargo test` built-in harness (Rust), Playwright 1.59 (e2e) - all pre-existing, no new framework introduced |
| Config file | `vite.config.ts` (no dedicated `test:` block - coverage flags go on the CLI, see Pitfall 1); `playwright.config.ts`; none for `cargo test` |
| Quick run command | `pnpm typecheck` (TS-side sanity) / `cargo test --lib paths::` (Rust-side sanity, scoped) |
| Full suite command | `make verify` (unchanged - `coverage` stays outside it per D-01) |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEST-02 | `make coverage` produces TS + Rust HTML reports and terminal totals with no threshold | manual/smoke (this is tooling, not app behavior - verified by running the command and inspecting output, not a unit test) | `make coverage` | Wave 0 - `Makefile` target does not exist yet |
| GATE-08 | A deliberate CI e2e failure against the current trace config produces a downloadable, non-trivial `trace.zip` | manual, CI-only (identical in kind to the existing GATE-04 Manual-Only row in `01-VALIDATION.md`) | `gh workflow run ci.yml --ref <probe-branch>` then `gh run download` + `unzip -l` | N/A - one-time evidence capture, not a repo-resident test |
| VALID-01 | Every v1.0 phase 01-03 requirement maps to a real test, and VALIDATION.md metadata reflects it | automated, via `/gsd-validate-phase {01,02,03}` dispatch (which itself runs the existing per-requirement commands enumerated in the inventory above) | see the VALID-01 Reconciliation Inventory table for the exact command per requirement | All exist - confirmed this session |
| SEC-03 | Phase 02's 8 `T-02-*` threats are each verified closed (or a small fix lands for any that are open) | automated, via `/gsd-secure-phase 02` dispatch | see the SEC-03 Threat Register Audit table for per-threat code evidence | All exist - confirmed this session |

### Sampling Rate

- **Per task commit:** For TEST-02 tasks, run the new `make coverage` command directly and eyeball
  the terminal totals output (no assertion to automate - this is a reporting tool, not a behavior).
  For VALID-01/SEC-03 tasks, run the specific per-requirement command cited in the inventory tables
  above.
- **Per wave merge:** `make verify` (unaffected, still green - this phase adds no gate) plus, for
  the TEST-02 wave, a manual inspection that `coverage/index.html` (TS) and `coverage/rust/index.html`
  (Rust) both render.
- **Phase gate:** `make verify` green; `11-VERIFICATION.md` records the coverage baseline totals and
  the GATE-08 probe's byte/entry evidence; all three archived VALIDATION.md files read
  `status: validated`; `02-SECURITY.md` exists with `threats_open: 0` (or documented accepted
  risks); `REQUIREMENTS.md` shows all four rows `Complete`.

### Wave 0 Gaps

- [ ] `Makefile` `coverage` target - does not exist yet, needed before any TEST-02 task can run its
      verify command
- [ ] `@vitest/coverage-v8` devDependency - not yet installed (checkpoint:human-verify gate first,
      per Package Legitimacy Audit)
- [ ] `.github/workflows/ci.yml` `coverage` job - does not exist yet

*(VALID-01 and SEC-03 have no Wave 0 gaps - all underlying tests and audit workflows already exist.)*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | No auth surface touched by this phase |
| V3 Session Management | no | N/A |
| V4 Access Control | no | N/A |
| V5 Input Validation | no (this phase adds no new input-handling code paths) | N/A |
| V6 Cryptography | no | N/A |
| V10 Malicious Code | yes (indirectly, via new dependencies) | Package Legitimacy Audit gate above (`@vitest/coverage-v8` checkpoint:human-verify; `cargo-llvm-cov` approved) |

This phase's actual security-relevant work is SEC-03 itself (auditing Phase 02's already-shipped
threat mitigations), not new threat surface from this phase's own changes. The two new tool
installs (`@vitest/coverage-v8`, `cargo-llvm-cov`) are the only new trust-boundary crossings this
phase introduces (pnpm/cargo registry to local + CI build environment), matching the shape of
`01-SECURITY.md`'s `T-01-SC` "package-manager installs" threat pattern precedent.

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Slopsquatted/malicious devDependency added under time pressure | Tampering | Package Legitimacy Audit gate (this document) + `checkpoint:human-verify` before `pnpm add -D @vitest/coverage-v8` |
| CI coverage job accidentally becomes a merge-blocking required check | Denial of Service (developer velocity) | Confirmed no required status checks exist on `main` at all this session; do not add branch-protection config in this phase, and do not make any other job depend on `coverage` |
| Coverage HTML artifact leaking workspace file contents | Information Disclosure | HTML coverage reports show source line-by-line; this repo's test fixtures use synthetic/mocked data (consistent with `01-SECURITY.md`'s `T-01-06` precedent for the Playwright trace artifact - no real user workspace data enters CI test runs) |

## Sources

### Primary (HIGH confidence)

- `/Users/yj.lee/workspace/work/dev/maru/package.json` - full read
- `/Users/yj.lee/workspace/work/dev/maru/Makefile` - full read
- `/Users/yj.lee/workspace/work/dev/maru/vite.config.ts` - full read
- `/Users/yj.lee/workspace/work/dev/maru/playwright.config.ts` - full read
- `/Users/yj.lee/workspace/work/dev/maru/.github/workflows/ci.yml` - full read
- `/Users/yj.lee/workspace/work/dev/maru/src-tauri/Cargo.toml` - full read
- `/Users/yj.lee/workspace/work/dev/maru/pnpm-lock.yaml` - targeted read (vitest/@vitest/coverage-v8 entries)
- `/Users/yj.lee/workspace/work/dev/maru/src-tauri/src/paths.rs`, `content_search.rs`, `vault.rs`,
  `secrets.rs`, `project_activity.rs`, `evidence_binder.rs`, `inbox.rs`, `maru_dir.rs`,
  `skill_host/fs.rs`, `ipc_error.rs` - grepped and partially read this session
- `/Users/yj.lee/workspace/work/dev/maru/src/lib/ipcError.ts`, `ipcError.test.ts`, `types.test.ts` (existence + content confirmed)
- `.planning/milestones/v1.0-phases/01-trustworthy-verify-signal/01-VERIFICATION.md`, `01-VALIDATION.md`, `01-SECURITY.md` - full reads
- `.planning/milestones/v1.0-phases/02-shared-scanner-and-path-invariants/02-VALIDATION.md`, `02-01/02/03-PLAN.md` threat_model blocks - full reads
- `.planning/milestones/v1.0-phases/03-typed-ipc-error-contract/03-VALIDATION.md`, `03-04-SUMMARY.md`, `03-SECURITY.md` - full reads
- `.planning/milestones/v1.0-MILESTONE-AUDIT.md` - full read
- `~/.claude/gsd-core/workflows/validate-phase.md`, `secure-phase.md` (and confirmed the project-local copies differ only in path substitution, not behavior)
- `gh api repos/:owner/:repo/branches/main/protection` - live check, no required status checks configured
- `gsd_run query init.phase-op 01` - live check, confirmed archived phase dirs resolve correctly
- `gsd_run query package-legitimacy check` for `@vitest/coverage-v8` (npm) and `cargo-llvm-cov` (crates)
- `npm view @vitest/coverage-v8@4.1.5 version` - live registry check

### Secondary (MEDIUM confidence)

- WebSearch: "cargo-llvm-cov workspace HTML report per-crate summary GitHub Actions taiki-e/install-action" - corroborated general usage pattern, not independently re-verified against the tool's own docs this session

### Tertiary (LOW confidence)

- `cargo-llvm-cov` current crates.io version number (`0.9.1`) - from WebSearch only, not cross-checked against a live crates.io API call this session (see Assumptions Log A1)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH for package identity/version compatibility (registry-verified); MEDIUM for CI toolchain wiring (no live CI run performed this session)
- Architecture: HIGH - all patterns modeled directly on existing, working code in this same repo
- VALID-01/SEC-03 inventories: HIGH - every claim backed by a file:line read or grep this session, not by SUMMARY.md claims alone
- Pitfalls: HIGH for repo-specific pitfalls (all confirmed by direct inspection); MEDIUM for the `llvm-tools` CI wiring pitfall (untested locally)

**Research date:** 2026-09-25
**Valid until:** 2026-10-25 (30 days - stable, low-churn evidence/tooling domain; re-check sooner if `playwright.config.ts` or `src-tauri/rust-toolchain.toml` change before this phase executes)
