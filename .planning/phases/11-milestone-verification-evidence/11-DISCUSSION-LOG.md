# Phase 11: Milestone Verification & Evidence - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md; this log preserves the alternatives considered.

**Date:** 2026-09-25
**Phase:** 11-milestone-verification-evidence
**Areas discussed:** Coverage report (TEST-02), GATE-08 proof, VALID-01 reconciliation scope, SEC-03 security report

Scout findings presented before the discussion: no coverage tooling is installed; the GATE-08 narrowed trace config was already probed on 2026-08-22 (run 32569215249) and has not changed since, but that run's artifact has expired; v1.0 VALIDATION files for phases 01-03 are pre-execution drafts; Phase 02 has 8 declared threats and no SECURITY.md.

---

## Coverage report (TEST-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Local make + CI main non-gating job | `make coverage` locally; a separate job on push to main uploads an artifact; PR speed unaffected | ✓ |
| Local make target only | Simplest; numbers exist only when someone runs it | |
| Local + CI every PR | Numbers on every PR; PR CI slows by an instrumented build | |

**User's choice:** Local make + CI main non-gating job

| Option | Description | Selected |
|--------|-------------|----------|
| HTML + terminal totals + CI Job Summary | Per-file HTML locally, totals in the terminal, totals table in the Job Summary, HTML as artifact | ✓ |
| HTML only | Lightest; totals require opening the file | |
| Add lcov | For external services or editors; YAGNI with no consumer | |

**User's choice:** HTML + terminal totals + CI Job Summary

| Option | Description | Selected |
|--------|-------------|----------|
| App lib + maru-cli | Whole workspace via cargo-llvm-cov, per-crate totals | ✓ |
| App lib only | Matches `make test-rust` (`cargo test --lib`) | |

**User's choice:** App lib + maru-cli

| Option | Description | Selected |
|--------|-------------|----------|
| Record first measurement, no threshold | Non-gating; first totals kept as a baseline | ✓ |
| Warn on drop | CI summary warning on a drop; baseline file upkeep | |
| Report only, no record | Lightest; no trend comparison | |

**User's choice:** Record first measurement, no threshold

---

## GATE-08 proof

| Option | Description | Selected |
|--------|-------------|----------|
| Re-run a fresh deliberate failure | Old artifact expired and the v1.0 audit did not accept it; one CI run, evidence written into docs | ✓ |
| Close on existing evidence + unchanged config | Cite run 32569215249 and git history showing no config change; indirect proof | |

**User's choice:** Re-run a fresh deliberate failure

| Option | Description | Selected |
|--------|-------------|----------|
| Temp branch + workflow_dispatch, delete after | One failing assertion on a branch, `gh workflow run ci.yml --ref`; no PR, nothing on main | ✓ |
| Permanent trace_probe dispatch input | Re-provable any time; CI code grows permanently | |
| Temporary PR | Same as v1.0; PR record but board noise | |

**User's choice:** Temp branch + workflow_dispatch, delete after

| Option | Description | Selected |
|--------|-------------|----------|
| Run URL + trace.zip entry/size listing in docs | `unzip -l` output, failing test, config commit in VERIFICATION; no binary committed | ✓ |
| Commit trace.zip | Permanent original; ~120 KB binary in git | |
| Run URL only | Lightest; expires after 7 days again | |

**User's choice:** Run URL + trace.zip entry/size listing in docs

---

## VALID-01 reconciliation scope

| Option | Description | Selected |
|--------|-------------|----------|
| Run validate-phase per phase | Map requirements to shipped tests, set validated; meets success criterion 3 directly | ✓ |
| Manual metadata fix | Faster; risks drifting from validate-phase output again | |

**User's choice:** Run validate-phase per phase

| Option | Description | Selected |
|--------|-------------|----------|
| Add small tests, break-and-revert manual-only | Unit-testable gaps get tests; gate-failure checks are manual-only with recorded evidence | ✓ |
| Record only | Docs only; `nyquist_compliant: false` may remain | |

**User's choice:** Add small tests, break-and-revert manual-only

| Option | Description | Selected |
|--------|-------------|----------|
| Update archive in place | The audit reads there; only VALIDATION files and 02-SECURITY change | ✓ |
| Freeze archive, separate v1.1 doc | History preserved; v1.0 audit still measures stale files | |

**User's choice:** Update archive in place

| Option | Description | Selected |
|--------|-------------|----------|
| Keep verdict, append "Resolved in v1.1 Phase 11" | Original tech_debt verdict kept as history, each debt item linked to its evidence | ✓ |
| Re-run v1.0 audit | Current but overwrites the original verdict | |
| Leave untouched | Resolution visible only in the v1.1 audit | |

**User's choice:** Keep verdict, append resolved section

---

## SEC-03 security report

| Option | Description | Selected |
|--------|-------------|----------|
| Current HEAD, 03-SECURITY format | secure-phase checks the 8 mitigations in today's code; same retroactive format as 03 | ✓ |
| v1.0 ship commit | Historically exact; says nothing about current risk | |

**User's choice:** Current HEAD, 03-SECURITY format

| Option | Description | Selected |
|--------|-------------|----------|
| Small fix here, large issue + open | Keeps the audit phase from growing into feature work; issue registered after approval | ✓ |
| Fix all here | Guarantees `threats_open: 0`; unbounded scope | |
| Record only | Report exists, threats stay open | |

**User's choice:** Small fix here, large issue + open

---

## Claude's Discretion

- Coverage config details (reporters, globs, output dir, job placement).
- Which e2e spec carries the probe assertion.
- Where the coverage baseline is recorded.
- Plan order and waves.

## Deferred Ideas

None.
