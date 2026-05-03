import type { VaultEntry } from "./types";

export const MIN_QUERY_LENGTH = 1;
export const MAX_RESULTS = 8;

export interface WikilinkSuggestion {
  /** Display title — disambiguated with parent folder when titles collide. */
  title: string;
  /** Wikilink target, written as `[[target]]`. Currently the rel path without
   *  extension; this matches Obsidian's behavior for nested vaults. */
  target: string;
  /** Workspace-absolute path (used as React key + selectEntry handle). */
  path: string;
  /** Workspace-relative path for muted display. */
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
 *  (without extension) → exact relPath → relPath suffix. Used by single-shot
 *  callers (preview click, missing-link toast) where one O(n) scan is fine.
 *  For hot paths (NeighborhoodPane resolves many mentions per keystroke) use
 *  buildEntryIndex + resolveTargetIndexed. */
export function resolveWikilinkTarget(
  entries: VaultEntry[],
  target: string,
): VaultEntry | null {
  return resolveTargetIndexed(buildEntryIndex(entries), entries, target);
}

export interface EntryIndex {
  /** Lowercase title → first matching entry (later duplicates are silently
   *  shadowed; suggestWikilinkTargets handles disambiguation upstream). */
  byTitle: Map<string, VaultEntry>;
  /** Lowercase filename without extension → entry. */
  byFilenameNoExt: Map<string, VaultEntry>;
  /** Lowercase exact relPath → entry. */
  byRelPath: Map<string, VaultEntry>;
  /** Lowercase relPath without extension → entry. */
  byRelPathNoExt: Map<string, VaultEntry>;
}

/** Build an O(1)-lookup index over the vault's entries. Cost: one pass.
 *  Memoize at the call site by entries identity (useMemo) so a typing burst
 *  reuses the same index. */
export function buildEntryIndex(entries: VaultEntry[]): EntryIndex {
  const byTitle = new Map<string, VaultEntry>();
  const byFilenameNoExt = new Map<string, VaultEntry>();
  const byRelPath = new Map<string, VaultEntry>();
  const byRelPathNoExt = new Map<string, VaultEntry>();
  for (const entry of entries) {
    const titleKey = entry.title.toLowerCase();
    if (!byTitle.has(titleKey)) byTitle.set(titleKey, entry);
    const filename = entry.relPath.split("/").pop() ?? "";
    const filenameKey = stripExt(filename).toLowerCase();
    if (!byFilenameNoExt.has(filenameKey)) byFilenameNoExt.set(filenameKey, entry);
    const relKey = entry.relPath.toLowerCase();
    byRelPath.set(relKey, entry);
    byRelPathNoExt.set(stripExt(relKey), entry);
  }
  return { byTitle, byFilenameNoExt, byRelPath, byRelPathNoExt };
}

/** Indexed variant of resolveWikilinkTarget. Same matching order, but every
 *  case except the multi-segment-path suffix fallback is O(1). The fallback
 *  scan only runs when the target contains a slash AND no hash hit. */
export function resolveTargetIndexed(
  idx: EntryIndex,
  entries: VaultEntry[],
  target: string,
): VaultEntry | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const stripped = stripExt(trimmed).toLowerCase();

  const fast =
    idx.byTitle.get(lower) ??
    idx.byFilenameNoExt.get(stripped) ??
    idx.byRelPath.get(lower) ??
    idx.byRelPathNoExt.get(stripped);
  if (fast) return fast;

  if (!lower.includes("/")) return null;
  for (const entry of entries) {
    const rel = entry.relPath.toLowerCase();
    if (rel.endsWith("/" + lower) || rel.endsWith("/" + stripped + ".md")) {
      return entry;
    }
  }
  return null;
}
