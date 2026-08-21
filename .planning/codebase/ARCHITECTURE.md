<!-- refreshed: 2026-08-22 -->
# Architecture

**Analysis Date:** 2026-08-22

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                  Tauri Webview (React 19)                    │
├──────────────────┬──────────────────┬───────────────────────┤
│  App shell       │  Mode panes      │  Frontend lib layer   │
│  `src/App.tsx`   │ `src/components/`│  `src/lib/`           │
│  activity rail,  │  18 lazy-loaded  │  IPC facade + pure    │
│  editor tabs,    │  mode surfaces   │  logic + stores       │
│  panels, dialogs │                  │  `src/lib/api.ts`     │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         │  invoke()        │  Channel<T>         │  listen()
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Tauri command layer (356 commands)              │
│         `src-tauri/src/lib.rs` : generate_handler![]         │
│         11 managed state singletons via `.manage()`          │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Rust domain modules (~90k lines)              │
│  workspace/vault scan+cache · document+frontmatter · git     │
│  inbox + providers (gws/mso/telegram/kakao) · tasks/today    │
│  skill_host · agent_host · terminal (PTY) · ops_catalog      │
│  export · studio · diagram · hub_client · linter · secrets   │
└──────┬───────────────────┬──────────────────┬───────────────┘
       │                   │                  │
       ▼                   ▼                  ▼
┌──────────────┐  ┌──────────────────┐  ┌────────────────────┐
│ Filesystem   │  │ External CLIs    │  │ MCP sidecar (Node) │
│ workspace/   │  │ claude/codex/    │  │ `sidecars/         │
│ `.maru/`     │  │ kimi/kiro, git,  │  │  maru-mcp/         │
│ `~/.maru/`   │  │ gws, m365, dot   │  │  index.mjs`        │
└──────────────┘  └──────────────────┘  └────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Web entry | Mounts React root, loads split display fonts, marks startup profile | `src/main.tsx` |
| App shell | Activity rail, mode routing, editor tabs, panels, dialogs, prop assembly | `src/App.tsx` |
| IPC facade | Every `invoke()` call plus a browser-mode mock fallback | `src/lib/api.ts` |
| Settings model | `MaruAppMode`, layered settings parse/normalize/persist | `src/lib/settings.ts` |
| Workspace store | Workspace registry, document index, file tree, watcher lifecycle | `src/lib/workspaceStore.ts` |
| Editor tabs store | Open tabs, split groups, active/focus ids, draft content | `src/lib/editorTabsStore.ts` |
| i18n | ko/en dictionaries as lazy chunks, `useTranslation()`/`t()` | `src/lib/i18n.ts` |
| Rust entry | Argv split: `--maru-cli` → CLI, otherwise desktop app | `src-tauri/src/main.rs` |
| Tauri builder | Plugins, menu, managed state, setup hooks, command registry | `src-tauri/src/lib.rs:272` |
| CLI dispatcher | `doctor`/`secrets`/`skills`/`jobs`/`terminal-hook` subcommands | `src-tauri/src/cli.rs` |
| Workspace scanner | walkdir + `.maruignore` + fingerprinted warm cache | `src-tauri/src/vault.rs` |
| Document I/O | read/save/create/version/move/trash + revision check | `src-tauri/src/document.rs` |
| Frontmatter ops | Only allowed YAML write path; preserves key order and comments | `src-tauri/src/frontmatter/ops.rs` |
| Atomic writes | Temp file in same dir + persist, permission-preserving | `src-tauri/src/atomic_file.rs` |
| Skills registry | Federated skill catalog, sources, installs, OTA bundle apply | `src-tauri/src/skill_host/store.rs` |
| Agent host | Provider probes, structured loop, proposals, protected writes | `src-tauri/src/agent_host/` |
| Terminal | Alacritty screen model over `portable-pty`, frame streaming | `src-tauri/src/terminal/mod.rs` |
| MCP sidecar | Local read-first MCP server over stdio | `sidecars/maru-mcp/index.mjs` |

## Pattern Overview

**Overall:** Local-first Tauri 2 desktop app: a thin React shell over a thick Rust core, with the filesystem as the single source of truth.

