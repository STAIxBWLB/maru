---
phase: "11"
slug: "milestone-verification-evidence"
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase section 6)
# audit-milestone section 5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
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
| 11-TBD | TBD | TBD | TEST-02 | - | N/A | smoke | `make coverage` | ❌ W0 | ⬜ pending |
| 11-TBD | TBD | TBD | GATE-08 | - | N/A | manual, CI-only | `gh workflow run ci.yml --ref <probe-branch>` then `gh run download` + `unzip -l` | N/A | ⬜ pending |
| 11-TBD | TBD | TBD | VALID-01 | - | N/A | automated via validate-phase | per-requirement commands in 11-RESEARCH.md VALID-01 inventory | ✅ | ⬜ pending |
| 11-TBD | TBD | TBD | SEC-03 | T-02-* | Phase 02 mitigations present at HEAD | automated via secure-phase | per-threat evidence in 11-RESEARCH.md SEC-03 audit | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `Makefile` `coverage` target
- [ ] `@vitest/coverage-v8` devDependency (human-verify checkpoint before install)
- [ ] `.github/workflows/ci.yml` main-push coverage job

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Deliberate CI e2e failure produces a trace zip under the narrowed config | GATE-08 | One-time CI evidence capture, same kind as the v1.0 GATE-04 manual row | Push probe branch with one failing assertion in `e2e/startup.spec.ts`, dispatch `ci.yml`, download artifact, record `unzip -l`, delete branch |
| Coverage HTML renders for TS and Rust | TEST-02 | Reporting tool, not app behavior | Run `make coverage`, open both `index.html` files, confirm terminal totals printed |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 600s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
