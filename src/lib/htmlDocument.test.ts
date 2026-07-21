// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  HTML_VISUAL_MAX_BYTES,
  HTML_VISUAL_MAX_NODES,
  analyzeHtmlEnvelope,
  bodyHasUnpreservableMarkup,
  buildRuntimeDocument,
  checkVisualLimits,
  detectRiskyMarkup,
  digestSource,
  isHtmlFileKind,
  isRestorableAssetOriginal,
  joinHtmlEnvelope,
  normalizeAbsolutePath,
  restoreSerializedBody,
  sanitizeEditableFragment,
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

  it("handles a quoted > in the body open tag and a <body> in a head comment (ADD-3)", () => {
    const content =
      '<html><head><!-- <body> old --></head><body data-x="a>b"><p>hi</p></body></html>';
    const env = analyzeHtmlEnvelope(content);
    expect(env.kind).toBe("full");
    expect(env.prefix).toBe('<html><head><!-- <body> old --></head><body data-x="a>b">');
    expect(env.bodyInner).toBe("<p>hi</p>");
    expect(env.suffix).toBe("</body></html>");
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

describe("bodyHasUnpreservableMarkup", () => {
  it("flags body markup a Visual round-trip would silently drop", () => {
    expect(bodyHasUnpreservableMarkup("<script>x()</script><p>hi</p>")).toBe(true);
    expect(bodyHasUnpreservableMarkup('<iframe src="y"></iframe>')).toBe(true);
    expect(bodyHasUnpreservableMarkup('<div onclick="f()">x</div>')).toBe(true);
    expect(bodyHasUnpreservableMarkup("<form action='/x'></form>")).toBe(true);
    expect(bodyHasUnpreservableMarkup('<object data="x"></object>')).toBe(true);
    expect(bodyHasUnpreservableMarkup('<base href="/">')).toBe(true);
  });

  it("allows clean bodies and custom elements (which survive serialization)", () => {
    expect(bodyHasUnpreservableMarkup("<p>Hello <b>world</b></p>")).toBe(false);
    expect(bodyHasUnpreservableMarkup("<my-widget>x</my-widget>")).toBe(false);
  });
});

describe("sanitizeEditableFragment", () => {
  it("strips on* handlers, unsafe URLs, and <script> but keeps safe content", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<img src="x" onerror="alert(1)">' +
      '<a href="javascript:evil()">a</a>' +
      '<a href="vbscript:bad()">b</a>' +
      '<img src="data:text/html,<script>1</script>">' +
      "<script>window.x=1</script>" +
      '<img src="data:image/png;base64,AAAA">' +
      '<a href="page.html">rel</a>';
    sanitizeEditableFragment(root);
    const html = root.innerHTML;
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("vbscript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("<script");
    // Safe data:image and relative URLs untouched.
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain('href="page.html"');
  });
});

describe("isRestorableAssetOriginal", () => {
  it("trusts only scheme-less relative references", () => {
    expect(isRestorableAssetOriginal("images/a.png")).toBe(true);
    expect(isRestorableAssetOriginal("./a.png")).toBe(true);
    expect(isRestorableAssetOriginal("../a.png")).toBe(true);
    expect(isRestorableAssetOriginal("/root/a.png")).toBe(true);
    // Forged / non-rewritten originals are rejected.
    expect(isRestorableAssetOriginal("javascript:evil()")).toBe(false);
    expect(isRestorableAssetOriginal("https://remote.example/x")).toBe(false);
    expect(isRestorableAssetOriginal("data:image/png;base64,AAAA")).toBe(false);
    expect(isRestorableAssetOriginal("//cdn.example/x")).toBe(false);
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

    // ../.. escapes out of the document directory are BLOCKED, not rewritten.
    expect(html).not.toContain("/ws/etc/secret.png");
    expect(html).not.toContain("secret.png");

    // Remote and javascript: URLs blocked; data: preserved.
    expect(html).not.toContain("remote.example");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="data:image/png;base64,AAAA"');

    // Blocked: remote + javascript + the ../.. escape. Rewritten: site.css + a.png.
    expect(result.blockedAssets).toBe(3);
    expect(result.rewrittenAssets).toBe(2);
  });

  it("blocks a relative asset that escapes the document directory (ADD-1)", () => {
    const result = buildRuntimeDocument(
      '<img src="../private/secret.png"><img src="sibling.png">',
      { documentDirectory: "/vault/public", toAssetUrl },
    );
    // The escaping ../private ref is stripped; the in-dir sibling is rewritten.
    expect(result.html).not.toContain("secret.png");
    expect(result.html).toContain('src="asset:///vault/public/sibling.png"');
    expect(result.blockedAssets).toBe(1);
    expect(result.rewrittenAssets).toBe(1);
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

describe("restoreSerializedBody", () => {
  it("restores relative asset origs, drops forged ones, and keeps author content (ADD-2/F4)", () => {
    const clone = document.createElement("div");
    clone.innerHTML =
      '<img src="asset://x/a.png" data-maru-orig-src="a.png">' +
      '<img src="asset://x/y.png" data-maru-orig-src="javascript:evil()">' +
      // A body element authored with data-maru-runtime must survive: the
      // injected runtime nodes live in <head>, never here.
      '<span data-maru-runtime="">keep me</span>' +
      '<form data-maru-form=""><input></form>';
    restoreSerializedBody(clone);
    // Relative orig restored, marker gone.
    const imgs = clone.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("a.png");
    expect(imgs[0].hasAttribute("data-maru-orig-src")).toBe(false);
    // Forged javascript: orig NOT promoted (runtime asset value left as-is,
    // marker still stripped).
    expect(imgs[1].getAttribute("src")).not.toContain("javascript:");
    expect(imgs[1].hasAttribute("data-maru-orig-src")).toBe(false);
    // Author's data-maru-runtime element is not deleted.
    expect(clone.querySelector("span")?.textContent).toBe("keep me");
    // Form marker cleared.
    expect(clone.querySelector("form")?.hasAttribute("data-maru-form")).toBe(false);
  });

  it("strips pasted on* handlers / scripts before serialization (F3)", () => {
    const clone = document.createElement("div");
    clone.innerHTML = '<img src="a" onerror="alert(1)"><script>x=1</script><p>ok</p>';
    restoreSerializedBody(clone);
    expect(clone.innerHTML).not.toContain("onerror");
    expect(clone.innerHTML).not.toContain("<script");
    expect(clone.querySelector("p")?.textContent).toBe("ok");
  });
});

describe("checkVisualLimits template bypass (ADD-6)", () => {
  it("counts <template> content toward the node cap", () => {
    const inner = "<i></i>".repeat(HTML_VISUAL_MAX_NODES + 1);
    const content = `<template>${inner}</template>`;
    expect(checkVisualLimits(content)).toEqual({ ok: false, reason: "nodes" });
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
