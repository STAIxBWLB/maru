// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyFindHighlights,
  cycleMatchIndex,
  findMatches,
} from "./findInDocument";

describe("findMatches", () => {
  it("finds case-insensitive, non-overlapping matches", () => {
    expect(findMatches("Alpha alpha ALPHA", "alpha")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it("returns no matches for an empty or blank query", () => {
    expect(findMatches("anything", "")).toEqual([]);
    expect(findMatches("anything", "   ")).toEqual([]);
  });

  it("returns offsets into the original string when case folding changes length", () => {
    // "İ".toLowerCase() is "i̇" (two code units): lowercasing the document
    // would put "X" at index 2 instead of 1.
    expect(findMatches("İX marks", "x")).toEqual([{ start: 1, end: 2 }]);
  });

  it("escapes regex metacharacters in the query", () => {
    expect(findMatches("a.c a-c", "a.c")).toEqual([{ start: 0, end: 3 }]);
  });

  it("does not overlap matches", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});

describe("cycleMatchIndex", () => {
  it("wraps around in both directions", () => {
    expect(cycleMatchIndex(2, 3, 1)).toBe(0);
    expect(cycleMatchIndex(0, 3, -1)).toBe(2);
    expect(cycleMatchIndex(0, 3, 1)).toBe(1);
  });

  it("stays at zero when there are no matches", () => {
    expect(cycleMatchIndex(4, 0, 1)).toBe(0);
  });
});

describe("applyFindHighlights", () => {
  it("wraps matches and marks only the current one", () => {
    document.body.innerHTML = "<p>one two one</p>";
    const container = document.body.querySelector("p")!;
    const count = applyFindHighlights(container, "one", 1);
    expect(count).toBe(2);
    expect(container.querySelectorAll("mark.find-mark")).toHaveLength(2);
    expect(container.querySelectorAll("mark.find-mark-current")).toHaveLength(1);
    expect(container.querySelector("mark.find-mark-current")?.textContent).toBe("one");
  });

  it("splits matches across element boundaries", () => {
    document.body.innerHTML = "<p>al<strong>pha be</strong>ta alpha</p>";
    const container = document.body.querySelector("p")!;
    const count = applyFindHighlights(container, "alpha", 0);
    expect(count).toBe(2);
    expect(container.querySelectorAll("mark.find-mark").length).toBeGreaterThanOrEqual(3);
  });

  it("is purely additive: the text is unchanged", () => {
    document.body.innerHTML = "<p>al<strong>pha</strong> alpha</p>";
    const container = document.body.querySelector("p")!;
    const before = container.textContent;
    applyFindHighlights(container, "alpha", 0);
    expect(container.textContent).toBe(before);
  });

  it("nests inside KG highlight marks instead of replacing them", () => {
    document.body.innerHTML =
      '<p>see <mark class="kg-ref-mark kg-ref-entity">alpha</mark> and alpha</p>';
    const container = document.body.querySelector("p")!;
    applyFindHighlights(container, "alpha", 0);
    expect(container.querySelectorAll("mark.kg-ref-mark")).toHaveLength(1);
    expect(container.querySelectorAll("mark.kg-ref-mark mark.find-mark")).toHaveLength(1);
    expect(container.textContent).toBe("see alpha and alpha");
  });
});
