// Graph app mode (maru-vault-graph-spec §F2). Owns: model build (live layer),
// enrichment overlay (vault_graph_read → community), filters/search/focus,
// worker lifecycle. GraphCanvas renders; layout.worker.ts computes positions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { vaultGraphRead } from "../../lib/api";
import "./graph.css";
import {
  buildVaultGraph,
  enrichGraph,
  focusSubgraph,
  type GraphModel,
  type GraphNode,
} from "../../lib/graph/model";
import type {
  LayoutRequest,
  LayoutResponse,
} from "../../lib/graph/layout.worker";
import { useTranslation } from "../../lib/i18n";
import type { VaultEntry } from "../../lib/types";
import { buildEntryIndex } from "../../lib/wikilinkSuggestions";
import { GraphCanvas, nodeRadius } from "./GraphCanvas";
import {
  DEFAULT_GRAPH_FILTERS,
  GraphFilterPanel,
  type GraphFilters,
} from "./GraphFilterPanel";

interface GraphViewProps {
  workspacePath: string | null;
  entries: VaultEntry[];
  focusNodeId: string | null;
  onClearFocus: () => void;
  onOpenEntry: (entry: VaultEntry) => void;
  onError: (message: string) => void;
}

export function GraphView({
  workspacePath,
  entries,
  focusNodeId,
  onClearFocus,
  onOpenEntry,
  onError,
}: GraphViewProps) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_GRAPH_FILTERS);
  const [search, setSearch] = useState("");
  const [enrichment, setEnrichment] = useState<{
    model: GraphModel | null;
    hint: string | null;
  }>({ model: null, hint: null });
  const [positions, setPositions] = useState<Float64Array | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const workerRef = useRef<Worker | null>(null);

  const index = useMemo(() => buildEntryIndex(entries), [entries]);
  const liveModel = useMemo(() => buildVaultGraph(entries, index), [entries, index]);

  // Enrichment overlay — graceful degradation on absence/corruption.
  useEffect(() => {
    let cancelled = false;
    setEnrichment({ model: null, hint: null });
    if (!workspacePath) return;
    vaultGraphRead(workspacePath)
      .then((file) => {
        if (cancelled) return;
        if (file) {
          setEnrichment({ model: enrichGraph(liveModel, file), hint: null });
        } else {
          setEnrichment({ model: null, hint: t("graph.hint.noEnrichment") });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEnrichment({ model: null, hint: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, liveModel]);

  const model = enrichment.model ?? liveModel;

  const facets = useMemo(() => {
    const domains = new Set<string>();
    const types = new Set<string>();
    const communities = new Set<number>();
    let maxDegree = 0;
    for (const node of model.nodes) {
      if (node.domain) domains.add(node.domain);
      types.add(node.type);
      if (node.community != null) communities.add(node.community);
      if (node.degree > maxDegree) maxDegree = node.degree;
    }
    return {
      domains: [...domains].sort(),
      types: [...types].sort(),
      communities: [...communities].sort((a, b) => a - b),
      maxDegree,
    };
  }, [model]);

  const filtered = useMemo(() => {
    let base = model;
    if (focusNodeId) {
      base = focusSubgraph(model, focusNodeId, 2);
    }
    const keep = new Set<string>();
    for (const node of base.nodes) {
      if (!filters.showGhosts && node.type === "unresolved") continue;
      if (filters.domains.size > 0 && (!node.domain || !filters.domains.has(node.domain)))
        continue;
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
  }, [model, filters, focusNodeId]);

  // Worker lifecycle: re-init layout whenever the filtered subgraph changes.
  useEffect(() => {
    const worker = new Worker(
      new URL("../../lib/graph/layout.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
      setPositions(event.data.positions);
    };
    const indexById = new Map(filtered.nodes.map((n, i) => [n.id, i]));
    const request: LayoutRequest = {
      type: "init",
      nodes: filtered.nodes.map((n) => ({
        radius: nodeRadius(n.degree),
        community: n.community,
      })),
      edges: filtered.edges
        .map((e) => ({
          source: indexById.get(e.source),
          target: indexById.get(e.target),
          fromFrontmatter: e.fromFrontmatter,
        }))
        .filter(
          (e): e is { source: number; target: number; fromFrontmatter: boolean } =>
            e.source != null && e.target != null,
        ),
      width: 1600,
      height: 1000,
    };
    setPositions(null);
    setLayoutEpoch((epoch) => epoch + 1);
    worker.postMessage(request);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [filtered]);

  const post = useCallback((message: LayoutRequest) => {
    workerRef.current?.postMessage(message);
  }, []);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (node.type === "unresolved") {
        // Ghost → note creation lands in V3 (8c); hint only for V1.
        onError(t("graph.hint.ghostNode"));
        return;
      }
      if (!node.relPath) return;
      const entry = entries.find((e) => e.relPath === node.relPath);
      if (entry) onOpenEntry(entry);
    },
    [entries, onOpenEntry, onError],
  );

  const searchMatch = useMemo(() => {
    if (!search.trim()) return null;
    const lower = search.trim().toLowerCase();
    return (
      filtered.nodes.find((n) => n.label.toLowerCase().includes(lower)) ?? null
    );
  }, [filtered, search]);

  return (
    <div className="graph-view" data-testid="graph-mode">
      <header className="graph-header">
        <h2>{t("mode.graph")}</h2>
        {model.enriched ? (
          <span className="graph-badge" data-testid="graph-enriched-badge">
            {t("graph.badge.communities")}:{" "}
            {new Set(model.nodes.map((n) => n.community).filter((c) => c != null)).size}
          </span>
        ) : (
          <span className="graph-hint" data-testid="graph-degraded-hint">
            {enrichment.hint ?? t("graph.hint.noEnrichment")}
          </span>
        )}
        {focusNodeId ? (
          <button type="button" className="graph-chip active" onClick={onClearFocus}>
            {t("graph.focus.exit")}: {focusNodeId}
          </button>
        ) : null}
        <span className="graph-stats">
          {filtered.nodes.length} · {filtered.edges.length}
        </span>
      </header>
      <div className="graph-body">
        <GraphFilterPanel
          filters={filters}
          domains={facets.domains}
          types={facets.types}
          communities={facets.communities}
          search={search}
          maxDegree={facets.maxDegree}
          onFiltersChange={setFilters}
          onSearchChange={setSearch}
          onRelayout={() => post({ type: "reheat" })}
        />
        <GraphCanvas
          nodes={filtered.nodes}
          edges={filtered.edges}
          positions={positions}
          layoutEpoch={layoutEpoch}
          enriched={model.enriched}
          focusNodeId={focusNodeId ?? searchMatch?.id ?? null}
          onNodeClick={handleNodeClick}
          onNodeDrag={(nodeIndex, phase, x, y) => {
            if (phase === "start") post({ type: "dragStart", index: nodeIndex });
            else if (phase === "move") post({ type: "dragMove", index: nodeIndex, x, y });
            else post({ type: "dragEnd", index: nodeIndex });
          }}
          onNodeUnpin={(nodeIndex) => post({ type: "unpin", index: nodeIndex })}
        />
      </div>
    </div>
  );
}
