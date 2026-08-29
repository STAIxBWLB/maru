---
phase: 06-native-e2e-runner-foundation
verified: 2026-08-29T14:11:58Z
status: passed
score: 34/34 must-haves verified
behavior_unverified: 0
overrides_applied: 0
behavior_unverified_items:
  - truth: "A run leaves no live PTY child process or app process behind after the suite exits, on both the pass and the fail path (06-01 backstop)"
    test: "Deliberately fail one native spec (e.g. temporarily break an assertion), let the run end, then run `pgrep -f '^\\./src-tauri/target/debug/maru$'` and check for live PTY children of any survivor"
    expected: "No matching app process and no orphaned PTY children; the fixture root under $TMPDIR is also gone"
    why_human: "killSurvivingAppProcesses is wired into both afterSession and onComplete (pass and fail paths), and this verifier observed zero leftover processes after this session's repeated green runs — but no test exercises the FAIL path's cleanup, and pass-path observation alone cannot prove the fail path"
human_verification:
  - test: "Fail-path cleanup: deliberately fail one native spec, let `make test-e2e-native` exit non-zero, then `pgrep -f '^\\./src-tauri/target/debug/maru$'` and `ls $TMPDIR | grep maru-native-e2e`"
    expected: "pgrep finds nothing; no fresh fixture root remains (the four roots dated 18:04-19:13 predate the final code and are dev-iteration artifacts, not evidence against cleanup)"
    why_human: "Cleanup invariant on the fail path; no automated test exercises it and a passing run cannot demonstrate it"
  - test: "Human review of judgment-tier prohibition verdicts (see Prohibition Review section): ship isolation, real-home isolation, echo-proof PTY assertion, honest coverage recording, honest verdict recording"
    expected: "Reviewer agrees each prohibition is upheld given the cited evidence"
    why_human: "Plan prohibitions carry no verification tier; per ADR-550 D4 they require explicit human resolution — recorded here as non-authoritative judgments with evidence, flagged for review"
---

# Phase 6: Native E2E Runner Foundation Verification Report

**Phase Goal:** A native test runner drives the real application (WKWebView DOM, a real PTY, and IME input) against the real Rust backend, and the milestone knows whether any part of it can run unattended in CI rather than assuming it can.
**Verified:** 2026-08-29T14:11:58Z
**Status:** passed (human items resolved 2026-08-29 — see Human Verification Resolution)
**Re-verification:** No — initial verification

## Human Verification Resolution

Both `human_verification` items were resolved after this report was first written:

1. **Fail-path cleanup — verified by probe.** A deliberately failing spec
   (`zz-deliberate-fail.spec.ts`, added then removed) drove `make
   test-e2e-native` to a non-zero exit; afterwards `pgrep -f
   '^\./src-tauri/target/debug/maru$'` found nothing, port 4445 was free, and
   no fresh `maru-native-e2e-*` fixture root remained under `$TMPDIR`. The
   four roots dated 18:04-19:13 predate the final code (dev-iteration
   artifacts) and were removed.
2. **Prohibition review — approved by the user** ("approved", 2026-08-29)
   after each of the five judgment-tier verdicts was presented with its cited
   evidence (fail-closed refusal unit tests, the live guard red case, the
   echo-proof marker design, and the verdict/CI-placement consistency checks).

## Goal Achievement

### Observable Truths

Must-haves merged from all five plans' frontmatter (34 truths total; roadmap success criteria are covered by them — see Requirements Coverage).

