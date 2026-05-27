import type { WorkspaceFileEntry } from "./types";
import {
  DEFAULT_BINARY_FILE_INCLUDE_PATTERNS,
  type FilesSortKey,
  type WorkspaceFileFilter,
} from "./settings";

export type WorkspaceFileTreeRow =
  | {
      kind: "folder";
      id: string;
      path: string;
      name: string;
      depth: number;
      count: number;
      collapsed: boolean;
    }
  | {
      kind: "file";
      id: string;
      entry: WorkspaceFileEntry;
      depth: number;
    };

export interface VirtualWorkspaceFileTreeRow {
  row: WorkspaceFileTreeRow;
  top: number;
}

export interface VirtualWorkspaceFileTreeLayout {
  rows: VirtualWorkspaceFileTreeRow[];
  totalHeight: number;
}

interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  files: WorkspaceFileEntry[];
  count: number;
}

export function filterWorkspaceFiles(
  entries: WorkspaceFileEntry[],
  query: string,
  filter: WorkspaceFileFilter,
  binaryIncludePatterns: readonly string[] = DEFAULT_BINARY_FILE_INCLUDE_PATTERNS,
): WorkspaceFileEntry[] {
  const q = query.trim().toLowerCase();
  const binaryMatchers =
    filter === "binary" ? compileWorkspaceFileIncludePatterns(binaryIncludePatterns) : [];
  return entries.filter((entry) => {
    if (filter === "tracked" && !entry.gitTracked) return false;
    if (filter === "binary" && !matchesWorkspaceFileIncludePatterns(entry, binaryMatchers)) {
      return false;
    }
    if (!q) return true;
    return (
      entry.name.toLowerCase().includes(q) ||
      entry.relPath.toLowerCase().includes(q) ||
      entry.fileKind.toLowerCase().includes(q)
    );
  });
}

interface CompiledWorkspaceFileIncludePattern {
  regex: RegExp;
  matchPath: boolean;
}

export function compileWorkspaceFileIncludePatterns(
  patterns: readonly string[],
): CompiledWorkspaceFileIncludePattern[] {
  const compiled: CompiledWorkspaceFileIncludePattern[] = [];
  const seen = new Set<string>();
  for (const value of patterns) {
    const pattern = value.trim().replace(/\\/g, "/");
    if (!pattern || pattern.startsWith("#")) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    compiled.push({
      regex: globToRegExp(pattern),
      matchPath: pattern.includes("/"),
    });
  }
  return compiled;
}

function matchesWorkspaceFileIncludePatterns(
  entry: WorkspaceFileEntry,
  patterns: readonly CompiledWorkspaceFileIncludePattern[],
): boolean {
  const relPath = entry.relPath.replace(/\\/g, "/");
  const name = entry.name.replace(/\\/g, "/");
  return patterns.some((pattern) => pattern.regex.test(pattern.matchPath ? relPath : name));
}

