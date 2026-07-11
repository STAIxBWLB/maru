# Changelog

All notable changes to Maru. Format is loosely [Keep a Changelog](https://keepachangelog.com/);
entries are grouped by release milestone rather than one section per patch tag,
because releases cut frequently during active development. Versions before
**v0.3.0 shipped under the name Anchor**; the M0 rename landed in v0.3.0.

Dates are the release-tag dates. Only `feat`/`fix`-level changes are listed;
`chore(release)` version bumps and merge commits are omitted.

## v0.4.2 — 2026-07-12 — Graph UI refresh (Obsidian-benchmark) + business-unit lifecycle Tree C

**Graph UI refresh**, benchmarking Obsidian's graph view:

- All canvas colors (labels, node borders, edges, dim states, ghost fill,
  export backgrounds) now derive from the app's theme tokens; the graph
  follows dark mode live, including the legend/filter/inspector swatches.
- Added two 12-color, CVD-validated community palettes (light/dark, stable
  slot order across themes).
- Replaced binary label-threshold popping with a zoom-linked fade (custom
  Sigma drawers) and added a hover-grow affordance.
- Removed community hulls entirely (`feat!`); communities are now
  Obsidian-style color groups keyed by the legend. Stored `showHulls`
  settings are silently dropped.
- Quieter, theme-derived edge weights.
- Unified panel/toolbar typography on one type scale with tabular numerals.
- Fixed a pre-existing accessibility bug where the graph's screen-reader
  selection live region had no CSS rule and rendered visibly over the canvas.

**Business-unit lifecycle (Tree C alignment):**

- Aligned the `business-unit-lifecycle` skill template with the workspace
  Tree C grammar: proposal-first scaffold (dropped empty 01-05 scaffolds),
  `_inbox` renamed to `_incoming`, added a bare `06-proposal` README.
- Single-sourced `YEAR_LEAVES` and fixed two contract mismatches
  (`external-dispatch` -> `official-documents`; dropped stray
  `02-admin-approvals` leaves).
- `new_business_unit.py` gained `--with <category>` activation and
  `--profile cycle`; added `graduate_unit.py`, emitting a
  `migrate_tree.py`-compatible manifest for cycle -> L3 graduation.

## v0.4.1 — 2026-07-11 — Graph V4 hotfix

- Fixed the Sigma node/edge reducers to merge over the incoming display data
  instead of replacing it. The bare-patch returns dropped node `x`/`y`, so the
  Sigma constructor threw on every mount and v0.4.0 silently fell back to the
  static renderer; the WebGL pipeline, ForceAtlas2 layout (community hulls),
  and PNG/SVG export never initialized.
- Renderer init failures are now logged and the container is cleared, so a
  failed constructor can't leave dead canvases stacked above the fallback
  swallowing pointer events.
- e2e hardening: the DOM overlay is the only `.graph-node` surface while
  active, stretches to the full canvas, and settings fallbacks write to the
  workPath-namespaced key; the multi-select Files drag uses synthesized drag
  events so virtualized row recycling can't shift the drag source mid-gesture.

## v0.4.0 — 2026-07-11 — Graph V4 (WebGL) + skills sync

- Replaced the SVG/d3-force hot path with lazy-loaded Sigma WebGL,
  Graphology `MultiDirectedGraph`, and a Barnes-Hut ForceAtlas2 worker.
- Filters and search now use visibility reducers without topology rebuilds or
  relayout; knowledge/workspace/all-file sources, connected/all scopes, and
  local depth/direction controls were added.
- Added layout cache v2, fingerprinted workspace cache v3, workspace watcher
  refresh, nested-workspace ownership enforcement, revision conflicts, atomic
  writes, and unique managed snapshots.
- Moved graph insight computation to a worker and added weighted hidden-link
  recommendations with reviewed typed/reciprocal relationship writes.
- Split non-default modes and BlockNote into lazy chunks, reduced initial JS
  from about 1,051KB to about 311KB gzip, deferred editor statistics, and
  hydrated only the visible startup tabs.
- Fixed native graph/comms/tasks settings persistence and the multi-selection
  drag payload race. Removed an embedded NUL byte from this changelog.
- Added `maru skills sync --check|--apply --tools claude,codex`, five source
  ownership classes (bundled, owned catalog, imported, external-managed,
  tool-native; the last two inventory-only), and a strictly read-only `maru
  doctor`; hardened manifest/import path traversal and symlink handling.

## v0.3.3 — 2026-07-09

**Graph mode V3** — visualization, speed, usability, connectivity, utility:

- Performance: imperative rendering pipeline — React owns structure, the DOM
  owns geometry (node transforms + edge endpoints written via `setAttribute`
  from worker frames, rAF-coalesced). Hover is O(neighbors) via a container
  class + `classList` (no reconciliation); child subtrees memoized so pan/zoom
  touches only the container transform; `buildAdjacency` memoized per model.
- Usability: persisted graph settings (`MaruSettings.graph` — view / filters /
  search-mode / hulls), search-as-filter toggle, node right-click context menu,
  and an `open-graph` command-palette action.
- Connectivity: Favorites integration (★ marker + context-menu / inspector
  toggle, shared with the Explorer) and insight → action (copy `[[wikilink]]` /
  open source note on hidden-link rows).
- Visualization: collapsible color legend (doubles as a filter) and translucent
  per-community convex-hull areas.
- Utility: PNG / SVG export of the current view (computed-style inlining +
  `getBBox` viewBox), with a Tauri save dialog and browser-download fallback.

## v0.3.2 — 2026-07-08

**Graph mode V2** (PR #67) — reworked for speed, a refined UI, and ideation:

- Performance: one reused layout worker (was terminate + recreate + full
  relayout on every filter change), per-id warm-start, epoch-gated frames, and
  a disk layout cache (`.maru/cache/graph-layout.json`). Memoized SVG
  node/edge children so pan/zoom only updates the container transform.
- UI: real design-token toolbar / filter panel / right-pane inspector + insight
  tabs; click selects, double-click opens, ctrl/⌘-wheel zooms.
- Insight/ideation (`src/lib/graph/insights.ts`): hidden-link candidates,
  surprising cross-community connections, community bridges, orphan/stale
  notes, and shortest-path finding.

**Explorer Favorites** (PR #68) — pin files and folders from the Documents /
Files context menus. Stored per-workspace in `.maru/workspace-state.json` with
path-safe normalization; missing-target handling and ko/en labels.

## v0.3.1 — 2026-07-08

- CI: `make verify` (typecheck + vitest + cargo test + build) now runs on every
  pull request and push to `main`.
- fix(vault): coerce non-string YAML frontmatter keys to JSON-safe strings so
  the document list no longer renders empty on template-placeholder frontmatter.
- docs: README rebuilt for the v0.3.0 state (Phase 8, 11 modes, rename); new
  graph/diagram/studio mode references and this changelog.

## v0.3.0 — 2026-07-08

**M0: Anchor → Maru full rename** (`feat!`). App id `com.anchor.app → com.maru.app`
(bundle `kr.maru.desktop`), dirs `~/.anchor → ~/.maru`, CLI `anchor → maru`,
Homebrew tap tokens. One-time on-disk migration with a back-compat symlink;
`.maruignore` preferred with `.anchorignore` read fallback. All three version
manifests (`package.json`, `tauri.conf.json`, `Cargo.toml`) → 0.3.0.

**Phase 8 — Vault knowledge graph** (shipped ahead of the linear W-plan):

- **8a — read-only graph mode** (PR #61): new `graph` mode, dual-source
  GraphModel (live `VaultEntry.links` + `<vault>/reports/vault-graph.json`
  community overlay, graceful degrade), `vault_graph_read` command, d3-force
  layout worker, GraphCanvas with viewport culling, filter/search/hover, and a
  NeighborhoodPane "그래프에서 보기" button.
- **8b — managed vault writes** (PR #62): `write_policy: "managed"`,
  `vault_guard` schema gate (`validate_managed_write` + `vault_validate_note`),
  EditorPane validation strip + OutlinePane frontmatter form, snapshot-before-write.
- **8c — graph-driven authoring** (PR #63): NewDocumentDialog neighbor panel,
  unresolved-wikilink → create-note, decision-chain timeline lanes.
- Fix: `model.ts` literal NUL byte → `` escape (PR #64).

**Skills / knowledge graph**:

- `build-graph.py --work-root` — 2-layer workspace knowledge graph builder.
- `md2docx`: Mermaid flowchart → native docx diagram + per-list numbering instances.
- Align `vault-lint` / `inbox-intake` / `inbox-process` with the English naming policy.

## v0.2.36–v0.2.40 — 2026-06-28 → 07-02 · HWP engine migration

- **Migrate HWP tooling from `hwp-toolkit` (Python) to `hwp-cli` (Rust).** Drop
  the bundled Java/JRE — HWPX generation is delegated to `hwp-cli` (#57).
- `md2docx` skill (markdown → docx) added alongside the hwp-cli engine (#56).
- HWPX `add-rows` / `fill-table` verbs for form table growth (#58).
- Templateless HWPX generation applies a default public-document (table-centric)
  style; reconcile the skill to the upstream hwp-cli interface.
- Fix: meetings display English `YYMMDD-meeting-<slug>` notes; align writer template.
- Folder-placement routing + `business-unit-lifecycle` Tree B (v2).

## v0.2.25–v0.2.35 — 2026-06-01 → 06-12 · Sites, terminal, comms

- **Sites mode** — left-rail site switcher with an embedded native browser pane (#55).
- **Terminal**: Rust-native `alacritty_terminal` renderer (#48); direct paste,
  focus restore, warp-level selection, ⌘K clear (#54); multi-task sidebar +
  active-item context for CLI agents (#47).
- **Comms**: multichannel comms-processing settings (#49).
- **Tasks**: edit task details, preserve provider PATH (#53).
- **Inbox**: batch review & confirm flow for `inbox-process` (#46).
- **Meetings**: transcript & auto-summary intake for the `meeting-notes` skill (#45).
- **Outline**: compact outline, vault backlinks, scoped ⌘A (#44).
- **Skills**: symlink/copy install choice, sync-all, install-mode UI (#43); manage
  workspace secrets under the app dir.
- Fix: prune oversized Tauri debug artifacts; file context-menu viewport/portal fixes.

## v0.2.13–v0.2.24 — 2026-05-24 → 05-31 · Diagram, HWPX engine, Codex peer

- **Diagram mode** scaffold — concept-map editor Phase 0 (#32), later hardened
  through Phase 7 (see [docs/diagram.md](docs/diagram.md)).
- **HWPX**: robust lxml editing engine + reference-form workflow, with section
  property guards and engine-review hardening.
- **Agents**: Codex as a first-class headless peer + revived 5-role loop (#40).
- **Context enrichment** (Phase 2): bidirectional linkage across `meeting-notes`
  / `task-management` / `inbox-process` / `vault-*` (#39).
- **Files**: in-app binary viewer tab (#34); Files list view with mtime sort +
  right-pane filter (#33).
- Layout: move document-types pane to the right; fix card title clip (#31).
- Fix: terminal hover-selection regression (#37), suppress mouse tracking (#35).

## v0.2.0–v0.2.11 — 2026-05-04 → 05-15 · Phase 3–4 backbone, shell

- **Phase 3 (M1 Operations Catalog + M7 Hub read)**: `ops_catalog` + `hub_client`
  scaffolds → real indexing + Catalog mode (W3), fs watcher + Hub HTTP fetch +
  drilldown (W4), Hub Library client + template-aware new doc (W5), Writing
  Guideline sidebar (W6).
- **Phase 4 (M4 Export + M2 Studio)**: export pipeline W8 scaffold → W9 manifest
  transitions + validate → W10 run-bundles-from-manifest dispatch; Hub frontmatter
  prefill in `create_document` (W7); Document Studio multi-step wizard (W11, #24);
  HWP field map + 개조식 inline lint (W12, #25).
- **Skills SSOT**: `skill_host` tier enforcement; `business-unit-lifecycle` skill (#19);
  expose Node runtime to skill runs.
- **Shell**: split panes + side utilities, resizable panes, file context menu,
  memo autosave; native update checks; Meetings app mode + skill review workbench.
- Fixes: macOS bundle signing / notarization gating, terminal launch + window
  close, file-queue drag drops, DMG detach before bundling.

## v0.1.0 — 2026-05-04 · Phases 0–2 foundation (as Anchor)

- **Phase 0 — Hardening**: frontmatter byte-identity safety, multi-vault registry,
  ko/en i18n.
- **Phase 0.5 — UI polish**: topbar, outline, command palette, real markdown preview.
- **Phase 1A — Killer-feature MVP**: wikilink autocomplete + navigation,
  neighborhood pane, frontmatter inspector; robust doc-row selection.
- **Phase 1B — Rich editor / git**: git status badge + commit-from-app (changed
  files, per-file diff, syntax color, focus auto-refresh); multi-tab keybinds
  (⌘1..⌘8, ⌘W). Symlink lexical containment; active-vault desync recovery.
- **Phase 2 — Inbox + AI**: backend-first inbox (polling, watcher, Korean date
  parser, Claude CLI bridge, tolerant-JSON classifier); InboxPane wired to the
  watcher + classifier; Gmail section via the `gws` CLI; workspace system mode;
  configurable inbox path + source filter; workspace switching.
