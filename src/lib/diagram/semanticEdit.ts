/**
 * Structural semantic edits (issue #433 P2).
 *
 * A structural edit is a spec edit: {@link planSemanticEdit} transforms the
 * dataset's spec, runs `validateSemanticContent`, and routes the result
 * through P1's audited path (`buildProposalFromCandidate` with scope = the
 * dataset's members, current locks and a touched filter, then
 * `prepareProposalApply`), so the caller commits exactly one `withSnapshot`
 * undo entry. Only canvas members whose projection changed are touched, so
 * canvas drift on other members survives. Planning stays synchronous; apply
 * controllers must use semanticApply's pinned-engine gate before committing.
 */

import type { StateTransformer } from "./actions";
import { floorplanDescendants } from "./floorplan";
import { buildProposalFromCandidate, prepareProposalApply, type ProposalMeta } from "./proposal";
import {
  SEMANTIC_TYPES,
  datasetHasContainers,
  detachSemanticDataset,
  floorplanRefNode,
  projectSemanticDataset,
  semanticContainerId,
  semanticDatasetsOf,
  semanticMemberNodeIds,
  sequenceOrder,
  semanticContainers,
  specEntries,
  validateSemanticContent,
  type SemanticContainerRole,
} from "./semantic";
import { createDiagramId, DIAGRAM_SCHEMA_VERSION, type DiagramStateRoot } from "./types";
import type { ValidationDiagnostic } from "./validation";
import type { SemanticDiagramType } from "./reportTypes";

/**
 * Keep a floorplan's canvas nodes parent-first like a fresh projection, so a
 * reparented node is not painted under its new (opaque) parent section. The
 * dataset's nodes keep their slots among freeform nodes.
 */
function reorderFloorplanNodes(state: DiagramStateRoot, dataset: Parameters<typeof projectSemanticDataset>[0]): DiagramStateRoot {
  const order = new Map(projectSemanticDataset(dataset).nodes.map((node, index) => [node.id, index]));
  const owned = new Set(semanticMemberNodeIds(state.doc, dataset.id));
  const sorted = state.doc.nodes.filter((node) => owned.has(node.id))
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  let slot = 0;
  const nodes = state.doc.nodes.map((node) => owned.has(node.id) ? sorted[slot++]! : node);
  return nodes.every((node, index) => node === state.doc.nodes[index]) ? state : { ...state, doc: { ...state.doc, nodes } };
}

/** A spec edit: the next spec plus warnings, or null when nothing changes. */
export type SpecTransform = (
  spec: Record<string, unknown>,
) => {
  spec: Record<string, unknown>;
  warnings?: ValidationDiagnostic[];
  containerIndexRemaps?: readonly SemanticContainerIndexRemap[];
  /** Index-keyed relation edges (floorplan): where each old edge index moved. */
  edgeIndexRemaps?: readonly SemanticEdgeIndexRemap[];
} | null;

/** Canvas identity remap for an index-keyed relation collection (`<datasetId>-e<index>`). */
export interface SemanticEdgeIndexRemap {
  oldIndex: number;
  newIndex: number | null;
}

/**
 * Rename surviving canvas edges to their new index ids and drop removed
 * ones, so a survivor keeps its own style and routing instead of inheriting
 * the removed edge's.
 */
function remapEdgeIndexCanvas(
  state: DiagramStateRoot,
  datasetId: string,
  remaps: readonly SemanticEdgeIndexRemap[],
): DiagramStateRoot {
  const byOld = new Map(remaps.map((remap) => [`${datasetId}-e${remap.oldIndex}`, remap.newIndex]));
  const edges = state.doc.edges.flatMap((edge) => {
    if (!byOld.has(edge.id)) return [edge];
    const next = byOld.get(edge.id);
    return next === null || next === undefined ? [] : [{ ...edge, id: `${datasetId}-e${next}` }];
  });
  const selection = state.ephemeral.selection;
  return {
    ...state,
    doc: { ...state.doc, edges },
    ephemeral: {
      ...state.ephemeral,
      selection: {
        nodes: selection.nodes,
        edges: new Set([...selection.edges].flatMap((id) => {
          if (!byOld.has(id)) return [id];
          const next = byOld.get(id);
          return next === null || next === undefined ? [] : [`${datasetId}-e${next}`];
        })),
      },
    },
  };
}

/** Transient canvas identity remap for an index-keyed semantic container collection. */
export interface SemanticContainerIndexRemap {
  field: string;
  role: SemanticContainerRole;
  oldIndex: number;
  newIndex: number | null;
}

export interface SemanticEntryTarget { field: string; index: number }
export interface SemanticCascadeEffect {
  field: string;
  index: number;
  label: string;
  action: "remove" | "unlink";
}

export type SemanticEditOutcome =
  | { status: "applied"; transformer: StateTransformer; warnings: ValidationDiagnostic[] }
  | { status: "unchanged" }
  | { status: "invalid"; diagnostics: ValidationDiagnostic[] };

