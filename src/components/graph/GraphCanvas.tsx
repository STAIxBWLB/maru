// SVG force-graph canvas (maru-vault-graph-spec §F2). Rendering only — layout
// runs in layout.worker.ts. This owns viewport (zoom/pan), hover highlight,
// and the select / double-click-open / drag-pin / path-target interactions.
//
// Perf: React owns *structure* (which nodes/edges/classes exist); the DOM owns
// *geometry*. Node transforms and edge endpoints are written imperatively via
// setAttribute (writeFrame) straight from worker frames, so simulation ticks,
// drags, pan/zoom and hover never trigger React reconciliation of the ~2.4k
// child elements. NodeView/EdgeView carry no coordinates, so their memo is
// near-perfect; the once-per-settle render reconciles almost nothing.
// ponytail: imperative geometry lifts the practical SVG ceiling well past the
// ~383-node vault; a Canvas/WebGL renderer stays the escape hatch above ~3-5k
// nodes (switching would forfeit CSS tokens, free hit-testing, and these
// e2e selectors — not worth it at this scale).

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
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
// Coordinates are written imperatively (see writeFrame), never via props, so
// these reconcile only when class/label/fill actually change.

const EdgeView = memo(function EdgeView({
  className, marker,
}: {
  className: string;
  marker: boolean;
}) {
  return (
    <line className={className} markerEnd={marker ? "url(#graph-arrow)" : undefined} />
  );
});

const NodeView = memo(function NodeView({
  index, id, r, fill, className, label, favorite,
}: {
  index: number;
  id: string;
  r: number;
  fill: string;
  className: string;
  label: string;
  favorite: boolean;
}) {
  return (
    <g className={className}>
      <circle r={r} data-node-index={index} data-node-id={id} fill={fill} />
      {favorite ? (
        <text className="graph-node-star" dy={-(r + 4)}>
          ★
        </text>
      ) : null}
      {/* Always mounted; visibility is CSS-toggled (label LOD + state) so
          zoom/hover threshold crossings need zero reconciliation. */}
      <text className="graph-node-label" dy={r + 12}>
        {label}
      </text>
    </g>
  );
});

// --- canvas --------------------------------------------------------------

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Latest positions (flat x,y interleaved), index-aligned with `nodes`.
   *  Owned by GraphView; read here for fit/center and structural placement. */
  positionsRef: RefObject<Float64Array | null>;
  /** GraphView populates this with the canvas's per-frame DOM writer so worker
   *  frames bypass React. */
  applyFrameRef: RefObject<((p: Float64Array) => void) | null>;
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
  onNodeContextMenu?: (node: GraphNode, index: number, x: number, y: number) => void;
  /** Node ids currently favorited — rendered with a ★ marker. */
  favoriteIds?: Set<string>;
  onViewportReport?: (zoom: number) => void;
}

