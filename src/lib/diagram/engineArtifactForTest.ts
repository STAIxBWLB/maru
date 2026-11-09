/** Test-only high-level Rust artifact adapter. Product Archify exports stay separate. */
import type {
  Diagnostic,
  EngineReceipt,
  PinSet,
} from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { canonicalSemanticExportInput } from "./export";
import { sanitizeEngineSvgArtifact, type StaticTheme } from "./engineSvg";
import type { DiagramDoc } from "./types";

export type EngineArtifactFormat = "svg" | "png";
export type EngineArtifactTheme = "light" | "dark";

export interface EngineArtifactRequest {
  specJson: string;
  theme: EngineArtifactTheme;
  format: EngineArtifactFormat;
  pixelRatio?: number;
  pinSet?: PinSet;
}

export interface EngineArtifactReport {
  apiVersion: 1;
  ok: boolean;
  bytes: number[] | null;
  svg: string | null;
  width: number | null;
  height: number | null;
  diagnostics: Diagnostic[];
  receipt: EngineReceipt;
}

export type EngineArtifactHost = (inputJson: string) => Promise<unknown>;

export interface VerifiedEngineArtifactForTest { bytes: Uint8Array; svgForDom: string; receipt: EngineReceipt }

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReceipt(value: unknown): boolean {
  if (!record(value) || typeof value.schemaVersion !== "number"
      || typeof value.inputSpecSha256 !== "string" || !record(value.engine)
      || typeof value.engine.id !== "string" || typeof value.engine.version !== "string"
      || typeof value.engine.revision !== "string" || !record(value.gates)) return false;
  return [value.gates.schema, value.gates.artifact, value.gates.browser, value.gates.visualReview]
    .every((gate) => record(gate) && typeof gate.status === "string" && typeof gate.scope === "string");
}

function parseReport(value: unknown): EngineArtifactReport {
  let report = value;
  if (typeof report === "string") {
    try {
      report = JSON.parse(report) as unknown;
    } catch {
      throw new Error("The Rust artifact adapter returned invalid JSON; rebuild the matching engine-render or engine-png WASM asset.");
    }
  }
  if (!record(report) || report.apiVersion !== 1 || typeof report.ok !== "boolean"
      || !(report.bytes === null || Array.isArray(report.bytes))
      || !(report.svg === null || typeof report.svg === "string")
      || !(report.width === null || (typeof report.width === "number" && Number.isFinite(report.width)))
      || !(report.height === null || (typeof report.height === "number" && Number.isFinite(report.height)))
      || !Array.isArray(report.diagnostics) || !validReceipt(report.receipt)) {
    throw new Error("The Rust artifact report has an incompatible shape; rebuild the matching generated bindings.");
  }
  if (Array.isArray(report.bytes) && report.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("The Rust artifact report contains invalid byte values; update the engine WASM and retry.");
  }
  if (report.ok && (report.bytes === null || report.svg === null || report.width === null || report.height === null)) {
    throw new Error("The Rust engine marked an incomplete artifact successful; rebuild matching engine bindings.");
  }
  return report as unknown as EngineArtifactReport;
}

async function loadWasmHost(format: EngineArtifactFormat): Promise<EngineArtifactHost> {
  const moduleUrl = format === "svg"
    ? new URL("./__generated__/engine-render/maru_diagram_engine.js", import.meta.url).href
    : new URL("./__generated__/engine-png/maru_diagram_engine.js", import.meta.url).href;
  const wasmUrl = format === "svg"
    ? new URL("./__generated__/engine-render/maru_diagram_engine_bg.wasm", import.meta.url)
    : new URL("./__generated__/engine-png/maru_diagram_engine_bg.wasm", import.meta.url);
  const bindings = await import(/* @vite-ignore */ moduleUrl) as Record<string, unknown>;
  if (typeof bindings.default !== "function" || typeof bindings.render_artifact !== "function") {
    throw new Error(`The ${format.toUpperCase()} engine WASM binding is missing render_artifact; rebuild its isolated generated artifact and retry.`);
  }
  await bindings.default({ module_or_path: wasmUrl });
  const render = bindings.render_artifact as (inputJson: string) => string;
  return async (inputJson) => render(inputJson);
}

/** Preload the isolated module without running a scene; used by measured cold/warm exports. */
export async function prepareEngineArtifactForTest(format: EngineArtifactFormat): Promise<EngineArtifactHost> {
  if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") throw new Error("Engine artifact preload is disabled; use the isolated geometry test build.");
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
  const adapter = host ?? await loadWasmHost(input.format);
  let result: unknown;
  try {
    result = await adapter(encoded);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown adapter failure";
    throw new Error(`The native diagram artifact request failed: ${detail}; rebuild the matching isolated WASM artifact and retry.`);
  }
  return parseReport(result);
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
  const sourceBytes = new TextEncoder().encode(canonical.candidateJson);
  const candidateHash = await sha256(sourceBytes);
  current();
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
  if (!report.ok || !report.bytes || !report.svg || !Number.isInteger(report.width) || !report.width
      || !Number.isInteger(report.height) || !report.height || report.bytes.length > 32 * 1024 * 1024
      || report.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("The Rust engine refused the source or returned invalid artifact bytes; repair the semantic dataset and retry.");
  }
  const bytes = new Uint8Array(report.bytes);
  const svgBytes = new TextEncoder().encode(report.svg);
  if (input.format === "svg" && (bytes.length !== svgBytes.length || bytes.some((byte, index) => byte !== svgBytes[index]))) {
    throw new Error("The Rust SVG bytes differ from the receipt's returned SVG string; regenerate matching engine bindings.");
  }
  if (input.format === "png" && !(bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))) {
    throw new Error("The Rust PNG artifact has an invalid signature; rebuild the engine-png artifact and retry.");
  }
  const svgHash = await sha256(svgBytes);
  current();
  const outputHash = await sha256(bytes);
  current();
  const receipt = report.receipt;
  const expectedMime = input.format === "svg" ? "image/svg+xml" : "image/png";
  const expectedArtifactScope = input.format === "svg" ? "independent-svg-artifact" : "independent-svg-and-png-artifacts";
  const gates = receipt.gates;
  const conversion = receipt.conversion;
  if (receipt.schemaVersion !== 1 || receipt.inputSpecSha256 !== candidateHash
      || receipt.engine?.id !== "maru-diagram-engine" || !receipt.engine.version || !receipt.engine.revision
      || receipt.engineOutputSha256 !== svgHash || receipt.outputSha256 !== outputHash
      || receipt.outputMimeType !== expectedMime
      || !conversion || conversion.format !== input.format || conversion.theme !== theme || conversion.pixelRatio !== pixelRatio
      || gates.schema.status !== "passed" || gates.schema.scope !== `${canonical.diagramType}-document-validity`
      || gates.artifact.status !== "passed" || gates.artifact.scope !== expectedArtifactScope
      || gates.browser.status !== "not-run" || gates.browser.scope !== "non-browser-rasterization"
      || gates.visualReview.status !== "not-run" || gates.visualReview.scope !== "manual"
      || receipt.readback?.status !== "not-run" || receipt.readback.scope !== "saved-file-byte-comparison") {
    throw new Error("The Rust receipt does not match the semantic source, engine artifact or required gates; rebuild the matching native engine and retry.");
  }
  current();
  const svgForDom = sanitizeEngineSvgArtifact(report.svg, theme);
  current();
  return { bytes, svgForDom, receipt };
}
