import { createNodeBorderProgram } from "@sigma/node-border";
import { toBlob } from "@sigma/export-image";
import { MultiDirectedGraph } from "graphology";
import { inferSettings } from "graphology-layout-forceatlas2";
import FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Sigma from "sigma";
import { EdgeArrowProgram, EdgeLineProgram } from "sigma/rendering";
import type { GraphEdge, GraphNode } from "../../lib/graph/model";
import { isUsableCoordinate } from "../../lib/graph/positions";
import type { GraphDisplaySettings } from "../../lib/settings";
import { edgeKey, graphTheme, graphTopologySignature, nodeColor, nodeRadius, relationColor } from "./graphStyle";
import { graphBridgeEnabled } from "./graphBridge";
import { drawMaruNodeLabel, drawMaruNodeHover } from "./graphLabels";
import { useTranslation } from "../../lib/i18n";

export interface GraphViewport {
  zoom: number;
  px: number;
  py: number;
}

export type GraphHighlight =
  | { kind: "pair"; a: string; b: string }
  | { kind: "path"; ids: string[] }
  | null;

export interface GraphExportController {
  png: () => Promise<Blob>;
  svg: () => Blob;
}

/** Renderer lifecycle. empty-source / filtered-empty are NOT renderer states —
 *  GraphView reports those via its own graph-empty-bar. */
export type GraphRendererState =
  | "loading"
  | "layout-running"
  | "ready"
  | "gpu-recovery"
  | "fallback"
  | "fatal";

const MaruNodeBorderProgram = createNodeBorderProgram<SigmaNodeAttributes, SigmaEdgeAttributes>();

type SigmaNodeAttributes = {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  borderColor: string;
  type: "border";
  hidden?: boolean;
  /** FA2 respects `fixed` (helpers.js:144 → NodeMatrix[9]; iterate.js skips
   *  fixed nodes) — synced from pinnedIds before every layout start. */
  fixed?: boolean;
  forceLabel?: boolean;
  highlighted?: boolean;
  /** Set by the nodeReducer from favoriteIds — drawMaruNodeLabel renders ★. */
  favorite?: boolean;
  index: number;
  node: GraphNode;
};

type SigmaEdgeAttributes = {
  size: number;
  /** Unscaled size (frontmatter 1 / body 0.6) — edgeScale reapplies from this. */
  baseSize: number;
  color: string;
  type: "line" | "arrow";
  hidden?: boolean;
  relation: string;
  fromFrontmatter: boolean;
  sourceId: string;
  targetId: string;
  suggested?: boolean;
};

type GraphInstance = MultiDirectedGraph<SigmaNodeAttributes, SigmaEdgeAttributes>;

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positionsRef: RefObject<Float64Array | null>;
  positionNodeIdsRef: RefObject<string[] | null>;
  seedPositions?: Record<string, [number, number]>;
  initialPinnedIds?: string[];
  visibleNodeIds?: Set<string>;
  layoutEpoch: number;
  themeEpoch: number;
  enriched: boolean;
  display: GraphDisplaySettings;
  selectedId: string | null;
  focusNodeId: string | null;
  /** Emphasized node from the search combobox (separate from local focus). */
  searchHighlightId?: string | null;
  pathSourceId: string | null;
  highlight: GraphHighlight;
  fitSignal: number;
  zoomSignal: { dir: 1 | -1; nonce: number } | null;
  centerSignal: { id: string; nonce: number } | null;
  onSelect: (node: GraphNode | null) => void;
  onOpen: (node: GraphNode) => void;
  onPathTarget: (node: GraphNode) => void;
  onNodeDrag: (index: number, phase: "start" | "move" | "end", x: number, y: number) => void;
  onNodeUnpin: (index: number) => void;
  unpinSignal?: { id: string; nonce: number } | null;
  onLayoutSettled?: (positions: Float64Array, pinnedIds: string[]) => void;
  onLayoutError?: (message: string) => void;
  onRendererStateChange?: (state: GraphRendererState) => void;
  onNodeContextMenu?: (node: GraphNode, index: number, x: number, y: number) => void;
  favoriteIds?: Set<string>;
  exportControllerRef?: RefObject<GraphExportController | null>;
  overlay?: ReactNode;
  onViewportReport?: (zoom: number) => void;
}

type InteractionState = {
  selectedId: string | null;
  focusNodeId: string | null;
  searchHighlightId: string | null;
  pathSourceId: string | null;
  highlight: GraphHighlight;
  hoverId: string | null;
  favoriteIds: Set<string>;
  visibleNodeIds: Set<string> | null;
};

/** arrows: "typed" = frontmatter relations get arrows (body wiki_link stays a
 *  line); "all" = every edge arrowed; "none" = no arrows. */
function edgeArrowType(edge: GraphEdge, arrows: GraphDisplaySettings["arrows"]): "line" | "arrow" {
  if (arrows === "none") return "line";
  if (arrows === "all") return "arrow";
  return edge.fromFrontmatter ? "arrow" : "line";
}

