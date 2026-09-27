---
phase: "11"
slug: "milestone-verification-evidence"
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase section 6)
# audit-milestone section 5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-09-25"
---

# Phase 11 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5 (TS), `cargo test` (Rust), Playwright 1.59 (e2e); all pre-existing |
| **Config file** | `vite.config.ts` (coverage flags on the CLI), `playwright.config.ts`; none for `cargo test` |
| **Quick run command** | `pnpm typecheck` / `cd src-tauri && cargo test --lib paths::` |
| **Full suite command** | `make verify` (coverage stays outside it, D-01) |
| **Estimated runtime** | ~600 seconds for `make verify` |

---

## Sampling Rate

- **After every task commit:** Run the task's own `<automated>` command (for TEST-02, `make coverage`; for VALID-01/SEC-03, the per-requirement command from 11-RESEARCH.md inventories)
- **After every plan wave:** Run `make verify`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 600 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-01 T1 | 11-01 | 1 | TEST-02 | - | `@vitest/coverage-v8` and cargo-llvm-cov cleared by a human before install | blocking checkpoint | manual (cleared, 11-01-SUMMARY); exact pin asserted by `pnpm exec vitest run scripts/coverage-placement.test.ts` | ✅ | ✅ green |
| 11-01 T2 | 11-01 | 1 | TEST-02 | - | N/A | unit + smoke | `pnpm exec vitest run scripts/coverage-summary.test.ts`; `make coverage` (needs cargo-llvm-cov) | ✅ | ✅ green |
| 11-01 T3 | 11-01 | 1 | TEST-02 | - | N/A | unit + contract | `pnpm exec vitest run scripts/coverage-summary.test.ts scripts/coverage-placement.test.ts` (per-crate totals; not in `verify`, no threshold) | ✅ | ✅ green |
| 11-02 T1 | 11-02 | 2 | TEST-02 | - | Workflow references no secrets and never runs on pull requests | contract + CI | `pnpm exec vitest run scripts/coverage-placement.test.ts`; main `coverage.yml` run 36287545904 (7c10b229) success | ✅ | ✅ green |
| 11-02 T2 | 11-02 | 2 | TEST-02 | - | N/A | doc assertion | `grep -q 'make coverage' README.md && grep -q coverage-report README.md` | ✅ | ✅ green |
| 11-03 T1 | 11-03 | 1 | GATE-08 | - | N/A | manual, CI-only | one-time probe run 36146017939, listing in 11-EVIDENCE.md; config pinned by `pnpm exec vitest run scripts/playwright-trace-config.test.ts` | ✅ | ✅ green |
| 11-03 T2 | 11-03 | 1 | GATE-08 | - | No trace binary committed | doc assertion | `grep -q '## GATE-08' .planning/phases/11-milestone-verification-evidence/11-EVIDENCE.md`; no tracked `trace.zip` | ✅ | ✅ green |
| 11-04 T1-T3 | 11-04 | 1 | VALID-01 | - | N/A | automated via validate-phase | per-requirement commands in 01/02/03-VALIDATION.md (e.g. `cargo test --offline --lib paths::`, `pnpm exec vitest run src/lib/ipcError.test.ts src/lib/types.test.ts`); frontmatter `status: validated`, `nyquist_compliant: true` in all three | ✅ | ✅ green |
| 11-05 T1-T2 | 11-05 | 1 | SEC-03 | T-02-01..08 | Phase 02 mitigations present at HEAD | automated via secure-phase | `cargo test --offline --lib` selectors `paths::`, `content_search::`, `evidence_binder::`, `vault::`, `inbox::`, `secrets::`, `skill_host::fs`; `02-SECURITY.md` has `threats_open: 0` and 8 `T-02-0N` rows | ✅ | ✅ green |
| 11-06 T1-T3 | 11-06 | 2 | TEST-02, GATE-08, VALID-01, SEC-03 | - | N/A | doc assertion + gate | the four requirement rows read `Phase 11 \| Complete` in `.planning/REQUIREMENTS.md`; `make verify` on CI | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `Makefile` `coverage` target
- [x] `@vitest/coverage-v8` devDependency (human-verify checkpoint before install)
- [x] `.github/workflows/ci.yml` main-push coverage job

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Deliberate CI e2e failure produces a trace zip under the narrowed config | GATE-08 | One-time CI evidence capture, same kind as the v1.0 GATE-04 manual row | Push probe branch with one failing assertion in `e2e/startup.spec.ts`, dispatch `ci.yml`, download artifact, record `unzip -l`, delete branch |
| Coverage HTML renders for TS and Rust | TEST-02 | Reporting tool, not app behavior | Run `make coverage`, open both `index.html` files, confirm terminal totals printed |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (11-01 T1 is a blocking human checkpoint and 11-03 T1 a one-time CI probe; both are recorded above)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 600s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-09-27

## Validation Audit 2026-09-27

| Metric | Count |
|--------|-------|
| Gaps found | 2 |
| Resolved | 2 |
| Escalated | 0 |

Gaps and their tests:

- TEST-02 (D-01/D-02/D-04), partial: the non-gating placement was proven only by one-off greps at execution time. Added `scripts/coverage-placement.test.ts`: `coverage` is not a `verify` prerequisite, its recipe and `vite.config.ts` carry no threshold, `coverage.yml` runs only on pushes to `main` with no secrets, and `@vitest/coverage-v8` is pinned to the `vitest` version.
- GATE-08, missing: nothing guarded the narrowed trace config the 11-03 probe measured. Added `scripts/playwright-trace-config.test.ts`, which pins `trace: { mode: "retain-on-failure", snapshots: false, screenshots: false }`.

VALID-01 and SEC-03 were already covered: the three v1.0 VALIDATION files are `validated` and compliant, `02-SECURITY.md` has `threats_open: 0` with all eight T-02 rows, and their cargo and vitest selectors ran green on this branch. The two Manual-Only rows stay manual.
