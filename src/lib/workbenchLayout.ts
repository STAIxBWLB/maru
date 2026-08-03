import type { MaruAppMode, RightWorkbenchSurface } from "./settings";

export const DEFAULT_WORKBENCH_MIN_WIDTH = 608;
export const DOCUMENT_WORKBENCH_MIN_WIDTH = 736;
export const SPLIT_DOCUMENT_WORKBENCH_MIN_WIDTH = 736;

export const RIGHT_WORKBENCH_MODES: readonly Exclude<MaruAppMode, "pkm">[] = [
  "files",
  "inbox",
  "comms",
  "meetings",
  "tasks",
  "catalog",
  "studio",
  "e2e",
  "diagram",
  "sites",
  "graph",
  "drafts",
  "gap",
  "agents",
];

export interface WorkbenchPlacementInput {
  visibleAppMode: MaruAppMode;
  splitOpen: boolean;
  rightSurface: RightWorkbenchSurface;
  hasRightEditorTab: boolean;
}

export function availableRightWorkbenchSurface(
  surface: RightWorkbenchSurface,
  availability: { e2e: boolean; diagram: boolean },
): RightWorkbenchSurface {
  if (surface === "e2e" && !availability.e2e) return "editor";
  if (surface === "diagram" && !availability.diagram) return "editor";
  return surface;
}

export interface WorkbenchPlacement {
  rightOpen: boolean;
  rightEditorOpen: boolean;
  rightMode: Exclude<MaruAppMode, "pkm"> | null;
}

export interface RightSitesCloseInput {
  rightWorkbenchMode: Exclude<MaruAppMode, "pkm"> | null;
  focusedWorkbenchSide: "left" | "right";
  documentHasFocus: boolean;
}

export interface WorkbenchMinimumWidthInput {
  visibleAppMode: MaruAppMode;
  rightWorkbenchMode: Exclude<MaruAppMode, "pkm"> | null;
  editorSplitOpen: boolean;
}

/**
 * Minimum visual width reserved before a right-docked terminal gets its
 * preferred width. Docs and its source/preview preset share a balanced floor
 * so the side panes, editors, and an open terminal all remain usable.
 */
export function minimumWorkbenchWidth({
  visibleAppMode,
  rightWorkbenchMode,
  editorSplitOpen,
}: WorkbenchMinimumWidthInput): number {
  if (visibleAppMode !== "pkm" || rightWorkbenchMode !== null) {
    return DEFAULT_WORKBENCH_MIN_WIDTH;
  }
  return editorSplitOpen
    ? SPLIT_DOCUMENT_WORKBENCH_MIN_WIDTH
    : DOCUMENT_WORKBENCH_MIN_WIDTH;
}

/**
 * A native Sites child webview does not bubble focus into the React DOM.
 * Prefer it for close only when the right surface explicitly owns focus, or
 * when the main webview itself has lost focus to that native child.
 */
export function shouldCloseRightSites({
  rightWorkbenchMode,
  focusedWorkbenchSide,
  documentHasFocus,
}: RightSitesCloseInput): boolean {
  return (
    rightWorkbenchMode === "sites" &&
    (focusedWorkbenchSide === "right" || !documentHasFocus)
  );
}

/** Keeps every non-document workbench mounted in exactly one placement. */
export function resolveWorkbenchPlacement({
  visibleAppMode,
  splitOpen,
  rightSurface,
  hasRightEditorTab,
}: WorkbenchPlacementInput): WorkbenchPlacement {
  if (visibleAppMode !== "pkm" || !splitOpen) {
    return { rightOpen: false, rightEditorOpen: false, rightMode: null };
  }
  if (rightSurface === "editor") {
    const rightEditorOpen = hasRightEditorTab;
    return { rightOpen: rightEditorOpen, rightEditorOpen, rightMode: null };
  }
  return { rightOpen: true, rightEditorOpen: false, rightMode: rightSurface };
}
