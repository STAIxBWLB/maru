import type { ScratchpadCollection, ScratchpadEntry } from "./types";

export const SCRATCHPAD_NAV_COLLECTIONS = ["memos", "temp"] as const;
export type ScratchpadNavCollection = (typeof SCRATCHPAD_NAV_COLLECTIONS)[number];

export interface ScratchpadFolderNode {
  id: string;
  name: string;
  collection: ScratchpadNavCollection | null;
  relativePath: string;
  fileCount: number;
  staleCount: number;
  children: ScratchpadFolderNode[];
}

export function scratchpadVirtualPath(
  entry: Pick<ScratchpadEntry, "collection" | "relativePath">,
): string {
  return `${entry.collection}/${normalizeScratchpadPath(entry.relativePath)}`;
}

export function scratchpadParentFolder(relativePath: string): string {
  return normalizeScratchpadPath(relativePath).split("/").filter(Boolean).slice(0, -1).join("/");
}

export function buildScratchpadFolderTree(entries: ScratchpadEntry[]): ScratchpadFolderNode {
  const root: ScratchpadFolderNode = {
    id: "",
    name: "",
    collection: null,
    relativePath: "",
    fileCount: 0,
    staleCount: 0,
    children: [],
  };
  const byId = new Map<string, ScratchpadFolderNode>([["", root]]);

  for (const collection of SCRATCHPAD_NAV_COLLECTIONS) {
    const node: ScratchpadFolderNode = {
      id: collection,
      name: collection,
      collection,
      relativePath: "",
      fileCount: 0,
      staleCount: 0,
      children: [],
    };
    root.children.push(node);
    byId.set(collection, node);
  }

  for (const entry of entries) {
    if (!isNavigableCollection(entry.collection)) continue;
    const parent = scratchpadParentFolder(entry.relativePath);
    const parts = parent.split("/").filter(Boolean);
    let parentId: string = entry.collection;
    for (let index = 0; index < parts.length; index += 1) {
      const relativePath = parts.slice(0, index + 1).join("/");
      const id = `${entry.collection}/${relativePath}`;
      if (!byId.has(id)) {
        const node: ScratchpadFolderNode = {
          id,
          name: parts[index],
          collection: entry.collection,
          relativePath,
          fileCount: 0,
          staleCount: 0,
          children: [],
        };
        byId.set(id, node);
        byId.get(parentId)?.children.push(node);
      }
      parentId = id;
    }

    root.fileCount += 1;
    if (entry.stale) root.staleCount += 1;
    const ancestors = [entry.collection, ...parts.map((_, index) =>
      `${entry.collection}/${parts.slice(0, index + 1).join("/")}`,
    )];
    for (const id of ancestors) {
      const node = byId.get(id);
      if (!node) continue;
      node.fileCount += 1;
      if (entry.stale) node.staleCount += 1;
    }
  }

  sortScratchpadTree(root);
  return root;
}

export function scratchpadFolderAncestors(folderId: string): string[] {
  const normalized = normalizeScratchpadPath(folderId);
  const parts = normalized.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function filterScratchpadFolderEntries(
  entries: ScratchpadEntry[],
  folderId: string,
  query: string,
): ScratchpadEntry[] {
  const parsed = parseScratchpadFolderId(folderId);
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (!isNavigableCollection(entry.collection)) return false;
    if (parsed && entry.collection !== parsed.collection) return false;
    const parent = scratchpadParentFolder(entry.relativePath);
    if (parsed) {
      if (needle) {
        if (
          parsed.relativePath &&
          parent !== parsed.relativePath &&
          !parent.startsWith(`${parsed.relativePath}/`)
        ) {
          return false;
        }
      } else if (parent !== parsed.relativePath) {
        return false;
      }
    }
    if (!needle) return true;
    return [entry.name, entry.relativePath, entry.preview, entry.source, entry.collection]
      .join("\n")
      .toLocaleLowerCase()
      .includes(needle);
  });
}

export function parseScratchpadFolderId(
  folderId: string,
): { collection: ScratchpadNavCollection; relativePath: string } | null {
  const normalized = normalizeScratchpadPath(folderId);
  if (!normalized) return null;
  const [collection, ...parts] = normalized.split("/");
  if (!isNavigableCollection(collection)) return null;
  return { collection, relativePath: parts.join("/") };
}

function isNavigableCollection(value: ScratchpadCollection | string): value is ScratchpadNavCollection {
  return value === "memos" || value === "temp";
}

function normalizeScratchpadPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function sortScratchpadTree(node: ScratchpadFolderNode) {
  node.children.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
  );
  node.children.forEach(sortScratchpadTree);
}
