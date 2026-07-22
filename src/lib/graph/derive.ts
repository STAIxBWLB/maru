// Single pure derivation pipeline for the graph canvas (graph-workbench V2).
// Replaces the scattered filter memos that used to live in GraphView: facet
// filters → relation filter → local traversal → neighbor pruning →
// search-as-filter, in that order, with paused-filter reporting so a persisted
// selection that no longer matches anything never silently blanks the canvas.

import type {
  GraphFilterProfile,
  GraphMode,
} from "../settings";
import {
  focusSubgraph,
  isGeneratedNode,
  type GraphModel,
} from "./model";

export interface DerivedGraphFacets {
  domains: { value: string; count: number }[];
  types: { value: string; count: number }[];
  relations: { value: string; count: number }[];
  communities: { value: number; count: number }[];
  maxVisibleNeighbors: number;
}

export type GraphEmptyReason = "empty-source" | "filtered-empty" | null;

export interface DerivedGraph {
  /** Facet-filtered model before local traversal/neighbor pruning — used by
   *  insights, pathfinding, export. */
  analysisModel: GraphModel;
  /** What the canvas renders. */
  visibleModel: GraphModel;
  /** Distinct visible-neighbor count per node id (relation+facet-filtered edges). */
  visibleNeighborCounts: Map<string, number>;
  facets: DerivedGraphFacets;
  /** Persisted filter values that could not be applied (e.g. community after
   *  overlay loss) — shown as inactive chips, never silently blanking the canvas. */
  pausedFilters: string[];
  emptyReason: GraphEmptyReason;
  /** mode==="local" requested but the focus target is not in the model —
   *  global graph stays visible and this flag reports the problem. */
  focusMissing: boolean;
}

/** Distinct-neighbor counts over an edge list. */
function neighborCounts(
  nodeIds: readonly string[],
  edges: GraphModel["edges"],
): Map<string, number> {
  const neighbors = new Map<string, Set<string>>();
  for (const id of nodeIds) neighbors.set(id, new Set());
  for (const edge of edges) {
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }
  const counts = new Map<string, number>();
  for (const [id, set] of neighbors) counts.set(id, set.size);
  return counts;
}

/** O(V+E) iterative k-core-style pruning: removing a sub-threshold node
 *  decrements its neighbors' counts, which can cascade. The focus anchor is
 *  never pruned. */
function pruneByMinNeighbors(
  model: GraphModel,
  threshold: number,
  protectId: string | null,
): GraphModel {
  if (threshold <= 0) return model;
  const neighbors = new Map<string, Set<string>>();
  for (const node of model.nodes) neighbors.set(node.id, new Set());
  for (const edge of model.edges) {
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }
  const removed = new Set<string>();
  const queue: string[] = [];
  for (const [id, set] of neighbors) {
    if (id !== protectId && set.size < threshold) queue.push(id);
  }
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (removed.has(id)) continue;
    removed.add(id);
    for (const other of neighbors.get(id) ?? []) {
      if (removed.has(other)) continue;
      const set = neighbors.get(other)!;
      set.delete(id);
      if (other !== protectId && set.size < threshold) queue.push(other);
    }
  }
  return {
    ...model,
    nodes: model.nodes.filter((n) => !removed.has(n.id)),
    edges: model.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
  };
}

