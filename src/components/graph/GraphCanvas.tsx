// SVG force-graph canvas (maru-vault-graph-spec §F2). Rendering only — the
// layout runs in layout.worker.ts; this component owns viewport (zoom/pan,
// gesture pattern from diagram CanvasSurface), hover 1-hop highlight,
// viewport culling (nodes as 1px rects), and drag/pin plumbed to the worker.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "../../lib/graph/model";

export interface GraphViewport {
  zoom: number;
  px: number;
  py: number;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const LABEL_ZOOM_THRESHOLD = 0.6;
const CULL_PADDING = 64;

// 12-color categorical palette for communities (spec §F2 시각 인코딩).
const COMMUNITY_COLORS = [
  "#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#eeca3b",
  "#b279a2", "#ff9da6", "#9d755d", "#bab0ac", "#86bcb6", "#d67195",
];
const DOMAIN_COLORS: Record<string, string> = {
  research: "#4c78a8",
  projects: "#f58518",
  teaching: "#54a24b",
  operations: "#e45756",
  people: "#b279a2",
  "ai-practice": "#72b7b2",
};
const FALLBACK_COLOR = "#8a8f98";

export function nodeRadius(degree: number): number {
  return Math.min(18, Math.max(4, 4 + 2 * Math.sqrt(degree)));
}

export function nodeColor(node: GraphNode, enriched: boolean): string {
  if (node.type === "unresolved") return "transparent";
  if (enriched && node.community != null) {
    return COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length];
  }
  return node.domain ? (DOMAIN_COLORS[node.domain] ?? FALLBACK_COLOR) : FALLBACK_COLOR;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Index-aligned with `nodes`; null until the first worker frame. */
  positions: Float64Array | null;
  /** Bumped by GraphView on each worker re-init — triggers a fit-view. */
  layoutEpoch: number;
  enriched: boolean;
  focusNodeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onNodeDrag: (
    index: number,
    phase: "start" | "move" | "end",
    x: number,
    y: number,
  ) => void;
  onNodeUnpin: (index: number) => void;
}

