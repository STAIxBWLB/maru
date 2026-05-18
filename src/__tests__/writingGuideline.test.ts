import { describe, expect, it } from "vitest";
import { extractGuidelineIds } from "../components/catalog/WritingGuidelineSidebar";

describe("extractGuidelineIds", () => {
  it("returns empty when no frontmatter and no provenance comment", () => {
    expect(extractGuidelineIds("# body", null)).toEqual([]);
    expect(extractGuidelineIds("# body", {})).toEqual([]);
  });

  it("reads frontmatter guideline_ids (snake_case)", () => {
    const ids = extractGuidelineIds("# body", {
      guideline_ids: ["gdl_abc", "gdl_def"],
    });
    expect(ids).toEqual(["gdl_abc", "gdl_def"]);
  });

  it("reads frontmatter guidelineIds (camelCase fallback)", () => {
    const ids = extractGuidelineIds("# body", {
      guidelineIds: ["gdl_alpha"],
    });
    expect(ids).toEqual(["gdl_alpha"]);
  });

  it("reads the provenance comment from the body", () => {
    const body = "# Title\n\nsome content\n\n<!-- anchor:guidelines gdl_x, gdl_y -->\n";
    expect(extractGuidelineIds(body, null)).toEqual(["gdl_x", "gdl_y"]);
  });

  it("merges frontmatter and comment ids without duplicates", () => {
    const body = "<!-- anchor:guidelines gdl_a, gdl_c -->";
    const ids = extractGuidelineIds(body, { guideline_ids: ["gdl_a", "gdl_b"] });
    expect(ids).toEqual(["gdl_a", "gdl_b", "gdl_c"]);
  });

  it("ignores empty pieces and trims whitespace", () => {
    const body = "<!--   anchor:guidelines  gdl_a ,   ,gdl_b  -->";
    expect(extractGuidelineIds(body, null)).toEqual(["gdl_a", "gdl_b"]);
  });

  it("ignores non-string array entries", () => {
    const ids = extractGuidelineIds("", {
      guideline_ids: ["gdl_keep", 42, null, "", "  ", "gdl_other"] as unknown[],
    });
    expect(ids).toEqual(["gdl_keep", "gdl_other"]);
  });
});
