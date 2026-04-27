import { describe, expect, it } from "vitest";
import type { VaultEntry } from "./types";
import {
  buildEntryIndex,
  resolveTargetIndexed,
  resolveWikilinkTarget,
  suggestWikilinkTargets,
} from "./wikilinkSuggestions";

function entry(overrides: Partial<VaultEntry>): VaultEntry {
  return {
    path: `/vault/${overrides.relPath ?? "note.md"}`,
    relPath: "note.md",
    title: "Untitled",
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "md",
    versionCount: 0,
    ...overrides,
  };
}

describe("suggestWikilinkTargets", () => {
  it("ranks title prefix before title contains before path contains", () => {
    const entries = [
      entry({ relPath: "projects/project-alpha.md", title: "Project Alpha" }),
      entry({ relPath: "meetings/alpha-review.md", title: "Alpha Review" }),
      entry({ relPath: "references/alpha-archive.md", title: "Reference" }),
    ];

    const suggestions = suggestWikilinkTargets(entries, "alpha");

    expect(suggestions.map((item) => item.target)).toEqual([
      "meetings/alpha-review",
      "projects/project-alpha",
      "references/alpha-archive",
    ]);
  });

  it("disambiguates duplicate display titles with the parent folder", () => {
    const entries = [
      entry({ relPath: "people/status.md", title: "Status" }),
      entry({ relPath: "projects/status.md", title: "Status" }),
    ];

    expect(suggestWikilinkTargets(entries, "status").map((item) => item.title)).toEqual([
      "Status (people)",
      "Status (projects)",
    ]);
  });
});

describe("resolveWikilinkTarget", () => {
  it("resolves by title, filename, rel path, rel path without extension, and suffix", () => {
    const entries = [
      entry({ relPath: "projects/alpha.md", title: "Project Alpha" }),
      entry({ relPath: "archive/people/lee.md", title: "Lee" }),
    ];
    const idx = buildEntryIndex(entries);

    expect(resolveTargetIndexed(idx, entries, "Project Alpha")?.relPath).toBe(
      "projects/alpha.md",
    );
    expect(resolveTargetIndexed(idx, entries, "lee")?.relPath).toBe(
      "archive/people/lee.md",
    );
    expect(resolveTargetIndexed(idx, entries, "projects/alpha.md")?.title).toBe(
      "Project Alpha",
    );
    expect(resolveTargetIndexed(idx, entries, "projects/alpha")?.title).toBe(
      "Project Alpha",
    );
    expect(resolveWikilinkTarget(entries, "people/lee")?.title).toBe("Lee");
  });

  it("returns null for empty or unresolved targets", () => {
    const entries = [entry({ relPath: "projects/alpha.md", title: "Project Alpha" })];
    const idx = buildEntryIndex(entries);

    expect(resolveTargetIndexed(idx, entries, "   ")).toBeNull();
    expect(resolveWikilinkTarget(entries, "Missing")).toBeNull();
  });
});
