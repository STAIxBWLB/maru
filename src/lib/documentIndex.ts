import { frontmatterScalar } from "./document";
import type { VaultEntry } from "./types";

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
  typeFilter: string | null,
): VaultEntry[] {
  const trimmed = query.trim().toLowerCase();
  const hasQuery = trimmed.length > 0;
  const out: VaultEntry[] = [];

  for (const record of index.records) {
    if (typeFilter != null) {
      if (typeFilter === "_") {
        if (record.type != null) continue;
      } else if (record.type !== typeFilter) {
        continue;
      }
    }
    if (hasQuery && !record.searchText.includes(trimmed)) continue;
    out.push(record.entry);
  }

  return out;
}

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
    ? filterDocumentIndex(index, query, null).slice(0, limit)
    : index.entries.slice(0, limit);
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
  return !entry.relPath.startsWith("_sys/") && !entry.relPath.startsWith(".anchor/");
}
