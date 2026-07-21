import { describe, expect, it } from "vitest";

import { deserializeDoc, migrate, serializeDoc, UnsupportedDiagramVersionError } from "./persistence";
import {
  computeProjectionHash,
  matrixFromRowsCols,
  validateMatrix,
} from "./reportTypes";
import { DIAGRAM_SCHEMA_VERSION, createEmptyDoc } from "./types";

describe("diagram persistence", () => {
  it("round-trips a v:7 doc", () => {
    const doc = createEmptyDoc("doc-1", 1700000000000);
    doc.docTitle = "Sample";
    doc.nodes.push({ id: "n1", kind: "simple", x: 10, y: 20, w: 140, h: 60, title: "Hello" });
    const json = serializeDoc(doc);
    const parsed = deserializeDoc(json, () => 1700000000000);
    expect(parsed.v).toBe(DIAGRAM_SCHEMA_VERSION);
    expect(parsed.id).toBe("doc-1");
    expect(parsed.docTitle).toBe("Sample");
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]?.title).toBe("Hello");
  });

  it("migrates legacy v:6 docs and bumps the version", () => {
    const legacy = {
      v: 6,
      docTitle: "Legacy",
      nodes: [{ id: "a", kind: "simple", x: 0, y: 0, w: 100, h: 50 }],
      edges: [],
      createdAt: 1600000000000,
      updatedAt: 1600000000000,
    };
    const migrated = migrate(legacy);
    expect(migrated.v).toBe(DIAGRAM_SCHEMA_VERSION);
    expect(migrated.docTitle).toBe("Legacy");
    expect(migrated.layers).toHaveLength(1);
    expect(migrated.layers[0]?.id).toBe("default");
  });

  it("wraps bare {nodes,edges} JSON exports", () => {
    const bare = { nodes: [{ id: "n1", kind: "text", x: 5, y: 5 }], edges: [] };
    const migrated = migrate(bare, () => 42);
    expect(migrated.v).toBe(DIAGRAM_SCHEMA_VERSION);
    expect(migrated.id).toBeTruthy();
    expect(migrated.createdAt).toBe(42);
    expect(migrated.nodes).toHaveLength(1);
    expect(migrated.nodes[0]?.kind).toBe("text");
  });

  it("synthesizes ids for nameless nodes and edges", () => {
    const raw = {
      nodes: [{ kind: "simple", x: 0, y: 0 }, { kind: "text", x: 10, y: 10 }],
      edges: [{ fromNode: "node-1", toNode: "node-2" }],
    };
    const out = migrate(raw);
    expect(out.nodes[0]?.id).toBe("node-1");
    expect(out.nodes[1]?.id).toBe("node-2");
    expect(out.edges[0]?.id).toBe("edge-1");
    expect(out.edges[0]?.fromPort).toBe("e");
    expect(out.edges[0]?.toPort).toBe("w");
  });

  it("skips malformed edges", () => {
    const out = migrate({ nodes: [], edges: [{ fromNode: 5 }, null, "x"] });
    expect(out.edges).toEqual([]);
  });

  it("coerces unknown node kinds to a supported kind", () => {
    const out = migrate({ nodes: [{ id: "n1", kind: "future-node", x: 0, y: 0 }], edges: [] });
    expect(out.nodes[0]?.kind).toBe("simple");
  });

  it("deserializeDoc throws on bad JSON", () => {
    expect(() => deserializeDoc("not json")).toThrow(/Cannot parse diagram JSON/);
  });

  it("returns an empty-but-valid doc for non-object input", () => {
    const out = migrate(null);
    expect(out.v).toBe(DIAGRAM_SCHEMA_VERSION);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.layers).toHaveLength(1);
  });
});

