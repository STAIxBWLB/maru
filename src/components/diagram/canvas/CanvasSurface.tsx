import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";

import {
  addEdge,
  defaultCoalescer,
  moveNodes,
  pinSemanticNodes,
  setSelection,
  setViewport,
  withSnapshot,
} from "../../../lib/diagram/actions";
import { defaultEdge } from "../../../lib/diagram/edgeRouting";
import { isDiagramKeystroke } from "../../../lib/diagram/shortcuts";
import {
  clamp,
  rectsIntersect,
  screenToCanvas,
  snap,
  type Rect,
} from "../../../lib/diagram/geometry";
import {
  canvasEngineDrawnIds,
  currentCanvasDiagnostics,
  canvasLabelsFor,
  canvasLabelLines,
  canvasMoveBase,
  type CanvasGeometry,
  type CanvasGeometryPoint,
  type CanvasGeometryPrimitive,
  type CanvasLabelLines,
} from "../../../lib/diagram/engineCanvasGeometry";
import { isPinnableCanvasMember } from "../../../lib/diagram/engineGeometryCanvas";
import { modelDrawsNode } from "../../../lib/diagram/nodeVisibility";
import {
  analyzeViewDrag,
  detachViewMembersSnippetAction,
  offsetViewBoundsAction,
} from "../../../lib/diagram/patternStudio";
import type { MatrixDataset } from "../../../lib/diagram/reportTypes";
import {
  matrixForTableNode,
  setColumnWidth,
  setRowHeight,
  setTableSelection,
} from "../../../lib/diagram/tableActions";
import { addrAtCanvasPoint } from "../../../lib/diagram/tableEditing";
import { visibleSubset } from "../../../lib/diagram/viewportCulling";
import type { Coalescer } from "../../../lib/diagram/history";
import {
  computeSmartGuides,
  type GuideLine,
} from "../../../lib/diagram/smartGuides";
import {
  DIAGRAM_PAGE_SIZES,
  type DiagramDoc,
  type DiagramNode,
  type EdgePort,
  type NodeId,
  type TableCellAddress,
} from "../../../lib/diagram/types";
import { confirmDialog } from "../../../lib/confirmDialog";
import { useTranslation } from "../../../lib/i18n";
import {
  useDiagram,
  useDiagramStore,
} from "../DiagramStoreContext";
import { EdgeMarkers } from "./EdgeMarkers";
import { EdgeView, type EngineRoute } from "./EdgeView";
import { EnginePrimitives } from "./EnginePrimitives";
import { Marquee } from "./Marquee";
import { EngineLabels, NodeView } from "./NodeView";
import { SmartGuides } from "./SmartGuides";
import { useCanvasDisplay } from "./useCanvasGeometry";
import { canvasPositionsState, commitCanvasPositions, setLiveCanvasPositions } from "../../../lib/diagram/canvasDisplayPositions";

const CanvasDiagnosticLayer = lazy(() => import("./CanvasDiagnostics").then((module) => ({ default: module.CanvasDiagnosticLayer })));

/**
 * Pointer capture is an optimization, not a precondition. WebKit raises
 * `NotFoundError` for a pointer id it has not activated, which is the shape the
 * native e2e harness produces when it dispatches synthetic PointerEvents, and a
 * handler that lets that throw escape loses the selection, pan or marquee with
 * it. Losing capture only costs events delivered outside the surface.
 */
function capturePointer(svg: SVGSVGElement, pointerId: number): void {
  try {
    svg.setPointerCapture(pointerId);
  } catch {
    /* the gesture continues without capture */
  }
}

