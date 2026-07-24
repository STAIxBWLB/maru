import { describe, expect, it } from "vitest";
import type { WorkspaceEntryNode } from "./types";
import {
  buildFilesDirectoryTree,
  collapseNestedPaths,
  filesBreadcrumbs,
  listFilesDirectoryContents,
  parentFolderRelPath,
} from "./filesWorkbench";

function entry(
  relPath: string,
  kind: WorkspaceEntryNode["kind"],
  overrides: Partial<WorkspaceEntryNode> = {},
): WorkspaceEntryNode {
  const parts = relPath.split("/");
  const name = parts.at(-1) ?? relPath;
  return {
    kind,
    targetKind: kind === "symlink" ? "file" : null,
    path: `/workspace/${relPath}`,
    relPath,
    parentRelPath: parts.slice(0, -1).join("/"),
    name,
    extension: kind === "file" ? name.split(".").at(1) ?? null : null,
    fileKind: kind === "directory" ? "folder" : "text",
    sizeBytes: kind === "directory" ? 0 : 10,
    updatedAt: "2026-07-24T01:00:00Z",
    gitTracked: false,
    binary: false,
    ...overrides,
  };
}

describe("Files workbench navigation", () => {
  const entries = [
    entry("assets", "directory"),
    entry("assets/empty", "directory"),
    entry("assets/icons", "symlink", { targetKind: "directory" }),
    entry("assets/logo.png", "file", { binary: true }),
    entry("docs", "directory"),
    entry("docs/guide.md", "file", { gitTracked: true }),
    entry("readme.md", "file", { gitTracked: true }),
  ];

  it("keeps empty directories in the tree but leaves symlinked directories out", () => {
    const tree = buildFilesDirectoryTree(entries, "Workspace");

    expect(tree.children.map((node) => node.relPath)).toEqual(["assets", "docs"]);
    expect(tree.children[0].children.map((node) => node.relPath)).toEqual([
      "assets/empty",
    ]);
  });

  it("lists direct children normally and searches descendants within the current folder", () => {
    expect(
      listFilesDirectoryContents(entries, "assets", "", "all", "name").map(
        (node) => node.relPath,
      ),
    ).toEqual(["assets/empty", "assets/icons", "assets/logo.png"]);

    expect(
      listFilesDirectoryContents(entries, "assets", "logo", "all", "name").map(
        (node) => node.relPath,
      ),
    ).toEqual(["assets/logo.png"]);
    expect(
      listFilesDirectoryContents(entries, "docs", "logo", "all", "name"),
    ).toEqual([]);
  });

  it("keeps folders before files while applying file filters", () => {
    expect(
      listFilesDirectoryContents(entries, "", "", "tracked", "name").map(
        (node) => node.relPath,
      ),
    ).toEqual(["readme.md"]);
    expect(
      listFilesDirectoryContents(entries, "assets", "", "binary", "name").map(
        (node) => node.relPath,
      ),
    ).toEqual(["assets/logo.png"]);
  });

  it("builds stable breadcrumbs and parent navigation", () => {
    expect(filesBreadcrumbs("/assets/icons/", "Workspace")).toEqual([
      { relPath: "", label: "Workspace" },
      { relPath: "assets", label: "assets" },
      { relPath: "assets/icons", label: "icons" },
    ]);
    expect(parentFolderRelPath("assets/icons")).toBe("assets");
    expect(parentFolderRelPath("assets")).toBe("");
  });

  it("collapses nested selections before filesystem mutations", () => {
    expect(
      collapseNestedPaths([
        "/workspace/assets/logo.png",
        "/workspace/assets",
        "/workspace/readme.md",
        "/workspace/assets",
      ]),
    ).toEqual(["/workspace/assets", "/workspace/readme.md"]);
  });
});
