---
last_mapped_commit: a938128cd8f34d36b2f2361d683d8b419c8ca534
---

# Technology Stack

**Analysis Date:** 2026-08-22

Maru (v0.4.62) is a local-first Tauri 2 desktop app: a React 19 + TypeScript
frontend in `src/` talking over Tauri IPC to a Rust core in `src-tauri/src/`,
plus a standalone Rust CLI (`src-tauri/maru-cli/`) and a Node MCP sidecar
(`sidecars/maru-mcp/`).

## Languages

**Primary:**
- TypeScript 5.9 (`~5.9.3`) - all frontend code under `src/` (562 `.ts`/`.tsx` files, 184 of them `*.test.ts(x)`), e2e specs under `e2e/`, build/release scripts under `scripts/*.mjs`. Config: `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`
- Rust 2021 edition, MSRV 1.77.2 - desktop core `src-tauri/src/` (85+ modules), CLI `src-tauri/maru-cli/src/main.rs`. Config: `src-tauri/Cargo.toml`

**Secondary:**
- JavaScript ESM (`.mjs`) - Node tooling in `scripts/` and the MCP sidecar `sidecars/maru-mcp/index.mjs`. No build step, run directly by Node
- CSS - hand-authored design system in `src/styles.css` (~26k lines, the single global stylesheet) and `src/foundations.css` (91 lines of tokens). Two feature-scoped stylesheets exist alongside it: `src/components/diagram/diagram.css`, `src/components/graph/graph.css`, `src/components/settings/settings.css`. No CSS framework, no preprocessor
- Python - only inside bundled skills (`skills/skills/hwpx/scripts/`, `skills/skills/io-kakao/scripts/`), executed out-of-process from the managed venv, never linked into the app

## Runtime

**Environment:**
- Node >= 22 (`package.json` `engines.node`); CI pins 22.22.3 (`.github/workflows/ci.yml`)
- Rust stable toolchain (`dtolnay/rust-toolchain@stable` in CI), MSRV 1.77.2
- Webview: system WebView - WKWebView on macOS, WebView2 on Windows, WebKitGTK 4.1 on Linux
- MCP sidecar requires Node >= 20.19 (`sidecars/maru-mcp/package.json`)

**Package Manager:**
- pnpm 9.15.0, pinned via `packageManager` in `package.json`
- Lockfile: `pnpm-lock.yaml` present, CI installs with `--frozen-lockfile`
- Single-package pnpm workspace (`pnpm-workspace.yaml` lists only `.`)
- Cargo workspace with two members: `.` and `maru-cli` (`src-tauri/Cargo.toml`); lockfile `src-tauri/Cargo.lock` committed

## Frameworks

**Core:**
- Tauri 2.10 (`tauri` crate, `@tauri-apps/api` ^2.10.1) - desktop shell, IPC, windowing, bundling. Uses the `unstable` cargo feature for child webviews (`src-tauri/src/site_view.rs`) and `protocol-asset` for local file serving
- React 19.2 + React DOM 19.2 - frontend UI, entry `src/main.tsx`, root component `src/App.tsx`. No router, no Redux/Zustand: mode switching and app state live in `App.tsx` plus hand-rolled `useSyncExternalStore` stores under `src/lib/` (`editorTabsStore.ts`, `workspaceStore.ts`, `errorStore.ts`, `appOverlayStore.ts`, `telegramEventsStore.ts`)
- Vite 7.3 with `@vitejs/plugin-react` - dev server (127.0.0.1:5307, strict port) and production bundler. Config: `vite.config.ts`

**Testing:**
- Vitest 4.1 - TS/React unit tests, run via `pnpm test` (`vitest run src scripts`). No `vitest.config.ts`; per-file `@vitest-environment jsdom` pragmas select the DOM environment (`jsdom` ^29.1.1)
- Playwright 1.59 (`@playwright/test`) - browser e2e against the mocked-Tauri Vite build. Config: `playwright.config.ts`, specs in `e2e/` (23 specs), Chromium project only
- `cargo test --lib` - Rust unit/integration tests colocated in `#[cfg(test)]` modules inside `src-tauri/src/`

