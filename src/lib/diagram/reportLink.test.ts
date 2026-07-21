import { describe, expect, it } from "vitest";

import {
  buildManagedBlock,
  findManagedBlock,
  parseManagedBlocks,
  spliceManagedBlock,
} from "./reportLink";

const ARGS = {
  source: "diagrams/example.cmd.json",
  scope: "pattern:view-1",
  assetPath: "attachments/diagrams/doc-1/pattern:view-1-ab12cd34.svg",
  fallbackPath: "attachments/diagrams/doc-1/pattern:view-1-ab12cd34.png",
  renderHash: "sha256:ab12cd34ef56",
  caption: "Weekly chart",
};

describe("buildManagedBlock", () => {
  it("renders the v1 comment + image line contract", () => {
    const block = buildManagedBlock(ARGS);
    expect(block).toBe(
      '<!-- maru-diagram:v1 {"source":"diagrams/example.cmd.json","scope":"pattern:view-1","asset":"attachments/diagrams/doc-1/pattern:view-1-ab12cd34.svg","fallback":"attachments/diagrams/doc-1/pattern:view-1-ab12cd34.png","renderHash":"sha256:ab12cd34ef56"} -->\n' +
        "![Weekly chart](attachments/diagrams/doc-1/pattern:view-1-ab12cd34.svg)",
    );
  });

  it("omits optional keys when not provided", () => {
    const block = buildManagedBlock({
      source: ARGS.source,
      scope: "doc",
      assetPath: ARGS.assetPath,
      caption: "c",
    });
    expect(block).not.toContain("fallback");
    expect(block).not.toContain("renderHash");
  });

  it("strips characters that would break the image syntax from the caption", () => {
    const block = buildManagedBlock({ ...ARGS, caption: "a [b]\nc" });
    expect(block).toContain("![a b c](");
  });
});

describe("parseManagedBlocks", () => {
  it("round-trips a built block", () => {
    const block = buildManagedBlock(ARGS);
    const matches = parseManagedBlocks(block);
    expect(matches).toHaveLength(1);
    expect(matches[0].attrs).toEqual({
      source: ARGS.source,
      scope: ARGS.scope,
      asset: ARGS.assetPath,
      fallback: ARGS.fallbackPath,
      renderHash: ARGS.renderHash,
    });
    expect(block.slice(matches[0].start, matches[0].end)).toBe(block);
  });

  it("finds blocks embedded in a larger document", () => {
    const block = buildManagedBlock(ARGS);
    const md = `# Report\n\nintro text\n\n${block}\n\noutro\n`;
    const matches = parseManagedBlocks(md);
    expect(matches).toHaveLength(1);
    expect(md.slice(matches[0].start, matches[0].end)).toBe(block);
  });

  it("tolerates a blank line between comment and image", () => {
    const block = buildManagedBlock(ARGS);
    const withBlank = block.replace("\n", "\n\n");
    const matches = parseManagedBlocks(withBlank);
    expect(matches).toHaveLength(1);
    expect(withBlank.slice(matches[0].start, matches[0].end)).toBe(withBlank);
  });

  it("still matches a comment without a following image line", () => {
    const comment = buildManagedBlock(ARGS).split("\n")[0];
    const md = `${comment}\nsome other paragraph\n`;
    const matches = parseManagedBlocks(md);
    expect(matches).toHaveLength(1);
    expect(md.slice(matches[0].start, matches[0].end)).toBe(comment);
  });

  it("skips malformed JSON blocks with a warning", () => {
    const md = "<!-- maru-diagram:v1 {not json} -->\n![x](y.svg)\n";
    expect(parseManagedBlocks(md)).toHaveLength(0);
  });

  it("skips blocks missing required keys", () => {
    const md = '<!-- maru-diagram:v1 {"source":"a"} -->\n![x](y.svg)\n';
    expect(parseManagedBlocks(md)).toHaveLength(0);
  });

  it("keeps multiple scopes of the same source distinct", () => {
    const a = buildManagedBlock(ARGS);
    const b = buildManagedBlock({ ...ARGS, scope: "doc", assetPath: "attachments/diagrams/doc-1/doc-ff00ff00.svg" });
    const md = `${a}\n\nmiddle\n\n${b}\n`;
    const matches = parseManagedBlocks(md);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.attrs.scope)).toEqual(["pattern:view-1", "doc"]);
  });
});

