/**
 * Pure helpers for the Safe WYSIWYG HTML Editing feature.
 *
 * The module is deliberately free of Tauri imports: asset URL conversion is
 * injected via the `toAssetUrl` parameter so everything stays unit-testable.
 * Functions that need DOM APIs (`buildRuntimeDocument`, `stripRuntimeNodes`,
 * and the DOMParser branch of `checkVisualLimits`) must run in a DOM
 * environment (browser webview or jsdom); the rest are environment-agnostic.
 */

export type HtmlEnvelopeKind = "full" | "fragment" | "malformed";

export interface HtmlEnvelope {
  kind: HtmlEnvelopeKind;
  /** Everything through the `<body...>` open tag (doctype, `<html>`, `<head>`,
   *  body attributes). "" for fragment/malformed. */
  prefix: string;
  /** Inner HTML of body (full) or the whole content (fragment/malformed). */
  bodyInner: string;
  /** `</body>` to EOF. "" for fragment/malformed. */
  suffix: string;
}

/** Visual editor limits. */
export const HTML_VISUAL_MAX_BYTES = 2 * 1024 * 1024;
export const HTML_VISUAL_MAX_NODES = 20_000;

/** CSP injected into the runtime document. Asset loading is limited to the
 *  Tauri asset protocol plus data:/blob: URLs; everything else is denied. */
const RUNTIME_CSP =
  "default-src 'none'; img-src data: blob: asset: http://asset.localhost; " +
  "style-src 'unsafe-inline' asset: http://asset.localhost; " +
  "font-src data: asset: http://asset.localhost; " +
  "media-src data: blob: asset: http://asset.localhost";

/** Case-insensitive html/htm file-kind check. */
export function isHtmlFileKind(fileKind: string | null | undefined): boolean {
  if (typeof fileKind !== "string") return false;
  const kind = fileKind.toLowerCase();
  return kind === "html" || kind === "htm";
}

/**
 * Split an HTML body-content string into prefix / bodyInner / suffix.
 *
 * Matches the FIRST `<body\b[^>]*>` open tag and the LAST `</body\s*>`
 * close tag (both case-insensitive). The last close tag is chosen so a
 * stray `</body>` inside a script string does not truncate the envelope;
 * typical documents have exactly one of each anyway.
 *
 * - Both tags found, close after open -> "full"; prefix and suffix are exact
 *   substrings, so `prefix + bodyInner + suffix === content` byte-for-byte.
 * - No usable body tags but `<html` or `<head` present -> "malformed"
 *   (bodyInner = content, prefix/suffix = "").
 * - Otherwise -> "fragment" (bodyInner = content).
 */
/** True when `index` falls inside an HTML comment (`<!-- ... -->`). Used so a
 *  `<body>`/`</body>` written inside a head comment cannot mis-place the
 *  envelope boundary. An unterminated comment swallows the rest of the file. */
function isInsideComment(content: string, index: number): boolean {
  const open = content.lastIndexOf("<!--", index);
  if (open === -1) return false;
  const close = content.indexOf("-->", open);
  return close === -1 || close + 3 > index;
}

export function analyzeHtmlEnvelope(content: string): HtmlEnvelope {
  // Quote-aware open tag: an attribute value may legally contain `>` inside
  // quotes (`<body data-x=">">`), so skip quoted spans rather than stopping at
  // the first `>`. Comment-guarded so `<!-- <body> -->` is ignored.
  const openRe = /<body\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
  let openMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(content)) !== null) {
    if (!isInsideComment(content, m.index)) {
      openMatch = m;
      break;
    }
  }
  if (openMatch) {
    const openEnd = openMatch.index + openMatch[0].length;
    const closeRe = /<\/body\s*>/gi;
    let lastClose: RegExpExecArray | null = null;
    let c: RegExpExecArray | null;
    while ((c = closeRe.exec(content)) !== null) {
      if (c.index >= openEnd && !isInsideComment(content, c.index)) lastClose = c;
    }
    if (lastClose) {
      return {
        kind: "full",
        prefix: content.slice(0, openEnd),
        bodyInner: content.slice(openEnd, lastClose.index),
        suffix: content.slice(lastClose.index),
      };
    }
  }
  if (/<html[\s>]/i.test(content) || /<head[\s>]/i.test(content)) {
    return { kind: "malformed", prefix: "", bodyInner: content, suffix: "" };
  }
  return { kind: "fragment", prefix: "", bodyInner: content, suffix: "" };
}

