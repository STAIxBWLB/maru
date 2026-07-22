import { describe, expect, it } from "vitest";
import type { GraphFilterProfile } from "../settings";
import { applyGraphSearch, deriveGraphView } from "./derive";
import { GRAPH_FIXTURES } from "./fixtures";
import {
  buildVaultGraph,
  graphEdgeVisibilityKey,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
} from "./model";

function node(over: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    label: over.id,
    relPath: `notes/${over.id}.md`,
    ownerWorkspacePath: null,
    type: "insight",
    domain: null,
    degree: 0,
    community: null,
    isGodNode: false,
    date: null,
    updatedAt: null,
    ...over,
  };
}

function edge(source: string, target: string, relation = "wiki_link"): GraphEdge {
  return { source, target, relation, fromFrontmatter: relation !== "wiki_link" };
}

function model(nodes: GraphNode[], edges: GraphEdge[]): GraphModel {
  return { nodes, edges, enriched: false, builtAt: 0 };
}

function profile(over: Partial<GraphFilterProfile> = {}): GraphFilterProfile {
  return {
    domains: [],
    types: [],
    relations: [],
    community: null,
    showUnresolved: false,
    showGenerated: false,
    minVisibleNeighbors: 0,
    ...over,
  };
}

function derive(
  m: GraphModel,
  p: GraphFilterProfile,
  over: Partial<Parameters<typeof deriveGraphView>[0]> = {},
) {
  return deriveGraphView({
    model: m,
    profile: p,
    generatedPatterns: ["reports/"],
    mode: "global",
    focusNodeId: null,
    localDepth: 2,
    localDirection: "both",
    search: "",
    searchAsFilter: false,
    ...over,
  });
}

const ids = (m: GraphModel) => m.nodes.map((n) => n.id).sort();

describe("deriveGraphView — node facets", () => {
  it("keeps untyped notes visible by default", () => {
    const m = model([node({ id: "a", type: "untyped" })], []);
    const d = derive(m, profile());
    expect(ids(d.visibleModel)).toEqual(["a"]);
  });

  it("hides generated notes by default and shows them with showGenerated", () => {
    const m = model(
      [node({ id: "a" }), node({ id: "report", relPath: "reports/weekly.md" })],
      [edge("a", "report")],
    );
    const hidden = derive(m, profile());
    expect(ids(hidden.visibleModel)).toEqual(["a"]);
    const shown = derive(m, profile({ showGenerated: true }));
    expect(ids(shown.visibleModel)).toEqual(["a", "report"]);
  });

  it("hides unresolved ghosts by default", () => {
    const m = model(
      [node({ id: "a" }), node({ id: "ghost", relPath: null, type: "unresolved" })],
      [edge("a", "ghost")],
    );
    const d = derive(m, profile());
    expect(ids(d.visibleModel)).toEqual(["a"]);
    expect(d.visibleModel.edges).toHaveLength(0);
    const shown = derive(m, profile({ showUnresolved: true }));
    expect(ids(shown.visibleModel)).toEqual(["a", "ghost"]);
  });
});

describe("deriveGraphView — relation filter", () => {
  it("drops non-matching edges before traversal and neighbor counting", () => {
    // a -[wiki_link]-> b, a -[topics]-> c
    const m = model(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      [edge("a", "b", "wiki_link"), edge("a", "c", "topics")],
    );
    const d = derive(m, profile({ relations: ["topics"] }));
    expect(d.analysisModel.edges).toHaveLength(1);
    expect(d.analysisModel.edges[0].relation).toBe("topics");
    expect(d.visibleEdgeKeys).toEqual(new Set([graphEdgeVisibilityKey(edge("a", "c", "topics"))]));
    expect(d.analysisModel.nodes.find((item) => item.id === "a")?.degree).toBe(1);
    // Neighbor counts reflect only the kept edges.
    expect(d.visibleNeighborCounts.get("a")).toBe(1);
    expect(d.visibleNeighborCounts.get("b")).toBe(0);
    // And traversal sees only the kept edges.
    const local = derive(m, profile({ relations: ["topics"] }), {
      mode: "local",
      focusNodeId: "a",
      localDepth: 1,
    });
    expect(ids(local.visibleModel)).toEqual(["a", "c"]);
  });
});

