/**
 * Typed generation proposals (issue #433 P1).
 *
 * A {@link Proposal} is the single auditable record between an AI candidate
 * (a `SemanticSpecDataset`) and a document mutation. It captures the document
 * identity and base revisions at job start ({@link ProposalMeta}), the
 * semantic candidate itself (the source of truth), the allowlisted patch ops
 * derived by diffing the candidate's projected canvas members against the
 * base document, and every diagnostic raised along the way.
 *
 * Contracts:
 *
 * - **Scope.** A whole-document candidate (`meta.scope === null`) owns the
 *   whole doc: on an empty doc its ops are pure additions. A scoped edit may
 *   only *modify* or *remove* scoped node ids; additions of brand-new ids are
 *   allowed (they touch nothing existing). Boundary edges (exactly one
 *   endpoint in scope) may be updated but are never removed silently — a kept
 *   boundary edge is reported, a removed one is a blocking violation. Edges
 *   fully outside the scope are never touched. Locked nodes
 *   (`meta.lockedNodeIds`) are never touched; a candidate that targets one is
 *   a blocking violation.
 * - **Blocking diagnostics.** Diagnostics whose key is in
 *   {@link BLOCKING_PROPOSAL_DIAGNOSTIC_KEYS} make the proposal unappliable;
 *   the offending ops are still dropped from `ops` so the op list alone can
 *   never mutate out-of-scope or locked members. Fidelity/warning diagnostics
 *   (unsupported fields, kept boundary edges) do not block.
 * - **Apply.** {@link prepareProposalApply} re-checks the base memory
 *   revision (stale → caller re-previews), replays the ops onto a draft and
 *   runs {@link validateCandidateDoc} on the would-be result, and only then
 *   returns a single {@link StateTransformer}. The caller wraps it in
 *   `withSnapshot` exactly once, so the whole proposal is one undo entry. The
 *   transformer preserves object identity for every untouched node/edge, the
 *   doc id, datasets/views not targeted by ops, and `meta`.
 * - **Never throws.** Malformed candidates produce diagnostics, not
 *   exceptions.
 *
 * Canvas projection lives in `semantic.ts` (entities, relations, and the
 * lane/stage/boundary containers); {@link projectSemanticCandidate} is the
 * members-only delegate kept for P1 callers.
 *
 * Regenerating an existing dataset (the doc holds a dataset with the
 * candidate's id, "previous"; issue #433 P2):
 *
 * - A locked member blocks only when it would change (patch or slot move) or
 *   be removed; an unchanged locked member does not block.
 * - On grid types a member whose projected slot moved between the previous
 *   and candidate projections moves by that delta (user offsets survive);
 *   containers resize the same way.
 * - Only edges of the previous projection's relations are removed; freeform
 *   annotation edges between members survive.
 * - Containers are added only for a dataset new to the doc or one that
 *   already has containers (P1 datasets stay container-less).
 * - `opts.touched` (manual semantic edits) keeps only update/remove ops for
 *   the touched ids plus the upsert, so canvas drift elsewhere is not
 *   silently reverted.
 */

import { isSemanticSpecDataset, type SemanticSpecDataset } from "./reportTypes";
import {
  SEMANTIC_TYPES,
  datasetHasContainers,
  isSemanticContainerNode,
  projectSemanticDataset,
  sequenceOrder,
  specEntries,
  type ProjectedMembers,
} from "./semantic";
import type { DiagramDoc, DiagramEdge, DiagramNode, DiagramStateRoot } from "./types";
import { validateCandidateDoc, type ValidationDiagnostic } from "./validation";
import type { StateTransformer } from "./actions";

export type { ProjectedMembers } from "./semantic";

// ---------------------------------------------------------------------------
// Proposal model
// ---------------------------------------------------------------------------

export interface ProposalMeta {
  jobId: string;
  docId: string;
  /** DIAGRAM_SCHEMA_VERSION at job start. */
  schemaVersion: number;
  /** diagramRevision(serializeDoc(doc)) at job start; "" means "new document". */
  baseMemoryRevision: string;
  baseStorageRevision: string | null;
  /** Node ids the patch may touch; null = whole-document candidate. */
  scope: ReadonlySet<string> | null;
  lockedNodeIds: string[];
}

