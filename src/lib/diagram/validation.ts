import { validatePortablePath } from "../../../sidecars/archify/renderers/shared/portable-path.mjs";
/**
 * Strict validation for AI-generated diagram candidates (issue #433 P1).
 *
 * Unlike `persistence.ts`, whose `ensure*` helpers migrate leniently and
 * coerce hostile input into a loadable doc, this module never mutates and
 * never throws: it inspects a candidate `DiagramDoc` and reports every
 * violation as a {@link ValidationDiagnostic}. Diagnostics carry i18n keys
 * under `diagram.validation.*` plus string/number params (the same contract
 * as `CodecWarning` in `codecs.ts`) — callers render them, validators never
 * carry user-visible strings.
 *
 * Two entry points:
 *
 * - {@link validateCandidateDoc} — structural floor for a whole candidate
 *   doc: id uniqueness per collection, referential integrity (edges → nodes,
 *   nodes → layers, views → datasets/members, node meta pointers), finite
 *   positive geometry, payload budgets, per-dataset validation (matrix span
 *   invariants, semantic-spec structure), and the schema version pin.
 * - {@link validateArchifySpecPreCheck} — cheap gate run before handing an
 *   AI-produced spec to the pinned Archify engine: known diagram type, plain
 *   object shape, JSON-serializability within the byte budget, and the
 *   minimum meta contract (`schema_version`, `meta.title`, portable
 *   `meta.output` ending in `.html`).
 *
 * `ok` is true exactly when `diagnostics` is empty. Malformed input produces
 * diagnostics (or is skipped defensively), never an exception.
 */

import {
  SEMANTIC_DIAGRAM_TYPES,
  SEMANTIC_SPEC_MAX_BYTES,
  validateMatrix,
  validateSemanticSpec,
  type ReportDataset,
} from "./reportTypes";
import { DIAGRAM_SCHEMA_VERSION, type DiagramDoc } from "./types";

export interface ValidationDiagnostic {
  /** i18n key under `diagram.validation.*`. */
  key: string;
  params?: Record<string, string | number>;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: ValidationDiagnostic[];
}

export interface ValidateCandidateDocOptions {
  maxNodes?: number;
  maxEdges?: number;
  maxStringLength?: number;
}

const DEFAULT_MAX_NODES = 2000;
const DEFAULT_MAX_EDGES = 4000;
const DEFAULT_MAX_STRING_LENGTH = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function collectDuplicates(
  items: readonly unknown[],
  key: string,
  diagnostics: ValidationDiagnostic[],
): Set<string> {
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    if (seen.has(item.id)) {
      diagnostics.push({ key, params: { id: item.id } });
    }
    seen.add(item.id);
  }
  return seen;
}

function checkStringBudget(
  value: unknown,
  maxStringLength: number,
  owner: { id: string; field: string },
  diagnostics: ValidationDiagnostic[],
): void {
  if (typeof value !== "string") return;
  if (value.length > maxStringLength) {
    diagnostics.push({
      key: "diagram.validation.budgetExceeded",
      params: {
        kind: "string",
        id: owner.id,
        field: owner.field,
        limit: maxStringLength,
        actual: value.length,
      },
    });
  }
}

/**
 * Strict structural validation of a candidate doc. Every violation found is
 * reported (validation does not stop at the first failure); an empty
 * `diagnostics` array means the candidate is safe to accept.
 */
