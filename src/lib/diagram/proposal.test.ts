import { describe, expect, it } from "vitest";

import { archifySpecToDataset } from "./archifyCodec";
import {
  buildProposalFromCandidate,
  diffProposal,
  isBlockingDiagnostic,
  prepareProposalApply,
  projectSemanticCandidate,
  type Proposal,
  type ProposalMeta,
} from "./proposal";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { validateCandidateDoc } from "./validation";
import { matrixFromRowsCols, type SemanticDiagramType, type SemanticSpecDataset } from "./reportTypes";
import { projectSemanticDocument, semanticMemberNodeIds } from "./semantic";
import {
  createEmptyDoc,
  createInitialEphemeral,
  type DiagramDoc,
  type DiagramEdge,
  type DiagramNode,
  type DiagramStateRoot,
} from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const node = (id: string, title: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id,
  kind: "simple",
  x: 40,
  y: 40,
  w: 160,
  h: 64,
  title,
  ...extra,
});

const edge = (id: string, from: string, to: string): DiagramEdge => ({
  id,
  fromNode: from,
  fromPort: "e",
  toNode: to,
  toPort: "w",
  arrowEnd: "filled",
});

const doc = (
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  extra: Partial<DiagramDoc> = {},
): DiagramDoc => ({
  ...createEmptyDoc("doc-proposal-test", 0),
  nodes,
  edges,
  ...extra,
});

const stateOf = (d: DiagramDoc): DiagramStateRoot => ({ doc: d, ephemeral: createInitialEphemeral() });

const metaFor = (overrides: Partial<ProposalMeta> = {}): ProposalMeta => ({
  jobId: "job-1",
  docId: "doc-proposal-test",
  schemaVersion: 9,
  baseMemoryRevision: "",
  baseStorageRevision: null,
  scope: null,
  lockedNodeIds: [],
  ...overrides,
});

const SPEC = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Shop", output: "shop.html" },
  components: [
    { id: "a", type: "frontend", label: "A-new" },
    { id: "b", type: "backend", label: "B" },
  ],
  connections: [{ id: "e1", from: "a", to: "b" }],
};

const candidateOf = (spec: Record<string, unknown> = SPEC, id = "ds1") =>
  archifySpecToDataset("architecture", spec, { id }).dataset;

// ---------------------------------------------------------------------------
// projectSemanticCandidate
// ---------------------------------------------------------------------------

describe("projectSemanticCandidate", () => {
  it("projects components and connections to canvas members with stable ids", () => {
    const { nodes, edges } = projectSemanticCandidate(candidateOf());
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(nodes[0]).toMatchObject({ kind: "simple", title: "A-new", meta: { memberId: "ds1:m0" } });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: "e1", fromNode: "a", toNode: "b" });
  });
});

// ---------------------------------------------------------------------------
// buildProposalFromCandidate
// ---------------------------------------------------------------------------

