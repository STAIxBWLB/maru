import { invoke } from "@tauri-apps/api/core";
import type { CatEnvelope } from "@hwp-editor/core";
import { normalizeIpcError } from "./ipcError";

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
