/**
 * "Insert/Update in report" flow (Report Pattern Studio Phase 4).
 *
 * Semantic datasets use engine-produced SVG + pixel-ratio-1 PNG with receipts
 * and immutable full-64-hex pair-hash names. Other diagrams retain model SVG
 * + 2x PNG and legacy hash8 names. Both paths write under
 * `attachments/diagrams/<docId>/<scope>-<hash>.{svg,png}` through
 * `diagram_write_report_asset`, then splice a `maru-diagram:v1`
 * managed block (see {@link ./reportLink}) into the target Markdown document
 * through the revision-checked document save path.
 *
 * Failure model: assets are hash-named, so a failure after the asset write
 * leaves harmless orphans and the document's previous block keeps pointing
 * at the previous (untouched) asset. A `document_conflict` from the save is
 * surfaced as-is — the flow never retries automatically.
 *
 * The core ({@link insertDiagramIntoReport}) takes all side effects as
 * injected deps so the flow is unit-testable without Tauri or a canvas;
 * {@link defaultReportInsertDeps} wires the real implementations.
 */

import { readDocument } from "../api";
import { diagramWriteReportAsset } from "../diagram";
import { blobToUint8Array, exportPng } from "./export";
import { IpcError } from "../ipcError";
import { serializeDoc } from "./persistence";
import { renderDocToSvg } from "./renderSvg";
import { bytesSha256, exportVerifiedSemanticArtifact } from "./verifiedExport";
import type { EngineReceipt } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import type { EngineRenderHost } from "./engine";
import { buildManagedBlock, spliceManagedBlock } from "./reportLink";
import type { DiagramDoc } from "./types";

/** Canonical render options baked into the render hash. */
export const REPORT_RENDER_OPTIONS = { padding: 40 } as const;

export interface ReportTarget {
  /** Workspace-relative document path (what `readDocument`/`saveDocument` take). */
  path: string;
  title?: string;
}

export interface ReportInsertDeps {
  writeAsset: (docId: string, fileName: string, bytes: Uint8Array) => Promise<string>;
  readTarget: (path: string) => Promise<{ content: string; revision?: string | null }>;
  saveTarget: (
    path: string,
    content: string,
    expectedRevision: string | null,
  ) => Promise<unknown>;
  renderAssets: (doc: DiagramDoc) => Promise<{ svg: Uint8Array; png: Uint8Array; receipts?: { svg: EngineReceipt; png: EngineReceipt }; storeWarnings?: string[] }>;
  digestHex: (text: string) => Promise<string>;
}

export type ReportInsertOutcome =
  | { status: "inserted"; targetPath: string; storeWarnings?: string[] }
  | { status: "updated"; targetPath: string; storeWarnings?: string[] }
  | { status: "needs-save" }
  | { status: "needs-target" }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

export interface ReportInsertRequest {
  /** Saved diagram file name (null when never saved). */
  diagramName: string | null;
  /** True when the in-memory doc differs from the last saved body. */
  dirty: boolean;
  doc: DiagramDoc;
  /** `pattern:<viewId>` for a single selected view, otherwise `doc`. */
  scope: string;
  /** Target Markdown document; null when the caller must ask the user. */
  target: ReportTarget | null;
  isCurrent?: () => boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sub-doc for a `pattern:<viewId>` scope: only the view's member nodes/edges,
 * so the rendered asset shows the selected view, not the whole canvas. The
 * full doc is returned for the `doc` scope or when the view no longer exists.
 */
export function scopeDocForRender(doc: DiagramDoc, scope: string): DiagramDoc {
  if (!scope.startsWith("pattern:")) return doc;
  const viewId = scope.slice("pattern:".length);
  const view = (doc.views ?? []).find((v) => v.id === viewId);
  if (!view) return doc;
  const nodeIds = new Set(view.nodeIds);
  const edgeIds = new Set(view.edgeIds);
  return {
    ...doc,
    datasets: (doc.datasets ?? []).filter((dataset) => dataset.id === view.datasetId),
    nodes: doc.nodes.filter((node) => nodeIds.has(node.id)),
    edges: doc.edges.filter((edge) => edgeIds.has(edge.id)),
  };
}

function isConflict(err: unknown): boolean {
  return err instanceof IpcError && err.code === "document_conflict";
}

/**
 * Run the insert/update flow. Pure orchestration — every side effect goes
 * through `deps`.
 */
export async function insertDiagramIntoReport(
  request: ReportInsertRequest,
  deps: ReportInsertDeps,
): Promise<ReportInsertOutcome> {
  const { diagramName, dirty, doc, scope, target } = request;
  if (!diagramName || dirty) return { status: "needs-save" };

  let hex: string;
  try {
    hex = await deps.digestHex(serializeDoc(doc) + JSON.stringify(REPORT_RENDER_OPTIONS));
  } catch (err) {
    return { status: "error", message: errorMessage(err) };
  }
  let renderHash = `sha256:${hex}`;
  let fileHash = hex.slice(0, 8);
  const current = () => {
    if (request.isCurrent?.() === false) throw new Error("The source diagram changed during export; save the current diagram and insert it again.");
  };
  // Windows-safe path components: scope may contain ':' (`pattern:<viewId>`,
  // an NTFS alternate-data-stream separator), and an imported doc id is an
  // arbitrary JSON string that could carry newlines/parens which would break
  // the Markdown image line. Block attrs keep the raw scope; only the asset
  // path is sanitized.
  const safeComponent = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "-");
  const fileScope = safeComponent(scope);
  const assetDocId = safeComponent(doc.id) || "doc";

