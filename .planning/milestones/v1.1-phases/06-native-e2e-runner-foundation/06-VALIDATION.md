---
phase: 6
slug: native-e2e-runner-foundation
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
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
| 06-01 T1 | 06-01 | 1 | TEST-01 | T-06-SC | Six `SUS` npm packages and one `[ASSUMED]` crate cleared by a human before install | blocking checkpoint | manual (blocking-human; cleared 2026-08-29, 06-01-SUMMARY) | n/a | ✅ green (manual) |
| 06-01 T2 | 06-01 | 1 | TEST-01 | T-06-03 | Home/config override fails closed when the env var is absent under the gating feature (the feature-gated `native_e2e_dir_override` delegates to the ungated `resolve_native_e2e_dir`, whose `resolve_native_e2e_dir_*` tests pin the refusal); inert (`Ok(None)`) in a default-feature build even with the var set | unit (Rust) | `cd src-tauri && cargo test --offline --lib paths::` (`resolve_native_e2e_dir_*`, `native_e2e_dir_override_is_inert_without_the_feature`) | ✅ | ✅ green |
| 06-01 T2 | 06-01 | 1 | TEST-01 | T-06-02 | Fixture workspace writes stay inside the per-run mkdtemp root; both override values pass `require_absolute` | unit (Rust) + native e2e | `cd src-tauri && cargo test --offline --lib paths::` then `make test-e2e-native` | ✅ | ✅ green |
| 06-01 T2 | 06-01 | 1 | TEST-01 | - | D-13 surface 1: one WKWebView DOM assertion against the real app | native e2e | `make test-e2e-native` (`e2e-native/specs/webview.spec.ts`; main CI `native-e2e.yml`) | ✅ | ✅ green |
| 06-01 T3 | 06-01 | 1 | TEST-01 | T-06-05 | Hosted-macOS session attempt classified by D-02, cap and failure class recorded | CI job + doc assertion | spike retired by D-16; its successor placement is asserted by `pnpm exec vitest run scripts/native-e2e-ci-placement.test.ts` | ✅ | ✅ green |
| 06-02 T1 | 06-02 | 2 | TEST-01 | T-06-01 | Terminal-text bridge present in a runner build, absent from a production build | unit (Vitest) + post-build assertion | `pnpm exec vitest run src/lib/nativeE2eBridge.test.ts` then `pnpm build:frontend` (chains `check-native-e2e-isolation.mjs`) | ✅ | ✅ green |
| 06-02 T2 | 06-02 | 2 | TEST-01 | T-06-07 | Real PTY output asserted by text mirror + canvas ink check, on a shell-produced string | native e2e | `make test-e2e-native` (`e2e-native/specs/pty.spec.ts`) | ✅ | ⚠️ flaky (hosted runner, #388) |
| 06-03 T1 | 06-03 | 3 | TEST-01 | T-06-08 | Synthetic composition judged on terminal textarea and rich editor; unreachable cases pending-with-reason | native e2e + doc assertion | `make test-e2e-native` (`e2e-native/specs/ime.spec.ts`) | ✅ | ✅ green |
| 06-03 T2 | 06-03 | 3 | TEST-01 | T-06-01 | Menu command ids driven through the app's own handler; every id declared in `app_menu.rs` | native e2e + source cross-check | `make test-e2e-native` (`e2e-native/specs/menu.spec.ts`) + `pnpm exec vitest run scripts/native-e2e-menu-ids.test.ts` | ✅ | ✅ green (cross-check); ⚠️ `terminal.split` flaky on hosted runner (#388) |
| 06-04 T1 | 06-04 | 3 | TEST-01 | - | `e2e-native/` inside the typecheck and lint gates | typecheck + lint + config contract | `pnpm typecheck && pnpm lint` + `pnpm exec vitest run scripts/native-e2e-typecheck-lint-registration.test.ts` | ✅ | ✅ green |
| 06-04 T2 | 06-04 | 3 | TEST-01 | T-06-01 | Debug bridge and WebDriver plugin absent from release artifacts, proven fail-first | static guard + red/green fixture test | `pnpm build:frontend` (green on the real bundle) + `pnpm exec vitest run scripts/check-native-e2e-isolation.test.ts` (red on bridge namespace and native-only command names, named failure on missing `dist/assets`) | ✅ | ✅ green |
| 06-05 T1 | 06-05 | 4 | TEST-01 | T-06-11 | CI placement matches the verdict; the PR job is eligible on every pull request, runs `pnpm typecheck` and `cargo check --locked --features native-e2e`, never runs the suite, and masks no failure; the suite runs with pipefail; `release-preflight` blocks on it; `verify` does not run it | workflow + Makefile contract | `pnpm exec vitest run scripts/native-e2e-ci-placement.test.ts`, plus `make release-preflight` | ✅ | ✅ green |
| 06-05 T2 | 06-05 | 4 | TEST-01 | T-06-04 | Verdict recorded in both `docs/native-e2e.md` and `.planning/PROJECT.md`, no overstatement | doc contract | `pnpm exec vitest run scripts/native-e2e-ci-placement.test.ts` (verdict describe) | ✅ | ✅ green |
| 06-05 T3 | 06-05 | 4 | TEST-01 | T-06-04, T-06-08 | D-01's three conditions answered individually with named evidence; per-item human checklist observations | blocking checkpoint | manual (ratified ci-viable, 06-05-SUMMARY; runs 33243419439, 33250704926) | n/a | ✅ green (manual) |

*Task IDs, plan numbers, and waves assigned by the planner on 2026-08-29. Rows are the
requirement-level obligations those tasks must satisfy. Threat IDs refer to each plan's own
`<threat_model>` register.*

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `e2e-native/wdio.conf.ts` - the runner config itself
- [x] `e2e-native/specs/*.spec.ts` - the four D-13 surface specs (WKWebView DOM, PTY, IME, menu bar)
- [x] `e2e-native/helpers/fixtureWorkspace.ts` - D-09's per-run seeding helper
- [x] `e2e-native/helpers/ptyAssertions.ts` - D-05's text-mirror + ink-check pair
- [x] `scripts/check-native-e2e-isolation.mjs` - D-10's static artifact guard
- [x] Default-off cargo feature in `src-tauri/Cargo.toml` gating `tauri-plugin-wdio-webdriver`
- [x] Feature-gated env-var override on `maru_home_dir()` and `test_config_dir_override()` - genuinely new Rust logic, NOT the existing `#[cfg(test)]` path (RESEARCH Pitfalls 1-2)
- [x] `tsconfig.e2e-native.json` registered in root `tsconfig.json` references and `eslint.config.js` files list (D-15), following the `tsconfig.e2e.json` shape
- [x] `docs/` native-runner document (D-04) recording scope, how to run, and the verdict
- [x] Framework install behind `checkpoint:human-verify` (Package Legitimacy Audit returned SUS on a too-new-version signal): `pnpm add -D @wdio/tauri-service webdriverio @wdio/cli @wdio/mocha-framework @wdio/spec-reporter` and `cargo add tauri-plugin-wdio-webdriver --optional`

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

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (06-01 T1 and 06-05 T3 are blocking human checkpoints by design and are recorded above)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s for the typecheck/lint and vitest loop; the native suite is a main-CI and release-preflight run
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-09-27

## Validation Audit 2026-09-27

| Metric | Count |
|--------|-------|
| Gaps found | 6 |
| Resolved | 6 |
| Escalated | 0 |

Gaps and their tests:

- 06-01 T2 (T-06-03): the default-feature override had no inertness test. Added `native_e2e_dir_override_is_inert_without_the_feature` to `src-tauri/src/paths.rs` (`cargo test --offline --lib paths::`, 15 passed).
- 06-03 T2 (T-06-01): the menu-id cross-check was a one-off plan command. Added `scripts/native-e2e-menu-ids.test.ts`.
- 06-04 T1: typecheck and lint registration was proven only by a manual deliberate-break drill. Added `scripts/native-e2e-typecheck-lint-registration.test.ts`.
- 06-04 T2 (T-06-01): the isolation guard's red case was manual. Added `scripts/check-native-e2e-isolation.test.ts` (red on the bridge namespace and on a native-only command name, named failure on a missing `dist/assets`, green with warn-and-skip of the manifest half when `cargo metadata` cannot run).
- 06-05 T1 (T-06-11) and T2 (T-06-04): CI placement and verdict agreement were one-off node assertions. Added `scripts/native-e2e-ci-placement.test.ts`. It was mutation-checked in a scratch copy of the inputs, and each of these 18 breaks fails it:
  - `ci.yml`: dropping the cargo check or the typecheck step, `if: false`, an `if:` that excludes pull requests, removing the `pull_request` trigger, a decision job that defaults `run_full=false`, `|| true` or `continue-on-error: true` on the cargo check, the suite added to the compile job, and a non-macOS runner.
  - `native-e2e.yml`: dropping `shell: bash`, `|| true` on the suite, and dropping the `v*` tag trigger.
  - `Makefile`: `-$(MAKE)`, `|| true`, or no `test-e2e-native` line in `release-preflight`, and `test-e2e-native` added to `verify`.
  - `PROJECT.md`: the verdict changed away from `ci-viable`.

The native specs are unchanged. They ran 8/8 on main run 36286207160 (HEAD 731f9260); the hosted-runner flakes in `pty.spec` and `menu.spec` `terminal.split` stay tracked on #388 and are marked flaky above. The native suite was not run locally for this audit.
