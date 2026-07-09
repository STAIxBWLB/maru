# Graph mode (Phase 8)

The `graph` activity-rail mode (label 그래프 / Graph) renders the vault as a
knowledge graph and, with managed writes enabled, lets you edit note frontmatter
under a schema gate. It ships in three layers — 8a (read-only), 8b (managed
writes), 8c (graph-driven authoring) — all landed and default-on, then refined
by **V2** (warm-start worker, design-token UI, client-side insights) and **V3**
(imperative rendering, persisted usability affordances, legend/hull
visualization, PNG/SVG export).

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

## Rendering

- `src/components/graph/GraphView.tsx` — mode shell; owns the model, filters,
  selection/path/insight state, and one reused layout worker.
- `src/components/graph/GraphCanvas.tsx` — SVG canvas. **React owns structure,
  the DOM owns geometry** (V3): node `<g>` transforms and edge endpoints are
  written imperatively via `setAttribute` straight from worker frames, so
  simulation ticks, drags, pan/zoom and hover never reconcile the ~2.4k child
  elements. `NodeView`/`EdgeView` carry no coordinates, and the two child
  subtrees are memoized on their non-viewport props, so pan/zoom touches only
  the container `<g transform>`. A `ResizeObserver` caches the canvas size.
- `src/components/graph/GraphLegend.tsx` — collapsible color key overlay
  (communities when enriched, else domains); each swatch toggles the filter.
- `src/components/graph/GraphToolbar.tsx` — search, graph/chains view switch,
  zoom cluster, re-layout, community-overlay refresh, stats.
- `src/components/graph/GraphFilterPanel.tsx` — domain/type/community chips with
  counts + color swatches, min-degree slider, reset.
- `src/components/graph/GraphInspector.tsx` — selected-node metadata + typed
  in/out neighbors (click to walk) + actions (open / focus / start path).
- `src/lib/graph/layout.worker.ts` — d3-force layout in a Web Worker (the only
  new frontend dependency introduced by Phase 8).
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
- Filters, view, search-mode and hull toggle **persist** in
  `MaruSettings.graph` and survive mode switches / restart; command palette has
  an **open-graph** action.

### Performance (V3)

React drives *structure* (mount/unmount, class changes); the DOM owns
*geometry*. Worker frames are pushed through `applyFrameRef` to a rAF-coalesced
`writeFrame` that mutates `transform`/`x1..y2` directly — only the settled
(`done`) frame reaches React state (for the disk cache and hull rendering).
Hover toggles a container `.has-hover` class plus per-element `.hl`/`.hovered`
via `classList`, so hovering across the graph reconciles nothing.
`buildAdjacency` is memoized per model (WeakMap), shared by the insight/focus
callers.

The layout worker (V2, unchanged protocol) is created once per mount and reused
across filter changes via `update` messages. A per-id position store
**warm-starts** surviving nodes; each request carries an `epoch` that round-trips
so the main thread discards stale frames. `settled` frames are tagged with their
node set, so hulls and the disk cache
(`<workspace>/.maru/cache/graph-layout.json`, `vault_graph_layout_{read,save}`)
never map a stale frame onto a reordered set.

## Visualization & export (V3)

- **Legend** — bottom-left overlay keying community (enriched) or domain colors
  with counts; clicking a swatch drives the corresponding filter.
- **Community areas** — translucent convex hulls per community
  (`src/lib/graph/hull.ts`, monotone-chain, no deps), drawn behind the edges
  from settled positions only. Toggled in the filter panel (enriched only).
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
  `decisionChains.test.ts`, `hull.test.ts`; `src/lib/settings.test.ts` (graph
  settings round-trip); perf bench `src/lib/graph/perf.bench.ts` (build / layout
  / insight-pass / cold `buildAdjacency` budgets).
- cargo: `vault_graph` — overlay read + layout-cache round-trip.
- e2e: `e2e/graph.spec.ts` (mode entry, filter, select/double-click, chain view,
  toolbar + insights + inspector; V3: hover highlight, drag-pin/unpin,
  search-as-filter, settings persistence across a mode switch, context menu,
  inspector favorite ★, SVG export download). **Scope note** — the enrichment
  path (`vault_graph_read`) is Tauri-only, so the browser-mode e2e suite verifies
  the *degraded* live-layer path (no communities → legend/hulls covered by
  vitest); the enriched overlay path is covered by vitest + cargo fixtures.

## Deferred

The only remaining Phase 8 item is **Hub graph-metadata sync** — held out of
scope until a Hub consumer exists.
