---
phase: 6
slug: native-e2e-runner-foundation
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-29
---

# Phase 6 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `06-RESEARCH.md` §Validation Architecture. Per-task rows are filled
> by the planner; `validate-phase` flips `status` and `nyquist_compliant`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | WebdriverIO (`@wdio/tauri-service`, embedded provider) in `e2e-native/` - new this phase |
| **Config file** | `e2e-native/wdio.conf.ts` - none - Wave 0 creates it (written from scratch, not derived from `playwright.config.ts`) |
| **Quick run command** | `pnpm typecheck && pnpm lint` (runner code compiles; no app launch) |
| **Full suite command** | `make test-e2e-native` (exact target name is Claude's discretion per CONTEXT.md) |
| **Estimated runtime** | ~180 seconds (per-spec-file app launch, D-12; refine after the spike) |

**Unmodified by this phase:** Playwright (`e2e/`), Vitest (`src/`, `scripts/`), `cargo test` (`src-tauri/`).

---

## Sampling Rate

- **After every task commit:** Run `pnpm typecheck && pnpm lint` (plus `cargo check --offline` when the task touched Rust)
- **After every plan wave:** Run the D-03 macOS compile-and-typecheck CI job, and `make test-e2e-native` locally once the runner can launch
- **Before `/gsd-verify-work`:** `make release-preflight` green (human-run, blocking per D-03) and the D-04 verdict document written
- **Max feedback latency:** 120 seconds for the typecheck/lint sampling loop

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | TEST-01 | T-06-01 | Debug global and WebDriver plugin absent from release artifacts | static guard | `node scripts/check-native-e2e-isolation.mjs` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | TEST-01 | T-06-02 | Fixture workspace writes stay inside the per-run tempdir | unit (Rust) | `cargo test --offline -p maru fixture_workspace` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | TEST-01 | T-06-03 | Home/config override fails closed when the env var is absent under the gating feature | unit (Rust) | `cargo test --offline -p maru maru_home_dir_override` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | TEST-01 | - | Real PTY output asserted by text mirror + canvas ink check | native e2e | `make test-e2e-native -- specs/pty.spec.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | TEST-01 | - | Synthetic composition on terminal textarea and rich editor | native e2e | `make test-e2e-native -- specs/ime.spec.ts` | ❌ W0 | ⬜ pending |

*Task IDs, plan numbers, and waves are assigned by the planner; rows above are the
requirement-level obligations those tasks must satisfy.*

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `e2e-native/wdio.conf.ts` - the runner config itself
- [ ] `e2e-native/specs/*.spec.ts` - the four D-13 surface specs (WKWebView DOM, PTY, IME, menu bar)
- [ ] `e2e-native/helpers/fixtureWorkspace.ts` - D-09's per-run seeding helper
- [ ] `e2e-native/helpers/ptyAssertions.ts` - D-05's text-mirror + ink-check pair
- [ ] `scripts/check-native-e2e-isolation.mjs` - D-10's static artifact guard
- [ ] Default-off cargo feature in `src-tauri/Cargo.toml` gating `tauri-plugin-wdio-webdriver`
- [ ] Feature-gated env-var override on `maru_home_dir()` and `test_config_dir_override()` - genuinely new Rust logic, NOT the existing `#[cfg(test)]` path (RESEARCH Pitfalls 1-2)
- [ ] `tsconfig.e2e-native.json` registered in root `tsconfig.json` references and `eslint.config.js` files list (D-15), following the `tsconfig.e2e.json` shape
- [ ] `docs/` native-runner document (D-04) recording scope, how to run, and the verdict
- [ ] Framework install behind `checkpoint:human-verify` (Package Legitimacy Audit returned SUS on a too-new-version signal): `pnpm add -D @wdio/tauri-service webdriverio @wdio/cli @wdio/mocha-framework @wdio/spec-reporter` and `cargo add tauri-plugin-wdio-webdriver --optional`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| An interactive or TCC permission prompt appears (or does not) during the hosted-macOS spike | TEST-01 crit. 1 | A prompt's appearance is the absence of automation - only a human watching the run, or a screenshot artifact, can settle it | Run the spike CI job; capture a screenshot artifact on the macOS runner and read the job's own hang/timeout signature. An observed prompt settles the verdict local-only on the spot (D-02) |
| Full local run completes with no human present (local branch of the verdict) | TEST-01 crit. 3 | If the spike fails, the runner is human-attended by definition | `make release-preflight` run by a developer; exit code recorded |
| Real OS-level IME composition (Korean 2-set) on terminal textarea and rich editor | TEST-01 crit. 4 | Synthetic composition events cannot reproduce OS IME (RESEARCH Pitfall 6); if the sub-spike confirms this, D-08 leaves a fixed human checklist behind | Fixed checklist in the D-04 document: type a Korean syllable in each surface, confirm no trailing-duplicate syllable and correct commit |
| macOS menu bar surface | TEST-01 / D-13 | Menu bar is outside the WKWebView; WebDriver cannot reach it | Checklist item in the D-04 document |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
