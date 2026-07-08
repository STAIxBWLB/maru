// Graph app mode (maru-vault-graph-spec §F2). Owns: model build (live layer),
// enrichment overlay (vault_graph_read → community), filters/search/selection/
// path/insights state, and a single reused layout worker. GraphCanvas renders;
// layout.worker.ts computes positions (warm-started + disk-cached).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  vaultGraphLayoutRead,
  vaultGraphLayoutSave,
  vaultGraphRead,
} from "../../lib/api";
import "./graph.css";
import {
  buildVaultGraph,
  enrichGraph,
  focusSubgraph,
  type GraphModel,
  type GraphNode,
} from "../../lib/graph/model";
import { shortestPath } from "../../lib/graph/insights";
import type {
  LayoutRequest,
  LayoutResponse,
} from "../../lib/graph/layout.worker";
import { useTranslation } from "../../lib/i18n";
import {
  isInEditable,
  matchesShortcut,
  useScopedKeyboardShortcuts,
} from "../../lib/diagram/shortcuts";
import type { VaultEntry } from "../../lib/types";
import { buildEntryIndex } from "../../lib/wikilinkSuggestions";
import { DecisionChainLanes } from "./DecisionChainLanes";
import { GraphCanvas, nodeRadius, type GraphHighlight } from "./GraphCanvas";
import {
  DEFAULT_GRAPH_FILTERS,
  GraphFilterPanel,
  type FacetItem,
  type GraphFilters,
} from "./GraphFilterPanel";
import { GraphInspector } from "./GraphInspector";
import { GraphInsightsPanel } from "./GraphInsightsPanel";
import { GraphToolbar, type GraphViewKind } from "./GraphToolbar";

interface GraphViewProps {
  workspacePath: string | null;
  entries: VaultEntry[];
  focusNodeId: string | null;
  onClearFocus: () => void;
  onOpenEntry: (entry: VaultEntry) => void;
  onCreateNote?: (target: string) => void;
  onError: (message: string) => void;
}

const UPDATE_DEBOUNCE_MS = 120;
const SAVE_DEBOUNCE_MS = 1500;

