---
phase: "11"
slug: "milestone-verification-evidence"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-09-26"
---

# Phase 11 - Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Register authored at plan time in the `<threat_model>` blocks of 11-01..11-06-PLAN.md;
> verified at ASVS L1 (grep and git depth) against `main` at `7bbfaf10` plus the
> `docs/phase-11-closure` branch.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| npm registry -> `node_modules` and the lockfile | New devDependency `@vitest/coverage-v8` enters the test toolchain | Third-party package code |
| crates.io -> developer machine (`~/.cargo/bin`) | `cargo-llvm-cov` compiled and installed locally | Third-party crate code |
| GitHub Actions runner -> repository | `coverage.yml` runs third-party actions with the workflow token | Read-only repo token, public source |
| Throwaway probe branch -> `origin` | GATE-08 probe pushed and dispatched, then deleted | One-line test change |
| Phase branch -> v1.0 archive and REQUIREMENTS.md | Evidence records edited in place | Planning documents |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-11-SC | Tampering | `@vitest/coverage-v8`, `cargo-llvm-cov` installs | high | mitigate | Owner-approved legitimacy checkpoint recorded in 11-01-SUMMARY.md; exact pin `"@vitest/coverage-v8": "4.1.5"` (`package.json:79`); CI installs with `--frozen-lockfile`; CI pins `cargo-llvm-cov@0.9.1` | closed |
| T-11-01 | Denial of Service | `make verify` prerequisites | medium | mitigate | `coverage` absent from the `verify:` prerequisite line (`Makefile:394`); no threshold or fail-under anywhere (the one "thresholds" hit is the `coverage-summary.mjs:11` comment stating there are none) | closed |
| T-11-02 | Information Disclosure | `coverage/` HTML output | low | accept | Gitignored (`.gitignore:47`); public repo | closed |
| T-11-03 | Repudiation | Coverage report claiming completeness | medium | mitigate | Preflight `llvm-cov --version` fails the target when the tool is missing (`Makefile:272`); `validateReports` rejects a malformed report | closed |
| T-11-04 | Tampering | Tag-pinned third-party actions in `coverage.yml` | medium | accept | Same convention as `ci.yml`; `contents: read`, no secrets, push-to-main only | closed |
| T-11-05 | Elevation of Privilege | Workflow token scope | medium | mitigate | `permissions: contents: read` (`coverage.yml:29-30`); 0 `pull_request`/`pull_request_target`/`workflow_dispatch` triggers; 0 `secrets.` references | closed |
| T-11-06 | Denial of Service | Coverage job gating merges | medium | mitigate | No `needs:` on the job anywhere; `ci.yml` unchanged by the phase; `main` protection has `required_status_checks: null` | closed |
| T-11-07 | Information Disclosure | `coverage-report` artifact | low | accept | Public source, synthetic fixtures; `retention-days: 30` (`coverage.yml:109`) | closed |
| T-11-08 | Tampering | Probe commit reaching `main` or the phase PR | high | mitigate | Probe `90f64713` is not an ancestor of `origin/main` (`merge-base --is-ancestor` exit 1); remote probe branch absent; `e2e/startup.spec.ts`, `playwright.config.ts`, `ci.yml` unchanged by the phase | closed |
| T-11-09 | Repudiation | Trace evidence from a modified config | medium | mitigate | `playwright.config.ts` identical between `2d2e8660` and `origin/main`; run 36146017939 `headSha` = `90f64713c13af7fae5e2a2786980ac1ee23be424` | closed |
| T-11-10 | Information Disclosure | `playwright-report` artifact | low | accept | Synthetic fixtures, 7-day retention; 0 `trace.zip` files tracked | closed |
| T-11-11 | Repudiation | VALIDATION.md rubber-stamped | medium | mitigate | Fresh re-run results recorded in 11-04-SUMMARY.md; phase verifier re-ran two cited commands live (65 and 4 passed) | closed |
| T-11-12 | Tampering | v1.0 archive rewritten | medium | mitigate | Phase diff under `.planning/milestones/` is exactly the three VALIDATION.md files, the new `02-SECURITY.md`, and the append-only audit section | closed |
| T-11-13 | Tampering | Mutating `pnpm remove` validation command | low | mitigate | 0 `pnpm remove` occurrences in `01-VALIDATION.md` | closed |
| T-11-14 | Repudiation | 02-SECURITY.md statuses | medium | mitigate | Exactly 8 `T-02-0*` rows, each with HEAD file:line; `## Verification Evidence` present; count corrected to "100 passed, 1 ignored" in the PR #351 review | closed |
| T-11-15 | Spoofing / Elevation of Privilege | Unapproved GitHub issue creation | medium | mitigate | D-13 Case C never triggered; the only issue created during the phase is #350, registered with the owner's explicit approval | closed |
| T-11-16 | Tampering | v1.0 archive history (Phase 02 dir) | low | mitigate | Only `02-SECURITY.md` and `02-VALIDATION.md` changed in the Phase 02 archive directory | closed |
| T-11-17 | Repudiation | REQUIREMENTS.md completion flips | medium | mitigate | Diff limited to 8 added / 8 removed lines for the four IDs; per-ID gates recorded in 11-06-SUMMARY.md | closed |
| T-11-18 | Tampering | v1.0 audit history rewritten | medium | mitigate | Audit diff 25 added / 0 removed; frontmatter `status: tech_debt` intact | closed |
| T-11-19 | Repudiation | SUMMARY-to-evidence transcription drift | low | mitigate | 11-EVIDENCE.md tables re-checked in the PR #351 review (re-measured baseline and measurement record aligned) and against the CI artifact after merge | closed |

*Status: open - closed - open, below high threshold (non-blocking)*
*Severity: critical > high > medium > low - only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) - accept (documented risk) - transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-11-01 | T-11-02 | Local, gitignored HTML of already-public source | Phase 11 plan (merged in PR #349) | 2026-09-25 |
| AR-11-02 | T-11-04 | Tag pinning matches `ci.yml`; read-only token, no secrets, trusted trigger only | Phase 11 plan (merged in PR #349) | 2026-09-25 |
| AR-11-03 | T-11-07 | Artifact holds already-public source and synthetic data | Phase 11 plan (merged in PR #349) | 2026-09-25 |
| AR-11-04 | T-11-10 | Trace artifact holds synthetic fixtures and expires in 7 days | Phase 11 plan (merged in PR #349) | 2026-09-25 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-26 | 20 | 20 | 0 | Claude Code orchestrator, secure-phase L1 short-circuit (register authored at plan time, ASVS 1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-26
