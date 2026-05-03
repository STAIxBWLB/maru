import { describe, expect, it } from "vitest";
import { filterEntries } from "./document";
import {
  buildDocumentIndex,
  filterDocumentIndex,
  getCommandPaletteDocs,
  getRecentEntries,
} from "./documentIndex";
import type { VaultEntry } from "./types";

function entry(relPath: string, patch: Partial<VaultEntry> = {}): VaultEntry {
  return {
    path: `/vault/${relPath}`,
    relPath,
    title: relPath.split("/").pop()?.replace(/\.(md|html)$/i, "") ?? relPath,
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: relPath.endsWith(".html") ? "html" : "md",
    versionCount: 0,
    ...patch,
  };
}

describe("document index", () => {
  it("matches legacy free-text search results", () => {
    const entries = [
      entry("projects/rise/plan.md", {
        title: "RISE Plan",
        frontmatter: { type: "project", status: "active", tags: ["grant", "2026"] },
        snippet: "annual operating plan",
      }),
      entry("meetings/weekly.md", {
        title: "Weekly Meeting",
        frontmatter: { type: "meeting", important: true },
        snippet: "action items",
      }),
      entry("people/yj.md", {
        title: "Young Joon",
        frontmatter: { type: "person", score: 7 },
        snippet: "profile",
      }),
    ];
    const index = buildDocumentIndex(entries);

    for (const query of ["rise", "grant", "true", "7", "action", "people/yj"]) {
      expect(filterDocumentIndex(index, query, null)).toEqual(filterEntries(entries, query));
    }
  });

  it("caches type counts while excluding operational folders", () => {
    const index = buildDocumentIndex([
      entry("a.md", { frontmatter: { type: "meeting" } }),
      entry("b.md", { frontmatter: { type: "meeting" } }),
      entry("c.md", { frontmatter: { type: "project" } }),
      entry("d.md"),
      entry("_sys/generated.md", { frontmatter: { type: "meeting" } }),
      entry(".anchor/settings.md"),
    ]);

    expect(index.contentCount).toBe(4);
    expect(index.typeCounts).toEqual([
      ["meeting", 2],
      ["project", 1],
      ["_", 1],
    ]);
  });

  it("filters by type and resolves recent and palette docs from cached maps", () => {
    const entries = [
      entry("a.md", { title: "Alpha", frontmatter: { type: "meeting" } }),
      entry("b.md", { title: "Beta", frontmatter: { type: "project" } }),
      entry("c.md", { title: "Gamma" }),
    ];
    const index = buildDocumentIndex(entries);

    expect(filterDocumentIndex(index, "", "meeting")).toEqual([entries[0]]);
    expect(filterDocumentIndex(index, "", "_")).toEqual([entries[2]]);
    expect(getRecentEntries(index, [entries[1].path, "/missing", entries[0].path], 2)).toEqual([
      entries[1],
      entries[0],
    ]);
    expect(getCommandPaletteDocs(index, "", 2)).toEqual(entries.slice(0, 2));
    expect(getCommandPaletteDocs(index, "gamma", 12)).toEqual([entries[2]]);
  });
});