describe("deriveGraphView — minVisibleNeighbors pruning", () => {
  it("prunes a chain A-B-C below threshold 2 (cascade)", () => {
    const m = model(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      [edge("a", "b"), edge("b", "c")],
    );
    const d = derive(m, profile({ minVisibleNeighbors: 2 }));
    expect(d.visibleModel.nodes).toHaveLength(0);
    expect(d.emptyReason).toBe("filtered-empty");
  });

  it("keeps a triangle at threshold 2", () => {
    const m = model(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    );
    const d = derive(m, profile({ minVisibleNeighbors: 2 }));
    expect(ids(d.visibleModel)).toEqual(["a", "b", "c"]);
  });

  it("never prunes the focus anchor", () => {
    const m = model(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      [edge("a", "b"), edge("b", "c")],
    );
    const d = derive(m, profile({ minVisibleNeighbors: 2 }), {
      mode: "local",
      focusNodeId: "a",
      localDepth: 2,
    });
    expect(ids(d.visibleModel)).toEqual(["a"]);
  });

  it("retains a Local focus even when node facets would normally hide it", () => {
    const m = model(
      [
        node({ id: "a", domain: "ops", type: "unresolved", relPath: null }),
        node({ id: "b", domain: "research" }),
      ],
      [edge("a", "b")],
    );
    const d = derive(m, profile({ domains: ["research"], showUnresolved: false }), {
      mode: "local",
      focusNodeId: "a",
      localDepth: 1,
    });
    expect(d.focusMissing).toBe(false);
    expect(ids(d.visibleModel)).toEqual(["a", "b"]);
  });
});

describe("deriveGraphView — paused filters", () => {
  it("pauses a community selection no node carries; global stays visible", () => {
    const m = model([node({ id: "a", community: 1 }), node({ id: "b", community: 2 })], [edge("a", "b")]);
    const d = derive(m, profile({ community: 9 }));
    expect(ids(d.visibleModel)).toEqual(["a", "b"]);
    expect(d.pausedFilters).toEqual(["community:9"]);
  });

  it("pauses absent domain/type/relation values", () => {
    const m = model([node({ id: "a", domain: "research" })], []);
    const d = derive(
      m,
      profile({ domains: ["nope"], types: ["nope"], relations: ["nope"] }),
    );
    expect(ids(d.visibleModel)).toEqual(["a"]);
    expect(d.pausedFilters).toEqual(["domain:nope", "type:nope", "relation:nope"]);
  });
});

describe("deriveGraphView — search-as-filter", () => {
  it("keeps matches plus their 1-hop neighbors", () => {
    const m = model(
      [
        node({ id: "alpha", label: "Alpha" }),
        node({ id: "beta", label: "Beta" }),
        node({ id: "gamma", label: "Gamma" }),
      ],
      [edge("alpha", "beta"), edge("beta", "gamma")],
    );
    const d = derive(m, profile(), { search: "alph", searchAsFilter: true });
    expect(ids(d.visibleModel)).toEqual(["alpha", "beta"]);
  });

  it("uses the same relPath matching contract as ranked search", () => {
    const m = model(
      [node({ id: "alpha", label: "Alpha", relPath: "projects/hidden-key.md" }), node({ id: "beta" })],
      [edge("alpha", "beta")],
    );
    expect(ids(derive(m, profile(), { search: "hidden-key", searchAsFilter: true }).visibleModel))
      .toEqual(["alpha", "beta"]);
  });
});

describe("deriveGraphView — empty reasons", () => {
  it("reports empty-source for a node-less model", () => {
    const d = derive(model([], []), profile());
    expect(d.emptyReason).toBe("empty-source");
  });

  it("reports filtered-empty when filters remove everything", () => {
    const m = model([node({ id: "ghost", relPath: null, type: "unresolved" })], []);
    const d = derive(m, profile());
    expect(d.emptyReason).toBe("filtered-empty");
  });

  it("reports null when nodes remain", () => {
    const d = derive(model([node({ id: "a" })], []), profile());
    expect(d.emptyReason).toBeNull();
  });
});

