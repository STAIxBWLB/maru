import { describe, expect, it } from "vitest";
import { extractOutgoingLinks, splitFrontmatter } from "./wikilinks";

describe("splitFrontmatter", () => {
  it("returns the YAML block and body without mutating bytes", () => {
    const content = "---\ntitle: 회의\n# comment\n---\n# Body\n";

    expect(splitFrontmatter(content)).toEqual([
      "---\ntitle: 회의\n# comment\n---\n",
      "# Body\n",
    ]);
  });

  it("treats malformed frontmatter as body content", () => {
    const content = "---\ntitle: missing close\n# Body\n";

    expect(splitFrontmatter(content)).toEqual(["", content]);
  });
});

describe("extractOutgoingLinks", () => {
  it("extracts aliases, trims targets, dedupes, and sorts", () => {
    const links = extractOutgoingLinks(
      "[[ Project Alpha |프로젝트]] [[People/Lee]] [[Project Alpha]] [[ ]]",
    );

    expect(links).toEqual(["People/Lee", "Project Alpha"]);
  });
});