**Key Characteristics:**
- All business logic lives in Rust; React owns rendering, editing surfaces, and layout only (README "Module boundary rules").
- Every backend call goes through one facade module, `src/lib/api.ts`, which also supplies browser-mode mocks so `pnpm dev` runs without Tauri.
- State lives in module-level stores read through `useSyncExternalStore`; no Redux/Zustand/Context-provider tree for app state.
- Mode surfaces are `React.lazy` chunks, keeping the entry bundle inside a budget enforced by `scripts/check-bundle-budget.mjs`.
- Backend↔frontend push uses named Tauri events (`vault://index-delta`, `ai://output`, and so on) and typed `Channel<T>` streams for high-rate terminal frames.
- Rust modules are flat, one file (or one directory) per feature, each exporting its own `#[tauri::command]` functions that `lib.rs` re-exports.

## Layers

**React shell (`src/App.tsx`, `src/components/`):**
- Purpose: Render the activity rail, the active mode surface, editor tabs, the bottom/right tool panel, and dialogs.
- Location: `src/App.tsx`, `src/components/**`
- Contains: `.tsx` components, per-mode subdirectories, shared primitives in `src/components/ui/`.
- Depends on: `src/lib/**` (API, stores, pure logic, i18n).
- Used by: nothing; this is the top.

**Frontend lib layer (`src/lib/`):**
- Purpose: The only place that talks to Tauri, plus pure, unit-testable domain logic and state stores.
- Location: `src/lib/**`
- Contains: `api.ts` (IPC facade), feature modules (`today.ts`, `skills.ts`, `inbox.ts`, and so on), stores (`*Store.ts`), hooks (`use*.ts`), `types.ts`, `i18n/`.
- Depends on: `@tauri-apps/api`, nothing from `src/components/` except one type import in `src/lib/appOverlayStore.ts:3`.
- Used by: `src/App.tsx` and every component.

**Tauri command layer (`src-tauri/src/lib.rs`):**
- Purpose: Register plugins, managed state, the app menu, setup hooks, and all 356 commands.
- Location: `src-tauri/src/lib.rs`
- Contains: `use` re-exports per module and one `tauri::generate_handler![]` list.
- Depends on: every Rust domain module.
- Used by: `src-tauri/src/main.rs`.

**Rust domain modules (`src-tauri/src/*.rs`, `src-tauri/src/*/`):**
- Purpose: Own the filesystem, cache, git, providers, skills, agents, PTY, and export pipelines.
- Location: `src-tauri/src/**`
- Contains: One module per feature; larger features get a directory with `mod.rs` (`agent_host/`, `skill_host/`, `terminal/`, `ops_catalog/`, `export/`, `hub_client/`, `frontmatter/`, `studio/`, `diagram/`, `linter/`).
- Depends on: shared helpers `atomic_file.rs`, `vault.rs` (path resolution), `vault_guard.rs`/`vault_list.rs` (write gating), `frontmatter/`.
- Used by: `lib.rs` and `cli.rs`.

**Sidecar (`sidecars/maru-mcp/`):**
- Purpose: Local read-first MCP server (`workspace.search`, `document.read`, `skill.list`) over stdio.
- Location: `sidecars/maru-mcp/index.mjs`
- Depends on: Node ≥20.19 and `MARU_MCP_WORKSPACE`.
- Used by: external agent CLIs, smoke-tested by `scripts/e2e-mcp-smoke.mjs`.

## Data Flow

### Primary Request Path (document open → edit → save)

1. User picks a document in the explorer; `MainApp` calls the facade (`src/App.tsx:774`).
2. `readDocument()` invokes `read_document` (`src/lib/api.ts`).
3. Rust resolves the path lexically inside the workspace, parses frontmatter, and returns a `DocumentPayload` carrying a `revision` digest (`src-tauri/src/document.rs:83`).
4. The payload becomes an `EditorTab` in the tabs store (`src/lib/editorTabsStore.ts`).
5. Edits update `draftContent`; a debounced saver serializes writes (`src/lib/debouncedSave.ts`).
6. `saveDocument(root, path, content, expectedRevision)` invokes `save_document` (`src/lib/api.ts:1077`, called at `src/App.tsx:4717`).
7. Rust checks the expected revision, runs the managed-write guard, then writes atomically (`src-tauri/src/document.rs:135` → `src-tauri/src/atomic_file.rs:12`).

### Workspace change propagation (watcher delta)

1. `start_vault_watcher` registers a `notify` watcher on the active workspace (`src-tauri/src/vault_watcher.rs`).
2. Filesystem events are debounced, mapped to workspace-relative paths, and emitted as `vault://index-delta` (`src-tauri/src/vault_watcher.rs:103`).
3. `workspaceStore` listens and calls `scanVaultPaths()` for only the touched paths (`src/lib/workspaceStore.ts:533`).
4. The returned entries are merged into the module store; absent paths are treated as removals, and subscribers re-render.

