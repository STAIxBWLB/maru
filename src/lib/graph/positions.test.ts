import { describe, expect, it } from "vitest";
import {
  isFinitePositions,
  isUsableCoordinate,
  sanitizePositions,
} from "./positions";

describe("isUsableCoordinate", () => {
  it("accepts finite numbers within the sanity bound", () => {
    expect(isUsableCoordinate(0)).toBe(true);
    expect(isUsableCoordinate(-123.456)).toBe(true);
    expect(isUsableCoordinate(1e6)).toBe(true);
  });

  it("rejects non-finite, non-number, and out-of-bounds values", () => {
    expect(isUsableCoordinate(NaN)).toBe(false);
    expect(isUsableCoordinate(Infinity)).toBe(false);
    expect(isUsableCoordinate(-Infinity)).toBe(false);
    expect(isUsableCoordinate(1e6 + 1)).toBe(false);
    expect(isUsableCoordinate(-2e6)).toBe(false);
    expect(isUsableCoordinate("12")).toBe(false);
    expect(isUsableCoordinate(undefined)).toBe(false);
    expect(isUsableCoordinate(null)).toBe(false);
  });
});

describe("isFinitePositions", () => {
  it("accepts an all-finite buffer", () => {
    expect(isFinitePositions(new Float64Array([0, 1.5, -2e5]))).toBe(true);
    expect(isFinitePositions(new Float64Array(0))).toBe(true);
  });

  it("rejects a buffer containing any non-finite value", () => {
    expect(isFinitePositions(new Float64Array([1, NaN, 2]))).toBe(false);
    expect(isFinitePositions(new Float64Array([Infinity]))).toBe(false);
  });
});

describe("sanitizePositions", () => {
  it("keeps valid entries and drops corrupt ones", () => {
    const clean = sanitizePositions({
      good: [10, -20],
      nan: [NaN, 0],
      inf: [0, Infinity],
      huge: [2e6, 0],
      wrongType: ["1", 2] as unknown as [number, number],
      notArray: "oops" as unknown as [number, number],
    });
    expect(clean).toEqual({ good: [10, -20] });
  });

  it("does not mutate the input record", () => {
    const input = { a: [1, 2] as [number, number], b: [NaN, 0] as [number, number] };
    sanitizePositions(input);
    expect(Object.keys(input)).toEqual(["a", "b"]);
  });
});
