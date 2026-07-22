// Pure derivation pipeline for the graph workbench. The renderer keeps the
// full topology for stable layout, while these outputs define the one truthful
// analysis/visibility contract used by every consumer.

import type { GraphFilterProfile, GraphMode } from "../settings";
import {
  focusSubgraph,
  graphEdgeVisibilityKey,
  isGeneratedNode,
  withGraphDegrees,
  type GraphModel,
  type GraphNode,
} from "./model";
import { graphNodeMatchesSearch } from "./search";

export interface DerivedGraphFacets {
  domains: { value: string; count: number }[];
  types: { value: string; count: number }[];
  relations: { value: string; count: number }[];
  communities: { value: number; count: number }[];
  maxVisibleNeighbors: number;
}

export type GraphEmptyReason = "empty-source" | "filtered-empty" | null;

export interface DerivedGraph {
  /** Facets + relations + Local + k-core, before transient search filtering. */
  analysisModel: GraphModel;
  /** Exact canvas/inspector/export view, including search-as-filter. */
  visibleModel: GraphModel;
  visibleNodeIds: Set<string>;
  visibleEdgeKeys: Set<string>;
  /** Derived degree per analysis node. */
  visibleNeighborCounts: Map<string, number>;
  facets: DerivedGraphFacets;
  /** Persisted selections absent from the source model. */
  pausedFilters: string[];
  emptyReason: GraphEmptyReason;
  /** Local mode requested a canonical target absent from the current source. */
  focusMissing: boolean;
  /** Local focus node kept visible through pruning and search narrowing. */
  protectedFocusId: string | null;
}

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
    nodes: model.nodes.filter((node) => !removed.has(node.id)),
    edges: model.edges.filter(
      (edge) => !removed.has(edge.source) && !removed.has(edge.target),
    ),
  };
}

function distinctNeighborCounts(model: GraphModel): Map<string, number> {
  const neighbors = new Map(model.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of model.edges) {
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }
  return new Map([...neighbors].map(([id, ids]) => [id, ids.size]));
}

type NodeFacet = "domain" | "type" | "community" | null;

function nodePasses(
  node: GraphNode,
  profile: GraphFilterProfile,
  generatedPatterns: readonly string[],
  focusNodeId: string | null,
  activeDomains: ReadonlySet<string>,
  activeTypes: ReadonlySet<string>,
  communityActive: boolean,
  omit: NodeFacet = null,
): boolean {
  if (node.id === focusNodeId) return true;
  if (!profile.showUnresolved && node.type === "unresolved") return false;
  if (!profile.showGenerated && isGeneratedNode(node, generatedPatterns)) return false;
  if (omit !== "domain" && activeDomains.size > 0 && (!node.domain || !activeDomains.has(node.domain))) {
    return false;
  }
  if (omit !== "type" && activeTypes.size > 0 && !activeTypes.has(node.type)) return false;
  if (omit !== "community" && communityActive && node.community !== profile.community) return false;
  return true;
}

