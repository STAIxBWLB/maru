import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "./menu";

describe("clampMenuPosition", () => {
  it("keeps an already visible menu position unchanged", () => {
    expect(
      clampMenuPosition(
        { x: 120, y: 160 },
        { width: 210, height: 180 },
        { width: 900, height: 700 },
      ),
    ).toEqual({ x: 120, y: 160 });
  });

  it("moves a menu back inside the right and bottom viewport edges", () => {
    expect(
      clampMenuPosition(
        { x: 760, y: 560 },
        { width: 210, height: 180 },
        { width: 900, height: 700 },
      ),
    ).toEqual({ x: 682, y: 512 });
  });

  it("keeps the menu reachable when it is wider or taller than the viewport", () => {
    expect(
      clampMenuPosition(
        { x: -20, y: -10 },
        { width: 500, height: 500 },
        { width: 320, height: 240 },
      ),
    ).toEqual({ x: 8, y: 8 });
  });
});
