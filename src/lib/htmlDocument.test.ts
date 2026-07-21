// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  HTML_VISUAL_MAX_BYTES,
  HTML_VISUAL_MAX_NODES,
  analyzeHtmlEnvelope,
  buildRuntimeDocument,
  checkVisualLimits,
  detectRiskyMarkup,
  digestSource,
  isHtmlFileKind,
  joinHtmlEnvelope,
  normalizeAbsolutePath,
  serializeVisualBody,
  stripRuntimeNodes,
} from "./htmlDocument";
import { splitFrontmatter } from "./wikilinks";

const FULL_DOC =
  "<!DOCTYPE html>\n" +
  '<html lang="en">\n' +
  "<head>\n" +
  "<style>body { color: red; }</style>\n" +
  '<script>console.log("head")</script>\n' +
  "</head>\n" +
  '<body class="x" onload="e()">\n' +
  "<p>Hello</p>\n" +
  "</body>\n" +
  "</html>\n";

describe("isHtmlFileKind", () => {
  it("accepts html/htm case-insensitively", () => {
    expect(isHtmlFileKind("html")).toBe(true);
    expect(isHtmlFileKind("htm")).toBe(true);
    expect(isHtmlFileKind("HTML")).toBe(true);
    expect(isHtmlFileKind("Htm")).toBe(true);
  });

  it("rejects non-html kinds and empty/undefined-ish values", () => {
    expect(isHtmlFileKind("md")).toBe(false);
    expect(isHtmlFileKind("markdown")).toBe(false);
    expect(isHtmlFileKind("")).toBe(false);
    expect(isHtmlFileKind(undefined)).toBe(false);
    expect(isHtmlFileKind(null)).toBe(false);
  });
});

describe("analyzeHtmlEnvelope", () => {
  it("splits a full document into exact prefix/bodyInner/suffix", () => {
    const env = analyzeHtmlEnvelope(FULL_DOC);
    expect(env.kind).toBe("full");
    expect(env.prefix).toContain("<!DOCTYPE html>");
    expect(env.prefix).toContain("<style>body { color: red; }</style>");
    expect(env.prefix.endsWith('<body class="x" onload="e()">')).toBe(true);
    expect(env.bodyInner).toBe("\n<p>Hello</p>\n");
    expect(env.suffix).toBe("</body>\n</html>\n");
    expect(env.prefix + env.bodyInner + env.suffix).toBe(FULL_DOC);
  });

  it("matches uppercase <BODY> and mixed-case </Body>", () => {
    const content = "<HTML><BODY><p>hi</p></Body></HTML>";
    const env = analyzeHtmlEnvelope(content);
    expect(env.kind).toBe("full");
    expect(env.prefix).toBe("<HTML><BODY>");
    expect(env.bodyInner).toBe("<p>hi</p>");
    expect(env.suffix).toBe("</Body></HTML>");
    expect(env.prefix + env.bodyInner + env.suffix).toBe(content);
  });

  it("treats body-less markup without html/head as a fragment", () => {
    const env = analyzeHtmlEnvelope("<p>hi</p>");
    expect(env).toEqual({
      kind: "fragment",
      prefix: "",
      bodyInner: "<p>hi</p>",
      suffix: "",
    });
  });

  it("flags html/head markup without a body tag as malformed", () => {
    const content = "<html><head></head>";
    const env = analyzeHtmlEnvelope(content);
    expect(env).toEqual({
      kind: "malformed",
      prefix: "",
      bodyInner: content,
      suffix: "",
    });
  });
});

describe("joinHtmlEnvelope", () => {
  it("round-trips a full envelope", () => {
    const env = analyzeHtmlEnvelope(FULL_DOC);
    expect(joinHtmlEnvelope(env, env.bodyInner)).toBe(FULL_DOC);
    expect(joinHtmlEnvelope(env, "<p>New</p>")).toBe(
      env.prefix + "<p>New</p>" + env.suffix,
    );
  });

  it("returns just the body for fragments and malformed docs", () => {
    const fragment = analyzeHtmlEnvelope("<p>hi</p>");
    expect(joinHtmlEnvelope(fragment, "<p>bye</p>")).toBe("<p>bye</p>");
    const malformed = analyzeHtmlEnvelope("<html><head></head>");
    expect(joinHtmlEnvelope(malformed, "<p>recovered</p>")).toBe("<p>recovered</p>");
  });
});