export function GraphCanvas({
  nodes,
  edges,
  positionsRef,
  applyFrameRef,
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
  onNodeContextMenu,
  favoriteIds,
  onViewportReport,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodesGroupRef = useRef<SVGGElement | null>(null);
  const edgesGroupRef = useRef<SVGGElement | null>(null);
  const pairLineRef = useRef<SVGLineElement | null>(null);
  // Element caches — rebuilt on structural change; DOM order == node/edge order.
  const nodeEls = useRef<SVGGElement[]>([]);
  const edgeEls = useRef<SVGLineElement[]>([]);
  // id → last written position; lets a structural change keep surviving nodes
  // in place instead of flashing to the origin before the next frame arrives.
  const lastPos = useRef<Map<string, [number, number]>>(new Map());
  // Previous nodes array identity — positionsRef is index-aligned only while it
  // is unchanged, so a same-cardinality filter swap must not write the stale
  // frame by index.
  const prevNodesRef = useRef<GraphNode[] | null>(null);

  const [viewport, setViewport] = useState<GraphViewport>({ zoom: 1, px: 0, py: 0 });
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [ready, setReady] = useState(false);
  const fittedEpochRef = useRef(-1);
  const lastClickRef = useRef<{ id: string; time: number }>({ id: "", time: 0 });

  // rAF coalescing for the worker frame stream.
  const rafRef = useRef(0);
  const pendingRef = useRef<Float64Array | null>(null);
  const writeFrameRef = useRef<((p: Float64Array) => void) | null>(null);

  // Imperative hover bookkeeping — never touches React state, so hovering
  // across the graph reconciles nothing.
  const hoverIdRef = useRef<string | null>(null);
  const hoverElsRef = useRef<Element[]>([]);
  const applyHoverRef = useRef<((id: string | null) => void) | null>(null);

  // Cache the canvas size via ResizeObserver instead of reading layout each
  // frame. The <svg> is always mounted (loading is an overlay), so this
  // attaches on the first commit.
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

  // Edges with both endpoints resolved, in render/DOM order — keeps edgeEls
  // index-aligned with the <line> children even if one is defensively dropped.
  const drawnEdges = useMemo(() => {
    const out: { si: number; ti: number; edge: GraphEdge }[] = [];
    for (const edge of edges) {
      const si = indexById.get(edge.source);
      const ti = indexById.get(edge.target);
      if (si != null && ti != null) out.push({ si, ti, edge });
    }
    return out;
  }, [edges, indexById]);

  // node id → indices into drawnEdges (incident edges), for hover highlight.
  const incidentEdges = useMemo(() => {
    const map = new Map<string, number[]>();
    drawnEdges.forEach((d, j) => {
      let a = map.get(d.edge.source);
      if (!a) map.set(d.edge.source, (a = []));
      a.push(j);
      let b = map.get(d.edge.target);
      if (!b) map.set(d.edge.target, (b = []));
      b.push(j);
    });
    return map;
  }, [drawnEdges]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of edges) {
      let s = map.get(edge.source);
      if (!s) map.set(edge.source, (s = new Set()));
      s.add(edge.target);
      let t = map.get(edge.target);
      if (!t) map.set(edge.target, (t = new Set()));
      t.add(edge.source);
    }
    return map;
  }, [edges]);

  // Highlight overlay → sets consulted per node/edge for dimming (React path).
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
      edgeSet.add(a < b ? `${a} ${b}` : `${b} ${a}`);
    }
    return { highlightNodes: nodeSet, highlightEdgeKeys: edgeSet, pairEndpoints: null };
  }, [highlight]);

  const showLabels = viewport.zoom > LABEL_ZOOM_THRESHOLD;

  const fitView = useCallback(
    (p?: Float64Array | null) => {
      const pos = p ?? positionsRef.current;
      if (!pos || pos.length === 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < pos.length; i += 2) {
        if (pos[i] < minX) minX = pos[i];
        if (pos[i] > maxX) maxX = pos[i];
        if (pos[i + 1] < minY) minY = pos[i + 1];
        if (pos[i + 1] > maxY) maxY = pos[i + 1];
      }
      const bw = Math.max(maxX - minX, 1) + 120;
      const bh = Math.max(maxY - minY, 1) + 120;
      const zoom = clamp(Math.min(size.width / bw, size.height / bh), MIN_ZOOM, MAX_ZOOM);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      setViewport({ zoom, px: size.width / 2 - cx * zoom, py: size.height / 2 - cy * zoom });
    },
    [positionsRef, size],
  );

  // Write geometry straight to the DOM from a positions frame. Called from the
  // rAF stream and from the structural commit hook.
  const writeFrame = useCallback(
    (p: Float64Array) => {
      // Stale-epoch guard: a frame whose length doesn't match the mounted node
      // set is from a superseded layout; the next matching frame corrects it.
      if (p.length !== nodes.length * 2) return;
      const nEls = nodeEls.current;
      for (let i = 0; i < nEls.length; i += 1) {
        const x = p[i * 2];
        const y = p[i * 2 + 1];
        nEls[i].setAttribute("transform", `translate(${x}, ${y})`);
        lastPos.current.set(nodes[i].id, [x, y]);
      }
      const eEls = edgeEls.current;
      for (let j = 0; j < drawnEdges.length; j += 1) {
        const el = eEls[j];
        if (!el) continue;
        const { si, ti } = drawnEdges[j];
        el.setAttribute("x1", String(p[si * 2]));
        el.setAttribute("y1", String(p[si * 2 + 1]));
        el.setAttribute("x2", String(p[ti * 2]));
        el.setAttribute("y2", String(p[ti * 2 + 1]));
      }
      if (pairLineRef.current && pairEndpoints) {
        const a = indexById.get(pairEndpoints[0]);
        const b = indexById.get(pairEndpoints[1]);
        if (a != null && b != null) {
          pairLineRef.current.setAttribute("x1", String(p[a * 2]));
          pairLineRef.current.setAttribute("y1", String(p[a * 2 + 1]));
          pairLineRef.current.setAttribute("x2", String(p[b * 2]));
          pairLineRef.current.setAttribute("y2", String(p[b * 2 + 1]));
        }
      }
      if (!ready) setReady(true);
      if (fittedEpochRef.current !== layoutEpoch) {
        fittedEpochRef.current = layoutEpoch;
        fitView(p);
      }
    },
    [nodes, drawnEdges, pairEndpoints, indexById, ready, layoutEpoch, fitView],
  );

  // Structural fallback: no fresh frame yet (e.g. just after a filter change).
  // Place surviving nodes at their last-known position; brand-new nodes stay at
  // the origin for the ~120ms until the worker's warm-started frame arrives.
  const placeFromLastKnown = useCallback(() => {
    const nEls = nodeEls.current;
    for (let i = 0; i < nEls.length; i += 1) {
      const prev = lastPos.current.get(nodes[i].id);
      if (prev) nEls[i].setAttribute("transform", `translate(${prev[0]}, ${prev[1]})`);
    }
    const eEls = edgeEls.current;
    for (let j = 0; j < drawnEdges.length; j += 1) {
      const el = eEls[j];
      if (!el) continue;
      const a = lastPos.current.get(drawnEdges[j].edge.source);
      const b = lastPos.current.get(drawnEdges[j].edge.target);
      if (a) { el.setAttribute("x1", String(a[0])); el.setAttribute("y1", String(a[1])); }
      if (b) { el.setAttribute("x2", String(b[0])); el.setAttribute("y2", String(b[1])); }
    }
  }, [nodes, drawnEdges]);

  // O(neighbors) hover: toggle a container class for the all-but-neighbors dim
  // (one CSS style recalc), and add per-element classes only to the hovered
  // node + its neighbors + incident edges. No React reconciliation.
  const applyHover = useCallback(
    (id: string | null) => {
      for (const el of hoverElsRef.current) el.classList.remove("hl", "hovered");
      hoverElsRef.current = [];
      hoverIdRef.current = id;
      // Inert while a pair/path overlay owns the dimming (parity with V2).
      const active = id != null && !highlight && indexById.has(id);
      svgRef.current?.classList.toggle("has-hover", active);
      if (!active) return;
      const i = indexById.get(id!);
      if (i == null) return;
      const els: Element[] = [];
      const hovered = nodeEls.current[i];
      if (hovered) { hovered.classList.add("hovered"); els.push(hovered); }
      for (const neighborId of adjacency.get(id!) ?? []) {
        const ni = indexById.get(neighborId);
        const el = ni != null ? nodeEls.current[ni] : undefined;
        if (el) { el.classList.add("hl"); els.push(el); }
      }
      for (const j of incidentEdges.get(id!) ?? []) {
        const el = edgeEls.current[j];
        if (el) { el.classList.add("hl"); els.push(el); }
      }
      hoverElsRef.current = els;
    },
    [highlight, indexById, adjacency, incidentEdges],
  );

  // Keep the imperative closures fresh for the rAF stream and structural hook.
  useLayoutEffect(() => {
    writeFrameRef.current = writeFrame;
    applyHoverRef.current = applyHover;
  });

  // Structural commit: rebuild element caches (DOM changed), then re-place
  // geometry and re-assert hover classes React may have dropped.
  useLayoutEffect(() => {
    nodeEls.current = Array.from(nodesGroupRef.current?.children ?? []) as SVGGElement[];
    edgeEls.current = Array.from(edgesGroupRef.current?.children ?? []) as SVGLineElement[];
    const p = positionsRef.current;
    // positionsRef is index-aligned only while node identity is unchanged; a
    // same-cardinality filter swap leaves it stale, so fall back to the id-keyed
    // placeFromLastKnown until the worker's frame for the new set arrives.
    const aligned = prevNodesRef.current === nodes;
    prevNodesRef.current = nodes;
    if (aligned && p && p.length === nodes.length * 2) writeFrameRef.current?.(p);
    else placeFromLastKnown();
    applyHoverRef.current?.(hoverIdRef.current);
  }, [nodes, drawnEdges, pairEndpoints, placeFromLastKnown, positionsRef]);

  // React rewrites a node's class attribute when its computed cls changes
  // (select / focus / path-source / highlight), silently dropping the
  // imperatively-added .hovered/.hl while .has-hover still dims the rest — and a
  // path overlay (pairEndpoints stays null) never re-runs the structural effect.
  // Re-assert hover on exactly those triggers; applyHover recomputes its `active`
  // guard against the fresh `highlight`, so it also clears .has-hover under an
  // overlay. Keyed narrowly (not every commit) so pan/zoom stays untouched.
  useLayoutEffect(() => {
    applyHoverRef.current?.(hoverIdRef.current);
  }, [selectedId, focusNodeId, pathSourceId, highlight]);

  // Subscribe the worker frame stream to a rAF-coalesced DOM write.
  useEffect(() => {
    const ref = applyFrameRef;
    ref.current = (p: Float64Array) => {
      pendingRef.current = p;
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const frame = pendingRef.current;
        pendingRef.current = null;
        if (frame) writeFrameRef.current?.(frame);
      });
    };
    return () => {
      ref.current = null;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [applyFrameRef]);

  // Fit once per layout epoch is handled inside writeFrame; the toolbar "fit"
  // button and keyboard 0 drive an explicit refit.
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
    if (!centerSignal) return;
    const p = positionsRef.current;
    if (!p) return;
    const i = indexById.get(centerSignal.id);
    if (i == null || i * 2 + 1 >= p.length) return;
    const cx = p[i * 2];
    const cy = p[i * 2 + 1];
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
      // Only the primary button pans/drags; right-click is reserved for the
      // context menu (onContextMenu), so it must not start a gesture.
      if (event.button !== 0) return;
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

  // Delegated hover: one listener on the <svg> instead of 2×N per-circle
  // handlers. pointerover bubbles up carrying the entered element as target.
  const handlePointerOver = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (gesture.current) return; // don't fight an active pan/drag
    const id = (event.target as SVGElement).getAttribute("data-node-id");
    if (id === hoverIdRef.current) return;
    applyHoverRef.current?.(id);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (hoverIdRef.current != null) applyHoverRef.current?.(null);
  }, []);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const attr = (event.target as SVGElement).getAttribute("data-node-index");
      if (attr == null) return; // let the browser menu show over empty canvas
      event.preventDefault();
      const index = Number(attr);
      const node = nodes[index];
      if (node) onNodeContextMenu?.(node, index, event.clientX, event.clientY);
    },
    [nodes, onNodeContextMenu],
  );

  // Memoize the child subtrees on their viewport-invariant deps so a pan/zoom
  // (viewport-only render) reuses the same element arrays and React bails the
  // ~2.4k-element subtree — only the outer <g transform> updates.
  const edgeChildren = useMemo(
    () =>
      drawnEdges.map(({ edge }) => {
        const key = edge.source < edge.target
          ? `${edge.source} ${edge.target}`
          : `${edge.target} ${edge.source}`;
        let cls = "graph-edge" + (edge.fromFrontmatter ? " frontmatter" : " wikilink");
        if (highlightEdgeKeys) {
          cls += highlightEdgeKeys.has(key) ? " path" : " dimmed";
        } else if (highlightNodes) {
          cls += " dimmed";
        }
        const isSupersedes = edge.relation === "supersedes" || edge.relation === "superseded_by";
        return (
          <EdgeView
            key={`${edge.source} ${edge.target} ${edge.relation}`}
            className={cls}
            marker={isSupersedes}
          />
        );
      }),
    [drawnEdges, highlightEdgeKeys, highlightNodes],
  );

  const nodeChildren = useMemo(
    () =>
      nodes.map((node, i) => {
        const inHighlight = highlightNodes?.has(node.id) ?? false;
        const dimmed = highlightNodes ? !inHighlight : false;
        const cls =
          "graph-node" +
          (node.type === "unresolved" ? " ghost" : "") +
          (node.isGodNode ? " god" : "") +
          (node.id === focusNodeId ? " focus" : "") +
          (node.id === selectedId ? " selected" : "") +
          (node.id === pathSourceId ? " path-source" : "") +
          (inHighlight ? " highlight" : "") +
          (dimmed ? " dimmed" : "");
        return (
          <NodeView
            key={node.id}
            index={i}
            id={node.id}
            r={nodeRadius(node.degree)}
            fill={nodeColor(node, enriched)}
            className={cls}
            label={node.label}
            favorite={favoriteIds?.has(node.id) ?? false}
          />
        );
      }),
    [nodes, highlightNodes, focusNodeId, selectedId, pathSourceId, enriched, favoriteIds],
  );

  return (
    <div className="graph-canvas-wrap">
      <svg
        ref={svgRef}
        className="graph-canvas"
        data-testid="graph-canvas"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerOver={handlePointerOver}
        onPointerLeave={handlePointerLeave}
        onContextMenu={handleContextMenu}
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
          <g className="graph-edges" ref={edgesGroupRef}>
            {edgeChildren}
          </g>
          {pairEndpoints ? (
            <line ref={pairLineRef} className="graph-edge suggested" />
          ) : null}
          <g className={"graph-nodes" + (showLabels ? " labels-on" : "")} ref={nodesGroupRef}>
            {nodeChildren}
          </g>
        </g>
      </svg>
      {!ready ? (
        <div className="graph-canvas-loading" data-testid="graph-canvas-loading">
          …
        </div>
      ) : null}
    </div>
  );
}
