// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { decoratePreviewHtml } from "./EditorPane";
import type { KgCharSpan } from "../lib/kgRefs";

const NO_DECORATION = {
  kgSpans: null,
  kgSource: "",
  kgTitleFor: () => "",
  findQuery: "",
  findCurrent: 0,
  resolveWikilink: () => true,
};

function kgSpan(start: number, end: number): KgCharSpan {
  return {
    start,
    end,
    paragraph: 0,
    nodePath: "references/glossary.md",
    nodeTitle: 'Glossary "quoted" & <raw>',
    matchKind: "entity",
  };
}

describe("decoratePreviewHtml", () => {
  it("returns the base html untouched when there is nothing to decorate", () => {
    const html = "<p>본문 텍스트</p>";
    // Identity, not just equality: no parse, no serialize, no work at all.
    expect(decoratePreviewHtml(html, NO_DECORATION)).toBe(html);
  });

  it("marks find matches without changing the text", () => {
    const html = "<p>alpha and alpha</p>";
    const out = decoratePreviewHtml(html, { ...NO_DECORATION, findQuery: "alpha" });
    document.body.innerHTML = out;
    expect(document.querySelectorAll("mark.find-mark")).toHaveLength(2);
    expect(document.querySelectorAll("mark.find-mark-current")).toHaveLength(1);
    expect(document.body.textContent).toBe("alpha and alpha");
  });

  it("nests a find match inside a reference mark rather than replacing it", () => {
    const out = decoratePreviewHtml("<p>see alpha here</p>", {
      ...NO_DECORATION,
      kgSpans: [kgSpan(4, 9)],
      kgSource: "see alpha here",
      kgTitleFor: (span) => `${span.nodeTitle} · entity`,
      findQuery: "alpha",
    });
    document.body.innerHTML = out;
    expect(document.querySelectorAll("mark.kg-ref-mark mark.find-mark")).toHaveLength(1);
    expect(document.body.textContent).toBe("see alpha here");
  });

  it("keeps a title containing quotes and angle brackets intact through the round trip", () => {
    // The marks are serialized to a string and reparsed by React, so anything
    // interpolated into an attribute has to survive that.
    const out = decoratePreviewHtml("<p>see alpha here</p>", {
      ...NO_DECORATION,
      kgSpans: [kgSpan(4, 9)],
      kgSource: "see alpha here",
      kgTitleFor: (span) => `${span.nodeTitle} · entity`,
    });
    document.body.innerHTML = out;
    const mark = document.querySelector("mark.kg-ref-mark")!;
    expect(mark.getAttribute("title")).toBe('Glossary "quoted" & <raw> · entity');
    expect(mark.getAttribute("data-kg-node")).toBe("references/glossary.md");
  });

  it("flags only wikilinks that do not resolve", () => {
    const html =
      '<p><a class="wikilink" href="#" data-wikilink="Known">a</a>' +
      '<a class="wikilink" href="#" data-wikilink="Missing">b</a></p>';
    const out = decoratePreviewHtml(html, {
      ...NO_DECORATION,
      resolveWikilink: (target) => target === "Known",
    });
    document.body.innerHTML = out;
    expect(document.querySelector('[data-wikilink="Known"]')!.className).not.toContain(
      "wikilink-missing",
    );
    expect(document.querySelector('[data-wikilink="Missing"]')!.className).toContain(
      "wikilink-missing",
    );
  });

  it("leaves already-sanitized markup byte-identical when it only resolves wikilinks", () => {
    const html = '<p><a class="wikilink" href="#" data-wikilink="Known">a</a> &amp; b</p>';
    const out = decoratePreviewHtml(html, {
      ...NO_DECORATION,
      resolveWikilink: () => true,
    });
    expect(out).toBe(html);
  });
});

describe("decoratePreviewHtml parse context", () => {
  it("keeps a leading head-category element that a document parse would relocate", () => {
    // Parsing as a full text/html document puts a leading <style> in <head>,
    // so returning body.innerHTML would drop it from the preview.
    const html = "<style>p{color:red}</style><p>alpha</p>";
    const out = decoratePreviewHtml(html, { ...NO_DECORATION, findQuery: "alpha" });
    expect(out).toContain("<style>p{color:red}</style>");
    expect(out).toContain("mark");
  });
});
