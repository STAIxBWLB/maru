import { describe, expect, it } from "vitest";

import {
  SEMANTIC_SPEC_MAX_BYTES,
  matrixFromRowsCols,
  type SemanticSpecDataset,
} from "./reportTypes";
import { createEmptyDoc, type DiagramDoc } from "./types";
import { validateArchifySpecPreCheck, validateCandidateDoc } from "./validation";

function keysOf(result: ReturnType<typeof validateCandidateDoc>): string[] {
  return result.diagnostics.map((d) => d.key);
}

function makeValidDoc(): DiagramDoc {
  const doc = createEmptyDoc("doc-1", 1700000000000);
  doc.nodes.push(
    { id: "n1", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "A" },
    { id: "n2", kind: "simple", x: 200, y: 0, w: 100, h: 50, title: "B" },
  );
  doc.edges.push({ id: "e1", fromNode: "n1", fromPort: "e", toNode: "n2", toPort: "w" });
  const matrix = matrixFromRowsCols(2, 2, { id: "ds1", name: "M" });
  doc.datasets = [matrix];
  doc.views = [
    {
      id: "view1",
      datasetId: "ds1",
      patternId: "table",
      bounds: { x: 0, y: 0, w: 200, h: 100 },
      nodeIds: ["n1"],
      edgeIds: ["e1"],
      projectionHash: "00000000",
    },
  ];
  doc.nodes[0]!.meta = { memberId: "ds1", viewId: "view1" };
  return doc;
}

