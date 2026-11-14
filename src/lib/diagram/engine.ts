import wasmUrl from "./__generated__/engine-e0/maru_diagram_engine_bg.wasm?url";
import initializeValidation, * as validationBindings from "./__generated__/engine-e0/maru_diagram_engine.js";
/** Product entry for engine validation, layout, rendering and render history. */
import type { ValidationReport } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
export type { ValidationReport } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import type {
  Diagnostic,
  EngineReceipt,
  GeometryReport,
  LayoutRequest,
} from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import type { EngineArtifactReport, EngineArtifactRequest } from "./engineArtifact";
import { productEngineLoadError } from "./engineUnavailable";
export { EngineUnavailableError, isEngineUnavailable } from "./engineUnavailable";
import type { SemanticDiagramType } from "./reportTypes";
import type { ValidationDiagnostic } from "./validation";
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function createIpcEngine(): DiagramEngine {
  return { transport: "ipc", async validate(input) {
    const { invoke } = await import("@tauri-apps/api/core");
    return checkedReport(await invoke("plugin:maru-diagram|validate", { input }));
  } };
}
export async function loadWasmEngine(): Promise<DiagramEngine> {
  const bindings = validationBindings as unknown as Record<string, unknown>;
  if (typeof bindings.default !== "function" || typeof bindings.validate_diagram_json !== "function") {
    throw new Error("The diagram validation module is unavailable; reload Maru, or update the app and retry.");
  }
  await initializeValidation({ module_or_path: wasmUrl });
  const validate = bindings.validate_diagram_json as (input: string) => string;
  return { transport: "wasm", async validate(input) { return checkedReport(JSON.parse(validate(input))); } };
}

/** Loading validation never imports the geometry/metric asset module. */
export async function loadGeometryFoundation() {
  return (await import("./engineGeometry")).loadGeometryFoundation();
}

/** Lazy E2 geometry loader; its canvas/SVG preview helpers remain test-gated. */
export async function loadGeometryEngine() {
  return (await import("./engineGeometry")).loadGeometryEngine();
}

export interface EngineCandidateValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  candidateSha256?: string;
  diagnostics: Diagnostic[];
  receipt?: EngineReceipt;
}

export interface EngineRenderContext {
  docId: string;
  documentName: string;
  documentRevision: string;
  diagramType: string;
  datasetId?: string | null;
}

export type EngineRenderedCandidate = EngineArtifactReport & { storeWarning?: string | null };

export interface EngineRenderOptions {
  format?: "svg" | "png";
  theme?: "light" | "dark";
  pixelRatio?: number;
}

export type EngineRenderHost = (
  diagramType: string,
  candidateJson: string,
  context?: EngineRenderContext,
  options?: EngineRenderOptions,
) => Promise<EngineRenderedCandidate>;

export interface ProductDiagramEngine {
  readonly transport: "wasm";
  validate(input: string): Promise<ValidationReport>;
  layout(request: LayoutRequest): Promise<GeometryReport>;
  render(request: EngineArtifactRequest): Promise<EngineArtifactReport>;
  validateCandidate(diagramType: string, spec: unknown): Promise<EngineCandidateValidation>;
}

export interface ProductDiagramEnginePorts {
  validate(input: string): Promise<ValidationReport>;
  layout(request: LayoutRequest): GeometryReport | Promise<GeometryReport>;
  /**
   * Floorplan's own engine entry (`layout_floorplan_json`): it runs the
   * document validity rules, then lays the map out. Floorplan documents carry
   * no `diagram_type`, so they cannot go through `validate`/`layout`.
   */
  layoutFloorplan?(request: LayoutRequest): GeometryReport | Promise<GeometryReport>;
  render(request: EngineArtifactRequest): Promise<EngineArtifactReport>;
}

function diagnosticText(diagnostic: Diagnostic): string {
  return [diagnostic.message.trim(), diagnostic.fix.trim(), `(engine ${diagnostic.code} at ${diagnostic.path})`]
    .filter(Boolean)
    .join(" ");
}