const LABEL_DENSITY: Record<GraphDisplaySettings["labels"], number> = { low: 0.35, balanced: 0.55, high: 0.8 };
const LABEL_THRESHOLD: Record<GraphDisplaySettings["labels"], number> = { low: 4, balanced: 3, high: 2 };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Camera animation duration honoring prefers-reduced-motion. */
function animDuration(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

function hashPosition(id: string, index: number): [number, number] {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const angle = ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
  const radius = 20 + Math.sqrt(index + 1) * 18;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

function buildSigmaGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  positions: Float64Array | null,
  positionNodeIds: string[] | null,
  seedPositions: Record<string, [number, number]> | undefined,
  enriched: boolean,
  display: GraphDisplaySettings,
): GraphInstance {
  const graph = new MultiDirectedGraph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const positionsAligned = positions?.length === nodes.length * 2
    && positionNodeIds?.length === nodes.length
    && nodes.every((node, index) => positionNodeIds[index] === node.id);
  nodes.forEach((node, index) => {
    const fallback = hashPosition(node.id, index);
    const seed = seedPositions?.[node.id];
    const rawX = positionsAligned ? positions![index * 2] : seed?.[0];
    const rawY = positionsAligned ? positions![index * 2 + 1] : seed?.[1];
    // A single non-finite/absurd coordinate must not poison the render —
    // fall back to the deterministic hash position for that node only.
    const x = isUsableCoordinate(rawX) ? rawX : fallback[0];
    const y = isUsableCoordinate(rawY) ? rawY : fallback[1];
    graph.addNode(node.id, {
      x,
      y,
      size: nodeRadius(node.degree) * display.nodeScale,
      label: node.label,
      color: nodeColor(node, enriched),
      borderColor: node.type === "unresolved" ? graphTheme().muted : graphTheme().nodeBorder,
      type: "border",
      forceLabel: node.isGodNode,
      index,
      node,
    });
  });
  edges.forEach((edge, index) => {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) return;
    const baseSize = edge.fromFrontmatter ? 1 : 0.6;
    graph.addDirectedEdgeWithKey(`edge:${index}:${edge.source}:${edge.target}:${edge.relation}`, edge.source, edge.target, {
      size: baseSize * display.edgeScale,
      baseSize,
      // Frontmatter edges carry their relation color; body wiki_link edges
      // stay neutral. Highlight/dim rules in the reducer stay dominant.
      color: edge.fromFrontmatter ? relationColor(edge.relation) : graphTheme().edge,
      type: edgeArrowType(edge, display.arrows),
      relation: edge.relation,
      fromFrontmatter: edge.fromFrontmatter,
      sourceId: edge.source,
      targetId: edge.target,
    });
  });
  return graph;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function graphToSvg(renderer: Sigma<SigmaNodeAttributes, SigmaEdgeAttributes>): Blob {
  const graph = renderer.getGraph();
  const { width, height } = renderer.getDimensions();
  const edgeParts: string[] = [];
  graph.forEachEdge((key, attrs, source, target) => {
    if (attrs.hidden) return;
    const a = renderer.graphToViewport(graph.getNodeAttributes(source));
    const b = renderer.graphToViewport(graph.getNodeAttributes(target));
    edgeParts.push(`<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" stroke="${xmlEscape(attrs.color)}" stroke-width="${attrs.size}" stroke-opacity="0.55" data-edge-id="${xmlEscape(key)}"/>`);
  });
  const nodeParts: string[] = [];
  graph.forEachNode((key, attrs) => {
    if (attrs.hidden) return;
    const p = renderer.graphToViewport(attrs);
    const r = Math.max(2, renderer.scaleSize(attrs.size));
    nodeParts.push(`<g data-node-id="${xmlEscape(key)}"><circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r.toFixed(2)}" fill="${xmlEscape(attrs.color)}" stroke="${xmlEscape(attrs.borderColor)}"/><text x="${p.x.toFixed(2)}" y="${(p.y + r + 12).toFixed(2)}" text-anchor="middle" font-family="Pretendard, sans-serif" font-size="10" fill="${xmlEscape(graphTheme().ink)}">${xmlEscape(attrs.label)}</text></g>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${xmlEscape(graphTheme().bg)}"/>${edgeParts.join("")}${nodeParts.join("")}</svg>`;
  return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

const FALLBACK_VIEWBOX = "-700 -500 1400 1000";
const FALLBACK_LIST_THRESHOLD = 2_000;
const FALLBACK_LIST_CAP = 500;

function StaticGraphFallback({
  nodes,
  edges,
  positions,
  enriched,
  visibleNodeIds,
  onSelect,
  onOpen,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Float64Array | null;
  enriched: boolean;
  visibleNodeIds?: Set<string>;
  onSelect: (node: GraphNode | null) => void;
  onOpen: (node: GraphNode) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const index = useMemo(() => new Map(nodes.map((node, i) => [node.id, i])), [nodes]);
  const isVisible = (node: GraphNode) => !visibleNodeIds || visibleNodeIds.has(node.id);
  const point = (i: number): [number, number] => {
    if (positions?.length === nodes.length * 2) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      if (isUsableCoordinate(x) && isUsableCoordinate(y)) return [x, y];
    }
    return hashPosition(nodes[i].id, i);
  };
  const visibleCount = useMemo(
    () => (visibleNodeIds ? nodes.filter((node) => visibleNodeIds.has(node.id)).length : nodes.length),
    [nodes, visibleNodeIds],
  );
  if (visibleCount > FALLBACK_LIST_THRESHOLD) {
    const q = query.trim().toLowerCase();
    const rows = nodes.filter(
      (node) => isVisible(node) && (!q || node.label.toLowerCase().includes(q)),
    );
    return (
      <div className="graph-webgl-fallback-list" data-testid="graph-canvas">
        <input
          type="search"
          value={query}
          placeholder={t("graph.fallback.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul>
          {rows.slice(0, FALLBACK_LIST_CAP).map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => onSelect(node)}
                onDoubleClick={() => onOpen(node)}
              >
                {node.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  // ViewBox from the finite visible positions (fallback to the legacy box
  // when nothing usable exists yet).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  nodes.forEach((node, i) => {
    if (!isVisible(node)) return;
    const [x, y] = point(i);
    found = true;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  const pad = 50;
  const viewBox = found
    ? `${minX - pad} ${minY - pad} ${Math.max(1, maxX - minX) + pad * 2} ${Math.max(1, maxY - minY) + pad * 2}`
    : FALLBACK_VIEWBOX;
  return (
    <svg className="graph-canvas graph-static-fallback" data-testid="graph-canvas" viewBox={viewBox} onClick={() => onSelect(null)}>
      <g className="graph-edges">
        {edges.map((edge, i) => {
          const si = index.get(edge.source);
          const ti = index.get(edge.target);
          if (si == null || ti == null) return null;
          if (!isVisible(nodes[si]) || !isVisible(nodes[ti])) return null;
          const [x1, y1] = point(si);
          const [x2, y2] = point(ti);
          return <line key={`${edgeKey(edge.source, edge.target)}:${i}`} x1={x1} y1={y1} x2={x2} y2={y2} className="graph-edge" />;
        })}
      </g>
      <g className="graph-nodes labels-on">
        {nodes.map((node, i) => {
          if (!isVisible(node)) return null;
          const [x, y] = point(i);
          const r = nodeRadius(node.degree);
          return (
            <g key={node.id} className={`graph-node${node.type === "unresolved" ? " ghost" : ""}`} transform={`translate(${x}, ${y})`} onClick={(event) => { event.stopPropagation(); onSelect(node); }} onDoubleClick={() => onOpen(node)}>
              <circle r={r} fill={nodeColor(node, enriched)} data-node-id={node.id} />
              <text className="graph-node-label" dy={r + 12}>{node.label}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export function GraphCanvas({
  nodes,
  edges,
  positionsRef,
  positionNodeIdsRef,
  seedPositions,
  initialPinnedIds = [],
  visibleNodeIds,
  layoutEpoch,
  themeEpoch,
  enriched,
  display,
  selectedId,
  focusNodeId,
  searchHighlightId = null,
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
  unpinSignal,
  onLayoutSettled,
  onLayoutError,
  onRendererStateChange,
  onNodeContextMenu,
  favoriteIds = new Set<string>(),
  exportControllerRef,
  overlay,
  onViewportReport,
}: GraphCanvasProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphInstance | null>(null);
  const rendererRef = useRef<Sigma<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutRef = useRef<FA2LayoutSupervisor<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startLayoutRef = useRef<((clearPins: boolean) => void) | null>(null);
  const fitToVisibleRef = useRef<((animate: boolean) => void) | null>(null);
  const [rendererState, setRendererState] = useState<GraphRendererState>("loading");
  const rendererStateRef = useRef<GraphRendererState>("loading");
  const onRendererStateChangeRef = useRef(onRendererStateChange);
  onRendererStateChangeRef.current = onRendererStateChange;
  const applyRendererState = (next: GraphRendererState) => {
    if (rendererStateRef.current === next) return;
    rendererStateRef.current = next;
    setRendererState(next);
    onRendererStateChangeRef.current?.(next);
  };
  // Retry epoch — bumping remounts the renderer after a fatal init failure.
  const [rendererEpoch, setRendererEpoch] = useState(0);
  const onLayoutErrorRef = useRef(onLayoutError);
  onLayoutErrorRef.current = onLayoutError;
  const fittedEpochRef = useRef(-1);
  // Node/edge-count signature of the last built graph — lets a rebuild whose
  // topology is unchanged (e.g. a metadata-only re-scan or the enrichment swap)
  // reuse the cached positions instead of re-annealing the whole layout.
  const prevTopoSigRef = useRef<string | null>(null);
  // Set when a layout run was triggered by a topology change (new source /
  // vault): fit the camera to the settled result, once.
  const fitOnSettleRef = useRef(false);
  const draggedRef = useRef<{ id: string; index: number; moved: boolean } | null>(null);
  const pinnedIdsRef = useRef(new Set(initialPinnedIds));
  const onLayoutSettledRef = useRef(onLayoutSettled);
  onLayoutSettledRef.current = onLayoutSettled;
  // Display settings live in a ref so the (deps-frozen) renderer-creation
  // effect reads the latest values, while dedicated effects below hot-apply
  // changes without a rebuild.
  const displayRef = useRef(display);
  displayRef.current = display;
  const interactionRef = useRef<InteractionState>({
    selectedId,
    focusNodeId,
    searchHighlightId,
    pathSourceId,
    highlight,
    hoverId: null,
    favoriteIds,
    visibleNodeIds: visibleNodeIds ?? null,
  });
  interactionRef.current = {
    ...interactionRef.current,
    selectedId,
    focusNodeId,
    searchHighlightId,
    pathSourceId,
    highlight,
    favoriteIds,
    visibleNodeIds: visibleNodeIds ?? null,
  };
  const callbacksRef = useRef({ onSelect, onOpen, onPathTarget, onNodeDrag, onNodeUnpin, onNodeContextMenu, onViewportReport });
  callbacksRef.current = { onSelect, onOpen, onPathTarget, onNodeDrag, onNodeUnpin, onNodeContextMenu, onViewportReport };

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source)!.add(edge.target);
      map.get(edge.target)!.add(edge.source);
    }
    return map;
  }, [edges]);
  const adjacencyRef = useRef(adjacency);
  adjacencyRef.current = adjacency;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // A terminal state (fallback/fatal) survives data-only re-runs of this
    // effect; only an explicit Retry (rendererEpoch) re-enters init.
    if (rendererStateRef.current === "fallback" || rendererStateRef.current === "fatal") return;

    let disposeRenderer: (() => void) | null = null;
    let mountObserver: ResizeObserver | null = null;

    const init = () => {
      const bridgeEnabled = graphBridgeEnabled();
      const graph = buildSigmaGraph(
        nodes,
        edges,
        positionsRef.current,
        positionNodeIdsRef.current,
        seedPositions,
        enriched,
        displayRef.current,
      );
      graphRef.current = graph;

      // Pins → FA2 `fixed` attribute. The supervisor snapshots node attributes
      // when it (re)sends the graph to the worker, so syncing before every
      // startLayout is sufficient — attribute edits mid-run are not forwarded.
      const syncPinnedFixed = () => {
        graph.forEachNode((id) => {
          const shouldFix = pinnedIdsRef.current.has(id);
          if (Boolean(graph.getNodeAttribute(id, "fixed")) !== shouldFix) {
            graph.setNodeAttribute(id, "fixed", shouldFix);
          }
        });
      };
      syncPinnedFixed();

      let renderer: Sigma<SigmaNodeAttributes, SigmaEdgeAttributes>;
      try {
        renderer = new Sigma<SigmaNodeAttributes, SigmaEdgeAttributes>(graph, container, {
          defaultNodeType: "border",
          defaultEdgeType: "line",
          nodeProgramClasses: { border: MaruNodeBorderProgram },
          edgeProgramClasses: { line: EdgeLineProgram, arrow: EdgeArrowProgram },
          labelFont: "Pretendard, sans-serif",
          labelSize: 11,
          labelWeight: "500",
          labelRenderedSizeThreshold: 3,
          labelDensity: 0.55,
          defaultDrawNodeLabel: drawMaruNodeLabel,
          defaultDrawNodeHover: drawMaruNodeHover,
          hideEdgesOnMove: nodes.length > 5_000,
          hideLabelsOnMove: true,
          enableEdgeEvents: false,
          minCameraRatio: 0.02,
          maxCameraRatio: 8,
          stagePadding: 36,
          // Sigma reducers REPLACE display data — the return value must carry
          // x/y/size/color, so every branch merges over `data`.
          nodeReducer: (node, data) => {
            const state = interactionRef.current;
            const patch: Partial<SigmaNodeAttributes> & { highlighted?: boolean } = {};
            if (state.visibleNodeIds && !state.visibleNodeIds.has(node)) {
              return { ...data, hidden: true };
            }
            const overlayIds = state.highlight?.kind === "pair"
              ? new Set([state.highlight.a, state.highlight.b])
              : state.highlight?.kind === "path"
                ? new Set(state.highlight.ids)
                : null;
            const hovered = state.hoverId;
            const hoverVisible = hovered == null || node === hovered || adjacencyRef.current.get(hovered)?.has(node);
            const overlayVisible = !overlayIds || overlayIds.has(node);
            if (!hoverVisible || !overlayVisible) patch.color = graphTheme().dimNode;
            if (node === state.hoverId) {
              patch.size = data.size * 1.15;
            }
            const emphasized = node === state.selectedId || node === state.focusNodeId || node === state.searchHighlightId || node === state.pathSourceId || overlayIds?.has(node);
            if (emphasized) {
              patch.borderColor = overlayIds?.has(node) ? graphTheme().warn : graphTheme().accent;
              patch.highlighted = true;
              patch.forceLabel = true;
              patch.size = data.size * 1.18;
            } else if (state.favoriteIds.has(node)) {
              patch.borderColor = graphTheme().warn;
              patch.forceLabel = true;
            }
            patch.favorite = state.favoriteIds.has(node);
            return { ...data, ...patch };
          },
          edgeReducer: (_edge, data) => {
            const state = interactionRef.current;
            if (state.visibleNodeIds && (!state.visibleNodeIds.has(data.sourceId) || !state.visibleNodeIds.has(data.targetId))) {
              return { ...data, hidden: true };
            }
            const hovered = state.hoverId;
            const pair = state.highlight?.kind === "pair" ? state.highlight : null;
            const path = state.highlight?.kind === "path" ? state.highlight.ids : null;
            let active = true;
            if (hovered) active = data.sourceId === hovered || data.targetId === hovered;
            if (pair) active = (data.sourceId === pair.a && data.targetId === pair.b) || (data.sourceId === pair.b && data.targetId === pair.a);
            if (path) {
              active = false;
              for (let i = 0; i + 1 < path.length; i += 1) {
                if (edgeKey(data.sourceId, data.targetId) === edgeKey(path[i], path[i + 1])) {
                  active = true;
                  break;
                }
              }
            }
            return active ? { ...data, color: pair || path ? graphTheme().accent : data.color, size: pair || path ? Math.max(2.2, data.size) : data.size } : { ...data, color: graphTheme().edgeDim, size: 0.4 };
          },
        });
      } catch (err) {
        console.error("[graph] WebGL renderer init failed — falling back to static render", err);
        // Sigma appends its canvases before validating — drop any orphans so
        // they can't sit above the fallback/overlay and swallow pointer events.
        container.replaceChildren();
        graphRef.current = null;
        rendererRef.current = null;
        applyRendererState("fallback");
        return;
      }
      rendererRef.current = renderer;

      // Pane resize: coalesced resize()+refresh() only — never a graphology
      // rebuild, never a layout re-run, never a camera move.
      let resizeRaf = 0;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
          renderer.resize();
          renderer.refresh();
        });
      });
      resizeObserver.observe(container);

      let contextRestored = false;
      let contextFallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const onContextLost = (event: Event) => {
        event.preventDefault();
        contextRestored = false;
        applyRendererState("gpu-recovery");
        if (contextFallbackTimer) clearTimeout(contextFallbackTimer);
        contextFallbackTimer = setTimeout(() => {
          if (contextRestored) return;
          // Kill the live renderer before swapping to the SVG fallback — its
          // canvases are about to be unmounted and would otherwise leak.
          teardown();
          applyRendererState("fallback");
        }, 1_000);
      };
      const onContextRestored = () => {
        contextRestored = true;
        if (contextFallbackTimer) clearTimeout(contextFallbackTimer);
        contextFallbackTimer = null;
        renderer.refresh();
        applyRendererState(layoutRef.current ? "layout-running" : "ready");
      };
      const rendererCanvases = Object.values(renderer.getCanvases());
      rendererCanvases.forEach((canvas) => {
        canvas.addEventListener("webglcontextlost", onContextLost);
        canvas.addEventListener("webglcontextrestored", onContextRestored);
      });

      const snapshotPositions = () => {
        const positions = new Float64Array(nodes.length * 2);
        nodes.forEach((node, index) => {
          if (!graph.hasNode(node.id)) return;
          positions[index * 2] = graph.getNodeAttribute(node.id, "x");
          positions[index * 2 + 1] = graph.getNodeAttribute(node.id, "y");
        });
        positionsRef.current = positions;
        positionNodeIdsRef.current = nodes.map((node) => node.id);
        onLayoutSettledRef.current?.(positions, [...pinnedIdsRef.current]);
      };
      const stopLayout = () => {
        layoutRef.current?.stop();
        layoutRef.current?.kill();
        layoutRef.current = null;
        if (layoutIntervalRef.current) clearInterval(layoutIntervalRef.current);
        if (layoutTimeoutRef.current) clearTimeout(layoutTimeoutRef.current);
        layoutIntervalRef.current = null;
        layoutTimeoutRef.current = null;
      };
      // Fit the camera to the finite bounds of the visible nodes. Uses sigma's
      // customBBox so the animatedReset framing is computed over exactly the
      // visible set; the bbox stays set (clearing it would reframe the
      // normalization and jump the camera) until a whole-graph fit clears it.
      const fitToVisible = (animate: boolean) => {
        const currentRenderer = rendererRef.current;
        const currentGraph = graphRef.current;
        if (!currentRenderer || !currentGraph) return;
        const { width, height } = currentRenderer.getDimensions();
        if (width <= 0 || height <= 0) return;
        const visible = interactionRef.current.visibleNodeIds;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let found = false;
        currentGraph.forEachNode((id, attrs) => {
          if (visible && !visible.has(id)) return;
          if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return;
          found = true;
          minX = Math.min(minX, attrs.x);
          minY = Math.min(minY, attrs.y);
          maxX = Math.max(maxX, attrs.x);
          maxY = Math.max(maxY, attrs.y);
        });
        if (!found) return;
        currentRenderer.setCustomBBox({ x: [minX, maxX], y: [minY, maxY] });
        currentRenderer.refresh();
        const camera = currentRenderer.getCamera();
        if (animate) void camera.animatedReset({ duration: animDuration(180) });
        else camera.setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
      };
      fitToVisibleRef.current = fitToVisible;
      const startLayout = (clearPins: boolean) => {
        stopLayout();
        if (clearPins) {
          pinnedIdsRef.current.clear();
          syncPinnedFixed();
        }
        if (graph.order < 2 || graph.size < 1) {
          snapshotPositions();
          if (fitOnSettleRef.current) {
            fitOnSettleRef.current = false;
            fitToVisible(false);
          }
          return;
        }
        applyRendererState("layout-running");
        const settings = {
          ...inferSettings(graph.order),
          adjustSizes: true,
          barnesHutOptimize: graph.order >= 500,
          barnesHutTheta: 0.6,
          gravity: 1,
          slowDown: graph.order >= 5_000 ? 8 : 3,
        };
        syncPinnedFixed();
        const supervisor = new FA2LayoutSupervisor<SigmaNodeAttributes, SigmaEdgeAttributes>(graph, { settings });
        layoutRef.current = supervisor;
        // A dead worker must not freeze the graph silently: keep the last-good
        // positions (the graphology graph still holds them), stop cleanly, and
        // surface the failure through the onLayoutError channel.
        const worker = (supervisor as unknown as { worker?: Worker | null }).worker ?? null;
        const onWorkerError = (event: Event) => {
          console.error("[graph] layout worker failed — keeping last-good positions", event);
          worker?.removeEventListener("error", onWorkerError);
          stopLayout();
          snapshotPositions();
          applyRendererState("ready");
          onLayoutErrorRef.current?.(t("graph.error.layout"));
        };
        worker?.addEventListener("error", onWorkerError);
        const settle = () => {
          stopLayout();
          snapshotPositions();
          applyRendererState("ready");
          if (fitOnSettleRef.current) {
            fitOnSettleRef.current = false;
            fitToVisible(true);
          }
        };
        const sampleIds = nodes.slice(0, 256).map((node) => node.id);
        let previous = sampleIds.map((id) => [graph.getNodeAttribute(id, "x"), graph.getNodeAttribute(id, "y")] as const);
        let stableSamples = 0;
        layoutIntervalRef.current = setInterval(() => {
          let displacement = 0;
          const next = sampleIds.map((id, index) => {
            const point = [graph.getNodeAttribute(id, "x"), graph.getNodeAttribute(id, "y")] as const;
            displacement += Math.hypot(point[0] - previous[index][0], point[1] - previous[index][1]);
            return point;
          });
          previous = next;
          stableSamples = displacement / Math.max(1, sampleIds.length) < 0.08 ? stableSamples + 1 : 0;
          if (stableSamples >= 3) settle();
        }, 250);
        layoutTimeoutRef.current = setTimeout(
          settle,
          seedPositions && Object.keys(seedPositions).length > 0 ? 2_500 : 5_000,
        );
        try {
          supervisor.start();
        } catch (err) {
          console.error("[graph] layout worker start failed — keeping last-good positions", err);
          worker?.removeEventListener("error", onWorkerError);
          settle();
          onLayoutErrorRef.current?.(t("graph.error.layout"));
        }
      };
      startLayoutRef.current = startLayout;
      // Dev-only e2e bridge (see graphBridge.ts) — real-Sigma observability
      // instead of the old fake DOM overlay. Nothing here ships in prod builds.
      let bridgeFrameCount = 0;
      renderer.on("afterRender", () => {
        bridgeFrameCount += 1;
      });
      if (bridgeEnabled) {
        window.__maruGraph = {
          state: () => rendererStateRef.current,
          containerSize: () => ({ width: container.clientWidth, height: container.clientHeight }),
          containerRect: () => {
            const rect = container.getBoundingClientRect();
            return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
          },
          frames: () => bridgeFrameCount,
          camera: () => {
            const state = renderer.getCamera().getState();
            return { x: state.x, y: state.y, ratio: state.ratio };
          },
          nodeViewportPoint: (id) => {
            if (!graph.hasNode(id)) return null;
            const visible = interactionRef.current.visibleNodeIds;
            if (visible && !visible.has(id)) return null;
            const attrs = graph.getNodeAttributes(id);
            if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return null;
            const point = renderer.graphToViewport(attrs);
            const rect = container.getBoundingClientRect();
            return { x: point.x + rect.left, y: point.y + rect.top };
          },
          nodeScreenState: (id) => {
            const data = renderer.getNodeDisplayData(id) as
              | { size?: number; color?: string; borderColor?: string; favorite?: boolean }
              | undefined;
            const visibleIds = interactionRef.current.visibleNodeIds;
            return {
              // Sigma keeps display data for reducer-hidden nodes, so
              // visibility comes from the filter set, not display data.
              visible: graph.hasNode(id) && (!visibleIds || visibleIds.has(id)),
              size: data?.size ?? null,
              color: data?.color ?? null,
              borderColor: data?.borderColor ?? null,
              favorite: data?.favorite === true,
            };
          },
          hoveredId: () => interactionRef.current.hoverId,
          layoutRunning: () => layoutRef.current?.isRunning() ?? false,
          freezeLayout: () => {
            stopLayout();
            applyRendererState("ready");
          },
          resumeLayout: () => startLayoutRef.current?.(false),
          fitView: () => fitToVisible(false),
          simulateContextLost: () => {
            rendererCanvases.forEach((canvas) => canvas.dispatchEvent(new Event("webglcontextlost")));
          },
          graphStats: () => ({
            nodes: nodes.length,
            edges: edges.length,
            visibleNodes: interactionRef.current.visibleNodeIds?.size ?? nodes.length,
          }),
        };
      }
      const resolveNode = (id: string) => graph.hasNode(id) ? graph.getNodeAttribute(id, "node") : null;
      renderer.on("clickStage", () => callbacksRef.current.onSelect(null));
      renderer.on("clickNode", ({ node, event }) => {
        const item = resolveNode(node);
        if (!item || draggedRef.current?.moved) return;
        const original = event.original as MouseEvent;
        if (original.altKey) {
          pinnedIdsRef.current.delete(node);
          graph.removeNodeAttribute(node, "fixed");
          callbacksRef.current.onNodeUnpin(graph.getNodeAttribute(node, "index"));
          startLayout(false);
        }
        else if (original.shiftKey) callbacksRef.current.onPathTarget(item);
        else callbacksRef.current.onSelect(item);
      });
      renderer.on("doubleClickNode", ({ node, event }) => {
        event.preventSigmaDefault();
        const item = resolveNode(node);
        if (item) callbacksRef.current.onOpen(item);
      });
      renderer.on("rightClickNode", ({ node, event }) => {
        event.preventSigmaDefault();
        const item = resolveNode(node);
        const original = event.original as MouseEvent;
        if (item) callbacksRef.current.onNodeContextMenu?.(item, graph.getNodeAttribute(node, "index"), original.clientX, original.clientY);
      });
      renderer.on("enterNode", ({ node }) => {
        interactionRef.current.hoverId = node;
        renderer.scheduleRefresh();
      });
      renderer.on("leaveNode", () => {
        interactionRef.current.hoverId = null;
        renderer.scheduleRefresh();
      });
      renderer.on("downNode", ({ node, event }) => {
        event.preventSigmaDefault();
        stopLayout();
        applyRendererState("ready");
        const attrs = graph.getNodeAttributes(node);
        draggedRef.current = { id: node, index: attrs.index, moved: false };
        renderer.getCamera().disable();
        callbacksRef.current.onNodeDrag(attrs.index, "start", attrs.x, attrs.y);
      });
      const mouse = renderer.getMouseCaptor();
      const onMove = ({ x, y }: { x: number; y: number }) => {
        const dragged = draggedRef.current;
        if (!dragged) return;
        dragged.moved = true;
        const point = renderer.viewportToGraph({ x, y });
        graph.mergeNodeAttributes(dragged.id, { x: point.x, y: point.y });
        renderer.scheduleRefresh({ partialGraph: { nodes: [dragged.id] } });
        callbacksRef.current.onNodeDrag(dragged.index, "move", point.x, point.y);
      };
      const onUp = () => {
        const dragged = draggedRef.current;
        if (!dragged) return;
        const attrs = graph.getNodeAttributes(dragged.id);
        callbacksRef.current.onNodeDrag(dragged.index, "end", attrs.x, attrs.y);
        pinnedIdsRef.current.add(dragged.id);
        graph.setNodeAttribute(dragged.id, "fixed", true);
        draggedRef.current = null;
        renderer.getCamera().enable();
        snapshotPositions();
      };
      mouse.on("mousemovebody", onMove);
      mouse.on("mouseup", onUp);
      renderer.getCamera().on("updated", (state) => callbacksRef.current.onViewportReport?.(1 / state.ratio));
      renderer.once("afterRender", () => {
        applyRendererState(layoutRef.current ? "layout-running" : "ready");
        // First render after creation: fit the finite visible bounds once.
        fitToVisible(false);
      });
      // Re-run the force layout only when node ids or edge topology changed.
      // Metadata-only rescans and enrichment swaps keep the viewport stable.
      const topoSig = graphTopologySignature(nodes, edges);
      const positionsValid = positionsRef.current?.length === graph.order * 2
        && positionNodeIdsRef.current?.length === graph.order
        && nodes.every((node, index) => positionNodeIdsRef.current?.[index] === node.id);
      if (prevTopoSigRef.current === topoSig && positionsValid) {
        snapshotPositions();
        applyRendererState("ready");
      } else {
        fitOnSettleRef.current = true;
        startLayout(false);
      }
      prevTopoSigRef.current = topoSig;
      if (exportControllerRef) {
        exportControllerRef.current = {
          png: () => toBlob(renderer as unknown as Sigma, { backgroundColor: graphTheme().bg }),
          svg: () => graphToSvg(renderer),
        };
      }
      let tornDown = false;
      function teardown() {
        if (tornDown) return;
        tornDown = true;
        if (bridgeEnabled) delete window.__maruGraph;
        if (exportControllerRef) exportControllerRef.current = null;
        resizeObserver.disconnect();
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        if (contextFallbackTimer) clearTimeout(contextFallbackTimer);
        rendererCanvases.forEach((canvas) => {
          canvas.removeEventListener("webglcontextlost", onContextLost);
          canvas.removeEventListener("webglcontextrestored", onContextRestored);
        });
        startLayoutRef.current = null;
        fitToVisibleRef.current = null;
        stopLayout();
        mouse.off("mousemovebody", onMove);
        mouse.off("mouseup", onUp);
        renderer.kill();
        rendererRef.current = null;
        graphRef.current = null;
      }
      return teardown;
    };

    // Mount gating: never construct Sigma against a zero-size container (it
    // throws without allowInvalidContainer, and even a surviving renderer
    // would compute a degenerate viewport). Data prep above is cheap; the
    // renderer waits for the first positive dimensions.
    const tryInit = (): boolean => {
      if (container.clientWidth <= 0 || container.clientHeight <= 0) return false;
      try {
        disposeRenderer = init() ?? null;
      } catch (err) {
        // A failure before Sigma construction (e.g. graph build) is one the
        // SVG fallback cannot cover either — report it as fatal with Retry.
        console.error("[graph] renderer init failed fatally", err);
        container.replaceChildren();
        graphRef.current = null;
        rendererRef.current = null;
        applyRendererState("fatal");
      }
      return true;
    };
    if (!tryInit()) {
      applyRendererState("loading");
      mountObserver = new ResizeObserver(() => {
        if (tryInit()) {
          mountObserver?.disconnect();
          mountObserver = null;
        }
      });
      mountObserver.observe(container);
    }
    return () => {
      mountObserver?.disconnect();
      disposeRenderer?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, enriched, positionsRef, positionNodeIdsRef, seedPositions, exportControllerRef, themeEpoch, rendererEpoch]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer) renderer.scheduleRefresh();
  }, [selectedId, focusNodeId, searchHighlightId, pathSourceId, highlight, favoriteIds, visibleNodeIds]);

  // --- display settings, hot-applied (no graph rebuild) --------------------

  useEffect(() => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;
    graph.forEachEdge((key, attrs) => {
      const type: "line" | "arrow" =
        display.arrows === "none" ? "line"
          : display.arrows === "all" ? "arrow"
            : attrs.fromFrontmatter ? "arrow" : "line";
      if (attrs.type !== type) graph.setEdgeAttribute(key, "type", type);
    });
    renderer.refresh();
  }, [display.arrows]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setSetting("labelDensity", LABEL_DENSITY[display.labels]);
    renderer.setSetting("labelRenderedSizeThreshold", LABEL_THRESHOLD[display.labels]);
    renderer.refresh();
  }, [display.labels]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;
    graph.forEachNode((key, attrs) => {
      graph.setNodeAttribute(key, "size", nodeRadius(attrs.node.degree) * display.nodeScale);
    });
    renderer.refresh();
  }, [display.nodeScale]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;
    graph.forEachEdge((key, attrs) => {
      graph.setEdgeAttribute(key, "size", attrs.baseSize * display.edgeScale);
    });
    renderer.refresh();
  }, [display.edgeScale]);

  // Filter change that leaves every visible node outside the current viewport
  // (e.g. focusing a cluster far from the current camera): re-fit once.
  // Ordinary filter changes and pane resizes never touch the camera.
  useEffect(() => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph || !visibleNodeIds || visibleNodeIds.size === 0) return;
    const { width, height } = renderer.getDimensions();
    if (width <= 0 || height <= 0) return;
    let anyFinite = false;
    let anyInside = false;
    for (const id of visibleNodeIds) {
      if (!graph.hasNode(id)) continue;
      const attrs = graph.getNodeAttributes(id);
      if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) continue;
      anyFinite = true;
      const p = renderer.graphToViewport(attrs);
      if (p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) {
        anyInside = true;
        break;
      }
    }
    if (anyFinite && !anyInside) fitToVisibleRef.current?.(true);
  }, [visibleNodeIds]);

  useEffect(() => {
    if (layoutEpoch <= 0 || fittedEpochRef.current === layoutEpoch) return;
    fittedEpochRef.current = layoutEpoch;
    // Whole-graph re-layout: clear pins and the visible-fit bbox, reset camera.
    rendererRef.current?.setCustomBBox(null);
    startLayoutRef.current?.(true);
    rendererRef.current?.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  }, [layoutEpoch]);

  useEffect(() => {
    if (!unpinSignal) return;
    pinnedIdsRef.current.delete(unpinSignal.id);
    const graph = graphRef.current;
    if (graph?.hasNode(unpinSignal.id)) graph.removeNodeAttribute(unpinSignal.id, "fixed");
    startLayoutRef.current?.(false);
  }, [unpinSignal]);

  useEffect(() => {
    if (fitSignal <= 0) return;
    // Whole-graph fit: drop any visible-set bbox before resetting.
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setCustomBBox(null);
    renderer.refresh();
    void renderer.getCamera().animatedReset({ duration: animDuration(180) });
  }, [fitSignal]);

  useEffect(() => {
    if (!zoomSignal) return;
    const camera = rendererRef.current?.getCamera();
    if (!camera) return;
    if (zoomSignal.dir === 1) void camera.animatedZoom({ duration: animDuration(100) });
    else void camera.animatedUnzoom({ duration: animDuration(100) });
  }, [zoomSignal]);

  useEffect(() => {
    if (!centerSignal) return;
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph?.hasNode(centerSignal.id)) return;
    const data = renderer.getNodeDisplayData(centerSignal.id);
    if (data) void renderer.getCamera().animate({ x: data.x, y: data.y }, { duration: animDuration(180) });
  }, [centerSignal]);

  // Keyboard access on the focused canvas: arrows nudge the camera (~40px,
  // shift for larger), Enter opens the current selection.
  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (event.key === "Enter") {
      const id = interactionRef.current.selectedId;
      const graph = graphRef.current;
      if (id && graph?.hasNode(id)) {
        event.preventDefault();
        callbacksRef.current.onOpen(graph.getNodeAttribute(id, "node"));
      }
      return;
    }
    const step = event.shiftKey ? 120 : 40;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;
    event.preventDefault();
    const origin = renderer.viewportToFramedGraph({ x: 0, y: 0 });
    const delta = renderer.viewportToFramedGraph({ x: dx, y: dy });
    const camera = renderer.getCamera();
    const state = camera.getState();
    camera.setState({
      ...state,
      x: state.x + (delta.x - origin.x),
      y: state.y + (delta.y - origin.y),
    });
  };

  const selectedLabel = selectedId && graphRef.current?.hasNode(selectedId)
    ? graphRef.current.getNodeAttribute(selectedId, "label")
    : null;

  return (
    <div className="graph-canvas-wrap">
      {rendererState === "fallback" ? (
        <StaticGraphFallback nodes={nodes} edges={edges} positions={positionsRef.current} enriched={enriched} visibleNodeIds={visibleNodeIds} onSelect={onSelect} onOpen={onOpen} />
      ) : (
        <div ref={containerRef} className="graph-canvas graph-webgl-canvas" data-testid="graph-canvas" role="application" aria-label={t("graph.aria.canvas")} tabIndex={0} onKeyDown={handleCanvasKeyDown} />
      )}
      <div className="sr-only" aria-live="polite">{selectedLabel ? t("graph.aria.selected", { label: selectedLabel }) : ""}</div>
      {rendererState === "loading" ? <div className="graph-canvas-loading" data-testid="graph-canvas-loading">…</div> : null}
      {rendererState === "gpu-recovery" ? (
        <div className="graph-renderer-overlay" data-testid="graph-gpu-recovery">
          {t("graph.overlay.gpuRecovery")}
        </div>
      ) : null}
      {rendererState === "fatal" ? (
        <div className="graph-renderer-overlay" data-testid="graph-fatal">
          <span>{t("graph.overlay.fatal")}</span>
          <button
            type="button"
            data-testid="graph-fatal-retry"
            onClick={() => {
              applyRendererState("loading");
              setRendererEpoch((epoch) => epoch + 1);
            }}
          >
            {t("graph.overlay.retry")}
          </button>
        </div>
      ) : null}
      {overlay}
    </div>
  );
}