describe("validateCandidateDoc", () => {
  it("accepts an empty doc", () => {
    const result = validateCandidateDoc(createEmptyDoc("doc-empty"));
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("accepts a fully-wired doc with dataset, view, and meta pointers", () => {
    const result = validateCandidateDoc(makeValidDoc());
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("flags duplicate ids per collection", () => {
    const doc = createEmptyDoc("doc-dup");
    doc.nodes.push(
      { id: "n1", kind: "simple", x: 0, y: 0, w: 10, h: 10 },
      { id: "n1", kind: "text", x: 20, y: 0, w: 10, h: 10 },
    );
    doc.edges.push(
      { id: "e1", fromNode: "n1", fromPort: "e", toNode: "n1", toPort: "w" },
      { id: "e1", fromNode: "n1", fromPort: "e", toNode: "n1", toPort: "w" },
    );
    doc.layers.push({ id: "default", name: "dup", visible: true, locked: false, order: 1 });
    doc.datasets = [
      matrixFromRowsCols(1, 1, { id: "ds1" }),
      matrixFromRowsCols(1, 1, { id: "ds1" }),
    ];
    doc.views = [
      { id: "v1", datasetId: "ds1", patternId: "table", bounds: { x: 0, y: 0, w: 1, h: 1 }, nodeIds: [], edgeIds: [], projectionHash: "x" },
      { id: "v1", datasetId: "ds1", patternId: "table", bounds: { x: 0, y: 0, w: 1, h: 1 }, nodeIds: [], edgeIds: [], projectionHash: "x" },
    ];
    const keys = keysOf(validateCandidateDoc(doc));
    expect(keys).toContain("diagram.validation.duplicateNodeId");
    expect(keys).toContain("diagram.validation.duplicateEdgeId");
    expect(keys).toContain("diagram.validation.duplicateLayerId");
    expect(keys).toContain("diagram.validation.duplicateDatasetId");
    expect(keys).toContain("diagram.validation.duplicateViewId");
  });

  it("flags dangling edge endpoints", () => {
    const doc = createEmptyDoc("doc-dangling");
    doc.nodes.push({ id: "n1", kind: "simple", x: 0, y: 0, w: 10, h: 10 });
    doc.edges.push({ id: "e1", fromNode: "n1", fromPort: "e", toNode: "ghost", toPort: "w" });
    const result = validateCandidateDoc(doc);
    expect(result.ok).toBe(false);
    expect(keysOf(result)).toContain("diagram.validation.danglingEdge");
    const diag = result.diagnostics.find((d) => d.key === "diagram.validation.danglingEdge");
    expect(diag?.params).toMatchObject({ edgeId: "e1", toNode: "ghost" });
  });

  it("flags node layerId pointing at an unknown layer", () => {
    const doc = createEmptyDoc("doc-layer");
    doc.nodes.push({ id: "n1", kind: "simple", x: 0, y: 0, w: 10, h: 10, layerId: "nope" });
    const result = validateCandidateDoc(doc);
    expect(keysOf(result)).toContain("diagram.validation.unknownLayer");
    expect(result.diagnostics[0]?.params).toMatchObject({ nodeId: "n1", layerId: "nope" });
  });

  it("flags bad view references (dataset, node, edge)", () => {
    const doc = makeValidDoc();
    doc.views = [
      {
        id: "view-bad",
        datasetId: "ghost-ds",
        patternId: "table",
        bounds: { x: 0, y: 0, w: 1, h: 1 },
        nodeIds: ["ghost-node"],
        edgeIds: ["ghost-edge"],
        projectionHash: "x",
      },
    ];
    // n1.meta.viewId now points at a view that no longer exists.
    doc.nodes[0]!.meta = {};
    const result = validateCandidateDoc(doc);
    const refs = result.diagnostics.filter((d) => d.key === "diagram.validation.viewReference");
    expect(refs.map((d) => d.params?.kind)).toEqual(["dataset", "node", "edge"]);
  });

  it("flags node meta member/view pointers to unknown ids", () => {
    const doc = makeValidDoc();
    doc.nodes[0]!.meta = { memberId: "ghost-ds", viewId: "ghost-view" };
    const result = validateCandidateDoc(doc);
    const refs = result.diagnostics.filter((d) => d.key === "diagram.validation.memberReference");
    expect(refs).toHaveLength(2);
    expect(refs.map((d) => d.params?.kind)).toEqual(["member", "view"]);
  });

  it("accepts pattern member addresses (<datasetId>:m<index>) for known datasets", () => {
    const doc = makeValidDoc();
    doc.nodes[0]!.meta = { memberId: "ds1:m0", viewId: "view1" };
    const result = validateCandidateDoc(doc);
    expect(result.diagnostics.filter((d) => d.key === "diagram.validation.memberReference")).toEqual([]);
    doc.nodes[0]!.meta = { memberId: "ghost-ds:m0", viewId: "view1" };
    const bad = validateCandidateDoc(doc);
    expect(bad.diagnostics.filter((d) => d.key === "diagram.validation.memberReference")).toHaveLength(1);
  });

  it("flags non-finite and non-positive geometry", () => {
    const doc = createEmptyDoc("doc-geom");
    doc.nodes.push(
      { id: "n1", kind: "simple", x: Number.NaN, y: 0, w: 10, h: 10 },
      { id: "n2", kind: "simple", x: 0, y: Infinity, w: 10, h: 10 },
      { id: "n3", kind: "simple", x: 0, y: 0, w: 0, h: 10 },
      { id: "n4", kind: "simple", x: 0, y: 0, w: 10, h: -5 },
    );
    doc.edges.push({
      id: "e1",
      fromNode: "n1",
      fromPort: "e",
      toNode: "n2",
      toPort: "w",
      midOff: Number.NaN,
    });
    const result = validateCandidateDoc(doc);
    const geom = result.diagnostics.filter((d) => d.key === "diagram.validation.nonFiniteGeometry");
    expect(geom.map((d) => `${d.params?.id}:${d.params?.field}`)).toEqual([
      "n1:x",
      "n2:y",
      "n3:w",
      "n4:h",
      "e1:midOff",
    ]);
  });

  it("enforces node/edge count budgets", () => {
    const doc = createEmptyDoc("doc-count");
    doc.nodes.push(
      { id: "n1", kind: "simple", x: 0, y: 0, w: 10, h: 10 },
      { id: "n2", kind: "simple", x: 0, y: 0, w: 10, h: 10 },
    );
    doc.edges.push({ id: "e1", fromNode: "n1", fromPort: "e", toNode: "n2", toPort: "w" });
    const result = validateCandidateDoc(doc, { maxNodes: 1, maxEdges: 0 });
    const budgets = result.diagnostics.filter((d) => d.key === "diagram.validation.budgetExceeded");
    expect(budgets).toHaveLength(2);
    expect(budgets[0]?.params).toMatchObject({ kind: "nodes", limit: 1, actual: 2 });
    expect(budgets[1]?.params).toMatchObject({ kind: "edges", limit: 0, actual: 1 });
  });

  it("enforces string-length budgets on titles, bodies, bullets, and labels", () => {
    const doc = createEmptyDoc("doc-strings");
    const big = "x".repeat(50);
    doc.nodes.push({
      id: "n1",
      kind: "simple",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      title: big,
      body: big,
      bullets: ["ok", big],
    });
    doc.nodes.push({ id: "n2", kind: "simple", x: 0, y: 0, w: 10, h: 10 });
    doc.edges.push({ id: "e1", fromNode: "n1", fromPort: "e", toNode: "n2", toPort: "w", label: big });
    const result = validateCandidateDoc(doc, { maxStringLength: 10 });
    const fields = result.diagnostics
      .filter((d) => d.key === "diagram.validation.budgetExceeded")
      .map((d) => d.params?.field);
    expect(fields).toEqual(["title", "body", "bullets[1]", "label"]);
  });

  it("flags a matrix dataset with a span violation", () => {
    const doc = createEmptyDoc("doc-matrix");
    const matrix = matrixFromRowsCols(2, 2, { id: "ds1" });
    const anchor = Object.values(matrix.cells).find(
      (cell) => cell.rowId === matrix.rows[0]!.id && cell.colId === matrix.columns[0]!.id,
    )!;
    anchor.rowSpan = 5;
    doc.datasets = [matrix];
    const result = validateCandidateDoc(doc);
    const diag = result.diagnostics.find((d) => d.key === "diagram.validation.dataset");
    expect(diag?.params?.datasetId).toBe("ds1");
    expect(String(diag?.params?.error)).toContain("span out of range");
  });

  it("flags a semanticSpec dataset with duplicate idMap values", () => {
    const doc = createEmptyDoc("doc-semantic");
    const dataset: SemanticSpecDataset = {
      id: "ds-sem",
      kind: "semanticSpec",
      name: "Spec",
      diagramType: "architecture",
      spec: { schema_version: 1 },
      idMap: { a: "ds:m0", b: "ds:m0" },
      engine: { name: "archify", version: "0.1.0" },
    };
    doc.datasets = [dataset];
    const result = validateCandidateDoc(doc);
    const diag = result.diagnostics.find((d) => d.key === "diagram.validation.dataset");
    expect(diag?.params?.datasetId).toBe("ds-sem");
    expect(String(diag?.params?.error)).toContain("duplicate Maru id");
  });

  it("flags a schema version mismatch", () => {
    const doc = createEmptyDoc("doc-version");
    (doc as { v: number }).v = 8;
    const result = validateCandidateDoc(doc);
    expect(keysOf(result)).toContain("diagram.validation.schemaVersion");
    expect(result.diagnostics[0]?.params).toMatchObject({ expected: 9, actual: "8" });
  });

  it("never throws on hostile input", () => {
    const hostile = {
      v: 9,
      nodes: [null, 42, { id: "n1" }],
      edges: [null, { id: "e1" }],
      layers: "not-an-array",
      datasets: [null, { kind: "matrix" }],
      views: [null],
    } as unknown as DiagramDoc;
    expect(() => validateCandidateDoc(hostile)).not.toThrow();
  });
});

describe("validateArchifySpecPreCheck", () => {
  const validSpec = {
    schema_version: 1,
    meta: { title: "System overview", output: "diagram.html" },
    nodes: [],
  };

  it("accepts a well-formed spec", () => {
    const result = validateArchifySpecPreCheck("architecture", validSpec);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects an unknown diagram type", () => {
    const result = validateArchifySpecPreCheck("sequence", validSpec);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.key)).toContain("diagram.validation.specType");
  });

  it("rejects non-object and array specs", () => {
    for (const spec of [null, 42, "spec", [1, 2]]) {
      const result = validateArchifySpecPreCheck("workflow", spec);
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((d) => d.key)).toContain("diagram.validation.specShape");
    }
  });

  it("rejects an unserializable spec", () => {
    const circular: Record<string, unknown> = { schema_version: 1 };
    circular.self = circular;
    const result = validateArchifySpecPreCheck("architecture", circular);
    expect(result.diagnostics.map((d) => d.key)).toContain("diagram.validation.specBudget");
  });

  it("rejects an oversized spec", () => {
    const spec = { ...validSpec, blob: "x".repeat(SEMANTIC_SPEC_MAX_BYTES) };
    const result = validateArchifySpecPreCheck("architecture", spec);
    const diag = result.diagnostics.find((d) => d.key === "diagram.validation.specBudget");
    expect(diag).toBeDefined();
    expect(diag?.params?.maxBytes).toBe(SEMANTIC_SPEC_MAX_BYTES);
  });

  it("rejects a missing or non-numeric schema_version", () => {
    for (const spec of [
      { meta: { title: "T", output: "o.html" } },
      { schema_version: "1", meta: { title: "T", output: "o.html" } },
    ]) {
      const result = validateArchifySpecPreCheck("architecture", spec);
      const diag = result.diagnostics.find((d) => d.key === "diagram.validation.specMeta");
      expect(diag?.params?.field).toBe("schema_version");
    }
  });

  it("rejects a missing meta.title", () => {
    const result = validateArchifySpecPreCheck("architecture", {
      schema_version: 1,
      meta: { output: "o.html" },
    });
    const fields = result.diagnostics
      .filter((d) => d.key === "diagram.validation.specMeta")
      .map((d) => d.params?.field);
    expect(fields).toContain("meta.title");
  });

  it("rejects a meta.output that is not a portable .html filename", () => {
    for (const output of ["out.svg", "dir/out.html", "../out.html", "a\\b.html", 42]) {
      const result = validateArchifySpecPreCheck("architecture", {
        schema_version: 1,
        meta: { title: "T", output },
      });
      const fields = result.diagnostics
        .filter((d) => d.key === "diagram.validation.specMeta")
        .map((d) => d.params?.field);
      expect(fields).toContain("meta.output");
    }
  });
});