function preflightDiagnosticText(diagnostic: ValidationDiagnostic): string {
  const field = String(diagnostic.params?.field ?? "source");
  const detail = diagnostic.params
    ? Object.entries(diagnostic.params).map(([key, value]) => `${key}: ${value}`).join(", ")
    : "";
  let cause = `The semantic source failed ${diagnostic.key}`;
  let fix = `correct ${field} or its referenced entries and retry`;
  if (diagnostic.key === "diagram.validation.specShape") {
    cause = "The semantic source must be a JSON object";
    fix = "provide an object containing the selected diagram type and its required collections";
  } else if (diagnostic.key === "diagram.validation.specType") {
    cause = "The selected diagram type is not supported by the SDK";
    fix = "select architecture, workflow, sequence, dataflow, lifecycle or floorplan";
  } else if (diagnostic.key === "diagram.validation.specBudget") {
    cause = "The semantic source exceeds its UTF-8 byte limit or cannot be serialized";
    fix = "split the diagram or remove oversized and non-JSON values, then retry";
  } else if (diagnostic.key === "diagram.validation.specMeta") {
    cause = `The semantic source has an invalid or missing ${field}`;
    fix = field === "meta.output"
      ? "use a relative portable .html output path with each UTF-8 segment at most 255 bytes"
      : field === "meta.title" ? "set meta.title to a non-empty string"
      : field === "schema_version" ? "set schema_version to an integer supported by this diagram family"
      : field === "diagram_type" ? "set diagram_type to the selected dataset type"
      : `provide the required ${field} collection as an array`;
  } else if (diagnostic.key === "diagram.semantic.danglingReference") {
    cause = `The reference at ${field} points to a missing entry`;
    fix = "restore the referenced entry or update the reference to an existing id";
  } else if (diagnostic.key === "diagram.semantic.duplicateId") {
    cause = `The collection at ${field} contains a duplicate id`;
    fix = "give entries distinct ids within that collection and update their references";
  }
  return `${cause}; ${fix}. (${diagnostic.key}${detail ? `: ${detail}` : ""})`;
}

const NONBLOCKING_ROUTE_NOTICE_CODES = new Set([
  "architecture/geometry-route-quality-notice",
  "workflow/geometry-route-quality-notice",
  "sequence/geometry-route-quality-notice",
  "dataflow/geometry-route-quality-notice",
  "lifecycle/geometry-route-quality-notice",
]);
function isRouteNotice(diagnostic: Diagnostic): boolean {
  return NONBLOCKING_ROUTE_NOTICE_CODES.has(diagnostic.code);
}

async function sourceSha256(specJson: string): Promise<string> {
  const bytes = new TextEncoder().encode(specJson);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkReceiptSource(receipt: EngineReceipt, expectedSha: string): void {
  if (!receipt || typeof receipt.inputSpecSha256 !== "string" || !record(receipt.engine)
      || typeof receipt.engine.id !== "string" || typeof receipt.engine.version !== "string"
      || typeof receipt.engine.revision !== "string") {
    throw new Error("The engine returned an incomplete receipt; update Maru and retry validation.");
  }
  if (receipt.inputSpecSha256 !== expectedSha) {
    throw new Error("The engine receipt does not match the submitted semantic spec; retry validation with the unchanged source.");
  }
  if (receipt.engine.id !== "maru-diagram-engine" || !receipt.engine.version || !receipt.engine.revision) {
    throw new Error("The engine receipt has an unsupported engine identity; update Maru and retry.");
  }
  checkReceiptEnvelope(receipt);
}

/** The receipt contract version `maru-diagram-engine` emits (`EngineReceipt.schema_version`). */
const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_GATE_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "not-run"]);
const RECEIPT_GATES = ["schema", "artifact", "browser", "visualReview"] as const;

/**
 * The mandatory envelope of an engine receipt (`ReceiptGates` in the engine
 * crate): a supported schemaVersion and four gates, each with a known status
 * and a scope. A report whose hash matches but whose envelope does not is not
 * proof of validation, so admission fails closed.
 */
function checkReceiptEnvelope(receipt: EngineReceipt): void {
  const raw = receipt as unknown as Record<string, unknown>;
  if (raw.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`The engine receipt has unsupported schemaVersion ${JSON.stringify(raw.schemaVersion ?? null)} (expected ${RECEIPT_SCHEMA_VERSION}); update Maru so the app and engine match, then retry.`);
  }
  const gates = raw.gates;
  if (!record(gates)) {
    throw new Error("The engine receipt has no gates record; update Maru so the app and engine match, then retry.");
  }
  for (const name of RECEIPT_GATES) {
    const gate = gates[name];
    if (!record(gate) || typeof gate.status !== "string" || !RECEIPT_GATE_STATUSES.has(gate.status)
        || typeof gate.scope !== "string" || gate.scope.length === 0) {
      throw new Error(`The engine receipt gate "${name}" is missing or malformed; update Maru so the app and engine match, then retry.`);
    }
  }
}

