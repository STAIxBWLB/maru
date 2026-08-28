# Phase 6: Native E2E Runner Foundation - Research

**Researched:** 2026-08-29
**Domain:** Native macOS WebDriver automation for a Tauri 2 desktop app (WKWebView, real PTY via `<canvas>`, IME composition, macOS menu bar); CI-viability spike design
**Confidence:** MEDIUM overall - HIGH on everything grounded in this repo's own code, MEDIUM on the WebdriverIO/Tauri embedded-provider mechanics (official docs read this session, not yet run against this repo), LOW on the one question the phase itself exists to answer: whether the embedded provider actually establishes an unattended session on hosted `macos-*` GitHub Actions runners. No source found this session resolves that LOW item - the phase's own spike is the only way to resolve it, exactly as CONTEXT.md assumes.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Spike verdict and CI-vs-local scope**
- **D-01:** The CI-viability verdict requires all three conditions to hold together: a WebDriver session establishes on a hosted macOS runner with no interactive permission prompt, real PTY output is readable through the canvas surface, and a full run completes with no human present. Any one of them failing settles the runner as local-only. A partial pass is not promoted to a CI gate.
- **D-02:** Failure is declared by failure type first, under a cap. An observed interactive or TCC permission prompt settles the verdict as local-only on the spot, with no further attempts. Every other failure class (build configuration, version mismatch, port conflict, missing dependency) is treated as fixable and retried within a fixed cap on macOS job runs. The cap and the observed failure class are both recorded, so a later re-attempt knows whether the wall was structural or incidental.
- **D-03:** The human-attended local gate is blocking in `make release-preflight` in both branches of the verdict, and a macOS CI job compiles and typechecks the runner code on every PR so the suite cannot rot between releases. The compile job does not execute the suite. Reversibility: costly.
- **D-04:** The verdict is recorded in two places: a dedicated native-runner document under `docs/` carrying how to run it, its scope, and its evidence, and an update to the `CI reality` constraint in `.planning/PROJECT.md`, which currently asserts that macOS-native changes ship unverified by CI. Phase 8 and Phase 9 plan their verification against those two, not against this CONTEXT.

**PTY and IME observation**
- **D-05:** Real PTY output is asserted two ways at once. A debug text mirror of the terminal screen grid asserts the output content exactly, and a shallow canvas readback ink check asserts the region was actually painted. Golden screenshot comparison is rejected: hosted-runner font rendering, `devicePixelRatio`, and theme differ from local. Reversibility: costly.
- **D-06:** The text mirror is exposed as a build-gated frontend debug global in the shape of `src/lib/e2eInvoke.ts`, wrapped in an `import.meta.env` condition so production bundles tree-shake it away. It reads the same grid the paint path reads, so it perturbs no app state. Driving the existing select-all plus clipboard user path is rejected. Reversibility: costly.
- **D-07:** The IME sub-spike judges two representative surfaces, not one: the terminal's hidden textarea (hand-written composition handling including the trailing-duplicate-syllable guard) and the rich editor (a ProseMirror-family surface handling composition its own way).
- **D-08:** If synthetic key events cannot substitute for real OS-level IME input, two things are left behind: a fixed human checklist for the real-IME behavior, and synthetic-composition regression tests kept inside the native runner so the app's own composition-handling logic stays guarded at the native level. The document records which of the two covers what.

**Native test seam and ship isolation**
- **D-09:** Each run seeds a fresh temporary directory with fixture files and points the app at it through an environment variable at launch, mirroring the existing `MARU_TEST_HOME` plus `tempfile::tempdir()` precedent in the Rust tests. The runner never opens the developer's real workspace, and no fixture workspace is committed to the repository. Reversibility: costly.
- **D-10:** Runner-only code is isolated two ways. It sits behind a default-off cargo feature so it is not compiled into release builds, and a static guard in the existing `scripts/check-*.mjs` family inspects the produced artifacts for the debug symbols and globals directly. A separate runner-only binary is rejected because it would break TEST-01's premise that the runner drives the application that actually ships. Reversibility: costly.
- **D-11:** The app's outbound dependencies stay unconfigured for the whole run. No credentials are seeded, and the updater and provider IO paths are left off.
- **D-12:** The app process is launched once per spec file, with the seed workspace reset between tests inside that file. Per-test relaunch is rejected (launch cost); a single launch for the whole run is rejected (state leakage across specs).

**Runner scope and downstream hand-off**
- **D-13:** Phase 6 leaves at least one living test on each of the four surfaces TEST-01 names: WKWebView DOM, a real PTY, IME input, and the macOS menu bar. Each is the minimum size that proves the surface can be driven at all.
- **D-14:** Phase 6 builds the runner skeleton and those four representative tests only. Phase 8's concurrency load test and Phase 9's SIGHUP test attach their own tests to this runner when those phases run.
- **D-15:** Native runner code lives in a top-level `e2e-native/` directory with its own make target, kept separate from `e2e/`, which stays Playwright-only. It must be added to the `tsconfig` and ESLint targets. Reversibility: costly.
- **D-16:** If the spike succeeds, the full native suite runs on pushes to `main` and on release tags, not on every PR. PRs get only the compile-and-typecheck job from D-03.

### Claude's Discretion

- The exact cap on macOS job runs for non-permission spike failures, provided the cap and the observed failure class are both recorded per D-02.
- The exact names of the environment variable, the debug global, the cargo feature, the guard script, and the make targets.
- The ink-check threshold and the sampled canvas region, provided the check fails on an unpainted terminal and does not depend on font rendering details.
- The composition of the seeded fixture workspace, provided it is created per run and never committed.
- The wdio configuration shape and the mechanics of the embedded provider setup.
- Which single flow represents each of the four surfaces in D-13.

### Deferred Ideas (OUT OF SCOPE)

None - the discussion stayed inside the Phase 6 boundary. Automating the manual macOS native UAT items from milestone v1.0 phases 04 and 05 was raised and rejected for this phase (growing the suite before the CI-viability verdict exists inverts the phase's own ordering). Available to a later phase once the verdict is recorded.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TEST-01 | A native runner drives the real application - WKWebView DOM, a real PTY, and IME input - against the real Rust backend rather than mocked IPC. Whether any part of it runs unattended in CI is decided by a spike that is the first slice of the owning phase. If the spike succeeds, the runner splits into a CI-gated subset plus a human-attended local gate for the macOS menu bar. If it fails, the runner is a single local target wired into `release-preflight`. | Standard Stack (the embedded-provider decision table and version pins), Architecture Patterns (spike sequencing, dual PTY assertion, native seam, per-spec-file launch), Common Pitfalls (16-20 plus two new in-repo findings on env-var override gating), Validation Architecture (maps each of the roadmap's 5 success criteria to a concrete observation and states which require a human) |

</phase_requirements>

## Summary

TEST-01's technical shape is settled by research; its CI-viability question is not, and cannot be without running the spike this phase opens with. `tauri-driver` has no macOS leg and never will (Apple ships no WebDriver for WKWebView) - that much is a clean, sourced NO `[CITED: v2.tauri.app/develop/tests/webdriver/ci/]`. The only real, free, macOS-capable alternative is `@wdio/tauri-service`'s **embedded** provider, backed by the `tauri-plugin-wdio-webdriver` Rust crate compiled into the app's own debug build - it runs a small WebDriver-compatible HTTP bridge *inside the WKWebView process*, so it needs no external driver binary, no signing, and (per the vendor's own docs) auto-detects on native macOS with "zero config" `[CITED: webdriver.io/docs/desktop-testing/tauri/platform-support/]`. What no source located this session demonstrates is that embedded provider actually completing an unattended session on a **hosted GitHub Actions macOS runner** - the vendor's own worked CI example builds on `macos-latest` and explicitly runs zero test steps there, doing the real WebdriverIO run only on the Linux leg `[CITED: webdriver.io/docs/desktop-testing/tauri/platform-support/, "No test step - just build verification"]`. That gap is not evidence the embedded provider fails on hosted macOS; it is evidence nobody's published example proves it succeeds either. This absence is itself the single most decision-relevant finding for this phase, matching SUMMARY.md's own framing.

