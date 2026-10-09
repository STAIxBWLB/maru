/**
 * Structural semantic edits (issue #433 P2).
 *
 * A structural edit is a spec edit: {@link planSemanticEdit} transforms the
 * dataset's spec, runs `validateSemanticContent`, and routes the result
 * through P1's audited path — `buildProposalFromCandidate` (scope = the
 * dataset's members, current locks, touched filter) then
 * `prepareProposalApply` — so the caller commits exactly one `withSnapshot`
 * undo entry. Only canvas members whose projection changed are touched, so
 * canvas drift on other members survives. Manual edits never run the engine
 * (it is async and Tauri-only); the publication gate must.
 */

import type { StateTransformer } from "./actions";
import { buildProposalFromCandidate, prepareProposalApply, type ProposalMeta } from "./proposal";
import {
  datasetHasContainers,
  detachSemanticDataset,
  projectSemanticDataset,
  semanticDatasetsOf,
  semanticMemberNodeIds,
  sequenceOrder,
  specEntries,
  validateSemanticContent,
} from "./semantic";
import { DIAGRAM_SCHEMA_VERSION, type DiagramStateRoot } from "./types";
import type { ValidationDiagnostic } from "./validation";

/** A spec edit: the next spec plus warnings, or null when nothing changes. */
export type SpecTransform = (
  spec: Record<string, unknown>,
) => { spec: Record<string, unknown>; warnings?: ValidationDiagnostic[] } | null;

export type SemanticEditOutcome =
  | { status: "applied"; transformer: StateTransformer; warnings: ValidationDiagnostic[] }
  | { status: "unchanged" }
  | { status: "invalid"; diagnostics: ValidationDiagnostic[] };

/** Canvas ids whose projection differs between two versions of a dataset. */
function changedProjectionIds(
  state: DiagramStateRoot,
  before: Parameters<typeof projectSemanticDataset>[0],
  after: Parameters<typeof projectSemanticDataset>[0],
): Set<string> {
  const opts = { containers: datasetHasContainers(state.doc, before.id), doc: state.doc };
  const a = projectSemanticDataset(before, opts);
  const b = projectSemanticDataset(after, opts);
  const touched = new Set<string>();
  for (const [left, right] of [
    [a.nodes, b.nodes],
    [a.edges, b.edges],
  ] as const) {
    const index = new Map<string, string>(left.map((entry) => [entry.id, JSON.stringify(entry)]));
    for (const entry of right) {
      if (index.get(entry.id) !== JSON.stringify(entry)) touched.add(entry.id);
      index.delete(entry.id);
    }
    for (const id of index.keys()) touched.add(id);
  }
  return touched;
}

/**
 * Plan a structural edit of dataset `datasetId`. Returns the single
 * transformer to wrap in `withSnapshot`, `unchanged`, or the diagnostics that
 * refused it (content validation, locks, whole-doc validation).
 */
export function planSemanticEdit(
  state: DiagramStateRoot,
  datasetId: string,
  transform: SpecTransform,
): SemanticEditOutcome {
  const dataset = semanticDatasetsOf(state.doc).find((entry) => entry.id === datasetId);
  if (!dataset) return { status: "unchanged" };
  const result = transform(dataset.spec);
  if (!result) return { status: "unchanged" };
  const content = validateSemanticContent(dataset.diagramType, result.spec);
  if (content.length > 0) return { status: "invalid", diagnostics: content };

  const next = { ...dataset, spec: result.spec };
  const meta: ProposalMeta = {
    jobId: "semantic-edit",
    docId: state.doc.id,
    schemaVersion: DIAGRAM_SCHEMA_VERSION,
    baseMemoryRevision: "",
    baseStorageRevision: null,
    scope: new Set(semanticMemberNodeIds(state.doc, datasetId)),
    lockedNodeIds: state.doc.nodes.filter((node) => node.locked === true).map((node) => node.id),
  };
  const { proposal } = buildProposalFromCandidate(meta, next, state.doc, {
    touched: changedProjectionIds(state, dataset, next),
  });
  const outcome = prepareProposalApply(state, proposal, "");
  if (outcome.status === "applied") {
    return { status: "applied", transformer: outcome.transformer, warnings: result.warnings ?? [] };
  }
  return { status: "invalid", diagnostics: outcome.status === "invalid" ? outcome.diagnostics : [] };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** Set (or, for `undefined`, delete) one key of entry `index` in `field`. */
export function setSpecField(field: string, index: number, key: string, value: unknown): SpecTransform {
  return (spec) => {
    const entries = specEntries(spec, field);
    const entry = entries[index];
    if (!entry || entry[key] === value) return null;
    const next = { ...entry };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return { spec: { ...spec, [field]: entries.map((item) => (item === entry ? next : item)) } };
  };
}

/** Lifecycle state type; the node kind follows (start/success/failure oval, decision diamond). */
export const setStateType = (index: number, type: string) => setSpecField("states", index, "type", type);

/** Dataflow flow classification; empty text deletes it. */
export const setClassification = (index: number, text: string) =>
  setSpecField("flows", index, "classification", text.length > 0 ? text : undefined);

/** Workflow/lifecycle lane reassignment; the member moves by its slot delta. */
export const setLane = (field: "nodes" | "states", index: number, laneId: string) =>
  setSpecField(field, index, "lane", laneId);

/** Dataflow stage reassignment; the member moves by its slot delta. */
export const setStage = (index: number, stage: number) => setSpecField("nodes", index, "stage", stage);

/**
 * Move message `index` one step earlier (-1) or later (+1) in sequence order:
 * swap both `y` and array position with its neighbour. No-op at the ends.
 * Segment and activation ranges are y-pixel ranges and are kept as they are;
 * a range containing either y is reported.
 */
export function moveMessage(index: number, direction: -1 | 1): SpecTransform {
  return (spec) => {
    const messages = specEntries(spec, "messages");
    const order = sequenceOrder(spec);
    const position = order.indexOf(index);
    const neighbour = position < 0 ? undefined : order[position + direction];
    const a = messages[index];
    const b = neighbour === undefined ? undefined : messages[neighbour];
    if (neighbour === undefined || !a || !b) return null;
    const next = [...messages];
    next[index] = { ...b, y: a.y };
    next[neighbour] = { ...a, y: b.y };
    const ys = [a.y, b.y].filter((y): y is number => typeof y === "number");
    const rangeHits = ["segments", "activations"].some((field) =>
      specEntries(spec, field).some((range) => {
        if (typeof range.from !== "number" || typeof range.to !== "number") return false;
        const [low, high] = [Math.min(range.from, range.to), Math.max(range.from, range.to)];
        return ys.some((y) => y >= low && y <= high);
      }),
    );
    return {
      spec: { ...spec, messages: next },
      warnings: rangeHits ? [{ key: "diagram.semantic.sequenceRangesKept" }] : [],
    };
  };
}

/** Detach dataset `datasetId` to freeform (one undo entry when wrapped in `withSnapshot`). */
export function detachSemanticDatasetAction(datasetId: string): StateTransformer {
  return (state) => {
    const { doc } = detachSemanticDataset(state.doc, datasetId);
    return doc === state.doc ? state : { ...state, doc };
  };
}
