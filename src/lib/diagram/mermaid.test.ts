import { describe, expect, it } from "vitest";

import { docToMermaid, mermaidToDoc } from "./mermaid";
import { DIAGRAM_SCHEMA_VERSION, createEmptyDoc } from "./types";

describe("docToMermaid", () => {
  it("emits flowchart TD with shaped nodes and edges", () => {
    const doc = createEmptyDoc("doc", 1);
    doc.docTitle = "Demo";
    doc.nodes.push(
      { id: "a", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "Start" },
      { id: "b", kind: "diamond", x: 0, y: 0, w: 100, h: 50, title: "Decision?" },
      { id: "c", kind: "oval", x: 0, y: 0, w: 100, h: 50, title: "Finish" },
    );
    doc.edges.push(
      { id: "e1", fromNode: "a", fromPort: "e", toNode: "b", toPort: "w", arrowEnd: "filled" },
      { id: "e2", fromNode: "b", fromPort: "e", toNode: "c", toPort: "w", arrowEnd: "filled", label: "yes" },
    );
    const out = docToMermaid(doc);
    expect(out).toContain("%% Demo");
    expect(out).toContain("flowchart TD");
    expect(out).toContain("[Start]");
    expect(out).toContain("{Decision?}");
    expect(out).toContain("((Finish))");
    expect(out).toContain(" --> b");
    expect(out).toContain("|yes| c");
  });

  it("escapes shape-sensitive characters in labels", () => {
    const doc = createEmptyDoc("doc", 1);
    doc.nodes.push({ id: "a", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "A | B (with) [brackets]" });
    const out = docToMermaid(doc);
    expect(out).not.toContain("[A | B (with) [brackets]]");
    expect(out).toMatch(/\[A {1,2}B with {1,2}brackets\]/);
  });
});

describe("mermaidToDoc", () => {
  it("produces docs at the current schema version", () => {
    const doc = mermaidToDoc("flowchart TD\n  A[Hi] --> B((Yo))", () => 42);
    expect(doc.v).toBe(DIAGRAM_SCHEMA_VERSION);
  });

  it("parses node shapes and arrow types", () => {
    const text = `flowchart TD
      A[Hello] --> B((World))
      B -.-> C{Choice}
      C -->|yes| D{{Hex}}`;
    const doc = mermaidToDoc(text, () => 42);
    expect(doc.nodes).toHaveLength(4);
    const kinds = doc.nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(["diamond", "hexagon", "oval", "simple"]);
    const labels = doc.nodes.map((n) => n.title).sort();
    expect(labels).toEqual(["Choice", "Hello", "Hex", "World"]);
    expect(doc.edges).toHaveLength(3);
    const dashed = doc.edges.find((e) => e.dash === "dashed");
    expect(dashed).toBeTruthy();
    const labeled = doc.edges.find((e) => e.label === "yes");
    expect(labeled).toBeTruthy();
  });

  it("ignores subgraphs/classDef/comments", () => {
    const text = `flowchart LR
      %% header
      classDef foo fill:#fff
      subgraph cluster
        A --> B
      end`;
    const doc = mermaidToDoc(text);
    expect(doc.nodes).toHaveLength(2);
    expect(doc.edges).toHaveLength(1);
  });

  it("falls back to a simple node for unknown shape syntax", () => {
    const text = `flowchart TD\n  A --> B`;
    const doc = mermaidToDoc(text);
    expect(doc.nodes.every((n) => n.kind === "simple")).toBe(true);
  });

  it("round-trips structurally through export → import", () => {
    const text = `flowchart TD
      a[Start] --> b{Decide}
      b -->|yes| c((Done))
      b -->|no| d((Cancel))`;
    const first = mermaidToDoc(text);
    const reEmitted = docToMermaid(first);
    const second = mermaidToDoc(reEmitted);
    expect(second.nodes.length).toBe(first.nodes.length);
    expect(second.edges.length).toBe(first.edges.length);
  });
});
