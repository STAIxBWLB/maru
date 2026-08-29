---
phase: 06-native-e2e-runner-foundation
plan: 02
subsystem: testing
tags: [webdriverio, tauri, pty, canvas, vite-tree-shaking, debug-bridge]

requires:
  - phase: 06-01
    provides: "make test-e2e-native runner, wdio.conf/fixtureWorkspace, the native-e2e cargo feature and VITE_NATIVE_E2E build flag"
provides:
  - "src/lib/nativeE2eBridge.ts: single build-gated window.__MARU_NATIVE_E2E__ namespace (terminalText + menuCommand), absent from production bundles"
  - "NativeTerminalView registers a read-only whole-screen text reader per session (D-06)"
  - "e2e-native/helpers/ptyAssertions.ts: readTerminalText + assertTerminalInk, the D-05 assertion pair every terminal-facing native spec will use"
  - "e2e-native/specs/pty.spec.ts: D-13 surface 2 — one real shell flow asserted both ways in ~0.5s"
affects: [06-03 IME spec (uses the same runner mechanics), 06-04 ship-isolation guard (checks the single namespace string), Phase 8 load test and Phase 9 SIGHUP spec (attach to readTerminalText/assertTerminalInk)]

actuals:
  tokens: 7189
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Build-inert seam: gate repeated as the literal import.meta.env.VITE_NATIVE_E2E === \"1\" expression at each entry point (esbuild folds it; it does NOT inline a helper call across functions), so the bridge string is absent from production bundles"
    - "Command-economy spec writing for the embedded provider: in-page clicks + executeAsync poll loops (one WebDriver command per wait), wdio element commands avoided (~10-15s each with withGlobalTauri:false), real key events only for the input path under test"
    - "Fixture reset that never deletes watched directories and skips the first per-worker reset (it races the app's boot read)"

key-files:
  created:
    - src/lib/nativeE2eBridge.ts
    - src/lib/nativeE2eBridge.test.ts
    - e2e-native/helpers/ptyAssertions.ts
    - e2e-native/specs/pty.spec.ts
  modified:
    - src/components/NativeTerminalView.tsx
    - e2e-native/helpers/fixtureWorkspace.ts
    - e2e-native/wdio.conf.ts

key-decisions:
  - "The VITE_NATIVE_E2E gate is repeated as a literal expression inside each register function rather than calling nativeE2eEnabled(): verified empirically that esbuild minify folds the statically replaced expression but does not inline the helper call, so the helper-call shape leaks the __MARU_NATIVE_E2E__ string into production bundles"
  - "pty.spec clicks the Shell launcher specifically, not the plan's literal 'first enabled button': the first enabled button is the Claude launcher, which spawns an interactive TUI where installed (and fails where not) — only a real shell makes the shell-produced-marker assertion meaningful"
  - "pty.spec drives setup with in-page clicks and does every wait as one executeAsync with an inlined poll loop; a probe function cannot cross the WebDriver boundary (only the serialized top-level function and JSON args can), and wdio element commands cost ~10-15s each under the embedded provider"
  - "The spec's marker is produced by splitting echo's argument with an empty quoted pair, so the typed characters (MARU\"\"_PTY_OK_7F3A2B) and the shell's printed line (MARU_PTY_OK_7F3A2B) differ — a terminal that only echoes input fails the spec (T-06-07)"

patterns-established:
  - "The D-05 assertion pair: text mirror for WHAT printed + empirical-background ink check for THAT the canvas painted; no golden screenshots, no font/DPR/theme dependence"
  - "readTerminalText throws naming pnpm build:frontend:native-e2e when the bridge namespace is absent — wrong-build failures get a named fix, not a null dereference"

requirements-completed: [TEST-01]

