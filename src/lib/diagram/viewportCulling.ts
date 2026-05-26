/**
 * Viewport culling — pick the subset of nodes + edges that intersect the
 * current viewport so we don't render thousands of off-screen SVG groups.
 *
 * Phase 6 target: 1000 nodes @ >55 fps pan/zoom. With culling, the per-frame
 * render only touches nodes inside the visible rectangle (plus a padding
 * margin so nodes don't pop in at the boundary). `forceVisible` keeps a small
 * always-rendered set — typically the active selection — so the user doesn't
 * see their drag target disappear when it crosses the cull boundary.
 *
 * Pure logic; no DOM, no React. Call from {@link CanvasSurface} with the
 * computed canvas-space viewport rectangle.
 */

import { rectsIntersect, type Rect } from "./geometry";
import type { DiagramEdge, DiagramNode, NodeId } from "./types";

export interface CullInput {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  viewport: Rect;
  /** Extra px around the viewport rect to keep nodes from popping. */
  padding?: number;
  /** Node ids that must remain in the output regardless of position. */
  forceVisible?: ReadonlySet<NodeId>;
}

export interface CullResult {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** True when nothing was culled — callers can skip the result wrapper. */
  full: boolean;
}

function expand(rect: Rect, padding: number): Rect {
  if (padding === 0) return rect;
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    w: rect.w + padding * 2,
    h: rect.h + padding * 2,
  };
}

export function visibleSubset(input: CullInput): CullResult {
  const padding = input.padding ?? 64;
  const padded = expand(input.viewport, padding);
  const forceVisible = input.forceVisible ?? new Set<NodeId>();
  const visibleNodes: DiagramNode[] = [];
  const visibleNodeIds = new Set<NodeId>();
  for (const node of input.nodes) {
    if (node.hidden) continue;
    const nodeRect: Rect = { x: node.x, y: node.y, w: node.w, h: node.h };
    if (forceVisible.has(node.id) || rectsIntersect(padded, nodeRect)) {
      visibleNodes.push(node);
      visibleNodeIds.add(node.id);
    }
  }
  const visibleEdges: DiagramEdge[] = [];
  for (const edge of input.edges) {
    if (visibleNodeIds.has(edge.fromNode) && visibleNodeIds.has(edge.toNode)) {
      visibleEdges.push(edge);
    }
  }
  const full =
    visibleNodes.length === input.nodes.length && visibleEdges.length === input.edges.length;
  return { nodes: visibleNodes, edges: visibleEdges, full };
}
