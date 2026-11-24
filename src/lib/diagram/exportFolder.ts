/**
 * Default folder for the diagram export save panel (#659).
 *
 * A first export used to default to `<workspace>/diagrams/<file>` even when
 * `diagrams/` did not exist; the macOS save panel then fell back to the nearest
 * existing folder (the workspace root) and left untracked exports in a
 * repository. The default now follows what the user actually did: the folder
 * they last saved a diagram export into for this workspace, else
 * `<workspace>/diagrams/` once it holds saved diagrams, else their Downloads
 * folder. With none of those, no directory hint is passed at all and the panel
 * keeps the platform default instead of a missing directory.
 *
 * Nothing here writes to disk: the folder is recorded only after the user has
 * confirmed a path in the save panel.
 */
import { downloadDir } from "@tauri-apps/api/path";

import { diagramListDocuments } from "../diagram";

export const DIAGRAM_EXPORT_FOLDER_STORAGE_KEY = "maru:diagram:exportFolder:v1";

export interface ExportDefaultInput {
  workspace: string;
  fileName: string;
  /** Folder the user last saved a diagram export into, for this workspace. */
  lastFolder: string | null;
  /** True when `<workspace>/diagrams/` holds saved diagram documents. */
  diagramsInUse: boolean;
  /** The platform's Downloads folder, when it could be resolved. */
  downloadsDir: string | null;
}

/** Pure default-path choice; no filesystem or storage access. */
export function chooseExportDefaultPath(input: ExportDefaultInput): string | null {
  if (input.lastFolder) return joinPath(input.lastFolder, input.fileName);
  if (input.diagramsInUse) {
    return joinPath(joinPath(input.workspace, "diagrams"), input.fileName);
  }
  if (input.downloadsDir) return joinPath(input.downloadsDir, input.fileName);
  return null;
}

/** Join a folder and a file name, keeping the folder's own separator style. */
export function joinPath(folder: string, name: string): string {
  const base = folder.trim();
  if (!base) return name;
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const trimmed = base.replace(/[\\/]+$/, "");
  const root = trimmed || separator;
  return root.endsWith(separator) ? `${root}${name}` : `${root}${separator}${name}`;
}

/** Folder part of a path the save panel returned; null when it has none. */
export function exportFolderOf(savedPath: string): string | null {
  const path = savedPath.trim();
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return null;
  const folder = cut === 0 ? path.slice(0, 1) : path.slice(0, cut).replace(/[\\/]+$/, "");
  return folder || null;
}

function storageKey(workspace: string): string {
  return `${DIAGRAM_EXPORT_FOLDER_STORAGE_KEY}:${workspace}`;
}

/** The folder the user last saved a diagram export into for this workspace. */
export function readLastExportFolder(workspace: string | null | undefined): string | null {
  const key = workspace?.trim();
  if (!key || typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(storageKey(key));
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** Remember the confirmed export folder for the next save panel in this workspace. */
export function rememberExportFolder(workspace: string, savedPath: string): void {
  const key = workspace.trim();
  const folder = exportFolderOf(savedPath);
  if (!key || !folder || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(key), folder);
  } catch {
    /* localStorage may be unavailable (private mode); remembering is best-effort. */
  }
}

/**
 * `<workspace>/diagrams/` counts as the landing folder once saved diagrams live
 * in it. Maru exposes no single-path existence bridge, and an empty leftover
 * directory is not a place the user has used, so the document list decides.
 */
export async function hasSavedDiagramDocuments(workspace: string): Promise<boolean> {
  try {
    return (await diagramListDocuments(workspace)).length > 0;
  } catch {
    return false;
  }
}

/** The platform's Downloads folder, or null when the shell cannot resolve it. */
export async function readDownloadsDirectory(): Promise<string | null> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return null;
  try {
    return (await downloadDir()) || null;
  } catch {
    return null;
  }
}

/** Default path handed to the native save panel for a diagram export. */
export async function resolveExportDefaultPath(
  workspace: string,
  fileName: string,
): Promise<string | null> {
  const lastFolder = readLastExportFolder(workspace);
  if (lastFolder) {
    return chooseExportDefaultPath({
      workspace,
      fileName,
      lastFolder,
      diagramsInUse: false,
      downloadsDir: null,
    });
  }
  const [diagramsInUse, downloadsDir] = await Promise.all([
    hasSavedDiagramDocuments(workspace),
    readDownloadsDirectory(),
  ]);
  return chooseExportDefaultPath({ workspace, fileName, lastFolder: null, diagramsInUse, downloadsDir });
}
