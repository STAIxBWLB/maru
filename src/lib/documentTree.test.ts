import { describe, expect, it } from "vitest";
import {
  buildDocumentTreeRows,
  collectDocumentTreeFolderPaths,
  expandDocumentAncestors,
  nextCollapsedFolders,
  virtualizeDocumentTreeRows,
} from "./documentTree";
import type { VaultEntry } from "./types";

function entry(relPath: string, title = relPath): VaultEntry {
  return {
    path: `/vault/${relPath}`,
    relPath,
    title,
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "md",
    versionCount: 0,
  };
}

describe("buildDocumentTreeRows", () => {
  it("sorts folders before files and then by path", () => {
    const rows = buildDocumentTreeRows(
      [
        entry("zeta.md"),
        entry("meetings/b.md"),
        entry("admin/a.md"),
        entry("alpha.md"),
      ],
      ["admin", "meetings"],
    );

    expect(rows.map((row) => (row.kind === "folder" ? row.path : row.entry.relPath))).toEqual([
      "admin",
      "admin/a.md",
      "meetings",
      "meetings/b.md",
      "alpha.md",
      "zeta.md",
    ]);
  });

  it("hides descendant entries below collapsed folders", () => {
    const rows = buildDocumentTreeRows([
      entry("projects/rise/plan.md"),
      entry("projects/rise/report.md"),
    ], []);

    expect(rows.map((row) => (row.kind === "folder" ? row.path : row.entry.relPath))).toEqual([
      "projects",
    ]);
  });

  it("force-expands collapsed folders during search or filtering", () => {
    const rows = buildDocumentTreeRows([entry("projects/rise/plan.md")], [], true);

    expect(rows.map((row) => (row.kind === "folder" ? row.path : row.entry.relPath))).toEqual([
      "projects",
      "projects/rise",
      "projects/rise/plan.md",
    ]);
  });
});

describe("nextCollapsedFolders", () => {
  it("tracks expanded folder paths deterministically", () => {
    expect(nextCollapsedFolders(["z"], "a", false)).toEqual(["a", "z"]);
    expect(nextCollapsedFolders(["a", "z"], "a", true)).toEqual(["z"]);
  });
});

describe("collectDocumentTreeFolderPaths", () => {
  it("collects all nested folder paths in sorted order", () => {
    expect(
      collectDocumentTreeFolderPaths([
        entry("projects/rise/plan.md"),
        entry("admin/a.md"),
        entry("projects/maru/readme.md"),
        entry("root.md"),
      ]),
    ).toEqual(["admin", "projects", "projects/maru", "projects/rise"]);
  });
});

describe("expandDocumentAncestors", () => {
  it("adds every ancestor folder while preserving existing expanded folders", () => {
    expect(expandDocumentAncestors(["z"], "projects/rise/reports/final.md")).toEqual([
      "projects",
      "projects/rise",
      "projects/rise/reports",
      "z",
    ]);
  });
});

describe("virtualizeDocumentTreeRows", () => {
  it("returns only rows in the visible window plus overscan", () => {
    const rows = buildDocumentTreeRows(
      Array.from({ length: 20 }, (_, index) => entry(`folder/doc-${index}.md`)),
      ["folder"],
    );
    const layout = virtualizeDocumentTreeRows(rows, 120, 60, 30, 30);

    expect(layout.totalHeight).toBe(rows.length * 30);
    expect(layout.rows[0].top).toBe(90);
    expect(layout.rows.at(-1)?.top).toBe(210);
    expect(layout.rows.map(({ row }) => row.id)).toEqual(
      rows.slice(3, 8).map((row) => row.id),
    );
  });
});

describe("buildDocumentTreeRows sort key", () => {
  function dated(relPath: string, updatedAt: string | null): VaultEntry {
    return { ...entry(relPath), updatedAt };
  }

  it("orders leaf entries by modified time while folders stay alphabetical", () => {
    const entries = [
      dated("b/old.md", "2026-01-01T00:00:00Z"),
      dated("b/new.md", "2026-06-01T00:00:00Z"),
      dated("a/mid.md", "2026-03-01T00:00:00Z"),
    ];

    const desc = buildDocumentTreeRows(entries, ["a", "b"], false, "modifiedDesc");
    expect(desc.map((row) => row.id)).toEqual([
      "folder:a",
      "entry:/vault/a/mid.md",
      "folder:b",
      "entry:/vault/b/new.md",
      "entry:/vault/b/old.md",
    ]);

    const asc = buildDocumentTreeRows(entries, ["a", "b"], false, "modifiedAsc");
    expect(asc.map((row) => row.id)).toEqual([
      "folder:a",
      "entry:/vault/a/mid.md",
      "folder:b",
      "entry:/vault/b/old.md",
      "entry:/vault/b/new.md",
    ]);
  });

  it("falls back to path order for entries without a timestamp", () => {
    const rows = buildDocumentTreeRows(
      [dated("z.md", null), dated("a.md", null)],
      [],
      false,
      "modifiedDesc",
    );
    expect(rows.map((row) => row.id)).toEqual(["entry:/vault/a.md", "entry:/vault/z.md"]);
  });
});
