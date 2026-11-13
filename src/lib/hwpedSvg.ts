// The SVG page sanitizer for the hwp editor surface.
//
// @hwp-editor/react 1.4.0 paints a rendered page as an <img> whose source is
// `data:image/svg+xml;base64,…` (dist/index.js, pageData), so the markup only
// ever becomes an image document and a script inside it never runs against the
// main webview. That was not true in 1.3.0, whose PageView used
// `dangerouslySetInnerHTML: { __html: svgHtml }` there; the package's own
// `sanitizeSvg` (still exported, deprecated) was the only guard, and it is a
// blocklist that misses SMIL `<set attributeName="href" to="javascript:…">`,
// entity- or whitespace-obfuscated schemes that the XML parser decodes before
// the check sees them, `data:` and external `<use>`/`<image>` references, and
// CSS `url()` values.
//
// The pages are still the engine's render of a `.hwpx` the reader may have
// received from anywhere, so this pass stays at the engine boundary: with 1.4.0
// it is defence in depth rather than the guard in front of a live sink (see
// docs/hwp-editor.md §Frontend for why it is kept rather than retired).
// check-dom-sanitizer scans maru's own sinks and cannot see one inside
// node_modules, which is why the wrap is tested in src/lib/hwped.test.ts.

import DOMPurify from "dompurify";
import type { PageImage } from "@hwp-editor/core";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A page that cannot be sanitized paints blank: an empty document is still SVG,
 *  and the package's own sanitizer answers "" for a parse failure anyway. */
const EMPTY_PAGE = `<svg xmlns="${SVG_NS}"/>`;

// Same profile and tag discipline as sanitizeEngineSvgArtifact in
// src/lib/diagram/engineSvg.ts. That function is not reused: it is bound to the
// diagram artifact contract, which requires a viewBox and replaces every `style`
// attribute it accepts with the diagram's font-feature-settings string, so an
// editor page would be rejected or restyled rather than passed through.
const PURIFY_OPTIONS = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [
    "script",
    "foreignObject",
    "foreignobject",
    "animate",
    "animateMotion",
    "animateTransform",
    "set",
    "a",
    "style",
    "iframe",
    "object",
    "embed",
  ],
  FORBID_ATTR: ["autofocus", "tabindex", "xml:base", "style"],
  ALLOW_DATA_ATTR: false,
};

const URL_ATTRS = [
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
];

/** A paint or reference value with no fetch of its own: local `url(#id)` plus
 *  colour and length functions. Anything scheme-like or `//`-prefixed is out. */
function cssValue(value: string): boolean {
  if (!value || value.length > 600 || /[<>@\\]|\/\//.test(value) || /\p{Cc}/u.test(value)) {
    return false;
  }
  const withoutLocalUrls = value.replace(/url\(\s*["']?#[A-Za-z0-9_.:-]+["']?\s*\)/gi, "");
  if (/url\s*\(|[A-Za-z][A-Za-z0-9+.-]*:/i.test(withoutLocalUrls)) return false;
  const functions = [...withoutLocalUrls.matchAll(/([A-Za-z-]+)\s*\(/g)].map((match) =>
    match[1]!.toLowerCase(),
  );
  return functions.every((name) =>
    [
      "var",
      "rgb",
      "rgba",
      "hsl",
      "hsla",
      "color",
      "color-mix",
      "oklch",
      "oklab",
      "lab",
      "lch",
      "light-dark",
      "calc",
      "min",
      "max",
      "clamp",
    ].includes(name),
  );
}

/** A raster an `<image>` can paint. Narrower than engineSvg.ts's embeddedRaster
 *  on purpose: that one also sniffs the raster's magic bytes, because the export
 *  artifact ships the bytes as a file; this one bounds the scheme, the media
 *  type and the size, because the value only ever reaches an image element. */
function rasterDataUrl(value: string): boolean {
  return (
    value.length <= 2 * 1024 * 1024 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function rootNode(svgText: string): Element | null {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = parsed.documentElement;
  if (parsed.querySelector("parsererror") !== null) return null;
  if (root.localName !== "svg" || root.namespaceURI !== SVG_NS) return null;
  return root;
}

/**
 * DOMPurify's SVG profile, then the scrub it leaves undone: the profile drops
 * script, SMIL animation and `on*` handlers but keeps external `href` and
 * `url()` references, which is the whole gap in the package's blocklist.
 */
export function sanitizeHwpedPageSvg(svgText: string): string {
  const purified = DOMPurify.sanitize(svgText, PURIFY_OPTIONS);
  const root = rootNode(purified);
  if (root === null) return EMPTY_PAGE;
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith("on") || name === "src" || name === "base") {
        element.removeAttributeNode(attribute);
      } else if (
        name === "href" &&
        !/^#[A-Za-z0-9_.:-]+$/.test(attribute.value) &&
        !rasterDataUrl(attribute.value)
      ) {
        element.removeAttributeNode(attribute);
      } else if (URL_ATTRS.includes(name) && !cssValue(attribute.value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }
  root.setAttribute("xmlns", SVG_NS);
  return new XMLSerializer().serializeToString(root);
}

/**
 * Every `format: "svg"` page, sanitized and re-encoded; raster pages pass
 * through untouched.
 */
export function sanitizeHwpedPages(pages: PageImage[]): PageImage[] {
  return pages.map((page) => {
    if (page.format !== "svg") return page;
    const text = new TextDecoder().decode(page.data);
    return { ...page, data: new TextEncoder().encode(sanitizeHwpedPageSvg(text)) };
  });
}
