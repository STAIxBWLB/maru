// hwp-editor engine bridge: the published @hwp-editor/core Tauri factory over
// maru's hwped_* Rust commands (src-tauri/src/hwped.rs). The wire types live
// in that package now; nothing here mirrors them. See docs/hwp-editor.md.

import { invoke } from "@tauri-apps/api/core";
import {
  createTauriEngine,
  type DocumentHandle,
  type HwpEngine,
  type CatEnvelope,
} from "@hwp-editor/core";
import { sanitizeHwpedPages } from "./hwpedSvg";
import { normalizeIpcError } from "./ipcError";

export interface HwpedEngineOptions {
  /** Maru's active workspace root; Rust resolves relative document paths
   *  against it on every call. */
  workspaceRoot: string;
  /**
   * Workspace-relative path for a document that already lives on disk. Rust
   * reads it directly when this answers, and receives base64 bytes when it
   * returns undefined, so a surface that only has bytes still works.
   */
  pathOf?: (document: DocumentHandle) => string | undefined;
}

/**
 * One engine per surface. `createTauriEngine` holds no state of its own, but
 * the caller owns the instance so a re-render does not rebuild it.
 *
 * The engine asks `hwped_capabilities` before an edit and sends the
 * `edit-ops-v1` JSON array when the host advertises `editOps: "v1"`, which
 * maru does; the `opsArgv` fallback for older hosts lives inside the package.
 *
 * `render` is wrapped because the package paints each SVG page with
 * `dangerouslySetInnerHTML` behind a blocklist sanitizer. The page bytes are
 * sanitized here, on the way out of the host, so nothing the package's own pass
 * misses can reach that sink (src/lib/hwpedSvg.ts has the details).
 */
export function createHwpedEngine(options: HwpedEngineOptions): HwpEngine {
  const engine = createTauriEngine(invoke, {
    workspaceRoot: options.workspaceRoot,
    ...(options.pathOf === undefined ? {} : { pathOf: options.pathOf }),
  });
  return {
    ...engine,
    render: async (document, renderOptions) =>
      sanitizeHwpedPages(await engine.render(document, renderOptions)),
  };
}

export interface HwpedCapturedSource extends CatEnvelope {
  source: { dataBase64: string; revision: string };
}

/** Capture the selected workspace path once; bytes and baseline are inseparable. */
export async function captureHwpedSource(
  workspaceRoot: string,
  documentPath: string,
): Promise<HwpedCapturedSource> {
  return invoke<HwpedCapturedSource>("hwped_read", {
    workspaceRoot,
    document: { name: documentPath.split("/").pop() ?? "source.hwpx", path: documentPath },
    captureSource: true,
  });
}

export interface HwpedSaveResult {
  revision: string;
  sizeBytes: number;
  snapshotPath: string;
}

/** Host persistence, separate from the published engine's in-memory edits. */
export async function saveHwpedDocument(
  workspaceRoot: string,
  documentPath: string,
  dataBase64: string,
  expectedRevision: string,
): Promise<HwpedSaveResult> {
  try {
    return await invoke<HwpedSaveResult>("hwped_save", {
      workspaceRoot, documentPath, dataBase64, expectedRevision,
    });
  } catch (cause) {
    throw normalizeIpcError(cause);
  }
}
