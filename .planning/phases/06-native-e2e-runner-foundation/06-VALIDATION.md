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
| 06-01 T1 | 06-01 | 1 | TEST-01 | T-06-SC | Six `SUS` npm packages and one `[ASSUMED]` crate cleared by a human before install | blocking checkpoint | manual (blocking-human; `cargo add ... --dry-run` resolves the crate first) | n/a | ⬜ pending |
| 06-01 T2 | 06-01 | 1 | TEST-01 | T-06-03 | Home/config override fails closed when the env var is absent under the gating feature | unit (Rust) | `cd src-tauri && cargo test --offline --features native-e2e paths::` | ❌ W0 | ⬜ pending |
| 06-01 T2 | 06-01 | 1 | TEST-01 | T-06-02 | Fixture workspace writes stay inside the per-run mkdtemp root; both override values pass `require_absolute` | unit (Rust) + native e2e | `cd src-tauri && cargo test --offline --features native-e2e paths::` then `make test-e2e-native` | ❌ W0 | ⬜ pending |
| 06-01 T2 | 06-01 | 1 | TEST-01 | - | D-13 surface 1: one WKWebView DOM assertion against the real app | native e2e | `make test-e2e-native` | ❌ W0 | ⬜ pending |
| 06-01 T3 | 06-01 | 1 | TEST-01 | T-06-05 | Hosted-macOS session attempt classified by D-02, cap and failure class recorded | CI job + doc assertion | `gh workflow run native-e2e-spike.yml` then the `docs/native-e2e.md` node assertion in the plan | ❌ W0 | ⬜ pending |
| 06-02 T1 | 06-02 | 2 | TEST-01 | T-06-01 | Terminal-text bridge present in a runner build, absent from a production build | unit (Vitest) + post-build assertion | `pnpm test -- nativeE2eBridge` then `pnpm build:frontend` + the dist assertion in the plan | ❌ W0 | ⬜ pending |
| 06-02 T2 | 06-02 | 2 | TEST-01 | T-06-07 | Real PTY output asserted by text mirror + canvas ink check, on a shell-produced string | native e2e | `make test-e2e-native` (`e2e-native/specs/pty.spec.ts`) | ❌ W0 | ⬜ pending |
| 06-03 T1 | 06-03 | 3 | TEST-01 | T-06-08 | Synthetic composition judged on terminal textarea and rich editor; unreachable cases pending-with-reason | native e2e + doc assertion | `make test-e2e-native` (`e2e-native/specs/ime.spec.ts`) | ❌ W0 | ⬜ pending |
| 06-03 T2 | 06-03 | 3 | TEST-01 | T-06-01 | Menu command ids driven through the app's own handler; every id declared in `app_menu.rs` | native e2e + source cross-check | `make test-e2e-native` (`e2e-native/specs/menu.spec.ts`) + the id cross-check in the plan | ❌ W0 | ⬜ pending |
| 06-04 T1 | 06-04 | 3 | TEST-01 | - | `e2e-native/` inside the typecheck and lint gates, proven by a deliberate break in each | typecheck + lint | `pnpm typecheck && pnpm lint` | ❌ W0 | ⬜ pending |
| 06-04 T2 | 06-04 | 3 | TEST-01 | T-06-01 | Debug bridge and WebDriver plugin absent from release artifacts, proven fail-first | static guard | `pnpm build:frontend && pnpm check:native-e2e-isolation` (red case: `pnpm build:frontend:native-e2e && ! pnpm check:native-e2e-isolation`) | ❌ W0 | ⬜ pending |
| 06-05 T1 | 06-05 | 4 | TEST-01 | T-06-11 | CI placement matches the verdict; PR job compiles only; `release-preflight` blocks | workflow + Makefile assertion | the three node assertions in the plan, plus `make release-preflight` | ❌ W0 | ⬜ pending |
| 06-05 T2 | 06-05 | 4 | TEST-01 | T-06-04 | Verdict recorded in both `docs/native-e2e.md` and `.planning/PROJECT.md`, no overstatement | doc assertion | the three node assertions in the plan | ❌ W0 | ⬜ pending |
| 06-05 T3 | 06-05 | 4 | TEST-01 | T-06-04, T-06-08 | D-01's three conditions answered individually with named evidence; per-item human checklist observations | blocking checkpoint | manual (blocking; `make release-preflight` exit code recorded) | n/a | ⬜ pending |

*Task IDs, plan numbers, and waves assigned by the planner on 2026-08-29. Rows are the
requirement-level obligations those tasks must satisfy. Threat IDs refer to each plan's own
`<threat_model>` register.*

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
