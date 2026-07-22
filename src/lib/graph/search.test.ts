import { describe, expect, it } from "vitest";
import { rankGraphSearch } from "./search";

const nodes = [
  { id: "a", label: "Graph", relPath: "notes/graph.md" },
  { id: "b", label: "Graph Notes", relPath: "notes/graph-notes.md" },
  { id: "c", label: "My Graph Ideas", relPath: "notes/my-graph-ideas.md" },
  { id: "d", label: "Unrelated", relPath: "notes/graph-setup.md" },
  { id: "e", label: "Other", relPath: "notes/other.md" },
];

describe("rankGraphSearch", () => {
  it("ranks exact > prefix > substring > relPath substring", () => {
    const results = rankGraphSearch(nodes, "graph");
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("is case-insensitive", () => {
    expect(rankGraphSearch(nodes, "GRAPH")[0]?.id).toBe("a");
  });

  it("returns [] for a blank query", () => {
    expect(rankGraphSearch(nodes, "   ")).toEqual([]);
  });

  it("caps results at the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      label: `note ${i}`,
      relPath: null,
    }));
    expect(rankGraphSearch(many, "note")).toHaveLength(20);
  });

  it("breaks ties alphabetically for stable navigation", () => {
    const ties = [
      { id: "z", label: "graph z", relPath: null },
      { id: "y", label: "graph a", relPath: null },
    ];
    expect(rankGraphSearch(ties, "graph").map((r) => r.id)).toEqual(["y", "z"]);
  });
});
