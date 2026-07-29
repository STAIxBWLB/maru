import { describe, expect, it } from "vitest";

import { formatUsageResetIn, formatUsageWindowSegment } from "./usageFormat";

const NOW = Date.parse("2026-07-28T12:00:00Z");

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe("formatUsageResetIn", () => {
  it("returns null for missing or unparseable timestamps", () => {
    expect(formatUsageResetIn(null, NOW)).toBeNull();
    expect(formatUsageResetIn("not-a-date", NOW)).toBeNull();
  });

  it("formats sub-hour resets as minutes", () => {
    expect(formatUsageResetIn(iso(48 * 60_000), NOW)).toBe("48m");
    expect(formatUsageResetIn(iso(60_000), NOW)).toBe("1m");
  });

  it("formats sub-day resets as hours and minutes", () => {
    expect(formatUsageResetIn(iso(3 * 3_600_000), NOW)).toBe("3h");
    expect(formatUsageResetIn(iso((2 * 60 + 5) * 60_000), NOW)).toBe("2h 5m");
  });

  it("formats multi-day resets as days and hours", () => {
    expect(formatUsageResetIn(iso((2 * 24 + 20) * 3_600_000), NOW)).toBe("2d 20h");
    expect(formatUsageResetIn(iso((6 * 24 + 4) * 3_600_000 + 30_000), NOW)).toBe("6d 4h");
  });

  it("clamps past timestamps to 0m", () => {
    expect(formatUsageResetIn(iso(-5 * 60_000), NOW)).toBe("0m");
  });
});

describe("formatUsageWindowSegment", () => {
  it("joins percent, suffix, and reset-in", () => {
    expect(
      formatUsageWindowSegment(
        { usedPercent: 19.4, resetsAt: iso(48 * 60_000) },
        "used",
        NOW,
      ),
    ).toBe("19% used 48m");
  });

  it("omits the reset-in part when there is no reset time", () => {
    expect(
      formatUsageWindowSegment({ usedPercent: 89, resetsAt: null }, "used", NOW),
    ).toBe("89% used");
  });
});
