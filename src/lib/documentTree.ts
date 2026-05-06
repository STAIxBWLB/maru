import type { VaultEntry } from "./types";

export type DocumentTreeRow =
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
      kind: "entry";
      id: string;
      entry: VaultEntry;
      depth: number;
    };

export interface VirtualTreeRow {
  row: DocumentTreeRow;
  top: number;
}

export interface VirtualTreeLayout {
  rows: VirtualTreeRow[];
  totalHeight: number;
}

interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  entries: VaultEntry[];
  count: number;
}

export function buildDocumentTreeRows(
  entries: VaultEntry[],
  collapsedFolders: string[],
  forceExpand = false,
): DocumentTreeRow[] {
  // Existing settings key is named "collapsed", but the stored value is the
  // user's expanded folder set so new folders stay collapsed by default.
  const expanded = new Set(collapsedFolders);
  const root: TreeNode = {
    name: "",
    path: "",
    folders: new Map(),
    entries: [],
    count: 0,
  };

  for (const entry of entries) {
    const parts = entry.relPath.split("/").filter(Boolean);
    if (parts.length <= 1) {
      root.entries.push(entry);
      root.count += 1;
      continue;
    }
    let node = root;
    node.count += 1;
    for (const folder of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${folder}` : folder;
      let next = node.folders.get(folder);
      if (!next) {
        next = {
          name: folder,
          path,
          folders: new Map(),
          entries: [],
          count: 0,
        };
        node.folders.set(folder, next);
      }
      next.count += 1;
      node = next;
    }
    node.entries.push(entry);
  }

  return flattenNode(root, expanded, forceExpand, -1);
}

export function nextCollapsedFolders(
  current: string[],
  folderPath: string,
  collapsed: boolean,
): string[] {
  const next = new Set(current);
  if (collapsed) next.delete(folderPath);
  else next.add(folderPath);
  return Array.from(next).sort((a, b) => a.localeCompare(b));
}

export function collectDocumentTreeFolderPaths(entries: VaultEntry[]): string[] {
  const folders = new Set<string>();
  for (const entry of entries) {
    const parts = entry.relPath.split("/").filter(Boolean);
    let current = "";
    for (const folder of parts.slice(0, -1)) {
      current = current ? `${current}/${folder}` : folder;
      folders.add(current);
    }
  }
  return Array.from(folders).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
  );
}

export function collectDocumentAncestorFolders(relPath: string): string[] {
  const folders: string[] = [];
  const parts = relPath.split("/").filter(Boolean).slice(0, -1);
  let current = "";
  for (const folder of parts) {
    current = current ? `${current}/${folder}` : folder;
    folders.push(current);
  }
  return folders;
}

export function expandDocumentAncestors(current: string[], relPath: string): string[] {
  return Array.from(new Set([...current, ...collectDocumentAncestorFolders(relPath)])).sort(
    (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
  );
}

export function virtualizeDocumentTreeRows(
  rows: DocumentTreeRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  rowHeight: number,
): VirtualTreeLayout {
  if (rowHeight <= 0) {
    return { rows: [], totalHeight: 0 };
  }
  const safeHeight = Math.max(0, viewportHeight);
  const safeScrollTop = Math.max(0, scrollTop);
  const min = Math.max(0, safeScrollTop - overscan);
  const max = safeScrollTop + safeHeight + overscan;
  const first = Math.max(0, Math.floor(min / rowHeight));
  const last = Math.min(rows.length - 1, Math.ceil(max / rowHeight));
  const visible: VirtualTreeRow[] = [];

  for (let index = first; index <= last; index += 1) {
    const row = rows[index];
    if (!row) continue;
    visible.push({ row, top: index * rowHeight });
  }

  return {
    rows: visible,
    totalHeight: rows.length * rowHeight,
  };
}

function flattenNode(
  node: TreeNode,
  expanded: Set<string>,
  forceExpand: boolean,
  depth: number,
): DocumentTreeRow[] {
  const rows: DocumentTreeRow[] = [];
  const folders = Array.from(node.folders.values()).sort(compareFolder);
  const entries = [...node.entries].sort(compareEntry);

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

  for (const entry of entries) {
    rows.push({
      kind: "entry",
      id: `entry:${entry.path}`,
      entry,
      depth: depth + 1,
    });
  }

  return rows;
}

function compareFolder(a: TreeNode, b: TreeNode): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

function compareEntry(a: VaultEntry, b: VaultEntry): number {
  return a.relPath.localeCompare(b.relPath, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}
