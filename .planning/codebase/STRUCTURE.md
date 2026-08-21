# Codebase Structure

**Analysis Date:** 2026-08-22

## Directory Layout

```
maru/
├── src/                      # React frontend (Tauri webview)
│   ├── main.tsx              # Web entry: createRoot + font chunks
│   ├── App.tsx               # App shell, mode routing, editor tabs (9,337 lines)
│   ├── foundations.css       # Design tokens (type scale, shell geometry, colors)
│   ├── styles.css            # Global stylesheet (26,095 lines)
│   ├── components/           # UI components, one subdirectory per mode
│   ├── lib/                  # IPC facade, pure logic, stores, hooks, i18n
│   ├── approval/             # Approval gate dialog
│   ├── assets/brand/         # Seal SVGs + icon manifest
│   └── __tests__/            # Cross-module frontend tests
├── src-tauri/                # Rust core + Tauri app
│   ├── src/                  # Domain modules and command handlers
│   ├── maru-cli/             # Standalone `maru` CLI binary crate
│   ├── skills-bootstrap/     # Embedded offline skills snapshot (include_dir!)
│   ├── capabilities/         # Tauri webview permission allowlist
│   ├── icons/                # Generated desktop/iOS/Android icons
│   ├── bundle/macos/         # macOS bundle resources
│   ├── tauri.conf.json       # Window, CSP, updater, bundle config
│   └── Cargo.toml            # Cargo workspace root (`.` + `maru-cli`)
├── sidecars/maru-mcp/        # Node stdio MCP server
├── e2e/                      # Playwright specs + helpers
├── scripts/                  # Build, verify, release, and guard scripts (.mjs)
├── docs/                     # Feature and policy documentation
├── packaging/homebrew/       # Cask + formula templates
├── public/                   # Static web assets (favicons, manifest)
├── sample-workspace/         # Seed workspace embedded into the binary
├── Makefile                  # Canonical task runner
├── package.json              # pnpm scripts + frontend deps
├── playwright.config.ts      # E2E runner config
├── vite.config.ts            # Dev server (127.0.0.1:5307) + React plugin
├── tsconfig*.json            # Project references: app + node
├── README.md                 # Primary project SSOT (architecture, modes, invariants)
└── ROADMAP.md / CHANGELOG.md # Plan and release history
```

## Directory Purposes

**`src/components/`:**
- Purpose: Every rendered surface. Flat `.tsx` files are shell-level components; subdirectories are per-mode or per-domain.
- Contains: `agents/`, `binaryViewers/`, `calendar/`, `catalog/`, `comms/`, `dashboard/`, `diagram/` (with `canvas/`, `modals/`, `panels/`, `ribbon/`), `drafts/`, `e2e/`, `evidence/`, `gap/`, `graph/`, `inbox/`, `jobs/`, `meetings/`, `settings/` (with `tabs/`), `sites/`, `skills/`, `studio/`, `tasks/`, `today/`, `ui/`.
- Key files: `src/components/EditorPane.tsx`, `src/components/TerminalPanel.tsx`, `src/components/FilesWorkbench.tsx`, `src/components/CommandPalette.tsx`, `src/components/ui/` (shared `Button`, `Field`, `Toggle`, `DialogSurface`, `ModeChrome`, `PaneResizeHandle`).

**`src/lib/`:**
- Purpose: Everything non-visual. The only layer allowed to call Tauri.
- Contains: the IPC facade, feature logic modules, `*Store.ts` module stores, `use*.ts` hooks, shared `types.ts`, and `i18n/`.
- Key files: `src/lib/api.ts` (3,739 lines), `src/lib/settings.ts` (2,430), `src/lib/types.ts` (1,370), `src/lib/workspaceStore.ts`, `src/lib/editorTabsStore.ts`, `src/lib/errorStore.ts`, `src/lib/fixtures.ts` (browser-mode mock data).
- Subdirectories: `calendar/`, `diagram/` (the largest, ~40 pure modules with paired tests), `graph/` (includes `analysis.worker.ts`), `i18n/locales/`.

**`src-tauri/src/`:**
- Purpose: The Rust core. One module per feature; `lib.rs` is the only aggregator.
- Contains: ~80 flat `.rs` modules plus 10 module directories (`agent_host/`, `skill_host/`, `terminal/`, `ops_catalog/`, `export/`, `hub_client/`, `frontmatter/`, `studio/`, `diagram/`, `linter/`).
- Key files: `src-tauri/src/lib.rs` (builder + command registry), `src-tauri/src/main.rs` (argv split), `src-tauri/src/cli.rs` (headless subcommands), `src-tauri/src/vault.rs` (scanner + cache), `src-tauri/src/document.rs`, `src-tauri/src/atomic_file.rs`, `src-tauri/src/skill_host/store.rs` (7,878 lines), `src-tauri/src/inbox.rs` (4,438).

