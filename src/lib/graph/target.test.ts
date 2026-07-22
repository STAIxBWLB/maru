import { describe, expect, it } from "vitest";
import type { GraphNode } from "./model";
import { graphLocalTargetForNode, graphNodeMatchesLocalTarget } from "./target";

function node(over: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "duplicate-title",
    label: "Duplicate title",
    relPath: "notes/one/Duplicate title.md",
    ownerWorkspacePath: null,
    type: "note",
    domain: null,
    degree: 0,
    community: null,
    isGodNode: false,
    date: null,
    updatedAt: null,
    ...over,
  };
}

describe("canonical graph Local targets", () => {
  it("matches relPath instead of a collision-prone node id", () => {
    const first = node();
    const second = node({ relPath: "notes/two/Duplicate title.md" });
    const target = { ownerWorkspacePath: null, relPath: "notes/two/Duplicate title.md" };
    expect(graphNodeMatchesLocalTarget(first, target)).toBe(false);
    expect(graphNodeMatchesLocalTarget(second, target)).toBe(true);
  });

  it("uses workspace ownership to disambiguate identical relative paths", () => {
    const target = { ownerWorkspacePath: "/work/b/", relPath: "notes/a.md" };
    expect(graphNodeMatchesLocalTarget(
      node({ relPath: "notes/a.md", ownerWorkspacePath: "/work/a" }),
      target,
    )).toBe(false);
    expect(graphNodeMatchesLocalTarget(
      node({ relPath: "notes/a.md", ownerWorkspacePath: "/work/b" }),
      target,
    )).toBe(true);
  });

  it("does not create a persisted target for unresolved nodes", () => {
    expect(graphLocalTargetForNode(node({ relPath: null, type: "unresolved" }))).toBeNull();
  });
});
