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

/** Export kinds accepted by the Rust `diagram_export_blob*` whitelist. */
export type DiagramExportKind =
  | "png"
  | "jpg"
  | "svg"
  | "json"
  | "pdf"
  | "mmd"
  | "csv"
  | "tsv"
  | "md"
  | "html";

export async function diagramExportBlob(
  workspace: string,
  name: string,
  kind: DiagramExportKind,
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
  kind: DiagramExportKind,
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

// ---------------------------------------------------------------------------
// Pattern presets (Report Pattern Studio) — `.maru/diagram-patterns/`
// ---------------------------------------------------------------------------

const MOCK_PATTERN_PREFIX = "maru:diagram:mock-patterns:";

function mockPatternPrefix(workspace: string): string {
  return `${MOCK_PATTERN_PREFIX}${encodeURIComponent(workspace)}:`;
}

function mockPatternKey(workspace: string, name: string): string {
  return `${mockPatternPrefix(workspace)}${encodeURIComponent(name)}`;
}

export async function diagramPatternSave(
  workspace: string,
  name: string,
  body: string,
): Promise<void> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) throw new Error("diagram_pattern_save_requires_tauri");
    storage.setItem(
      mockPatternKey(workspace, name),
      JSON.stringify({ body, modifiedAt: Date.now() }),
    );
    return;
  }
  return invoke<void>("diagram_pattern_save", { workspace, name, body });
}

export async function diagramPatternList(workspace: string): Promise<DiagramFile[]> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) return [];
    const prefix = mockPatternPrefix(workspace);
    const files: DiagramFile[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { body?: unknown; modifiedAt?: unknown };
        const body = typeof parsed.body === "string" ? parsed.body : "";
        files.push({
          name: decodeURIComponent(key.slice(prefix.length)),
          size: new Blob([body]).size,
          modifiedAt: typeof parsed.modifiedAt === "number" ? parsed.modifiedAt : 0,
          docTitle: "",
        });
      } catch {
        /* skip malformed mock entries */
      }
    }
    return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }
  return invoke<DiagramFile[]>("diagram_pattern_list", { workspace });
}

/**
 * Load a preset body. There is no dedicated Rust read command; presets are
 * plain JSON text files inside the workspace, so the generic `read_document`
 * command (vault-contained path resolution) reads them.
 */
export async function diagramPatternLoad(workspace: string, name: string): Promise<string> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) throw new Error("diagram_pattern_load_requires_tauri");
    const raw = storage.getItem(mockPatternKey(workspace, name));
    if (!raw) throw new Error(`Pattern preset not found: ${name}`);
    const parsed = JSON.parse(raw) as { body?: unknown };
    if (typeof parsed.body !== "string") throw new Error(`Pattern preset not found: ${name}`);
    return parsed.body;
  }
  const payload = await invoke<{ content: string }>("read_document", {
    vaultPath: workspace,
    documentPath: `.maru/diagram-patterns/${name}.pattern.json`,
  });
  return payload.content;
}

export async function diagramPatternDelete(
  workspace: string,
  name: string,
): Promise<boolean> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) return false;
    const key = mockPatternKey(workspace, name);
    const existed = storage.getItem(key) !== null;
    storage.removeItem(key);
    return existed;
  }
  return invoke<boolean>("diagram_pattern_delete", { workspace, name });
}

// ---------------------------------------------------------------------------
// Report assets (Insert/Update in report) — `attachments/diagrams/<docId>/`
// ---------------------------------------------------------------------------

const MOCK_REPORT_ASSET_PREFIX = "maru:diagram:mock-report-assets:";

/**
 * Write a rendered report asset (SVG/PNG/JSON) next to the reports that
 * reference it. Returns the workspace-relative path
 * (`attachments/diagrams/<docId>/<fileName>`). Hash-named files make repeated
 * renders idempotent. The browser mock keeps a record in localStorage so the
 * e2e/dev path does not crash; it cannot place real files.
 */
export async function diagramWriteReportAsset(
  workspace: string,
  docId: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  if (!isTauri()) {
    const storage = mockStorage();
    if (!storage) throw new Error("diagram_write_report_asset_requires_tauri");
    storage.setItem(
      `${MOCK_REPORT_ASSET_PREFIX}${encodeURIComponent(workspace)}:${encodeURIComponent(docId)}:${encodeURIComponent(fileName)}`,
      JSON.stringify({ bytes: Array.from(bytes), modifiedAt: Date.now() }),
    );
    return `attachments/diagrams/${docId}/${fileName}`;
  }
  return invoke<string>("diagram_write_report_asset", {
    workspace,
    docId,
    fileName,
    bytes: Array.from(bytes),
  });
}
