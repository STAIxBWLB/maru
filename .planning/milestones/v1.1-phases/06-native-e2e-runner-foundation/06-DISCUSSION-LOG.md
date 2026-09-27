# Phase 6: Native E2E Runner Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-08-29
**Phase:** 6-Native E2E Runner Foundation
**Areas discussed:** Spike verdict criteria, PTY/IME observation method, Native test seam, Runner scope and hand-off

---

## Spike verdict criteria

### Q1: Which of the three conditions must hold to declare CI unattended viability?

| Option | Description | Selected |
|--------|-------------|----------|
| All three | Session establishes, canvas PTY readout, unattended full run must all hold; any failure means local-only | ✓ |
| Permission condition only | Prompt-free session plus unattended completion is enough; canvas readout split into its own slice | |
| Per-surface verdicts | No single verdict; record CI viability per surface and gate only the passing ones | |

**User's choice:** All three
**Notes:** Matches the roadmap's demand for a definitive answer rather than an assumption, and avoids a CI gate that can only be half trusted. Accepted cost: a purely technical canvas-readout problem can drag the whole runner down to local-only.

### Q2: When is the spike declared failed and turned local-only?

| Option | Description | Selected |
|--------|-------------|----------|
| Failure-type first + cap | An observed interactive/TCC prompt settles it on the spot; other failures are fixable within a fixed job-run cap | ✓ |
| Job-run cap only | Fixed number of macOS job runs regardless of cause | |
| Time cap only | Fixed working-time budget regardless of cause | |

**User's choice:** Failure-type first + cap
**Notes:** Separates the structural wall from an incidental setup mistake, so the spike neither abandons a fixable path nor burns budget on an unfixable one.

### Q3: How much enforcement does the human-attended local gate get?

| Option | Description | Selected |
|--------|-------------|----------|
| Blocking + compile job | Blocking in release-preflight, plus a per-PR macOS job that compiles and typechecks the runner | ✓ |
| Blocking only | Blocking in release-preflight with no CI job | |
| Non-blocking report | Reports in release-preflight but does not stop a release | |

**User's choice:** Blocking + compile job
**Notes:** A test nobody is forced to pass decays, and a runner that never compiles in CI rots between releases. Accepted cost: some macOS runner minutes on every PR.

### Q4: Where is the spike verdict recorded?

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated doc + constraint update | A native-runner doc under docs/, plus an update to the PROJECT.md "CI reality" constraint | ✓ |
| PROJECT.md constraint only | Fix the constraint line and add no new document | |
| GSD artifacts only | Record inside Phase 6 CONTEXT/SUMMARY/VERIFICATION only | |

**User's choice:** Dedicated doc + constraint update
**Notes:** docs/ already holds operational documents (e2e-flow-evidence.md, perf-baseline.md), and the PROJECT.md constraint is the line downstream agents actually read. GSD artifacts alone would be archived at milestone close.

---

## PTY/IME observation method

### Q1: What asserts real PTY output?

| Option | Description | Selected |
|--------|-------------|----------|
| Text mirror + ink check | Debug accessor reads the screen grid as text for exact content; canvas readback shallowly confirms the region was painted | ✓ |
| Golden screenshot compare | Pixel-compare against a stored reference image | |
| Pixel check only | Canvas readback for non-blank/ink volume, no content assertion | |

**User's choice:** Text mirror + ink check
**Notes:** The two prove different facts - that the PTY returned the right bytes, and that the render pipeline is alive. Golden screenshots were rejected on hosted-runner font, DPR, and theme drift.

### Q2: How is the text mirror exposed?

| Option | Description | Selected |
|--------|-------------|----------|
| Build-gated debug global | Same shape as src/lib/e2eInvoke.ts, wrapped in an import.meta.env condition so production tree-shakes it | ✓ |
| Reuse existing user path | Drive select-all plus copy with real key input and read the clipboard; zero added surface | |
| cargo feature Rust command | A #[cfg(feature)] Tauri command, strongest ship guarantee | |

**User's choice:** Build-gated debug global
**Notes:** Reads the same grid the paint path reads without perturbing app state. The clipboard route was rejected because selection changes the screen and clipboard access adds a second permission variable. The Rust route was rejected because the canonical grid lives on the frontend, so Rust would have to reconstruct it and could drift from what is actually shown.

### Q3: Which surfaces must the IME sub-spike cover?

| Option | Description | Selected |
|--------|-------------|----------|
| Terminal + rich editor | Two representatives: hand-written composition handling and a ProseMirror-family surface | ✓ |
| Terminal only | Judge the automation layer's capability from one surface | |
| Every Korean-capable surface | Include search fields and dialog inputs | |

**User's choice:** Terminal + rich editor
**Notes:** Synthetic events can plausibly work in a plain textarea and fail in ProseMirror, so a single surface risks a verdict that does not generalize.

### Q4: Fallback if synthetic key events cannot substitute for real IME?

| Option | Description | Selected |
|--------|-------------|----------|
| Checklist + synthetic regression | Fixed human checklist for real OS IME, plus synthetic-composition regression tests kept in the runner | ✓ |
| Accessibility-based local automation | AppleScript / Accessibility API drives the real IME locally | |
| Checklist only | All of it becomes human work, no IME code in the runner | |

**User's choice:** Checklist + synthetic regression
**Notes:** Keeps the terminal's duplicate-syllable guard and Enter-during-composition logic under automated regression cover even when real IME behavior cannot be automated. The Accessibility route was rejected as a permission-dependent, macOS-version-fragile expansion of a foundation phase.

