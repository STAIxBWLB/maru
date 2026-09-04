# Maru Architecture

**Analysis Date:** 2026-09-02

Maru is a local-first desktop workspace built with Tauri 2 and React 19. The filesystem is the single source of truth; the Rust backend owns persistence, scanning, and external integrations, while the frontend owns rendering, editing surfaces, and shell layout.

## System Overview

```text
┌───────────────────────────────────────────────────────────────┐
│                  Tauri Webview (React 19)                     │
│  ┌──────────────┐  ┌────────────────────┐  ┌───────────────┐  │
│  │ App shell    │  │ Mode surfaces      │  │ Frontend lib  │  │
│  │ App.tsx      │  │ src/components/    │  │ src/lib/      │  │
│  │ activity rail│  │ 18 lazy modes      │  │ IPC + stores  │  │
│  │ editor tabs  │  │ + eager Scratchpad │  │ + pure logic  │  │
│  └──────┬───────┘  └─────────┬──────────┘  └───────┬───────┘  │
└─────────┼────────────────────┼─────────────────────┼──────────┘
          │ invoke()           │ Channel<T>          │ listen()
          ▼                    ▼                     ▼
┌───────────────────────────────────────────────────────────────┐
│              Tauri command layer (365 commands)                │
│              src-tauri/src/lib.rs generate_handler![]          │
│              11 managed state singletons via .manage()         │
└───────────────────────────────┬───────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                 Rust domain modules (~93k lines)               │
│  vault · document · frontmatter · git · workspace              │
│  inbox + providers · tasks · today · scratchpad · drafts       │
│  skill_host · agent_host · terminal · ops_catalog · export     │
│  studio · diagram · hub_client · sites · secrets · linter      │
└──────┬───────────────────┬──────────────────┬─────────────────┘
       ▼                   ▼                  ▼
┌─────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│ Filesystem  │  │ External CLIs    │  │ MCP sidecar (Node)   │
│ workspace/  │  │ claude/codex/    │  │ sidecars/maru-mcp/   │
│ .maru/      │  │ kimi/kiro, git,  │  │ index.mjs            │
│ ~/.maru/    │  │ gws, m365, dot   │  │                      │
└─────────────┘  └──────────────────┘  └──────────────────────┘
```

## Layers

### React shell (`src/App.tsx`, `src/components/`)

- Renders the activity rail, mode surface, editor tabs, tool panels, and dialogs.
- `App.tsx` is the single shell assembler: mode routing, tab management, workspace activation, and prop bundling for panes.
- Mode surfaces are lazy-loaded via `modeRegistry.tsx` except `ScratchpadPane`, which is eager.
- Shared editing chrome: `DocumentModeSurface.tsx` supplies rich/source/preview tabs to the Documents pane, Files inline editor, and Scratchpad.

### Frontend lib layer (`src/lib/`)

- The only layer that talks to Tauri.
- `src/lib/api.ts` is the IPC facade: every `invoke()` call plus browser-mode mocks for `pnpm dev` / Playwright.
- Feature modules hold pure, unit-testable domain logic (e.g., `today.ts`, `inbox.ts`, `scratchpadTree.ts`, `diagram/`).
- Module-level stores read through `useSyncExternalStore` (no Redux/Zustand/Context tree).

### Tauri command layer (`src-tauri/src/lib.rs`)

- Registers plugins, managed state, app menu, setup hooks, and all commands.
- Commands are feature-prefixed (`today_open`, `diagram_save_document`, `skills_list_sources`).
- 11 managed state singletons for watchers, pollers, terminals, approvals, missions, and browser passkeys.

### Rust domain modules (`src-tauri/src/*.rs`, `src-tauri/src/*/`)

- Own the filesystem, cache, git, providers, skills, agents, PTY, and export pipelines.
- Larger features get directories with `mod.rs`: `agent_host/`, `skill_host/`, `terminal/`, `ops_catalog/`, `export/`, `hub_client/`, `frontmatter/`, `studio/`, `diagram/`, `linter/`.
- Shared primitives: `atomic_file.rs`, `vault.rs`, `vault_guard.rs`, `vault_list.rs`, `filename_rules.rs`.

### Sidecar (`sidecars/maru-mcp/`)

- Node stdio MCP server exposing read-first tools (`workspace.search`, `document.read`, `skill.list`) to external agent CLIs.

## Major Subsystems

### Workspace and Vault

- `vault.rs` / `vault_list.rs`: scan workspace roots, build a fingerprinted document index, respect `.maruignore`, and emit `vault://index-delta` events.
- `workspace.rs`: detect `workspace.config.yaml`, register private/public roots, and resolve workspace paths.
- `workspace_files.rs`: file-tree operations (copy, move, rename, trash, paste, file queue apply).
- `workspaceStore.ts`: frontend workspace registry, document index, file-tree twins, explorer UI state.

### Documents and Editor

- `document.rs`: read/save/create/version/move/trash with revision checks.
- `frontmatter/ops.rs`: the only allowed YAML write path; preserves key order and comments.
- `atomic_file.rs`: temp-file-in-same-dir writes with permission preservation.
- `editorTabsStore.ts`: open tabs, split groups, active/focus ids, draft content.
- `editorSurfaceStore.ts`, `editorPaneStore.ts`, `outlinePaneStore.ts`: document-surface state.
- `EditorPane.tsx`: tab strip, find bar, wikilink autocomplete, KG highlight.

### Today / Tasks / Planner

