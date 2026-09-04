# Maru Codebase Structure

**Analysis Date:** 2026-09-02

## Top-Level Layout

```text
maru/
├── src/                      # React frontend (Tauri webview)
│   ├── main.tsx              # Web entry: createRoot + split font CSS
│   ├── App.tsx               # App shell, mode routing, tabs (8,850 lines)
│   ├── foundations.css       # Design tokens
│   ├── styles.css            # Global stylesheet (26,434 lines)
│   ├── components/           # Rendered surfaces, one subdirectory per mode
│   ├── lib/                  # IPC facade, stores, pure logic, i18n
│   ├── approval/             # Approval gate dialog
│   ├── assets/brand/         # Seal SVGs + icon manifest
│   └── __tests__/            # Cross-module frontend tests
├── src-tauri/                # Rust core + Tauri app
│   ├── src/                  # Domain modules and command handlers (~93k lines)
│   ├── maru-cli/             # Standalone `maru` CLI binary crate
│   ├── skills-bootstrap/     # Embedded offline skills snapshot
│   ├── capabilities/         # Webview permission allowlists
│   ├── icons/                # Generated desktop/mobile icons
│   ├── bundle/macos/         # macOS bundle resources
│   ├── tauri.conf.json       # Window, CSP, updater, bundle config
│   └── Cargo.toml            # Cargo workspace root
├── sidecars/maru-mcp/        # Node stdio MCP server
├── e2e/                      # Playwright specs (23 specs)
├── e2e-native/               # WebdriverIO native E2E
├── scripts/                  # Build, verify, release, and guard scripts
├── docs/                     # Feature and policy documentation
├── packaging/homebrew/       # Cask + formula templates
├── public/                   # Static web assets
├── sample-workspace/         # Seed workspace embedded into the binary
├── Makefile                  # Canonical task runner
├── package.json              # pnpm scripts + frontend deps
├── playwright.config.ts      # E2E runner config
├── vite.config.ts            # Dev server (127.0.0.1:5307)
├── tsconfig*.json            # Project references
├── README.md                 # Project SSOT
├── ROADMAP.md                # Milestones and phases
└── CHANGELOG.md              # Release history
```

## `src/` Breakdown

### Entry points

- `src/main.tsx`: mounts the React root, lazy-loads Korean serif font CSS, imports design tokens.
- `src/App.tsx`: single shell component. Contains `App()` and `MainApp()`. Handles mode routing, editor tabs, workspace lifecycle, dialogs, and prop assembly for panes.

### `src/components/`

Every rendered surface. Flat `.tsx` files at the top are shell-level; subdirectories are per-mode or per-domain.

**Shell-level components:**

- `App.tsx` — shell itself.
- `EditorPane.tsx` — Documents editor with tabs, find, wikilinks, KG highlight.
- `EditorPaneFacade.tsx` — adapter between `EditorPane` and `App.tsx`.
- `DocumentModeSurface.tsx` — shared rich/source/preview tab chrome.
- `InlineDocumentEditor.tsx` — docked editor for non-Documents modes.
- `FilesWorkbench.tsx` — file tree/list/preview explorer.
- `ScratchpadPane.tsx` — scratchpad list, virtual folders, editor, autosave.
- `OutlinePane.tsx` — outline + file queue + mini explorer.
- `TerminalPanel.tsx`, `NativeTerminalView.tsx` — terminal UI.
- `CommandPalette.tsx`, `CommitDialog.tsx`, `NewDocumentDialog.tsx`, `AddWorkspaceDialog.tsx`, `WorkspaceSwitcher.tsx`.
- `ui/` — shared primitives: `Button`, `Field`, `Toggle`, `DialogSurface`, `ModeChrome`, `PaneResizeHandle`, `SortModeToggle`.

**Per-mode subdirectories (22):**

- `agents/`, `binaryViewers/`, `calendar/`, `catalog/`, `comms/`, `dashboard/`, `diagram/` (`canvas/`, `modals/`, `panels/`, `ribbon/`), `drafts/`, `e2e/`, `evidence/`, `gap/`, `graph/`, `inbox/`, `jobs/`, `meetings/`, `settings/` (`tabs/`), `sites/`, `skills/`, `studio/`, `tasks/`, `today/`.

### `src/lib/`

The only layer allowed to call Tauri. ~135k lines of TypeScript including tests.

**Core files:**

- `api.ts` (3,762 lines) — IPC facade: every `invoke()` + browser mocks.
- `types.ts` (1,393 lines) — shared TypeScript types mirroring Rust contracts.
- `settings.ts` (2,473 lines) — `MaruSettings`, `MaruAppMode`, parse/normalize/persist.
- `fixtures.ts` — mock data for browser-mode dev and tests.

**Stores (module-level, `useSyncExternalStore`):**