coverage:
  - id: D1
    description: "Build-gated debug bridge: gate, registration, unregistration, unknown-session null, per-session independence, single namespace — plus the production/native-e2e bundle presence/absence assertions"
    requirement: TEST-01
    verification:
      - kind: unit
        ref: "pnpm test -- nativeE2eBridge — 9 cases green (212 files / 1954 tests total)"
        status: pass
      - kind: other
        ref: "post-build grep over dist/assets/*.js: bridge string absent after pnpm build:frontend, present (index-*.js) after pnpm build:frontend:native-e2e"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-13 surface 2: one real shell runs a real command in the real app; the shell-printed marker is read through the text mirror and the canvas ink check proves paint (8527/212176 sampled pixels, ratio 0.040)"
    requirement: TEST-01
    verification:
      - kind: e2e
        ref: "make test-e2e-native — 2 passing (pty.spec 0.45-0.5s, webview.spec 46s), exit 0, 2026-08-29"
        status: pass
    human_judgment: false
  - id: D3
    description: "Assertion-pair negative controls: unpainted canvas fails the ink check; plain production dist fails the spec naming pnpm build:frontend:native-e2e"
    requirement: TEST-01
    verification:
      - kind: e2e
        ref: "temporary probe spec: 0/120000 pixels differ, ratio 0.00000 < 0.002 (observed, reverted); plain-dist run: readTerminalText threw the named-build error (observed, build restored)"
        status: pass
    human_judgment: false

duration: ~55min
completed: 2026-08-29
status: complete
---

# Phase 06-02: Build-Gated Terminal Bridge and Dual PTY Assertion Summary

**A build-gated `window.__MARU_NATIVE_E2E__` debug bridge exposes the terminal screen as exact text (tree-shaken out of production bundles), and one native spec spends it plus a canvas ink check on a real shell flow in ~0.5s — with two negative-control probes proving both assertions can fail.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-29T08:51:35Z
- **Completed:** 2026-08-29T09:45Z
- **Tasks:** 2/2
- **Commits:** 3 (fdb9d33 test/RED, b92a8d9 feat/GREEN, 8f43639 feat)

## Task 1 — Build-gated terminal-text bridge (TDD)

RED→GREEN: failing Vitest file first (module did not exist), then the
implementation.

- `src/lib/nativeE2eBridge.ts` — one namespaced global typed as
  `MaruNativeE2eBridge` (`terminalText(sessionId): string | null`,
  `menuCommand(id): void`), lazily installed on first registration, readers in
  a module-level `Map`. Unknown session ids return null, never throw.
  Registration entry points take closures, keeping the dependency
  component→lib (PROJECT.md import-direction rule).
- **Tree-shaking mechanics, verified not assumed:** esbuild minify folds the
  statically replaced `import.meta.env.VITE_NATIVE_E2E` expression in place
  but does NOT inline a `nativeE2eEnabled()` call across functions — the
  helper-call shape left `__MARU_NATIVE_E2E__` in the production bundle in a
  direct esbuild reproduction. The gate is therefore repeated as the literal
  expression inside each register function (header comment explains why).
  Verified end-to-end: absent from every `dist/assets/*.js` after plain
  `pnpm build:frontend`, present after `pnpm build:frontend:native-e2e`.
- `src/components/NativeTerminalView.tsx` — an effect keyed on `sessionId`
  guards with `nativeE2eEnabled()` and registers
  `() => gridRef.current.map(frameLineToText).join("\n")` — the exact
  expression `selectAll` already uses. It writes no ref, dispatches no event,
  and never touches selection, scroll, or cursor (T-06-06; the
  selection-unchanged truth holds by construction — the closure is
  read-only). No eslint-disable added; `pnpm lint` clean.
- `src/lib/nativeE2eBridge.test.ts` — jsdom pragma on line 1, `vi.stubEnv`
  per case, global deleted between cases; one `it` per `<behavior>` bullet
  (9 cases).

## Task 2 — Dual PTY assertion helper and real-shell spec

