# Stack Research

**Domain:** Tauri 2 desktop app, quality/reliability milestone (v1.1 Felt Quality and Native Proof)
**Researched:** 2026-08-28
**Confidence:** MEDIUM (versions verified live against npm/crates.io registries and official docs; the macOS-CI-viability claims are cross-checked across 2+ independent sources but not hands-on tested in this repo's CI yet)

This milestone adds zero product features. Every recommendation below is scoped to closing four gaps: (1) no native macOS e2e coverage, (2) no coverage measurement, (3) one 26k-line `styles.css` that isn't chunked with its lazy panes, (4) nothing else.

## Q1 - Native E2E Runner for a Tauri 2 App on macOS (THE CRITICAL ONE)

### Verdict, stated plainly

**Official `tauri-driver` does not and will never support macOS** - Apple ships no WebDriver implementation for WKWebView, unlike WebKitGTK (Linux) and Edge (Windows), which is why Tauri's own CI docs (`v2.tauri.app/develop/tests/webdriver/ci/`) only show `ubuntu-latest` and `windows-latest` in the test matrix. That part of the question has a clean, definitive NO.

**But there is now a real, free, unattended-CI-capable macOS answer as of 2026**: `@wdio/tauri-service` (WebdriverIO's official Tauri integration, published from `webdriverio/desktop-mobile`) ships an **embedded** driver provider - `tauri-plugin-wdio-webdriver`, a Rust crate compiled into the app's debug build that runs a small JS-bridge HTTP server *inside the WKWebView process itself*. No external driver binary, no paid key, no code signing, no notarization. It genuinely drives the real WKWebView on a real hosted GitHub Actions `macos-14`/`macos-15` runner.

**What it cannot do, and nothing can do unattended on hosted CI**: touch the native macOS menu bar, native file/print dialogs, or anything else that lives outside the webview. Those require the macOS Accessibility (TCC) permission, which needs a one-time interactive System Settings click - hosted GitHub Actions macOS runners are a fresh VM every run with nobody there to click it (this is a long-standing, unresolved, structural limitation tracked across multiple `actions/runner-images` issues, not a config problem you can script around). That gap is real and matches what PROJECT.md already says: native-only changes stay a manual gate.

### Decision table

| Option | Runs on macOS | Unattended in GH Actions | Signing/notarization needed | Self-hosted runner needed | Can observe | Cannot observe |
|---|---|---|---|---|---|---|
| **`tauri-driver` (official, crates.io)** | **No** | Linux/Windows only | No | No | WKWebView N/A | N/A on macOS |
| **`@wdio/tauri-service` "official" provider** (wraps `tauri-driver`) | **No** | Linux/Windows only | No | No | Same as above, DOM via WebKitWebDriver/Edge WebDriver | macOS entirely |
| **`@wdio/tauri-service` "embedded" provider** (`tauri-plugin-wdio-webdriver`) | **Yes** | **Yes** - hosted `macos-14`/`macos-15` runner, debug build, no Gatekeeper quarantine on a locally-built binary | **No** - debug build only, plugin explicitly excludes itself from release binaries | **No** | DOM, computed styles, JS execution/console, real WKWebView screenshots (including canvas pixel content), window handles/position, cookies, dialogs opened *inside* the webview | Native NSMenu bar, native OS dialogs, OS-level IME composition (DOM `compositionstart/update/end` events fire but that is not the same code path as a real IME engine), real PTY glyphs specifically - **Maru's terminal renders to `<canvas>` (`NativeTerminalView.tsx:2129`, 2D context), so DOM queries see nothing; only screenshot/pixel assertion or an explicit JS state hook can verify PTY output through this driver** |
| **CrabNebula `@crabnebula/tauri-driver`** | Yes | Yes, in principle | No | No | Same class as embedded | Same as embedded |  Paid `CN_API_KEY` required specifically for macOS - reject, embedded is free and does the same job |
| **`tauri::test::mock_builder()` / `MockRuntime`** (Rust, in-tree `tauri` crate) | Yes (it's just `cargo test`) | Yes, trivially - no webview at all | No | No | IPC command handler behavior, `assert_ipc_response`/`get_ipc_response` | WKWebView, PTY, IME, menu - none of it; this is IPC-contract testing, not UI testing |
| **AXUIElement / `axuielement` crate / AppleScript System Events** | Yes | **No** - needs interactive one-time Accessibility (TCC) permission grant; hosted runners are ephemeral VMs, nobody can click the dialog (`actions/runner-images` #553, #1567, #3286, #8214) | No | **Yes, effectively** - only a persistent self-hosted Mac with the permission pre-granted once works unattended | Native menu bar, native dialogs, real OS-level keystroke injection | Nothing web-specific; heavier to build, brittle across macOS versions |
| **XCTest/XCUITest against the bundled `.app`** | Yes | Only with an Xcode UI-test target wired to the `.app`, which Tauri does not scaffold and no maintained community project provides | Possibly (Xcode signing for the test runner) | Recommend against - high setup cost for a capability the embedded provider already covers except menu bar | Deep native introspection if built | Not evaluated further - no ready integration exists for Tauri; building one from scratch is out of proportion to this milestone |
| **Community forks** (`danielraffel/tauri-webdriver`, `Choochmeque/tauri-webdriver`) | Yes | Same embedded-in-webview approach as the now-official provider | No | No | Same class as embedded | Same as embedded - **skip these**, the org-owned `@wdio/tauri-service` embedded provider is the maintained successor to this exact idea (published 3 weeks ago via GitHub Actions OIDC, MIT) |

### Recommendation

Add a **new, separate native e2e project** - do not fold this into the existing Playwright/Chromium/mocked-IPC suite, they test different things and have different failure semantics.

| Package | Version (verified) | Purpose |
|---|---|---|
| `@wdio/tauri-service` | `1.3.0` (npm, verified live) | WebdriverIO service, `embedded` provider by default |
| `webdriverio` | `9.31.4` (npm, verified live; service pins `9.30.0` as a dep floor) | WebDriver client/test runner |
| `tauri-plugin-wdio-webdriver` | `1.3.0` (crates.io, verified via `cargo search`/`cargo info`; `rust-version = 1.77` - compatible with this repo's MSRV 1.77.2) | The in-app embedded driver, added as a `dev-dependencies`-only Cargo feature so it never ships in the signed/notarized release bundle |
| `@wdio/cli`, `@wdio/mocha-framework`, `@wdio/spec-reporter` (or `@wdio/local-runner`) | pull whatever `wdio config` scaffolds - check current pins at install time | Standard WebdriverIO test harness plumbing |

**CI wiring:** a new job in `.github/workflows/ci.yml`, `runs-on: macos-14` (or `macos-15`), matrix-optional alongside the existing `ubuntu-22.04` `verify`/`e2e` jobs - does not touch them. Build the app once with `pnpm tauri build --debug` (with the wdio plugin feature enabled), then run the WebdriverIO suite against that binary. No `APPLE_SIGNING_IDENTITY`/`APPLE_ID`/notarization secrets needed for this job - those stay scoped to `release-bundles.yml`.

**Scope this suite honestly, per TEST-01's own four surfaces:**
- WKWebView, real DOM, IME `compositionstart/update/end` events, and non-canvas UI - in scope, this driver reaches them.
- PTY output - only verifiable by screenshot/pixel assertion against the `<canvas>`, not DOM query; treat these as a small number of high-value smoke assertions, not broad coverage.
- Native macOS menu bar - **stays a manual gate**. Do not attempt AXUIElement/AppleScript automation in hosted CI; it cannot pass the TCC permission wall unattended. If menu coverage becomes a hard requirement in a future milestone, the only unattended path is a self-hosted Mac runner with the permission pre-granted once - a real option, but a heavier one than this milestone needs, and PROJECT.md already accepts "validate by running the real app" for exactly this gap.

**Where `tauri::test::mock_builder()`/`MockRuntime` fits:** add it as ordinary `#[cfg(test)]` Rust tests for IPC command handlers that need contract coverage without spinning up a webview at all - cheap, runs on the existing `ubuntu-22.04` job, no new CI surface. It is a complement to the WebdriverIO suite, not a substitute; it cannot see WKWebView/PTY/IME/menu, only command dispatch.

## Q2 - Coverage Measurement (Non-Gating Report)

### TypeScript/Vitest

| Package | Version | Notes |
|---|---|---|
| `@vitest/coverage-v8` | `4.1.11` (npm, verified live) | Matches installed `vitest@^4.1.5` - its own `peerDependencies` pin `vitest: 4.1.11`, so this is the correct, currently-resolvable pairing, not a guess |

**Provider choice: v8, not istanbul.** `@vitest/coverage-istanbul@4.1.11` also exists and is version-aligned, but v8 is the right default here: it uses V8's native coverage counters (no source instrumentation step, so it does not distort timing-sensitive tests - this repo has real ones, e.g. the 700ms debounce/fake-timer suites in `TESTING.md`), and Vitest's own docs treat v8 as the default/first-class provider. Istanbul only wins when you need per-branch coverage on non-V8 runtimes, which does not apply here (jsdom + Node, always V8).

**Wiring - non-gating:**
```bash
pnpm add -D @vitest/coverage-v8
```
Add a script rather than a config block, since there is deliberately no `vitest.config.ts` in this repo (`TESTING.md`: "configured entirely by `vite.config.ts`... Defaults apply"):
```json
"test:coverage": "vitest run src scripts --coverage"
```
Coverage thresholds are simply never set - Vitest only fails the run on a threshold if one is configured; omitting `test.coverage.thresholds` entirely keeps this report-only, matching "non-gating" exactly. Wire it as an independent `make coverage` / CI step that uploads or prints a summary, **not** inside `make verify` - `verify` must stay the trusted floor and adding coverage there would silently change its meaning.

### Rust

| Tool | Version | Notes |
|---|---|---|
| `cargo-llvm-cov` | `0.9.0` (crates.io, verified via `cargo search`) | LLVM source-based coverage (`-C instrument-coverage`), the standard modern choice over the older `cargo-tarpaulin` (ptrace-based, Linux-only, slower, and increasingly unmaintained relative to llvm-cov) |

**Install/run (non-gating):**
```bash
rustup component add llvm-tools-preview   # once, matches the pinned rust-toolchain 1.98.0
cargo install cargo-llvm-cov --locked
cd src-tauri && cargo llvm-cov --lib --html          # local, human report
cd src-tauri && cargo llvm-cov --lib --lcov --output-path lcov.info   # CI artifact
```
Add as a separate `make coverage-rust` target or a non-blocking CI step that uploads `lcov.info` as a workflow artifact (or to a coverage viewer if one is ever wanted) - again, deliberately outside `make verify`/`make test-rust`.

## Q3 - CSS Code Splitting Under Vite 7.3

**Mechanism: a plain `import "./mode.css"` inside the lazy-loaded module. No Vite config change.**

Vite's `build.cssCodeSplit` **already defaults to `true`** (confirmed against Vite's build-options docs) - this repo has never turned it off, so it is silently relying on a global `styles.css` `<link>` instead of benefiting from a feature that has been on since Vite 2. Per Vite's own semantics: "CSS imported in async chunks will be preserved as chunks and fetched together when the chunk is fetched... the async chunk is guaranteed to only be evaluated after the CSS is loaded, to avoid FOUC." That is exactly the lazy-registry shape this app already has for `GraphView`, `RichMarkdownEditor`, i18n dictionaries, and the 18 mode panes.

**What to actually do:**
1. Split `src/styles.css` (~26k lines) into per-mode files, mirroring the pattern already used for `diagram.css`, `graph.css`, `settings.css`.
2. Put the `import "./modeX.css"` statement at the top of the same file the lazy registry already dynamically imports for that mode (the `React.lazy(() => import("./ModeXPane"))` target) - not in a barrel file, not in `App.tsx`. Vite's chunk graph follows the import, and the CSS rides along in the same async chunk automatically.
3. Keep the truly shared, always-needed rules (resets, tokens/`foundations.css`, layout shell used by every mode) in the entry-graph stylesheet so they load with the initial JS, matching the existing 70 KiB CSS budget gate philosophy.
4. Re-run `scripts/check-bundle-budget.mjs` after the split - it already asserts `GraphView`/`RichMarkdownEditor`/i18n stay lazy; extend the same style of assertion to the new CSS chunks if the script supports per-chunk size checks, otherwise confirm manually that the initial CSS shrinks and per-mode CSS shows up only in that mode's network request.

No plugin is needed (`vite-plugin-lib-inject-css` etc. solve a different problem - CSS injection for *library* builds, not app code splitting). No `rollupOptions.output.manualChunks` change is needed either; that controls JS chunking, and CSS code-splitting is already keyed to the JS chunk graph by default.

## Q4 - What NOT to Add

| Temptation | Why reject it here | Use instead |
|---|---|---|
| **Zustand/Jotai/Redux/any new state library**, reached for by whoever writes the WebdriverIO page objects or a coverage dashboard state | Explicit hard constraint in PROJECT.md and CLAUDE.md; the `useSyncExternalStore` module-store pattern (`errorStore.ts`, `workspaceStore.ts`, etc.) is proven and this milestone is not supposed to touch frontend architecture at all, only test/CI plumbing | Nothing - coverage/e2e tooling has no reason to touch app state |
| **Tailwind/any CSS framework**, reached for "while we're touching CSS anyway" during the styles.css split | Explicit hard constraint; the split is purely mechanical (move rules to files, add imports) - it is not a redesign and must not become one | Keep the existing hand-authored CSS, same tokens (`foundations.css`), same class-name conventions the 23 Playwright specs already select on (499 `.css-class` locators depend on stable names) |
| **`cargo-tarpaulin`** for Rust coverage | Older ptrace-based approach, Linux-only (this repo ships/tests on macOS, Windows, Linux), slower and less actively evolved than `cargo-llvm-cov`, which uses the same LLVM instrumentation Rust's own toolchain ships | `cargo-llvm-cov` |
| **Codecov/Coveralls SaaS integration** | Not asked for, adds an external service dependency and a secret to manage for a report that's explicitly non-gating; premature for "measure it, don't gate on it" | Local HTML report (`cargo llvm-cov --html`) + `lcov.info`/coverage JSON as a CI artifact; wire a real dashboard later if coverage becomes a gated metric |
| **XCUITest/WebDriverAgent custom harness** | No maintained Tauri integration exists; building an Xcode UI-test target around a Tauri `.app` from scratch is a multi-week investment for capability (menu bar) that the embedded WebdriverIO provider mostly makes unnecessary, and the remaining gap (menu bar) can't run unattended on hosted CI anyway regardless of tooling | `@wdio/tauri-service` embedded provider for everything it *can* reach; manual verification for the menu bar, as PROJECT.md already accepts |
| **`@crabnebula/tauri-driver`** | Requires a paid `CN_API_KEY` specifically for the one platform (macOS) this milestone cares most about; the free official embedded provider does the same job | `@wdio/tauri-service` with the default `embedded` provider |
| **Playwright for the native suite** | Playwright drives Chromium/Firefox/WebKit browser binaries it manages itself, not the app's actual WKWebView process - it cannot exercise this app's Tauri IPC, native PTY, or native window chrome any better than the existing mocked-IPC suite already does; adding a second Playwright config would just duplicate what's already covered without closing the WKWebView gap | `@wdio/tauri-service`, which drives the real bundled binary |
| **A second `vitest.config.ts`** to hold coverage config | This repo deliberately has none; adding one just for a `coverage` block reintroduces the exact config surface the codebase avoided | A `--coverage` CLI flag on the existing `vitest run src scripts` invocation, wrapped in a new `package.json` script |
| **Retrofitting coverage or the CSS split into `make verify`'s gate set** | Both are explicitly non-gating/mechanical per the milestone scope; folding them into `verify` changes what "verify is green" means, which PROJECT.md calls out as the thing this milestone must not do silently | Separate `make coverage` / `make coverage-rust` targets and CI steps; CSS split is verified by the existing bundle-budget gate, not a new one |

## Sources

- `https://v2.tauri.app/develop/tests/webdriver/ci/` - Tauri official WebDriver CI docs (Linux+Windows matrix only), MEDIUM confidence (official docs)
- `https://webdriver.io/docs/desktop-testing/tauri/platform-support/` - WebdriverIO Tauri platform-support matrix, driver provider comparison, MEDIUM confidence (official docs, cross-checked)
- `https://webdriver.io/docs/wdio-tauri-service/` - `@wdio/tauri-service` setup, MEDIUM confidence
- `https://github.com/webdriverio/desktop-mobile` - source repo for `@wdio/tauri-service` / `tauri-plugin-wdio-webdriver`, npm/crates.io registries verified live (`npm view`, `cargo search`/`cargo info`), HIGH-grade for version numbers specifically
- `https://docs.rs/tauri/latest/tauri/test/` - `mock_builder`/`MockRuntime`/`assert_ipc_response`, MEDIUM confidence (official docs.rs)
- `https://github.com/actions/runner-images` issues #553, #1567, #3286, #8214 - TCC/Accessibility permission blocker on hosted macOS runners, MEDIUM confidence (multiple independent, long-running issue threads, consistent conclusion)
- `https://danielraffel.me/2026/02/14/i-built-a-webdriver-for-wkwebview-tauri-apps-on-macos/` and `github.com/Choochmeque/tauri-webdriver` - community precursors to the now-official embedded provider, LOW-MEDIUM (blog/community, used only to establish the pattern predates the official release)
- `npm view @wdio/tauri-service / webdriverio / @vitest/coverage-v8 / @vitest/coverage-istanbul` - live npm registry query, HIGH confidence (primary registry data)
- `cargo search` / `cargo info tauri-plugin-wdio-webdriver` / `cargo search cargo-llvm-cov` - live crates.io registry query, HIGH confidence (primary registry data)
- `https://vite.dev/config/build-options` (`cssCodeSplit`) and `https://vite.dev/guide/features` (async-chunk CSS behavior) - official Vite docs, MEDIUM confidence
- This repo: `src/components/NativeTerminalView.tsx:2129` (terminal renders to `<canvas>`, 2D context) - direct code read, HIGH confidence

---
*Stack research for: Maru v1.1 Felt Quality and Native Proof*
*Researched: 2026-08-28*