| # | Truth (plan) | Status | Evidence |
|---|---|---|---|
| 1 | One make target builds the real app with the feature on, launches it under WebDriver, asserts the real WKWebView DOM (06-01) | ✓ VERIFIED | `Makefile:222-233` `test-e2e-native` (VITE_NATIVE_E2E=1 build → touch build.rs → cargo build --features native-e2e → wdio); `e2e-native/specs/webview.spec.ts` substantive (activity rail + seeded document via real DOM); suite 4/4 green repeatedly this session, hosted run 33250704926 green |
| 2 | Home-dir resolution refuses when feature on + MARU_NATIVE_E2E_HOME absent (06-01) | ✓ VERIFIED | `paths.rs:97-120` fail-closed resolver; `maru_dir.rs:162` consumes it; `cargo test --offline --features native-e2e paths::` run by this verifier: 10 passed incl. `resolve_native_e2e_dir_errors_on_absent_value_naming_the_variable` |
| 3 | Config-dir resolution refuses when feature on + MARU_NATIVE_E2E_CONFIG_DIR absent (06-01) | ✓ VERIFIED | Same resolver; `vault_list.rs:189` consumes it after the cfg(test) override; unit test `resolve_native_e2e_dir_errors_on_empty_value_naming_the_variable` passed |
| 4 | All fixture files under one per-run mkdtemp root; none committed (06-01) | ✓ VERIFIED | `fixtureWorkspace.ts:110` single `fs.mkdtemp(os.tmpdir(), "maru-native-e2e-")` root, all writes `path.join`-derived; `git ls-files` shows no committed native fixture workspace |
| 5 | App under the runner has no credentials seeded, updater/provider IO unconfigured (06-01) | ✓ VERIFIED | `fixtureWorkspace.ts` seeds exactly one local private workspace + registry, nothing else; doc states D-11 |
| 6 | Hosted spike produced a definitive classified first result; retry cap and failure class recorded (06-01) | ✓ VERIFIED | `docs/native-e2e.md` `## Spike log`: cap 3 recorded, 2 runs used, both attempts pass with run URLs, verdict settled |
| 7 | No live PTY child/app process left after suite exit, pass AND fail paths (06-01, backstop) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `killSurvivingAppProcesses` wired into `afterSession` AND `onComplete` (wdio.conf.ts:150-165), anchored/escaped pgrep (CR-01 fix confirmed in code); verifier's own `pgrep -fl` after this session's repeated green runs: zero matches — but no test exercises the fail path. See Human Verification #1 |
| 8 | Spec reads the terminal's whole screen as exact text via build-gated bridge, no state change (06-02) | ✓ VERIFIED | `nativeE2eBridge.ts` + registration at `NativeTerminalView.tsx:868-870`; reader closure `gridRef.current.map(frameLineToText).join("\n")` — read-only by full-body inspection |
| 9 | Canvas ink check proves paint independent of text, font, DPR (06-02) | ✓ VERIFIED | `ptyAssertions.ts:76-138` samples device pixels from canvas.width/height, derives background empirically, no palette/theme read; unpainted-canvas negative control observed failing (06-02 summary drill) |
| 10 | Real PTY child runs a command, asserted both ways in one spec (06-02) | ✓ VERIFIED | `pty.spec.ts` drives a real Shell launcher session; text mirror + ink check both asserted; hosted run 33250704926 `pty.spec.ts 1 passing (4.7s)` |
| 11 | Spec distinguishes PTY output from textarea echo (06-02) | ✓ VERIFIED | `pty.spec.ts:163-170`: typed `echo MARU""_PTY_OK_7F3A2B` vs asserted `MARU_PTY_OK_7F3A2B`; explanatory comment in place |
| 12 | Bridge absent from a normal production build (literal-false gate) (06-02) | ✓ VERIFIED | Gate repeated as literal `import.meta.env.VITE_NATIVE_E2E !== "1"` at each entry point; verifier ran the guard against the current (runner-built) dist/ and observed it FAIL naming `dist/assets/index-DCYTENzs.js` — the red case fires live; production-build green recorded in 06-02/06-03 summaries and re-verified after the App.tsx import |
| 13 | Text-mirror read leaves selection/scroll/cursor unchanged (06-02, backstop) | ✓ VERIFIED | Non-mutation provable by exhaustive inspection: the registered closure's entire body is `gridRef.current.map(frameLineToText).join("\n")` — no writes, no events, no ref mutation; the only code path is fully visible |
| 14 | IME sub-spike produced per-surface answers on both D-07 surfaces (06-03) | ✓ VERIFIED | `ime.spec.ts` (21KB, both mechanisms × both surfaces as locked assertions); `docs/native-e2e.md` `## IME sub-spike` four-row table |
| 15 | Working mechanisms left as running native regression tests (06-03) | ✓ VERIFIED | ime.spec terminal composition + rich-editor composition cases assert positive outcomes; suite green (ime 6 passing) |
| 16 | Non-working mechanisms named per surface as human-attended (06-03) | ✓ VERIFIED | Doc `## IME sub-spike` "Left to a human" column per row + `## Human-attended checklist` items 4-6 |
| 17 | Native spec drives the menu-command path and asserts DOM response (06-03) | ✓ VERIFIED | `menu.spec.ts` drives 3 ids; verifier ran the plan's id-declaration check: `view.documents`, `terminal.shell`, `terminal.split` all declared in `app_menu.rs`; `App.tsx:6932-6935` registers dispatcher delegating to the same `runMenuCommand` (no parallel switch) |
| 18 | Spec states it does not prove OS menu-bar delivery; that half human-attended (06-03) | ✓ VERIFIED | menu.spec.ts opening comment lines 1-11 states both halves explicitly |
| 19 | Composed Korean syllable arrives exactly once, no trailing duplicate (06-03, backstop) | ✓ VERIFIED | `ime.spec.ts:325-333` dispatches the trailing echo inside the 100ms guard window and asserts `countOccurrences(text, WORD) === 1`; behavioral test exists and the suite passes it (hosted run green) |
| 20 | `pnpm typecheck` covers e2e-native/ (06-04) | ✓ VERIFIED | `tsconfig.json:7` references `./tsconfig.e2e-native.json` (include exactly `["e2e-native"]`, no composite key); verifier ran `tsc -p tsconfig.e2e-native.json --noEmit` → exit 0 |
| 21 | `pnpm lint` covers e2e-native/ (06-04) | ✓ VERIFIED | `eslint.config.js:53-65` block pointed at tsconfig.e2e-native.json with the same two rules as e2e/; `package.json` lint script includes `e2e-native`; verifier ran `eslint e2e-native --max-warnings 0` → exit 0 |
| 22 | `make verify` fails when a production build carries the bridge; failure observed before fix (06-04) | ✓ VERIFIED | Guard chained into `build:frontend` after check-bundle-budget (`package.json:14`); verify's last prerequisite is build-frontend; verifier observed the live red case this session; 06-04 summary records the fail-first drill |
| 23 | `make verify` fails when the manifest stops excluding the plugin from defaults (06-04) | ✓ VERIFIED | `check-native-e2e-isolation.mjs` checkManifest asserts default==[], native-e2e feature present, plugin optional, no default-reachable feature enables it; runs inside build:frontend chain; manifest-break drills recorded failing and reverted |
| 24 | `make release-checks` fails when a default-feature binary contains the plugin (06-04) | ✓ VERIFIED | `Makefile:288` `--binary` scan between the debug no-bundle build and the prune; verifier confirmed the current feature-on binary contains the plugin strings (754 hits) so the scan is not vacuous; default-build green drill recorded |
| 25 | Both guard halves read produced artifacts, not source declarations (06-04) | ✓ VERIFIED | Bundle half reads `dist/assets/*.js`; binary half reads the built executable buffer; manifest assertions kept as cheap early warning only (header comment says so) |
| 26 | Guard failure message names the build to re-run (06-04, backstop) | ✓ VERIFIED | Verifier's live run printed: "...a correct failure on a build that was never meant to ship. Re-run `pnpm build:frontend`." |
| 27 | macOS CI job compiles/typechecks runner code on every PR, never runs the suite (06-05) | ✓ VERIFIED | `ci.yml:226-269` `native-e2e-compile` on macos-14, `needs: decision` + `run_full` gating, steps install/typecheck/lint/`cargo check --locked --features native-e2e`; structural one-liner passed; no suite invocation in ci.yml |
| 28 | `make release-preflight` fails when the native suite fails, both branches (06-05) | ✓ VERIFIED | `Makefile:301` release-preflight invokes `test-e2e-native`; `verify` prerequisite list confirmed free of it; release-preflight exit 0 recorded (context + ratification record) |
| 29 | Full suite runs on main/tags only because the spike proved all three D-01 conditions (06-05) | ✓ VERIFIED | `native-e2e.yml` triggers: push main, tags `v*`, workflow_dispatch; spike workflow deleted; verdict/workflow consistency one-liner passed; ratification record carries per-condition evidence |
| 30 | One doc under docs/ says what the runner is, how to run it, CI scope, human parts (06-05) | ✓ VERIFIED | `docs/native-e2e.md` — all seven required sections present (verifier ran the plan's section one-liner) |
| 31 | PROJECT.md CI reality states the verdict, not the pre-phase assumption (06-05) | ✓ VERIFIED | `.planning/PROJECT.md:232-234` rewritten bullet; old claim absent; points at docs/native-e2e.md |
| 32 | Verdict not recorded ci-viable unless all three D-01 conditions held (06-05) | ✓ VERIFIED | `### Ratification` section answers each condition YES with named evidence (runs 33243419439/33250704926, zero TCC lines, skipped failure-screencapture, pty.spec green, 4/4 unattended); blocking human checkpoint approved item-by-item |
| 33 | Doc names which D-08 artifact covers what (06-05) | ✓ VERIFIED | `## Human-attended checklist` opening: "the synthetic-composition specs inside the runner guard the app's own composition-handling logic … this checklist covers the OS input method itself" |
| 34 | A reader can tell which make target runs which suite (06-05, backstop) | ✓ VERIFIED | Doc: "**Which target runs which suite:** `make test-e2e` is the Playwright suite … `make test-e2e-native` is WebdriverIO against the real backend … a green result from one says nothing about the other" |

**Score:** 33/34 truths verified (1 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src-tauri/Cargo.toml` | `[features]` with default-off native-e2e gating the plugin | ✓ VERIFIED | `default = []`; `native-e2e = ["dep:tauri-plugin-wdio-webdriver", "tauri/custom-protocol"]`; plugin `optional = true` |
| `src-tauri/src/paths.rs` | Fail-closed override resolver | ✓ VERIFIED | All 4 declared exports present; 4 resolver unit tests pass (run by verifier) |
| `e2e-native/wdio.conf.ts` | wdio config, per-spec-file launch, teardown on both paths | ✓ VERIFIED | 166 lines, substantive; literal retry/timeout values with reasons |
| `e2e-native/helpers/fixtureWorkspace.ts` | mkdtemp seeding + env vars | ✓ VERIFIED | All 3 exports; atomic registry write (WR-02 fix confirmed) |
| `e2e-native/specs/webview.spec.ts` | D-13 surface 1 | ✓ VERIFIED | Substantive real-DOM assertions |
| `tsconfig.e2e-native.json` | TS project for e2e-native | ✓ VERIFIED | include `["e2e-native"]`, no composite, wdio/mocha types; typechecks clean |
| `.github/workflows/native-e2e-spike.yml` | Spike workflow | ✓ VERIFIED (as superseded) | Existed, produced 2 runs, then deleted in the ci-viable branch per plan 06-05 — absence is the correct end state |
| `docs/native-e2e.md` | Spike log + full runner document | ✓ VERIFIED | All 7 sections + Ratification + Observations |
| `src/lib/nativeE2eBridge.ts` + `.test.ts` | Build-gated bridge + vitest coverage | ✓ VERIFIED | All exports; jsdom pragma line 1; 9 test cases; full vitest run (212 files / 1954 tests) green |
| `e2e-native/helpers/ptyAssertions.ts` | D-05 assertion pair | ✓ VERIFIED | All 4 exports; empirical background; device-pixel sampling |
| `e2e-native/specs/pty.spec.ts` / `ime.spec.ts` / `menu.spec.ts` | D-13 surfaces 2-4 | ✓ VERIFIED | All substantive, all passing in suite |
| `scripts/check-native-e2e-isolation.mjs` | Artifact-level ship-isolation guard | ✓ VERIFIED | 222 lines; live red-case observed by verifier |
| `tsconfig.json` / `eslint.config.js` | Tree registration | ✓ VERIFIED | Reference + lint block confirmed |
| `.github/workflows/native-e2e.yml` | Gated suite workflow (ci-viable branch) | ✓ VERIFIED | native-e2e-suite on main push / v* tags / dispatch; failure evidence upload |
| `.github/workflows/ci.yml` | native-e2e-compile job | ✓ VERIFIED | Present, macos-14, --locked, no suite run |
| `Makefile` | test-e2e-native, guard target, release wiring | ✓ VERIFIED | All present; release-checks scan ordered before prune; release-preflight blocks on suite; verify untouched |
| `.planning/PROJECT.md` | Rewritten CI reality constraint | ✓ VERIFIED | 3-line bullet, points at doc, old claim gone |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| fixtureWorkspace.ts | paths.rs | MARU_NATIVE_E2E_HOME/CONFIG_DIR set on wdio launcher env, inherited by spawned app | ✓ WIRED | seedFixtureWorkspace sets both on process.env in onPrepare (launcher, before service spawns app); paths.rs resolves both |
| maru_dir.rs | paths.rs | maru_home_dir() → native_e2e_dir_override → require_absolute | ✓ WIRED | maru_dir.rs:162, single-exit shape |
| vault_list.rs | paths.rs | app_config_dir() → native_e2e_dir_override after cfg(test) override | ✓ WIRED | vault_list.rs:189 |
| lib.rs | Cargo.toml | cfg(feature = "native-e2e") plugin registration | ✓ WIRED | lib.rs:293-294 |
| NativeTerminalView.tsx | nativeE2eBridge.ts | registerTerminalTextReader with grid closure | ✓ WIRED | lines 868-870, disposer as effect cleanup |
| ptyAssertions.ts | nativeE2eBridge.ts | browser.execute reads the bridge global | ✓ WIRED | readTerminalText reads `window.__MARU_NATIVE_E2E__?.terminalText` |
| pty.spec.ts | NativeTerminalView.tsx | canvas selector inside `[data-session-id]` | ✓ WIRED | `.native-terminal-view[...] .native-terminal-canvas` |
| App.tsx | nativeE2eBridge.ts | registerMenuCommandDispatcher → same runMenuCommand | ✓ WIRED | App.tsx:6932-6935; no parallel switch |
| menu.spec.ts | App.tsx | menuCommand dispatches real app_menu.rs ids | ✓ WIRED | 3 ids verified declared in app_menu.rs |
| package.json build:frontend | check-native-e2e-isolation.mjs | chained after check-bundle-budget | ✓ WIRED | package.json:14; NOT chained into build:frontend:native-e2e |
| Makefile release-checks | guard --binary | scan between debug build and prune | ✓ WIRED | Makefile:288 before clean:tauri-debug |
| Makefile release-preflight | test-e2e-native | recipe line | ✓ WIRED | Makefile:301; verify prerequisite list clean |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| webview.spec.ts | document list text | Real app DOM seeded from per-run mkdtemp fixture | Yes — fixture written per run, read by real backend | ✓ FLOWING |
| pty.spec.ts | terminal text | bridge → gridRef of the live terminal (real PTY child) | Yes — shell-produced marker only exists if a child ran | ✓ FLOWING |
| pty.spec.ts | ink sample | getImageData on the live painted canvas | Yes | ✓ FLOWING |
| ime.spec.ts | composed word count | text mirror / live editor document | Yes | ✓ FLOWING |
| menu.spec.ts | DOM consequences | real runMenuCommand dispatch in the live app | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| e2e-native typechecks | `tsc -p tsconfig.e2e-native.json --noEmit` | exit 0 | ✓ PASS |
| Fail-closed resolver tests | `cargo test --offline --features native-e2e paths::` | 10 passed, incl. absent/empty/relative error cases | ✓ PASS |
| Bridge unit tests (full suite) | `pnpm test` | 212 files / 1954 tests passed | ✓ PASS |
| e2e-native lints | `eslint e2e-native --max-warnings 0` | exit 0 | ✓ PASS |
| Guard fires on runner-built dist | `node scripts/check-native-e2e-isolation.mjs` | exit 1, names `index-DCYTENzs.js` and the fix | ✓ PASS (red case live-observed; current dist is a runner build by design) |
| Menu ids declared | plan's id-declaration one-liner | view.documents, terminal.shell, terminal.split all in app_menu.rs | ✓ PASS |
| CI/preflight structure | plan 06-05 structural one-liner | OK | ✓ PASS |
| Verdict/workflow consistency | plan 06-05 consistency one-liner | ci-viable + suite present + spike deleted | ✓ PASS |
| Doc sections + PROJECT.md | plan 06-05 doc one-liners | all pass | ✓ PASS |
| Leftover process check | `pgrep -fl "src-tauri/target/debug/maru"` | exit 1 (no matches) after repeated suite runs | ✓ PASS (pass path only) |
| Full suite end-to-end | `make test-e2e-native` | 4/4 passing repeatedly; hosted runs 33243419439 + 33250704926 green; release-preflight exit 0 | ? SKIP (session-observed per orchestrator context; re-running a ~5min GUI suite was not repeated by this verifier) |

### Prohibition Review (judgment-tier; non-authoritative, flagged for human review)

| Prohibition | Judgment | Evidence |
|---|---|---|
| Runner never reads/writes/registers real ~/.maru / config dir; refuses rather than falls back (06-01) | UPHELD (non-authoritative) | Fail-closed resolver unit-tested and wired at both call sites; 06-01 human checkpoint confirmed `~/.maru` and registry unchanged |
| No runner-only affordance in a user-installable build (06-01, 06-02, 06-04) | UPHELD (non-authoritative) | default-off feature + literal Vite gate + artifact guard in verify/release-checks; verifier live-observed the guard red on a runner dist; feature-on binary confirmed to contain the plugin strings (scan not vacuous) |
| PTY assertion not satisfiable by echo (06-02) | UPHELD (non-authoritative) | Marker-split construction verified in pty.spec.ts |
| Suite must not be presented as covering OS menu bar / OS-level IME (06-03, 06-05) | UPHELD (non-authoritative) | docs/native-e2e.md names human-attended halves per surface |
| Verdict must not claim CI viability on a partial pass (06-05) | UPHELD (non-authoritative) | Ratification record answers all three D-01 conditions individually with named evidence before recording ci-viable |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| TEST-01 | 06-01..06-05 (all) | Native runner drives the real app (WKWebView DOM, real PTY, IME) against the real Rust backend; CI-vs-unattended decided by spike, not assumed; both verdict branches specified | ✓ SATISFIED | All four D-13 surfaces have living passing specs; spike ran (2 hosted runs, green); verdict ci-viable ratified per-condition; CI placement + release-preflight gate + both records in place. REQUIREMENTS.md marks TEST-01 [x], traceability "Phase 6 — Complete". No orphaned requirement IDs for Phase 6 |

Roadmap success criteria mapping: SC1 (spike definitive answer) → truths 6, 32 ✓; SC2 (PTY readable through canvas) → truths 9, 10 ✓; SC3 (full run unattended / local-only fallback) → truths 27-29 + hosted run 33250704926 ✓; SC4 (IME sub-spike verdict) → truths 14-16, 19 ✓; SC5 (CI-vs-local recorded as settled fact) → truths 30-31, 33-34 ✓.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| — | — | None | — | No TBD/FIXME/XXX, no placeholder text, no empty implementations in any phase-modified file |
| `$TMPDIR/maru-native-e2e-*` (×4) | — | Stale fixture roots dated 18:04–19:13 | ℹ️ Info | Predate the final cleanup code (fixtureWorkspace.ts finalized 22:47); no roots from the post-fix green runs — dev-iteration artifacts, safe to delete |
| `.github/workflows/native-e2e.yml` | 23-29 | No `paths-ignore` (review IN-03) | ℹ️ Info | Docs-only pushes to main burn a full macOS suite run; Info-level finding deliberately out of fix scope (fix_scope: critical_warning) |
| Working tree | — | `docs/design-qa/*.png` modified, uncommitted | ℹ️ Info | Pre-existing dirt recorded in 06-03/06-05 summaries; predates and is unrelated to this phase |

### Human Verification Required

#### 1. Fail-path process/fixture cleanup (backstop truth #7)

**Test:** Deliberately fail one native spec (temporarily break an assertion), run `make test-e2e-native` to a non-zero exit, then `pgrep -f '^\./src-tauri/target/debug/maru$'` and `ls $TMPDIR | grep maru-native-e2e`.
**Expected:** No matching app process, no orphaned PTY children, no fresh fixture root. (The four roots dated 18:04–19:13 predate the final code.)
**Why human:** `killSurvivingAppProcesses` and `cleanupFixtureWorkspace` are wired into `onComplete`, which wdio runs on both paths, and this verifier observed zero leftovers after repeated green runs — but no test exercises the fail path, and a passing run cannot demonstrate fail-path cleanup. 06-02's summary also noted a mocha-timeout teardown path may still leak (not reproduced after fixes).

#### 2. Prohibition verdicts (ADR-550 judgment-tier)

**Test:** Review the five prohibition judgments above against their cited evidence.
**Expected:** Reviewer agrees each is upheld, or flags one for a gap-closure plan.
**Why human:** The plans' prohibition entries carry no `verification: test` tier; the deterministic default is flagged-unverified until a human resolves them. Evidence is strong (unit tests, live guard red case, per-condition ratification) but the rule requires explicit human resolution.

### Gaps Summary

No gaps. Every artifact exists and is substantive, every key link is wired, both guard halves live-fire, and the full suite is green locally and on hosted CI. The single behavior-unverified item is the fail-path cleanup backstop (code wired on both paths; only the pass path is directly evidenced), plus the standing judgment-tier prohibition flags — both routed to human verification above. The phase goal — a native runner driving the real WKWebView DOM, a real PTY, and IME input against the real Rust backend, with the CI-vs-local question settled by evidence (ci-viable, ratified per D-01 condition) — is achieved in the codebase.

---

_Verified: 2026-08-29T14:11:58Z_
_Verifier: Claude (gsd-verifier)_
