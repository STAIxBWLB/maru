// Graph model for the "graph" app mode (maru-vault-graph-spec §F2).
//
// Dual source: the live graph is derived from VaultEntry[] (always fresh, no
// community); `<vault>/reports/vault-graph.json` — produced by build-graph.py
// on the weekly ritual — overlays `community` per node. Absent/corrupt JSON
// degrades gracefully to the live graph (enriched=false).

import { collectWikilinkTargets } from "../neighborhood";
import type { VaultEntry } from "../types";
import {
  buildEntryIndex,
  resolveTargetIndexed,
  type EntryIndex,
} from "../wikilinkSuggestions";

export interface GraphNode {
  id: string;
  label: string;
  /** null = ghost (unresolved wikilink target — F3(b)'s input). */
  relPath: string | null;
  ownerWorkspacePath?: string | null;
  type: string;
  domain: string | null;
  degree: number;
  community: number | null;
  isGodNode: boolean;
  /** frontmatter created/decided_date/date — decision-chain lane ordering. */
  date: string | null;
  /** file mtime (VaultEntry.updatedAt) — stale-note detection; null for ghosts. */
  updatedAt: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** frontmatter field name, or "wiki_link" for body links. */
  relation: string;
  fromFrontmatter: boolean;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  enriched: boolean;
  builtAt: number;
}

/** Shape of `vault-graph.json` as returned by the `vault_graph_read` command
 *  (schema-freeze table: knowledge-graph-integration.md §2 / spec §5.2). */
export interface VaultGraphFile {
  nodes: {
    id: string;
    label?: string | null;
    community?: number | null;
    type?: string | null;
    domain?: string | null;
    source_file?: string | null;
  }[];
  edges: { source: string; target: string; relation?: string | null }[];
}

const GOD_NODE_COUNT = 10;
const MARKDOWN_KINDS = new Set(["md", "markdown", "mdx"]);

function stemOf(relPath: string): string {
  const filename = relPath.split("/").pop() ?? relPath;
  return filename.replace(/\.(md|mdx|markdown)$/i, "").toLowerCase();
}

function normalizeTarget(target: string): string {
  return target.trim().toLowerCase().replace(/\s+/g, "-");
}

function frontmatterString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Build the live graph from scanned entries. Node id = lowercase stem
 *  (matches build-graph.py `f.stem`); every member of a stem collision uses
 *  its rel-path-without-extension so ids stay unique and scan-order stable. */
