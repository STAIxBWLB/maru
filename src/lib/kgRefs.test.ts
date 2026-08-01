import { describe, expect, it } from "vitest";
import type { DocumentRefMap, KgNodeRef } from "./types";
import {
  buildByteToCharTable,
  byteOffsetToCharIndex,
  mapSpansToRenderedText,
  refMapToCharSpans,
  refStepsByParagraph,
  resolveReferenceNodeIds,
  segmentsFromSpans,
  spanSearchTexts,
  uniqueRefNodePaths,
} from "./kgRefs";

const encoder = new TextEncoder();
const byteLen = (text: string) => encoder.encode(text).length;

function refMap(refs: KgNodeRef[]): DocumentRefMap {
  return {
    docPath: "doc.md",
    docHash: "h",
    vaultStamp: "v",
    refs,
    computedAt: "2026-07-30T00:00:00Z",
  };
}

describe("buildByteToCharTable / byteOffsetToCharIndex", () => {
  it("maps ASCII 1:1", () => {
    const table = buildByteToCharTable("hello");
    expect(table.length).toBe(6);
    expect(byteOffsetToCharIndex(table, 0)).toBe(0);
    expect(byteOffsetToCharIndex(table, 4)).toBe(4);
    expect(byteOffsetToCharIndex(table, 5)).toBe(5);
  });

  it("maps Korean (3-byte) characters to UTF-16 indices", () => {
    const content = "한글 테스트";
    const table = buildByteToCharTable(content);
    // '한' 3 bytes → index 0, '글' starts at byte 3 → index 1
    expect(byteOffsetToCharIndex(table, 0)).toBe(0);
    expect(byteOffsetToCharIndex(table, 3)).toBe(1);
    // '테' starts at byte 7 (한3 글3 공백1) → index 3
    expect(byteOffsetToCharIndex(table, 7)).toBe(3);
    expect(byteOffsetToCharIndex(table, byteLen(content))).toBe(content.length);
  });

  it("maps emoji (4-byte, surrogate pair) correctly", () => {
    const content = "a🙂b";
    const table = buildByteToCharTable(content);
    expect(byteOffsetToCharIndex(table, 0)).toBe(0); // 'a'
    expect(byteOffsetToCharIndex(table, 1)).toBe(1); // '🙂' starts at byte 1 → index 1
    expect(byteOffsetToCharIndex(table, 5)).toBe(3); // 'b' starts at byte 5 → index 3 (surrogate pair = 2 units)
    expect(byteOffsetToCharIndex(table, byteLen(content))).toBe(4);
  });

  it("slices the same substring the backend saw, for mixed multibyte text", () => {
    const content = "# 제목 🙂\n\n본문에 [[Maru Project]] 링크와 한국어 엔티티.";
    const table = buildByteToCharTable(content);
    const target = "[[Maru Project]]";
    const charStart = content.indexOf(target);
    const byteStart = byteLen(content.slice(0, charStart));
    const byteEnd = byteStart + byteLen(target);
    const start = byteOffsetToCharIndex(table, byteStart);
    const end = byteOffsetToCharIndex(table, byteEnd);
    expect(content.slice(start, end)).toBe(target);
  });

  it("clamps out-of-range offsets", () => {
    const table = buildByteToCharTable("ab");
    expect(byteOffsetToCharIndex(table, -5)).toBe(0);
    expect(byteOffsetToCharIndex(table, 999)).toBe(2);
  });
});

describe("refMapToCharSpans", () => {
  it("flattens refs, converts offsets, and sorts by start", () => {
    const content = "한글 [[노트]] 본문 엔티티";
    const wikiStart = content.indexOf("[[노트]]");
    const entityStart = content.indexOf("엔티티");
    const map = refMap([
      {
        nodePath: "notes/note.md",
        nodeTitle: "노트",
        matchKind: "wikilink",
        spans: [
          {
            start: byteLen(content.slice(0, wikiStart)),
            end: byteLen(content.slice(0, wikiStart + "[[노트]]".length)),
            paragraph: 0,
          },
        ],
      },
      {
        nodePath: "notes/entity.md",
        nodeTitle: "엔티티",
        matchKind: "entity",
        spans: [
          {
            start: byteLen(content.slice(0, entityStart)),
            end: byteLen(content.slice(0, entityStart + "엔티티".length)),
            paragraph: 0,
          },
        ],
      },
    ]);
    const spans = refMapToCharSpans(content, map);
    expect(spans).toHaveLength(2);
    expect(spans[0].nodePath).toBe("notes/note.md");
    expect(content.slice(spans[0].start, spans[0].end)).toBe("[[노트]]");
    expect(content.slice(spans[1].start, spans[1].end)).toBe("엔티티");
  });

  it("resolves overlaps: wikilink beats entity at the same start", () => {
    const content = "[[프로젝트]]";
    const span = (kind: "wikilink" | "entity", len: number) => ({
      start: 0,
      end: byteLen(content.slice(0, len)),
      paragraph: 0,
    });
    const map = refMap([
      { nodePath: "a.md", nodeTitle: "a", matchKind: "entity", spans: [span("entity", 3)] },
      { nodePath: "b.md", nodeTitle: "b", matchKind: "wikilink", spans: [span("wikilink", content.length)] },
    ]);
    const spans = refMapToCharSpans(content, map);
    expect(spans).toHaveLength(1);
    expect(spans[0].matchKind).toBe("wikilink");
  });

  it("drops zero-length spans", () => {
    const map = refMap([
      { nodePath: "a.md", nodeTitle: "a", matchKind: "entity", spans: [{ start: 4, end: 4, paragraph: 0 }] },
    ]);
    expect(refMapToCharSpans("abcdef", map)).toHaveLength(0);
  });
});

