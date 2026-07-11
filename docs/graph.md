# Graph mode (Phase 8)

The `graph` activity-rail mode (label 그래프 / Graph) renders the vault as a
knowledge graph and, with managed writes enabled, lets you edit note frontmatter
under a schema gate. It ships in three layers — 8a (read-only), 8b (managed
writes), 8c (graph-driven authoring) — all landed and default-on, then refined
by **V2** (warm-start worker, design-token UI, client-side insights) and **V3**
(imperative rendering, persisted usability affordances, legend/hull
visualization, PNG/SVG export), and **V4** (Sigma WebGL, Graphology
ForceAtlas2 worker, incremental index refresh, reviewed relationship writes).

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

## Rendering (V4)

- `src/components/graph/GraphView.tsx` — mode shell; owns the model, filters,
  selection/path/insight state, and one reused layout worker.
- `src/components/graph/GraphCanvas.tsx` — Sigma WebGL renderer over a
  Graphology `MultiDirectedGraph`. GPU picking owns hit testing; reducers own
  hover, path, selection and visibility. Filters never rebuild topology or
  restart layout.
- `src/components/graph/GraphLegend.tsx` — collapsible color key overlay
  (communities when enriched, else domains); each swatch toggles the filter.
- `src/components/graph/GraphToolbar.tsx` — search, graph/chains view switch,
  zoom cluster, re-layout, community-overlay refresh, stats.
- `src/components/graph/GraphFilterPanel.tsx` — domain/type/community chips with
  counts + color swatches, min-degree slider, reset.
- `src/components/graph/GraphInspector.tsx` — selected-node metadata + typed
  in/out neighbors (click to walk) + actions (open / focus / start path).
- `graphology-layout-forceatlas2/worker` — Barnes-Hut ForceAtlas2 worker.
  Cached coordinates paint immediately, layout stops after three stable
  samples or five seconds, and drag stops layout before pinning the node.
- `NeighborhoodPane` gains a "그래프에서 보기" (view in graph) button that focuses
  the graph on the active document.

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
  survive mode switches / restart; command palette has an **open-graph**
  action.

### Performance (V4)

Sigma batches nodes and edges into WebGL programs, so the former per-frame SVG
attribute writes are gone. Search and facets update hidden attributes through
reducers. Insights run in `analysis.worker.ts`; the main thread remains
interactive while hidden-link, bridge, stale and orphan analyses run.

Layout cache v2 stores the full position map and pinned ids, migrates v1 on
read, merges partial updates, and uses atomic replacement. WebGL context loss
gets a restore attempt, then degrades to a static SVG graph at 2k nodes or a
searchable inspector/list for larger models.

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

- vitest: `src/lib/graph/model.test.ts`, `insights.test.ts`,
  `decisionChains.test.ts`; `src/lib/settings.test.ts` (graph
  settings round-trip); perf bench `src/lib/graph/perf.bench.ts` (build / layout
  / insight-pass / cold `buildAdjacency` budgets).
- 2026-07-11 local baseline at 10,000 nodes / 59,994 edges: model build 47ms,
  ForceAtlas2 20 iterations 694ms, visibility update 0.021ms, insight pass
  129ms, cold adjacency build 9.7ms (benchmark means; hardware-dependent).
- cargo: `vault_graph` — overlay read + layout-cache round-trip.
- e2e: `e2e/graph.spec.ts` (mode entry, filter, select/double-click, chain view,
  toolbar + insights + inspector; hover highlight, drag-pin/unpin,
  search-as-filter, settings persistence across a mode switch, context menu,
  inspector favorite ★, PNG/SVG export download). Interaction selectors are
  exposed only by the dev/E2E graph bridge, not production DOM. **Scope note** — the enrichment
  path (`vault_graph_read`) is Tauri-only, so the browser-mode e2e suite verifies
  the *degraded* live-layer path (no communities → legend covered by
  vitest); the enriched overlay path is covered by vitest + cargo fixtures.

## Deferred

The only remaining Phase 8 item is **Hub graph-metadata sync** — held out of
scope until a Hub consumer exists.
