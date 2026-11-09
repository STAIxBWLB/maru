/** Isolated E3 test facade; all SVG serialization and artifact gates stay in Rust/WASM. */
import type { Diagnostic, GeometryDocument } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
export interface SvgOptions { theme: "light" | "dark"; title: string; description: string }
export interface SvgReport { apiVersion: 1; ok: boolean; svg: string | null; diagnostics: Diagnostic[] }
export async function renderSvgForTest(geometry: GeometryDocument, options: SvgOptions): Promise<SvgReport> {
  if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") {
    throw new Error("Engine SVG rendering is disabled in this build; build the isolated E3 test library and retry.");
  }
  const moduleUrl = new URL("./__generated__/engine-render/maru_diagram_engine.js", import.meta.url).href;
  const wasmUrl = new URL("./__generated__/engine-render/maru_diagram_engine_bg.wasm", import.meta.url);
  const bindings = await import(/* @vite-ignore */ moduleUrl) as Record<string, unknown>;
  if (typeof bindings.default !== "function" || typeof bindings.render_scene_svg !== "function") {
    throw new Error("SVG WASM bindings are missing; rebuild engine-e0 wasm with the separate wasm-render feature and reload.");
  }
  await bindings.default({ module_or_path: wasmUrl });
  const render = bindings.render_scene_svg as (input: string) => string;
  let report: unknown;
  try { report = JSON.parse(render(JSON.stringify({ geometry, options }))); }
  catch { throw new Error("SVG request or report cannot be serialized; provide compatible geometry/options and rebuild matching WASM bindings."); }
  if (!report || typeof report !== "object" || !("apiVersion" in report) || report.apiVersion !== 1
      || !("ok" in report) || typeof report.ok !== "boolean" || !("diagnostics" in report) || !Array.isArray(report.diagnostics)
      || !("svg" in report) || (report.svg !== null && typeof report.svg !== "string") || (report.ok && typeof report.svg !== "string")) {
    throw new Error("SVG engine returned an incompatible report; rebuild the E3 WASM artifact and retry.");
  }
  return report as SvgReport;
}