describe("uniqueRefNodePaths", () => {
  it("dedupes nodes referenced by both match kinds", () => {
    const paths = uniqueRefNodePaths([
      { nodePath: "a.md", nodeTitle: "a", matchKind: "wikilink", spans: [] },
      { nodePath: "a.md", nodeTitle: "a", matchKind: "entity", spans: [] },
      { nodePath: "b.md", nodeTitle: "b", matchKind: "entity", spans: [] },
    ]);
    expect(paths).toEqual(["a.md", "b.md"]);
  });
});

describe("refStepsByParagraph", () => {
  const span = (paragraph: number, start: number) => ({
    start,
    end: start + 4,
    paragraph,
  });

  it("walks paragraphs in document order, deduping per paragraph", () => {
    const steps = refStepsByParagraph([
      {
        nodePath: "a.md",
        nodeTitle: "a",
        matchKind: "wikilink",
        spans: [span(2, 0), span(0, 10), span(0, 20)],
      },
      { nodePath: "b.md", nodeTitle: "b", matchKind: "entity", spans: [span(0, 30)] },
    ]);
    expect(steps).toEqual([
      { paragraph: 0, nodePaths: ["a.md", "b.md"] },
      { paragraph: 2, nodePaths: ["a.md"] },
    ]);
  });

  it("skips paragraphs that cite nothing rather than emitting empty steps", () => {
    const steps = refStepsByParagraph([
      { nodePath: "a.md", nodeTitle: "a", matchKind: "entity", spans: [span(5, 0)] },
    ]);
    expect(steps).toEqual([{ paragraph: 5, nodePaths: ["a.md"] }]);
  });

  it("returns no steps for refs without spans", () => {
    expect(
      refStepsByParagraph([
        { nodePath: "a.md", nodeTitle: "a", matchKind: "entity", spans: [] },
      ]),
    ).toEqual([]);
  });
});

describe("segmentsFromSpans", () => {
  it("splits content into plain and highlighted segments", () => {
    const content = "앞 [[링크]] 뒤";
    const spans = refMapToCharSpans(
      content,
      refMap([
        {
          nodePath: "l.md",
          nodeTitle: "링크",
          matchKind: "wikilink",
          spans: [{ start: byteLen("앞 "), end: byteLen("앞 [[링크]]"), paragraph: 0 }],
        },
      ]),
    );
    const segments = segmentsFromSpans(content, spans);
    expect(segments.map((s) => [s.text, s.span?.matchKind ?? null])).toEqual([
      ["앞 ", null],
      ["[[링크]]", "wikilink"],
      [" 뒤", null],
    ]);
  });
});

describe("spanSearchTexts", () => {
  it("offers raw, alias, then target for wikilinks", () => {
    expect(spanSearchTexts("[[대상|별칭]]", "wikilink")).toEqual(["[[대상|별칭]]", "별칭", "대상"]);
    expect(spanSearchTexts("[[대상]]", "wikilink")).toEqual(["[[대상]]", "대상"]);
  });

  it("offers the raw text for entities", () => {
    expect(spanSearchTexts("엔티티", "entity")).toEqual(["엔티티"]);
  });
});