- `e2e-native/helpers/ptyAssertions.ts` — `readTerminalText(sessionId)` reads
  the bridge via `browser.execute`, returning null for unregistered sessions
  and throwing a message that names `pnpm build:frontend:native-e2e` when the
  namespace itself is absent. `assertTerminalInk(selector, options)` samples
  the canvas's full width × top 25% in DEVICE pixels (`canvas.width/height`,
  never CSS geometry), derives the background as the most frequent RGBA
  quadruple in the sample (no palette/theme/CSS read), and fails unless the
  differing-pixel ratio ≥ `INK_MIN_RATIO` (0.002) at `INK_CHANNEL_TOLERANCE`
  8. SecurityError is deliberately not caught.
- `e2e-native/specs/pty.spec.ts` — opens the terminal panel, clicks the Shell
  launcher, waits for the new active session view, focuses
  `.native-terminal-input`, sends `echo MARU""_PTY_OK_7F3A2B` as REAL key
  events, and polls the text mirror for `MARU_PTY_OK_7F3A2B` — a string the
  shell produces only by evaluating the empty quoted pair away, so terminal
  echo alone can never satisfy it (comment in the spec says so). Then the ink
  check on the session's canvas. Passing run: marker found, ink ratio 0.040.
- **Acceptance probes (observed, reverted):**
  - Unpainted-canvas probe: a temporary spec pointed `assertTerminalInk` at a
    sized-but-never-drawn canvas created in `browser.execute` — it failed
    with `0/120000 sampled pixels differ (ratio 0.00000 < 0.002)`. Probe
    file deleted after observation.
  - Plain-dist probe: `pnpm build:frontend` + `touch build.rs` +
    `cargo build --features native-e2e`, then the spec failed with
    "readTerminalText: window.__MARU_NATIVE_E2E__ is absent … Rebuild with
    `pnpm build:frontend:native-e2e` …" — the named build, not a null
    dereference. Flagged build restored afterwards.
- Final `make test-e2e-native`: **2 passed, exit 0** (pty.spec ~0.5s,
  webview.spec 46s); no leftover app processes, ports, or fixture roots.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Shell launcher chosen over the literal "first enabled button"**
- **Found during:** Task 2
- **Issue:** The plan said "start a shell from the first enabled button in
  `.terminal-launchers`". The first enabled button is the Claude launcher
  (all five launchers default enabled; availability is not checked), which
  spawns an interactive TUI where the CLI is installed and fails to spawn
  where it is not — either way the plan's own must-have truth ("a real PTY
  child process runs a command") cannot be proven through it.
- **Fix:** The spec clicks
  `.terminal-launchers button[aria-label="Shell"]` and a comment records why.
- **Files modified:** e2e-native/specs/pty.spec.ts
- **Committed in:** 8f43639

**2. [Rule 3 - Blocking] Spec mechanics rebuilt around per-command overhead**
- **Found during:** Task 2 (first `make test-e2e-native` run: both specs hit
  the 60s mocha timeout)
- **Issue:** With `withGlobalTauri: false`, the tauri-service's window-state
  helper times out (~5s, twice) around every wdio element command — a click
  or `waitForDisplayed` costs ~10-15s, so the plan-shaped spec (a dozen
  element commands plus `waitUntil` polls) cannot fit any reasonable budget.
- **Fix:** pty.spec drives DOM setup with in-page clicks and does every wait
  as ONE `executeAsync` whose poll loop is inlined (a probe passed as an
  argument cannot cross the WebDriver boundary — first attempt at a generic
  `pollInPage` helper failed exactly that way). In-page deadlines (20s) stay
  below the driver's 30s default script timeout. Result: the whole PTY flow
  runs in ~0.5s. `browser.keys` (real key events) is kept for the terminal
  input — the path under test. Also added a per-test `.timeout(120_000)`.
- **Files modified:** e2e-native/specs/pty.spec.ts
- **Committed in:** 8f43639

