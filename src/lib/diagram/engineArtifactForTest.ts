/** Test-only high-level Rust artifact adapter. Product Archify exports stay separate. */
import type {
  Diagnostic,
  EngineReceipt,
  PinSet,
} from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import {
  EngineArtifactTransportError,
  parseEngineArtifactReport,
  verifyEngineArtifactReport,
  type EngineArtifactFormat,
  type EngineArtifactHost,
  type EngineArtifactReport,
  type EngineArtifactRequest,
  type EngineArtifactTheme,
} from "./engineArtifact";
export {
  EngineArtifactTransportError,
  type EngineArtifactFormat,
  type EngineArtifactHost,
  type EngineArtifactPurpose,
  type EngineArtifactReport,
  type EngineArtifactRequest,
  type EngineArtifactTextMode,
  type EngineArtifactTheme,
} from "./engineArtifact";
import { canonicalSemanticExportInput } from "./export";
import { sanitizeEngineSvgArtifact, type StaticTheme } from "./engineSvg";
import type { DiagramDoc } from "./types";

export interface VerifiedEngineArtifactForTest { bytes: Uint8Array; svgForDom: string; receipt: EngineReceipt }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDiagnostic(value: unknown): value is Diagnostic {
  return record(value)
    && typeof value.code === "string"
    && typeof value.path === "string"
    && typeof value.rule === "string"
    && typeof value.message === "string"
    && typeof value.fix === "string";
}

async function loadWasmHost(format: EngineArtifactFormat): Promise<EngineArtifactHost> {
  const moduleUrl = format === "svg"
    ? new URL("./__generated__/engine-render/maru_diagram_engine.js", import.meta.url).href
    : new URL("./__generated__/engine-png/maru_diagram_engine.js", import.meta.url).href;
  const wasmUrl = format === "svg"
    ? new URL("./__generated__/engine-render/maru_diagram_engine_bg.wasm", import.meta.url)
    : new URL("./__generated__/engine-png/maru_diagram_engine_bg.wasm", import.meta.url);
  try {
    const bindings = await import(/* @vite-ignore */ moduleUrl) as Record<string, unknown>;
    if (typeof bindings.default !== "function" || typeof bindings.render_artifact !== "function") {
      throw new Error(`The ${format.toUpperCase()} engine WASM binding is missing render_artifact; rebuild its isolated generated artifact and retry.`);
    }
    await bindings.default({ module_or_path: wasmUrl });
    const render = bindings.render_artifact as (inputJson: string) => string;
    return async (inputJson) => render(inputJson);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`The isolated ${format.toUpperCase()} WASM could not load: ${detail}; rebuild its generated test artifact and retry.`);
  }
}

async function loadNativePngHost(): Promise<EngineArtifactHost> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (input) => invoke("plugin:maru-diagram|render_png", { input });
}

/** Preload the isolated module without running a scene; used by measured cold/warm exports. */
export async function prepareEngineArtifactForTest(format: EngineArtifactFormat): Promise<EngineArtifactHost> {
  if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") throw new Error("Engine artifact preload is disabled; use the isolated geometry test build.");
  if (format !== "svg" && format !== "png") throw new Error("Artifact format is invalid; choose svg or png.");
  return format === "svg" ? loadWasmHost("svg") : loadNativePngHost();
}

/** PNG/WASM is kept only for the isolated adapter measurement script. */
export async function prepareWasmArtifactForMeasurement(format: EngineArtifactFormat): Promise<EngineArtifactHost> {
  if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") throw new Error("WASM artifact measurement is disabled; use the isolated geometry test build.");
  if (format !== "svg" && format !== "png") throw new Error("Artifact format is invalid; choose svg or png.");
  return loadWasmHost(format);
}