describe("mapSpansToRenderedText", () => {
  it("maps entity and wikilink spans onto rendered text in order", () => {
    // Source has frontmatter (paragraph 0, stripped by the renderer) and a
    // body with a wikilink (rendered without brackets) plus an entity.
    const content = "---\ntype: meeting\n---\n# 제목\n\n본문 [[Maru Project]] 그리고 인재양성본부 언급.";
    const spans = refMapToCharSpans(
      content,
      refMap([
        {
          nodePath: "maru-project.md",
          nodeTitle: "Maru Project",
          matchKind: "wikilink",
          spans: [
            {
              start: byteLen(content.slice(0, content.indexOf("[["))),
              end: byteLen(content.slice(0, content.indexOf("[[") + "[[Maru Project]]".length)),
              paragraph: 2,
            },
          ],
        },
        {
          nodePath: "hrd.md",
          nodeTitle: "인재양성본부",
          matchKind: "entity",
          spans: [
            {
              start: byteLen(content.slice(0, content.indexOf("인재양성본부"))),
              end: byteLen(content.slice(0, content.indexOf("인재양성본부") + "인재양성본부".length)),
              paragraph: 2,
            },
          ],
        },
      ]),
    );
    const rendered = "제목\n본문 Maru Project 그리고 인재양성본부 언급.";
    const mapped = mapSpansToRenderedText(rendered, spans, (span) => content.slice(span.start, span.end));
    expect(mapped).toHaveLength(2);
    expect(rendered.slice(mapped[0].start, mapped[0].end)).toBe("Maru Project");
    expect(mapped[0].matchKind).toBe("wikilink");
    expect(rendered.slice(mapped[1].start, mapped[1].end)).toBe("인재양성본부");
  });

  it("resolves aliased wikilinks to their alias text", () => {
    const content = "링크 [[maru-project|Maru 사업]] 끝";
    const spans = refMapToCharSpans(
      content,
      refMap([
        {
          nodePath: "maru-project.md",
          nodeTitle: "Maru Project",
          matchKind: "wikilink",
          spans: [
            {
              start: byteLen("링크 "),
              end: byteLen("링크 [[maru-project|Maru 사업]]"),
              paragraph: 0,
            },
          ],
        },
      ]),
    );
    const rendered = "링크 Maru 사업 끝";
    const mapped = mapSpansToRenderedText(rendered, spans, (span) => content.slice(span.start, span.end));
    expect(mapped).toHaveLength(1);
    expect(rendered.slice(mapped[0].start, mapped[0].end)).toBe("Maru 사업");
  });

  it("skips spans missing from the rendered text without desyncing later spans", () => {
    const content = "frontmatter만 [[유령]] 그리고 본문 실체";
    const spans = refMapToCharSpans(
      content,
      refMap([
        {
          nodePath: "ghost.md",
          nodeTitle: "유령",
          matchKind: "wikilink",
          spans: [{ start: byteLen("frontmatter만 "), end: byteLen("frontmatter만 [[유령]]"), paragraph: 0 }],
        },
        {
          nodePath: "real.md",
          nodeTitle: "실체",
          matchKind: "entity",
          spans: [{ start: byteLen(content.slice(0, content.indexOf("실체"))), end: byteLen(content), paragraph: 1 }],
        },
      ]),
    );
    // Renderer stripped everything before "본문".
    const rendered = "본문 실체";
    const mapped = mapSpansToRenderedText(rendered, spans, (span) => content.slice(span.start, span.end));
    expect(mapped).toHaveLength(1);
    expect(mapped[0].nodePath).toBe("real.md");
    expect(rendered.slice(mapped[0].start, mapped[0].end)).toBe("실체");
  });
});

describe("resolveReferenceNodeIds", () => {
  const nodes = [
    { id: "plan", relPath: "notes/plan.md" },
    { id: "people", relPath: "notes/people.md" },
    { id: "ghost", relPath: null },
  ];

  // The regression this exists for: refs come back rooted at the workspace while
  // graph nodes are rooted at the graph's data path. On the primary layout (work
  // repo + nested vault/ submodule) the two differ by one segment, and comparing
  // the relative strings resolved nothing while the UI still claimed a highlight.
  it("matches across a nested vault root", () => {
    const ids = resolveReferenceNodeIds(
      nodes,
      ["vault/notes/plan.md"],
      "/w",
      "/w/vault",
    );
    expect([...ids]).toEqual(["plan"]);
  });

  it("matches when both roots are the same workspace", () => {
    const ids = resolveReferenceNodeIds(nodes, ["notes/people.md"], "/w", "/w");
    expect([...ids]).toEqual(["people"]);
  });

  it("does not match a same-suffix path under a different root", () => {
    const ids = resolveReferenceNodeIds(nodes, ["notes/plan.md"], "/other", "/w/vault");
    expect(ids.size).toBe(0);
  });

  it("ignores ghost nodes and tolerates trailing slashes and backslashes", () => {
    const ids = resolveReferenceNodeIds(
      [...nodes, { id: "win", relPath: "notes\\win.md" }],
      ["vault/notes/win.md"],
      "/w/",
      "/w/vault/",
    );
    expect([...ids]).toEqual(["win"]);
  });

  it("resolves nothing when the graph has no root yet", () => {
    expect(resolveReferenceNodeIds(nodes, ["vault/notes/plan.md"], "/w", null).size).toBe(0);
  });
});