export function GraphView({
  workspacePath,
  entries,
  focusNodeId,
  onClearFocus,
  onOpenEntry,
  onCreateNote,
  onError,
}: GraphViewProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<GraphViewKind>("graph");
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_GRAPH_FILTERS);
  const [search, setSearch] = useState("");
  const [enrichment, setEnrichment] = useState<{ model: GraphModel | null; hint: string | null }>({
    model: null,
    hint: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [positions, setPositions] = useState<Float64Array | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const [seedReady, setSeedReady] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const frameEpochRef = useRef(0);
  const seedRef = useRef<Record<string, [number, number]> | undefined>(undefined);
  const seedAppliedRef = useRef(false);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nowRef = useRef<number>(Date.now());

  const index = useMemo(() => buildEntryIndex(entries), [entries]);
  const liveModel = useMemo(() => buildVaultGraph(entries, index), [entries, index]);

  const loadOverlay = useCallback(
    (path: string, live: GraphModel) => {
      setRefreshing(true);
      vaultGraphRead(path)
        .then((file) => {
          if (file) setEnrichment({ model: enrichGraph(live, file), hint: null });
          else setEnrichment({ model: null, hint: t("graph.hint.noEnrichment") });
        })
        .catch((err: unknown) => setEnrichment({ model: null, hint: String(err) }))
        .finally(() => setRefreshing(false));
    },
    [t],
  );

  useEffect(() => {
    setEnrichment({ model: null, hint: null });
    if (workspacePath) loadOverlay(workspacePath, liveModel);
  }, [workspacePath, liveModel, loadOverlay]);

  const model = enrichment.model ?? liveModel;

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

  const filtered = useMemo(() => {
    let base = model;
    if (focus) base = focusSubgraph(model, focus, 2);
    const keep = new Set<string>();
    for (const node of base.nodes) {
      if (!filters.showGhosts && node.type === "unresolved") continue;
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
  }, [model, filters, focus]);

  // --- worker lifecycle: one worker, reused across filter changes ---------

  useEffect(() => {
    const worker = new Worker(new URL("../../lib/graph/layout.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
      // Discard frames from a superseded layout request.
      if (event.data.epoch === frameEpochRef.current) setPositions(event.data.positions);
    };
    if (workspacePath) {
      vaultGraphLayoutRead(workspacePath)
        .then((cache) => {
          if (cache) seedRef.current = cache.positions;
        })
        .finally(() => setSeedReady(true));
    } else {
      setSeedReady(true);
    }
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
    // Worker is created once per mount; workspacePath is stable within a mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendUpdate = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    frameEpochRef.current += 1;
    const indexById = new Map(filtered.nodes.map((n, i) => [n.id, i]));
    const seed = seedAppliedRef.current ? undefined : seedRef.current;
    seedAppliedRef.current = true;
    const request: LayoutRequest = {
      type: "update",
      epoch: frameEpochRef.current,
      nodes: filtered.nodes.map((n) => ({ id: n.id, radius: nodeRadius(n.degree), community: n.community })),
      edges: filtered.edges
        .map((e) => ({ source: indexById.get(e.source), target: indexById.get(e.target), fromFrontmatter: e.fromFrontmatter }))
        .filter((e): e is { source: number; target: number; fromFrontmatter: boolean } => e.source != null && e.target != null),
      width: 1600,
      height: 1000,
      seed,
    };
    worker.postMessage(request);
  }, [filtered]);

  // Debounced update on filter changes (coalesces min-degree slider ticks).
  // Gated on the disk-cache seed so the first layout can warm-start from it.
  useEffect(() => {
    if (!seedReady) return;
    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    updateTimerRef.current = setTimeout(sendUpdate, UPDATE_DEBOUNCE_MS);
    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    };
  }, [sendUpdate, seedReady]);

  // Refit the viewport on focus enter/exit (a structural change), not on
  // ordinary filter tweaks.
  useEffect(() => {
    setLayoutEpoch((e) => e + 1);
  }, [focus]);

  // --- disk layout cache: debounced save of current positions -------------

  useEffect(() => {
    if (!workspacePath || !positions) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const map: Record<string, [number, number]> = {};
      filtered.nodes.forEach((node, i) => {
        map[node.id] = [positions[i * 2], positions[i * 2 + 1]];
      });
      void vaultGraphLayoutSave(workspacePath, { version: 1, positions: map });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // ponytail: saves only the currently-filtered nodes' positions — enough to
    // warm-start the common case; a full-model save would need the worker store.
  }, [positions, filtered, workspacePath]);

  const post = useCallback((message: LayoutRequest) => {
    workerRef.current?.postMessage(message);
  }, []);

  // --- interactions -------------------------------------------------------

  const handleOpen = useCallback(
    (node: GraphNode) => {
      if (node.type === "unresolved") {
        if (onCreateNote) onCreateNote(node.label);
        else onError(t("graph.hint.ghostNode"));
        return;
      }
      if (!node.relPath) return;
      const entry = entries.find((e) => e.relPath === node.relPath);
      if (entry) onOpenEntry(entry);
    },
    [entries, onOpenEntry, onCreateNote, onError, t],
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
    [clearOverlays],
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
        search={search}
        onSearchChange={setSearch}
        searchInputRef={searchRef}
        view={view}
        onViewChange={setView}
        zoomPercent={zoomPercent}
        onZoomIn={() => setZoomSignal({ dir: 1, nonce: Date.now() })}
        onZoomOut={() => setZoomSignal({ dir: -1, nonce: Date.now() })}
        onFit={() => setFitSignal((s) => s + 1)}
        onRelayout={() => {
          post({ type: "reheat" });
          setLayoutEpoch((e) => e + 1);
        }}
        onRefreshOverlay={() => {
          if (workspacePath) loadOverlay(workspacePath, liveModel);
        }}
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
            nodes={filtered.nodes}
            edges={filtered.edges}
            positions={positions}
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
            onNodeDrag={(nodeIndex, phase, x, y) => {
              if (phase === "start") post({ type: "dragStart", index: nodeIndex });
              else if (phase === "move") post({ type: "dragMove", index: nodeIndex, x, y });
              else post({ type: "dragEnd", index: nodeIndex });
            }}
            onNodeUnpin={(nodeIndex) => post({ type: "unpin", index: nodeIndex })}
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
                now={nowRef.current}
                onHighlightPair={handleHighlightPair}
                onSelectNode={handleInsightNode}
              />
            ) : (
              <GraphInspector
                node={selectedNode}
                model={model}
                onSelectNode={handleInsightNode}
                onOpen={handleOpen}
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
    </div>
  );
}
