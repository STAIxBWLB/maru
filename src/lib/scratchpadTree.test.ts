import { describe, expect, it } from "vitest";
import type { ScratchpadEntry } from "./types";
import {
  buildScratchpadFolderTree,
  filterScratchpadFolderEntries,
  scratchpadFolderAncestors,
  scratchpadVirtualPath,
} from "./scratchpadTree";

function entry(
  collection: "memos" | "temp",
  relativePath: string,
  patch: Partial<ScratchpadEntry> = {},
): ScratchpadEntry {
  return {
    collection,
    relativePath,
    name: relativePath.split("/").at(-1) ?? relativePath,
    source: collection === "temp" ? "codex" : "maru",
    format: relativePath.endsWith(".txt") ? "plain" : "markdown",
    updatedAt: "2026-08-22T00:00:00Z",
    sizeBytes: 10,
    preview: relativePath,
    revision: relativePath,
    stale: false,
    editable: true,
    ...patch,
  };
}

const entries = [
  entry("memos", "daily.md"),
  entry("memos", "projects/maru/notes.md"),
  entry("memos", "projects/other.md"),
  entry("temp", "codex/run/result.md", { stale: true }),
  entry("temp", "kimi/output.txt"),
];

describe("scratchpadTree", () => {
  it("builds collection roots and nested virtual folders with recursive counts", () => {
    const tree = buildScratchpadFolderTree(entries);
    expect(tree.fileCount).toBe(5);
    expect(tree.staleCount).toBe(1);
    expect(tree.children.map((node) => node.id)).toEqual(["memos", "temp"]);
    const memos = tree.children[0];
    expect(memos.fileCount).toBe(3);
    expect(memos.children[0].id).toBe("memos/projects");
    expect(memos.children[0].children[0].id).toBe("memos/projects/maru");
    const temp = tree.children[1];
    expect(temp.staleCount).toBe(1);
  });

  it("keeps every file at the root and lists direct children inside a folder", () => {
    expect(filterScratchpadFolderEntries(entries, "", "")).toHaveLength(5);
    expect(
      filterScratchpadFolderEntries(entries, "memos/projects", "").map(
        (item) => item.relativePath,
      ),
    ).toEqual(["projects/other.md"]);
    expect(
      filterScratchpadFolderEntries(entries, "memos/projects/maru", "").map(
        (item) => item.relativePath,
      ),
    ).toEqual(["projects/maru/notes.md"]);
  });

  it("searches descendants within the selected folder", () => {
    expect(
      filterScratchpadFolderEntries(entries, "memos/projects", "notes").map(
        (item) => item.relativePath,
      ),
    ).toEqual(["projects/maru/notes.md"]);
    expect(filterScratchpadFolderEntries(entries, "temp/codex", "daily")).toEqual([]);
  });

  it("builds stable virtual paths and folder ancestor chains", () => {
    expect(scratchpadVirtualPath(entries[1])).toBe("memos/projects/maru/notes.md");
    expect(scratchpadFolderAncestors("temp/codex/run")).toEqual([
      "temp",
      "temp/codex",
      "temp/codex/run",
    ]);
  });
});