### AI mission / agent run

1. A mode pane or the command palette starts a run via `start_agent_cli_invocation` / `start_claude_cli_invocation` (`src-tauri/src/ai_router.rs:57`).
2. Rust spawns the provider CLI, registers the run in `MissionState`, and streams `ai://output`, then `ai://done` or `ai://error` (`src-tauri/src/ai_router.rs`, `src-tauri/src/mission_state.rs`).
3. `src/lib/useActiveMissions.ts` and `src/lib/missionProgress.ts` fold those events into store state consumed by `MissionBadge` and the per-mode run panels.
4. Draft artifacts land under `$MARU_DRAFTS` and `.maru/drafts/index.json`; `drafts://changed` refreshes the Drafts pane.

### Terminal frames

1. `terminal_spawn` receives a `Channel<TerminalStreamMessage>` from the frontend (`src-tauri/src/terminal/mod.rs:347`).
2. The Rust Alacritty model owns the screen, selection, and scrollback; it pushes ordered, generation-tagged frames with at most two in flight.
3. The canvas view applies frames and calls `terminal_ack`; a sequence or dimension mismatch triggers `terminal_request_full` (`src/components/NativeTerminalView.tsx`).

**State Management:**
- Module-level state object + `publish()` + `useSyncExternalStore` per slice. Stores: `src/lib/workspaceStore.ts`, `src/lib/editorTabsStore.ts`, `src/lib/errorStore.ts`, `src/lib/appOverlayStore.ts`, `src/lib/telegramEventsStore.ts`, `src/lib/missionProgress.ts`, `src/lib/useActiveMissions.ts`, and the diagram store in `src/components/diagram/DiagramStoreContext.tsx`.
- Pure `*InState` helper functions are exported for direct unit testing; the hook wrappers stay trivial.
- Persistent UI state goes to `~/.maru/settings.json` through `src/lib/settings.ts`; a few view keys use `localStorage` (`maru:lastOpenedNote:v1`, `maru:openTabs:v1`, `maru:recent:v1`, `maru:locale:v1`).

## Key Abstractions

**Tauri command:**
- Purpose: The only frontend→backend call shape.
- Examples: `src-tauri/src/document.rs`, `src-tauri/src/vault.rs:325`, `src-tauri/src/ops_catalog/mod.rs:61`
- Pattern: `#[tauri::command]` (or `#[tauri::command(async)]` for heavy I/O) returning `Result<T, String>`; structs are `#[serde(rename_all = "camelCase")]`.

**API facade function:**
- Purpose: One exported async function per command, with a browser-mode mock branch.
- Examples: `src/lib/api.ts:287`, `src/lib/api.ts:1077`
- Pattern: `if (!isTauri()) return mockX(...); return invoke<T>("command_name", { camelCaseArgs });`

**Module store:**
- Purpose: Shared app state without prop drilling or a provider tree.
- Examples: `src/lib/workspaceStore.ts`, `src/lib/errorStore.ts`
- Pattern: module-level state, `Set<() => void>` subscribers, `publish()` replacing state atomically, per-slice `useSyncExternalStore` hooks.

**Managed Tauri state:**
- Purpose: Long-lived backend singletons (watchers, pollers, PTY sessions, missions).
- Examples: `TerminalState`, `MissionState`, `InboxWatcherState`, `VaultWatcherState`, `TelegramIoState`, `CatalogWatcherState`, registered at `src-tauri/src/lib.rs:283`.
- Pattern: `Default`-constructed struct wrapping `Mutex<...>`, injected into commands as `State<'_, T>`.

**Workspace index cache:**
- Purpose: Warm startup without a full rescan.
- Examples: `src-tauri/src/vault.rs:20` (`.maru/cache/workspace-index-v3.json`)
- Pattern: per-file fingerprints; unchanged entries are reused, changed files reparsed, then the envelope is rewritten.

**Skill / agent registry:**
- Purpose: Federated skill catalog with one owner tier per skill name.
- Examples: `src-tauri/src/skill_host/store.rs`, tiers documented in `docs/SSOT-TIERS.md`
- Pattern: registry JSON under `~/.maru/skills/registry.json`, guarded by a process-wide `REGISTRY_LOCK`.

## Entry Points