/** Canvas ids whose projection differs between two versions of a dataset. */
function changedProjectionIds(
  state: DiagramStateRoot,
  before: Parameters<typeof projectSemanticDataset>[0],
  after: Parameters<typeof projectSemanticDataset>[0],
  forceContainers = false,
  previousNodeIdRemap: ReadonlyMap<string, string> = new Map(),
): Set<string> {
  const opts = { containers: forceContainers || datasetHasContainers(state.doc, before.id), doc: state.doc };
  const previous = projectSemanticDataset(before, opts);
  const a = {
    ...previous,
    nodes: previous.nodes.map((node) => {
      const id = previousNodeIdRemap.get(node.id);
      return id ? { ...node, id } : node;
    }),
  };
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

interface RemappedPlanningState {
  state: DiagramStateRoot;
  nodeIdRemap: ReadonlyMap<string, string>;
}

function remapIndexContainerCanvas(
  state: DiagramStateRoot,
  datasetId: string,
  remaps: readonly SemanticContainerIndexRemap[],
  capturedNodeIdRemap?: ReadonlyMap<string, string>,
): RemappedPlanningState | { diagnostics: ValidationDiagnostic[] } {
  const nodeIdRemap = new Map(capturedNodeIdRemap ?? []);
  const removedNodeMarkers = new Map<string, string>();
  const sourceIds = new Set<string>();
  const occupied = new Set(state.doc.nodes.map((node) => node.id));

  for (const remap of capturedNodeIdRemap ? [] : remaps) {
    const oldId = semanticContainerId(datasetId, remap.role, String(remap.oldIndex));
    const existing = state.doc.nodes.find((node) => node.id === oldId);
    if (existing) {
      const expectedMemberId = `${datasetId}:${remap.role}:${remap.oldIndex}`;
      if (existing.meta?.semanticContainer !== remap.role || existing.meta?.memberId !== expectedMemberId) {
        return { diagnostics: [{ key: "diagram.proposal.idCollision", params: { id: oldId } }] };
      }
      sourceIds.add(oldId);
    }
    let newId: string;
    if (remap.newIndex === null) {
      do {
        newId = createDiagramId("semantic-remap");
      } while (occupied.has(newId) || [...nodeIdRemap.values()].includes(newId));
      removedNodeMarkers.set(newId, `${datasetId}:${remap.role}:tombstone:${remap.oldIndex}`);
    } else {
      newId = semanticContainerId(datasetId, remap.role, String(remap.newIndex));
    }
    nodeIdRemap.set(oldId, newId);
  }

  for (const [oldId, newId] of nodeIdRemap) {
    const source = state.doc.nodes.find((node) => node.id === oldId);
    if (source) {
      const match = remaps.find((entry) => semanticContainerId(datasetId, entry.role, String(entry.oldIndex)) === oldId);
      const expectedMemberId = match ? `${datasetId}:${match.role}:${match.oldIndex}` : null;
      if (!expectedMemberId || source.meta?.semanticContainer !== match?.role || source.meta?.memberId !== expectedMemberId) {
        return { diagnostics: [{ key: "diagram.proposal.idCollision", params: { id: oldId } }] };
      }
      sourceIds.add(oldId);
      if (match?.newIndex === null) removedNodeMarkers.set(newId, `${datasetId}:${match.role}:tombstone:${match.oldIndex}`);
    }
  }
  for (const [oldId, newId] of nodeIdRemap) {
    if (oldId === newId) continue;
    const owner = state.doc.nodes.find((node) => node.id === newId);
    if (owner && !sourceIds.has(newId)) {
      return { diagnostics: [{ key: "diagram.proposal.idCollision", params: { id: newId } }] };
    }
  }

  const nodes = state.doc.nodes.map((node) => {
    const id = nodeIdRemap.get(node.id);
    if (!id) return node;
    const marker = removedNodeMarkers.get(id);
    const match = remaps.find((entry) => semanticContainerId(datasetId, entry.role, String(entry.oldIndex)) === node.id);
    const memberId = marker ?? (match?.newIndex === null
      ? node.meta?.memberId
      : `${datasetId}:${match?.role}:${match?.newIndex}`);
    return { ...node, id, meta: { ...node.meta, ...(memberId ? { memberId } : {}) } };
  });
  const edges = state.doc.edges.map((edge) => {
    const fromNode = nodeIdRemap.get(edge.fromNode) ?? edge.fromNode;
    const toNode = nodeIdRemap.get(edge.toNode) ?? edge.toNode;
    return fromNode === edge.fromNode && toNode === edge.toNode ? edge : { ...edge, fromNode, toNode };
  });
  const selection = state.ephemeral.selection;
  const remappedState: DiagramStateRoot = {
    ...state,
    doc: { ...state.doc, nodes, edges },
    ephemeral: {
      ...state.ephemeral,
      selection: {
        nodes: new Set([...selection.nodes].map((id) => nodeIdRemap.get(id) ?? id)),
        edges: selection.edges,
      },
    },
  };
  return { state: remappedState, nodeIdRemap };
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
  if (
    dataset.diagramType === "lifecycle" &&
    specEntries(dataset.spec, "lanes").some((lane) => lane.id === "main") &&
    !specEntries(result.spec, "lanes").some((lane) => lane.id === "main")
  ) {
    return { status: "invalid", diagnostics: [{ key: "diagram.semantic.reservedMainLane" }] };
  }
  const content = validateSemanticContent(dataset.diagramType, result.spec);
  if (content.length > 0) return { status: "invalid", diagnostics: content };

  const edgeRemapped = result.edgeIndexRemaps?.length ? remapEdgeIndexCanvas(state, datasetId, result.edgeIndexRemaps) : state;
  const preparedRemap = result.containerIndexRemaps?.length
    ? remapIndexContainerCanvas(edgeRemapped, datasetId, result.containerIndexRemaps)
    : { state: edgeRemapped, nodeIdRemap: new Map<string, string>() };
  if ("diagnostics" in preparedRemap) return { status: "invalid", diagnostics: preparedRemap.diagnostics };
  const planningState = preparedRemap.state;
  const previousNodeIdRemap = preparedRemap.nodeIdRemap;

  const next = { ...dataset, spec: result.spec };
  const descriptor = SEMANTIC_TYPES[dataset.diagramType];
  const addsFirstContainer = semanticContainers(descriptor).some(({ field }) =>
    specEntries(result.spec, field).length > specEntries(dataset.spec, field).length &&
    !datasetHasContainers(planningState.doc, dataset.id),
  );
  const meta: ProposalMeta = {
    jobId: "semantic-edit",
    docId: planningState.doc.id,
    schemaVersion: DIAGRAM_SCHEMA_VERSION,
    baseMemoryRevision: "",
    baseStorageRevision: null,
    scope: new Set(semanticMemberNodeIds(planningState.doc, datasetId)),
    lockedNodeIds: planningState.doc.nodes.filter((node) => node.locked === true).map((node) => node.id),
  };
  const { proposal } = buildProposalFromCandidate(meta, next, planningState.doc, {
    touched: changedProjectionIds(planningState, dataset, next, addsFirstContainer, previousNodeIdRemap),
    previousNodeIdRemap,
    ...(addsFirstContainer ? { containers: true } : {}),
  });
  const outcome = prepareProposalApply(planningState, proposal, "");
  if (outcome.status === "applied") {
    const applyProposal = outcome.transformer;
    const transformer: StateTransformer = (current) => {
      const committed = commit(current);
      return dataset.diagramType === "floorplan" && committed.doc !== current.doc ? reorderFloorplanNodes(committed, next) : committed;
    };
    const commit: StateTransformer = (current) => {
      if (current.doc !== state.doc) return current;
      if (result.edgeIndexRemaps?.length) current = remapEdgeIndexCanvas(current, datasetId, result.edgeIndexRemaps);
      if (result.containerIndexRemaps?.length) {
        const remapped = remapIndexContainerCanvas(current, datasetId, result.containerIndexRemaps, previousNodeIdRemap);
        if ("diagnostics" in remapped) return current;
        return applyProposal(remapped.state);
      }
      return applyProposal(current);
    };
    return { status: "applied", transformer, warnings: result.warnings ?? [] };
  }
  const diagnostics = outcome.status === "invalid" ? outcome.diagnostics : [];
  if (previousNodeIdRemap.size === 0) return { status: "invalid", diagnostics };
  const originalIdByRemappedId = new Map([...previousNodeIdRemap].map(([originalId, remappedId]) => [remappedId, originalId]));
  return {
    status: "invalid",
    diagnostics: diagnostics.map((diagnostic) => {
      const id = diagnostic.params?.id;
      const originalId = typeof id === "string" ? originalIdByRemappedId.get(id) : undefined;
      return originalId ? { ...diagnostic, params: { ...diagnostic.params, id: originalId } } : diagnostic;
    }),
  };
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

const entryLabel = (entry: Record<string, unknown>, fallback: string) =>
  typeof entry.label === "string" && entry.label.length > 0 ? entry.label : fallback;

function isValidWorkflowMainPath(path: readonly unknown[], edges: readonly Record<string, unknown>[]): boolean {
  return path.length >= 2 && path.every((id) => typeof id === "string") &&
    path.slice(1).every((to, index) => edges.some((edge) => edge.from === path[index] && edge.to === to));
}

function hasWorkflowPath(edges: readonly Record<string, unknown>[], from: string, to: string): boolean {
  if (from === to) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const pending = [from];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (next === to) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(next);
    }
  }
  return false;
}

