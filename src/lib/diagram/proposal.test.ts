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
import { validateCandidateDoc } from "./validation";
import { matrixFromRowsCols } from "./reportTypes";
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

    expect(proposal.ops).toContainEqual({ kind: "updateNode", id: "a", patch: { title: "A-new" } });
    expect(proposal.ops.some((op) => op.kind === "upsertSemanticDataset")).toBe(true);
    // b is unchanged -> no op; nothing touches c, d or e4.
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