  // Resolve the target before writing assets so a cancelled chooser leaves
  // nothing behind. (The spec orders the asset write first; both orders keep
  // the same failure-safety property because asset files are hash-named.)
  if (!target) return { status: "needs-target" };

  let svgPath: string;
  let pngPath: string;
  let storeWarnings: string[] = [];
  try {
    current();
    const assets = await deps.renderAssets(scopeDocForRender(doc, scope));
    storeWarnings = [...new Set(assets.storeWarnings ?? [])];
    current();
    if (assets.receipts) {
      const { svg, png } = assets.receipts;
      if (svg.outputSha256 !== await bytesSha256(assets.svg) || png.outputSha256 !== await bytesSha256(assets.png)
          || svg.inputSpecSha256 !== png.inputSpecSha256
          || svg.engine.id !== png.engine.id || svg.engine.version !== png.engine.version || svg.engine.revision !== png.engine.revision) {
        throw new Error("Report artifact receipts do not match their bytes or semantic source; regenerate the engine exports before inserting.");
      }
      hex = await deps.digestHex(JSON.stringify({ svg: svg.outputSha256, png: png.outputSha256, input: svg.inputSpecSha256, engine: svg.engine }));
      renderHash = `sha256:${hex}`;
      fileHash = hex;
    }
    current();
    svgPath = await deps.writeAsset(assetDocId, `${fileScope}-${fileHash}.svg`, assets.svg);
    current();
    pngPath = await deps.writeAsset(assetDocId, `${fileScope}-${fileHash}.png`, assets.png);
  } catch (err) {
    return { status: "error", message: errorMessage(err) };
  }

  const block = buildManagedBlock({
    source: `diagrams/${diagramName}.cmd.json`,
    scope,
    assetPath: svgPath,
    fallbackPath: pngPath,
    renderHash,
    caption: doc.docTitle.trim() || diagramName,
  });

  try {
    current();
    const fresh = await deps.readTarget(target.path);
    current();
    const spliced = spliceManagedBlock(fresh.content, block, {
      source: `diagrams/${diagramName}.cmd.json`,
      scope,
    });
    await deps.saveTarget(target.path, spliced.content, fresh.revision ?? null);
    return spliced.mode === "updated"
      ? { status: "updated", targetPath: target.path, ...(storeWarnings.length ? { storeWarnings } : {}) }
      : { status: "inserted", targetPath: target.path, ...(storeWarnings.length ? { storeWarnings } : {}) };
  } catch (err) {
    const message = errorMessage(err);
    return isConflict(err)
      ? { status: "conflict", message }
      : { status: "error", message };
  }
}

// ---------------------------------------------------------------------------
// Real implementations (Tauri + Canvas2D)
// ---------------------------------------------------------------------------

/** hex(sha256(text)) via Web Crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Render the model to standalone SVG bytes + 2x PNG bytes. */
export async function renderReportAssets(
  doc: DiagramDoc,
): Promise<{ svg: Uint8Array; png: Uint8Array }> {
  const rendered = renderDocToSvg(doc, REPORT_RENDER_OPTIONS);
  const svgText = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${rendered.svg}`;
  // The live-svg parameter is deprecated — exports derive from the model.
  const png = await exportPng(null as unknown as SVGSVGElement, doc, {
    padding: REPORT_RENDER_OPTIONS.padding,
    pixelRatio: 2,
  });
  return {
    svg: new TextEncoder().encode(svgText),
    png: await blobToUint8Array(png.blob),
  };
}

/**
 * Wire the real deps. `saveTarget` is the app-provided callback so Diagram
 * mode stays decoupled from the editor's save path; reads go through the
 * standard `readDocument` wrapper.
 */
export function defaultReportInsertDeps(
  workspace: string,
  saveTarget: ReportInsertDeps["saveTarget"],
  renderHost?: EngineRenderHost,
): ReportInsertDeps {
  return {
    writeAsset: (docId, fileName, bytes) =>
      diagramWriteReportAsset(workspace, docId, fileName, bytes),
    readTarget: async (path) => {
      const payload = await readDocument(workspace, path);
      return { content: payload.content, revision: payload.revision ?? null };
    },
    saveTarget,
    renderAssets: async (doc) => {
      const datasets = (doc.datasets ?? []).filter((dataset) => dataset.kind === "semanticSpec");
      if (!datasets.length) return renderReportAssets(doc);
      const svg = await exportVerifiedSemanticArtifact({ doc, workspace, format: "svg", host: renderHost });
      const png = await exportVerifiedSemanticArtifact({ doc, workspace, format: "png", host: renderHost });
      const storeWarnings = [...new Set([svg.storeWarning, png.storeWarning].filter((value): value is string => Boolean(value)))];
      return { svg: svg.bytes, png: png.bytes, receipts: { svg: svg.receipt, png: png.receipt }, ...(storeWarnings.length ? { storeWarnings } : {}) };
    },
    digestHex: sha256Hex,
  };
}