/** Reassemble a document from an envelope and a (possibly edited) body. */
export function joinHtmlEnvelope(parts: HtmlEnvelope, newBodyInner: string): string {
  if (parts.kind === "full") return parts.prefix + newBodyInner + parts.suffix;
  return newBodyInner;
}

export type RiskyMarkupCategory =
  | "script"
  | "event-handler"
  | "custom-element"
  | "form"
  | "embedded"
  | "meta-refresh"
  | "base";

const RISKY_PATTERNS: Array<[RiskyMarkupCategory, RegExp]> = [
  ["script", /<script\b/i],
  // `[\s/]` so slash-separated handlers (`<img/onerror=...>`) are caught too.
  ["event-handler", /[\s/]on\w+\s*=/i],
  ["custom-element", /<[a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]*/],
  ["form", /<form\b/i],
  ["embedded", /<(?:iframe|frame|object|embed)\b/i],
  ["meta-refresh", /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i],
  ["base", /<base\b/i],
];

/**
 * Return the category keys of risky markup present in `content`, in the
 * stable order: script, event-handler, custom-element, form, embedded,
 * meta-refresh, base. Categories not present are omitted.
 */
export function detectRiskyMarkup(content: string): string[] {
  const found: string[] = [];
  for (const [key, re] of RISKY_PATTERNS) {
    if (re.test(content)) found.push(key);
  }
  return found;
}

/**
 * True when the body contains markup `buildRuntimeDocument` removes or strips
 * destructively (scripts, event handlers, embedded frames/objects, forms,
 * meta-refresh, base). A Visual round-trip serializes `body.innerHTML` after
 * that stripping, so such markup would be silently dropped from the saved
 * file — the caller must keep those documents Source-only. `custom-element`
 * survives serialization untouched and is intentionally excluded.
 */
export function bodyHasUnpreservableMarkup(bodyInner: string): boolean {
  return detectRiskyMarkup(bodyInner).some((category) => category !== "custom-element");
}

const UNSAFE_URL_RE = /^\s*(?:javascript:|vbscript:|data:text\/html)/i;

/**
 * Strip inline `on*` event handlers, `javascript:`/`vbscript:`/`data:text/html`
 * URLs, and `<script>` from an editable DOM subtree. Run on paste and again
 * before serialization so hostile markup a user pasted (or that slipped
 * through execCommand) never reaches the saved file. The Visual iframe sandbox
 * already makes it inert in-app; this keeps the persisted bytes safe for a
 * normal browser too.
 */
export function sanitizeEditableFragment(root: ParentNode): void {
  root.querySelectorAll("script").forEach((el) => el.remove());
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) {
        el.removeAttribute(attr.name);
      } else if (
        (attr.name === "src" || attr.name === "href" || attr.name === "xlink:href") &&
        UNSAFE_URL_RE.test(attr.value)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * Check whether `content` fits the visual editor limits. Bytes are checked
 * first (UTF-8 encoded length), then node count. Node count uses DOMParser
 * when available; in non-DOM environments (plain node/vitest) it falls back
 * to counting tag opens via `/<[a-zA-Z][^<>]*>/g`, which is an approximation
 * (it also counts tags inside raw-text elements like <script>/<style>).
 */
export function checkVisualLimits(
  content: string,
): { ok: true } | { ok: false; reason: "bytes" | "nodes" } {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > HTML_VISUAL_MAX_BYTES) return { ok: false, reason: "bytes" };
  let nodes: number;
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(content, "text/html");
    nodes = doc.getElementsByTagName("*").length;
    // getElementsByTagName does not descend into <template>.content, so a
    // template packed with nodes would otherwise bypass the cap.
    for (const tpl of Array.from(doc.getElementsByTagName("template"))) {
      nodes += (tpl as HTMLTemplateElement).content.querySelectorAll("*").length;
    }
  } else {
    const matches = content.match(/<[a-zA-Z][^<>]*>/g);
    nodes = matches ? matches.length : 0;
  }
  if (nodes > HTML_VISUAL_MAX_NODES) return { ok: false, reason: "nodes" };
  return { ok: true };
}