interface DragState {
  kind: "node";
  startCanvasX: number;
  startCanvasY: number;
  lastDx: number;
  lastDy: number;
  ids: NodeId[];
  /** Ids whose box the engine owns; the drag paints them, the drop pins them. */
  engineIds: NodeId[];
  /** Original positions of dragged nodes, keyed by id. */
  origins: Map<NodeId, { x: number; y: number; w: number; h: number }>;
  /** Views whose ENTIRE membership is dragged — stay linked (bounds offset on drop). */
  linkedViewIds: string[];
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

/** Drag-extend of a table cell range (ephemeral only — no snapshots). */
interface CellRangeState {
  kind: "cell-range";
  nodeId: NodeId;
}

/** Row-height / column-width drag on a table's resize handles. */
interface TableResizeState {
  kind: "table-resize";
  nodeId: NodeId;
  datasetId: string;
  axis: "col" | "row";
  trackId: string;
  startCanvasPos: number;
  origSize: number;
  coalescer: Coalescer;
}

type Gesture = ((DragState | PanState | MarqueeState | ConnectState | CellRangeState | TableResizeState) & { documentId: string; generation: number }) | null;
function gestureContext(doc: DiagramDoc) {
  return { documentId: doc.id, generation: canvasPositionsState(doc.id).generation };
}

export interface CanvasSurfaceProps {
  onMemoOpen?: (nodeId: NodeId) => void;
  onNodeDoubleClick?: (nodeId: NodeId) => void;
  /** Double-click on blank canvas (no node hit) — opens the pattern gallery. */
  onBlankDoubleClick?: () => void;
  /** Tracks the last canvas-space pointer position (insert-at-pointer target). */
  onPointerCanvasMove?: (point: { x: number; y: number }) => void;
  /** Double-click / quick-entry request for a table cell. */
  onCellEditRequest?: (nodeId: NodeId, addr: TableCellAddress) => void;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const SMART_GUIDE_THRESHOLD_PX = 6;
/** Stable empty list, so a canvas without a scene does not re-render the layer. */
const NO_PRIMITIVES: readonly CanvasGeometryPrimitive[] = [];

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

export function CanvasSurface({ onMemoOpen, onNodeDoubleClick, onBlankDoubleClick, onPointerCanvasMove, onCellEditRequest }: CanvasSurfaceProps = {}) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gestureRef = useRef<Gesture>(null);

  const doc = useDiagram((s) => s.doc);
  const nodes = useDiagram((s) => s.doc.nodes);
  const edges = useDiagram((s) => s.doc.edges);
  const datasets = useDiagram((s) => s.doc.datasets);
  const page = useDiagram((s) => s.doc.page);
  const tableSelection = useDiagram((s) => s.ephemeral.tableSelection);
  const viewport = useDiagram((s) => s.ephemeral.viewport);
  const selection = useDiagram((s) => s.ephemeral.selection);
  const snapOn = useDiagram((s) => s.ephemeral.ui.snapOn);
  const snapSize = useDiagram((s) => s.ephemeral.ui.snapSize);
  const smartGuideOn = useDiagram((s) => s.ephemeral.ui.smartGuideOn);
  const tool = useDiagram((s) => s.ephemeral.tool);
  const { state: canvasGeometry, session: displaySession, nodes: displayNodes } = useCanvasDisplay(doc);
  const geometry: CanvasGeometry | null = canvasGeometry.geometry;
  const datasetId = canvasGeometry.datasetId;

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

  useEffect(() => () => { setLiveCanvasPositions(doc.id, null); }, [doc.id]);
  useEffect(() => {
    gestureRef.current = null;
    setMarquee(null);
    setGuides([]);
    setConnectGhost(null);
  }, [doc.id, displaySession]);

  const activeGesture = useCallback(() => {
    const gesture = gestureRef.current;
    const currentDoc = store.getState().doc;
    if (gesture && (gesture.documentId !== currentDoc.id || gesture.generation !== canvasPositionsState(currentDoc.id).generation)) {
      gestureRef.current = null;
      setLiveCanvasPositions(gesture.documentId, null);
      setMarquee(null);
      setGuides([]);
      setConnectGhost(null);
      return null;
    }
    return gesture;
  }, [store]);

  // Labels are relative to the engine box, so a drag that displaces the node
  // group carries them without re-deriving anything.
  const engineLabelsByNode = useMemo(() => {
    const map = new Map<NodeId, readonly CanvasLabelLines[]>();
    if (!geometry) return map;
    for (const [id, box] of geometry.boxes) {
      const labels = canvasLabelsFor(geometry, id, "node");
      if (labels.length) map.set(id, labels.map((label) => canvasLabelLines(label, box)));
    }
    return map;
  }, [geometry]);

