import type { GraphEdge, GraphNode } from "../../lib/graph/model";

// dataviz-validated categorical palettes (12 slots, same hue per slot across
// themes). Light: min adjacent deutan dE 13.3 on #f4f3ee. Dark: 14.8 on
// #181a18. Slot ORDER is the CVD-safety mechanism; never reorder or cycle.
const LIGHT_COMMUNITY_COLORS = [
  "#2a78d6", "#eda100", "#008300", "#e34948", "#0894ab", "#eb6834",
  "#4a3aa7", "#6b8e23", "#e87ba4", "#9c6410", "#1baf7a", "#7a4fb5",
];
const DARK_COMMUNITY_COLORS = [
  "#3987e5", "#c98500", "#17913a", "#e25b70", "#1a95aa", "#d95926",
  "#9085e9", "#7a9630", "#d55181", "#b07b28", "#199e70", "#a678d8",
];
// Domains map onto palette slots so domain and community coloring share hues.
const DOMAIN_SLOTS: Record<string, number> = {
  research: 0,      // blue
  projects: 5,      // orange
  teaching: 2,      // green
  operations: 3,    // red
  people: 11,       // purple
  "ai-practice": 4, // cyan
};

export interface GraphTheme {
  bg: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  warn: string;
  labelColor: string;
  edge: string;
  edgeStrong: string;
  edgeDim: string;
  nodeBorder: string;
  ghostFill: string;
  dimNode: string;
  dark: boolean;
  communityColors: string[];
  domainColors: Record<string, string>;
  fallback: string;
}

const LIGHT_DEFAULTS = { bg: "#f4f3ee", ink: "#1f1d18", muted: "#69645b", line: "#dedbd1", accent: "#2f5a3c" };
const DARK_DEFAULTS = { bg: "#181a18", ink: "#f2f0e8", muted: "#a19c8f", line: "#3a3d36", accent: "#7faf86" };

function hexLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 1;
  const value = parseInt(match[1], 16);
  const channel = (component: number) => {
    const c = component / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((value >> 16) & 0xff)
    + 0.7152 * channel((value >> 8) & 0xff)
    + 0.0722 * channel(value & 0xff);
}

function buildTheme(read: (name: string, fallback: string) => string): GraphTheme {
  const bgProbe = read("--bg", LIGHT_DEFAULTS.bg);
  const dark = hexLuminance(bgProbe) < 0.5;
  const defaults = dark ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  const bg = read("--bg", defaults.bg);
  const ink = read("--ink", defaults.ink);
  const line = read("--line", defaults.line);
  const communityColors = dark ? DARK_COMMUNITY_COLORS : LIGHT_COMMUNITY_COLORS;
  const domainColors = Object.fromEntries(
    Object.entries(DOMAIN_SLOTS).map(([domain, slot]) => [domain, communityColors[slot]]),
  );
  return {
    bg,
    ink,
    muted: read("--muted", defaults.muted),
    line,
    accent: read("--accent", defaults.accent),
    warn: dark ? "#d6b070" : "#b8690f",
    labelColor: dark ? "rgba(242, 240, 232, 0.82)" : "rgba(31, 29, 24, 0.82)",
    edge: line,
    edgeStrong: dark ? "#4c5049" : "#c8c4b8",
    edgeDim: dark ? "rgba(58, 61, 54, 0.35)" : "rgba(222, 219, 209, 0.4)",
    nodeBorder: bg,
    ghostFill: bg,
    dimNode: dark ? "#2e312d" : "#dcdad2",
    dark,
    communityColors,
    domainColors,
    fallback: dark ? "#9aa0a8" : "#8a8f98",
  };
}

let activeTheme: GraphTheme = buildTheme((_name, fallback) => fallback);

export function refreshGraphTheme(): GraphTheme {
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const style = getComputedStyle(document.documentElement);
    activeTheme = buildTheme((name, fallback) => style.getPropertyValue(name).trim() || fallback);
  }
  return activeTheme;
}

export function graphTheme(): GraphTheme {
  return activeTheme;
}

export function nodeRadius(degree: number): number {
  return Math.min(12, Math.max(3, 3 + 1.4 * Math.sqrt(degree)));
}

export function nodeColor(node: GraphNode, enriched: boolean): string {
  const theme = activeTheme;
  if (node.type === "unresolved") return theme.ghostFill;
  if (enriched && node.community != null) {
    return theme.communityColors[node.community % theme.communityColors.length];
  }
  return node.domain ? (theme.domainColors[node.domain] ?? theme.fallback) : theme.fallback;
}

export function communityColor(community: number): string {
  return activeTheme.communityColors[community % activeTheme.communityColors.length];
}

export function domainColor(domain: string | null): string {
  return domain ? (activeTheme.domainColors[domain] ?? activeTheme.fallback) : activeTheme.fallback;
}

/** Stable per-relation edge color: FNV hash into the categorical palette.
 *  Body `wiki_link` edges are handled by the caller (they stay neutral). */
export function relationColor(relation: string): string {
  const palette = activeTheme.communityColors;
  let hash = 2166136261;
  for (let index = 0; index < relation.length; index += 1) {
    hash ^= relation.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return palette[(hash >>> 0) % palette.length];
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
