---
phase: 06-native-e2e-runner-foundation
plan: 01
subsystem: testing
tags: [webdriverio, tauri, wkwebview, e2e, cargo-features, github-actions]

requires: []
provides:
  - "make test-e2e-native: one target that builds the real app with the native-e2e feature and drives its WKWebView DOM under WebDriver"
  - "Fail-closed native-e2e dir overrides (paths.rs) wired into maru_dir and vault_list"
  - "e2e-native/ runner tree: wdio.conf, fixtureWorkspace helper, first spec (D-13 surface 1)"
  - "Hosted-macOS CI-viability spike workflow + spike log with a first hosted pass"
affects: [06-02 real PTY ink check, 06-03 IME sub-spike, 06-05 CI/preflight wiring, 10 release-preflight CSP check]

actuals:
  tokens: 42000
  tasks: 3
  commits: 5

tech-stack:
  added: ["@wdio/cli 9.31.4", "@wdio/globals 9.31.3", "@wdio/local-runner 9.31.4", "@wdio/mocha-framework 9.31.2", "@wdio/spec-reporter 9.31.2", "@wdio/tauri-service 1.3.0", "tauri-plugin-wdio-webdriver 1.3.0 (crate, optional)"]
  patterns: ["default-off cargo feature gating all runner-only affordances", "fail-closed env-var dir overrides", "per-run mkdtemp fixture root, never committed", "workflow_dispatch-only disposable spike workflow"]

key-files:
  created:
    - e2e-native/wdio.conf.ts
    - e2e-native/helpers/fixtureWorkspace.ts
    - e2e-native/specs/webview.spec.ts
    - tsconfig.e2e-native.json
    - .github/workflows/native-e2e-spike.yml
    - docs/native-e2e.md
  modified:
    - package.json
    - pnpm-lock.yaml
    - src-tauri/Cargo.toml
    - src-tauri/Cargo.lock
    - src-tauri/src/lib.rs
    - src-tauri/src/paths.rs
    - src-tauri/src/maru_dir.rs
    - src-tauri/src/vault_list.rs
    - Makefile

key-decisions:
  - "native-e2e feature also enables tauri/custom-protocol: tauri compiles dev mode whenever custom-protocol is off, so without it a plain cargo build binary points at devUrl and the webview stays about:blank forever"
  - "make target touches src-tauri/build.rs between the vite and cargo builds; cargo does not track dist/ as an input and otherwise reuses a stale binary"
  - "fixture seeding runs in the wdio config's onPrepare (launcher process, before the service spawns the app); beforeSession runs in the worker and was too late for env inheritance"
  - "spec clicks the rail's documents button before asserting .document-list; a fresh profile lands on the Today view"

patterns-established:
  - "Runner-only affordances compile only under a default-off feature that is never in a shippable build (D-10)"
  - "Hosted-runner evidence is uploaded with if: always() and an explicit job timeout, so a modal hang is a readable timeout, not a 6-hour job"

requirements-completed: [TEST-01]

coverage:
  - id: D1
    description: "Local native e2e run: make test-e2e-native builds the app, launches it under the embedded WebDriver provider, and asserts the real WKWebView DOM (activity rail + seeded fixture document)"
    requirement: TEST-01
    verification:
      - kind: e2e
        ref: "make test-e2e-native — 1 passing (51.8s), local macOS, 2026-08-29"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fail-closed isolation: with native-e2e active and MARU_NATIVE_E2E_HOME / MARU_NATIVE_E2E_CONFIG_DIR absent, home/config dir resolution refuses instead of falling back to the real ~/.maru"
    requirement: TEST-01
    verification:
      - kind: unit
        ref: "cargo test (paths.rs resolver tests) via make verify — CI run 33240188151 green"
        status: pass
    human_judgment: false
  - id: D3
    description: "Fixture isolation: per-run mkdtemp root, no creds/provider IO seeded, no live app or PTY child left after pass or fail"
    requirement: TEST-01
    verification:
      - kind: e2e
        ref: "make test-e2e-native — fixture workspace 'Native E2E Fixture' rendered; pgrep/lsof clean after pass and fail runs"
        status: pass
    human_judgment: false
  - id: D4
    description: "Hosted-macOS session-establishment spike: workflow_dispatch job on macos-14, evidence uploaded unconditionally, first failure classifiable under D-02"
    requirement: TEST-01
    verification:
      - kind: e2e
        ref: "https://github.com/STAIxBWLB/maru/actions/runs/33243419439 — pass on attempt 1, no permission prompt"
        status: pass
    human_judgment: false

