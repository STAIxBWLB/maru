import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../lib/graph/model";
import { edgeKey, graphTopologySignature } from "./graphStyle";

describe("edgeKey", () => {
  it("is order-independent", () => {
    expect(edgeKey("a", "b")).toBe(edgeKey("b", "a"));
  });

  it("does not collide when ids contain spaces", () => {
    // A plain-space delimiter would map both "x"+"y z" and "x y"+"z" to "x y z";
    // the NUL delimiter keeps them distinct (path-highlight correctness).
    expect(edgeKey("x", "y z")).not.toBe(edgeKey("x y", "z"));
  });

  it("keeps both ids recoverable", () => {
    const k = edgeKey("alpha", "beta");
    expect(k.includes("alpha")).toBe(true);
    expect(k.includes("beta")).toBe(true);
  });
});

describe("graphTopologySignature", () => {
  const nodes = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ] as GraphNode[];
  const edges = [
    { source: "a", target: "b", relation: "related", fromFrontmatter: true },
  ] as GraphEdge[];

  it("ignores metadata-only node changes", () => {
    const renamed = nodes.map((node) => ({ ...node, label: `${node.label}!` }));
    expect(graphTopologySignature(renamed, edges)).toBe(graphTopologySignature(nodes, edges));
  });

  it("changes when same-cardinality topology changes", () => {
    const rewired = [
      { source: "a", target: "c", relation: "related", fromFrontmatter: true },
    ] as GraphEdge[];
    expect(graphTopologySignature(nodes, rewired)).not.toBe(
      graphTopologySignature(nodes, edges),
    );
  });
});