function candidateFailure(
  message: string,
  candidateSha256?: string,
): EngineCandidateValidation {
  return {
    ok: false,
    errors: [message],
    warnings: [],
    ...(candidateSha256 ? { candidateSha256 } : {}),
    diagnostics: [],
  };
}

async function validateEngineCandidateWithPorts(
  ports: ProductDiagramEnginePorts,
  diagramType: string,
  spec: unknown,
): Promise<EngineCandidateValidation> {
  let specJson: string;
  try {
    specJson = typeof spec === "string" ? spec : JSON.stringify(spec) ?? "";
  } catch (error) {
    return candidateFailure(`The semantic spec cannot be serialized: ${error instanceof Error ? error.message : String(error)}; replace cyclic or non-JSON values and retry.`);
  }
  if (!specJson.trim()) return candidateFailure("The semantic spec is empty; provide a valid diagram and retry.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(specJson) as unknown;
  } catch (error) {
    return candidateFailure(`The semantic spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}; repair the JSON syntax and retry.`);
  }
  if (diagramType === "floorplan") return validateFloorplanCandidateWithPorts(ports, specJson, parsed);
  if (!record(parsed) || parsed.diagram_type !== diagramType) {
    return candidateFailure(
      `The semantic spec type does not match the selected ${diagramType} dataset; select the matching dataset and retry.`,
      await sourceSha256(specJson),
    );
  }

  const candidateSha256 = await sourceSha256(specJson);
  const { validateSemanticContentShape } = await import("./semantic");
  const preflight = validateSemanticContentShape(diagramType as SemanticDiagramType, parsed);
  if (preflight.length > 0) {
    return {
      ok: false,
      errors: preflight.map(preflightDiagnosticText),
      warnings: [],
      candidateSha256,
      diagnostics: [],
    };
  }

  const validation = await ports.validate(specJson);
  checkReceiptSource(validation.receipt, candidateSha256);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.diagnostics.map(diagnosticText),
      warnings: [],
      candidateSha256,
      diagnostics: validation.diagnostics,
      receipt: validation.receipt,
    };
  }

  const layout = await ports.layout({ specJson });
  return layoutAdmission(layout, candidateSha256, validation.diagnostics);
}

function layoutAdmission(
  layout: GeometryReport,
  candidateSha256: string,
  priorDiagnostics: Diagnostic[],
): EngineCandidateValidation {
  checkReceiptSource(layout.receipt, candidateSha256);
  const warnings = layout.ok ? layout.diagnostics.map(diagnosticText) : [];
  const errors = layout.ok
    ? []
    : layout.diagnostics.filter((diagnostic) => !isRouteNotice(diagnostic)).map(diagnosticText);
  if (!layout.ok && errors.length === 0) {
    errors.push("The geometry engine refused this layout; inspect its diagnostics and repair the source before applying it.");
  }
  return {
    ok: layout.ok,
    errors,
    warnings,
    candidateSha256,
    diagnostics: [...priorDiagnostics, ...layout.diagnostics],
    receipt: layout.receipt,
  };
}

/**
 * Floorplan admission (`maru#553` E5 T4): the local floor runs first for
 * field-named diagnostics, then the engine's Floorplan entry validates the
 * document and lays it out. Its receipt must name the exact submitted source.
 */
async function validateFloorplanCandidateWithPorts(
  ports: ProductDiagramEnginePorts,
  specJson: string,
  parsed: unknown,
): Promise<EngineCandidateValidation> {
  if (!record(parsed) || "diagram_type" in parsed) {
    return candidateFailure(
      "The semantic spec is not a Floorplan document; select the matching dataset, or remove diagram_type from the floorplan/architecture@1 map, and retry.",
      await sourceSha256(specJson),
    );
  }
  const candidateSha256 = await sourceSha256(specJson);
  const { validateSemanticContentShape } = await import("./semantic");
  const preflight = validateSemanticContentShape("floorplan", parsed);
  if (preflight.length > 0) {
    return { ok: false, errors: preflight.map(preflightDiagnosticText), warnings: [], candidateSha256, diagnostics: [] };
  }
  if (!ports.layoutFloorplan) {
    throw new Error("The Floorplan engine entry is missing from this build; update Maru and apply again.");
  }
  return layoutAdmission(await ports.layoutFloorplan({ specJson }), candidateSha256, []);
}

