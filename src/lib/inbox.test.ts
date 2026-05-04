import { describe, expect, it } from "vitest";
import { filterItemsBySource, uniqueSources } from "./inbox";

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
