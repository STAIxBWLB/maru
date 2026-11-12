// Graph insight engine — the "ideation" layer over the read-only graph.
//
// All analyses run in a worker over the in-memory GraphModel, so nothing here
// depends on the weekly `vmem graph build` report; these are the same ideas
// (god nodes, surprising cross-community links, community bridges) recomputed
// live, plus link prediction (hidden links) and path finding for exploration.

import { buildAdjacency, type GraphModel, type GraphNode } from "./model";

/** Types excluded from insight endpoints: ghosts aren't real notes, and MOCs
 *  are deliberate hubs that connect everything — a shared MOC neighbor or an
 *  MOC endpoint is never a "surprising" signal. */
const HUB_TYPES = new Set(["moc", "unresolved"]);

// ponytail: findHiddenLinks is O(Σ deg²). Capping the bridging degree bounds
// it and improves quality — a mega-hub linking everything doesn't make two of
// its neighbors meaningfully related. Raise the cap if recall matters more.
const COMMON_NEIGHBOR_DEGREE_CAP = 30;
const DAY_MS = 86_400_000;

function isHub(node: GraphNode | undefined): boolean {
  return !node || HUB_TYPES.has(node.type);
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export interface HiddenLink {
  source: string;
  target: string;
  /** Number of shared neighbors (common-neighbor link-prediction score). */
  shared: number;
  /** Adamic-Adar style weighted score; specific shared neighbors count more. */
  score: number;
  /** Ids of a few shared neighbors, for "connected via …" explanation. */
  via: string[];
}

/** Non-adjacent note pairs that share ≥2 neighbors — candidate links the
 *  author hasn't drawn yet. This is the core "derive new relationships"
 *  feature. */
export function findHiddenLinks(model: GraphModel, limit = 12): HiddenLink[] {
  const adjacency = buildAdjacency(model);
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const nodeIndex = new Map(model.nodes.map((node, index) => [node.id, index]));
  const nodeCount = model.nodes.length;
  // A numeric pair key avoids allocating and later splitting a temporary
  // string for every candidate pair. nodeCount² remains safely below
  // Number.MAX_SAFE_INTEGER for the graph sizes Maru supports.
  const pairs = new Map<number, { count: number; score: number; via: string[] }>();

  for (const node of model.nodes) {
    if (isHub(node)) continue;
    const neighbors = [...(adjacency.get(node.id) ?? [])].filter(
      (id) => !isHub(nodeById.get(id)),
    );
    if (neighbors.length < 2 || neighbors.length > COMMON_NEIGHBOR_DEGREE_CAP) {
      continue;
    }
    const weight = 1 / Math.log2(2 + Math.max(1, node.degree));
    for (let i = 0; i < neighbors.length; i += 1) {
      for (let j = i + 1; j < neighbors.length; j += 1) {
        const a = neighbors[i];
        const b = neighbors[j];
        if (adjacency.get(a)?.has(b)) continue; // already directly linked
        const aIndex = nodeIndex.get(a)!;
        const bIndex = nodeIndex.get(b)!;
        const key =
          aIndex < bIndex
            ? aIndex * nodeCount + bIndex
            : bIndex * nodeCount + aIndex;
        const entry = pairs.get(key);
        if (entry) {
          entry.count += 1;
          entry.score += weight;
          if (entry.via.length < 5) entry.via.push(node.id);
        } else {
          pairs.set(key, { count: 1, score: weight, via: [node.id] });
        }
      }
    }
  }

  const out: HiddenLink[] = [];
  for (const [key, { count, score, via }] of pairs) {
    if (count < 2) continue;
    const source = model.nodes[Math.floor(key / nodeCount)].id;
    const target = model.nodes[key % nodeCount].id;
    out.push({ source, target, shared: count, score, via });
  }
  out.sort((a, b) => b.score - a.score || b.shared - a.shared || a.source.localeCompare(b.source));
  return out.slice(0, limit);
}

export interface SurprisingConnection {
  source: string;
  target: string;
  score: number;
  sourceCommunity: number | null;
  targetCommunity: number | null;
}

/** Existing edges that cross community boundaries, ranked by combined degree
 *  (the producer's "Surprising Connections (Cross-Community)" report section).
 *  Requires the community overlay; returns [] on the degraded live graph. */
export function findSurprisingConnections(
  model: GraphModel,
  limit = 12,
): SurprisingConnection[] {
  if (!model.enriched) return [];
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: SurprisingConnection[] = [];
  for (const edge of model.edges) {
    const s = nodeById.get(edge.source);
    const t = nodeById.get(edge.target);
    if (isHub(s) || isHub(t)) continue;
    if (s!.community == null || t!.community == null) continue;
    if (s!.community === t!.community) continue;
    const key = pairKey(edge.source, edge.target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: edge.source,
      target: edge.target,
      score: s!.degree + t!.degree,
      sourceCommunity: s!.community,
      targetCommunity: t!.community,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export interface BridgeNode {
  id: string;
  communityCount: number;
  neighborCount: number;
  communities: number[];
}

/** Notes whose neighbors span the most distinct communities — the connectors
 *  that hold otherwise-separate clusters together (a cheap betweenness proxy).
 *  Requires the community overlay. */
export function findBridges(model: GraphModel, limit = 12): BridgeNode[] {
  if (!model.enriched) return [];
  const adjacency = buildAdjacency(model);
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const out: BridgeNode[] = [];
  for (const node of model.nodes) {
    if (isHub(node)) continue;
    const neighbors = adjacency.get(node.id);
    if (!neighbors) continue;
    const communities = new Set<number>();
    for (const id of neighbors) {
      const n = nodeById.get(id);
      if (n && n.community != null) communities.add(n.community);
    }
    if (communities.size >= 2) {
      out.push({
        id: node.id,
        communityCount: communities.size,
        neighborCount: neighbors.size,
        communities: [...communities].sort((a, b) => a - b),
      });
    }
  }
  out.sort(
    (a, b) => b.communityCount - a.communityCount || b.neighborCount - a.neighborCount,
  );
  return out.slice(0, limit);
}

export interface OrphanNode {
  id: string;
  degree: number;
}

/** Notes with ≤1 connection (excluding ghosts and MOC hubs) — candidates to
 *  link into the graph or archive. */
export function findOrphans(model: GraphModel, limit = 20): OrphanNode[] {
  const out: OrphanNode[] = [];
  for (const node of model.nodes) {
    if (node.type === "unresolved" || node.type === "moc") continue;
    if (node.degree <= 1) out.push({ id: node.id, degree: node.degree });
  }
  out.sort((a, b) => a.degree - b.degree || a.id.localeCompare(b.id));
  return out.slice(0, limit);
}

export interface StaleNode {
  id: string;
  degree: number;
  updatedAt: string | null;
}

/** Well-connected notes not touched in `olderThanDays` — worth revisiting.
 *  `now` is passed for deterministic tests. */
export function findStale(
  model: GraphModel,
  olderThanDays: number,
  now: number,
  limit = 20,
): StaleNode[] {
  const cutoff = now - olderThanDays * DAY_MS;
  const out: StaleNode[] = [];
  for (const node of model.nodes) {
    if (node.type === "unresolved") continue;
    if (node.degree < 2) continue;
    const ts = node.updatedAt ? Date.parse(node.updatedAt) : NaN;
    if (Number.isNaN(ts) || ts >= cutoff) continue;
    out.push({ id: node.id, degree: node.degree, updatedAt: node.updatedAt });
  }
  out.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
  return out.slice(0, limit);
}

/** Shortest path between two nodes (BFS over the undirected graph) — "how are
 *  these two ideas connected?". Returns the id chain (inclusive) or null. */
export function shortestPath(
  model: GraphModel,
  sourceId: string,
  targetId: string,
): string[] | null {
  if (sourceId === targetId) return [sourceId];
  const adjacency = buildAdjacency(model);
  if (!adjacency.has(sourceId) || !adjacency.has(targetId)) return null;
  const prev = new Map<string, string>();
  const visited = new Set<string>([sourceId]);
  // ponytail: array-shift BFS is O(n²) worst case; fine at vault scale, swap
  // for a ring buffer if this ever runs on 10k+ nodes.
  const queue: string[] = [sourceId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      prev.set(next, current);
      if (next === targetId) {
        const path = [targetId];
        let step = targetId;
        while (step !== sourceId) {
          step = prev.get(step)!;
          path.push(step);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}