/** Invoke the isolated source-to-artifact ABI; never accepts caller-built geometry. */
export async function renderEngineArtifactForTest(
  input: EngineArtifactRequest,
  host?: EngineArtifactHost,
): Promise<EngineArtifactReport> {
  if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") {
    throw new Error("Native engine artifact rendering is disabled in this build; use the isolated geometry test build.");
  }
  if (typeof input.specJson !== "string" || !input.specJson.trim()) {
    throw new Error("The semantic source spec is missing; select a valid stored semantic dataset and retry.");
  }
  if (input.theme !== "light" && input.theme !== "dark") {
    throw new Error("The engine theme is invalid; choose light or dark and retry.");
  }
  if (input.format === "svg" && input.pixelRatio !== undefined && input.pixelRatio !== 1) {
    throw new Error("SVG uses vector logical-pixel dimensions and requires pixelRatio 1; choose PNG for scaled raster output.");
  }
  if (input.format !== "svg" && input.format !== "png") {
    throw new Error("The engine artifact format is invalid; choose SVG or PNG and retry.");
  }
  const pixelRatio = input.pixelRatio ?? 1;
  if (!Number.isInteger(pixelRatio) || pixelRatio < 1 || pixelRatio > 4) {
    throw new Error("PNG pixel ratio must be an integer from 1 to 4; choose a supported ratio and retry.");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify({
      specJson: input.specJson,
      theme: input.theme,
      format: input.format,
      pixelRatio,
      ...(input.pinSet ? { pinSet: input.pinSet } : {}),
    });
  } catch {
    throw new Error("The Rust artifact request cannot be serialized; provide a valid pin set and semantic source.");
  }
  const adapter = host ?? (input.format === "svg" ? await loadWasmHost("svg") : await loadNativePngHost());
  let result: unknown;
  try {
    result = await adapter(encoded);
  } catch (cause) {
    if (record(cause)
        && typeof cause.code === "string"
        && typeof cause.message === "string"
        && typeof cause.nextStep === "string") {
      if (cause.diagnostics !== undefined
          && (!Array.isArray(cause.diagnostics) || !cause.diagnostics.every(validDiagnostic))) {
        throw new Error("The native PNG refusal contains malformed diagnostics; rebuild matching plugin bindings and retry.");
      }
      const diagnostics = (cause.diagnostics ?? []) as Diagnostic[];
      throw new EngineArtifactTransportError({
        code: cause.code,
        message: cause.message,
        nextStep: cause.nextStep,
        diagnostics,
      });
    }
    const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "invalid adapter error payload";
    const fix = input.format === "png"
      ? "use the native-e2e test build with the PNG plugin permission and retry"
      : "rebuild the matching isolated engine-render WASM artifact and retry";
    throw new Error(`The diagram artifact request failed: ${detail}; ${fix}.`);
  }
  return parseEngineArtifactReport(result);
}

/** Verify the complete native receipt before exposing returned bytes or SVG to a DOM. */
export async function exportVerifiedEngineArtifactForTest(input: {
  doc: DiagramDoc;
  datasetId?: string;
  format: EngineArtifactFormat;
  theme?: StaticTheme;
  pixelRatio?: number;
  pinSet?: PinSet;
  host?: EngineArtifactHost;
  isCurrent?: () => boolean;
}): Promise<VerifiedEngineArtifactForTest> {
  if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") {
    throw new Error("Native engine artifact export is disabled in this build; use the isolated geometry test build.");
  }
  const current = () => {
    if (input.isCurrent?.() === false) {
      throw new Error("The export was cancelled or its document changed; start a new export from the current diagram.");
    }
  };
  current();
  const canonical = canonicalSemanticExportInput(input.doc, input.datasetId);
  const theme = input.theme ?? "light";
  const pixelRatio = input.pixelRatio ?? 1;
  if (input.format === "svg" && pixelRatio !== 1) {
    throw new Error("SVG uses vector logical-pixel dimensions and requires pixelRatio 1; choose PNG for scaled raster output.");
  }
  const report = await renderEngineArtifactForTest({
    specJson: canonical.candidateJson,
    theme,
    format: input.format,
    pixelRatio,
    ...(input.pinSet ? { pinSet: input.pinSet } : {}),
  }, input.host);
  current();
  const verified = await verifyEngineArtifactReport({
    specJson: canonical.candidateJson,
    theme,
    format: input.format,
    pixelRatio,
    ...(input.pinSet ? { pinSet: input.pinSet } : {}),
    purpose: "preview",
  }, report);
  current();
  if (!verified.ok) {
    const diagnostic = verified.diagnostics[0];
    if (diagnostic && diagnostic.message.trim() && diagnostic.fix.trim()) {
      throw new Error(`${diagnostic.message} ${diagnostic.fix} (Rust diagnostic ${diagnostic.code} at ${diagnostic.path}).`);
    }
    throw new Error("The Rust engine refused the artifact without an actionable diagnostic; rebuild the matching engine-render or engine-png artifact and retry.");
  }
  if (!verified.bytes || !verified.svg) {
    throw new Error("The Rust engine marked an artifact successful without returning its bytes and SVG; rebuild the matching engine-render or engine-png artifact and retry.");
  }
  const bytes = new Uint8Array(verified.bytes);
  current();
  const svgForDom = sanitizeEngineSvgArtifact(verified.svg, theme);
  current();
  return { bytes, svgForDom, receipt: verified.receipt };
}
