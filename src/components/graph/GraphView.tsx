// Graph app mode (maru-vault-graph-spec §F2). Owns: model build (live layer),
// enrichment overlay (vault_graph_read → community), filters/search/selection/
// path/insights state, and a single reused layout worker. GraphCanvas renders;
// layout.worker.ts computes positions (warm-started + disk-cached).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chooseSaveFile,
  isTauri,
  vaultGraphLayoutRead,
  vaultGraphLayoutSave,
  vaultGraphRead,
} from "../../lib/api";
import { diagramExportBlobToPath } from "../../lib/diagram";
import "./graph.css";
import {
  blobToUint8Array,
  downloadGraphBlob,
} from "../../lib/graph/export";
import {
  buildVaultGraph,
  enrichGraph,
  focusSubgraph,
  type GraphModel,
  type GraphNode,
} from "../../lib/graph/model";
import { shortestPath } from "../../lib/graph/insights";
import { useTranslation } from "../../lib/i18n";
import {
  isInEditable,
  matchesShortcut,
  useScopedKeyboardShortcuts,
} from "../../lib/diagram/shortcuts";
import { useContextMenuKeyboard } from "../../lib/useContextMenuKeyboard";
import type { FavoriteKind, GraphSettings } from "../../lib/settings";
import type { FavoriteTarget } from "../FavoritesSection";
import type { VaultEntry } from "../../lib/types";
import { buildEntryIndex } from "../../lib/wikilinkSuggestions";
import { DecisionChainLanes } from "./DecisionChainLanes";
import {
  GraphCanvas,
  type GraphExportController,
  type GraphHighlight,
} from "./GraphCanvas";
import {
  filtersFromSettings,
  filtersToSettings,
  GraphFilterPanel,
  type FacetItem,
  type GraphFilters,
} from "./GraphFilterPanel";
import { GraphInspector } from "./GraphInspector";
import { GraphInsightsPanel } from "./GraphInsightsPanel";
import { GraphLegend } from "./GraphLegend";
import { GraphRelationReviewDialog } from "./GraphRelationReviewDialog";
import { GraphToolbar, type GraphViewKind } from "./GraphToolbar";

interface GraphViewProps {
  workspacePath: string | null;
  overlayPath?: string | null;
  entries: VaultEntry[];
  focusNodeId: string | null;
  onClearFocus: () => void;
  onOpenEntry: (entry: VaultEntry) => void;
  onCreateNote: (target: string) => void;
  graphSettings: GraphSettings;
  onGraphSettingsChange: (next: GraphSettings) => void;
  isFavorite: (kind: FavoriteKind, relPath: string) => boolean;
  onToggleFavorite: (target: FavoriteTarget) => void;
  onError: (message: string) => void;
  onGraphChanged?: () => void;
}

const SAVE_DEBOUNCE_MS = 1500;

