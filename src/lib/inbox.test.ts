import { describe, expect, it } from "vitest";
import { filterItemsBySource, groupEntriesByChannel, groupFilesBySource, uniqueSources } from "./inbox";
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
  };
}
