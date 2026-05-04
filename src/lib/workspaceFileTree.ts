import type { WorkspaceFileEntry } from "./types";
import {
  DEFAULT_BINARY_FILE_INCLUDE_PATTERNS,
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