/** Testable product-engine factory; ports are per-instance, never process-global overrides. */
export function createProductDiagramEngine(ports: ProductDiagramEnginePorts): ProductDiagramEngine {
  return {
    transport: "wasm",
    validate: (input) => ports.validate(input),
    async layout(request) {
      return ports.layout(request);
    },
    render: (request) => ports.render(request),
    validateCandidate: (diagramType, spec) => validateEngineCandidateWithPorts(ports, diagramType, spec),
  };
}

type ProductGeometryEngine = Awaited<ReturnType<typeof loadGeometryEngine>>;
let productDiagramEngine: ProductDiagramEngine | undefined;
let productValidationEngine: Promise<DiagramEngine> | undefined;
let productGeometryEngine: Promise<ProductGeometryEngine> | undefined;

async function loadProductValidationEngine(): Promise<DiagramEngine> {
  productValidationEngine ??= loadWasmEngine().catch((error) => {
    productValidationEngine = undefined;
    throw productEngineLoadError("validation", error);
  });
  return productValidationEngine;
}

async function loadProductGeometryEngine(): Promise<ProductGeometryEngine> {
  productGeometryEngine ??= loadGeometryEngine().catch((error) => {
    productGeometryEngine = undefined;
    throw productEngineLoadError("geometry", error);
  });
  return productGeometryEngine;
}

/** Cache the facade; each method lazily loads only the SDK artifact it needs. */
export function loadDiagramEngine(): Promise<ProductDiagramEngine> {
  productDiagramEngine ??= createProductDiagramEngine({
    async validate(input) {
      return (await loadProductValidationEngine()).validate(input);
    },
    async layout(request) {
      return (await loadProductGeometryEngine()).layout(request);
    },
    async layoutFloorplan(request) {
      return (await loadProductGeometryEngine()).layoutFloorplan(request);
    },
    async render(request) {
      const { renderEngineArtifact } = await import("./engineArtifact");
      return renderEngineArtifact(request);
    },
  });
  return Promise.resolve(productDiagramEngine);
}

/** Product facade wrappers keep callers independent of the WASM loader details. */
export async function validate(input: string): Promise<ValidationReport> {
  return (await loadDiagramEngine()).validate(input);
}

export async function layout(request: LayoutRequest): Promise<GeometryReport> {
  return (await loadDiagramEngine()).layout(request);
}

/** SVG export defaults to outlined text; previews must request purpose=preview explicitly. */
export async function render(request: EngineArtifactRequest): Promise<EngineArtifactReport> {
  return (await loadDiagramEngine()).render({ ...request, purpose: request.purpose ?? "export" });
}

/** Native render-and-store boundary; loaded dynamically to keep this module safe for E0 data-URL consumers. */
export async function renderEngineCandidate(
  workspace: string,
  diagramType: string,
  candidateJson: string,
  context?: EngineRenderContext,
  options?: EngineRenderOptions,
): Promise<EngineRenderedCandidate> {
  const { renderEngineCandidate: renderCandidate } = await import("./engineCandidate");
  return renderCandidate(workspace, diagramType, candidateJson, context, options);
}

export async function validateEngineCandidate(
  diagramType: string,
  spec: unknown,
): Promise<EngineCandidateValidation> {
  return (await loadDiagramEngine()).validateCandidate(diagramType, spec);
}

/** Verify renderer provenance and bytes at caller-injected export boundaries too. */
export async function verifyRenderedArtifact(request: EngineArtifactRequest, report: unknown): Promise<EngineArtifactReport> {
  return (await import("./engineArtifact")).verifyEngineArtifactReport(request, report);
}

/** Workspace store I/O shares the product plugin entry; paths are authorized by its host. */
export async function listStoredRenders(workspace: string): Promise<import("./renders").RenderGroup[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("plugin:maru-diagram|diagram_list_renders", { workspace });
}
export async function prepareStoredRender(workspace: string, docId: string, renderId: string): Promise<import("./renders").RenderView> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("plugin:maru-diagram|diagram_prepare_render_view", { workspace, docId, renderId });
}
export async function deleteStoredRender(workspace: string, docId: string, renderId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("plugin:maru-diagram|diagram_delete_render", { workspace, docId, renderId });
}