**3. [Rule 3 - Blocking] 06-01's per-session cleanup deleted the shared fixture root**
- **Found during:** Task 2 (webview.spec failed with the first-run **Sample
  Workspace** on screen instead of the seeded "Native E2E Fixture" whenever
  it ran after pty.spec)
- **Issue:** `afterSession` runs per worker (per spec file); it removed the
  mkdtemp fixture root after the FIRST spec file, but the launcher spawns the
  NEXT spec file's app pointed at the same root. That app booted into an
  empty registry and the frontend's first-run path seeded its Sample
  Workspace. Additionally, `resetFixtureWorkspace` deleted the watched
  workspace/config directories themselves, and its `beforeTest` invocation
  before a spec file's FIRST test raced the freshly launched app's boot read
  of `workspaces.json` (same Sample Workspace outcome).
- **Fix:** cleanup moved to `onComplete` only (it runs once per run, on pass
  and fail paths; `afterSession` keeps `killSurvivingAppProcesses`). Reset
  now clears directory CONTENTS (never the watched directories) and skips the
  first call per worker — the app for a spec file launched after `onPrepare`
  seeded, so its first test already sees fresh state (D-12's reset is
  between-tests by definition).
- **Files modified:** e2e-native/wdio.conf.ts, e2e-native/helpers/fixtureWorkspace.ts
- **Verification:** full suite green twice in a row (standalone `wdio run`
  and `make test-e2e-native`, exit 0)
- **Committed in:** 8f43639

**4. [Rule 3 - Blocking] mocha timeout 60s → 120s**
- **Found during:** Task 2
- **Issue:** 60s was calibrated in 06-01 when the suite had one spec with ~7
  element commands; at ~10-15s per element command it measured 46-76s across
  runs — over the line on loaded machines.
- **Fix:** `mochaOpts.timeout: 120_000` with a comment naming the cause; the
  timeout still bounds a genuinely hung test.
- **Files modified:** e2e-native/wdio.conf.ts
- **Committed in:** 8f43639

---

**Total deviations:** 4 auto-fixed (1 Rule 1, 3 Rule 3)
**Impact on plan:** All fixes serve the plan's own truths and acceptance
criteria; no scope creep (no new surfaces, no helper API changes from the
planned exports).

## Issues Encountered

- A leftover app process survived the first timed-out run; killed manually.
  The config's `killSurvivingAppProcesses` covers normal teardown; a
  mocha-timeout teardown path may still leak — not reproduced after the
  fixes, noted for 06-05's hardening.
- Cross-spec-file fixture dirtiness (a file created by one spec visible to
  the next file's app) is not reset by design — D-12 scopes resets to
  between tests inside a file, and Phase 8/9 plans should add a
  launcher-side re-seed hook if they need per-file freshness.

## User Setup Required

None.

## Next Phase Readiness

- 06-03 (IME sub-spike) inherits: the runner, the command-economy spec
  pattern, and the `menuCommand` dispatcher registration point (bridge
  member already typed).
- 06-04's ship-isolation guard checks the single string
  `__MARU_NATIVE_E2E__` — the production-absence assertion in this plan is
  its prototype.
- Phase 8/9 attach to `readTerminalText` / `assertTerminalInk` directly.

---
*Phase: 06-native-e2e-runner-foundation*
*Completed: 2026-08-29*

## Self-Check: PASSED

- All five plan artifacts exist on disk (bridge, bridge test, registration in NativeTerminalView, ptyAssertions, pty.spec); SUMMARY.md written.
- All three commits found in git log: fdb9d33 (test/RED), b92a8d9 (feat/GREEN), 8f43639 (feat Task 2).
- Verify evidence: `pnpm test -- nativeE2eBridge` 212 files / 1954 tests green; `pnpm typecheck` + `pnpm lint` clean; production `dist/` free of the bridge string, native-e2e `dist/` contains it; `make test-e2e-native` exit 0 with both specs passing; both negative-control probes observed failing and reverted.
