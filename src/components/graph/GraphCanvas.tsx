// SVG force-graph canvas (maru-vault-graph-spec §F2). Rendering only — layout
// runs in layout.worker.ts. This owns viewport (zoom/pan), hover highlight,
// and the select / double-click-open / drag-pin / path-target interactions.
//
// Perf: nodes and edges are memoized child components (diagram NodeView/EdgeView
// pattern), so pan/zoom updates only the container <g transform> — zero child
// reconciliation once the layout has settled. No viewport culling at this scale
// (≤~2k nodes render fine); a ResizeObserver caches the canvas size instead of
// reading getBoundingClientRect() every frame.
// ponytail: no cull is deliberate for vault scale — if a vault exceeds ~3k
// nodes, reintroduce hysteretic culling or a canvas renderer.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clamp } from "../../lib/diagram/geometry";
import type { GraphEdge, GraphNode } from "../../lib/graph/model";

export interface GraphViewport {
  zoom: number;
  px: number;
  py: number;
}

/** Canvas highlight overlay: an insight-suggested pair (dashed virtual edge) or
 *  a discovered path (chain of ids). */
export type GraphHighlight =
  | { kind: "pair"; a: string; b: string }
  | { kind: "path"; ids: string[] }
  | null;

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3.5;
const LABEL_ZOOM_THRESHOLD = 0.7;

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
  return Math.min(20, Math.max(4, 4 + 2 * Math.sqrt(degree)));
}

export function nodeColor(node: GraphNode, enriched: boolean): string {
  if (node.type === "unresolved") return "transparent";
  if (enriched && node.community != null) {
    return COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length];
  }
  return node.domain ? (DOMAIN_COLORS[node.domain] ?? FALLBACK_COLOR) : FALLBACK_COLOR;
}

export function communityColor(community: number): string {
  return COMMUNITY_COLORS[community % COMMUNITY_COLORS.length];
}

export function domainColor(domain: string | null): string {
  return domain ? (DOMAIN_COLORS[domain] ?? FALLBACK_COLOR) : FALLBACK_COLOR;
}

// --- memoized primitives -------------------------------------------------

const EdgeView = memo(function EdgeView({
  x1, y1, x2, y2, className, marker,
}: {
  x1: number; y1: number; x2: number; y2: number; className: string; marker: boolean;
}) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      className={className}
      markerEnd={marker ? "url(#graph-arrow)" : undefined}
    />
  );
});

const NodeView = memo(function NodeView({
  index, id, x, y, r, fill, className, label, showLabel, onEnter, onLeave,
}: {
  index: number;
  id: string;
  x: number;
  y: number;
  r: number;
  fill: string;
  className: string;
  label: string;
  showLabel: boolean;
  onEnter: (id: string) => void;
  onLeave: () => void;
}) {
  return (
    <g className={className} transform={`translate(${x}, ${y})`}>
      <circle
        r={r}
        data-node-index={index}
        data-node-id={id}
        fill={fill}
        onMouseEnter={() => onEnter(id)}
        onMouseLeave={onLeave}
      />
      {showLabel ? (
        <text className="graph-node-label" dy={r + 12}>
          {label}
        </text>
      ) : null}
    </g>
  );
});

// --- canvas --------------------------------------------------------------

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Float64Array | null;
  /** Bumped by GraphView on each worker re-init — triggers a fit-view. */
  layoutEpoch: number;
  enriched: boolean;
  selectedId: string | null;
  focusNodeId: string | null;
  pathSourceId: string | null;
  highlight: GraphHighlight;
  /** Imperative fit-view trigger from the toolbar; increment to refit. */
  fitSignal: number;
  zoomSignal: { dir: 1 | -1; nonce: number } | null;
  /** Pan to center a node (from an insight-row click); keeps current zoom. */
  centerSignal: { id: string; nonce: number } | null;
  onSelect: (node: GraphNode | null) => void;
  onOpen: (node: GraphNode) => void;
  onPathTarget: (node: GraphNode) => void;
  onNodeDrag: (index: number, phase: "start" | "move" | "end", x: number, y: number) => void;
  onNodeUnpin: (index: number) => void;
  onViewportReport?: (zoom: number) => void;
}

