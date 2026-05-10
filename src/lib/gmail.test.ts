import { describe, expect, it } from "vitest";
import {
  buildGmailMessageStates,
  buildGmailScanQuery,
  gmailRefreshPolicy,
  normalizeGmailRefreshTtl,
  normalizeGmailScanLimit,
  shouldApplyGmailRefreshResult,
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
        auto_refresh_ttl_seconds: 300,
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
        auto_refresh_ttl_seconds: 300,
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
    expect(normalizeGmailRefreshTtl(Number.NaN)).toBe(300);
    expect(normalizeGmailRefreshTtl(90000)).toBe(86400);
  });
});

describe("gmailRefreshPolicy", () => {
  const base = {
    enabled: true,
    force: false,
    loading: false,
    now: 1_000_000,
    lastFetchedAt: 900_000,
    ttlSeconds: 300,
    query: "is:unread newer_than:14d",
    previousQuery: "is:unread newer_than:14d",
    max: 20,
    previousMax: 20,
  };

  it("skips automatic refresh inside ttl", () => {
    expect(gmailRefreshPolicy(base)).toBe("ttl");
  });

  it("starts when ttl expired or force is requested", () => {
    expect(gmailRefreshPolicy({ ...base, now: 1_300_001 })).toBe("start");
    expect(gmailRefreshPolicy({ ...base, force: true, loading: true })).toBe("start");
  });

  it("skips duplicate automatic refresh while loading", () => {
    expect(gmailRefreshPolicy({ ...base, loading: true })).toBe("loading");
  });

  it("starts when query or max changed and clears when disabled", () => {
    expect(gmailRefreshPolicy({ ...base, query: "is:unread newer_than:7d" })).toBe("start");
    expect(gmailRefreshPolicy({ ...base, max: 50 })).toBe("start");
    expect(gmailRefreshPolicy({ ...base, enabled: false })).toBe("disabled");
  });

  it("ignores stale request results", () => {
    expect(shouldApplyGmailRefreshResult(3, 3)).toBe(true);
    expect(shouldApplyGmailRefreshResult(2, 3)).toBe(false);
  });
});