Two additional findings this session adds beyond `.planning/research/*`, both read directly from this repo's Rust source and both change what D-09's fixture-seeding implementation has to do: the existing `MARU_TEST_HOME`/`MARU_TEST_CONFIG_DIR` precedent D-09 says to mirror is `#[cfg(test)]`-gated and has **zero effect on the real running app binary** the native runner launches - `test_config_dir_override()` returns `None` under `#[cfg(not(test))]` `[VERIFIED: src-tauri/src/vault_list.rs:179-182]`, and `maru_home_dir()` has no env override of any kind, ever, in any build `[VERIFIED: src-tauri/src/maru_dir.rs:158-161]`. A plan that assumes setting `MARU_TEST_HOME` before launching the real `.app` isolates it from the developer's real `~/.maru` and `workspaces.json` is wrong; the phase must add a new, feature-gated override to both functions, in the same cargo feature D-10 already introduces for the WebDriver plugin dependency.

On the observation side, D-05's two-assertion design has direct in-repo support: `gridRef.current.map(frameLineToText).join("\n")` already exists as the exact text-serialization the mirror should read `[VERIFIED: src/components/NativeTerminalView.tsx:1206]`, and `import.meta.env.DEV`-gated tree-shaking already has a working precedent one component away - `graphBridge.ts`'s bridge is "Active only when `import.meta.env.DEV`... Vite drops DEV-gated code from production builds" `[VERIFIED: src/components/graph/graphBridge.ts:1-4]`, wired at the call site with `import.meta.env.DEV && graphBridgeEnabled()` `[VERIFIED: src/components/graph/GraphCanvas.tsx:773]`. D-05's canvas ink check is a plain `getImageData` sample; the terminal canvas paints via `fillText`/`fillRect` 2D-context calls rather than `drawImage()` from an external source, so it is not subject to the CORS canvas-tainting restriction regardless of which origin Tauri's custom protocol serves the page from `[CITED: standard Canvas 2D security model - taint only arises from cross-origin `drawImage` sources, not from vector/text drawing calls]`.

**Primary recommendation:** Spend the phase's first slice proving or disproving the embedded provider on a hosted `macos-14`/`macos-15` runner before writing any other verification step as fact, following D-01/D-02's stop conditions exactly; design the fixture-seeding mechanism as a new feature-gated Rust override (not a reuse of the test-only env vars); build the text-mirror seam on the existing `frameLineToText`/`import.meta.env.DEV` precedents; and write `e2e-native/`'s own config from scratch rather than copying `playwright.config.ts`, since PITFALLS.md documents that config already omits `retries` despite configuring `trace: "on-first-retry"` and native automation's flake sources (focus stealing, first-launch Gatekeeper dialogs, leftover PTY/watcher processes) have no analogue in the mocked-IPC Chromium suite.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| WebDriver session establishment on macOS | New: native test harness (Node/WebdriverIO process) | Rust (embedded driver plugin compiled into the app) | The wdio process is the driver client; the embedded server it talks to runs inside the app's own WKWebView process - this is a two-sided new component, not an extension of an existing tier |
| Real PTY output observation | Browser/Client (canvas paint + text-mirror debug global) | Native test harness (executeScript + getImageData sampling) | The terminal already paints to `<canvas>` in the webview; the harness only reads it out via WebDriver's `executeScript`, it does not re-implement terminal rendering |
| IME composition proof | Browser/Client (existing composition handlers in `NativeTerminalView.tsx` and the ProseMirror-family editor) | Native test harness (dispatches key events, observes DOM composition state) | The app's own composition logic is what's under test; the harness is an external observer/driver, never a second implementation |
| Fixture workspace seeding | Rust core (`src-tauri`, new feature-gated env-var override) | Native test harness (writes the fixture tree before launch) | Workspace resolution is entirely Rust-side (`maru_home_dir()`, `app_config_dir()`, `workspace_registry_path()`); the harness can only seed files and set env vars, it cannot reach into the running process |
| Ship isolation (runner code never reaches production) | Rust core (default-off cargo feature) | Build tooling (`scripts/check-*.mjs` static guard) | D-10 explicitly assigns declaration to the Cargo manifest/feature and verification of the *produced artifact* to the existing static-guard family - two different tiers by design, not duplication |
| macOS menu bar automation | Human (local, Accessibility-permission-gated) | - | No unattended path exists on any tier for AXUIElement-based automation on a fresh/ephemeral runner; this stays outside all automated tiers per D-13/PITFALLS.md Pitfall 17 |
| CI-vs-local placement | CI/build tooling (`Makefile`, `.github/workflows/ci.yml`) | - | `verify-integration`/`release-preflight` precedent already exists at this tier; TEST-01 attaches beside it, not inside `make verify` |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@wdio/tauri-service` | `1.3.0` | WebdriverIO service; `embedded` driver provider by default, drives real WKWebView on macOS with no external binary | Only free, maintained macOS-capable WebDriver path for Tauri as of this session; MIT-licensed, published by the `webdriverio` GitHub org `[VERIFIED: npm view - published 3 weeks before this session, 37,298 weekly downloads]` |
| `webdriverio` | `9.31.4` | WebDriver protocol client / test runner core, dependency floor for the service | `npm view` confirms current `latest`, actively maintained (published within the last 2 days of this session) `[VERIFIED: npm view]` |
| `tauri-plugin-wdio-webdriver` | Not independently resolvable this session (crates.io lookup returned no reachable response in this sandbox; declared as a peer/companion crate by `@wdio/tauri-service`'s own docs) | The in-app embedded driver server, added as a Cargo `dev-dependencies`-only, feature-gated dependency so it never compiles into the release binary | `[CITED: webdriver.io/docs/desktop-testing/tauri/platform-support/ - "tauri-plugin-wdio-webdriver runs the embedded WebDriver server... required for the embedded provider"]`. **Pin the exact version at install time via `cargo add tauri-plugin-wdio-webdriver` inside the phase's own execution, not from this document** - crates.io was unreachable to this research session (curl returned no response; STACK.md's prior pass recorded `1.3.0` via `cargo search`/`cargo info`, one day earlier, but that number is not independently re-confirmed here) |
| `@wdio/cli`, `@wdio/mocha-framework`, `@wdio/spec-reporter` (or `@wdio/local-runner`) | Whatever `wdio config` scaffolds at install time | Standard WebdriverIO test-runner plumbing (test grouping, reporting) | Same org, same release train as `webdriverio`/`@wdio/tauri-service` - `npm view` confirms all three exist and are current `[VERIFIED: npm view]` |
| `tauri::test::mock_builder()` / `MockRuntime` (in-tree `tauri` crate, already a dependency) | Matches the pinned `tauri = "2.10.0"` | IPC command-handler contract tests with no webview at all - a cheap complement, not a substitute, for the WebDriver suite | `[CITED: docs.rs/tauri/latest/tauri/test/]`. Zero new dependency; runs on the existing `ubuntu-22.04` job |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node `child_process` env inheritance (no package) | n/a | Passing the D-09 fixture-seeding env var to the launched app | `@wdio/tauri-service`'s documented `tauri:options` capability shape only shows an `args` array for the launched binary, not an `env` key `[CITED: WebSearch summary of GitHub search results for "tauri:options" capabilities, cross-checked against the README excerpt fetched from github.com/webdriverio/desktop-mobile]`. The safer, unconfirmed-but-standard approach is setting the env var on the wdio Node process itself before it spawns the app (child processes inherit parent env by default) - **flag this for the spike to confirm directly**, do not assume it works from a config key that was not found in this session's sources |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@wdio/tauri-service` embedded provider | `@wdio/tauri-service` **official**/`external` provider (wraps `tauri-driver`) | No macOS support at all - Linux/Windows only, rejected outright for this phase's macOS-first scope `[CITED: webdriver.io/docs/desktop-testing/tauri/platform-support/ provider comparison table]` |
| `@wdio/tauri-service` embedded provider | CrabNebula `@crabnebula/tauri-driver` | Requires a paid `CN_API_KEY` specifically for macOS; the free embedded provider covers the same surface `[CITED: webdriver.io/docs/wdio-tauri-service/]` |
| A new native harness | AXUIElement / `axuielement` / AppleScript System Events | Only path that can reach the macOS menu bar at all, but needs an interactive one-time Accessibility grant no hosted runner has - reserved for the human-attended local gate only, never attempted in CI |
| A new native harness | XCTest/XCUITest against the bundled `.app` | No maintained Tauri integration exists; multi-week build-from-scratch cost for capability the embedded provider mostly already covers |

