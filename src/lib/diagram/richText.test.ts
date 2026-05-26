import { describe, expect, it } from "vitest";

import { escapeHtml, plainTextToHtml } from "./richText";

// `sanitizeHtml` + `htmlToPlainText` rely on the DOM (DOMPurify, document.createElement)
// and are exercised in browser/Playwright runs. The pure helpers below are tested here.

describe("richText (pure)", () => {
  it("escapeHtml escapes all five entities", () => {
    expect(escapeHtml("<a href=\"x\" data-x='y'>&</a>")).toBe(
      "&lt;a href=&quot;x&quot; data-x=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("plainTextToHtml turns newlines into <br>", () => {
    expect(plainTextToHtml("line 1\nline 2")).toBe("line 1<br>line 2");
  });

  it("plainTextToHtml escapes raw characters", () => {
    expect(plainTextToHtml("<b>")).toBe("&lt;b&gt;");
  });
});