export type ProposalOp =
  | { kind: "addNode"; node: DiagramNode }
  | { kind: "updateNode"; id: string; patch: Partial<DiagramNode> }
  | { kind: "removeNode"; id: string }
  | { kind: "addEdge"; edge: DiagramEdge }
  | { kind: "updateEdge"; id: string; patch: Partial<DiagramEdge> }
  | { kind: "removeEdge"; id: string }
  | { kind: "upsertSemanticDataset"; dataset: SemanticSpecDataset };

export interface Proposal {
  meta: ProposalMeta;
  /** The semantic result — the source of truth the ops project. */
  candidate: SemanticSpecDataset;
  ops: ProposalOp[];
  diagnostics: ValidationDiagnostic[];
}

/** Diagnostic keys that make a proposal unappliable. */
export const BLOCKING_PROPOSAL_DIAGNOSTIC_KEYS: readonly string[] = [
  "diagram.proposal.outOfScopeNode",
  "diagram.proposal.outOfScopeEdge",
  "diagram.proposal.lockedNode",
  "diagram.proposal.boundaryEdgeRemoved",
  "diagram.proposal.unresolvedEndpoint",
];

export function isBlockingDiagnostic(diagnostic: ValidationDiagnostic): boolean {
  return BLOCKING_PROPOSAL_DIAGNOSTIC_KEYS.includes(diagnostic.key);
}

// ---------------------------------------------------------------------------
// Candidate projection (spec -> canvas members)
// ---------------------------------------------------------------------------

/**
 * Project a semantic candidate to canvas members (no containers). Pure and
 * deterministic; delegates to `projectSemanticDataset`.
 */
export function projectSemanticCandidate(candidate: SemanticSpecDataset): ProjectedMembers {
  return projectSemanticDataset(candidate);
}

// ---------------------------------------------------------------------------
// Proposal construction (diff candidate projection against the base doc)
// ---------------------------------------------------------------------------