export function deriveGraphView(args: {
  model: GraphModel;
  profile: GraphFilterProfile;
  generatedPatterns: readonly string[];
  mode: GraphMode;
  focusNodeId: string | null;
  localDepth: 1 | 2 | 3;
  localDirection: "both" | "incoming" | "outgoing";
  search: string;
  searchAsFilter: boolean;
}): DerivedGraph {
  const {
    model,
    profile,
    generatedPatterns,
    mode,
    focusNodeId,
    localDepth,
    localDirection,
    search,
    searchAsFilter,
  } = args;

  // --- paused filters: persisted values absent from the unfiltered model ---
  const modelDomains = new Set<string>();
  const modelTypes = new Set<string>();
  const modelCommunities = new Set<number>();
  for (const node of model.nodes) {
    if (node.domain) modelDomains.add(node.domain);
    modelTypes.add(node.type);
    if (node.community != null) modelCommunities.add(node.community);
  }
  const modelRelations = new Set(model.edges.map((edge) => edge.relation));

  const pausedFilters: string[] = [];
  const activeDomains = profile.domains.filter((value) => {
    if (modelDomains.has(value)) return true;
    pausedFilters.push(`domain:${value}`);
    return false;
  });
  const activeTypes = profile.types.filter((value) => {
    if (modelTypes.has(value)) return true;
    pausedFilters.push(`type:${value}`);
    return false;
  });
  const activeRelations = profile.relations.filter((value) => {
    if (modelRelations.has(value)) return true;
    pausedFilters.push(`relation:${value}`);
    return false;
  });
  const communityActive =
    profile.community != null && modelCommunities.has(profile.community);
  if (profile.community != null && !communityActive) {
    pausedFilters.push(`community:${profile.community}`);
  }

  // --- 1. node facet filter + 2. relation filter → analysis model ----------
  const keep = new Set<string>();
  for (const node of model.nodes) {
    if (!profile.showUnresolved && node.type === "unresolved") continue;
    if (!profile.showGenerated && isGeneratedNode(node, generatedPatterns)) continue;
    if (activeDomains.length > 0 && (!node.domain || !activeDomains.includes(node.domain))) continue;
    if (activeTypes.length > 0 && !activeTypes.includes(node.type)) continue;
    if (communityActive && node.community !== profile.community) continue;
    keep.add(node.id);
  }
  const relationKeep = activeRelations.length > 0 ? new Set(activeRelations) : null;
  const analysisModel: GraphModel = {
    ...model,
    nodes: model.nodes.filter((n) => keep.has(n.id)),
    edges: model.edges.filter(
      (e) => keep.has(e.source) && keep.has(e.target) && (!relationKeep || relationKeep.has(e.relation)),
    ),
  };

  const visibleNeighborCounts = neighborCounts(
    analysisModel.nodes.map((n) => n.id),
    analysisModel.edges,
  );

  // --- 4. local mode: k-hop traversal over the filtered model --------------
  let focusMissing = false;
  let working = analysisModel;
  if (mode === "local" && focusNodeId) {
    if (analysisModel.nodes.some((n) => n.id === focusNodeId)) {
      working = focusSubgraph(analysisModel, focusNodeId, localDepth, localDirection);
    } else {
      // Focus target not in the (filtered) model — keep the global result.
      focusMissing = true;
    }
  }

  // --- 5. minVisibleNeighbors k-core pruning (anchor always retained) ------
  working = pruneByMinNeighbors(working, profile.minVisibleNeighbors, focusNodeId);

  // --- 6. search-as-filter: matches + their 1-hop neighbors ----------------
  const query = searchAsFilter ? search.trim().toLowerCase() : "";
  if (query) {
    const matched = new Set<string>();
    for (const node of working.nodes) {
      if (node.label.toLowerCase().includes(query)) matched.add(node.id);
    }
    const visible = new Set(matched);
    for (const edge of working.edges) {
      if (matched.has(edge.source)) visible.add(edge.target);
      if (matched.has(edge.target)) visible.add(edge.source);
    }
    working = {
      ...working,
      nodes: working.nodes.filter((n) => visible.has(n.id)),
      edges: working.edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
    };
  }
  const visibleModel = working;

  // --- facets from the analysis model (post-facet, pre-local/prune) --------
  const domainCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const relationCounts = new Map<string, number>();
  const communityCounts = new Map<number, number>();
  for (const node of analysisModel.nodes) {
    if (node.domain) domainCounts.set(node.domain, (domainCounts.get(node.domain) ?? 0) + 1);
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    if (node.community != null) {
      communityCounts.set(node.community, (communityCounts.get(node.community) ?? 0) + 1);
    }
  }
  for (const edge of analysisModel.edges) {
    relationCounts.set(edge.relation, (relationCounts.get(edge.relation) ?? 0) + 1);
  }
  let maxVisibleNeighbors = 0;
  for (const count of visibleNeighborCounts.values()) {
    if (count > maxVisibleNeighbors) maxVisibleNeighbors = count;
  }
  const facets: DerivedGraphFacets = {
    domains: [...domainCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count })),
    types: [...typeCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count })),
    relations: [...relationCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count })),
    communities: [...communityCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([value, count]) => ({ value, count })),
    maxVisibleNeighbors,
  };

  // --- 7. empty reason -------------------------------------------------------
  const emptyReason: GraphEmptyReason =
    model.nodes.length === 0
      ? "empty-source"
      : visibleModel.nodes.length === 0
        ? "filtered-empty"
        : null;

  return {
    analysisModel,
    visibleModel,
    visibleNeighborCounts,
    facets,
    pausedFilters,
    emptyReason,
    focusMissing,
  };
}
