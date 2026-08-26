import { useSyncExternalStore } from "react";

import type { DiagramActiveDocument, DiagramRecentDocument } from "../components/diagram/DiagramMode";

export type VisualModeDomain = "diagram" | "graph" | "sites";

export interface DiagramModeSlice {
  workPath: string | null;
  activeDocument: DiagramActiveDocument | null;
  recentDocuments: DiagramRecentDocument[];
}

export interface GraphModeSlice {
  focusNonce: number;
}

export interface SitesModeSlice {
  requestNonce: number;
}

interface VisualModeState {
  diagram: DiagramModeSlice;
  graph: GraphModeSlice;
  sites: SitesModeSlice;
}

const EMPTY_DIAGRAM_SLICE: DiagramModeSlice = {
  workPath: null,
  activeDocument: null,
  recentDocuments: [],
};

const INITIAL_STATE: VisualModeState = {
  diagram: EMPTY_DIAGRAM_SLICE,
  graph: { focusNonce: 0 },
  sites: { requestNonce: 0 },
};

export interface VisualModeController {
  subscribe(domain: VisualModeDomain, listener: () => void): () => void;
  getDiagramSlice(): DiagramModeSlice;
  setDiagramActiveDocument(slice: DiagramModeSlice): void;
}

/**
 * Visual surfaces have isolated subscriptions. The controller intentionally
 * publishes only the domain whose immutable slice changed, so a Diagram save
 * projection cannot re-execute Graph, Sites, or MainApp subscribers.
 */
export function createVisualModeController(): VisualModeController {
  let state = INITIAL_STATE;
  const listeners: Record<VisualModeDomain, Set<() => void>> = {
    diagram: new Set(),
    graph: new Set(),
    sites: new Set(),
  };

  const notify = (domain: VisualModeDomain) => {
    for (const listener of listeners[domain]) listener();
  };

  return {
    subscribe(domain, listener) {
      listeners[domain].add(listener);
      return () => listeners[domain].delete(listener);
    },
    getDiagramSlice() {
      return state.diagram;
    },
    setDiagramActiveDocument(slice) {
      const current = state.diagram;
      if (
        current.workPath === slice.workPath &&
        current.activeDocument === slice.activeDocument &&
        current.recentDocuments === slice.recentDocuments
      ) {
        return;
      }
      state = { ...state, diagram: slice };
      notify("diagram");
    },
  };
}

export const visualModeController = createVisualModeController();

export function useDiagramModeSlice(): DiagramModeSlice {
  return useSyncExternalStore(
    (listener) => visualModeController.subscribe("diagram", listener),
    () => visualModeController.getDiagramSlice(),
    () => EMPTY_DIAGRAM_SLICE,
  );
}