export function GraphCanvas({
  nodes,
  edges,
  positions,
  layoutEpoch,
  enriched,
  focusNodeId,
  onNodeClick,
  onNodeDrag,
  onNodeUnpin,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewport, setViewport] = useState<GraphViewport>({ zoom: 1, px: 0, py: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const fittedEpochRef = useRef(-1);

  // Fit-view once per layout epoch, on the first frame that has positions —
  // the worker's layout space is independent of the on-screen canvas size.
  useEffect(() => {
    if (!positions || positions.length === 0) return;
    if (fittedEpochRef.current === layoutEpoch) return;
    fittedEpochRef.current = layoutEpoch;
    const rect = svgRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 1200;
    const height = rect?.height ?? 800;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < positions.length; i += 2) {
      if (positions[i] < minX) minX = positions[i];
      if (positions[i] > maxX) maxX = positions[i];
      if (positions[i + 1] < minY) minY = positions[i + 1];
      if (positions[i + 1] > maxY) maxY = positions[i + 1];
    }
    const bw = Math.max(maxX - minX, 1) + 120;
    const bh = Math.max(maxY - minY, 1) + 120;
    const zoom = clamp(Math.min(width / bw, height / bh), MIN_ZOOM, MAX_ZOOM);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewport({ zoom, px: width / 2 - cx * zoom, py: height / 2 - cy * zoom });
  }, [positions, layoutEpoch]);
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; origin: GraphViewport }
    | { kind: "drag"; nodeIndex: number; startX: number; startY: number; moved: boolean }
    | null
  >(null);

  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    nodes.forEach((node, i) => map.set(node.id, i));
    return map;
  }, [nodes]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of edges) {
      (map.get(edge.source) ?? map.set(edge.source, new Set()).get(edge.source)!).add(edge.target);
      (map.get(edge.target) ?? map.set(edge.target, new Set()).get(edge.target)!).add(edge.source);
    }
    return map;
  }, [edges]);

  const screenToCanvas = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - viewport.px) / viewport.zoom,
      y: (sy - viewport.py) / viewport.zoom,
    }),
    [viewport],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<SVGSVGElement>) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const factor = Math.pow(1.0015, -event.deltaY);
      setViewport((current) => {
        const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const cx = (sx - current.px) / current.zoom;
        const cy = (sy - current.py) / current.zoom;
        return { zoom, px: sx - cx * zoom, py: sy - cy * zoom };
      });
    },
    [],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const target = event.target as SVGElement;
      const nodeIndexAttr = target.getAttribute("data-node-index");
      if (nodeIndexAttr != null) {
        const index = Number(nodeIndexAttr);
        gesture.current = {
          kind: "drag",
          nodeIndex: index,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        const rect = svgRef.current!.getBoundingClientRect();
        const point = screenToCanvas(event.clientX - rect.left, event.clientY - rect.top);
        onNodeDrag(index, "start", point.x, point.y);
      } else {
        gesture.current = {
          kind: "pan",
          startX: event.clientX,
          startY: event.clientY,
          origin: viewport,
        };
      }
      (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    },
    [onNodeDrag, screenToCanvas, viewport],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const active = gesture.current;
      if (!active) return;
      if (active.kind === "pan") {
        setViewport({
          ...active.origin,
          px: active.origin.px + (event.clientX - active.startX),
          py: active.origin.py + (event.clientY - active.startY),
        });
      } else {
        if (
          Math.abs(event.clientX - active.startX) > 3
          || Math.abs(event.clientY - active.startY) > 3
        ) {
          active.moved = true;
        }
        const rect = svgRef.current!.getBoundingClientRect();
        const point = screenToCanvas(event.clientX - rect.left, event.clientY - rect.top);
        onNodeDrag(active.nodeIndex, "move", point.x, point.y);
      }
    },
    [onNodeDrag, screenToCanvas],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const active = gesture.current;
      gesture.current = null;
      if (active?.kind === "drag") {
        const rect = svgRef.current!.getBoundingClientRect();
        const point = screenToCanvas(event.clientX - rect.left, event.clientY - rect.top);
        onNodeDrag(active.nodeIndex, "end", point.x, point.y);
        // Pointer capture on the svg swallows the synthetic click on the
        // circle — a press without movement IS the click.
        if (!active.moved) {
          const node = nodes[active.nodeIndex];
          if (node) onNodeClick(node);
        }
      }
    },
    [nodes, onNodeClick, onNodeDrag, screenToCanvas],
  );

  // Viewport culling: node → 1px rect vs padded viewport rect
  // (viewportCulling.visibleSubset pattern; adapted to graph node shape).
  const visible = useMemo(() => {
    if (!positions) return { nodes: new Set<number>(), full: false };
    const rect = svgRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 1200;
    const height = rect?.height ?? 800;
    const minX = (-viewport.px - CULL_PADDING) / viewport.zoom;
    const minY = (-viewport.py - CULL_PADDING) / viewport.zoom;
    const maxX = (width - viewport.px + CULL_PADDING) / viewport.zoom;
    const maxY = (height - viewport.py + CULL_PADDING) / viewport.zoom;
    const set = new Set<number>();
    for (let i = 0; i < nodes.length; i += 1) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) set.add(i);
    }
    return { nodes: set, full: set.size === nodes.length };
  }, [nodes, positions, viewport]);

  const hoverNeighbors = hoveredId ? (adjacency.get(hoveredId) ?? new Set()) : null;
  const showLabels = viewport.zoom > LABEL_ZOOM_THRESHOLD;

  if (!positions) {
    return (
      <div className="graph-canvas-loading" data-testid="graph-canvas-loading">
        …
      </div>
    );
  }

  return (
    <svg
      ref={svgRef}
      className="graph-canvas"
      data-testid="graph-canvas"
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <g transform={`translate(${viewport.px}, ${viewport.py}) scale(${viewport.zoom})`}>
        <g className="graph-edges">
          {edges.map((edge, i) => {
            const si = indexById.get(edge.source);
            const ti = indexById.get(edge.target);
            if (si == null || ti == null) return null;
            if (!visible.full && !visible.nodes.has(si) && !visible.nodes.has(ti)) return null;
            const dimmed =
              hoveredId != null && edge.source !== hoveredId && edge.target !== hoveredId;
            const isSupersedes = edge.relation === "supersedes" || edge.relation === "superseded_by";
            return (
              <line
                key={i}
                x1={positions[si * 2]}
                y1={positions[si * 2 + 1]}
                x2={positions[ti * 2]}
                y2={positions[ti * 2 + 1]}
                className={
                  "graph-edge" +
                  (edge.fromFrontmatter ? " frontmatter" : " wikilink") +
                  (dimmed ? " dimmed" : "")
                }
                markerEnd={isSupersedes ? "url(#graph-arrow)" : undefined}
              />
            );
          })}
        </g>
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        <g className="graph-nodes">
          {nodes.map((node, i) => {
            if (!visible.full && !visible.nodes.has(i)) return null;
            const x = positions[i * 2];
            const y = positions[i * 2 + 1];
            const r = nodeRadius(node.degree);
            const isGhost = node.type === "unresolved";
            const isFocus = node.id === focusNodeId;
            const isHover = node.id === hoveredId;
            const isNeighbor = hoverNeighbors?.has(node.id) ?? false;
            const dimmed = hoveredId != null && !isHover && !isNeighbor;
            return (
              <g
                key={node.id}
                className={
                  "graph-node" +
                  (isGhost ? " ghost" : "") +
                  (node.isGodNode ? " god" : "") +
                  (isFocus ? " focus" : "") +
                  (dimmed ? " dimmed" : "")
                }
                transform={`translate(${x}, ${y})`}
              >
                <circle
                  r={r}
                  data-node-index={i}
                  data-node-id={node.id}
                  fill={nodeColor(node, enriched)}
                  onDoubleClick={() => onNodeUnpin(i)}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                />
                {showLabels || isHover || isFocus || node.isGodNode ? (
                  <text className="graph-node-label" dy={r + 12}>
                    {node.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </g>
    </svg>
  );
}
