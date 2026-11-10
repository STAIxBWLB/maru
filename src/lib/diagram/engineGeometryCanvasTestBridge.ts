/** Isolated canvas preview consumer. No DiagramMode, document or history write.
 *
 * The scene mapping is the product one (`canvasGeometryOf`): this bridge only
 * lays out through the shared adapter and flattens the result for the isolated
 * probe, so the test library and the canvas cannot disagree on ids or units.
 */
import { canvasGeometryOf } from "./engineCanvasGeometry";
import { layoutCanvasRequest } from "./engineGeometryCanvas";
import type { GeometryEngine } from "./engineGeometry";
import type { DiagramDoc } from "./types";
import type { GeometryReport } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";

export interface EngineCanvasPreviewBox {
  id: string;
  sourceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface EngineCanvasPreview {
  report: GeometryReport;
  nodes: EngineCanvasPreviewBox[];
  containers: EngineCanvasPreviewBox[];
  labels: EngineCanvasPreviewBox[];
  routes: Array<{ id: string; sourceId: string; points: Array<{ x: number; y: number }> }>;
  page: { x: number; y: number; w: number; h: number } | null;
}

export async function previewEngineCanvasForTest(
  engine: Pick<GeometryEngine, "layout">,
  doc: DiagramDoc,
  datasetId: string,
): Promise<EngineCanvasPreview> {
  const dataset = doc.datasets?.find((item) => item.id === datasetId);
  if (!dataset || dataset.kind !== "semanticSpec") {
    throw new Error("Engine canvas preview needs a semantic dataset; choose an existing semantic dataset and retry the isolated test.");
  }
  const { report } = await layoutCanvasRequest(engine, doc, datasetId);
  const geometry = canvasGeometryOf(report, doc, dataset);
  if (!geometry) return { report, nodes: [], containers: [], labels: [], routes: [], page: null };
  const flatten = (role: "node" | "container"): EngineCanvasPreviewBox[] =>
    [...geometry.boxes.values()]
      .filter((box) => box.role === role)
      .map(({ id, sourceId, x, y, w, h }) => ({ id, sourceId, x, y, w, h }));
  return {
    report,
    nodes: flatten("node"),
    containers: flatten("container"),
    labels: [...geometry.labels.values()].flat().map((label) => ({
      id: label.id, sourceId: label.targetId,
      x: label.x, y: label.y, w: label.w, h: label.h,
    })),
    routes: [...geometry.routes.values()].map((route) => ({
      id: route.id, sourceId: route.sourceId,
      points: route.points.map((point) => ({ x: point.x, y: point.y })),
    })),
    page: geometry.page,
  };
}
