import type { FileQueueSourceKind, FileStoreOperation } from "./types";

export const EXPLORER_DRAG_MIME = "application/x-anchor-explorer-items";
export const FILE_QUEUE_DRAG_MIME = "application/x-anchor-file-queue";

export type ExplorerDragOrigin = "documents" | "files";

export interface ExplorerDragItem {
  path: string;
  relPath: string;
  fileName: string;
  sourceKind: FileQueueSourceKind;
}

export interface ExplorerDragPayload {
  origin: ExplorerDragOrigin;
  workspacePath: string;
  items: ExplorerDragItem[];
}

export interface FileQueueDragPayload {
  itemIds: string[];
}

const ACTIVE_EXPLORER_DRAG_TTL_MS = 30_000;
let activeExplorerDrag:
  | {
      payload: ExplorerDragPayload;
      startedAt: number;
    }
  | null = null;
let activeFileQueueDrag:
  | {
      payload: FileQueueDragPayload;
      startedAt: number;
    }
  | null = null;

interface DragDataTransferLike {
  types?: readonly string[];
  effectAllowed?: string;
  dropEffect?: string;
  setData?: (format: string, data: string) => void;
  getData?: (format: string) => string;
}

interface DragEventLike {
  dataTransfer: DragDataTransferLike;
  altKey?: boolean;
}

export function writeExplorerDragPayload(
  event: DragEventLike,
  payload: ExplorerDragPayload,
): void {
  activeExplorerDrag = { payload, startedAt: Date.now() };
  event.dataTransfer.setData?.(EXPLORER_DRAG_MIME, JSON.stringify(payload));
  event.dataTransfer.setData?.(
    "text/plain",
    payload.items.map((item) => item.relPath || item.fileName).join("\n"),
  );
  event.dataTransfer.effectAllowed = "copyMove";
}

export function readExplorerDragPayload(
  dataTransfer: DragDataTransferLike,
): ExplorerDragPayload | null {
  const raw = dataTransfer.getData?.(EXPLORER_DRAG_MIME);
  if (raw) {
    try {
      return normalizeExplorerDragPayload(JSON.parse(raw));
    } catch {
      return readActiveExplorerDragPayload();
    }
  }
  return readActiveExplorerDragPayload();
}

export function hasExplorerDragPayload(dataTransfer: DragDataTransferLike): boolean {
  return Boolean(
    dataTransfer.types?.includes(EXPLORER_DRAG_MIME) ||
      dataTransfer.getData?.(EXPLORER_DRAG_MIME) ||
      readActiveExplorerDragPayload(),
  );
}

export function clearExplorerDragPayload(): void {
  activeExplorerDrag = null;
}

export function writeFileQueueDragPayload(
  event: DragEventLike,
  itemIds: string[],
): void {
  const payload = normalizeFileQueueDragPayload({ itemIds });
  if (!payload) return;
  activeFileQueueDrag = { payload, startedAt: Date.now() };
  event.dataTransfer.setData?.(FILE_QUEUE_DRAG_MIME, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copyMove";
}

export function readFileQueueDragPayload(
  dataTransfer: DragDataTransferLike,
): FileQueueDragPayload | null {
  const raw = dataTransfer.getData?.(FILE_QUEUE_DRAG_MIME);
  if (raw) {
    try {
      return normalizeFileQueueDragPayload(JSON.parse(raw));
    } catch {
      return normalizeFileQueueDragPayload(raw) ?? readActiveFileQueueDragPayload();
    }
  }
  return readActiveFileQueueDragPayload();
}

export function hasFileQueueDragPayload(dataTransfer: DragDataTransferLike): boolean {
  return Boolean(
    dataTransfer.types?.includes(FILE_QUEUE_DRAG_MIME) ||
      dataTransfer.getData?.(FILE_QUEUE_DRAG_MIME) ||
      readActiveFileQueueDragPayload(),
  );
}

export function clearFileQueueDragPayload(): void {
  activeFileQueueDrag = null;
}

export function dropOperationFromEvent(event: Pick<DragEventLike, "altKey">): FileStoreOperation {
  return event.altKey ? "move" : "copy";
}

export function targetDirForDropTarget(
  targetPath: string,
  targetKind: FileQueueSourceKind,
): string {
  return targetKind === "directory" ? trimTrailingSlash(targetPath) : parentPath(targetPath);
}

export function isSameParentMove(item: ExplorerDragItem, targetDir: string): boolean {
  return normalizePath(parentPath(item.path)) === normalizePath(targetDir);
}

export function parentPath(path: string): string {
  const normalized = trimTrailingSlash(path);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function normalizeExplorerDragPayload(value: unknown): ExplorerDragPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const origin = record.origin;
  const workspacePath = record.workspacePath;
  const rawItems = record.items;
  if ((origin !== "documents" && origin !== "files") || typeof workspacePath !== "string") {
    return null;
  }
  if (!Array.isArray(rawItems)) return null;
  const items: ExplorerDragItem[] = [];
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const { path, relPath, fileName, sourceKind } = item;
    if (
      typeof path !== "string" ||
      typeof relPath !== "string" ||
      typeof fileName !== "string" ||
      (sourceKind !== "file" && sourceKind !== "directory")
    ) {
      continue;
    }
    items.push({ path, relPath, fileName, sourceKind });
  }
  if (items.length === 0) return null;
  return { origin, workspacePath, items };
}

function normalizeFileQueueDragPayload(value: unknown): FileQueueDragPayload | null {
  if (typeof value === "string") return value ? { itemIds: [value] } : null;
  const rawIds =
    Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>).itemIds
        : null;
  if (!Array.isArray(rawIds)) return null;
  const itemIds = Array.from(
    new Set(
      rawIds.filter(
        (itemId): itemId is string => typeof itemId === "string" && itemId.length > 0,
      ),
    ),
  );
  return itemIds.length > 0 ? { itemIds } : null;
}

function readActiveExplorerDragPayload(): ExplorerDragPayload | null {
  if (!activeExplorerDrag) return null;
  if (Date.now() - activeExplorerDrag.startedAt > ACTIVE_EXPLORER_DRAG_TTL_MS) {
    activeExplorerDrag = null;
    return null;
  }
  return activeExplorerDrag.payload;
}

function readActiveFileQueueDragPayload(): FileQueueDragPayload | null {
  if (!activeFileQueueDrag) return null;
  if (Date.now() - activeFileQueueDrag.startedAt > ACTIVE_EXPLORER_DRAG_TTL_MS) {
    activeFileQueueDrag = null;
    return null;
  }
  return activeFileQueueDrag.payload;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePath(value: string): string {
  return trimTrailingSlash(value).replace(/\/+/g, "/");
}