/** FNV-1a 32-bit hash of `content`, as 8 lowercase hex chars. Stable. */
export function digestSource(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

type UrlClass = "preserve" | "block" | "resolve";

function classifyUrl(raw: string): UrlClass {
  const value = raw.trim();
  if (value === "") return "preserve";
  const lower = value.toLowerCase();
  if (lower.startsWith("data:") || lower.startsWith("blob:")) return "preserve";
  if (value.startsWith("#")) return "preserve";
  if (value.startsWith("//")) return "block";
  // Any explicit scheme (http:, https:, javascript:, file:, ...) is blocked.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return "block";
  return "resolve";
}

/**
 * True when a value recorded in a `data-maru-orig-*` marker is the kind of URL
 * `buildRuntimeDocument` actually rewrites (a scheme-less relative reference).
 * Restoration trusts the marker only when this holds, so an author-forged
 * marker carrying a `javascript:` or remote value cannot be promoted back onto
 * a real `src`/`href` at serialization time.
 */
export function isRestorableAssetOriginal(original: string): boolean {
  return classifyUrl(original) === "resolve";
}

/** Normalize an absolute-ish path: resolve `.` and `..` segments, collapse
 *  duplicate slashes. `..` may pop above the root; workspace containment is
 *  enforced backend-side, so this is purely lexical. */
export function normalizeAbsolutePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return "/" + out.join("/");
}

function httpEquivIs(el: Element, value: string): boolean {
  return (el.getAttribute("http-equiv") ?? "").trim().toLowerCase() === value;
}

export interface BuildRuntimeDocumentResult {
  html: string;
  blockedAssets: number;
  rewrittenAssets: number;
}

/**
 * Build a runtime-only iframe srcdoc string from the FULL raw HTML content.
 * The result is sanitized (scripts, on* handlers, meta refresh, embedded
 * frames/objects, document <base> and CSP metas removed; forms neutralized)
 * and relative asset URLs are rewritten through `toAssetUrl`. Injected
 * runtime nodes (`<base>` + CSP `<meta>`) carry `data-maru-runtime` so they
 * can be stripped again by `stripRuntimeNodes`.
 *
 * Requires a DOM environment (DOMParser). Side-effect free: operates only on
 * the parsed document.
 */
