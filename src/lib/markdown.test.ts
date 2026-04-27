import { describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

import { extractOutline, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("strips frontmatter and rewrites wikilinks to anchor links", () => {
    const html = renderMarkdown("---\ntitle: Hidden\n---\n# Title\nSee [[Project Alpha|프로젝트]].");

    expect(html).not.toContain("title: Hidden");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-wikilink="Project Alpha"');
    expect(html).toContain("프로젝트");
  });
});

describe("extractOutline", () => {
  it("extracts h1-h3 headings outside frontmatter with line numbers", () => {
    const headings = extractOutline("---\ntitle: # Not heading\n---\n# One\n#### Skip\n## Two\n");

    expect(headings).toEqual([
      { level: 1, text: "One", line: 3 },
      { level: 2, text: "Two", line: 5 },
    ]);
  });
});
