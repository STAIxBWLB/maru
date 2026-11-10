import type {
  Diagnostic,
  EngineReceipt,
  PinSet,
} from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";

export type EngineArtifactFormat = "svg" | "png";
export type EngineArtifactTheme = "light" | "dark";
export type EngineArtifactPurpose = "preview" | "export";
export type EngineArtifactTextMode = "text" | "outlines";

export interface EngineArtifactRequest {
  specJson: string;
  theme: EngineArtifactTheme;
  format: EngineArtifactFormat;
  pixelRatio?: number;
  pinSet?: PinSet | null;
  purpose?: EngineArtifactPurpose;
}

/** Mirrors Rust ArtifactReport plus the additive SVG text-mode proof. */
export interface EngineArtifactReport {
  apiVersion: 1;
  ok: boolean;
  bytes: number[] | null;
  svg: string | null;
  width: number | null;
  height: number | null;
  pixelsSha256?: string | null;
  diagnostics: Diagnostic[];
  receipt: EngineReceipt;
  textMode?: EngineArtifactTextMode;
  storeWarning?: string | null;
}

export type EngineArtifactHost = (inputJson: string) => Promise<unknown>;

/** Per-instance adapter injection is a unit-test seam, not a product global. */
export interface EngineArtifactPorts {
  renderSvgPreview?: EngineArtifactHost;
  renderSvgExport?: EngineArtifactHost;
  renderPng?: EngineArtifactHost;
}

export class EngineArtifactTransportError extends Error {
  readonly code: string;
  readonly nextStep: string;
  readonly diagnostics: Diagnostic[];

  constructor(payload: { code: string; message: string; nextStep: string; diagnostics: Diagnostic[] }) {
    const details = payload.diagnostics
      .map((diagnostic) => `${diagnostic.message} ${diagnostic.fix}`.trim())
      .filter(Boolean)
      .join(" ");
    super([payload.message, details, payload.nextStep].filter(Boolean).join(" "));
    this.name = "EngineArtifactTransportError";
    this.code = payload.code;
    this.nextStep = payload.nextStep;
    this.diagnostics = payload.diagnostics;
  }
}

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

function validReceiptShape(value: unknown): value is EngineReceipt {
  if (!record(value) || value.schemaVersion !== 1
      || typeof value.inputSpecSha256 !== "string" || !record(value.engine)
      || typeof value.engine.id !== "string" || typeof value.engine.version !== "string"
      || typeof value.engine.revision !== "string" || !record(value.gates)) return false;
  return [value.gates.schema, value.gates.artifact, value.gates.browser, value.gates.visualReview]
    .every((gate) => record(gate) && typeof gate.status === "string" && typeof gate.scope === "string");
}

/** Retained for the isolated test adapter; successful bytes still require verifyEngineArtifactReport. */
export function parseEngineArtifactReport(value: unknown): EngineArtifactReport {
  let report = value;
  if (typeof report === "string") {
    try {
      report = JSON.parse(report) as unknown;
    } catch {
      throw new Error("The Rust artifact adapter returned invalid JSON; update Maru and retry.");
    }
  }
  if (!record(report) || report.apiVersion !== 1 || typeof report.ok !== "boolean"
      || !(report.bytes === null || Array.isArray(report.bytes))
      || !(report.svg === null || typeof report.svg === "string")
      || !(report.width === null || (typeof report.width === "number" && Number.isFinite(report.width)))
      || !(report.height === null || (typeof report.height === "number" && Number.isFinite(report.height)))
      || !Array.isArray(report.diagnostics) || !report.diagnostics.every(validDiagnostic)
      || !validReceiptShape(report.receipt)
      || report.textMode !== undefined && report.textMode !== "text" && report.textMode !== "outlines"
      || report.storeWarning !== undefined && report.storeWarning !== null && typeof report.storeWarning !== "string") {
    throw new Error("The Rust artifact report has an incompatible shape; update Maru and retry.");
  }
  if (Array.isArray(report.bytes) && report.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("The Rust artifact report contains invalid byte values; update Maru and retry.");
  }
  if (report.ok && (report.bytes === null || report.svg === null || report.width === null || report.height === null)) {
    throw new Error("The Rust engine marked an incomplete artifact successful; update Maru and retry.");
  }
  if (!report.ok && (report.bytes !== null || report.svg !== null || report.width !== null || report.height !== null)) {
    throw new Error("The Rust engine returned artifact data with a refusal; update Maru and retry.");
  }
  return report as unknown as EngineArtifactReport;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function svgViewBox(svg: string): [number, number] | null {
  const root = /<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i.exec(svg);
  if (!root) return null;
  const values = root[1]!.trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))
      || values[2]! <= 0 || values[3]! <= 0) return null;
  return [values[2]!, values[3]!];
}

function validPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
}

function refusalError(diagnostics: readonly Diagnostic[]): Error {
  const details = diagnostics
    .map((diagnostic) => `${diagnostic.message.trim()} ${diagnostic.fix.trim()} (Rust diagnostic ${diagnostic.code} at ${diagnostic.path}).`)
    .join(" ");
  return new Error(details || "The Rust engine refused the artifact without an actionable diagnostic; repair the source and retry.");
}

