import { describe, expect, it } from "vitest";
import { convexHull, hullPath, type Point } from "./hull";

describe("convexHull", () => {
  it("drops interior points, keeping the outer boundary", () => {
    const pts: Point[] = [
      [0, 0], [4, 0], [4, 4], [0, 4],
      [2, 2], // interior
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    expect(hull.some(([x, y]) => x === 2 && y === 2)).toBe(false);
  });

  it("returns the input unchanged for fewer than 3 points", () => {
    expect(convexHull([[1, 1], [2, 2]])).toEqual([[1, 1], [2, 2]]);
  });

  it("does not collapse a collinear set to a degenerate loop", () => {
    // All collinear → no real hull; must not return <3 phantom vertices.
    const hull = convexHull([[0, 0], [1, 0], [2, 0]]);
    expect(hull.length).toBeGreaterThanOrEqual(3);
  });
});

describe("hullPath", () => {
  it("emits a closed path for a polygon", () => {
    const d = hullPath([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
    expect(d).toContain(" L ");
  });

  it("falls back to a circle for 1-2 points", () => {
    const d = hullPath([[5, 5]]);
    expect(d).toContain("a "); // SVG arc commands
    expect(d.endsWith("Z")).toBe(true);
  });

  it("returns an empty string for no points", () => {
    expect(hullPath([])).toBe("");
  });
});
