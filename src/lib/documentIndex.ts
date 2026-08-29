import { frontmatterScalar } from "./document";
import type { DocumentViewDefinition, SortKey } from "./settings";
import type { VaultEntry } from "./types";

export type BuiltInDocumentView = "inbox" | "drafts" | "archive" | "recentlyUpdated";

export type DocumentFilter =
  | { kind: "all" }
  | { kind: "type"; type: string }
  | { kind: "untyped" }
  | { kind: "view"; view: BuiltInDocumentView }
  | { kind: "custom"; viewId: string };

export const ALL_DOCUMENTS_FILTER: DocumentFilter = { kind: "all" };

export interface DocumentFilterOptions {
  customViews?: DocumentViewDefinition[];
  now?: Date;
}

export interface IndexedDocument {
  entry: VaultEntry;
  type: string | null;
  lowerTitle: string;
  lowerRelPath: string;
  searchText: string;
}

export interface DocumentIndex {
  entries: VaultEntry[];
  records: IndexedDocument[];
  byPath: Map<string, VaultEntry>;
  contentEntries: VaultEntry[];
  contentCount: number;
  typeCounts: Array<[string, number]>;
}

export function buildDocumentIndex(entries: VaultEntry[]): DocumentIndex {
  const records: IndexedDocument[] = [];
  const byPath = new Map<string, VaultEntry>();
  const contentEntries: VaultEntry[] = [];
  const counts = new Map<string, { count: number; firstSeen: number }>();

  for (const [index, entry] of entries.entries()) {
    const type = frontmatterScalar(entry.frontmatter, "type");
    records.push({
      entry,
      type,
      lowerTitle: entry.title.toLowerCase(),
      lowerRelPath: entry.relPath.toLowerCase(),
      searchText: buildSearchText(entry),
    });
    byPath.set(entry.path, entry);

    if (isContentEntry(entry)) {
      contentEntries.push(entry);
      const key = type ?? "_";
      const current = counts.get(key);
      if (current) {
        current.count += 1;
      } else {
        counts.set(key, { count: 1, firstSeen: index });
      }
    }
  }

  const typeCounts = Array.from(counts.entries())
    .sort((a, b) => b[1].count - a[1].count || a[1].firstSeen - b[1].firstSeen)
    .map(([type, value]) => [type, value.count] as [string, number]);

  return {
    entries,
    records,
    byPath,
    contentEntries,
    contentCount: contentEntries.length,
    typeCounts,
  };
}

export function filterDocumentIndex(
  index: DocumentIndex,
  query: string,
  filter: DocumentFilter,
  options: DocumentFilterOptions = {},
): VaultEntry[] {
  const trimmed = query.trim().toLowerCase();
  const hasQuery = trimmed.length > 0;
  const out: VaultEntry[] = [];

  for (const record of index.records) {
    if (!matchesDocumentFilter(record, filter, options)) continue;
    if (hasQuery && !record.searchText.includes(trimmed)) continue;
    out.push(record.entry);
  }

  return out;
}

/** Reorder a filtered document list. Mirrors the Files pane comparator
 *  (`filesWorkbench.ts`): modified time first, then a stable name tiebreak. */
export function sortDocumentEntries(entries: VaultEntry[], sortKey: SortKey): VaultEntry[] {
  return [...entries].sort((a, b) => {
    if (sortKey === "modifiedAsc" || sortKey === "modifiedDesc") {
      const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      const modified = sortKey === "modifiedAsc" ? aTime - bTime : bTime - aTime;
      if (modified) return modified;
    }
    return compareDocumentName(a, b);
  });
}

function compareDocumentName(a: VaultEntry, b: VaultEntry): number {
  return (
    a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) ||
    a.relPath.localeCompare(b.relPath, undefined, { sensitivity: "base", numeric: true })
  );
}

export function countDocumentFilter(
  index: DocumentIndex,
  filter: DocumentFilter,
  options: DocumentFilterOptions = {},
): number {
  let count = 0;
  for (const record of index.records) {
    if (!isContentEntry(record.entry)) continue;
    if (matchesDocumentFilter(record, filter, options)) count += 1;
  }
  return count;
}

export function documentFilterKey(filter: DocumentFilter): string {
  switch (filter.kind) {
    case "all":
      return "all";
    case "type":
      return `type:${filter.type}`;
    case "untyped":
      return "untyped";
    case "view":
      return `view:${filter.view}`;
    case "custom":
      return `custom:${filter.viewId}`;
  }
}

export function isAllDocumentFilter(filter: DocumentFilter): boolean {
  return filter.kind === "all";
}

export function documentFilterDefaultDocType(
  filter: DocumentFilter,
  customViews: readonly DocumentViewDefinition[] = [],
): string | null {
  if (filter.kind === "type") return filter.type;
  if (filter.kind !== "custom") return null;
  const view = customViews.find((item) => item.id === filter.viewId);
  return view?.type?.trim() || null;
}

/** How many recently-opened paths are kept and resolved. Matches the maximum
 *  `ui.dashboardListRows` allows, so the setting can always be satisfied; the
 *  dashboard card slices this down to the configured rows. */
export const RECENT_PATHS_LIMIT = 50;