/** Verify engine provenance and output hashes before a successful artifact reaches callers. */
export async function verifyEngineArtifactReport(
  input: EngineArtifactRequest,
  rawReport: unknown,
): Promise<EngineArtifactReport> {
  let report = parseEngineArtifactReport(rawReport);
  if (!report.ok) return report;

  const purpose = input.purpose ?? "export";
  const textMode = report.textMode ?? (purpose === "preview" && input.format === "svg" ? "text" : undefined);
  if (input.format === "svg" && purpose === "export" && textMode !== "outlines") {
    throw new Error("The engine did not report outlined SVG text; update Maru and retry the export.");
  }
  if (input.format === "svg" && purpose === "preview" && textMode !== "text") {
    throw new Error("The engine preview did not report text-mode SVG; update Maru and retry.");
  }
  if (input.format === "svg" && textMode === "outlines" && /<text(?:\s|>)/i.test(report.svg!)) {
    throw new Error("The engine reported outlined SVG text but emitted a text element; update Maru and retry.");
  }
  if (!Number.isInteger(report.width) || report.width! <= 0
      || !Number.isInteger(report.height) || report.height! <= 0) {
    throw new Error("The Rust engine returned invalid artifact pixel dimensions; reduce output size and retry.");
  }
  if (report.bytes!.length > 32 * 1024 * 1024) {
    throw new Error("The Rust engine returned artifact bytes above the 32 MiB transport limit; reduce output dimensions or pixel ratio and retry.");
  }

  const svgBytes = new TextEncoder().encode(report.svg!);
  const sourceHash = await sha256(new TextEncoder().encode(input.specJson));
  const svgHash = await sha256(svgBytes);
  const outputBytes = new Uint8Array(report.bytes!);
  const outputHash = await sha256(outputBytes);
  const receipt = report.receipt;
  const expectedMime = input.format === "svg" ? "image/svg+xml" : "image/png";
  const expectedArtifactScope = input.format === "svg"
    ? "independent-svg-artifact"
    : "independent-svg-and-png-artifacts";
  const source = JSON.parse(input.specJson) as { diagram_type?: unknown };
  const conversion = receipt.conversion;
  if (receipt.inputSpecSha256 !== sourceHash
      || receipt.engine.id !== "maru-diagram-engine"
      || !receipt.engine.version || !receipt.engine.revision
      || receipt.engineOutputSha256 !== svgHash
      || receipt.outputSha256 !== outputHash
      || receipt.outputMimeType !== expectedMime
      || !conversion || conversion.format !== input.format
      || conversion.theme !== input.theme
      || conversion.pixelRatio !== (input.pixelRatio ?? 1)
      || receipt.gates.schema.status !== "passed"
      || receipt.gates.schema.scope !== `${String(source.diagram_type)}-document-validity`
      || receipt.gates.artifact.status !== "passed"
      || receipt.gates.artifact.scope !== expectedArtifactScope
      || receipt.gates.browser.status !== "not-run"
      || receipt.gates.browser.scope !== "non-browser-rasterization"
      || receipt.gates.visualReview.status !== "not-run"
      || receipt.gates.visualReview.scope !== "manual"
      || receipt.readback?.status !== "not-run"
      || receipt.readback.scope !== "saved-file-byte-comparison") {
    throw new Error("The Rust receipt does not match the semantic source, engine artifact or required gates; update Maru and retry.");
  }

  if (input.format === "svg") {
    if (svgBytes.length !== outputBytes.length
        || svgBytes.some((byte, index) => byte !== outputBytes[index])) {
      throw new Error("The Rust SVG bytes differ from the receipt's returned SVG string; update Maru and retry.");
    }
    const viewBox = svgViewBox(report.svg!);
    const pixelRatio = input.pixelRatio ?? 1;
    if (!viewBox || Math.ceil(viewBox[0] * pixelRatio) !== report.width
        || Math.ceil(viewBox[1] * pixelRatio) !== report.height) {
      throw new Error("The Rust engine returned SVG dimensions that do not match its viewBox; update Maru and retry.");
    }
  } else if (!validPngSignature(outputBytes)) {
    throw new Error("The Rust PNG artifact has an invalid signature; update Maru and retry.");
  }
  // Export receipts contain the public v1 contract only. Transport diagnostics
  // and future private adapter fields must not become saved sidecar metadata.
  const gate = (value: EngineReceipt["gates"]["schema"]) => ({ status: value.status, scope: value.scope });
  const publicReceipt: EngineReceipt = {
    schemaVersion: receipt.schemaVersion,
    inputSpecSha256: receipt.inputSpecSha256,
    engine: { id: receipt.engine.id, version: receipt.engine.version, revision: receipt.engine.revision },
    engineOutputSha256: receipt.engineOutputSha256,
    outputSha256: receipt.outputSha256,
    outputMimeType: receipt.outputMimeType,
    conversion: conversion ? { format: conversion.format, theme: conversion.theme, pixelRatio: conversion.pixelRatio } : conversion,
    gates: {
      schema: gate(receipt.gates.schema), artifact: gate(receipt.gates.artifact),
      browser: gate(receipt.gates.browser), visualReview: gate(receipt.gates.visualReview),
    },
    readback: receipt.readback ? gate(receipt.readback) : receipt.readback,
  };
  for (const key of ["docId", "documentName", "documentRevision", "renderedAt", "diagramType", "datasetId"] as const) {
    if (receipt[key] !== undefined) publicReceipt[key] = receipt[key];
  }
  return { ...report, receipt: publicReceipt, ...(textMode ? { textMode } : {}) };
}

