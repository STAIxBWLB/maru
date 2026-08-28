import { useEffect, useState, type RefObject } from "react";

import type { EditorViewMode } from "../components/EditorPane";
import type { FileQueueItem } from "./types";
import type { RightPaneTab } from "./settings";
import {
  getOutlinePaneState,
  hydrateOutlinePaneState,
  setOutlineFileQueueCanApply,
  setOutlineFileQueueSelection,
  type OutlineExplorerSlice,
  type OutlinePaneScope,
  type OutlineSidebarSlice,
} from "./outlinePaneStore";

/** Keeps the queue facade aligned with the canonical queue and its write gate. */
export function useOutlineFileQueueLifecycle(
  scope: OutlinePaneScope,
  fileQueue: FileQueueItem[],
  canApply: boolean,
): void {
  useEffect(() => {
    setOutlineFileQueueCanApply(scope, canApply);
  }, [canApply, scope]);

  useEffect(() => {
    const ids = new Set(fileQueue.map((item) => item.id));
    const selected = getOutlinePaneState(scope).fileQueue.selectedFileQueueItemIds;
    const next = selected.filter((id) => ids.has(id));
    if (next.length !== selected.length) setOutlineFileQueueSelection(scope, next);
  }, [fileQueue, scope]);
}

/** Publishes immutable render slices after App has composed canonical sources. */
export function useOutlinePaneHydration(
  scope: OutlinePaneScope,
  sidebar: OutlineSidebarSlice,
  explorer: OutlineExplorerSlice,
): void {
  useEffect(() => {
    hydrateOutlinePaneState(scope, { sidebar, explorer });
  }, [explorer, scope, sidebar]);
}

interface ActiveOutlineLineOptions {
  outlineOpen: boolean;
  rightPaneTab: RightPaneTab;
  editorViewMode: EditorViewMode;
  focusedEditorGroup: "left" | "right";
  documentPath: string | undefined;
  leftTextareaRef: RefObject<HTMLTextAreaElement | null>;
  rightTextareaRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Owns the source-editor scroll subscription used by the Outline facade. The
 * selected line is transient UI state and deliberately never enters settings.
 */
export function useActiveOutlineLine({
  outlineOpen,
  rightPaneTab,
  editorViewMode,
  focusedEditorGroup,
  documentPath,
  leftTextareaRef,
  rightTextareaRef,
}: ActiveOutlineLineOptions): number | null {
  const [activeLine, setActiveLine] = useState<number | null>(null);

  useEffect(() => {
    if (!outlineOpen || rightPaneTab !== "outline" || editorViewMode !== "source") {
      setActiveLine(null);
      return;
    }
    const textarea = focusedEditorGroup === "right" ? rightTextareaRef.current : leftTextareaRef.current;
    if (!textarea) {
      setActiveLine(null);
      return;
    }
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight || "20") || 20;
    let frame = 0;
    const compute = () => {
      frame = 0;
      setActiveLine(Math.floor(textarea.scrollTop / lineHeight));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(compute);
    };
    compute();
    textarea.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      textarea.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [documentPath, editorViewMode, focusedEditorGroup, leftTextareaRef, outlineOpen, rightPaneTab, rightTextareaRef]);

  return activeLine;
}