interface SlotMove {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Container geometry never collapses below this when a slot delta shrinks it. */
const MIN_RESIZED_EXTENT = 20;

/** Semantic fields (and slot moves) whose drift turns a projection match into an update op. */
function nodeSemanticPatch(
  existing: DiagramNode,
  projected: DiagramNode,
  move: SlotMove | undefined,
): Partial<DiagramNode> | null {
  const patch: Partial<DiagramNode> = {};
  if (existing.kind !== projected.kind) patch.kind = projected.kind;
  if (existing.title !== projected.title) patch.title = projected.title;
  if (existing.body !== projected.body) patch.body = projected.body;
  if (move) {
    if (move.dx !== 0) patch.x = existing.x + move.dx;
    if (move.dy !== 0) patch.y = existing.y + move.dy;
    if (move.dw !== 0) patch.w = Math.max(MIN_RESIZED_EXTENT, existing.w + move.dw);
    if (move.dh !== 0) patch.h = Math.max(MIN_RESIZED_EXTENT, existing.h + move.dh);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function edgeSemanticPatch(existing: DiagramEdge, projected: DiagramEdge): Partial<DiagramEdge> | null {
  const patch: Partial<DiagramEdge> = {};
  if (existing.fromNode !== projected.fromNode) patch.fromNode = projected.fromNode;
  if (existing.toNode !== projected.toNode) patch.toNode = projected.toNode;
  if (existing.fromPort !== projected.fromPort) patch.fromPort = projected.fromPort;
  if (existing.toPort !== projected.toPort) patch.toPort = projected.toPort;
  if (existing.label !== projected.label) patch.label = projected.label;
  if (projected.midOff !== undefined && existing.midOff !== projected.midOff) patch.midOff = projected.midOff;
  if (projected.dash !== undefined && existing.dash !== projected.dash) patch.dash = projected.dash;
  return Object.keys(patch).length > 0 ? patch : null;
}

function semanticDatasetById(doc: DiagramDoc, id: string): SemanticSpecDataset | null {
  return (
    (doc.datasets ?? []).find(
      (dataset): dataset is SemanticSpecDataset => isSemanticSpecDataset(dataset) && dataset.id === id,
    ) ?? null
  );
}

export interface BuildProposalOptions {
  /**
   * Canvas ids a manual semantic edit touched: only update/remove ops for
   * these ids (plus the dataset upsert) are kept, and nothing is added.
   */
  touched?: ReadonlySet<string>;
}

/**
 * Diff the candidate's projected members against `currentDoc` within
 * `meta.scope` and build the op list. Scope/lock violations are dropped from
 * the ops and reported as blocking diagnostics; the returned proposal carries
 * every diagnostic (blocking and informational).
 */
export function buildProposalFromCandidate(
  meta: ProposalMeta,
  candidate: SemanticSpecDataset,
  currentDoc: DiagramDoc,
  opts: BuildProposalOptions = {},
): { proposal: Proposal; diagnostics: ValidationDiagnostic[] } {
  const previous = semanticDatasetById(currentDoc, candidate.id);
  const containers = previous === null || datasetHasContainers(currentDoc, candidate.id);
  const projection = projectSemanticDataset(candidate, { containers, doc: currentDoc });
  const previousProjection = previous ? projectSemanticDataset(previous, { containers, doc: currentDoc }) : null;
  const diagnostics: ValidationDiagnostic[] = [...projection.diagnostics];

  const scope = meta.scope ?? null;
  const touched = opts.touched ?? null;
  const skip = (id: string): boolean => touched !== null && !touched.has(id);
  const locked = new Set(meta.lockedNodeIds);
  const docNodes = new Map((currentDoc.nodes ?? []).map((node) => [node.id, node]));
  const docEdges = new Map((currentDoc.edges ?? []).map((edge) => [edge.id, edge]));
  const candidateNodeIds = new Set(projection.nodes.map((node) => node.id));
  const candidateEdgeIds = new Set(projection.edges.map((edge) => edge.id));

  // Slot moves: previous → candidate projection delta, for grid members and
  // for containers of every type.
  const slotMoves = new Map<string, SlotMove>();
  if (previousProjection) {
    const grid = SEMANTIC_TYPES[candidate.diagramType]?.grid === true;
    const before = new Map(previousProjection.nodes.map((node) => [node.id, node]));
    for (const next of projection.nodes) {
      const prev = before.get(next.id);
      if (!prev || !(grid || isSemanticContainerNode(next))) continue;
      const move = { dx: next.x - prev.x, dy: next.y - prev.y, dw: next.w - prev.w, dh: next.h - prev.h };
      if (move.dx !== 0 || move.dy !== 0 || move.dw !== 0 || move.dh !== 0) slotMoves.set(next.id, move);
    }
  }
  const previousRelationEdgeIds = new Set(previousProjection?.edges.map((edge) => edge.id) ?? []);
  const isPreviousMember = (node: DiagramNode): boolean => {
    const memberId = node.meta?.memberId;
    return previous !== null && typeof memberId === "string" && memberId.startsWith(`${previous.id}:`);
  };

  // A member is effectively in scope when the scope owns it or it is a new
  // candidate addition (adding members touches nothing existing).
  const effectivelyInScope = (id: string): boolean =>
    scope === null || scope.has(id) || candidateNodeIds.has(id);

  const ops: ProposalOp[] = [];

  // --- nodes: additions and updates --------------------------------------
  for (const projected of projection.nodes) {
    const existing = docNodes.get(projected.id);
    if (!existing) {
      if (touched === null) ops.push({ kind: "addNode", node: projected });
      continue;
    }
    if (skip(projected.id)) continue;
    const patch = nodeSemanticPatch(existing, projected, slotMoves.get(projected.id));
    // A locked node blocks only when the candidate would change it.
    if (locked.has(projected.id)) {
      if (patch) diagnostics.push({ key: "diagram.proposal.lockedNode", params: { id: projected.id } });
      continue;
    }
    if (scope !== null && !scope.has(projected.id)) {
      diagnostics.push({
        key: "diagram.proposal.outOfScopeNode",
        params: { id: projected.id },
      });
      continue;
    }
    if (patch) ops.push({ kind: "updateNode", id: projected.id, patch });
  }

  // --- node removals -------------------------------------------------------
  for (const existing of currentDoc.nodes ?? []) {
    if (candidateNodeIds.has(existing.id) || skip(existing.id)) continue;
    if (locked.has(existing.id)) {
      // Locked nodes are never touched; a locked member the spec drops would
      // leave the canvas disagreeing with the spec, so that blocks.
      if (isPreviousMember(existing) && (scope === null || scope.has(existing.id))) {
        diagnostics.push({ key: "diagram.proposal.lockedNode", params: { id: existing.id } });
      }
      continue;
    }
    if (scope !== null && !scope.has(existing.id)) continue;
    // A scoped removal must not strand a boundary edge silently: the edge
    // cannot be removed (its other endpoint is out of scope), so the removal
    // itself is refused.
    if (scope !== null) {
      const strandsBoundary = (currentDoc.edges ?? []).some((edge) => {
        const touchesNode = edge.fromNode === existing.id || edge.toNode === existing.id;
        if (!touchesNode) return false;
        const other = edge.fromNode === existing.id ? edge.toNode : edge.fromNode;
        return !scope.has(other) && !candidateNodeIds.has(other) && docNodes.has(other);
      });
      if (strandsBoundary) {
        diagnostics.push({
          key: "diagram.proposal.boundaryEdgeRemoved",
          params: { id: existing.id },
        });
        continue;
      }
    }
    ops.push({ kind: "removeNode", id: existing.id });
  }

  // --- edges: additions and updates ---------------------------------------
  for (const projected of projection.edges) {
    const existing = docEdges.get(projected.id);
    if (touched !== null && (!existing || skip(projected.id))) continue;
    const fromOk = candidateNodeIds.has(projected.fromNode) || docNodes.has(projected.fromNode);
    const toOk = candidateNodeIds.has(projected.toNode) || docNodes.has(projected.toNode);
    if (!fromOk || !toOk) {
      diagnostics.push({
        key: "diagram.proposal.unresolvedEndpoint",
        params: { id: projected.id, fromNode: projected.fromNode, toNode: projected.toNode },
      });
      continue;
    }
    const fromIn = effectivelyInScope(projected.fromNode);
    const toIn = effectivelyInScope(projected.toNode);
    if (!fromIn && !toIn) {
      diagnostics.push({
        key: "diagram.proposal.outOfScopeEdge",
        params: { id: projected.id },
      });
      continue;
    }
    if (!existing) {
      ops.push({ kind: "addEdge", edge: projected });
      continue;
    }
    const patch = edgeSemanticPatch(existing, projected);
    if (patch) ops.push({ kind: "updateEdge", id: projected.id, patch });
  }

  // --- edge removals --------------------------------------------------------
  for (const existing of currentDoc.edges ?? []) {
    if (candidateEdgeIds.has(existing.id) || skip(existing.id)) continue;
    // Regenerating a dataset removes only its own relation edges; freeform
    // annotation edges between members survive.
    if (previous !== null && !previousRelationEdgeIds.has(existing.id)) continue;
    if (scope === null) {
      // Whole-document candidate owns every edge; removals of edges incident
      // to surviving locked nodes are still fine (the node object is untouched).
      ops.push({ kind: "removeEdge", id: existing.id });
      continue;
    }
    const fromIn = scope.has(existing.fromNode);
    const toIn = scope.has(existing.toNode);
    if (fromIn && toIn) {
      ops.push({ kind: "removeEdge", id: existing.id });
    } else if (fromIn !== toIn) {
      // Boundary edges are never removed silently.
      diagnostics.push({
        key: "diagram.proposal.boundaryEdgeKept",
        params: { id: existing.id },
      });
    }
    // Fully out-of-scope edges are never touched.
  }

  // The semantic candidate itself is stored with the patch.
  ops.push({ kind: "upsertSemanticDataset", dataset: candidate });

  return { proposal: { meta, candidate, ops, diagnostics }, diagnostics };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyProposalOps(doc: DiagramDoc, ops: readonly ProposalOp[]): DiagramDoc {
  let nodes = doc.nodes ?? [];
  let edges = doc.edges ?? [];
  let datasets = doc.datasets;
  // Added containers go first in `nodes` (behind their members), in op order.
  const containers: DiagramNode[] = [];

  for (const op of ops) {
    switch (op.kind) {
      case "addNode":
        if (isSemanticContainerNode(op.node)) containers.push(op.node);
        else nodes = [...nodes, op.node];
        break;
      case "updateNode":
        nodes = nodes.map((node) => (node.id === op.id ? { ...node, ...op.patch } : node));
        break;
      case "removeNode":
        nodes = nodes.filter((node) => node.id !== op.id);
        edges = edges.filter((edge) => edge.fromNode !== op.id && edge.toNode !== op.id);
        break;
      case "addEdge":
        edges = [...edges, op.edge];
        break;
      case "updateEdge":
        edges = edges.map((edge) => (edge.id === op.id ? { ...edge, ...op.patch } : edge));
        break;
      case "removeEdge":
        edges = edges.filter((edge) => edge.id !== op.id);
        break;
      case "upsertSemanticDataset": {
        const current = datasets ?? [];
        datasets = current.some((dataset) => dataset.id === op.dataset.id)
          ? current.map((dataset) => (dataset.id === op.dataset.id ? op.dataset : dataset))
          : [...current, op.dataset];
        break;
      }
    }
  }

  if (containers.length > 0) nodes = [...containers, ...nodes];
  return { ...doc, nodes, edges, ...(datasets !== undefined ? { datasets } : {}) };
}

export type ProposalApplyOutcome =
  | { status: "applied"; transformer: StateTransformer }
  | { status: "stale"; currentRevision: string }
  | { status: "invalid"; diagnostics: ValidationDiagnostic[] };

/**
 * Gate a proposal for application. Stale when the doc moved since the job
 * started; invalid when the proposal carries blocking diagnostics or the
 * would-be result doc fails {@link validateCandidateDoc}. Otherwise returns
 * one pure transformer applying every op atomically — wrap it in
 * `withSnapshot` exactly once for a single undo entry.
 */
export function prepareProposalApply(
  state: DiagramStateRoot,
  proposal: Proposal,
  currentMemoryRevision: string,
): ProposalApplyOutcome {
  const base = proposal.meta.baseMemoryRevision;
  if (base !== "" && base !== currentMemoryRevision) {
    return { status: "stale", currentRevision: currentMemoryRevision };
  }

  const blocking = proposal.diagnostics.filter(isBlockingDiagnostic);
  if (blocking.length > 0) {
    return { status: "invalid", diagnostics: blocking };
  }

  const draft = applyProposalOps(state.doc, proposal.ops);
  const validation = validateCandidateDoc(draft);
  if (!validation.ok) {
    return { status: "invalid", diagnostics: validation.diagnostics };
  }

  const transformer: StateTransformer = (current) => {
    const doc = applyProposalOps(current.doc, proposal.ops);
    const removedNodes = new Set(
      proposal.ops.filter((op) => op.kind === "removeNode").map((op) => (op as { id: string }).id),
    );
    const removedEdges = new Set(
      proposal.ops.filter((op) => op.kind === "removeEdge").map((op) => (op as { id: string }).id),
    );
    return {
      ...current,
      doc,
      ephemeral: {
        ...current.ephemeral,
        selection: {
          nodes: new Set([...current.ephemeral.selection.nodes].filter((id) => !removedNodes.has(id))),
          edges: new Set([...current.ephemeral.selection.edges].filter((id) => !removedEdges.has(id))),
        },
      },
    };
  };
  return { status: "applied", transformer };
}

// ---------------------------------------------------------------------------
// Diff (preview UI)
// ---------------------------------------------------------------------------

export interface ProposalDiff {
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];
  addedEdges: number;
  removedEdges: number;
  /** Spec-level summary; "components" are entities, "connections" relations. */
  semanticSummary: {
    componentsAdded: string[];
    componentsRemoved: string[];
    componentsChanged: string[];
    connectionsAdded: number;
    connectionsRemoved: number;
    /** Relative order of messages present in both specs changed (sequence). */
    orderChanged: boolean;
    containersAdded: number;
    containersRemoved: number;
    containersChanged: number;
  };
}

interface SpecEntry {
  id: string;
  label: string;
  fingerprint: string;
}

function specEntityEntries(dataset: SemanticSpecDataset): SpecEntry[] {
  const descriptor = SEMANTIC_TYPES[dataset.diagramType];
  if (!descriptor) return [];
  return specEntries(dataset.spec, descriptor.entities)
    .filter((entry) => typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id as string,
      label: typeof entry.label === "string" ? entry.label : (entry.id as string),
      fingerprint: JSON.stringify(
        ["label", "sublabel", "type", "lane", "col", "stage", "row"].map((key) => entry[key] ?? null),
      ),
    }));
}

function specRelationKeys(dataset: SemanticSpecDataset): string[] {
  const descriptor = SEMANTIC_TYPES[dataset.diagramType];
  if (!descriptor) return [];
  return specEntries(dataset.spec, descriptor.relations)
    .filter((entry) => typeof entry.from === "string" && typeof entry.to === "string")
    .map((entry, index) =>
      typeof entry.id === "string" && entry.id.length > 0
        ? (entry.id as string)
        : `${entry.from as string}->${entry.to as string}#${index}`,
    );
}

/** Container key → label fingerprint (lanes by id, stages/boundaries by index). */
function specContainers(dataset: SemanticSpecDataset): Map<string, string> {
  const container = SEMANTIC_TYPES[dataset.diagramType]?.container;
  if (!container) return new Map();
  return new Map(
    specEntries(dataset.spec, container.field).map((entry, index) => [
      container.keyedBy === "id" && typeof entry.id === "string" ? entry.id : String(index),
      JSON.stringify([entry.label ?? null, entry.wraps ?? null]),
    ]),
  );
}

/** Message ids in sequence order (id-less messages are skipped). */
function messageOrder(dataset: SemanticSpecDataset): string[] {
  if (dataset.diagramType !== "sequence") return [];
  const messages = specEntries(dataset.spec, "messages");
  return sequenceOrder(dataset.spec)
    .map((index) => messages[index]?.id)
    .filter((id): id is string => typeof id === "string");
}

/**
 * Categorized diff for the preview UI. Node/edge categories come from the op
 * list; the semantic summary compares the candidate spec against the doc's
 * dataset with the candidate's id (everything is "added" when absent).
 */
export function diffProposal(currentDoc: DiagramDoc, proposal: Proposal): ProposalDiff {
  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const changedNodes: string[] = [];
  let addedEdges = 0;
  let removedEdges = 0;
  for (const op of proposal.ops) {
    switch (op.kind) {
      case "addNode":
        addedNodes.push(op.node.id);
        break;
      case "removeNode":
        removedNodes.push(op.id);
        break;
      case "updateNode":
        changedNodes.push(op.id);
        break;
      case "addEdge":
        addedEdges += 1;
        break;
      case "removeEdge":
        removedEdges += 1;
        break;
      default:
        break;
    }
  }

  const current = semanticDatasetById(currentDoc, proposal.candidate.id);
  const semanticSummary: ProposalDiff["semanticSummary"] = {
    componentsAdded: [],
    componentsRemoved: [],
    componentsChanged: [],
    connectionsAdded: 0,
    connectionsRemoved: 0,
    orderChanged: false,
    containersAdded: 0,
    containersRemoved: 0,
    containersChanged: 0,
  };
  const nextEntries = new Map(specEntityEntries(proposal.candidate).map((entry) => [entry.id, entry]));
  const prevEntries = new Map((current ? specEntityEntries(current) : []).map((entry) => [entry.id, entry]));
  for (const [id, entry] of nextEntries) {
    const prev = prevEntries.get(id);
    if (!prev) semanticSummary.componentsAdded.push(entry.label);
    else if (prev.fingerprint !== entry.fingerprint) semanticSummary.componentsChanged.push(entry.label);
  }
  for (const [id, entry] of prevEntries) {
    if (!nextEntries.has(id)) semanticSummary.componentsRemoved.push(entry.label);
  }
  const nextConnections = new Set(specRelationKeys(proposal.candidate));
  const prevConnections = new Set(current ? specRelationKeys(current) : []);
  for (const key of nextConnections) {
    if (!prevConnections.has(key)) semanticSummary.connectionsAdded += 1;
  }
  for (const key of prevConnections) {
    if (!nextConnections.has(key)) semanticSummary.connectionsRemoved += 1;
  }
  const nextContainers = specContainers(proposal.candidate);
  const prevContainers = current ? specContainers(current) : new Map<string, string>();
  for (const [key, fingerprint] of nextContainers) {
    const prev = prevContainers.get(key);
    if (prev === undefined) semanticSummary.containersAdded += 1;
    else if (prev !== fingerprint) semanticSummary.containersChanged += 1;
  }
  for (const key of prevContainers.keys()) {
    if (!nextContainers.has(key)) semanticSummary.containersRemoved += 1;
  }
  if (current) {
    const nextOrder = messageOrder(proposal.candidate);
    const prevOrder = messageOrder(current);
    const common = new Set(nextOrder.filter((id) => prevOrder.includes(id)));
    const a = nextOrder.filter((id) => common.has(id));
    const b = prevOrder.filter((id) => common.has(id));
    semanticSummary.orderChanged = a.some((id, index) => id !== b[index]);
  }

  return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, semanticSummary };
}
