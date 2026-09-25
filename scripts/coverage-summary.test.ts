import { describe, expect, it } from "vitest";

describe("summarizeCoverage", () => {
  it("renders the TypeScript row with recomputed percentages", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const table = summarizeCoverage({
      ts: {
        total: {
          lines: { total: 200, covered: 150 },
          functions: { total: 40, covered: 10 },
        },
      },
    });
    expect(table).toContain("| TypeScript (src + scripts) | 75.00% (150/200) | 25.00% (10/40) |");
  });

  it("starts with the Coverage totals heading and header row", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const table = summarizeCoverage({
      ts: {
        total: {
          lines: { total: 10, covered: 5 },
          functions: { total: 2, covered: 1 },
        },
      },
    });
    const lines = table.split("\n");
    expect(lines[0]).toBe("### Coverage totals");
    expect(lines[1]).toBe("| Scope | Lines | Functions |");
  });

  it("renders n/a for a zero denominator instead of dividing by zero", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const table = summarizeCoverage({
      ts: {
        total: {
          lines: { total: 0, covered: 0 },
          functions: { total: 0, covered: 0 },
        },
      },
    });
    expect(table).toContain("| TypeScript (src + scripts) | n/a (0/0) | n/a (0/0) |");
  });

  it("recomputes percentages from covered/total rather than trusting an input pct field", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const table = summarizeCoverage({
      ts: {
        total: {
          // @ts-expect-error -- deliberately wrong `pct` to prove it is ignored
          lines: { total: 4, covered: 1, pct: 999 },
          // @ts-expect-error -- deliberately wrong `pct` to prove it is ignored
          functions: { total: 4, covered: 1, pct: 999 },
        },
      },
    });
    expect(table).toContain("| TypeScript (src + scripts) | 25.00% (1/4) | 25.00% (1/4) |");
  });

  it("groups Rust files by crate and computes per-crate plus workspace totals", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const rust = {
      data: [
        {
          files: [
            {
              filename: "/w/src-tauri/src/a.rs",
              summary: { lines: { count: 10, covered: 5 }, functions: { count: 2, covered: 1 } },
            },
            {
              filename: "/w/src-tauri/maru-cli/src/main.rs",
              summary: { lines: { count: 4, covered: 0 }, functions: { count: 1, covered: 0 } },
            },
          ],
        },
      ],
    };
    const table = summarizeCoverage({ rust });
    expect(table).toContain("| Rust maru (src-tauri/src) | 50.00% (5/10) | 50.00% (1/2) |");
    expect(table).toContain("| Rust maru-cli (src-tauri/maru-cli) | 0.00% (0/4) | 0.00% (0/1) |");
    expect(table).toContain("| Rust workspace total | 35.71% (5/14) | 33.33% (1/3) |");
  });

  it("renders 'no files in report' for a crate with no files in the export instead of dropping the row", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const rust = {
      data: [
        {
          files: [
            {
              filename: "/w/src-tauri/src/a.rs",
              summary: { lines: { count: 10, covered: 5 }, functions: { count: 2, covered: 1 } },
            },
          ],
        },
      ],
    };
    const table = summarizeCoverage({ rust });
    expect(table).toContain("| Rust maru-cli (src-tauri/maru-cli) | no files in report | no files in report |");
  });

  it("groups Windows-style backslash separators the same way as forward slashes", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const rust = {
      data: [
        {
          files: [
            {
              filename: "C:\\w\\src-tauri\\maru-cli\\src\\main.rs",
              summary: { lines: { count: 4, covered: 4 }, functions: { count: 1, covered: 1 } },
            },
          ],
        },
      ],
    };
    const table = summarizeCoverage({ rust });
    expect(table).toContain("| Rust maru-cli (src-tauri/maru-cli) | 100.00% (4/4) | 100.00% (1/1) |");
  });

  it("counts a file outside both crate paths only toward the workspace total", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const rust = {
      data: [
        {
          files: [
            {
              filename: "/w/other/file.rs",
              summary: { lines: { count: 6, covered: 3 }, functions: { count: 1, covered: 1 } },
            },
          ],
        },
      ],
    };
    const table = summarizeCoverage({ rust });
    expect(table).toContain("| Rust maru (src-tauri/src) | no files in report | no files in report |");
    expect(table).toContain("| Rust maru-cli (src-tauri/maru-cli) | no files in report | no files in report |");
    expect(table).toContain("| Rust workspace total | 50.00% (3/6) | 100.00% (1/1) |");
  });

  it("keeps the TypeScript row first when both ts and rust are present", async () => {
    const { summarizeCoverage } = await import("./coverage-summary.mjs");
    const table = summarizeCoverage({
      ts: {
        total: {
          lines: { total: 10, covered: 5 },
          functions: { total: 2, covered: 1 },
        },
      },
      rust: { data: [{ files: [] }] },
    });
    const dataRows = table
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.startsWith("| Scope") && !line.startsWith("|---"));
    expect(dataRows[0]).toContain("TypeScript");
  });
});
