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
 * Canvas projection (P1 baseline): architecture `components` and workflow
 * `nodes` project to `simple` nodes (title = label, body = sublabel,
 * `meta.memberId = <datasetId>:m<index>`); `connections` / `edges` project to
 * edges. Lanes, boundaries, phases and groups stay semantic-only (they live
 * in the spec) until their editing phases land in P2. Node geometry comes
 * from the spec's `pos`/`size` when present, else a deterministic grid; the
 * dialog layer may reflow added nodes with `layoutDoc` afterwards.
 */

import { isSemanticSpecDataset, type SemanticSpecDataset } from "./reportTypes";
import type { DiagramDoc, DiagramEdge, DiagramNode, DiagramStateRoot } from "./types";
import { validateCandidateDoc, type ValidationDiagnostic } from "./validation";
import type { StateTransformer } from "./actions";
import { LAYOUT_DEFAULT_ORIGIN, LAYOUT_STEP_X, LAYOUT_STEP_Y } from "./layout";

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

export interface ProjectedMembers {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  diagnostics: ValidationDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

const PROJECTION_GRID_COLS = 4;
const PROJECTION_NODE_W = 160;
const PROJECTION_NODE_H = 64;

/** Maru canvas id for a spec id, via the dataset's id map (identity fallback). */
function maruIdFor(candidate: SemanticSpecDataset, specId: string): string {
  return candidate.idMap[specId] ?? specId;
}

function projectNode(
  candidate: SemanticSpecDataset,
  entry: Record<string, unknown>,
  index: number,
): DiagramNode | null {
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;
  const pos = isPoint(entry.pos) ? entry.pos : null;
  const size = isPoint(entry.size) && entry.size[0] > 0 && entry.size[1] > 0 ? entry.size : null;
  return {
    id: maruIdFor(candidate, entry.id),
    kind: "simple",
    x: pos ? pos[0] : LAYOUT_DEFAULT_ORIGIN.x + (index % PROJECTION_GRID_COLS) * LAYOUT_STEP_X,
    y: pos ? pos[1] : LAYOUT_DEFAULT_ORIGIN.y + Math.floor(index / PROJECTION_GRID_COLS) * LAYOUT_STEP_Y,
    w: size ? size[0] : PROJECTION_NODE_W,
    h: size ? size[1] : PROJECTION_NODE_H,
    title: typeof entry.label === "string" ? entry.label : entry.id,
    body: typeof entry.sublabel === "string" ? entry.sublabel : undefined,
    meta: { memberId: `${candidate.id}:m${index}` },
  };
}

/**
 * Project a semantic candidate to canvas members. Pure and deterministic;
 * unresolvable edge endpoints are skipped with a (blocking) diagnostic.
 */
export function projectSemanticCandidate(candidate: SemanticSpecDataset): ProjectedMembers {
  const diagnostics: ValidationDiagnostic[] = [];
  const spec = candidate.spec;
  const nodeEntries = asRecordArray(candidate.diagramType === "architecture" ? spec.components : spec.nodes);
  const edgeEntries = asRecordArray(candidate.diagramType === "architecture" ? spec.connections : spec.edges);

  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<string>();
  nodeEntries.forEach((entry, index) => {
    const node = projectNode(candidate, entry, index);
    if (!node || nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  });

  const edges: DiagramEdge[] = [];
  const edgeIds = new Set<string>();
  edgeEntries.forEach((entry, index) => {
    if (typeof entry.from !== "string" || typeof entry.to !== "string") return;
    const fromNode = maruIdFor(candidate, entry.from);
    const toNode = maruIdFor(candidate, entry.to);
    let id =
      typeof entry.id === "string" && entry.id.length > 0
        ? maruIdFor(candidate, entry.id)
        : `${candidate.id}-e${index}`;
    while (edgeIds.has(id)) id = `${id}-2`;
    edgeIds.add(id);
    edges.push({
      id,
      fromNode,
      fromPort: "e",
      toNode,
      toPort: "w",
      arrowEnd: "filled",
      label: typeof entry.label === "string" ? entry.label : undefined,
    });
  });

  return { nodes, edges, diagnostics };
}

// ---------------------------------------------------------------------------
// Proposal construction (diff candidate projection against the base doc)
// ---------------------------------------------------------------------------

/** Semantic fields whose drift turns a projection match into an update op. */
function nodeSemanticPatch(existing: DiagramNode, projected: DiagramNode): Partial<DiagramNode> | null {
  const patch: Partial<DiagramNode> = {};
  if (existing.kind !== projected.kind) patch.kind = projected.kind;
  if (existing.title !== projected.title) patch.title = projected.title;
  if (existing.body !== projected.body) patch.body = projected.body;
  return Object.keys(patch).length > 0 ? patch : null;
}

function edgeSemanticPatch(existing: DiagramEdge, projected: DiagramEdge): Partial<DiagramEdge> | null {
  const patch: Partial<DiagramEdge> = {};
  if (existing.fromNode !== projected.fromNode) patch.fromNode = projected.fromNode;
  if (existing.toNode !== projected.toNode) patch.toNode = projected.toNode;
  if (existing.fromPort !== projected.fromPort) patch.fromPort = projected.fromPort;
  if (existing.toPort !== projected.toPort) patch.toPort = projected.toPort;
  if (existing.label !== projected.label) patch.label = projected.label;
  return Object.keys(patch).length > 0 ? patch : null;
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
): { proposal: Proposal; diagnostics: ValidationDiagnostic[] } {
  const projection = projectSemanticCandidate(candidate);
  const diagnostics: ValidationDiagnostic[] = [...projection.diagnostics];

  const scope = meta.scope ?? null;
  const locked = new Set(meta.lockedNodeIds);
  const docNodes = new Map((currentDoc.nodes ?? []).map((node) => [node.id, node]));
  const docEdges = new Map((currentDoc.edges ?? []).map((edge) => [edge.id, edge]));
  const candidateNodeIds = new Set(projection.nodes.map((node) => node.id));
  const candidateEdgeIds = new Set(projection.edges.map((edge) => edge.id));

  // A member is effectively in scope when the scope owns it or it is a new
  // candidate addition (adding members touches nothing existing).
  const effectivelyInScope = (id: string): boolean =>
    scope === null || scope.has(id) || candidateNodeIds.has(id);

  const ops: ProposalOp[] = [];

  // --- nodes: additions and updates --------------------------------------
  for (const projected of projection.nodes) {
    if (locked.has(projected.id)) {
      diagnostics.push({
        key: "diagram.proposal.lockedNode",
        params: { id: projected.id },
      });
      continue;
    }
    const existing = docNodes.get(projected.id);
    if (existing && scope !== null && !scope.has(projected.id)) {
      diagnostics.push({
        key: "diagram.proposal.outOfScopeNode",
        params: { id: projected.id },
      });
      continue;
    }
    if (!existing) {
      ops.push({ kind: "addNode", node: projected });
      continue;
    }
    const patch = nodeSemanticPatch(existing, projected);
    if (patch) ops.push({ kind: "updateNode", id: projected.id, patch });
  }

  // --- node removals -------------------------------------------------------
  for (const existing of currentDoc.nodes ?? []) {
    if (candidateNodeIds.has(existing.id)) continue;
    if (locked.has(existing.id)) continue; // locked nodes are never touched
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
    const existing = docEdges.get(projected.id);
    if (!existing) {
      ops.push({ kind: "addEdge", edge: projected });
      continue;
    }
    const patch = edgeSemanticPatch(existing, projected);
    if (patch) ops.push({ kind: "updateEdge", id: projected.id, patch });
  }

  // --- edge removals --------------------------------------------------------
  for (const existing of currentDoc.edges ?? []) {
    if (candidateEdgeIds.has(existing.id)) continue;
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

  for (const op of ops) {
    switch (op.kind) {
      case "addNode":
        nodes = [...nodes, op.node];
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
  semanticSummary: {
    componentsAdded: string[];
    componentsRemoved: string[];
    componentsChanged: string[];
    connectionsAdded: number;
    connectionsRemoved: number;
  };
}

interface SpecEntry {
  id: string;
  label: string;
  fingerprint: string;
}

function specComponentEntries(dataset: SemanticSpecDataset): SpecEntry[] {
  const raw = dataset.diagramType === "architecture" ? dataset.spec.components : dataset.spec.nodes;
  return asRecordArray(raw)
    .filter((entry) => typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id as string,
      label: typeof entry.label === "string" ? entry.label : (entry.id as string),
      fingerprint: JSON.stringify([entry.label ?? null, entry.sublabel ?? null, entry.type ?? null]),
    }));
}

function specConnectionKeys(dataset: SemanticSpecDataset): string[] {
  const raw = dataset.diagramType === "architecture" ? dataset.spec.connections : dataset.spec.edges;
  return asRecordArray(raw)
    .filter((entry) => typeof entry.from === "string" && typeof entry.to === "string")
    .map((entry, index) =>
      typeof entry.id === "string" && entry.id.length > 0
        ? (entry.id as string)
        : `${entry.from as string}->${entry.to as string}#${index}`,
    );
}

function currentSemanticDataset(doc: DiagramDoc, candidate: SemanticSpecDataset): SemanticSpecDataset | null {
  const datasets = doc.datasets ?? [];
  const byId = datasets.find(
    (dataset): dataset is SemanticSpecDataset =>
      isSemanticSpecDataset(dataset) && dataset.id === candidate.id,
  );
  if (byId) return byId;
  return (
    datasets.find(
      (dataset): dataset is SemanticSpecDataset =>
        isSemanticSpecDataset(dataset) && dataset.diagramType === candidate.diagramType,
    ) ?? null
  );
}

/**
 * Categorized diff for the preview UI. Node/edge categories come from the op
 * list; the semantic summary compares the candidate spec against the current
 * semantic dataset of the same diagram type (empty categories when absent).
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

  const current = currentSemanticDataset(currentDoc, proposal.candidate);
  const semanticSummary: ProposalDiff["semanticSummary"] = {
    componentsAdded: [],
    componentsRemoved: [],
    componentsChanged: [],
    connectionsAdded: 0,
    connectionsRemoved: 0,
  };
  if (current) {
    const nextEntries = new Map(specComponentEntries(proposal.candidate).map((entry) => [entry.id, entry]));
    const prevEntries = new Map(specComponentEntries(current).map((entry) => [entry.id, entry]));
    for (const [id, entry] of nextEntries) {
      const prev = prevEntries.get(id);
      if (!prev) semanticSummary.componentsAdded.push(entry.label);
      else if (prev.fingerprint !== entry.fingerprint) semanticSummary.componentsChanged.push(entry.label);
    }
    for (const [id, entry] of prevEntries) {
      if (!nextEntries.has(id)) semanticSummary.componentsRemoved.push(entry.label);
    }
    const nextConnections = new Set(specConnectionKeys(proposal.candidate));
    const prevConnections = new Set(specConnectionKeys(current));
    for (const key of nextConnections) {
      if (!prevConnections.has(key)) semanticSummary.connectionsAdded += 1;
    }
    for (const key of prevConnections) {
      if (!nextConnections.has(key)) semanticSummary.connectionsRemoved += 1;
    }
  } else {
    // No prior semantic dataset: everything in the candidate is new.
    for (const entry of specComponentEntries(proposal.candidate)) {
      semanticSummary.componentsAdded.push(entry.label);
    }
    semanticSummary.connectionsAdded = specConnectionKeys(proposal.candidate).length;
  }

  return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, semanticSummary };
}
