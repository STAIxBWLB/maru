# Phase 6: Native E2E Runner Foundation - Context

**Gathered:** 2026-08-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up a native test runner that drives the real Maru application - the real
WKWebView DOM, a real PTY, and IME input - against the real Rust backend rather
than mocked IPC, and settle by spike whether any part of it runs unattended on a
hosted macOS CI runner.

The phase delivers the runner, its seam into the app, its CI-or-local placement,
and the recorded verdict. It does not fix any of the defects the runner will
later verify (PERF-01..05, REL-01..03), does not add product features, and does
not replace the existing Playwright suite, which stays Chromium-against-Vite with
mocked IPC.

</domain>

<decisions>
## Implementation Decisions

### Spike verdict and CI-vs-local scope

- **D-01:** The CI-viability verdict requires all three conditions to hold
  together: a WebDriver session establishes on a hosted macOS runner with no
  interactive permission prompt, real PTY output is readable through the canvas
  surface, and a full run completes with no human present. Any one of them
  failing settles the runner as local-only. A partial pass is not promoted to a
  CI gate.
- **D-02:** Failure is declared by failure type first, under a cap. An observed
  interactive or TCC permission prompt settles the verdict as local-only on the
  spot, with no further attempts. Every other failure class (build configuration,
  version mismatch, port conflict, missing dependency) is treated as fixable and
  retried within a fixed cap on macOS job runs. The cap and the observed failure
  class are both recorded, so a later re-attempt knows whether the wall was
  structural or incidental.
- **D-03:** The human-attended local gate is blocking in `make release-preflight`
  in both branches of the verdict, and a macOS CI job compiles and typechecks the
  runner code on every PR so the suite cannot rot between releases. The compile
  job does not execute the suite. - **Reversibility:** costly - the CI job and
  the preflight wiring are both referenced by the release process and the
  milestone's evidence trail; removing them later means re-arguing the evidence
  standard rather than editing one file.
- **D-04:** The verdict is recorded in two places: a dedicated native-runner
  document under `docs/` carrying how to run it, its scope, and its evidence,
  and an update to the `CI reality` constraint in `.planning/PROJECT.md`, which
  currently asserts that macOS-native changes ship unverified by CI. Phase 8 and
  Phase 9 plan their verification against those two, not against this CONTEXT.

### PTY and IME observation

- **D-05:** Real PTY output is asserted two ways at once, because the two prove
  different facts. A debug text mirror of the terminal screen grid asserts the
  output content exactly, and a shallow canvas readback ink check asserts the
  region was actually painted. The ink check is what satisfies the roadmap's
  canvas-based assertion criterion; the text mirror is what makes the assertion
  specific enough for Phase 9 to check a named string. Golden screenshot
  comparison is rejected: hosted-runner font rendering, `devicePixelRatio`, and
  theme differ from local, so it would fail for reasons unrelated to behavior.
  - **Reversibility:** costly - every terminal-facing native test is written
  against this pair, so changing the assertion model later rewrites all of them.
- **D-06:** The text mirror is exposed as a build-gated frontend debug global in
  the shape of `src/lib/e2eInvoke.ts`, wrapped in an `import.meta.env` condition
  so production bundles tree-shake it away. It reads the same grid the paint path
  reads, so it perturbs no app state. Driving the existing select-all plus
  clipboard user path is rejected: selection changes the screen and would
  contaminate subsequent assertions, and clipboard access on a hosted runner adds
  a second permission variable to the one the spike is trying to isolate.
  - **Reversibility:** costly - the seam shape is what every native spec calls
  into, and it is also the thing the ship-isolation guard is written against.
- **D-07:** The IME sub-spike judges two representative surfaces, not one: the
  terminal's hidden textarea, which carries hand-written composition handling
  including the trailing-duplicate-syllable guard, and the rich editor, which is
  a ProseMirror-family surface handling composition its own way. A single surface
  could yield a verdict that does not generalize.
- **D-08:** If synthetic key events cannot substitute for real OS-level IME
  input, two things are left behind rather than one: a fixed human checklist for
  the real-IME behavior, and synthetic-composition regression tests kept inside
  the native runner so the app's own composition-handling logic stays guarded at
  the native level. The document records which of the two covers what, so the
  boundary between automated proof and human attendance is explicit.

### Native test seam and ship isolation

- **D-09:** Each run seeds a fresh temporary directory with fixture files and
  points the app at it through an environment variable at launch, mirroring the
  existing `MARU_TEST_HOME` plus `tempfile::tempdir()` precedent in the Rust
  tests. The runner never opens the developer's real workspace, and no fixture
  workspace is committed to the repository. - **Reversibility:** costly - the
  fixture contract is what every spec's setup depends on.
