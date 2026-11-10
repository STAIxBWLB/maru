import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  canvasGeometryDatasetId,
  canvasGeometryState,
  syncCanvasGeometry,
  subscribeCanvasGeometry,
  type CanvasGeometryState,
} from "../../../lib/diagram/engineCanvasGeometry";
import type { DiagramDoc } from "../../../lib/diagram/types";

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
