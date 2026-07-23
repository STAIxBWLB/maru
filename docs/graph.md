# Graph mode (Phase 8)

The `graph` activity-rail mode (label 그래프 / Graph) renders the vault as a
knowledge graph and, with managed writes enabled, lets you edit note frontmatter
under a schema gate. It ships in three layers — 8a (read-only), 8b (managed
writes), 8c (graph-driven authoring) — all landed and default-on, then refined
by **V2** (warm-start worker, design-token UI, client-side insights) and **V3**
(imperative rendering, persisted usability affordances, legend/hull
visualization, PNG/SVG export), and **V4** (Sigma WebGL, Graphology
ForceAtlas2 worker, incremental index refresh, reviewed relationship writes).
**V5** reworked the workspace UI (adaptive tiers, per-source filter profiles,
display controls, a single derivation pipeline) and hardened the renderer
lifecycle (state machine, mount gating, camera-fit rules, real-Sigma e2e).
**V6** makes the canvas primary: compact floating controls, one
progressive-disclosure tools surface, dark neutral defaults with a selectable
accent, dense-graph visual LOD, and safe recovery while the canvas container is
temporarily zero-sized. Graph can also stay open as a persistent, resizable
right editor split while documents remain editable on the left.

Spec 정본 (work repo): `_meta/migrations/2607-deep-restructure/specs/maru-vault-graph-spec.md` (DR-020).

## Data model — dual source, graceful degrade

The graph is assembled from two sources by `src/lib/graph/model.ts`:

1. **Live layer** — `VaultEntry.links` extracted from the workspace scan. Any
   frontmatter field containing `[[wikilink]]` is an edge (dynamic relationship
   detection — no hard-coded field list). Always available.
2. **Community overlay** — `<vault>/reports/vault-graph.json`, read by the Rust
   command `vault_graph_read(vault_path) -> Option<VaultGraphFile>`
   (`src-tauri/src/vault_graph.rs`). Tolerant of both `edges` and `links` shapes.
   Supplies community/cluster coloring and precomputed metrics.

If the overlay file is missing or malformed, the model degrades to the live
layer alone — the graph still renders, just without community coloring. The
overlay is produced out-of-band by the `vault-graph` skill
(`skills/lib/build-graph.py`), not by the app.

## Rendering (V4, hardened in V5/V6)

- `src/components/graph/GraphView.tsx` — mode shell; owns the model,
  adaptive tier/panel layout, filter/search/selection/path state, and one
  reused layout worker.
- `src/components/graph/GraphCanvas.tsx` — Sigma WebGL renderer over a
  Graphology `MultiDirectedGraph`. GPU picking owns hit testing; reducers own
  hover, path, selection and visibility. Filters never rebuild topology or
  restart layout. V5 added an explicit renderer state machine
  (`loading | layout-running | ready | gpu-recovery | fallback | fatal`),
  mount gating (no renderer while the container is zero-size), a
  ResizeObserver → coalesced `resize()`+`refresh()` (never a camera move),
  camera-fit rules (fit on first frame, on topology change after settle, and
  when every visible node leaves the viewport — ordinary resizes/filter
  changes never move the camera), and pins synced to FA2's native `fixed`
  node attribute. V6 also enables Sigma's invalid-container guard so hiding or
  maximizing another pane cannot crash the entire app while Graph is mounted.
- `src/components/graph/GraphLegend.tsx` — collapsible color key overlay,
  shown only when it describes the active canvas colors (domain color mode, or
  community color mode on an enriched graph; hidden for neutral); collapses to
  an icon button outside the wide tier.
- `src/components/graph/GraphToolbar.tsx` — compact floating view/source/saved
  selector, search combobox (ranked results over the current filtered graph,
  full keyboard/ARIA), search-as-filter toggle, visible/total counts, one Tools
  toggle, and a More menu (refresh overlay, export, re-layout). The zoom cluster
  floats bottom-right inside the canvas wrap.
- `src/components/graph/GraphFilterPanel.tsx` — Data (generated/unresolved
  toggles, min-visible-neighbors), searchable Domain/Type/Relation/Community
  facet groups, paused-filter chips, Display (arrows/labels/scales).
