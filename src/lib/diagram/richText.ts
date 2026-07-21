/**
 * Rich-text helpers — DOMPurify wrapper + plain-text round-tripper.
 *
 * The source HTML editor's `esc()` (concept-map-diagram.html line 2902) only
 * escapes `&<>`, leaking `'`/`"` and creating a 109-site `innerHTML=` attack
 * surface. We replace it with a single sanitizer here so any place we need to
 * render user-authored HTML (memos, future rich-text node bodies) goes through
 * the same allowlist.
 *
 * Today the canvas uses plain React text — React already escapes everything,
 * so we don't need DOMPurify for rendering. We expose it so Phase 6+ rich-text
 * features have one place to extend.
 */

import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["b", "strong", "i", "em", "u", "s", "br", "span", "p", "ul", "ol", "li"];
const ALLOWED_ATTR = ["style"];

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    USE_PROFILES: { html: true },
  });
}

/** Escape `<`, `>`, `&`, `"`, `'` so the string is safe inside HTML markup. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

/** Convert a plain string with `\n` line breaks into safe-for-rendering HTML. */
export function plainTextToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/**
 * Accept only plain CSS color forms: `#hex`, a bare color name, or
 * `rgb()/rgba()/hsl()/hsla()` with numeric-ish args. Style values ride in from
 * imported diagram JSON and pasted HTML, and are interpolated into exported
 * SVG attributes — anything fancier (`url(...)`, `expression`, markup chars)
 * returns undefined so callers fall back to their default.
 */
const CSS_COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|(?:rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/-]{0,48}\))$/;

export function sanitizeCssColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return CSS_COLOR_RE.test(trimmed) ? trimmed : undefined;
}

/** Strip tags and decode entities — best-effort, for serialising back to plain. */
export function htmlToPlainText(html: string): string {
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, "");
  const tmp = document.createElement("div");
  tmp.innerHTML = sanitizeHtml(html);
  return tmp.textContent ?? "";
}