**Installation (indicative - re-verify exact versions live at plan/implementation time, per the version-verification protocol below):**
```bash
pnpm add -D @wdio/tauri-service webdriverio @wdio/cli @wdio/mocha-framework @wdio/spec-reporter
cd src-tauri && cargo add tauri-plugin-wdio-webdriver --optional
```

**Version verification:** `npm view @wdio/tauri-service version` and `npm view webdriverio version` were run live this session and returned `1.3.0` and `9.31.4` respectively, both current `latest`. `cargo search`/`cargo info tauri-plugin-wdio-webdriver` could not be independently re-run this session (the sandbox's plain `cargo` hangs without `--offline`, and a direct `curl` to `crates.io`'s API returned no response within the timeout) - re-run `cargo add tauri-plugin-wdio-webdriver` (which resolves live) as the phase's first concrete step and record the resolved version in the phase's implementation notes, not from this document.

## Package Legitimacy Audit

| Package | Registry | Age (latest version) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@wdio/tauri-service` | npm | 3 weeks (this session) | 37,298/wk | github.com/webdriverio/desktop-mobile | SUS (`too-new`) | Flagged - see note below |
| `webdriverio` | npm | ~2 days | 2,930,202/wk | github.com/webdriverio/webdriverio | SUS (`too-new`) | Flagged - see note below |
| `@wdio/cli` | npm | ~2 days | 1,398,410/wk | github.com/webdriverio/webdriverio | SUS (`too-new`) | Flagged - see note below |
| `@wdio/mocha-framework` | npm | ~8 days | 913,967/wk | github.com/webdriverio/webdriverio | SUS (`too-new`) | Flagged - see note below |
| `@wdio/spec-reporter` | npm | ~8 days | 1,037,517/wk | github.com/webdriverio/webdriverio | SUS (`too-new`) | Flagged - see note below |
| `@vitest/coverage-v8` | npm | ~11 days | 37,291,996/wk | github.com/vitest-dev/vitest | SUS (`too-new`) | Flagged - see note below (TEST-02, not this phase, listed for completeness since STACK.md recommends it) |
| `tauri-plugin-wdio-webdriver` | crates.io | Not resolvable this session | Not resolvable this session | (declared by vendor docs as the embedded-provider server crate) | Not checked - registry unreachable | **[ASSUMED]** - must be checked with `cargo search`/`cargo info` at implementation time before installing |

**Reading the SUS verdicts honestly:** every npm package above was flagged `SUS` solely for the `too-new` signal, which the legitimacy seam derives from the **latest published version's** date, not the package's actual age or trustworthiness. All five are published by the `webdriverio` GitHub organization (single shared monorepo/release train), carry seven-to-eight-figure weekly download counts, and are the identical packages STACK.md's prior research pass (2026-08-28, one day earlier) verified live against the same registries. This reads as an active, high-velocity release cadence on an established project, not slopsquatting - but per the package-legitimacy protocol, `SUS` still requires a `checkpoint:human-verify` task before installation, not a silent override. The planner must add that checkpoint before the `pnpm add` step for all six packages.

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `@wdio/tauri-service`, `webdriverio`, `@wdio/cli`, `@wdio/mocha-framework`, `@wdio/spec-reporter`, `@vitest/coverage-v8` - all six flagged solely on the `too-new` signal against otherwise strong download/repo signals; planner must gate each behind `checkpoint:human-verify`.

`tauri-plugin-wdio-webdriver` is `[ASSUMED]` in full - package name sourced from official WebdriverIO documentation (not WebSearch/training alone), but its existence and version were not independently confirmed against crates.io this session. Gate its install behind `checkpoint:human-verify` as well, and treat the "1.3.0, rust-version 1.77" figures anywhere they are repeated in this document (carried from STACK.md) as unverified-this-session.

## Architecture Patterns

### System Architecture Diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│ e2e-native/ (new, Node/WebdriverIO process - D-15)                    │
│                                                                       │
│  1. Seed fixture workspace: write files to a fresh tempdir            │
│  2. Set the D-09 env var(s) pointing the app at that tempdir           │
│  3. wdio launches the app binary once per spec file (D-12)             │
│         │ WebDriver protocol (HTTP, localhost)                        │
└─────────┼───────────────────────────────────────────────────────────┘
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Real Maru.app process (debug build, `wdio-embedded` cargo feature ON) │
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ tauri-plugin-wdio-webdriver: embedded WebDriver HTTP server     │  │
│  │   running *inside* the WKWebView process (D-10 gated compile)   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                          │ drives DOM / executeScript                │
│                          ▼                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ React 19 webview (unmodified app code)                          │  │
│  │  - NativeTerminalView.tsx: <canvas> paint + hidden <textarea>    │  │
│  │      IME composition handlers (real code path, not a mock)      │  │
│  │  - D-06 debug global: reads gridRef via frameLineToText,         │  │
│  │      import.meta.env.DEV-gated, tree-shaken from prod builds     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                          │ invoke() (real IPC, no mocking)            │
│                          ▼                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Rust core (src-tauri) - real backend, real PTY (portable-pty)   │  │
│  │  - D-09: new feature-gated env-var override on                  │  │
│  │      maru_home_dir() (maru_dir.rs:158) and                      │  │
│  │      app_config_dir()/test_config_dir_override()                │  │
│  │      (vault_list.rs:179-189) - the existing #[cfg(test)]         │  │
│  │      overrides do NOT reach this real binary                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
          │
          ▼ (assertion targets, D-05)
┌─────────────────────────────────────────────────────────────────────┐
│ Two independent PTY assertions, read via executeScript:               │
│  A. Text mirror (D-06 global) - exact content match                   │
│  B. Canvas ink check (getImageData sample) - "region was painted",    │
│     threshold-based, font/DPI-independent                             │
└─────────────────────────────────────────────────────────────────────┘

Separate, unmodified:
┌─────────────────────────────────────────────────────────────────────┐
│ e2e/*.spec.ts (Playwright, Chromium, mocked IPC via                   │
│ window.__MARU_E2E_INVOKE__ / src/lib/e2eInvoke.ts) - untouched        │
└─────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
e2e-native/
├── wdio.conf.ts               # own retry/flake policy (not copied from playwright.config.ts)
├── specs/
│   ├── webview.spec.ts        # D-13 surface 1: WKWebView DOM
│   ├── pty.spec.ts            # D-13 surface 2: real PTY (text mirror + ink check)
│   ├── ime.spec.ts            # D-13 surface 3: IME (terminal textarea + rich editor)
│   └── menu.spec.ts           # D-13 surface 4: macOS menu bar (human-attended only)
├── helpers/
│   ├── fixtureWorkspace.ts    # D-09: build + seed the per-run tempdir
│   └── ptyAssertions.ts       # D-05: text-mirror read + canvas ink-check sample
└── SPIKE.md or docs/native-e2e.md  # D-04: recorded verdict, scope, evidence (exact path is Claude's discretion within D-04's "a dedicated document under docs/")
```