export function validateCandidateDoc(
  doc: DiagramDoc,
  opts: ValidateCandidateDocOptions = {},
): ValidationResult {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = opts.maxEdges ?? DEFAULT_MAX_EDGES;
  const maxStringLength = opts.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  const diagnostics: ValidationDiagnostic[] = [];

  if (doc.v !== DIAGRAM_SCHEMA_VERSION) {
    diagnostics.push({
      key: "diagram.validation.schemaVersion",
      params: { expected: DIAGRAM_SCHEMA_VERSION, actual: String(doc.v) },
    });
  }

  const nodes = asArray(doc.nodes);
  const edges = asArray(doc.edges);
  const layers = asArray(doc.layers);
  const datasets = asArray(doc.datasets);
  const views = asArray(doc.views);

  // Id uniqueness per collection.
  const nodeIds = collectDuplicates(nodes, "diagram.validation.duplicateNodeId", diagnostics);
  const edgeIds = collectDuplicates(edges, "diagram.validation.duplicateEdgeId", diagnostics);
  const layerIds = collectDuplicates(layers, "diagram.validation.duplicateLayerId", diagnostics);
  const datasetIds = collectDuplicates(
    datasets,
    "diagram.validation.duplicateDatasetId",
    diagnostics,
  );
  const viewIds = collectDuplicates(views, "diagram.validation.duplicateViewId", diagnostics);

  // Count budgets.
  if (nodes.length > maxNodes) {
    diagnostics.push({
      key: "diagram.validation.budgetExceeded",
      params: { kind: "nodes", limit: maxNodes, actual: nodes.length },
    });
  }
  if (edges.length > maxEdges) {
    diagnostics.push({
      key: "diagram.validation.budgetExceeded",
      params: { kind: "edges", limit: maxEdges, actual: edges.length },
    });
  }

  // Per-node checks: geometry, layer reference, meta pointers, string budgets.
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const id = typeof node.id === "string" ? node.id : "?";
    for (const field of ["x", "y", "w", "h"] as const) {
      const value = node[field];
      const bad = typeof value !== "number" || !Number.isFinite(value);
      const nonPositive = (field === "w" || field === "h") && typeof value === "number" && value <= 0;
      if (bad || nonPositive) {
        diagnostics.push({
          key: "diagram.validation.nonFiniteGeometry",
          params: { id, field, value: String(value) },
        });
      }
    }
    if (node.layerId !== undefined && !(typeof node.layerId === "string" && layerIds.has(node.layerId))) {
      diagnostics.push({
        key: "diagram.validation.unknownLayer",
        params: { nodeId: id, layerId: String(node.layerId) },
      });
    }
    if (isRecord(node.meta)) {
      const memberId = node.meta.memberId;
      // A member pointer is either the dataset id itself (v7 upgrade legacy)
      // or a pattern member address `<datasetId>:m<index>` (patterns.ts).
      const memberOk =
        typeof memberId === "string" &&
        (datasetIds.has(memberId) ||
          (memberId.includes(":") && datasetIds.has(memberId.slice(0, memberId.indexOf(":")))));
      if (memberId !== undefined && !memberOk) {
        diagnostics.push({
          key: "diagram.validation.memberReference",
          params: { nodeId: id, kind: "member", refId: String(memberId) },
        });
      }
      const viewId = node.meta.viewId;
      if (viewId !== undefined && !(typeof viewId === "string" && viewIds.has(viewId))) {
        diagnostics.push({
          key: "diagram.validation.memberReference",
          params: { nodeId: id, kind: "view", refId: String(viewId) },
        });
      }
    }
    checkStringBudget(node.title, maxStringLength, { id, field: "title" }, diagnostics);
    checkStringBudget(node.body, maxStringLength, { id, field: "body" }, diagnostics);
    if (Array.isArray(node.bullets)) {
      node.bullets.forEach((bullet, index) => {
        checkStringBudget(bullet, maxStringLength, { id, field: `bullets[${index}]` }, diagnostics);
      });
    }
  }

  // Per-edge checks: endpoint references, midOff geometry, label budget.
  for (const edge of edges) {
    if (!isRecord(edge)) continue;
    const id = typeof edge.id === "string" ? edge.id : "?";
    const fromOk = typeof edge.fromNode === "string" && nodeIds.has(edge.fromNode);
    const toOk = typeof edge.toNode === "string" && nodeIds.has(edge.toNode);
    if (!fromOk || !toOk) {
      diagnostics.push({
        key: "diagram.validation.danglingEdge",
        params: {
          edgeId: id,
          fromNode: String(edge.fromNode),
          toNode: String(edge.toNode),
        },
      });
    }
    if (
      edge.midOff !== undefined &&
      (typeof edge.midOff !== "number" || !Number.isFinite(edge.midOff))
    ) {
      diagnostics.push({
        key: "diagram.validation.nonFiniteGeometry",
        params: { id, field: "midOff", value: String(edge.midOff) },
      });
    }
    checkStringBudget(edge.label, maxStringLength, { id, field: "label" }, diagnostics);
  }

  // View reference integrity.
  for (const view of views) {
    if (!isRecord(view)) continue;
    const id = typeof view.id === "string" ? view.id : "?";
    if (!(typeof view.datasetId === "string" && datasetIds.has(view.datasetId))) {
      diagnostics.push({
        key: "diagram.validation.viewReference",
        params: { viewId: id, kind: "dataset", refId: String(view.datasetId) },
      });
    }
    if (Array.isArray(view.nodeIds)) {
      for (const refId of view.nodeIds) {
        if (!(typeof refId === "string" && nodeIds.has(refId))) {
          diagnostics.push({
            key: "diagram.validation.viewReference",
            params: { viewId: id, kind: "node", refId: String(refId) },
          });
        }
      }
    }
    if (Array.isArray(view.edgeIds)) {
      for (const refId of view.edgeIds) {
        if (!(typeof refId === "string" && edgeIds.has(refId))) {
          diagnostics.push({
            key: "diagram.validation.viewReference",
            params: { viewId: id, kind: "edge", refId: String(refId) },
          });
        }
      }
    }
  }

  // Per-dataset structural validation.
  for (const dataset of datasets) {
    if (!isRecord(dataset) || typeof dataset.id !== "string") continue;
    const result = validateDataset(dataset as ReportDataset);
    for (const error of result) {
      diagnostics.push({
        key: "diagram.validation.dataset",
        params: { datasetId: dataset.id, error },
      });
    }
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

function validateDataset(dataset: ReportDataset): string[] {
  try {
    if (dataset.kind === "matrix") return validateMatrix(dataset).errors;
    if (dataset.kind === "semanticSpec") return validateSemanticSpec(dataset).errors;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return [];
}

/**
 * Cheap pre-flight gate for an AI-produced Archify spec, run before the
 * pinned engine sees it. Reports an unknown diagram type, a non-object spec,
 * an unserializable or oversized payload, and a missing/invalid meta
 * contract. Never throws.
 */
export function validateArchifySpecPreCheck(
  diagramType: string,
  spec: unknown,
): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];

  if (!(SEMANTIC_DIAGRAM_TYPES as readonly string[]).includes(diagramType)) {
    diagnostics.push({
      key: "diagram.validation.specType",
      params: { diagramType },
    });
  }

  if (!isRecord(spec)) {
    diagnostics.push({ key: "diagram.validation.specShape" });
    return { ok: false, diagnostics };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(spec);
  } catch {
    diagnostics.push({
      key: "diagram.validation.specBudget",
      params: { bytes: "n/a", maxBytes: SEMANTIC_SPEC_MAX_BYTES },
    });
    return { ok: false, diagnostics };
  }
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > SEMANTIC_SPEC_MAX_BYTES) {
    diagnostics.push({
      key: "diagram.validation.specBudget",
      params: { bytes, maxBytes: SEMANTIC_SPEC_MAX_BYTES },
    });
  }

  if (typeof spec.schema_version !== "number" || !Number.isFinite(spec.schema_version)) {
    diagnostics.push({
      key: "diagram.validation.specMeta",
      params: { field: "schema_version" },
    });
  }
  const meta = spec.meta;
  if (!isRecord(meta) || typeof meta.title !== "string" || meta.title.length === 0) {
    diagnostics.push({
      key: "diagram.validation.specMeta",
      params: { field: "meta.title" },
    });
  }
  const output = isRecord(meta) ? meta.output : undefined;
  let outputOk = typeof output === "string" && /[.]html$/i.test(output);
  if (outputOk) {
    try {
      validatePortablePath(output as string, { profile: "output" });
    } catch {
      outputOk = false;
    }
  }
  if (!outputOk) {
    diagnostics.push({
      key: "diagram.validation.specMeta",
      params: { field: "meta.output" },
    });
  }

  return { ok: diagnostics.length === 0, diagnostics };
}