export async function renderEngineArtifact(
  input: EngineArtifactRequest,
  ports: EngineArtifactPorts = {},
): Promise<EngineArtifactReport> {
  if (typeof input.specJson !== "string" || !input.specJson.trim()) {
    throw new Error("The semantic source spec is missing; select a valid semantic dataset and retry.");
  }
  if (input.theme !== "light" && input.theme !== "dark") {
    throw new Error("The engine theme is invalid; choose light or dark and retry.");
  }
  if (input.format !== "svg" && input.format !== "png") {
    throw new Error("The engine artifact format is invalid; choose SVG or PNG and retry.");
  }
  const purpose = input.purpose ?? "export";
  if (purpose !== "preview" && purpose !== "export") {
    throw new Error("The engine artifact purpose is invalid; choose preview or export and retry.");
  }
  const pixelRatio = input.pixelRatio ?? 1;
  if (!Number.isInteger(pixelRatio) || pixelRatio < 1 || pixelRatio > 4
      || input.format === "svg" && pixelRatio !== 1) {
    throw new Error("SVG requires pixelRatio 1 and PNG requires an integer pixelRatio from 1 to 4; choose a supported output size and retry.");
  }
  const svgPreview = input.format === "svg" && purpose === "preview";
  const svgExport = input.format === "svg" && purpose === "export";
  const request: Record<string, unknown> = {
    specJson: input.specJson,
    theme: input.theme,
    format: input.format,
    pixelRatio,
    ...(input.pinSet ? { pinSet: input.pinSet } : {}),
    ...(svgExport ? { textMode: "outlines" } : {}),
  };
  let adapter: EngineArtifactHost;
  try {
    adapter = svgPreview
      ? ports.renderSvgPreview ?? await wasmSvgPreviewHost()
      : svgExport
        ? ports.renderSvgExport ?? await nativeRenderHost("render_svg")
        : ports.renderPng ?? await nativeRenderHost("render_png");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`The diagram engine renderer could not load: ${detail}; update Maru and retry.`);
  }
  let raw: unknown;
  try {
    raw = await adapter(JSON.stringify(request));
  } catch (cause) {
    throw normalizeTransportError(cause, input.format);
  }
  return verifyEngineArtifactReport({ ...input, pixelRatio, purpose }, raw);
}

let wasmSvgHostPromise: Promise<EngineArtifactHost> | undefined;
async function wasmSvgPreviewHost(): Promise<EngineArtifactHost> {
  wasmSvgHostPromise ??= (async () => {
    const [module, asset] = await Promise.all([
      import("./__generated__/engine-render/maru_diagram_engine.js"),
      import("./__generated__/engine-render/maru_diagram_engine_bg.wasm?url"),
    ]);
    const bindings = module as unknown as Record<string, unknown>;
    if (typeof bindings.default !== "function" || typeof bindings.render_artifact !== "function") {
      throw new Error("The SVG preview WASM binding is missing; update Maru and retry.");
    }
    await bindings.default({ module_or_path: asset.default });
    const render = bindings.render_artifact as (input: string) => string;
    return async (input: string) => render(input);
  })().catch((error) => {
    wasmSvgHostPromise = undefined;
    throw error;
  });
  return wasmSvgHostPromise;
}

async function nativeRenderHost(command: "render_svg" | "render_png"): Promise<EngineArtifactHost> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (input) => invoke(`plugin:maru-diagram|${command}`, { input });
}

function normalizeTransportError(cause: unknown, format: EngineArtifactFormat): Error {
  if (record(cause)
      && typeof cause.code === "string"
      && typeof cause.message === "string"
      && typeof cause.nextStep === "string") {
    if (cause.diagnostics !== undefined
        && (!Array.isArray(cause.diagnostics) || !cause.diagnostics.every(validDiagnostic))) {
      return new Error("The native PNG refusal contains malformed diagnostics; update Maru and retry.");
    }
    return new EngineArtifactTransportError({
      code: cause.code,
      message: cause.message,
      nextStep: cause.nextStep,
      diagnostics: (cause.diagnostics ?? []) as Diagnostic[],
    });
  }
  const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "invalid engine error payload";
  const fix = format === "png"
    ? "open this workspace in the Maru desktop app and retry the native PNG render"
    : "update Maru and retry the engine SVG render";
  return new Error(`The diagram artifact request failed: ${detail}; ${fix}.`);
}
