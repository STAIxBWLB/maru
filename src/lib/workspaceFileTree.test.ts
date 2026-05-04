import { describe, expect, it } from "vitest";
import {
  buildWorkspaceFileTreeRows,
  collectWorkspaceFileFolderPaths,
  filterWorkspaceFiles,
  virtualizeWorkspaceFileTreeRows,
} from "./workspaceFileTree";
import type { WorkspaceFileEntry } from "./types";

function file(relPath: string, extras: Partial<WorkspaceFileEntry> = {}): WorkspaceFileEntry {
  const name = relPath.split("/").pop() ?? relPath;
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? null : null;
  return {
    path: `/workspace/${relPath}`,
    relPath,
    name,
    extension,
    fileKind: extension ?? "file",
    sizeBytes: 10,
    updatedAt: null,
    gitTracked: false,
    binary: false,
    ...extras,
  };
}

describe("workspace file tree", () => {
  it("filters all, tracked, and binary include-pattern files", () => {
    const entries = [
      file("docs/a.md", { gitTracked: true }),
      file("attachments/report.pdf"),
      file("exports/PAGE.HTML"),
      file("tmp/raw.bin", { binary: true, gitTracked: true }),
    ];

    expect(filterWorkspaceFiles(entries, "", "all").map((entry) => entry.relPath)).toEqual([
      "docs/a.md",
      "attachments/report.pdf",
      "exports/PAGE.HTML",
      "tmp/raw.bin",
    ]);
    expect(filterWorkspaceFiles(entries, "", "tracked").map((entry) => entry.relPath)).toEqual([
      "docs/a.md",
      "tmp/raw.bin",
    ]);
    expect(filterWorkspaceFiles(entries, "", "binary").map((entry) => entry.relPath)).toEqual([
      "attachments/report.pdf",
      "exports/PAGE.HTML",
    ]);
    expect(
      filterWorkspaceFiles(entries, "", "binary", ["tmp/*.bin"]).map((entry) => entry.relPath),
    ).toEqual(["tmp/raw.bin"]);
  });

  it("collapses folders by default", () => {
    const rows = buildWorkspaceFileTreeRows(
      [file("z.md"), file("docs/b.md"), file("docs/a.md")],
      [],
    );

    expect(rows.map((row) => (row.kind === "folder" ? row.path : row.entry.relPath))).toEqual([
      "docs",
      "z.md",
    ]);
    expect(rows[0]).toMatchObject({ kind: "folder", count: 2, collapsed: true });
  });

  it("keeps only explicitly expanded folders open", () => {
    const rows = buildWorkspaceFileTreeRows(
      [file("z.md"), file("docs/b.md"), file("docs/a.md")],
      ["docs"],
    );

    expect(rows.map((row) => (row.kind === "folder" ? row.path : row.entry.relPath))).toEqual([
      "docs",
      "docs/a.md",
      "docs/b.md",
      "z.md",
    ]);
    expect(rows[0]).toMatchObject({ kind: "folder", count: 2, collapsed: false });
  });

  it("collects folder paths and virtualizes visible rows", () => {
    const entries = [file("a/b/c.md"), file("a/d/e.md"), file("root.md")];
    expect(collectWorkspaceFileFolderPaths(entries)).toEqual(["a", "a/b", "a/d"]);
    const rows = buildWorkspaceFileTreeRows(entries, ["a", "a/b", "a/d"], false);
    const layout = virtualizeWorkspaceFileTreeRows(rows, 30, 60, 0, 30);
    expect(layout.totalHeight).toBe(rows.length * 30);
    expect(layout.rows.map(({ top }) => top)).toEqual([30, 60, 90]);
  });
});