**Build/Dev:**
- `@tauri-apps/cli` ^2.10 - `tauri dev` / `tauri build`
- `tauri-build` 2.5.4 - build script `src-tauri/build.rs`, also re-runs on `skills-bootstrap/` changes
- GNU Make - `Makefile` is the task SSOT (`make verify`, `make tauri-dev`, `make test`, `make release-preflight`, `make homebrew-update`)
- `tsc -b` project-references typecheck (`pnpm typecheck`)

## Key Dependencies

**Critical (frontend):**
- `@blocknote/core|react|mantine` ^0.49 - rich markdown editor (`src/components/RichMarkdownEditor.tsx`); always behind `React.lazy`, budget-enforced. Three call sites load it: `src/components/EditorPane.tsx`, `src/components/InlineDocumentEditor.tsx`, `src/components/ScratchpadPane.tsx`
- `@codemirror/*` ^6 (`state`, `view`, `commands`, `lang-markdown`) - used by exactly one component, the Studio source editor `src/components/studio/MarkdownSourceEditor.tsx`. The Documents / Files / Scratchpad "Source" tabs are a plain `<textarea>`, not CodeMirror
- `sigma` 3.0.3 + `@sigma/node-border` 3.0.0 + `@sigma/export-image` 3.0.0 + `graphology` 0.26 + `graphology-layout` 0.6.1 + `graphology-layout-forceatlas2` 0.10.1 (worker build) - WebGL knowledge graph (`src/lib/graph/`, `src/components/graph/GraphCanvas.tsx`); versions are pinned exactly, not caret-ranged
- `marked` ^18 + `dompurify` ^3.4 - markdown preview rendering and sanitization (`src/lib/markdown.ts`)
- `@radix-ui/react-dialog`, `@radix-ui/react-tabs` - the only UI primitives; everything else is hand-rolled. Radix Tabs is now wrapped once in `src/components/DocumentModeSurface.tsx` rather than re-declared per editor
- `lucide-react`, `react-icons` - icon sets
- `date-fns` ^3 - date math
- `@fontsource/noto-serif-kr` - bundled Korean serif; Pretendard is expected from the OS (`src/styles.css`)
- Tauri plugins: `plugin-updater`, `plugin-notification`, `plugin-dialog`, `plugin-clipboard-manager`, `plugin-process`

**Critical (Rust):**
- `alacritty_terminal` 0.26 + `portable-pty` 0.8 - native PTY terminal (`src-tauri/src/terminal/`)
- `walkdir` 2 + `rayon` 1 + `notify` 6 - parallel workspace scan, cached index, filesystem watchers (`src-tauri/src/workspace.rs`, `inbox_watcher.rs`, `vault_watcher.rs`, `scratchpad_watcher.rs`)
- `serde` / `serde_json` / `serde_yaml` 0.9 - IPC payloads, `.maru/*.json` state, frontmatter and `workspace.config.yaml` parsing
- `reqwest` 0.12 (blocking, rustls-tls, no default features) - the only HTTP client; used by `hub_client/http.rs` and `skill_host/bundle_update.rs`
- `minisign-verify` 0.2 + `sha2` 0.10 - signature and digest verification for OTA skill bundles
- `zip` 4.6 + `quick-xml` 0.39 + `encoding_rs` - HWPX/DOCX/XLSX container reading (`kordoc_lite.rs`, `binary_viewer.rs`)
- `chrono` + `chrono-tz` - timestamps, Korean date parsing (`korean_date.rs`), scheduler slots
- `include_dir` 0.7 - embeds `src-tauri/skills-bootstrap/` into the binary
- `trash` =4.1.1 (exact pin) - system-Trash file operations
- `similar` 2 - diffs for git view and gap analysis
- Platform: `objc2` / `block2` / `core-foundation-sys` on macOS; `windows-sys` 0.59 (JobObjects, Threading) on Windows

**Infrastructure:**
- `tempfile`, `uuid` v4, `dirs` 5, `mime_guess`, `regex`, `base64`, `unicode-width`

## Configuration