**`scripts/`:**
- Purpose: Node build/verify/release tooling invoked from `package.json` and `Makefile`.
- Key files: `scripts/check-bundle-budget.mjs`, `scripts/lint-i18n.mjs`, `scripts/generate-icons.mjs`, `scripts/check-release-version.mjs`, `scripts/tauri-window-policy.test.mjs`, `scripts/skills-bootstrap-refresh.mjs`, `scripts/update-homebrew-tap.mjs`, `scripts/e2e-mcp-smoke.mjs`.
- Note: `scripts/` is included in the vitest run (`vitest run src scripts`), so `*.test.mjs` here executes as a unit test.

**`e2e/`:**
- Purpose: Playwright specs driving the browser (mocked-Tauri) build, one spec per mode or feature.
- Key files: `e2e/smoke.spec.ts`, `e2e/startup.spec.ts`, `e2e/graph.spec.ts` + `e2e/graph-shell.spec.ts` (split behavior/shell), `e2e/helpers/`.

**`docs/`:**
- Purpose: Long-form feature and policy documents referenced from `README.md`.
- Key files: `docs/BOUNDARIES.md` (Maru vs dotfiles-v2 file ownership), `docs/SSOT-TIERS.md` (skill tier ownership), `docs/agents.md`, `docs/drafts.md`, `docs/graph.md`, `docs/diagram.md`, `docs/studio.md`, `docs/gap-analysis.md`, `docs/kg-references.md`, `docs/perf-baseline.md`.

## Key File Locations

**Entry Points:**
- `src/main.tsx`: React root mount.
- `src/App.tsx`: `App()` at line 739, `MainApp()` at line 774.
- `src-tauri/src/main.rs`: native entry; `--maru-cli` routes to the CLI.
- `src-tauri/src/lib.rs:272`: `run()`: Tauri builder, managed state, command registry.
- `src-tauri/maru-cli/src/main.rs`: standalone CLI binary.
- `sidecars/maru-mcp/index.mjs`: MCP stdio server.

**Configuration:**
- `src-tauri/tauri.conf.json`: window policy, CSP, asset protocol, updater, bundle identifier `kr.maru.desktop`.
- `src-tauri/capabilities/default.json`: webview permission allowlist for `main` and `skill-editor` windows.
- `vite.config.ts`, `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json`, `playwright.config.ts`.
- `package.json` (version SSOT mirrored into `src-tauri/Cargo.toml` and `tauri.conf.json`; enforced by `scripts/check-release-version.mjs`).
- `.gitignore` plus local-only `.git/info/exclude` (excludes `.context/`, `graphify-out/`, `.conductor/settings.local.*`).

**Core Logic:**
- Frontend IPC: `src/lib/api.ts`
- Frontend state: `src/lib/workspaceStore.ts`, `src/lib/editorTabsStore.ts`, `src/lib/errorStore.ts`, `src/lib/appOverlayStore.ts`
- Backend registry: `src-tauri/src/lib.rs`
- Backend write path: `src-tauri/src/document.rs`, `src-tauri/src/frontmatter/ops.rs`, `src-tauri/src/atomic_file.rs`
- Backend guards: `src-tauri/src/vault_guard.rs`, `src-tauri/src/vault_list.rs`, `src-tauri/src/filename_rules.rs`

**Testing:**
- Frontend unit: co-located `src/**/*.test.ts(x)` plus `src/__tests__/`
- Rust unit: `#[cfg(test)]` modules inside each `.rs` (one extracted file: `src-tauri/src/frontmatter/ops_update_tests.rs`)
- E2E: `e2e/*.spec.ts`
- Bench: `src/lib/graph/perf.bench.ts`, `src/lib/diagram/perf.bench.ts`

## Naming Conventions

**Files:**
- React components: `PascalCase.tsx` (`src/components/DocumentList.tsx`, `src/components/today/TodayPane.tsx`).
- Frontend logic/stores/hooks: `camelCase.ts` (`src/lib/todayPlan.ts`, `src/lib/workspaceStore.ts`, `src/lib/useActiveMissions.ts`).
- Tests: sibling `<name>.test.ts` / `<name>.test.tsx`; benches `<name>.bench.ts`; fixtures `fixtures.ts` or `__fixtures__/`.
- Rust: `snake_case.rs`, one module per feature; multi-file features use `<feature>/mod.rs`.
- Node scripts: `kebab-case.mjs`.
- E2E specs: `kebab-case.spec.ts`.
- Scoped CSS: `<domain>.css` inside the component directory (`src/components/graph/graph.css`).

**Directories:**
- Frontend: lowercase camelCase-free single words matching the mode id (`today/`, `tasks/`, `drafts/`, `binaryViewers/` is the one camelCase exception).
- Rust: `snake_case`.

**Symbols:**
- Rust commands: `snake_case` verbs, feature-prefixed (`skills_list_sources`, `today_open`, `diagram_save_document`).
- Frontend facade functions: `camelCase` mirror of the command name (`skillsListSources`, `todayOpen`).
- Rust structs crossing IPC: `#[serde(rename_all = "camelCase")]` so TypeScript sees camelCase fields.
- Tauri events: `namespace://event_name` (`vault://index-delta`, `ai://output`, `skills://updated`).
- i18n keys: dot-namespaced (`system.tab.secrets`, `app.unsaved.title`).
- Store internals: exported pure `<verb>InState` helpers, thin `use<Slice>()` hooks.