- `src/components/graph/GraphInspector.tsx` — selected-node metadata + typed
  in/out neighbors (click to walk) + actions (open / focus / start path).
- `graphology-layout-forceatlas2/worker` — Barnes-Hut ForceAtlas2 worker.
  Cached coordinates paint immediately, layout stops after three stable
  samples or five seconds, and drag stops layout before pinning the node.
  A dead worker keeps last-good positions and reports through `onLayoutError`.
- `NeighborhoodPane` gains a "그래프에서 보기" (view in graph) button that focuses
  the graph on the active document.

## Derivation pipeline & settings V3 (V6)

- `src/lib/graph/derive.ts` — one pure pipeline: node facet filter → relation
  filter (before traversal/counting) → local k-hop → `minVisibleNeighbors`
  k-core pruning (focus anchor always retained) → search-as-filter. Produces
  `analysisModel` (insights/pathfinding, before transient search),
  `visibleModel` plus node/edge masks (canvas/Inspector/export),
  facets (incl. relations), `pausedFilters` (persisted values absent from the
  current graph — shown as inactive chips, never silently blanking the
  canvas), `emptyReason` and `focusMissing`.
- **Untyped ≠ generated**: notes without a frontmatter `type` are `"untyped"`
  and visible authored content. Only paths matching `generatedPatterns`
  (trailing `/` = prefix, else exact filename, case-insensitive) count as
  generated (`isGeneratedNode`).
- `MaruSettings.graph` is `GraphSettingsV3` (`schemaVersion: 3`): `source`
  (vault|workspace), `mode` (global|local|chains), `localDepth`/
  `localDirection`, `searchAsFilter`, `generatedPatterns`, per-source
  `profiles` (domains/types/relations/community/showUnresolved/showGenerated/
  minVisibleNeighbors — `minVisibleNeighbors` replaces the old scope toggle
  and minDegree; the V1→V2 migration maps `all`→workspace and
  `max(minDegree, connected ? 1 : 0)`), `display` (arrows typed|all|none,
  label density low|balanced|high, neutral|domain|community colors, optional
  relation colors, dark|light|app theme, violet|green accent, node/edge scale
  0.5–2), `panels` (one optional pinned Tools drawer with a width clamped
  280–480), and `savedViews` (source/mode/localTarget/profile/display per
  view). V2 settings migrate without losing filters or saved views. Legacy
  default displays adopt the V6 dark/neutral/violet canvas defaults. The toolbar
  menu creates, applies, replaces by name, and deletes views; query, selection,
  path, camera, and overlay state remain transient.
- Display wiring is hot-applied: arrows/labels via `setSetting` or attribute
  updates + `refresh()`, never a graph rebuild. Frontmatter edges carry a
  stable `relationColor` (palette hash); body `wiki_link` edges stay neutral.

## Canvas-first workspace (V6)

- The graph stays edge-to-edge at every width. Filters, display controls,
  Insights, and selected-node Details share one Tools surface. It docks as a
  resizable drawer when pinned on wide layouts, overlays the canvas by default,
  and becomes a bottom sheet on compact layouts. Escape closes transient
  layers in order without changing persisted filters.
- Selecting a node exposes a compact selection shelf and moves the shared Tools
  surface to Details; clearing returns it to Insights. Insight sections preview 6 rows with
  a "more" expander; hidden-link rows show shared-neighbor `via` evidence and
  the prediction score.
- Dark, neutral, low-label output is the default. Dense graphs reduce node and
  edge prominence before Sigma draws them, preserving a readable focal
  selection instead of a bright edge mass.
- Favorites render a ★ above the node in the production canvas label drawer
  (plus the warn border ring), not only in the e2e overlay.
- A11y: arrow-key camera pan on the focused canvas (shift for larger steps),
  Enter opens the selection, `aria-live` announcements for selection /
  empty-filter / layout running→done, and `prefers-reduced-motion` turns all
  camera animations instant. Docked panel separators also resize with the
  left/right arrow keys, and static fallback nodes are keyboard-operable.
- In Docs mode, the editor tab toolbar and command palette action "Open graph
  on right" create a resizable document/Graph split. The selected split surface
  persists across restart. Graph interactions keep focus on the right; opening
  a graph node or selecting a document routes the document to the left pane.
  Cmd/Ctrl+W closes only the focused Graph split.

