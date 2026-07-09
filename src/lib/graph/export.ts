// Export the current graph view as SVG or PNG (spec §F2 활용성 — the graph is
// used in slides/docs). Unlike the diagram (inline-styled), graph styling lives
// in CSS classes + design tokens, so we inline computed styles onto a clone,
// then reuse the diagram's SVG→Canvas rasteriser for PNG.

import { blobToUint8Array, rasterise, type ExportResult } from "../diagram/export";

const SVG_NS = "http://www.w3.org/2000/svg";

// Presentation-affecting properties resolved from the live stylesheet. `display`
// is included on purpose — labels are always mounted and CSS-hidden (label LOD),
// so without it every hidden label would leak into the export.
const STYLE_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "opacity", "display", "color", "font-size",
  "font-family", "font-weight", "text-anchor",
];

/** Clone the live <svg>, inline computed styles, and fit a viewBox to content
 *  (getBBox includes visible label extents; hidden labels contribute nothing). */
function cloneWithInlineStyles(live: SVGSVGElement, padding = 60): SVGSVGElement {
  const clone = live.cloneNode(true) as SVGSVGElement;
  const liveEls = live.querySelectorAll<SVGElement>("*");
  const cloneEls = clone.querySelectorAll<SVGElement>("*");
  // cloneNode preserves document order, so the two lists are index-aligned.
  cloneEls.forEach((el, i) => {
    const src = liveEls[i];
    if (!src) return;
    const cs = getComputedStyle(src);
    for (const prop of STYLE_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value) el.style.setProperty(prop, value);
    }
  });

  const inner = live.querySelector<SVGGElement>("g[transform]");
  const box = inner?.getBBox() ?? { x: 0, y: 0, width: 800, height: 600 };
  clone.querySelector<SVGGElement>("g[transform]")?.removeAttribute("transform");

  const x = box.x - padding;
  const y = box.y - padding;
  const w = Math.max(1, box.width + padding * 2);
  const h = Math.max(1, box.height + padding * 2);
  clone.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  clone.setAttribute("width", String(Math.round(w)));
  clone.setAttribute("height", String(Math.round(h)));
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  return clone;
}

export function exportGraphSvg(live: SVGSVGElement): ExportResult {
  const clone = cloneWithInlineStyles(live);
  const text = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${new XMLSerializer().serializeToString(clone)}`;
  const blob = new Blob([text], { type: "image/svg+xml" });
  const vb = clone.getAttribute("viewBox")?.split(/\s+/) ?? [];
  return {
    blob,
    width: parseFloat(vb[2] ?? "0"),
    height: parseFloat(vb[3] ?? "0"),
    mimeType: "image/svg+xml",
    extension: "svg",
  };
}

export async function exportGraphPng(live: SVGSVGElement): Promise<ExportResult> {
  const bg = getComputedStyle(live).backgroundColor || "#ffffff";
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio ?? 1));
  return rasterise(cloneWithInlineStyles(live), "image/png", bg, ratio, 1);
}

/** Browser fallback (and e2e path): trigger a download without a Tauri dialog. */
export function downloadGraphBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

export { blobToUint8Array };
