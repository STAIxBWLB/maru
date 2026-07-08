# Graph mode (Phase 8)

The `graph` activity-rail mode (label 그래프 / Graph) renders the vault as a
knowledge graph and, with managed writes enabled, lets you edit note frontmatter
under a schema gate. It ships in three layers — 8a (read-only), 8b (managed
writes), 8c (graph-driven authoring) — all landed and default-on.

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
- `src/components/graph/GraphCanvas.tsx` — SVG canvas. Nodes/edges are memoized
  child components (`NodeView`/`EdgeView`), so pan/zoom updates only the
  container `<g transform>` — zero child reconciliation once the layout settles.
  A `ResizeObserver` caches the canvas size (no per-frame `getBoundingClientRect`).
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
  **shift-click = path target**, **Esc = clear** selection/path/focus.
- Wheel scroll pans; **ctrl/⌘ + wheel zooms** at the cursor. ⌘F focuses search;
  `+`/`-`/`0` zoom in/out/fit.
- Hover highlights a node's 1-hop neighborhood and dims the rest.

### Performance (V2)

The layout worker is created once per mount and reused across filter changes via
`update` messages (no terminate/recreate). It keeps a per-id position store so
surviving nodes **warm-start** from their last position instead of
re-randomizing — filtering nudges the layout instead of exploding it. Each
request carries an `epoch` that round-trips so the main thread discards stale
frames (no blank-and-reflow). Settled positions persist to
`<workspace>/.maru/cache/graph-layout.json` (`vault_graph_layout_{read,save}`)
and prime the first layout on re-entry.

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
node on the canvas.

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
  `decisionChains.test.ts`; perf bench `src/lib/graph/perf.bench.ts` (adds an
  insight-pass budget alongside build/layout/cull).
- cargo: `vault_graph` — overlay read + layout-cache round-trip.
- e2e: `e2e/graph.spec.ts` (mode entry, filter, select/double-click, chain view,
  toolbar + insights + inspector surfaces). **Scope note** — the enrichment path
  (`vault_graph_read`) is Tauri-only, so the browser-mode e2e suite verifies the
  *degraded* live-layer path; the enriched overlay path is covered by
  vitest + cargo fixtures.

## Deferred

The only remaining Phase 8 item is **Hub graph-metadata sync** — held out of
scope until a Hub consumer exists.