## Local targets and saved views

- A Local target is `{ownerWorkspacePath, relPath}` plus an explicit graph
  source at app handoff. It never uses a basename or node id, so duplicate
  filenames in different folders/workspaces resolve deterministically.
- The Local anchor is protected throughout derivation. If its canonical path
  is absent from the selected source, the focus bar reports that state and
  offers a direct exit instead of silently focusing another note.
- Applying a saved Local view changes source, profile, display, mode, and the
  canonical target in one settings transition. Switching source clears an
  incompatible session focus.

### Interaction

- **Click = select** (metadata in the right-pane inspector), **double-click =
  open** the note in the editor, **drag = move + pin**, **alt-click = unpin**,
  **shift-click = path target**, **right-click = context menu** (open / focus /
  start path / copy `[[wikilink]]` / favorite / unpin), **Esc = clear**
  selection/path/focus (or close the menu).
- Wheel scroll pans; **ctrl/⌘ + wheel zooms** at the cursor. ⌘F focuses search;
  `+`/`-`/`0` zoom in/out/fit.
- Hover highlights a node's 1-hop neighborhood and dims the rest (O(neighbors),
  imperative — no reconciliation).
- **Search-as-filter** (toolbar toggle): narrow the graph to matches + their
  1-hop neighbors, instead of only highlighting the first match.
- **Favorites**: favorite a node from the context menu or inspector; favorited
  nodes carry a ★ marker (shares `settings.ui.favorites` with the Explorer).
- Filters, view and search-mode **persist** in `MaruSettings.graph` and
  survive mode switches / restart; command palette has **open-graph** and
  **open-graph-right** actions.

### Performance (V4)

Sigma batches nodes and edges into WebGL programs, so the former per-frame SVG
attribute writes are gone. Search and facets update hidden attributes through
reducers. Insights run in `analysis.worker.ts`; the main thread remains
interactive while hidden-link, bridge, stale and orphan analyses run.

Layout cache v2 stores the full position map and pinned ids, migrates v1 on
read, merges partial updates, and uses atomic replacement. WebGL context loss
gets a restore attempt, then degrades to a static SVG graph at 2k nodes or a
searchable inspector/list for larger models. PNG/SVG export remains available
from the fallback and observes the same node/edge visibility masks.

## Visualization & export (V3)

- **Legend** — bottom-left overlay keying community (enriched) or domain colors
  with counts; clicking a swatch drives the corresponding filter. It is the
  only color key (no separate area overlay).
- **Color groups**: communities are color groups, not shapes; each node is
  colored by community (enriched) or domain (degraded) via theme-aware
  12-slot palettes, one palette for light and one for dark, with a fixed
  hue-per-slot mapping so colors stay CVD-safe and consistent across theme
  flips (`src/components/graph/graphStyle.ts`).
- **Label fade**: Obsidian-style zoom-linked label fade via custom drawers
  (`src/components/graph/graphLabels.ts`); labels ramp in as a node grows on
  screen (zoom-in or high degree) instead of an all-or-nothing cutoff.
- **Live theming**: all canvas colors read from CSS theme tokens (`--bg`,
  `--ink`, `--accent`, etc.); `GraphView` subscribes to `data-theme` mutations
  and `prefers-color-scheme` changes, refreshes the token cache, and
  re-renders the canvas together with the legend, filter panel and inspector
  so swatches never go stale on a theme flip.
- **Export** — PNG / SVG of the current view (`src/lib/graph/export.ts`): the
  live `<svg>` is cloned, computed styles inlined (`display` included, so the
  label LOD state is preserved), a `getBBox` viewBox is fitted, and PNG reuses
  the diagram rasteriser. Saves via the Tauri dialog with a browser-download
  fallback. Toolbar buttons; filename `graph-YYYY-MM-DD.{png,svg}`.

## Insight / ideation (V2)

The right pane's **Insights** tab (`GraphInsightsPanel` +
`src/lib/graph/insights.ts`) turns the read-only graph into an ideation surface.
All analyses run client-side over the in-memory model (no dependency on the
weekly `build-graph.py` report):

