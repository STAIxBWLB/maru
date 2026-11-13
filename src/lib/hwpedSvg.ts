// The SVG page sanitizer for the hwp editor surface.
//
// @hwp-editor/react paints each rendered page with
// `dangerouslySetInnerHTML: { __html: svgHtml }` (dist/index.js, PageView), and
// the only guard in front of it is the package's own `sanitizeSvg`: a blocklist
// that removes `script`/`foreignObject`, `on*` attributes and `href` values that
// start with `javascript:` after trim and lowercase. It misses SMIL
// `<set attributeName="href" to="javascript:…">`, entity- or whitespace-
// obfuscated schemes that the XML parser decodes before the check sees them,
// `data:` and external `<use>`/`<image>` references, and CSS `url()` values.
//
// The SVG is the engine's render of a `.hwpx` the reader may have received from
// anywhere, and that sink lives in the main webview next to Tauri IPC, so the
// bytes are sanitized here, at the engine boundary, before the package ever
// holds them. check-dom-sanitizer cannot see this sink (it lives in
// node_modules), which is why the wrap is in src/lib/hwped.ts and tested there.

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
