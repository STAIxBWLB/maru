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

const MOCK_DIAGRAM_PREFIX = "maru:diagram:mock-documents:";

function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function mockStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function mockDocumentPrefix(workspace: string): string {
  return `${MOCK_DIAGRAM_PREFIX}${encodeURIComponent(workspace)}:`;
}

function mockDocumentKey(workspace: string, name: string): string {
  return `${mockDocumentPrefix(workspace)}${encodeURIComponent(name)}`;
}

function extractDocTitle(body: string): string {
  try {
    const parsed = JSON.parse(body) as { docTitle?: unknown };
    return typeof parsed.docTitle === "string" ? parsed.docTitle : "";
  } catch {
    return "";
  }
}

export async function diagramSaveDocument(
  workspace: string,
  name: string,
  body: string,
): Promise<void> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) throw new Error("diagram_save_document_requires_tauri");
    storage.setItem(
      mockDocumentKey(workspace, name),
      JSON.stringify({ body, modifiedAt: Date.now() }),
    );
    return;
  }
  return invoke<void>("diagram_save_document", { workspace, name, body });
}

export async function diagramLoadDocument(
  workspace: string,
  name: string,
): Promise<string> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) throw new Error("diagram_load_document_requires_tauri");
    const raw = storage.getItem(mockDocumentKey(workspace, name));
    if (!raw) throw new Error(`Diagram not found: ${name}`);
    const parsed = JSON.parse(raw) as { body?: unknown };
    if (typeof parsed.body !== "string") throw new Error(`Diagram not found: ${name}`);
    return parsed.body;
  }
  return invoke<string>("diagram_load_document", { workspace, name });
}

export async function diagramListDocuments(workspace: string): Promise<DiagramFile[]> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) return [];
    const prefix = mockDocumentPrefix(workspace);
    const files: DiagramFile[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { body?: unknown; modifiedAt?: unknown };
        const body = typeof parsed.body === "string" ? parsed.body : "";
        const name = decodeURIComponent(key.slice(prefix.length));
        files.push({
          name,
          size: new Blob([body]).size,
          modifiedAt: typeof parsed.modifiedAt === "number" ? parsed.modifiedAt : 0,
          docTitle: extractDocTitle(body),
        });
      } catch {
        /* skip malformed mock entries */
      }
    }
    return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }
  return invoke<DiagramFile[]>("diagram_list_documents", { workspace });
}

export async function diagramDeleteDocument(
  workspace: string,
  name: string,
): Promise<boolean> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) return false;
    const key = mockDocumentKey(workspace, name);
    const existed = storage.getItem(key) !== null;
    storage.removeItem(key);
    return existed;
  }
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

export async function diagramExportBlobToPath(
  targetPath: string,
  kind: "png" | "jpg" | "svg" | "json" | "pdf" | "mmd",
  bytes: Uint8Array,
): Promise<string> {
  if (!isTauri()) throw new Error("diagram_export_blob_to_path_requires_tauri");
  return invoke<string>("diagram_export_blob_to_path", {
    targetPath,
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

/**
 * One-time v7 backup before the first v8 save overwrites a legacy document.
 * Returns the backup file path. In the localStorage mock the copy is kept
 * under a `backups:` key so tests can verify it happened.
 */
export async function diagramBackupDocument(
  workspace: string,
  name: string,
): Promise<string> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) throw new Error("diagram_backup_document_requires_tauri");
    const raw = storage.getItem(mockDocumentKey(workspace, name));
    if (!raw) throw new Error(`Diagram not found: ${name}`);
    const backupName = `${name}-v7-${Date.now()}`;
    storage.setItem(
      `${mockDocumentPrefix(workspace)}backups:${encodeURIComponent(backupName)}`,
      raw,
    );
    return backupName;
  }
  return invoke<string>("diagram_backup_document", { workspace, name });
}