**Desktop app (web side):**
- Location: `src/main.tsx`
- Triggers: `index.html` `<script type="module" src="/src/main.tsx">`
- Responsibilities: `createRoot(...).render(<StrictMode><App /></StrictMode>)`, async display-font chunks, `markStartup("app:entry")`.

**Desktop app (native side):**
- Location: `src-tauri/src/main.rs:6` → `src-tauri/src/lib.rs:272`
- Triggers: launching `Maru.app` / `cargo tauri dev`
- Responsibilities: plugins, app menu, managed state, `maru_migration::migrate_home()`, terminal hook watcher, scheduler ticker, command registry.

**Standalone CLI:**
- Location: `src-tauri/maru-cli/src/main.rs` and `src-tauri/src/main.rs:8` (`--maru-cli` argv prefix), both landing in `src-tauri/src/cli.rs`
- Triggers: `maru doctor|secrets|skills|jobs|terminal-hook`
- Responsibilities: headless registry/secret/job maintenance without launching the webview.

**MCP sidecar:**
- Location: `sidecars/maru-mcp/index.mjs`
- Triggers: an external agent CLI spawning `maru-mcp` over stdio
- Responsibilities: read-first workspace tools scoped to `MARU_MCP_WORKSPACE`.

**E2E harness:**
- Location: `playwright.config.ts`, `e2e/*.spec.ts`
- Triggers: `pnpm test:e2e`
- Responsibilities: drive the Vite dev server in browser (mocked-Tauri) mode.

## Architectural Constraints

- **Threading:** The webview runs one JS thread; Rust commands run on the Tauri command pool only when declared `#[tauri::command(async)]` (76 of 356 today). A synchronous command doing heavy filesystem work blocks the caller; scanners and catalog queries are explicitly marked async (`src-tauri/src/vault.rs:290`, `src-tauri/src/ops_catalog/mod.rs:61`). New heavy-I/O commands must follow that.
- **Global state:** Rust keeps process-wide `OnceLock<Mutex<()>>` locks to serialize registry and journal writes: `skill_host/store.rs:45` (`REGISTRY_LOCK`), `skill_host/fs.rs:199`, `jobs.rs:16`, `dot_sync.rs:14`, `evidence_binder.rs:19`, plus `scheduler.rs:31` (`TICKER_STARTED`) and `scheduler.rs:38` (`LAST_FIRED`). Two `include_dir!` statics embed read-only payloads: `vault.rs:36` (sample workspace) and `skill_host/store.rs:43` (skills bootstrap).
- **Circular imports:** None in the frontend dependency direction: `src/lib/` never imports from `src/components/` except one type-only import (`src/lib/appOverlayStore.ts:3`), and nothing imports `src/App.tsx`. Keep it that way.
- **Filesystem is authoritative:** `.maru/cache/workspace-index-v3.json` is disposable; React state is derived. Never treat cache contents as truth.
- **Frontmatter writes:** `src-tauri/src/frontmatter/ops.rs` is the only allowed YAML write path; key order and comments must survive a single-field patch.
- **Path containment is lexical:** `resolve_inside_vault` / `lexical_normalize` (`src-tauri/src/vault.rs:581`, `:618`) deliberately avoid `canonicalize()` so user-created symlinks inside a workspace stay part of it.
- **Write gating:** Every mutating command routes through `vault_list::assert_maru_can_write` / `assert_document_owner` and, for managed vaults, `vault_guard::validate_managed_write` with a pre-mutation snapshot.
- **macOS window policy:** `backgroundThrottling: "throttle"` in `src-tauri/tauri.conf.json` is a contract guarded by `scripts/tauri-window-policy.test.mjs`.
- **Bundle budget:** the entry chunk is size-gated by `scripts/check-bundle-budget.mjs`, which is why mode panes and locale dictionaries are dynamic imports.
- **i18n parity:** every UI string lives in `src/lib/i18n/locales/{ko,en}.ts`; `pnpm lint:i18n` fails on key drift or a hardcoded string in `src/**/*.tsx`.

## Anti-Patterns

### Monolithic `MainApp`

**What happens:** `src/App.tsx` is 9,337 lines. `MainApp` (`src/App.tsx:774`) holds hundreds of `useState`/`useCallback` bindings and passes them down as large prop bundles; the mode surface is selected by a nested ternary chain that runs roughly from `src/App.tsx:8600` to `:8790`.
**Why it's wrong:** Any mode change forces a read of the whole shell, prop bundles grow monotonically, and unrelated state churn re-renders every open pane.
**Do this instead:** Add new shared state as a module store next to `src/lib/workspaceStore.ts` and read it inside the owning pane with `useSyncExternalStore`, instead of threading another prop through `MainApp`. Extraction precedent: the comment blocks at `src/lib/workspaceStore.ts:14` and `src/lib/errorStore.ts:3` record earlier slices pulled out of `MainApp`.

