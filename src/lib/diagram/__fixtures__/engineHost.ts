/** Node-only test fixture that initializes the generated E1 and geometry WASM artifacts. */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import type {
  GeometryReport,
  LayoutRequest,
  ValidationReport,
} from "../../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { createProductDiagramEngine } from "../engine";

type WasmBindings = {
  default(options: { module_or_path: Uint8Array }): Promise<unknown>;
  validate_diagram_json?: (input: string) => string;
  layout_json?: (input: string) => string;
  layout_floorplan_json?: (input: string) => string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadBindings(directory: "engine-e0" | "engine-geometry"): Promise<WasmBindings> {
  const modulePath = fileURLToPath(new NodeURL(`../__generated__/${directory}/maru_diagram_engine.js`, import.meta.url));
  const wasmPath = fileURLToPath(new NodeURL(`../__generated__/${directory}/maru_diagram_engine_bg.wasm`, import.meta.url));
  let wasm: Uint8Array;
  try {
    wasm = new Uint8Array(readFileSync(wasmPath));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Generated ${directory} WASM binary is missing or unreadable: ${detail}; run node scripts/diagram-engine-e0.mjs wasm and retry.`);
  }
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(modulePath).href);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Generated ${directory} WASM binding could not load: ${detail}; regenerate it with node scripts/diagram-engine-e0.mjs wasm and retry.`);
  }
  const bindings = loaded as WasmBindings;
  if (typeof bindings.default !== "function") {
    throw new Error(`Generated ${directory} WASM initializer is missing; run node scripts/diagram-engine-e0.mjs wasm and retry.`);
  }
  await bindings.default({ module_or_path: wasm });
  return bindings;
}

function parseReport<T>(raw: string, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Generated ${label} WASM returned invalid JSON; rebuild its matching bindings and retry.`);
  }
  if (!record(value)) throw new Error(`Generated ${label} WASM returned an incompatible report; rebuild its matching bindings and retry.`);
  return value as T;
}

let enginePromise: Promise<ReturnType<typeof createProductDiagramEngine>> | undefined;

async function loadFixtureEngine(): Promise<ReturnType<typeof createProductDiagramEngine>> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [validation, geometry] = await Promise.all([
        loadBindings("engine-e0"),
        loadBindings("engine-geometry"),
      ]);
      if (typeof validation.validate_diagram_json !== "function" || typeof geometry.layout_json !== "function"
          || typeof geometry.layout_floorplan_json !== "function") {
        throw new Error("Generated diagram WASM exports are incomplete; run node scripts/diagram-engine-e0.mjs wasm and retry.");
      }
      const validate = validation.validate_diagram_json;
      const layout = geometry.layout_json;
      const layoutFloorplan = geometry.layout_floorplan_json;
      return createProductDiagramEngine({
        async validate(input: string): Promise<ValidationReport> {
          return parseReport<ValidationReport>(validate(input), "E1 validation");
        },
        layout(request: LayoutRequest): GeometryReport {
          return parseReport<GeometryReport>(layout(JSON.stringify(request)), "geometry layout");
        },
        layoutFloorplan(request: LayoutRequest): GeometryReport {
          return parseReport<GeometryReport>(layoutFloorplan(JSON.stringify(request)), "floorplan layout");
        },
        async render() {
          throw new Error("Rendering is outside the semantic admission fixture; use the native artifact adapter tests.");
        },
      });
    })().catch((error) => {
      enginePromise = undefined;
      throw error;
    });
  }
  return enginePromise;
}

export const pinnedEngineHost = {
  async validateCandidate(diagramType: string, spec: unknown) {
    return (await loadFixtureEngine()).validateCandidate(diagramType, spec);
  },
};