function mintSpecId(type: SemanticDiagramType, field: string, spec: Record<string, unknown>): string {
  const used = new Set(
    Object.values(spec).flatMap((value) =>
      Array.isArray(value)
        ? value.flatMap((entry) =>
            typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
              ? [(entry as { id: string }).id]
              : [],
          )
        : [],
    ),
  );
  const prefix = field.replace(/s$/, "") || type;
  let id = `${prefix}-${createDiagramId(prefix).replace(/[^a-zA-Z0-9_-]/g, "")}`;
  while (used.has(id)) id = `${prefix}-${createDiagramId(prefix).replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return id;
}

function remapSequenceRanges(
  source: Record<string, unknown>,
  next: Record<string, unknown>,
  oldToNewY: ReadonlyMap<number, number>,
): Record<string, unknown> {
  const messages = specEntries(source, "messages");
  const anchors = messages
    .map((entry) => ({ old: entry.y, next: oldToNewY.get(messages.indexOf(entry)) }))
    .filter((item): item is { old: number; next: number } =>
      typeof item.old === "number" && Number.isFinite(item.old) && typeof item.next === "number",
    )
    .sort((a, b) => a.old - b.old);
  if (anchors.length === 0) return next;
  const mapY = (y: unknown): unknown => {
    if (typeof y !== "number" || !Number.isFinite(y)) return y;
    if (anchors.length === 1) return y + (anchors[0]!.next - anchors[0]!.old);
    let left = anchors[anchors.length - 2]!;
    let right = anchors[anchors.length - 1]!;
    for (let i = 1; i < anchors.length; i++) {
      if (y <= anchors[i]!.old) { left = anchors[i - 1]!; right = anchors[i]!; break; }
    }
    const span = right.old - left.old;
    if (span === 0) return left.next;
    return left.next + ((y - left.old) / span) * (right.next - left.next);
  };
  const updated: Record<string, unknown> = { ...next };
  for (const field of ["segments", "activations"]) {
    if (!Array.isArray(next[field])) continue;
    updated[field] = specEntries(next, field).map((range) => {
      const from = mapY(range.from);
      const to = mapY(range.to);
      // Removing a leading block can extrapolate a surviving segment above
      // the timeline. Keep its frame on the pinned renderer's canvas.
      if (field === "segments" && typeof from === "number" && typeof to === "number") {
        const start = Math.max(72, from);
        return { ...range, from: start, to: Math.max(start + 1, to) };
      }
      return { ...range, from, to };
    });
  }
  return updated;
}

function growSequenceViewBox(spec: Record<string, unknown>): Record<string, unknown> {
  const meta = spec.meta;
  if (typeof meta !== "object" || meta === null) return spec;
  const authored = (meta as Record<string, unknown>).viewBox;
  const viewBox = Array.isArray(authored) ? [...authored] : [920, 760];
  if (typeof viewBox[0] !== "number" || typeof viewBox[1] !== "number") return spec;
  const messages = specEntries(spec, "messages");
  const activations = specEntries(spec, "activations");
  const segments = specEntries(spec, "segments");
  const participantCount = specEntries(spec, "participants").length;
  const spread = (meta as Record<string, unknown>).column_fit === "spread";
  const requiredWidth = (spread ? 188 : 145) + Math.max(0, participantCount - 1) * 108;
  const contentBottom = Math.max(
    0,
    ...messages.map((message) => typeof message.y === "number" ? message.y + (message.note ? 22 : 6) : 0),
    ...activations.map((activation) => typeof activation.to === "number" ? activation.to : 0),
    ...segments.map((segment) => typeof segment.to === "number" ? segment.to : 0),
  );
  // There are at most five sequence legend entries. A legal 80-character
  // override can force each entry onto its own row at the default width.
  const legendIsHidden =
    typeof (meta as Record<string, unknown>).legend === "object" &&
    (meta as { legend?: { mode?: unknown } }).legend?.mode === "hidden";
  const legendClearance = legendIsHidden ? 0 : 12 + 86 + 4 * 22;
  const requiredHeight = Math.max(
    ...messages.map((message) => typeof message.y === "number" ? message.y + 83 : 0),
    ...segments.map((segment) => typeof segment.to === "number" ? segment.to + 45 : 0),
    ...activations.map((activation) => typeof activation.to === "number" ? activation.to + 45 : 0),
    legendClearance > 0 ? contentBottom + legendClearance : 0,
    760,
  );
  if (requiredWidth <= viewBox[0] && requiredHeight <= viewBox[1]) return spec;
  viewBox[0] = Math.max(viewBox[0], requiredWidth);
  viewBox[1] = Math.max(viewBox[1], requiredHeight);
  return { ...spec, meta: { ...meta, viewBox } };
}

/** Add a schema-valid semantic collection entry, minting its stable spec id when required. */
export function addSemanticEntry(
  type: SemanticDiagramType,
  field: string,
  entry: Record<string, unknown>,
  index?: number,
): SpecTransform {
  return (spec) => {
    const descriptor = SEMANTIC_TYPES[type];
    const isManaged = field === descriptor.entities || field === descriptor.relations ||
      [descriptor.container, ...(descriptor.additionalContainers ?? [])].some((item) => item?.field === field);
    if (!isManaged) return null;
    const entries = specEntries(spec, field);
    const at = Math.max(0, Math.min(entries.length, index ?? entries.length));
    const added = { ...entry };
    const idKeyedContainer = [descriptor.container, ...(descriptor.additionalContainers ?? [])]
      .some((container) => container?.field === field && container.keyedBy === "id");
    const requiresId = field === descriptor.entities || (field === descriptor.relations && !descriptor.noRelationIds) || idKeyedContainer;
    if (requiresId && (typeof added.id !== "string" || added.id.length === 0)) {
      added.id = mintSpecId(type, field, spec);
    }
    const nextEntries = [...entries.slice(0, at), added, ...entries.slice(at)];
    let next: Record<string, unknown> = { ...spec, [field]: nextEntries };
    if (type === "dataflow" && field === "stages") {
      next.nodes = specEntries(spec, "nodes").map((node) => {
        const stage = node.stage;
        return typeof stage === "number" && stage >= at ? { ...node, stage: stage + 1 } : node;
      });
    }
    if (type === "sequence" && field === "messages") {
      const oldOrder = sequenceOrder(spec);
      const foundInsertionPosition = oldOrder.findIndex((oldIndex) => oldIndex >= at);
      const insertAt = foundInsertionPosition < 0 ? oldOrder.length : foundInsertionPosition;
      const order = [...oldOrder.slice(0, insertAt), at, ...oldOrder.slice(insertAt).map((old) => old >= at ? old + 1 : old)];
      const firstY = Math.min(180, ...specEntries(spec, "messages").map((message) => typeof message.y === "number" ? message.y : 180));
      const oldToNew = new Map<number, number>();
      const nextMessages = [...nextEntries];
      order.forEach((messageIndex, position) => {
        const y = firstY + position * 50;
        if (messageIndex === at) nextMessages[messageIndex] = { ...nextMessages[messageIndex], y };
        else {
          const originalIndex = messageIndex < at ? messageIndex : messageIndex - 1;
          oldToNew.set(originalIndex, y);
          nextMessages[messageIndex] = { ...nextMessages[messageIndex], y };
        }
      });
      next = growSequenceViewBox(remapSequenceRanges(spec, { ...next, messages: nextMessages }, oldToNew));
    }
    if (type === "sequence") next = growSequenceViewBox(next);
    const indexedContainer = semanticContainers(descriptor).find((container) => container.field === field && container.keyedBy === "index");
    const containerIndexRemaps = indexedContainer
      ? entries.map((_, oldIndex) => ({
          field,
          role: indexedContainer.role,
          oldIndex,
          newIndex: oldIndex >= at ? oldIndex + 1 : oldIndex,
        })).filter((remap) => remap.newIndex !== remap.oldIndex)
      : [];
    const edgeIndexRemaps: SemanticEdgeIndexRemap[] = type === "floorplan" && field === "edges"
      ? entries.flatMap((_, oldIndex) => oldIndex >= at ? [{ oldIndex, newIndex: oldIndex + 1 }] : [])
      : [];
    return {
      spec: next,
      ...(containerIndexRemaps.length > 0 ? { containerIndexRemaps } : {}),
      ...(edgeIndexRemaps.length > 0 ? { edgeIndexRemaps } : {}),
    };
  };
}

/** Remove selected semantic entries and the references that would otherwise dangle. */
export function removeSemanticEntries(
  type: SemanticDiagramType,
  spec: Record<string, unknown>,
  targets: readonly SemanticEntryTarget[],
): { transform: SpecTransform; effects: SemanticCascadeEffect[] } {
  if (type === "floorplan") return removeFloorplanEntries(spec, targets);
  const descriptor = SEMANTIC_TYPES[type];
  const supported = new Set([descriptor.entities, descriptor.relations, descriptor.container?.field,
    ...(descriptor.additionalContainers ?? []).map((item) => item.field)].filter((field): field is string => Boolean(field)));
  const removals = new Map<string, Set<number>>();
  const effects: SemanticCascadeEffect[] = [];
  const addRemoval = (field: string, index: number, action: "remove" | "unlink" = "remove") => {
    if (!supported.has(field) && field !== "phases" && field !== "groups" && field !== "segments" && field !== "activations") return;
    const entries = specEntries(spec, field);
    const entry = entries[index];
    if (!entry || removals.get(field)?.has(index)) return;
    if (!removals.has(field)) removals.set(field, new Set());
    removals.get(field)!.add(index);
    effects.push({ field, index, label: entryLabel(entry, field), action });
  };
  for (const target of targets) if (supported.has(target.field)) addRemoval(target.field, target.index);
  if (removals.size === 0) return { transform: () => null, effects };

  const removedEntityIds = new Set<string>();
  const removedLaneIds = new Set<string>();
  if (type === "workflow" || type === "lifecycle") {
    for (const index of removals.get("lanes") ?? []) {
      const id = specEntries(spec, "lanes")[index]?.id;
      if (typeof id === "string") removedLaneIds.add(id);
    }
    specEntries(spec, descriptor.entities).forEach((entity, index) => {
      if (removedLaneIds.has(String(entity.lane))) addRemoval(descriptor.entities, index);
    });
    if (type === "workflow") specEntries(spec, "groups").forEach((group, index) => {
      if (removedLaneIds.has(String(group.lane))) addRemoval("groups", index);
    });
  }
  if (type === "dataflow") {
    const deletedStages = [...(removals.get("stages") ?? [])].sort((a, b) => a - b);
    specEntries(spec, "nodes").forEach((node, index) => {
      if (deletedStages.includes(Number(node.stage))) addRemoval("nodes", index);
    });
  }
  for (const index of removals.get(descriptor.entities) ?? []) {
    const id = specEntries(spec, descriptor.entities)[index]?.id;
    if (typeof id === "string") removedEntityIds.add(id);
  }
  if (type === "workflow") specEntries(spec, "groups").forEach((group, index) => {
    if (removals.get("groups")?.has(index)) return;
    const remains = specEntries(spec, "nodes").some((node, nodeIndex) =>
      !removals.get("nodes")?.has(nodeIndex) && node.lane === group.lane && typeof node.col === "number" &&
      typeof group.fromCol === "number" && typeof group.toCol === "number" && node.col >= group.fromCol && node.col <= group.toCol,
    );
    if (!remains) addRemoval("groups", index);
  });
  for (const index of removals.get(descriptor.entities) ?? []) {
    const entity = specEntries(spec, descriptor.entities)[index];
    if (!entity) continue;
    const id = entity.id;
    specEntries(spec, descriptor.relations).forEach((relation, relationIndex) => {
      if (relation.from === id || relation.to === id) addRemoval(descriptor.relations, relationIndex);
    });
    if (type === "sequence" && typeof id === "string") specEntries(spec, "activations").forEach((activation, activationIndex) => {
      if (activation.participant === id) addRemoval("activations", activationIndex);
    });
  }
  const droppedWorkflowChecks = new Map<string, Set<number>>();
  if (type === "workflow") {
    const remainingEdges = specEntries(spec, "edges").filter((edge, index) =>
      !removals.get("edges")?.has(index) &&
      !removedEntityIds.has(String(edge.from)) &&
      !removedEntityIds.has(String(edge.to)),
    );
    const checks = spec.semanticChecks as Record<string, unknown> | undefined;
    if (checks) {
      for (const field of ["requiredEdges", "requiredPaths"]) {
        const entries = Array.isArray(checks[field]) ? checks[field] as Record<string, unknown>[] : [];
        const dropped = new Set<number>();
        entries.forEach((check, index) => {
          if (typeof check.from !== "string" || typeof check.to !== "string" ||
              removedEntityIds.has(check.from) || removedEntityIds.has(check.to)) {
            dropped.add(index);
          } else if (field === "requiredEdges") {
            if (!remainingEdges.some((edge) => edge.from === check.from && edge.to === check.to)) dropped.add(index);
          } else if (!hasWorkflowPath(remainingEdges, check.from, check.to)) {
            dropped.add(index);
          }
        });
        if (dropped.size > 0) droppedWorkflowChecks.set(field, dropped);
      }
    }
  }
  if (type === "architecture" && removedEntityIds.size > 0) {
    specEntries(spec, "boundaries").forEach((boundary, index) => {
      if (removals.get("boundaries")?.has(index)) return;
      const wraps = Array.isArray(boundary.wraps) ? boundary.wraps : [];
      if (!wraps.some((id) => removedEntityIds.has(String(id)))) return;
      if (wraps.every((id) => removedEntityIds.has(String(id)))) addRemoval("boundaries", index);
      else effects.push({ field: "boundaries", index, label: entryLabel(boundary, "Boundary"), action: "unlink" });
    });
  }
  if (type === "dataflow" && removals.has("stages")) {
    const deletedStages = removals.get("stages")!;
    specEntries(spec, "nodes").forEach((node, index) => {
      if (removals.get("nodes")?.has(index)) return;
      const nodeStage = node.stage;
      if (typeof nodeStage === "number" && [...deletedStages].some((stage) => stage < nodeStage)) {
        effects.push({ field: "nodes", index, label: entryLabel(node, "Node"), action: "unlink" });
      }
    });
  }
  if (type === "sequence" && removals.has("messages")) {
    for (const field of ["segments", "activations"]) specEntries(spec, field).forEach((range, index) => {
      if (removals.get(field)?.has(index)) return;
      effects.push({ field, index, label: entryLabel(range, field), action: "unlink" });
    });
  }
  if (type === "workflow") {
    const mainPath = Array.isArray(spec.mainPath) ? spec.mainPath : [];
    const remainingMainPath = mainPath.filter((id) => !removedEntityIds.has(String(id)));
    const remainingEdges = specEntries(spec, "edges").filter((_, index) => !removals.get("edges")?.has(index));
    const pathIsAffected = mainPath.length !== remainingMainPath.length ||
      [...(removals.get("edges") ?? [])].some((index) => {
        const removedEdge = specEntries(spec, "edges")[index];
        return mainPath.some((from, pathIndex) => pathIndex < mainPath.length - 1 && from === removedEdge?.from && mainPath[pathIndex + 1] === removedEdge?.to);
      });
    if (Array.isArray(spec.mainPath) && !isValidWorkflowMainPath(remainingMainPath, remainingEdges)) {
      effects.push({ field: "mainPath", index: -1, label: "mainPath", action: "remove" });
    } else if (pathIsAffected) {
      mainPath.forEach((id, index) => {
        if (removedEntityIds.has(String(id))) effects.push({ field: "mainPath", index, label: "mainPath", action: "unlink" });
      });
    }
  }
  if (type === "workflow") {
    const checks = spec.semanticChecks as Record<string, unknown> | undefined;
    if (checks) {
      for (const key of ["allowedRoots", "allowedTerminals"]) {
        (Array.isArray(checks[key]) ? checks[key] as unknown[] : []).forEach((id, index) => {
          if (typeof id === "string" && removedEntityIds.has(id)) {
            effects.push({ field: `semanticChecks.${key}`, index, label: key, action: "unlink" });
          }
        });
      }
      for (const key of ["requiredEdges", "requiredPaths"]) {
        for (const index of droppedWorkflowChecks.get(key) ?? []) {
          effects.push({ field: `semanticChecks.${key}`, index, label: key, action: "remove" });
        }
      }
    }
  }

  const containerIndexRemaps: SemanticContainerIndexRemap[] = [];
  for (const container of semanticContainers(descriptor)) {
    if (container.keyedBy !== "index") continue;
    const removedIndexes = removals.get(container.field);
    if (!removedIndexes?.size) continue;
    specEntries(spec, container.field).forEach((_, oldIndex) => {
      const newIndex = removedIndexes.has(oldIndex)
        ? null
        : oldIndex - [...removedIndexes].filter((removedIndex) => removedIndex < oldIndex).length;
      if (newIndex !== oldIndex) containerIndexRemaps.push({ field: container.field, role: container.role, oldIndex, newIndex });
    });
  }

  const transform: SpecTransform = (current) => {
    if (current !== spec || effects.length === 0) return null;
    let next: Record<string, unknown> = { ...spec };
    for (const [field, indexes] of removals) {
      const values = specEntries(spec, field);
      next[field] = values.filter((_, index) => !indexes.has(index));
    }
    if (type === "architecture" && removedEntityIds.size > 0) {
      next.boundaries = specEntries(next, "boundaries").map((boundary) => ({
        ...boundary,
        wraps: Array.isArray(boundary.wraps) ? boundary.wraps.filter((id) => !removedEntityIds.has(String(id))) : [],
      })).filter((boundary) => (boundary.wraps as unknown[]).length > 0);
    }
    if (type === "workflow" && Array.isArray(spec.mainPath)) {
      const mainPath = spec.mainPath.filter((id) => !removedEntityIds.has(String(id)));
      if (mainPath.length === 0 || !isValidWorkflowMainPath(mainPath, specEntries(next, "edges"))) delete next.mainPath;
      else next.mainPath = mainPath;
    }
    if (type === "workflow" && (removedEntityIds.size > 0 || droppedWorkflowChecks.size > 0)) {
      const checks = spec.semanticChecks as Record<string, unknown> | undefined;
      if (checks) {
        const clean = { ...checks };
        for (const key of ["allowedRoots", "allowedTerminals"]) {
          if (Array.isArray(clean[key])) clean[key] = (clean[key] as unknown[]).filter((id) => !removedEntityIds.has(String(id)));
        }
        for (const key of ["requiredEdges", "requiredPaths"]) {
          if (Array.isArray(clean[key])) clean[key] = (clean[key] as unknown[]).filter((_, index) => !droppedWorkflowChecks.get(key)?.has(index));
        }
        if (Object.keys(clean).length > 0) next.semanticChecks = clean;
        else delete next.semanticChecks;
      }
    }
    if (type === "dataflow" && removals.has("stages")) {
      const removed = removals.get("stages")!;
      next.nodes = specEntries(next, "nodes").map((node) => {
        const stage = node.stage;
        if (typeof stage !== "number") return { ...node };
        const removedBefore = [...removed].filter((removedIndex) => removedIndex < stage).length;
        return { ...node, stage: stage - removedBefore };
      });
    }
    if (type === "sequence" && removals.has("messages")) {
      const oldMessages = specEntries(spec, "messages");
      const oldOrder = sequenceOrder(spec).filter((index) => !removals.get("messages")!.has(index));
      const baseY = Math.min(180, ...oldMessages.map((message) => typeof message.y === "number" ? message.y : 180));
      const oldToNew = new Map<number, number>();
      const kept = oldMessages.filter((_, index) => !removals.get("messages")!.has(index));
      oldOrder.forEach((index, rank) => oldToNew.set(index, baseY + rank * 50));
      const keptOriginalIndexes = oldMessages.map((_, index) => index).filter((index) => !removals.get("messages")!.has(index));
      next.messages = kept.map((message, index) => ({ ...message, y: oldToNew.get(keptOriginalIndexes[index]!) }));
      next = growSequenceViewBox(remapSequenceRanges(spec, next, oldToNew));
    }
    return { spec: next, ...(containerIndexRemaps.length > 0 ? { containerIndexRemaps } : {}) };
  };
  return { transform, effects };
}

/**
 * Floorplan removal (issue #535). Removing a node removes its descendants,
 * every edge, flow step and tour stop that names a removed node, and the
 * annotations whose file only a removed node claimed. A flow left with fewer
 * than two steps is removed whole. Refs are resolved on the spec before the
 * edit: a file path counts as removed when it resolved to a removed node and
 * resolves to nothing afterwards.
 */
function removeFloorplanEntries(
  spec: Record<string, unknown>,
  targets: readonly SemanticEntryTarget[],
): { transform: SpecTransform; effects: SemanticCascadeEffect[] } {
  const nodes = specEntries(spec, "nodes");
  const edges = specEntries(spec, "edges");
  const effects: SemanticCascadeEffect[] = [];
  const removedNodes = new Set<number>();
  const removedEdges = new Set<number>();
  const direct = new Set<string>();
  for (const target of targets) {
    if (target.field === "nodes" && nodes[target.index]) {
      removedNodes.add(target.index);
      const id = nodes[target.index]!.id;
      if (typeof id === "string") direct.add(id);
    } else if (target.field === "edges" && edges[target.index]) removedEdges.add(target.index);
  }
  if (removedNodes.size === 0 && removedEdges.size === 0) return { transform: () => null, effects };
  const descendants = floorplanDescendants(spec, direct);
  nodes.forEach((node, index) => {
    if (typeof node.id === "string" && descendants.has(node.id)) removedNodes.add(index);
  });
  const removedIds = new Set([...removedNodes].map((index) => nodes[index]!.id).filter((id): id is string => typeof id === "string"));
  const keptNodes = nodes.filter((_, index) => !removedNodes.has(index));
  const after = { ...spec, nodes: keptNodes };
  const gone = (ref: unknown): boolean => {
    if (typeof ref !== "string") return false;
    if (removedIds.has(ref)) return true;
    const before = floorplanRefNode(spec, ref);
    return before !== null && removedIds.has(before) && floorplanRefNode(after, ref) === null;
  };
  [...removedNodes].sort((a, b) => a - b).forEach((index) =>
    effects.push({ field: "nodes", index, label: entryLabel(nodes[index]!, String(nodes[index]!.id ?? "node")), action: "remove" }));
  edges.forEach((edge, index) => {
    if (!removedEdges.has(index) && (gone(edge.from) || gone(edge.to))) removedEdges.add(index);
  });
  [...removedEdges].sort((a, b) => a - b).forEach((index) => {
    const edge = edges[index]!;
    effects.push({ field: "edges", index, label: entryLabel(edge, `${String(edge.from)} -> ${String(edge.to)}`), action: "remove" });
  });
  const flows = specEntries(spec, "flows");
  const nextFlows: Record<string, unknown>[] = [];
  let flowsChanged = false;
  flows.forEach((flow, index) => {
    const steps = Array.isArray(flow.steps) ? flow.steps : [];
    const kept = steps.filter((step) => !(typeof step === "object" && step !== null && gone((step as Record<string, unknown>).node)));
    if (kept.length === steps.length) return void nextFlows.push(flow);
    flowsChanged = true;
    const label = typeof flow.title === "string" ? flow.title : String(flow.id ?? "flow");
    if (kept.length < 2) effects.push({ field: "flows", index, label, action: "remove" });
    else {
      effects.push({ field: "flows", index, label, action: "unlink" });
      nextFlows.push({ ...flow, steps: kept });
    }
  });
  const tour = Array.isArray(spec.tour) ? spec.tour as unknown[] : [];
  const removedStops = new Set<number>();
  tour.forEach((stop, index) => {
    if (typeof stop !== "object" || stop === null || !gone((stop as Record<string, unknown>).node)) return;
    removedStops.add(index);
    const record = stop as Record<string, unknown>;
    effects.push({ field: "tour", index, label: typeof record.title === "string" ? record.title : String(record.node), action: "remove" });
  });
  const annotations = Array.isArray(spec.annotations) ? spec.annotations as unknown[] : [];
  const removedAnnotations = new Set<number>();
  annotations.forEach((annotation, index) => {
    if (typeof annotation !== "object" || annotation === null || !gone((annotation as Record<string, unknown>).path)) return;
    removedAnnotations.add(index);
    effects.push({ field: "annotations", index, label: String((annotation as Record<string, unknown>).path), action: "remove" });
  });

  const transform: SpecTransform = (current) => {
    if (current !== spec) return null;
    const next: Record<string, unknown> = { ...spec, nodes: keptNodes };
    if (Array.isArray(spec.edges)) next.edges = edges.filter((_, index) => !removedEdges.has(index));
    if (flowsChanged) next.flows = nextFlows;
    if (removedStops.size > 0) next.tour = tour.filter((_, index) => !removedStops.has(index));
    if (removedAnnotations.size > 0) next.annotations = annotations.filter((_, index) => !removedAnnotations.has(index));
    const edgeIndexRemaps: SemanticEdgeIndexRemap[] = [];
    let kept = 0;
    edges.forEach((_, oldIndex) => {
      const newIndex = removedEdges.has(oldIndex) ? null : kept++;
      if (newIndex !== oldIndex) edgeIndexRemaps.push({ oldIndex, newIndex });
    });
    return { spec: next, ...(edgeIndexRemaps.length > 0 ? { edgeIndexRemaps } : {}) };
  };
  return { transform, effects };
}

/** Set the authored membership list of an architecture boundary. */
export function setBoundaryMembership(index: number, ids: readonly string[]): SpecTransform {
  return (spec) => {
    const boundaries = specEntries(spec, "boundaries");
    const boundary = boundaries[index];
    if (!boundary) return null;
    const wraps = [...new Set(ids)];
    if (JSON.stringify(boundary.wraps ?? []) === JSON.stringify(wraps)) return null;
    return { spec: { ...spec, boundaries: boundaries.map((item, at) => at === index ? { ...item, wraps } : item) } };
  };
}

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