  const engineRoutesByEdge = useMemo(() => {
    const map = new Map<string, EngineRoute>();
    if (!geometry) return map;
    for (const edge of edges) {
      const route = geometry.routes.get(edge.id);
      if (!route) continue;
      const label = canvasLabelsFor(geometry, edge.id, "edge")[0] ?? null;
      map.set(edge.id, { route, label });
    }
    return map;
  }, [edges, geometry]);

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
    for (const n of displayNodes) map.set(n.id, n);
    return map;
  }, [displayNodes]);

  // View-linked tables: node id → matrix dataset (via meta.memberId).
  const matrixByNodeId = useMemo(() => {
    const map = new Map<NodeId, MatrixDataset>();
    for (const n of nodes) {
      const matrix = matrixForTableNode(n, datasets);
      if (matrix) map.set(n.id, matrix);
    }
    return map;
  }, [nodes, datasets]);

  const pageSize = page && page !== "free" ? DIAGRAM_PAGE_SIZES[page] : null;

  // A hidden member, or one on an invisible layer, is not drawn at all. That is
  // the model's own rule, shared with `renderSvg`, so it applies before the cull
  // and needs no measurement: the canvas would otherwise paint a hidden node
  // until its first resize and then drop it.
  const drawnNodes = useMemo(() => displayNodes.filter(modelDrawsNode(doc)), [displayNodes, doc]);

  // Culling: pick only the visible subset of nodes + edges. Selection is
  // forced-visible so an off-screen drag target doesn't disappear mid-gesture.
  // Skip when we haven't measured yet (avoid culling everything on first paint).
  const visible = useMemo(() => {
    if (svgSize.width === 0 || svgSize.height === 0) {
      return { nodes: drawnNodes, edges, full: true };
    }
    const tl = screenToCanvas(0, 0, viewport);
    const br = screenToCanvas(svgSize.width, svgSize.height, viewport);
    return visibleSubset({
      nodes: drawnNodes,
      edges,
      viewport: { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y },
      forceVisible: selection.nodes,
    });
  }, [drawnNodes, edges, selection.nodes, svgSize.height, svgSize.width, viewport]);

  // The engine's shapes follow the members they belong to. This is the model's
  // own visibility and not the viewport subset: a lifeline whose participant
  // sits above the viewport still crosses the part of the scene the reader is
  // looking at, so culling it would tear the timeline in half.
  const drawnMembers = useMemo(
    () => new Set(drawnNodes.map((node) => node.id)),
    [drawnNodes],
  );

  // The engine's member-owned shapes follow the same displacement the member
  // groups do: a member sits at its engine box plus its live drag offset, so a
  // shape anchored to it needs that delta too, or a dragged state leaves its
  // inner border behind and a dragged lifeline waits for the next layout.
  const memberOffsets = useMemo(() => {
    const offsets = new Map<NodeId, CanvasGeometryPoint>();
    if (!geometry) return offsets;
    for (const node of drawnNodes) {
      const box = geometry.boxes.get(node.id);
      if (!box) continue;
      const dx = node.x - box.x;
      const dy = node.y - box.y;
      if (dx !== 0 || dy !== 0) offsets.set(node.id, { x: dx, y: dy });
    }
    return offsets;
  }, [drawnNodes, geometry]);

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
      capturePointer(svg, event.pointerId);
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
      // Detach prompt (Phase 2b): dragging a strict subset of a view's
      // generated members breaks the projection link, so ask first. A
      // whole-membership drag stays linked (bounds offset on drop).
      const analysis = analyzeViewDrag(state.doc, ids);
      if (analysis.subsets.length > 0) {
        // The press is over by the time the async dialog answers, so this
        // press only detaches; the next drag moves the detached nodes (#377).
        void confirmDialog(t("diagram.detach.confirm")).then((confirmed) => {
          if (!confirmed) return;
          for (const subset of analysis.subsets) {
            store.setState(
              withSnapshot(
                detachViewMembersSnippetAction(subset.viewId, subset.memberIds),
                defaultCoalescer(),
              ),
            );
          }
        });
        return;
      }
      const origins = new Map<NodeId, { x: number; y: number; w: number; h: number }>();
      for (const id of ids) {
        const n = nodeById.get(id);
        if (n) origins.set(id, { x: n.x, y: n.y, w: n.w, h: n.h });
      }
      const drawnIds = canvasEngineDrawnIds(state.doc, datasetId, geometry);
      gestureRef.current = {
        ...gestureContext(store.getState().doc),
        kind: "node",
        startCanvasX: canvas.x,
        startCanvasY: canvas.y,
        lastDx: 0,
        lastDy: 0,
        ids,
        // All semantic members, including derived frames before their first
        // scene, stay engine-owned. Only pinnable members author a pin on drop;
        // a plain doc move would be hidden when the engine box arrives.
        engineIds: ids.filter((id) => drawnIds.has(id)),
        origins,
        linkedViewIds: analysis.full,
        coalescer: defaultCoalescer(),
      };
    },
    [datasetId, geometry, nodeById, store, t, viewport],
  );

  const beginConnect = useCallback(
    (event: PointerEvent<SVGCircleElement>, nodeId: NodeId, port: EdgePort) => {
      const svg = svgRef.current;
      if (!svg) return;
      capturePointer(svg, event.pointerId);
      const rect = svg.getBoundingClientRect();
      const canvas = screenToCanvas(event.clientX - rect.left, event.clientY - rect.top, viewport);
      const node = nodeById.get(nodeId);
      if (!node) return;
      const startCanvas = {
        x: port === "e" ? node.x + node.w : port === "w" ? node.x : node.x + node.w / 2,
        y: port === "s" ? node.y + node.h : port === "n" ? node.y : node.y + node.h / 2,
      };
      gestureRef.current = {
        ...gestureContext(store.getState().doc),
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
    [nodeById, store, viewport],
  );

  // Cell click: only takes over when the table node is already selected
  // (otherwise the pointerdown falls through to the node-drag handler, which
  // selects the node first). Starts a range-extend drag gesture.
  const beginCellSelect = useCallback(
    (event: PointerEvent<SVGRectElement>, nodeId: NodeId, addr: TableCellAddress) => {
      const state = store.getState();
      const node = state.doc.nodes.find((n) => n.id === nodeId);
      if (!node || node.locked) return;
      if (!state.ephemeral.selection.nodes.has(nodeId)) return;
      event.stopPropagation();
      const svg = svgRef.current;
      if (!svg) return;
      capturePointer(svg, event.pointerId);
      const existing = state.ephemeral.tableSelection;
      if (event.shiftKey && existing && existing.nodeId === nodeId) {
        store.setState(setTableSelection({ ...existing, focus: addr }));
      } else {
        store.setState(setTableSelection({ nodeId, anchor: addr, focus: addr }));
      }
      gestureRef.current = { ...gestureContext(store.getState().doc), kind: "cell-range", nodeId };
    },
    [store],
  );

  const onCellDoubleClick = useCallback(
    (event: MouseEvent<SVGRectElement>, nodeId: NodeId, addr: TableCellAddress) => {
      event.stopPropagation();
      const node = store.getState().doc.nodes.find((n) => n.id === nodeId);
      if (!node || node.locked) return;
      onCellEditRequest?.(nodeId, addr);
    },
    [onCellEditRequest, store],
  );

  // Row/column resize: mirrors the node-drag pattern — live updates through
  // withSnapshot with a fresh per-gesture coalescer → one undo entry per drag.
  const beginTableResize = useCallback(
    (event: PointerEvent<SVGRectElement>, nodeId: NodeId, axis: "col" | "row", index: number) => {
      event.stopPropagation();
      const svg = svgRef.current;
      if (!svg) return;
      const state = store.getState();
      const node = state.doc.nodes.find((n) => n.id === nodeId);
      if (!node || node.locked) return;
      const matrix = matrixForTableNode(node, state.doc.datasets);
      if (!matrix) return;
      const track = axis === "col" ? matrix.columns[index] : matrix.rows[index];
      if (!track) return;
      capturePointer(svg, event.pointerId);
      const rect = svg.getBoundingClientRect();
      const canvas = screenToCanvas(event.clientX - rect.left, event.clientY - rect.top, viewport);
      gestureRef.current = {
        ...gestureContext(store.getState().doc),
        kind: "table-resize",
        nodeId,
        datasetId: matrix.id,
        axis,
        trackId: track.id,
        startCanvasPos: axis === "col" ? canvas.x : canvas.y,
        origSize:
          axis === "col"
            ? (matrix.columns[index]?.width ?? node.w / Math.max(1, matrix.columns.length))
            : (matrix.rows[index]?.height ?? node.h / Math.max(1, matrix.rows.length)),
        coalescer: defaultCoalescer(),
      };
    },
    [store, viewport],
  );

  const onEdgeSelect = useCallback(    (event: PointerEvent<SVGGElement>, edgeId: string) => {
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
      capturePointer(svg, event.pointerId);
      const rect = svg.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      if (event.shiftKey || tool === "pan") {
        gestureRef.current = {
          ...gestureContext(store.getState().doc),
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
        ...gestureContext(store.getState().doc),
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
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      // Last-pointer tracking for the gallery's "insert at pointer" action.
      if (onPointerCanvasMove) {
        const point = screenToCanvas(screenX, screenY, viewport);
        onPointerCanvasMove(point);
      }
      const gesture = activeGesture();
      if (!gesture) return;

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

      if (gesture.kind === "cell-range") {
        const canvas = screenToCanvas(screenX, screenY, viewport);
        const state = store.getState();
        const node = state.doc.nodes.find((n) => n.id === gesture.nodeId);
        const matrix = node ? matrixForTableNode(node, state.doc.datasets) : null;
        const current = state.ephemeral.tableSelection;
        if (!node || !matrix || !current || current.nodeId !== gesture.nodeId) return;
        const addr = addrAtCanvasPoint(matrix, node, canvas.x, canvas.y);
        if (!addr) return;
        if (addr.rowId === current.focus.rowId && addr.colId === current.focus.colId) return;
        store.setState(setTableSelection({ ...current, focus: addr }));
        return;
      }

      if (gesture.kind === "table-resize") {
        const canvas = screenToCanvas(screenX, screenY, viewport);
        const pos = gesture.axis === "col" ? canvas.x : canvas.y;
        const size = Math.max(16, gesture.origSize + (pos - gesture.startCanvasPos));
        store.setState(
          withSnapshot(
            gesture.axis === "col"
              ? setColumnWidth(gesture.datasetId, gesture.trackId, size)
              : setRowHeight(gesture.datasetId, gesture.trackId, size),
            gesture.coalescer,
            { coalesce: true },
          ),
        );
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
            const stationary: Rect[] = displayNodes
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
        // Engine-drawn nodes move on the canvas, not in the doc: the drop writes
        // one pin per member. Everything else keeps the live doc move.
        const plainIds = gesture.ids.filter((id) => !gesture.engineIds.includes(id));
        if (plainIds.length > 0) {
          store.setState(
            withSnapshot(moveNodes(plainIds, stepDx, stepDy), gesture.coalescer, {
              coalesce: true,
            }),
          );
        }
        if (gesture.engineIds.length > 0) {
          const positions = new Map<NodeId, { x: number; y: number }>();
          for (const id of gesture.engineIds) {
            const origin = gesture.origins.get(id);
            if (origin) positions.set(id, { x: origin.x + proposedDx, y: origin.y + proposedDy });
          }
          setLiveCanvasPositions(doc.id, positions);
        }
        setGuides(smartGuideOut);
      }
    },
    [activeGesture, displayNodes, doc.id, onPointerCanvasMove, snapOn, snapSize, smartGuideOn, store, updateViewport, viewport],
  );

  const onSurfacePointerUp = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (svg && svg.hasPointerCapture(event.pointerId)) {
        svg.releasePointerCapture(event.pointerId);
      }
      const gesture = activeGesture();
      if (!gesture) return;
      if (gesture.kind === "marquee") {
        const rect = marqueeRect(gesture);
        if (rect.w > 1 || rect.h > 1) {
          const hits = nodesInsideRect(displayNodes, rect);
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
        // Whole-membership drags stay linked: offset the view bounds by the
        // same delta so the projection hash follows the moved members.
        if (
          gesture.linkedViewIds.length > 0 &&
          (gesture.lastDx !== 0 || gesture.lastDy !== 0)
        ) {
          store.setState(
            withSnapshot(
              offsetViewBoundsAction(gesture.linkedViewIds, gesture.lastDx, gesture.lastDy),
              gesture.coalescer,
              { coalesce: true },
            ),
          );
        }
        // A drop on engine-drawn members authors their position: one pin per
        // pinnable member, in emitted canvas coordinates, in one undo step.
        const moved = gesture.lastDx !== 0 || gesture.lastDy !== 0;
        const placed: Array<{ id: NodeId; x: number; y: number }> = [];
        if (moved && datasetId) {
          for (const id of gesture.engineIds) {
            // The doc node is the base, never the painted one: a painted node
            // already carries the live gesture offset, and the drop adds it
            // again (maru#552). Without a scene yet (first paint, first-run
            // refusal) the doc position also stands in for the box.
            const node = nodes.find((candidate) => candidate.id === id);
            if (!node || !isPinnableCanvasMember(doc, datasetId, node)) continue;
            const base = canvasMoveBase(node, geometry);
            placed.push({
              id,
              x: base.x + gesture.lastDx,
              y: base.y + gesture.lastDy,
            });
          }
        }
        if (placed.length > 0) {
          store.setState(withSnapshot(pinSemanticNodes(placed), gesture.coalescer, { coalesce: true }));
        }
        // The painting follows the pins until the layout answers them: with a
        // scene the engine box hides the doc position, so the gesture offset
        // holds the drop. Without one, or when nothing was pinnable, the offset
        // must go, or the canvas keeps a displacement no layout will replace.
        setLiveCanvasPositions(doc.id, null);
        if (moved && gesture.engineIds.length > 0) {
          commitCanvasPositions(store.getState().doc, canvasGeometry, gesture.engineIds, placed);
        }
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
    [activeGesture, canvasGeometry, datasetId, displayNodes, doc, geometry, nodes, store],
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
      // Same boundary as the diagram's other shortcuts: this is a window
      // listener, so without it Escape typed into the find bar or a dialog
      // cancels an in-flight canvas gesture.
      if (!isDiagramKeystroke(event.target)) return;
      if (event.key === "Escape") {
        gestureRef.current = null;
        setLiveCanvasPositions(doc.id, null);
        setMarquee(null);
        setGuides([]);
        setConnectGhost(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [doc.id]);

  const onNodeEnter = useCallback((nodeId: NodeId) => setHoverNodeId(nodeId), []);
  const onNodeLeave = useCallback(() => setHoverNodeId(null), []);

  // Blank-canvas double-click (svg background or page frame, not a node).
  const onSurfaceDoubleClick = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target === svgRef.current || target.hasAttribute("data-page-frame")) {
        onBlankDoubleClick?.();
      }
    },
    [onBlankDoubleClick],
  );

  // The engine's own box per node, for the geometry proofs and for debugging.
  const engineBoxAttr = (nodeId: NodeId): string | undefined => {
    const box = geometry?.boxes.get(nodeId);
    return box ? `${box.x} ${box.y} ${box.w} ${box.h}` : undefined;
  };

  // A container is a frame the engine paints around other members: a lane, a
  // boundary, a stage, a segment or an activation. Its own fill must not cover
  // the routes the engine ran inside it.
  const isEngineContainer = (node: DiagramNode): boolean =>
    geometry?.boxes.get(node.id)?.role === "container";

  const renderNode = (n: DiagramNode) => (
    <g
      key={n.id}
      data-engine-source-id={geometry?.boxes.get(n.id)?.sourceId}
      data-engine-box={engineBoxAttr(n.id)}
      onPointerEnter={() => onNodeEnter(n.id)}
      onPointerLeave={onNodeLeave}
      onDoubleClick={() => onNodeDoubleClick?.(n.id)}
    >
      <NodeView
        node={n}
        selected={selection.nodes.has(n.id)}
        showPorts={hoverNodeId === n.id}
        pendingConnectActive={Boolean(connectGhost)}
        engineLabels={engineLabelsByNode.get(n.id) ?? null}
        onPointerDown={beginNodeDrag}
        onPortPointerDown={beginConnect}
        onMemoOpen={onMemoOpen}
        tableMatrix={matrixByNodeId.get(n.id) ?? null}
        tableSelection={
          tableSelection && tableSelection.nodeId === n.id ? tableSelection : null
        }
        onCellPointerDown={beginCellSelect}
        onCellDoubleClick={onCellDoubleClick}
        onTableResizeHandlePointerDown={beginTableResize}
      />
    </g>
  );

  const diagnostics = currentCanvasDiagnostics(doc, canvasGeometry);

  return (
    <svg
      ref={svgRef}
      className="maru-diagram-canvas"
      role="application"
      aria-label={t("diagram.aria.canvas")}
      data-engine-dataset-id={datasetId ?? undefined}
      data-engine-spec-sha256={canvasGeometry.sourceSpecSha256 ?? undefined}
      data-engine-geometry-status={datasetId ? canvasGeometry.status : undefined}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onSurfacePointerMove}
      onPointerUp={onSurfacePointerUp}
      onPointerCancel={onSurfacePointerUp}
      onDoubleClick={onSurfaceDoubleClick}
      onWheel={onWheel}
    >
      <EdgeMarkers />
      <g transform={transform}>
        {pageSize ? (
          <g data-export-ignore pointerEvents="none">
            <rect
              data-page-frame
              x={0}
              y={0}
              width={pageSize.w}
              height={pageSize.h}
              fill="#ffffff"
              stroke="#cbd5e1"
              strokeWidth={1.5}
              strokeDasharray="8 4"
            />
          </g>
        ) : null}
        {/* Engine containers (lanes, boundaries, stages, segments) are frames:
            their fills would hide every route inside them if they were painted
            with the members, so they go under the edges. `renderSvg` keeps the
            same order. */}
        {visible.nodes.filter(isEngineContainer).map(renderNode)}
        {/* The engine's underlay shapes — a sequence lifeline, a phase span, a
            lifecycle band — paint after the frames and before the routes, in
            the writer's own order, so a message reads against its participant's
            timeline and no shape covers a route the engine ran. */}
        <EnginePrimitives primitives={geometry?.primitives ?? NO_PRIMITIVES} layer="underlay" members={drawnMembers} offsets={memberOffsets} />
        {visible.edges.map((edge) => (
          <EdgeView
            key={edge.id}
            edge={edge}
            fromNode={nodeById.get(edge.fromNode)}
            toNode={nodeById.get(edge.toNode)}
            selected={selection.edges.has(edge.id)}
            engineRoute={engineRoutesByEdge.get(edge.id) ?? null}
            onSelect={onEdgeSelect}
          />
        ))}
        {visible.nodes.filter((n) => !isEngineContainer(n)).map(renderNode)}
        {/* Overlays come after the members: a lifecycle final border sits on its
            own state and would be hidden by the state's box. */}
        <EnginePrimitives primitives={geometry?.primitives ?? NO_PRIMITIVES} layer="overlay" members={drawnMembers} offsets={memberOffsets} />
        {geometry && geometry.pageLabels.length > 0 ? (
          // The engine's title and subtitle sit in the header band its page
          // offset reserves. They are page chrome, so they paint after the
          // scene: above a lane, boundary or stage frame that reaches up to
          // them, exactly as `renderSvg` emits them.
          <EngineLabels labels={geometry.pageLabels} color="#111827" />
        ) : null}
        <SmartGuides guides={guides} />
        {connectGhost ? (
          <line
            data-export-ignore
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
        {datasetId && diagnostics.length > 0 ? (
          <Suspense fallback={null}>
            <CanvasDiagnosticLayer doc={doc} datasetId={datasetId} geometry={geometry} diagnostics={diagnostics} displayedNodes={drawnNodes} scope="elements" />
          </Suspense>
        ) : null}
      </g>
      {datasetId && diagnostics.length > 0 ? (
        <Suspense fallback={null}>
          <CanvasDiagnosticLayer doc={doc} datasetId={datasetId} geometry={geometry} diagnostics={diagnostics} displayedNodes={drawnNodes} scope="canvas" />
        </Suspense>
      ) : null}
    </svg>
  );
}
