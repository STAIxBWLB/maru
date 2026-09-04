# Maru Testing Strategy

## Overview

Tests are split into four layers: TypeScript unit tests, Rust unit/integration tests, Playwright E2E against a mocked Tauri frontend, and native WebdriverIO E2E against the real macOS application. `make verify` covers the hermetic layers; real-app and live-backend tests live outside it.

## TypeScript Unit Tests

- **Runner**: Vitest, invoked via `pnpm test` (`vitest run src scripts`).
- **Environment**: Node by default; component tests opt into `jsdom` with `// @vitest-environment jsdom`.
- **Location**: co-located `*.test.ts` / `*.test.tsx` next to source files, plus a few cross-cutting specs under `src/__tests__/`.
- **Coverage expectation**: unit tests cover store reducers, domain logic, component rendering, and IPC error normalization.
- **Run focused tests**:
  - `pnpm test`
  - `pnpm test <pattern>`

### Representative test types

- Pure state reducers (`workspaceStore.test.ts`, `documentIndex.test.ts`).
- React component tests using `createRoot` + `act` (`AgentUsageBar.test.tsx`).
- Mocked Tauri invoke / module tests using `vi.hoisted` + `vi.mock`.
- Benchmarks: `pnpm bench:graph` runs `src/lib/graph/perf.bench.ts`.

## Rust Unit and Integration Tests

- **Runner**: `cargo test` via `make test-rust` (`cargo test --lib` in `src-tauri/`).
- **CLI tests**: `make test-cli` runs `cargo test -p maru-cli --bin maru-cli`.
- Tests live inline in `#[cfg(test)]` modules or in dedicated test files such as `src-tauri/src/frontmatter/ops_update_tests.rs`.
- **Coverage expectation**: frontmatter operations, vault guards, path containment, workspace scanning, and IPC error contracts have inline test coverage.

### Non-hermetic / gated Rust tests

- `make verify-integration`: smoke tests against real installed AI CLIs. Skips uninstalled CLIs; requires live tokens for some backends. Not part of `make verify`.
- `make bench-scan`: real workspace scan benchmark (`--ignored --nocapture --test-threads=1`).

## E2E Tests (Playwright)

- **Directory**: `e2e/`
- **Config**: `playwright.config.ts`
- **Browser**: Chromium only.
- **Runtime**: Vite dev server with mocked Tauri IPC (`window.__MARU_E2E_INVOKE__`, defined in `src/lib/e2eInvoke.ts`).
- **Port**: `MARU_E2E_PORT` defaults to `5307`.
- **Timeout**: 30 s per test; 8 s expect timeout.
- **Trace policy**: `retain-on-failure` with snapshots and screenshots disabled for CI speed.

### Running

- `pnpm test:e2e` or `make test-e2e`
- `pnpm test:e2e:graph` runs graph behavior + shell specs together.

### Spec scope

23 spec files cover work surfaces including dashboard, today, tasks, drafts, inbox, agents, comms, meetings, diagram, graph, HTML editor, binary viewer, workbench layout, brand assets, and the internal `e2e` flow console.

## Native E2E Tests (WebdriverIO)

- **Directory**: `e2e-native/`
- **Config**: `e2e-native/wdio.conf.ts`
- **Target**: real macOS `.app` built with the optional `native-e2e` Cargo feature.
- **Runner**: `@wdio/tauri-service` drives the actual WKWebView DOM, a real PTY, IME composition, and menu-command paths.
- **Feature flag**: `native-e2e` enables `tauri-plugin-wdio-webdriver` and `tauri/custom-protocol`; it is off by default so the plugin never ships in release builds.

### Running

- `make test-e2e-native`
- This builds the frontend with `VITE_NATIVE_E2E=1`, compiles the app with `--features native-e2e`, then runs `pnpm test:e2e:native`.

### Constraints

- Not part of `make verify` because it is not hermetic.
- CI runs a compile check (`native-e2e-compile`) on PRs; the full suite runs only on `main`, release tags, and manual dispatch.
- The runner kills surviving app processes after the session and activates the app window to avoid background-throttling flakes.

## CI Verification Pipeline

### Pull-request flow (`ci.yml`)

1. **Decision job**: deduplicates `main` pushes whose exact tree was already verified by a successful PR run.
2. **`verify` job**: runs `make verify` on Ubuntu 22.04. Switches to `make release-checks` when a version change is detected.
3. **`e2e` job**: installs Playwright Chromium and runs `make test-e2e`.
4. **`native-e2e-compile` job**: typecheck, lint, frontend build, and `cargo check --locked --features native-e2e` on macOS; does not execute the suite.

### `make verify` composition

```text
typecheck
lint
release-version-check
icons-check
lint-i18n
check-select-chrome
check-type-tokens
test-ts
test-rust
fmt-check
clippy
build-frontend
```

### Release workflows

- `release-preflight.yml`: `make release-preflight-core` on Ubuntu, `make cli-smoke` on Ubuntu, and Playwright E2E.
- `native-e2e.yml`: full native E2E suite on `main`, `v*` tags, and manual dispatch.
- `release-bundles.yml`: triggered by a published release; builds, signs, notarizes, and uploads macOS/Linux/Windows artifacts plus the standalone CLI.

### What CI does not prove

Playwright E2E does not prove WKWebView, the native PTY, Korean IME behavior, macOS menus, signing, or notarization. macOS-affecting changes require a real-app or release-artifact check.

## Coverage Expectations

- New Rust modules with conflict-emitting commands should preserve `{ code, message }` and be covered by the ERR-06 recursive source guard.
- New frontend stores should have reducer unit tests.
- New work surfaces should have at least one Playwright spec exercising the mocked-backend seam.
- Native-only flows (PTY, IME, menu commands, passkey packaging) should be exercised in the native E2E suite or release preflight.

## Running Tests Locally

```bash
# Full hermetic verification
make verify

# Frontend gates
pnpm typecheck
pnpm lint
pnpm test
pnpm build

# Rust gates
make test-rust
make fmt-check
make clippy
make test-cli

# E2E (requires `pnpm exec playwright install --with-deps chromium`)
make test-e2e

# Native E2E (macOS only)
make test-e2e-native

# Real CLI integration smoke (non-hermetic)
make verify-integration
MARU_CLI_SMOKE_ROUNDTRIP=1 make verify-integration
```