### Pattern 1: The CI-viability spike, stop-condition-first (D-01/D-02)

**What:** Before writing any other part of the runner, stand up the minimum WebDriver session (launch the app, connect, run one trivial assertion) on a hosted `macos-14` or `macos-15` GitHub Actions runner, and classify the very first failure by D-02's rule: an interactive/TCC permission prompt ends the spike immediately as local-only; anything else (build config, version mismatch, port conflict, missing dependency) is retried up to a fixed cap.
**When to use:** First slice of the phase, before any spec beyond the trivial connectivity check is written.
**Example (illustrative shape, not a verified working config - the exact keys must be confirmed against the vendor docs live at implementation time):**
```typescript
// e2e-native/wdio.conf.ts (spike-phase skeleton)
export const config = {
  services: ["@wdio/tauri-service"], // driverProvider defaults to "embedded"
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: "./src-tauri/target/debug/maru",
        // args (documented): pass whatever the D-09 env-var mechanism needs
        // if the wdio process's own inherited env cannot reach the child -
        // confirm which path actually works during the spike itself, no
        // "env" key was found documented for tauri:options this session.
      },
    },
  ],
};
```
Source for the shape: `[CITED: github.com/webdriverio/desktop-mobile README excerpt fetched this session]`.

### Pattern 2: Dual PTY assertion (D-05)

**What:** Every PTY-observing spec asserts twice: the D-06 text-mirror global for exact content, and a canvas `getImageData` ink check for "something was actually painted."
**When to use:** Any spec touching `NativeTerminalView.tsx`.
**Example, grounded directly in the existing code the mirror must reuse:**
```typescript
// src/lib/e2eNativeInvoke.ts (illustrative name - D-06 leaves the exact
// name to Claude's discretion) - shape mirrors src/lib/e2eInvoke.ts's
// runtime-inert precedent, but tree-shaken at build time instead of
// runtime-inert, per D-06's explicit "wrapped in an import.meta.env
// condition" requirement.
if (import.meta.env.DEV) {
  // precedent: import.meta.env.DEV && graphBridgeEnabled()
  // (src/components/graph/GraphCanvas.tsx:773)
  window.__MARU_NATIVE_TERMINAL_TEXT__ = (sessionId: string) =>
    // reuses the exact serialization NativeTerminalView.tsx already does
    // at line 1206: gridRef.current.map(frameLineToText).join("\n")
    getTerminalGridText(sessionId);
}
```
```typescript
// e2e-native/helpers/ptyAssertions.ts (wdio side)
async function inkCheck(canvasSelector: string, region: { x: number; y: number; w: number; h: number }) {
  return browser.executeScript(
    (sel: string, r: typeof region) => {
      const canvas = document.querySelector(sel) as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      // fillText/fillRect drawing never taints the canvas - taint only
      // arises from cross-origin drawImage() sources (standard Canvas 2D
      // security model) - safe to read back regardless of protocol origin.
      const data = ctx.getImageData(r.x, r.y, r.w, r.h).data;
      let nonBackgroundPixels = 0;
      for (let i = 0; i < data.length; i += 4) {
        // compare against the known terminal background color; count
        // pixels that differ beyond a small tolerance
      }
      return nonBackgroundPixels; // threshold decided by the phase plan
    },
    [canvasSelector, region],
  );
}
```

### Pattern 3: Ship-isolation, declared and verified separately (D-10)

**What:** A default-off Cargo feature gates the WebDriver plugin dependency; a static guard (joining the `scripts/check-*.mjs` family) inspects the *built artifact* for the debug global/symbols, independent of the feature declaration.
**When to use:** Every runner-only addition to `src-tauri/Cargo.toml` and to the frontend debug global.
**Example, following the existing guard shape verified in this repo:**
```javascript
// scripts/check-native-e2e-isolation.mjs (illustrative name)
// Shape follows scripts/check-select-chrome.mjs and scripts/check-bundle-budget.mjs:
// read the PRODUCED artifact, fail loudly if a ship-isolation invariant breaks.
import { readFileSync, readdirSync } from "node:fs";
// ... assert the release dist/assets/*.js bundle does NOT contain the
// D-06 global's string (e.g. "__MARU_NATIVE_TERMINAL_TEXT__"), the same
// principle check-bundle-budget.mjs already applies to lazy-chunk membership.
```
`[VERIFIED: scripts/check-select-chrome.mjs:1-20, scripts/check-bundle-budget.mjs:1-30 - both read the produced artifact directly rather than the source, matching D-10's stated principle]`.

### Pattern 4: Per-spec-file app launch (D-12)

**What:** Configure the wdio runner so each spec file gets its own app launch, with the D-09 fixture workspace reset between individual tests inside that file (not a fresh launch per test, not one launch for the whole run).
**When to use:** `e2e-native/wdio.conf.ts` `maxInstances`/spec-grouping configuration - exact mechanism TBD at implementation time (the vendor docs excerpt fetched this session did not show a worked multi-spec-file lifecycle example; this is an **[ASSUMED]** mechanism, confirm during the spike).

### Anti-Patterns to Avoid

- **Reusing `playwright.config.ts`'s retry/trace settings for `e2e-native/`:** that config already has a known-broken combination (`trace: "on-first-retry"` with `retries` unset, so `on-first-retry` never fires) and assumes headless-friendly, no-OS-chrome, no-permission-prompt conditions that do not hold for driving a real signed/unsigned macOS `.app` `[CITED: PITFALLS.md Pitfall 20, cross-referenced against the live `playwright.config.ts` read this session]`.
- **Assuming `MARU_TEST_HOME`/`MARU_TEST_CONFIG_DIR` isolate the real app binary:** both are `#[cfg(test)]`-only; the actual launched `.app` ignores them entirely `[VERIFIED: src-tauri/src/vault_list.rs:179-182, src-tauri/src/maru_dir.rs:158-161]`.
- **Treating the four D-13 surfaces as equally-scoped:** WKWebView driving is categorically the highest-uncertainty item (needs the spike); PTY/IME are Rust-side/DOM-side and lower-risk; the menu bar is definitionally out of CI reach regardless of driver choice `[CITED: PITFALLS.md Pitfall 16]`.
- **Validating the harness only against a local unsigned `cargo tauri dev`/debug build and calling TEST-01 done:** the release-signed, notarized, hardened-runtime `.app` restricts debugger/injection mechanisms a dev build does not, so re-verify at least once per release cycle against the actual `release-bundles.yml` artifact `[CITED: PITFALLS.md Pitfall 18]`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Driving a real WKWebView from an external process | A custom Accessibility-API or private-framework automation bridge | `@wdio/tauri-service`'s embedded provider (`tauri-plugin-wdio-webdriver`) | It is the maintained, org-owned successor to exactly this idea; community forks (`danielraffel/tauri-webdriver`, `Choochmeque/tauri-webdriver`) predate it and should not be used now that the official package exists `[CITED: STACK.md, cross-checked this session against the current npm listing which shows the same `webdriverio/desktop-mobile` org repo]` |
| IPC command-handler contract testing without a webview | A new mock harness around `#[tauri::command]` handlers | `tauri::test::mock_builder()`/`MockRuntime` (already ships with the pinned `tauri` crate) | Zero new dependency, runs on the existing `ubuntu-22.04` job, official first-party mechanism `[CITED: docs.rs/tauri/latest/tauri/test/]` |
| Verifying a fresh Tauri release-signed/notarized `.app` opens without Gatekeeper friction | Custom `codesign`/`spctl` scripting inside the runner | The existing `release-bundles.yml` notarize/staple/`spctl -a -vv -t open` step, already proven in this repo | `[VERIFIED: .github/workflows/release-bundles.yml - the "Build, notarize, staple, and upload macOS disk image" step already runs `xcrun notarytool submit`, `stapler staple/validate`, and `spctl -a -vv -t open`]` - don't duplicate this; TEST-01 targets debug builds, this precedent only needs citing so the phase doesn't reinvent it if the spike ever needs to test against a signed artifact |
| Ship-isolation verification | A new lint/allowlist framework | One more member of the existing `scripts/check-*.mjs` family, wired into `verify` | Matches D-10's own explicit instruction and the existing `check-bundle-budget.mjs`/`check-select-chrome.mjs` precedent exactly |

