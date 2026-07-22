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

  it("matches owner-stamped nodes when the target owner is unknown", () => {
    // The Rust scanner stamps ownerWorkspacePath on every real entry
    // (vault.rs), while fixtures and older saved views send null. A null
    // target owner is a wildcard, not a literal null to equality-match —
    // otherwise every real "View in graph" handoff reports target missing.
    const target = { ownerWorkspacePath: null, relPath: "notes/a.md" };
    expect(graphNodeMatchesLocalTarget(
      node({ relPath: "notes/a.md", ownerWorkspacePath: "/Users/x/vault" }),
      target,
    )).toBe(true);
    // A known owner still requires exact equality.
    expect(graphNodeMatchesLocalTarget(
      node({ relPath: "notes/a.md", ownerWorkspacePath: "/Users/x/vault" }),
      { ownerWorkspacePath: "/Users/y/vault", relPath: "notes/a.md" },
    )).toBe(false);
  });
});
