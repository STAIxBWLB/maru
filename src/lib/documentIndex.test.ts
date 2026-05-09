import { describe, expect, it } from "vitest";
import { filterEntries } from "./document";
import {
  ALL_DOCUMENTS_FILTER,
  buildDocumentIndex,
  countDocumentFilter,
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
      expect(filterDocumentIndex(index, query, ALL_DOCUMENTS_FILTER)).toEqual(
        filterEntries(entries, query),
      );
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

    expect(filterDocumentIndex(index, "", { kind: "type", type: "meeting" })).toEqual([
      entries[0],
    ]);
    expect(filterDocumentIndex(index, "", { kind: "untyped" })).toEqual([entries[2]]);
    expect(getRecentEntries(index, [entries[1].path, "/missing", entries[0].path], 2)).toEqual([
      entries[1],
      entries[0],
    ]);
    expect(getCommandPaletteDocs(index, "", 2)).toEqual(entries.slice(0, 2));
    expect(getCommandPaletteDocs(index, "gamma", 12)).toEqual([entries[2]]);
  });

  it("filters built-in document views", () => {
    const now = new Date("2026-05-09T00:00:00Z");
    const entries = [
      entry("inbox/dropped.md", { frontmatter: { type: "memo" } }),
      entry("plans/draft.md", { frontmatter: { status: "draft" } }),
      entry("archive/old.md"),
      entry("projects/archived.md", { frontmatter: { status: "archived" } }),
      entry("recent.md", { updatedAt: "2026-05-07T00:00:00Z" }),
      entry("stale.md", { updatedAt: "2026-04-01T00:00:00Z" }),
    ];
    const index = buildDocumentIndex(entries);

    expect(filterDocumentIndex(index, "", { kind: "view", view: "inbox" })).toEqual([
      entries[0],
    ]);
    expect(filterDocumentIndex(index, "", { kind: "view", view: "drafts" })).toEqual([
      entries[1],
    ]);
    expect(filterDocumentIndex(index, "", { kind: "view", view: "archive" })).toEqual([
      entries[2],
      entries[3],
    ]);
    expect(
      filterDocumentIndex(index, "", { kind: "view", view: "recentlyUpdated" }, { now }),
    ).toEqual([entries[4]]);
  });

  it("filters and counts custom document views with AND criteria", () => {
    const entries = [
      entry("projects/rise/plan.md", {
        title: "RISE Plan",
        frontmatter: { type: "project", status: "active" },
        snippet: "grant plan",
      }),
      entry("projects/rise/draft.md", {
        title: "RISE Draft",
        frontmatter: { type: "project", status: "draft" },
        snippet: "grant plan",
      }),
      entry("projects/other/plan.md", {
        title: "Other Plan",
        frontmatter: { type: "project", status: "active" },
        snippet: "grant plan",
      }),
    ];
    const index = buildDocumentIndex(entries);
    const customViews = [
      {
        id: "rise-active",
        label: "RISE Active",
        color: "#884477",
        type: "project",
        status: "active",
        pathPrefix: "projects/rise",
        query: "grant",
      },
    ];
    const filter = { kind: "custom" as const, viewId: "rise-active" };

    expect(filterDocumentIndex(index, "", filter, { customViews })).toEqual([entries[0]]);
    expect(countDocumentFilter(index, filter, { customViews })).toBe(1);
  });
});
