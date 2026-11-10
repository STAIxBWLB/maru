import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  canvasDisplayNode,
  canvasGeometryDatasetId,
  canvasGeometryState,
  syncCanvasGeometry,
  subscribeCanvasGeometry,
  type CanvasGeometry,
  type CanvasGeometryState,
} from "../../../lib/diagram/engineCanvasGeometry";
import type { DiagramDoc, DiagramNode } from "../../../lib/diagram/types";

/**
 * Canvas-side read of the engine geometry store. Layouts run once per distinct
 * source/pin key, so an unrelated doc edit (a title, a selection, a viewport)
 * never re-requests the engine, and the lib stays free of React and of
 * component imports.
 */
export function useCanvasGeometry(doc: DiagramDoc): CanvasGeometryState {
  const datasetId = useMemo(() => canvasGeometryDatasetId(doc), [doc]);
  const subscribe = useCallback(
    (listener: () => void) => (datasetId ? subscribeCanvasGeometry(datasetId, listener) : () => {}),
    [datasetId],
  );
  const getSnapshot = useCallback(() => canvasGeometryState(datasetId), [datasetId]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    // The store publishes when the layout lands; the canvas draws what it has.
    if (datasetId) void syncCanvasGeometry(doc, datasetId);
  }, [datasetId, doc]);
  return state;
}

export interface CanvasDisplay {
  datasetId: string | null;
  geometry: CanvasGeometry | null;
  /** The doc nodes as the canvas paints them: the engine's box where it owns one. */
  nodes: DiagramNode[];
}

/**
 * What the canvas displays, for the chrome that acts on it: an inline editor,
 * fit view, find navigation and the property fields all must use the box on
 * screen, not the coarse slot the doc still stores under an engine member.
 */
export function useCanvasDisplay(doc: DiagramDoc): CanvasDisplay {
  const state = useCanvasGeometry(doc);
  const geometry = state.geometry;
  const nodes = useMemo(
    () => (geometry ? doc.nodes.map((node) => canvasDisplayNode(node, geometry)) : doc.nodes),
    [doc.nodes, geometry],
  );
  return useMemo(
    () => ({ datasetId: state.datasetId, geometry, nodes }),
    [geometry, nodes, state.datasetId],
  );
}
