import { describe, expect, it } from "vitest";
import {
  applyWorkspaceFilesPaneFilters,
  buildWorkspaceFileListRows,
  buildWorkspaceFileTreeRows,
  collectWorkspaceFileExtensionCounts,
  collectWorkspaceFileFolderPaths,
  EMPTY_WORKSPACE_FILES_PANE_FILTERS,
  expandWorkspaceFileAncestors,
  filterWorkspaceFiles,
  groupWorkspaceFilesByMtime,
  sortWorkspaceFiles,
  virtualizeWorkspaceFileListRows,
  virtualizeWorkspaceFileTreeRows,
  type WorkspaceFilesPaneFilters,
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

  it("expands every ancestor for a revealed workspace file", () => {
    expect(expandWorkspaceFileAncestors(["z"], "assets/reports/final.pdf")).toEqual([
      "assets",
      "assets/reports",
      "z",
    ]);
  });
});

describe("workspace file list view", () => {
  const ISO_DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 4, 27, 12, 0, 0); // 2026-05-27 12:00 UTC

  const today = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(now - 2 * ISO_DAY).toISOString();
  const lastMonth = new Date(now - 40 * ISO_DAY).toISOString();

  const entries: WorkspaceFileEntry[] = [
    file("docs/old.md", { updatedAt: lastMonth }),
    file("docs/today.md", { updatedAt: today }),
    file("docs/week.md", { updatedAt: yesterday }),
    file("notes/no-mtime.md", { updatedAt: null }),
  ];

  it("sorts by name (default)", () => {
    const sorted = sortWorkspaceFiles(entries, "name");
    expect(sorted.map((entry) => entry.relPath)).toEqual([
      "docs/old.md",
      "docs/today.md",
      "docs/week.md",
      "notes/no-mtime.md",
    ]);
  });

  it("sorts by modifiedDesc with missing mtime last", () => {
    const sorted = sortWorkspaceFiles(entries, "modifiedDesc");
    expect(sorted.map((entry) => entry.relPath)).toEqual([
      "docs/today.md",
      "docs/week.md",
      "docs/old.md",
      "notes/no-mtime.md",
    ]);
  });

  it("sorts by modifiedAsc with missing mtime first (treated as epoch 0)", () => {
    const sorted = sortWorkspaceFiles(entries, "modifiedAsc");
    expect(sorted.map((entry) => entry.relPath)).toEqual([
      "notes/no-mtime.md",
      "docs/old.md",
      "docs/week.md",
      "docs/today.md",
    ]);
  });

  it("groups by mtime buckets (Today / This week / Earlier)", () => {
    const buckets = groupWorkspaceFilesByMtime(
      entries,
      { today: "Today", thisWeek: "This week", earlier: "Earlier" },
      now,
    );
    expect(buckets.map((bucket) => [bucket.label, bucket.items.length])).toEqual([
      ["Today", 1],
      ["This week", 1],
      ["Earlier", 2],
    ]);
  });

  it("builds list rows with group headers only when modified sort is active and grouping requested", () => {
    const rowsGrouped = buildWorkspaceFileListRows(entries, {
      sortKey: "modifiedDesc",
      grouped: true,
      bucketLabels: { today: "Today", thisWeek: "This week", earlier: "Earlier" },
      now,
    });
    const labels = rowsGrouped
      .filter((row) => row.kind === "group")
      .map((row) => (row.kind === "group" ? row.label : ""));
    expect(labels).toEqual(["Today", "This week", "Earlier"]);

    const flatNameRows = buildWorkspaceFileListRows(entries, {
      sortKey: "name",
      grouped: true,
      bucketLabels: { today: "Today", thisWeek: "This week", earlier: "Earlier" },
      now,
    });
    expect(flatNameRows.every((row) => row.kind === "file")).toBe(true);
  });

  it("applies pane filters by extension, modified window, size, and queuedOnly", () => {
    const sized: WorkspaceFileEntry[] = [
      file("a.md", { updatedAt: today, sizeBytes: 500 }),
      file("b.png", { updatedAt: yesterday, sizeBytes: 200_000 }),
      file("c.png", { updatedAt: lastMonth, sizeBytes: 30 * 1024 * 1024 }),
    ];
    const filters: WorkspaceFilesPaneFilters = {
      ...EMPTY_WORKSPACE_FILES_PANE_FILTERS,
      extensions: ["png"],
    };
    expect(
      applyWorkspaceFilesPaneFilters(sized, filters, now).map((entry) => entry.relPath),
    ).toEqual(["b.png", "c.png"]);

    const modifiedWithin = applyWorkspaceFilesPaneFilters(
      sized,
      { ...filters, modifiedWithinDays: 7 },
      now,
    );
    expect(modifiedWithin.map((entry) => entry.relPath)).toEqual(["b.png"]);

    const large = applyWorkspaceFilesPaneFilters(
      sized,
      { ...EMPTY_WORKSPACE_FILES_PANE_FILTERS, sizeBucket: "gte10m" },
      now,
    );
    expect(large.map((entry) => entry.relPath)).toEqual(["c.png"]);

    const queuedOnly = applyWorkspaceFilesPaneFilters(
      sized,
      {
        ...EMPTY_WORKSPACE_FILES_PANE_FILTERS,
        queuedOnly: true,
        queuedPaths: ["/workspace/b.png"],
      },
      now,
    );
    expect(queuedOnly.map((entry) => entry.relPath)).toEqual(["b.png"]);
  });

  it("collects extension counts sorted by frequency", () => {
    const counts = collectWorkspaceFileExtensionCounts([
      file("a.md"),
      file("b.md"),
      file("c.png"),
      file("d.hwpx"),
      file("e.md"),
    ]);
    expect(counts.slice(0, 3)).toEqual([
      { extension: "md", count: 3 },
      { extension: "hwpx", count: 1 },
      { extension: "png", count: 1 },
    ]);
  });

  it("virtualizes file list rows with mixed group/file heights", () => {
    const rows = buildWorkspaceFileListRows(entries, {
      sortKey: "modifiedDesc",
      grouped: true,
      bucketLabels: { today: "Today", thisWeek: "This week", earlier: "Earlier" },
      now,
    });
    const layout = virtualizeWorkspaceFileListRows(rows, 0, 200, 0, 34, 24);
    const expectedTotal = rows.reduce(
      (sum, row) => sum + (row.kind === "group" ? 24 : 34),
      0,
    );
    expect(layout.totalHeight).toBe(expectedTotal);
    expect(layout.rows.length).toBeGreaterThan(0);
  });
});
