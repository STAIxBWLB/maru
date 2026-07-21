/**
 * "Insert/Update in report" flow (Report Pattern Studio Phase 4).
 *
 * Renders the saved diagram to SVG + 2x PNG, writes both under
 * `attachments/diagrams/<docId>/<scope>-<hash8>.{svg,png}` via the
 * `diagram_write_report_asset` command, then splices a `maru-diagram:v1`
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
import { serializeDoc } from "./persistence";
import { renderDocToSvg } from "./renderSvg";
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
  renderAssets: (doc: DiagramDoc) => Promise<{ svg: Uint8Array; png: Uint8Array }>;
  digestHex: (text: string) => Promise<string>;
}

export type ReportInsertOutcome =
  | { status: "inserted"; targetPath: string }
  | { status: "updated"; targetPath: string }
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
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isConflict(message: string): boolean {
  return message.includes("document_conflict");
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
  const renderHash = `sha256:${hex}`;
  const hash8 = hex.slice(0, 8);

  // Resolve the target before writing assets so a cancelled chooser leaves
  // nothing behind. (The spec orders the asset write first; both orders keep
  // the same failure-safety property because asset files are hash-named.)
  if (!target) return { status: "needs-target" };

  let svgPath: string;
  let pngPath: string;
  try {
    const assets = await deps.renderAssets(doc);
    svgPath = await deps.writeAsset(doc.id, `${scope}-${hash8}.svg`, assets.svg);
    pngPath = await deps.writeAsset(doc.id, `${scope}-${hash8}.png`, assets.png);
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
    const fresh = await deps.readTarget(target.path);
    const spliced = spliceManagedBlock(fresh.content, block, {
      source: `diagrams/${diagramName}.cmd.json`,
      scope,
    });
    await deps.saveTarget(target.path, spliced.content, fresh.revision ?? null);
    return spliced.mode === "updated"
      ? { status: "updated", targetPath: target.path }
      : { status: "inserted", targetPath: target.path };
  } catch (err) {
    const message = errorMessage(err);
    return isConflict(message)
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
): ReportInsertDeps {
  return {
    writeAsset: (docId, fileName, bytes) =>
      diagramWriteReportAsset(workspace, docId, fileName, bytes),
    readTarget: async (path) => {
      const payload = await readDocument(workspace, path);
      return { content: payload.content, revision: payload.revision ?? null };
    },
    saveTarget,
    renderAssets: renderReportAssets,
    digestHex: sha256Hex,
  };
}
