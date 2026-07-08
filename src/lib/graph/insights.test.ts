import { describe, expect, it } from "vitest";
import {
  findBridges,
  findHiddenLinks,
  findOrphans,
  findStale,
  findSurprisingConnections,
  shortestPath,
} from "./insights";
import type { GraphEdge, GraphModel, GraphNode } from "./model";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    relPath: `notes/${id}.md`,
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

function edge(source: string, target: string): GraphEdge {
  return { source, target, relation: "wiki_link", fromFrontmatter: false };
}

/** Build a model and fill in each node's degree from the edge list. */
function model(nodes: GraphNode[], edges: GraphEdge[], enriched = false): GraphModel {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (s) s.degree += 1;
    if (t) t.degree += 1;
  }
  return { nodes, edges, enriched, builtAt: 0 };
}

describe("findHiddenLinks", () => {
  it("surfaces non-adjacent pairs sharing ≥2 neighbors", () => {
    // a and b both link to hubs h1 and h2, but a–b is not linked.
    const m = model(
      [node("a"), node("b"), node("h1"), node("h2")],
      [edge("a", "h1"), edge("a", "h2"), edge("b", "h1"), edge("b", "h2")],
    );
    const links = findHiddenLinks(m);
    const ab = links.find(
      (l) => (l.source === "a" && l.target === "b") || (l.source === "b" && l.target === "a"),
    );
    expect(ab).toBeDefined();
    expect(ab!.shared).toBe(2);
    expect(ab!.via.sort()).toEqual(["h1", "h2"]);
  });

  it("does not suggest already-linked pairs", () => {
    const m = model(
      [node("a"), node("b"), node("h1"), node("h2")],
      [edge("a", "h1"), edge("a", "h2"), edge("b", "h1"), edge("b", "h2"), edge("a", "b")],
    );
    const links = findHiddenLinks(m);
    expect(links.find((l) => new Set([l.source, l.target]).has("a") && new Set([l.source, l.target]).has("b"))).toBeUndefined();
  });

  it("ignores shared MOC / ghost neighbors", () => {
    const m = model(
      [node("a"), node("b"), node("moc", { type: "moc" }), node("ghost", { type: "unresolved" })],
      [edge("a", "moc"), edge("b", "moc"), edge("a", "ghost"), edge("b", "ghost")],
    );
    // Only shared neighbors are a MOC and a ghost — both excluded → no suggestion.
    expect(findHiddenLinks(m)).toHaveLength(0);
  });
});

describe("findSurprisingConnections", () => {
  it("returns [] without community enrichment", () => {
    const m = model([node("a"), node("b")], [edge("a", "b")]);
    expect(findSurprisingConnections(m)).toHaveLength(0);
  });

  it("ranks cross-community edges by combined degree", () => {
    const m = model(
      [
        node("a", { community: 0 }),
        node("b", { community: 1 }),
        node("c", { community: 0 }),
        node("d", { community: 0 }),
      ],
      [edge("a", "b"), edge("a", "c"), edge("a", "d")],
      true,
    );
    const surprises = findSurprisingConnections(m);
    // a–b is the only cross-community edge.
    expect(surprises).toHaveLength(1);
    expect(surprises[0].source).toBe("a");
    expect(surprises[0].target).toBe("b");
  });
});

describe("findBridges", () => {
  it("ranks nodes by distinct neighbor communities", () => {
    const m = model(
      [
        node("hub", { community: 0 }),
        node("x", { community: 1 }),
        node("y", { community: 2 }),
        node("z", { community: 3 }),
      ],
      [edge("hub", "x"), edge("hub", "y"), edge("hub", "z")],
      true,
    );
    const bridges = findBridges(m);
    expect(bridges[0].id).toBe("hub");
    expect(bridges[0].communityCount).toBe(3);
  });
});

describe("findOrphans", () => {
  it("returns notes with ≤1 link, excluding MOC and ghosts", () => {
    const m = model(
      [node("lonely"), node("linked"), node("hub"), node("moc", { type: "moc" }), node("ghost", { type: "unresolved" })],
      [edge("linked", "hub"), edge("hub", "moc"), edge("hub", "ghost")],
    );
    const orphans = findOrphans(m).map((o) => o.id);
    expect(orphans).toContain("lonely");
    expect(orphans).not.toContain("moc");
    expect(orphans).not.toContain("ghost");
  });
});

describe("findStale", () => {
  it("flags well-connected notes older than the cutoff", () => {
    const now = Date.parse("2026-07-08T00:00:00Z");
    const old = "2026-01-01T00:00:00Z";
    const fresh = "2026-07-01T00:00:00Z";
    const m = model(
      [
        node("old-hub", { updatedAt: old }),
        node("fresh-hub", { updatedAt: fresh }),
        node("old-orphan", { updatedAt: old }),
      ],
      [edge("old-hub", "fresh-hub"), edge("old-hub", "old-orphan"), edge("old-hub", "fresh-hub")],
    );
    const stale = findStale(m, 30, now).map((s) => s.id);
    expect(stale).toContain("old-hub");
    expect(stale).not.toContain("fresh-hub"); // too recent
    expect(stale).not.toContain("old-orphan"); // degree < 2
  });
});

describe("shortestPath", () => {
  it("finds the shortest chain between two nodes", () => {
    const m = model(
      [node("a"), node("b"), node("c"), node("d")],
      [edge("a", "b"), edge("b", "c"), edge("c", "d")],
    );
    expect(shortestPath(m, "a", "d")).toEqual(["a", "b", "c", "d"]);
  });

  it("returns null when disconnected", () => {
    const m = model([node("a"), node("b"), node("c")], [edge("a", "b")]);
    expect(shortestPath(m, "a", "c")).toBeNull();
  });

  it("returns the single node for identical endpoints", () => {
    const m = model([node("a")], []);
    expect(shortestPath(m, "a", "a")).toEqual(["a"]);
  });
});
