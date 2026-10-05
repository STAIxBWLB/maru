/**
 * Deterministic auto-layout for whole diagram docs or scoped node sets
 * (issue #433 P1).
 *
 * The algorithm mirrors the flow-family projection in `patterns.ts`: a Kahn
 * longest-path depth over the edges restricted to movable nodes, then layered
 * top-down placement. Unlike the pattern projections (which scale into view
 * bounds), this lays nodes out in absolute canvas units from an origin with
 * fixed column/row steps and keeps each node's own `w`/`h`.
 *
 * Determinism contract: same input doc → identical output coordinates. There
 * is no clock, no randomness, and every iteration order that can affect the
 * result is sorted by node id (byte order, not locale). Cycle members left
 * over after Kahn's algorithm are assigned depths in id order, so cyclic
 * graphs terminate and are reproducible.
 *
 * Placement model: depth `d` rows sit at `origin.y + d * LAYOUT_STEP_Y`;
 * within a row the `i`-th node (id order) sits at `origin.x + i *
 * LAYOUT_STEP_X`. Nodes with no edges among the movable set are appended
 * after the connected ones (id order) on their own row directly below the
 * deepest connected layer.
 *
 * Safety contract: `locked === true` or `meta.pinned === true` nodes are
 * never moved, and a scoped layout never touches out-of-scope nodes; both
 * situations are reported through diagnostics instead of failing silently.
 */
import type { DiagramDoc, DiagramNode, NodeId } from "./types";

export interface LayoutDiagnostic {
  key: string;
  params?: Record<string, string | number>;
}

export interface LayoutResult {
  doc: DiagramDoc;
  diagnostics: LayoutDiagnostic[];
  changed: boolean;
}

export interface LayoutOptions {
  /** When given, only these node ids are eligible for repositioning. */
  scope?: ReadonlySet<NodeId>;
  /** Top-left of the layout grid; defaults to { x: 40, y: 40 }. */
  origin?: { x: number; y: number };
}

/** Horizontal step between consecutive slots in a layer. */
export const LAYOUT_STEP_X = 200;
/** Vertical step between depth layers. */
export const LAYOUT_STEP_Y = 120;
export const LAYOUT_DEFAULT_ORIGIN = { x: 40, y: 40 } as const;

function isPinned(node: DiagramNode): boolean {
  return node.locked === true || node.meta?.pinned === true;
}

/** Byte-order id comparison — stable across locales, unlike localeCompare. */
function byId(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lay out `doc` (or the `opts.scope` subset of it) with the deterministic
 * layered algorithm described in the module header. Pure: the input doc is
 * never mutated, and when nothing moves the original doc reference is
 * returned with `changed: false`.
 */
export function layoutDoc(doc: DiagramDoc, opts: LayoutOptions = {}): LayoutResult {
  const origin = opts.origin ?? LAYOUT_DEFAULT_ORIGIN;
  const scope = opts.scope;
  const diagnostics: LayoutDiagnostic[] = [];

  const inScope = (node: DiagramNode): boolean => (scope ? scope.has(node.id) : true);
  const scopedNodes = doc.nodes.filter(inScope);
  const skipped = scopedNodes.filter(isPinned);
  if (skipped.length > 0) {
    diagnostics.push({ key: "diagram.layout.pinnedKept", params: { count: skipped.length } });
  }

  const movable = scopedNodes
    .filter((node) => !isPinned(node))
    .map((node) => node.id)
    .sort(byId);

  if (movable.length === 0) {
    diagnostics.push({ key: "diagram.layout.infeasible" });
    return { doc, diagnostics, changed: false };
  }

  // A scoped layout ignores out-of-scope neighbours a whole-doc layout would
  // have positioned too; surface that instead of silently pretending the
  // subgraph is the whole graph.
  if (scope) {
    const nodeIds = new Set(doc.nodes.map((node) => node.id));
    const boundary = doc.edges.filter(
      (edge) =>
        nodeIds.has(edge.fromNode) &&
        nodeIds.has(edge.toNode) &&
        scope.has(edge.fromNode) !== scope.has(edge.toNode),
    );
    if (boundary.length > 0) {
      diagnostics.push({
        key: "diagram.layout.scopePreserved",
        params: { count: boundary.length },
      });
    }
  }

  // Longest-path depth from sources (Kahn), over edges whose endpoints are
  // both movable. Cycle members never reach indegree 0 and are assigned
  // afterwards in id order, which breaks cycles deterministically.
  const movableSet = new Set(movable);
  const links = doc.edges.filter(
    (edge) => movableSet.has(edge.fromNode) && movableSet.has(edge.toNode),
  );
  const indegree = new Map<NodeId, number>(movable.map((id) => [id, 0]));
  for (const link of links) {
    indegree.set(link.toNode, (indegree.get(link.toNode) ?? 0) + 1);
  }
  const depth = new Map<NodeId, number>();
  const visited = new Set<NodeId>();
  const queue = movable.filter((id) => (indegree.get(id) ?? 0) === 0);
  const remaining = new Map(indegree);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    depth.set(id, depth.get(id) ?? 0);
    for (const link of links) {
      if (link.fromNode !== id) continue;
      depth.set(link.toNode, Math.max(depth.get(link.toNode) ?? 0, (depth.get(id) ?? 0) + 1));
      const left = (remaining.get(link.toNode) ?? 0) - 1;
      remaining.set(link.toNode, left);
      if (left <= 0) queue.push(link.toNode);
    }
  }
  // Cycle members never reach indegree 0; assign their depths in id order
  // from already-placed predecessors so cyclic graphs terminate and are
  // reproducible ("cycles broken deterministically by node id order").
  for (const id of movable) {
    if (visited.has(id)) continue;
    let best = -1;
    for (const link of links) {
      if (link.toNode !== id || link.fromNode === id) continue;
      const pred = depth.get(link.fromNode);
      if (pred !== undefined) best = Math.max(best, pred);
    }
    depth.set(id, best + 1);
  }

  // Nodes untouched by any movable-edge are appended after the connected
  // ones (id order) on a row below the deepest connected layer.
  const incident = new Set<NodeId>();
  for (const link of links) {
    incident.add(link.fromNode);
    incident.add(link.toNode);
  }
  const connected = movable.filter((id) => incident.has(id));
  const isolated = movable.filter((id) => !incident.has(id));
  const maxConnectedDepth = connected.reduce((max, id) => Math.max(max, depth.get(id) ?? 0), -1);

  const layers = new Map<number, NodeId[]>();
  const addToLayer = (d: number, id: NodeId) => {
    const layer = layers.get(d);
    if (layer) layer.push(id);
    else layers.set(d, [id]);
  };
  for (const id of connected) addToLayer(depth.get(id) ?? 0, id);
  for (const id of isolated) addToLayer(maxConnectedDepth + 1, id);

  const positions = new Map<NodeId, { x: number; y: number }>();
  for (const [d, ids] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    ids.sort(byId).forEach((id, i) => {
      positions.set(id, {
        x: origin.x + i * LAYOUT_STEP_X,
        y: origin.y + d * LAYOUT_STEP_Y,
      });
    });
  }

  let changed = false;
  const nodes = doc.nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) return node;
    if (node.x === pos.x && node.y === pos.y) return node;
    changed = true;
    return { ...node, x: pos.x, y: pos.y };
  });

  return { doc: changed ? { ...doc, nodes } : doc, diagnostics, changed };
}
