/**
 * Diagram exports — PNG / PNG-transparent / JPEG / SVG / JSON / PDF.
 *
 * Phase 4 ships a pure SVG→Canvas2D path so the main bundle stays slim
 * (no html2canvas dep needed for an all-SVG canvas). The exporter clones
 * the live `<svg>`, rewrites its viewport-transform group to identity,
 * sets a `viewBox` derived from the doc bounding box, and rasterises via
 * an Image+Canvas trip. Phase 6 may swap in html2canvas if `<foreignObject>`
 * rich-text export reveals platform gaps.
 *
 * All helpers return a Blob (or Uint8Array for the Tauri bridge) so callers
 * can hand the bytes to a save dialog without further conversion.
 */

import { bbox } from "./geometry";
import { serializeDoc } from "./persistence";
import type { DiagramDoc } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

export type ExportFormat = "png" | "png-transparent" | "jpg" | "svg" | "json" | "pdf";

export interface ExportOpts {
  /** Padding (canvas-space px) around the diagram's bounding box. */
  padding?: number;
  /** Override pixel density (1 = native). */
  pixelRatio?: number;
  /** Background fill for PNG/JPG (ignored for png-transparent). */
  background?: string;
  /** Override output width in CSS px. */
  width?: number;
  /** Override output height in CSS px. */
  height?: number;
}

export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
  extension: string;
}

export function suggestedFileName(doc: DiagramDoc, ext: string): string {
  const slugSource = doc.docTitle.trim() || "diagram";
  const slug = slugSource.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${slug || "diagram"}.${ext}`;
}

export async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

function computeViewBox(doc: DiagramDoc, padding: number) {
  const box = bbox(doc.nodes);
  if (!box) return { x: 0, y: 0, w: 800, h: 600 };
  return {
    x: box.x - padding,
    y: box.y - padding,
    w: Math.max(1, box.w + padding * 2),
    h: Math.max(1, box.h + padding * 2),
  };
}

/** Clone the live <svg> into a standalone, transform-free, viewBox-fitted node. */
function cloneStandaloneSvg(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  padding: number,
): SVGSVGElement {
  const out = liveSvg.cloneNode(true) as SVGSVGElement;
  // Strip the marquee / smart-guide / connect-ghost overlays so exports look clean.
  out.querySelectorAll("[data-export-ignore]").forEach((el) => el.remove());
  // Reset the pan/zoom transform on the inner content group so the exported
  // viewBox aligns with canvas-space coordinates.
  const inner = out.querySelector("g[transform]");
  if (inner) inner.removeAttribute("transform");
  const { x, y, w, h } = computeViewBox(doc, padding);
  out.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  out.setAttribute("width", String(w));
  out.setAttribute("height", String(h));
  out.setAttribute("xmlns", SVG_NS);
  out.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  return out;
}

function serializeSvgElement(svg: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svg);
}

function svgToBlobUrl(svgText: string): { url: string; revoke: () => void } {
  const blob = new Blob([svgText], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = url;
  });
}

export async function rasterise(
  svg: SVGSVGElement,
  mime: "image/png" | "image/jpeg",
  background: string | null,
  pixelRatio: number,
  qualityForJpeg: number,
): Promise<ExportResult> {
  const svgText = serializeSvgElement(svg);
  const { url, revoke } = svgToBlobUrl(svgText);
  try {
    const img = await loadImage(url);
    const viewBox = svg.getAttribute("viewBox")?.split(/\s+/);
    const w = viewBox ? parseFloat(viewBox[2] ?? "0") : img.width;
    const h = viewBox ? parseFloat(viewBox[3] ?? "0") : img.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * pixelRatio));
    canvas.height = Math.max(1, Math.round(h * pixelRatio));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas2D context unavailable");
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, qualityForJpeg),
    );
    if (!blob) throw new Error("Canvas toBlob failed");
    const ext = mime === "image/jpeg" ? "jpg" : "png";
    return { blob, width: canvas.width, height: canvas.height, mimeType: mime, extension: ext };
  } finally {
    revoke();
  }
}

export async function exportPng(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  opts: ExportOpts = {},
): Promise<ExportResult> {
  const padding = opts.padding ?? 40;
  const ratio = opts.pixelRatio ?? Math.min(2, Math.max(1, window.devicePixelRatio ?? 1));
  const standalone = cloneStandaloneSvg(liveSvg, doc, padding);
  return rasterise(standalone, "image/png", opts.background ?? "#ffffff", ratio, 1);
}

export async function exportPngTransparent(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  opts: ExportOpts = {},
): Promise<ExportResult> {
  const padding = opts.padding ?? 40;
  const ratio = opts.pixelRatio ?? Math.min(2, Math.max(1, window.devicePixelRatio ?? 1));
  const standalone = cloneStandaloneSvg(liveSvg, doc, padding);
  return rasterise(standalone, "image/png", null, ratio, 1);
}

export async function exportJpg(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  opts: ExportOpts = {},
): Promise<ExportResult> {
  const padding = opts.padding ?? 40;
  const ratio = opts.pixelRatio ?? Math.min(2, Math.max(1, window.devicePixelRatio ?? 1));
  const standalone = cloneStandaloneSvg(liveSvg, doc, padding);
  return rasterise(standalone, "image/jpeg", opts.background ?? "#ffffff", ratio, 0.92);
}

export function exportSvg(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  opts: ExportOpts = {},
): ExportResult {
  const padding = opts.padding ?? 40;
  const standalone = cloneStandaloneSvg(liveSvg, doc, padding);
  const text = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${serializeSvgElement(standalone)}`;
  const blob = new Blob([text], { type: "image/svg+xml" });
  const viewBox = standalone.getAttribute("viewBox")?.split(/\s+/);
  const w = viewBox ? parseFloat(viewBox[2] ?? "0") : 800;
  const h = viewBox ? parseFloat(viewBox[3] ?? "0") : 600;
  return { blob, width: w, height: h, mimeType: "image/svg+xml", extension: "svg" };
}

export function exportJson(doc: DiagramDoc): ExportResult {
  const text = serializeDoc(doc);
  const blob = new Blob([text], { type: "application/json" });
  return { blob, width: 0, height: 0, mimeType: "application/json", extension: "json" };
}

/**
 * Open a print window with the diagram inlined; the user picks "Save as PDF"
 * from the platform's print dialog. We deliberately avoid bundling a heavyweight
 * PDF library — the platform-native PDF writer covers the common case fine.
 */
export async function exportPdf(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  opts: ExportOpts = {},
): Promise<void> {
  const padding = opts.padding ?? 40;
  const standalone = cloneStandaloneSvg(liveSvg, doc, padding);
  const text = serializeSvgElement(standalone);
  const printWindow = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
  if (!printWindow) {
    throw new Error("print_popup_blocked");
  }
  const titleEsc = doc.docTitle.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  printWindow.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${titleEsc || "Diagram"}</title>` +
      "<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff}" +
      "svg{max-width:100%;height:auto}@media print{body{min-height:auto}}</style></head><body>" +
      text +
      "</body></html>",
  );
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    try {
      printWindow.print();
    } catch {
      /* ignore — user can use the menu */
    }
  }, 250);
}
