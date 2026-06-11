import { describe, expect, it } from "vitest";
import {
  candidateToSite,
  faviconUrlFor,
  filterSitesByQuery,
  groupSitesByCategory,
  newSiteId,
  normalizeSiteUrl,
  parseSiteCandidates,
  parseSitesDocument,
  removeSite,
  serializeSitesDocument,
  shouldShowSiteView,
  siteViewBoundsFromRect,
  sortSites,
  touchSiteUsage,
  upsertSite,
  type SiteEntry,
} from "./sites";

function site(overrides: Partial<SiteEntry>): SiteEntry {
  return {
    id: "id-1",
    label: "Example",
    url: "https://example.com",
    category: null,
    favicon: null,
    localPath: null,
    devUrl: null,
    order: 0,
    createdAt: null,
    lastUsedAt: null,
    notes: null,
    ...overrides,
  };
}

describe("parseSitesDocument", () => {
  it("returns an empty document for garbage input", () => {
    expect(parseSitesDocument(null)).toEqual({ version: 1, sites: [] });
    expect(parseSitesDocument("nope")).toEqual({ version: 1, sites: [] });
    expect(parseSitesDocument({ version: 9, sites: "x" })).toEqual({ version: 1, sites: [] });
  });

  it("drops rows without a url and fills defaults", () => {
    const doc = parseSitesDocument({
      version: 1,
      sites: [
        { label: "no url" },
        { url: " https://a.example ", order: "3", notes: 7 },
      ],
    });
    expect(doc.sites).toHaveLength(1);
    expect(doc.sites[0].url).toBe("https://a.example");
    expect(doc.sites[0].label).toBe("https://a.example");
    expect(doc.sites[0].order).toBe(3);
    expect(doc.sites[0].notes).toBeNull();
    expect(doc.sites[0].id).toBeTruthy();
  });

  it("round-trips through serializeSitesDocument", () => {
    const sites = [site({ id: "a", order: 1 }), site({ id: "b", order: 0 })];
    const doc = parseSitesDocument(serializeSitesDocument(sites));
    expect(doc.sites.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("sortSites / upsertSite / removeSite / touchSiteUsage", () => {
  it("sorts by order then label", () => {
    const sorted = sortSites([
      site({ id: "c", order: 1, label: "C" }),
      site({ id: "b", order: 0, label: "나" }),
      site({ id: "a", order: 0, label: "가" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("upserts by id and removes by id", () => {
    const start = [site({ id: "a" })];
    const updated = upsertSite(start, site({ id: "a", label: "Renamed" }));
    expect(updated).toHaveLength(1);
    expect(updated[0].label).toBe("Renamed");
    expect(removeSite(updated, "a")).toEqual([]);
  });

  it("stamps lastUsedAt on the touched site only", () => {
    const when = new Date("2026-06-11T00:00:00Z");
    const next = touchSiteUsage([site({ id: "a" }), site({ id: "b" })], "a", when);
    expect(next.find((entry) => entry.id === "a")?.lastUsedAt).toBe(when.toISOString());
    expect(next.find((entry) => entry.id === "b")?.lastUsedAt).toBeNull();
  });
});

describe("groupSitesByCategory", () => {
  it("sorts categories and puts uncategorized last", () => {
    const groups = groupSitesByCategory([
      site({ id: "a", category: null }),
      site({ id: "b", category: "work" }),
      site({ id: "c", category: "blog" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(["blog", "work", null]);
  });
});

describe("filterSitesByQuery", () => {
  it("matches label, url, and category case-insensitively", () => {
    const sites = [
      site({ id: "a", label: "제주 블로그", url: "https://jeju.ai" }),
      site({ id: "b", label: "Docs", category: "Work" }),
    ];
    expect(filterSitesByQuery(sites, "제주").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterSitesByQuery(sites, "JEJU").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterSitesByQuery(sites, "work").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterSitesByQuery(sites, "  ")).toHaveLength(2);
  });
});

describe("faviconUrlFor / normalizeSiteUrl", () => {
  it("prefers the explicit favicon and derives origin fallback", () => {
    expect(faviconUrlFor(site({ favicon: "https://x/i.png" }))).toBe("https://x/i.png");
    expect(faviconUrlFor(site({ url: "https://jeju.ai/blog" }))).toBe(
      "https://jeju.ai/favicon.ico",
    );
    expect(faviconUrlFor(site({ url: "not a url" }))).toBeNull();
  });

  it("normalizes scheme-less input and rejects non-http", () => {
    expect(normalizeSiteUrl("Example.com/x/")).toBe("https://example.com/x");
    expect(normalizeSiteUrl("http://localhost:4321/")).toBe("http://localhost:4321");
    expect(normalizeSiteUrl("ftp://x")).toBeNull();
    expect(normalizeSiteUrl("   ")).toBeNull();
  });
});

describe("parseSiteCandidates / candidateToSite", () => {
  it("tolerates garbage rows and falls back to devUrl", () => {
    const candidates = parseSiteCandidates([
      null,
      { dirName: "demo", localPath: "/w/sites/demo", devUrl: "http://localhost:3000" },
    ]);
    expect(candidates).toHaveLength(1);
    const entry = candidateToSite(candidates[0], {}, 5);
    expect(entry?.url).toBe("http://localhost:3000");
    expect(entry?.order).toBe(5);
    expect(candidateToSite({ ...candidates[0], devUrl: null }, {}, 0)).toBeNull();
  });
});

describe("siteViewBoundsFromRect / shouldShowSiteView", () => {
  it("rounds bounds and rejects collapsed rects", () => {
    expect(siteViewBoundsFromRect({ x: 1.4, y: 2.6, width: 100.5, height: 50.2 })).toEqual({
      x: 1,
      y: 3,
      width: 101,
      height: 50,
    });
    expect(siteViewBoundsFromRect({ x: 0, y: 0, width: 0, height: 0 })).toBeNull();
  });

  it("hides for overlays and dialogs", () => {
    expect(
      shouldShowSiteView({ hasActiveSite: true, overlayOpen: false, localDialogOpen: false }),
    ).toBe(true);
    expect(
      shouldShowSiteView({ hasActiveSite: true, overlayOpen: true, localDialogOpen: false }),
    ).toBe(false);
    expect(
      shouldShowSiteView({ hasActiveSite: true, overlayOpen: false, localDialogOpen: true }),
    ).toBe(false);
    expect(
      shouldShowSiteView({ hasActiveSite: false, overlayOpen: false, localDialogOpen: false }),
    ).toBe(false);
  });
});

describe("newSiteId", () => {
  it("produces unique non-empty ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSiteId()));
    expect(ids.size).toBe(50);
  });
});
