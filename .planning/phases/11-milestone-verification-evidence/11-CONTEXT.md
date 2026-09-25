# Phase 11: Milestone Verification & Evidence - Context

**Gathered:** 2026-09-25
**Status:** Ready for planning

<domain>
## Phase Boundary

The milestone's audit trail becomes as trustworthy as the product changes it verifies. Four evidence items are in scope:

- **TEST-02:** TypeScript and Rust test coverage is measured and reported as a non-gating artifact outside `make verify`.
- **GATE-08:** A fresh deliberate CI failure proves the narrowed Playwright trace configuration still produces a trace.
- **VALID-01:** Nyquist validation metadata for v1.0 phases 01-03 matches what `validate-phase` reports.
- **SEC-03:** v1.0 Phase 02 gets a security report, so security evidence is uniform across v1.0 phases.

Coverage gates, thresholds, external coverage services, and any product behavior change are out of scope. Code changes are limited to the coverage tooling, small tests that close genuine VALID-01 gaps, and small fixes for open SEC-03 threats.

</domain>

<decisions>
## Implementation Decisions

### Coverage report (TEST-02)
- **D-01:** Coverage runs from a local `make coverage` target and from a non-gating CI job that runs on push to `main` only, never on PRs. It stays outside `make verify`, and the CI job must not be a required check.
- **D-02:** Output is an HTML report per language, a totals line per language printed to the terminal at the end of the run, and in CI a totals table written to the GitHub Job Summary with the HTML uploaded as an artifact. No lcov and no external coverage service.
- **D-03:** Tooling defaults: Vitest coverage with the v8 provider over the same scope as `pnpm test` (`src` and `scripts`), and `cargo-llvm-cov` over the whole Cargo workspace (the app lib and `maru-cli`) with per-crate totals. The Vitest coverage package version must match the installed `vitest` (^4.1.5). The researcher confirms both tools work on the current toolchain before the plan commits to them.
- **D-04:** No threshold and no fail condition. The first measured totals are recorded once as the baseline in the phase artifacts so later runs can be compared by eye.

### GATE-08 trace proof
- **D-05:** Re-run a fresh deliberate CI failure against the current `playwright.config.ts` trace setting (`{ mode: "retain-on-failure", snapshots: false, screenshots: false }`). The 2026-08-22 probe (run 32569215249) is not accepted as closing evidence: its artifact has expired and the v1.0 audit did not accept it.
- **D-06:** Mechanism: a temporary branch adds one failing assertion to an existing e2e spec and is run with `gh workflow run ci.yml --ref <branch>` (`ci.yml` already has `workflow_dispatch`). No PR is opened and `main` is never touched. After the evidence is captured, the probe branch is deleted locally and on the remote. The user approved this method, including the branch push, the dispatch, and the branch deletion.
- **D-07:** Evidence recorded in the phase verification artifact: run URL and ID, artifact name, the failing test name, the config commit, and the `unzip -l` listing of the trace zip (entry names and byte sizes), compared against the v1.0 figures (123,399 bytes across 6 entries). The trace binary is not committed.

### VALID-01 reconciliation
- **D-08:** Run the validate-phase workflow for v1.0 phases 01, 02, and 03 in turn. Map every requirement in each VALIDATION.md to the tests that actually shipped, replace the pre-execution `TBD` / `W0` / `pending` rows, and set `status: validated` and `nyquist_compliant` from the result.
- **D-09:** Gap policy: a requirement a unit test can cover and that has no automated test gets a small test in this phase. Gate-behavior checks proven by break-and-revert (the GATE-01..05 kind) are classified manual-only, citing the recorded evidence in the phase SUMMARY files.
- **D-10:** Edit the v1.0 archive in place under `.planning/milestones/v1.0-phases/`. Only the three VALIDATION.md files change and `02-SECURITY.md` is added. No other archived document is edited.
- **D-11:** `.planning/milestones/v1.0-MILESTONE-AUDIT.md` keeps its original frontmatter and verdict. A "Resolved in v1.1 Phase 11" section is appended with one entry per debt item (GATE-04 trace, Nyquist 01-03, Phase 02 security report), each linking its evidence. The audit's claim that Phase 03 had no SECURITY.md is noted as already resolved by `03-SECURITY.md` (commit `4fd3ea3b`, 2026-08-28).

### SEC-03 security report
- **D-12:** A retroactive secure-phase audit of the 8 `T-02-*` threats declared in the `<threat_model>` blocks of `02-01..02-03-PLAN.md`, checked against current HEAD, written to `.planning/milestones/v1.0-phases/02-shared-scanner-and-path-invariants/02-SECURITY.md` in the `03-SECURITY.md` format (frontmatter `status`, `threats_open`, `asvs_level`; trust boundaries; per-threat verdict with code evidence).
- **D-13:** An open threat with a small, local fix is fixed in this phase. A larger one is recorded as open in the report and proposed as a GitHub issue, which is registered only after user approval.