describe("spliceManagedBlock", () => {
  it("inserts at the end with surrounding blank lines", () => {
    const block = buildManagedBlock(ARGS);
    const md = "# Report\n\nbody text\n";
    const result = spliceManagedBlock(md, block, { source: ARGS.source, scope: ARGS.scope });
    expect(result.mode).toBe("inserted");
    expect(result.content).toBe(`# Report\n\nbody text\n\n${block}\n`);
  });

  it("inserts into an empty document", () => {
    const block = buildManagedBlock(ARGS);
    const result = spliceManagedBlock("", block, { source: ARGS.source, scope: ARGS.scope });
    expect(result.mode).toBe("inserted");
    expect(result.content).toBe(`${block}\n`);
  });

  it("does not add a duplicate blank line when the doc already ends with one", () => {
    const block = buildManagedBlock(ARGS);
    const md = "body\n\n";
    const result = spliceManagedBlock(md, block, { source: ARGS.source, scope: ARGS.scope });
    expect(result.content).toBe(`body\n\n${block}\n`);
  });

  it("updates an existing block in place and preserves surrounding bytes", () => {
    const before = buildManagedBlock(ARGS);
    const md = `# Report\n\ntop\n\n${before}\n\nbottom\n`;
    const after = buildManagedBlock({ ...ARGS, renderHash: "sha256:99", assetPath: "attachments/diagrams/doc-1/pattern:view-1-99999999.svg" });
    const result = spliceManagedBlock(md, after, { source: ARGS.source, scope: ARGS.scope });
    expect(result.mode).toBe("updated");
    expect(result.content).toBe(`# Report\n\ntop\n\n${after}\n\nbottom\n`);
  });

  it("matches on source AND scope together", () => {
    const existing = buildManagedBlock(ARGS);
    const md = `${existing}\n`;
    // Same source, different scope -> insert, not update.
    const other = buildManagedBlock({ ...ARGS, scope: "doc" });
    const result = spliceManagedBlock(md, other, { source: ARGS.source, scope: "doc" });
    expect(result.mode).toBe("inserted");
    expect(result.content).toBe(`${existing}\n\n${other}\n`);
  });

  it("is idempotent", () => {
    const block = buildManagedBlock(ARGS);
    const md = "# Report\n";
    const first = spliceManagedBlock(md, block, { source: ARGS.source, scope: ARGS.scope });
    const second = spliceManagedBlock(first.content, block, { source: ARGS.source, scope: ARGS.scope });
    expect(second.mode).toBe("updated");
    expect(second.content).toBe(first.content);
  });

  it("preserves CRLF-free content outside the block byte-for-byte", () => {
    const block = buildManagedBlock(ARGS);
    const head = "---\ntitle: 보고서\n---\n\n# 제목\n\n- [ ] task  \n\ntrailing spaces   \n";
    const tail = "\n## 끝\n";
    const md = head + tail;
    const result = spliceManagedBlock(md, block, { source: ARGS.source, scope: ARGS.scope });
    expect(result.content.startsWith(head)).toBe(true);
    // Insert appends at the very end of the document, after the tail.
    expect(result.content).toBe(`${head}${tail}\n${block}\n`);
  });
});

describe("findManagedBlock", () => {
  it("returns the matching block or null", () => {
    const block = buildManagedBlock(ARGS);
    const md = `x\n\n${block}\n`;
    expect(findManagedBlock(md, { source: ARGS.source, scope: ARGS.scope })).not.toBeNull();
    expect(findManagedBlock(md, { source: ARGS.source, scope: "doc" })).toBeNull();
    expect(findManagedBlock(md, { source: "diagrams/other.cmd.json", scope: ARGS.scope })).toBeNull();
  });

  it("survives '-->' inside attr values (diagram named 'x --> y')", () => {
    // Un-escaped, the first --> inside the JSON would terminate the HTML
    // comment, the block would parse as malformed, and every insert would
    // append a duplicate.
    const args = { ...ARGS, source: "diagrams/x --> y.cmd.json" };
    const block = buildManagedBlock(args);
    const md = `# R\n\n${block}\n`;
    const match = { source: args.source, scope: args.scope };
    const found = findManagedBlock(md, match);
    expect(found).not.toBeNull();
    expect(found!.attrs.source).toBe(args.source);
    const again = spliceManagedBlock(md, block, match);
    expect(again.mode).toBe("updated");
    expect(again.content).toBe(md);
  });
});
