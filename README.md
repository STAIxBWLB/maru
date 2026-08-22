# Maru

Local-first AI workspace desktop app for Korean knowledge/document operations.
Tauri 2 + Rust + React 19 + TypeScript. The current version is defined by the
synced app manifests (`package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and `src-tauri/maru-cli/Cargo.toml`).

Maru is the author SSOT for a single user's `~/workspace/work/` — it edits
markdown with byte-identical frontmatter, ingests an inbox, runs bundled Claude
Code skills, drives Korean document (HWPX/DOCX/PDF) operations, and visualizes
the vault as a knowledge graph. Releases before v0.3.0 shipped under the name
**Anchor**; the M0 rename (`kr.maru.desktop`, `~/.maru/`) landed in v0.3.0.

## Status (2026-07-25)

| Phase | State | Outcome |
|-------|-------|---------|
| 0 — Hardening | ✅ shipped | Open existing workspaces safely. Frontmatter byte-identical round-trip. Multi-workspace registry. ko/en parity. |
| 0.5 — UI polish | ✅ shipped | Topbar, sidebar with type filters + recents, command palette (⌘K), Pretendard Korean typography, light/dark. |
| 1A — Killer feature MVP | ✅ shipped | Doc-selection reliability, frontmatter inline edit (InspectorPane), wikilink autocomplete (Korean IME-aware) + click-to-navigate, typed neighborhood pane, in-memory nav history (⌘[ / ⌘]). |
| 1B — Rich editor / git | ✅ feature-complete | Git status badge + commit-from-app (file list + per-file diff + syntax color). Rayon-parallel workspace scan + cache-backed warm startup. Multi-tab editor (⌘1..⌘8 / ⌘W, dirty stash). BlockNote rich + source + preview modes persist independently per split pane; ⌘W closes the focused editor or terminal tab. Browser smoke e2e. **Deferred**: monorepo extraction. |
| 2 — Inbox + AI | ✅ write loop live | Polling scan + notify watcher + Korean date parser + Claude CLI bridge + classifier + Gmail via `gws`, plus `InboxPane` (classify/accept/reject/process, approval gate, Maru labels, `a`/`r`/`p`, bulk actions, mission log tails). |
| 2.5 — Tree + Cursor shell + Terminal | ✅ shipped | Separate Documents and Finder-style Files workspaces, file tree + direct-child list + inline preview, copy/move/rename/duplicate/system-Trash operations, Cursor-style activity rail, split panes (⌘D), and one resizable bottom/right Panel that switches between persistent Terminal and Graph tabs. Rust-native `alacritty_terminal` PTY tabs (Claude/Codex/Kimi/Kiro/Shell), independent Terminal/Graph themes, layered `~/.maru/settings.json` + `<workspace>/.maru/workspace-state.json`, signed auto-update, native menu bar. |
| 3 — Unified document ops (M1–M7) | ✅ W1–W6 + skills SSOT | Operations Catalog mode (`ops_catalog::scan`, fs watcher, Hub HTTP read + ETag/offline fallback, drilldown + Reveal), Hub Library client + template-aware new doc, Writing Guideline sidebar. Rust `skill_host` owns tiers (core/public/private/imported/managed), doctor validation, dirty/reconcile. maru-hub backs shared catalog (REST + Alembic + seeds). |
| 4 — Document Studio + Templates | ✅ W7–W12 | 7-step `Studio` mode (source → template → guideline → sections → HWP fields → export → package). `create_document` frontmatter prefill, M4 export pipeline (`export/` plan/validate/dispatch, docx/hwpx/pdf + sha256 manifest), HWPX field map (`hwpx slots` + `template_fill`), 개조식 inline lint (`linter/gaejosik`). |
| 5 — Evidence Binder | ✅ W14 implemented | Schema-v2 local binder state under `<workspace>/.maru/binder/<doc-id>.json`; revision-guarded atomic mutations; full binary sha256 identity; typed sidecar status; BU-scoped candidates; explicit section/KPI/checklist targets, local verification, submission selection, undo, and orphan handling. W15 Hub evidence-index integration and W16–W18 Deck Studio remain planned. |
| D — Concept-map Diagram mode | ✅ shipped (Phase 0–7, hardened) + Report Pattern Studio (v8) | `diagram` mode: HWP-style 9-tab ribbon, 13 node kinds, 4-port edges, smart-guide snap, 11 templates, version history, viewport culling for 1000-node smoothness. Report Pattern Studio: v8 schema (report datasets + pattern views, one-time v7 backup at `.maru/diagrams/backups/`), typed table editing, pattern gallery + conversion preview, codec-registry import/export (lossless/structural/visual), and "Insert/Update in report" — managed `maru-diagram:v1` Markdown blocks with rendered assets at `attachments/diagrams/<docId>/`. Storage: `diagrams/*.cmd.json`, `.maru/diagram-patterns/`. New commands: `diagram_backup_document`, `diagram_pattern_save/list/delete`, `diagram_write_report_asset`. See [docs/diagram.md](docs/diagram.md). |
| 8 — Knowledge graph | ✅ 8a/8b/8c + V6 shipped | `graph` mode: stable Sigma WebGL + Graphology multi-directed model, Barnes-Hut ForceAtlas2 worker, visibility reducers, 10k+ node target, vault/workspace sources, canonical Local targets, local depth/direction controls, background insights, saved views, reviewed relationship writes, incremental cache/watch refresh. V6: canvas-first floating controls, one progressive-disclosure tools drawer, dark neutral Obsidian-style defaults, selectable accent/color modes, dense-graph visual LOD, zero-size container recovery, and a persistent Graph tab in the shared bottom/right Panel. Managed writes remain schema-gated, revision-checked, snapshotted, and atomic. See [docs/graph.md](docs/graph.md). |
| M0 — Anchor → Maru rename | ✅ shipped (v0.3.0) | Full rename across app id, dirs, CLI, tap. One-time on-disk migration (`~/.anchor → ~/.maru`, `com.anchor.app → com.maru.app`) with back-compat symlink; `.maruignore` preferred with `.anchorignore` fallback read. |

Rule SSOTs live in the work repo at
`~/workspace/work/_meta/rules/{frontmatter-schema,document-lifecycle,hub-contract,evidence-policy}.md`.
The deeper "what's next + how to continue" reference is [ROADMAP.md](ROADMAP.md).

## Modes

The activity rail exposes eighteen top-level modes (Settings opens as an
in-app overlay, so it is not an app mode). Diagram and Graph default on; E2E
Flow is flag-gated.

| Mode | Label (ko / en) | What it does |
|------|-----------------|--------------|
| `pkm` | 문서 / Docs | Default. Markdown/HTML document tree, editor, and right utility rail. |
| `scratchpad` | 스크래치패드 / Scratchpad | Three-pane memo and temporary-result workspace with a virtual folder tree, searchable file list, Rich/Source/Preview editing, autosave, recovery, and cleanup. |
| `files` | 파일 / Files | Finder-style workspace with folder tree, direct-child list, inline Markdown/HTML editor, binary previews, search/filter/sort, and filesystem operations. |
| `inbox` | 인박스 / Inbox | Configured drop / pending / processed / Files / Gmail sections with classify + `a`/`r`/`p`. |
| `comms` | 메시지 / Messages | Multichannel comms settings (Telegram auth/mapping, source config, macOS migration). |
| `meetings` | 회의록 / Meetings | Transcript + auto-summary intake and the meeting-notes review workbench. |
| `today` | 오늘 / Today | Today planner (`src/components/today/`) over file-backed tasks with Google Tasks/Calendar links: prepare / execute / review stages plus calendar sync. |
| `tasks` | 태스크 / Tasks | Standalone task & schedule management: full task list, month/week/day calendar, detail editing, and AI runs. |
| `dashboard` | 대시보드 / Dashboard | At-a-glance workspace overview: today summary, tasks, schedule, catalog signals, inbox, agents, drafts, git, recents, and sync, with in-mode drilldowns and deep links into the owning modes. |
| `drafts` | 아이디어 / Ideation | Ideation hub for durable ideas, implementation drafts, promotion, gap analysis, and the recurring-skill Automation scheduler. See [docs/drafts.md](docs/drafts.md). |
| `gap` | 갭 분석 / Gap Analysis | Diffs promoted drafts against their frozen baselines, classifies the human edits, and feeds the tendencies back into draft prompts. See [docs/gap-analysis.md](docs/gap-analysis.md). |
| `agents` | 에이전트 / Agents | Every AI job Maru can run: status, chat, run, stop, backend, permission mode, prompt, schedule, plus user-created agents. The 대화 tab talks to the agent's backend in-app instead of through a PTY, and routes a turn into a task, a memo, or an approved proposal. See [docs/agents.md](docs/agents.md). |
| `catalog` | 카탈로그 / Catalog | M1 Operations Catalog — deadlines, in-flight approvals, unlinked evidence, inbox pending. |
| `studio` | 스튜디오 / Studio | M2 Document Studio 7-step authoring wizard. See [docs/studio.md](docs/studio.md). |
| `diagram` | 다이어그램 / Diagram | Concept-map editor. See [docs/diagram.md](docs/diagram.md). |
| `graph` | 그래프 / Graph | Vault knowledge graph. See [docs/graph.md](docs/graph.md). |
| `sites` | 사이트 / Sites | Left-rail site switcher with an embedded native browser pane. |
| `e2e` | E2E 플로우 / E2E Flow | Hidden end-to-end flow console (flag-gated `e2eFlowEnabled`). |

## Workspace sync management

Settings > Jobs includes a separate Workspace Sync section for the global dot
workspace. It reads dot's versioned JSON status API and manages both sync
profiles without adding them to the workspace-local `.maru/jobs.json` registry:

- Cloud mirror status, owner, propagation policy, filters, push/pull schedules,
  pause/resume, preview, run, and bounded log tail.
- Mac peer SSH target, bidirectional schedule with quarantined deletions,
  doctor/diff, preview/run, secret allow patterns, and host-path allowlist.
  dot limits deletion to baseline-recorded paths and caps new profiles at 100
  paths per run.
- Confirmed Homebrew install/update when dot is missing or older than the
  minimum compatible JSON API version.

The permanent bottom status bar shows setup, manual, scheduled, syncing,
paused, or attention state and opens Settings > Jobs when clicked. Maru invokes
fixed dot arguments directly, never through a shell; mutating actions are
serialized and destructive or secret-expanding changes require confirmation.

## HTML editing

`.html` and `.htm` documents open in the document editor with three modes
(Markdown files keep their own rich/source/preview modes and saved
preference):

- **Visual** (default) — sandboxed WYSIWYG editing with a formatting toolbar
  (undo/redo, paragraph/heading styles, bold/italic/underline/strike, lists,
  link/unlink, clear formatting).
- **Source** — lossless raw HTML editing.
- **Preview** — sandboxed, read-only rendering.

Preservation guarantees and limits:

- YAML frontmatter, the doctype, `<html>`, `<head>` (including styles and
  scripts), `<body>` attributes, and the surrounding document shell are
  preserved byte-for-byte. After an actual Visual edit, only the body
  contents may receive browser HTML normalization; when Visual mode is
  opened without editing, the source stays byte-identical.
- HTML fragments edit as fragments. Full documents whose `<body>` boundary
  cannot be parsed disable Visual mode with a direct Source-mode action.
- Visual mode is limited to documents up to 2 MiB (UTF-8) or 20,000 DOM
  nodes; larger documents fall back to Source and Preview.

Sandbox behavior:

- Scripts, inline event handlers, meta refresh, nested frames, and forms are
  preserved in the source but never executed: the editing/preview surface is
  a runtime-only iframe clone that strips them and injects a
  Content-Security-Policy blocking scripts, connections, workers, objects,
  frames, form submission, and remote resources. Runtime safety markup and
  rewritten asset URLs are never serialized back to the file.
- Documents containing scripts, event handlers, custom elements, forms, or
  embedded content require a one-time confirmation (per tab and current
  source digest) before Visual editing; source edits and external revisions
  re-arm the confirmation.

Local assets:

- Relative asset URLs (CSS, images, fonts, media), `data:`, and `blob:` URLs
  load through the Tauri asset protocol, authorized read-only and scoped to
  the document's own directory inside the owning registered workspace
  (`prepare_html_editor_assets`). Network resources and paths escaping the
  workspace are blocked.
- File operations (rename/move, duplicate, trash, manual and automatic
  snapshots) preserve the original HTML extension, including case, and the
  vault scanner/watcher recognize HTML extensions case-insensitively.

## Files workspace

Files is independent from the Documents pane. It scans files, empty folders,
and symlinks as first-class entries, then presents a resizable folder tree,
the current folder's direct children, and a resizable editor/preview pane.
Searching within a folder includes its descendants; normal browsing remains
direct-child only.

- Single-click selects and previews. Markdown opens Rich/Source/Preview and
  HTML opens Visual/Source/Preview directly in Files, with explicit Save and
  the same in-memory draft shared with Docs. Double-click opens a folder, a
  document in Docs, or another file in its external app.
- Directory and multi-selection summaries plus image/PDF/Office/media/archive
  viewers remain available for non-document selections.
- Multi-select, range select, keyboard navigation, drag/drop, rename, duplicate,
  Maru-internal cut/copy/paste, and new-folder creation are supported.
- Delete moves entries to the operating system Trash. Risky deletes require
  confirmation, and deletes containing unsaved open documents are blocked.
- Managed workspaces are read-only in Files. Read-only and delegated capability
  policies are enforced again by the Rust command layer.
- Rename/move uses the existing `.maru-rename-txn` journal and scan-time
  recovery. Collisions never overwrite an existing item; copy/paste chooses a
  `-copy` suffix.

## Drafts, gap analysis, and KG references

Three surfaces close the loop between AI generation and the confirmed vault:

- **Drafts + scheduler** — AI skill runs (scheduled from the Agents mode, or
  manual) emit task/idea/implementation draft artifacts that Maru
  ingests into an unconfirmed store: the resolved `$MARU_DRAFTS` bodies
  (`scratchpad/drafts/` by default) plus `.maru/drafts/index.json` metadata.
  Accepting a draft promotes it into the
  vault through the approval gate. The Drafts mode is the **Ideation hub**:
  durable ideas can be created, edited, and moved through their lifecycle
  there, while the Scratchpad pane remains focused on memos and temporary
  results. See [docs/drafts.md](docs/drafts.md).
- **Gap analysis** — promotion freezes a baseline copy; the Gap mode diffs the
  promoted document against it, classifies each human edit (external info /
  direct edit / cross-doc reference / formatting), and appends the summary to
  `.maru/gap-log.jsonl`. A digest of recent log entries is attached to new
  extract-tasks schedule prompts so future drafts need fewer edits. See
  [docs/gap-analysis.md](docs/gap-analysis.md).
- **KG reference visualization** — `kg_document_refs` maps which vault notes a
  document references (wikilinks + title/alias mentions), computed on demand
  and cached under `.maru/kg-cache/`. The editor highlights referenced titles
  inline; the graph can focus the referenced neighborhood. See
  [docs/kg-references.md](docs/kg-references.md).

## Install

Maru ships the desktop app and CLI as separate artifacts. On macOS, both are
distributed through the `STAIxBWLB/homebrew-cask` tap:

```bash
brew tap STAIxBWLB/homebrew-cask

# Desktop app only:
brew install --cask maru-workspace

# Standalone CLI only. Installs the executable as `maru`:
brew install maru-cli

maru --version
```

The app cask installs `Maru.app` and does not create a CLI symlink. The CLI
formula installs only the standalone `maru` executable. The desktop app keeps
using signed Tauri updater metadata from GitHub Releases; Homebrew users can
also upgrade via `brew upgrade --cask maru-workspace` and `brew upgrade maru-cli`.

For repo-local management shortcuts:

```bash
make cli-install
make cli-smoke
make release-preflight
make homebrew-update RELEASE_TAG=v$(node -p "require('./package.json').version") HOMEBREW_TAP_DIR=../homebrew-cask
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri Webview (src/)                                        │
│   React 19 + Radix UI + BlockNote + marked + DOMPurify       │
│   Sigma WebGL + Graphology · CodeMirror · alacritty canvas    │
│                                                               │
│   Activity rail (18 modes):                                  │
│     Dashboard / Docs / Scratchpad / Files / Inbox / Messages │
│     Meetings / Today / Tasks / Drafts / Gap / Agents /       │
│     Catalog / Studio / Diagram / Graph / Sites / E2E         │
│   Files/Scratchpad tree + list + editor + Terminal/Graph Panel│
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri IPC
┌──────────────────────────────▼──────────────────────────────┐
│  Rust core (src-tauri/src/)                                  │
│   workspace scan — walkdir + .maruignore + cached index      │
│   frontmatter/   — line-by-line YAML edit (preserves order)  │
│   document.rs    — read/save/create/version + field patch    │
│   git.rs         — status/commit/diff via shell-out          │
│   vault_list.rs / vault.rs / vault_graph.rs / vault_guard.rs │
│   inbox.rs / inbox_watcher.rs / inbox_classifier.rs          │
│   gmail_gws.rs / outlook_mso.rs / telegram_io.rs / ai_router │
│   ops_catalog/ · hub_client/ · export/ · studio/ · diagram/  │
│   skill_host/ · agent_host/ · terminal/ · linter/            │
│   maru_dir.rs   — layered settings + .maru rules/templates   │
│   maru_migration.rs — one-time Anchor → Maru on-disk rename  │
└──────┬─────────────────────────────────────────────────────┘
       │ stdio bridge
┌──────▼────────┐ ┌────────────────────┐
│ MCP server    │ │ User's Claude Code │
│ (Node sidecar) │ │ CLI (~/.maru/skills)│
└───────────────┘ └────────────────────┘
```

**Module boundary rules**:
- Rust core **owns** workspace FS / cache / git / frontmatter / inbox
  scan/watch/classification / Gmail `gws` + Outlook + Telegram bridges / layered
  Maru settings / Claude inbox subprocess / integrated terminal PTY + screen
  model / skills registry (`skill_host`) / agent proposal host (`agent_host`) /
  ops catalog / export pipeline / Studio + Diagram + Graph backends.
- React handles **only** BlockNote / command palette / neighborhood / graph
  layout worker / diagram canvas. No business logic.
- Node sidecar (`sidecars/maru-mcp/`) holds the local read-first MCP server.
- **Deferred (Phase 4 original plan, on hold)**: a Whisper (Korean large-v3)
  Python sidecar + MediaPipe voice/gesture editing. Not shipped — Phase 4 was
  repurposed to Document Studio. Voice/gesture remains a future track.

### Integrated terminal reliability contract

- Terminal and Graph share one VS Code-style Panel that docks at the bottom or
  right, persists its active tab/size/position, and exposes independent theme
  selectors. The terminal workspace mounts eagerly and keeps its
  textarea/canvas identity across collapse and Graph tab switches. macOS
  first-mouse activation focuses a
  terminal in one click; activation clicks are not forwarded to a TUI, while
  Shift always forces local selection.
- Each PTY session streams ordered, generation-tagged frames through a Tauri
  Channel. The frontend acknowledges applied frames, the backend keeps at most
  two frames in flight, hidden sessions do not serialize or paint frames, and
  a sequence/dimension mismatch requests a full resync.
- Frames use a palette plus compact `[text,width,style]` cells. Release gates
  cap a 120x30 full frame at 100 KiB and a dirty-row patch at 4 KiB.
- The Rust Alacritty model owns selection and copy semantics, including
  scrollback coordinates, soft wraps, wide CJK cells, resize reflow, semantic
  word selection, and line selection. The canvas keeps an optimistic drag
  overlay for immediate feedback.
- Frontend input is queued before spawn, microtask-batched, and sent in strict
  order. Normal key/text/paste delivery reads mirrored terminal modes without
  contending with the output parser's screen-model lock.

### macOS window lifecycle policy

- The main Tauri window explicitly uses `backgroundThrottling: "throttle"`.
  On macOS 14+, this prevents WebKit's default full suspend/unload behavior for
  an inactive hidden or minimized main view while retaining rate limiting.
  It does not guarantee continuity across system sleep, Spaces, app switching,
  or compositor transitions.
- This is a configuration contract in `src-tauri/tauri.conf.json`, protected by
  `scripts/tauri-window-policy.test.mjs`, and the test is static configuration
  validation rather than runtime proof. Keep the policy when changing the main
  window; a native macOS sleep/wake or hide/show smoke test remains required.

### AI agent runtimes

Maru treats Claude Code, Codex, Kimi, and Kiro as first-class AI runtimes
(`ai.defaultRuntime`, terminal launchers, and per-agent command overrides).

Every AI feature runs as a named **agent** that binds a skill to one of those
runtimes, so the backend is a per-feature choice rather than a global one. The
`agents` mode manages them; the Settings tab below covers the runtime *accounts*
those agents dispatch to. See [docs/agents.md](docs/agents.md).

- The Settings **AI 런타임 / AI Runtimes** tab (`system.tab.agents`) shows per-agent
  sub-tabs with authentication status (Connected / Not connected / Not
  installed), account details (version, provider, login method, organization,
  email), a "Run login" action that launches the provider's login command in
  the integrated terminal, launch-command overrides (binary path + extra
  args), and quota/usage windows where the provider exposes them.
- The main window footer renders an agent usage bar with one chip per agent
  (usage percent + reset countdown); it polls on an interval and on window
  focus, stays hidden when no agent reports usage, and clicking a chip opens
  the Agents settings tab.
- Backend commands: `agents_account_status` (per-agent install/auth probe,
  honoring command overrides) and `agents_usage_status` (cached quota/usage
  windows, `force` for a user-initiated refresh).
- The opt-in command-palette hook action installs reversible Maru lifecycle
  entries in the selected Claude settings scope and a marker-managed block in
  `$KIMI_CODE_HOME/config.toml` (default `~/.kimi-code/config.toml`). Kimi's
  `SessionStart` stdin supplies the native session id used to resume a restored
  terminal tab; uninstall removes only Maru entries and preserves the user's
  other hooks and TOML content.

## Phase 3 verification gates (passed)

1. **Catalog watcher + auto-refresh** — notify recursively watches `inbox/items/`, `tasks/{active,calendar}`, every BU's `02-admin-approvals/` + `03-evidence-cert/` + `.maru/bu-config.yaml`; bursts are debounced 500 ms and the React pane re-queries in another 300 ms.
2. **Hub catalog read path** — `hub_client::http::fetch_with_cache` GETs `/api/v1/{templates,guidelines,glossary,...}` with ETag revalidation, falls back to `<workspace>/.maru/cache/hub/` on any network error.
3. **Drilldown dialog + Reveal** — Catalog row → modal showing frontmatter + manifest + README excerpt + sibling paths + "Finder에서 보기".
4. **Real-workspace timing** — `MARU_CATALOG_BENCH_WORKSPACE=~/workspace/work cargo test --lib -- --ignored catalog_real_workspace_smoke` indexed 110 entries across 4 BUs in 986 ms (30× under the 30-second budget).
5. **Template-aware new doc** — `⌘ ⇧ N` / palette "Hub 템플릿으로 새 문서" → BU/category filter → template picker prefills body + title + docType → optional guideline multi-select → `maru:template` / `maru:business_unit` / `maru:guidelines` provenance.
6. **Guideline sidebar** — opening a doc created via the template flow surfaces its guideline bodies in the right-pane `BookOpen` tab.

### Live-Hub verification (operator procedure)

The above gates run fully offline (cache fallback). To exercise the live Hub read path:

```bash
# maru-hub: start FastAPI + sqlite (or run docker compose up -d db for Postgres)
cd dev/maru-hub
uv run python -m scripts.seed_catalog
MARU_HUB_DATABASE_URL=sqlite:///tmp/maru-hub.db uv run uvicorn maru_hub.main:app --port 8017

# maru: flip workspace.config.yaml
#   hub.enabled: true
#   hub.endpoint: http://127.0.0.1:8017/api/v1
#   hub.api_token_ref: ~/workspace/work/.maru/secrets/hub-token (empty file is fine for local)
```

Then in Maru: open Catalog mode → footer "마지막 스캔" populates; ⌘ ⇧ N → toggle "Hub 템플릿에서 시작" → templates load from Hub; pick `business-plan-default` → body prefills with slot hints.

After Phase 6 W21 ships, the same operator procedure will also exercise the `POST /api/v1/documents/{id}/finalize` round-trip — Maru pushes the approved markdown body + rendered artifacts + linked evidence binaries to Hub, and the document then appears under the Hub Finalized tab inside Catalog mode.

## Roadmap

The active plan lives in [ROADMAP.md](ROADMAP.md) — a 7-module (M1–M7)
decomposition with weekly deliverables (W1–W34+) plus the Diagram and Graph side
tracks. Phases 0–5, the Diagram mode, and the Phase 8 graph mode (8a/8b/8c) are
shipped. See [CHANGELOG.md](CHANGELOG.md) for the release-by-release history.

Each phase is defined in **outcomes the user actually exercises**. No phase
exists just to grow infrastructure. The entry gate for each phase is the
verification of the previous one.

### Next up

Git has run ahead of the linear W-plan: Phase 8 (graph mode) shipped before the
remaining Phase 5 evidence work. The nearest pending items:

1. **W15 Evidence index** — use the W14 full-sha binding identity for Hub `evidence_index` lookup and reuse hints. Keep binaries local; send only sha256 and metadata through the approval-gated Hub path. Entry files: `src-tauri/src/evidence_binder.rs`, `src-tauri/src/hub_client/*`, `src/components/evidence/*`.
2. **W16–W18 Deck Studio (M6)** — a `Decks` mode wrapping the gpt-images-deck wizard with the bundled 14-style catalog (`skills/docs/slide-decks/`).
3. **Phase 6 (W19–W22) Approval + Finalize-to-Hub** — submission gates, gate-state polling, and the approval-gated `POST /api/v1/documents/{id}/finalize` write path (the only Maru client path allowed to carry body/binary payloads). Requires a matching `hub_client/safety.rs` pre-flight.
4. **Phase 7 (W23–W26) Certification & KPI bundle** — Hub-backed certification vault, KPI composer, and PDF bundle assembly.

## Hub as published-document SSOT

Maru stays the **author SSOT** — drafting and editing always happen under
`~/workspace/work/`. Maru Hub becomes the **published SSOT** the moment an
approval route closes. Two write paths land on Hub from Maru:

1. **`POST /api/v1/documents/sync`** (planned M7 caller) — drafting metadata only: `document_uri`, `body_sha256`, `frontmatter`, and the evidence link graph. **No body, no binary.** Used for cross-BU lookups and "이미 동기화된 초안" hints.
2. **`POST /api/v1/documents/{id}/finalize`** (Phase 6 W21) — approval-gated canonical push. The instant `submission_gate.state` flips to `approved`, Maru auto-calls finalize with the full markdown body, every rendered artifact in the M4 manifest (docx/hwpx/pdf), and the binary bytes of every evidence file linked via `frontmatter.evidence_links`. On `201`, the local frontmatter `status` flips to `archived-hub:<finalized_id>@v<N>`.

Gate submits made while the Hub is disabled or unreachable persist in
`<workspace>/.maru/queue/hub/` (one JSON per request) and drain FIFO via
the `hub_queue_drain` command — exposed in the Catalog footer as a queue
depth badge with a retry action.

## Development

```bash
pnpm install

# Browser dev (mocked Tauri):
pnpm dev

# Native Tauri dev (cleans stale local app bundles first):
pnpm tauri:dev

# Type check:
pnpm typecheck

# i18n lint (ko/en parity + hardcoded UI string scan; also in make verify):
pnpm lint:i18n

# ESLint (four correctness rules over src/ + e2e/; also in make verify):
pnpm lint

# Rust format check and lint gate (both also in make verify):
make fmt-check
make clippy

# Production build:
pnpm build

# Regenerate every icon from the canonical vector sources:
pnpm icons:generate

# Verify that committed web, desktop, Windows, iOS, and Android icons are current:
pnpm icons:check

# Full verification (typecheck + ESLint + release-version sync + guards + unit
# tests + Rust fmt/clippy + frontend build):
make verify

# Full verify plus release-only CLI and debug Tauri checks:
make release-checks

# Smoke the real installed AI CLIs. Every provider unit test drives a fake
# shell script, so this is the only check that touches the actual integration:
# --version, auth classification, skills-gate/account-probe agreement,
# usage-vs-capability, and real-binary permission parsing. Uninstalled backends are skipped.
# Run it when touching agent_host/provider.rs, skill_host/dispatch.rs,
# agent_host/status.rs, or terminal/mod.rs. It is deliberately NOT part of
# make verify, which must stay hermetic.
make verify-integration
MARU_CLI_SMOKE_ROUNDTRIP=1 make verify-integration  # + one live prompt per backend

# Signed native release build:
make tauri-build

# Raw pnpm build still requires explicit updater signing env:
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/maru-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/maru-updater.key.password)"
pnpm tauri:build

# Prune oversized local Tauri debug artifacts (also runs from tauri:dev/build):
pnpm clean:tauri-debug
# Checks once every 24h and prunes src-tauri/target/debug when artifacts exceed 4GiB.

# Rust unit + integration tests:
cd src-tauri && cargo test
# or: make test-rust  (cargo test --lib)

# Frontend unit tests:
pnpm test
# End-to-end:
pnpm test:e2e

# Local Maru MCP sidecar smoke:
MARU_MCP_WORKSPACE="$PWD" node sidecars/maru-mcp/index.mjs

# Skills registry doctor / reconcile:
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- --version
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- doctor --json
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills dirty --json
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills reconcile <name-or-id> --accept --dry-run
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills import /path/to/skill --copy

# Bench workspace scan on a real workspace:
cd src-tauri && cargo test --release bench_scan_real_workspace \
    -- --ignored --nocapture --test-threads=1
# → MARU_BENCH_WORKSPACE=/some/path overrides the default ~/workspace/work
```

Codex skill sync writes to `$CODEX_HOME/skills` when `CODEX_HOME` is set, as
it is for isolated Orca account profiles. Without that variable, it uses the
standard `~/.codex/skills` directory.

CI runs `make verify` (typecheck + ESLint + release-version sync + guards + unit
tests + Rust fmt-check and clippy + frontend build) and `make test-e2e` on
pull requests via
`.github/workflows/ci.yml`. Documentation-only changes do not start CI. A push
to `main` first compares the pushed tree with its associated PR head and checks
that the latest `CI PR #<number>` run for that exact head succeeded. The stable
run name keeps the check PR-specific even when GitHub's workflow-run API omits
its `pull_requests` association. Only that exact-tree case skips the expensive
steps; direct pushes, stale merge bases, missing checks, and API failures run
the full suite. Version-changing PRs run
`make release-checks` instead of `make verify`, adding CLI and debug Tauri
checks without repeating verify, frontend build, or E2E.

`typecheck` covers four TypeScript projects — `src/`, the node config files,
`e2e/`, and `scripts/` — so a type error in a Playwright spec or a build script
fails the gate instead of surfacing at run time. `rust-toolchain.toml` pins the
Rust toolchain, so `make fmt-check` and `make clippy` resolve the same compiler
on every machine and in CI rather than following whatever `stable` happens to
be. A failing e2e in CI uploads a Playwright trace with the `playwright-report`
artifact; the trace keeps the action timeline and the failing stack, but not DOM
snapshots, screenshots, or the network log (see the comment in
`playwright.config.ts` for why, and for when to turn them back on).

`.github/workflows/release-preflight.yml` is a manual recovery gate. It keeps
the intentionally exhaustive `make release-preflight` path but no longer
duplicates PR verification automatically when a version tag is pushed.

## Skills Bundle Channel (OTA)

Skills deploy independently of app releases and live in their own repo,
[`STAIxBWLB/skills`](https://github.com/STAIxBWLB/skills). Every push there
that touches bundle content verifies, packages, signs (same minisign key as
the app updater), and uploads immutable assets to that repo's
`skills-channel` prerelease. The app checks that channel after launch and
every 6 hours, applies new bundles automatically when the local skills are
clean and runtime-compatible, and shows an update-available notification
otherwise; `maru skills update --check|--apply [--repair-env]` and the
Skills UI cover manual flows. The binary embeds only a frozen
`src-tauri/skills-bootstrap/` snapshot as the offline first-run fallback;
refresh it from the newest bundle with `make skills-bootstrap-refresh` when
cutting an app release.

## Release Bundles

Publishing a GitHub Release (a `v*` tag; the skills channel is excluded)
triggers `.github/workflows/release-bundles.yml`.
The workflow validates the tag, synchronized version surfaces, locked Cargo
metadata, and required secrets once before starting platform runners. It then
builds native Tauri bundles concurrently on macOS ARM, macOS Intel, Ubuntu,
and Windows and uploads the generated `.app` / `.dmg`, `.deb` / `.rpm` /
`.AppImage`, `.exe`, and `.msi` assets to that same release. Each macOS app job
also builds `maru-cli` from the populated target cache, packages a tarball
containing a `maru` executable, and uploads
`maru-cli_<version>_darwin_{aarch64,x86_64}.tar.gz` plus SHA256 files.

Platform jobs never update `latest.json`. After all four jobs succeed, one
finalizer validates the complete 20-asset pre-manifest set, reads the seven
updater signatures, and publishes a single 11-platform `latest.json` consumed
by startup auto-update and the native `Check for Updates...` action. The same
finalizer updates Homebrew only after the manifest succeeds. This single-writer
design removes the release-asset race that previously required serial builds.

For Developer ID builds, Tauri first notarizes, staples and uploads the app
updater artifact without creating a DMG. The workflow then builds each DMG in a
staging path, submits it as a separate notarization artifact, staples and
validates its ticket, and runs Gatekeeper's primary-signature check. Only a DMG
that passes all checks is uploaded to the public release. A failed container
check fails that macOS matrix leg and blocks the Homebrew tap update.

macOS bundles must be code signed before publishing. The repository default
remains explicit ad-hoc signing (`bundle.macOS.signingIdentity = "-"`) for local
development, but the release workflow fails closed unless the complete
Developer ID and notarization secret set is present. Configure these GitHub
Secrets before publishing a release:

- `APPLE_CERTIFICATE` — base64 encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD` — app-specific password
- `APPLE_TEAM_ID`

The release workflow imports `APPLE_CERTIFICATE` only inside the macOS signing
prep step, and it sends Apple notarization env vars only to the Developer ID
build branch. It intentionally does not pass unset Apple secrets into
`tauri-apps/tauri-action`, because empty environment variables make Tauri try
to import or notarize with blank credentials.

Minimum Apple Developer setup for direct distribution:

1. Create a `Developer ID Application` certificate. The default Maru bundle
   intentionally has no managed entitlement or HTTP/HTTPS browser-role
   declaration, so it does not require an App ID or provisioning profile.
2. Install the downloaded `.cer` into Keychain Access, then export it with its
   private key as a password-protected `.p12`.
3. Encode the `.p12` and set the release secrets:

   ```bash
   tmp_cert_b64="$(mktemp)"
   openssl base64 -A -in DeveloperIDApplication.p12 -out "$tmp_cert_b64"
   gh secret set APPLE_CERTIFICATE --repo STAIxBWLB/maru --body-file "$tmp_cert_b64"
   rm "$tmp_cert_b64"

   gh secret set APPLE_CERTIFICATE_PASSWORD --repo STAIxBWLB/maru
   gh secret set KEYCHAIN_PASSWORD --repo STAIxBWLB/maru
   gh secret set APPLE_ID --repo STAIxBWLB/maru
   gh secret set APPLE_PASSWORD --repo STAIxBWLB/maru
   gh secret set APPLE_TEAM_ID --repo STAIxBWLB/maru
   ```

4. Confirm release readiness without printing secret values:

   ```bash
   make macos-distribution-check
   make macos-distribution-local-check
   ```

For a local notarization smoke test, keep Apple files under
`~/workspace/work/.maru/secrets/apple/`:

- `DeveloperIDApplication.p12`
- `AuthKey_<APPLE_API_KEY_ID>.p8`
- `certificate-password`
- `api-issuer-id`
- optional `api-key-id` (defaults to the `AuthKey_<id>.p8` filename)
- optional `keychain-password` (generated locally if missing)

Then run:

```bash
make macos-notarize-local TARGET=aarch64-apple-darwin
```

Keep the Tauri updater secrets (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in place; they sign updater metadata and
are separate from Apple Developer ID signing. The workflow fails on partial
Apple signing configuration instead of silently producing an unintended ad-hoc
macOS release.

Browser-passkey packaging is a separate, fail-closed opt-in. The default
`src-tauri/tauri.conf.json` omits both the managed entitlement and HTTP/HTTPS
browser-role metadata; the runtime checks the effective code signature with
`SecTaskCopyValueForEntitlement` and returns `unsupported` before loading or
constructing Apple's browser passkey manager. This keeps `tauri dev`, CI,
ad-hoc bundles, and older supported macOS releases launchable.

`src-tauri/tauri.passkeys.conf.json` is an active, opt-in overlay. The app
bundle contains one Mach-O executable (`maru`) plus an executable
`Contents/Resources/maru-cli` shell wrapper that dispatches to
`../MacOS/maru --maru-cli`; the standalone/Homebrew `maru-cli` Mach-O lives in
the separate `src-tauri/maru-cli` workspace package, outside the app package's
binary targets. This prevents Tauri from applying the
managed entitlement to an unprovisioned helper. Incoming HTTP/HTTPS open
events are filtered into a bounded memory queue, emitted as
`sites://open-requested`, and can be drained after cold start. The Safari
fallback opens `com.apple.Safari` directly so Maru cannot recursively invoke
itself when registered as the default HTTP/HTTPS handler.

Passkey-enabled distribution requires an Apple-approved managed capability, a
Developer ID provisioning profile, and notarization. The provisioned build also
launches into Sites because Apple requires a browser surface on launch. The full
runbook, including Apple's review criteria and the stop condition when the
capability is not offered for Developer ID distribution, is
[docs/macos-passkeys.md](docs/macos-passkeys.md):

```bash
export MARU_MACOS_PROVISIONING_PROFILE=/absolute/path/to/Maru.provisionprofile
export APPLE_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)'
export APPLE_TEAM_ID=TEAMID
make macos-passkey-readiness-check
make macos-passkey-notarized-build
```

The normal release workflow never selects this overlay. Calling `tauri build`
with the overlay directly, without the staging and readiness checks, is
unsupported.

Release asset versions come from `package.json`, `src-tauri/tauri.conf.json`,
the root and CLI Cargo manifests, and their package entries in
`src-tauri/Cargo.lock`. `make release-version-check` validates all of them with
locked Cargo metadata. The release preparation job additionally requires the
published tag to equal `v<package version>` and stops before any platform build
if the versions or tag disagree.

The finalizer in `release-bundles.yml` pushes the tap update automatically once
the platform builds and updater manifest finish. The `make homebrew-*` targets
below are for verifying that result, or for recovering by hand if finalization
failed:

```bash
make homebrew-update-commit RELEASE_TAG=v$(node -p "require('./package.json').version") HOMEBREW_TAP_DIR=../homebrew-cask
make homebrew-audit HOMEBREW_TAP_DIR=../homebrew-cask
make homebrew-fetch HOMEBREW_TAP_DIR=../homebrew-cask
```

After downloading the release DMG, verify Gatekeeper-facing state on macOS:

```bash
xcrun stapler validate Maru_*.dmg
spctl -a -vv -t open --context context:primary-signature Maru_*.dmg
codesign --verify --deep --strict --verbose=4 /Applications/Maru.app
spctl -a -vv -t exec /Applications/Maru.app
```

## Workspace Layout

An AI workspace is any folder containing `.md` (or `.markdown`, `.html`, `.htm`) files.

### Scratchpad

The primary private workspace owns one Scratchpad root. `ideation/`,
`memos/`, and the configurable drafts collection are durable, Git-tracked
content; only `temp/` is disposable and Git-ignored. The Drafts mode owns
ideation files and implementation drafts; the Scratchpad pane lists only
memos and temporary results.

```text
<work>/scratchpad/
  ideation/{seeds,developing,proposals,_archive}/
  memos/
  drafts/  # scratchpad.drafts_subdir default; headless producers use $MARU_DRAFTS
  temp/{claude,codex,kiro,kimi,runtime}/
```

`workspace.config.yaml` may set `paths.scratchpad` and the
`scratchpad.{ideation_subdir,memos_subdir,temp_subdir,drafts_subdir,editable_extensions,temp_stale_days,ideation_review_days,editable_max_bytes}`
policy, plus `drafts.promote_dir` for the document-promotion suggestion
(default: `_incoming`). The promote directory must be a safe relative path
outside `scratchpad` and `.maru`; it does not restrict an explicit target path
entered in the promote dialog. `drafts_subdir` defaults to `drafts`, must be a
safe relative path, and cannot overlap another collection. Maru exposes the
resolved root as `MARU_SCRATCHPAD`, the resolved draft collection as
`MARU_DRAFTS`, its disposable
subdirectory as `MARU_TEMP`, and places Claude runtime files below
`$MARU_TEMP/runtime/claude` through `CLAUDE_CODE_TMPDIR`.

Scratchpad edits support `.md`, `.markdown`, and `.txt`. Ideation files older
than the review threshold are flagged for review but never cleaned
automatically. Temp cleanup is an explicit, per-file system-Trash operation.
Legacy `.maru/memos` migration is also explicit and verifies each destination
before removing its source. The pane keeps recovery drafts locally when it
cannot flush safely and never mutates tracked files merely by opening.

Verify the frontend contract with `pnpm test`, `pnpm typecheck`,
`pnpm lint:i18n`, and `pnpm build`; Rust containment, revision, migration,
cleanup, and watcher behavior is covered by `cargo test --lib scratchpad`.

Private workspace is the required default. Public workspace is optional and means a provider-managed shared root, not internet publishing. V1 capability support is registry-only: Maru stores non-secret provider metadata in `workspaces.json`, maps a manually entered provider role to coarse capabilities, intersects that with a filesystem writability probe, and gates direct writes in the UI and Rust commands. OAuth, Microsoft Graph, Google Drive, and Nextcloud live API checks are deferred.

Supported public providers are Local, Google Drive, OneDrive, SharePoint, Nextcloud, Obsidian, and Unknown. `workspace.config.yaml` accepts:

```yaml
paths:
  private: ~/workspace/work
  public:
    - label: Team Drive
      path: ~/gdrive-workspace/work
      provider: googleDrive
      providerId: shared-drive-id
      writePolicy: direct
      role: contentManager
    - label: Reference Site
      path: ~/shared/reference
      provider: sharePoint
      writePolicy: readOnly
      role: Can view
```

Maru stores user/global preferences at:

```
~/.maru/
  settings.json    # UI/theme/layout/window/split/terminal/explorer/file-queue/AI defaults
```

Maru stores workspace-local state and resources at:

```
<workspace>/
  .maru/
    cache/           # disposable workspace index for warm startup
    workspace-state.json # collapsed folders, initialization flags, binary patterns, overrides
    versions/        # snapshots created via the "Version" button
    studio/          # per-document Studio wizard state
    binder/          # per-document Evidence Binder state
  .maruignore      # optional, gitignore-style segment patterns (falls back to legacy .anchorignore)
```

`<workspace>/.maru/settings.json` is a legacy migration input only. Maru reads
it when present to build effective settings, but new workspaces do not get that
file.

`.maruignore` example for the user's `~/workspace/work`:

```
node_modules
.venv
dist
build
target
.next
.turbo
.cache
.maru/cache
```

## Critical invariants

1. **Filesystem is authoritative.** The fingerprinted cache (`<workspace>/.maru/cache/workspace-index-v3.json`) is disposable. Warm reconciliation reuses unchanged entries and reparses changed files only; React state remains derived.
2. **Frontmatter key order + comments preserved.** A single-field patch must never disturb the order or comments of any other key (verified by cargo test). `src-tauri/src/frontmatter/ops.rs` is the only allowed write path.
3. **Crash-safe rename.** `.maru-rename-txn/` staging dir + recovery on the next workspace scan.
4. **Dynamic relationship detection.** Any frontmatter field containing `[[wikilink]]` is treated as a relationship. No hard-coded field lists.
5. **Symlinks inside the workspace are honored.** Deliberate user-created symlinks (e.g. `~/workspace/work/inbox/downloads → ~/gdrive-workspace/...`) are considered part of the workspace. Maru uses lexical containment, not `canonicalize()`.
6. **Managed vault writes are schema-gated + snapshotted.** `write_policy: "managed"` writes pass `vault_guard::validate_managed_write` and take a snapshot before mutation; note deletion stays MCP-only.

## Hard "No" list (v1)

Out of scope for v1 by explicit decision:

- Semantic / embedding search (keyword + wikilink + git-grep cover 10k notes).
- Cloud sync, maru account, default telemetry (opt-in only).
- Mobile (Tauri 2 mobile is unstable; Obsidian owns mobile for now).
- Public marketplace server (cloned sources carrying a `maru.source.json`
  manifest are schema-validated on install and rolled back on failure; the
  manifest `signed` flag is a metadata check, not cryptographic signature
  verification — no server, no moderation policy).
- iMessage / Slack ingestion (permission pain > value).
- Multi-user collab, CRDT, realtime (single user, single device, git for history).
- PDF annotation, OCR (file-extracted text is enough).
- Agent-autonomous edits as default behavior. Autonomy is staged behind disposable workspaces, protected writes, approval policy, and audit events.
- iCloud / Dropbox workspace awareness (user's responsibility).
- Unsigned / ad-hoc auto-updater feeds (updates are accepted only through signed GitHub Release artifacts).

## License

No license file is currently published. All rights reserved unless a license is added.