export function GraphView({
  workspacePath,
  overlayPath,
  entries,
  focusNodeId,
  onClearFocus,
  onOpenEntry,
  onCreateNote,
  graphSettings,
  onGraphSettingsChange,
  isFavorite,
  onToggleFavorite,
  onError,
  onGraphChanged,
}: GraphViewProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<GraphSettings["source"]>(graphSettings.source);
  const [scope, setScope] = useState<GraphSettings["scope"]>(graphSettings.scope);
  const [localDepth, setLocalDepth] = useState<GraphSettings["localDepth"]>(graphSettings.localDepth);
  const [localDirection, setLocalDirection] = useState<GraphSettings["localDirection"]>(graphSettings.localDirection);
  // Seeded from persisted settings; changes are written back (skip-first) below.
  const [view, setView] = useState<GraphViewKind>(graphSettings.view);
  const [filters, setFilters] = useState<GraphFilters>(() =>
    filtersFromSettings(graphSettings.filters),
  );
  const [searchAsFilter, setSearchAsFilter] = useState(graphSettings.searchAsFilter);
  const [search, setSearch] = useState("");
  const exportControllerRef = useRef<GraphExportController | null>(null);
  // Right-click node context menu (spec §F2 usability).
  const [menu, setMenu] = useState<{ x: number; y: number; node: GraphNode; index: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const handleMenuKeyDown = useContextMenuKeyboard(menuRef, !!menu, () => setMenu(null));

  // Persist view / filter / search-mode changes (skip the initial seed render).
  // The callback is held in a ref so App re-renders (which re-create it inline)
  // don't re-fire persistence — only real state changes do.
  const onGraphSettingsChangeRef = useRef(onGraphSettingsChange);
  onGraphSettingsChangeRef.current = onGraphSettingsChange;
  const persistSkipRef = useRef(true);
  useEffect(() => {
    if (persistSkipRef.current) {
      persistSkipRef.current = false;
      return;
    }
    onGraphSettingsChangeRef.current({
      source,
      scope,
      localDepth,
      localDirection,
      view,
      searchAsFilter,
      filters: filtersToSettings(filters),
    });
  }, [source, scope, localDepth, localDirection, view, searchAsFilter, filters]);

  // Re-seed from external (cross-window) settings changes. Deps are only
  // [graphSettings], and each setState is gated on a real diff, so a local
  // edit's own persist round-trip (prop catches up to local) is a no-op — no
  // reset of the in-flight local change and no feedback loop.
  useEffect(() => {
    if (graphSettings.source !== source) setSource(graphSettings.source);
    if (graphSettings.scope !== scope) setScope(graphSettings.scope);
    if (graphSettings.localDepth !== localDepth) setLocalDepth(graphSettings.localDepth);
    if (graphSettings.localDirection !== localDirection) setLocalDirection(graphSettings.localDirection);
    if (graphSettings.view !== view) setView(graphSettings.view);
    if (graphSettings.searchAsFilter !== searchAsFilter) setSearchAsFilter(graphSettings.searchAsFilter);
    if (JSON.stringify(graphSettings.filters) !== JSON.stringify(filtersToSettings(filters))) {
      setFilters(filtersFromSettings(graphSettings.filters));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSettings]);
  const [enrichment, setEnrichment] = useState<{ model: GraphModel | null; hint: string | null }>({
    model: null,
    hint: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [settled, setSettled] = useState<Float64Array | null>(null);
  const latestPositionsRef = useRef<Float64Array | null>(null);
  const latestPositionNodeIdsRef = useRef<string[] | null>(null);
  const settledNodesRef = useRef<GraphNode[] | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [seedPositions, setSeedPositions] = useState<Record<string, [number, number]>>({});
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [unpinSignal, setUnpinSignal] = useState<{ id: string; nonce: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [relationPair, setRelationPair] = useState<{ source: GraphNode; target: GraphNode } | null>(null);
  const [rightTab, setRightTab] = useState<"insights" | "selected">("insights");
  const [pathSourceId, setPathSourceId] = useState<string | null>(null);
  const [pathIds, setPathIds] = useState<string[]>([]);
  const [highlightPair, setHighlightPair] = useState<{ a: string; b: string } | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [fitSignal, setFitSignal] = useState(0);
  const [zoomSignal, setZoomSignal] = useState<{ dir: 1 | -1; nonce: number } | null>(null);
  const [centerSignal, setCenterSignal] = useState<{ id: string; nonce: number } | null>(null);
  // Focus (k-hop subgraph) is seeded from the prop (NeighborhoodPane "그래프에서
  // 보기") but can also be set locally from the inspector.
  const [focus, setFocus] = useState<string | null>(focusNodeId ?? null);
  useEffect(() => setFocus(focusNodeId ?? null), [focusNodeId]);
  // Focus hides the siblings via visibility (no relayout), so recenter the
  // camera on the focused node when it changes — otherwise the neighborhood can
  // sit off-screen at its full-graph position.
  const prevFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (focus && focus !== prevFocusRef.current) {
      setCenterSignal({ id: focus, nonce: Date.now() });
    }
    prevFocusRef.current = focus;
  }, [focus]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const index = useMemo(() => buildEntryIndex(entries), [entries]);
  const liveModel = useMemo(() => buildVaultGraph(entries, index), [entries, index]);

  const loadOverlay = useCallback(
    (path: string, live: GraphModel) => {
      setRefreshing(true);
      vaultGraphRead(path, source)
        .then((file) => {
          if (file) setEnrichment({ model: enrichGraph(live, file), hint: null });
          else setEnrichment({ model: null, hint: t("graph.hint.noEnrichment") });
        })
        .catch((err: unknown) => setEnrichment({ model: null, hint: String(err) }))
        .finally(() => setRefreshing(false));
    },
    [t, source],
  );

  useEffect(() => {
    setEnrichment({ model: null, hint: null });
    const root = overlayPath ?? workspacePath;
    if (root) loadOverlay(root, liveModel);
  }, [workspacePath, overlayPath, liveModel, loadOverlay]);

  const model = enrichment.model ?? liveModel;
  // "now" for stale-note detection — recomputed whenever the model changes
  // (i.e. on vault edits) so it doesn't stay frozen at mount time.
  const now = useMemo(() => Date.now(), [model]);

  const facets = useMemo(() => {
    const domain = new Map<string, number>();
    const type = new Map<string, number>();
    const community = new Map<number, number>();
    let maxDegree = 0;
    for (const node of model.nodes) {
      if (node.domain) domain.set(node.domain, (domain.get(node.domain) ?? 0) + 1);
      type.set(node.type, (type.get(node.type) ?? 0) + 1);
      if (node.community != null) community.set(node.community, (community.get(node.community) ?? 0) + 1);
      if (node.degree > maxDegree) maxDegree = node.degree;
    }
    const domains: FacetItem<string>[] = [...domain.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }));
    const types: FacetItem<string>[] = [...type.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }));
    const communities: FacetItem<number>[] = [...community.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([value, count]) => ({ value, count }));
    return { domains, types, communities, maxDegree };
  }, [model]);

  const baseFiltered = useMemo(() => {
    let base = model;
    if (focus) base = focusSubgraph(model, focus, localDepth, localDirection);
    const keep = new Set<string>();
    for (const node of base.nodes) {
      if (!filters.showGhosts && node.type === "unresolved") continue;
      if (scope === "connected" && node.degree === 0) continue;
      if (filters.domains.size > 0 && (!node.domain || !filters.domains.has(node.domain))) continue;
      if (filters.types.size > 0 && !filters.types.has(node.type)) continue;
      if (filters.community != null && node.community !== filters.community) continue;
      if (node.degree < filters.minDegree) continue;
      keep.add(node.id);
    }
    return {
      ...base,
      nodes: base.nodes.filter((n) => keep.has(n.id)),
      edges: base.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [model, filters, focus, localDepth, localDirection, scope]);

  // Search-as-filter narrows the facet-filtered set to matches + their 1-hop
  // neighbors (matches alone would render as disconnected dots). Off → returns
  // baseFiltered by identity, so plain search typing doesn't re-layout.
  const filtered = useMemo(() => {
    const q = searchAsFilter ? search.trim().toLowerCase() : "";
    if (!q) return baseFiltered;
    const matched = new Set<string>();
    for (const node of baseFiltered.nodes) {
      if (node.label.toLowerCase().includes(q)) matched.add(node.id);
    }
    const visible = new Set(matched);
    for (const e of baseFiltered.edges) {
      if (matched.has(e.source)) visible.add(e.target);
      if (matched.has(e.target)) visible.add(e.source);
    }
    return {
      ...baseFiltered,
      nodes: baseFiltered.nodes.filter((n) => visible.has(n.id)),
      edges: baseFiltered.edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
    };
  }, [baseFiltered, search, searchAsFilter]);
  const visibleNodeIds = useMemo(
    () => new Set(filtered.nodes.map((node) => node.id)),
    [filtered.nodes],
  );

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    void vaultGraphLayoutRead(workspacePath).then((cache) => {
      if (cancelled || !cache) return;
      setSeedPositions(cache.positions);
      setPinnedIds(cache.pinnedIds ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const handleLayoutSettled = useCallback((positions: Float64Array, nextPinnedIds: string[]) => {
    latestPositionsRef.current = positions;
    settledNodesRef.current = model.nodes;
    setPinnedIds(nextPinnedIds);
    setSettled(positions);
  }, [model.nodes]);

  // --- disk layout cache: debounced save of current positions -------------

  useEffect(() => {
    if (!workspacePath || !settled) return;
    // Skip while `settled` belongs to a different node set (identity, not just
    // cardinality — a same-cardinality swap would persist wrong coordinates).
    if (settledNodesRef.current !== model.nodes) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      // `settled` is index-aligned with the full model, so this is the complete
      // current node set — no seed spread (that would re-accrete deleted ids).
      const map: Record<string, [number, number]> = {};
      model.nodes.forEach((node, i) => {
        map[node.id] = [settled[i * 2], settled[i * 2 + 1]];
      });
      void vaultGraphLayoutSave(workspacePath, {
        version: 2,
        positions: map,
        pinnedIds,
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [settled, model, workspacePath, pinnedIds]);

  // --- interactions -------------------------------------------------------

  const handleOpen = useCallback(
    (node: GraphNode) => {
      if (node.type === "unresolved") {
        onCreateNote(node.label);
        return;
      }
      if (!node.relPath) return;
      const entry = entries.find((e) => e.relPath === node.relPath);
      if (entry) onOpenEntry(entry);
    },
    [entries, onOpenEntry, onCreateNote],
  );

  const selectById = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setHighlightPair(null);
      setPathIds([]);
      if (id) setRightTab("selected");
      else setRightTab("insights");
    },
    [],
  );

  const handleSelect = useCallback(
    (node: GraphNode | null) => selectById(node?.id ?? null),
    [selectById],
  );

  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model]);

  // Insight → action: copy the [[wikilink]] to paste into a note, or open the
  // source note in the editor (reuses handleOpen's mode switch).
  const copyWikilink = useCallback(
    (id: string) => {
      const node = nodeById.get(id);
      if (!node) return;
      // Canonical target: relPath-sans-ext (what the editor autocomplete emits;
      // resolves unambiguously via byRelPathNoExt even on duplicate titles).
      // Ghosts have no relPath — their label IS the raw wikilink target.
      const target = node.relPath
        ? node.relPath.replace(/\.(md|mdx|markdown)$/i, "")
        : node.label;
      void navigator.clipboard
        .writeText(`[[${target}]]`)
        .catch((err: unknown) => onError(String(err)));
    },
    [nodeById, onError],
  );
  const openNodeById = useCallback(
    (id: string) => {
      const node = nodeById.get(id);
      if (node) handleOpen(node);
    },
    [nodeById, handleOpen],
  );

  // Favorites integration: a node maps to its file relPath (ghosts have none).
  const favoriteIds = useMemo(
    () =>
      new Set(
        model.nodes
          .filter((n) => n.relPath && isFavorite("file", n.relPath))
          .map((n) => n.id),
      ),
    [model, isFavorite],
  );
  const toggleNodeFavorite = useCallback(
    (node: GraphNode) => {
      if (!node.relPath) return;
      onToggleFavorite({ kind: "file", relPath: node.relPath, label: node.label });
    },
    [onToggleFavorite],
  );

  // Export the current view as PNG/SVG. In Tauri we route through the native
  // save dialog (canceling aborts — no silent fallback); in the browser we
  // download the blob directly.
  const handleExport = useCallback(
    async (format: "png" | "svg") => {
      const controller = exportControllerRef.current;
      if (!controller) return;
      try {
        const result = {
          blob: format === "png" ? await controller.png() : controller.svg(),
          extension: format,
        };
        // Local calendar date (en-CA → YYYY-MM-DD); toISOString would stamp UTC.
        const name = `graph-${new Date().toLocaleDateString("en-CA")}.${result.extension}`;
        if (workspacePath && isTauri()) {
          const target = await chooseSaveFile(
            t("graph.export.saveTitle"),
            `${workspacePath.replace(/[/\\]+$/, "")}/reports/${name}`,
          );
          if (!target) return; // user canceled the native dialog → abort
          await diagramExportBlobToPath(
            target,
            result.extension as "png" | "svg",
            await blobToUint8Array(result.blob),
          );
        } else {
          downloadGraphBlob(result.blob, name);
        }
      } catch (err: unknown) {
        onError(String(err));
      }
    },
    [workspacePath, onError, t],
  );

  // Context-menu lifecycle: close on any outside interaction / Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const runMenuAction = useCallback(
    (fn: (node: GraphNode, index: number) => void) => {
      const m = menu;
      setMenu(null);
      if (m) fn(m.node, m.index);
    },
    [menu],
  );

  const handlePathTarget = useCallback(
    (node: GraphNode) => {
      const source = pathSourceId ?? selectedId;
      if (!source || source === node.id) {
        setPathSourceId(node.id);
        setRightTab("selected");
        return;
      }
      const path = shortestPath(model, source, node.id);
      if (!path) {
        onError(t("graph.path.none"));
        return;
      }
      setPathIds(path);
      setHighlightPair(null);
      setPathSourceId(null);
    },
    [model, pathSourceId, selectedId, onError, t],
  );

  const handleInsightNode = useCallback(
    (id: string) => {
      selectById(id);
      setCenterSignal({ id, nonce: Date.now() });
    },
    [selectById],
  );

  const handleHighlightPair = useCallback(
    (a: string, b: string) => {
      setHighlightPair({ a, b });
      setPathIds([]);
      setSelectedId(null);
      setCenterSignal({ id: a, nonce: Date.now() });
    },
    [],
  );
  const handleConnect = useCallback((sourceId: string, targetId: string) => {
    const sourceNode = nodeById.get(sourceId);
    const targetNode = nodeById.get(targetId);
    if (!sourceNode?.relPath || !targetNode?.relPath) return;
    setRelationPair({ source: sourceNode, target: targetNode });
  }, [nodeById]);

  const clearFocus = useCallback(() => {
    setFocus(null);
    onClearFocus();
  }, [onClearFocus]);

  const clearOverlays = useCallback(() => {
    setSelectedId(null);
    setHighlightPair(null);
    setPathIds([]);
    setPathSourceId(null);
    setRightTab("insights");
    if (focus) clearFocus();
  }, [focus, clearFocus]);

  // Mode-scoped shortcuts: ⌘F focus search, Esc clears, +/-/0 zoom.
  const shortcutPredicate = useCallback(() => view === "graph", [view]);
  const shortcutHandler = useCallback(
    (event: KeyboardEvent) => {
      if (matchesShortcut(event, { key: "f", mod: true })) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isInEditable(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        // The scoped shortcut runs capture-phase and stops propagation, so it
        // must close the context menu itself (the menu's own Esc handler and the
        // window listener never see the event).
        if (menu) {
          setMenu(null);
          return;
        }
        clearOverlays();
      } else if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setZoomSignal({ dir: 1, nonce: Date.now() });
      } else if (event.key === "-") {
        event.preventDefault();
        setZoomSignal({ dir: -1, nonce: Date.now() });
      } else if (event.key === "0") {
        event.preventDefault();
        setFitSignal((s) => s + 1);
      }
    },
    [clearOverlays, menu],
  );
  useScopedKeyboardShortcuts(shortcutPredicate, shortcutHandler);

  const searchMatch = useMemo(() => {
    if (!search.trim()) return null;
    const lower = search.trim().toLowerCase();
    return filtered.nodes.find((n) => n.label.toLowerCase().includes(lower)) ?? null;
  }, [filtered, search]);

  const selectedNode = useMemo(
    () => (selectedId ? model.nodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, model],
  );

  const highlight: GraphHighlight = useMemo(() => {
    if (pathIds.length > 1) return { kind: "path", ids: pathIds };
    if (highlightPair) return { kind: "pair", a: highlightPair.a, b: highlightPair.b };
    return null;
  }, [pathIds, highlightPair]);

  const enrichedCount = model.enriched
    ? new Set(model.nodes.map((n) => n.community).filter((c) => c != null)).size
    : 0;

  return (
    <div className="graph-view" data-testid="graph-mode">
      <GraphToolbar
        source={source}
        onSourceChange={setSource}
        scope={scope}
        onScopeChange={setScope}
        search={search}
        onSearchChange={setSearch}
        searchInputRef={searchRef}
        searchAsFilter={searchAsFilter}
        onSearchAsFilterChange={setSearchAsFilter}
        view={view}
        onViewChange={setView}
        zoomPercent={zoomPercent}
        onZoomIn={() => setZoomSignal({ dir: 1, nonce: Date.now() })}
        onZoomOut={() => setZoomSignal({ dir: -1, nonce: Date.now() })}
        onFit={() => setFitSignal((s) => s + 1)}
        onRelayout={() => setLayoutEpoch((e) => e + 1)}
        onRefreshOverlay={() => {
          const root = overlayPath ?? workspacePath;
          if (root) loadOverlay(root, liveModel);
        }}
        onExportPng={() => void handleExport("png")}
        onExportSvg={() => void handleExport("svg")}
        refreshing={refreshing}
        enriched={model.enriched}
        communityCount={enrichedCount}
        nodeCount={filtered.nodes.length}
        edgeCount={filtered.edges.length}
      />

      {!model.enriched ? (
        <div className="graph-degraded-bar" data-testid="graph-degraded-hint">
          {enrichment.hint ?? t("graph.hint.noEnrichment")}
        </div>
      ) : null}
      {focus ? (
        <div className="graph-focus-bar" data-testid="graph-focus-bar">
          <span>{t("graph.focus.active")}: {focus}</span>
          <label>
            {t("graph.focus.depth")}
            <select value={localDepth} onChange={(event) => setLocalDepth(Number(event.target.value) as 1 | 2 | 3)}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label>
            {t("graph.focus.direction")}
            <select value={localDirection} onChange={(event) => setLocalDirection(event.target.value as GraphSettings["localDirection"])}>
              <option value="both">{t("graph.focus.both")}</option>
              <option value="incoming">{t("graph.focus.incoming")}</option>
              <option value="outgoing">{t("graph.focus.outgoing")}</option>
            </select>
          </label>
          <button type="button" onClick={clearFocus}>{t("graph.focus.exit")}</button>
        </div>
      ) : null}
      {pathSourceId ? (
        <div className="graph-path-bar" data-testid="graph-path-bar">
          {t("graph.path.pick")}
          <button type="button" onClick={() => setPathSourceId(null)}>{t("graph.focus.exit")}</button>
        </div>
      ) : null}

      {view === "chains" ? (
        <DecisionChainLanes model={model} onNodeClick={handleOpen} />
      ) : (
        <div className="graph-body">
          <GraphFilterPanel
            filters={filters}
            domains={facets.domains}
            types={facets.types}
            communities={facets.communities}
            maxDegree={facets.maxDegree}
            onFiltersChange={setFilters}
          />
          <GraphCanvas
            nodes={model.nodes}
            edges={model.edges}
            positionsRef={latestPositionsRef}
            positionNodeIdsRef={latestPositionNodeIdsRef}
            seedPositions={seedPositions}
            initialPinnedIds={pinnedIds}
            visibleNodeIds={visibleNodeIds}
            layoutEpoch={layoutEpoch}
            enriched={model.enriched}
            selectedId={selectedId}
            focusNodeId={searchMatch?.id ?? focus ?? null}
            pathSourceId={pathSourceId}
            highlight={highlight}
            fitSignal={fitSignal}
            zoomSignal={zoomSignal}
            centerSignal={centerSignal}
            onSelect={handleSelect}
            onOpen={handleOpen}
            onPathTarget={handlePathTarget}
            onNodeDrag={() => undefined}
            onNodeUnpin={() => undefined}
            unpinSignal={unpinSignal}
            onLayoutSettled={handleLayoutSettled}
            onNodeContextMenu={(node, index, x, y) => setMenu({ node, index, x, y })}
            favoriteIds={favoriteIds}
            exportControllerRef={exportControllerRef}
            overlay={
              <GraphLegend
                enriched={model.enriched}
                domains={facets.domains}
                communities={facets.communities}
                filters={filters}
                onFiltersChange={setFilters}
              />
            }
            onViewportReport={(zoom) => setZoomPercent(zoom * 100)}
          />
          <div className="graph-right" data-testid="graph-right">
            <div className="graph-right-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "insights"}
                className={rightTab === "insights" ? "active" : ""}
                onClick={() => setRightTab("insights")}
              >
                {t("graph.tab.insights")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "selected"}
                className={rightTab === "selected" ? "active" : ""}
                onClick={() => setRightTab("selected")}
              >
                {t("graph.tab.selected")}
              </button>
            </div>
            {rightTab === "insights" ? (
              <GraphInsightsPanel
                model={model}
                now={now}
                onHighlightPair={handleHighlightPair}
                onSelectNode={handleInsightNode}
                onCopyWikilink={copyWikilink}
                onOpenNode={openNodeById}
                onConnect={handleConnect}
              />
            ) : (
              <GraphInspector
                node={selectedNode}
                model={model}
                isFavorite={
                  selectedNode?.relPath ? isFavorite("file", selectedNode.relPath) : false
                }
                onSelectNode={handleInsightNode}
                onOpen={handleOpen}
                onToggleFavorite={toggleNodeFavorite}
                onFocus={(node) => {
                  setFocus(node.id);
                  selectById(node.id);
                }}
                onStartPath={(node) => {
                  setPathSourceId(node.id);
                  setSelectedId(node.id);
                }}
              />
            )}
          </div>
        </div>
      )}

      {menu ? (
        <div
          ref={menuRef}
          className="context-menu graph-node-context-menu"
          data-testid="graph-node-context-menu"
          role="menu"
          tabIndex={-1}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="context-menu-title" title={menu.node.relPath ?? menu.node.label}>
            {menu.node.label}
          </div>
          <button type="button" role="menuitem" onClick={() => runMenuAction((n) => handleOpen(n))}>
            <span>{t("graph.inspector.open")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runMenuAction((n) => { setFocus(n.id); selectById(n.id); })}
          >
            <span>{t("graph.inspector.focus")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runMenuAction((n) => { setPathSourceId(n.id); setSelectedId(n.id); })}
          >
            <span>{t("graph.inspector.startPath")}</span>
          </button>
          <div className="context-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => runMenuAction((n) => copyWikilink(n.id))}>
            <span>{t("graph.action.copyWikilink")}</span>
          </button>
          {menu.node.relPath ? (
            <button type="button" role="menuitem" onClick={() => runMenuAction((n) => toggleNodeFavorite(n))}>
              <span>{favoriteIds.has(menu.node.id) ? t("graph.menu.unfavorite") : t("graph.menu.favorite")}</span>
            </button>
          ) : null}
          <div className="context-menu-separator" role="separator" />
          {/* ponytail: no "pin" item — pinned state lives only in the worker, so
              a pin toggle couldn't honestly render its own on/off state. */}
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              runMenuAction((n) => {
                const index = model.nodes.findIndex((fn) => fn.id === n.id);
                if (index < 0) return;
                setUnpinSignal({ id: n.id, nonce: Date.now() });
              })
            }
          >
            <span>{t("graph.menu.unpin")}</span>
          </button>
        </div>
      ) : null}
      <GraphRelationReviewDialog
        open={relationPair != null}
        source={relationPair?.source ?? null}
        target={relationPair?.target ?? null}
        workspacePath={workspacePath}
        onOpenChange={(open) => {
          if (!open) setRelationPair(null);
        }}
        onApplied={() => onGraphChanged?.()}
      />
    </div>
  );
}
