import { describe, expect, it } from "vitest";
import type { VaultEntry } from "./types";
import {
  MAX_DRAFT_GRAPH_RELATIONS,
  resolveDraftGraphRelationEntries,
  resolveDraftGraphRelations,
} from "./draftGraphRelations";

function entry(
  relPath: string,
  title = relPath,
  links: string[] = [],
): VaultEntry {
  return {
    path: `/workspace/${relPath}`,
    relPath,
    title,
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "md",
    versionCount: 0,
    links,
  };
}

describe("resolveDraftGraphRelations", () => {
  it("resolves provenance, promotion, and body wikilinks without adding draft nodes", () => {
    const entries = [
      entry("origin.md", "Origin"),
      entry("promoted.md", "Promoted"),
      entry("body.md", "Body link"),
    ];

    const relations = resolveDraftGraphRelations(
      entries,
      ["origin.md"],
      "promoted.md",
      "Draft text [[body]] [[missing]].",
    );

    expect(relations.map((relation) => relation.entry.relPath).sort()).toEqual([
      "body.md",
      "origin.md",
      "promoted.md",
    ]);
  });

  it("deduplicates, sorts by graph degree, and caps the result at eight", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry(`note-${index}.md`, `Note ${index}`, [
        ...Array.from({ length: index }, (_, neighbor) => `note-${neighbor}.md`),
      ]),
    );

    const relations = resolveDraftGraphRelations(
      entries,
      entries.map((candidate) => candidate.relPath),
      entries[0].relPath,
    );

    expect(relations).toHaveLength(MAX_DRAFT_GRAPH_RELATIONS);
    expect(relations[0].degree).toBeGreaterThanOrEqual(relations.at(-1)?.degree ?? 0);
    expect(new Set(relations.map((relation) => relation.entry.relPath)).size).toBe(
      MAX_DRAFT_GRAPH_RELATIONS,
    );

    const allRelations = resolveDraftGraphRelationEntries(
      entries,
      entries.map((candidate) => candidate.relPath),
      entries[0].relPath,
    );
    expect(allRelations).toHaveLength(entries.length);
    expect(allRelations.map((relation) => relation.entry.relPath)).toContain("note-9.md");
  });

  it("returns no relations for an empty workspace", () => {
    expect(resolveDraftGraphRelations([], ["origin.md"], "promoted.md", "[[body]]")).toEqual([]);
  });
});