export function getRecentEntries(
  index: DocumentIndex,
  recentPaths: string[],
  limit: number,
): VaultEntry[] {
  const out: VaultEntry[] = [];
  for (const path of recentPaths) {
    const entry = index.byPath.get(path);
    if (!entry) continue;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

export function getCommandPaletteDocs(
  index: DocumentIndex,
  query: string,
  limit: number,
): VaultEntry[] {
  return query.trim()
    ? filterDocumentIndex(index, query, ALL_DOCUMENTS_FILTER).slice(0, limit)
    : index.entries.slice(0, limit);
}

/** Scope id for documents outside every submodule. "." is never a git
 *  $displaypath, so the workspace root shares one exclusion list with them. */
export const WORKSPACE_ROOT_SCOPE_ID = ".";

/** Owning submodule of a workspace-relative path, or WORKSPACE_ROOT_SCOPE_ID
 *  when it sits outside every submodule. `git submodule foreach --recursive`
 *  reports a nested submodule as both "a" and "a/b", so the longest prefix
 *  wins; the boundary check keeps "deps/childish/x.md" out of "deps/child".
 *  VaultEntry.relPath carries native separators (backslashes on Windows) while
 *  $displaypath is always slash-delimited, so relPath is normalized first. */
export function submoduleScopeId(relPath: string, submodulePaths: readonly string[]): string {
  const normalized = relPath.replace(/\\/g, "/");
  let owner: string | null = null;
  for (const submodule of submodulePaths) {
    if (!normalized.startsWith(submodule)) continue;
    if (normalized.length > submodule.length && normalized[submodule.length] !== "/") continue;
    if (owner === null || submodule.length > owner.length) owner = submodule;
  }
  return owner ?? WORKSPACE_ROOT_SCOPE_ID;
}

/** Documents-pane submodule scope. Returns the input array untouched on the
 *  default path, and when the workspace has no submodules at all -- the latter
 *  guard is what stops a stale ["."] exclusion from hiding everything after the
 *  last submodule is removed. */
export function filterEntriesBySubmoduleScope(
  entries: VaultEntry[],
  submodulePaths: readonly string[],
  excluded: readonly string[],
): VaultEntry[] {
  if (excluded.length === 0 || submodulePaths.length === 0) return entries;
  const hidden = new Set(excluded);
  return entries.filter((entry) => !hidden.has(submoduleScopeId(entry.relPath, submodulePaths)));
}

/** Per-scope counts for the sidebar chips, over the UNSCOPED entries so a
 *  hidden submodule still advertises what it holds. Counts content documents
 *  only, matching the "All" chip.
 *  ponytail: O(entries x submodules) prefix scan, fine for a few thousand
 *  entries against ~20 submodules; precompute per-entry scope ids if it bites. */
export function countEntriesBySubmodule(
  entries: readonly VaultEntry[],
  submodulePaths: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = { [WORKSPACE_ROOT_SCOPE_ID]: 0 };
  for (const submodule of submodulePaths) counts[submodule] = 0;
  for (const entry of entries) {
    if (!isContentEntry(entry)) continue;
    counts[submoduleScopeId(entry.relPath, submodulePaths)] += 1;
  }
  return counts;
}

function matchesDocumentFilter(
  record: IndexedDocument,
  filter: DocumentFilter,
  options: DocumentFilterOptions,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "type":
      return record.type === filter.type;
    case "untyped":
      return record.type == null;
    case "view":
      return matchesBuiltInView(record, filter.view, options.now ?? new Date());
    case "custom": {
      const view = options.customViews?.find((item) => item.id === filter.viewId);
      return view ? matchesCustomView(record, view) : false;
    }
  }
}

function matchesBuiltInView(
  record: IndexedDocument,
  view: BuiltInDocumentView,
  now: Date,
): boolean {
  switch (view) {
    case "inbox":
      return record.entry.relPath.startsWith("inbox/");
    case "drafts":
      return frontmatterScalar(record.entry.frontmatter, "status") === "draft";
    case "archive": {
      const status = frontmatterScalar(record.entry.frontmatter, "status");
      return (
        status === "archived" ||
        record.entry.relPath.startsWith("archive/") ||
        record.entry.relPath.startsWith("archives/")
      );
    }
    case "recentlyUpdated": {
      if (!record.entry.updatedAt) return false;
      const updated = new Date(record.entry.updatedAt).getTime();
      if (!Number.isFinite(updated)) return false;
      return now.getTime() - updated <= 7 * 24 * 60 * 60 * 1000;
    }
  }
}

function matchesCustomView(record: IndexedDocument, view: DocumentViewDefinition): boolean {
  if (view.type && record.type !== view.type) return false;
  if (view.status && frontmatterScalar(record.entry.frontmatter, "status") !== view.status) {
    return false;
  }
  if (view.pathPrefix && !record.entry.relPath.startsWith(view.pathPrefix)) return false;
  if (view.query && !record.searchText.includes(view.query.trim().toLowerCase())) return false;
  return true;
}

function buildSearchText(entry: VaultEntry): string {
  const parts = [
    entry.title,
    entry.relPath,
    entry.snippet,
    ...Object.values(entry.frontmatter ?? {}).map((value) =>
      typeof value === "string" ? value : JSON.stringify(value),
    ),
  ].filter((value): value is string => typeof value === "string");
  return parts.join(" ").toLowerCase();
}

function isContentEntry(entry: VaultEntry): boolean {
  return !entry.relPath.startsWith("_sys/") && !entry.relPath.startsWith(".maru/");
}
