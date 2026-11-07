/**
 * Structural semantic edits (issue #433 P2).
 *
 * A structural edit is a spec edit: {@link planSemanticEdit} transforms the
 * dataset's spec, runs `validateSemanticContent`, and routes the result
 * through P1's audited path (`buildProposalFromCandidate` with scope = the
 * dataset's members, current locks and a touched filter, then
 * `prepareProposalApply`), so the caller commits exactly one `withSnapshot`
 * undo entry. Only canvas members whose projection changed are touched, so
 * canvas drift on other members survives. Manual edits never run the engine
 * (it is async and Tauri-only); the publication gate must.
 */

import type { StateTransformer } from "./actions";
import { buildProposalFromCandidate, prepareProposalApply, type ProposalMeta } from "./proposal";
import {
  SEMANTIC_TYPES,
  datasetHasContainers,
  detachSemanticDataset,
  projectSemanticDataset,
  semanticDatasetsOf,
  semanticMemberNodeIds,
  sequenceOrder,
  semanticContainers,
  specEntries,
  validateSemanticContent,
} from "./semantic";
import { createDiagramId, DIAGRAM_SCHEMA_VERSION, type DiagramStateRoot } from "./types";
import type { ValidationDiagnostic } from "./validation";
import type { SemanticDiagramType } from "./reportTypes";

/** A spec edit: the next spec plus warnings, or null when nothing changes. */
export type SpecTransform = (
  spec: Record<string, unknown>,
) => { spec: Record<string, unknown>; warnings?: ValidationDiagnostic[] } | null;

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
): Set<string> {
  const opts = { containers: forceContainers || datasetHasContainers(state.doc, before.id), doc: state.doc };
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
  const descriptor = SEMANTIC_TYPES[dataset.diagramType];
  const addsFirstContainer = semanticContainers(descriptor).some(({ field }) =>
    specEntries(result.spec, field).length > specEntries(dataset.spec, field).length &&
    !datasetHasContainers(state.doc, dataset.id),
  );
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
    touched: changedProjectionIds(state, dataset, next, addsFirstContainer),
    ...(addsFirstContainer ? { containers: true } : {}),
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

const entryLabel = (entry: Record<string, unknown>, fallback: string) =>
  typeof entry.label === "string" && entry.label.length > 0 ? entry.label : fallback;

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
    let left = anchors[0]!;
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
  const participantCount = specEntries(spec, "participants").length;
  const spread = (meta as Record<string, unknown>).column_fit === "spread";
  const requiredWidth = (spread ? 188 : 145) + Math.max(0, participantCount - 1) * 108;
  const requiredHeight = Math.max(
    ...specEntries(spec, "messages").map((item) => typeof item.y === "number" ? item.y + 83 : 0),
    ...specEntries(spec, "segments").map((item) => typeof item.to === "number" ? item.to + 45 : 0),
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
    const requiresId = field === descriptor.entities || field === descriptor.relations || idKeyedContainer;
    if (requiresId && (typeof added.id !== "string" || added.id.length === 0)) {
      added.id = mintSpecId(type, field, spec);
    }
    const nextEntries = [...entries.slice(0, at), added, ...entries.slice(at)];
    let next: Record<string, unknown> = { ...spec, [field]: nextEntries };
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
    return { spec: next };
  };
}

/** Remove selected semantic entries and the references that would otherwise dangle. */
export function removeSemanticEntries(
  type: SemanticDiagramType,
  spec: Record<string, unknown>,
  targets: readonly SemanticEntryTarget[],
): { transform: SpecTransform; effects: SemanticCascadeEffect[] } {
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
      if (typeof node.stage === "number" && [...deletedStages].some((stage) => stage < node.stage)) {
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
  if (type === "workflow" && removedEntityIds.size > 0) {
    const mainPath = Array.isArray(spec.mainPath) ? spec.mainPath : [];
    const remainingMainPath = mainPath.filter((id) => !removedEntityIds.has(String(id)));
    if (mainPath.length !== remainingMainPath.length && remainingMainPath.length < 2) {
      effects.push({ field: "mainPath", index: -1, label: "mainPath", action: "remove" });
    } else {
      mainPath.forEach((id, index) => {
        if (removedEntityIds.has(String(id))) effects.push({ field: "mainPath", index, label: "mainPath", action: "unlink" });
      });
    }
    const checks = spec.semanticChecks as Record<string, unknown> | undefined;
    if (checks) for (const key of ["allowedRoots", "allowedTerminals", "requiredEdges", "requiredPaths"]) {
      (Array.isArray(checks[key]) ? checks[key] as unknown[] : []).forEach((value, index) => {
        const affected = typeof value === "string" ? removedEntityIds.has(value) : typeof value === "object" && value !== null && [((value as Record<string, unknown>).from), ((value as Record<string, unknown>).to)].some((id) => typeof id === "string" && removedEntityIds.has(id));
        if (affected) effects.push({ field: `semanticChecks.${key}`, index, label: key, action: "unlink" });
      });
    }
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
    if (type === "workflow" && removedEntityIds.size > 0) {
      const mainPath = Array.isArray(spec.mainPath) ? spec.mainPath.filter((id) => !removedEntityIds.has(String(id))) : spec.mainPath;
      if (Array.isArray(mainPath) && mainPath.length < 2) delete next.mainPath;
      else next.mainPath = mainPath;
      const checks = spec.semanticChecks as Record<string, unknown> | undefined;
      if (checks) {
        const clean = { ...checks };
        for (const key of ["allowedRoots", "allowedTerminals"]) if (Array.isArray(clean[key])) clean[key] = (clean[key] as unknown[]).filter((id) => !removedEntityIds.has(String(id)));
        for (const key of ["requiredEdges", "requiredPaths"]) if (Array.isArray(clean[key])) clean[key] = (clean[key] as Record<string, unknown>[]).filter((item) => !removedEntityIds.has(String(item.from)) && !removedEntityIds.has(String(item.to)));
        next.semanticChecks = clean;
      }
    }
    if (type === "dataflow" && removals.has("stages")) {
      const removed = removals.get("stages")!;
      next.nodes = specEntries(next, "nodes").map((node) => ({ ...node, stage: typeof node.stage === "number" ? node.stage - [...removed].filter((index) => index < node.stage!).length : node.stage }));
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
    return { spec: next };
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