- `workspaceStore.ts` — workspace registry, document index, file-tree twins.
- `editorTabsStore.ts` — open tabs, split groups, active ids, drafts.
- `editorPaneStore.ts`, `editorSurfaceStore.ts` — document surface state.
- `outlinePaneStore.ts` — outline/file-queue state.
- `documentBrowserStore.ts`, `documentOpsModeStore.ts`.
- `appOverlayStore.ts` — dialog/command-palette/settings overlay state.
- `errorStore.ts`, `shellSettingsStore.ts`, `telegramEventsStore.ts`.

**Feature logic modules:**

- `today.ts`, `tasks.ts`, `inbox.ts`, `scratchpad.ts`, `scratchpadTree.ts`, `drafts.ts`, `gapAnalysis.ts`, `meetings.ts`, `comms.ts`, `sites.ts`, `skills.ts`, `skillRuns.ts`, `agents.ts`, `agentChat.ts`, `agentCapabilities.ts`.
- Subdirectories: `calendar/`, `diagram/` (~40 pure modules), `graph/` (with `analysis.worker.ts`), `i18n/locales/` (`ko.ts`, `en.ts`), `modeAdapters/`.

**Hooks:**

- `useActiveMissions.ts`, `useKeyboardShortcuts.ts`, `useInboxEvents.ts`, `useTelegramEvents.ts`, `useUpdaterToasts.ts`, `useWorkspaceConfigLoad.ts`, `useDestructiveActionGuard.ts`, etc.

**Mode adapters (`src/lib/modeAdapters/`):**

One adapter per mode: `TodayModeAdapter.tsx`, `TasksModeAdapter.tsx`, `DiagramModeAdapter.tsx`, `GraphModeAdapter.tsx`, etc. Each adapts a mode to the `ModeSurfaceHost` contract.

### Other `src/` directories

- `src/approval/` — `ApprovalDialog.tsx`.
- `src/assets/brand/` — Maru seal SVGs and `icon-manifest.json`.
- `src/__tests__/` — Cross-module frontend tests.

## `src-tauri/src/` Breakdown

### Entry points

- `src-tauri/src/main.rs` — native entry; `--maru-cli` routes to headless CLI.
- `src-tauri/src/lib.rs` — Tauri builder, plugin registration, managed state, command registry (365 commands).
- `src-tauri/src/cli.rs` — headless subcommands (`doctor`, `secrets`, `skills`, `jobs`, `terminal-hook`).

### Core infrastructure

- `vault.rs` — workspace scanner + cache.
- `vault_list.rs` — workspace registry, root add/remove/activate.
- `vault_guard.rs` — write gating and validation.
- `vault_graph.rs`, `vault_watcher.rs` — graph view and file watching.
- `workspace.rs` — `workspace.config.yaml` detection and registration.
- `workspace_files.rs` — file-tree mutations.
- `document.rs` — document CRUD and versioning.
- `frontmatter/` — safe YAML read/write preserving comments.
- `atomic_file.rs` — atomic temp-file writes.
- `filename_rules.rs` — path/name validation.
- `maru_dir.rs` — `.maru/` system directory helpers.
- `paths.rs` — path constants and helpers.

### Domain modules

- **Today / Tasks:** `today.rs`, `today_store.rs`, `today_lifecycle.rs`, `today_ai.rs`, `today_calendar.rs`, `today_outbox.rs`, `today_notify.rs`, `tasks.rs`.
- **Inbox / Comms:** `inbox.rs`, `inbox_classifier.rs`, `inbox_drop.rs`, `inbox_settings.rs`, `inbox_watcher.rs`, `gmail_gws.rs`, `outlook_mso.rs`, `telegram_config.rs`, `telegram_io.rs`, `kakao_relay.rs`, `share_outbox.rs`.
- **Scratchpad / Drafts:** `scratchpad.rs`, `scratchpad_watcher.rs`, `drafts.rs`, `shelf.rs`.
- **Skills / Agents:** `skill_host/` (`store.rs`, `dispatch.rs`, `bundle_update.rs`, `env.rs`, `fs.rs`), `agents.rs`, `agent_host/` (`mod.rs`, `provider.rs`, `structured_loop.rs`, `proposal.rs`, `event_store.rs`, `roles.rs`, `status.rs`, `contracts.rs`, `protected_write.rs`, `marketplace.rs`, `cloud_dashboard.rs`), `agent_runtime_env.rs`, `mission_state.rs`, `scheduler.rs`.
- **Terminal:** `terminal/` (`mod.rs`, `model.rs`, `input.rs`, `snapshot.rs`), `terminal_hooks.rs`, `command_output.rs`.
- **Diagram / Graph:** `diagram/mod.rs`, `graph_authoring.rs`, `vault_graph.rs`.
- **Export / Studio:** `export/`, `studio/`, `html_editor.rs`, `template_fill.rs`, `hwped.rs`, `hwp_cli_template.rs`, `kordoc_lite.rs`, `linter/`.
- **Hub / Sites:** `hub_client/`, `sites.rs`, `site_view.rs`, `browser_passkeys.rs`, `web_actions.rs`.
- **Ops / Catalog:** `ops_catalog/` (`mod.rs`, `index.rs`, `scan.rs`, `watcher.rs`), `project_activity.rs`, `jobs.rs`, `dot_sync.rs`.
- **Utils:** `korean_date.rs`, `calendar_search.rs`, `content_search.rs`, `evidence_binder.rs`, `git.rs`, `kg_refs.rs`, `meetings.rs`, `ipc_error.rs`, `secrets.rs`.

