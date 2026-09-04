# Maru Technology Stack

Local-first desktop workspace for Korean knowledge and document operations. Version **1.1.3**.

## Languages & Runtimes

- **TypeScript 5.9.3** — frontend, e2e specs, build/release scripts
- **React 19.2** — UI runtime
- **Node.js >= 22** (CI pins 22.22.3)
- **Rust 2021 edition** — Tauri backend core; MSRV pinned to 1.77.2
- **Python** — optional skill helpers and Telegram monitor scripts

## Package Management

- **pnpm 9.15.0** — declared in `package.json`; frozen-lockfile installs in CI
- **Cargo** — Rust workspace with members `.` (desktop core) and `maru-cli`

## Frontend

- **Build tool:** Vite 7.3.1 with `@vitejs/plugin-react`
- **Module/target:** ESNext, Bundler resolution, JSX transform `react-jsx`
- **UI primitives:** Radix UI (`react-dialog`, `react-tabs`)
- **Block editor:** BlockNote 0.49 (`core`, `react`, `mantine`)
- **Code editor:** CodeMirror 6 (`state`, `view`, `commands`, `lang-markdown`)
- **Markdown / HTML:** `marked` 18, `dompurify` 3.4
- **Icons:** `lucide-react` 0.564, `react-icons` 5.7
- **Typography:** `@fontsource/noto-serif-kr` 5.3
- **Date utilities:** `date-fns` 3.6

## Graph & Diagram

- **WebGL renderer:** `sigma` 3.0.3
- **Graph data model / layouts:** `graphology` 0.26.0, `graphology-layout` 0.6.1, `graphology-layout-forceatlas2` 0.10.1
- **Sigma plugins:** `@sigma/export-image` 3.0.0, `@sigma/node-border` 3.0.0
- **Diagram authoring:** custom Rust-backed diagram engine in `src-tauri/src/diagram/`

## Desktop Shell

- **Tauri 2.10.0** with `protocol-asset` and `unstable` features
- **Plugins:**
  - `@tauri-apps/plugin-clipboard-manager` 2.3.2
  - `@tauri-apps/plugin-dialog` 2.6+
  - `@tauri-apps/plugin-notification` 2
  - `@tauri-apps/plugin-process` 2
  - `@tauri-apps/plugin-updater` 2
  - Native-e2e only: `tauri-plugin-wdio-webdriver` 1.3.0

## Rust Core (`src-tauri`)

- **Framework:** `tauri` 2.10.0, `tauri-build` 2.5.4
- **Serialization:** `serde`, `serde_json`, `serde_yaml` 0.9
- **Date / timezone:** `chrono`, `chrono-tz`
- **HTTP:** `reqwest` 0.12 (`blocking`, `json`, `rustls-tls`)
- **Concurrency:** `rayon`
- **File watching:** `notify` 6
- **Terminal / PTY:** `portable-pty` 0.8, `alacritty_terminal` 0.26.0
- **Document containers:** `quick-xml` 0.39.2, `zip` 4.6.1 (`deflate-flate2-zlib-rs`)
- **Crypto / hashing:** `sha2`, `base64`, `minisign-verify`
- **Text / regex:** `regex`, `unicode-width`, `similar` 2, `encoding_rs`
- **Paths / env / IO:** `dirs`, `walkdir`, `tempfile`, `trash` 4.1.1
- **UUID:** `uuid` v4
- **Embedded assets:** `include_dir` 0.7

## Platform-Specific Rust Crates

- **macOS:** `block2` 0.6.2, `core-foundation-sys` 0.8.7, `objc2` 0.6.4
- **Windows:** `windows-sys` 0.59 (`Win32_Foundation`, `Security`, `System_JobObjects`, `System_Threading`)

## Standalone CLI

- `src-tauri/maru-cli/` defines the `maru-cli` binary
- Reuses `maru_lib` crate; distributed separately via GitHub Releases and Homebrew formula `maru-cli`

## Testing & Quality

- **Unit tests:** Vitest 4.1.5 (`src`, `scripts`), `jsdom` 29
- **Browser e2e:** Playwright 1.59.1 (Chromium)
- **Native e2e:** WebdriverIO 9.31.4 with `@wdio/tauri-service` 1.3.0 and the `native-e2e` cargo feature
- **Rust tests:** `cargo test --lib`
- **Linting:** ESLint 10.9 flat config (`typescript-eslint`, `eslint-plugin-react-hooks`)
- **Rust checks:** `cargo clippy -D warnings`, `cargo fmt --check`

## Build & Release

- **Make** — primary workflow entry point: `make verify`, `make tauri-dev`, `make tauri-build`, `make cli-build`, `make release-preflight`
- **Tauri CLI:** `pnpm tauri` / `@tauri-apps/cli` 2.10.0
- **CI/CD:** GitHub Actions (`.github/workflows/ci.yml`, `release-bundles.yml`, `release-preflight.yml`, `native-e2e.yml`)
- **Distribution:**
  - GitHub Releases with Tauri updater artifacts
  - macOS codesigning + notarization + stapling
  - Homebrew tap `STAIxBWLB/homebrew-cask` (`maru-workspace` cask, `maru-cli` formula)

## Sidecars

- **`sidecars/maru-mcp/`** — Node-based MCP companion (`@maru/maru-mcp`), engine `>=20.19`

## Key Configuration Files

- `vite.config.ts` — dev server on `127.0.0.1:5307`, env prefixes `VITE_`, `TAURI_`
- `tsconfig.json` — project references: `app`, `node`, `e2e`, `e2e-native`, `scripts`
- `src-tauri/tauri.conf.json` — bundle identifier `kr.maru.desktop`, updater endpoint, CSP
- `eslint.config.js` — flat ESLint config scoped to `src/`, `e2e/`, `e2e-native/`