- Rust: `today.rs` (types + capacity math), `today_store.rs` (CRUD + revision locking), `today_lifecycle.rs` (transitions), `today_ai.rs` (plan contracts), `today_calendar.rs`, `today_outbox.rs`.
- TypeScript twin: `src/lib/today.ts` mirrors serde contracts exactly.
- `tasks.rs`: task-note scanning and metadata updates.
- Frontend: `src/components/today/` (prepare/execute/review stages) and `src/components/tasks/`.

### Inbox and Communications

- `inbox.rs`: routing, drop staging, accept/reject, processed-item scanning.
- Provider modules: `gmail_gws.rs`, `outlook_mso.rs`, `telegram_io.rs`, `telegram_config.rs`, `kakao_relay.rs`.
- Watchers: `inbox_watcher.rs`, `scratchpad_watcher.rs`, `vault_watcher.rs`.
- Frontend: `InboxPane.tsx`, `CommsPane.tsx`, provider control panels in `src/components/comms/`.

### Skills and Agents

- `skill_host/`: federated skill catalog, sources, installs, OTA bundle updates, dispatch (`compose`, `terminal`, `background`).
- `agent_host/`: provider probes, structured loop, skill proposals, protected writes, run summaries.
- `agents.rs`: registry CRUD; `mission_state.rs` tracks active missions.
- `agent_runtime_env.rs`: reserves runtime env vars (`MARU_SCRATCHPAD`, `MARU_DRAFTS`, `MARU_TEMP`) and routes agent runs to the owning private workspace.
- Frontend: `src/components/skills/`, `src/lib/skills.ts`, `src/lib/agentRuntimeModeStore.ts`.

### Diagram and Graph

- `diagram/` (Rust) + `src/lib/diagram/` (TypeScript): SVG-based diagram editor with nodes, edges, tables, patterns, snapshots, and report asset export.
- `graph/` (TypeScript) + `vault_graph.rs`: knowledge-graph view over vault files using Sigma/Graphology with worker-based analysis.

### Terminal

- `terminal/` (Rust): Alacritty screen model over `portable-pty`, frame streaming through `Channel<T>`.
- `terminal_hooks.rs`: agent context hints installed into external CLIs.
- Frontend: `TerminalPanel.tsx`, `NativeTerminalView.tsx`.

### Export / Studio

- `export/`: plan, validate, and dispatch exports (PDF, DOCX, etc.).
- `studio/`: document-studio state and template assembly.
- `hwped.rs` / `hwp_cli_template.rs`: HWP editor bridge and template filling.
- `linter/gaejosik.rs`: Korean official-document linting.

## State Management

- **No global context provider tree.** App state lives in module-level stores that expose `getState()` / `subscribe()` / action helpers and React hooks built on `useSyncExternalStore`.
- Examples: `workspaceStore.ts`, `editorTabsStore.ts`, `appOverlayStore.ts`, `errorStore.ts`, `shellSettingsStore.ts`.
- Pure `<verb>InState` helpers compute the next state; actions publish atomically. Helpers preserve object identity on no-ops to avoid re-renders.
- `MainApp` still owns some transient local state (saving indicators, per-pane view modes, drag payloads) and passes large prop bundles to a few panes; the target direction is pane-local state like `ScratchpadPane`.

## IPC and Data Flow

### Request/response

- All frontend calls go through `src/lib/api.ts`.
- Rust commands return `Result<T, String>`; newer commands return typed `IpcError` codes normalized by `src/lib/ipcError.ts`.
- Browser mode: `isTauri()` is false, so `api.ts` resolves through `src/lib/fixtures.ts` mocks.

### Push / streaming

- Named Tauri events: `vault://index-delta`, `ai://output`, `scratchpad://changed`, `skills://updated`, `telegram://messages`, etc.
- `Channel<T>` streams high-rate terminal frames from Rust to the frontend.

### E2E bridge

- `src/lib/e2eInvoke.ts` lets Playwright override individual Tauri commands without touching source code.
- `src/lib/nativeE2eBridge.ts` supports native WebDriver E2E behind a Cargo feature (`native-e2e`).

## Key Design Patterns

- **Filesystem as SSOT:** every document, task, today snapshot, setting, and skill file is plain text on disk. Rust is the only writer; frontend asks through commands.
- **Optimistic concurrency:** documents and today snapshots carry a `revision` (sha256) and commands reject stale writes.
- **Atomic writes:** all file writes use `atomic_file.rs` (temp + rename) to avoid half-written state.
- **Feature-prefixed commands:** `today_open`, `diagram_save_document`, `skills_list_sources` make the command registry searchable and collision-free.
- **Mode adapter pattern:** each mode is a lazy adapter implementing `ModeAdapterProps`; the registry in `modeRegistry.tsx` decouples `App.tsx` from mode details.
- **Pure state helpers:** frontend stores keep logic unit-testable with exported `*InState` functions.
- **Bundle budget guard:** `scripts/check-bundle-budget.mjs` enforces entry-chunk size; lazy modes and split font CSS keep the initial load small.

## Testing

- Frontend unit: co-located `*.test.ts(x)` plus `src/__tests__/`; run with `vitest run src scripts`.
- Rust unit: `#[cfg(test)]` modules inside each `.rs`.
- E2E: Playwright specs in `e2e/*.spec.ts` against the browser (mocked Tauri) build; native E2E via WebdriverIO in `e2e-native/`.
- Bundle/release guards: `scripts/check-bundle-budget.mjs`, `scripts/check-release-version.mjs`, `scripts/check-native-e2e-isolation.mjs`.