export function buildWorkspaceFileTreeRows(
  entries: WorkspaceFileEntry[],
  collapsedFolders: string[],
  forceExpand = false,
): WorkspaceFileTreeRow[] {
  // Existing settings key is named "collapsed", but the stored value is the
  // user's expanded folder set so new folders stay collapsed by default.
  const expanded = new Set(collapsedFolders);
  const root: TreeNode = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
    count: 0,
  };

  for (const entry of entries) {
    const parts = entry.relPath.split("/").filter(Boolean);
    if (parts.length <= 1) {
      root.files.push(entry);
      root.count += 1;
      continue;
    }
    let node = root;
    node.count += 1;
    for (const folder of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${folder}` : folder;
      let next = node.folders.get(folder);
      if (!next) {
        next = { name: folder, path, folders: new Map(), files: [], count: 0 };
        node.folders.set(folder, next);
      }
      next.count += 1;
      node = next;
    }
    node.files.push(entry);
  }

  return flattenNode(root, expanded, forceExpand, -1);
}

export function collectWorkspaceFileFolderPaths(entries: WorkspaceFileEntry[]): string[] {
  const folders = new Set<string>();
  for (const entry of entries) {
    const parts = entry.relPath.split("/").filter(Boolean);
    let current = "";
    for (const folder of parts.slice(0, -1)) {
      current = current ? `${current}/${folder}` : folder;
      folders.add(current);
    }
  }
  return Array.from(folders).sort(compareName);
}

export function collectWorkspaceFileAncestorFolders(relPath: string): string[] {
  const folders: string[] = [];
  const parts = relPath.split("/").filter(Boolean).slice(0, -1);
  let current = "";
  for (const folder of parts) {
    current = current ? `${current}/${folder}` : folder;
    folders.push(current);
  }
  return folders;
}

export function expandWorkspaceFileAncestors(current: string[], relPath: string): string[] {
  return Array.from(new Set([...current, ...collectWorkspaceFileAncestorFolders(relPath)])).sort(
    compareName,
  );
}

export function nextCollapsedFileFolders(
  current: string[],
  folderPath: string,
  collapsed: boolean,
): string[] {
  const next = new Set(current);
  if (collapsed) next.delete(folderPath);
  else next.add(folderPath);
  return Array.from(next).sort(compareName);
}

export function virtualizeWorkspaceFileTreeRows(
  rows: WorkspaceFileTreeRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  rowHeight: number,
): VirtualWorkspaceFileTreeLayout {
  if (rowHeight <= 0) return { rows: [], totalHeight: 0 };
  const safeHeight = Math.max(0, viewportHeight);
  const safeScrollTop = Math.max(0, scrollTop);
  const min = Math.max(0, safeScrollTop - overscan);
  const max = safeScrollTop + safeHeight + overscan;
  const first = Math.max(0, Math.floor(min / rowHeight));
  const last = Math.min(rows.length - 1, Math.ceil(max / rowHeight));
  const visible: VirtualWorkspaceFileTreeRow[] = [];
  for (let index = first; index <= last; index += 1) {
    const row = rows[index];
    if (!row) continue;
    visible.push({ row, top: index * rowHeight });
  }
  return { rows: visible, totalHeight: rows.length * rowHeight };
}

export function isOpenableDocumentFile(entry: WorkspaceFileEntry): boolean {
  return ["md", "markdown", "html", "htm"].includes(entry.fileKind.toLowerCase());
}

function flattenNode(
  node: TreeNode,
  expanded: Set<string>,
  forceExpand: boolean,
  depth: number,
): WorkspaceFileTreeRow[] {
  const rows: WorkspaceFileTreeRow[] = [];
  const folders = Array.from(node.folders.values()).sort((a, b) => compareName(a.name, b.name));
  const files = [...node.files].sort((a, b) => compareName(a.name, b.name));

  for (const folder of folders) {
    const isCollapsed = !forceExpand && !expanded.has(folder.path);
    rows.push({
      kind: "folder",
      id: `folder:${folder.path}`,
      path: folder.path,
      name: folder.name,
      depth: depth + 1,
      count: folder.count,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) {
      rows.push(...flattenNode(folder, expanded, forceExpand, depth + 1));
    }
  }

  for (const entry of files) {
    rows.push({
      kind: "file",
      id: `file:${entry.path}`,
      entry,
      depth: depth + 1,
    });
  }

  return rows;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source, "i");
}

function compareName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

// ---------------------------------------------------------------------------
// Files List view (flat list with optional mtime grouping)
// ---------------------------------------------------------------------------

export type WorkspaceFileListRow =
  | {
      kind: "group";
      id: string;
      label: string;
      count: number;
    }
  | {
      kind: "file";
      id: string;
      entry: WorkspaceFileEntry;
    };

export interface VirtualWorkspaceFileListRow {
  row: WorkspaceFileListRow;
  top: number;
  height: number;
}

export interface VirtualWorkspaceFileListLayout {
  rows: VirtualWorkspaceFileListRow[];
  totalHeight: number;
}

export interface WorkspaceFilesPaneFilters {
  extensions: string[];
  modifiedWithinDays: number | null;
  sizeBucket: "lt10k" | "lt1m" | "lt10m" | "gte10m" | null;
  queuedOnly: boolean;
  queuedPaths: string[];
}

export const EMPTY_WORKSPACE_FILES_PANE_FILTERS: WorkspaceFilesPaneFilters = {
  extensions: [],
  modifiedWithinDays: null,
  sizeBucket: null,
  queuedOnly: false,
  queuedPaths: [],
};

export function hasActiveWorkspaceFilesPaneFilters(
  filters: WorkspaceFilesPaneFilters,
): boolean {
  return (
    filters.extensions.length > 0 ||
    filters.modifiedWithinDays !== null ||
    filters.sizeBucket !== null ||
    filters.queuedOnly
  );
}

export function applyWorkspaceFilesPaneFilters(
  entries: WorkspaceFileEntry[],
  filters: WorkspaceFilesPaneFilters,
  now: number = Date.now(),
): WorkspaceFileEntry[] {
  if (!hasActiveWorkspaceFilesPaneFilters(filters)) return entries;
  const extSet = new Set(
    filters.extensions.map((ext) => ext.trim().toLowerCase()).filter(Boolean),
  );
  const queuedSet =
    filters.queuedOnly && filters.queuedPaths.length > 0
      ? new Set(filters.queuedPaths)
      : null;
  const cutoff =
    filters.modifiedWithinDays !== null
      ? now - filters.modifiedWithinDays * 24 * 60 * 60 * 1000
      : null;
  return entries.filter((entry) => {
    if (extSet.size > 0) {
      const kind = entry.fileKind.toLowerCase();
      const ext = entry.extension?.toLowerCase() ?? kind;
      if (!extSet.has(ext) && !extSet.has(kind)) return false;
    }
    if (cutoff !== null) {
      const ts = entry.updatedAt ? Date.parse(entry.updatedAt) : 0;
      if (!Number.isFinite(ts) || ts < cutoff) return false;
    }
    if (filters.sizeBucket) {
      const size = entry.sizeBytes;
      if (filters.sizeBucket === "lt10k" && size >= 10 * 1024) return false;
      if (
        filters.sizeBucket === "lt1m" &&
        (size < 10 * 1024 || size >= 1024 * 1024)
      )
        return false;
      if (
        filters.sizeBucket === "lt10m" &&
        (size < 1024 * 1024 || size >= 10 * 1024 * 1024)
      )
        return false;
      if (filters.sizeBucket === "gte10m" && size < 10 * 1024 * 1024) return false;
    }
    if (queuedSet && !queuedSet.has(entry.path)) return false;
    if (filters.queuedOnly && !queuedSet) return false;
    return true;
  });
}

export function collectWorkspaceFileExtensionCounts(
  entries: WorkspaceFileEntry[],
): { extension: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const ext =
      (entry.extension ?? entry.fileKind ?? "").toLowerCase().trim() || "(none)";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([extension, count]) => ({ extension, count }))
    .sort((a, b) => b.count - a.count || compareName(a.extension, b.extension));
}

function entryMtime(entry: WorkspaceFileEntry): number {
  if (!entry.updatedAt) return 0;
  const ts = Date.parse(entry.updatedAt);
  return Number.isFinite(ts) ? ts : 0;
}

export function sortWorkspaceFiles(
  entries: WorkspaceFileEntry[],
  sortKey: FilesSortKey,
): WorkspaceFileEntry[] {
  const sorted = entries.slice();
  if (sortKey === "modifiedDesc") {
    sorted.sort((a, b) => {
      const diff = entryMtime(b) - entryMtime(a);
      return diff !== 0 ? diff : compareName(a.relPath, b.relPath);
    });
  } else if (sortKey === "modifiedAsc") {
    sorted.sort((a, b) => {
      const diff = entryMtime(a) - entryMtime(b);
      return diff !== 0 ? diff : compareName(a.relPath, b.relPath);
    });
  } else {
    sorted.sort((a, b) => compareName(a.relPath, b.relPath));
  }
  return sorted;
}

export interface WorkspaceFileMtimeBucket {
  label: string;
  items: WorkspaceFileEntry[];
}

export interface WorkspaceFileMtimeBucketLabels {
  today: string;
  thisWeek: string;
  earlier: string;
}

export function groupWorkspaceFilesByMtime(
  entries: WorkspaceFileEntry[],
  labels: WorkspaceFileMtimeBucketLabels,
  now: number = Date.now(),
): WorkspaceFileMtimeBucket[] {
  const day = 24 * 60 * 60 * 1000;
  const buckets: WorkspaceFileMtimeBucket[] = [
    { label: labels.today, items: [] },
    { label: labels.thisWeek, items: [] },
    { label: labels.earlier, items: [] },
  ];
  for (const entry of entries) {
    const ts = entryMtime(entry);
    const age = now - ts;
    if (age < day) buckets[0].items.push(entry);
    else if (age < 7 * day) buckets[1].items.push(entry);
    else buckets[2].items.push(entry);
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}

export function buildWorkspaceFileListRows(
  entries: WorkspaceFileEntry[],
  options: {
    grouped?: boolean;
    sortKey: FilesSortKey;
    bucketLabels?: WorkspaceFileMtimeBucketLabels;
    now?: number;
  },
): WorkspaceFileListRow[] {
  const sorted = sortWorkspaceFiles(entries, options.sortKey);
  if (
    !options.grouped ||
    !options.bucketLabels ||
    (options.sortKey !== "modifiedDesc" && options.sortKey !== "modifiedAsc")
  ) {
    return sorted.map((entry) => ({
      kind: "file" as const,
      id: `file:${entry.path}`,
      entry,
    }));
  }
  const buckets = groupWorkspaceFilesByMtime(sorted, options.bucketLabels, options.now);
  const rows: WorkspaceFileListRow[] = [];
  for (const bucket of buckets) {
    rows.push({
      kind: "group",
      id: `group:${bucket.label}`,
      label: bucket.label,
      count: bucket.items.length,
    });
    for (const entry of bucket.items) {
      rows.push({ kind: "file", id: `file:${entry.path}`, entry });
    }
  }
  return rows;
}

export function virtualizeWorkspaceFileListRows(
  rows: WorkspaceFileListRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  fileRowHeight: number,
  groupRowHeight: number,
): VirtualWorkspaceFileListLayout {
  if (fileRowHeight <= 0) return { rows: [], totalHeight: 0 };
  const safeHeight = Math.max(0, viewportHeight);
  const safeScrollTop = Math.max(0, scrollTop);
  const min = Math.max(0, safeScrollTop - overscan);
  const max = safeScrollTop + safeHeight + overscan;
  const positioned: VirtualWorkspaceFileListRow[] = [];
  let cursor = 0;
  for (const row of rows) {
    const height = row.kind === "group" ? groupRowHeight : fileRowHeight;
    positioned.push({ row, top: cursor, height });
    cursor += height;
  }
  const visible = positioned.filter(
    ({ top, height }) => top + height >= min && top <= max,
  );
  return { rows: visible, totalHeight: cursor };
}
