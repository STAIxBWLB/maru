/** Independent engine measurement facade. Product apply/render paths do not import this. */
import type { ValidationReport } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
export type { ValidationReport } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
export interface DiagramEngine {
  readonly transport: "ipc" | "wasm";
  validate(input: string): Promise<ValidationReport>;
}
function checkedReport(value: unknown): ValidationReport {
  if (!value || typeof value !== "object" || !("apiVersion" in value) || value.apiVersion !== 1
      || !("ok" in value) || typeof value.ok !== "boolean" || !("diagnostics" in value) || !Array.isArray(value.diagnostics)
      || !("receipt" in value) || !value.receipt || typeof value.receipt !== "object") {
    throw new Error("E0 engine returned an incompatible report; regenerate the Rust bindings and rebuild the spike.");
  }
  return value as ValidationReport;
}
export function createIpcEngine(): DiagramEngine {
  return { transport: "ipc", async validate(input) {
    const { invoke } = await import("@tauri-apps/api/core");
    return checkedReport(await invoke("plugin:maru-diagram|validate", { input }));
  } };
}
export async function loadWasmEngine(): Promise<DiagramEngine> {
  const moduleUrl = new URL("./__generated__/engine-e0/maru_diagram_engine.js", import.meta.url).href;
  const wasmUrl = new URL("./__generated__/engine-e0/maru_diagram_engine_bg.wasm", import.meta.url);
  const bindings = await import(/* @vite-ignore */ moduleUrl) as Record<string, unknown>;
  if (typeof bindings.default !== "function" || typeof bindings.validate_diagram_json !== "function") {
    throw new Error("E0 WebAssembly bindings are missing; run the engine-e0 build script before the browser spike.");
  }
  await bindings.default({ module_or_path: wasmUrl });
  const validate = bindings.validate_diagram_json as (input: string) => string;
  return { transport: "wasm", async validate(input) { return checkedReport(JSON.parse(validate(input))); } };
}
