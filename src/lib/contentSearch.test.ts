import { describe, expect, it } from "vitest";
import {
  MIN_CONTENT_QUERY_LENGTH,
  parseGlobList,
  shouldRunContentSearch,
  splitMatchSegments,
} from "./contentSearch";

describe("content search helpers", () => {
  it("sorts, clamps, and merges match ranges", () => {
    expect(
      splitMatchSegments("abcdefghij", [
        [8, 20],
        [2, 5],
        [4, 7],
        [-3, 1],
        [9, 4],
      ]),
    ).toEqual([
      { text: "a", hit: true },
      { text: "b", hit: false },
      { text: "cdefg", hit: true },
      { text: "h", hit: false },
      { text: "ij", hit: true },
    ]);
  });

  it("uses UTF-16 indices directly for emoji", () => {
    expect(splitMatchSegments("😀 world", [[3, 8]])).toEqual([
      { text: "😀 ", hit: false },
      { text: "world", hit: true },
    ]);
  });

  it("returns one plain segment when no usable range remains", () => {
    expect(splitMatchSegments("text", [[3, 3], [5, 1]])).toEqual([
      { text: "text", hit: false },
    ]);
    expect(splitMatchSegments("", [[0, 1]])).toEqual([]);
  });

  it("parses comma-separated glob lists", () => {
    expect(parseGlobList("*.ts, src/**, , docs/*.md ")).toEqual([
      "*.ts",
      "src/**",
      "docs/*.md",
    ]);
  });

  it("runs only a sufficiently specific contents query with a workspace", () => {
    expect(MIN_CONTENT_QUERY_LENGTH).toBe(2);
    expect(
      shouldRunContentSearch({ mode: "contents", query: "회의", workspacePath: "/work" }),
    ).toBe(true);
    expect(
      shouldRunContentSearch({ mode: "names", query: "회의", workspacePath: "/work" }),
    ).toBe(false);
    expect(
      shouldRunContentSearch({ mode: "contents", query: "a", workspacePath: "/work" }),
    ).toBe(false);
    expect(
      shouldRunContentSearch({ mode: "contents", query: "word", workspacePath: null }),
    ).toBe(false);
  });
});