- **Hidden link candidates** — non-adjacent note pairs sharing ≥2 neighbors
  (common-neighbor link prediction); the "derive new relationships" core.
- **Surprising connections** — existing edges that cross community boundaries,
  ranked by combined degree (requires the community overlay).
- **Bridge notes** — nodes whose neighbors span the most distinct communities
  (a cheap betweenness proxy; requires the overlay).
- **Neglected notes** — orphans (≤1 link) and stale well-connected notes.
- **Path finding** — `shortestPath` (BFS) between two nodes: start a path from
  the inspector, shift-click a target, and the chain highlights on the canvas.

Clicking an insight row highlights the pair (dashed virtual edge) or centers the
node on the canvas. Hidden-link rows also carry **actions** (V3): copy the
target's `[[wikilink]]` to paste, or open the source note in the editor.

## Managed writes (8b)

Vault write safety is opt-in per workspace via `write_policy: "managed"`
(toggled in the WorkspaceSwitcher). When enabled:

- `vault_guard::validate_managed_write` + `vault_validate_note(content, rel_path)`
  (`src-tauri/src/vault_guard.rs`) enforce the note schema before any write.
- The EditorPane shows a validation strip; OutlinePane renders a frontmatter form
  (description character counter, type/domain selects, topics chips).
- A **snapshot is taken before every managed write.**
- Note **deletion stays MCP-only** — the app never deletes vault notes directly.

This is the only invariant change Phase 8 introduces to the capability model
(see README "Critical invariants" #6).

## Graph-driven authoring (8c)

Pure-frontend features built on the 8a + 8b primitives:

- NewDocumentDialog neighbor panel (suggests links from the graph).
- Unresolved `[[wikilink]]` → CreateNoteDialog (stub-and-open).
- Decision-chain timeline lanes (`src/lib/graph/decisionChains.ts` +
  `src/components/graph/DecisionChainLanes.tsx`).

## Tests

- vitest: `src/lib/graph/model.test.ts`, `derive.test.ts` (pipeline + dense
  filter/search round-trip <100ms), `insights.test.ts`,
  `decisionChains.test.ts`, `positions.test.ts` (coordinate sanitizing),
  `search.test.ts` (combobox ranking); `src/lib/settings.test.ts` (graph
  settings round-trip + V1→V2 migration); perf bench
  `src/lib/graph/perf.bench.ts` (`pnpm bench:graph` — build / layout /
  insight-pass / cold `buildAdjacency` budgets) with seeded fixtures from
  `src/lib/graph/fixtures.ts` (tiny / empty / dense 1.2k / stress 10k).
- 2026-07-11 local baseline at 10,000 nodes / 59,994 edges: model build 47ms,
  ForceAtlas2 20 iterations 694ms, visibility update 0.021ms, insight pass
  129ms, cold adjacency build 9.7ms (benchmark means; hardware-dependent).
- cargo: `vault_graph` — overlay read + layout-cache round-trip.
- e2e (`pnpm test:e2e:graph`): `e2e/graph.spec.ts` drives the REAL Sigma
  renderer (chromium + SwiftShader) through the dev-only `window.__maruGraph`
  bridge (`localStorage["maru:e2e:graph-bridge"] = "1"`, see
  `src/components/graph/graphBridge.ts` — viewport points, screen state,
  camera snapshot, `freezeLayout()` for determinism). The old fake DOM
  overlay (`maru:e2e:graph-dom`) is gone. `e2e/graph-shell.spec.ts` pins the
  shell geometry across viewports and terminal dock/resize/maximize states
  (the right-docked-terminal zero-size regression). Layout cache writes are
  skipped when settled positions contain non-finite values; cached seeds are
  sanitized on read. **Scope note** — the enrichment
  path (`vault_graph_read`) is Tauri-only, so the browser-mode e2e suite verifies
  the *degraded* live-layer path plus a mock-overlay opt-in
  (`maru:e2e:graph-overlay`); the enriched overlay path is also covered by
  vitest + cargo fixtures.

## Deferred

The only remaining Phase 8 item is **Hub graph-metadata sync** — held out of
scope until a Hub consumer exists.
