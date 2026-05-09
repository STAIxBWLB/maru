import { describe, expect, it } from "vitest";
import {
  buildGmailMessageStates,
  buildGmailScanQuery,
  normalizeGmailScanLimit,
  shortFrom,
} from "./gmail";

describe("shortFrom", () => {
  it("returns empty string for empty input", () => {
    expect(shortFrom("")).toBe("");
    expect(shortFrom("   ")).toBe("");
  });

  it("extracts display name from quoted RFC5322 form", () => {
    expect(shortFrom('"PLAUD.AI" <no-reply@plaud.ai>')).toBe("PLAUD.AI");
  });

  it("extracts display name from unquoted form", () => {
    expect(shortFrom("Boss <boss@example.com>")).toBe("Boss");
  });

  it("returns raw email when no display name present", () => {
    expect(shortFrom("no-reply@plaud.ai")).toBe("no-reply@plaud.ai");
  });

  it("preserves Korean display names", () => {
    expect(shortFrom('"김윤수" <yunsu2353@korea.kr>')).toBe("김윤수");
  });
});

describe("buildGmailMessageStates", () => {
  const sample = (id: string) => ({
    id,
    from: `${id}@x`,
    subject: `subject ${id}`,
    date: "Tue, 28 Apr 2026 09:00:00 +0900",
  });

  it("defaults missing decisions to pending", () => {
    const result = buildGmailMessageStates(
      [sample("a"), sample("b")],
      new Map(),
    );
    expect(result.map((s) => s.decision)).toEqual(["pending", "pending"]);
  });

  it("carries existing decisions by id", () => {
    const decisions = new Map([["a", "accepted"], ["b", "rejected"]] as const);
    const result = buildGmailMessageStates([sample("a"), sample("b"), sample("c")], decisions);
    expect(result[0].decision).toBe("accepted");
    expect(result[1].decision).toBe("rejected");
    expect(result[2].decision).toBe("pending");
  });
});

describe("buildGmailScanQuery", () => {
  it("uses explicit query when provided", () => {
    expect(
      buildGmailScanQuery({
        enabled: true,
        scan_window_days: 14,
        max_results: 20,
        unread_only: true,
        query: "label:work newer_than:7d",
        gws_path: null,
      }),
    ).toBe("label:work newer_than:7d");
  });

  it("builds unread and scan-window query from structured fields", () => {
    expect(
      buildGmailScanQuery({
        enabled: true,
        scan_window_days: 30,
        max_results: 20,
        unread_only: true,
        query: "",
        gws_path: null,
      }),
    ).toBe("is:unread newer_than:30d");
  });

  it("clamps scan limits to gws-friendly bounds", () => {
    expect(normalizeGmailScanLimit(0)).toBe(1);
    expect(normalizeGmailScanLimit(250)).toBe(200);
    expect(normalizeGmailScanLimit(42.8)).toBe(42);
  });
});
