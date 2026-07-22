// Search ranking for the graph toolbar combobox. Searches the CURRENT
// filtered graph (visibleModel nodes); ranking: exact label → label prefix →
// label substring → relPath substring, ties broken alphabetically for stable
// arrow-key navigation.

export interface GraphSearchResult {
  id: string;
  label: string;
  relPath: string | null;
}

export const GRAPH_SEARCH_LIMIT = 20;

export function rankGraphSearch(
  nodes: readonly { id: string; label: string; relPath: string | null }[],
  query: string,
  limit: number = GRAPH_SEARCH_LIMIT,
): GraphSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { node: GraphSearchResult; rank: number }[] = [];
  for (const node of nodes) {
    const label = node.label.toLowerCase();
    let rank: number | null = null;
    if (label === q) rank = 0;
    else if (label.startsWith(q)) rank = 1;
    else if (label.includes(q)) rank = 2;
    else if (node.relPath && node.relPath.toLowerCase().includes(q)) rank = 3;
    if (rank == null) continue;
    scored.push({ node: { id: node.id, label: node.label, relPath: node.relPath }, rank });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.node.label.localeCompare(b.node.label) || a.node.id.localeCompare(b.node.id),
  );
  return scored.slice(0, limit).map((entry) => entry.node);
}
