import { describe, expect, it } from "vitest";
import { labelAlpha } from "./graphLabels";

describe("labelAlpha", () => {
  it("hides labels on small rendered nodes", () => {
    expect(labelAlpha(0, false)).toBe(0);
    expect(labelAlpha(6, false)).toBe(0);
  });
  it("ramps linearly between fade bounds", () => {
    expect(labelAlpha(9, false)).toBeCloseTo(0.15, 5);
  });
  it("caps idle labels at low opacity", () => {
    expect(labelAlpha(12, false)).toBe(0.3);
    expect(labelAlpha(40, false)).toBe(0.3);
  });
  it("forced labels are always fully opaque", () => {
    expect(labelAlpha(0, true)).toBe(1);
  });
});