---

## Native test seam

### Q1: What workspace does the runner hand the app?

| Option | Description | Selected |
|--------|-------------|----------|
| Temp dir + env | Per-run temp directory seeded with fixtures, pointed at by an environment variable at launch | ✓ |
| Build it through the UI | Launch clean and have the runner create the workspace by clicking | |
| Committed fixture workspace | Check a fixture workspace into the repository and open it | |

**User's choice:** Temp dir + env
**Notes:** Mirrors the existing MARU_TEST_HOME plus tempdir precedent, keeps every run clean, and never touches the developer's real workspace. A committed fixture would be dirtied the moment a test writes.

### Q2: How is runner-only code kept out of shipped bundles?

| Option | Description | Selected |
|--------|-------------|----------|
| cargo feature + static guard | Default-off feature, plus a check-*.mjs guard that inspects the produced artifacts | ✓ |
| cargo feature only | Default-off feature, no artifact inspection | |
| Separate runner binary | A distinct binary target fully separated from the shipped app | |

**User's choice:** cargo feature + static guard
**Notes:** Declaring intent and checking output are different acts; only the guard catches a stray build flag or a feature propagated through a dependency. A separate binary was rejected because it breaks TEST-01's premise that the runner drives the app that ships.

### Q3: How are the app's outbound dependencies handled during a run?

| Option | Description | Selected |
|--------|-------------|----------|
| All unconfigured | No credentials seeded, updater and provider paths off; assert only against the unconfigured state | ✓ |
| Real environment as-is | Leave probes and network alone and do not assert on them | |
| Local stubs | Fake CLIs and a stub server return deterministic responses | |

**User's choice:** All unconfigured
**Notes:** TEST-01 is settling WKWebView, PTY, and IME, not provider integration. Stubs were rejected as rebuilding a mock layer inside a runner whose entire purpose is avoiding mocks.

### Q4: At what granularity is the app process relaunched?

| Option | Description | Selected |
|--------|-------------|----------|
| Once per spec file | One launch per spec, seed workspace reset between tests | ✓ |
| Once per test | Perfect isolation, highest launch cost | |
| Once per full run | Fastest, weakest isolation | |

**User's choice:** Once per spec file
**Notes:** Balances macOS launch cost against the unattended-completion criterion. A single launch for the whole run was rejected because terminal sessions and editor tabs are long-lived state whose cross-spec leakage would be hard to attribute.

---

## Runner scope and hand-off

### Q1: How far does Phase 6 build?

| Option | Description | Selected |
|--------|-------------|----------|
| One test per named surface | At least one living test each on WKWebView DOM, real PTY, IME, and the macOS menu bar | ✓ |
| Single smoke only | App launches and one DOM assertion passes; other surfaces recorded as spike results | |
| Replace the manual UAT | Automate the macOS native UAT items from v1.0 phases 04 and 05 | |

**User's choice:** One test per named surface
**Notes:** Leaves proof that each named surface can be driven, so later phases have something to extend. The full UAT replacement was rejected as growing the suite before the CI-viability verdict exists, which inverts the phase's own ordering.

### Q2: How do Phase 8 and Phase 9 use this runner?

| Option | Description | Selected |
|--------|-------------|----------|
| Later phases add their own | Phase 6 ships the skeleton and four representative tests; Phases 8 and 9 attach their own tests | ✓ |
| Pre-build helpers | Phase 6 builds a concurrency driver and a PTY process-tree inspector in advance | |
| Each phase separately | Phases 8 and 9 verify by their own means without the runner | |

**User's choice:** Later phases add their own
**Notes:** Avoids designing helpers against requirements that are not yet specified. Separate means was rejected because the roadmap makes Phase 9 depend on Phase 6 precisely so REL-01's SIGHUP claim can be checked against a real PTY.

### Q3: Where does native runner code live?

| Option | Description | Selected |
|--------|-------------|----------|
| Top-level e2e-native/ | Separate directory and make target; e2e/ stays Playwright-only | ✓ |
| e2e/native/ | Nested under the existing e2e directory | |
| Under src-tauri/tests/ | Attached to the Rust side | |

**User's choice:** Top-level e2e-native/
**Notes:** Keeps the TESTING.md statement that e2e/ is Playwright-only true, avoids colliding with Playwright's default discovery path, and makes the two runners' difference visible in the layout. Requires adding the directory to tsconfig and ESLint targets.

### Q4: When does the full native suite run in CI if the spike succeeds?

| Option | Description | Selected |
|--------|-------------|----------|
| main pushes and release tags | PRs get only the compile job; the full suite runs at integration points | ✓ |
| Every PR | Strongest gate, highest macOS minute cost | |
| Release tags only | Cheapest, latest possible regression discovery | |

**User's choice:** main pushes and release tags
**Notes:** Balances macOS runner cost against signal, and keeps early native flakiness from blocking unrelated PRs while still finding regressions before a release.

---

## Claude's Discretion

- The exact cap on macOS job runs for non-permission spike failures.
- Names for the environment variable, the debug global, the cargo feature, the guard script, and the make targets.
- The ink-check threshold and sampled canvas region.
- The composition of the seeded fixture workspace.
- The wdio configuration shape and embedded-provider setup mechanics.
- Which single flow represents each of the four surfaces.

## Deferred Ideas

- Automating the manual macOS native UAT items from milestone v1.0 phases 04 and 05. Raised while scoping the runner and rejected for this phase because growing the suite before the CI-viability verdict exists inverts the phase's ordering. Available to a later phase once the verdict is recorded.
