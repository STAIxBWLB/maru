import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";

import {
  addEdge,
  defaultCoalescer,
  moveNodes,
  setSelection,
  setViewport,
  withSnapshot,
} from "../../../lib/diagram/actions";
import { defaultEdge } from "../../../lib/diagram/edgeRouting";
import {
  clamp,
  rectsIntersect,
  screenToCanvas,
  snap,
  type Rect,
} from "../../../lib/diagram/geometry";
import { visibleSubset } from "../../../lib/diagram/viewportCulling";
import type { Coalescer } from "../../../lib/diagram/history";
import {
  computeSmartGuides,
  type GuideLine,
} from "../../../lib/diagram/smartGuides";
import type {
  DiagramNode,
  EdgePort,
  NodeId,
} from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";
import {
  useDiagram,
  useDiagramStore,
} from "../DiagramStoreContext";
import { EdgeMarkers } from "./EdgeMarkers";
import { EdgeView } from "./EdgeView";
import { Marquee } from "./Marquee";
import { NodeView } from "./NodeView";
import { SmartGuides } from "./SmartGuides";

interface DragState {
  kind: "node";
  startCanvasX: number;
  startCanvasY: number;
  lastDx: number;
  lastDy: number;
  ids: NodeId[];
  /** Original positions of dragged nodes, keyed by id. */
  origins: Map<NodeId, { x: number; y: number; w: number; h: number }>;
  coalescer: Coalescer;
}

interface PanState {
  kind: "pan";
  startScreenX: number;
  startScreenY: number;
  startPx: number;
  startPy: number;
}

interface MarqueeState {
  kind: "marquee";
  startCanvasX: number;
  startCanvasY: number;
  currentCanvasX: number;
  currentCanvasY: number;
  additive: boolean;
}

interface ConnectState {
  kind: "connect";
  fromNodeId: NodeId;
  fromPort: EdgePort;
  startCanvasX: number;
  startCanvasY: number;
  pointerCanvasX: number;
  pointerCanvasY: number;
}

type Gesture = DragState | PanState | MarqueeState | ConnectState | null;

export interface CanvasSurfaceProps {
  onMemoOpen?: (nodeId: NodeId) => void;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const SMART_GUIDE_THRESHOLD_PX = 6;

function marqueeRect(g: MarqueeState): Rect {
  const x = Math.min(g.startCanvasX, g.currentCanvasX);
  const y = Math.min(g.startCanvasY, g.currentCanvasY);
  return {
    x,
    y,
    w: Math.abs(g.currentCanvasX - g.startCanvasX),
    h: Math.abs(g.currentCanvasY - g.startCanvasY),
  };
}

function nodesInsideRect(nodes: DiagramNode[], rect: Rect): NodeId[] {
  const out: NodeId[] = [];
  for (const n of nodes) {
    if (rectsIntersect({ x: n.x, y: n.y, w: n.w, h: n.h }, rect)) {
      out.push(n.id);
    }
  }
  return out;
}

function findPortTarget(event: PointerEvent<SVGSVGElement>): {
  nodeId: NodeId;
  port: EdgePort;
} | null {
  const el = document.elementFromPoint(event.clientX, event.clientY);
  if (!el) return null;
  const port = el.getAttribute("data-port") as EdgePort | null;
  const nodeId = el.getAttribute("data-node-id");
  if (port && nodeId) return { nodeId, port };
  // Fall back to nearest ancestor node if dropped on body.
  const parent = el.closest("[data-node-id]");
  if (!parent) return null;
  return null; // Body-drop without explicit port — skip for Phase 2.
}

export function CanvasSurface({ onMemoOpen }: CanvasSurfaceProps = {}) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gestureRef = useRef<Gesture>(null);

