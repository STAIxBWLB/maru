import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export interface DiagramFile {
  name: string;
  size: number;
  modifiedAt: number;
  docTitle: string;
}

export interface DiagramSnapshotMeta {
  docId: string;
  snapshotTs: string;
  size: number;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function diagramSaveDocument(
  workspace: string,
  name: string,
  body: string,
): Promise<void> {
  if (!isTauri()) throw new Error("diagram_save_document_requires_tauri");
  return invoke<void>("diagram_save_document", { workspace, name, body });
}

export async function diagramLoadDocument(
  workspace: string,
  name: string,
): Promise<string> {
  if (!isTauri()) throw new Error("diagram_load_document_requires_tauri");
  return invoke<string>("diagram_load_document", { workspace, name });
}

export async function diagramListDocuments(workspace: string): Promise<DiagramFile[]> {
  if (!isTauri()) return [];
  return invoke<DiagramFile[]>("diagram_list_documents", { workspace });
}

export async function diagramDeleteDocument(
  workspace: string,
  name: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("diagram_delete_document", { workspace, name });
}

export async function diagramExportBlob(
  workspace: string,
  name: string,
  kind: "png" | "jpg" | "svg" | "json" | "pdf" | "mmd",
  bytes: Uint8Array,
): Promise<string> {
  if (!isTauri()) throw new Error("diagram_export_blob_requires_tauri");
  return invoke<string>("diagram_export_blob", {
    workspace,
    name,
    kind,
    bytes: Array.from(bytes),
  });
}

export async function diagramSaveSnapshot(
  workspace: string,
  docId: string,
  snapshotTs: string,
  content: string,
): Promise<DiagramSnapshotMeta> {
  if (!isTauri()) throw new Error("diagram_save_snapshot_requires_tauri");
  return invoke<DiagramSnapshotMeta>("diagram_save_snapshot", {
    workspace,
    docId,
    snapshotTs,
    content,
  });
}

export async function diagramListSnapshots(
  workspace: string,
  docId: string,
): Promise<DiagramSnapshotMeta[]> {
  if (!isTauri()) return [];
  return invoke<DiagramSnapshotMeta[]>("diagram_list_snapshots", {
    workspace,
    docId,
  });
}

export async function diagramRestoreSnapshot(
  workspace: string,
  docId: string,
  snapshotTs: string,
): Promise<string> {
  if (!isTauri()) throw new Error("diagram_restore_snapshot_requires_tauri");
  return invoke<string>("diagram_restore_snapshot", {
    workspace,
    docId,
    snapshotTs,
  });
}