export function buildVaultGraph(
  entries: VaultEntry[],
  index?: EntryIndex,
): GraphModel {
  const idx = index ?? buildEntryIndex(entries);
  const docs = entries.filter((entry) =>
    MARKDOWN_KINDS.has(entry.fileKind.toLowerCase()),
  );

  // Resolve all collisions before assigning ids. Giving only the second note
  // a path id makes cached positions and deep links depend on scan order.
  const stemCounts = new Map<string, number>();
  for (const entry of docs) {
    const stem = stemOf(entry.relPath);
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }

  const idByPath = new Map<string, string>();
  for (const entry of docs) {
    const stem = stemOf(entry.relPath);
    const id =
      stemCounts.get(stem) === 1
        ? stem
        : entry.relPath.replace(/\.(md|mdx|markdown)$/i, "").toLowerCase();
    idByPath.set(entry.path, id);
  }

  const nodes = new Map<string, GraphNode>();
  for (const entry of docs) {
    const meta = (entry.frontmatter ?? {}) as Record<string, unknown>;
    const id = idByPath.get(entry.path)!;
    nodes.set(id, {
      id,
      label: entry.title,
      relPath: entry.relPath,
      ownerWorkspacePath: entry.ownerWorkspacePath ?? null,
      type: frontmatterString(meta.type) ?? "unknown",
      domain: frontmatterString(meta.domain),
      degree: 0,
      community: null,
      isGodNode: false,
      date:
        frontmatterString(meta.created) ??
        frontmatterString(meta.decided_date) ??
        frontmatterString(meta.date) ??
        (typeof meta.created === "object" || typeof meta.date === "object"
          ? String(meta.created ?? meta.date ?? "") || null
          : null),
      updatedAt: entry.updatedAt,
    });
  }

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const pushEdge = (
    source: string,
    target: string,
    relation: string,
    fromFrontmatter: boolean,
  ) => {
    if (source === target) return;
    const key = `${source}\u0000${target}\u0000${relation}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ source, target, relation, fromFrontmatter });
  };

  const resolveToId = (target: string): string => {
    const resolved = resolveTargetIndexed(idx, entries, target);
    if (resolved) {
      const id = idByPath.get(resolved.path);
      if (id) return id;
    }
    // Ghost node — unresolved wikilink target.
    const ghostId = normalizeTarget(target);
    if (!nodes.has(ghostId)) {
      nodes.set(ghostId, {
        id: ghostId,
        label: target.trim(),
        relPath: null,
        ownerWorkspacePath: null,
        type: "unresolved",
        domain: null,
        degree: 0,
        community: null,
        isGodNode: false,
        date: null,
        updatedAt: null,
      });
    }
    return ghostId;
  };

  for (const entry of docs) {
    const sourceId = idByPath.get(entry.path)!;
    const meta = (entry.frontmatter ?? {}) as Record<string, unknown>;

    // Frontmatter wikilink fields → relation = field name.
    const frontmatterTargets = new Set<string>();
    for (const [field, value] of Object.entries(meta)) {
      for (const target of collectWikilinkTargets(value)) {
        frontmatterTargets.add(target);
        pushEdge(sourceId, resolveToId(target), field, true);
      }
    }
    // Body links = entry.links minus frontmatter targets → "wiki_link".
    for (const target of entry.links ?? []) {
      if (frontmatterTargets.has(target)) continue;
      pushEdge(sourceId, resolveToId(target), "wiki_link", false);
    }
  }

  for (const edge of edges) {
    const s = nodes.get(edge.source);
    const t = nodes.get(edge.target);
    if (s) s.degree += 1;
    if (t) t.degree += 1;
  }

  const godCandidates = [...nodes.values()]
    .filter((n) => n.type !== "moc" && n.type !== "unresolved")
    .sort((a, b) => b.degree - a.degree)
    .slice(0, GOD_NODE_COUNT);
  for (const node of godCandidates) {
    if (node.degree > 0) node.isGodNode = true;
  }

  return {
    nodes: [...nodes.values()],
    edges,
    enriched: false,
    builtAt: Date.now(),
  };
}

/** Overlay `community` from vault-graph.json onto the live model. Matching:
 *  node id first, then `source_file` stem fallback. Nodes without a match
 *  (e.g. outside `notes/` — the builder only covers flat notes/*.md) keep
 *  community=null. */
export function enrichGraph(
  model: GraphModel,
  file: VaultGraphFile,
): GraphModel {
  const communityById = new Map<string, number>();
  for (const fileNode of file.nodes) {
    if (fileNode.community == null) continue;
    communityById.set(fileNode.id.toLowerCase(), fileNode.community);
    if (fileNode.source_file) {
      communityById.set(stemOf(fileNode.source_file), fileNode.community);
    }
  }
  if (communityById.size === 0) {
    return { ...model, enriched: true };
  }
  return {
    ...model,
    enriched: true,
    nodes: model.nodes.map((node) => {
      const community =
        communityById.get(node.id) ??
        (node.relPath ? communityById.get(stemOf(node.relPath)) : undefined);
      return community == null ? node : { ...node, community };
    }),
  };
}

/** Precomputed 1-hop adjacency for hover highlighting. Cached per model so
 *  the 3-4 callers in a render cycle (insights + focusSubgraph) share one build
 *  instead of each rebuilding O(E). A new model identity (vault edit / enrich)
 *  misses and rebuilds; keyed weakly so old models get collected. */
const adjacencyCache = new WeakMap<GraphModel, Map<string, Set<string>>>();

export function buildAdjacency(model: GraphModel): Map<string, Set<string>> {
  const cached = adjacencyCache.get(model);
  if (cached) return cached;
  const adjacency = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = adjacency.get(a);
    if (!set) {
      set = new Set();
      adjacency.set(a, set);
    }
    set.add(b);
  };
  for (const edge of model.edges) {
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  }
  adjacencyCache.set(model, adjacency);
  return adjacency;
}

/** k-hop subgraph around a focus node (focus mode, k=2 per spec). */
export function focusSubgraph(
  model: GraphModel,
  focusId: string,
  k: number = 2,
  direction: "both" | "incoming" | "outgoing" = "both",
): GraphModel {
  const adjacency = direction === "both" ? buildAdjacency(model) : new Map<string, Set<string>>();
  if (direction !== "both") {
    for (const edge of model.edges) {
      const from = direction === "outgoing" ? edge.source : edge.target;
      const to = direction === "outgoing" ? edge.target : edge.source;
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      adjacency.get(from)!.add(to);
    }
  }
  const keep = new Set<string>([focusId]);
  let frontier = [focusId];
  for (let hop = 0; hop < k; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!keep.has(neighbor)) {
          keep.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return {
    ...model,
    nodes: model.nodes.filter((n) => keep.has(n.id)),
    edges: model.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

/** Auto-generated noise: untyped notes (no frontmatter `type`) or notes whose
 *  relPath matches a noise pattern (trailing "/" = prefix match, otherwise
 *  exact filename match), both case-insensitive. Ghosts (`relPath: null`,
 *  type "unresolved") are governed by the showGhosts filter, not here. */
export function isNoiseNode(node: GraphNode, patterns: readonly string[]): boolean {
  if (node.type === "unresolved") return false;
  if (node.type === "unknown") return true;
  if (!node.relPath) return false;
  const relPath = node.relPath.toLowerCase();
  const fileName = relPath.split("/").pop() ?? relPath;
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    return pattern.endsWith("/") ? relPath.startsWith(pattern) : fileName === pattern;
  });
}
