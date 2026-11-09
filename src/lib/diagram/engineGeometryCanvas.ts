/** Test-only canvas adapter. Import lazily from the dev/native bridge only.
 * Canvas positions become engine pins only with an explicit pinned/locked flag;
 * automatic projected positions remain automatic engine layout inputs.
 */
import type { GeometryPin, LayoutRequest } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import type { SemanticSpecDataset } from "./reportTypes";
import type { DiagramDoc, DiagramNode } from "./types";

const ENTITY_FIELDS: Readonly<Record<string, string>> = {
  architecture: "components",
  workflow: "nodes",
  sequence: "participants",
  dataflow: "nodes",
  lifecycle: "states",
};
const DERIVED_ROLES = new Set(["boundary", "stage", "segment", "activation", "card"]);
const AUTHORED_CONTAINERS: Readonly<Record<string, string>> = {
  lane: "lanes", phase: "phases", group: "groups",
};

/** Translation the emitted page applies to the source drawing (emitted = source + offset). */
export interface ContentOffset { x: number; y: number }
export const NO_CONTENT_OFFSET: Readonly<ContentOffset> = { x: 0, y: 0 };
export interface CanvasPinOptions {
  /** Offset of the canvas the pinned members are displayed on, from `page.contentOffset`. */
  contentOffset?: Readonly<ContentOffset>;
  /** False for the probe layout that only measures the offset. */
  pins?: boolean;
}

function fail(cause: string, fix: string): never {
  throw new Error(`Cannot adapt canvas pins: ${cause}; ${fix}.`);
}

