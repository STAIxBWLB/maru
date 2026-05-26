/**
 * Anchor diagram-mode domain types.
 *
 * The schema number {@link DIAGRAM_SCHEMA_VERSION} continues the source
 * standalone editor's numbering (last was v:6, this is v:7) so legacy JSON can
 * be migrated forward. See `persistence.ts` for the migrator chain.
 */

export const DIAGRAM_SCHEMA_VERSION = 7 as const;

export type DiagramId = string;
export type NodeId = string;
export type EdgeId = string;
export type LayerId = string;

export type EdgePort = "n" | "s" | "e" | "w";

export type NodeKind =
  | "simple"
  | "section"
  | "numbered"
  | "text"
  | "diamond"
  | "oval"
  | "hexagon"
  | "cylinder"
  | "callout"
  | "split-box"
  | "titled-box"
  | "table"
  | "image";

export interface NodeStyle {
  bg?: string;
  border?: string;
  fc?: string;
  bw?: number;
  br?: number;
  fs?: number;
  fw?: number;
  align?: "left" | "center" | "right";
}

export interface DiagramNode {
  id: NodeId;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  body?: string;
  bullets?: string[];
  layerId?: LayerId;
  locked?: boolean;
  hidden?: boolean;
  style?: NodeStyle;
  meta?: Record<string, unknown>;
}

export type EdgeRouteMode = "auto" | "straight";
export type EdgeArrowKind = "none" | "filled" | "open";
export type EdgeDash = "solid" | "dashed";

export interface DiagramEdge {
  id: EdgeId;
  fromNode: NodeId;
  fromPort: EdgePort;
  toNode: NodeId;
  toPort: EdgePort;
  routeMode?: EdgeRouteMode;
  arrowStart?: EdgeArrowKind;
  arrowEnd?: EdgeArrowKind;
  arrowSize?: number;
  dash?: EdgeDash;
  color?: string;
  width?: number;
  label?: string;
  midOff?: number;
}

export interface DiagramLayer {
  id: LayerId;
  name: string;
  visible: boolean;
  locked: boolean;
  order: number;
}

export interface DiagramDoc {
  v: typeof DIAGRAM_SCHEMA_VERSION;
  id: DiagramId;
  docTitle: string;
  createdAt: number;
  updatedAt: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  layers: DiagramLayer[];
  meta?: { author?: string; tags?: string[] };
}

export type Tool = "select" | "pan" | "connect" | "marquee";

export interface Viewport {
  zoom: number;
  px: number;
  py: number;
}

export interface Selection {
  nodes: Set<NodeId>;
  edges: Set<EdgeId>;
}

export interface DragState {
  startX: number;
  startY: number;
  movedX: number;
  movedY: number;
  nodeIds: NodeId[];
}

export interface UiState {
  gridOn: boolean;
  snapOn: boolean;
  snapSize: number;
  autoFitOn: boolean;
  smartGuideOn: boolean;
  focusMode: boolean;
  activeRibbon: RibbonTab;
}

export type RibbonTab =
  | "file"
  | "edit"
  | "view"
  | "insert"
  | "format"
  | "tools"
  | "info"
  | "arrow"
  | "table";

export interface EphemeralState {
  selection: Selection;
  viewport: Viewport;
  tool: Tool;
  drag: DragState | null;
  pendingConnect: { fromNodeId: NodeId; fromPort: EdgePort } | null;
  clipboard: { nodes: DiagramNode[]; edges: DiagramEdge[] } | null;
  history: { past: string[]; future: string[] };
  ui: UiState;
}

export interface DiagramStateRoot {
  doc: DiagramDoc;
  ephemeral: EphemeralState;
}

export function createEmptyDoc(id: DiagramId, now: number = Date.now()): DiagramDoc {
  return {
    v: DIAGRAM_SCHEMA_VERSION,
    id,
    docTitle: "",
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    layers: [{ id: "default", name: "default", visible: true, locked: false, order: 0 }],
  };
}

export function createInitialEphemeral(): EphemeralState {
  return {
    selection: { nodes: new Set(), edges: new Set() },
    viewport: { zoom: 1, px: 0, py: 0 },
    tool: "select",
    drag: null,
    pendingConnect: null,
    clipboard: null,
    history: { past: [], future: [] },
    ui: {
      gridOn: true,
      snapOn: true,
      snapSize: 10,
      autoFitOn: true,
      smartGuideOn: true,
      focusMode: false,
      activeRibbon: "edit",
    },
  };
}
