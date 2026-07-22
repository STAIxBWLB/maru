# Changelog

All notable changes to Maru. Format is loosely [Keep a Changelog](https://keepachangelog.com/);
entries are grouped by release milestone rather than one section per patch tag,
because releases cut frequently during active development. Versions before
**v0.3.0 shipped under the name Anchor**; the M0 rename landed in v0.3.0.

Dates are the release-tag dates. Only `feat`/`fix`-level changes are listed;
`chore(release)` version bumps and merge commits are omitted.

## v0.4.12 — 2026-07-23 — Graph Workbench V5

- **Adaptive graph workspace.** The graph shell measures its own width and
  switches tiers: wide (≥1280, Filters + Workbench docked with drag-resize),
  standard (920–1279, Filters as overlay), compact (<920, mutually exclusive
  overlays). Docked visibility and widths persist in `MaruSettings.graph.panels`.
- **Settings V2 with a single derive pipeline.** `GraphSettingsV2` adds
  per-source filter profiles (domains/types/relations/community, generated/
  unresolved visibility, min-visible-neighbors k-core pruning — replacing the
  old scope toggle and min-degree), display settings (arrows, label density,
  node/edge scale), panel state, and working saved views, with V1→V2
  migration. `src/lib/graph/derive.ts` is the one pure pipeline behind the
  canvas, insights, pathfinding, and export, with paused-filter reporting so
  stale persisted selections never silently blank the graph.
- **Untyped notes are authored content.** Notes without a frontmatter `type`
  stay visible by default; only configured `generatedPatterns` paths count as
  generated.
- **Hardened renderer.** Explicit state machine
  (loading / layout-running / ready / gpu-recovery / fallback / fatal),
  zero-size mount gating, ResizeObserver-driven resize without camera moves,
  camera-fit rules, pins synced to ForceAtlas2's native `fixed` attribute,
  layout-worker error isolation, and disk-cache position validation.
- **Canonical Local navigation and truthful visibility.** Neighborhood handoff
  now carries source + workspace owner + relative path instead of a
  collision-prone filename stem. Local focus survives facet, relation,
  neighbor, and search filtering; every canvas edge, Inspector view, insight,
  path, and export consumes the same derived visibility contract.
- **Workbench, combobox, display controls.** Radix-tabbed Insights/Details
  workbench with 6-row previews and via/score evidence on hidden-link
  candidates; a ranked search combobox over the filtered graph;
  arrows/label-density/scale controls hot-applied without rebuilds;
  per-relation edge colors; production ★ favorite markers; and saved-view
  create/apply/delete controls for source, mode, Local target, filters, and
  display settings.
- **Real-Sigma e2e.** The fake DOM test overlay is replaced by a dev-only
  `window.__maruGraph` bridge driving the actual WebGL renderer
  (`e2e/graph.spec.ts`), plus a shell-geometry regression suite
  (`e2e/graph-shell.spec.ts`) covering the right-docked-terminal zero-size
  canvas bug. `pnpm test:e2e:graph` and `pnpm bench:graph` scripts added.

- **Graph fixes from adversarial review.** Path-highlight reducers precompute
  their overlay sets once per highlight change instead of rebuilding a
  path-sized set per node on every Sigma refresh (seconds of frozen canvas on
  long paths at 10k nodes); canonical Local targets with an unknown owner
  match on relative path alone, so "View in graph" resolves against
  owner-stamped scanner entries; the derivation pipeline splits into a stable
  analysis stage and a transient search stage, so typing in search no longer
  restarts the insights worker with a full graph clone per keystroke; the
  filtered-empty "Reset filters" action also clears the search query; and the
  insights worker logs failures instead of silently showing empty sections.

## v0.4.11 — 2026-07-23 — Terminal Hardening + Scheduled Jobs

- **Scheduled jobs registry (launchd).** Jobs are declared as data in
  `<work>/.maru/jobs.json` and managed by Maru: per-workspace launchd labels
  (`com.maru.job.<id>.<hash>`), hand-rendered plists with safety gates, a
  System → Jobs tab, and a `maru jobs` CLI. First consumer is the daily mail
  digest, replacing its script-owned LaunchAgent.
- **Jobs launchd-semantics fixes from adversarial review.** Stop now boots the
  service out as well as disabling it, so a stopped schedule actually stops
  firing; Start re-bootstraps after enabling instead of only flipping the
  disabled flag; Install enables before bootstrap so reinstalling a previously
  stopped job no longer fails, and installing a disabled job no longer leaves
  its schedule loaded. `StartInterval` is omitted when no recovery interval is
  declared (launchd rejects 0), flag and URL arguments pass through without
  workspace-path mangling, and jobs.json now rejects duplicate ids and
  out-of-range schedules.
- **cmux-class terminal interaction hardening.** The integrated terminal now
  accepts the first macOS click, mounts before launch requests, restores actual
  textarea focus across pane/app transitions, and queues early input without
  dropping the first keystroke. PTY output moved from global events and React
  frame state to ordered per-session Channels with generation/sequence guards,
  two-frame credit, hidden-session suspension, compact palette frames, and
  imperative canvas patches. Alacritty now owns scrollback-aware selection and
  copy semantics for soft wraps and wide CJK cells; drag selection is
  animation-frame coalesced, supports edge auto-scroll, and exposes a terminal
  Copy/Paste/Select All/Find/Clear menu.
- **Terminal streaming and lifecycle fixes from adversarial review.** The frame
  emitter no longer loses a condvar wakeup, which could park an idle session
  and leave the last chunk of output unrendered (or strand the pump thread on
  shutdown); pending damage now drains past the credit window when a session
  stops, so the tail of a command's output survives. Sessions unregister on
  kill and on child exit without waiting for a PTY reader that a surviving
  grandchild holds open. PTY and model resize are atomic against the parser,
  bracketed-paste payloads can no longer smuggle their own terminator, the
  input pump fails closed instead of delivering later batches past a dropped
  one, buffered frames are acknowledged so backpressure cannot deadlock,
  unapplied frames force a real resync, launch no longer steals focus from a
  rename or search field, and clipboard copies respect soft wraps.
## v0.4.10 — 2026-07-22 — Unified Scratchpad

- **One Scratchpad pane for memos, ideation, and AI temp files.** The right
  pane replaces the legacy memo tool with a unified view over Git-tracked
  `scratchpad/ideation/` and `scratchpad/memos/` plus ignored
  `scratchpad/temp/` AI artifacts, grouped by collection, ideation stage, and
  temp provider, with search, Markdown preview, autosave, and localStorage
  draft recovery.
- **Contained, revision-checked storage.** Every Scratchpad command validates
  the primary private workspace, rejects traversal and symlinks, publishes
  through canonicalized parents pinned immediately before atomic writes
  (`persist_noclobber` for creates), and requires the current content hash
  for saves, renames, stage transitions, deletes, and temp cleanup; deletes
  and cleanup go through the system Trash.
- **Ideation lifecycle.** Seed → developing → proposal → archive transitions
  (with archive → seed revival) move single files or whole slug directories
  without overwriting, verifying every published asset before removing the
  source.
- **Legacy memo migration.** `.maru/memos/` migrates into
  `scratchpad/memos/` by claiming each file into a per-run staging directory
  first, hash-verifying the copy, and leaving concurrent recreations
  untouched; failures keep their recovery copy and are reported.
- **AI runtime routing.** Maru terminal, agent, and skill subprocesses now
  receive `MARU_SCRATCHPAD`, `MARU_TEMP`, and `CLAUDE_CODE_TMPDIR` resolved
  from the owning private workspace; routing fails closed when the workspace
  registry is unreadable and requires the active private workspace to be
  registered as private.
- **Graph/catalog hygiene.** Ideation stays graph-visible while scratchpad
  memos and temp are excluded from the workspace catalog and graph scans,
  honoring relocated roots and renamed collections from
  `workspace.config.yaml` (skills-bootstrap copy included).
- **Watcher-driven refresh.** A generation-tokened filesystem watcher
  debounces Scratchpad changes into UI refreshes that never clobber in-flight
  edits: stale async reads, out-of-order refreshes, and dirty buffers all
  surface a conflict banner (reload / overwrite / save-copy) instead of
  silently replacing content.

## v0.4.9 — 2026-07-22 — Report Pattern Studio

- **Diagram mode becomes a data-driven report editor.** A new schema v8 adds
  typed `ReportDataset` variants (matrix, hierarchy, timeline, flow, network,
  scorecard) with `PatternView` projections where the dataset is
  authoritative; v7 documents migrate forward on read, with a one-time v7
  backup (`.maru/diagrams/backups/`) taken before the first v8 save and
  unknown future versions rejected rather than down-converted.
- **Typed tables on canvas.** A matrix model with stable row/column/cell ids,
  row/col spans, multi-level headers, group/subtotal rows, per-cell styles,
  and semantic column tags. Fast editing: double-click/F2, Enter/Escape, Tab
  and arrow navigation, range selection, drag resize, merge/split, row/column
  insert/delete with confirmation, one undo entry per gesture, Korean IME
  guards, and free/A4/16:9 page frames (limits: 200 rows / 50 cols / 5,000
  rendered cells).
- **Pattern library + workspace presets.** A searchable Pattern Gallery (16
  report patterns plus the 11 classic templates) with new-document / insert /
  convert-selected flows, favorites and recents, and data-only presets under
  `.maru/diagram-patterns/`. Same-family conversions switch live-linked views
  without copying the dataset; cross-family conversions use a semantic
  field-mapping preview and never mutate the source.
- **Codecs + import/export.** A codec registry with declared fidelity
  (lossless / structural / visual) drives clipboard import (HTML table → TSV →
  Markdown, the Excel/Word/HWP paste path), file import (csv/tsv/md/html/json/
  cmd.json/mmd and Maru-SVG with embedded canonical JSON), structured export,
  and Copy PNG/SVG/table/Markdown.
- **Insert/Update in report.** Renders a hash-named SVG + 2x PNG into
  `attachments/diagrams/<doc-id>/` (guarded atomic Rust command) and splices a
  managed `<!-- maru-diagram:v1 -->` block through the revision-checked
  document save; idempotent updates, conflicts leave the previous asset and
  document untouched. Also fixes pre-existing defects: `body`/`bullets` now
  render (KPI values, SWOT bullets, Kanban items were invisible), exports no
  longer leak selection chrome or drop off-viewport nodes, and the
  auto-snapshot debounce works. Post-review hardening: report-asset paths are
  Windows-safe and ASCII-allowlisted, exported SVG colors are whitelisted
  against markup injection, managed-block JSON escapes the comment terminator,
  hostile paste spans are clamped, a failed v7 backup aborts the save, and
  copy/paste/duplicate of a linked table clones its dataset instead of
  aliasing the original.

## v0.4.8 — 2026-07-22 — Today surface + HTML editing

- **Today: a daily operating surface.** The Tasks mode is now presented as
  **Today** (the existing list/calendar lives on under **All Tasks**) with
  three stages: Prepare (Yesterday Review, Brain Dump, normalized captures,
  Top 3, capacity/sleep cards), Execute (Top 3, flexible queue, fixed
  events, always-visible Done Today), and Review. A Rust logical-day model
  (03:30 boundary, tz-aware capacity with a 480-minute focus cap and 21:30
  sleep guard) drives atomic per-day state with revisions/Undo, a daily
  journal projection that preserves hand-written text, and idempotent
  rollover that seeds Yesterday Review without touching task status. AI may
  plan and replan (validated, reversible) but completion, cancellation,
  deletion, Google Task creation, and calendar publication stay explicit
  user actions, with a durable crash-safe Google Tasks outbox. Post-review
  hardening: crash-safe completion ordering, multi-day-gap rollover,
  logical-day event attribution, per-workspace write locks, and calendar
  publish that cannot clobber concurrent edits.
- **Safe WYSIWYG HTML editing.** `.html`/`.htm` documents open in a Visual
  (sandboxed-iframe contenteditable), Source, or Preview mode, routed away
  from the Markdown pipeline. The document shell, frontmatter, and head are
  preserved byte-for-byte; opening Visual without editing leaves the source
  identical. Scripts never execute (sandbox without `allow-scripts`, plus
  script/handler stripping and an injected CSP). Post-review hardening:
  documents with unpreservable body markup redirect to Source instead of
  silently dropping it, pasted HTML is sanitized, relative asset URLs are
  confined to the document directory, the asset-loading IPC refuses to
  expose the workspace root or `.maru` secrets and re-asserts symlink
  containment, rename preserves the HTML extension, and save returns a
  revision conflict instead of recreating an externally deleted file.

## v0.4.7 — 2026-07-18 — completeness hardening

- **Update + close safety.** The startup update check no longer downloads,
  installs, and relaunches on its own: updates surface as an actionable
  toast (install → "Relaunch now"), and relaunch/window close now confirm
  before discarding unsaved editor drafts. The Rust `CloseRequested`
  handler that force-destroyed windows ahead of the JS close guards was
  removed, so the settings-flush and dirty-draft guards actually run.
- **ko/en parity restored + enforced.** Catalog, Inbox, Settings
  (secrets/migration/inbox channels), approval dialog + prompts, git
  badge, calendar, and editor/graph/diagram strings moved into the central
  dictionary (~200 new keys per locale). Template-based new documents no
  longer bake a Korean placeholder into the body under the en locale. New
  `scripts/lint-i18n.mjs` (`pnpm lint:i18n`, wired into `make verify` and
  CI) fails on key-parity drift and hardcoded UI strings in `src/**/*.tsx`.
- **Hub submit queue is real.** `hub_submit_gate` now POSTs immediately
  when the Hub is enabled (durable-queue fallback on failure), the new
  `hub_queue_drain` command retries queued submits FIFO with
  `retry_count`/`last_error` tracking, and the Catalog footer surfaces
  queue depth with a retry action. Public-mode submits additionally run
  the real-name blocklist.
- **Marketplace manifest enforcement.** Cloned skill sources carrying a
  `maru.source.json` manifest are schema-validated on install and rolled
  back on failure. The `signed` flag remains a metadata check (non-empty
  signature string), not cryptographic verification.
- **Dead surface cleanup.** Wired the Korean date parser into Tasks
  natural scheduling (live parse preview in the dialog + authoritative
  RFC3339 datetime in the skill prompt); removed `default_vault_path`,
  `save_maru_skills`, the manual `export_record_*`/`export_manifest_load`
  commands (superseded by `export_dispatch`), the never-consumed
  `tasks.hooks.autoVaultExtract` setting, and dead TS wrappers.
- Tests: hub queue/drain, marketplace manifest rollback, ops_catalog
  query/drilldown unit tests, CatalogPane component test.

## v0.4.6 — 2026-07-13 — OTA skills bundle channel

- Skills now deploy independently of app releases: merging `skills/**` to
  main publishes a signed immutable bundle (minisign, Tauri updater key) to
  the fixed `skills-channel` prerelease, and the app verifies and applies it
  atomically at launch when local skills are clean and runtime-compatible.
  Editing skills no longer rebuilds or re-releases the binary.
- New bundle machinery in `skill_host`: durable bundle state with pristine
  baselines (`~/.maru/skills/_bundles/`), transaction-journaled swap with
  crash recovery and rollback, downgrade blocking, dirty-edit gate, env-hash
  gate with `--repair-env`, and removed-skill cleanup limited to provably
  Maru-owned symlinks. Builtin dirty detection and reconcile `--discard` now
  baseline against the active bundle instead of the embedded snapshot.
- New surfaces: `maru skills update --check|--apply [--repair-env] [--json]`,
  Skills pane bundle status/actions, launch auto-update with security-error
  surfacing, `skills://updated` live refresh.
- Packaging/CI: `make skills-verify` / `make skills-package`,
  `release-skills.yml` (main-only, step-scoped secrets, immutable assets,
  metadata-last upload), app release workflow gated to `v*` tags, and CI
  change classification so skill-only pushes skip the app toolchain.
- Hardened per two Codex cross-review rounds + adversarial pass: concurrent
  apply race, zip traversal/symlink/decompression-budget/unlisted-file
  rejection, case-fold and NFC filename collisions, Windows reserved names,
  archive-name/revision binding, fresh-install registry seeding.
- Share-outbox skill: staged files can auto-send via Telegram (#79).

## v0.4.5 — 2026-07-12 — App-wide CSS repair

- Fixed elements rendering at browser defaults because their classes had no
  CSS rule: the graph relation dialog's rows and buttons (renamed onto the
  shared dialog/button system), the app-wide `.muted` utility (~28 uses),
  the lazy-mode and editor Suspense fallbacks, writing-guideline spacing,
  and run-log long-token wrapping.
- Settings window repairs (found by an independent Codex audit): the
  secret-editor dialog title rendered at browser-default 24px; the
  no-workspace empty states (settings and tasks) were unstyled; the Tasks
  display settings lacked their 3-column grid; an inert inline-heading grid
  rule; and three undefined CSS variables silently dropping declarations
  (`--panel-muted`, `--success`, inline `--maru-muted`), which had left
  Telegram panels transparent and secrets ok-states colorless.
- Diagram status/export chips now theme correctly in dark mode via
  `--maru-ok/warn/danger-*` tokens.
- Cross-review regressions fixed: checkbox rows no longer stack (selector
  precedence), heading guards use zero-specificity `:where()`, and the
  terminal's intentionally fixed dark palette is documented.

## v0.4.4 — 2026-07-12 — Graph noise filter

- Auto-generated files (lint reports, work logs, summaries) no longer clutter
  the graph: notes without a frontmatter `type` and notes matching the
  configurable `noisePatterns` list (default `reports/`, `log.md`) are hidden
  by default, restorable via a new "show generated/untyped notes" toggle. The
  hidden `unknown` type chip and stale type selections are handled so the
  graph never silently empties.
- The minimum-connections control moved to the top of the filter panel and
  gained a direct number input alongside the slider; its default threshold
  rose to 1 (stored settings keep their value).
- Node sizes shrank (radius cap 20 to 12) for denser, Obsidian-like reading.
- Cross-reviewed with Codex; focus-target visibility, stale type selections,
  and number-input clearing were fixed from its findings.

## v0.4.3 — 2026-07-12 — Toolbar hotfix

- Fixed the graph toolbar's scope toggle (전체/연결됨) overflowing its box:
  the text button reused the 26px icon-button square, so CJK labels wrapped
  one character per line and broke the toolbar layout. The button now sizes
  to its text and never wraps; the source dropdown is pinned against flex
  collapse at narrow widths.

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
