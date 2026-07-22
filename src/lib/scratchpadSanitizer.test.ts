// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderScratchpadMarkdown } from "./scratchpad";

describe("Scratchpad Markdown sanitizer", () => {
  it("removes SVG resource elements and every remote-capable URL attribute", () => {
    const html = renderScratchpadMarkdown(
      '<svg><image href="https://example.com/a.svg"/><use xlink:href="https://example.com/s.svg#x"/></svg>' +
        '<a href="https://example.com">remote</a>' +
        '<img src="https://example.com/a.png" srcset="https://example.com/b.png 2x">',
    );

    expect(html).not.toMatch(/<svg|<image|<use|<img/i);
    expect(html).not.toMatch(/(?:href|xlink:href|src|srcset)=/i);
    expect(html).toContain("remote");
  });
});
