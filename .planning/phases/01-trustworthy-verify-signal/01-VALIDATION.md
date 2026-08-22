---
phase: 1
slug: trustworthy-verify-signal
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-22
---

# Phase 1 — Validation Strategy

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
| TBD | 01 | 1 | GATE-01 | — | N/A | manual break-and-revert | `cd src-tauri && cargo clippy --offline -- -D warnings` and `cargo fmt --check` | ✅ | ⬜ pending |
| TBD | 01 | 1 | GATE-02 | — | N/A | manual break-and-revert | `pnpm lint` | ❌ W0 (target does not exist yet) | ⬜ pending |
| TBD | 01 | 1 | GATE-03 | — | N/A | manual break-and-revert | `pnpm typecheck` (`tsc -b`) | ✅ | ⬜ pending |
| TBD | 01 | 1 | GATE-04 | — | N/A | **CI-only** — local trace defaults differ | Land a deliberately failing spec, push, inspect the uploaded artifact for `trace.zip`, revert | ✅ | ⬜ pending |
| TBD | 01 | 1 | GATE-05 | — | N/A | manual | `git checkout <old-sha> -- rust-toolchain.toml && cd src-tauri && cargo --version` | ❌ W0 (file does not exist yet) | ⬜ pending |
| TBD | 01 | 1 | GATE-06 | — | N/A | automated | `pnpm remove @types/dompurify && pnpm typecheck` | ✅ | ⬜ pending |
| TBD | 01 | 1 | GATE-07 | — | N/A | automated (grep) | `grep -c "skill-name-drift" src/lib/e2eFlow.ts` must be 0 | ✅ `src/lib/e2eFlow.ts` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*Task IDs are filled in by the planner; the requirement rows are fixed.*

---

## Wave 0 Requirements

- [ ] `eslint.config.js` — flat config, four correctness rules, scoped to `src/` + `e2e/` (GATE-02 has no runnable command until this exists)
- [ ] `make lint` target + `pnpm lint` script — the entry point every GATE-02 check calls
- [ ] `tsconfig.e2e.json` and `tsconfig.scripts.json` + `references` entries — GATE-03 cannot fail-correctly until `tsc -b` covers those trees
- [ ] `rust-toolchain.toml` — GATE-05 has nothing to verify until the pin exists
- [ ] `@types/node@22` devDependency — `tsc -b` cannot resolve `types: ["node"]` without it, so GATE-03's command errors before reaching real code

*Everything else runs on existing infrastructure.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A failing e2e in CI leaves a downloadable trace | GATE-04 | Local runs use `reuseExistingServer` and different trace defaults; only a real CI run proves the artifact path | Land a deliberately failing spec on a branch, push, open the run's artifacts, confirm `trace.zip` is present, revert the spec (D-13) |
| An older commit rebuilds with its own toolchain | GATE-05 | Requires checking out a prior commit and observing the resolved toolchain; not expressible as a repo-resident test | `git checkout <old-sha> -- rust-toolchain.toml`, then `cd src-tauri && cargo --version`, confirm it matches that commit's pin |
| Each gate fails on a deliberate break | GATE-01, GATE-02, GATE-03 | Success criterion 1 and 2 are about the gate going red, which cannot be asserted from inside a green suite | Break one thing per gate (bad dep array, unused symbol, unformatted Rust file, clippy warning, type error in a spec), confirm `make verify` fails, revert |

---

## Validation Sign-Off

- [ ] All tasks have an automated verify command or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ references above
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s for per-task commands
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
