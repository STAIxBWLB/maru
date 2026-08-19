import { describe, expect, it } from "vitest";
import {
  countInboxEntryChannels,
  countInboxEntryIntakeModes,
  filterEntriesByChannel,
  filterEntriesByIntakeMode,
  filterItemsBySource,
  groupEntriesByChannel,
  groupFilesBySource,
  mergeInboxSourceKeys,
  uniqueEntryChannels,
  uniqueSources,
} from "./inbox";
import type { InboxEntry } from "./types";

interface Wrapped {
  item: { source: string; id: string };
}

const items: Wrapped[] = [
  { item: { source: "outlook", id: "a" } },
  { item: { source: "sharepoint", id: "b" } },
  { item: { source: "outlook", id: "c" } },
  { item: { source: "kakao", id: "d" } },
];

describe("filterItemsBySource", () => {
  it("returns the input unchanged when source is null", () => {
    expect(filterItemsBySource(items, null)).toEqual(items);
  });

  it("filters down to a single matching source", () => {
    const filtered = filterItemsBySource(items, "outlook");
    expect(filtered.map((entry) => entry.item.id)).toEqual(["a", "c"]);
  });

  it("returns an empty list for unknown sources", () => {
    expect(filterItemsBySource(items, "missing")).toEqual([]);
  });
});

describe("uniqueSources", () => {
  it("collects sources alphabetically without duplicates", () => {
    expect(uniqueSources(items)).toEqual(["kakao", "outlook", "sharepoint"]);
  });

  it("returns empty array for empty input", () => {
    expect(uniqueSources([])).toEqual([]);
  });
});

describe("groupEntriesByChannel", () => {
  it("groups configured entries by sorted channel while preserving item order", () => {
    const entries = [
      inboxEntry("mso-b", "mso"),
      inboxEntry("kakao-a", "kakao"),
      inboxEntry("mso-c", "mso"),
    ];

    const groups = groupEntriesByChannel(entries);
    expect(groups.map((group) => group.key)).toEqual(["kakao", "mso"]);
    expect(groups.find((group) => group.key === "mso")?.entries.map((entry) => entry.id)).toEqual([
      "mso-b",
      "mso-c",
    ]);
  });

  it("returns empty groups for empty configured entries", () => {
    expect(groupEntriesByChannel([])).toEqual([]);
  });
});

describe("configured entry source filters", () => {
  const entries = [
    inboxEntry("mso-b", "mso"),
    inboxEntry("kakao-a", "kakao"),
    inboxEntry("mso-c", "mso"),
  ];

  it("filters configured entries by channel", () => {
    expect(filterEntriesByChannel(entries, null).map((entry) => entry.id)).toEqual([
      "mso-b",
      "kakao-a",
      "mso-c",
    ]);
    expect(filterEntriesByChannel(entries, "mso").map((entry) => entry.id)).toEqual([
      "mso-b",
      "mso-c",
    ]);
    expect(filterEntriesByChannel(entries, "gws")).toEqual([]);
  });

  it("collects and counts configured entry channels", () => {
    expect(uniqueEntryChannels(entries)).toEqual(["kakao", "mso"]);
    const counts = countInboxEntryChannels(entries);
    expect(counts.get("mso")).toBe(2);
    expect(counts.get("kakao")).toBe(1);
  });

  it("keeps configured source folder keys visible before observed sources", () => {
    expect(
      mergeInboxSourceKeys(
        ["incoming", "kakao", "gws", "telegram"],
        uniqueEntryChannels(entries),
        uniqueSources(items),
      ),
    ).toEqual(["incoming", "kakao", "gws", "telegram", "mso", "outlook", "sharepoint"]);
  });
});

describe("groupFilesBySource", () => {
  it("groups staged files by sorted source while preserving item order", () => {
    const groups = groupFilesBySource(items);
    expect(groups.map((group) => group.key)).toEqual(["kakao", "outlook", "sharepoint"]);
    expect(groups.find((group) => group.key === "outlook")?.items.map((entry) => entry.item.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns empty groups for empty staged files", () => {
    expect(groupFilesBySource([])).toEqual([]);
  });
});

describe("intake mode", () => {
  const entry = (id: string, intakeMode: "auto" | "manual"): InboxEntry => ({
    ...inboxEntry(id, "gws"),
    intakeMode,
  });

  it("filters by population and treats null as everything", () => {
    const entries = [entry("a", "auto"), entry("b", "manual"), entry("c", "auto")];
    expect(filterEntriesByIntakeMode(entries, null)).toHaveLength(3);
    expect(filterEntriesByIntakeMode(entries, "auto").map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterEntriesByIntakeMode(entries, "manual").map((e) => e.id)).toEqual(["b"]);
  });

  it("tallies the two populations in their own map", () => {
    const counts = countInboxEntryIntakeModes([
      entry("a", "auto"),
      entry("b", "manual"),
      entry("c", "auto"),
    ]);
    // Its own map on purpose: folding these into the channel counts would
    // double any total summed from that map.
    expect(counts.get("auto")).toBe(2);
    expect(counts.get("manual")).toBe(1);
    expect([...counts.keys()].sort()).toEqual(["auto", "manual"]);
  });
});

function inboxEntry(id: string, channel: string): InboxEntry {
  return {
    id,
    kind: "dropFile",
    path: `/work/inbox/drop/${channel}/${id}.txt`,
    relPath: `inbox/drop/${channel}/${id}.txt`,
    title: `${id}.txt`,
    channel,
    sourceKind: "message",
    dropPath: `drop/${channel}`,
    configuredRoot: "/work/inbox",
    itemId: null,
    status: "drop",
    manifestPath: null,
    summaryPath: null,
    routePath: null,
    sizeBytes: 4,
    receivedAt: null,
    intakeMode: "manual",
  };
}
