/**
 * Edge geometry — pure routing helpers.
 *
 * The source HTML editor uses a hand-rolled SVG path with three modes;
 * Phase 2 ships `auto` (orthogonal "manhattan" L/S-shape) and `straight`
 * (one line segment). Phase 3 will add `curved`. All inputs are
 * data — no DOM access — so call sites that need a path simply pipe the
 * doc through {@link routeEdge}.
 *
 * Arrowhead `<marker>` ids are exported so callers can render a single
 * shared `<defs>` block and reference markers by id.
 */

import { portPoint } from "./geometry";
import type { DiagramEdge, DiagramNode } from "./types";

export const ARROW_MARKER_ID = {
  filled: "anchor-diagram-arrow-filled",
  open: "anchor-diagram-arrow-open",
} as const;

export type ArrowKind = keyof typeof ARROW_MARKER_ID;

export interface RoutedEdge {
  /** Full SVG path `d` attribute string. */
  path: string;
  /** Visible label anchor (the path midpoint). */
  label: { x: number; y: number };
  /** Midpoint handle position (offset by edge.midOff in the perpendicular axis). */
  mid: { x: number; y: number };
  /** Tangent direction at the head, useful for orienting custom arrow heads. */
  headDir: { x: number; y: number };
}

const EMPTY_VEC = { x: 0, y: 0 };

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function unitVec(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return EMPTY_VEC;
  return { x: dx / len, y: dy / len };
}

function autoPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  startPort: DiagramEdge["fromPort"],
  endPort: DiagramEdge["toPort"],
  midOff: number,
): RoutedEdge {
  const horizontal = (port: string) => port === "e" || port === "w";
  // Strategy: leave each port perpendicular to its side by half the gap,
  // then connect with one orthogonal turn.
  const startHorizontal = horizontal(startPort);
  const endHorizontal = horizontal(endPort);
  let bend: { x: number; y: number };
  if (startHorizontal === endHorizontal) {
    // Same axis — single turn at half the distance.
    if (startHorizontal) {
      const cx = (start.x + end.x) / 2 + (midOff || 0);
      bend = { x: cx, y: start.y };
      const path = `M ${start.x} ${start.y} L ${cx} ${start.y} L ${cx} ${end.y} L ${end.x} ${end.y}`;
      return finalize(path, start, end);
    }
    const cy = (start.y + end.y) / 2 + (midOff || 0);
    bend = { x: start.x, y: cy };
    const path = `M ${start.x} ${start.y} L ${start.x} ${cy} L ${end.x} ${cy} L ${end.x} ${end.y}`;
    return finalize(path, start, end);
  }
  // Different axes — single L bend.
  if (startHorizontal) {
    bend = { x: end.x, y: start.y };
  } else {
    bend = { x: start.x, y: end.y };
  }
  const path = `M ${start.x} ${start.y} L ${bend.x} ${bend.y} L ${end.x} ${end.y}`;
  return finalize(path, start, end);
}

function finalize(
  path: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
): RoutedEdge {
  const label = midpoint(start, end);
  return {
    path,
    label,
    mid: label,
    headDir: unitVec(start, end),
  };
}

function straightPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
): RoutedEdge {
  return finalize(`M ${start.x} ${start.y} L ${end.x} ${end.y}`, start, end);
}

// ---------------------------------------------------------------------------
// Route cache
//
// `routeEdge` is invoked on every render of every edge — Phase 6 caches the
// result keyed by all the inputs that affect the path, so a 200-edge diagram
// only recomputes the routes for edges whose endpoints actually moved this
// frame.
// ---------------------------------------------------------------------------

const ROUTE_CACHE_CAP = 5_000;
const routeCache = new Map<string, RoutedEdge>();

function routeKey(
  edge: DiagramEdge,
  fromNode: DiagramNode,
  toNode: DiagramNode,
): string {
  return [
    edge.id,
    edge.fromPort,
    edge.toPort,
    edge.routeMode ?? "auto",
    edge.midOff ?? 0,
    fromNode.x, fromNode.y, fromNode.w, fromNode.h,
    toNode.x, toNode.y, toNode.w, toNode.h,
  ].join("|");
}

function rememberRoute(key: string, value: RoutedEdge): RoutedEdge {
  if (routeCache.size >= ROUTE_CACHE_CAP) {
    // Evict the oldest insertion — Map preserves insertion order.
    const oldestKey = routeCache.keys().next().value as string | undefined;
    if (oldestKey !== undefined) routeCache.delete(oldestKey);
  }
  routeCache.set(key, value);
  return value;
}

/** Drop every cached entry — useful in tests or on doc replace. */
export function clearRouteCache(): void {
  routeCache.clear();
}

/** Read-only handle for tests. */
export function _routeCacheSizeForTests(): number {
  return routeCache.size;
}

export function routeEdge(
  edge: DiagramEdge,
  fromNode: DiagramNode | undefined,
  toNode: DiagramNode | undefined,
): RoutedEdge | null {
  if (!fromNode || !toNode) return null;
  const key = routeKey(edge, fromNode, toNode);
  const cached = routeCache.get(key);
  if (cached) return cached;
  const start = portPoint(fromNode, edge.fromPort);
  const end = portPoint(toNode, edge.toPort);
  const mode = edge.routeMode ?? "auto";
  const routed =
    mode === "straight"
      ? straightPath(start, end)
      : autoPath(start, end, edge.fromPort, edge.toPort, edge.midOff ?? 0);
  return rememberRoute(key, routed);
}

export function defaultEdge(
  id: string,
  fromNode: string,
  fromPort: DiagramEdge["fromPort"],
  toNode: string,
  toPort: DiagramEdge["toPort"],
  overrides: Partial<DiagramEdge> = {},
): DiagramEdge {
  return {
    id,
    fromNode,
    fromPort,
    toNode,
    toPort,
    routeMode: "auto",
    arrowStart: "none",
    arrowEnd: "filled",
    arrowSize: 1,
    dash: "solid",
    width: 1.5,
    color: "#1f2937",
    midOff: 0,
    ...overrides,
  };
}