function countNodeFacet<T extends string | number>(
  nodes: readonly GraphNode[],
  value: (node: GraphNode) => T | null,
): Map<T, number> {
  const counts = new Map<T, number>();
  for (const node of nodes) {
    const item = value(node);
    if (item != null) counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

function facetItems<T extends string | number>(
  counts: Map<T, number>,
  selected: readonly T[],
  compare: (a: T, b: T) => number,
): { value: T; count: number }[] {
  for (const value of selected) {
    if (!counts.has(value)) counts.set(value, 0);
  }
  return [...counts.entries()]
    .sort((a, b) => compare(a[0], b[0]))
    .map(([value, count]) => ({ value, count }));
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
  const activeDomains = new Set(profile.domains.filter((value) => {
    if (modelDomains.has(value)) return true;
    pausedFilters.push(`domain:${value}`);
    return false;
  }));
  const activeTypes = new Set(profile.types.filter((value) => {
    if (modelTypes.has(value)) return true;
    pausedFilters.push(`type:${value}`);
    return false;
  }));
  const activeRelations = new Set(profile.relations.filter((value) => {
    if (modelRelations.has(value)) return true;
    pausedFilters.push(`relation:${value}`);
    return false;
  }));
  const communityActive = profile.community != null && modelCommunities.has(profile.community);
  if (profile.community != null && !communityActive) {
    pausedFilters.push(`community:${profile.community}`);
  }

  const focusExists = focusNodeId != null && model.nodes.some((node) => node.id === focusNodeId);
  const protectedFocusId = mode === "local" && focusExists ? focusNodeId : null;
  const pass = (node: GraphNode, omit: NodeFacet = null) => nodePasses(
    node,
    profile,
    generatedPatterns,
    protectedFocusId,
    activeDomains,
    activeTypes,
    communityActive,
    omit,
  );

  // Self-excluding facets keep additive choices visible. Relation counts use
  // the fully node-filtered graph before the relation facet applies itself.
  const domainCounts = countNodeFacet(model.nodes.filter((node) => pass(node, "domain")), (node) => node.domain);
  const typeCounts = countNodeFacet(model.nodes.filter((node) => pass(node, "type")), (node) => node.type);
  const communityCounts = countNodeFacet(
    model.nodes.filter((node) => pass(node, "community")),
    (node) => node.community,
  );

  const keptNodeIds = new Set(model.nodes.filter((node) => pass(node)).map((node) => node.id));
  const nodeFilteredEdges = model.edges.filter(
    (edge) => keptNodeIds.has(edge.source) && keptNodeIds.has(edge.target),
  );
  const relationCounts = new Map<string, number>();
  for (const edge of nodeFilteredEdges) {
    relationCounts.set(edge.relation, (relationCounts.get(edge.relation) ?? 0) + 1);
  }
  const relationFilteredEdges = activeRelations.size === 0
    ? nodeFilteredEdges
    : nodeFilteredEdges.filter((edge) => activeRelations.has(edge.relation));

  let working = withGraphDegrees({
    ...model,
    nodes: model.nodes.filter((node) => keptNodeIds.has(node.id)),
    edges: relationFilteredEdges,
  });
  const focusMissing = mode === "local" && focusNodeId != null && !focusExists;
  if (mode === "local" && protectedFocusId) {
    working = focusSubgraph(working, protectedFocusId, localDepth, localDirection);
  }
  working = withGraphDegrees(
    pruneByMinNeighbors(working, profile.minVisibleNeighbors, protectedFocusId),
  );
  const analysisModel = working;

  const visibleNodeIds = new Set(analysisModel.nodes.map((node) => node.id));
  const visibleEdgeKeys = new Set(analysisModel.edges.map(graphEdgeVisibilityKey));
  const visibleNeighborCounts = distinctNeighborCounts(analysisModel);
  const maxVisibleNeighbors = Math.max(0, ...visibleNeighborCounts.values());

  const facets: DerivedGraphFacets = {
    domains: facetItems(domainCounts, profile.domains, (a, b) => a.localeCompare(b)),
    types: facetItems(typeCounts, profile.types, (a, b) => a.localeCompare(b)),
    relations: facetItems(relationCounts, profile.relations, (a, b) => a.localeCompare(b)),
    communities: facetItems(
      communityCounts,
      profile.community == null ? [] : [profile.community],
      (a, b) => a - b,
    ),
    maxVisibleNeighbors,
  };

  const emptyReason: GraphEmptyReason = model.nodes.length === 0
    ? "empty-source"
    : analysisModel.nodes.length === 0
      ? "filtered-empty"
      : null;

  const base: DerivedGraph = {
    analysisModel,
    visibleModel: analysisModel,
    visibleNodeIds,
    visibleEdgeKeys,
    visibleNeighborCounts,
    facets,
    pausedFilters,
    emptyReason,
    focusMissing,
    protectedFocusId,
  };
  return applyGraphSearch(base, searchAsFilter ? search : "");
}

/** Transient search narrowing over an analysis-stage derivation. Split out so
 * the expensive facet/local/k-core stage keeps a stable identity across
 * keystrokes — recreating `analysisModel` per keystroke made the insights
 * panel terminate and respawn its worker (with a full structured clone of the
 * graph) on every character typed. */
export function applyGraphSearch(base: DerivedGraph, search: string): DerivedGraph {
  const query = search.trim();
  if (!query) return base;
  const analysis = base.analysisModel;
  const matched = new Set(
    analysis.nodes.filter((node) => graphNodeMatchesSearch(node, query)).map((node) => node.id),
  );
  const visible = new Set(matched);
  for (const edge of analysis.edges) {
    if (matched.has(edge.source)) visible.add(edge.target);
    if (matched.has(edge.target)) visible.add(edge.source);
  }
  if (base.protectedFocusId) visible.add(base.protectedFocusId);
  const visibleModel = withGraphDegrees({
    ...analysis,
    nodes: analysis.nodes.filter((node) => visible.has(node.id)),
    edges: analysis.edges.filter(
      (edge) => visible.has(edge.source) && visible.has(edge.target),
    ),
  });
  return {
    ...base,
    visibleModel,
    visibleNodeIds: new Set(visibleModel.nodes.map((node) => node.id)),
    visibleEdgeKeys: new Set(visibleModel.edges.map(graphEdgeVisibilityKey)),
    emptyReason: base.emptyReason === "empty-source"
      ? "empty-source"
      : visibleModel.nodes.length === 0
        ? "filtered-empty"
        : base.emptyReason,
  };
}
