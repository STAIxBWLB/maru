/** Isolated canvas preview consumer. No DiagramMode, document or history write. */
import { buildEngineCanvasLayoutRequest } from "./engineGeometryCanvas";
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
function pixels(value: number): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new Error("Engine canvas preview received an invalid fixed-point coordinate; rebuild the same SDK bindings and retry the isolated test.");
  }
  return value / 64;
}

export async function previewEngineCanvasForTest(
  engine: Pick<GeometryEngine, "layout">,
  doc: DiagramDoc,
  datasetId: string,
): Promise<EngineCanvasPreview> {
  const request = await buildEngineCanvasLayoutRequest(doc, datasetId);
  const dataset = doc.datasets?.find((item) => item.id === datasetId);
  if (!dataset || dataset.kind !== "semanticSpec") {
    throw new Error("Engine canvas preview needs a semantic dataset; choose an existing semantic dataset and retry the isolated test.");
  }
  const report = engine.layout(request);
  const canvasId = (sourceId: string, container = false) => {
    if (Object.hasOwn(dataset.idMap, sourceId)) return dataset.idMap[sourceId]!;
    if (!container) return sourceId;
    const memberId = `${datasetId}:${sourceId}`;
    return doc.nodes.find((node) => node.meta?.memberId === memberId)?.id ?? memberId;
  };
  const box = (id: string, sourceId: string, bounds: { x: number; y: number; width: number; height: number }) => ({
    id, sourceId, x: pixels(bounds.x), y: pixels(bounds.y), w: pixels(bounds.width), h: pixels(bounds.height),
  });
  const geometry = report.geometry;
  if (!geometry) return { report, nodes: [], containers: [], labels: [], routes: [], page: null };
  return {
    report,
    nodes: geometry.nodes.map((node) => box(canvasId(node.id), node.id, node.bounds)),
    containers: geometry.containers.map((container) => box(canvasId(container.id, true), container.id, container.bounds)),
    labels: geometry.labels.map((label, index) => box(label.id ?? `label:${index}`, label.targetId, label.bounds)),
    routes: geometry.routes.map((route, index) => ({
      id: route.id ?? `route:${index}`, sourceId: route.id ?? `route:${index}`,
      points: route.points.map((point) => ({ x: pixels(point.x), y: pixels(point.y) })),
    })),
    page: { x: pixels(geometry.page.bounds.x), y: pixels(geometry.page.bounds.y), w: pixels(geometry.page.bounds.width), h: pixels(geometry.page.bounds.height) },
  };
}