**Key insight:** every mechanism this phase needs already has either an official first-party tool (`tauri::test`, the embedded WebDriver provider) or a proven in-repo pattern (`check-*.mjs`, `MARU_TEST_HOME`-style env isolation, `import.meta.env.DEV` tree-shaking) to extend. The phase's actual novel work is wiring, not invention - except for the one Rust-side gap this session found (no runtime env override exists yet for the real binary's workspace/config paths), which is genuinely new code, not a reuse.

## Common Pitfalls

### Pitfall 1 (repo-specific, new this session): the `MARU_TEST_HOME`/`MARU_TEST_CONFIG_DIR` precedent D-09 names does not reach the real app binary

**What goes wrong:** A plan that reads D-09 as "mirror `MARU_TEST_HOME`" and implements it by setting that env var before launching the native runner's `.app` process will silently fail to isolate anything - the real binary calls `maru_home_dir()`, which unconditionally resolves to `dirs::home_dir().join(".maru")` with no override path at all, and `app_config_dir()`, whose override (`test_config_dir_override()`) is compiled out entirely under `#[cfg(not(test))]`.
**Why it happens:** The existing isolation mechanism was built for `cargo test`, where `#[cfg(test)]` is always active; nobody has needed a runtime (non-test-harness) override before because nothing outside `cargo test` has needed to run the app against a throwaway home/config directory.
**How to avoid:** Add a new override, gated by the same D-10 cargo feature (not `#[cfg(test)]`), to both `maru_home_dir()` (`src-tauri/src/maru_dir.rs:158`) and the `app_config_dir()`/`test_config_dir_override()` pair (`src-tauri/src/vault_list.rs:174-189`). Decide during planning whether one new env var covers both paths or two are needed - `maru_home_dir()` governs `~/.maru/settings.json` (global preferences) while `app_config_dir()` governs `<config>/com.maru.app/workspaces.json` (the workspace registry); D-09's "seeded fixture workspace" almost certainly needs both isolated together, since the app must both find no stale global settings and register/open the seeded workspace from a clean registry.
**Warning signs:** A native spec run that touches files under the real `~/.maru/` or the real OS config directory instead of the seeded tempdir; a first-run flow (workspace picker) appearing when the spec expected an already-open seeded workspace.
**Phase to address:** This phase, as part of D-09/D-10's implementation - not discoverable by reading CONTEXT.md alone, only by reading the actual override functions.

### Pitfall 2 (repo-specific, new this session): `maru_home_dir()` has literally no override, unlike `app_config_dir()`

