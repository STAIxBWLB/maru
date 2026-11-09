/** Static conversion of pinned-engine HTML; the HTML is never mounted or executed. */
import DOMPurify from "dompurify";

export type StaticTheme = "light" | "dark";
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";
const PROPERTIES = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "color",
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
  "text-anchor", "dominant-baseline", "paint-order", "marker-start", "marker-mid", "marker-end",
  "stop-color", "stop-opacity", "flood-color", "flood-opacity", "lighting-color", "filter", "clip-path", "mask", "vector-effect",
]);

function cssValue(value: string): boolean {
  if (!value || value.length > 600 || /[<>@\\]|\/\//.test(value) || /\p{Cc}/u.test(value)) return false;
  const localUrlsRemoved = value.replace(/url\(\s*["']?#[A-Za-z0-9_.:-]+["']?\s*\)/gi, "");
  if (/url\s*\(|[A-Za-z][A-Za-z0-9+.-]*:/i.test(localUrlsRemoved)) return false;
  const functions = [...localUrlsRemoved.matchAll(/([A-Za-z-]+)\s*\(/g)].map((match) => match[1]!.toLowerCase());
  return functions.every((name) => ["var", "rgb", "rgba", "hsl", "hsla", "color", "color-mix", "oklch", "oklab", "lab", "lch", "light-dark", "calc", "min", "max", "clamp"].includes(name));
}

function safeDeclarations(style: CSSStyleDeclaration): string {
  const out: string[] = [];
  for (let i = 0; i < style.length; i += 1) {
    const property = style.item(i);
    const value = style.getPropertyValue(property).trim();
    if ((PROPERTIES.has(property) || /^--[a-z0-9-]+$/i.test(property)) && cssValue(value)) {
      out.push(`${property}:${value}`);
    }
  }
  return out.join(";");
}

function embeddedRaster(value: string): boolean {
  if (value.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  let bytes: string;
  try { bytes = atob(value.slice(value.indexOf(",") + 1, value.indexOf(",") + 25)); } catch { return false; }
  if (value.startsWith("data:image/png")) return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes.charCodeAt(index) === byte);
  if (value.startsWith("data:image/jpeg")) return [255, 216, 255].every((byte, index) => bytes.charCodeAt(index) === byte);
  return bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
}

function svgStyles(parsed: Document): string {
  if (typeof CSSStyleSheet === "undefined" || typeof CSSStyleSheet.prototype.replaceSync !== "function") {
    throw new Error("This WebView cannot parse export styles; update the system WebView and retry the engine export.");
  }
  const out: string[] = [];
  for (const style of parsed.querySelectorAll("style")) {
    const sheet = new CSSStyleSheet();
    try { sheet.replaceSync(style.textContent ?? ""); } catch {
      throw new Error("The engine stylesheet could not be parsed; regenerate the semantic diagram or update the WebView, then retry.");
    }
    for (const rule of sheet.cssRules) {
      // Static output needs plain SVG/theme rules only, no imports, fonts,
      // animations, media-dependent viewer state, toolbar or print chrome.
      if (!(rule instanceof CSSStyleRule)) continue;
      const selectors = rule.selectorText.split(",").map((value) => value.trim())
        .filter((value) => /^(?:svg\b|:root\b|\[data-(?:theme|preset)\b|\.[ctam]-[a-z0-9_-]+)/i.test(value)
          && !/:hover|:focus|:active|:has|aria-pressed|data-(?:focus|selected|zoom|animation)/i.test(value));
      const declarations = safeDeclarations(rule.style);
      if (selectors.length && declarations) out.push(`${selectors.join(",")}{${declarations}}`);
    }
  }
  // Remove unused viewer variables, keeping recursive color/theme fallbacks.
  const combined = out.join("\n");
  const declarations = combined.replace(/--[a-z0-9-]+:[^;}]+[;}]?/gi, "");
  const needed = new Set([...`${declarations} ${parsed.querySelector("svg")?.outerHTML ?? ""}`.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1]!));
  needed.add("--bg");
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of combined.matchAll(/(--[a-z0-9-]+):([^;}]+)/gi)) {
      if (!needed.has(match[1]!)) continue;
      for (const dependency of match[2]!.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        if (!needed.has(dependency[1]!)) { needed.add(dependency[1]!); changed = true; }
      }
    }
  }
  return combined.replace(/(--[a-z0-9-]+):([^;}]+);?/gi, (declaration, property: string) => needed.has(property) ? declaration : "");
}