export function GraphCanvas({
  nodes,
  edges,
  positions,
  layoutEpoch,
  enriched,
  selectedId,
  focusNodeId,
  pathSourceId,
  highlight,
  fitSignal,
  zoomSignal,
  centerSignal,
  onSelect,
  onOpen,
  onPathTarget,
  onNodeDrag,
  onNodeUnpin,
  onViewportReport,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewport, setViewport] = useState<GraphViewport>({ zoom: 1, px: 0, py: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const fittedEpochRef = useRef(-1);
  const lastClickRef = useRef<{ id: string; time: number }>({ id: "", time: 0 });

  // Cache the canvas size via ResizeObserver instead of reading layout each frame.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0 && box.height > 0) {
        setSize({ width: box.width, height: box.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onViewportReport?.(viewport.zoom);
  }, [viewport.zoom, onViewportReport]);

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

  const fitView = useCallback(() => {
    if (!positions || positions.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < positions.length; i += 2) {
      if (positions[i] < minX) minX = positions[i];
      if (positions[i] > maxX) maxX = positions[i];
      if (positions[i + 1] < minY) minY = positions[i + 1];
      if (positions[i + 1] > maxY) maxY = positions[i + 1];
    }
    const bw = Math.max(maxX - minX, 1) + 120;
    const bh = Math.max(maxY - minY, 1) + 120;
    const zoom = clamp(Math.min(size.width / bw, size.height / bh), MIN_ZOOM, MAX_ZOOM);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewport({ zoom, px: size.width / 2 - cx * zoom, py: size.height / 2 - cy * zoom });
  }, [positions, size]);

  // Fit once per layout epoch, on the first frame that has positions.
  useEffect(() => {
    if (!positions || positions.length === 0) return;
    if (fittedEpochRef.current === layoutEpoch) return;
    fittedEpochRef.current = layoutEpoch;
    fitView();
  }, [positions, layoutEpoch, fitView]);

  // Toolbar "fit" button.
  useEffect(() => {
    if (fitSignal > 0) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  // Toolbar zoom buttons: zoom around the canvas center.
  useEffect(() => {
    if (!zoomSignal) return;
    setViewport((current) => {
      const factor = zoomSignal.dir === 1 ? 1.25 : 0.8;
      const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const cx = (size.width / 2 - current.px) / current.zoom;
      const cy = (size.height / 2 - current.py) / current.zoom;
      return { zoom, px: size.width / 2 - cx * zoom, py: size.height / 2 - cy * zoom };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomSignal]);

  // Pan to center a node when an insight row is clicked (keeps current zoom).
  useEffect(() => {
    if (!centerSignal || !positions) return;
    const i = indexById.get(centerSignal.id);
    if (i == null) return;
    const cx = positions[i * 2];
    const cy = positions[i * 2 + 1];
    setViewport((current) => ({
      ...current,
      px: size.width / 2 - cx * current.zoom,
      py: size.height / 2 - cy * current.zoom,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerSignal]);

  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; origin: GraphViewport }
    | { kind: "drag"; nodeIndex: number; startX: number; startY: number; moved: boolean }
    | null
  >(null);

  const screenPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current!.getBoundingClientRect();
      return {
        x: (clientX - rect.left - viewport.px) / viewport.zoom,
        y: (clientY - rect.top - viewport.py) / viewport.zoom,
      };
    },
    [viewport],
  );

  // Wheel: raw scroll pans; ctrl/meta zooms at the cursor (diagram convention —
  // avoids trackpad scroll being read as zoom).
  const handleWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (event.ctrlKey || event.metaKey) {
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const factor = Math.pow(1.0015, -event.deltaY);
      setViewport((current) => {
        const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const cx = (sx - current.px) / current.zoom;
        const cy = (sy - current.py) / current.zoom;
        return { zoom, px: sx - cx * zoom, py: sy - cy * zoom };
      });
    } else {
      setViewport((current) => ({
        ...current,
        px: current.px - event.deltaX,
        py: current.py - event.deltaY,
      }));
    }
  }, []);

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
        const point = screenPoint(event.clientX, event.clientY);
        onNodeDrag(index, "start", point.x, point.y);
      } else {
        gesture.current = { kind: "pan", startX: event.clientX, startY: event.clientY, origin: viewport };
      }
      (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    },
    [onNodeDrag, screenPoint, viewport],
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
        if (Math.abs(event.clientX - active.startX) > 3 || Math.abs(event.clientY - active.startY) > 3) {
          active.moved = true;
        }
        const point = screenPoint(event.clientX, event.clientY);
        onNodeDrag(active.nodeIndex, "move", point.x, point.y);
      }
    },
    [onNodeDrag, screenPoint],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const active = gesture.current;
      gesture.current = null;
      if (!active) return;
      if (active.kind === "pan") {
        // A background press without movement clears the selection.
        if (Math.abs(event.clientX - active.startX) < 3 && Math.abs(event.clientY - active.startY) < 3) {
          onSelect(null);
        }
        return;
      }
      const point = screenPoint(event.clientX, event.clientY);
      onNodeDrag(active.nodeIndex, "end", point.x, point.y);
      if (active.moved) return; // a drag, not a click
      const node = nodes[active.nodeIndex];
      if (!node) return;
      // Pointer capture swallows the native click/dblclick, so resolve the
      // gesture here: alt = unpin, shift = path target, quick repeat = open.
      if (event.altKey) {
        onNodeUnpin(active.nodeIndex);
        return;
      }
      if (event.shiftKey) {
        onPathTarget(node);
        return;
      }
      const now = event.timeStamp;
      const last = lastClickRef.current;
      if (last.id === node.id && now - last.time < 350) {
        lastClickRef.current = { id: "", time: 0 };
        onOpen(node);
      } else {
        lastClickRef.current = { id: node.id, time: now };
        onSelect(node);
      }
    },
    [nodes, onNodeDrag, onNodeUnpin, onOpen, onPathTarget, onSelect, screenPoint],
  );

  // Highlight overlay → sets consulted per node/edge for dimming.
  const { highlightNodes, highlightEdgeKeys, pairEndpoints } = useMemo(() => {
    if (!highlight) {
      return { highlightNodes: null as Set<string> | null, highlightEdgeKeys: null as Set<string> | null, pairEndpoints: null as [string, string] | null };
    }
    if (highlight.kind === "pair") {
      return {
        highlightNodes: new Set([highlight.a, highlight.b]),
        highlightEdgeKeys: null,
        pairEndpoints: [highlight.a, highlight.b] as [string, string],
      };
    }
    const nodeSet = new Set(highlight.ids);
    const edgeSet = new Set<string>();
    for (let i = 0; i + 1 < highlight.ids.length; i += 1) {
      const a = highlight.ids[i];
      const b = highlight.ids[i + 1];
      edgeSet.add(a < b ? `${a} ${b}` : `${b} ${a}`);
    }
    return { highlightNodes: nodeSet, highlightEdgeKeys: edgeSet, pairEndpoints: null };
  }, [highlight]);

  const hoverNeighbors = hoveredId ? (adjacency.get(hoveredId) ?? new Set<string>()) : null;
  const showLabels = viewport.zoom > LABEL_ZOOM_THRESHOLD;

  const onEnter = useCallback((id: string) => setHoveredId(id), []);
  const onLeave = useCallback(() => setHoveredId(null), []);

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
      <g transform={`translate(${viewport.px}, ${viewport.py}) scale(${viewport.zoom})`}>
        <g className="graph-edges">
          {edges.map((edge, i) => {
            const si = indexById.get(edge.source);
            const ti = indexById.get(edge.target);
            if (si == null || ti == null) return null;
            const key = edge.source < edge.target
              ? `${edge.source} ${edge.target}`
              : `${edge.target} ${edge.source}`;
            let cls = "graph-edge" + (edge.fromFrontmatter ? " frontmatter" : " wikilink");
            if (highlightEdgeKeys) {
              cls += highlightEdgeKeys.has(key) ? " path" : " dimmed";
            } else if (highlightNodes) {
              cls += " dimmed";
            } else if (hoveredId != null && edge.source !== hoveredId && edge.target !== hoveredId) {
              cls += " dimmed";
            }
            const isSupersedes = edge.relation === "supersedes" || edge.relation === "superseded_by";
            return (
              <EdgeView
                key={i}
                x1={positions[si * 2]}
                y1={positions[si * 2 + 1]}
                x2={positions[ti * 2]}
                y2={positions[ti * 2 + 1]}
                className={cls}
                marker={isSupersedes}
              />
            );
          })}
          {pairEndpoints && indexById.has(pairEndpoints[0]) && indexById.has(pairEndpoints[1]) ? (
            <line
              className="graph-edge suggested"
              x1={positions[indexById.get(pairEndpoints[0])! * 2]}
              y1={positions[indexById.get(pairEndpoints[0])! * 2 + 1]}
              x2={positions[indexById.get(pairEndpoints[1])! * 2]}
              y2={positions[indexById.get(pairEndpoints[1])! * 2 + 1]}
            />
          ) : null}
        </g>
        <g className="graph-nodes">
          {nodes.map((node, i) => {
            const x = positions[i * 2];
            const y = positions[i * 2 + 1];
            const isHover = node.id === hoveredId;
            const isNeighbor = hoverNeighbors?.has(node.id) ?? false;
            const inHighlight = highlightNodes?.has(node.id) ?? false;
            let dimmed = false;
            if (highlightNodes) dimmed = !inHighlight;
            else if (hoveredId != null) dimmed = !isHover && !isNeighbor;
            const cls =
              "graph-node" +
              (node.type === "unresolved" ? " ghost" : "") +
              (node.isGodNode ? " god" : "") +
              (node.id === focusNodeId ? " focus" : "") +
              (node.id === selectedId ? " selected" : "") +
              (node.id === pathSourceId ? " path-source" : "") +
              (inHighlight ? " highlight" : "") +
              (dimmed ? " dimmed" : "");
            const showLabel =
              showLabels || isHover || node.id === selectedId || node.id === focusNodeId || inHighlight || node.isGodNode;
            return (
              <NodeView
                key={node.id}
                index={i}
                id={node.id}
                x={x}
                y={y}
                r={nodeRadius(node.degree)}
                fill={nodeColor(node, enriched)}
                className={cls}
                label={node.label}
                showLabel={showLabel}
                onEnter={onEnter}
                onLeave={onLeave}
              />
            );
          })}
        </g>
      </g>
    </svg>
  );
}