**Environment:**
- No `.env` in the repo; `.env*` is gitignored and the app reads no dotenv at runtime
- Vite exposes only `VITE_` and `TAURI_` prefixed vars (`envPrefix` in `vite.config.ts`)
- Runtime behavior is file-configured, not env-configured. Per-workspace state lives in `<workspace>/.maru/` (`workspace.json`, `settings.json`, `workspace-state.json`, `projects.json`, `mcp.json`, `inbox.json`, `secrets/`, `queue/hub/`, `binder/`, `drafts/`, `today/`, `schedules.json`) - layout documented at `src-tauri/src/maru_dir.rs:1`
- The frontend half of `settings.json` is typed and defaulted in `src/lib/settings.ts`: `MaruSettings` / `DEFAULT_MARU_SETTINGS` / `normalizeMaruSettings`. Every new UI preference must be added in all three places plus `cloneDefaultSettings`, or it silently resets on load. Pane sizes are declared as `{ defaultValue, min, max }` constants (e.g. `SCRATCHPAD_TREE_WIDTH`, `SCRATCHPAD_LIST_WIDTH`, `DRAFTS_LIST_WIDTH`) and clamped by `normalizePaneWidth`
- Global preferences live at `~/.maru/settings.json`; skills and their venv live at `~/.maru/skills/` and `~/.maru/env/` (`src-tauri/src/skill_host/env.rs`, `store.rs`)
- Provider wiring (Gmail/Outlook/Telegram/Kakao/Hub) is read from the workspace's `workspace.config.yaml` - see `src-tauri/src/telegram_io.rs`, `outlook_mso.rs`, `hub_client/mod.rs`
- Test/QA env overrides only: `MARU_TEST_HOME`, `MARU_TEST_CONFIG_DIR`, `MARU_MISSION_STATE_DIR`, `MARU_E2E_PORT`, `MARU_SKILLS_MANIFEST_URL`, `MARU_SKILLS_PUBKEY`, `MARU_HWPX_BIN`, `MARU_CLI_SMOKE`, `MARU_STARTUP_PROFILE`
- Release/signing env (CI + local release only): `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY_PATH`, `APPLE_TEAM_ID`, `MARU_RELEASE_REPO`, `MARU_HOMEBREW_TAP`

**Build:**
- `vite.config.ts` - React plugin, fixed dev host/port, env prefixes
- `src-tauri/tauri.conf.json` - product identity (`kr.maru.desktop`), window defaults, strict CSP (no remote origins in `default-src`/`connect-src`), asset protocol, updater endpoint and minisign pubkey, bundle targets `all` with updater artifacts, macOS resource `maru-cli`
- `src-tauri/tauri.passkeys.conf.json` + `Entitlements.plist` + `Info.passkeys.plist` - opt-in macOS browser-passkey build variant
- `scripts/check-bundle-budget.mjs` - gzip budget gate run as part of `pnpm build:frontend`; also asserts `GraphView`, `RichMarkdownEditor`, and the i18n dictionaries stay lazy chunks. Any new component that pulls BlockNote or the graph stack must go through `React.lazy` or this gate fails the build
- `scripts/generate-icons.mjs` (+ `icons:check`), `scripts/lint-i18n.mjs`, `scripts/check-select-chrome.mjs` - generated-asset and static guards wired into `make verify`. `lint-i18n.mjs` enforces key parity between `src/lib/i18n/locales/en.ts` and `ko.ts`

## Platform Requirements

**Development:**
- Node >= 22 with pnpm 9.15.0, Rust stable >= 1.77.2
- Linux additionally needs `libwebkit2gtk-4.1-dev` and the Tauri system deps installed in CI (`.github/workflows/ci.yml:154`)
- Playwright browsers via `pnpm exec playwright install chromium` for `make test-e2e`
- Optional external CLIs for full functionality: `claude`, `codex`, `kimi`, `kiro`, `gws`, `m365`, `dot`, `git`, `hwp` - all resolved through `src-tauri/src/cli_path.rs` with an augmented PATH, all optional at runtime

**Production:**
- Desktop app distributed as signed bundles from GitHub Releases (`STAIxBWLB/maru`), built by `.github/workflows/release-bundles.yml` on macOS (aarch64 + x86_64), Windows, and Ubuntu 22.04
- macOS delivery via Homebrew cask `maru-workspace` and CLI formula `maru-cli` (`packaging/homebrew/`, `scripts/update-homebrew-tap.mjs`); macOS builds are codesigned and notarized (`scripts/appleNotary.mjs`, `scripts/sign-macos-app-binaries.mjs`)
- In-app auto-update through `tauri-plugin-updater` against `latest.json` on the GitHub release, verified with the embedded minisign public key

---

*Stack analysis: 2026-08-22*
