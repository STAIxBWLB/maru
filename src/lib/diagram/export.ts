/**
 * Diagram exports — PNG / PNG-transparent / JPEG / SVG / JSON / PDF.
 *
 * Phase 4 ships a pure SVG→Canvas2D path so the main bundle stays slim
 * (no html2canvas dep needed for an all-SVG canvas). The exporter renders the
 * document model via {@link renderDocToSvg} — a pure, culling-free renderer —
 * and rasterises via an Image+Canvas trip. Phase 6 may swap in html2canvas if
 * `<foreignObject>` rich-text export reveals platform gaps.
 *
 * The `liveSvg` parameters on the export entry points are deprecated: they
 * are accepted for API compatibility with existing callers (the unified
 * ImportExportDialog passes null) but no longer read — exports derive purely
 * from the {@link DiagramDoc} model so off-screen (culled) nodes and
 * interactive chrome can no longer leak or go missing.
 *
 * All helpers return a Blob (or Uint8Array for the Tauri bridge) so callers
 * can hand the bytes to a save dialog without further conversion.
 */

import { serializeDoc } from "./persistence";
import { validateArchifySpecPreCheck } from "./validation";
import { renderDocToSvg, type RenderedDiagramSvg } from "./renderSvg";
import type { DiagramDoc } from "./types";
import type { SemanticDiagramType, SemanticSpecDataset } from "./reportTypes";

export type ExportFormat = "png" | "png-transparent" | "jpg" | "svg" | "json" | "pdf";

/** Test-only lazy boundary for the isolated native SVG/PNG engine artifacts. */
export async function renderEngineArtifactForTest(
  input: import("./engineArtifactForTest").EngineArtifactRequest,
  host?: import("./engineArtifactForTest").EngineArtifactHost,
): Promise<import("./engineArtifactForTest").EngineArtifactReport> {
  if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") {
    throw new Error("Native engine artifact rendering is disabled in this build; use the isolated geometry test build.");
  }
  const { renderEngineArtifactForTest: render } = await import("./engineArtifactForTest");
  return render(input, host);
}

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

function renderStandalone(doc: DiagramDoc, padding: number): RenderedDiagramSvg {
  return renderDocToSvg(doc, { padding });
}

/** Parse a rendered SVG string back into an element for the rasteriser. */
function svgTextToElement(svgText: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const el = parsed.documentElement;
  if (!(el instanceof SVGSVGElement) || el.tagName.toLowerCase() !== "svg") {
    throw new Error("svg_render_failed");
  }
  return el;
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
  void liveSvg; // Deprecated — the model is the source of truth.
  const rendered = renderStandalone(doc, opts.padding ?? 40);
  const ratio = opts.pixelRatio ?? Math.min(2, Math.max(1, window.devicePixelRatio ?? 1));
  return rasterise(svgTextToElement(rendered.svg), "image/png", opts.background ?? "#ffffff", ratio, 1);
}

export async function exportPngTransparent(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  opts: ExportOpts = {},
): Promise<ExportResult> {
  void liveSvg;
  const rendered = renderStandalone(doc, opts.padding ?? 40);
  const ratio = opts.pixelRatio ?? Math.min(2, Math.max(1, window.devicePixelRatio ?? 1));
  return rasterise(svgTextToElement(rendered.svg), "image/png", null, ratio, 1);
}

export async function exportJpg(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  opts: ExportOpts = {},
): Promise<ExportResult> {
  void liveSvg;
  const rendered = renderStandalone(doc, opts.padding ?? 40);
  const ratio = opts.pixelRatio ?? Math.min(2, Math.max(1, window.devicePixelRatio ?? 1));
  return rasterise(svgTextToElement(rendered.svg), "image/jpeg", opts.background ?? "#ffffff", ratio, 0.92);
}

export function exportSvg(
  liveSvg: SVGSVGElement,
  doc: DiagramDoc,
  opts: ExportOpts = {},
): ExportResult {
  void liveSvg;
  const rendered = renderStandalone(doc, opts.padding ?? 40);
  const text = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${rendered.svg}`;
  const blob = new Blob([text], { type: "image/svg+xml" });
  return {
    blob,
    width: rendered.width,
    height: rendered.height,
    mimeType: "image/svg+xml",
    extension: "svg",
  };
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
  void liveSvg;
  const rendered = renderStandalone(doc, opts.padding ?? 40);
  const printWindow = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
  if (!printWindow) {
    throw new Error("print_popup_blocked");
  }
  const titleEsc = doc.docTitle.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  printWindow.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${titleEsc || "Diagram"}</title>` +
      "<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff}" +
      "svg{max-width:100%;height:auto}@media print{body{min-height:auto}}</style></head><body>" +
      rendered.svg +
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

/** Only the diagram types implemented by the current pinned Archify engine. */
export const ARCHIFY_STATIC_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
export function supportsArchifyStaticExport(type: string): boolean {
  return ARCHIFY_STATIC_TYPES.some((supported) => supported === type);
}

/** The engine consumes one stored semantic spec, never canvas/editor state. */
export interface CanonicalSemanticExportInput {
  datasetId: string;
  diagramType: SemanticDiagramType;
  candidateJson: string;
}

export function canonicalSemanticExportInput(
  doc: DiagramDoc,
  datasetId?: string,
): CanonicalSemanticExportInput {
  const datasets = (doc.datasets ?? []).filter(
    (dataset): dataset is SemanticSpecDataset => dataset.kind === "semanticSpec",
  );
  const dataset = datasetId ? datasets.find((item) => item.id === datasetId)
    : datasets.length === 1 ? datasets[0] : undefined;
  if (!dataset) {
    throw new Error("A semantic dataset was not selected; select the diagram's semantic dataset and retry the engine export.");
  }
  if (!supportsArchifyStaticExport(dataset.diagramType)) {
    throw new Error("The pinned Archify engine does not render this diagram type; select a supported semantic dataset or export its source JSON.");
  }
  const validation = validateArchifySpecPreCheck(dataset.diagramType, dataset.spec);
  if (!validation.ok) {
    throw new Error(`The semantic spec cannot be exported (${validation.diagnostics.map((item) => item.key).join(", ")}); repair or regenerate the semantic dataset and retry.`);
  }
  return { datasetId: dataset.id, diagramType: dataset.diagramType, candidateJson: JSON.stringify(dataset.spec) };
}
