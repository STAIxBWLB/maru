import { useEffect, useRef, useSyncExternalStore } from "react";

import type { DiagramActiveDocument, DiagramRecentDocument } from "../components/diagram/DiagramMode";
import {
  buildSiteViewOpenRequests,
  subscribeSiteViewOpenRequests,
  unroutedSiteViewOpenRequestId,
  type SiteViewOpenRequest,
} from "./siteView";
import type { GraphOpenTarget } from "./settings";

export type VisualModeDomain = "diagram" | "graph" | "sites";

export interface DiagramModeSlice {
  workPath: string | null;
  activeDocument: DiagramActiveDocument | null;
  recentDocuments: DiagramRecentDocument[];
}

export interface GraphModeSlice {
  focusTarget: GraphOpenTarget | null;
  referenceFocus: {
    source: "editor" | "drafts" | "gap";
    docPath: string;
    docRoot: string;
    nodePaths: string[];
    steps: Array<{ paragraph: number; nodePaths: string[] }>;
    nonce: number;
  } | null;
}

export interface SitesModeSlice {
  openedUrls: readonly SiteViewOpenRequest[];
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
  graph: { focusTarget: null, referenceFocus: null },
  sites: { openedUrls: [] },
};

export interface VisualModeController {
  subscribe(domain: VisualModeDomain, listener: () => void): () => void;
  getDiagramSlice(): DiagramModeSlice;
  getGraphModeSlice(): GraphModeSlice;
  getSitesModeSlice(): SitesModeSlice;
  setDiagramActiveDocument(slice: DiagramModeSlice): void;
  setGraphFocusTarget(target: GraphOpenTarget | null): void;
  setGraphReferenceFocus(focus: GraphModeSlice["referenceFocus"]): void;
  enqueueSiteUrls(urls: unknown): void;
  acknowledgeSiteUrls(ids: readonly number[]): void;
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
    getGraphModeSlice() {
      return state.graph;
    },
    getSitesModeSlice() {
      return state.sites;
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
    setGraphFocusTarget(focusTarget) {
      if (state.graph.focusTarget === focusTarget) return;
      state = { ...state, graph: { ...state.graph, focusTarget } };
      notify("graph");
    },
    setGraphReferenceFocus(referenceFocus) {
      if (state.graph.referenceFocus === referenceFocus) return;
      state = { ...state, graph: { ...state.graph, referenceFocus } };
      notify("graph");
    },
    enqueueSiteUrls(urls) {
      const nextId = state.sites.openedUrls.at(-1)?.id ?? 0;
      const batch = buildSiteViewOpenRequests(urls, nextId);
      if (batch.requests.length === 0) return;
      state = { ...state, sites: { openedUrls: [...state.sites.openedUrls, ...batch.requests] } };
      notify("sites");
    },
    acknowledgeSiteUrls(ids) {
      const handled = new Set(ids);
      const openedUrls = state.sites.openedUrls.filter((request) => !handled.has(request.id));
      if (openedUrls.length === state.sites.openedUrls.length) return;
      state = { ...state, sites: { openedUrls } };
      notify("sites");
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

export function useGraphModeSlice(): GraphModeSlice {
  return useSyncExternalStore(
    (listener) => visualModeController.subscribe("graph", listener),
    () => visualModeController.getGraphModeSlice(),
    () => INITIAL_STATE.graph,
  );
}

export function useSitesModeSlice(): SitesModeSlice {
  return useSyncExternalStore(
    (listener) => visualModeController.subscribe("sites", listener),
    () => visualModeController.getSitesModeSlice(),
    () => INITIAL_STATE.sites,
  );
}

/** Keeps native URL-event subscription and one-shot routing outside MainApp. */
export function SitesOpenRequestBridge({
  booting,
  visibleMode,
  rightWorkbenchMode,
  openPrimary,
  openRight,
}: {
  booting: boolean;
  visibleMode: string;
  rightWorkbenchMode: string | null;
  openPrimary(mode: "sites"): void;
  openRight(mode: "sites"): void;
}) {
  const { openedUrls } = useSitesModeSlice();
  const routedRequestId = useRef(0);

  useEffect(() => {
    if (booting) return;
    return subscribeSiteViewOpenRequests(visualModeController.enqueueSiteUrls);
  }, [booting]);

  useEffect(() => {
    const requestId = unroutedSiteViewOpenRequestId(openedUrls, routedRequestId.current);
    if (requestId === null) return;
    routedRequestId.current = requestId;
    if (visibleMode === "pkm") {
      if (rightWorkbenchMode !== "sites") openRight("sites");
      return;
    }
    if (visibleMode !== "sites") openPrimary("sites");
  }, [openedUrls, openPrimary, openRight, rightWorkbenchMode, visibleMode]);

  return null;
}
