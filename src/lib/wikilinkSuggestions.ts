import type { VaultEntry } from "./types";

export const MIN_QUERY_LENGTH = 1;
export const MAX_RESULTS = 8;

export interface WikilinkSuggestion {
  /** Display title — disambiguated with parent folder when titles collide. */
  title: string;
  /** Wikilink target, written as `[[target]]`. Currently the rel path without
   *  extension; this matches Obsidian's behavior for nested vaults. */
  target: string;
  /** Vault-absolute path (used as React key + selectEntry handle). */
  path: string;
  /** Vault-relative path for muted display. */
  relPath: string;
}

function stripExt(relPath: string): string {
  return relPath.replace(/\.(md|mdx|markdown)$/i, "");
}

function toSuggestion(entry: VaultEntry): WikilinkSuggestion {
  return {
    title: entry.title,
    target: stripExt(entry.relPath),
    path: entry.path,
    relPath: entry.relPath,
  };
}

function disambiguate(items: WikilinkSuggestion[]): WikilinkSuggestion[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
  }
  return items.map((item) => {
    if ((counts.get(item.title) ?? 0) <= 1) return item;
    const parts = item.relPath.split("/");
    const folder = parts.length >= 2 ? parts[parts.length - 2] : "";
    return folder ? { ...item, title: `${item.title} (${folder})` } : item;
  });
}

/** Fuzzy-rank vault entries against an autocomplete query. Empty query →
 *  most recently updated. Title prefix > title contains > path contains. */
export function suggestWikilinkTargets(
  entries: VaultEntry[],
  query: string,
  limit: number = MAX_RESULTS,
): WikilinkSuggestion[] {
  if (query.length < MIN_QUERY_LENGTH) {
    const fresh = [...entries]
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, limit);
    return disambiguate(fresh.map(toSuggestion));
  }
  const lower = query.toLowerCase();
  const scored: { suggestion: WikilinkSuggestion; rank: number; tieBreak: string }[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const relPath = entry.relPath.toLowerCase();
    let rank: number;
    if (title.startsWith(lower)) rank = 0;
    else if (title.includes(lower)) rank = 1;
    else if (relPath.includes(lower)) rank = 2;
    else continue;
    scored.push({ suggestion: toSuggestion(entry), rank, tieBreak: title });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.tieBreak.localeCompare(b.tieBreak),
  );
  return disambiguate(scored.slice(0, limit).map((x) => x.suggestion));
}

/** Resolve a wikilink target to a VaultEntry. Order: exact title → filename
 *  (without extension) → exact relPath → relPath suffix. Used by preview
 *  click navigation and (later) by neighborhood pane. */
export function resolveWikilinkTarget(
  entries: VaultEntry[],
  target: string,
): VaultEntry | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const stripped = stripExt(trimmed).toLowerCase();

  for (const entry of entries) {
    if (entry.title.toLowerCase() === lower) return entry;
  }
  for (const entry of entries) {
    const fn = entry.relPath.split("/").pop() ?? "";
    if (stripExt(fn).toLowerCase() === stripped) return entry;
  }
  for (const entry of entries) {
    if (entry.relPath.toLowerCase() === lower) return entry;
    if (stripExt(entry.relPath).toLowerCase() === stripped) return entry;
  }
  for (const entry of entries) {
    const rel = entry.relPath.toLowerCase();
    if (rel.endsWith("/" + lower) || rel.endsWith("/" + stripped + ".md")) return entry;
  }
  return null;
}