describe("frontmatter interplay", () => {
  it("envelopes only the body part after splitFrontmatter", () => {
    const draft = "---\ntitle: x\n---\n" + FULL_DOC;
    const [frontmatter, bodyContent] = splitFrontmatter(draft);
    expect(frontmatter).toBe("---\ntitle: x\n---\n");
    const env = analyzeHtmlEnvelope(bodyContent);
    expect(env.kind).toBe("full");
    expect(
      serializeVisualBody({
        originalDraft: draft,
        envelope: env,
        frontmatter,
        dirty: false,
        bodyInner: "ignored",
      }),
    ).toBe(draft);
  });
});

describe("detectRiskyMarkup", () => {
  it("detects every category in stable order", () => {
    const content = [
      '<script src="x.js"></script>',
      "<div onclick=\"f()\"></div>",
      "<my-widget></my-widget>",
      "<form action='/x'></form>",
      '<iframe src="y"></iframe>',
      '<meta http-equiv="refresh" content="5">',
      '<base href="/">',
    ].join("\n");
    expect(detectRiskyMarkup(content)).toEqual([
      "script",
      "event-handler",
      "custom-element",
      "form",
      "embedded",
      "meta-refresh",
      "base",
    ]);
  });

  it("detects embedded variants and is case-insensitive", () => {
    expect(detectRiskyMarkup("<OBJECT data='x'></OBJECT>")).toEqual(["embedded"]);
    expect(detectRiskyMarkup("<embed src='x'>")).toEqual(["embedded"]);
    expect(detectRiskyMarkup("<frame src='x'>")).toEqual(["embedded"]);
    expect(detectRiskyMarkup('<SCRIPT>1</SCRIPT>')).toEqual(["script"]);
    expect(detectRiskyMarkup('<META HTTP-EQUIV=refresh content="0">')).toEqual([
      "meta-refresh",
    ]);
  });

  it("returns [] for a clean document", () => {
    expect(detectRiskyMarkup("<p>Hello <b>world</b></p>")).toEqual([]);
  });
});

describe("digestSource", () => {
  it("is stable and changes with the input", () => {
    const digest = digestSource(FULL_DOC);
    expect(digest).toBe(digestSource(FULL_DOC));
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    expect(digestSource(FULL_DOC + "x")).not.toBe(digest);
  });
});

describe("checkVisualLimits", () => {
  it("accepts small documents", () => {
    expect(checkVisualLimits("<p>hi</p>")).toEqual({ ok: true });
  });

  it("rejects content over the byte limit", () => {
    const tooBig = "a".repeat(HTML_VISUAL_MAX_BYTES + 1);
    expect(checkVisualLimits(tooBig)).toEqual({ ok: false, reason: "bytes" });
  });

  it("rejects documents over the node limit", () => {
    const tooManyNodes = "<i></i>".repeat(HTML_VISUAL_MAX_NODES + 1);
    expect(checkVisualLimits(tooManyNodes)).toEqual({ ok: false, reason: "nodes" });
  });
});