  const nodes = useDiagram((s) => s.doc.nodes);
  const edges = useDiagram((s) => s.doc.edges);
  const viewport = useDiagram((s) => s.ephemeral.viewport);
  const selection = useDiagram((s) => s.ephemeral.selection);
  const snapOn = useDiagram((s) => s.ephemeral.ui.snapOn);
  const snapSize = useDiagram((s) => s.ephemeral.ui.snapSize);
  const smartGuideOn = useDiagram((s) => s.ephemeral.ui.smartGuideOn);
  const tool = useDiagram((s) => s.ephemeral.tool);

  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [guides, setGuides] = useState<GuideLine[]>([]);
  const [connectGhost, setConnectGhost] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<NodeId | null>(null);
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });

  // Track our own size for culling. `ResizeObserver` avoids re-measuring on
  // every render and stays accurate when the user toggles side panels.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSvgSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const nodeById = useMemo(() => {
    const map = new Map<NodeId, DiagramNode>();
    for (const n of nodes) map.set(n.id, n);
    return map;
  }, [nodes]);

  // Culling: pick only the visible subset of nodes + edges. Selection is
  // forced-visible so an off-screen drag target doesn't disappear mid-gesture.
  // Skip when we haven't measured yet (avoid culling everything on first paint).
  const visible = useMemo(() => {
    if (svgSize.width === 0 || svgSize.height === 0) {
      return { nodes, edges, full: true };
    }
    const tl = screenToCanvas(0, 0, viewport);
    const br = screenToCanvas(svgSize.width, svgSize.height, viewport);
    return visibleSubset({
      nodes,
      edges,
      viewport: { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y },
      forceVisible: selection.nodes,
    });
  }, [edges, nodes, selection.nodes, svgSize.height, svgSize.width, viewport]);

  const transform = `translate(${viewport.px}, ${viewport.py}) scale(${viewport.zoom})`;

  const updateViewport = useCallback(
    (next: { zoom: number; px: number; py: number }) => store.setState(setViewport(next)),
    [store],
  );

  const beginNodeDrag = useCallback(
    (event: PointerEvent<SVGGElement>, nodeId: NodeId) => {
      event.stopPropagation();
      const svg = svgRef.current;
      if (!svg) return;
      svg.setPointerCapture(event.pointerId);
      const rect = svg.getBoundingClientRect();
      const canvas = screenToCanvas(event.clientX - rect.left, event.clientY - rect.top, viewport);
      const state = store.getState();
      const activeNode = state.doc.nodes.find((node) => node.id === nodeId);
      if (activeNode?.locked) return;
      const currentSelection = state.ephemeral.selection.nodes;
      const ids = currentSelection.has(nodeId)
        ? [...currentSelection].filter((id) => !nodeById.get(id)?.locked)
        : (() => {
            store.setState(setSelection([nodeId]));
            return [nodeId];
          })();
      if (ids.length === 0) return;
      const origins = new Map<NodeId, { x: number; y: number; w: number; h: number }>();
      for (const id of ids) {
        const n = nodeById.get(id);
        if (n) origins.set(id, { x: n.x, y: n.y, w: n.w, h: n.h });
      }
      gestureRef.current = {
        kind: "node",
        startCanvasX: canvas.x,
        startCanvasY: canvas.y,
        lastDx: 0,
        lastDy: 0,
        ids,
        origins,
        coalescer: defaultCoalescer(),
      };
    },
    [nodeById, store, viewport],
  );

  const beginConnect = useCallback(
    (event: PointerEvent<SVGCircleElement>, nodeId: NodeId, port: EdgePort) => {
      const svg = svgRef.current;
      if (!svg) return;
      svg.setPointerCapture(event.pointerId);
      const rect = svg.getBoundingClientRect();
      const canvas = screenToCanvas(event.clientX - rect.left, event.clientY - rect.top, viewport);
      const node = nodeById.get(nodeId);
      if (!node) return;
      const startCanvas = {
        x: port === "e" ? node.x + node.w : port === "w" ? node.x : node.x + node.w / 2,
        y: port === "s" ? node.y + node.h : port === "n" ? node.y : node.y + node.h / 2,
      };
      gestureRef.current = {
        kind: "connect",
        fromNodeId: nodeId,
        fromPort: port,
        startCanvasX: startCanvas.x,
        startCanvasY: startCanvas.y,
        pointerCanvasX: canvas.x,
        pointerCanvasY: canvas.y,
      };
      setConnectGhost({
        x1: startCanvas.x,
        y1: startCanvas.y,
        x2: canvas.x,
        y2: canvas.y,
      });
    },
    [nodeById, viewport],
  );

  const onEdgeSelect = useCallback(
    (event: PointerEvent<SVGGElement>, edgeId: string) => {
      event.stopPropagation();
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const state = store.getState();
      if (additive) {
        const next = new Set(state.ephemeral.selection.edges);
        if (next.has(edgeId)) next.delete(edgeId);
        else next.add(edgeId);
        store.setState((s) => ({
          ...s,
          ephemeral: {
            ...s.ephemeral,
            selection: { nodes: s.ephemeral.selection.nodes, edges: next },
          },
        }));
      } else {
        store.setState(setSelection([], [edgeId]));
      }
    },
    [store],
  );

  const onSurfacePointerDown = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      const svg = svgRef.current;
      if (!svg) return;
      svg.setPointerCapture(event.pointerId);
      const rect = svg.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      if (event.shiftKey || tool === "pan") {
        gestureRef.current = {
          kind: "pan",
          startScreenX: screenX,
          startScreenY: screenY,
          startPx: viewport.px,
          startPy: viewport.py,
        };
        return;
      }

      const canvas = screenToCanvas(screenX, screenY, viewport);
      gestureRef.current = {
        kind: "marquee",
        startCanvasX: canvas.x,
        startCanvasY: canvas.y,
        currentCanvasX: canvas.x,
        currentCanvasY: canvas.y,
        additive: event.metaKey || event.ctrlKey,
      };
      setMarquee({ x: canvas.x, y: canvas.y, w: 0, h: 0 });

      if (!event.metaKey && !event.ctrlKey) {
        store.setState(setSelection([], []));
      }
    },
    [store, tool, viewport],
  );

  const onSurfacePointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      if (gesture.kind === "pan") {
        updateViewport({
          zoom: viewport.zoom,
          px: gesture.startPx + (screenX - gesture.startScreenX),
          py: gesture.startPy + (screenY - gesture.startScreenY),
        });
        return;
      }

      if (gesture.kind === "marquee") {
        const canvas = screenToCanvas(screenX, screenY, viewport);
        gesture.currentCanvasX = canvas.x;
        gesture.currentCanvasY = canvas.y;
        setMarquee(marqueeRect(gesture));
        return;
      }

      if (gesture.kind === "connect") {
        const canvas = screenToCanvas(screenX, screenY, viewport);
        gesture.pointerCanvasX = canvas.x;
        gesture.pointerCanvasY = canvas.y;
        setConnectGhost({
          x1: gesture.startCanvasX,
          y1: gesture.startCanvasY,
          x2: canvas.x,
          y2: canvas.y,
        });
        return;
      }

      if (gesture.kind === "node") {
        const canvas = screenToCanvas(screenX, screenY, viewport);
        let proposedDx = canvas.x - gesture.startCanvasX;
        let proposedDy = canvas.y - gesture.startCanvasY;
        if (snapOn) {
          proposedDx = snap(proposedDx, snapSize);
          proposedDy = snap(proposedDy, snapSize);
        }

        // Smart-guide snap relative to the first dragged node's origin.
        let smartGuideOut: GuideLine[] = [];
        if (smartGuideOn) {
          const firstId = gesture.ids[0];
          const origin = firstId ? gesture.origins.get(firstId) : null;
          if (origin) {
            const movingRect: Rect = {
              x: origin.x + proposedDx,
              y: origin.y + proposedDy,
              w: origin.w,
              h: origin.h,
            };
            const stationary: Rect[] = nodes
              .filter((n) => !gesture.ids.includes(n.id))
              .map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
            const result = computeSmartGuides({
              movingRect,
              stationary,
              threshold: SMART_GUIDE_THRESHOLD_PX / viewport.zoom,
            });
            proposedDx += result.dx;
            proposedDy += result.dy;
            smartGuideOut = result.guides;
          }
        }

        const stepDx = proposedDx - gesture.lastDx;
        const stepDy = proposedDy - gesture.lastDy;
        if (stepDx === 0 && stepDy === 0) {
          setGuides(smartGuideOut);
          return;
        }
        gesture.lastDx = proposedDx;
        gesture.lastDy = proposedDy;
        store.setState(
          withSnapshot(moveNodes(gesture.ids, stepDx, stepDy), gesture.coalescer, {
            coalesce: true,
          }),
        );
        setGuides(smartGuideOut);
      }
    },
    [nodes, snapOn, snapSize, smartGuideOn, store, updateViewport, viewport],
  );

  const onSurfacePointerUp = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (svg && svg.hasPointerCapture(event.pointerId)) {
        svg.releasePointerCapture(event.pointerId);
      }
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (gesture.kind === "marquee") {
        const rect = marqueeRect(gesture);
        if (rect.w > 1 || rect.h > 1) {
          const hits = nodesInsideRect(store.getState().doc.nodes, rect);
          if (gesture.additive) {
            const existing = [...store.getState().ephemeral.selection.nodes];
            store.setState(setSelection([...new Set([...existing, ...hits])]));
          } else {
            store.setState(setSelection(hits));
          }
        }
        setMarquee(null);
      }
      if (gesture.kind === "node") {
        setGuides([]);
      }
      if (gesture.kind === "connect") {
        const target = findPortTarget(event);
        if (target && target.nodeId !== gesture.fromNodeId) {
          const id = `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          store.setState(
            withSnapshot(
              addEdge(
                defaultEdge(id, gesture.fromNodeId, gesture.fromPort, target.nodeId, target.port),
              ),
              defaultCoalescer(),
            ),
          );
        }
        setConnectGhost(null);
      }
      gestureRef.current = null;
    },
    [store],
  );

  const onWheel = useCallback(
    (event: WheelEvent<SVGSVGElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const canvasBefore = screenToCanvas(screenX, screenY, viewport);
      const factor = Math.pow(1.0015, -event.deltaY);
      const zoom = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const px = screenX - canvasBefore.x * zoom;
      const py = screenY - canvasBefore.y * zoom;
      updateViewport({ zoom, px, py });
    },
    [updateViewport, viewport],
  );

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        gestureRef.current = null;
        setMarquee(null);
        setGuides([]);
        setConnectGhost(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const onNodeEnter = useCallback((nodeId: NodeId) => setHoverNodeId(nodeId), []);
  const onNodeLeave = useCallback(() => setHoverNodeId(null), []);

  return (
    <svg
      ref={svgRef}
      className="maru-diagram-canvas"
      role="application"
      aria-label={t("diagram.aria.canvas")}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onSurfacePointerMove}
      onPointerUp={onSurfacePointerUp}
      onPointerCancel={onSurfacePointerUp}
      onWheel={onWheel}
    >
      <EdgeMarkers />
      <g transform={transform}>
        {visible.edges.map((edge) => (
          <EdgeView
            key={edge.id}
            edge={edge}
            fromNode={nodeById.get(edge.fromNode)}
            toNode={nodeById.get(edge.toNode)}
            selected={selection.edges.has(edge.id)}
            onSelect={onEdgeSelect}
          />
        ))}
        {visible.nodes.map((n) => (
          <g
            key={n.id}
            onPointerEnter={() => onNodeEnter(n.id)}
            onPointerLeave={onNodeLeave}
          >
            <NodeView
              node={n}
              selected={selection.nodes.has(n.id)}
              showPorts={hoverNodeId === n.id}
              pendingConnectActive={Boolean(connectGhost)}
              onPointerDown={beginNodeDrag}
              onPortPointerDown={beginConnect}
              onMemoOpen={onMemoOpen}
            />
          </g>
        ))}
        <SmartGuides guides={guides} />
        {connectGhost ? (
          <line
            x1={connectGhost.x1}
            y1={connectGhost.y1}
            x2={connectGhost.x2}
            y2={connectGhost.y2}
            stroke="#2563eb"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            pointerEvents="none"
          />
        ) : null}
        <Marquee rect={marquee} />
      </g>
    </svg>
  );
}