**What goes wrong:** Even after fixing Pitfall 1's `#[cfg(test)]` gating problem for `app_config_dir()`, `maru_home_dir()` (`src-tauri/src/maru_dir.rs:158-161`) has no branch to add an override *to* - it is a plain three-line function with no existing conditional structure, unlike `app_config_dir()` which already has the `test_config_dir_override()` indirection ready to extend.
**Why it happens:** Global settings (`~/.maru/settings.json`) were apparently never expected to need isolation outside `cargo test`'s own separate test helpers (which likely stub this path differently, or accept touching the real file in narrow scenarios - re-check `#[cfg(test)]` call sites of `maru_home_dir()` specifically during planning).
**How to avoid:** Restructure `maru_home_dir()` to the same indirection shape `app_config_dir()` already uses (a small override-check function that this phase's new feature can populate), rather than special-casing the call site.
**Warning signs:** A spec-level test that appears to isolate the config dir correctly but still reads/writes real global UI-mode/theme settings from the developer's actual `~/.maru/settings.json`.
**Phase to address:** This phase.

### Pitfall 3 (WKWebView driver, MEDIUM confidence): there is no first-party WebDriver for WKWebView - do not assume the Windows/Linux pattern ports

`[CITED: PITFALLS.md Pitfall 16, independently corroborated this session via v2.tauri.app/develop/tests/webdriver/ci/ and webdriver.io/docs/desktop-testing/tauri/platform-support/'s provider table, which lists macOS as `embedded`/`crabnebula` only, never `official`/`external`]`. A plan for TEST-01 that treats WKWebView, PTY, IME, and menu bar as four equally-scoped, equally-risky sub-items is the warning sign this wasn't separately researched.

### Pitfall 4 (TCC/Accessibility, MEDIUM confidence): permission grants cannot be scripted by an unattended runner - but this applies specifically to Accessibility-API automation, not necessarily to the embedded webview driver

`[CITED: PITFALLS.md Pitfall 17]`. This session's reading refines the scope slightly: the embedded provider drives the DOM/JS/canvas *inside* the WKWebView process and, per its own vendor docs, does not describe itself as requiring the Accessibility permission the way AXUIElement-based menu-bar automation does. Nothing found this session confirms the embedded provider is TCC-free on a hosted runner either - that is exactly the open question the spike answers. Do not treat "the vendor doesn't mention TCC" as evidence it's absent; treat it as unconfirmed.

### Pitfall 5 (signed-vs-debug divergence, MEDIUM confidence): a hardened-runtime notarized `.app` is a different automation target than a debug build

`[CITED: PITFALLS.md Pitfall 18]`. Re-verify against the real `release-bundles.yml`-produced artifact at least once per release cycle once the runner exists; do not let "ran locally via `tauri dev`" stand in for that.

### Pitfall 6 (synthetic IME, MEDIUM confidence): synthetic key events never exercise real OS-level IME composition

`[CITED: PITFALLS.md Pitfall 19]`. Directly relevant to D-07/D-08: verify explicitly, early, whether whatever mechanism the embedded provider/wdio use to send keys can trigger real `compositionstart`/`compositionupdate`/`compositionend` against a known Hangul-composition case (typing 안녕 requires multiple raw keystrokes composed into two syllables) before trusting any IME-labeled spec. `NativeTerminalView.tsx`'s own composition handling (`isTrailingCompositionDuplicate`, `COMPOSITION_TRAILING_MS = 100`, `[VERIFIED: src/components/NativeTerminalView.tsx:135-136]`) is specifically the kind of timing-sensitive logic a synthetic-only event stream may never actually exercise as a real IME engine would.

### Pitfall 7 (flake sources, HIGH confidence given the direct config comparison): native automation flake has no analogue in the mocked-IPC suite

`[CITED: PITFALLS.md Pitfall 20, VERIFIED against the live playwright.config.ts read this session - trace: { mode: "retain-on-failure", snapshots: false, screenshots: false } with no retries key set anywhere in the file]`. Window/focus stealing, first-launch Gatekeeper dialogs on a freshly built artifact, screen lock during a long local run, and leftover PTY/watcher/child processes from a previous crashed run are all real risks with no counterpart in the 23 Chromium specs. Write `e2e-native/wdio.conf.ts`'s retry/cleanup policy from scratch.

### Pitfall 8 (this session, MEDIUM confidence, environment-passing gap): no documented `env` key for `tauri:options`

Every fetched capabilities example this session showed only `application` and `args`; none showed an `env` field for passing environment variables to the launched app process `[CITED: WebSearch aggregate + github.com/webdriverio/desktop-mobile README excerpt fetched this session]`. D-09's "points the app at it through an environment variable at launch" may need to rely on the wdio Node process's own inherited environment (setting the var before the service spawns the child) rather than a config key - confirm this mechanism works during the spike itself, before D-09's implementation is written into the phase plan as settled.

## Code Examples

### Existing text-serialization the D-06 mirror should reuse verbatim

```typescript
// src/components/NativeTerminalView.tsx:238-243
export function frameLineToText(line: TerminalCell[]): string {
  return line
    .filter((cell) => cell.width !== 0)
    .map((cell) => cell.ch || " ")
    .join("")
    .replace(/\s+$/u, "");
}
```
`[VERIFIED: src/components/NativeTerminalView.tsx:238-243]` - and the whole-grid call site the mirror should copy the shape of:
```typescript
// src/components/NativeTerminalView.tsx:1204-1206 (inside selectAll)
allSelectionTextRef.current =
  text ?? gridRef.current.map(frameLineToText).join("\n");
```
`[VERIFIED: src/components/NativeTerminalView.tsx:1204-1206]`

### Existing `import.meta.env.DEV` tree-shaking precedent D-06 should follow

```typescript
// src/components/graph/graphBridge.ts:1-4
// Development-only observational bridge for real-Sigma e2e (replaces the old
// fake DOM overlay). Active only when import.meta.env.DEV AND
// localStorage["maru:e2e:graph-bridge"] === "1" — Vite drops DEV-gated code
// from production builds, and the flag keeps it off in normal dev sessions.
```
```typescript
// src/components/graph/GraphCanvas.tsx:773
const bridgeEnabled = import.meta.env.DEV && graphBridgeEnabled();
```
`[VERIFIED: src/components/graph/graphBridge.ts:1-4, src/components/graph/GraphCanvas.tsx:773]`

### Existing `#[cfg(test)]`-only override that D-09 must NOT assume reaches the real binary

```rust
// src-tauri/src/vault_list.rs:174-189
#[cfg(test)]
fn test_config_dir_override() -> Option<PathBuf> {
    std::env::var_os("MARU_TEST_CONFIG_DIR").map(PathBuf::from)
}

#[cfg(not(test))]
fn test_config_dir_override() -> Option<PathBuf> {
    None
}

fn app_config_dir() -> Result<PathBuf, String> {
    if let Some(dir) = test_config_dir_override() {
        return Ok(dir);
    }
    dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())
}
```
```rust
// src-tauri/src/maru_dir.rs:158-161 (no override at all, in any build)
fn maru_home_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".maru"))
        .ok_or_else(|| "Could not determine home directory for ~/.maru".to_string())
}
```
`[VERIFIED: src-tauri/src/vault_list.rs:174-189, src-tauri/src/maru_dir.rs:158-161]`

### Existing static-guard shape the D-10 ship-isolation check should join

```javascript
// scripts/check-bundle-budget.mjs:1-13 (reads the PRODUCED artifact, not source)
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const assetsDir = new URL("../dist/assets/", import.meta.url);
const files = readdirSync(assetsDir);
// ... asserts against dist/assets/*.js content, throws on violation
```
`[VERIFIED: scripts/check-bundle-budget.mjs:1-13]`

### Existing local-only-gate precedent (Makefile) TEST-01 attaches beside

```makefile
# Makefile:216-223
# Deliberately NOT part of `verify`: this depends on which AI CLIs are installed
# and whether their tokens are live, and a merge gate that fails on an expired
# token is a gate people learn to bypass. Run it when touching provider.rs,
# skill_host/dispatch.rs, agent_host/status.rs or terminal/mod.rs.
.PHONY: verify-integration
verify-integration: $(ICON_PATH) ## Smoke the real installed AI CLIs...
	cd $(TAURI_DIR) && MARU_CLI_SMOKE=1 \
		$(CARGO) test --lib cli_backends_real_smoke -- --ignored --nocapture --test-threads=1
```
```makefile
# Makefile:267-271
.PHONY: release-preflight
release-preflight: ## Complete local release preflight: core checks, release CLI smoke, and e2e
	$(MAKE) release-preflight-core
	$(MAKE) cli-smoke
	$(MAKE) test-e2e
```
`[VERIFIED: Makefile:216-223, Makefile:262-271]` - D-03's blocking-local-gate and D-15's own make target join this chain the same way.

### Minimal WebdriverIO + Tauri capabilities shape (vendor-documented, unverified against this repo)

```typescript
// From the official README - not yet run against this repo's build
export const config = {
  services: ["@wdio/tauri-service"],
  capabilities: [{
    browserName: "tauri",
    "tauri:options": {
      application: "./src-tauri/target/release/my-app.exe",
    },
  }],
};
```
`[CITED: github.com/webdriverio/desktop-mobile README, webdriver.io/docs/wdio-tauri-service/]`

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| No free unattended macOS WebDriver path for Tauri existed (community forks only, `danielraffel/tauri-webdriver`, `Choochmeque/tauri-webdriver`) | `@wdio/tauri-service`'s official `embedded` provider (`tauri-plugin-wdio-webdriver`) | Published ~3 weeks before this session (per `npm view`), superseding the community forks as the maintained path | This is exactly why STACK.md's MEDIUM confidence and this document's LOW confidence on the CI-unattended question both stand: the tool is new enough that no public repository has yet published a working hosted-macOS-CI proof, and the vendor's own worked CI example does not attempt one either |

**Deprecated/outdated:** the `official`/`external` `driverProvider` alias for `tauri-driver`-wrapping usage is itself marked deprecated by the vendor docs in favor of `'external'` `[CITED: webdriver.io/docs/wdio-tauri-service/]` - irrelevant to macOS either way since that provider never supported it.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `tauri-plugin-wdio-webdriver` exists on crates.io at a legitimate, current version (carried from STACK.md's prior-day `cargo search`/`cargo info`, not independently re-confirmed this session because `cargo` requires `--offline` in this sandbox and a direct `curl` to the crates.io API returned no response) | Standard Stack, Package Legitimacy Audit | If the crate name or version has changed, the phase's first `cargo add` step fails immediately and visibly - low blast radius, but must be the actual first action taken, not assumed from this document |
| A2 | `tauri:options` in wdio capabilities has no `env` key; the fixture-seeding env var (D-09) must instead rely on inheriting the wdio Node process's own environment | Standard Stack (Supporting), Common Pitfalls #8, Architecture Pattern 1 | If wrong (a real `env` key exists but wasn't surfaced by this session's sources), the phase may build a more roundabout env-passing mechanism than necessary - low risk, easy to discover and correct once the spike's actual config is written against live docs |
| A3 | The embedded provider does not require the macOS Accessibility/TCC permission the way AXUIElement-based automation does, because it operates entirely inside the WKWebView process | Common Pitfalls #4 | This is the central open question the phase's spike exists to answer - if wrong, the spike returns "local-only" per D-01/D-02, which is an accepted, planned-for branch, not a plan failure |
| A4 | Canvas `getImageData` reads are unaffected by cross-origin taint for this app's terminal canvas, because it is painted via `fillText`/`fillRect` rather than `drawImage()` from an external source | Common Pitfalls (implicit in Pattern 2), Code Examples | Low risk - this is standard, stable Canvas 2D security model behavior, not Tauri-specific; if somehow wrong, the ink check would throw a `SecurityError` immediately and loudly during the spike, not fail silently |
| A5 | wdio's per-spec-file launch/multi-instance lifecycle (D-12) has a documented configuration mechanism reachable without a custom runner script | Architecture Pattern 4 | If no such config exists, the phase needs a thin custom launch/teardown wrapper around each spec file - moderate implementation cost, no architectural risk, discoverable early in the spike |

**None of these are compliance, retention, or performance-target claims** - all are technical/mechanical and self-revealing on first attempt (a wrong package name fails `cargo add`; a wrong env mechanism fails the first fixture-read assertion).

## Open Questions (RESOLVED at plan time - answered by this phase's own spike and by plan 06-01)

**Disposition, recorded 2026-08-29 when the phase plans were written.** None of the three is
left hanging for a later phase; each has a named home in the plan set.

- **Q1 is structurally answerable only by running the spike**, which is what D-01/D-02 already
  scope and what plan 06-01 Task 3 executes on a hosted `macos-14` runner under a cap of 3
  runs. Every plan's `<flagged_assumptions>` block records that TEST-01's edge stays
  `unresolved` until that spike returns, and plan 06-05 Task 3 ratifies the answer. No source
  could have closed this one; the phase exists to close it.
- **Q2 (the crate's real version and `rust-version`) is answered operationally** by plan 06-01
  Task 1, whose blocking-human checkpoint resolves `tauri-plugin-wdio-webdriver` live against
  crates.io as the phase's literal first action and records the resolved values. A wrong crate
  name fails there, before any npm install.
- **Q3 (whether `tauri:options` can pass environment variables)** is answered operationally by
  plan 06-01 Task 2, which implements the inherited-`process.env` path this document
  recommends and instructs the executor to prefer a real `env` key and record the correction
  if the spike shows one exists.

1. **Does the embedded WebDriver session establish on a hosted `macos-14`/`macos-15` GitHub Actions runner with no interactive permission prompt?**
   - What we know: `tauri-driver` definitively cannot (no macOS support, ever). The embedded provider *can* drive a real WKWebView locally on macOS with "zero config" per vendor docs. No source located this session shows it running unattended in a hosted CI environment - the vendor's own CI example explicitly skips the test step on its `macos-latest` leg.
   - What's unclear: whether the embedded provider needs any permission grant at all in a fresh, ephemeral runner VM, and whether the debug-build/no-signing path changes that.
   - Recommendation: this is D-01/D-02's spike, exactly as scoped. Do not write any downstream verification step (Phase 8, Phase 9) assuming an answer either way until the spike returns one.

2. **What is the actual current version of `tauri-plugin-wdio-webdriver` on crates.io, and does its `rust-version` requirement stay under the pinned `1.98.0` toolchain?**
   - What we know: STACK.md recorded `1.3.0`/`rust-version = "1.77"` one day before this session, matching this repo's `rust-version = "1.77.2"` in `Cargo.toml`.
   - What's unclear: not independently re-confirmed this session (crates.io network access unavailable to this research pass).
   - Recommendation: `cargo add tauri-plugin-wdio-webdriver --optional` as the first concrete implementation action; record the resolved version.

3. **Does `wdio.conf.ts`'s `tauri:options` (or the service's own hooks, e.g. `onPrepare`/`beforeSession`) expose a documented way to pass environment variables to the launched app process, or must this rely on the wdio Node process's own inherited env?**
   - What we know: no `env` key appeared in any fetched capabilities example this session; `args` is documented.
   - What's unclear: whether an undocumented or differently-named mechanism exists.
   - Recommendation: confirm directly against the live `@wdio/tauri-service` config reference at implementation time (`packages/tauri-service/docs/configuration.md` in the vendor repo, not fully fetched this session) before finalizing D-09's mechanism.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| A hosted `macos-14`/`macos-15` GitHub Actions runner | The CI-viability spike itself (D-01) | Not checkable from this sandbox; `.github/workflows/release-bundles.yml` already runs a `macos-latest` matrix leg successfully in this repo's own CI, so runner *availability* is proven, session-viability is not | `macos-latest` (currently maps to a recent macOS version per GitHub's own rolling alias) confirmed usable in this repo `[VERIFIED: .github/workflows/release-bundles.yml matrix.platform: macos-latest]` | None needed - this is what the spike tests, not a dependency to work around |
| `pnpm`, `Node 22.22.3`, pinned Rust toolchain `1.98.0` | Building the debug app + running wdio | Already proven in this repo's own CI (`ci.yml`, `release-bundles.yml`) | pnpm 9.15.0, Node 22.22.3, rustc 1.98.0 `[VERIFIED: .github/workflows/ci.yml, .github/workflows/release-bundles.yml, rust-toolchain.toml]` | None needed |
| Local macOS machine with the app already built for the human-attended fallback path | D-03's blocking `release-preflight` gate, D-13's menu-bar test regardless of spike outcome | Not checkable from this sandbox (this is a human/local requirement, always true when the local gate actually runs) | n/a | n/a - by design this stays a human-run step |
| crates.io / npm registry reachability from within a build/test environment | Installing `tauri-plugin-wdio-webdriver`, `@wdio/tauri-service`, etc. | npm confirmed reachable and working this session; crates.io was unreachable via `curl` from this specific research sandbox (unrelated to whether the phase's actual CI/dev environment can reach it - CI already fetches crates via `cargo build` successfully today) | n/a | None needed - this session's specific network restriction is not expected to affect the phase's actual implementation environment |

**Missing dependencies with no fallback:** none identified - every dependency this phase needs is already provable as reachable from this repo's existing CI, except the one question (unattended macOS CI-viability) that is the phase's own subject matter, not an environment gap.

**Missing dependencies with fallback:** none beyond the spike's own two-branch design (D-01: CI-gated subset, or D-02/D-03: local-only fallback), which is already the phase's stated contract.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework (new) | WebdriverIO (`@wdio/tauri-service`, embedded provider) - `e2e-native/` |
| Framework (existing, reused as-is) | Playwright (`e2e/`), Vitest (`src/`, `scripts/`), `cargo test` (`src-tauri/`) - all unmodified by this phase |
| Config file (new) | `e2e-native/wdio.conf.ts` - written from scratch (Pitfall 7), not derived from `playwright.config.ts` |
| Quick run command (new) | A new `make` target, e.g. `make test-e2e-native` (exact name: Claude's discretion per CONTEXT.md), wired into `release-preflight` per D-03 |
| Full suite command | Same target; D-16 gates *when* it runs (main/tag pushes only if the spike succeeds), not what it runs |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEST-01 (roadmap criterion 1) | CI-viability spike produces a definitive answer on session establishment with no permission prompt | CI job run (`workflow_dispatch` or a dedicated PR-triggered macOS leg during the spike) | The spike's own CI job, e.g. `pnpm exec wdio run e2e-native/wdio.conf.ts` on a `macos-14` runner - not yet written | ❌ Wave 0 (this is the phase's first deliverable) |
| TEST-01 (roadmap criterion 2) | Real PTY output readable via canvas-based pixel assertion | Native e2e (WebDriver) | `e2e-native/specs/pty.spec.ts` (text mirror + ink check, Pattern 2) | ❌ Wave 0 |
| TEST-01 (roadmap criterion 3) | Full run of the proven-out subset completes with no human present (CI branch) OR exactly one local-only target exists wired into `release-preflight` (local branch) | Both branches are automated-command-observable, but which branch is "true" is itself the spike's output, not presupposable | CI branch: the new macOS CI job's own green/red status. Local branch: `make release-preflight`'s exit code, run by a human | ❌ Wave 0 for either branch |
| TEST-01 (roadmap criterion 4) | IME sub-spike shows whether synthetic key events substitute for real IME, on both the terminal textarea and the rich editor | Native e2e (WebDriver) attempting synthetic composition, cross-checked against a human-observed real-IME run | `e2e-native/specs/ime.spec.ts` for the automated half; a human checklist item for the real-IME half (D-08's fallback) | ❌ Wave 0 |
| TEST-01 (roadmap criterion 5) | CI-vs-local scope recorded as a settled fact Phase 8/9 build against | Documentation, not a test | D-04's `docs/` native-runner document + the `PROJECT.md` "CI reality" constraint update | ❌ Wave 0 (the document itself doesn't exist yet) |

### Sampling Rate

- **Per task commit (during phase implementation):** the spike's own CI run per attempt, capped per D-02; local `cargo build`/`pnpm typecheck` on the runner code between attempts.
- **Per wave merge:** the D-03 macOS compile-and-typecheck CI job (every PR, once it exists) plus, if the spike succeeded, the gated full-suite job on the branches D-16 specifies.
- **Phase gate:** `make release-preflight` (human-run, blocking per D-03) plus the recorded D-04 verdict document, before the phase is considered complete.

### Wave 0 Gaps

- [ ] `e2e-native/wdio.conf.ts` - the runner config itself, does not exist
- [ ] `e2e-native/specs/*.spec.ts` - all four D-13 surface specs, do not exist
- [ ] `e2e-native/helpers/fixtureWorkspace.ts` - D-09's seeding helper, does not exist
- [ ] `e2e-native/helpers/ptyAssertions.ts` - D-05's dual-assertion helper, does not exist
- [ ] `scripts/check-native-e2e-isolation.mjs` (or equivalent name) - D-10's static guard, does not exist
- [ ] New cargo feature in `src-tauri/Cargo.toml` gating `tauri-plugin-wdio-webdriver` - does not exist
- [ ] New env-var override on `maru_home_dir()` and `app_config_dir()`/`test_config_dir_override()` - does not exist (Pitfalls 1-2 above); this is the one genuinely new piece of Rust logic the phase must write, not just wire
- [ ] `tsconfig.e2e-native.json` (or similarly named) registered in the root `tsconfig.json` references array and `eslint.config.js`'s `files` list, per D-15 - does not exist; follow the existing `tsconfig.e2e.json` shape (`target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `include: ["e2e-native"]`) `[VERIFIED: tsconfig.e2e.json:1-16]`
- [ ] `docs/`-tier native-runner document (D-04) - does not exist
- Framework install: `pnpm add -D @wdio/tauri-service webdriverio @wdio/cli @wdio/mocha-framework @wdio/spec-reporter` and `cargo add tauri-plugin-wdio-webdriver --optional`, both gated behind `checkpoint:human-verify` per the Package Legitimacy Audit above

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | The runner explicitly runs the app unconfigured (D-11) - no credentials exist to authenticate |
| V3 Session Management | No | No user session surface is exercised; D-11 keeps provider IO and the updater off |
| V4 Access Control | No | No multi-user/permission surface is exercised by this phase's own runner code |
| V5 Input Validation | Marginal | The D-09 fixture-workspace path itself must be validated as a real, contained temp directory - reuse `crate::paths::ensure_within`/`require_absolute`, the project's own canonical helpers (`.planning/PROJECT.md` "Path containment is lexical" constraint), rather than a bespoke check |
| V6 Cryptography | No | Nothing in this phase touches signing/notarization secrets - those stay scoped to `release-bundles.yml` per its own existing `APPLE_SIGNING_IDENTITY`/`TAURI_SIGNING_PRIVATE_KEY` handling, unmodified here |

### Known Threat Patterns for this phase's surface

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A CI-only debug global (D-06) leaking into a production/release bundle, becoming an unintended attack surface (arbitrary terminal-screen-content read) | Information Disclosure | D-10's two-layer isolation: the cargo feature keeps the WebDriver plugin out of release builds, and the static artifact guard (Pattern 3) independently verifies the frontend global string is absent from the shipped JS bundle - "declaring the intent and checking the output are different acts" per D-10's own stated rationale |
| A fixture workspace path escaping its tempdir via a crafted seed value (low risk, but the mechanism is new code) | Tampering | Route the D-09 seeding helper's writes through `crate::paths::ensure_within`/`require_absolute` rather than raw `fs::write` with a caller-supplied path |
| A leaked env var or seeded fixture accidentally pointing the real launched app at the developer's actual `~/.maru` or vault, if the new Pitfall-1/2 override is implemented incorrectly | Tampering / accidental data loss | The override must fail closed (refuse to launch / error loudly) if the expected env var is absent while the gating cargo feature is active, rather than silently falling back to the real home directory |

**Phase to address:** SEC-02 (the `dangerouslySetInnerHTML` guard) is a separate, unrelated Phase 7 requirement and out of scope here; this phase's own security surface is narrow and covered above.

## Sources

### Primary (HIGH confidence)
- This repo, read directly this session: `src-tauri/src/vault_list.rs:174-189`, `src-tauri/src/maru_dir.rs:1-40,158-161`, `src/components/NativeTerminalView.tsx` (multiple ranges, cited inline), `src/components/graph/graphBridge.ts:1-4`, `src/components/graph/GraphCanvas.tsx:773`, `src/lib/e2eInvoke.ts`, `scripts/check-select-chrome.mjs`, `scripts/check-bundle-budget.mjs`, `src-tauri/Cargo.toml`, `rust-toolchain.toml`, `Makefile`, `.github/workflows/ci.yml`, `.github/workflows/release-bundles.yml`, `tsconfig.e2e.json`, `eslint.config.js`, `playwright.config.ts`, `.planning/codebase/TESTING.md`
- `npm view @wdio/tauri-service version` / `npm view webdriverio version` / `npm view @wdio/tauri-service` (full record) - live npm registry queries, run this session

### Secondary (MEDIUM confidence)
- `https://v2.tauri.app/develop/tests/webdriver/ci/` - official Tauri WebDriver CI docs, no macOS leg
- `https://webdriver.io/docs/desktop-testing/tauri/platform-support/` - fetched this session (WebFetch), platform/provider comparison table, the CI YAML example quoted verbatim
- `https://webdriver.io/docs/wdio-tauri-service/` - fetched this session (WebFetch), provider-selection wording quoted verbatim
- `https://github.com/webdriverio/desktop-mobile` (tauri-service package README) - fetched this session (WebFetch)
- `https://docs.rs/tauri/latest/tauri/test/` - `mock_builder`/`MockRuntime` reference, carried from prior STACK.md pass, not independently re-fetched this session

### Tertiary (LOW confidence)
- `.planning/research/STACK.md`, `.planning/research/PITFALLS.md`, `.planning/research/ARCHITECTURE.md`, `.planning/research/SUMMARY.md` - prior GSD research pass (2026-08-28, one day before this session), reused for context and cross-checked where this session had independent sources; not re-verified line-by-line where this session had no independent way to check (e.g. the crates.io version numbers)
- WebSearch aggregate results for "tauri:options env args", "precedent hosted macOS CI + wdio embedded", and "TCC accessibility github actions" queries - used only to confirm the absence of a documented precedent, itself the decision-relevant finding; no single result reached HIGH confidence

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM - npm package existence/versions verified live this session; the one crates.io package could not be re-verified due to this sandbox's network restrictions and must be the phase's literal first action
- Architecture: HIGH - every pattern is either grounded in a `[VERIFIED]` in-repo read this session or an explicit `[CITED]` official-docs quote; the two new pitfalls (env-var override gaps) are entirely `[VERIFIED]` against source
- Pitfalls: HIGH for the two new repo-specific findings (direct source reads); MEDIUM for the five carried-forward WKWebView/TCC/IME/flake pitfalls (official docs cross-checked this session but the core CI-viability question remains genuinely unresolved by any source)
- The CI-viability question itself: LOW, by design - this is precisely what the phase's spike exists to resolve, not something research can answer from documents

**Research date:** 2026-08-29
**Valid until:** 7 days - this is explicitly a fast-moving area (the core dependency `@wdio/tauri-service` embedded provider is 3 weeks old at time of research, actively shipping new npm releases within days of each other); re-verify package versions immediately before the phase's implementation, not from this document's cached numbers.
