---
phase: 1
slug: trustworthy-verify-signal
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase §6)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-22
---

# Phase 1 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

**Note on this phase's shape.** Phase 1 builds gates rather than features, so most
of its verification is the gate proving it fails correctly: break something
deliberately, watch `make verify` go red, revert. D-13 specifies this method for
GATE-04 and it applies identically to GATE-01, GATE-02, and GATE-03. There are no
new test fixtures and no new framework.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4 (TS/React), `cargo test` built-in harness (Rust), Playwright 1.59 (e2e) — all three already wired into `Makefile` |
| **Config file** | `vite.config.ts` (Vitest, no dedicated `vitest.config.ts`); `playwright.config.ts`; none for `cargo test` |
| **Quick run command** | `pnpm typecheck && pnpm lint` |
| **Full suite command** | `make verify` |
| **Estimated runtime** | ~560 seconds (CI `make verify` measured at 9m19s on PR #275) |

---

## Sampling Rate

- **After every task commit:** Run that gate's own command (per-task map below) plus `pnpm typecheck`
- **After every plan wave:** Run `make verify`
- **Before `/gsd-verify-work`:** `make verify` and `make test-e2e` green locally, plus one real CI run for GATE-04's artifact proof
- **Max feedback latency:** ~60 seconds for the per-task commands; `make verify` is the wave-level gate, not the per-task one

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01 Task 1-2 / 01-02 Task 1-3 | 01-01, 01-02 | 1 | GATE-01 | - | N/A | manual break-and-revert | `cd src-tauri && cargo clippy --offline -- -D warnings` and `cargo fmt --check` | Yes | manual-only (see below) |
| 01-07 Task 3 | 01-07 | 1 | GATE-02 | - | N/A | manual break-and-revert | `pnpm lint` | Yes | manual-only (see below) |
| 01-04 Task 4 / 01-05 Task 3 | 01-04, 01-05 | 1 | GATE-03 | - | N/A | manual break-and-revert | `pnpm typecheck` (`tsc -b`) | Yes | manual-only (see below) |
| 01-03 Task 1, 3 | 01-03 | 1 | GATE-04 | - | N/A | **CI-only** - local trace defaults differ | Land a deliberately failing spec, push, inspect the uploaded artifact for `trace.zip`, revert | Yes | manual-only, CI-only (see below and 11-EVIDENCE.md) |
| 01-01 Task 1 | 01-01 | 1 | GATE-05 | - | N/A | manual | `git checkout <old-sha> -- rust-toolchain.toml && cd src-tauri && cargo --version` | Yes | manual-only (see below) |
| 01-04 Task 2 | 01-04 | 1 | GATE-06 | - | N/A | automated | read-only `@types/dompurify` absence check + `pnpm typecheck` | Yes | green |
| 01-03 Task 2 | 01-03 | 1 | GATE-07 | - | N/A | automated (grep) | `grep -c "skill-name-drift" src/lib/e2eFlow.ts` must be 0; `grep -q Hand-maintained src/lib/e2eFlow.ts` | Yes `src/lib/e2eFlow.ts` | green |

*Status: pending, green, red, manual-only, or flaky.*

---

## Wave 0 Requirements

- [x] `eslint.config.js` - flat config, four correctness rules, scoped to `src/` + `e2e/` (GATE-02), delivered by 01-06/01-07
- [x] `make lint` target + `pnpm lint` script - the entry point every GATE-02 check calls, delivered by 01-07 Task 3
- [x] `tsconfig.e2e.json` and `tsconfig.scripts.json` + `references` entries - GATE-03, delivered by 01-04 Task 3-4 and 01-05 Task 1-3
- [x] `rust-toolchain.toml` - GATE-05, delivered by 01-01 Task 1
- [x] `@types/node@22` devDependency - delivered by 01-04 Task 2

*Everything runs on existing infrastructure; no install step remains outstanding.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A failing e2e in CI leaves a downloadable trace | GATE-04 | Local runs use `reuseExistingServer` and different trace defaults; only a real CI run proves the artifact path | Evidence: 01-03-SUMMARY.md and CI run `32559390372` (01-VERIFICATION.md truth #3). The narrowing commit `a064994` (trace config narrowed to snapshots+screenshots off) postdates that proof and was never re-exercised in CI. v1.1 re-proof: `.planning/phases/11-milestone-verification-evidence/11-EVIDENCE.md` (GATE-08 section, plan 11-03) |
| An older commit rebuilds with its own toolchain | GATE-05 | Requires checking out a prior commit and observing the resolved toolchain; not expressible as a repo-resident test | `git checkout <old-sha> -- rust-toolchain.toml`, then `cd src-tauri && cargo --version`, confirm it matches that commit's pin. Evidence: 01-01-SUMMARY.md and 01-VERIFICATION.md truth #4. Automated half re-run today: `grep -E '^channel = "[0-9]+\.[0-9]+\.[0-9]+"' rust-toolchain.toml` -> `channel = "1.98.0"` |
| Each gate fails on a deliberate break | GATE-01, GATE-02, GATE-03 | Whether the gate goes red on a bad dep array, unused symbol, unformatted Rust file, clippy warning, or type error cannot be asserted from inside a green suite - it requires a deliberate break-and-revert | Evidence: 01-01/01-02-SUMMARY.md (GATE-01 fmt+clippy break-revert), 01-07-SUMMARY.md (GATE-02 lint break-revert both ways), 01-04/01-05-SUMMARY.md (GATE-03 e2e/ and scripts/ break-revert). Automated half re-run today, all clean: `make fmt-check clippy`, `pnpm lint` |

**Note on the composite gate:** `pnpm typecheck` (GATE-03's and GATE-06's automated half) currently fails on a pre-existing, unrelated `src/components/graph/GraphCanvas.tsx` TS7006 regression, outside this phase's diff and outside this plan's file list (see 02-VALIDATION.md's Manual-Only section and 11-04-SUMMARY.md for the full account). This does not reopen GATE-03 or GATE-06: GATE-03's own e2e/ and scripts/ typechecking is proven by 01-04/01-05's break-and-revert record, and GATE-06's `@types/dompurify` absence is independently confirmed by the read-only check below, which does not depend on `tsc -b` completing.

---

## Validation Sign-Off

- [x] All tasks have an automated verify command or a Wave 0 dependency
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all references above - each plan creates its config
      unreferenced and verifies it with a direct `tsc -p` / `eslint` run before
      wiring it into `verify`, which satisfies the Wave 0 intent without a
      separate Wave 0 plan
- [x] No watch-mode flags
- [x] Feedback latency < 60s for per-task commands - recorded as a policy-consistent
      exception, not a gap: four tasks (01-03 T1, 01-04 T3, 01-05 T3, 01-07 T3)
      invoke the full `make test-e2e` or `make verify` (~9m19s in CI) by design.
      The sampling policy is explicit that the fast command is per-task and the
      full gate is per-wave; these four tasks ARE the per-wave gate check, not a
      violation of the per-task budget.
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-09-25

## Validation Audit 2026-09-25

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 1 |

- `cd src-tauri && cargo fmt --check` - exit 0, clean
- `cd src-tauri && cargo clippy -- -D warnings` - exit 0, clean
- `pnpm lint` - exit 0, clean (`eslint src e2e e2e-native --max-warnings 0`)
- `grep -E '^channel = "[0-9]+\.[0-9]+\.[0-9]+"' rust-toolchain.toml` - `channel = "1.98.0"`
- `node -e "..."` read-only `@types/dompurify` absence check - exit 0, absent from dependencies and devDependencies
- `test "$(grep -c skill-name-drift src/lib/e2eFlow.ts)" = 0` - exit 0
- `grep -q 'Hand-maintained' src/lib/e2eFlow.ts` - exit 0, present
- `pnpm typecheck` - non-zero exit at `src/components/graph/GraphCanvas.tsx`, unrelated to Phase 1 (see Manual-Only note above); escalated, not resolved in this plan per D-10 scope
- HEAD at measurement: `e4bc96af`