/** Returns only safe standalone SVG. Ambiguous roots are refused, not cropped. */
export function extractEngineSvg(html: string, theme: StaticTheme = "light"): string {
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    throw new Error("The engine artifact exceeds the export budget; reduce the semantic diagram and retry.");
  }
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const roots = parsed.querySelectorAll("svg");
  if (roots.length !== 1) throw new Error("The engine artifact does not have exactly one SVG; regenerate the diagram and retry the export.");
  const source = roots[0]!;
  const dims = (source.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (dims.length !== 4 || dims.some((value) => !Number.isFinite(value)) || dims[2]! <= 0 || dims[3]! <= 0
      || dims[2]! > 8192 || dims[3]! > 8192 || dims[2]! * dims[3]! > 16 * 1024 * 1024) {
    throw new Error("The engine SVG has invalid or oversized dimensions; reduce its viewBox and retry.");
  }
  const css = svgStyles(parsed);
  const preset = source.getAttribute("data-preset") ?? parsed.documentElement.getAttribute("data-preset");
  const safe = DOMPurify.sanitize(source.outerHTML, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "foreignobject", "animate", "animateMotion", "animateTransform", "set", "a", "style"],
    FORBID_ATTR: ["tabindex", "aria-pressed", "autofocus"],
    ALLOW_DATA_ATTR: false,
  });
  const xml = new DOMParser().parseFromString(safe, "image/svg+xml");
  const svg = xml.documentElement;
  if (svg.localName !== "svg" || xml.querySelector("parsererror")) {
    throw new Error("SVG sanitization produced invalid XML; regenerate the diagram and retry.");
  }
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    for (const attr of [...element.attributes]) {
      const name = attr.localName.toLowerCase();
      if (name.startsWith("on") || name.startsWith("data-") || name === "role" && element !== svg) element.removeAttributeNode(attr);
      else if (name === "style") {
        const declaration = document.createElement("span").style;
        declaration.cssText = attr.value;
        element.setAttribute("style", safeDeclarations(declaration));
      } else if (name === "href" && !/^#[A-Za-z0-9_.:-]+$/.test(attr.value) && !embeddedRaster(attr.value)) element.removeAttributeNode(attr);
      else if (["fill", "stroke", "filter", "mask", "clip-path", "marker-start", "marker-mid", "marker-end", "cursor"].includes(name) && !cssValue(attr.value)) element.removeAttributeNode(attr);
    }
  }
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(dims[2]));
  svg.setAttribute("height", String(dims[3]));
  svg.setAttribute("data-theme", theme);
  if (preset && /^[a-z0-9-]{1,48}$/i.test(preset)) svg.setAttribute("data-preset", preset);
  svg.setAttribute("role", "img");
  const style = xml.createElementNS(SVG_NS, "style");
  style.textContent = `${css}\n*{animation:none!important;transition:none!important}`;
  svg.prepend(style);
  const background = xml.createElementNS(SVG_NS, "rect");
  background.setAttribute("x", String(dims[0])); background.setAttribute("y", String(dims[1]));
  background.setAttribute("width", String(dims[2])); background.setAttribute("height", String(dims[3]));
  background.setAttribute("fill", "var(--bg, #ffffff)"); background.setAttribute("aria-hidden", "true");
  svg.insertBefore(background, style.nextSibling);
  const text = new XMLSerializer().serializeToString(svg);
  if (/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\b[A-Za-z]:[\\/]|file:)/i.test(text)) {
    throw new Error("The SVG contains a private filesystem path; remove private paths from the semantic labels and retry.");
  }
  return text;
}

/** Sanitize a standalone Rust SVG before any application DOM use. */
export function sanitizeEngineSvgArtifact(svgText: string, theme: StaticTheme = "light"): string {
  if (new TextEncoder().encode(svgText).length > MAX_HTML_BYTES) {
    throw new Error("The engine SVG exceeds the export budget; reduce the semantic diagram and retry.");
  }
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg"
      || parsed.documentElement.namespaceURI !== SVG_NS || [...parsed.childNodes].filter((node) => node.nodeType === Node.ELEMENT_NODE).length !== 1) {
    throw new Error("The Rust engine did not return one valid SVG root; regenerate the semantic diagram and retry.");
  }
  return extractEngineSvg(svgText, theme);
}