describe("buildProposalFromCandidate", () => {
  it("produces pure additions for a whole-document candidate on an empty doc", () => {
    const base = doc([], []);
    const { proposal, diagnostics } = buildProposalFromCandidate(metaFor(), candidateOf(), base);
    expect(diagnostics).toEqual([]);
    const kinds = proposal.ops.map((op) => op.kind);
    expect(kinds).toEqual(["addNode", "addNode", "addEdge", "upsertSemanticDataset"]);
  });

  it("updates only scoped nodes and keeps boundary edges with a diagnostic", () => {
    // a,b in scope; e1 a→b internal, e2 b→c boundary, e4 c→d fully outside.
    const base = doc(
      [node("a", "A-old"), node("b", "B"), node("c", "C"), node("d", "D")],
      [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e4", "c", "d")],
    );
    const meta = metaFor({ scope: new Set(["a", "b"]) });
    const { proposal, diagnostics } = buildProposalFromCandidate(meta, candidateOf(), base);

    // The scoped freeform nodes become the new dataset's members (#444).
    expect(proposal.ops).toContainEqual({
      kind: "updateNode",
      id: "a",
      patch: { title: "A-new", meta: { memberId: "ds1:m0" } },
    });
    expect(proposal.ops).toContainEqual({ kind: "updateNode", id: "b", patch: { meta: { memberId: "ds1:m1" } } });
    expect(proposal.ops.some((op) => op.kind === "upsertSemanticDataset")).toBe(true);
    // Nothing touches c, d or e4.
    expect(
      proposal.ops.every(
        (op) =>
          (op.kind !== "updateNode" || (op.id !== "c" && op.id !== "d")) &&
          (op.kind !== "removeNode" || (op.id !== "c" && op.id !== "d")) &&
          ((op.kind !== "updateEdge" && op.kind !== "removeEdge") || op.id !== "e4"),
      ),
    ).toBe(true);
    // e2 (b→c) is a boundary edge absent from the candidate: kept, reported.
    expect(diagnostics).toContainEqual({
      key: "diagram.proposal.boundaryEdgeKept",
      params: { id: "e2" },
    });
    expect(diagnostics.every((d) => !isBlockingDiagnostic(d))).toBe(true);
  });

  it("turns out-of-scope candidate members into blocking diagnostics, not ops", () => {
    const base = doc([node("a", "A"), node("c", "C")], []);
    const meta = metaFor({ scope: new Set(["a"]) });
    const spec = {
      ...SPEC,
      components: [
        { id: "a", type: "frontend", label: "A" },
        { id: "c", type: "backend", label: "C-hijacked" },
      ],
      connections: [],
    };
    const { proposal, diagnostics } = buildProposalFromCandidate(meta, candidateOf(spec), base);
    expect(diagnostics).toContainEqual({
      key: "diagram.proposal.outOfScopeNode",
      params: { id: "c" },
    });
    expect(proposal.ops.some((op) => op.kind === "updateNode" && op.id === "c")).toBe(false);
  });

  it("refuses to touch locked nodes", () => {
    const base = doc([node("a", "A"), node("c", "C")], []);
    const meta = metaFor({ lockedNodeIds: ["c"] });
    const spec = {
      ...SPEC,
      components: [
        { id: "a", type: "frontend", label: "A" },
        { id: "c", type: "backend", label: "C-hijacked" },
      ],
      connections: [],
    };
    const { diagnostics } = buildProposalFromCandidate(meta, candidateOf(spec), base);
    expect(diagnostics).toContainEqual({ key: "diagram.proposal.lockedNode", params: { id: "c" } });
  });

  it("refuses scoped node removals that would strand a boundary edge", () => {
    // Candidate keeps only a; removing b would strand boundary edge e2 b→c.
    const base = doc(
      [node("a", "A-new"), node("b", "B"), node("c", "C")],
      [edge("e2", "b", "c")],
    );
    const meta = metaFor({ scope: new Set(["a", "b"]) });
    const spec = { ...SPEC, components: [{ id: "a", type: "frontend", label: "A-new" }], connections: [] };
    const { proposal, diagnostics } = buildProposalFromCandidate(meta, candidateOf(spec), base);
    expect(diagnostics).toContainEqual({
      key: "diagram.proposal.boundaryEdgeRemoved",
      params: { id: "b" },
    });
    expect(proposal.ops.some((op) => op.kind === "removeNode" && op.id === "b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prepareProposalApply
// ---------------------------------------------------------------------------

describe("prepareProposalApply", () => {
  it("applies a whole-doc candidate to an empty doc as one transformer", () => {
    const base = doc([], []);
    const { proposal } = buildProposalFromCandidate(metaFor(), candidateOf(), base);
    const outcome = prepareProposalApply(stateOf(base), proposal, "");
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    const next = outcome.transformer(stateOf(base));
    expect(next.doc.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(next.doc.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(next.doc.datasets?.some((d) => d.id === "ds1" && d.kind === "semanticSpec")).toBe(true);
    expect(validateCandidateDoc(next.doc).ok).toBe(true);
  });

  it("preserves identity of untouched objects, the doc id, and untargeted datasets", () => {
    const untouched = matrixFromRowsCols(1, 1, { id: "m1" });
    const base = doc(
      [node("a", "A-old"), node("b", "B"), node("c", "C"), node("d", "D")],
      [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e4", "c", "d")],
      { datasets: [untouched] },
    );
    const meta = metaFor({ scope: new Set(["a", "b"]) });
    const { proposal } = buildProposalFromCandidate(meta, candidateOf(), base);
    const outcome = prepareProposalApply(stateOf(base), proposal, "");
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    const next = outcome.transformer(stateOf(base));

    expect(next.doc.id).toBe(base.id);
    expect(next.doc.nodes.find((n) => n.id === "a")?.title).toBe("A-new");
    // Untouched objects keep their references.
    expect(next.doc.nodes.find((n) => n.id === "c")).toBe(base.nodes[2]);
    expect(next.doc.nodes.find((n) => n.id === "d")).toBe(base.nodes[3]);
    expect(next.doc.edges.find((e) => e.id === "e4")).toBe(base.edges[2]);
    expect(next.doc.edges.find((e) => e.id === "e2")).toBe(base.edges[1]);
    expect(next.doc.datasets?.find((d) => d.id === "m1")).toBe(untouched);
    expect(next.doc.datasets?.some((d) => d.id === "ds1")).toBe(true);
  });

  it("rejects a stale base revision", () => {
    const base = doc([], []);
    const meta = metaFor({ baseMemoryRevision: "rev-at-start" });
    const { proposal } = buildProposalFromCandidate(meta, candidateOf(), base);
    const outcome = prepareProposalApply(stateOf(base), proposal, "rev-now");
    expect(outcome).toEqual({ status: "stale", currentRevision: "rev-now" });
  });

  it("rejects proposals carrying blocking diagnostics", () => {
    const base = doc([node("a", "A"), node("c", "C")], []);
    const meta = metaFor({ scope: new Set(["a"]) });
    const spec = {
      ...SPEC,
      components: [
        { id: "a", type: "frontend", label: "A" },
        { id: "c", type: "backend", label: "C-hijacked" },
      ],
      connections: [],
    };
    const { proposal } = buildProposalFromCandidate(meta, candidateOf(spec), base);
    const outcome = prepareProposalApply(stateOf(base), proposal, "");
    expect(outcome.status).toBe("invalid");
    if (outcome.status !== "invalid") return;
    expect(outcome.diagnostics).toContainEqual({
      key: "diagram.proposal.outOfScopeNode",
      params: { id: "c" },
    });
  });

  it("rejects a would-be result doc that fails candidate validation", () => {
    const base = doc([], []);
    const badNode: DiagramNode = { id: "x", kind: "simple", x: 0, y: 0, w: -5, h: 10 };
    const proposal: Proposal = {
      meta: metaFor(),
      candidate: candidateOf(),
      ops: [{ kind: "addNode", node: badNode }],
      diagnostics: [],
    };
    const outcome = prepareProposalApply(stateOf(base), proposal, "");
    expect(outcome.status).toBe("invalid");
    if (outcome.status !== "invalid") return;
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// diffProposal
// ---------------------------------------------------------------------------

describe("diffProposal", () => {
  it("categorizes node/edge ops and summarizes semantic drift", () => {
    const oldSpec = {
      ...SPEC,
      components: [
        { id: "a", type: "frontend", label: "A-old" },
        { id: "b", type: "backend", label: "B" },
      ],
      connections: [{ id: "e1", from: "a", to: "b" }],
    };
    const oldDataset = archifySpecToDataset("architecture", oldSpec, { id: "ds1" }).dataset;
    const base = doc([node("a", "A-old"), node("b", "B")], [edge("e1", "a", "b")], {
      datasets: [oldDataset],
    });

    const newSpec = {
      ...SPEC,
      components: [
        { id: "a", type: "frontend", label: "A-new" },
        { id: "c", type: "cloud", label: "C" },
      ],
      connections: [{ id: "e2", from: "a", to: "c" }],
    };
    const candidate = archifySpecToDataset("architecture", newSpec, { id: "ds1" }).dataset;
    const { proposal } = buildProposalFromCandidate(metaFor(), candidate, base);
    const diff = diffProposal(base, proposal);

    expect(diff.addedNodes).toEqual(["c"]);
    expect(diff.removedNodes).toEqual(["b"]);
    expect(diff.changedNodes).toEqual(["a"]);
    expect(diff.addedEdges).toBe(1);
    expect(diff.removedEdges).toBe(1);
    expect(diff.semanticSummary).toEqual({
      componentsAdded: ["C"],
      componentsRemoved: ["B"],
      componentsChanged: ["A-new"],
      connectionsAdded: 1,
      connectionsRemoved: 1,
      orderChanged: false,
      containersAdded: 0,
      containersRemoved: 0,
      containersChanged: 0,
    });
  });

  it("reports every candidate member as added when no prior semantic dataset exists", () => {
    const base = doc([], []);
    const { proposal } = buildProposalFromCandidate(metaFor(), candidateOf(), base);
    const diff = diffProposal(base, proposal);
    expect(diff.semanticSummary.componentsAdded).toEqual(["A-new", "B"]);
    expect(diff.semanticSummary.componentsRemoved).toEqual([]);
    expect(diff.semanticSummary.connectionsAdded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regenerating an existing semantic dataset (issue #433 P2)
// ---------------------------------------------------------------------------

describe("buildProposalFromCandidate across datasets", () => {
  // Canvas ids are spec ids, so a second dataset can propose an id another
  // dataset already owns on the canvas.
  const owned = () => projectSemanticDocument(candidateOf(SPEC, "dsA")).doc;

  it("blocks a candidate node whose id another dataset's member owns", () => {
    const base = owned();
    const { proposal } = buildProposalFromCandidate(metaFor({ scope: new Set(["a", "b"]) }), candidateOf(SPEC, "dsB"), base);
    expect(proposal.diagnostics.some((d) => d.key === "diagram.proposal.idCollision" && isBlockingDiagnostic(d))).toBe(true);
    expect(proposal.ops.some((op) => op.kind === "updateNode")).toBe(false);
  });

  it("blocks a candidate edge whose id is another dataset's relation", () => {
    const base = owned();
    const spec = { ...SPEC, components: [{ id: "x", type: "frontend", label: "X" }, { id: "y", type: "backend", label: "Y" }], connections: [{ id: "e1", from: "x", to: "y" }] };
    const { proposal } = buildProposalFromCandidate(metaFor(), candidateOf(spec, "dsB"), base);
    expect(proposal.diagnostics.map((d) => d.key)).toContain("diagram.proposal.idCollision");
    expect(proposal.ops.some((op) => op.kind === "updateEdge")).toBe(false);
  });

  it("adopts a freeform node that shares a candidate id as the new member", () => {
    const base = doc([node("a", "A-old")], []);
    const { proposal } = buildProposalFromCandidate(metaFor(), candidateOf(SPEC, "dsB"), base);
    const update = proposal.ops.find((op) => op.kind === "updateNode" && op.id === "a");
    expect(update && update.kind === "updateNode" ? update.patch.meta?.memberId : null).toMatch(/^dsB:/);
    expect(proposal.diagnostics.some(isBlockingDiagnostic)).toBe(false);
  });
});

describe("buildProposalFromCandidate with a previous dataset", () => {
  const datasetOf = (type: SemanticDiagramType, spec: Record<string, unknown>) =>
    archifySpecToDataset(type, structuredClone(spec), { id: `ds-${type}` }).dataset;
  const projectedDoc = (type: SemanticDiagramType, spec = SEMANTIC_FIXTURES[type]) =>
    projectSemanticDocument(datasetOf(type, spec)).doc;
  const memberMeta = (d: DiagramDoc, datasetId: string, locked: string[] = []) =>
    metaFor({ scope: new Set(semanticMemberNodeIds(d, datasetId)), lockedNodeIds: locked });
  const lifecycleWith = (mutate: (states: Record<string, unknown>[]) => void) => {
    const spec = structuredClone(SEMANTIC_FIXTURES.lifecycle);
    mutate(spec.states as Record<string, unknown>[]);
    return datasetOf("lifecycle", spec);
  };

  it("does not block on a locked member the candidate leaves unchanged", () => {
    const base = projectedDoc("lifecycle");
    const locked = { ...base, nodes: base.nodes.map((n) => (n.id === "queued" ? { ...n, locked: true } : n)) };
    const candidate = lifecycleWith((states) => {
      states[2]!.label = "Finished";
    });
    const { proposal } = buildProposalFromCandidate(memberMeta(locked, "ds-lifecycle", ["queued"]), candidate, locked);
    expect(proposal.diagnostics.filter(isBlockingDiagnostic)).toEqual([]);
    expect(proposal.ops).toContainEqual({ kind: "updateNode", id: "done", patch: { title: "Finished" } });
  });

  it("blocks when a locked member would be removed from the spec", () => {
    const base = projectedDoc("lifecycle");
    const locked = { ...base, nodes: base.nodes.map((n) => (n.id === "done" ? { ...n, locked: true } : n)) };
    const spec = structuredClone(SEMANTIC_FIXTURES.lifecycle);
    spec.states = (spec.states as Record<string, unknown>[]).slice(0, 2);
    spec.transitions = (spec.transitions as Record<string, unknown>[]).slice(0, 1);
    const { proposal } = buildProposalFromCandidate(
      memberMeta(locked, "ds-lifecycle", ["done"]),
      datasetOf("lifecycle", spec),
      locked,
    );
    expect(proposal.diagnostics).toContainEqual({ key: "diagram.proposal.lockedNode", params: { id: "done" } });
  });

  it("keeps annotation edges between kept members and removes dropped relations", () => {
    const base = projectedDoc("lifecycle");
    const annotated = { ...base, edges: [...base.edges, edge("note-edge", "queued", "done")] };
    const spec = structuredClone(SEMANTIC_FIXTURES.lifecycle);
    spec.transitions = (spec.transitions as Record<string, unknown>[]).slice(0, 1);
    const { proposal } = buildProposalFromCandidate(
      memberMeta(annotated, "ds-lifecycle"),
      datasetOf("lifecycle", spec),
      annotated,
    );
    const removed = proposal.ops.filter((op) => op.kind === "removeEdge").map((op) => (op as { id: string }).id);
    expect(removed).toEqual(["tr2"]);
  });

  it("moves a member by its slot delta, keeping the user's offset", () => {
    const base = projectedDoc("lifecycle");
    const nudged = { ...base, nodes: base.nodes.map((n) => (n.id === "done" ? { ...n, x: n.x + 7, y: n.y + 3 } : n)) };
    const before = nudged.nodes.find((n) => n.id === "done")!;
    const candidate = lifecycleWith((states) => {
      states[2]!.col = 4;
    });
    const { proposal } = buildProposalFromCandidate(memberMeta(nudged, "ds-lifecycle"), candidate, nudged);
    expect(proposal.ops).toContainEqual({ kind: "updateNode", id: "done", patch: { x: before.x + 400 } });
    // The lane widens with the new max column.
    const lane = proposal.ops.find((op) => op.kind === "updateNode" && op.id === "ds-lifecycle:lane:main");
    expect(lane).toMatchObject({ patch: { w: base.nodes[0]!.w + 400 } });
  });

  it("patches sequence bracket order (midOff) and reports orderChanged", () => {
    const base = projectedDoc("sequence");
    const spec = structuredClone(base.datasets![0] as SemanticSpecDataset).spec;
    const messages = spec.messages as Record<string, unknown>[];
    [messages[1]!.y, messages[2]!.y] = [messages[2]!.y, messages[1]!.y];
    const candidate = { ...(base.datasets![0] as SemanticSpecDataset), spec };
    const { proposal } = buildProposalFromCandidate(memberMeta(base, "ds-sequence"), candidate, base);
    expect(proposal.ops).toContainEqual({ kind: "updateEdge", id: "msg2", patch: { midOff: 104 } });
    expect(proposal.ops).toContainEqual({ kind: "updateEdge", id: "msg3", patch: { midOff: 72 } });
    expect(diffProposal(base, proposal).semanticSummary.orderChanged).toBe(true);
  });

  it("reports container counts and prepends added containers", () => {
    const base = projectedDoc("workflow");
    const spec = structuredClone(SEMANTIC_FIXTURES.workflow);
    (spec.lanes as Record<string, unknown>[]).push({ id: "ops", label: "Ops" });
    (spec.lanes as Record<string, unknown>[])[0]!.label = "Writer";
    const { proposal } = buildProposalFromCandidate(memberMeta(base, "ds-workflow"), datasetOf("workflow", spec), base);
    const summary = diffProposal(base, proposal).semanticSummary;
    expect([summary.containersAdded, summary.containersChanged, summary.containersRemoved]).toEqual([1, 1, 0]);
    const outcome = prepareProposalApply(stateOf(base), proposal, "");
    if (outcome.status !== "applied") throw new Error(JSON.stringify(outcome));
    expect(outcome.transformer(stateOf(base)).doc.nodes[0]!.id).toBe("ds-workflow:lane:ops");
  });

  it("never adds containers to a container-less (P1) dataset", () => {
    const dataset = datasetOf("workflow", SEMANTIC_FIXTURES.workflow);
    const members = projectSemanticCandidate(dataset);
    const p1 = doc(members.nodes, members.edges, { datasets: [dataset] });
    const { proposal } = buildProposalFromCandidate(memberMeta(p1, "ds-workflow"), dataset, p1);
    expect(proposal.ops.filter((op) => op.kind === "addNode")).toEqual([]);
  });

  it("keeps only touched ids when a manual edit passes the touched filter", () => {
    const base = projectedDoc("dataflow");
    const drifted = { ...base, nodes: base.nodes.map((n) => (n.id === "app" ? { ...n, title: "Canvas only" } : n)) };
    const spec = structuredClone(SEMANTIC_FIXTURES.dataflow);
    (spec.nodes as Record<string, unknown>[])[1]!.label = "Lake";
    const { proposal } = buildProposalFromCandidate(
      memberMeta(drifted, "ds-dataflow"),
      datasetOf("dataflow", spec),
      drifted,
      { touched: new Set(["wh"]) },
    );
    expect(proposal.ops.map((op) => op.kind)).toEqual(["updateNode", "upsertSemanticDataset"]);
    expect(proposal.ops[0]).toEqual({ kind: "updateNode", id: "wh", patch: { title: "Lake" } });
  });
});
