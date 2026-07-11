import type { GraphEdge, GraphNode } from "../../lib/graph/model";

const COMMUNITY_COLORS = [
  "#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#eeca3b",
  "#b279a2", "#ff9da6", "#9d755d", "#bab0ac", "#86bcb6", "#d67195",
];
const DOMAIN_COLORS: Record<string, string> = {
  research: "#4c78a8",
  projects: "#f58518",
  teaching: "#54a24b",
  operations: "#e45756",
  people: "#b279a2",
  "ai-practice": "#72b7b2",
};
const FALLBACK_COLOR = "#8a8f98";

export function nodeRadius(degree: number): number {
  return Math.min(20, Math.max(4, 4 + 2 * Math.sqrt(degree)));
}

export function nodeColor(node: GraphNode, enriched: boolean): string {
  if (node.type === "unresolved") return "#f7f7f5";
  if (enriched && node.community != null) {
    return COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length];
  }
  return node.domain ? (DOMAIN_COLORS[node.domain] ?? FALLBACK_COLOR) : FALLBACK_COLOR;
}

export function communityColor(community: number): string {
  return COMMUNITY_COLORS[community % COMMUNITY_COLORS.length];
}

export function domainColor(domain: string | null): string {
  return domain ? (DOMAIN_COLORS[domain] ?? FALLBACK_COLOR) : FALLBACK_COLOR;
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export function graphTopologySignature(nodes: GraphNode[], edges: GraphEdge[]): string {
  let hash = 2166136261;
  const add = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16777619);
  };
  for (const node of nodes) add(node.id);
  for (const edge of edges) {
    add(edge.source);
    add(edge.target);
    add(edge.relation);
  }
  return `${nodes.length}:${edges.length}:${hash >>> 0}`;
}
