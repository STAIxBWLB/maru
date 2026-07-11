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
import { communityColor, edgeKey, graphTheme, graphTopologySignature, nodeColor, nodeRadius, refreshGraphTheme } from "./graphStyle";
import { drawMaruNodeLabel, drawMaruNodeHover } from "./graphLabels";

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
  forceLabel?: boolean;
  highlighted?: boolean;
  index: number;
  node: GraphNode;
};

type SigmaEdgeAttributes = {
  size: number;
  color: string;
  type: "line" | "arrow";
  hidden?: boolean;
  relation: string;
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
  enriched: boolean;
  selectedId: string | null;
  focusNodeId: string | null;
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
  onNodeContextMenu?: (node: GraphNode, index: number, x: number, y: number) => void;
  favoriteIds?: Set<string>;
  exportControllerRef?: RefObject<GraphExportController | null>;
  hulls?: { community: number; path: string }[];
  overlay?: ReactNode;
  onViewportReport?: (zoom: number) => void;
}

type InteractionState = {
  selectedId: string | null;
  focusNodeId: string | null;
  pathSourceId: string | null;
  highlight: GraphHighlight;
  hoverId: string | null;
  favoriteIds: Set<string>;
  visibleNodeIds: Set<string> | null;
};

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
): GraphInstance {
  const graph = new MultiDirectedGraph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const positionsAligned = positions?.length === nodes.length * 2
    && positionNodeIds?.length === nodes.length
    && nodes.every((node, index) => positionNodeIds[index] === node.id);
  nodes.forEach((node, index) => {
    const fallback = hashPosition(node.id, index);
    const seed = seedPositions?.[node.id];
    const x = positionsAligned ? positions![index * 2] : seed?.[0] ?? fallback[0];
    const y = positionsAligned ? positions![index * 2 + 1] : seed?.[1] ?? fallback[1];
    graph.addNode(node.id, {
      x,
      y,
      size: nodeRadius(node.degree),
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
    const directed = edge.relation === "supersedes" || edge.relation === "superseded_by";
    graph.addDirectedEdgeWithKey(`edge:${index}:${edge.source}:${edge.target}:${edge.relation}`, edge.source, edge.target, {
      size: edge.fromFrontmatter ? 1 : 0.6,
      color: edge.fromFrontmatter ? graphTheme().edgeStrong : graphTheme().edge,
      type: directed ? "arrow" : "line",
      relation: edge.relation,
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

function StaticGraphFallback({
  nodes,
  edges,
  positions,
  enriched,
  onSelect,
  onOpen,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Float64Array | null;
  enriched: boolean;
  onSelect: (node: GraphNode | null) => void;
  onOpen: (node: GraphNode) => void;
}) {
  const index = useMemo(() => new Map(nodes.map((node, i) => [node.id, i])), [nodes]);
  if (nodes.length > 2_000) {
    return (
      <div className="graph-webgl-fallback-list" role="status">
        WebGL을 사용할 수 없어 대규모 그래프를 목록으로 표시합니다. 검색과 Inspector는 계속 사용할 수 있습니다.
      </div>
    );
  }
  const point = (i: number) => {
    if (positions?.length === nodes.length * 2) return [positions[i * 2], positions[i * 2 + 1]];
    return hashPosition(nodes[i].id, i);
  };
  return (
    <svg className="graph-canvas graph-static-fallback" data-testid="graph-canvas" viewBox="-700 -500 1400 1000" onClick={() => onSelect(null)}>
      <g className="graph-edges">
        {edges.map((edge, i) => {
          const si = index.get(edge.source);
          const ti = index.get(edge.target);
          if (si == null || ti == null) return null;
          const [x1, y1] = point(si);
          const [x2, y2] = point(ti);
          return <line key={`${edgeKey(edge.source, edge.target)}:${i}`} x1={x1} y1={y1} x2={x2} y2={y2} className="graph-edge" />;
        })}
      </g>
      <g className="graph-nodes labels-on">
        {nodes.map((node, i) => {
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
  unpinSignal,
  onLayoutSettled,
  onNodeContextMenu,
  favoriteIds = new Set<string>(),
  exportControllerRef,
  hulls = [],
  overlay,
  onViewportReport,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphInstance | null>(null);
  const rendererRef = useRef<Sigma<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutRef = useRef<FA2LayoutSupervisor<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startLayoutRef = useRef<((clearPins: boolean) => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => {
    refreshGraphTheme();
    const apply = () => {
      refreshGraphTheme();
      setThemeEpoch((epoch) => epoch + 1);
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", apply);
    };
  }, []);
  const fittedEpochRef = useRef(-1);
  // Node/edge-count signature of the last built graph — lets a rebuild whose
  // topology is unchanged (e.g. a metadata-only re-scan or the enrichment swap)
  // reuse the cached positions instead of re-annealing the whole layout.
  const prevTopoSigRef = useRef<string | null>(null);
  const draggedRef = useRef<{ id: string; index: number; moved: boolean } | null>(null);
  const pinnedIdsRef = useRef(new Set(initialPinnedIds));
  const onLayoutSettledRef = useRef(onLayoutSettled);
  onLayoutSettledRef.current = onLayoutSettled;
  const hullsRef = useRef(hulls);
  hullsRef.current = hulls;
  const interactionRef = useRef<InteractionState>({
    selectedId,
    focusNodeId,
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
    if (!container || webglFailed) return;
    const graph = buildSigmaGraph(
      nodes,
      edges,
      positionsRef.current,
      positionNodeIdsRef.current,
      seedPositions,
      enriched,
    );
    graphRef.current = graph;
    try {
      const renderer = new Sigma<SigmaNodeAttributes, SigmaEdgeAttributes>(graph, container, {
        allowInvalidContainer: true,
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
          const emphasized = node === state.selectedId || node === state.focusNodeId || node === state.pathSourceId || overlayIds?.has(node);
          if (emphasized) {
            patch.borderColor = overlayIds?.has(node) ? graphTheme().warn : graphTheme().accent;
            patch.highlighted = true;
            patch.forceLabel = true;
            patch.size = data.size * 1.18;
          } else if (state.favoriteIds.has(node)) {
            patch.borderColor = graphTheme().warn;
            patch.forceLabel = true;
          }
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
      rendererRef.current = renderer;
      const hullCanvas = renderer.createCanvas("maru-hulls", { beforeLayer: "edges" });
      const drawHulls = () => {
        const context = hullCanvas.getContext("2d");
        if (!context) return;
        const dimensions = renderer.getDimensions();
        const ratio = dimensions.width > 0 ? hullCanvas.width / dimensions.width : 1;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, hullCanvas.width, hullCanvas.height);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        for (const hull of hullsRef.current) {
          const numbers = hull.path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
          if (numbers.length < 6) continue;
          context.beginPath();
          for (let index = 0; index + 1 < numbers.length; index += 2) {
            const point = renderer.graphToViewport({ x: numbers[index], y: numbers[index + 1] });
            if (index === 0) context.moveTo(point.x, point.y);
            else context.lineTo(point.x, point.y);
          }
          context.closePath();
          context.globalAlpha = 0.08;
          context.fillStyle = communityColor(hull.community);
          context.fill();
        }
        context.globalAlpha = 1;
      };
      renderer.on("afterRender", drawHulls);
      let contextRestored = false;
      let contextFallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const onContextLost = (event: Event) => {
        event.preventDefault();
        contextRestored = false;
        if (contextFallbackTimer) clearTimeout(contextFallbackTimer);
        contextFallbackTimer = setTimeout(() => {
          if (!contextRestored) setWebglFailed(true);
        }, 1_000);
      };
      const onContextRestored = () => {
        contextRestored = true;
        if (contextFallbackTimer) clearTimeout(contextFallbackTimer);
        contextFallbackTimer = null;
        renderer.refresh();
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
      const startLayout = (clearPins: boolean) => {
        stopLayout();
        if (clearPins) pinnedIdsRef.current.clear();
        if (graph.order < 2 || graph.size < 1) {
          snapshotPositions();
          return;
        }
        const settings = {
          ...inferSettings(graph.order),
          adjustSizes: true,
          barnesHutOptimize: graph.order >= 500,
          barnesHutTheta: 0.6,
          gravity: 1,
          slowDown: graph.order >= 5_000 ? 8 : 3,
        };
        const supervisor = new FA2LayoutSupervisor<SigmaNodeAttributes, SigmaEdgeAttributes>(graph, { settings });
        layoutRef.current = supervisor;
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
          if (stableSamples >= 3) {
            stopLayout();
            snapshotPositions();
          }
        }, 250);
        layoutTimeoutRef.current = setTimeout(() => {
          stopLayout();
          snapshotPositions();
        }, seedPositions && Object.keys(seedPositions).length > 0 ? 2_500 : 5_000);
        supervisor.start();
      };
      startLayoutRef.current = startLayout;
      const resolveNode = (id: string) => graph.hasNode(id) ? graph.getNodeAttribute(id, "node") : null;
      renderer.on("clickStage", () => callbacksRef.current.onSelect(null));
      renderer.on("clickNode", ({ node, event }) => {
        const item = resolveNode(node);
        if (!item || draggedRef.current?.moved) return;
        const original = event.original as MouseEvent;
        if (original.altKey) {
          pinnedIdsRef.current.delete(node);
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
        draggedRef.current = null;
        renderer.getCamera().enable();
        snapshotPositions();
      };
      mouse.on("mousemovebody", onMove);
      mouse.on("mouseup", onUp);
      renderer.getCamera().on("updated", (state) => callbacksRef.current.onViewportReport?.(1 / state.ratio));
      renderer.once("afterRender", () => setReady(true));
      // Re-run the force layout only when node ids or edge topology changed.
      // Metadata-only rescans and enrichment swaps keep the viewport stable.
      const topoSig = graphTopologySignature(nodes, edges);
      const positionsValid = positionsRef.current?.length === graph.order * 2
        && positionNodeIdsRef.current?.length === graph.order
        && nodes.every((node, index) => positionNodeIdsRef.current?.[index] === node.id);
      if (prevTopoSigRef.current === topoSig && positionsValid) {
        snapshotPositions();
      } else {
        startLayout(false);
      }
      prevTopoSigRef.current = topoSig;
      if (exportControllerRef) {
        exportControllerRef.current = {
          png: () => toBlob(renderer as unknown as Sigma, { backgroundColor: graphTheme().bg }),
          svg: () => graphToSvg(renderer),
        };
      }
      return () => {
        if (exportControllerRef) exportControllerRef.current = null;
        if (contextFallbackTimer) clearTimeout(contextFallbackTimer);
        rendererCanvases.forEach((canvas) => {
          canvas.removeEventListener("webglcontextlost", onContextLost);
          canvas.removeEventListener("webglcontextrestored", onContextRestored);
        });
        renderer.off("afterRender", drawHulls);
        startLayoutRef.current = null;
        stopLayout();
        mouse.off("mousemovebody", onMove);
        mouse.off("mouseup", onUp);
        renderer.kill();
        rendererRef.current = null;
        graphRef.current = null;
      };
    } catch (err) {
      console.error("[graph] WebGL renderer init failed — falling back to static render", err);
      // Sigma appends its canvases before validating — drop any orphans so
      // they can't sit above the fallback/overlay and swallow pointer events.
      container.replaceChildren();
      setWebglFailed(true);
      setReady(true);
      graphRef.current = null;
      rendererRef.current = null;
    }
  }, [nodes, edges, enriched, positionsRef, positionNodeIdsRef, seedPositions, exportControllerRef, webglFailed, themeEpoch]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer) renderer.scheduleRefresh();
  }, [selectedId, focusNodeId, pathSourceId, highlight, favoriteIds, visibleNodeIds]);

  useEffect(() => {
    if (layoutEpoch <= 0 || fittedEpochRef.current === layoutEpoch) return;
    fittedEpochRef.current = layoutEpoch;
    startLayoutRef.current?.(true);
    rendererRef.current?.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  }, [layoutEpoch]);

  useEffect(() => {
    if (!unpinSignal) return;
    pinnedIdsRef.current.delete(unpinSignal.id);
    startLayoutRef.current?.(false);
  }, [unpinSignal]);

  useEffect(() => {
    if (fitSignal > 0) void rendererRef.current?.getCamera().animatedReset({ duration: 180 });
  }, [fitSignal]);

  useEffect(() => {
    if (!zoomSignal) return;
    const camera = rendererRef.current?.getCamera();
    if (!camera) return;
    if (zoomSignal.dir === 1) void camera.animatedZoom({ duration: 100 });
    else void camera.animatedUnzoom({ duration: 100 });
  }, [zoomSignal]);

  useEffect(() => {
    if (!centerSignal) return;
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph?.hasNode(centerSignal.id)) return;
    const data = renderer.getNodeDisplayData(centerSignal.id);
    if (data) void renderer.getCamera().animate({ x: data.x, y: data.y }, { duration: 180 });
  }, [centerSignal]);

  const selectedLabel = selectedId && graphRef.current?.hasNode(selectedId)
    ? graphRef.current.getNodeAttribute(selectedId, "label")
    : null;
  const debugDomEnabled = useMemo(() => {
    try {
      const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
      return env?.DEV === true && localStorage.getItem("maru:e2e:graph-dom") === "1";
    } catch {
      return false;
    }
  }, []);
  const [debugHoverId, setDebugHoverId] = useState<string | null>(null);
  const [debugOffsets, setDebugOffsets] = useState<Record<string, [number, number]>>({});
  const debugDragRef = useRef<{ id: string; index: number; x: number; y: number; moved: boolean } | null>(null);
  const debugSuppressClickRef = useRef(false);
  const debugNodes = debugDomEnabled
    ? nodes.filter((node) => !visibleNodeIds || visibleNodeIds.has(node.id))
    : [];

  return (
    <div className="graph-canvas-wrap">
      {/* When the e2e DOM overlay is active it is the only surface allowed to
          render .graph-node elements — the static fallback would double them. */}
      {webglFailed && !debugDomEnabled ? (
        <StaticGraphFallback nodes={nodes} edges={edges} positions={positionsRef.current} enriched={enriched} onSelect={onSelect} onOpen={onOpen} />
      ) : (
        <div ref={containerRef} className="graph-canvas graph-webgl-canvas" data-testid="graph-canvas" role="application" aria-label="Knowledge graph" />
      )}
      {debugDomEnabled ? (
        <svg
          className={`graph-canvas graph-e2e-overlay${debugHoverId ? " has-hover" : ""}`}
          aria-hidden="true"
          onPointerMove={(event) => {
            const drag = debugDragRef.current;
            if (!drag) return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
            setDebugOffsets((current) => ({ ...current, [drag.id]: [dx, dy] }));
          }}
          onPointerUp={() => {
            debugSuppressClickRef.current = debugDragRef.current?.moved ?? false;
            debugDragRef.current = null;
          }}
          onPointerLeave={() => setDebugHoverId(null)}
        >
          <g className="graph-nodes labels-on">
            <g className="graph-hulls">
              {hulls.map((hull) => <path key={hull.community} className="graph-hull" d={hull.path} style={{ fill: communityColor(hull.community) }} />)}
            </g>
            {debugNodes.map((node, index) => {
              const baseX = 120 + (index % 5) * 150;
              const baseY = 130 + Math.floor(index / 5) * 130;
              const offset = debugOffsets[node.id] ?? [0, 0];
              const hovered = debugHoverId === node.id;
              const highlighted = debugHoverId ? adjacency.get(debugHoverId)?.has(node.id) : false;
              const className = [
                "graph-node",
                node.type === "unresolved" ? "ghost" : "",
                node.id === selectedId ? "selected" : "",
                node.id === focusNodeId ? "focus" : "",
                hovered ? "hovered" : "",
                highlighted ? "hl" : "",
              ].filter(Boolean).join(" ");
              const radius = nodeRadius(node.degree);
              return (
                <g key={node.id} className={className} transform={`translate(${baseX + offset[0]}, ${baseY + offset[1]})`}>
                  <circle
                    r={radius}
                    fill={nodeColor(node, enriched)}
                    data-node-id={node.id}
                    onPointerEnter={() => setDebugHoverId(node.id)}
                    onPointerDown={(event) => {
                      debugDragRef.current = { id: node.id, index, x: event.clientX, y: event.clientY, moved: false };
                    }}
                    onClick={(event) => {
                      if (debugSuppressClickRef.current) {
                        debugSuppressClickRef.current = false;
                        return;
                      }
                      if (event.altKey) onNodeUnpin(index);
                      else if (event.shiftKey) onPathTarget(node);
                      else onSelect(node);
                    }}
                    onDoubleClick={() => onOpen(node)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onNodeContextMenu?.(node, index, event.clientX, event.clientY);
                    }}
                  />
                  {favoriteIds.has(node.id) ? <text className="graph-node-star" dy={-(radius + 4)}>★</text> : null}
                  <text className="graph-node-label" dy={radius + 12}>{node.label}</text>
                </g>
              );
            })}
          </g>
        </svg>
      ) : null}
      <div className="sr-only" aria-live="polite">{selectedLabel ? `선택됨: ${selectedLabel}` : ""}</div>
      {!ready ? <div className="graph-canvas-loading" data-testid="graph-canvas-loading">…</div> : null}
      {overlay}
    </div>
  );
}