duration: cross-session (recovered; see notes)
completed: 2026-08-29
status: complete
---

# Phase 06-01: Native E2E Runner Tracer Slice Summary

**One make target now drives the real macOS app's WKWebView DOM under WebDriver with fail-closed workspace isolation, and the hosted-macOS spike passed on its first attempt — session establishment is CI-viable, with D-01's PTY and full-unattended conditions still open for later plans.**

## Performance

- **Duration:** cross-session — the slice was built in a prior sandboxed session that stopped at the D-02-shaped white screen; recovery, diagnosis, and the spike completed 2026-08-29
- **Commits:** 5 (8d70342 slice, 5bf816f runner fix, 3df8cf7 spike workflow, a80f3ef spike log, d847e12 plan-doc corrections)
- **Tasks:** 3/3

## Task 1 — Package legitimacy gate (human-approved in the prior session)

- `tauri-plugin-wdio-webdriver` resolved to **1.3.0** from crates.io; the dependency is installed and compiles against the pinned toolchain (Cargo.lock records the registry source).
- The five npm packages (`@wdio/tauri-service` 1.3.0, `webdriverio`, `@wdio/cli`, `@wdio/mocha-framework`, `@wdio/spec-reporter` — 9.31.x train) all ship from the `webdriverio` GitHub organization; install completed and CI (`make verify`, run 33240188151) is green.
- `@vitest/coverage-v8` was NOT installed — deferred to Phase 11 (TEST-02) as the plan requires.

## Task 2 — Runner slice (recovered and fixed)

The prior session's slice failed with a permanently blank webview in two independent environments. Diagnosis and fixes (commit 5bf816f):

1. **Dev-mode binary:** tauri compiles `dev` mode whenever the `custom-protocol` feature is off (`dev = !custom_protocol` in tauri's build.rs). A plain `cargo build` binary pointed its window at `devUrl` and embedded no assets — with no vite dev server the webview stayed on `about:blank` (verified live: initial URL `about:blank`; manual navigation to `tauri://localhost/index.html` returned "asset not found: index.html"; the same webview rendered the full app once pointed at a running vite server). The `native-e2e` feature now enables `tauri/custom-protocol`.
2. **Stale asset embedding:** cargo does not track `dist/` as a build input (observed: a 0.89s no-op build after a fresh vite build). The make target touches `src-tauri/build.rs` between the two builds.
3. **Fixture env never reached the app:** seeding ran in wdio's `beforeSession`, which executes in the worker process after the launcher had already spawned the app. Seeding moved to the config's `onPrepare` (runs before the service's own onPrepare; the service spreads `process.env` into the app spawn). Workers recover the fixture root from the inherited env.
4. **Spec assumed the wrong landing view:** a fresh profile opens the Today view; the spec now clicks the rail's `문서` button before asserting `.document-list` (Korean aria-label, matching the Playwright suite's convention).

Result: `make test-e2e-native` → **1 passing (51.8s)** locally; no leftover app processes, ports, or fixture roots on either the pass or the fail path.

## Task 3 — Hosted CI-viability spike

- `.github/workflows/native-e2e-spike.yml`: `workflow_dispatch`-only job on `macos-14`, 45-minute explicit timeout, evidence (run log + failure screencapture) uploaded with `if: always()`. `ci.yml` untouched.
- Merged via PR #294 (workflow_dispatch requires the file on the default branch), dispatched against main.
- **Attempt 1: pass.** Run https://github.com/STAIxBWLB/maru/actions/runs/33243419439 — session established with no interactive/TCC prompt, suite green (`1 passing (46s)`). Runs used: 1 of 3.
- Running verdict recorded in `docs/native-e2e.md`: **`ci-viable-pending-full-suite`** — session establishment only; D-01's PTY-readability (plan 06-02) and full-unattended-run conditions remain open.

## Deviations

- The plan's premise that a directly launched debug binary serves the production Vite output was false; 06-01/06-02 plan text and RESEARCH Pitfall 8 were corrected in d847e12 with the actual mechanism.
- The gsd-pr-branch skill's strip loop would have staged deletions of main-tracked `.planning/codebase/`; during PR-branch construction the strip was narrowed to paths each commit actually touched.
- Known non-blocking noise: `withGlobalTauri: false` means the tauri-service focus helper logs a 5s-timeout warning per DOM command; the `tauri-driver not found` diagnostics line is expected in embedded-provider mode.

## Self-Check: PASSED

- All must-have artifacts exist on disk; both verify commands (`make test-e2e-native`, `tsc -p tsconfig.e2e-native.json --noEmit`) pass; spike-log content checks pass; CI green on PRs #293/#294.