describe("buildRuntimeDocument", () => {
  const toAssetUrl = (p: string) => "asset://" + p;
  const content = [
    "<!DOCTYPE html>",
    "<html><head>",
    '<meta http-equiv="refresh" content="5">',
    '<meta http-equiv="Content-Security-Policy" content="default-src *">',
    '<base href="https://evil.example/">',
    '<link rel="stylesheet" href="styles/site.css">',
    "</head>",
    '<body onload="track()">',
    "<script>alert(1)</script>",
    '<iframe src="https://ads.example/x"></iframe>',
    '<form action="/submit" onsubmit="go()"><input name="q"></form>',
    '<img src="images/a.png">',
    '<img src="https://remote.example/x.png">',
    '<img src="data:image/png;base64,AAAA">',
    '<a href="javascript:evil()">x</a>',
    '<img src="../../etc/secret.png">',
    "</body></html>",
  ].join("\n");

  it("sanitizes risky markup, rewrites assets, and injects runtime nodes", () => {
    const result = buildRuntimeDocument(content, {
      documentDirectory: "/ws/docs/pages",
      toAssetUrl,
    });
    const html = result.html;

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);

    // Removed markup.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("onload");
    expect(html).not.toContain('content="5"');
    expect(html).not.toContain("default-src *");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("onsubmit");

    // Form neutralized.
    expect(html).toContain('data-maru-form=""');
    expect(html).not.toContain('action="/submit"');

    // Injected runtime nodes carry data-maru-runtime.
    expect(html).toContain('<meta data-maru-runtime="" http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<base data-maru-runtime="" href="asset:///ws/docs/pages/">');

    // Relative assets rewritten through toAssetUrl.
    expect(html).toContain('href="asset:///ws/docs/pages/styles/site.css"');
    expect(html).toContain('src="asset:///ws/docs/pages/images/a.png"');

    // Original URLs recorded so serialization can restore them (rewrites are
    // runtime-only and must never be persisted).
    expect(html).toContain('data-maru-orig-href="styles/site.css"');
    expect(html).toContain('data-maru-orig-src="images/a.png"');

    // ../.. escapes are normalized lexically (containment is backend-side).
    expect(html).toContain('src="asset:///ws/etc/secret.png"');

    // Remote and javascript: URLs blocked; data: preserved.
    expect(html).not.toContain("remote.example");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="data:image/png;base64,AAAA"');

    expect(result.blockedAssets).toBe(2);
    expect(result.rewrittenAssets).toBe(3);
  });

  it("leaves relative URLs unchanged and skips <base> without resolution config", () => {
    const result = buildRuntimeDocument('<img src="images/a.png">', {
      documentDirectory: null,
      toAssetUrl,
    });
    expect(result.html).toContain('src="images/a.png"');
    expect(result.html).not.toContain("<base");
    expect(result.html).toContain("data-maru-runtime"); // CSP meta still injected
    expect(result.rewrittenAssets).toBe(0);
    expect(result.blockedAssets).toBe(0);
  });

  it("works for fragments without html/head/body", () => {
    const result = buildRuntimeDocument('<p>hi <img src="a.png"></p>', {
      documentDirectory: "/ws",
      toAssetUrl,
    });
    expect(result.html).toContain("<p>hi");
    expect(result.html).toContain('src="asset:///ws/a.png"');
    expect(result.rewrittenAssets).toBe(1);
  });
});

describe("normalizeAbsolutePath", () => {
  it("resolves dot segments lexically", () => {
    expect(normalizeAbsolutePath("/ws/docs/./a.png")).toBe("/ws/docs/a.png");
    expect(normalizeAbsolutePath("/ws/docs/pages/../../etc/x.png")).toBe(
      "/ws/etc/x.png",
    );
    expect(normalizeAbsolutePath("/ws//docs//a.png")).toBe("/ws/docs/a.png");
  });
});

describe("stripRuntimeNodes", () => {
  it("removes data-maru-runtime descendants only", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p>keep</p><span data-maru-runtime="">drop</span>' +
      '<section><b data-maru-runtime="x">drop too</b></section>';
    stripRuntimeNodes(container);
    expect(container.querySelectorAll("[data-maru-runtime]").length).toBe(0);
    expect(container.querySelector("p")?.textContent).toBe("keep");
    expect(container.querySelector("section")?.innerHTML).toBe("");
  });
});

describe("serializeVisualBody", () => {
  const draft = "---\ntitle: x\n---\n" + FULL_DOC;
  const [frontmatter, bodyContent] = splitFrontmatter(draft);
  const envelope = analyzeHtmlEnvelope(bodyContent);

  it("returns the original draft byte-identical when not dirty", () => {
    const out = serializeVisualBody({
      originalDraft: draft,
      envelope,
      frontmatter,
      dirty: false,
      bodyInner: "<p>edited but not dirty</p>",
    });
    expect(out).toBe(draft);
  });

  it("reassembles frontmatter + envelope with the new body when dirty", () => {
    const out = serializeVisualBody({
      originalDraft: draft,
      envelope,
      frontmatter,
      dirty: true,
      bodyInner: "\n<p>New</p>\n",
    });
    expect(out).toBe(
      frontmatter + envelope.prefix + "\n<p>New</p>\n" + envelope.suffix,
    );
    expect(out.startsWith("---\ntitle: x\n---\n<!DOCTYPE html>")).toBe(true);
  });
});