### Traceability
- **D-14:** TEST-02, GATE-08, VALID-01, and SEC-03 are marked complete in `.planning/REQUIREMENTS.md` only when their evidence exists as described above.

### Claude's Discretion
- Coverage config details: reporters, include/exclude globs, output directory (`coverage/` is already gitignored), and whether the main-push job lives in `ci.yml` or its own workflow file.
- Which existing e2e spec carries the probe assertion.
- Where the coverage baseline is recorded (phase VERIFICATION or a dedicated section).
- Plan order and wave split across the four items, which are independent of each other.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` section "Phase 11: Milestone Verification & Evidence": goal and the 4 success criteria.
- `.planning/REQUIREMENTS.md`: TEST-02, GATE-08, VALID-01, SEC-03 text and traceability rows.
- `.planning/STATE.md` deferred-items table: the three v1.0 debt items promoted to v1.1 on 2026-08-28.
- `.planning/milestones/v1.0-MILESTONE-AUDIT.md`: the `tech_debt` items this phase retires, and the Nyquist coverage table.

### Coverage (TEST-02)
- `package.json`: the `test` script scope (`vitest run src scripts`, command-isolation test run separately) and the `vitest` version.
- `Makefile`: existing test targets (`test-rust` is `cargo test --lib`) and `verify`, which coverage must stay out of.
- `src-tauri/Cargo.toml`: `[workspace] members = [".", "maru-cli"]`, `default-members = ["."]`.
- `.github/workflows/ci.yml`: triggers (PR, push to main, `workflow_dispatch`), job layout, and the e2e artifact upload.

### GATE-08 trace proof
- `playwright.config.ts` lines 12-30: the narrowed trace setting and the measured contents of the trace it produces.
- `.planning/milestones/v1.0-phases/01-trustworthy-verify-signal/01-VERIFICATION.md` "Human Verification Required" item 1: the 2026-08-22 probe method and figures (run 32569215249, 123,399 bytes / 6 entries vs 1,752,382 bytes / 14 entries).
- `.github/workflows/ci.yml` "Upload e2e artifacts on failure": `playwright-report/` and `test-results/`, `retention-days: 7`.

### VALID-01 reconciliation
- `.planning/milestones/v1.0-phases/01-trustworthy-verify-signal/01-VALIDATION.md`, `.planning/milestones/v1.0-phases/02-shared-scanner-and-path-invariants/02-VALIDATION.md`, `.planning/milestones/v1.0-phases/03-typed-ipc-error-contract/03-VALIDATION.md`: the draft files to reconcile.
- The `*-SUMMARY.md` and `*-VERIFICATION.md` files in the same three directories: what shipped and the break-and-revert evidence.
- `~/.claude/gsd-core/workflows/validate-phase.md`: the validate-phase workflow.

### SEC-03 security report
- `.planning/milestones/v1.0-phases/02-shared-scanner-and-path-invariants/02-01-PLAN.md`, `02-02-PLAN.md`, `02-03-PLAN.md`: `<threat_model>` blocks (T-02-* register).
- `.planning/milestones/v1.0-phases/03-typed-ipc-error-contract/03-SECURITY.md`: the retroactive report format to follow.
- `.planning/milestones/v1.0-phases/01-trustworthy-verify-signal/01-SECURITY.md`: a second format reference.
- `~/.claude/gsd-core/workflows/secure-phase.md`: the secure-phase workflow.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ci.yml` `workflow_dispatch`: already present, so the GATE-08 probe needs no workflow change.
- The v1.0 break-and-revert method (01-02, 01-05 SUMMARY files): the precedent for the GATE-08 probe and for classifying gate checks as manual-only.
- `03-SECURITY.md`: a finished retroactive security report to copy the structure from.

### Established Patterns
- Non-gating evidence stays outside `make verify` (TEST-02 wording; the native e2e runner precedent in Phase 6).
- The CI e2e artifact upload runs only on failure and expires after 7 days. That is why D-07 records the evidence in the repo instead of relying on the artifact.
- `coverage/` is already in `.gitignore`.

### Integration Points
- New `make coverage` target in `Makefile`.
- New non-gating main-push coverage job (in `ci.yml` or a new workflow file).
- A Vitest coverage dev dependency in `package.json` and the lockfile. `cargo-llvm-cov` is a CI install step plus a local prerequisite, not a Cargo dependency.
- v1.0 archive files under `.planning/milestones/v1.0-phases/` and `.planning/milestones/v1.0-MILESTONE-AUDIT.md`.

</code_context>

<specifics>
## Specific Ideas

- The GATE-08 evidence must outlive CI artifact retention, which is the failure that left the v1.0 proof unverifiable.
- The v1.0 audit's original verdict stays readable as history. Resolution is appended to it, not rewritten over it.

</specifics>

<deferred>
## Deferred Ideas

None. The discussion stayed within phase scope.

</deferred>

---

*Phase: 11-milestone-verification-evidence*
*Context gathered: 2026-09-25*