describe("diagram persistence v8 (report pattern studio)", () => {
  it("migrates a legacy v:7 table node with meta.rows/cols into a dataset + view", () => {
    const legacy = {
      v: 7,
      docTitle: "Legacy tables",
      nodes: [
        {
          id: "t1",
          kind: "table",
          x: 10,
          y: 20,
          w: 300,
          h: 200,
          title: "KPIs",
          meta: { rows: 3, cols: 4, memo: "review", custom: "keep-me" },
        },
      ],
      edges: [],
    };
    const doc = migrate(legacy);
    expect(doc.v).toBe(8);

    expect(doc.datasets).toHaveLength(1);
    const dataset = doc.datasets?.[0];
    expect(dataset?.kind).toBe("matrix");
    if (dataset?.kind !== "matrix") throw new Error("expected matrix dataset");
    expect(dataset.name).toBe("KPIs");
    expect(dataset.rows).toHaveLength(3);
    expect(dataset.columns).toHaveLength(4);
    expect(Object.keys(dataset.cells)).toHaveLength(12);
    expect(validateMatrix(dataset).ok).toBe(true);

    expect(doc.views).toHaveLength(1);
    const view = doc.views?.[0];
    expect(view?.patternId).toBe("table");
    expect(view?.datasetId).toBe(dataset.id);
    expect(view?.bounds).toEqual({ x: 10, y: 20, w: 300, h: 200 });
    expect(view?.nodeIds).toEqual(["t1"]);
    expect(view?.projectionHash).toMatch(/^[0-9a-f]{8}$/);

    const node = doc.nodes[0];
    expect(node?.x).toBe(10);
    expect(node?.w).toBe(300);
    expect(node?.meta?.viewId).toBe(view?.id);
    expect(node?.meta?.memberId).toBe(dataset.id);
    // typed meta mapping + unknown keys preserved, consumed keys removed
    expect(node?.meta?.memo).toBe("review");
    expect(node?.meta?.custom).toBe("keep-me");
    expect(node?.meta?.rows).toBeUndefined();
    expect(node?.meta?.cols).toBeUndefined();
  });

  it("maps typed legacy meta keys and leaves unknown keys untouched", () => {
    const legacy = {
      v: 7,
      nodes: [
        {
          id: "n1",
          kind: "image",
          x: 0,
          y: 0,
          w: 100,
          h: 100,
          meta: {
            src: "diagrams/img.png",
            name: "figure",
            memo: "note",
            status: "draft",
            progress: 0.5,
            number: 7,
            futureKey: { nested: true },
          },
        },
      ],
      edges: [],
    };
    const node = migrate(legacy).nodes[0];
    expect(node?.meta?.src).toBe("diagrams/img.png");
    expect(node?.meta?.name).toBe("figure");
    expect(node?.meta?.memo).toBe("note");
    expect(node?.meta?.status).toBe("draft");
    expect(node?.meta?.progress).toBe(0.5);
    expect(node?.meta?.number).toBe(7);
    expect(node?.meta?.futureKey).toEqual({ nested: true });
  });

  it("keeps non-table nodes with meta.rows/cols untouched", () => {
    const legacy = {
      v: 7,
      nodes: [{ id: "n1", kind: "simple", x: 0, y: 0, w: 10, h: 10, meta: { rows: 2, cols: 2 } }],
      edges: [],
    };
    const doc = migrate(legacy);
    expect(doc.datasets).toEqual([]);
    expect(doc.views).toEqual([]);
    expect(doc.nodes[0]?.meta?.rows).toBe(2);
  });

  it("passes v:8 docs through with defaults and round-trips losslessly", () => {
    const matrix = matrixFromRowsCols(2, 2, { name: "m" });
    const view = {
      id: "view-1",
      datasetId: matrix.id,
      patternId: "table",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodeIds: ["n1"],
      edgeIds: [],
      projectionHash: computeProjectionHash({ patternId: "table" }),
    };
    const raw = {
      v: 8,
      id: "doc-8",
      docTitle: "V8",
      createdAt: 1,
      updatedAt: 2,
      nodes: [{ id: "n1", kind: "table", x: 0, y: 0, w: 100, h: 100 }],
      edges: [],
      layers: [{ id: "default", name: "default", visible: true, locked: false, order: 0 }],
      datasets: [matrix],
      views: [view],
    };
    const doc = migrate(raw);
    expect(doc.v).toBe(8);
    expect(doc.datasets).toHaveLength(1);
    // no extra datasets/views synthesized for v8 input
    expect(doc.views).toEqual([view]);

    const roundTripped = deserializeDoc(serializeDoc(doc));
    expect(JSON.parse(serializeDoc(roundTripped))).toEqual(JSON.parse(serializeDoc(doc)));
    const dataset = roundTripped.datasets?.[0];
    if (dataset?.kind !== "matrix") throw new Error("expected matrix dataset");
    expect(validateMatrix(dataset).ok).toBe(true);
  });

  it("normalizes missing datasets/views to empty arrays", () => {
    const doc = migrate({ v: 8, nodes: [], edges: [] });
    expect(doc.datasets).toEqual([]);
    expect(doc.views).toEqual([]);
  });

  it("throws UnsupportedDiagramVersionError for v:9 and never down-converts", () => {
    expect(() => migrate({ v: 9, nodes: [], edges: [] })).toThrow(UnsupportedDiagramVersionError);
    try {
      migrate({ v: 9, nodes: [], edges: [] });
      expect.unreachable();
    } catch (err) {
      const typed = err as UnsupportedDiagramVersionError;
      expect(typed.version).toBe(9);
      expect(typed.supported).toBe(DIAGRAM_SCHEMA_VERSION);
      expect(typed.message).toMatch(/v9/);
    }
    expect(() => deserializeDoc(JSON.stringify({ v: 42 }))).toThrow(UnsupportedDiagramVersionError);
  });

  it("still wraps bare {nodes,edges} exports without synthesizing datasets", () => {
    const doc = migrate({ nodes: [{ id: "t", kind: "table", x: 0, y: 0, meta: { rows: 2, cols: 2 } }], edges: [] });
    expect(doc.v).toBe(8);
    expect(doc.datasets).toEqual([]);
    expect(doc.views).toEqual([]);
  });

  it("rejects a present-but-non-numeric v instead of silently rewriting", () => {
    // `{"v":"9"}` is a format this build does not know — treating it as
    // unversioned would discard unknown fields and overwrite it as v8 on save.
    expect(() => migrate({ v: "9", nodes: [], edges: [] })).toThrow(UnsupportedDiagramVersionError);
    expect(() => migrate({ v: null, nodes: [], edges: [] })).toThrow(UnsupportedDiagramVersionError);
    expect(() => migrate({ v: NaN, nodes: [], edges: [] })).toThrow(UnsupportedDiagramVersionError);
  });
});
