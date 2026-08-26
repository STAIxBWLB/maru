import { useSyncExternalStore } from "react";

import type { DraftGraphFocusRequest } from "./draftGraphRelations";
import type { EditorViewMode } from "../components/DocumentModeSurface";
import type { SortKey } from "./settings";
import { visualModeController } from "./visualModeStore";

export type KnowledgeModeDomain = "scratchpad" | "drafts" | "gap";

export interface ScratchpadModeSlice {
  workspacePath: string | null;
  sortKey: SortKey;
  listHeight: number;
  listWidth: number;
  treeOpen: boolean;
  treeWidth: number;
  expandedFolders: readonly string[];
  editorViewMode: EditorViewMode;
  refreshRequestEpoch: number;
}

export interface DraftsModeSlice {
  workspacePath: string | null;
}

export interface GapModeSlice {
  workspacePath: string | null;
  initialDraftId: string | null;
  initialDraftRequest: number;
}

export interface KnowledgeModeController {
  subscribe(domain: KnowledgeModeDomain, listener: () => void): () => void;
  getScratchpadSlice(): ScratchpadModeSlice;
  getDraftsSlice(): DraftsModeSlice;
  getGapSlice(): GapModeSlice;
  setScratchpadWorkspace(workspacePath: string | null): number;
  setScratchpadSettings(settings: Omit<ScratchpadModeSlice, "workspacePath" | "refreshRequestEpoch">): void;
  publishScratchpadForWorkspace(
    generation: number,
    patch: Partial<Omit<ScratchpadModeSlice, "workspacePath">>,
  ): boolean;
  requestScratchpadRefresh(): void;
  setDraftsWorkspace(workspacePath: string | null): void;
  setGapWorkspace(workspacePath: string | null): void;
  requestGapDraft(draftId: string): void;
  consumeGapDraft(request: number): void;
  openGraphReference(
    source: "drafts" | "gap",
    request: DraftGraphFocusRequest,
    docRoot: string | null,
  ): boolean;
  clearGraphReference(source: "drafts" | "gap"): void;
}

const EMPTY_SCRATCHPAD: ScratchpadModeSlice = Object.freeze({
  workspacePath: null,
  sortKey: "modifiedDesc",
  listHeight: 320,
  listWidth: 320,
  treeOpen: true,
  treeWidth: 240,
  expandedFolders: Object.freeze([]),
  editorViewMode: "rich",
  refreshRequestEpoch: 0,
});
const EMPTY_DRAFTS: DraftsModeSlice = Object.freeze({ workspacePath: null });
const EMPTY_GAP: GapModeSlice = Object.freeze({
  workspacePath: null,
  initialDraftId: null,
  initialDraftRequest: 0,
});

function sameScratchpad(left: ScratchpadModeSlice, right: ScratchpadModeSlice): boolean {
  return left.workspacePath === right.workspacePath &&
    left.sortKey === right.sortKey &&
    left.listHeight === right.listHeight &&
    left.listWidth === right.listWidth &&
    left.treeOpen === right.treeOpen &&
    left.treeWidth === right.treeWidth &&
    left.expandedFolders === right.expandedFolders &&
    left.editorViewMode === right.editorViewMode &&
    left.refreshRequestEpoch === right.refreshRequestEpoch;
}

/**
 * Shell-owned knowledge-mode intents are isolated by mode domain. Filesystem
 * documents, draft approval, autosave, watchers, and editor state deliberately
 * remain inside their canonical stores or components.
 */
export function createKnowledgeModeController(): KnowledgeModeController {
  const listeners: Record<KnowledgeModeDomain, Set<() => void>> = {
    scratchpad: new Set(),
    drafts: new Set(),
    gap: new Set(),
  };
  let scratchpad = EMPTY_SCRATCHPAD;
  let drafts = EMPTY_DRAFTS;
  let gap = EMPTY_GAP;
  let scratchpadWorkspaceGeneration = 0;

  const notify = (domain: KnowledgeModeDomain) => {
    for (const listener of listeners[domain]) listener();
  };
  const publishScratchpad = (next: ScratchpadModeSlice) => {
    if (sameScratchpad(scratchpad, next)) return;
    scratchpad = Object.freeze(next);
    notify("scratchpad");
  };
  const publishDrafts = (next: DraftsModeSlice) => {
    if (drafts.workspacePath === next.workspacePath) return;
    drafts = Object.freeze(next);
    notify("drafts");
  };
  const publishGap = (next: GapModeSlice) => {
    if (
      gap.workspacePath === next.workspacePath &&
      gap.initialDraftId === next.initialDraftId &&
      gap.initialDraftRequest === next.initialDraftRequest
    ) return;
    gap = Object.freeze(next);
    notify("gap");
  };

  return {
    subscribe(domain, listener) {
      listeners[domain].add(listener);
      return () => listeners[domain].delete(listener);
    },
    getScratchpadSlice: () => scratchpad,
    getDraftsSlice: () => drafts,
    getGapSlice: () => gap,
    setScratchpadWorkspace(workspacePath) {
      scratchpadWorkspaceGeneration += 1;
      publishScratchpad({ ...scratchpad, workspacePath });
      return scratchpadWorkspaceGeneration;
    },
    setScratchpadSettings(settings) {
      publishScratchpad({ ...scratchpad, ...settings });
    },
    publishScratchpadForWorkspace(generation, patch) {
      if (generation !== scratchpadWorkspaceGeneration) return false;
      publishScratchpad({ ...scratchpad, ...patch });
      return true;
    },
    requestScratchpadRefresh() {
      publishScratchpad({ ...scratchpad, refreshRequestEpoch: scratchpad.refreshRequestEpoch + 1 });
    },
    setDraftsWorkspace(workspacePath) {
      publishDrafts({ workspacePath });
    },
    setGapWorkspace(workspacePath) {
      publishGap({ ...gap, workspacePath });
    },
    requestGapDraft(draftId) {
      publishGap({ ...gap, initialDraftId: draftId, initialDraftRequest: gap.initialDraftRequest + 1 });
    },
    consumeGapDraft(request) {
      if (request !== gap.initialDraftRequest || gap.initialDraftId === null) return;
      publishGap({ ...gap, initialDraftId: null });
    },
    openGraphReference(source, request, docRoot) {
      if (!docRoot || request.nodePaths.length === 0) return false;
      visualModeController.setGraphReferenceFocus({
        source,
        docPath: request.docPath,
        docRoot,
        nodePaths: request.nodePaths,
        steps: [{ paragraph: 0, nodePaths: request.nodePaths }],
        nonce: Date.now(),
      });
      return true;
    },
    clearGraphReference(source) {
      if (visualModeController.getGraphModeSlice().referenceFocus?.source === source) {
        visualModeController.setGraphReferenceFocus(null);
      }
    },
  };
}

export const knowledgeModeController = createKnowledgeModeController();

function useSlice<T>(domain: KnowledgeModeDomain, getSnapshot: () => T): T {
  return useSyncExternalStore(
    (listener) => knowledgeModeController.subscribe(domain, listener),
    getSnapshot,
    getSnapshot,
  );
}

export function useScratchpadModeSlice(): ScratchpadModeSlice {
  return useSlice("scratchpad", knowledgeModeController.getScratchpadSlice);
}

export function useDraftsModeSlice(): DraftsModeSlice {
  return useSlice("drafts", knowledgeModeController.getDraftsSlice);
}

export function useGapModeSlice(): GapModeSlice {
  return useSlice("gap", knowledgeModeController.getGapSlice);
}
