import { describe, expect, it } from "vitest";

import { computeSmartGuides } from "./smartGuides";

describe("smartGuides", () => {
  it("returns no guides when stationary is empty", () => {
    const r = computeSmartGuides({
      movingRect: { x: 0, y: 0, w: 100, h: 50 },
      stationary: [],
      threshold: 8,
    });
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([]);
  });

  it("snaps left-edge to another node's left-edge within threshold", () => {
    const r = computeSmartGuides({
      movingRect: { x: 5, y: 100, w: 100, h: 50 },
      stationary: [{ x: 0, y: 200, w: 80, h: 40 }],
      threshold: 8,
    });
    expect(r.dx).toBe(-5);
    expect(r.guides[0]?.orientation).toBe("v");
    expect(r.guides[0]?.pos).toBe(0);
  });

  it("snaps horizontal center to another node center", () => {
    const r = computeSmartGuides({
      movingRect: { x: 0, y: 92, w: 100, h: 50 }, // centerY = 117
      stationary: [{ x: 200, y: 100, w: 60, h: 30 }], // centerY = 115
      threshold: 5,
    });
    expect(r.dy).toBe(-2);
    expect(r.guides.find((g) => g.orientation === "h")?.pos).toBe(115);
  });

  it("ignores candidates outside the threshold", () => {
    const r = computeSmartGuides({
      movingRect: { x: 0, y: 0, w: 100, h: 50 },
      stationary: [{ x: 500, y: 500, w: 100, h: 50 }],
      threshold: 8,
    });
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([]);
  });

  it("picks the closest candidate when multiple alignments are within threshold", () => {
    const r = computeSmartGuides({
      movingRect: { x: 3, y: 0, w: 100, h: 50 },
      stationary: [
        { x: 0, y: 200, w: 100, h: 50 },
        { x: 6, y: 300, w: 100, h: 50 },
      ],
      threshold: 8,
    });
    expect(r.dx).toBe(-3);
  });
});
