/** Lazy E2 foundation. This module alone owns metric-WASM asset references. */
import type { Diagnostic, TextMetrics } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
export interface GeometryFoundation {
  measureText(text: string, weight: 400 | 700, size: number): TextMetrics;
}
export async function loadGeometryFoundation(): Promise<GeometryFoundation> {
  const moduleUrl = new URL("./__generated__/engine-geometry/maru_diagram_engine.js", import.meta.url).href;
  const wasmUrl = new URL("./__generated__/engine-geometry/maru_diagram_engine_bg.wasm", import.meta.url);
  const bindings = await import(/* @vite-ignore */ moduleUrl) as Record<string, unknown>;
  if (typeof bindings.default !== "function" || typeof bindings.measure_text_json !== "function") {
    throw new Error("Geometry metric bindings are missing; run node scripts/diagram-engine-e0.mjs wasm and reload the measurement page.");
  }
  await bindings.default({ module_or_path: wasmUrl });
  const measure = bindings.measure_text_json as (text: string, weight: number, size: number) => string;
  return { measureText(text, weight, size) {
    if (typeof text !== "string" || (weight !== 400 && weight !== 700)
        || !Number.isInteger(size) || size <= 0 || size > 2147483647) {
      throw new Error("Text metric arguments are outside the fixed-point font contract; use string text, weight 400 or 700, and a positive signed-32-bit size in 1/64 pixel units.");
    }
    const report = JSON.parse(measure(text, weight, size)) as { ok: boolean; metrics?: TextMetrics; diagnostic?: Diagnostic };
    if (!report.ok || !report.metrics) throw new Error(`${report.diagnostic?.message ?? "Font measurement failed"}; ${report.diagnostic?.fix ?? "rebuild the metric tables and retry"}.`);
    return report.metrics;
  } };
}