function offsetOf(value: Readonly<ContentOffset> | undefined): Readonly<ContentOffset> {
  if (!value) return NO_CONTENT_OFFSET;
  if (!Number.isInteger(value.x) || !Number.isInteger(value.y)) {
    fail("the page content offset is not signed-32-bit fixed-point", "pass the contentOffset the engine reported and retry");
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same half-away-from-zero quantization as the SDK fixed-point boundary. */
function coordinate(value: number, nodeId: string, axis: "x" | "y"): number {
  if (!Number.isFinite(value)) fail(`node ${nodeId} has a non-finite ${axis} position`, "set a finite canvas position and retry");
  const scaled = value * 64;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  if (!Number.isFinite(rounded) || rounded < -2147483648 || rounded > 2147483647) {
    fail(`node ${nodeId} has an ${axis} position outside signed-32-bit fixed-point bounds`, "move the pinned node inside the supported canvas extent and retry");
  }
  return rounded === 0 ? 0 : rounded;
}

function entryAt(dataset: SemanticSpecDataset, field: string, index: number): string {
  const entries = dataset.spec[field];
  const entry: unknown = Array.isArray(entries) ? entries[index] : undefined;
  if (!record(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
    fail(`dataset ${dataset.id} has no source entity for a pinned canvas member`, "regenerate the dataset projection and retry");
  }
  return entry.id;
}

function target(dataset: SemanticSpecDataset, node: DiagramNode): Pick<GeometryPin, "targetId" | "targetKind" | "role"> | null {
  const memberId = node.meta?.memberId;
  const prefix = `${dataset.id}:`;
  if (typeof memberId !== "string" || !memberId.startsWith(prefix)) return null;
  const role = node.meta?.semanticContainer;
  if (typeof role === "string") {
    if (DERIVED_ROLES.has(role)) return null;
    const allowed = role === "lane" ? dataset.diagramType === "workflow" || dataset.diagramType === "lifecycle"
      : (role === "phase" || role === "group") && dataset.diagramType === "workflow";
    const field = AUTHORED_CONTAINERS[role];
    const rolePrefix = `${prefix}${role}:`;
    const key = memberId.startsWith(rolePrefix) ? memberId.slice(rolePrefix.length) : "";
    const entries = field ? dataset.spec[field] : undefined;
    if (!allowed || !key || !Array.isArray(entries) || !entries.some((entry: unknown) => record(entry) && entry.id === key) || node.id !== memberId) {
      fail(`pinned container ${node.id} does not match an authored container in dataset ${dataset.id}`, "regenerate the dataset projection or remove the explicit pin and retry");
    }
    return { targetId: `${role}:${key}`, targetKind: "container", role };
  }
  const member = memberId.slice(prefix.length);
  if (!/^m(0|[1-9][0-9]*)$/.test(member)) {
    fail(`pinned node ${node.id} has an invalid semantic member identity`, "regenerate the dataset projection or remove the explicit pin and retry");
  }
  const index = Number(member.slice(1));
  if (!Number.isSafeInteger(index)) fail(`pinned node ${node.id} has an unrepresentable member index`, "regenerate the dataset projection and retry");
  const sourceId = entryAt(dataset, ENTITY_FIELDS[dataset.diagramType], index);
  const mapped = Object.hasOwn(dataset.idMap, sourceId) ? dataset.idMap[sourceId] : sourceId;
  if (mapped !== node.id) fail(`pinned node ${node.id} disagrees with its dataset id mapping`, "regenerate the dataset projection and retry");
  return { targetId: sourceId, targetKind: "node" };
}

/** Build the test engine request for one semantic dataset without editing the doc.
 * The hash covers the exact serialized source passed to the SDK, not canvas state.
 * A canvas position is emitted space, so it becomes a pin only after the page's
 * `contentOffset` is subtracted: pins are authored source coordinates (maru#561).
 */
export async function buildEngineCanvasLayoutRequest(
  doc: DiagramDoc,
  datasetId: string,
  options: CanvasPinOptions = {},
): Promise<LayoutRequest> {
  const contentOffset = offsetOf(options.contentOffset);
  const includePins = options.pins !== false;
  const datasets = (doc.datasets ?? []).filter((dataset) => dataset.id === datasetId);
  if (datasets.length !== 1 || datasets[0].kind !== "semanticSpec") {
    fail(`dataset ${datasetId} is missing, duplicated, or not semantic`, "select one uniquely identified semantic dataset and retry");
  }
  const dataset = datasets[0];
  if (!Object.hasOwn(ENTITY_FIELDS, dataset.diagramType)) {
    fail(`diagram type ${dataset.diagramType} has no test engine layout adapter`, "select an architecture, workflow, sequence, dataflow, or lifecycle dataset");
  }
  let specJson: string;
  try { specJson = JSON.stringify(dataset.spec); }
  catch { fail(`dataset ${datasetId} cannot be serialized`, "repair cyclic or unsupported source values and retry"); }
  const pins: GeometryPin[] = [];
  const seen = new Set<string>();
  for (const node of includePins ? doc.nodes : []) {
    if (node.locked !== true && node.meta?.pinned !== true) continue;
    // Imported dataset IDs may contain colons. A longer, exact dataset prefix
    // owns its members; a short prefix must not capture that other dataset.
    const memberId = node.meta?.memberId;
    if (typeof memberId === "string" && (doc.datasets ?? []).some((candidate) => candidate.id !== datasetId
      && candidate.id.startsWith(`${datasetId}:`) && memberId.startsWith(`${candidate.id}:`))) continue;
    const member = target(dataset, node);
    if (!member) continue;
    const key = `${member.targetKind}:${member.targetId}`;
    if (seen.has(key)) fail(`multiple explicitly pinned canvas members map to ${member.targetId}`, "remove duplicate canvas members or regenerate the dataset projection and retry");
    seen.add(key);
    pins.push({
      ...member,
      position: {
        x: coordinate(node.x - contentOffset.x / 64, node.id, "x"),
        y: coordinate(node.y - contentOffset.y / 64, node.id, "y"),
      },
    });
  }
  pins.sort((a, b) => a.targetKind < b.targetKind ? -1 : a.targetKind > b.targetKind ? 1 : a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0);
  let sourceSpecSha256: string;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(specJson));
    sourceSpecSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch { fail("SHA-256 is unavailable for the source spec", "open the test bridge in a secure desktop or browser context and retry"); }
  return { specJson, pinSet: { sourceSpecSha256, pins } };
}
