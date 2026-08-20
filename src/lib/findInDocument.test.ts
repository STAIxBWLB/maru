// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyFindHighlights,
  clearFindHighlights,
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

describe("applyFindHighlights / clearFindHighlights", () => {
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

  it("clear restores the exact original text", () => {
    document.body.innerHTML = "<p>al<strong>pha</strong> alpha</p>";
    const container = document.body.querySelector("p")!;
    const before = container.textContent;
    applyFindHighlights(container, "alpha", 0);
    clearFindHighlights(container);
    expect(container.textContent).toBe(before);
    expect(container.querySelectorAll("mark.find-mark")).toHaveLength(0);
  });

  it("leaves KG highlight marks untouched", () => {
    document.body.innerHTML =
      '<p>see <mark class="kg-ref-mark kg-ref-entity">alpha</mark> and alpha</p>';
    const container = document.body.querySelector("p")!;
    applyFindHighlights(container, "alpha", 0);
    clearFindHighlights(container);
    expect(container.querySelectorAll("mark.kg-ref-mark")).toHaveLength(1);
    expect(container.textContent).toBe("see alpha and alpha");
  });
});
