import { describe, expect, it } from "vitest";
import type { VaultEntry } from "../types";
import {
  buildAdjacency,
  buildVaultGraph,
  enrichGraph,
  focusSubgraph,
  type VaultGraphFile,
} from "./model";

function entry(overrides: Partial<VaultEntry> & { relPath: string }): VaultEntry {
  return {
    path: `/vault/${overrides.relPath}`,
    title: overrides.relPath.split("/").pop()!.replace(/\.md$/, ""),
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "md",
    versionCount: 0,
    links: [],
    ...overrides,
  };
}

const A = entry({
  relPath: "notes/a-note.md",
  frontmatter: { type: "insight", domain: "research", topics: ["[[projects]]"] },
  links: ["b-note", "projects"],
});
const B = entry({
  relPath: "notes/b-note.md",
  frontmatter: { type: "decision", domain: "projects" },
  links: ["missing-target"],
});
const MOC = entry({
  relPath: "notes/projects.md",
  frontmatter: { type: "moc", domain: "projects" },
});

describe("buildVaultGraph", () => {
  it("resolves body links to node ids and tags frontmatter fields as relations", () => {
    const model = buildVaultGraph([A, B, MOC]);
    // topics frontmatter → relation "topics", fromFrontmatter
    const topicsEdge = model.edges.find(
      (e) => e.source === "a-note" && e.target === "projects" && e.relation === "topics",
    );
    expect(topicsEdge?.fromFrontmatter).toBe(true);
    // body link a→b (not in frontmatter) → wiki_link
    const bodyEdge = model.edges.find(
      (e) => e.source === "a-note" && e.target === "b-note",
    );
    expect(bodyEdge?.relation).toBe("wiki_link");
    expect(bodyEdge?.fromFrontmatter).toBe(false);
  });

  it("creates ghost nodes for unresolved targets", () => {
    const model = buildVaultGraph([A, B, MOC]);
    const ghost = model.nodes.find((n) => n.id === "missing-target");
    expect(ghost).toBeDefined();
    expect(ghost!.type).toBe("unresolved");
    expect(ghost!.relPath).toBeNull();
  });

  it("dedupes (source, target, relation) triples", () => {
    const dup = entry({
      relPath: "notes/dup.md",
      frontmatter: {},
      links: ["a-note", "a-note"],
    });
    const model = buildVaultGraph([A, B, MOC, dup]);
    const edges = model.edges.filter(
      (e) => e.source === "dup" && e.target === "a-note",
    );
    expect(edges).toHaveLength(1);
  });

  it("keeps a frontmatter edge and a body wiki_link to the same target as one edge each relation", () => {
    // body links that duplicate frontmatter targets are suppressed (entry.links
    // merges both; the model subtracts frontmatter targets from body links)
    const model = buildVaultGraph([A, B, MOC]);
    const aToProjects = model.edges.filter(
      (e) => e.source === "a-note" && e.target === "projects",
    );
    expect(aToProjects).toHaveLength(1);
    expect(aToProjects[0].relation).toBe("topics");
  });

  it("computes degree and marks god nodes excluding moc/unresolved", () => {
    const model = buildVaultGraph([A, B, MOC]);
    const a = model.nodes.find((n) => n.id === "a-note")!;
    expect(a.degree).toBeGreaterThan(0);
    const moc = model.nodes.find((n) => n.id === "projects")!;
    expect(moc.isGodNode).toBe(false);
    const ghost = model.nodes.find((n) => n.id === "missing-target")!;
    expect(ghost.isGodNode).toBe(false);
  });

  it("falls back to relPath id on stem collision", () => {
    const one = entry({ relPath: "notes/same.md" });
    const two = entry({ relPath: "ops/same.md" });
    const model = buildVaultGraph([one, two]);
    const ids = model.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("same");
    expect(ids).toContain("ops/same");
  });
});

describe("enrichGraph", () => {
  const file: VaultGraphFile = {
    nodes: [
      { id: "a-note", community: 4 },
      { id: "renamed-elsewhere", community: 7, source_file: "notes/b-note.md" },
      { id: "projects", community: null }, // hub — excluded from clustering
    ],
    edges: [],
  };

  it("copies community by id, falls back to source_file stem, leaves unmatched null", () => {
    const model = buildVaultGraph([A, B, MOC]);
    const enriched = enrichGraph(model, file);
    expect(enriched.enriched).toBe(true);
    expect(enriched.nodes.find((n) => n.id === "a-note")!.community).toBe(4);
    // b-note matched via source_file fallback
    expect(enriched.nodes.find((n) => n.id === "b-note")!.community).toBe(7);
    // moc had null community in the file → stays null
    expect(enriched.nodes.find((n) => n.id === "projects")!.community).toBeNull();
    // ghost never matches
    expect(enriched.nodes.find((n) => n.id === "missing-target")!.community).toBeNull();
  });

  it("does not mutate the input model", () => {
    const model = buildVaultGraph([A, B, MOC]);
    enrichGraph(model, file);
    expect(model.enriched).toBe(false);
    expect(model.nodes.find((n) => n.id === "a-note")!.community).toBeNull();
  });
});

describe("focusSubgraph / buildAdjacency", () => {
  it("keeps k-hop neighborhood only", () => {
    const c = entry({ relPath: "notes/c-note.md", links: ["b-note"] });
    const d = entry({ relPath: "notes/d-note.md", links: ["c-note"] });
    const far = entry({ relPath: "notes/far.md" });
    const model = buildVaultGraph([A, B, MOC, c, d, far]);
    const sub = focusSubgraph(model, "a-note", 2);
    const ids = new Set(sub.nodes.map((n) => n.id));
    expect(ids.has("a-note")).toBe(true);
    expect(ids.has("b-note")).toBe(true); // 1 hop
    expect(ids.has("far")).toBe(false); // disconnected
    const adjacency = buildAdjacency(model);
    expect(adjacency.get("a-note")).toContain("b-note");
  });
});
