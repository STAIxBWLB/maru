import { describe, expect, it } from "vitest";

import { deserializeDoc, migrate, serializeDoc } from "./persistence";
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
