import { describe, expect, it } from "vitest";
import { moveForInsertion, sameOrder } from "./pointerReorder";

describe("pointer reorder helpers", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves before and after the hovered row", () => {
    expect(moveForInsertion(ids, 0, 2, "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveForInsertion(ids, 3, 1, "before")).toEqual(["a", "d", "b", "c"]);
  });

  it("keeps invalid insertions unchanged and compares identity order", () => {
    expect(moveForInsertion(ids, -1, 2, "after")).toEqual(ids);
    expect(sameOrder(ids, [...ids], (id) => id)).toBe(true);
    expect(sameOrder(ids, ["b", "a", "c", "d"], (id) => id)).toBe(false);
  });
});
