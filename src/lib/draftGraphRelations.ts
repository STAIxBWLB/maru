import { buildAdjacency, buildVaultGraph } from "./graph/model";
import { splitFrontmatter, extractOutgoingLinks } from "./wikilinks";
import type { VaultEntry } from "./types";
import { buildEntryIndex, resolveTargetIndexed } from "./wikilinkSuggestions";

export const MAX_DRAFT_GRAPH_RELATIONS = 8;

export interface DraftGraphRelation {
  entry: VaultEntry;
  degree: number;
}

export interface DraftGraphFocusRequest {
  docPath: string;
  nodePaths: string[];
}

/**
 * Resolve every graph-backed workspace document related to an unconfirmed
 * draft or idea. The result is intentionally uncapped: graph focus must not
 * silently drop references just because the compact chip projection is
 * limited to MAX_DRAFT_GRAPH_RELATIONS.
 */
export function resolveDraftGraphRelationEntries(
  entries: readonly VaultEntry[],
  originRefs: readonly string[] = [],
  promotedTo: string | null | undefined = null,
  content = "",
): DraftGraphRelation[] {
  if (entries.length === 0) return [];

  const workspaceEntries = [...entries];
  const index = buildEntryIndex(workspaceEntries);
  const model = buildVaultGraph(workspaceEntries, index);
  const adjacency = buildAdjacency(model);
  const degreeById = new Map(model.nodes.map((node) => [node.id, node.degree]));
  const nodeByRelPath = new Map(
    model.nodes
      .filter((node) => node.relPath)
      .map((node) => [node.relPath!.toLowerCase(), node]),
  );

  const [, body] = splitFrontmatter(content);
  const targets = [
    ...originRefs,
    ...(promotedTo ? [promotedTo] : []),
    ...extractOutgoingLinks(body),
  ];
  const seen = new Set<string>();
  const relations: DraftGraphRelation[] = [];
  for (const target of targets) {
    const resolved = resolveTargetIndexed(index, workspaceEntries, target);
    if (!resolved) continue;
    const key = resolved.relPath.toLowerCase();
    if (seen.has(key)) continue;
    const node = nodeByRelPath.get(key);
    // Non-Markdown workspace files can resolve in the wikilink index but are
    // intentionally absent from the graph model.
    if (!node) continue;
    seen.add(key);
    relations.push({
      entry: resolved,
      degree: degreeById.get(node.id) ?? adjacency.get(node.id)?.size ?? 0,
    });
  }

  return relations.sort(
    (a, b) =>
      b.degree - a.degree ||
      a.entry.title.localeCompare(b.entry.title) ||
      a.entry.relPath.localeCompare(b.entry.relPath),
  );
}

/**
 * Resolve the workspace documents related to an unconfirmed draft or idea.
 *
 * Scratchpad and draft files deliberately never enter the graph model. Their
 * provenance is still useful as an overlay, so only references that resolve to
 * a scanned Markdown entry are returned. The chip projection applies the
 * compact max-8 limit; graph focus consumes the uncapped resolver above.
 */
export function resolveDraftGraphRelations(
  entries: readonly VaultEntry[],
  originRefs: readonly string[] = [],
  promotedTo: string | null | undefined = null,
  content = "",
): DraftGraphRelation[] {
  return resolveDraftGraphRelationEntries(entries, originRefs, promotedTo, content).slice(
    0,
    MAX_DRAFT_GRAPH_RELATIONS,
  );
}