- **D-10:** Runner-only code is isolated two ways. It sits behind a default-off
  cargo feature so it is not compiled into release builds, and a static guard in
  the existing `scripts/check-*.mjs` family inspects the produced artifacts for
  the debug symbols and globals directly. Declaring the intent and checking the
  output are different acts, and only the second one catches a stray build flag
  or a feature propagated through a dependency. A separate runner-only binary is
  rejected because it would break TEST-01's premise that the runner drives the
  application that actually ships. - **Reversibility:** costly - the feature gate
  reaches the Cargo manifest, the build commands, and CI, and the guard becomes
  part of the verify gate.
- **D-11:** The app's outbound dependencies stay unconfigured for the whole run.
  No credentials are seeded, and the updater and provider IO paths are left off.
  The app runs in its normal unconfigured state and the suite asserts only
  against that state. TEST-01 is settling WKWebView, PTY, and IME, not provider
  integration, and leaving the network out is what makes the hosted-runner result
  reproducible.
- **D-12:** The app process is launched once per spec file, with the seed
  workspace reset between tests inside that file. Per-test relaunch is rejected
  because macOS launch cost compounds against the unattended-completion criterion;
  a single launch for the whole run is rejected because terminal sessions and
  editor tabs are long-lived state whose leakage across specs would be hard to
  attribute.

### Runner scope and downstream hand-off

- **D-13:** Phase 6 leaves at least one living test on each of the four surfaces
  TEST-01 names: WKWebView DOM, a real PTY, IME input, and the macOS menu bar.
  Each is the minimum size that proves the surface can be driven at all. The
  point is evidence that the driving method works on every named surface, not
  suite breadth.
- **D-14:** Phase 6 builds the runner skeleton and those four representative
  tests only. Phase 8's concurrency load test and Phase 9's SIGHUP test attach
  their own tests to this runner when those phases run. Phase 6 does not
  pre-build helpers for requirements that are not yet specified.
- **D-15:** Native runner code lives in a top-level `e2e-native/` directory with
  its own make target, kept separate from `e2e/`, which stays Playwright-only as
  `.planning/codebase/TESTING.md` describes. It must be added to the `tsconfig`
  and ESLint targets. - **Reversibility:** costly - the path is referenced by the
  Makefile, CI workflows, tsconfig, ESLint config, and the testing map, so moving
  it later is a wide rename rather than a local edit.
- **D-16:** If the spike succeeds, the full native suite runs on pushes to `main`
  and on release tags, not on every PR. PRs get only the compile-and-typecheck
  job from D-03. Running the full suite per PR is rejected on macOS runner cost
  and on the risk that early native flakiness blocks unrelated PRs; deferring it
  to release tags alone is rejected because it finds regressions at the worst
  possible moment.

### Claude's Discretion

- The exact cap on macOS job runs for non-permission spike failures, provided the
  cap and the observed failure class are both recorded per D-02.
- The exact names of the environment variable, the debug global, the cargo
  feature, the guard script, and the make targets.
- The ink-check threshold and the sampled canvas region, provided the check fails
  on an unpainted terminal and does not depend on font rendering details.
- The composition of the seeded fixture workspace, provided it is created per run
  and never committed.
- The wdio configuration shape and the mechanics of the embedded provider setup.
- Which single flow represents each of the four surfaces in D-13.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and locked project constraints

- `.planning/ROADMAP.md` section "Phase 6: Native E2E Runner Foundation" - goal,
  the HIGH uncertainty note, and the five success criteria this context refines.
- `.planning/REQUIREMENTS.md` section "Native Verification" - TEST-01 in full,
  including both branches of the spike outcome.
- `.planning/REQUIREMENTS.md` section "Out of Scope" - Playwright is explicitly
  rejected for the native suite.
- `.planning/PROJECT.md` sections "Constraints" and "Current Milestone" - the
  `CI reality` constraint D-04 updates, the tech-stack pins, the bundle budget,
  and the milestone's evidence standard.

### Research that this phase is settling

- `.planning/research/SUMMARY.md` - the unresolved STACK-vs-PITFALLS tension on
  `@wdio/tauri-service`'s embedded provider, what a spike must demonstrate, and
  why the IME sub-spike is separate. This is the single most important upstream
  document for this phase.
- `.planning/research/STACK.md` - the MEDIUM-confidence case that the embedded
  provider (`tauri-plugin-wdio-webdriver`) runs unattended on hosted macOS.
- `.planning/research/PITFALLS.md` - pitfalls 16-20, the TCC permission wall
  argument, signed-vs-debug build divergence, and the synthetic-key-vs-real-IME
  gap.
- `.planning/research/ARCHITECTURE.md` - the independent conclusion that TEST-01
  is likely a human-attended local tool.

### Codebase evidence and conventions

- `.planning/codebase/TESTING.md` - the three existing test layers, the
  `e2e/`-is-Playwright-only rule D-15 preserves, the Rust `MARU_TEST_HOME` plus
  `tempdir` isolation precedent D-09 mirrors, and the `make verify` hermeticity
  rule.
