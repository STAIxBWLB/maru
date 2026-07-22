// Development-only observational bridge for real-Sigma e2e (replaces the old
// fake DOM overlay). Active only when import.meta.env.DEV AND
// localStorage["maru:e2e:graph-bridge"] === "1" — Vite drops DEV-gated code
// from production builds, and the flag keeps it off in normal dev sessions.

export interface MaruGraphBridge {
  /** Renderer lifecycle state ("loading" | "layout-running" | "ready" |
   *  "gpu-recovery" | "fallback" | "fatal"). */
  state(): string;
  containerSize(): { width: number; height: number };
  /** Container's bounding rect in PAGE coordinates (for mouse math). */
  containerRect(): { x: number; y: number; width: number; height: number };
  /** Frames rendered since renderer creation (afterRender counter). */
  frames(): number;
  camera(): { x: number; y: number; ratio: number };
  /** PAGE coordinates of a node's center (container-relative sigma viewport
   *  point + the container's bounding-rect origin), or null when the node is
   *  missing, hidden by filters, or has non-finite coordinates. */
  nodeViewportPoint(id: string): { x: number; y: number } | null;
  nodeScreenState(id: string): {
    visible: boolean;
    size: number | null;
    color: string | null;
    borderColor: string | null;
    favorite: boolean;
  };
  hoveredId(): string | null;
  layoutRunning(): boolean;
  /** Stop the FA2 supervisor (deterministic tests). */
  freezeLayout(): void;
  /** Restart FA2 from the current positions. */
  resumeLayout(): void;
  /** Fit the camera to the visible nodes, instantly (no animation). */
  fitView(): void;
  /** Dispatch webglcontextlost on the renderer canvases. */
  simulateContextLost(): void;
  graphStats(): { nodes: number; edges: number; visibleNodes: number };
}

declare global {
  interface Window {
    __maruGraph?: MaruGraphBridge;
  }
}

export function graphBridgeEnabled(): boolean {
  try {
    return (
      (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true &&
      typeof localStorage !== "undefined" &&
      localStorage.getItem("maru:e2e:graph-bridge") === "1"
    );
  } catch {
    return false;
  }
}