### State-managed singletons

`InboxWatcherState`, `VaultWatcherState`, `ScratchpadWatcherState`, `TelegramIoState`, `TerminalState`, `TerminalHookWatcherState`, `ApprovalState`, `MissionState`, `CatalogWatcherState`, `BrowserPasskeyState`, `SiteOpenedUrlState`.

## `e2e/` and `e2e-native/`

- `e2e/*.spec.ts` — 23 Playwright specs covering startup, smoke, today, tasks, inbox, comms, dashboard, graph, diagram, drafts, gap, agents, workbench layout, HTML editor, brand assets, and the Maru end-to-end flow.
- `e2e/helpers/todayFixtures.ts` — shared test data.
- `e2e-native/` — WebdriverIO native E2E configuration and specs.

## `scripts/`

Node tooling invoked from `package.json` and `Makefile`:

- `check-bundle-budget.mjs` — enforces entry-chunk size.
- `check-release-version.mjs` — keeps version in sync across `package.json`, `Cargo.toml`, `tauri.conf.json`.
- `check-native-e2e-isolation.mjs` — guards native-E2E code from release builds.
- `generate-icons.mjs` — generates Tauri icon sets.
- `lint-i18n.mjs` — i18n key validation.
- `skills-bootstrap-refresh.mjs` — refreshes embedded skill snapshot.
- `e2e-mcp-smoke.mjs` — MCP sidecar smoke test.
- `lib/` — shared script utilities (`releaseVersion.mjs`, `updaterManifest.mjs`, `appleNotary.mjs`, etc.).

## Naming Conventions

### Files

- React components: `PascalCase.tsx` (`DocumentModeSurface.tsx`, `today/TodayPane.tsx`).
- Frontend logic/stores/hooks: `camelCase.ts` (`scratchpadTree.ts`, `workspaceStore.ts`, `useActiveMissions.ts`).
- Tests: sibling `<name>.test.ts(x)`; benches `<name>.bench.ts`; fixtures `fixtures.ts` or `__fixtures__/`.
- Rust: `snake_case.rs`; multi-file features use `<feature>/mod.rs`.
- Node scripts: `kebab-case.mjs`.
- E2E specs: `kebab-case.spec.ts`.
- Scoped CSS: `<domain>.css` inside component directory (`graph/graph.css`, `diagram/diagram.css`).

### Directories

- Frontend: lowercase single words matching the mode id (`today/`, `tasks/`, `drafts/`); `binaryViewers/` is the camelCase exception.
- Rust: `snake_case`.

### Symbols

- Rust commands: `snake_case` verbs, feature-prefixed (`today_open`, `diagram_save_document`, `skills_list_sources`).
- Frontend facade functions: `camelCase` mirror of command name (`todayOpen`, `diagramSaveDocument`, `skillsListSources`).
- Rust IPC structs: `#[serde(rename_all = "camelCase")]` so TypeScript sees camelCase fields.
- Tauri events: `namespace://event_name` (`vault://index-delta`, `ai://output`, `skills://updated`).
- i18n keys: dot-namespaced (`system.tab.secrets`, `scratchpad.tree.title`).
- Store helpers: exported pure `<verb>InState` functions + thin `use<Slice>()` hooks.
- Settings keys: `ui.<feature><Thing>` for view state, `ui.layout.<feature><Thing>` for geometry.

## Where Features Live

### Add a new Tauri command

1. Implement in `src-tauri/src/<feature>.rs` or `src-tauri/src/<feature>/mod.rs`.
2. Mark `#[tauri::command(async)]` for non-trivial filesystem/subprocess work; return `Result<T, String>`.
3. Register in `src-tauri/src/lib.rs`: add `use <feature>::{...}` and the name in `generate_handler![]`.
4. Add frontend wrapper in `src/lib/api.ts` with a browser-mode mock in `src/lib/fixtures.ts`.
5. Add Rust `#[cfg(test)]` module and/or frontend `*.test.ts(x)`.

### Add a new mode

1. Add mode id to `MaruAppMode` in `src/lib/settings.ts` and update `modeRegistry.tsx`.
2. Create pane in `src/components/<mode>/<Mode>Pane.tsx` and adapter in `src/lib/modeAdapters/<Mode>ModeAdapter.tsx`.
3. Add lazy import branch in `src/App.tsx` surface-mode chain.
4. Add settings/layout keys as needed.

### Add a new frontend store

1. Create `src/lib/<domain>Store.ts`.
2. Export pure `*InState` helpers, `getState()`, `subscribe()`, action setters, and `use<Slice>()` hooks via `useSyncExternalStore`.
3. Co-locate tests in `src/lib/<domain>Store.test.ts`.