### Business logic drifting into React

**What happens:** Pane components occasionally compute domain results (routing, classification, formatting) inline in JSX.
**Why it's wrong:** It breaks the documented module boundary (README "Module boundary rules": React handles only editors, palette, graph layout, diagram canvas) and the logic becomes untestable without rendering.
**Do this instead:** Put the pure function in `src/lib/<feature>.ts` with a sibling `<feature>.test.ts`, and let the component call it. See `src/lib/todayPlan.ts` + `src/lib/todayPlan.test.ts`.

### Duplicated `isTauri` definitions

**What happens:** `src/lib/api.ts:141` exports `isTauri`, but ten other modules redeclare the same `window.__TAURI_INTERNALS__` check locally (`src/lib/agents.ts:33`, `src/lib/skills.ts:11`, `src/lib/studio.ts:12`, `src/lib/maruDir.ts:40`, `src/lib/clipboard.ts:9`, `src/lib/siteView.ts:17`, `src/lib/agentChat.ts:18`, `src/lib/browserPasskeys.ts:28`, `src/lib/evidenceBinder.ts:11`).
**Why it's wrong:** A change to platform detection has to be made in ten places, and browser-mode behavior can silently diverge per module.
**Do this instead:** Import `isTauri` from `src/lib/api.ts` in new modules.

### One global stylesheet

**What happens:** `src/styles.css` is 26,095 lines and holds nearly all component styling; only `diagram`, `graph`, and `settings` have scoped files (`src/components/diagram/diagram.css`, `src/components/graph/graph.css`, `src/components/settings/settings.css`).
**Why it's wrong:** Selectors are globally reachable, so a new rule can silently restyle an unrelated mode, and dead CSS is impossible to detect.
**Do this instead:** For a new mode or a large pane, add a scoped `<mode>.css` next to its component and import it there; use the design tokens declared in `src/foundations.css` rather than raw values.

## Error Handling

**Strategy:** Rust commands return `Result<T, String>` (1,118 occurrences) with human-readable messages; the Tauri bridge turns `Err` into a rejected promise, and the frontend surfaces it through a single global toast.

**Patterns:**
- Rust: `.map_err(|err| format!("Cannot write {}: {err}", path.display()))?`: always name the path or operation (`src-tauri/src/atomic_file.rs`).
- Rust background work uses `let _ = app.emit(...)` so a missing listener never fails the operation.
- Frontend: `setError(...)` / `clearError()` from `src/lib/errorStore.ts`; `setError` also accepts an updater so a reporter can clear only its own message.
- Save paths use `expectedRevision` for optimistic concurrency; a mismatch is a domain error, not a crash.
- Chunk loading (`loadLocale`) never caches a rejected promise, so a transient failure can be retried (`src/lib/i18n.ts`).

## Cross-Cutting Concerns

**Logging:** No logging framework. Rust reports through returned errors and emitted events; AI-run output is persisted per mission and read back via `read_ai_mission_log`. Startup timing goes through `src/lib/startupProfile.ts` (`markStartup` / `measureStartup`), consumed by `scripts/perf-startup-profile.mjs`.

**Validation:** Filenames and folders through `src-tauri/src/filename_rules.rs`; workspace containment through `vault::resolve_inside_vault`; managed-vault schema through `src-tauri/src/vault_guard.rs`; skill sources validated against the `maru.source.json` manifest schema on install with rollback on failure.

**Authentication:** No app account. Provider auth is delegated to external CLIs and probed per provider (`check_gws_auth`, `check_mso_auth`, `check_telegram_auth`, `agents_account_status`). Secrets live as files under `<workspace>/.maru/secrets/` and are managed by `src-tauri/src/secrets.rs`; values are never rendered until explicitly revealed.

**Permissions:** The webview capability allowlist is `src-tauri/capabilities/default.json`; CSP and the scoped asset protocol are configured in `src-tauri/tauri.conf.json`. Agent autonomy is staged behind `src-tauri/src/approval.rs` and `agent_host/protected_write.rs`.

**Internationalization:** ko-KR and en-US are equal first-class locales; dictionaries load as separate chunks and `t()` stays synchronous once `ready`.

---

*Architecture analysis: 2026-08-22*
