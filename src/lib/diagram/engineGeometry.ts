import wasmUrl from "./__generated__/engine-geometry/maru_diagram_engine_bg.wasm?url";
import initializeGeometry, * as geometryBindings from "./__generated__/engine-geometry/maru_diagram_engine.js";
/** Lazy product layout/metrics. This module alone owns geometry-WASM asset references. */
import type { Diagnostic, TextMetrics, GeometryReport, LayoutRequest } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import type { DiagramDoc } from "./types";
import type { EngineCanvasPreview } from "./engineGeometryCanvasTestBridge";
export interface GeometryFoundation {
  measureText(text: string, weight: 400 | 700, size: number): TextMetrics;
}
export interface GeometryEngine extends GeometryFoundation {
  layout(input: LayoutRequest): GeometryReport;
  renderSvgForTest(geometry: import("../../../src-tauri/crates/maru-diagram-engine/bindings/engine").GeometryDocument, options: import("./engineSvgForTest").SvgOptions, specJson: string): Promise<import("./engineSvgForTest").SvgReport>;
  /** Available only in the separately built isolated test library. */
  layoutCanvasForTest(doc: DiagramDoc, datasetId: string): Promise<EngineCanvasPreview>;
}
export async function loadGeometryEngine(): Promise<GeometryEngine> {
  const bindings = geometryBindings as unknown as Record<string, unknown>;
  if (typeof bindings.default !== "function" || typeof bindings.measure_text_json !== "function" || typeof bindings.layout_json !== "function") {
    throw new Error("The diagram layout module is unavailable; reload Maru, or update the app and retry.");
  }
  await initializeGeometry({ module_or_path: wasmUrl });
  const measure = bindings.measure_text_json as (text: string, weight: number, size: number) => string;
  const layout = bindings.layout_json as (input: string) => string;
  const engine: GeometryEngine = { async renderSvgForTest(geometry, options, specJson) {
    if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") throw new Error("SVG preview is disabled; build the isolated E3 test library and retry.");
    const { renderSvgForTest } = await import("./engineSvgForTest");
    return renderSvgForTest(geometry, options, specJson);
  }, async layoutCanvasForTest(doc, datasetId) {
    if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") {
      throw new Error("Engine canvas preview is disabled in this build; build the isolated engine-e0 test library with VITE_ENGINE_GEOMETRY_TEST=1 and retry.");
    }
    const { previewEngineCanvasForTest } = await import("./engineGeometryCanvasTestBridge");
    return previewEngineCanvasForTest(engine, doc, datasetId);
  }, layout(input) {
    let encoded: string;
    try { encoded = JSON.stringify(input); }
    catch { throw new Error("Layout input cannot be serialized; provide an acyclic LayoutRequest with finite fixed-point pins and retry."); }
    if (typeof encoded !== "string") throw new Error("Layout input is missing; provide a LayoutRequest with specJson and retry.");
    let value: unknown;
    try { value = JSON.parse(layout(encoded)); }
    catch { throw new Error("Geometry engine returned invalid JSON; rebuild compatible WASM bindings and reload the test page."); }
    if (!value || typeof value !== "object" || !("apiVersion" in value) || value.apiVersion !== 1
        || !("ok" in value) || typeof value.ok !== "boolean" || !("diagnostics" in value) || !Array.isArray(value.diagnostics)
        || !("receipt" in value) || !value.receipt || typeof value.receipt !== "object"
        || ((value.ok || ("geometry" in value && value.geometry != null)) && (!("geometry" in value) || !value.geometry || typeof value.geometry !== "object"
          || !("nodes" in value.geometry) || !Array.isArray(value.geometry.nodes)
          || !("routes" in value.geometry) || !Array.isArray(value.geometry.routes)))) {
      throw new Error("Geometry engine returned an incompatible scene report; regenerate bindings and rebuild the same SDK revision.");
    }
    return value as GeometryReport;
  }, measureText(text, weight, size) {
    if (typeof text !== "string" || (weight !== 400 && weight !== 700)
        || !Number.isInteger(size) || size <= 0 || size > 2147483647) {
      throw new Error("Text metric arguments are outside the fixed-point font contract; use string text, weight 400 or 700, and a positive signed-32-bit size in 1/64 pixel units.");
    }
    const report = JSON.parse(measure(text, weight, size)) as { ok: boolean; metrics?: TextMetrics; diagnostic?: Diagnostic };
    if (!report.ok || !report.metrics) throw new Error(`${report.diagnostic?.message ?? "Font measurement failed"}; ${report.diagnostic?.fix ?? "rebuild the metric tables and retry"}.`);
    return report.metrics;
  } };
  return engine;
}

/** S1 compatibility name; both calls share the same lazy geometry artifact. */
export const loadGeometryFoundation = loadGeometryEngine;
