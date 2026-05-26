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

/** Strip tags and decode entities — best-effort, for serialising back to plain. */
export function htmlToPlainText(html: string): string {
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, "");
  const tmp = document.createElement("div");
  tmp.innerHTML = sanitizeHtml(html);
  return tmp.textContent ?? "";
}