describe("deriveGraphView — local mode", () => {
  const chain = () =>
    model(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" }), node({ id: "d" })],
      [edge("a", "b"), edge("b", "c"), edge("c", "d")],
    );

  it("limits to k-hop neighborhood", () => {
    const d = derive(chain(), profile(), { mode: "local", focusNodeId: "a", localDepth: 1 });
    expect(ids(d.visibleModel)).toEqual(["a", "b"]);
    const d2 = derive(chain(), profile(), { mode: "local", focusNodeId: "a", localDepth: 2 });
    expect(ids(d2.visibleModel)).toEqual(["a", "b", "c"]);
  });

  it("respects direction", () => {
    const d = derive(chain(), profile(), {
      mode: "local",
      focusNodeId: "b",
      localDepth: 1,
      localDirection: "outgoing",
    });
    expect(ids(d.visibleModel)).toEqual(["b", "c"]);
  });

  it("sets focusMissing and keeps the global graph when the focus id is absent", () => {
    const d = derive(chain(), profile(), { mode: "local", focusNodeId: "zzz" });
    expect(d.focusMissing).toBe(true);
    expect(ids(d.visibleModel)).toEqual(["a", "b", "c", "d"]);
  });

  it("sets focusMissing when the focus node was facet-filtered out", () => {
    const d = derive(chain(), profile({ showUnresolved: false }), {
      mode: "local",
      focusNodeId: "ghost",
    });
    expect(d.focusMissing).toBe(true);
    expect(ids(d.visibleModel)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("deriveGraphView — facets", () => {
  it("self-excludes the active facet and retains paused selections at zero", () => {
    const m = model(
      [
        node({ id: "a", domain: "research", type: "decision" }),
        node({ id: "b", domain: "research", type: "decision" }),
        node({ id: "c", domain: "ops", type: "decision" }),
      ],
      [edge("a", "b", "topics"), edge("a", "b", "wiki_link")],
    );
    const d = derive(m, profile({ domains: ["research", "missing"], relations: ["topics"] }));
    expect(d.facets.domains).toEqual([
      { value: "missing", count: 0 },
      { value: "ops", count: 1 },
      { value: "research", count: 2 },
    ]);
    expect(d.facets.relations).toEqual([
      { value: "topics", count: 1 },
      { value: "wiki_link", count: 1 },
    ]);
    expect(d.pausedFilters).toContain("domain:missing");
  });

  it("counts distinct visible neighbors when parallel relations exist", () => {
    const m = model(
      [node({ id: "a" }), node({ id: "b" })],
      [edge("a", "b", "topics"), edge("a", "b", "wiki_link")],
    );
    const d = derive(m, profile());
    expect(d.visibleNeighborCounts.get("a")).toBe(1);
    expect(d.facets.maxVisibleNeighbors).toBe(1);
  });

  it("keeps self-excluding facet counts global while neighbor range follows Local", () => {
    const m = model(
      [
        node({ id: "a", domain: "research", community: 1 }),
        node({ id: "b", domain: "research", community: 1 }),
        node({ id: "c", domain: "ops", community: 2 }),
      ],
      [edge("a", "b", "topics"), edge("b", "c", "wiki_link")],
    );
    const d = derive(m, profile(), { mode: "local", focusNodeId: "a", localDepth: 1 });
    expect(d.facets.domains).toEqual([
      { value: "ops", count: 1 },
      { value: "research", count: 2 },
    ]);
    expect(d.facets.relations).toEqual([
      { value: "topics", count: 1 },
      { value: "wiki_link", count: 1 },
    ]);
    expect(d.facets.communities).toEqual([
      { value: 1, count: 2 },
      { value: 2, count: 1 },
    ]);
    expect(d.facets.maxVisibleNeighbors).toBe(1);
  });
});

describe("applyGraphSearch — two-stage identity", () => {
  it("keeps the analysis stage stable while search narrows the visible stage", () => {
    const m = buildVaultGraph(GRAPH_FIXTURES.dense());
    const args = {
      model: m,
      profile: profile(),
      generatedPatterns: [] as string[],
      mode: "global" as const,
      focusNodeId: null,
      localDepth: 2 as const,
      localDirection: "both" as const,
      search: "",
      searchAsFilter: false,
    };
    const analysis = deriveGraphView(args);
    // No query: the base derivation is returned as-is (same identity), so a
    // keystroke with search-as-filter off cannot restart downstream workers.
    expect(applyGraphSearch(analysis, "")).toBe(analysis);
    // Splitting the stages is behavior-preserving: analysis + search equals
    // the single-pass derivation with the same query.
    const narrowed = applyGraphSearch(analysis, "note-1");
    const single = deriveGraphView({ ...args, search: "note-1", searchAsFilter: true });
    expect(narrowed.analysisModel).toBe(analysis.analysisModel);
    expect([...narrowed.visibleNodeIds].sort()).toEqual([...single.visibleNodeIds].sort());
    expect([...narrowed.visibleEdgeKeys].sort()).toEqual([...single.visibleEdgeKeys].sort());
    expect(narrowed.emptyReason).toBe(single.emptyReason);
  });

  it("reports filtered-empty when the query matches nothing", () => {
    const m = buildVaultGraph(GRAPH_FIXTURES.dense());
    const analysis = deriveGraphView({
      model: m,
      profile: profile(),
      generatedPatterns: [],
      mode: "global",
      focusNodeId: null,
      localDepth: 2,
      localDirection: "both",
      search: "",
      searchAsFilter: false,
    });
    const narrowed = applyGraphSearch(analysis, "no-such-node-anywhere");
    expect(narrowed.visibleModel.nodes).toHaveLength(0);
    expect(narrowed.emptyReason).toBe("filtered-empty");
  });
});

describe("deriveGraphView — perf budget", () => {
  it("filter/search round-trip stays under 100ms on the dense fixture", () => {
    // 1,200 nodes / ~6,000 edges — the interactive budget for a filter or
    // search keystroke. (Build time excluded; measured on derive only.)
    const m = buildVaultGraph(GRAPH_FIXTURES.dense());
    const start = performance.now();
    const d = deriveGraphView({
      model: m,
      profile: profile({ domains: ["research"], minVisibleNeighbors: 2 }),
      generatedPatterns: ["reports/"],
      mode: "global",
      focusNodeId: null,
      localDepth: 2,
      localDirection: "both",
      search: "note-1",
      searchAsFilter: true,
    });
    const elapsed = performance.now() - start;
    expect(d.visibleModel.nodes.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});
