import { describe, expect, it } from "vitest";
import { formatElapsed, latestActivityLine } from "./missionProgress";

describe("latestActivityLine", () => {
  it("returns the last non-empty line with the stream prefix stripped", () => {
    expect(
      latestActivityLine([
        "[stdout] Extracting files",
        "[stderr] warn: slow",
        "[stdout] Classifying item 3",
      ]),
    ).toBe("Classifying item 3");
  });

  it("skips blank and whitespace-only trailing lines", () => {
    expect(latestActivityLine(["[stdout] working", "[stdout]   ", "[stdout] "])).toBe("working");
  });

  it("returns null for empty or undefined input", () => {
    expect(latestActivityLine([])).toBeNull();
    expect(latestActivityLine(undefined)).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(-100)).toBe("0s");
  });

  it("formats minutes with zero-padded seconds", () => {
    expect(formatElapsed(65_000)).toBe("1m 05s");
  });

  it("formats hours with zero-padded minutes", () => {
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
  });
});