- `.planning/milestones/v1.0-phases/05-shell-decomposition-completion/05-CONTEXT.md`
  - decisions D-16 and D-20 describe the manual macOS native UAT this runner is
  meant to eventually displace.

### Live implementation anchors

- `src/components/NativeTerminalView.tsx` - the `<canvas aria-hidden="true">` at
  line 2129, the grid the paint path reads, the whole-screen text path at line
  1206, and the IME composition handling at lines 86-136 and 470-531.
- `src/lib/e2eInvoke.ts` - the existing build-inert seam whose shape D-06 copies.
- `playwright.config.ts` and `e2e/helpers/todayFixtures.ts` - the existing e2e
  suite and its page-side fixture pattern, kept separate from the native runner.
- `.github/workflows/ci.yml` - currently `ubuntu-22.04` only for both verify and
  e2e; the macOS compile job from D-03 lands here.
- `.github/workflows/release-bundles.yml` - the existing `macos-latest` matrix
  legs, the only macOS runners in the repository today.
- `Makefile` targets `release-preflight`, `release-preflight-core`, and
  `verify-integration` - the wiring point for D-03 and the precedent for a
  non-hermetic target kept outside `make verify`.
- `scripts/check-bundle-budget.mjs` and `scripts/check-select-chrome.mjs` - the
  static guard family D-10's ship-isolation check joins.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/lib/e2eInvoke.ts`: a build-inert seam that already demonstrates how to add
  a test-only global without it reaching the shipped shell. D-06 copies its
  shape, inverted - active in a debug native build, absent in production.
- `src/components/NativeTerminalView.tsx` line 1206: `gridRef.current.map(frameLineToText).join("\n")`
  already produces the whole terminal screen as text. The text mirror reads the
  same grid through the same helper rather than reconstructing it.
- The Rust test isolation idiom (`MARU_TEST_HOME`, `MARU_TEST_CONFIG_DIR`, and a
  restore guard, with `tempfile::tempdir()` for real filesystem behavior) is the
  established pattern for keeping a test off the developer's real workspace.
- `scripts/check-*.mjs`: an existing family of static guards wired into
  `make verify`, ready to take one more member rather than needing a framework.
- `.github/workflows/release-bundles.yml`: proves macOS runners and the Rust
  toolchain setup already work in this repository's CI, so the macOS job is a new
  leg on a proven path rather than new ground.

### Established Patterns

- `make verify` stays hermetic; anything needing installed tools or live
  credentials lives in a separate target. `make verify-integration` is the
  precedent the native target follows.
- Rust filesystem behavior is tested against a real tempdir, never a mock.
- Test-only affordances are opt-in and inert wherever they are not wanted, rather
  than being guarded by runtime conditionals that ship.
- The bundle budget gate proves properties of the produced artifact, not of the
  source. D-10's ship-isolation guard follows the same principle.

### Integration Points

- A new top-level `e2e-native/` directory joins the `tsconfig` project references
  and the ESLint target list alongside `src` and `e2e`.
- A new make target joins `release-preflight`, next to `cli-smoke` and `test-e2e`.
- A new macOS job joins `.github/workflows/ci.yml`, which today has only
  `ubuntu-22.04` legs.
- A cargo feature joins `src-tauri/Cargo.toml`, defaulting off, gating the
  WebDriver plugin dependency.
- A new guard joins the `check-*` chain inside the `verify` target.
- `.planning/PROJECT.md`'s `CI reality` constraint is rewritten at phase end to
  match the verdict.

</code_context>

<specifics>
## Specific Ideas

- Treat the canvas ink check and the text mirror as proving two different facts,
  and keep both, rather than choosing one assertion style.
- Treat an observed permission prompt as terminal evidence that ends the spike
  immediately, and every other failure as ordinary debugging under a cap. The
  distinction between a structural wall and a fixable mistake is what keeps the
  spike from either quitting early or running forever.
- Record the failure class alongside the verdict, so a future macOS runner-image
  change can be evaluated against what actually blocked us.
- Keep the app in its unconfigured state for the whole run, so nothing outside
  the four named surfaces can influence a result.
- Prove each of the four surfaces once at minimum size rather than building a
  broad suite, and let the phases that need more attach their own tests.
- Preserve `e2e/` as a Playwright-only directory so the two suites' different
  runners and different premises stay visible in the file layout.

</specifics>

<deferred>
## Deferred Ideas

None - the discussion stayed inside the Phase 6 boundary. Automating the manual
macOS native UAT items from milestone v1.0 phases 04 and 05 was raised as an
option and rejected for this phase, on the grounds that growing the suite before
the CI-viability verdict exists inverts the phase's own ordering. It remains
available to a later phase once the verdict is recorded.

</deferred>

---

*Phase: 6-Native E2E Runner Foundation*
*Context gathered: 2026-08-29*