## Where to Add New Code

**New backend capability (Tauri command):**
1. Implementation: `src-tauri/src/<feature>.rs` (or `src-tauri/src/<feature>/mod.rs` if it needs more than one file).
2. Mark `#[tauri::command(async)]` when it does non-trivial filesystem or subprocess work; return `Result<T, String>`.
3. Register in `src-tauri/src/lib.rs`: add the `use <feature>::{...}` line and the name inside `tauri::generate_handler![]`.
4. Frontend wrapper: `src/lib/api.ts`, with an `if (!isTauri())` mock branch backed by `src/lib/fixtures.ts`.
5. Tests: `#[cfg(test)]` module in the same `.rs`; frontend behavior in `src/lib/api.test.ts` or the owning feature test.

**New feature / mode:**
- Mode id: add to `MaruAppMode` in `src/lib/settings.ts:25` and to the mode table in `README.md`.
- Pane: `src/components/<mode>/<Mode>Pane.tsx`; register a `lazy()` import near `src/App.tsx:500` and add the branch in the surface-mode chain.
- Logic: `src/lib/<mode>.ts` with a sibling `src/lib/<mode>.test.ts`.
- Strings: add every key to both `src/lib/i18n/locales/ko.ts` and `src/lib/i18n/locales/en.ts` in the same change.
- Styles: prefer a scoped `src/components/<mode>/<mode>.css` over appending to `src/styles.css`.
- E2E: `e2e/<mode>.spec.ts`.

**New component:**
- Mode-specific: `src/components/<mode>/`.
- Shell-level (used by `App.tsx` directly): `src/components/`.
- Reusable primitive: `src/components/ui/`.

**New shared state:**
- `src/lib/<name>Store.ts` following `src/lib/errorStore.ts`: module state, `publish()`, `useSyncExternalStore` hook, exported pure helpers for testing. Do not add another prop to `MainApp`.

**Utilities:**
- Frontend: `src/lib/<topic>.ts` (there is no `utils.ts` catch-all; keep helpers with their topic).
- Rust: `src-tauri/src/atomic_file.rs` for writes, `src-tauri/src/vault.rs` for path resolution and slugging, `src-tauri/src/filename_rules.rs` for name validation.

**New skill:**
- Not in this repo. Bundled (T1) skills ship from the `STAIxBWLB/skills` repo through the `skills-channel` OTA bundle; `src-tauri/skills-bootstrap/` is a generated snapshot refreshed with `pnpm exec node scripts/skills-bootstrap-refresh.mjs` (`make skills-bootstrap-refresh`). See `docs/SSOT-TIERS.md`.

## Special Directories

**`src-tauri/skills-bootstrap/`:**
- Purpose: Offline first-run seed for the skills registry, embedded via `include_dir!` at `src-tauri/src/skill_host/store.rs:43`.
- Generated: Yes (`scripts/skills-bootstrap-refresh.mjs`).
- Committed: Yes. Never hand-edit; it can never downgrade an applied OTA bundle.

**`sample-workspace/`:**
- Purpose: Demo workspace embedded via `include_dir!` at `src-tauri/src/vault.rs:36` and unpacked by `sample_workspace_path`.
- Generated: No.
- Committed: Yes.

**`src-tauri/icons/`, `public/icons/`, `src/assets/brand/`:**
- Purpose: Generated icon sets (web, macOS, Windows, iOS, Android) derived from the brand SVGs.
- Generated: Yes (`pnpm icons:generate`); staleness fails `pnpm icons:check` and `make verify`.
- Committed: Yes (explicit `.gitignore` negations keep them tracked).

**`src-tauri/gen/schemas/`:**
- Purpose: Tauri-generated capability schemas.
- Generated: Yes. Committed: No (gitignored).

**`dist/`, `src-tauri/target/`, `test-results/`, `node_modules/`, `.pnpm-store/`:**
- Purpose: Build output, Cargo artifacts, Playwright results, dependencies.
- Generated: Yes. Committed: No.

**`graphify-out/`:**
- Purpose: `/graph-bridge` code-graph analysis output.
- Generated: Yes. Committed: No (excluded via `.git/info/exclude`).

**`.planning/codebase/`:**
- Purpose: GSD codebase map documents (this file, `ARCHITECTURE.md`, and the tech/quality/concerns set).
- Generated: Yes (by the GSD mapper agents). Committed: Yes.

**`.omc/`, `.omx/`, `.conductor/`, `.context/`, `.superpowers/`, `.claude/`:**
- Purpose: Agent tooling state and project-local agent config.
- Generated: Mostly. Committed: only `.claude/` non-local files; the rest are ignored.

**`Users/`, `skills/` (repo root):**
- Purpose: None. Both are stray empty directory trees left by earlier tool runs (`Users/yj.lee/.maru/env/node_modules`, `skills/**/__pycache__`); they hold zero tracked or untracked real files. Safe to delete; do not add code to either. The real skill source lives in `src-tauri/skills-bootstrap/`.

---

*Structure analysis: 2026-08-22*