export function buildRuntimeDocument(
  content: string,
  opts: {
    documentDirectory: string | null;
    toAssetUrl?: (absPath: string) => string;
  },
): BuildRuntimeDocumentResult {
  if (typeof DOMParser === "undefined") {
    throw new Error("buildRuntimeDocument requires a DOM environment (DOMParser)");
  }
  const { documentDirectory, toAssetUrl } = opts;
  const doc = new DOMParser().parseFromString(content, "text/html");

  // Remove scripts, embedded frames/objects, document <base>, meta refresh,
  // and document CSP metas.
  for (const el of Array.from(
    doc.querySelectorAll("script, frame, iframe, object, embed, base"),
  )) {
    el.remove();
  }
  for (const meta of Array.from(doc.querySelectorAll("meta[http-equiv]"))) {
    if (httpEquivIs(meta, "refresh") || httpEquivIs(meta, "content-security-policy")) {
      meta.remove();
    }
  }

  // Strip all on* event-handler attributes.
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }

  // Neutralize forms: mark them and drop submission behavior.
  for (const form of Array.from(doc.querySelectorAll("form"))) {
    form.setAttribute("data-maru-form", "");
    form.removeAttribute("action");
    form.removeAttribute("onsubmit");
  }

  // Rewrite asset URLs.
  let blockedAssets = 0;
  let rewrittenAssets = 0;
  const canResolve = documentDirectory !== null && toAssetUrl !== undefined;
  const baseDir = documentDirectory?.replace(/\/+$/, "") ?? "";
  for (const el of Array.from(doc.querySelectorAll("[src],[href]"))) {
    for (const attrName of ["src", "href"] as const) {
      const raw = el.getAttribute(attrName);
      if (raw === null) continue;
      const cls = classifyUrl(raw);
      if (cls === "preserve") continue;
      if (cls === "block") {
        el.removeAttribute(attrName);
        blockedAssets++;
        continue;
      }
      // Relative (incl. ./, ../, and root-absolute /...) URL.
      if (!canResolve) continue; // leave unchanged, uncounted
      const resolved = normalizeAbsolutePath(baseDir + "/" + raw.trim().replace(/^\/+/, ""));
      const normBase = normalizeAbsolutePath(baseDir);
      // Containment: a `../` escape out of the document's own directory must
      // not be rewritten into an asset URL — a previously-opened doc may have
      // authorized the sibling dir, so this would leak cross-document reads.
      if (resolved !== normBase && !resolved.startsWith(normBase + "/")) {
        el.removeAttribute(attrName);
        blockedAssets++;
        continue;
      }
      // Keep the original URL so serialization can restore it — rewritten
      // asset URLs are runtime-only and must never be persisted.
      el.setAttribute(`data-maru-orig-${attrName}`, raw);
      el.setAttribute(attrName, toAssetUrl(resolved));
      rewrittenAssets++;
    }
  }

  // Inject runtime <base> (only when asset resolution is configured) and CSP.
  const head = doc.head ?? doc.documentElement;
  if (canResolve) {
    const base = doc.createElement("base");
    base.setAttribute("data-maru-runtime", "");
    base.setAttribute("href", toAssetUrl(baseDir + "/"));
    head.prepend(base);
  }
  const csp = doc.createElement("meta");
  csp.setAttribute("data-maru-runtime", "");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", RUNTIME_CSP);
  head.prepend(csp);

  return {
    html: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML,
    blockedAssets,
    rewrittenAssets,
  };
}

/** Remove all `[data-maru-runtime]` descendants. Injected runtime nodes live
 *  in `<head>`, so this is only used against a full document, never the body
 *  clone (which would only ever delete author content). */
export function stripRuntimeNodes(container: HTMLElement): void {
  for (const el of Array.from(container.querySelectorAll("[data-maru-runtime]"))) {
    el.remove();
  }
}

/**
 * Restore original asset URLs / form attributes on a cloned BODY so runtime
 * rewrites never get serialized, then sanitize. Never strips by
 * `data-maru-runtime`: the injected base/CSP nodes live in `<head>` and are
 * out of the body clone, so a marker found here can only be author content.
 *
 * A `data-maru-orig-*` marker is trusted only when its recorded value is a
 * relative reference (`isRestorableAssetOriginal`), so a forged marker cannot
 * promote `javascript:`/remote onto a real attribute. Finally the fragment is
 * sanitized (on* handlers, unsafe URLs, scripts) so pasted markup never reaches
 * disk.
 */
export function restoreSerializedBody(clone: HTMLElement): void {
  for (const attr of ["src", "href"] as const) {
    clone.querySelectorAll(`[data-maru-orig-${attr}]`).forEach((el) => {
      const original = el.getAttribute(`data-maru-orig-${attr}`);
      if (original != null && isRestorableAssetOriginal(original)) {
        el.setAttribute(attr, original);
      }
      el.removeAttribute(`data-maru-orig-${attr}`);
    });
  }
  clone.querySelectorAll("[data-maru-form]").forEach((el) => {
    el.removeAttribute("data-maru-form");
  });
  sanitizeEditableFragment(clone);
}

/**
 * Produce the text to persist for a visual-editing session.
 * - `dirty === false`: return `originalDraft` EXACTLY (byte-identical).
 * - otherwise: reassemble `frontmatter + envelope(prefix + bodyInner + suffix)`.
 */
export function serializeVisualBody(opts: {
  originalDraft: string;
  envelope: HtmlEnvelope;
  frontmatter: string;
  dirty: boolean;
  bodyInner: string;
}): string {
  const { originalDraft, envelope, frontmatter, dirty, bodyInner } = opts;
  if (!dirty) return originalDraft;
  return frontmatter + joinHtmlEnvelope(envelope, bodyInner);
}
