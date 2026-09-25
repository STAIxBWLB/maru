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
});
