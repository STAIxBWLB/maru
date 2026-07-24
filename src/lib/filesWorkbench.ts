import type { FilesSortKey, WorkspaceFileFilter } from "./settings";
import type { WorkspaceEntryNode, WorkspaceFileEntry } from "./types";

export interface FilesDirectoryTreeNode {
  relPath: string;
  name: string;
  entry: WorkspaceEntryNode | null;
  children: FilesDirectoryTreeNode[];
}

export interface FilesBreadcrumb {
  relPath: string;
  label: string;
}

export function isDirectoryNode(entry: WorkspaceEntryNode): boolean {
  return (
    entry.kind === "directory" ||
    (entry.kind === "symlink" && entry.targetKind === "directory")
  );
}

export function isFileNode(entry: WorkspaceEntryNode): boolean {
  return (
    entry.kind === "file" ||
    (entry.kind === "symlink" && entry.targetKind === "file")
  );
}

export function workspaceNodeToFileEntry(
  entry: WorkspaceEntryNode,
): WorkspaceFileEntry | null {
  if (!isFileNode(entry)) return null;
  return {
    path: entry.path,
    relPath: entry.relPath,
    name: entry.name,
    extension: entry.extension,
    fileKind: entry.fileKind,
    sizeBytes: entry.sizeBytes,
    updatedAt: entry.updatedAt,
    gitTracked: entry.gitTracked,
    binary: entry.binary,
  };
}

export function buildFilesDirectoryTree(
  entries: WorkspaceEntryNode[],
  rootLabel: string,
): FilesDirectoryTreeNode {
  const root: FilesDirectoryTreeNode = {
    relPath: "",
    name: rootLabel,
    entry: null,
    children: [],
  };
  const byPath = new Map<string, FilesDirectoryTreeNode>([["", root]]);
  const directories = entries
    .filter(isDirectoryNode)
    .sort((a, b) => pathDepth(a.relPath) - pathDepth(b.relPath) || compareName(a, b));

  for (const entry of directories) {
    const node: FilesDirectoryTreeNode = {
      relPath: entry.relPath,
      name: entry.name,
      entry,
      children: [],
    };
    byPath.set(entry.relPath, node);
    const parent = byPath.get(entry.parentRelPath) ?? root;
    parent.children.push(node);
  }
  sortTree(root);
  return root;
}

export function listFilesDirectoryContents(
  entries: WorkspaceEntryNode[],
  currentFolder: string,
  query: string,
  filter: WorkspaceFileFilter,
  sortKey: FilesSortKey,
): WorkspaceEntryNode[] {
  const normalizedFolder = normalizeRelPath(currentFolder);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const folderPrefix = normalizedFolder ? `${normalizedFolder}/` : "";
  const candidates = normalizedQuery
    ? entries.filter((entry) => {
        if (
          folderPrefix &&
          entry.relPath !== normalizedFolder &&
          !entry.relPath.startsWith(folderPrefix)
        ) {
          return false;
        }
        return `${entry.name}\n${entry.relPath}`.toLocaleLowerCase().includes(normalizedQuery);
      })
    : entries.filter((entry) => entry.parentRelPath === normalizedFolder);

  return candidates
    .filter((entry) => {
      if (isDirectoryNode(entry)) return filter === "all";
      if (!isFileNode(entry)) return filter === "all";
      if (filter === "tracked") return entry.gitTracked;
      if (filter === "binary") return entry.binary;
      return true;
    })
    .sort((a, b) => {
      const kindOrder = Number(!isDirectoryNode(a)) - Number(!isDirectoryNode(b));
      if (kindOrder !== 0) return kindOrder;
      if (sortKey === "modifiedAsc" || sortKey === "modifiedDesc") {
        const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        const modified = sortKey === "modifiedAsc" ? aTime - bTime : bTime - aTime;
        if (modified !== 0) return modified;
      }
      return compareName(a, b);
    });
}

export function filesBreadcrumbs(
  currentFolder: string,
  rootLabel: string,
): FilesBreadcrumb[] {
  const parts = normalizeRelPath(currentFolder).split("/").filter(Boolean);
  const breadcrumbs: FilesBreadcrumb[] = [{ relPath: "", label: rootLabel }];
  for (let index = 0; index < parts.length; index += 1) {
    breadcrumbs.push({
      relPath: parts.slice(0, index + 1).join("/"),
      label: parts[index],
    });
  }
  return breadcrumbs;
}

export function parentFolderRelPath(currentFolder: string): string {
  return normalizeRelPath(currentFolder).split("/").filter(Boolean).slice(0, -1).join("/");
}

export function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function collapseNestedPaths(paths: string[]): string[] {
  return Array.from(new Set(paths))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .filter(
      (path, index, ordered) =>
        !ordered
          .slice(0, index)
          .some((parent) => path === parent || path.startsWith(`${parent.replace(/\/+$/, "")}/`)),
    );
}

function compareName(a: Pick<WorkspaceEntryNode, "name">, b: Pick<WorkspaceEntryNode, "name">) {
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function pathDepth(path: string): number {
  return normalizeRelPath(path).split("/").filter(Boolean).length;
}

function sortTree(node: FilesDirectoryTreeNode) {
  node.children.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
  node.children.forEach(sortTree);
}
